import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, renameSync, rmSync } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prismaAssetQuery } from "@knowledge-base/api/lib/kb/asset-authz";
import {
  type AuthorityBarrier,
  runLockedOperation,
} from "@knowledge-base/api/lib/kb/authority-lock";
import {
  type ApplyResult,
  type ChangesApplyEditRequest,
  type ChangesApplyRequest,
  changesPublicationForDocument,
  createChangesPublication,
  DOCUMENT_UPDATE_OPERATION,
} from "@knowledge-base/api/lib/kb/changes";
import { createCursorSigner } from "@knowledge-base/api/lib/kb/cursor";
import { readDocumentAtRevision } from "@knowledge-base/api/lib/kb/documents-read";
import { embeddingFingerprint } from "@knowledge-base/api/lib/kb/fingerprint";
import {
  nearLimitDistinctFiles,
  writeFixtureCommit,
} from "@knowledge-base/api/lib/kb/fixtures/near-limit-tree";
import {
  hardenedGitEnv,
  kbBareRepoPath,
  readHeadSha,
  readRefSha,
  runGit,
} from "@knowledge-base/api/lib/kb/git-read";
import {
  GitCommandError,
  type GitMutatingExecutor,
  writeInitialMainCommit,
} from "@knowledge-base/api/lib/kb/git-write";
import { createMemoryRatePort } from "@knowledge-base/api/lib/kb/limits";
import type { HeldLockLease } from "@knowledge-base/api/lib/kb/lock";
import {
  canonicalRequestHash,
  type PublicationBarrier,
  reconcileKbIntents,
} from "@knowledge-base/api/lib/kb/operation-intent";
import { prismaAuthorityStore } from "@knowledge-base/api/lib/kb/permissions";
import type { CredentialVerifier, Principal } from "@knowledge-base/api/lib/kb/principal";
import {
  createPullRequestPublication,
  getPullRequest,
  type PrMutationRequest,
} from "@knowledge-base/api/lib/kb/pull-requests";
import { reserveQuota, statfsDiskMeter } from "@knowledge-base/api/lib/kb/quota";
import {
  runJournalRecoverySweep,
  setKbRecoveryComplete,
} from "@knowledge-base/api/lib/kb/recovery";
import { captureLog } from "@knowledge-base/env/log";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openKbPostgresClusterFromEnv } from "./index.js";

const cluster = await openKbPostgresClusterFromEnv();
const db = await cluster.createDatabase();
db.applyPrismaSchema();
const prisma = db.createPrismaClient("runtime");
const reposDir = mkdtempSync(join(tmpdir(), "kb-pr-integration-"));
const coordinator = {
  run<T>(options: {
    opId: string;
    kind: "git-write";
    kbIds: string[];
    barrier?: AuthorityBarrier;
    run(ctx: { lease: HeldLockLease }): Promise<T>;
  }) {
    return runLockedOperation({
      ...options,
      connectionString: db.urls.runtime,
      kind: "kb-write",
      run: (lease) => options.run({ lease }),
    });
  },
};
const executor: GitMutatingExecutor = {
  exec({ cwd, argv, env }) {
    return new Promise<void>((resolve, reject) => {
      const child = spawn(argv[0]!, argv.slice(1), { cwd, env, stdio: "ignore" });
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0 ? resolve() : reject(new GitCommandError("fixture", code ?? -1)),
      );
    });
  },
};
afterAll(async () => {
  await prisma.$disconnect();
  await db.close();
  await cluster.close();
  rmSync(reposDir, { recursive: true, force: true });
});
const store = prismaAuthorityStore(prisma);
async function user() {
  return prisma.user.create({
    data: { name: "PR fixture", email: `${randomUUID()}@example.invalid`, emailVerified: true },
  });
}
async function setup() {
  const owner = await user();
  const author = await user();
  const reviewer = await user();
  const row = await prisma.knowledgeBase.create({
    data: {
      ownerId: owner.id,
      name: "PR fixture",
      slug: `pr-${randomUUID().slice(0, 8)}`,
      description: "PR integration fixture",
      state: "CREATING",
    },
  });
  const base = await writeInitialMainCommit(
    { reposDir, kbId: row.id, executor },
    { message: "initial", description: "PR integration fixture" },
  );
  await prisma.knowledgeBase.update({
    where: { id: row.id },
    data: { headSha: base, state: "ACTIVE" },
  });
  await prisma.kbShare.create({ data: { kbId: row.id, userId: author.id, bits: ["propose"] } });
  await prisma.kbShare.create({ data: { kbId: row.id, userId: reviewer.id, bits: ["review"] } });
  setKbRecoveryComplete(true);
  return {
    id: row.id,
    owner: owner.id,
    author: author.id,
    reviewer: reviewer.id,
    base,
    repo: kbBareRepoPath(reposDir, row.id),
  };
}
const edit = (
  baseRevision: string,
  path = "proposal.md",
  body = "proposal",
): ChangesApplyEditRequest => ({
  mode: "edit",
  baseRevision,
  title: "proposal",
  changes: [{ op: "create", path, content: { markdown: body } }],
  sourceSessionIds: [],
});
/**
 * A test client that names a PR read its head first (`proposalHeadSha`
 * is the PR head a write was prepared on). A request that sets the key, even
 * to `undefined`, is sent as is.
 */
async function withObservedHead(
  kbId: string,
  request: ChangesApplyRequest,
): Promise<ChangesApplyRequest> {
  if (request.proposalNumber === undefined || "proposalHeadSha" in request) return request;
  const pr = await prisma.pullRequest.findUnique({
    where: { kbId_number: { kbId, number: request.proposalNumber } },
    select: { headSha: true },
  });
  return pr ? { ...request, proposalHeadSha: pr.headSha } : request;
}
async function apply(kbId: string, userId: string, raw: ChangesApplyRequest) {
  const request = await withObservedHead(kbId, raw);
  const publication = createChangesPublication({
    store,
    principal: { kind: "browser", userId },
    reposDir,
    kbId,
    idempotencyKey: randomUUID(),
    request,
    operation: "CHANGES_APPLY",
    requestHash: canonicalRequestHash(request),
    ratePort: createMemoryRatePort(),
  });
  return (await coordinator.run({
    opId: randomUUID(),
    kind: "git-write",
    kbIds: [kbId],
    barrier: publication.barrier,
    run: (ctx) => publication.publish(ctx.lease, executor),
  })) as ApplyResult;
}
function mutate(userId: string, request: PrMutationRequest, barrier?: PublicationBarrier) {
  const publication = createPullRequestPublication({
    store,
    principal: { kind: "browser", userId },
    reposDir,
    request,
    barrier,
  });
  return coordinator.run({
    opId: randomUUID(),
    kind: "git-write",
    kbIds: [request.kbId],
    barrier: publication.barrier,
    run: (ctx) => publication.publish(ctx.lease, executor),
  });
}
function review(
  kbId: string,
  number: number,
  head: string,
  target: string,
  decision: "merge" | "close" = "merge",
): PrMutationRequest {
  return {
    kind: "review",
    kbId,
    number,
    expectedHeadSha: head,
    expectedTargetSha: target,
    decision,
    confirm: decision === "merge" ? "MERGE" : "CLOSE",
    idempotencyKey: randomUUID(),
  };
}
const signer = createCursorSigner(Buffer.alloc(32, 9));
function detail(userId: string, kbId: string, cursor?: string | null) {
  return getPullRequest(
    {
      store,
      principal: { kind: "browser", userId },
      query: prismaAssetQuery(prisma),
      reposDir,
      cursorSigner: signer,
    },
    { kbId, number: 1, page: { limit: 1, cursor } },
  );
}
async function effects(kbId: string) {
  return {
    kb: await prisma.knowledgeBase.findUnique({
      where: { id: kbId },
      select: { headSha: true, desiredEpoch: true },
    }),
    audit: await prisma.auditEvent.count({ where: { kbId, action: "pr_merge" } }),
    intents: await prisma.operationIntent.count({ where: { kbId, operation: "PR_MERGE" } }),
  };
}

// Match gitFixtureTests' lifecycle: prerequisite IO has a preparation budget,
// while every tested action and every product mutation keep their 30s limit.
// Join timed-out actions before the parent closes the DB/repository fixtures.
function prFixtureTest<T>(
  name: string,
  prepare: (f: Awaited<ReturnType<typeof setup>>) => Promise<T>,
  run: (f: Awaited<ReturnType<typeof setup>>, prepared: T) => Promise<void>,
  /** A scenario of several actions, each still bounded by its own deadline. */
  timeoutMs?: number,
) {
  describe(name, () => {
    let f: Awaited<ReturnType<typeof setup>>;
    let prepared: T;
    let preparation: Promise<void>;
    let action: Promise<void> | undefined;
    beforeAll(() => {
      preparation = (async () => {
        f = await setup();
        prepared = await prepare(f);
      })();
      return preparation;
    }, 180_000);
    afterAll(async () => {
      await preparation?.catch(() => {});
      await action?.catch(() => {});
    }, 180_000);
    it("holds at the publication boundary", { timeout: timeoutMs }, () => {
      action = run(f, prepared);
      return action;
    });
  });
}

describe("PR publication boundary", () => {
  prFixtureTest(
    "recovery removes an inventoried orphan and releases its actual disk charge",
    async (f) => {
      const opId = `merge-${randomUUID()}`;
      const path = join(reposDir, ".private", "tmp", opId);
      await mkdir(path, { recursive: true, mode: 0o700 });
      await writeFile(join(path, "object"), "orphaned merge object");
      const quota = await coordinator.run({
        opId: randomUUID(),
        kind: "git-write",
        kbIds: [f.id],
        run: (ctx) =>
          ctx.lease.transaction((query) =>
            reserveQuota(
              { transactionQuery: query },
              {
                opId,
                charges: [],
                disks: [{ path: reposDir, bytes: 1024n * 1024n, meter: statfsDiskMeter(reposDir) }],
                expiresAt: new Date(Date.now() + 3600000),
              },
            ),
          ),
      });
      return { opId, path, quota };
    },
    async (_f, { opId, path, quota }) => {
      let fenceChecks = 0;
      await runJournalRecoverySweep(prisma, reposDir, reposDir, db.urls.runtime, () => {
        fenceChecks++;
      });
      expect(fenceChecks).toBeGreaterThan(0);
      await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
      const rows = await prisma.quotaReservation.findMany({
        where: { opId },
        select: { id: true, outcome: true },
        take: 2,
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: quota.reservationIds[0], outcome: "RELEASED" });
    },
  );
  prFixtureTest(
    "creates only from an owned USER branch with exact SHAs and one active PR",
    async (f) => {
      const p = await apply(f.id, f.author, edit(f.base));
      await executor.exec({
        cwd: reposDir,
        argv: ["git", "--git-dir", f.repo, "update-ref", "refs/heads/topic", p.commitSha],
        env: hardenedGitEnv(),
      });
      await prisma.branchOwner.create({
        data: {
          kbId: f.id,
          refName: "refs/heads/topic",
          ownerActorKey: `user:${f.author}`,
          purpose: "USER",
        },
      });
      const request: PrMutationRequest = {
        kind: "create",
        kbId: f.id,
        headBranch: "topic",
        expectedHeadSha: p.commitSha,
        expectedTargetSha: f.base,
        title: "User branch",
        idempotencyKey: randomUUID(),
      };
      return { request };
    },
    async (f, { request }) => {
      await expect(mutate(f.owner, request)).rejects.toThrow();
      await expect(mutate(f.author, { ...request, expectedHeadSha: f.base })).rejects.toMatchObject(
        { code: "CONFLICT" },
      );
      const created = await mutate(f.author, request);
      expect(created.pr).toMatchObject({ number: 2, status: "OPEN", sourceBranch: "topic" });
      expect(await mutate(f.author, request)).toEqual(created);
      await expect(
        mutate(f.author, { ...request, idempotencyKey: randomUUID() }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(readHeadSha(f.repo)).toBe(f.base);
    },
  );
  prFixtureTest(
    "ancestor merges record review; replay retains the same SHA, audit, and desired epoch",
    async (f) => {
      const proposed = await apply(f.id, f.author, edit(f.base));
      const provider = await prisma.embeddingProvider.create({
        data: { ownerId: f.owner, name: "fixture" },
      });
      const probe = await prisma.durableJob.create({
        data: { dedupKey: randomUUID(), kind: "PROVIDER_PROBE", desired: {}, state: "COMPLETE" },
      });
      const config = {
        endpointUrl: "https://provider.example.invalid/embeddings",
        model: "fixture",
        dimensions: 2,
      };
      await prisma.providerRevision.create({
        data: {
          ...config,
          providerId: provider.id,
          version: 1,
          ownerSnapshot: f.owner,
          fingerprint: embeddingFingerprint(config),
          ciphertext: "fixture-only-unused",
          jobId: probe.id,
          idempotencyKey: randomUUID(),
          requestHash: "0".repeat(64),
        },
      });
      await prisma.knowledgeBase.update({
        where: { id: f.id },
        data: { profileProviderId: provider.id, profileVersion: 1 },
      });
      return { proposed, request: review(f.id, 1, proposed.commitSha, f.base) };
    },
    async (f, { proposed, request }) => {
      const merged = await mutate(f.reviewer, request);
      expect(merged.pr.status).toBe("MERGED");
      const mergeSha = merged.pr.mergeCommitSha!;
      expect(mergeSha).not.toBe(proposed.commitSha);
      expect(readHeadSha(f.repo)).toBe(mergeSha);
      expect(runGit(f.repo, ["rev-list", "--parents", "-n", "1", mergeSha])).toBe(
        `${mergeSha} ${f.base} ${proposed.commitSha}`,
      );
      expect(commitMessage(f.repo, mergeSha)).toBe(
        "Merge #1: proposal\n\nActed-by: PR fixture via web",
      );
      const state = await effects(f.id);
      expect(state.audit).toBe(1);
      // Nothing of the new head is active, so the merge schedules the lexical companion
      // (epoch 1) before the semantic build (epoch 2); the replay schedules nothing more.
      expect(state.kb?.desiredEpoch).toBe(2n);
      expect(await mutate(f.reviewer, request)).toEqual(merged);
      expect(await effects(f.id)).toEqual(state);
      for (const [epoch, mode] of [
        [1, "lexical"],
        [2, undefined],
      ] as const) {
        const jobs = await prisma.durableJob.findMany({
          where: { dedupKey: `index:${f.id}:${epoch}` },
          take: 2,
        });
        expect(jobs).toHaveLength(1);
        expect(jobs[0]?.kind).toBe("INDEX_KB");
        expect((jobs[0]!.desired as { mode?: string }).mode).toBe(mode);
      }
      await expect(
        apply(f.id, f.reviewer, edit(proposed.commitSha, "forbidden.md")),
      ).rejects.toThrow();
      await expect(
        apply(f.id, f.author, { ...edit(proposed.commitSha), proposalNumber: 1 }),
      ).rejects.toThrow();
      expect(readRefSha(f.repo, "refs/heads/pr/1")).toBe(proposed.commitSha);
    },
  );
  prFixtureTest(
    "clean divergence keeps both sides with ordered parents",
    async (f) => {
      const p = await apply(f.id, f.author, edit(f.base));
      const main = await apply(f.id, f.owner, edit(f.base, "main.md", "main"));
      const previousScratchIds = new Set(
        (
          await prisma.quotaReservation.findMany({
            where: { opId: { startsWith: "merge-" } },
            select: { id: true },
            take: 32,
          })
        ).map((r) => r.id),
      );
      return { p, main, previousScratchIds };
    },
    async (f, { p, main, previousScratchIds }) => {
      const result = await mutate(f.reviewer, review(f.id, 1, p.commitSha, main.commitSha));
      expect(runGit(f.repo, ["cat-file", "-p", result.pr.mergeCommitSha!])).toContain(
        `parent ${main.commitSha}\nparent ${p.commitSha}`,
      );
      expect(runGit(f.repo, ["ls-tree", "-r", "--name-only", result.pr.mergeCommitSha!])).toContain(
        "main.md",
      );
      const scratchCharges = await prisma.$queryRaw<
        { id: string; outcome: string; dimension: string; amount: string }[]
      >`
      SELECT r.id, r.outcome::text AS outcome, a.dimension::text AS dimension, r.amount::text AS amount
      FROM quota_reservation r JOIN quota_account a ON a.id = r."accountId"
      WHERE r."opId" LIKE 'merge-%' ORDER BY r.id LIMIT 32`;
      const newCharges = scratchCharges.filter((r) => !previousScratchIds.has(r.id));
      expect(newCharges).toHaveLength(1);
      expect(newCharges[0]).toMatchObject({ outcome: "RELEASED", dimension: "DISK_VOLUME" });
      expect(BigInt(newCharges[0]!.amount)).toBeGreaterThan(0n);
    },
  );
  for (const dream of [false, true]) {
    prFixtureTest(
      `content/provenance conflict produces zero publication effects (dream=${dream})`,
      async (f) => {
        const request: ChangesApplyRequest = dream
          ? {
              mode: "dream",
              baseRevision: f.base,
              title: "dream",
              changes: [],
              sourceSessionIds: [randomUUID()],
              dream: {
                model: { provider: "fixture", model: "fixture" },
                redactionApplied: true,
                upserts: [
                  {
                    id: "a",
                    type: "concept",
                    title: null,
                    body: "dream",
                    citations: [],
                    provenance: "dream",
                  },
                ],
              },
            }
          : edit(f.base, "same.md", "proposal");
        const p = await apply(f.id, f.author, request);
        const main = await apply(
          f.id,
          f.owner,
          edit(
            f.base,
            dream ? "concepts/a.md" : "same.md",
            dream ? "---\nid: a\nprovenance: human\n---\nhuman" : "main",
          ),
        );
        return { p, main, before: await effects(f.id) };
      },
      async (f, { p, main, before }) => {
        const refused = await mutate(
          f.reviewer,
          review(f.id, 1, p.commitSha, main.commitSha),
        ).catch((error: unknown) => error);
        expect(refused).toBeInstanceOf(Error);
        expect((refused as Error).message).toMatch(/^This pull request conflicts with main\./);
        // Same revisions, unmergeable content — distinct from moved revisions.
        expect(refused).toMatchObject({ code: "CONFLICT", conflict: { kind: "content_conflict" } });
        expect(await effects(f.id)).toEqual(before);
        expect(readHeadSha(f.repo)).toBe(main.commitSha);
        expect(
          (
            await prisma.pullRequest.findUnique({
              where: { kbId_number: { kbId: f.id, number: 1 } },
            })
          )?.status,
        ).toBe("OPEN");
      },
    );
  }
  prFixtureTest(
    "source advance journals version, clears CONFLICT, and rejects the old head",
    async (f) => {
      const p = await apply(f.id, f.author, edit(f.base));
      await prisma.pullRequest.update({
        where: { kbId_number: { kbId: f.id, number: 1 } },
        data: { status: "CONFLICT" },
      });
      return { p };
    },
    async (f, { p }) => {
      const next = await apply(f.id, f.author, edit(p.commitSha, "next.md"));
      expect(next.proposal).toMatchObject({ number: 1, status: "OPEN", version: 2 });
      await expect(mutate(f.reviewer, review(f.id, 1, p.commitSha, f.base))).rejects.toMatchObject({
        code: "CONFLICT",
        conflict: {
          kind: "revision_moved",
          headMoved: true,
          targetMoved: false,
          currentHeadSha: next.commitSha,
          currentTargetSha: f.base,
        },
      });
    },
  );
  prFixtureTest(
    "rejects the old target while the reviewed source stays current",
    async (f) => {
      const p = await apply(f.id, f.author, edit(f.base));
      const next = await apply(f.id, f.author, edit(p.commitSha, "next.md"));
      const main = await apply(f.id, f.owner, edit(f.base, "main.md"));
      return { next, main };
    },
    async (f, { next, main }) => {
      await expect(
        mutate(f.reviewer, review(f.id, 1, next.commitSha, f.base)),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        conflict: {
          kind: "revision_moved",
          headMoved: false,
          targetMoved: true,
          currentHeadSha: next.commitSha,
          currentTargetSha: main.commitSha,
        },
      });
      expect(readHeadSha(f.repo)).toBe(main.commitSha);
    },
  );
  prFixtureTest(
    "propose author closes with no ref change; wrong actor and merge are forbidden",
    async (f) => {
      const p = await apply(f.id, f.author, edit(f.base));
      const stranger = await user();
      await prisma.kbShare.create({ data: { kbId: f.id, userId: stranger.id, bits: ["write"] } });
      return { p, stranger, before: readHeadSha(f.repo) };
    },
    async (f, { p, stranger, before }) => {
      await expect(mutate(f.author, review(f.id, 1, p.commitSha, f.base))).rejects.toThrow();
      await expect(
        mutate(stranger.id, review(f.id, 1, p.commitSha, f.base, "close")),
      ).rejects.toThrow();
      const request = review(f.id, 1, p.commitSha, f.base, "close");
      const closed = await mutate(f.author, request);
      expect(closed.pr.status).toBe("CLOSED");
      expect(readHeadSha(f.repo)).toBe(before);
      expect(readRefSha(f.repo, "refs/heads/pr/1")).toBe(p.commitSha);
      expect(await mutate(f.author, request)).toEqual(closed);
      await expect(mutate(f.reviewer, review(f.id, 1, p.commitSha, f.base))).rejects.toMatchObject({
        code: "CONFLICT",
        conflict: { kind: "state_changed" },
      });
    },
  );
  prFixtureTest(
    "revocation before reservation prevents publication",
    async (f) => {
      const p = await apply(f.id, f.author, edit(f.base));
      return { p };
    },
    async (f, { p }) => {
      await expect(
        mutate(f.reviewer, review(f.id, 1, p.commitSha, f.base), {
          afterPrepared: async () => {
            await prisma.kbShare.update({
              where: { kbId_userId: { kbId: f.id, userId: f.reviewer } },
              data: { revokedAt: new Date() },
            });
          },
        }),
      ).rejects.toThrow();
      expect(readHeadSha(f.repo)).toBe(f.base);
    },
  );
  prFixtureTest(
    "after CAS recovery finalizes exactly once without authority",
    async (f) => {
      const p = await apply(f.id, f.author, edit(f.base));
      const request = review(f.id, 1, p.commitSha, f.base);
      await expect(
        mutate(f.reviewer, request, {
          afterRefUpdate: async () => {
            await prisma.kbShare.update({
              where: { kbId_userId: { kbId: f.id, userId: f.reviewer } },
              data: { revokedAt: new Date() },
            });
            throw new Error("lost process after CAS");
          },
        }),
      ).rejects.toThrow("lost process after CAS");
      return { p, request };
    },
    async (f, { p, request }) => {
      await coordinator.run({
        opId: randomUUID(),
        kind: "git-write",
        kbIds: [f.id],
        run: (ctx) => ctx.lease.transaction((q) => reconcileKbIntents(q, reposDir, f.id)),
      });
      const once = await effects(f.id);
      expect(once.audit).toBe(1);
      const mergeSha = readHeadSha(f.repo)!;
      expect(mergeSha).not.toBe(p.commitSha);
      expect(once.kb?.headSha).toBe(mergeSha);
      expect(runGit(f.repo, ["rev-parse", `${mergeSha}^{tree}`])).toBe(
        runGit(f.repo, ["rev-parse", `${p.commitSha}^{tree}`]),
      );
      await expect(mutate(f.reviewer, request)).rejects.toThrow();
      await prisma.kbShare.update({
        where: { kbId_userId: { kbId: f.id, userId: f.reviewer } },
        data: { revokedAt: null },
      });
      expect((await mutate(f.reviewer, request)).pr.mergeCommitSha).toBe(mergeSha);
      expect(await effects(f.id)).toEqual(once);
    },
  );
  prFixtureTest(
    "merge versus main write serializes with one winner and no lost update",
    async (f) => {
      const p = await apply(f.id, f.author, edit(f.base));
      return { p };
    },
    async (f, { p }) => {
      const outcomes = await Promise.allSettled([
        mutate(f.reviewer, review(f.id, 1, p.commitSha, f.base)),
        apply(f.id, f.owner, edit(f.base, "racer.md")),
      ]);
      expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.filter((r) => r.status === "rejected")).toHaveLength(1);
      expect((await effects(f.id)).kb?.headSha).toBe(readHeadSha(f.repo));
    },
  );
  prFixtureTest(
    "detail pages retain viewed base/head/target even after source and main advance",
    async (f) => {
      const p = await apply(f.id, f.author, {
        ...edit(f.base),
        changes: [
          { op: "create", path: "a.md", content: { markdown: "a" } },
          { op: "create", path: "b.md", content: { markdown: "b" } },
        ],
      });
      const first = await detail(f.reviewer, f.id);
      await apply(f.id, f.author, edit(p.commitSha, "z.md"));
      await apply(f.id, f.owner, edit(f.base, "main.md"));
      return { p, first };
    },
    async (f, { p, first }) => {
      expect(first.nextCursor).toBeTruthy();
      const second = await detail(f.reviewer, f.id, first.nextCursor);
      expect(second.pr.headSha).toBe(p.commitSha);
      expect(second.pr.targetSha).toBe(f.base);
      expect([...first.files, ...second.files].map((f) => f.path)).toEqual(["a.md", "b.md"]);
      expect(second.nextCursor).toBeNull();
    },
  );
});

function prRead(userId: string) {
  return {
    store,
    principal: { kind: "browser" as const, userId },
    query: prismaAssetQuery(prisma),
    reposDir,
    cursorSigner: signer,
  };
}
const replace = (baseRevision: string, path: string, body: string): ChangesApplyEditRequest => ({
  mode: "edit",
  baseRevision,
  title: `Update ${path}`,
  changes: [{ op: "replace", path, content: { markdown: body } }],
  sourceSessionIds: [],
});
async function prRow(kbId: string, number = 1) {
  return prisma.pullRequest.findUniqueOrThrow({
    where: { kbId_number: { kbId, number } },
    select: { status: true, baseSha: true, headSha: true, version: true, mergeCheckedSha: true },
  });
}
const commitMessage = (repo: string, sha: string) =>
  runGit(repo, ["cat-file", "commit", sha]).split("\n\n").slice(1).join("\n\n");

describe("PR conflicts, updates and ownership", () => {
  prFixtureTest(
    "a PR turns CONFLICT when main clashes and OPEN again once moved onto main",
    async (f) => {
      const doc = await apply(f.id, f.owner, edit(f.base, "rate.md", "limit 100\n"));
      const proposed = await apply(
        f.id,
        f.author,
        replace(doc.commitSha, "rate.md", "limit 200\n"),
      );
      const main = await apply(f.id, f.owner, replace(doc.commitSha, "rate.md", "limit 50\n"));
      return { doc, proposed, main };
    },
    async (f, { doc, proposed, main }) => {
      expect(proposed.proposal?.number).toBe(1);
      const viewed = await getPullRequest(prRead(f.reviewer), { kbId: f.id, number: 1 });
      expect(viewed.pr.status).toBe("CONFLICT");
      expect((await prRow(f.id)).mergeCheckedSha).toBe(main.commitSha);
      const { listPullRequests } = await import("@knowledge-base/api/lib/kb/pull-requests");
      const conflicted = await listPullRequests(prRead(f.reviewer), {
        kbId: f.id,
        status: "CONFLICT",
      });
      expect(conflicted.items.map((pr) => pr.number)).toEqual([1]);

      // Still clashing: the CONFLICT carries every version of the unresolved path.
      const other = replace(main.commitSha, "index.md", "# Index\n\nother\n");
      await expect(apply(f.id, f.author, other)).rejects.toMatchObject({
        code: "CONFLICT",
        details: {
          reason: "PROPOSAL_CONFLICT",
          headSha: main.commitSha,
          proposalNumber: 1,
          baseSha: doc.commitSha,
          proposalHeadSha: proposed.commitSha,
          contentIncluded: true,
          paths: [
            { path: "rate.md", base: "limit 100\n", theirs: "limit 50\n", yours: "limit 200\n" },
          ],
        },
      });
      expect(readRefSha(f.repo, "refs/heads/pr/1")).toBe(proposed.commitSha);

      // Overwriting a PR-changed path needs the PR named with the head the
      // caller read (one consent rule): unnamed, nothing is applied.
      await expect(
        apply(f.id, f.author, replace(main.commitSha, "rate.md", "limit 75\n")),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        details: { reason: "PROPOSAL_CONFLICT", paths: [{ path: "rate.md", kind: "document" }] },
      });
      expect(readRefSha(f.repo, "refs/heads/pr/1")).toBe(proposed.commitSha);
      // Writing the file in full against main, naming the PR, resolves it:
      // same PR, new base.
      const moved = await apply(f.id, f.author, {
        ...replace(main.commitSha, "rate.md", "limit 75\n"),
        proposalNumber: 1,
      });
      expect(moved.kind).toBe("proposed");
      expect(moved.proposal?.number).toBe(1);
      const row = await prRow(f.id);
      expect(row).toMatchObject({ baseSha: main.commitSha, headSha: moved.commitSha, version: 2 });
      expect(runGit(f.repo, ["rev-parse", `${moved.commitSha}^`])).toBe(main.commitSha);
      const after = await getPullRequest(prRead(f.reviewer), { kbId: f.id, number: 1 });
      expect(after.pr.status).toBe("OPEN");
      expect(after.files.map((file) => file.path)).toEqual(["rate.md"]);
      const merged = await mutate(f.reviewer, review(f.id, 1, moved.commitSha, main.commitSha));
      expect(merged.pr.status).toBe("MERGED");
    },
  );
  prFixtureTest(
    "a clean update against main replays the PR's earlier changes onto main",
    async (f) => {
      const first = await apply(f.id, f.author, edit(f.base, "a.md", "a"));
      const main = await apply(f.id, f.owner, edit(f.base, "b.md", "b"));
      return { first, main };
    },
    async (f, { first, main }) => {
      // Writing a path the PR changed, against main's version, would drop the PR's
      // change unseen: it clashes, and naming the PR makes it the resolution.
      await expect(
        apply(f.id, f.author, replace(main.commitSha, "a.md", "a2")),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        details: {
          reason: "PROPOSAL_CONFLICT",
          paths: [{ path: "a.md", base: null, theirs: null, yours: "a" }],
        },
      });
      expect(readRefSha(f.repo, "refs/heads/pr/1")).toBe(first.commitSha);
      const moved = await apply(f.id, f.author, edit(main.commitSha, "c.md", "c"));
      expect(moved.proposal?.number).toBe(1);
      expect(runGit(f.repo, ["rev-parse", `${moved.commitSha}^`])).toBe(main.commitSha);
      expect(runGit(f.repo, ["show", `${moved.commitSha}:a.md`])).toBe("a");
      expect((await prRow(f.id)).baseSha).toBe(main.commitSha);
      const detail = await getPullRequest(prRead(f.reviewer), { kbId: f.id, number: 1 });
      expect(detail.files.map((file) => file.path)).toEqual(["a.md", "c.md"]);
      expect(first.commitSha).not.toBe(moved.commitSha);
    },
  );
  prFixtureTest(
    "while the PR sits on main, an edit against main applies on its head (R3-W6)",
    async (f) => ({ p: await apply(f.id, f.author, edit(f.base, "a.md", "a")) }),
    async (f, { p }) => {
      // A path the PR did not change: main's version is the PR's own.
      const next = await apply(f.id, f.author, edit(f.base, "b.md", "b"));
      expect(next.proposal).toMatchObject({ number: 1, version: 2, baseSha: f.base });
      expect(runGit(f.repo, ["rev-parse", `${next.commitSha}^`])).toBe(p.commitSha);
      expect(runGit(f.repo, ["show", `${next.commitSha}:a.md`])).toBe("a");
      // R3-W5: the PR keeps the title it was opened with.
      expect(next.proposal?.title).toBe("proposal");
      // Rewriting the PR's own path against main needs its number.
      await expect(
        apply(f.id, f.author, replace(f.base, "a.md", "from main")),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        details: {
          reason: "PROPOSAL_CONFLICT",
          proposalNumber: 1,
          proposalHeadSha: next.commitSha,
          paths: [{ path: "a.md", kind: "document", theirs: null, yours: "a" }],
        },
      });
      // Naming the PR against main needs the PR head the choice was made
      // on; a second editor holding an older head is refused (no overwrite).
      await expect(
        apply(f.id, f.author, {
          ...replace(f.base, "a.md", "chosen"),
          proposalNumber: 1,
          proposalHeadSha: undefined,
        }),
      ).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
        details: { reason: "MISSING_ARGUMENT", field: "/proposalHeadSha" },
      });
      await expect(
        apply(f.id, f.author, {
          ...replace(f.base, "a.md", "stale"),
          proposalNumber: 1,
          proposalHeadSha: p.commitSha,
        }),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        details: { headSha: next.commitSha, proposalNumber: 1 },
      });
      const named = await apply(f.id, f.author, {
        ...replace(f.base, "a.md", "chosen"),
        proposalNumber: 1,
        proposalHeadSha: next.commitSha,
      });
      expect(named.proposal).toMatchObject({ number: 1, version: 3, title: "proposal" });
      expect(runGit(f.repo, ["show", `${named.commitSha}:a.md`])).toBe("chosen");
      expect(runGit(f.repo, ["show", `${named.commitSha}:b.md`])).toBe("b");
      // A no-op on a path the PR did not change names the revision it was
      // evaluated on: the PR head, not main.
      const noop = await apply(
        f.id,
        f.author,
        replace(f.base, "index.md", "# Knowledge base\n\nPR integration fixture\n"),
      );
      expect(noop.kind).toBe("noop");
      expect(noop.commitSha).toBe(named.commitSha);
      expect(noop.proposal?.headSha).toBe(named.commitSha);
    },
  );
  prFixtureTest(
    "fresh no-op receipts require validated status against current main",
    async (f) => {
      const doc = await apply(f.id, f.owner, edit(f.base, "rate.md", "limit 100\n"));
      const proposed = await apply(
        f.id,
        f.author,
        replace(doc.commitSha, "rate.md", "limit 200\n"),
      );
      const main = await apply(f.id, f.owner, replace(doc.commitSha, "rate.md", "limit 50\n"));
      return { proposed, main };
    },
    async (f, { proposed, main }) => {
      const noop = await apply(f.id, f.author, {
        ...replace(proposed.commitSha, "rate.md", "limit 200\n"),
        proposalNumber: 1,
        proposalHeadSha: proposed.commitSha,
      });
      expect(noop.kind).toBe("noop");
      expect(noop.proposal).toMatchObject({ status: "CONFLICT", targetSha: main.commitSha });
      // A no-op on an unaffected path still needs to read/validate the PR's
      // changed content. Operational failure cannot mint a stale receipt.
      const blob = runGit(f.repo, ["rev-parse", "refs/heads/pr/1:rate.md"]);
      const loose = join(f.repo, "objects", blob.slice(0, 2), blob.slice(2));
      renameSync(loose, `${loose}.away`);
      try {
        await expect(
          apply(f.id, f.author, {
            ...replace(
              proposed.commitSha,
              "index.md",
              "# Knowledge base\n\nPR integration fixture\n",
            ),
            proposalNumber: 1,
            proposalHeadSha: proposed.commitSha,
          }),
        ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
      } finally {
        renameSync(`${loose}.away`, loose);
      }
    },
  );
  prFixtureTest(
    "a refused merge lists the clashing paths with their versions",
    async (f) => {
      const doc = await apply(f.id, f.owner, edit(f.base, "rate.md", "limit 100\n"));
      const proposed = await apply(
        f.id,
        f.author,
        replace(doc.commitSha, "rate.md", "limit 200\n"),
      );
      const main = await apply(f.id, f.owner, replace(doc.commitSha, "rate.md", "limit 50\n"));
      return { doc, proposed, main };
    },
    async (f, { doc, proposed, main }) => {
      await expect(
        mutate(f.reviewer, review(f.id, 1, proposed.commitSha, main.commitSha)),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        conflict: { kind: "content_conflict" },
        details: {
          reason: "PROPOSAL_CONFLICT",
          headSha: main.commitSha,
          proposalNumber: 1,
          baseSha: doc.commitSha,
          proposalHeadSha: proposed.commitSha,
          paths: [{ path: "rate.md", theirs: "limit 50\n", yours: "limit 200\n" }],
        },
      });
      const { getPullRequestConflicts } = await import("@knowledge-base/api/lib/kb/pull-requests");
      const listed = await getPullRequestConflicts(prRead(f.author), { kbId: f.id, number: 1 });
      expect(listed).toMatchObject({
        status: "CONFLICT",
        targetSha: main.commitSha,
        isDream: false,
        truncated: false,
        paths: [
          {
            path: "rate.md",
            kind: "document",
            recorded: false,
            standing: false,
            baseSha: doc.commitSha,
            theirsSha: main.commitSha,
            yoursSha: proposed.commitSha,
          },
        ],
      });
    },
  );
  prFixtureTest(
    "the conflicts list makes the status current first and pairs it with that main",
    async (f) => {
      const doc = await apply(f.id, f.owner, edit(f.base, "rate.md", "limit 100\n"));
      const proposed = await apply(
        f.id,
        f.author,
        replace(doc.commitSha, "rate.md", "limit 200\n"),
      );
      const main = await apply(f.id, f.owner, replace(doc.commitSha, "rate.md", "limit 50\n"));
      return { proposed, main };
    },
    async (f, { main }) => {
      const { getPullRequestConflicts } = await import("@knowledge-base/api/lib/kb/pull-requests");
      // No read has refreshed the cached OPEN yet.
      const clashing = await getPullRequestConflicts(prRead(f.author), { kbId: f.id, number: 1 });
      expect(clashing).toMatchObject({ status: "CONFLICT", targetSha: main.commitSha });
      expect(clashing.paths.map((p) => p.path)).toEqual(["rate.md"]);
      // Main takes the PR's version: the cached CONFLICT must not survive.
      const healed = await apply(f.id, f.owner, replace(main.commitSha, "rate.md", "limit 200\n"));
      const clean = await getPullRequestConflicts(prRead(f.author), { kbId: f.id, number: 1 });
      expect(clean).toMatchObject({ status: "OPEN", targetSha: healed.commitSha, paths: [] });
    },
  );
  prFixtureTest(
    "the conflicts list never serves a cached status it could not make current",
    async (f) => {
      const doc = await apply(f.id, f.owner, edit(f.base, "rate.md", "limit 100\n"));
      const proposed = await apply(
        f.id,
        f.author,
        replace(doc.commitSha, "rate.md", "limit 200\n"),
      );
      return { doc, proposed };
    },
    async (f, { doc }) => {
      const { getPullRequestConflicts } = await import("@knowledge-base/api/lib/kb/pull-requests");
      const conflicts = (hooks = {}) =>
        getPullRequestConflicts(prRead(f.author), { kbId: f.id, number: 1 }, hooks);
      // The PR's own blob made unreadable: every check of it fails.
      const blob = runGit(f.repo, ["rev-parse", "refs/heads/pr/1:rate.md"]);
      const loose = join(f.repo, "objects", blob.slice(0, 2), blob.slice(2));
      const sabotaged = async <T>(run: () => Promise<T>) => {
        renameSync(loose, `${loose}.away`);
        try {
          return await run();
        } finally {
          renameSync(`${loose}.away`, loose);
        }
      };
      // Cached OPEN, main moved to a clash: no stale OPEN with the old target.
      expect((await conflicts()).status).toBe("OPEN");
      const clash = await apply(f.id, f.owner, replace(doc.commitSha, "rate.md", "limit 50\n"));
      await expect(sabotaged(() => conflicts())).rejects.toMatchObject({
        code: "STORAGE_UNAVAILABLE",
      });
      // Cached CONFLICT, main moved again: no stale CONFLICT either.
      expect(await conflicts()).toMatchObject({ status: "CONFLICT", targetSha: clash.commitSha });
      await apply(f.id, f.owner, replace(clash.commitSha, "rate.md", "limit 51\n"));
      await expect(sabotaged(() => conflicts())).rejects.toMatchObject({
        code: "STORAGE_UNAVAILABLE",
      });
      // Main moving under every check is a race it never answers from.
      let n = 0;
      await expect(
        conflicts({
          afterRefresh: async () => {
            const head = (await prisma.knowledgeBase.findUniqueOrThrow({ where: { id: f.id } }))
              .headSha!;
            n += 1;
            await apply(f.id, f.owner, edit(head, `race-${n}.md`, "r"));
          },
        }),
      ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    },
  );
  prFixtureTest(
    "every answer of the new PR reads re-checks authority last (revoked mid-read)",
    async (f) => {
      const doc = await apply(f.id, f.owner, edit(f.base, "rate.md", "limit 100\n"));
      const proposed = await apply(
        f.id,
        f.author,
        replace(doc.commitSha, "rate.md", "limit 200\n"),
      );
      return { doc, proposed };
    },
    async (f, { doc, proposed }) => {
      const { getPullRequestConflicts, findViewerProposalForPath } = await import(
        "@knowledge-base/api/lib/kb/pull-requests"
      );
      const share = { kbId_userId: { kbId: f.id, userId: f.author } };
      const revoke = async () => {
        await prisma.kbShare.update({ where: share, data: { revokedAt: new Date() } });
      };
      const restore = async () => {
        await prisma.kbShare.update({ where: share, data: { revokedAt: null } });
      };
      const conflictsRevoked = async () => {
        await expect(
          getPullRequestConflicts(
            prRead(f.author),
            { kbId: f.id, number: 1 },
            { afterRefresh: revoke },
          ),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
        await restore();
      };
      // OPEN branch.
      await conflictsRevoked();
      // CONFLICT branch.
      await apply(f.id, f.owner, replace(doc.commitSha, "rate.md", "limit 50\n"));
      await conflictsRevoked();
      // forDocument, both the "no PR changes it" and the "changes it" answers.
      for (const path of ["other.md", "rate.md"]) {
        let revoked = false;
        const base = prRead(f.author).query;
        // Revoke right after the PR lookup reads, before the answer is sent.
        async function query<R = Record<string, unknown>>(text: string, values?: unknown[]) {
          const result = await base<R>(text, values);
          if (!revoked && text.includes("pull_request")) {
            revoked = true;
            await revoke();
          }
          return result;
        }
        const read = { ...prRead(f.author), userId: f.author, query };
        await expect(findViewerProposalForPath(read, { kbId: f.id, path })).rejects.toMatchObject({
          code: "NOT_FOUND",
        });
        await restore();
      }
      // Terminal branch: a closed PR.
      const viewed = await getPullRequest(prRead(f.reviewer), { kbId: f.id, number: 1 });
      await mutate(f.reviewer, review(f.id, 1, proposed.commitSha, viewed.pr.targetSha, "close"));
      await conflictsRevoked();
    },
  );
  prFixtureTest(
    "naming one's own closed PR is the precondition answer; another's stays invisible",
    async (f) => ({ p: await apply(f.id, f.author, edit(f.base, "a.md", "a")) }),
    async (f, { p }) => {
      await mutate(f.author, review(f.id, 1, p.commitSha, f.base, "close"));
      await expect(
        apply(f.id, f.author, {
          ...edit(f.base, "b.md", "b"),
          proposalNumber: 1,
          proposalHeadSha: p.commitSha,
        }),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        details: { headSha: f.base, proposalNumber: null },
      });
      await expect(
        apply(f.id, f.owner, {
          ...edit(f.base, "b.md", "b"),
          proposalNumber: 1,
          proposalHeadSha: p.commitSha,
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    },
  );
  prFixtureTest(
    "another person's PR at the same head never hides the caller's own (bounded lookup)",
    async (f) => {
      const p = await apply(f.id, f.author, edit(f.base, "a.md", "a"));
      return { p };
    },
    async (f, { p }) => {
      // Nine other people's open PRs at the same head, all newer.
      const first = await prisma.pullRequest.findUniqueOrThrow({
        where: { kbId_number: { kbId: f.id, number: 1 } },
      });
      for (let n = 2; n <= 10; n += 1) {
        const refName = `refs/heads/other/${n}`;
        await prisma.branchOwner.create({
          data: { kbId: f.id, refName, ownerActorKey: `user:${f.reviewer}`, purpose: "USER" },
        });
        await prisma.pullRequest.create({
          data: {
            kbId: f.id,
            number: n,
            title: "other",
            sourceBranch: refName,
            baseSha: first.baseSha,
            headSha: first.headSha,
            targetSha: first.targetSha,
            status: "OPEN",
            authorActorKey: `user:${f.reviewer}`,
          },
        });
      }
      // The author holds write now: editing at their PR head continues it.
      await prisma.kbShare.update({
        where: { kbId_userId: { kbId: f.id, userId: f.author } },
        data: { bits: ["propose", "write"] },
      });
      const next = await apply(f.id, f.author, edit(p.commitSha, "b.md", "b"));
      expect(next.proposal?.number).toBe(1);
    },
  );
  prFixtureTest(
    "the person owns the PR: their web session closes what their token opened",
    async (f) => {
      const p = await apply(f.id, f.author, edit(f.base));
      const grantId = randomUUID();
      await prisma.mcpGrant.create({
        data: {
          id: grantId,
          actorUserIdSnapshot: f.author,
          userId: f.author,
          kind: "PAT",
          clientId: "pat",
          referenceId: randomUUID(),
          scopes: ["mcp:read", "mcp:write"],
          toolGroups: ["read", "edit", "pull_requests"],
        },
      });
      // As if `bob-direct` had opened it: the PR and its branch belong to the grant.
      for (const table of ["branch_owner", "pull_request"])
        await db.query(
          "applier",
          `UPDATE ${table} SET "${table === "branch_owner" ? "ownerActorKey" : "authorActorKey"}" = $1 WHERE "kbId" = $2`,
          [`grant:${grantId}`, f.id],
        );
      const other = await user();
      await prisma.kbShare.create({ data: { kbId: f.id, userId: other.id, bits: ["propose"] } });
      const reader = await user();
      await prisma.kbShare.create({ data: { kbId: f.id, userId: reader.id, bits: ["read"] } });
      return { p, other: other.id, reader: reader.id };
    },
    async (f, { p, other, reader }) => {
      const close = () => review(f.id, 1, p.commitSha, f.base, "close");
      await expect(mutate(other, close())).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(mutate(reader, close())).rejects.toMatchObject({ code: "FORBIDDEN" });
      // The person may also update it from the web, though a token opened it.
      const updated = await apply(f.id, f.author, {
        ...edit(p.commitSha, "more.md"),
        proposalNumber: 1,
      });
      expect(updated.proposal?.number).toBe(1);
      const closed = await mutate(f.author, review(f.id, 1, updated.commitSha, f.base, "close"));
      expect(closed.pr.status).toBe("CLOSED");
    },
  );
  prFixtureTest(
    "an owner continues their token-opened PR from the web, at its head and after main moves",
    async (f) => {
      const p = await apply(f.id, f.author, edit(f.base, "a.md", "a\n"));
      const grantId = randomUUID();
      await prisma.mcpGrant.create({
        data: {
          id: grantId,
          actorUserIdSnapshot: f.owner,
          userId: f.owner,
          kind: "PAT",
          clientId: "pat",
          referenceId: randomUUID(),
          scopes: ["mcp:read", "mcp:write"],
          toolGroups: ["read", "edit"],
        },
      });
      // As if the owner's propose-only token had opened it.
      for (const table of ["branch_owner", "pull_request"])
        await db.query(
          "applier",
          `UPDATE ${table} SET "${table === "branch_owner" ? "ownerActorKey" : "authorActorKey"}" = $1 WHERE "kbId" = $2`,
          [`grant:${grantId}`, f.id],
        );
      return { p };
    },
    async (f, { p }) => {
      // Editing at the PR head targets that PR, not main (write access notwithstanding).
      const continued = await apply(f.id, f.owner, edit(p.commitSha, "b.md", "b\n"));
      expect(continued).toMatchObject({ kind: "proposed", proposal: { number: 1 } });
      // Ordinary main writes are unchanged.
      const main = await apply(f.id, f.owner, edit(f.base, "m.md", "m\n"));
      expect(main.kind).toBe("applied");
      // Naming the PR against the new main moves it onto main.
      const moved = await apply(f.id, f.owner, {
        ...edit(main.commitSha, "c.md", "c\n"),
        proposalNumber: 1,
      });
      expect(moved).toMatchObject({ kind: "proposed", proposal: { number: 1 } });
      expect((await prRow(f.id)).baseSha).toBe(main.commitSha);
    },
  );
  prFixtureTest(
    "a shared writer continues their own PR at its head",
    async (f) => {
      const p = await apply(f.id, f.author, edit(f.base, "a.md", "a\n"));
      await prisma.kbShare.update({
        where: { kbId_userId: { kbId: f.id, userId: f.author } },
        data: { bits: ["propose", "write"] },
      });
      return { p };
    },
    async (f, { p }) => {
      const continued = await apply(f.id, f.author, edit(p.commitSha, "b.md", "b\n"));
      expect(continued).toMatchObject({ kind: "proposed", proposal: { number: 1 } });
      expect((await prRow(f.id)).headSha).toBe(continued.commitSha);
    },
  );
  prFixtureTest(
    "commits keep the system author and name who acted",
    async (f) => {
      const p = await apply(f.id, f.author, edit(f.base));
      return { p };
    },
    async (f, { p }) => {
      const proposal = runGit(f.repo, ["cat-file", "commit", p.commitSha]);
      expect(proposal).toContain("author knowledge-base <kb@example.invalid>");
      expect(commitMessage(f.repo, p.commitSha)).toBe("proposal\n\nActed-by: PR fixture via web");
      const main = await apply(f.id, f.owner, edit(f.base, "main.md", "main"));
      const merged = await mutate(f.reviewer, review(f.id, 1, p.commitSha, main.commitSha));
      expect(commitMessage(f.repo, merged.pr.mergeCommitSha!)).toBe(
        "Merge #1: proposal\n\nActed-by: PR fixture via web",
      );
      expect(proposal).not.toMatch(/@example\.invalid>.*\n\n.*@/s);
    },
  );
});

/** A PAT/OAuth principal of `userId` with `bits` on the KB, admitted by a fixed live grant. */
async function tokenOf(
  userId: string,
  kbId: string,
  bits: string[],
  kind: "PAT" | "OAUTH" = "PAT",
): Promise<{ principal: Principal; verifier: CredentialVerifier; grantId: string }> {
  const grantId = randomUUID();
  await prisma.mcpGrant.create({
    data: {
      id: grantId,
      actorUserIdSnapshot: userId,
      userId,
      kind,
      clientId: kind === "PAT" ? "pat" : "fixture-agent",
      referenceId: randomUUID(),
      scopes: ["mcp:read", "mcp:write"],
      toolGroups: ["read", "edit", "pull_requests"],
    },
  });
  const verifier: CredentialVerifier = {
    inspect: async () => ({
      generationActive: true,
      instanceEnabled: true,
      expired: false,
      banned: false,
      twoFactorSatisfied: true,
      toolGroups: ["read", "edit", "pull_requests"],
    }),
    grantBits: async () => bits,
  };
  return {
    grantId,
    verifier,
    principal: {
      kind: "token",
      userId,
      grantId,
      grantGeneration: "1",
      scopes: ["mcp:read", "mcp:write"],
      expiresAt: null,
      storedAcl: new Map([[kbId, bits]]),
    },
  };
}
async function applyAs(
  as: { principal: Principal; verifier?: CredentialVerifier },
  kbId: string,
  request: ChangesApplyRequest,
) {
  const publication = createChangesPublication({
    store,
    principal: as.principal,
    verifier: as.verifier,
    reposDir,
    kbId,
    idempotencyKey: randomUUID(),
    request,
    operation: "CHANGES_APPLY",
    requestHash: canonicalRequestHash(request),
    ratePort: createMemoryRatePort(),
  });
  return (await coordinator.run({
    opId: randomUUID(),
    kind: "git-write",
    kbIds: [kbId],
    barrier: publication.barrier,
    run: (ctx) => publication.publish(ctx.lease, executor),
  })) as ApplyResult;
}
function reviewAs(
  as: { principal: Principal; verifier?: CredentialVerifier },
  request: PrMutationRequest,
) {
  const publication = createPullRequestPublication({
    store,
    principal: as.principal,
    verifier: as.verifier,
    reposDir,
    request,
  });
  return coordinator.run({
    opId: randomUUID(),
    kind: "git-write",
    kbIds: [request.kbId],
    barrier: publication.barrier,
    run: (ctx) => publication.publish(ctx.lease, executor),
  });
}
/** What the browser document procedures run (`documents.update`). */
async function webUpdate(
  userId: string,
  kbId: string,
  baseRevision: string,
  path: string,
  body: string,
  proposal?: { number: number; headSha: string },
) {
  const request = {
    ...(proposal ? { proposalNumber: proposal.number, proposalHeadSha: proposal.headSha } : {}),
    operation: DOCUMENT_UPDATE_OPERATION,
    path,
    content: { markdown: body },
    idempotencyKey: randomUUID(),
  } as const;
  const publication = changesPublicationForDocument({
    store,
    principal: { kind: "browser", userId },
    reposDir,
    kbId,
    idempotencyKey: request.idempotencyKey,
    baseRevision,
    ...(proposal ? { proposalNumber: proposal.number, proposalHeadSha: proposal.headSha } : {}),
    request,
    ratePort: createMemoryRatePort(),
  });
  return (await coordinator.run({
    opId: randomUUID(),
    kind: "git-write",
    kbIds: [kbId],
    barrier: publication.barrier,
    run: (ctx) => publication.publish(ctx.lease, executor),
  })) as ApplyResult;
}

describe("every actor path selects the person's proposal", () => {
  prFixtureTest(
    "web, PAT and OAuth credentials of one person continue and close one PR; read-only and others cannot",
    async (f) => {
      const pat = await tokenOf(f.author, f.id, ["read", "propose"]);
      const oauth = await tokenOf(f.author, f.id, ["read", "propose"], "OAUTH");
      const readOnly = await tokenOf(f.author, f.id, ["read"]);
      const stranger = await user();
      await prisma.kbShare.create({ data: { kbId: f.id, userId: stranger.id, bits: ["propose"] } });
      const strangerPat = await tokenOf(stranger.id, f.id, ["read", "propose"]);
      const opened = await applyAs(pat, f.id, edit(f.base, "doc.md", "token text\n"));
      return { pat, oauth, readOnly, strangerPat, opened };
    },
    async (f, { pat, oauth, readOnly, strangerPat, opened }) => {
      expect(opened.proposal).toMatchObject({ number: 1, authorActorKey: `grant:${pat.grantId}` });
      // The web editor reading main is told about the token's open PR and its
      // version of the document (R3-W6: rewriting the PR's own path against
      // main needs its proposalNumber)...
      await expect(webUpdate(f.author, f.id, f.base, "doc.md", "web\n")).rejects.toMatchObject({
        code: "CONFLICT",
        details: {
          reason: "PROPOSAL_CONFLICT",
          headSha: f.base,
          proposalHeadSha: opened.commitSha,
          proposalNumber: 1,
          paths: [{ path: "doc.md", yours: "token text\n" }],
        },
      });
      // ...and explicitly choosing its observed head updates that PR.
      const web = await webUpdate(f.author, f.id, opened.commitSha, "doc.md", "web text\n", {
        number: 1,
        headSha: opened.commitSha,
      });
      expect(web.proposal).toMatchObject({ number: 1, status: "OPEN" });
      // Another credential of the same person has the same explicit consent rule.
      const viaOauth = await applyAs(oauth, f.id, {
        ...replace(web.commitSha, "doc.md", "oauth text\n"),
        proposalNumber: 1,
        proposalHeadSha: web.commitSha,
      });
      expect(viaOauth.proposal?.number).toBe(1);
      // A stranger's proposal is their own PR.
      const theirs = await applyAs(strangerPat, f.id, edit(f.base, "other.md", "x"));
      expect(theirs.proposal?.number).toBe(2);
      await expect(
        applyAs(strangerPat, f.id, {
          ...replace(viaOauth.commitSha, "doc.md", "y"),
          proposalNumber: 1,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      const close = review(f.id, 1, viaOauth.commitSha, f.base, "close");
      await expect(reviewAs(readOnly, close)).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(reviewAs(strangerPat, close)).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect((await reviewAs(oauth, close)).pr.status).toBe("CLOSED");
      expect(await prisma.pullRequest.count({ where: { kbId: f.id } })).toBe(2);
    },
  );
});

describe("no read or receipt presents an unchecked PR status", () => {
  prFixtureTest(
    "the requested PR, list pages and filters are checked beyond the first ten stale PRs",
    async (f) => {
      const doc = await apply(f.id, f.owner, edit(f.base, "shared.md", "one\n"));
      const authors: string[] = [];
      for (let n = 0; n < 12; n += 1) {
        const author = await user();
        await prisma.kbShare.create({ data: { kbId: f.id, userId: author.id, bits: ["propose"] } });
        authors.push(author.id);
        await apply(
          f.id,
          author.id,
          n === 11
            ? replace(doc.commitSha, "shared.md", "twelve\n")
            : edit(doc.commitSha, `own-${n}.md`, `${n}`),
        );
      }
      const main = await apply(f.id, f.owner, replace(doc.commitSha, "shared.md", "main\n"));
      return { main };
    },
    async (f, { main }) => {
      // #12 is the twelfth stale PR: opening it checks it directly.
      const twelve = await getPullRequest(prRead(f.reviewer), { kbId: f.id, number: 12 });
      expect(twelve.pr.status).toBe("CONFLICT");
      await db.query(
        "applier",
        `UPDATE pull_request SET "mergeCheckedSha" = NULL, "mergeCheckedKey" = NULL WHERE "kbId" = $1`,
        [f.id],
      );
      const { listPullRequests } = await import("@knowledge-base/api/lib/kb/pull-requests");
      const conflicted = await listPullRequests(prRead(f.reviewer), {
        kbId: f.id,
        status: "CONFLICT",
      });
      expect(conflicted.items.map((pr) => pr.number)).toEqual([12]);
      const open = await listPullRequests(prRead(f.reviewer), { kbId: f.id, status: "OPEN" });
      expect(open.items.map((pr) => pr.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
      expect(
        await prisma.pullRequest.count({ where: { kbId: f.id, mergeCheckedSha: main.commitSha } }),
      ).toBe(12);
    },
  );
  prFixtureTest(
    "an update stacked on a stale base reports the status it really has",
    async (f) => {
      const doc = await apply(f.id, f.owner, edit(f.base, "rate.md", "100\n"));
      const proposed = await apply(f.id, f.author, replace(doc.commitSha, "rate.md", "200\n"));
      await apply(f.id, f.owner, replace(doc.commitSha, "rate.md", "50\n"));
      return { proposed };
    },
    async (f, { proposed }) => {
      const stacked = await apply(f.id, f.author, edit(proposed.commitSha, "more.md", "more"));
      expect(stacked.proposal?.status).toBe("CONFLICT");
    },
  );
  prFixtureTest(
    "a clean text merge that breaks the tree (one id in two documents) is a conflict",
    async (f) => {
      const proposed = await apply(
        f.id,
        f.author,
        edit(f.base, "a.md", "---\nid: twin\n---\n# A\n"),
      );
      const main = await apply(f.id, f.owner, edit(f.base, "b.md", "---\nid: twin\n---\n# B\n"));
      return { proposed, main };
    },
    async (f, { proposed, main }) => {
      expect((await getPullRequest(prRead(f.reviewer), { kbId: f.id, number: 1 })).pr.status).toBe(
        "CONFLICT",
      );
      await expect(apply(f.id, f.author, edit(main.commitSha, "c.md", "c"))).rejects.toMatchObject({
        code: "CONFLICT",
        details: { reason: "PROPOSAL_CONFLICT" },
      });
      expect(readRefSha(f.repo, "refs/heads/pr/1")).toBe(proposed.commitSha);
    },
  );
});

describe("uniform overwrite consent", () => {
  prFixtureTest(
    "a PR head as base cannot replace either explicit selector",
    async (f) => ({ p: await apply(f.id, f.author, edit(f.base, "a.md", "proposal")) }),
    async (f, { p }) => {
      for (const selectors of [
        {},
        { proposalNumber: 1, proposalHeadSha: undefined },
        { proposalHeadSha: p.commitSha },
      ]) {
        await expect(
          apply(f.id, f.author, {
            ...replace(p.commitSha, "a.md", "overwrite"),
            ...selectors,
          }),
        ).rejects.toMatchObject({ code: "CONFLICT", details: { reason: "PROPOSAL_CONFLICT" } });
      }
      expect(readRefSha(f.repo, "refs/heads/pr/1")).toBe(p.commitSha);
      const result = await apply(f.id, f.author, {
        ...replace(p.commitSha, "a.md", "chosen"),
        proposalNumber: 1,
        proposalHeadSha: p.commitSha,
      });
      expect(result.kind).toBe("proposed");
    },
  );
});

describe("a slower status check never overwrites a newer one", () => {
  prFixtureTest(
    "check A (old main) finishes after main moved and check B stored CONFLICT",
    async (f) => {
      const doc = await apply(f.id, f.owner, edit(f.base, "rate.md", "100\n"));
      await apply(f.id, f.author, replace(doc.commitSha, "rate.md", "200\n"));
      await db.query(
        "applier",
        `UPDATE pull_request SET "mergeCheckedSha" = NULL, "mergeCheckedEpoch" = NULL, "mergeCheckedKey" = NULL WHERE "kbId" = $1`,
        [f.id],
      );
      return { doc };
    },
    async (f, { doc }) => {
      const { refreshPrMergeability } = await import("@knowledge-base/api/lib/kb/pull-requests");
      const read = { query: prismaAssetQuery(prisma), reposDir };
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let computed!: () => void;
      const reached = new Promise<void>((resolve) => {
        computed = resolve;
      });
      const a = refreshPrMergeability(read, { kbId: f.id, number: 1 }, 1, new Set(), async () => {
        computed();
        await held;
      });
      await reached;
      // Main moves into a clash; a fresh check records it.
      await apply(f.id, f.owner, replace(doc.commitSha, "rate.md", "50\n"));
      await refreshPrMergeability(read, { kbId: f.id, number: 1 });
      expect((await prRow(f.id)).status).toBe("CONFLICT");
      release();
      await a;
      const row = await prRow(f.id);
      expect(row.status).toBe("CONFLICT");
      expect(row.mergeCheckedSha).toBe(readHeadSha(f.repo));
    },
  );
});

describe("a failing status check is logged, not silent (R3-W3)", () => {
  prFixtureTest(
    "an unreadable head keeps the cached status and logs the failure with its PR",
    async (f) => {
      const doc = await apply(f.id, f.owner, edit(f.base, "rate.md", "100\n"));
      await apply(f.id, f.author, replace(doc.commitSha, "rate.md", "200\n"));
      await db.query(
        "applier",
        `UPDATE pull_request SET "mergeCheckedSha" = NULL, "mergeCheckedEpoch" = NULL, "headSha" = $2 WHERE "kbId" = $1`,
        [f.id, "f".repeat(40)],
      );
      return {};
    },
    async (f) => {
      const { refreshPrMergeability } = await import("@knowledge-base/api/lib/kb/pull-requests");
      const logged = captureLog();
      try {
        const result = await refreshPrMergeability(
          { query: prismaAssetQuery(prisma), reposDir },
          { kbId: f.id, number: 1 },
        );
        expect(result.failed).toEqual([1]);
        const records = logged.records.filter((record) => record.site === "pr-mergeability");
        expect(records).toHaveLength(1);
        // The fixed record only: site, ids, class/code, the process-lifetime count.
        expect(records[0]).toMatchObject({
          level: "error",
          message: "pull request mergeability refresh failed",
          kbId: f.id,
          pr: 1,
          failures: expect.any(Number),
        });
        expect(
          Object.keys(records[0]!).every((key) =>
            [
              "level",
              "site",
              "message",
              "errorClass",
              "errorCode",
              "kbId",
              "pr",
              "failures",
            ].includes(key),
          ),
        ).toBe(true);
        expect((await prRow(f.id)).mergeCheckedSha).toBeNull();
      } finally {
        logged.restore();
      }
    },
  );
});

describe("one verified snapshot: status, head and target agree", () => {
  prFixtureTest(
    "a check that finishes after main moved recomputes, with no second checker",
    async (f) => {
      const doc = await apply(f.id, f.owner, edit(f.base, "rate.md", "100\n"));
      await apply(f.id, f.author, replace(doc.commitSha, "rate.md", "200\n"));
      await db.query(
        "applier",
        `UPDATE pull_request SET "mergeCheckedSha" = NULL, "mergeCheckedEpoch" = NULL, "mergeCheckedKey" = NULL WHERE "kbId" = $1`,
        [f.id],
      );
      return { doc };
    },
    async (f, { doc }) => {
      const { refreshPrMergeability } = await import("@knowledge-base/api/lib/kb/pull-requests");
      const read = { query: prismaAssetQuery(prisma), reposDir };
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let computed!: () => void;
      const reached = new Promise<void>((resolve) => {
        computed = resolve;
      });
      let calls = 0;
      const a = refreshPrMergeability(read, { kbId: f.id, number: 1 }, 1, new Set(), async () => {
        calls += 1;
        if (calls > 1) return;
        computed();
        await held;
      });
      await reached;
      const moved = await apply(f.id, f.owner, replace(doc.commitSha, "rate.md", "50\n"));
      release();
      await a;
      expect(calls).toBe(2);
      expect(await prRow(f.id)).toMatchObject({
        status: "CONFLICT",
        mergeCheckedSha: moved.commitSha,
      });
      const view = await getPullRequest(prRead(f.reviewer), { kbId: f.id, number: 1 });
      expect(view.pr).toMatchObject({ status: "CONFLICT", targetSha: moved.commitSha });
      const { listPullRequests } = await import("@knowledge-base/api/lib/kb/pull-requests");
      const [listed] = (await listPullRequests(prRead(f.reviewer), { kbId: f.id })).items;
      expect(listed).toMatchObject({ status: "CONFLICT", targetSha: moved.commitSha });
    },
  );
});

describe("every resolution is valid on a conflicted path", () => {
  const scenarios = {
    "main modifies, PR deletes": {
      pr: (base: string) => ({
        ...edit(base, "d.md"),
        changes: [{ op: "delete" as const, path: "d.md" }],
      }),
      main: (base: string) => replace(base, "d.md", "main\n"),
      path: "d.md",
    },
    "main deletes, PR modifies": {
      pr: (base: string) => replace(base, "d.md", "proposal\n"),
      main: (base: string) => ({
        ...edit(base, "d.md"),
        changes: [{ op: "delete" as const, path: "d.md" }],
      }),
      path: "d.md",
    },
    "both add": {
      pr: (base: string) => edit(base, "n.md", "proposal\n"),
      main: (base: string) => edit(base, "n.md", "main\n"),
      path: "n.md",
    },
  };
  // Independent KB scenarios own independent test lifetimes. Every product
  // mutation and each resolution test retain the existing 30-second deadline.
  for (const [name, scenario] of Object.entries(scenarios))
    for (const op of ["delete", "replace", "create"] as const)
      prFixtureTest(
        `${name} / ${op}`,
        async (f) => {
          const doc = await apply(f.id, f.owner, edit(f.base, "d.md", "base\n"));
          await apply(f.id, f.author, scenario.pr(doc.commitSha));
          const main = await apply(f.id, f.owner, scenario.main(doc.commitSha));
          return { main };
        },
        async (f, { main }) => {
          expect(
            (await getPullRequest(prRead(f.reviewer), { kbId: f.id, number: 1 })).pr.status,
          ).toBe("CONFLICT");
          const change =
            op === "delete"
              ? { op, path: scenario.path }
              : { op, path: scenario.path, content: { markdown: "chosen\n" } };
          const resolved = await apply(f.id, f.author, {
            ...edit(main.commitSha, scenario.path),
            changes: [change],
            proposalNumber: 1,
          });
          expect(resolved.proposal).toMatchObject({
            number: 1,
            status: "OPEN",
            targetSha: main.commitSha,
          });
          const files = runGit(f.repo, ["ls-tree", "-r", "--name-only", resolved.commitSha]);
          if (op === "delete") expect(files.split("\n")).not.toContain(scenario.path);
          else
            expect(runGit(f.repo, ["show", `${resolved.commitSha}:${scenario.path}`])).toBe(
              "chosen",
            );
        },
      );
  prFixtureTest(
    "outside a conflict the ordinary missing-path error remains",
    async (f) => {
      await apply(f.id, f.author, edit(f.base, "a.md", "a"));
      return apply(f.id, f.owner, edit(f.base, "b.md", "b"));
    },
    async (f, main) => {
      await expect(
        apply(f.id, f.author, {
          ...edit(main.commitSha, "x.md"),
          changes: [{ op: "delete", path: "missing.md" }],
          proposalNumber: 1,
        }),
      ).rejects.toMatchObject({ code: "INVALID_ARGUMENT", details: { reason: "PATH_NOT_FOUND" } });
    },
  );
});

describe("progressive, typed conflict resolution", () => {
  const doc = (n: number) => `doc-${n}.md`;
  const writeAll = async (
    f: Awaited<ReturnType<typeof setup>>,
    userId: string,
    base: string,
    numbers: number[],
    body: (n: number) => string,
    op: "create" | "replace",
  ) => {
    let head = base;
    for (let i = 0; i < numbers.length; i += 8) {
      const result = await apply(f.id, userId, {
        ...edit(head, "x.md"),
        changes: numbers
          .slice(i, i + 8)
          .map((n) => ({ op, path: doc(n), content: { markdown: body(n) } })),
      });
      head = result.commitSha;
    }
    return head;
  };
  const resolve = (base: string, numbers: number[]) => ({
    ...edit(base, "x.md"),
    changes: numbers.map((n) => ({
      op: "replace" as const,
      path: doc(n),
      content: { markdown: `chosen ${n}\n` },
    })),
    proposalNumber: 1,
  });
  const nine = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  prFixtureTest(
    "nine conflicts resolve over several requests, across a main move, then merge",
    async (f) => {
      const seeded = await writeAll(f, f.owner, f.base, nine, (n) => `base ${n}\n`, "create");
      await writeAll(f, f.author, seeded, nine, (n) => `proposal ${n}\n`, "replace");
      const main = await writeAll(f, f.owner, seeded, nine, (n) => `main ${n}\n`, "replace");
      return { main };
    },
    async (f, { main }) => {
      const status = async () =>
        (await getPullRequest(prRead(f.reviewer), { kbId: f.id, number: 1 })).pr;
      expect((await status()).status).toBe("CONFLICT");
      // A wrong-kind operation resolves nothing.
      await expect(
        apply(f.id, f.author, {
          ...edit(main, "x.md"),
          changes: [{ op: "assetRemove", path: doc(1) }],
          proposalNumber: 1,
        }),
      ).rejects.toMatchObject({ code: "CONFLICT", details: { reason: "PROPOSAL_CONFLICT" } });
      // Eight now: the PR moves onto main and stays CONFLICT on the ninth.
      const first = await apply(f.id, f.author, resolve(main, [1, 2, 3, 4, 5, 6, 7, 8]));
      expect(first.proposal).toMatchObject({ number: 1, status: "CONFLICT", baseSha: main });
      expect(runGit(f.repo, ["rev-parse", `${first.commitSha}^`])).toBe(main);
      // No merge marker anywhere on the published branch.
      for (const n of nine)
        expect(runGit(f.repo, ["show", `${first.commitSha}:${doc(n)}`])).not.toContain("<<<<<<<");
      expect(runGit(f.repo, ["show", `${first.commitSha}:${doc(9)}`])).toBe("proposal 9");
      await expect(
        mutate(f.reviewer, review(f.id, 1, first.commitSha, main)),
      ).rejects.toMatchObject({ code: "CONFLICT", conflict: { kind: "content_conflict" } });
      // Main moves again and clashes with a resolution already made.
      const moved = await apply(f.id, f.owner, replace(main, doc(1), "main again\n"));
      const second = await apply(f.id, f.author, resolve(moved.commitSha, [9]));
      expect(second.proposal).toMatchObject({ status: "CONFLICT", baseSha: moved.commitSha });
      expect(runGit(f.repo, ["show", `${second.commitSha}:${doc(1)}`])).toBe("chosen 1");
      // Keeping the version the PR already holds is a resolution too.
      const done = await apply(f.id, f.author, resolve(moved.commitSha, [1]));
      expect(done.kind).toBe("proposed");
      expect(done.proposal).toMatchObject({ status: "OPEN", targetSha: moved.commitSha });
      for (const n of nine)
        expect(runGit(f.repo, ["show", `${done.commitSha}:${doc(n)}`])).toBe(`chosen ${n}`);
      const merged = await mutate(f.reviewer, review(f.id, 1, done.commitSha, moved.commitSha));
      expect(merged.pr.status).toBe("MERGED");
    },
  );
  prFixtureTest(
    "later diff pages keep the first page's head, target and status",
    async (f) => {
      const p = await apply(f.id, f.author, {
        ...edit(f.base),
        changes: [
          { op: "create", path: "a.md", content: { markdown: "a" } },
          { op: "create", path: "b.md", content: { markdown: "b" } },
        ],
      });
      const first = await getPullRequest(prRead(f.reviewer), {
        kbId: f.id,
        number: 1,
        page: { limit: 1 },
      });
      // Source and main both advance; main now clashes with the PR.
      await apply(f.id, f.author, edit(p.commitSha, "z.md"));
      await apply(f.id, f.owner, edit(f.base, "a.md", "main a"));
      return { p, first };
    },
    async (f, { p, first }) => {
      expect(first.pr).toMatchObject({ status: "OPEN", headSha: p.commitSha, targetSha: f.base });
      const second = await getPullRequest(prRead(f.reviewer), {
        kbId: f.id,
        number: 1,
        page: { limit: 1, cursor: first.nextCursor },
      });
      expect(second.pr).toMatchObject({ status: "OPEN", headSha: p.commitSha, targetSha: f.base });
      const fresh = await getPullRequest(prRead(f.reviewer), { kbId: f.id, number: 1 });
      expect(fresh.pr.status).toBe("CONFLICT");
      expect(fresh.pr.headSha).not.toBe(p.commitSha);
    },
  );
});

describe("structural conflicts on real logical paths", () => {
  const idDoc = (n: number, side: string) => `---\nid: key-${n}\n---\n# ${side} ${n}\n`;
  const batch = (
    base: string,
    changes: Array<{ op: "create" | "replace" | "delete"; path: string; body?: string }>,
  ) => ({
    ...edit(base, "x.md"),
    changes: changes.map((c) =>
      c.op === "delete"
        ? { op: c.op, path: c.path }
        : { op: c.op, path: c.path, content: { markdown: c.body! } },
    ),
  });
  prFixtureTest(
    "nine duplicated document ids are nine resolvable conflicts",
    async (f) => {
      const nine = Array.from({ length: 9 }, (_, n) => n);
      const first = await apply(
        f.id,
        f.author,
        batch(
          f.base,
          nine
            .slice(0, 8)
            .map((n) => ({ op: "create", path: `pr/b${n}.md`, body: idDoc(n, "pr") })),
        ),
      );
      await apply(
        f.id,
        f.author,
        batch(first.commitSha, [{ op: "create", path: "pr/b8.md", body: idDoc(8, "pr") }]),
      );
      const m1 = await apply(
        f.id,
        f.owner,
        batch(
          f.base,
          nine
            .slice(0, 8)
            .map((n) => ({ op: "create", path: `main/m${n}.md`, body: idDoc(n, "main") })),
        ),
      );
      const main = await apply(
        f.id,
        f.owner,
        batch(m1.commitSha, [{ op: "create", path: "main/m8.md", body: idDoc(8, "main") }]),
      );
      return { main: main.commitSha };
    },
    async (f, { main }) => {
      await expect(apply(f.id, f.author, edit(main, "unrelated.md"))).rejects.toMatchObject({
        code: "CONFLICT",
        details: {
          reason: "PROPOSAL_CONFLICT",
          // Main's holders of each id are reported too: they stand in the way
          // of restoring the PR's documents as they were.
          paths: [
            ...Array.from({ length: 9 }, (_, n) =>
              expect.objectContaining({ path: `main/m${n}.md` }),
            ),
            ...Array.from({ length: 9 }, (_, n) =>
              expect.objectContaining({ path: `pr/b${n}.md` }),
            ),
          ],
        },
      });
      const renamed = (ns: number[]) => ({
        ...batch(
          main,
          ns.map((n) => ({
            op: "replace",
            path: `pr/b${n}.md`,
            body: `---\nid: pr-${n}\n---\n# pr ${n}\n`,
          })),
        ),
        proposalNumber: 1,
      });
      const step = await apply(f.id, f.author, renamed([0, 1, 2, 3, 4, 5, 6, 7]));
      expect(step.proposal).toMatchObject({ status: "CONFLICT", baseSha: main });
      // Resolving the last of the PR's own conflicts settles main's standing entries.
      const done = await apply(f.id, f.author, renamed([8]));
      expect(done.proposal).toMatchObject({ status: "OPEN", targetSha: main });
      expect((await mutate(f.reviewer, review(f.id, 1, done.commitSha, main))).pr.status).toBe(
        "MERGED",
      );
    },
  );
  for (const orientation of ["directory on the PR", "file on the PR"] as const)
    prFixtureTest(
      `file-vs-directory, ${orientation}: the real path conflicts and deleting it resolves`,
      async (f) => {
        const [prPath, mainPath] =
          orientation === "directory on the PR"
            ? ["foo.md/bar.md", "foo.md"]
            : ["foo.md", "foo.md/bar.md"];
        await apply(f.id, f.author, edit(f.base, prPath, "pr\n"));
        const main = await apply(f.id, f.owner, edit(f.base, mainPath, "main\n"));
        return { prPath, main: main.commitSha };
      },
      async (f, { prPath, main }) => {
        expect(
          (await getPullRequest(prRead(f.reviewer), { kbId: f.id, number: 1 })).pr.status,
        ).toBe("CONFLICT");
        await expect(apply(f.id, f.author, edit(main, "unrelated.md"))).rejects.toMatchObject({
          code: "CONFLICT",
          details: {
            // Both sides of the clash; main's side stands in the way.
            paths: ["foo.md", "foo.md/bar.md"].map((path) =>
              expect.objectContaining(path === prPath ? { path, yours: "pr\n" } : { path }),
            ),
          },
        });
        const resolved = await apply(f.id, f.author, {
          ...batch(main, [{ op: "delete", path: prPath }]),
          proposalNumber: 1,
        });
        expect(resolved.proposal).toMatchObject({ status: "OPEN", targetSha: main });
      },
    );
});

describe("recorded conflict versions stay reachable and readable", () => {
  prFixtureTest(
    "after a partial resolution, omitted large versions are read at their exact revisions",
    async (f) => {
      const big = (n: number) => `---\nid: big-${n}\n---\n# big ${n}\n\n${"x".repeat(100_000)}\n`;
      await apply(f.id, f.author, {
        ...edit(f.base, "x.md"),
        changes: [0, 1, 2, 3].map((n) => ({
          op: "create" as const,
          path: `pr/big${n}.md`,
          content: { markdown: big(n) },
        })),
      });
      const main = await apply(f.id, f.owner, {
        ...edit(f.base, "x.md"),
        changes: [0, 1, 2, 3].map((n) => ({
          op: "create" as const,
          path: `main/m${n}.md`,
          content: { markdown: `---\nid: big-${n}\n---\n# main ${n}\n` },
        })),
      });
      return { main: main.commitSha, big };
    },
    async (f, { main, big }) => {
      const step = await apply(f.id, f.author, {
        ...edit(main, "x.md"),
        changes: [
          {
            op: "replace",
            path: "pr/big0.md",
            content: { markdown: "---\nid: mine-0\n---\n# 0\n" },
          },
        ],
        proposalNumber: 1,
      });
      expect(step.proposal).toMatchObject({ status: "CONFLICT", baseSha: main });
      // The moved head keeps the proposal's previous head as a second parent.
      const parents = runGit(f.repo, ["rev-list", "--parents", "-n", "1", step.commitSha]).split(
        " ",
      );
      expect(parents.slice(1)).toHaveLength(2);
      const refused = await apply(f.id, f.author, edit(main, "unrelated.md")).catch(
        (e: unknown) => e,
      );
      const details = (
        refused as { details: { contentIncluded: boolean; paths: Array<Record<string, unknown>> } }
      ).details;
      expect(details.contentIncluded).toBe(false);
      // Main's holders of the ids stay reported until the PR's own are resolved.
      expect(details.paths.map((p) => p.path)).toEqual([
        "main/m0.md",
        "main/m1.md",
        "main/m2.md",
        "main/m3.md",
        "pr/big1.md",
        "pr/big2.md",
        "pr/big3.md",
      ]);
      for (const [n, entry] of details.paths.slice(4).entries()) {
        expect(entry).toMatchObject({ kind: "document", yours: null, theirsSha: main });
        // documents_get reads it at the exact revision, though the branch has moved on.
        const doc = await readDocumentAtRevision({
          reposDir,
          kbId: f.id,
          commitSha: entry.yoursSha as string,
          path: entry.path as string,
        });
        expect(doc.markdown).toBe(big(n + 1));
      }
      // The PR view still reads, with the recorded state.
      expect((await getPullRequest(prRead(f.reviewer), { kbId: f.id, number: 1 })).pr.status).toBe(
        "CONFLICT",
      );
    },
  );
});

describe("one request lifetime for every recheck batch", () => {
  prFixtureTest(
    "list rechecks stop on cancellation between batches and at the pinned deadline",
    async (f) => {
      const doc = await apply(f.id, f.owner, edit(f.base, "shared.md", "one\n"));
      for (let n = 0; n < 12; n += 1) {
        const author = await user();
        await prisma.kbShare.create({ data: { kbId: f.id, userId: author.id, bits: ["propose"] } });
        await apply(f.id, author.id, edit(doc.commitSha, `own-${n}.md`, `${n}`));
      }
      await apply(f.id, f.owner, edit(doc.commitSha, "main.md", "main\n"));
      return null;
    },
    async (f) => {
      const { listPullRequests } = await import("@knowledge-base/api/lib/kb/pull-requests");
      const stale = () =>
        prisma.pullRequest.count({
          where: {
            kbId: f.id,
            OR: [{ mergeCheckedSha: null }, { NOT: { mergeCheckedSha: readHeadSha(f.repo) } }],
          },
        });
      const reset = () =>
        db.query(
          "applier",
          `UPDATE pull_request SET "mergeCheckedSha" = NULL, "mergeCheckedEpoch" = NULL, "mergeCheckedKey" = NULL WHERE "kbId" = $1`,
          [f.id],
        );
      // Each stored status runs `hook`, after the batch's first store.
      const watched = (hook: () => Promise<void> | void) => {
        const base = prismaAssetQuery(prisma);
        let stores = 0;
        const query = (async <R>(sql: string, params?: unknown[]) => {
          const result = await base<R>(sql, params);
          if (/UPDATE pull_request\s+SET status=/.test(sql)) {
            stores += 1;
            if (stores === 1) await hook();
          }
          return result;
        }) as typeof base;
        return { ...prRead(f.reviewer), query };
      };
      await reset();
      const abort = new AbortController();
      await expect(
        listPullRequests({ ...watched(() => abort.abort()), signal: abort.signal }, { kbId: f.id }),
      ).rejects.toThrow();
      // The first batch's later checks and every later batch were not run.
      expect(await stale()).toBeGreaterThan(1);
      await reset();
      // One deadline for the whole call: it lapses during the first batch.
      const deadlineAt = Date.now() + 3000;
      await expect(
        listPullRequests(
          {
            ...watched(async () => {
              await new Promise((resolve) =>
                setTimeout(resolve, Math.max(0, deadlineAt - Date.now()) + 50),
              );
            }),
            deadlineAt,
          },
          { kbId: f.id },
        ),
      ).rejects.toMatchObject({ code: "DEADLINE_EXCEEDED" });
      expect(await stale()).toBeGreaterThan(1);
      // Rechecks start only in the first two thirds of the read's time: past
      // that, the page ends before the first unchecked PR with a cursor.
      await reset();
      const shortAt = Date.now() + 6000;
      const short = await listPullRequests(
        {
          ...watched(async () => {
            const share = Date.now() + ((shortAt - Date.now()) * 2) / 3;
            await new Promise((resolve) =>
              setTimeout(resolve, Math.max(0, share - Date.now()) + 50),
            );
          }),
          deadlineAt: shortAt,
        },
        { kbId: f.id },
      );
      expect(short.items.map((pr) => pr.number)).toEqual([1]);
      expect(short.nextCursor).not.toBeNull();
      expect(await stale()).toBe(11);
      const rest = await listPullRequests(prRead(f.reviewer), {
        kbId: f.id,
        cursor: short.nextCursor,
      });
      expect(rest.items.map((pr) => pr.number)).toEqual(
        Array.from({ length: 11 }, (_, n) => n + 2),
      );
      // Without either, the whole list is checked.
      await reset();
      expect((await listPullRequests(prRead(f.reviewer), { kbId: f.id })).items).toHaveLength(12);
      expect(await stale()).toBe(0);
    },
  );
});

describe("near-limit KBs with distinct subtrees stay within the deadlines", () => {
  prFixtureTest(
    "edits, rechecks, an update onto main and a merge on ~4,000 distinct directories",
    async (f) => {
      // Main at the limits: every directory a distinct tree object.
      const big = await writeFixtureCommit(f.repo, f.base, nearLimitDistinctFiles(), "loose seed", {
        loose: true,
      });
      runGit(f.repo, ["update-ref", "refs/heads/main", big, f.base]);
      await prisma.knowledgeBase.update({ where: { id: f.id }, data: { headSha: big } });
      const second = await user();
      await prisma.kbShare.create({ data: { kbId: f.id, userId: second.id, bits: ["propose"] } });
      return { big, second: second.id };
    },
    async (f, { big, second }) => {
      const actions = [
        "first proposal",
        "second proposal",
        "main update",
        "detail refresh",
        "list refresh",
        "proposal rebase",
        "reviewed merge",
      ];
      let nextAction = 0;
      const timed = async <T>(work: () => Promise<T>, withinMs: number): Promise<T> => {
        const action = actions[nextAction++];
        const started = Date.now();
        let result: T;
        try {
          result = await work();
        } catch (cause) {
          throw new Error(`${action} failed after ${Date.now() - started} ms`, { cause });
        }
        expect(Date.now() - started, action).toBeLessThan(withinMs);
        return result;
      };
      // Real edits, each inside the 30s mutation deadline (bounded below it, also under load).
      const p1 = await timed(
        () => apply(f.id, f.author, replace(big, "g7/d3/n.md", "# edited\n")),
        25_000,
      );
      expect(p1.proposal?.number).toBe(1);
      const p2 = await timed(() => apply(f.id, second, edit(big, "g8/d2/extra.md", "x\n")), 25_000);
      expect(p2.proposal?.number).toBe(2);
      const main = await timed(
        () => apply(f.id, f.owner, edit(big, "g9/d1/main.md", "main\n")),
        25_000,
      );
      expect(main.kind).toBe("applied");
      // View and list recheck the moved main well inside the read deadline.
      const viewed = await timed(
        () => getPullRequest(prRead(f.reviewer), { kbId: f.id, number: 1 }),
        25_000,
      );
      expect(viewed.pr.status).toBe("OPEN");
      const { listPullRequests } = await import("@knowledge-base/api/lib/kb/pull-requests");
      const listed = await timed(
        () => listPullRequests(prRead(f.reviewer), { kbId: f.id }),
        20_000,
      );
      expect(listed.items.map((pr) => [pr.number, pr.status])).toEqual([
        [1, "OPEN"],
        [2, "OPEN"],
      ]);
      expect(listed.nextCursor).toBeNull();
      // The update flow: a further edit against main moves the PR onto main.
      const moved = await timed(
        () => apply(f.id, f.author, edit(main.commitSha, "g7/d4/more.md", "more\n")),
        25_000,
      );
      expect(moved.proposal?.number).toBe(1);
      expect(runGit(f.repo, ["rev-parse", `${moved.commitSha}^`])).toBe(main.commitSha);
      expect(runGit(f.repo, ["show", `${moved.commitSha}:g7/d3/n.md`])).toBe("# edited");
      // The reviewed merge plans and publishes inside its mutation deadline.
      const merged = await timed(
        () => mutate(f.reviewer, review(f.id, 1, moved.commitSha, main.commitSha)),
        25_000,
      );
      expect(merged.pr.status).toBe("MERGED");
    },
    // Six actions in sequence; each is asserted well inside its own deadline.
    120_000,
  );
});

describe("diff cursors pin the base too", () => {
  prFixtureTest(
    "a page cursor from before the PR moved onto main keeps its snapshot",
    async (f) => {
      const first = await apply(f.id, f.author, {
        ...edit(f.base, "a.md", "a\n"),
        changes: [
          { op: "create", path: "a.md", content: { markdown: "a\n" } },
          { op: "create", path: "b.md", content: { markdown: "b\n" } },
        ],
      });
      const main = await apply(f.id, f.owner, edit(f.base, "main.md", "main\n"));
      return { first, main };
    },
    async (f, { first, main }) => {
      const page1 = await detail(f.reviewer, f.id);
      expect(page1.files.map((file) => file.path)).toEqual(["a.md"]);
      expect(page1.nextCursor).not.toBeNull();
      // The PR moves onto main: new base, new head.
      const moved = await apply(f.id, f.author, edit(main.commitSha, "c.md", "c\n"));
      expect((await prRow(f.id)).baseSha).toBe(main.commitSha);
      const page2 = await detail(f.reviewer, f.id, page1.nextCursor);
      expect(page2.files.map((file) => file.path)).toEqual(["b.md"]);
      expect(page2.pr).toMatchObject({ baseSha: f.base, headSha: first.commitSha });
      expect(moved.commitSha).not.toBe(first.commitSha);
    },
  );
});
