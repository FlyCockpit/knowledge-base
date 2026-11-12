// @ts-nocheck — PG integration harness.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kbBareRepoPath, readHeadSha, runGit } from "@knowledge-base/api/lib/kb/git-read";
import {
  createEmptyTreeCommit,
  GitCommandError,
  type GitMutatingExecutor,
  writeInitialMainCommit,
} from "@knowledge-base/api/lib/kb/git-write";
import {
  AUTHORITY_LOCK_CLASSID,
  AUTHORITY_LOCK_OBJID,
  checkoutPinnedSession,
  requireOperationLease,
} from "@knowledge-base/api/lib/kb/lock";
import {
  type JournalTestPublicationInput,
  markIntentCommitting,
  reconcileKbIntents,
} from "@knowledge-base/api/lib/kb/operation-intent";
import { prismaAuthorityStore } from "@knowledge-base/api/lib/kb/permissions";
import {
  runStartupJournalRecovery,
  setKbRecoveryComplete,
} from "@knowledge-base/api/lib/kb/recovery";
import { afterAll, describe, expect, it, vi } from "vitest";
import { assertProcessFence } from "./kb-process.js";
import { createKbWriteCoordinator, runJournalTestPublish } from "./kb-write-coordinator.js";

// Native-supervisor crash/drain proof lives in the fence suite. Here only its
// transport is substituted; Git children, coordinator, capabilities, SQL and
// both advisory-lock layers run for real.
vi.mock("./kb-process.js", async (importOriginal) => ({
  ...(await importOriginal()),
  assertProcessFence() {},
}));

const syncFault = vi.hoisted(() => ({ directory: "" }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal();
  return {
    ...fs,
    fsyncSync(fd) {
      if (
        syncFault.directory &&
        fs.fstatSync(fd).isDirectory() &&
        fs.readlinkSync(`/proc/self/fd/${fd}`) === syncFault.directory
      ) {
        throw Object.assign(new Error("injected directory fsync failure"), { code: "EIO" });
      }
      return fs.fsyncSync(fd);
    },
  };
});

import { openKbPostgresClusterFromEnv } from "../../../packages/test-utils/src/kb/index.js";

const DESCRIPTION = "a knowledge base used by journal tests";

// Real Git through the same exit-status-only contract the supervised
// coordinator executor uses; no spawn is mocked.
const journalExecutor: GitMutatingExecutor = {
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
const reposDir = mkdtempSync(join(tmpdir(), "kb-journal-repos-"));
const assetsDir = mkdtempSync(join(tmpdir(), "kb-journal-assets-"));
const children = new Map();
const pausedRefUpdates = new Map();
const coordinator = createKbWriteCoordinator({
  connectionString: db.urls.runtime,
  closeAdmission: async () => {},
  async spawn(req) {
    const paused = req.argv[3] === "update-ref" && pausedRefUpdates.get(req.argv[2]);
    if (paused) pausedRefUpdates.delete(req.argv[2]);
    const child = spawn(
      req.argv[0],
      paused ? [...req.argv.slice(1, 4), "--stdin"] : req.argv.slice(1),
      {
        cwd: req.cwd,
        env: req.env,
        stdio: paused ? ["pipe", "pipe", "ignore"] : "ignore",
        timeout: 10_000,
        killSignal: "SIGKILL",
      },
    );
    const exit = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (status) =>
        resolve({ opId: req.opId, pid: child.pid, status: status ?? -1 }),
      );
    });
    children.set(child.pid, { child, exit });
    if (paused) {
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk.toString();
        if (output.includes("prepare: ok\n")) paused.resolve(child);
      });
      child.once("error", paused.reject);
      child.once("exit", () => paused.reject(new Error("Git exited before its prepare barrier")));
      // Git itself creates and holds main.lock. No commit command is sent;
      // SIGKILL at this documented transaction barrier leaves it on disk.
      child.stdin.write(`start\nupdate ${req.argv[4]} ${req.argv[5]} ${req.argv[6]}\nprepare\n`);
    }
    return { pid: child.pid };
  },
  wait: (_opId, pid) => children.get(pid).exit,
  drain: (_opId, pid) => {
    const slot = children.get(pid);
    slot.child.kill("SIGKILL");
    return slot.exit;
  },
});

afterAll(async () => {
  await coordinator.shutdown();
  await prisma.$disconnect();
  await db.close();
  await cluster.close();
  rmSync(reposDir, { recursive: true, force: true });
});

db.applyPrismaSchema();

async function owner() {
  return prisma.user.create({
    data: {
      name: "journal",
      email: `journal-${crypto.randomUUID()}@example.invalid`,
      emailVerified: true,
    },
  });
}

async function activeKb(userId: string, slug: string) {
  const kb = await prisma.knowledgeBase.create({
    data: {
      ownerId: userId,
      name: "Journal KB",
      slug,
      description: DESCRIPTION,
      state: "CREATING",
      headSha: null,
    },
  });
  const head = await writeInitialMainCommit(
    { reposDir, kbId: kb.id, executor: journalExecutor },
    { message: "init", description: DESCRIPTION },
  );
  return prisma.knowledgeBase.update({
    where: { id: kb.id },
    data: { state: "ACTIVE", headSha: head },
  });
}

async function publish(
  kbId: string,
  userId: string,
  key: string,
  marker: string,
  barrier?: JournalTestPublicationInput["barrier"],
) {
  return runJournalTestPublish(coordinator, {
    store: prismaAuthorityStore(prisma),
    principal: { kind: "browser", userId },
    reposDir,
    kbId,
    idempotencyKey: key,
    request: { marker },
    barrier,
  });
}

function crash(where: "afterPrepared" | "afterCommitting" | "afterRefUpdate" | "afterDbFinalize") {
  return {
    [where]: () => {
      throw new Error(`simulated crash ${where}`);
    },
  };
}

describe("journal integration", () => {
  it("replays the same actor/key/body with one ref effect and one durable job", async () => {
    setKbRecoveryComplete(true);
    const user = await owner();
    const kb = await activeKb(user.id, "journal-a");
    const first = await publish(kb.id, user.id, "key-1", "marker-1");
    const second = await publish(kb.id, user.id, "key-1", "marker-1");
    expect(second).toEqual(first);
    const jobs = await prisma.durableJob.findMany({
      where: { dedupKey: `journal:${first.operationId}` },
    });
    expect(jobs).toHaveLength(1);
    const audits = await prisma.auditEvent.findMany({
      where: {
        opId: first.operationId,
        action: "journal_test_publish",
        outcome: "SUCCESS",
      },
    });
    expect(audits).toHaveLength(1);
  });

  it("rejects the same key with a different body", async () => {
    setKbRecoveryComplete(true);
    const user = await owner();
    const kb = await activeKb(user.id, "journal-b");
    await publish(kb.id, user.id, "key-2", "same-key");
    await expect(publish(kb.id, user.id, "key-2", "other-body")).rejects.toMatchObject({
      code: "IDEMPOTENCY_MISMATCH",
    });
  });

  it("keeps distinct actors on the same idempotency key with distinct durable jobs", async () => {
    setKbRecoveryComplete(true);
    const a = await owner();
    const b = await owner();
    const kb = await activeKb(a.id, "journal-c");
    await prisma.kbShare.create({
      data: { kbId: kb.id, userId: b.id, bits: ["write"] },
    });
    const first = await publish(kb.id, a.id, "shared-key", "marker");
    const second = await publish(kb.id, b.id, "shared-key", "marker");
    expect(second.operationId).not.toBe(first.operationId);
    const jobs = await prisma.durableJob.findMany({
      where: {
        dedupKey: { in: [`journal:${first.operationId}`, `journal:${second.operationId}`] },
      },
    });
    expect(jobs).toHaveLength(2);
  });

  it("marks repair required when main diverges to a third sha during an in-flight intent", async () => {
    setKbRecoveryComplete(true);
    const user = await owner();
    const kb = await activeKb(user.id, "journal-d");
    const repo = kbBareRepoPath(reposDir, kb.id);
    const head = readHeadSha(repo)!;
    const planned = await createEmptyTreeCommit(
      { reposDir, kbId: kb.id },
      { parentSha: head, message: "planned-tip" },
    );
    const foreign = await createEmptyTreeCommit(
      { reposDir, kbId: kb.id },
      { parentSha: head, message: "foreign-tip" },
    );
    runGit(repo, ["update-ref", "refs/heads/main", foreign]);
    await db.query(
      "applier",
      `INSERT INTO "operation_intent"
        ("opId", "createdAt", "updatedAt", "kbId", "actorKey", "actorUserIdSnapshot", "actorUserId",
         operation, "idempotencyKey", "requestHash", phase, "refName", "oldRef", "newRef",
         "preparedDelta", "publishNonce")
       VALUES ($1, now(), now(), $2, $3, $4, $4, $5, $6, $7, 'PREPARED'::"OperationIntentPhase",
               'refs/heads/main', $8, $9, $10::jsonb, $11)`,
      [
        crypto.randomUUID(),
        kb.id,
        `user:${user.id}`,
        user.id,
        "JOURNAL_TEST_PUBLISH",
        "repair-key",
        "hash",
        head,
        planned,
        JSON.stringify({
          kind: "journal_test_publish",
          headSha: planned,
          marker: "repair-marker",
          jobDedupKey: `journal:repair-key`,
        }),
        crypto.randomUUID(),
      ],
    );
    const lease = await checkoutPinnedSession({
      connectionString: db.urls.runtime,
      opId: crypto.randomUUID(),
    });
    try {
      await lease.transaction(async (query) => {
        const result = await reconcileKbIntents(query, reposDir, kb.id);
        expect(result).toBe("repair_required");
      }, false);
    } finally {
      await lease.close();
    }
    const row = await prisma.knowledgeBase.findUnique({ where: { id: kb.id } });
    expect(row?.state).toBe("REPAIR_REQUIRED");
    expect(readHeadSha(repo)).toBe(foreign);
  });

  it("marks repair required when an active kb loses its canonical ref", async () => {
    setKbRecoveryComplete(true);
    const user = await owner();
    const kb = await activeKb(user.id, "journal-d2");
    const repo = kbBareRepoPath(reposDir, kb.id);
    runGit(repo, ["update-ref", "-d", "refs/heads/main"]);
    const lease = await checkoutPinnedSession({
      connectionString: db.urls.runtime,
      opId: crypto.randomUUID(),
    });
    try {
      await lease.transaction(async (query) => {
        const result = await reconcileKbIntents(query, reposDir, kb.id);
        expect(result).toBe("repair_required");
      }, false);
    } finally {
      await lease.close();
    }
    const row = await prisma.knowledgeBase.findUnique({ where: { id: kb.id } });
    expect(row?.state).toBe("REPAIR_REQUIRED");
  });

  it("finalizes metadata when the ref already advanced but the db did not", async () => {
    setKbRecoveryComplete(false);
    const user = await owner();
    const kb = await activeKb(user.id, "journal-e");
    const repo = kbBareRepoPath(reposDir, kb.id);
    const head = readHeadSha(repo)!;
    const newSha = await createEmptyTreeCommit(
      { reposDir, kbId: kb.id },
      { parentSha: head, message: "ahead-of-db" },
    );
    runGit(repo, ["update-ref", "refs/heads/main", newSha]);
    const lease = await checkoutPinnedSession({
      connectionString: db.urls.runtime,
      opId: crypto.randomUUID(),
    });
    try {
      await lease.transaction(async (query) => {
        await query(
          `INSERT INTO "operation_intent"
            ("opId", "createdAt", "updatedAt", "kbId", "actorKey", "actorUserIdSnapshot", "actorUserId", operation,
             "idempotencyKey", "requestHash", phase, "refName", "oldRef", "newRef",
             "preparedDelta", "publishNonce")
           VALUES ($1, now(), now(), $2, $3, $4, $4, $5, $6, $7, 'COMMITTING'::"OperationIntentPhase",
                   'refs/heads/main', $8, $9, $10::jsonb, $11)`,
          [
            crypto.randomUUID(),
            kb.id,
            `user:${user.id}`,
            user.id,
            "JOURNAL_TEST_PUBLISH",
            "recover-key",
            "hash",
            head,
            newSha,
            JSON.stringify({
              kind: "journal_test_publish",
              headSha: newSha,
              marker: "recover-marker",
              jobDedupKey: `journal:recover-key`,
            }),
            crypto.randomUUID(),
          ],
        );
      }, true);
    } finally {
      await lease.close();
    }
    await runStartupJournalRecovery(
      prisma,
      reposDir,
      assetsDir,
      db.urls.runtime,
      assertProcessFence,
    );
    const after = await prisma.knowledgeBase.findUnique({ where: { id: kb.id } });
    expect(after?.headSha).toBe(newSha);
    const intent = await prisma.operationIntent.findFirst({
      where: { kbId: kb.id, idempotencyKey: "recover-key" },
    });
    expect(intent?.phase).toBe("FINALIZED");
  });

  it("an interrupted PREPARED intent aborts on retry and needs a new key", async () => {
    setKbRecoveryComplete(true);
    const user = await owner();
    const kb = await activeKb(user.id, "journal-f");
    const repo = kbBareRepoPath(reposDir, kb.id);
    const head = readHeadSha(repo)!;
    await expect(
      publish(kb.id, user.id, "crash-prepared", "m", crash("afterPrepared")),
    ).rejects.toThrow(/simulated crash/);
    const refEffect = readHeadSha(repo);
    expect(refEffect).toBe(head);
    // Same key/body retry is a stable conflict, never a continuation.
    await expect(publish(kb.id, user.id, "crash-prepared", "m")).rejects.toMatchObject({
      code: "INTENT_CONFLICT",
    });
    expect(readHeadSha(repo)).toBe(head);
    const intent = await prisma.operationIntent.findFirst({
      where: { kbId: kb.id, idempotencyKey: "crash-prepared" },
    });
    expect(intent?.phase).toBe("ABORTED");
    // A new key publishes cleanly.
    const receipt = await publish(kb.id, user.id, "crash-prepared-2", "m2");
    expect(readHeadSha(repo)).toBe(receipt.headSha);
  });

  it("an interrupted COMMITTING intent never publishes on retry, even after actor revocation", async () => {
    setKbRecoveryComplete(true);
    const a = await owner();
    const b = await owner();
    const kb = await activeKb(a.id, "journal-g");
    await prisma.kbShare.create({
      data: { kbId: kb.id, userId: b.id, bits: ["write"] },
    });
    const repo = kbBareRepoPath(reposDir, kb.id);
    const head = readHeadSha(repo)!;
    await expect(
      publish(kb.id, b.id, "crash-committing", "m", crash("afterCommitting")),
    ).rejects.toThrow(/simulated crash/);
    // Revoke the actor between the interruption and the retry.
    await prisma.kbShare.delete({ where: { kbId_userId: { kbId: kb.id, userId: b.id } } });
    await expect(publish(kb.id, b.id, "crash-committing", "m")).rejects.toMatchObject({
      code: "INTENT_CONFLICT",
    });
    expect(readHeadSha(repo)).toBe(head);
    const intent = await prisma.operationIntent.findFirst({
      where: { kbId: kb.id, idempotencyKey: "crash-committing" },
    });
    expect(intent?.phase).toBe("ABORTED");
    const jobs = await prisma.durableJob.findMany({
      where: { dedupKey: `journal:${intent.opId}` },
    });
    expect(jobs).toHaveLength(0);
  });

  it.each(["startup", "retry", "fresh"])(
    "recovers a SIGKILLed Git writer's ref lock via %s without changing its aborted receipt",
    async (recovery) => {
      setKbRecoveryComplete(true);
      const user = await owner();
      const kb = await activeKb(user.id, `journal-killed-${recovery}`);
      const repo = kbBareRepoPath(reposDir, kb.id);
      const lock = join(repo, "refs/heads/main.lock");
      const prepared = Promise.withResolvers<ChildProcess>();
      pausedRefUpdates.set(repo, prepared);
      const failed = publish(kb.id, user.id, "killed-key", "killed-marker").catch((error) => error);
      let child: ChildProcess | undefined;
      try {
        child = await prepared.promise;
        expect(existsSync(lock)).toBe(true);
        expect(existsSync(join(repo, "HEAD.lock"))).toBe(true);
        expect(readHeadSha(repo)).toBe(kb.headSha);
        expect(child.exitCode).toBeNull();
        const pending = await prisma.operationIntent.findFirst({ where: { kbId: kb.id } });
        expect(pending.phase).toBe("COMMITTING");
        child.kill("SIGKILL");
        expect(await failed).toMatchObject({
          message: expect.stringContaining("ref cas rejected"),
        });
        expect(child.signalCode).toBe("SIGKILL");
        expect(existsSync(lock)).toBe(true);
        expect(readHeadSha(repo)).toBe(kb.headSha);

        let fresh: Awaited<ReturnType<typeof publish>> | undefined;
        if (recovery === "startup") {
          await expect(
            runStartupJournalRecovery(prisma, reposDir, assetsDir, db.urls.runtime, () => {
              throw new Error("volume fence unavailable");
            }),
          ).rejects.toThrow("volume fence unavailable");
          expect(existsSync(lock)).toBe(true);
          await runStartupJournalRecovery(
            prisma,
            reposDir,
            assetsDir,
            db.urls.runtime,
            assertProcessFence,
          );
        } else if (recovery === "retry") {
          await expect(
            publish(kb.id, user.id, "killed-key", "killed-marker"),
          ).rejects.toMatchObject({
            code: "INTENT_CONFLICT",
          });
        } else {
          fresh = await publish(kb.id, user.id, "fresh-key", "fresh-marker");
        }
        expect(existsSync(lock)).toBe(false);
        expect(existsSync(join(repo, "HEAD.lock"))).toBe(false);
        const aborted = await prisma.operationIntent.findUnique({ where: { opId: pending.opId } });
        expect(aborted).toMatchObject({
          phase: "ABORTED",
          resultStatus: "ABORTED",
          abortReason: "unpublished intent",
        });
        for (let retry = 0; retry < 2; retry++) {
          await expect(
            publish(kb.id, user.id, "killed-key", "killed-marker"),
          ).rejects.toMatchObject({
            code: "INTENT_CONFLICT",
            message: "unpublished intent",
          });
        }
        fresh ??= await publish(kb.id, user.id, "fresh-key", "fresh-marker");
        expect(await publish(kb.id, user.id, "fresh-key", "fresh-marker")).toEqual(fresh);
        expect(readHeadSha(repo)).toBe(fresh.headSha);
        expect(await prisma.knowledgeBase.findUnique({ where: { id: kb.id } })).toMatchObject({
          state: "ACTIVE",
          headSha: fresh.headSha,
        });
        expect(await prisma.operationIntent.findUnique({ where: { opId: pending.opId } })).toEqual(
          aborted,
        );
        expect(
          await prisma.durableJob.count({ where: { dedupKey: `journal:${pending.opId}` } }),
        ).toBe(0);
        expect(await prisma.auditEvent.count({ where: { opId: pending.opId } })).toBe(0);
        expect(
          await prisma.durableJob.count({ where: { dedupKey: `journal:${fresh.operationId}` } }),
        ).toBe(1);
        expect(await prisma.auditEvent.count({ where: { opId: fresh.operationId } })).toBe(1);
      } finally {
        pausedRefUpdates.delete(repo);
        child?.kill("SIGKILL");
        await failed;
      }
    },
  );

  it("a crash after the ref update finalizes exactly once on retry", async () => {
    setKbRecoveryComplete(true);
    const user = await owner();
    const kb = await activeKb(user.id, "journal-h");
    const repo = kbBareRepoPath(reposDir, kb.id);
    await expect(
      publish(kb.id, user.id, "crash-ref", "m", crash("afterRefUpdate")),
    ).rejects.toThrow(/simulated crash/);
    const advanced = readHeadSha(repo)!;
    const receipt = await publish(kb.id, user.id, "crash-ref", "m");
    expect(receipt.headSha).toBe(advanced);
    const jobs = await prisma.durableJob.findMany({
      where: { dedupKey: `journal:${receipt.operationId}` },
    });
    expect(jobs).toHaveLength(1);
    const audits = await prisma.auditEvent.findMany({
      where: { opId: receipt.operationId, action: "journal_test_publish", outcome: "SUCCESS" },
    });
    expect(audits).toHaveLength(1);
    const intent = await prisma.operationIntent.findFirst({
      where: { kbId: kb.id, idempotencyKey: "crash-ref" },
    });
    expect(intent?.phase).toBe("FINALIZED");
  });

  it("a crash after db finalize replays the identical receipt", async () => {
    setKbRecoveryComplete(true);
    const user = await owner();
    const kb = await activeKb(user.id, "journal-i");
    await expect(
      publish(kb.id, user.id, "crash-finalize", "m", crash("afterDbFinalize")),
    ).rejects.toThrow(/simulated crash/);
    const first = await publish(kb.id, user.id, "crash-finalize", "m");
    const second = await publish(kb.id, user.id, "crash-finalize", "m");
    expect(second).toEqual(first);
  });

  it("a fresh operation finalizes a published but unfinalized earlier intent instead of overtaking it", async () => {
    setKbRecoveryComplete(true);
    const a = await owner();
    const b = await owner();
    const kb = await activeKb(a.id, "journal-j");
    await prisma.kbShare.create({
      data: { kbId: kb.id, userId: b.id, bits: ["write"] },
    });
    const repo = kbBareRepoPath(reposDir, kb.id);
    await expect(
      publish(kb.id, a.id, "overtake-a", "marker-a", crash("afterRefUpdate")),
    ).rejects.toThrow(/simulated crash/);
    const publishedA = readHeadSha(repo)!;
    // A's ref effect landed but its finalize did not. B publishes with its own
    // key under the same fence: A must finalize atomically first, and B must
    // build on A's ref — recovery may never see B's SHA as a third SHA for A.
    const receiptB = await publish(kb.id, b.id, "overtake-b", "marker-b");
    expect(receiptB.headSha).not.toBe(publishedA);
    const intentA = await prisma.operationIntent.findFirst({
      where: { kbId: kb.id, idempotencyKey: "overtake-a" },
    });
    expect(intentA?.phase).toBe("FINALIZED");
    const jobsA = await prisma.durableJob.findMany({
      where: { dedupKey: `journal:${intentA?.opId}` },
    });
    expect(jobsA).toHaveLength(1);
    const auditsA = await prisma.auditEvent.findMany({
      where: { opId: intentA?.opId, action: "journal_test_publish", outcome: "SUCCESS" },
    });
    expect(auditsA).toHaveLength(1);
    // A's retry with the same key replays A's own preserved receipt.
    const replayA = await publish(kb.id, a.id, "overtake-a", "marker-a");
    expect(replayA).toEqual({
      operationId: intentA?.opId,
      headSha: publishedA,
      marker: "marker-a",
    });
    const row = await prisma.knowledgeBase.findUnique({ where: { id: kb.id } });
    expect(row?.state).toBe("ACTIVE");
    expect(row?.headSha).toBe(receiptB.headSha);
  });

  it("blocks fresh publication on a quarantined kb and never adopts a foreign head", async () => {
    setKbRecoveryComplete(true);
    const user = await owner();
    const kb = await activeKb(user.id, "journal-k");
    const repo = kbBareRepoPath(reposDir, kb.id);
    const head = readHeadSha(repo)!;
    const foreign = await createEmptyTreeCommit(
      { reposDir, kbId: kb.id },
      { parentSha: head, message: "foreign-move" },
    );
    runGit(repo, ["update-ref", "refs/heads/main", foreign]);
    // An externally moved ref with no journal explanation stops the next
    // publication before any object or ref mutation and quarantines the KB.
    await expect(publish(kb.id, user.id, "blocked-key", "m")).rejects.toMatchObject({
      code: "REPAIR_REQUIRED",
    });
    expect(readHeadSha(repo)).toBe(foreign);
    const row = await prisma.knowledgeBase.findUnique({ where: { id: kb.id } });
    expect(row?.state).toBe("REPAIR_REQUIRED");
    expect(row?.headSha).toBe(head);
    const intents = await prisma.operationIntent.findMany({
      where: { kbId: kb.id, idempotencyKey: "blocked-key" },
    });
    expect(intents).toHaveLength(0);
    // A quarantined KB stays blocked for later keys too — explicit repair is
    // the only path back to publication.
    await expect(publish(kb.id, user.id, "blocked-key-2", "m2")).rejects.toMatchObject({
      code: "REPAIR_REQUIRED",
    });
    expect(readHeadSha(repo)).toBe(foreign);
  });
  it("rejects COMMITTING outside the authority reservation even with a held KB lock", async () => {
    const lease = await checkoutPinnedSession({
      connectionString: db.urls.runtime,
      opId: crypto.randomUUID(),
    });
    try {
      await lease.acquire([{ kind: "kb", kbId: "unreserved" }]);
      await expect(
        markIntentCommitting(
          { query: lease.query, signal: lease.scope.signal },
          prismaAuthorityStore(prisma),
          { kind: "browser", userId: "unused" },
          "unreserved",
          crypto.randomUUID(),
        ),
      ).rejects.toMatchObject({ code: "NOT_HELD" });
    } finally {
      await lease.close();
    }
  });

  it("rejects publication when a revocation wins the authority lock", async () => {
    const a = await owner();
    const b = await owner();
    const kb = await activeKb(a.id, "revoke-first");
    await prisma.kbShare.create({ data: { kbId: kb.id, userId: b.id, bits: ["write"] } });
    const revoker = await checkoutPinnedSession({
      connectionString: db.urls.runtime,
      opId: crypto.randomUUID(),
    });
    let pending: ReturnType<typeof publish> | undefined;
    try {
      await revoker.acquire([{ kind: "authority" }]);
      pending = publish(kb.id, b.id, "revoked-first", "m");
      void pending.catch(() => {});
      // Wait for the writer's real blocked PG lock, not a scheduling delay.
      await vi.waitFor(async () => {
        const locks = await db.query(
          "applier",
          `SELECT pid FROM pg_locks
          WHERE locktype = 'advisory' AND classid = $1 AND objid = $2 AND NOT granted`,
          [AUTHORITY_LOCK_CLASSID, AUTHORITY_LOCK_OBJID],
        );
        expect(locks.rows).toHaveLength(1);
      });
      await revoker.transaction((query) =>
        query(`UPDATE "kb_share" SET "revokedAt" = now() WHERE "kbId" = $1 AND "userId" = $2`, [
          kb.id,
          b.id,
        ]),
      );
      await revoker.releaseAuthority();
      await expect(pending).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      expect(readHeadSha(kbBareRepoPath(reposDir, kb.id))).toBe(kb.headSha);
      expect(await prisma.operationIntent.count({ where: { kbId: kb.id } })).toBe(0);
    } finally {
      await revoker.close();
      await pending?.catch(() => {});
    }
  });

  it("holds authority through the COMMITTING commit and lets that reservation finish after revocation", async () => {
    const a = await owner();
    const b = await owner();
    const kb = await activeKb(a.id, "reserve-first");
    await prisma.kbShare.create({ data: { kbId: kb.id, userId: b.id, bits: ["write"] } });
    const revoker = await checkoutPinnedSession({
      connectionString: db.urls.runtime,
      opId: crypto.randomUUID(),
    });
    const startRevocation = Promise.withResolvers<void>();
    // Register outside the writer's AsyncLocalStorage operation context: this
    // is an independent authority-only operation, never a nested lock owner.
    const revocation = startRevocation.promise.then(async () => {
      await revoker.acquire([{ kind: "authority" }]);
      const row = await prisma.operationIntent.findFirst({ where: { kbId: kb.id } });
      expect(row.phase).toBe("COMMITTING"); // Visible on a different SQL session.
      await revoker.transaction((query) =>
        query(`UPDATE "kb_share" SET "revokedAt" = now() WHERE "kbId" = $1 AND "userId" = $2`, [
          kb.id,
          b.id,
        ]),
      );
      await revoker.releaseAuthority();
    });
    void revocation.catch(() => {});
    try {
      await expect(
        publish(kb.id, b.id, "reserved-first", "m", {
          async afterPrepared() {
            const writer = requireOperationLease();
            expect(writer.holdingAuthority()).toBe(true);
            writer.assertHeldKb(kb.id);
            startRevocation.resolve();
            await vi.waitFor(async () => {
              const locks = await db.query(
                "applier",
                `SELECT pid FROM pg_locks
              WHERE pid = $1 AND locktype = 'advisory' AND NOT granted`,
                [revoker.backendPid],
              );
              expect(locks.rows).toHaveLength(1);
            });
          },
          async afterCommitting() {
            expect(requireOperationLease().holdingAuthority()).toBe(false);
            await revocation;
          },
        }),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" }); // Private receipt withheld.
      const intent = await prisma.operationIntent.findFirst({ where: { kbId: kb.id } });
      expect(intent.phase).toBe("FINALIZED");
      expect(readHeadSha(kbBareRepoPath(reposDir, kb.id))).toBe(intent.newRef);
      expect(await prisma.durableJob.count({ where: { dedupKey: `journal:${intent.opId}` } })).toBe(
        1,
      );
      expect(await prisma.auditEvent.count({ where: { opId: intent.opId } })).toBe(1);
    } finally {
      startRevocation.resolve();
      await revocation.catch(() => {});
      await revoker.close();
    }
  });

  it("keeps a failed ref-directory sync COMMITTING until recovery can sync it", async () => {
    const user = await owner();
    const kb = await activeKb(user.id, "fsync-failure");
    const repo = kbBareRepoPath(reposDir, kb.id);
    try {
      await expect(
        publish(kb.id, user.id, "failed-sync", "m", {
          afterCommitting() {
            syncFault.directory = join(repo, "refs/heads");
          },
        }),
      ).rejects.toMatchObject({ code: "EIO" });
      const intent = await prisma.operationIntent.findFirst({ where: { kbId: kb.id } });
      expect(intent.phase).toBe("COMMITTING");
      expect(readHeadSha(repo)).toBe(intent.newRef);
      await expect(publish(kb.id, user.id, "failed-sync", "m")).rejects.toMatchObject({
        code: "EIO",
      });
      await expect(
        runStartupJournalRecovery(prisma, reposDir, assetsDir, db.urls.runtime, assertProcessFence),
      ).rejects.toMatchObject({ code: "EIO" });
      expect(
        (await prisma.operationIntent.findUnique({ where: { opId: intent.opId } })).phase,
      ).toBe("COMMITTING");
      expect((await prisma.knowledgeBase.findUnique({ where: { id: kb.id } })).headSha).toBe(
        kb.headSha,
      );
      expect(await prisma.durableJob.count({ where: { dedupKey: `journal:${intent.opId}` } })).toBe(
        0,
      );
      expect(await prisma.auditEvent.count({ where: { opId: intent.opId } })).toBe(0);
      syncFault.directory = "";
      await runStartupJournalRecovery(
        prisma,
        reposDir,
        assetsDir,
        db.urls.runtime,
        assertProcessFence,
      );
      const receipt = await publish(kb.id, user.id, "failed-sync", "m");
      expect(receipt.headSha).toBe(intent.newRef);
      expect(await publish(kb.id, user.id, "failed-sync", "m")).toEqual(receipt);
      expect(await prisma.durableJob.count({ where: { dedupKey: `journal:${intent.opId}` } })).toBe(
        1,
      );
      expect(await prisma.auditEvent.count({ where: { opId: intent.opId } })).toBe(1);
    } finally {
      syncFault.directory = "";
      setKbRecoveryComplete(true);
    }
  });
});
