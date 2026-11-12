// @ts-nocheck — PG/Git integration harness.

import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  remoteAttachmentLocator,
  sealedNamespaceUuidV5,
} from "@knowledge-base/api/lib/kb/attachment";
import {
  createKnowledgeBase,
  deleteKnowledgeBase,
  getKnowledgeBaseAttachment,
  getKnowledgeBaseForViewer,
  listKnowledgeBases,
  listKnowledgeBasesForViewer,
  updateKnowledgeBase,
} from "@knowledge-base/api/lib/kb/bases";
import { createDiskBlobStore } from "@knowledge-base/api/lib/kb/blob-store-disk";
import { createCursorSigner } from "@knowledge-base/api/lib/kb/cursor";
import {
  readDocumentAtRevision,
  resolvePinnedRevision,
} from "@knowledge-base/api/lib/kb/documents-read";
import { hardenedGitEnv, kbBareRepoPath, readHeadSha } from "@knowledge-base/api/lib/kb/git-read";
import { createTreeReuseCommit } from "@knowledge-base/api/lib/kb/git-write";
import { createMemoryRatePort } from "@knowledge-base/api/lib/kb/limits";
import { prismaAuthorityStore } from "@knowledge-base/api/lib/kb/permissions";
import {
  runJournalRecoverySweep,
  setKbRecoveryComplete,
} from "@knowledge-base/api/lib/kb/recovery";
import { configureKbRuntime } from "@knowledge-base/api/lib/kb/runtime";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createKbWriteCoordinator,
  runJournalTestPublish,
} from "../../../../apps/server/src/kb-write-coordinator.js";
import { documentsRouter } from "../../../api/src/routers/documents";

vi.mock("../../../../apps/server/src/kb-process.js", async (importOriginal) => ({
  ...(await importOriginal()),
  assertProcessFence() {},
}));
vi.mock("@knowledge-base/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});
vi.mock("../../../api/src/lib/procedure-budget", () => ({
  createProcedureBudget: () => async () => {},
}));

import { openKbPostgresClusterFromEnv } from "./index.js";

// The timed-out test still owns its async action. Drain before a successor can
// share the database/runtime or a spy can outlive its case.
let pendingAction: Promise<unknown> | undefined;
function runOwnedAction<T>(run: () => Promise<T>): Promise<T> {
  const action = Promise.resolve().then(run);
  pendingAction = action;
  return action;
}
afterEach(async () => {
  await pendingAction?.catch(() => {});
  pendingAction = undefined;
}, 180_000);

const cluster = await openKbPostgresClusterFromEnv();
const db = await cluster.createDatabase();
const prisma = db.createPrismaClient("runtime");
const reposDir = mkdtempSync(join(tmpdir(), "kb-bases-repos-"));
const children = new Map<number, Promise<{ opId: string; pid: number; status: number }>>();
const coordinator = createKbWriteCoordinator({
  connectionString: db.urls.runtime,
  closeAdmission: async () => {},
  async spawn(req) {
    const child = spawn(req.argv[0], req.argv.slice(1), {
      cwd: req.cwd,
      env: req.env,
      stdio: "ignore",
      timeout: 10_000,
      killSignal: "SIGKILL",
    });
    const exit = new Promise<{ opId: string; pid: number; status: number }>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (status) =>
        resolve({ opId: req.opId, pid: child.pid!, status: status ?? -1 }),
      );
    });
    children.set(child.pid!, exit);
    return { pid: child.pid! };
  },
  // The coordinator waits by (opId, pid); an unknown child is a harness bug.
  wait: async (_opId, pid) => {
    const exit = children.get(pid);
    if (!exit) throw new Error(`unknown supervised child ${pid}`);
    return exit;
  },
});

db.applyPrismaSchema();

const localGitExecutor = {
  exec({ cwd, argv, env }) {
    execFileSync(argv[0]!, argv.slice(1), { cwd, env, stdio: "ignore" });
  },
};

const runtimeAssetsDir = mkdtempSync(join(tmpdir(), "kb-bases-assets-"));
const runtime = {
  prisma,
  connectionString: db.urls.runtime,
  reposDir,
  assetsDir: runtimeAssetsDir,
  blobStore: createDiskBlobStore(runtimeAssetsDir),
  canonicalOrigin: "https://kb.example.com",
  cursorSigner: createCursorSigner(randomBytes(32)),
  ratePort: createMemoryRatePort(),
  diskMeter: { freeBytes: async () => 1n << 40n },
  coordinator,
  createGitExecutor: () => localGitExecutor,
};
configureKbRuntime(runtime);

function documentRead(method: "get" | "list", userId: string, kbId: string, rev?: string) {
  // Exercise the actual handlers with real PG authority and Git reads. Browser
  // session middleware and the Redis budget have their own transport tests.
  return documentsRouter[method]["~orpc"].handler({
    context: { session: { user: { id: userId } } },
    input: { kbId, path: "index.md", rev },
  });
}

afterAll(async () => {
  await prisma.$disconnect();
  await db.close();
  await cluster.close();
  rmSync(reposDir, { recursive: true, force: true });
});

async function owner() {
  return prisma.user.create({
    data: {
      name: "owner",
      email: `owner-${crypto.randomUUID()}@example.invalid`,
      emailVerified: true,
    },
  });
}

async function createKb(userId: string, slug: string) {
  return createKnowledgeBase(runtime, userId, {
    name: "KB",
    slug,
    description: "integration test knowledge base",
    idempotencyKey: `create-${slug}`,
  });
}

describe("kb lifecycle integration", () => {
  it("R52c persists scalar-boundary metadata and prioritizes changed-key mismatch over domain validation", () =>
    runOwnedAction(async () => {
      setKbRecoveryComplete(true);
      const user = await owner();
      const create = {
        name: "😀".repeat(120),
        slug: `scalar-${crypto.randomUUID().slice(0, 8)}`,
        description: "😀".repeat(2000),
        idempotencyKey: `create-${crypto.randomUUID()}`,
      };
      const created = await createKnowledgeBase(runtime, user.id, create);
      const kbId = created.kb.id as string;
      expect(await prisma.knowledgeBase.findUnique({ where: { id: kbId } })).toMatchObject({
        name: create.name,
        description: create.description,
      });
      const update = {
        kbId,
        metadataVersion: 1,
        name: "界".repeat(120),
        description: "😀".repeat(10),
        idempotencyKey: `update-${crypto.randomUUID()}`,
      };
      const updated = await updateKnowledgeBase(runtime, user.id, update);
      expect((await updateKnowledgeBase(runtime, user.id, update)).operationId).toBe(
        updated.operationId,
      );
      const before = await prisma.operationIntent.count({ where: { kbId } });
      for (const changed of [{ name: "bad\u0007name" }, { description: "bad\u0007description" }]) {
        await expect(
          updateKnowledgeBase(runtime, user.id, { ...update, ...changed }),
        ).rejects.toMatchObject({
          code: "IDEMPOTENCY_MISMATCH",
        });
        await expect(
          updateKnowledgeBase(runtime, user.id, {
            ...update,
            ...changed,
            metadataVersion: 2,
            idempotencyKey: `invalid-${crypto.randomUUID()}`,
          }),
        ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
      }
      expect(await prisma.operationIntent.count({ where: { kbId } })).toBe(before);
      expect(await prisma.knowledgeBase.findUnique({ where: { id: kbId } })).toMatchObject({
        name: update.name,
        description: update.description,
        metadataVersion: 2,
      });
    }));

  it("creates an initial main commit, activates the row, and keeps git on disk after tombstone", () =>
    runOwnedAction(async () => {
      setKbRecoveryComplete(true);
      const user = await owner();
      const first = await createKb(user.id, "notes");
      const kbId = first.kb.id as string;
      const repo = kbBareRepoPath(reposDir, kbId);
      expect(readHeadSha(repo)).toBe(first.kb.headSha);
      // The system author, and who created it (a browser session).
      const commit = execFileSync(
        "git",
        ["--git-dir", repo, "cat-file", "commit", first.kb.headSha as string],
        {
          encoding: "utf8",
        },
      );
      expect(commit.split("\n\n").slice(1).join("\n\n")).toBe(
        "Initial commit\n\nActed-by: owner via web\n",
      );
      const replay = await createKb(user.id, "notes");
      expect(replay.operationId).toBe(first.operationId);
      await prisma.knowledgeBase.update({
        where: { id: kbId },
        data: { metadataVersion: 1 },
      });
      await prisma.knowledgeBase.update({
        where: { id: kbId },
        data: { state: "TOMBSTONED", ownerId: null, metadataVersion: { increment: 1 } },
      });
      expect(existsSync(repo)).toBe(true);
    }));

  it("returns immutable document bytes at an older revision", () =>
    runOwnedAction(async () => {
      setKbRecoveryComplete(true);
      const user = await owner();
      const created = await createKb(user.id, "history");
      const kbId = created.kb.id as string;
      const repo = kbBareRepoPath(reposDir, kbId);
      const base = readHeadSha(repo)!;
      await runJournalTestPublish(coordinator, {
        store: prismaAuthorityStore(prisma),
        principal: { kind: "browser", userId: user.id },
        reposDir,
        kbId,
        idempotencyKey: "publish-1",
        request: { marker: "marker-1" },
      });
      const head = readHeadSha(repo)!;
      expect(head).not.toBe(base);
      const pinned = await resolvePinnedRevision(repo, base, head);
      for (const rev of [undefined, base]) {
        await expect(resolvePinnedRevision(repo, rev, null)).rejects.toMatchObject({
          code: "STORAGE_UNAVAILABLE",
        });
      }
      const doc = await readDocumentAtRevision({
        reposDir,
        kbId,
        commitSha: pinned,
        path: "index.md",
      });
      expect(doc.commitSha).toBe(base);
      expect(doc.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    }));

  it("resumes an interrupted create under its reserved identity", () =>
    runOwnedAction(async () => {
      setKbRecoveryComplete(true);
      const user = await owner();
      const key = `retry-${crypto.randomUUID()}`;
      const request = {
        name: "Retry KB",
        slug: `retry-${crypto.randomUUID().slice(0, 8)}`,
        description: "integration test knowledge base",
        idempotencyKey: key,
      };
      const starvedRuntime = { ...runtime, diskMeter: { freeBytes: async () => 0n } };
      await expect(createKnowledgeBase(starvedRuntime, user.id, request)).rejects.toMatchObject({
        code: "QUOTA_EXCEEDED",
      });
      const first = await createKnowledgeBase(runtime, user.id, request);
      const kbId = first.kb.id as string;
      const replay = await createKnowledgeBase(runtime, user.id, request);
      expect(replay.operationId).toBe(first.operationId);
      expect((replay.kb as { id: string }).id).toBe(kbId);
      const row = await prisma.knowledgeBase.findUnique({ where: { id: kbId } });
      expect(row?.state).toBe("ACTIVE");
      const ownerLive = await prisma.$queryRaw<{ committed: bigint }[]>`
      SELECT committed FROM "quota_account"
       WHERE dimension = 'OWNER_LIVE_KB' AND "subjectId" = ${user.id}`;
      expect(ownerLive[0]?.committed).toBe(1n);
    }));

  it("replays a finalized tombstone receipt and audits update/tombstone", () =>
    runOwnedAction(async () => {
      setKbRecoveryComplete(true);
      const user = await owner();
      const created = await createKnowledgeBase(runtime, user.id, {
        name: "Del KB",
        slug: `del-${crypto.randomUUID().slice(0, 8)}`,
        description: "integration test knowledge base",
        idempotencyKey: `create-${crypto.randomUUID()}`,
      });
      const kbId = created.kb.id as string;
      const beforeUpdate = await prisma.knowledgeBase.findUnique({ where: { id: kbId } });
      const updateRequest = {
        kbId,
        metadataVersion: beforeUpdate?.metadataVersion ?? 1,
        idempotencyKey: "upd-1",
        name: "Renamed KB",
      };
      const updated = await updateKnowledgeBase(runtime, user.id, updateRequest);
      expect((updated.kb as { name: string }).name).toBe("Renamed KB");
      const updateReplay = await updateKnowledgeBase(runtime, user.id, updateRequest);
      expect(updateReplay.operationId).toBe(updated.operationId);
      const afterUpdate = await prisma.knowledgeBase.findUnique({ where: { id: kbId } });
      const deleteRequest = {
        kbId,
        metadataVersion: afterUpdate?.metadataVersion ?? 2,
        idempotencyKey: "del-1",
        confirm: "DELETE",
      };
      const deleted = await deleteKnowledgeBase(runtime, user.id, deleteRequest);
      expect(deleted.tombstoned).toBe(true);
      const deleteReplay = await deleteKnowledgeBase(runtime, user.id, deleteRequest);
      expect(deleteReplay.operationId).toBe(deleted.operationId);
      expect(deleteReplay.tombstoned).toBe(true);
      const audits = await prisma.$queryRaw<{ action: string }[]>`
      SELECT action FROM "audit_event" WHERE "kbId" = ${kbId}`;
      const actions = audits.map((row) => row.action).sort();
      expect(actions).toContain("kb_create");
      expect(actions).toContain("kb_update");
      expect(actions).toContain("kb_tombstone");
    }));

  it("uses distinct sealed namespaces per kb and stable rename", () =>
    runOwnedAction(async () => {
      const origin = "https://kb.example.com";
      const a = sealedNamespaceUuidV5(remoteAttachmentLocator(origin, "aaaaaaaaaaaaaaaaaaaaaaaa"));
      const b = sealedNamespaceUuidV5(remoteAttachmentLocator(origin, "bbbbbbbbbbbbbbbbbbbbbbbb"));
      expect(a).not.toBe(b);
      const renamed = sealedNamespaceUuidV5(
        remoteAttachmentLocator(origin, "aaaaaaaaaaaaaaaaaaaaaaaa"),
      );
      expect(a).toBe(renamed);
    }));

  it("re-authorizes update receipt replay against live share state with a live-derived attachment", () =>
    runOwnedAction(async () => {
      setKbRecoveryComplete(true);
      const ownerUser = await owner();
      const manager = await prisma.user.create({
        data: {
          name: "manager",
          email: `manager-${crypto.randomUUID()}@example.invalid`,
          emailVerified: true,
        },
      });
      const created = await createKnowledgeBase(runtime, ownerUser.id, {
        name: "Shared KB",
        slug: `shared-${crypto.randomUUID().slice(0, 8)}`,
        description: "integration test knowledge base",
        idempotencyKey: `create-${crypto.randomUUID()}`,
      });
      const kbId = created.kb.id as string;
      await prisma.kbShare.create({ data: { kbId, userId: manager.id, bits: ["manage"] } });
      const before = await prisma.knowledgeBase.findUnique({ where: { id: kbId } });
      const request = {
        kbId,
        metadataVersion: before?.metadataVersion ?? 1,
        idempotencyKey: "upd-shared-1",
        description: "manager authored description text",
      };
      const updated = await updateKnowledgeBase(runtime, manager.id, request);
      expect((updated.kb as { capabilities: string[] }).capabilities).toContain("manage");
      // A later owner update must be reflected in the manager's replay: the
      // receipt body is re-derived from the live row, not the stored response.
      const afterManager = await prisma.knowledgeBase.findUnique({ where: { id: kbId } });
      await updateKnowledgeBase(runtime, ownerUser.id, {
        kbId,
        metadataVersion: afterManager?.metadataVersion ?? 2,
        idempotencyKey: "upd-owner-1",
        name: "Owner Renamed",
      });
      const liveRow = await prisma.knowledgeBase.findUnique({ where: { id: kbId } });
      const replay = await updateKnowledgeBase(runtime, manager.id, request);
      expect(replay.operationId).toBe(updated.operationId);
      expect((replay.kb as { name: string }).name).toBe("Owner Renamed");
      expect((replay.kb as { metadataVersion: number }).metadataVersion).toBe(
        liveRow?.metadataVersion,
      );
      // Revoked: get denies the KB, and receipt replay must deny it too.
      await prisma.kbShare.update({
        where: { kbId_userId: { kbId, userId: manager.id } },
        data: { revokedAt: new Date() },
      });
      await expect(getKnowledgeBaseAttachment(runtime, manager.id, kbId)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      await expect(updateKnowledgeBase(runtime, manager.id, request)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    }));

  it("viewer list splits owned from shared, flags isOwner, and binds cursors per relation", () =>
    runOwnedAction(async () => {
      setKbRecoveryComplete(true);
      const me = await owner();
      const other = await owner();
      const tag = crypto.randomUUID().slice(0, 8);
      const mine = [];
      for (const n of [1, 2, 3]) mine.push((await createKb(me.id, `mine-${n}-${tag}`)).kb.id);
      const theirs = (await createKb(other.id, `theirs-${tag}`)).kb.id;
      const revoked = (await createKb(other.id, `revoked-${tag}`)).kb.id;
      const unshared = (await createKb(other.id, `unshared-${tag}`)).kb.id;
      await prisma.kbShare.create({
        data: { kbId: theirs, userId: me.id, bits: ["read", "manage"] },
      });
      await prisma.kbShare.create({
        data: { kbId: revoked, userId: me.id, bits: ["read"], revokedAt: new Date() },
      });
      const ids = (page: { items: { id: string }[] }) => page.items.map((kb) => kb.id);

      const owned = await listKnowledgeBasesForViewer(runtime, me.id, { relation: "owned" });
      expect(new Set(ids(owned))).toEqual(new Set(mine));
      expect(owned.items.every((kb) => kb.isOwner === true)).toBe(true);
      const shared = await listKnowledgeBasesForViewer(runtime, me.id, { relation: "shared" });
      expect(ids(shared)).toEqual([theirs]);
      expect(shared.items[0]).toMatchObject({ isOwner: false });
      expect(shared.items[0]!.capabilities).toContain("manage");
      const all = await listKnowledgeBasesForViewer(runtime, me.id, {});
      expect(new Set(ids(all))).toEqual(new Set([...mine, theirs]));
      expect(ids(all)).not.toContain(revoked);
      expect(ids(all)).not.toContain(unshared);
      // The protocol listing (MCP) is unchanged: same set, no owner field.
      const protocol = await listKnowledgeBases(runtime, me.id, {});
      expect(new Set(ids(protocol))).toEqual(new Set(ids(all)));
      expect(protocol.items.every((kb) => !("isOwner" in kb))).toBe(true);

      // Each relation paginates on its own; a cursor never crosses relations.
      const first = await listKnowledgeBasesForViewer(runtime, me.id, {
        relation: "owned",
        limit: 2,
      });
      expect(first.items).toHaveLength(2);
      expect(first.nextCursor).not.toBeNull();
      const second = await listKnowledgeBasesForViewer(runtime, me.id, {
        relation: "owned",
        limit: 2,
        cursor: first.nextCursor,
      });
      expect(new Set([...ids(first), ...ids(second)])).toEqual(new Set(mine));
      await expect(
        listKnowledgeBasesForViewer(runtime, me.id, {
          relation: "shared",
          limit: 2,
          cursor: first.nextCursor,
        }),
      ).rejects.toThrow();

      expect(await getKnowledgeBaseForViewer(runtime, me.id, mine[0]!)).toMatchObject({
        isOwner: true,
      });
      expect(await getKnowledgeBaseForViewer(runtime, me.id, theirs)).toMatchObject({
        isOwner: false,
      });
      expect(await getKnowledgeBaseForViewer(runtime, other.id, theirs)).toMatchObject({
        isOwner: true,
      });
      await expect(getKnowledgeBaseForViewer(runtime, me.id, unshared)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    }));

  it("denies create receipt replay after ownership loss", () =>
    runOwnedAction(async () => {
      setKbRecoveryComplete(true);
      const creator = await owner();
      const other = await owner();
      const request = {
        name: "Loss KB",
        slug: `loss-${crypto.randomUUID().slice(0, 8)}`,
        description: "integration test knowledge base",
        idempotencyKey: `loss-${crypto.randomUUID()}`,
      };
      const created = await createKnowledgeBase(runtime, creator.id, request);
      const kbId = created.kb.id as string;
      const replay = await createKnowledgeBase(runtime, creator.id, request);
      expect(replay.operationId).toBe(created.operationId);
      await prisma.knowledgeBase.update({
        where: { id: kbId },
        data: { ownerId: other.id, metadataVersion: { increment: 1 } },
      });
      await expect(createKnowledgeBase(runtime, creator.id, request)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    }));

  it.each([
    { operation: "update", remainingBit: null, error: "NOT_FOUND" },
    { operation: "update", remainingBit: "read", error: "FORBIDDEN" },
    { operation: "create", remainingBit: null, error: "NOT_FOUND" },
    { operation: "create", remainingBit: "write", error: null },
  ])(
    "rechecks $operation replay after authority changes during metadata fetch ($remainingBit)",
    ({ operation, remainingBit, error }) =>
      runOwnedAction(async () => {
        setKbRecoveryComplete(true);
        const actor = await owner();
        const other = await owner();
        const request = {
          name: "Replay race KB",
          slug: `replay-${crypto.randomUUID().slice(0, 8)}`,
          description: "integration test knowledge base",
          idempotencyKey: `replay-${crypto.randomUUID()}`,
        };
        const created = await createKnowledgeBase(runtime, actor.id, request);
        const kbId = created.kb.id;
        const update = {
          kbId,
          metadataVersion: created.kb.metadataVersion,
          name: "Updated before replay",
          idempotencyKey: `update-${crypto.randomUUID()}`,
        };
        if (operation === "update") {
          await prisma.knowledgeBase.update({ where: { id: kbId }, data: { ownerId: other.id } });
          await prisma.kbShare.create({ data: { kbId, userId: actor.id, bits: ["manage"] } });
          await updateKnowledgeBase(runtime, actor.id, update);
        }
        const loadRow = prisma.knowledgeBase.findUnique.bind(prisma.knowledgeBase);
        let changed = false;
        const fetch = vi
          .spyOn(prisma.knowledgeBase, "findUnique")
          .mockImplementation(async (args) => {
            if (!changed && args.where.id === kbId && args.select?.description) {
              changed = true;
              // Runs after initial authorization, before the private row is read.
              await prisma.knowledgeBase.update({
                where: { id: kbId },
                data: { ownerId: other.id, description: "Private metadata after authority change" },
              });
              await prisma.kbShare.upsert({
                where: { kbId_userId: { kbId, userId: actor.id } },
                create: { kbId, userId: actor.id, bits: remainingBit ? [remainingBit] : [] },
                update: {
                  bits: remainingBit ? [remainingBit] : [],
                  revokedAt: remainingBit ? null : new Date(),
                },
              });
            }
            return loadRow(args);
          });
        try {
          const replay =
            operation === "create"
              ? createKnowledgeBase(runtime, actor.id, request)
              : updateKnowledgeBase(runtime, actor.id, update);
          if (error) {
            await expect(replay).rejects.toMatchObject({ code: error });
          } else {
            await expect(replay).resolves.toMatchObject({
              operationId: created.operationId,
              kb: {
                capabilities: ["read", "propose", "write"],
                description: "Private metadata after authority change",
              },
            });
          }
          expect(changed).toBe(true);
        } finally {
          fetch.mockRestore();
        }
      }),
  );

  describe.each([
    "before-init",
    "before-cas",
    "published",
    "diverged",
    "corrupt-object",
    "corrupt-ref",
  ])("recovers interrupted create without discarding published evidence: %s", (stage) => {
    async function prepare() {
      setKbRecoveryComplete(true);
      const user = await owner();
      const request = {
        name: "Recovery KB",
        slug: `recovery-${crypto.randomUUID().slice(0, 8)}`,
        description: "integration test knowledge base",
        idempotencyKey: `recovery-${crypto.randomUUID()}`,
      };
      const interruptedRuntime = {
        ...runtime,
        createGitExecutor: () => ({
          exec(input) {
            if (stage === "before-init" && input.argv.includes("init"))
              throw new Error("create interrupted");
            if (stage === "before-cas" && input.argv.includes("update-ref"))
              throw new Error("create interrupted");
            localGitExecutor.exec(input);
            if (input.argv.includes("update-ref")) throw new Error("create interrupted");
          },
        }),
      };
      await expect(createKnowledgeBase(interruptedRuntime, user.id, request)).rejects.toThrow(
        "create interrupted",
      );
      const intent = await prisma.operationIntent.findFirstOrThrow({
        where: {
          actorKey: `user:${user.id}`,
          operation: "KB_CREATE",
          idempotencyKey: request.idempotencyKey,
        },
      });
      expect(intent.phase).toBe("COMMITTING");
      const kbId = intent.reservedKbId;
      const repo = kbBareRepoPath(reposDir, kbId);
      expect((await prisma.knowledgeBase.findUniqueOrThrow({ where: { id: kbId } })).state).toBe(
        "CREATING",
      );
      if (stage === "diverged") {
        const next = await createTreeReuseCommit(
          { reposDir, kbId },
          { parentSha: intent.newRef, message: "unexplained commit" },
        );
        execFileSync(
          "git",
          ["--git-dir", repo, "update-ref", "refs/heads/main", next, intent.newRef],
          { stdio: "ignore" },
        );
      } else if (stage === "corrupt-object") {
        writeFileSync(
          join(repo, "objects", intent.newRef.slice(0, 2), intent.newRef.slice(2)),
          "corrupt object",
        );
      } else if (stage === "corrupt-ref") {
        writeFileSync(join(repo, "refs/heads/main"), "corrupt ref\n");
      }
      const unpublished = stage === "before-init" || stage === "before-cas";
      const repair = !unpublished && stage !== "published";
      const actual = readHeadSha(repo);
      const refBytes = unpublished ? null : readFileSync(join(repo, "refs/heads/main"), "utf8");

      return { user, intent, kbId, repo, unpublished, repair, actual, refBytes };
    }
    let fixture: Awaited<ReturnType<typeof prepare>>;
    let setup: Promise<void> | undefined;
    let action: Promise<void> | undefined;
    beforeAll(() => {
      // Interrupted history is a prerequisite. Recovery/deletion keeps its
      // original 30s action deadline, independently of durable fixture I/O.
      setup = prepare().then((prepared) => {
        fixture = prepared;
      });
      return setup;
    }, 180_000);
    afterAll(async () => {
      await setup?.catch(() => {});
      await action?.catch(() => {});
    }, 180_000);
    afterEach(async () => {
      await action?.catch(() => {});
    }, 180_000);
    it.each([0, 1])("preserves the journal, refs and quota on sweep %i", () => {
      action = (async () => {
        const { user, intent, kbId, repo, unpublished, repair, actual, refBytes } = fixture;
        // The second sweep must preserve the first result and never double-charge
        // or release the quota for quarantined published history.
        {
          await runJournalRecoverySweep(
            prisma,
            reposDir,
            runtime.assetsDir,
            db.urls.runtime,
            () => {},
          );
          const row = await prisma.knowledgeBase.findUniqueOrThrow({ where: { id: kbId } });
          expect(row.state).toBe(
            repair ? "REPAIR_REQUIRED" : unpublished ? "TOMBSTONED" : "ACTIVE",
          );
          expect(row.headSha).toBe(stage === "published" ? intent.newRef : null);
          expect(readHeadSha(repo)).toBe(actual);
          if (refBytes !== null)
            expect(readFileSync(join(repo, "refs/heads/main"), "utf8")).toBe(refBytes);
          const settled = await prisma.operationIntent.findUniqueOrThrow({
            where: { opId: intent.opId },
          });
          expect(settled.phase).toBe(stage === "published" ? "FINALIZED" : "ABORTED");
          expect(settled.oldRef).toBe(intent.oldRef);
          expect(settled.newRef).toBe(intent.newRef);
          expect(settled.preparedDelta).toEqual(intent.preparedDelta);
          if (repair) expect(settled.abortReason).toBe("kb create ref diverged or is corrupt");
          if (repair) {
            for (const method of ["get", "list"] as const) {
              for (const rev of [undefined, intent.newRef]) {
                await expect(documentRead(method, user.id, kbId, rev)).rejects.toMatchObject({
                  code: "REPAIR_REQUIRED",
                });
              }
            }
            // Repair management retains human metadata, while common attachments require a usable head.
            await expect(getKnowledgeBaseForViewer(runtime, user.id, kbId)).resolves.toMatchObject({
              id: kbId,
              headSha: null,
              isOwner: true,
            });
            await expect(getKnowledgeBaseAttachment(runtime, user.id, kbId)).rejects.toMatchObject({
              code: "REPAIR_REQUIRED",
            });
          }
          const quota = await prisma.quotaReservation.findUniqueOrThrow({
            where: { id: intent.preparedDelta.quotaReservationId },
          });
          expect(quota.outcome).toBe(repair ? "RESERVED" : unpublished ? "RELEASED" : "COMMITTED");
          expect(
            await prisma.auditEvent.count({ where: { opId: intent.opId, action: "kb_create" } }),
          ).toBe(stage === "published" ? 1 : 0);
        }
      })();
      return action;
    });
  });

  describe.each(["get", "list", "create replay", "update replay"] as const)(
    "common attachment enters repair during %s assembly",
    (operation) => {
      async function prepare() {
        setKbRecoveryComplete(true);
        const user = await owner();
        const request = {
          name: "Attachment race",
          slug: `attachment-${crypto.randomUUID().slice(0, 8)}`,
          description: "integration test knowledge base",
          idempotencyKey: crypto.randomUUID(),
        };
        const created = await createKnowledgeBase(runtime, user.id, request);
        const update = {
          kbId: created.kb.id,
          metadataVersion: created.kb.metadataVersion,
          name: "Ready attachment",
          idempotencyKey: crypto.randomUUID(),
        };
        if (operation === "update replay") await updateKnowledgeBase(runtime, user.id, update);
        await expect(
          getKnowledgeBaseAttachment(runtime, user.id, created.kb.id),
        ).resolves.toMatchObject({
          headSha: created.kb.headSha,
        });
        return { user, created, request, update };
      }
      let context: Awaited<ReturnType<typeof prepare>>;
      let setup: Promise<void> | undefined;
      let action: Promise<void> | undefined;
      beforeAll(() => {
        setup = runOwnedAction(async () => {
          context = await prepare();
        });
        return setup;
      }, 180_000);
      afterAll(async () => {
        await setup?.catch(() => {});
        await action?.catch(() => {});
      }, 180_000);
      it("uses the final live state and retains human diagnostics", () => {
        action = runOwnedAction(async () => {
          const { user, created, request, update } = context;
          const kbId = created.kb.id;
          const load = prisma.knowledgeBase.findUnique.bind(prisma.knowledgeBase);
          let changed = false;
          const fetch = vi
            .spyOn(prisma.knowledgeBase, "findUnique")
            .mockImplementation(async (args) => {
              if (
                !changed &&
                args.where.id === kbId &&
                (operation === "list" || args.select?.description)
              ) {
                // Metadata has already been fetched/assembled. Persist repair before
                // the final authority query; every query still reaches real PG.
                const row = operation === "list" ? null : await load(args);
                changed = true;
                await prisma.knowledgeBase.update({
                  where: { id: kbId },
                  data: { state: "REPAIR_REQUIRED", headSha: null },
                });
                return operation === "list" ? load(args) : row;
              }
              return load(args);
            });
          try {
            const result =
              operation === "get"
                ? getKnowledgeBaseAttachment(runtime, user.id, kbId)
                : operation === "list"
                  ? listKnowledgeBases(runtime, user.id, {})
                  : operation === "create replay"
                    ? createKnowledgeBase(runtime, user.id, request)
                    : updateKnowledgeBase(runtime, user.id, update);
            if (operation === "list") await expect(result).resolves.toMatchObject({ items: [] });
            else await expect(result).rejects.toMatchObject({ code: "REPAIR_REQUIRED" });
            expect(changed).toBe(true);
          } finally {
            fetch.mockRestore();
          }
          await expect(getKnowledgeBaseForViewer(runtime, user.id, kbId)).resolves.toMatchObject({
            id: kbId,
            headSha: null,
            isOwner: true,
          });
        });
        return action;
      });
    },
  );

  it.each(["get", "list"] as const)(
    "rejects %s results when the KB enters quarantine during the read",
    (method) =>
      runOwnedAction(async () => {
        setKbRecoveryComplete(true);
        const user = await owner();
        const created = await createKb(user.id, `read-${method}`);
        const kbId = created.kb.id;
        await expect(documentRead(method, user.id, kbId)).resolves.toBeDefined();
        const load = prisma.knowledgeBase.findUnique.bind(prisma.knowledgeBase);
        let admissions = 0;
        const spy = vi
          .spyOn(prisma.knowledgeBase, "findUnique")
          .mockImplementation(async (args) => {
            if (args.where.id === kbId && args.select?.ownerId && ++admissions === 2) {
              await prisma.knowledgeBase.update({
                where: { id: kbId },
                data: { state: "REPAIR_REQUIRED" },
              });
            }
            return load(args);
          });
        try {
          await expect(documentRead(method, user.id, kbId)).rejects.toMatchObject({
            code: "REPAIR_REQUIRED",
          });
          expect(admissions).toBe(2);
        } finally {
          spy.mockRestore();
        }
      }),
  );

  it.each([
    { bits: [], error: "NOT_FOUND" },
    { bits: ["read"], error: "FORBIDDEN" },
  ])(
    "rechecks queued update replay after a metadata-read authority change ($error)",
    ({ bits, error }) =>
      runOwnedAction(async () => {
        setKbRecoveryComplete(true);
        const user = await owner();
        const manager = await owner();
        const created = await createKb(
          user.id,
          `queued-${error.toLowerCase().replaceAll("_", "-")}`,
        );
        const kbId = created.kb.id;
        await prisma.kbShare.create({ data: { kbId, userId: manager.id, bits: ["manage"] } });
        const request = {
          kbId,
          metadataVersion: 1,
          name: "Manager update",
          idempotencyKey: "queued-update",
        };
        await updateKnowledgeBase(runtime, manager.id, request);
        // Simulate the unlocked lookup racing the first request's commit. The
        // locked lookup must find the real FINALIZED receipt on the pinned session.
        const lookup = vi.spyOn(prisma.operationIntent, "findFirst").mockResolvedValueOnce(null);
        let changed = false;
        const queuedRuntime = {
          ...runtime,
          coordinator: {
            run: (options) =>
              coordinator.run({
                ...options,
                barrier: {
                  ...options.barrier,
                  reauthorize: (ctx) =>
                    options.barrier.reauthorize({
                      ...ctx,
                      query: async (sql, params) => {
                        if (!changed && sql.includes("SELECT id, name, slug, description")) {
                          changed = true;
                          await prisma.kbShare.update({
                            where: { kbId_userId: { kbId, userId: manager.id } },
                            data: { bits },
                          });
                          await prisma.knowledgeBase.update({
                            where: { id: kbId },
                            data: { description: "Private metadata after revocation" },
                          });
                        }
                        return ctx.query(sql, params);
                      },
                    }),
                },
              }),
          },
        };
        try {
          await expect(
            updateKnowledgeBase(queuedRuntime, manager.id, request),
          ).rejects.toMatchObject({ code: error });
          expect(changed).toBe(true);
        } finally {
          lookup.mockRestore();
        }
      }),
  );

  describe.each(["before-init", "before-cas", "published", "quarantined"])(
    "tombstones an interrupted create and releases only its live quota: %s",
    (stage) => {
      async function prepare() {
        setKbRecoveryComplete(true);
        const user = await owner();
        const retained = await createKb(user.id, "retained");
        const request = {
          name: "Interrupted",
          slug: "interrupted",
          description: "Interrupted create for deletion",
          idempotencyKey: "interrupted-delete",
        };
        await expect(
          createKnowledgeBase(
            {
              ...runtime,
              createGitExecutor: () => ({
                exec(input) {
                  if (stage === "before-init" && input.argv.includes("init"))
                    throw new Error("interrupted");
                  if (stage === "before-cas" && input.argv.includes("update-ref"))
                    throw new Error("interrupted");
                  localGitExecutor.exec(input);
                  if (input.argv.includes("update-ref")) throw new Error("interrupted");
                },
              }),
            },
            user.id,
            request,
          ),
        ).rejects.toThrow("interrupted");
        const intent = await prisma.operationIntent.findFirstOrThrow({
          where: {
            actorKey: `user:${user.id}`,
            operation: "KB_CREATE",
            idempotencyKey: request.idempotencyKey,
          },
        });
        const kbId = intent.reservedKbId;
        const repo = kbBareRepoPath(reposDir, kbId);
        if (stage === "quarantined") {
          const next = await createTreeReuseCommit(
            { reposDir, kbId },
            { parentSha: intent.newRef, message: "unexplained" },
          );
          execFileSync("git", [
            "--git-dir",
            repo,
            "update-ref",
            "refs/heads/main",
            next,
            intent.newRef,
          ]);
          await runJournalRecoverySweep(
            prisma,
            reposDir,
            runtime.assetsDir,
            db.urls.runtime,
            () => {},
          );
        }
        const before = await prisma.knowledgeBase.findUniqueOrThrow({ where: { id: kbId } });
        expect(before.state).toBe(stage === "quarantined" ? "REPAIR_REQUIRED" : "CREATING");
        const actual = readHeadSha(repo);
        const deletion = {
          kbId,
          metadataVersion: before.metadataVersion,
          idempotencyKey: "delete-interrupted",
          confirm: "DELETE",
        };

        return { user, retained, intent, kbId, repo, actual, deletion };
      }
      let fixture: Awaited<ReturnType<typeof prepare>>;
      let setup: Promise<void> | undefined;
      let action: Promise<void> | undefined;
      beforeAll(() => {
        // Interrupted history is a prerequisite. Recovery/deletion keeps its
        // original 30s action deadline, independently of durable fixture I/O.
        setup = prepare().then((prepared) => {
          fixture = prepared;
        });
        return setup;
      }, 180_000);
      afterAll(async () => {
        await setup?.catch(() => {});
        await action?.catch(() => {});
      }, 180_000);
      let result: Awaited<ReturnType<typeof deleteKnowledgeBase>>;
      afterEach(async () => {
        await action?.catch(() => {});
      }, 180_000);
      it("deletes the interrupted identity and records its receipt", () => {
        action = (async () => {
          const { user, kbId, deletion } = fixture;
          result = await deleteKnowledgeBase(runtime, user.id, deletion);
          expect(result).toBeDefined();
          expect(
            await prisma.knowledgeBase.findUniqueOrThrow({ where: { id: kbId } }),
          ).toMatchObject({ state: "TOMBSTONED", ownerId: null });
        })();
        return action;
      });
      it.each([0, 1])("preserves the journal, refs and quota on replay %i", () => {
        action = (async () => {
          const { user, retained, intent, kbId, repo, actual, deletion } = fixture;
          expect(result).toBeDefined();
          {
            await expect(deleteKnowledgeBase(runtime, user.id, deletion)).resolves.toEqual(result);
            await runJournalRecoverySweep(
              prisma,
              reposDir,
              runtime.assetsDir,
              db.urls.runtime,
              () => {},
            );
            expect(
              await prisma.knowledgeBase.findUniqueOrThrow({ where: { id: kbId } }),
            ).toMatchObject({ state: "TOMBSTONED", ownerId: null });
            const account = await prisma.quotaAccount.findFirstOrThrow({
              where: { dimension: "OWNER_LIVE_KB", subjectId: user.id },
            });
            expect(account).toMatchObject({ reserved: 0n, committed: 1n });
            const settled = await prisma.operationIntent.findUniqueOrThrow({
              where: { opId: intent.opId },
            });
            expect(settled).toMatchObject({
              phase: stage === "published" ? "FINALIZED" : "ABORTED",
              oldRef: intent.oldRef,
              newRef: intent.newRef,
              preparedDelta: intent.preparedDelta,
            });
            if (stage === "quarantined")
              expect(settled.abortReason).toBe("kb create ref diverged or is corrupt");
            expect(readHeadSha(repo)).toBe(actual);
            expect(await prisma.auditEvent.count({ where: { kbId, action: "kb_tombstone" } })).toBe(
              1,
            );
            expect(await prisma.auditEvent.count({ where: { kbId, action: "kb_create" } })).toBe(
              stage === "published" ? 1 : 0,
            );
          }
          expect(
            await prisma.knowledgeBase.findUniqueOrThrow({ where: { id: retained.kb.id } }),
          ).toMatchObject({ state: "ACTIVE" });
        })();
        return action;
      });
    },
  );

  it("reads an adversarial bracket document through the real get path in bounded time", () =>
    runOwnedAction(async () => {
      setKbRecoveryComplete(true);
      const user = await owner();
      const created = await createKnowledgeBase(runtime, user.id, {
        name: "Adversarial KB",
        slug: `adversarial-${crypto.randomUUID().slice(0, 8)}`,
        description: "integration test knowledge base",
        idempotencyKey: `create-${crypto.randomUUID()}`,
      });
      const kbId = created.kb.id as string;
      const repo = kbBareRepoPath(reposDir, kbId);
      const base = readHeadSha(repo)!;
      const markdown = `${"[".repeat(128 * 1024)}](real.png)`;
      const blob = execFileSync("git", ["--git-dir", repo, "hash-object", "-w", "--stdin"], {
        input: markdown,
        env: hardenedGitEnv(),
      })
        .toString()
        .trim();
      const tree = execFileSync("git", ["--git-dir", repo, "mktree"], {
        input: `100644 blob ${blob}\tindex.md\n`,
        env: hardenedGitEnv(),
      })
        .toString()
        .trim();
      const commit = execFileSync(
        "git",
        ["--git-dir", repo, "commit-tree", tree, "-p", base, "-m", "adversarial"],
        { env: hardenedGitEnv() },
      )
        .toString()
        .trim();
      execFileSync("git", ["--git-dir", repo, "update-ref", "refs/heads/main", commit, base], {
        env: hardenedGitEnv(),
      });
      await prisma.knowledgeBase.update({ where: { id: kbId }, data: { headSha: commit } });
      const doc = await readDocumentAtRevision({
        reposDir,
        kbId,
        commitSha: commit,
        path: "index.md",
      });
      // Parser CPU-work bounds are checked in documents-read.test.ts with a
      // larger hostile input. This real-I/O case checks the immutable read result.
      expect(doc.markdown).toBe(markdown);
      expect(doc.assetRefs).toEqual([]);
    }));
});
