// @ts-nocheck — PG/Git integration harness.
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteKnowledgeBase } from "@knowledge-base/api/lib/kb/bases";
import { createCursorSigner } from "@knowledge-base/api/lib/kb/cursor";
import { kbBareRepoPath, readHeadSha, readRefSha } from "@knowledge-base/api/lib/kb/git-read";
import {
  GitCommandError,
  type GitMutatingExecutor,
  writeInitialMainCommit,
} from "@knowledge-base/api/lib/kb/git-write";
import { createMemoryRatePort } from "@knowledge-base/api/lib/kb/limits";
import {
  type PublicationBarrier,
  reconcileKbIntents,
} from "@knowledge-base/api/lib/kb/operation-intent";
import { prismaAuthorityStore } from "@knowledge-base/api/lib/kb/permissions";
import { setKbRecoveryComplete } from "@knowledge-base/api/lib/kb/recovery";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createKbWriteCoordinator,
  runChangesApply,
} from "../../../../apps/server/src/kb-write-coordinator.js";

vi.mock("../../../../apps/server/src/kb-process.js", async (importOriginal) => ({
  ...(await importOriginal()),
  assertProcessFence() {},
}));

import { openKbPostgresClusterFromEnv } from "./index.js";

const DESCRIPTION = "changes integration knowledge base";

const executor: GitMutatingExecutor = {
  exec({ cwd, argv, env }) {
    return new Promise((resolve, reject) => {
      const child = spawn(argv[0]!, argv.slice(1), {
        cwd,
        env,
        stdio: ["ignore", "ignore", "ignore"],
      });
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code === 0) resolve();
        else reject(new GitCommandError(String(argv[1] ?? argv[0]), code ?? -1));
      });
    });
  },
};

const cluster = await openKbPostgresClusterFromEnv();
const db = await cluster.createDatabase();
const prisma = db.createPrismaClient("runtime");
const reposDir = mkdtempSync(join(tmpdir(), "kb-changes-repos-"));
const children = new Map();
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
    const exit = new Promise((resolve, reject) => {
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

afterAll(async () => {
  await prisma.$disconnect();
  await db.close();
  await cluster.close();
  rmSync(reposDir, { recursive: true, force: true });
});

async function owner() {
  return prisma.user.create({
    data: {
      name: "changes",
      email: `changes-${crypto.randomUUID()}@example.invalid`,
      emailVerified: true,
    },
  });
}

async function activeKb(userId: string) {
  const kb = await prisma.knowledgeBase.create({
    data: {
      ownerId: userId,
      name: "Changes KB",
      slug: `chg-${crypto.randomUUID().slice(0, 8)}`,
      description: DESCRIPTION,
      state: "CREATING",
      headSha: null,
    },
  });
  const head = await writeInitialMainCommit(
    { reposDir, kbId: kb.id, executor },
    { message: "init", description: DESCRIPTION },
  );
  return prisma.knowledgeBase.update({
    where: { id: kb.id },
    data: { state: "ACTIVE", headSha: head },
  });
}

function applyEdit(
  kbId: string,
  userId: string,
  baseRevision: string,
  key: string,
  changes: unknown[],
  options?: { diskMeter?: { freeBytes(): Promise<bigint> }; barrier?: PublicationBarrier },
) {
  setKbRecoveryComplete(true);
  return runChangesApply(coordinator, {
    store: prismaAuthorityStore(prisma),
    principal: { kind: "browser", userId },
    reposDir,
    kbId,
    idempotencyKey: key,
    request: {
      mode: "edit",
      baseRevision,
      title: "edit",
      changes,
      sourceSessionIds: [],
    },
    ratePort: createMemoryRatePort(),
    diskMeter: options?.diskMeter,
    barrier: options?.barrier,
  });
}

async function quotaCommitted(kbId: string, dimension: "KB_BRANCH" | "KB_HISTORY_BYTES") {
  const rows = await prisma.$queryRaw<{ committed: bigint; reserved: bigint }[]>`
    SELECT committed, reserved FROM "quota_account"
     WHERE dimension = ${dimension}::"QuotaDimension" AND "subjectId" = ${kbId}`;
  return rows[0] ?? null;
}

async function seedExhaustedQuota(kbId: string, dimension: "KB_BRANCH" | "KB_HISTORY_BYTES") {
  await prisma.$executeRaw`
    INSERT INTO "quota_account" (id, dimension, "subjectId", committed, reserved, "updatedAt")
    VALUES (${crypto.randomUUID()}, ${dimension}::"QuotaDimension", ${kbId}, 1073741824::bigint, 0::bigint, now())`;
}

async function proposeOnlyShare(kbId: string) {
  const user = await owner();
  await prisma.kbShare.create({
    data: { kbId, userId: user.id, bits: ["read", "propose"] },
  });
  return user;
}

/** Physical size of the bare repository's loose-object store. */
function looseObjectBytes(repo: string): bigint {
  const objectsDir = join(repo, "objects");
  let total = 0n;
  for (const entry of readdirSync(objectsDir, { withFileTypes: true })) {
    if (!/^[0-9a-f]{2}$/.test(entry.name)) continue;
    for (const name of readdirSync(join(objectsDir, entry.name))) {
      total += BigInt(statSync(join(objectsDir, entry.name, name)).size);
    }
  }
  return total;
}

describe("changes integration", () => {
  let prepared: {
    user: Awaited<ReturnType<typeof owner>>;
    kb: Awaited<ReturnType<typeof activeKb>>;
  };
  // Initial repository durability is fixture work. Keep the existing hook and
  // action budgets, and each publication's independent 30s scope.
  beforeEach(async () => {
    const user = await owner();
    const kb = await activeKb(user.id);
    prepared = { user, kb };
  });
  it.each([
    { barrier: "afterPrepared", proposal: false, tombstone: false },
    { barrier: "afterCommitting", proposal: false, tombstone: false },
    { barrier: "afterPrepared", proposal: true, tombstone: false },
    { barrier: "afterCommitting", proposal: true, tombstone: false },
    { barrier: "afterPrepared", proposal: true, tombstone: true },
  ] as const)(
    "keeps retained history charged after $barrier (proposal=$proposal, tombstone=$tombstone)",
    async ({ barrier, proposal, tombstone }) => {
      const { user, kb } = prepared;
      const actor = proposal ? await proposeOnlyShare(kb.id) : user;
      const repo = kbBareRepoPath(reposDir, kb.id);
      const before = looseObjectBytes(repo);
      const changes = [
        { op: "create", path: "retained.md", content: { markdown: "# Retained history\n" } },
      ];
      await expect(
        applyEdit(kb.id, actor.id, kb.headSha!, "interrupted", changes, {
          barrier: {
            [barrier]: () => {
              throw new Error("injected publication interruption");
            },
          },
        }),
      ).rejects.toThrow("injected publication interruption");
      const intent = await prisma.operationIntent.findFirstOrThrow({
        where: { kbId: kb.id, idempotencyKey: "interrupted" },
      });
      expect(intent.phase).toBe(barrier === "afterPrepared" ? "PREPARED" : "COMMITTING");
      const retained = looseObjectBytes(repo) - before;
      expect(retained).toBeGreaterThan(0n);
      expect(await quotaCommitted(kb.id, "KB_HISTORY_BYTES")).toEqual({
        reserved: retained,
        committed: 0n,
      });

      // Exercise settlement and its retry through the actual recovery or
      // tombstone path, under the coordinator's KB fence and SQL transaction.
      for (let attempt = 0; attempt < 2; attempt++) {
        if (tombstone) {
          await deleteKnowledgeBase(
            {
              prisma,
              coordinator,
              reposDir,
              connectionString: db.urls.runtime,
              canonicalOrigin: "https://kb.example.invalid",
              cursorSigner: createCursorSigner(Buffer.alloc(32, 1)),
              ratePort: createMemoryRatePort(),
              diskMeter: { freeBytes: async () => 1n << 40n },
            },
            user.id,
            {
              kbId: kb.id,
              metadataVersion: kb.metadataVersion,
              idempotencyKey: "tombstone-interrupted",
              confirm: "DELETE",
            },
          );
        } else {
          await coordinator.run({
            opId: crypto.randomUUID(),
            kind: "git-write",
            kbIds: [kb.id],
            run: ({ lease }) =>
              lease.transaction(async (query) => {
                expect(await reconcileKbIntents(query, reposDir, kb.id)).toBe("ok");
              }),
          });
        }
        expect(await quotaCommitted(kb.id, "KB_HISTORY_BYTES")).toEqual({
          reserved: 0n,
          committed: retained,
        });
        expect(looseObjectBytes(repo) - before).toBe(retained);
      }
      expect(
        await prisma.operationIntent.findUnique({ where: { opId: intent.opId } }),
      ).toMatchObject({ phase: "ABORTED" });
      const reservations = await prisma.$queryRaw<{ dimension: string; outcome: string }[]>`
        SELECT a.dimension::text AS dimension, r.outcome::text AS outcome
          FROM "quota_reservation" r JOIN "quota_account" a ON a.id = r."accountId"
         WHERE r."opId" = ${intent.opId}`;
      expect(reservations).toHaveLength(proposal ? 3 : 2);
      for (const reservation of reservations) {
        expect(reservation.outcome).toBe(
          reservation.dimension === "KB_HISTORY_BYTES" ? "COMMITTED" : "RELEASED",
        );
      }
      expect(readHeadSha(repo)).toBe(kb.headSha);
      const prCount = await prisma.$queryRaw<{ count: bigint }[]>`
        SELECT count(*)::bigint AS count FROM "pull_request" WHERE "kbId" = ${kb.id}`;
      expect(prCount[0]?.count).toBe(0n);
      if (proposal) {
        expect(readRefSha(repo, intent.refName!)).toBeNull();
        expect(await quotaCommitted(kb.id, "KB_BRANCH")).toEqual({ committed: 0n, reserved: 0n });
      }
      await expect(
        applyEdit(kb.id, actor.id, kb.headSha!, "interrupted", changes),
      ).rejects.toMatchObject({ code: "INTENT_CONFLICT" });
      if (!tombstone) {
        // A new key may reuse those already-charged blobs. It only pays for
        // newly materialized objects; neither abort nor dedup forgives bytes.
        await applyEdit(kb.id, actor.id, kb.headSha!, "retry-new-key", changes);
        expect(await quotaCommitted(kb.id, "KB_HISTORY_BYTES")).toEqual({
          reserved: 0n,
          committed: looseObjectBytes(repo) - before,
        });
      }
    },
  );

  it("applies a direct write to main and bumps desired epoch", async () => {
    const { user, kb } = prepared;
    const base = kb.headSha!;
    const result = await applyEdit(kb.id, user.id, base, "k1", [
      { op: "create", path: "notes/one.md", content: { markdown: "# One\n" } },
    ]);
    expect(result.kind).toBe("applied");
    const row = await prisma.knowledgeBase.findUnique({ where: { id: kb.id } });
    expect(row?.headSha).toBe(result.commitSha);
    expect(row?.desiredEpoch).toBe(1n);
    expect(readHeadSha(kbBareRepoPath(reposDir, kb.id))).toBe(result.commitSha);
    // Direct main writes charge history bytes but never a branch slot, and the
    // committed charge replaces the transient reservation.
    const history = await quotaCommitted(kb.id, "KB_HISTORY_BYTES");
    expect(Number(history?.committed ?? 0n)).toBeGreaterThan(0);
    expect(history?.reserved).toBe(0n);
    expect(await quotaCommitted(kb.id, "KB_BRANCH")).toBeNull();
  });

  it("commits 32 changes atomically and refuses 33 before any effect", async () => {
    const { user, kb } = prepared;
    const batch = Array.from({ length: 32 }, (_, i) => ({
      op: "create",
      path: `batch/${i}.md`,
      content: { markdown: `# Batch ${i}\n` },
    }));
    const before = readHeadSha(kbBareRepoPath(reposDir, kb.id));
    await expect(
      applyEdit(kb.id, user.id, kb.headSha!, "cap33", [
        ...batch,
        { op: "create", path: "batch/extra.md", content: { markdown: "# Extra\n" } },
      ]),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      details: { reason: "TOO_MANY_CHANGES", field: "/changes", max: 32 },
    });
    expect(readHeadSha(kbBareRepoPath(reposDir, kb.id))).toBe(before);
    const result = await applyEdit(kb.id, user.id, kb.headSha!, "cap32", batch);
    expect(result.changedPaths).toHaveLength(32);
    expect(readHeadSha(kbBareRepoPath(reposDir, kb.id))).toBe(result.commitSha);
    const final = await prisma.knowledgeBase.findUniqueOrThrow({ where: { id: kb.id } });
    expect(final.desiredEpoch).toBe(1n);
    const replacements = batch.map((c, i) => ({
      ...c,
      op: "replace",
      content: { markdown: `# Replaced ${i}\n` },
    }));
    const replaced = await applyEdit(
      kb.id,
      user.id,
      result.commitSha,
      "cap32-replace",
      replacements,
    );
    expect(replaced.changedPaths).toHaveLength(32);
    const removed = await applyEdit(
      kb.id,
      user.id,
      replaced.commitSha,
      "cap32-delete",
      batch.map((c) => ({ op: "delete", path: c.path })),
    );
    expect(removed.changedPaths).toHaveLength(32);
  });

  it.each([
    ["caps.md", "CAPS.md"],
    ["CAPS.md", "caps.md"],
    ["Docs/existing.md", "docs/new.md"],
  ])(
    "names the submitted path when %s collides with %s in the existing tree",
    async (existing, submitted) => {
      const { user, kb } = prepared;
      const first = await applyEdit(kb.id, user.id, kb.headSha!, "case-existing", [
        { op: "create", path: existing, content: { markdown: "# Existing\n" } },
      ]);
      await expect(
        applyEdit(kb.id, user.id, first.commitSha, "case-collision", [
          { op: "create", path: submitted, content: { markdown: "# New\n" } },
        ]),
      ).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
        details: { reason: "PATH_CASE_COLLISION", field: "/changes/0/path" },
      });
      expect(readHeadSha(kbBareRepoPath(reposDir, kb.id))).toBe(first.commitSha);
    },
  );
  it("leaves git, rows, and quota unchanged when the eighth change is invalid", async () => {
    const { user, kb } = prepared;
    const base = kb.headSha!;
    const beforeHead = readHeadSha(kbBareRepoPath(reposDir, kb.id));
    const jobsBefore = await prisma.durableJob.count();
    const quotaBefore = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*)::bigint AS count FROM "quota_account"
       WHERE "subjectId" = ${kb.id} AND dimension IN ('KB_BRANCH'::"QuotaDimension", 'KB_HISTORY_BYTES'::"QuotaDimension")`;
    await expect(
      applyEdit(kb.id, user.id, base, "k-invalid", [
        { op: "create", path: "a.md", content: { markdown: "# A\n" } },
        { op: "create", path: "b.md", content: { markdown: "# B\n" } },
        { op: "create", path: "c.md", content: { markdown: "# C\n" } },
        { op: "create", path: "d.md", content: { markdown: "# D\n" } },
        { op: "create", path: "e.md", content: { markdown: "# E\n" } },
        { op: "create", path: "f.md", content: { markdown: "# F\n" } },
        { op: "create", path: "g.md", content: { markdown: "# G\n" } },
        { op: "create", path: "a.md", content: { markdown: "# dup\n" } },
      ]),
    ).rejects.toThrow();
    expect(readHeadSha(kbBareRepoPath(reposDir, kb.id))).toBe(beforeHead);
    const row = await prisma.knowledgeBase.findUnique({ where: { id: kb.id } });
    expect(row?.headSha).toBe(base);
    expect(await prisma.durableJob.count()).toBe(jobsBefore);
    const prCount = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*)::bigint AS count FROM "pull_request" WHERE "kbId" = ${kb.id}`;
    expect(prCount[0]?.count).toBe(0n);
    const quotaAfter = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*)::bigint AS count FROM "quota_account"
       WHERE "subjectId" = ${kb.id} AND dimension IN ('KB_BRANCH'::"QuotaDimension", 'KB_HISTORY_BYTES'::"QuotaDimension")`;
    expect(quotaAfter[0]?.count).toBe(quotaBefore[0]?.count ?? 0n);
  });

  it("propose-only writes reuse one auto pull request without moving main", async () => {
    const { user, kb } = prepared;
    const mainBefore = kb.headSha!;
    const share = await prisma.kbShare.create({
      data: { kbId: kb.id, userId: user.id, bits: ["read", "propose"] },
    });
    expect(share).toBeTruthy();
    const proposeUser = await owner();
    await prisma.kbShare.create({
      data: { kbId: kb.id, userId: proposeUser.id, bits: ["read", "propose"] },
    });
    const first = await applyEdit(kb.id, proposeUser.id, mainBefore, "p1", [
      { op: "create", path: "ideas/x.md", content: { markdown: "# X\n" } },
    ]);
    expect(first.kind).toBe("proposed");
    const mainAfter = await prisma.knowledgeBase.findUnique({ where: { id: kb.id } });
    expect(mainAfter?.headSha).toBe(mainBefore);
    const prs = await prisma.$queryRaw<{ number: number }[]>`
      SELECT number FROM "pull_request" WHERE "kbId" = ${kb.id}`;
    expect(prs).toHaveLength(1);
    // A new proposal branch consumes exactly one branch slot; appends to the
    // same proposal charge history only.
    const branchAfterFirst = await quotaCommitted(kb.id, "KB_BRANCH");
    expect(branchAfterFirst?.committed).toBe(1n);
    const historyAfterFirst = await quotaCommitted(kb.id, "KB_HISTORY_BYTES");
    const second = await applyEdit(kb.id, proposeUser.id, first.commitSha, "p2", [
      { op: "create", path: "ideas/y.md", content: { markdown: "# Y\n" } },
    ]);
    expect(second.kind).toBe("proposed");
    expect(second.proposal?.number).toBe(first.proposal?.number);
    const prCount = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*)::bigint AS count FROM "pull_request" WHERE "kbId" = ${kb.id}`;
    expect(prCount[0]?.count).toBe(1n);
    expect(await quotaCommitted(kb.id, "KB_BRANCH")).toMatchObject({
      committed: 1n,
      reserved: 0n,
    });
    const historyAfterSecond = await quotaCommitted(kb.id, "KB_HISTORY_BYTES");
    expect(historyAfterSecond!.committed).toBeGreaterThan(historyAfterFirst!.committed);
  });

  it("rejects a new proposal branch when the branch budget is exhausted", async () => {
    const { kb } = prepared;
    const proposeUser = await proposeOnlyShare(kb.id);
    const before = await prisma.knowledgeBase.findUnique({
      where: { id: kb.id },
      select: { nextPrNumber: true },
    });
    await seedExhaustedQuota(kb.id, "KB_BRANCH");
    await expect(
      applyEdit(kb.id, proposeUser.id, kb.headSha!, "branch-cap", [
        { op: "create", path: "capped/x.md", content: { markdown: "# capped\n" } },
      ]),
    ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    const prCount = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*)::bigint AS count FROM "pull_request" WHERE "kbId" = ${kb.id}`;
    expect(prCount[0]?.count).toBe(0n);
    const ownerCount = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*)::bigint AS count FROM "branch_owner" WHERE "kbId" = ${kb.id}`;
    expect(ownerCount[0]?.count).toBe(0n);
    const after = await prisma.knowledgeBase.findUnique({
      where: { id: kb.id },
      select: { nextPrNumber: true },
    });
    expect(after?.nextPrNumber).toBe(before?.nextPrNumber);
    // The failed reservation rolled back completely: no history charge either.
    expect(await quotaCommitted(kb.id, "KB_HISTORY_BYTES")).toBeNull();
  });

  it("rejects edits when the per-KB history budget is exhausted", async () => {
    const { user, kb } = prepared;
    await seedExhaustedQuota(kb.id, "KB_HISTORY_BYTES");
    const beforeHead = readHeadSha(kbBareRepoPath(reposDir, kb.id));
    await expect(
      applyEdit(kb.id, user.id, kb.headSha!, "history-cap", [
        { op: "create", path: "full/x.md", content: { markdown: "# full\n" } },
      ]),
    ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    expect(readHeadSha(kbBareRepoPath(reposDir, kb.id))).toBe(beforeHead);
    const row = await prisma.knowledgeBase.findUnique({ where: { id: kb.id } });
    expect(row?.headSha).toBe(kb.headSha);
  });

  it("rejects edits when the free-disk admission floor is breached", async () => {
    const { user, kb } = prepared;
    const beforeHead = readHeadSha(kbBareRepoPath(reposDir, kb.id));
    await expect(
      applyEdit(
        kb.id,
        user.id,
        kb.headSha!,
        "disk-floor",
        [{ op: "create", path: "floor/x.md", content: { markdown: "# floor\n" } }],
        {
          diskMeter: {
            async freeBytes() {
              return 0n;
            },
          },
        },
      ),
    ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    expect(readHeadSha(kbBareRepoPath(reposDir, kb.id))).toBe(beforeHead);
  });

  it("identical replacements are a durable noop that consumes no quota", async () => {
    const { user, kb } = prepared;
    const created = await applyEdit(kb.id, user.id, kb.headSha!, "noop-seed", [
      { op: "create", path: "same/x.md", content: { markdown: "# same\n" } },
    ]);
    expect(created.kind).toBe("applied");
    const noop = await applyEdit(kb.id, user.id, created.commitSha, "noop-identical", [
      { op: "replace", path: "same/x.md", content: { markdown: "# same\n" } },
    ]);
    expect(noop.kind).toBe("noop");
    expect(noop.commitSha).toBe(created.commitSha);
    expect(await quotaCommitted(kb.id, "KB_BRANCH")).toBeNull();
    const history = await quotaCommitted(kb.id, "KB_HISTORY_BYTES");
    expect(history?.committed).toBeGreaterThan(0n);
    // Only the seed write charged; the noop added nothing on top of it.
    const single = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*)::bigint AS count FROM "quota_reservation" r
       JOIN "quota_account" a ON a.id = r."accountId"
      WHERE a."subjectId" = ${kb.id}
        AND a.dimension = 'KB_HISTORY_BYTES'::"QuotaDimension"
        AND r.outcome = 'COMMITTED'::"QuotaReservationOutcome"`;
    expect(single[0]?.count).toBe(1n);
  });

  it("rejects a whole-tree validation failure without materializing git objects", async () => {
    const { user, kb } = prepared;
    const repo = kbBareRepoPath(reposDir, kb.id);
    const bytesBefore = looseObjectBytes(repo);
    const headBefore = readHeadSha(repo);
    // Each document is individually valid markdown; only whole-tree
    // validation sees the duplicate frontmatter id.
    await expect(
      applyEdit(kb.id, user.id, kb.headSha!, "dup-document-id", [
        { op: "create", path: "docs/a.md", content: { markdown: "---\nid: twin\n---\n# A\n" } },
        { op: "create", path: "docs/b.md", content: { markdown: "---\nid: twin\n---\n# B\n" } },
      ]),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      details: { reason: "DUPLICATE_DOCUMENT_ID", field: "/changes/1/content" },
    });
    // The rejected candidate never reached the canonical object store.
    expect(looseObjectBytes(repo)).toBe(bytesBefore);
    expect(readHeadSha(repo)).toBe(headBefore);
    expect(await quotaCommitted(kb.id, "KB_HISTORY_BYTES")).toBeNull();
    const prCount = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*)::bigint AS count FROM "pull_request" WHERE "kbId" = ${kb.id}`;
    expect(prCount[0]?.count).toBe(0n);
  });

  it("says why a change was refused, with the same pointers as kb mcp", async () => {
    const { user, kb } = prepared;
    const base = kb.headSha!;
    await expect(
      applyEdit(kb.id, user.id, base, "d14-exists", [
        { op: "create", path: "index.md", content: { markdown: "# Again\n" } },
      ]),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "PATH_EXISTS", field: "/changes/0/path" },
    });
    await expect(
      applyEdit(kb.id, user.id, base, "d14-missing", [
        { op: "create", path: "fresh.md", content: { markdown: "# Fresh\n" } },
        { op: "delete", path: "absent.md" },
      ]),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      details: { reason: "PATH_NOT_FOUND", field: "/changes/1/path" },
    });
    await expect(
      applyEdit(kb.id, user.id, base, "d14-yaml", [
        { op: "create", path: "yaml.md", content: { markdown: "---\na: [\n---\n# Y\n" } },
      ]),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      details: { reason: "INVALID_FRONT_MATTER", field: "/changes/0/content/markdown" },
    });
    expect(readHeadSha(kbBareRepoPath(reposDir, kb.id))).toBe(base);
  });

  it("charges history bytes for exactly the git objects a publication retains", async () => {
    const { user, kb } = prepared;
    const repo = kbBareRepoPath(reposDir, kb.id);
    const seed = await applyEdit(kb.id, user.id, kb.headSha!, "exact-seed", [
      { op: "create", path: "notes/deep/a.md", content: { markdown: "# A seed\n" } },
      { op: "create", path: "notes/deep/b.md", content: { markdown: "# B seed\n" } },
    ]);
    expect(seed.kind).toBe("applied");
    const bytesBefore = looseObjectBytes(repo);
    const historyBefore = await quotaCommitted(kb.id, "KB_HISTORY_BYTES");
    const edit = await applyEdit(kb.id, user.id, seed.commitSha, "exact-charge", [
      { op: "replace", path: "notes/deep/a.md", content: { markdown: "# A edited\n" } },
    ]);
    expect(edit.kind).toBe("applied");
    // Rewriting one leaf rewrites its ancestor trees and the commit; the
    // committed charge must equal the measured growth of the object store,
    // not just the changed blob bytes.
    const growth = looseObjectBytes(repo) - bytesBefore;
    expect(growth).toBeGreaterThan(BigInt("# A edited\n".length));
    const historyAfter = await quotaCommitted(kb.id, "KB_HISTORY_BYTES");
    expect(historyAfter!.committed - historyBefore!.committed).toBe(growth);
    expect(historyAfter!.reserved).toBe(0n);
  });
});
