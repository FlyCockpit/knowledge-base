// @ts-nocheck — PG/Git integration harness.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { evaluateDreamMergeGuardAsync } from "@knowledge-base/api/lib/kb/dream";
import { kbBareRepoPath, readHeadSha } from "@knowledge-base/api/lib/kb/git-read";
import {
  GitCommandError,
  type GitMutatingExecutor,
  writeInitialMainCommit,
} from "@knowledge-base/api/lib/kb/git-write";
import { createMemoryRatePort } from "@knowledge-base/api/lib/kb/limits";
import { serializeDreamMarkdown } from "@knowledge-base/api/lib/kb/parse-markdown";
import { prismaAuthorityStore } from "@knowledge-base/api/lib/kb/permissions";
import { setKbRecoveryComplete } from "@knowledge-base/api/lib/kb/recovery";
import { afterAll, describe, expect, it, vi } from "vitest";

import {
  createKbWriteCoordinator,
  runChangesApply,
} from "../../../../apps/server/src/kb-write-coordinator.js";

vi.mock("../../../../apps/server/src/kb-process.js", async (importOriginal) => ({
  ...(await importOriginal()),
  assertProcessFence() {},
}));

import { openKbPostgresClusterFromEnv } from "./index.js";

const ROOT = resolve(import.meta.dirname, "../../../..");
const DREAM_FIXTURE = JSON.parse(
  readFileSync(resolve(ROOT, "packages/api/src/lib/kb/fixtures/dream.json"), "utf8"),
);

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
const reposDir = mkdtempSync(join(tmpdir(), "kb-dream-repos-"));
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
      name: "dream",
      email: `dream-${crypto.randomUUID()}@example.invalid`,
      emailVerified: true,
    },
  });
}

async function activeKb(userId: string) {
  const kb = await prisma.knowledgeBase.create({
    data: {
      ownerId: userId,
      name: "Dream KB",
      slug: `drm-${crypto.randomUUID().slice(0, 8)}`,
      description: "dream integration knowledge base",
      state: "CREATING",
      headSha: null,
    },
  });
  const head = await writeInitialMainCommit(
    { reposDir, kbId: kb.id, executor },
    { message: "init", description: "dream integration knowledge base" },
  );
  return prisma.knowledgeBase.update({
    where: { id: kb.id },
    data: { state: "ACTIVE", headSha: head },
  });
}

async function proposeOnlyUser(kbId: string) {
  const user = await owner();
  await prisma.kbShare.create({
    data: { kbId, userId: user.id, bits: ["read", "propose"] },
  });
  return user;
}

function applyEdit(
  kbId: string,
  userId: string,
  baseRevision: string,
  key: string,
  changes: unknown[],
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
  });
}

function applyDream(
  kbId: string,
  userId: string,
  baseRevision: string,
  key: string,
  dream: unknown,
  sourceSessionIds: string[],
) {
  setKbRecoveryComplete(true);
  return runChangesApply(coordinator, {
    store: prismaAuthorityStore(prisma),
    principal: { kind: "browser", userId },
    reposDir,
    kbId,
    idempotencyKey: key,
    request: {
      mode: "dream",
      baseRevision,
      title: "dream batch",
      changes: [],
      sourceSessionIds,
      dream,
    },
    ratePort: createMemoryRatePort(),
  });
}

async function counts(kbId: string) {
  const [prs, jobs, head] = await Promise.all([
    prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*)::bigint AS count FROM "pull_request" WHERE "kbId" = ${kbId}`,
    prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*)::bigint AS count FROM "durable_job"`,
    prisma.knowledgeBase.findUnique({ where: { id: kbId }, select: { headSha: true } }),
  ]);
  return {
    prs: Number(prs[0]?.count ?? 0n),
    jobs: Number(jobs[0]?.count ?? 0n),
    headSha: head?.headSha ?? null,
  };
}

describe("dream integration", () => {
  it("applies fixture dream as a proposal with persisted metadata", async () => {
    const ownerUser = await owner();
    const kb = await activeKb(ownerUser.id);
    const actor = await proposeOnlyUser(kb.id);
    const session = crypto.randomUUID();
    const result = await applyDream(kb.id, actor.id, kb.headSha!, "dream-ok", DREAM_FIXTURE, [
      session,
    ]);
    expect(result.kind).toBe("proposed");
    const prRows = await prisma.$queryRaw<
      { dreamMetadata: { upserts: unknown[] } | null }[]
    >`SELECT "dreamMetadata" FROM "pull_request" WHERE "kbId" = ${kb.id} LIMIT 1`;
    const pr = prRows[0];
    expect(pr?.dreamMetadata).toBeTruthy();
    expect(pr?.dreamMetadata?.upserts?.length).toBe(2);
    const main = await prisma.knowledgeBase.findUnique({ where: { id: kb.id } });
    expect(main?.headSha).toBe(kb.headSha);
  });

  it("noop dream retains source metadata without creating a commit", async () => {
    const user = await owner();
    const kb = await activeKb(user.id);
    const before = await counts(kb.id);
    const session = crypto.randomUUID();
    const result = await applyDream(
      kb.id,
      user.id,
      kb.headSha!,
      "dream-noop",
      {
        model: DREAM_FIXTURE.model,
        redactionApplied: true,
        upserts: [],
      },
      [session],
    );
    expect(result.kind).toBe("noop");
    expect(result.sourceSessionIds).toEqual([session]);
    const after = await counts(kb.id);
    expect(after.headSha).toBe(before.headSha);
    expect(after.prs).toBe(before.prs);
    expect(after.jobs).toBe(before.jobs);
  });

  it("rejects human provenance overwrite with zero publication effects", async () => {
    const user = await owner();
    const kb = await activeKb(user.id);
    const human = serializeDreamMarkdown({
      id: "locked",
      type: "concept",
      title: "Human",
      citations: [],
      body: "human",
    }).replace("provenance: dream", "provenance: human");
    await applyEdit(kb.id, user.id, kb.headSha!, "seed-human", [
      { op: "create", path: "concepts/locked.md", content: { markdown: human } },
    ]);
    const headAfterSeed = (await prisma.knowledgeBase.findUnique({ where: { id: kb.id } }))!
      .headSha!;
    const before = await counts(kb.id);
    await expect(
      applyDream(
        kb.id,
        user.id,
        headAfterSeed,
        "dream-human-block",
        {
          model: DREAM_FIXTURE.model,
          redactionApplied: true,
          upserts: [
            {
              id: "locked",
              type: "concept",
              title: "Dream retry",
              body: "dream",
              citations: [],
              provenance: "dream",
            },
          ],
        },
        [crypto.randomUUID()],
      ),
    ).rejects.toThrow(/human or unspecified provenance/u);
    const after = await counts(kb.id);
    expect(after.headSha).toBe(headAfterSeed);
    expect(after.prs).toBe(before.prs);
  });

  it("rejects duplicate upsert ids and duplicate source sessions without effects", async () => {
    const user = await owner();
    const kb = await activeKb(user.id);
    const session = crypto.randomUUID();
    const before = await counts(kb.id);
    await expect(
      applyDream(
        kb.id,
        user.id,
        kb.headSha!,
        "dup-id",
        {
          model: DREAM_FIXTURE.model,
          redactionApplied: true,
          upserts: [
            {
              id: "dup",
              type: "concept",
              title: "a",
              body: "a",
              citations: [],
              provenance: "dream",
            },
            {
              id: "dup",
              type: "concept",
              title: "b",
              body: "b",
              citations: [],
              provenance: "dream",
            },
          ],
        },
        [session],
      ),
    ).rejects.toThrow(/duplicate dream upsert ids/u);
    await expect(
      runChangesApply(coordinator, {
        store: prismaAuthorityStore(prisma),
        principal: { kind: "browser", userId: user.id },
        reposDir,
        kbId: kb.id,
        idempotencyKey: "dup-sessions",
        request: {
          mode: "dream",
          baseRevision: kb.headSha!,
          title: "dream",
          changes: [],
          sourceSessionIds: [session, session],
          dream: {
            model: DREAM_FIXTURE.model,
            redactionApplied: true,
            upserts: DREAM_FIXTURE.upserts.slice(0, 1),
          },
        },
        ratePort: createMemoryRatePort(),
      }),
    ).rejects.toThrow(/sourceSessionIds must be unique/u);
    const after = await counts(kb.id);
    expect(after).toEqual(before);
  });

  it("rejects sensitive eighth upsert before any ref movement", async () => {
    const user = await owner();
    const kb = await activeKb(user.id);
    const beforeHead = kb.headSha;
    const upserts = Array.from({ length: 7 }, (_, index) => ({
      id: `note-${index}`,
      type: "concept",
      title: `n${index}`,
      body: `body ${index}`,
      citations: [],
      provenance: "dream" as const,
    }));
    upserts.push({
      id: "leak",
      type: "concept",
      title: "leak",
      body: "sk-proj-abcdefghijklmnopqrstuvwxyz",
      citations: [],
      provenance: "dream" as const,
    });
    const before = await counts(kb.id);
    await expect(
      applyDream(
        kb.id,
        user.id,
        kb.headSha!,
        "dream-sensitive",
        {
          model: DREAM_FIXTURE.model,
          redactionApplied: true,
          upserts,
        },
        [crypto.randomUUID()],
      ),
    ).rejects.toThrow(/credential pattern/u);
    const after = await counts(kb.id);
    expect(after.headSha).toBe(beforeHead);
    expect(after.prs).toBe(before.prs);
    const audit = await prisma.auditEvent.findFirst({
      where: { kbId: kb.id, action: "changes_apply", outcome: "FAILURE" },
      orderBy: { createdAt: "desc" },
    });
    expect(audit?.metadata?.reasonCode).toBe("dream_sensitive_rejected");
    expect(JSON.stringify(audit)).not.toMatch(/sk-proj/u);
  });

  it("merge guard rejects main human edit after proposal while allowing dream updates", async () => {
    const user = await owner();
    const kb = await activeKb(user.id);
    const actor = await proposeOnlyUser(kb.id);
    await applyDream(kb.id, actor.id, kb.headSha!, "dream-pr", DREAM_FIXTURE, [
      crypto.randomUUID(),
    ]);
    const prRows = await prisma.$queryRaw<
      { dreamMetadata: DreamMetadata }[]
    >`SELECT "dreamMetadata" FROM "pull_request" WHERE "kbId" = ${kb.id} LIMIT 1`;
    const pr = prRows[0]!;
    const repoPath = kbBareRepoPath(reposDir, kb.id);
    const mainBefore = readHeadSha(repoPath)!;
    const human = serializeDreamMarkdown({
      id: DREAM_FIXTURE.upserts[0]!.id,
      type: "concept",
      title: "Human override",
      citations: [],
      body: "human edited",
    }).replace("provenance: dream", "provenance: human");
    await applyEdit(kb.id, user.id, mainBefore, "human-main", [
      { op: "create", path: "concepts/alpha-note.md", content: { markdown: human } },
    ]);
    const mainHead = readHeadSha(repoPath)!;
    const blocked = await evaluateDreamMergeGuardAsync({
      repoPath,
      mainHead,
      dream: pr.dreamMetadata,
    });
    expect(blocked.ok).toBe(false);
  });

  it("keeps PR dream metadata when an edit-mode append follows the dream", async () => {
    const user = await owner();
    const kb = await activeKb(user.id);
    const actor = await proposeOnlyUser(kb.id);
    const dream = await applyDream(kb.id, actor.id, kb.headSha!, "dream-then-edit", DREAM_FIXTURE, [
      crypto.randomUUID(),
    ]);
    expect(dream.kind).toBe("proposed");
    const edit = await applyEdit(kb.id, actor.id, dream.commitSha, "dream-then-edit-append", [
      { op: "create", path: "notes/extra.md", content: { markdown: "# Extra\n" } },
    ]);
    expect(edit.kind).toBe("proposed");
    const prRows = await prisma.$queryRaw<
      {
        dreamMetadata: {
          upserts: { id: string }[];
          guardTouchedPaths: Record<string, { path: string; existedAtBase: boolean }[]>;
        } | null;
      }[]
    >`SELECT "dreamMetadata" FROM "pull_request" WHERE "kbId" = ${kb.id} LIMIT 1`;
    const metadata = prRows[0]?.dreamMetadata;
    expect(metadata?.upserts?.map((upsert) => upsert.id).sort()).toEqual([
      "alpha-note",
      "beta-note",
    ]);
    expect(Object.keys(metadata?.guardTouchedPaths ?? {}).sort()).toEqual([
      "alpha-note",
      "beta-note",
    ]);
    expect(metadata?.guardTouchedPaths?.["alpha-note"]).toEqual([
      { path: "concepts/alpha-note.md", existedAtBase: false },
    ]);
  });
});
