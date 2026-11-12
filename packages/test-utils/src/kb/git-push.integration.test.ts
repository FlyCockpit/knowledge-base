import { execFile, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmod, copyFile, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { prismaAssetQuery } from "@knowledge-base/api/lib/kb/asset-authz";
import { remoteSealedNamespace } from "@knowledge-base/api/lib/kb/attachment";
import { embeddingFingerprint } from "@knowledge-base/api/lib/kb/fingerprint";
import { hardenedGitEnv, kbBareRepoPath } from "@knowledge-base/api/lib/kb/git-read";
import { createMemoryRatePort, type RatePort } from "@knowledge-base/api/lib/kb/limits";
import type { LockQuery } from "@knowledge-base/api/lib/kb/lock";
import type { LiveAuthorityStore } from "@knowledge-base/api/lib/kb/permissions";
import { prismaAuthorityStore } from "@knowledge-base/api/lib/kb/permissions";
import type { CredentialVerifier, TokenPrincipal } from "@knowledge-base/api/lib/kb/principal";
import { setKbRecoveryComplete } from "@knowledge-base/api/lib/kb/recovery";
import { digestPatSecret, generatePatSecret } from "@knowledge-base/api/lib/mcp-token-access";
import type { Hono } from "hono";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildArtifactPath, requireBuiltArtifact } from "./build-artifacts.mjs";
import { dockerFixtureLabels, drainDockerFixtures, withDockerContainer } from "./docker.js";
import { NODE_BASE_IMAGE } from "./node-image.mjs";

const pendingGitPushActions = new Set<Promise<void>>();
function runOwnedGitPushAction(run: () => Promise<void>): Promise<void> {
  const action = Promise.resolve().then(run);
  const settled = action
    .then(
      () => {},
      () => {},
    )
    .finally(() => pendingGitPushActions.delete(settled));
  pendingGitPushActions.add(settled);
  return action;
}
async function drainGitPushActions(): Promise<void> {
  while (pendingGitPushActions.size) await Promise.all([...pendingGitPushActions]);
}
afterEach(async () => {
  await drainGitPushActions();
  await drainDockerFixtures();
}, 300_000);

import { openKbPostgresClusterFromEnv } from "./postgres";

type Actor = { principal: TokenPrincipal; verifier: CredentialVerifier; recheck(): Promise<void> };
const { createGitHttp } = (await import(
  new URL("../../../../apps/server/src/git-http.ts", import.meta.url).href
)) as {
  createGitHttp(options: {
    reposDir: string;
    admit(request: Request): Promise<Actor>;
    store: LiveAuthorityStore;
    retainedRefs(id: string): Promise<string[]>;
    push?: {
      connectionString: string;
      canonicalOrigin: string;
      ratePort: RatePort;
      barrier?: Record<string, () => Promise<void>>;
    };
  }): { app: Hono; close(): Promise<void> };
};
const { createBearerAdmission } = (await import(
  new URL("../../../../apps/server/src/mcp/auth.ts", import.meta.url).href
)) as {
  createBearerAdmission(options: {
    query: LockQuery;
    origin: string;
  }): (request: Request) => Promise<Actor>;
};
const { serve } = (await import(
  new URL("../../../../apps/server/node_modules/@hono/node-server/dist/index.mjs", import.meta.url)
    .href
)) as {
  serve(
    options: { fetch: Hono["fetch"]; hostname: string; port: number },
    callback: (info: { port: number }) => void,
  ): Server;
};
const cluster = await openKbPostgresClusterFromEnv();
const db = await cluster.createDatabase();
db.applyPrismaSchema();
const prisma = db.createPrismaClient();
const reposDir = join(process.env.KB_DATA_ROOT!, "repos");
const id = "b123456789012345678901234";
const repo = kbBareRepoPath(reposDir, id);
const clone = join(reposDir, "push-source");
const token = generatePatSecret();
const tokenId = "a234567890123456789012345";
const grantId = randomUUID();
let first = "";
let url = "";
let onReserved: (() => Promise<void>) | undefined;
let server: Server;
let endpoint: ReturnType<typeof createGitHttp>;
const git = (args: string[], cwd = clone) =>
  execFileSync("git", args, {
    cwd,
    env: hardenedGitEnv(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const client = promisify(execFile);
const auth = () => `Basic ${Buffer.from(`ignored:${token.secret}`).toString("base64")}`;
async function remote(args: string[]) {
  return client("git", ["-c", `http.extraHeader=Authorization: ${auth()}`, ...args], {
    cwd: reposDir,
    env: hardenedGitEnv(),
    // ReceivePush owns a 60s product deadline. This watchdog also covers
    // discovery/client scheduling and must not abort a valid admitted push.
    timeout: 90_000,
    maxBuffer: 1024 * 1024,
  });
}
function object(type: string, input: string) {
  return execFileSync("git", ["hash-object", "-w", "--stdin", "-t", type], {
    cwd: clone,
    env: hardenedGitEnv(),
    input,
    encoding: "utf8",
  }).trim();
}
function tree(
  body = "# valid\n",
  manifest = '{"version":1,"entries":[]}\n',
  documents: Record<string, string> = {},
) {
  const blob = (text: string) => object("blob", text);
  const subtree = execFileSync("git", ["mktree"], {
    cwd: clone,
    env: hardenedGitEnv(),
    input: `100644 blob ${blob(manifest)}\tmanifest.json\n`,
    encoding: "utf8",
  }).trim();
  return execFileSync("git", ["mktree"], {
    cwd: clone,
    env: hardenedGitEnv(),
    input: `040000 tree ${subtree}\t.assets\n100644 blob ${blob("# kb managed\n")}\t.gitignore\n100644 blob ${blob(body)}\tindex.md\n${Object.entries(
      documents,
    )
      .map(([path, text]) => `100644 blob ${blob(text)}\t${path}\n`)
      .join("")}`,
    encoding: "utf8",
  }).trim();
}
function commit(message: string, parent?: string, content = tree()) {
  return git(["commit-tree", content, ...(parent ? ["-p", parent] : []), "-m", message]);
}
const current = () => git(["rev-parse", "refs/heads/main"], repo);
const push = (...refs: string[]) => remote(["-C", clone, "push", url, ...refs]);
beforeAll(async () => {
  await mkdir(clone);
  git(["init", "--bare", "--initial-branch=main"]);
  first = commit("first");
  git(["update-ref", "refs/heads/main", first]);
  git(["clone", "--bare", clone, repo]);
  setKbRecoveryComplete(true);
  const owner = await prisma.user.create({
    data: { name: "Git test", email: `${randomUUID()}@example.invalid`, twoFactorEnabled: true },
  });
  await prisma.knowledgeBase.create({
    data: {
      id,
      ownerId: owner.id,
      name: "Git test",
      slug: "git-test",
      description: "Git transport test",
      state: "ACTIVE",
      headSha: first,
    },
  });
  await prisma.mcpGrant.create({
    data: {
      id: grantId,
      actorUserIdSnapshot: owner.id,
      userId: owner.id,
      kind: "PAT",
      clientId: `pat:${tokenId}`,
      referenceId: "pat",
      scopes: ["mcp:write"],
      toolGroups: ["read", "edit"],
      createdKbBits: [],
      acl: { create: { kbId: id, bits: ["write"] } },
    },
  });
  // Resource is canonical and independent of the ephemeral HTTP listen port.
  const origin = "http://git.example.invalid";
  await prisma.mcpPersonalToken.create({
    data: {
      id: tokenId,
      userIdSnapshot: owner.id,
      userId: owner.id,
      name: "fixture",
      lookupPrefix: token.lookupPrefix,
      secretDigest: digestPatSecret(token.secret),
      grantId,
      scopes: ["mcp:write"],
      resource: `${origin}/mcp`,
      expiresAt: new Date(Date.now() + 3600000),
    },
  });
  const provider = await prisma.embeddingProvider.create({
    data: { ownerId: owner.id, name: "fixture" },
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
      ownerSnapshot: owner.id,
      fingerprint: embeddingFingerprint(config),
      ciphertext: "fixture-only-unused",
      jobId: probe.id,
      idempotencyKey: randomUUID(),
      requestHash: "0".repeat(64),
    },
  });
  await prisma.knowledgeBase.update({
    where: { id },
    data: { profileProviderId: provider.id, profileVersion: 1 },
  });
  endpoint = createGitHttp({
    reposDir,
    push: {
      connectionString: db.urls.applier,
      canonicalOrigin: origin,
      ratePort: createMemoryRatePort(),
      barrier: {
        afterCommitting: async () => {
          await onReserved?.();
        },
      },
    },
    admit: createBearerAdmission({ query: prismaAssetQuery(prisma), origin }),
    store: prismaAuthorityStore(prisma),
    retainedRefs: async () => [
      "refs/heads/main",
      ...(await prisma.branchOwner.findMany({ where: { kbId: id }, take: 101 })).map(
        (row) => row.refName,
      ),
    ],
  });
  await new Promise<void>((resolve) => {
    server = serve({ fetch: endpoint.app.fetch, hostname: "127.0.0.1", port: 0 }, (info) => {
      url = `http://127.0.0.1:${info.port}/git/${id}.git`;
      resolve();
    });
  });
});
afterAll(async () => {
  await drainGitPushActions();
  await endpoint?.close();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await prisma.$disconnect();
  await db.close();
  await cluster.close();
  for (const path of [repo, clone]) await rm(path, { recursive: true, force: true });
});
describe("git-push real PAT, Git quarantine and journal", { timeout: 120_000 }, () => {
  it("joins an owned native action before shared fixture teardown", async () => {
    const child = spawn("git", ["hash-object", "--stdin"], {
      cwd: clone,
      env: hardenedGitEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.resume();
    child.stderr.resume();
    const exited = once(child, "exit");
    let drained = false;
    const action = runOwnedGitPushAction(async () => {
      expect((await exited)[0]).toBe(0);
    });
    const draining = drainGitPushActions().then(() => {
      drained = true;
    });
    try {
      await Promise.resolve();
      expect(drained).toBe(false);
      expect(child.exitCode).toBeNull();
      // Race while stdin is held: an early drain cannot hide behind the later join.
      const order = Promise.race([action.then(() => "action"), draining.then(() => "drain")]);
      expect(await Promise.race([draining.then(() => "drain"), delay(50).then(() => "held")])).toBe(
        "held",
      );
      child.stdin.end("owned fixture action");
      expect(await order).toBe("action");
      await draining;
      expect(drained).toBe(true);
      expect(() => process.kill(child.pid!, 0)).toThrow();
    } finally {
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited.catch(() => {});
      await action.catch(() => {});
      await draining;
    }
  });
  it.each([false, true])(
    "rejects two valid refs including atomic=%s, and valid plus invalid without moving either",
    (atomic) => {
      return runOwnedGitPushAction(async () => {
        const head = current(),
          next = commit("two refs", head);
        for (const other of ["refs/heads/topic", "refs/tags/forbidden"]) {
          await expect(
            push(...(atomic ? ["--atomic"] : []), `${next}:refs/heads/main`, `${next}:${other}`),
          ).rejects.toMatchObject({
            code: 1,
            stderr: expect.stringMatching(
              /! \[remote rejected\].*multiple ref updates are refused/,
            ),
          });
          expect(current()).toBe(head);
          expect(git(["for-each-ref", "--format=%(refname)", other], repo)).toBe("");
        }
      });
    },
  );
  it("accepts one FF preserving source SHA and author with one durable main effect", () => {
    return runOwnedGitPushAction(async () => {
      const head = current(),
        next = commit("single accepted", head);
      const before = await prisma.knowledgeBase.findUniqueOrThrow({ where: { id } });
      await push(`${next}:refs/heads/main`);
      expect(current()).toBe(next);
      expect(git(["show", "-s", "--format=%an <%ae>", next], repo)).toBe(
        git(["show", "-s", "--format=%an <%ae>", next]),
      );
      expect((await prisma.knowledgeBase.findUniqueOrThrow({ where: { id } })).headSha).toBe(next);
      expect(
        await prisma.operationIntent.count({
          where: { kbId: id, operation: "GIT_PUSH", phase: "FINALIZED" },
        }),
      ).toBe(1);
      // Nothing of the new head is active, so the push schedules the lexical companion
      // and then the semantic build: two epochs, two INDEX_KB jobs, once.
      expect((await prisma.knowledgeBase.findUniqueOrThrow({ where: { id } })).desiredEpoch).toBe(
        before.desiredEpoch + 2n,
      );
      expect(await prisma.durableJob.count({ where: { kind: "INDEX_KB" } })).toBe(2);
      const intent = await prisma.operationIntent.findFirstOrThrow({
        where: { kbId: id, operation: "GIT_PUSH", phase: "FINALIZED" },
      });
      expect(
        await prisma.auditEvent.count({
          where: { opId: intent.opId, action: "git_push", outcome: "SUCCESS" },
        }),
      ).toBe(1);
      expect(
        await prisma.auditEvent.count({
          where: { opId: intent.opId, action: "git_push", outcome: "FAILURE" },
        }),
      ).toBe(0);
    });
  });
  it("audits rejected authenticated pushes before intent creation and authorization, without client payloads", () => {
    return runOwnedGitPushAction(async () => {
      const head = current();
      const before = await prisma.auditEvent.count({
        where: { action: "git_push", outcome: "FAILURE" },
      });
      const intents = await prisma.operationIntent.count({ where: { operation: "GIT_PUSH" } });
      const reject = () =>
        fetch(`${url}/git-receive-pack`, {
          method: "POST",
          headers: {
            authorization: auth(),
            "content-type": "application/x-git-receive-pack-request",
          },
          body: "rejected-push-private-body-canary",
        });
      const malformed = await reject();
      expect(malformed.status).toBe(409);
      expect(await malformed.text()).toContain("The push request or pack is invalid");
      expect(await prisma.operationIntent.count({ where: { operation: "GIT_PUSH" } })).toBe(
        intents,
      );
      expect(
        await prisma.auditEvent.count({ where: { action: "git_push", outcome: "FAILURE" } }),
      ).toBe(before + 1);
      await prisma.grantKbAcl.update({
        where: { grantId_kbId: { grantId, kbId: id } },
        data: { bits: ["read"] },
      });
      try {
        // Authenticated but not permitted: 403 with a reason, not a credential prompt.
        expect((await reject()).status).toBe(403);
        expect(
          await prisma.auditEvent.count({ where: { action: "git_push", outcome: "FAILURE" } }),
        ).toBe(before + 2);
      } finally {
        await prisma.grantKbAcl.update({
          where: { grantId_kbId: { grantId, kbId: id } },
          data: { bits: ["write"] },
        });
      }
      for (let n = 0; n < 12; n++) expect((await reject()).status).toBe(409);
      const events = await prisma.auditEvent.findMany({
        where: { action: "git_push", outcome: "FAILURE" },
        take: 100,
      });
      expect(events.length - before).toBeLessThanOrEqual(10);
      expect(JSON.stringify(events)).not.toContain("rejected-push-private-body-canary");
      for (const event of events) {
        expect(event.metadata).toEqual({ reasonCode: "PUSH_REJECTED", requestId: event.opId });
        expect(event.revision).toBeNull();
      }
      expect(current()).toBe(head);
    });
  });

  it("a PAT without the edit tool group cannot push; restoring edit restores push", () => {
    return runOwnedGitPushAction(async () => {
      const head = current();
      const next = commit("edit-less push", head);
      await prisma.mcpGrant.update({ where: { id: grantId }, data: { toolGroups: ["read"] } });
      try {
        await expect(push(`${next}:refs/heads/main`)).rejects.toThrow();
        expect(current()).toBe(head);
        expect((await prisma.knowledgeBase.findUniqueOrThrow({ where: { id } })).headSha).toBe(
          head,
        );
      } finally {
        await prisma.mcpGrant.update({
          where: { id: grantId },
          data: { toolGroups: ["read", "edit"] },
        });
      }
      await push(`${next}:refs/heads/main`);
      expect(current()).toBe(next);
    });
  });

  it("denies force/non-FF, deletion, reserved namespaces and invalid intermediate trees", () => {
    return runOwnedGitPushAction(async () => {
      const head = current();
      const bad = commit("bad middle", head, tree("bad\u0001"));
      const repaired = commit("valid tip", bad);
      for (const [refs, reason] of [
        [["--force", `${first}:refs/heads/main`], "Non-fast-forward updates are refused"],
        [[":refs/heads/main"], "Branch deletion by push is refused"],
        [[`${head}:refs/heads/pr/1`], "The pr/ namespace is reserved"],
        [[`${head}:refs/tags/forbidden`], "tags are refused"],
        [[`${repaired}:refs/heads/main`], "does not pass this knowledge base's checks"],
      ] as const) {
        await expect(push(...refs)).rejects.toMatchObject({
          code: 1,
          stderr: expect.stringContaining(reason),
        });
        expect(current()).toBe(head);
      }
    });
  });
  it("rejects exactly 513 new commits without moving the authoritative ref", () => {
    return runOwnedGitPushAction(async () => {
      const head = current();
      // One real Git import avoids making the action deadline pay for 513
      // process startups. Each imported commit inherits its parent's valid tree.
      const history = Array.from({ length: 513 }, (_, i) => {
        const message = `cap ${i}`;
        return `commit refs/heads/cap-fixture\nmark :${i + 1}\ncommitter Fixture <fixture@example.invalid> 1700000000 +0000\ndata ${Buffer.byteLength(message)}\n${message}\nfrom ${i === 0 ? head : `:${i}`}\n\n`;
      }).join("");
      execFileSync("git", ["fast-import", "--quiet", "--done"], {
        cwd: clone,
        env: hardenedGitEnv(),
        input: `${history}done\n`,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const tip = git(["rev-parse", "refs/heads/cap-fixture"]);
      expect(Number(git(["rev-list", "--count", `${head}..${tip}`]))).toBe(513);
      await expect(push(`${tip}:refs/heads/main`)).rejects.toMatchObject({
        code: 1,
        killed: false,
        // A content refusal is reported against the ref, never as a 503 (R3-W10).
        stderr: expect.stringMatching(
          /! \[remote rejected\] \S+ -> main \(A pushed commit does not pass this knowledge base's checks/,
        ),
      });
      expect(current()).toBe(head);
    });
  });
  it("rejects a manifest hash without this KB's lineage", () => {
    return runOwnedGitPushAction(async () => {
      const head = current();
      const kb = await prisma.knowledgeBase.findUniqueOrThrow({ where: { id } });
      const other = await prisma.knowledgeBase.create({
        data: {
          ownerId: kb.ownerId,
          name: "Other",
          slug: "other-assets",
          description: "Foreign lineage fixture",
          state: "ACTIVE",
          headSha: head,
        },
      });
      const hash = `sha256:${"a".repeat(64)}`;
      await prisma.assetBlob.create({
        data: { hash, size: 1, mime: "image/png", verifiedAt: new Date() },
      });
      await prisma.kbAssetLineage.create({
        data: {
          kbId: other.id,
          hash,
          source: "UPLOAD",
          actorKey: `grant:${grantId}`,
          actorUserIdSnapshot: kb.ownerId!,
        },
      });
      const foreign = commit(
        "foreign blob",
        head,
        tree(
          "# manifest",
          JSON.stringify({
            version: 1,
            entries: [
              { path: "image.png", hash: `sha256:${"a".repeat(64)}`, size: 1, mime: "image/png" },
            ],
          }) + "\n",
        ),
      );
      await expect(push(`${foreign}:refs/heads/main`)).rejects.toMatchObject({
        code: 1,
        killed: false,
        // A content refusal is reported against the ref, never as a 503 (R3-W10).
        stderr: expect.stringMatching(
          /! \[remote rejected\] \S+ -> main \(A pushed commit does not pass this knowledge base's checks/,
        ),
      });
      expect(current()).toBe(head);
    });
  });
  describe("proposal-only branch ownership and terminal protection", () => {
    let head: string;
    let source: string;
    let next: string;
    let owner: Awaited<ReturnType<typeof prisma.branchOwner.findUniqueOrThrow>>;
    let setup: Promise<void> | undefined;
    beforeAll(() => {
      setup = (async () => {
        head = current();
        source = commit("branch", head);
        await prisma.grantKbAcl.update({
          where: { grantId_kbId: { grantId, kbId: id } },
          data: { bits: ["propose"] },
        });
      })();
      return setup;
    }, 180_000);
    afterAll(async () => {
      await setup?.catch(() => {});
      await drainGitPushActions();
      // Restoration also runs after a failed assertion or timed-out action.
      await prisma.grantKbAcl.update({
        where: { grantId_kbId: { grantId, kbId: id } },
        data: { bits: ["write"] },
      });
    }, 180_000);
    it("denies proposal-only publication to main", () => {
      return runOwnedGitPushAction(async () => {
        await expect(push(`${source}:refs/heads/main`)).rejects.toThrow();
        expect(current()).toBe(head);
      });
    });
    it("records the actor as branch owner", () => {
      return runOwnedGitPushAction(async () => {
        await push(`${source}:refs/heads/topic`);
        owner = await prisma.branchOwner.findUniqueOrThrow({
          where: { kbId_refName: { kbId: id, refName: "refs/heads/topic" } },
        });
        expect(owner.ownerActorKey).toBe(`grant:${grantId}`);
        await prisma.pullRequest.create({
          data: {
            kbId: id,
            number: 1,
            title: "Review",
            sourceBranch: owner.refName,
            targetBranch: "main",
            baseSha: head,
            headSha: source,
            targetSha: head,
            status: "CONFLICT",
            authorActorKey: owner.ownerActorKey,
            version: 1,
            isAutoPr: false,
          },
        });
      });
    });
    it("refreshes conflict on proposal append without moving main", () => {
      return runOwnedGitPushAction(async () => {
        next = commit("append", source);
        await push(`${next}:refs/heads/topic`);
        expect(
          await prisma.pullRequest.findUniqueOrThrow({
            where: { kbId_number: { kbId: id, number: 1 } },
          }),
        ).toMatchObject({ headSha: next, status: "OPEN", version: 2 });
        expect(current()).toBe(head);
      });
    });
    it("resolves the recorded conflicts a push writes and keeps the rest", () => {
      return runOwnedGitPushAction(async () => {
        const where = { kbId_number: { kbId: id, number: 1 } };
        await prisma.pullRequest.update({
          where,
          data: {
            pendingConflicts: [
              { path: "index.md", kind: "document" },
              { path: "gone.md", kind: "document" },
            ],
          },
        });
        const resolved = commit("resolve index", next, tree("# resolved\n"));
        await push(`${resolved}:refs/heads/topic`);
        expect(await prisma.pullRequest.findUniqueOrThrow({ where })).toMatchObject({
          headSha: resolved,
          pendingConflicts: [{ path: "gone.md", kind: "document" }],
        });
        // With nothing left to resolve, the reviewed merge plans again.
        await prisma.pullRequest.update({
          where,
          data: { pendingConflicts: [{ path: "index.md", kind: "document" }] },
        });
        next = commit("resolve again", resolved, tree("# resolved again\n"));
        await push(`${next}:refs/heads/topic`);
        const row = await prisma.pullRequest.findUniqueOrThrow({ where });
        expect(row.pendingConflicts).toEqual([]);
        const { planReviewedMerge } = await import("@knowledge-base/api/lib/kb/pr-merge");
        const plan = await planReviewedMerge({
          repoPath: repo,
          mainHead: current(),
          sourceHead: row.headSha,
          dream: null,
          pendingConflicts: [],
        });
        expect(plan.validation.ok).toBe(true);
      });
    });
    it("reports a large update's logical writes in bounded frames", () => {
      return runOwnedGitPushAction(async () => {
        const where = { kbId_number: { kbId: id, number: 1 } };
        await prisma.pullRequest.update({
          where,
          data: {
            pendingConflicts: [
              { path: "bulk/1099.md", kind: "document" },
              { path: "gone.md", kind: "document" },
            ],
          },
        });
        // 1,100 new documents: more logical writes than one hook frame carries.
        const bulk = execFileSync("git", ["mktree"], {
          cwd: clone,
          env: hardenedGitEnv(),
          input: Array.from(
            { length: 1100 },
            (_, n) => `100644 blob ${object("blob", `# bulk ${n}\n`)}\t${n}.md\n`,
          ).join(""),
          encoding: "utf8",
        }).trim();
        const base = tree();
        const root = execFileSync("git", ["mktree"], {
          cwd: clone,
          env: hardenedGitEnv(),
          input: `${git(["ls-tree", base])}\n040000 tree ${bulk}\tbulk\n`,
          encoding: "utf8",
        }).trim();
        next = commit("bulk", next, root);
        await push(`${next}:refs/heads/topic`);
        expect(await prisma.pullRequest.findUniqueOrThrow({ where })).toMatchObject({
          headSha: next,
          pendingConflicts: [{ path: "gone.md", kind: "document" }],
        });
        await prisma.pullRequest.update({ where, data: { pendingConflicts: [] } });
      });
    });
    it("lets the same person append from another credential", () => {
      return runOwnedGitPushAction(async () => {
        const grant = await prisma.mcpGrant.findUniqueOrThrow({ where: { id: grantId } });
        const other = await prisma.mcpGrant.create({
          data: {
            id: randomUUID(),
            actorUserIdSnapshot: grant.userId!,
            userId: grant.userId,
            kind: "PAT",
            clientId: `pat:${randomUUID()}`,
            referenceId: "pat",
            scopes: ["mcp:write"],
            toolGroups: ["read", "edit"],
            createdKbBits: [],
          },
        });
        await prisma.branchOwner.update({
          where: { kbId_refName: { kbId: id, refName: owner.refName } },
          data: { ownerActorKey: `grant:${other.id}` },
        });
        try {
          next = commit("same person", next);
          await push(`${next}:refs/heads/topic`);
          expect(git(["rev-parse", "refs/heads/topic"], repo)).toBe(next);
        } finally {
          await prisma.branchOwner.update({
            where: { kbId_refName: { kbId: id, refName: owner.refName } },
            data: { ownerActorKey: owner.ownerActorKey },
          });
        }
      });
    });
    it("denies append by a foreign owner", () => {
      return runOwnedGitPushAction(async () => {
        await prisma.branchOwner.update({
          where: { kbId_refName: { kbId: id, refName: owner.refName } },
          data: { ownerActorKey: "user:foreign" },
        });
        try {
          await expect(push(`${commit("foreign", next)}:refs/heads/topic`)).rejects.toThrow();
        } finally {
          await prisma.branchOwner.update({
            where: { kbId_refName: { kbId: id, refName: owner.refName } },
            data: { ownerActorKey: owner.ownerActorKey },
          });
        }
      });
    });
    it.each(["CLOSED", "MERGED"] as const)("denies append to a %s proposal", (status) => {
      return runOwnedGitPushAction(async () => {
        await prisma.pullRequest.update({
          where: { kbId_number: { kbId: id, number: 1 } },
          data: { status },
        });
        await expect(push(`${commit(status, next)}:refs/heads/topic`)).rejects.toThrow();
      });
    });
  });
  it("expires the owning publication scope before release and drains without moving the ref", () => {
    return runOwnedGitPushAction(async () => {
      const { requireOperationLease } = await import("@knowledge-base/api/lib/kb/lock");
      const head = current();
      const next = commit("owning deadline", head);
      let reached = false;
      const startedAt = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(startedAt);
      let budget: number | undefined;
      let expiryError: unknown;
      onReserved = async () => {
        const scope = requireOperationLease().scope;
        reached = true;
        budget = scope.deadlineAt - startedAt;
        // Advance the owning clock, after real admission/quarantine/reservation.
        // Host descheduling cannot substitute for the product expiry assertion.
        vi.spyOn(scope, "now").mockReturnValue(scope.deadlineAt);
        try {
          scope.assertActive();
        } catch (error) {
          expiryError = error;
          throw error;
        }
      };
      try {
        await expect(push(`${next}:refs/heads/main`)).rejects.toMatchObject({
          code: 1,
          killed: false,
          stderr: expect.stringContaining("HTTP 503"),
        });
        expect(reached).toBe(true);
        expect(budget).toBe(60_000);
        expect(expiryError).toMatchObject({ code: "DEADLINE_EXCEEDED" });
        expect(current()).toBe(head);
      } finally {
        onReserved = undefined;
        vi.restoreAllMocks();
      }
    });
  });
  it("permission loss after reservation cannot cancel its publication", () => {
    return runOwnedGitPushAction(async () => {
      const next = commit("reserved before revoke", current());
      onReserved = async () => {
        await prisma.grantKbAcl.update({
          where: { grantId_kbId: { grantId, kbId: id } },
          data: { bits: ["read"] },
        });
      };
      try {
        await push(`${next}:refs/heads/main`);
        expect(current()).toBe(next);
      } finally {
        onReserved = undefined;
        await prisma.grantKbAcl.update({
          where: { grantId_kbId: { grantId, kbId: id } },
          data: { bits: ["write"] },
        });
      }
    });
  });
  it.each(["all", "partial", "packed"])(
    "unpublished %s migration retains exactly its canonical history charge",
    (migration) => {
      return runOwnedGitPushAction(async () => {
        const head = current(),
          next = commit(`retained ${migration}`, head, tree(`# new ${migration}\n`));
        const before = await prisma.quotaAccount.findFirst({
          where: { subjectId: id, dimension: "KB_HISTORY_BYTES" },
        });
        let expected = 0n;
        let faultStage = "before COMMITTING";
        onReserved = async () => {
          faultStage = "intent lookup";
          const intent = await prisma.operationIntent.findFirstOrThrow({
            where: { kbId: id, newRef: next, phase: "COMMITTING" },
          });
          const files = (
            intent.preparedDelta as { objectFiles: Array<{ path: string; bytes: number }> }
          ).objectFiles;
          faultStage = "inventory validation";
          expect(files.length).toBeGreaterThan(1);
          if (migration !== "partial") {
            if (migration === "packed")
              expect(files.some((file) => file.path.endsWith(".pack"))).toBe(true);
            expected = BigInt(files.reduce((sum, file) => sum + file.bytes, 0));
            // Native receive-pack migrates its quarantine before failing the ref CAS.
            await writeFile(join(repo, "refs/heads/main.lock"), "occupied", { flag: "wx" });
          } else {
            faultStage = "quarantine lookup";
            const objects = join(repo, "objects");
            const file = files.find(
              (file) => file.path !== `${next.slice(0, 2)}/${next.slice(2)}`,
            )!;
            // Earlier interrupted receives can leave other incoming directories.
            // Select this inventory's actual file, not the first directory name.
            const sources: string[] = [];
            for (const name of await readdir(objects)) {
              if (!name.startsWith("tmp_objdir-incoming-")) continue;
              const source = join(objects, name, file.path);
              const info = await stat(source).catch((error: NodeJS.ErrnoException) => {
                if (error.code === "ENOENT") return undefined;
                throw error;
              });
              if (info?.isFile() && info.size === file.bytes) sources.push(source);
            }
            expect(sources).toHaveLength(1);
            await mkdir(dirname(join(objects, file.path)), { recursive: true });
            faultStage = "partial file copy";
            await copyFile(sources[0]!, join(objects, file.path));
            expected = BigInt(file.bytes);
            throw new Error("injected interruption after partial migration");
          }
        };
        if (migration === "packed") git(["config", "receive.unpackLimit", "1"], repo);
        try {
          await expect(push(`${next}:refs/heads/main`)).rejects.toThrow();
        } finally {
          onReserved = undefined;
          if (migration === "packed") git(["config", "--unset", "receive.unpackLimit"], repo);
        }
        expect(expected, `fault did not complete: ${faultStage}`).toBeGreaterThan(0n);
        const { runLockedOperation } = await import("@knowledge-base/api/lib/kb/authority-lock");
        const { reconcileKbIntents } = await import("@knowledge-base/api/lib/kb/operation-intent");
        for (let replay = 0; replay < 2; replay++) {
          await runLockedOperation({
            connectionString: db.urls.applier,
            opId: randomUUID(),
            kind: "kb-write",
            kbIds: [id],
            run: (lease) => lease.transaction((query) => reconcileKbIntents(query, reposDir, id)),
          });
          expect(current()).toBe(head);
          const history = await prisma.quotaAccount.findFirstOrThrow({
            where: { subjectId: id, dimension: "KB_HISTORY_BYTES" },
          });
          expect(history.reserved).toBe(0n);
          expect(history.committed).toBe((before?.committed ?? 0n) + expected);
        }
        if (migration !== "partial") {
          expect(git(["cat-file", "-t", next], repo)).toBe("commit");
          // Already-retained objects can be published without a second charge.
          await push(`${next}:refs/heads/main`);
          expect(current()).toBe(next);
          const history = await prisma.quotaAccount.findFirstOrThrow({
            where: { subjectId: id, dimension: "KB_HISTORY_BYTES" },
          });
          expect(history.committed).toBe((before?.committed ?? 0n) + expected);
          expect(history.reserved).toBe(0n);
        } else expect(() => git(["cat-file", "-t", next], repo)).toThrow();
      });
    },
  );
  describe.each(["afterCommitting", "afterRefUpdate", "afterDbFinalize", "afterBufferedReply"])(
    "SIGKILL at %s recovers one logical outcome",
    (stage) => {
      let ownedRoot: string | undefined;
      let ownedChild: ReturnType<typeof spawn> | undefined;
      let ownedExit: Promise<unknown[]> | undefined;
      let crashDb: Awaited<ReturnType<typeof cluster.createDatabase>> | undefined;
      let crashPrisma: ReturnType<typeof db.createPrismaClient> | undefined;
      async function prepare() {
        const root = new URL("../../../../", import.meta.url).pathname;
        const crashData = await mkdtemp(join(tmpdir(), "kb-push-crash-"));
        ownedRoot = crashData;
        // The provisioned volume layout: the supervisor opens
        // <KB_DATA_ROOT>/repos/.private/server.fence.
        const crashRoot = join(crashData, "repos");
        await mkdir(join(crashRoot, ".private"), { recursive: true, mode: 0o700 });
        const crashId = `c${randomUUID().replaceAll("-", "").slice(0, 23)}`;
        const base = await prisma.knowledgeBase.findUniqueOrThrow({ where: { id } });
        const ownerId = base.ownerId;
        if (!ownerId) throw new Error("crash fixture needs a live owner");
        crashDb = await cluster.createDatabase();
        crashDb.applyPrismaSchema();
        crashPrisma = crashDb.createPrismaClient();
        await crashPrisma.user.create({
          data: {
            id: ownerId,
            name: "Crash owner",
            email: `${randomUUID()}@example.invalid`,
            twoFactorEnabled: true,
          },
        });
        await crashPrisma.embeddingProvider.create({
          data: { id: base.profileProviderId!, ownerId: ownerId, name: "Crash provider" },
        });
        const probe = await crashPrisma.durableJob.create({
          data: { dedupKey: randomUUID(), kind: "PROVIDER_PROBE", desired: {}, state: "COMPLETE" },
        });
        const config = {
          endpointUrl: "https://provider.example.invalid/embeddings",
          model: "fixture",
          dimensions: 2,
        };
        await crashPrisma.providerRevision.create({
          data: {
            ...config,
            providerId: base.profileProviderId!,
            version: 1,
            ownerSnapshot: ownerId,
            fingerprint: embeddingFingerprint(config),
            ciphertext: "fixture-only-unused",
            jobId: probe.id,
            idempotencyKey: randomUUID(),
            requestHash: "0".repeat(64),
          },
        });
        await crashPrisma.knowledgeBase.create({
          data: {
            id: crashId,
            ownerId: ownerId,
            name: "Crash",
            slug: crashId,
            description: "crash recovery fixture",
            state: "ACTIVE",
            headSha: base.headSha,
            profileProviderId: base.profileProviderId,
            profileVersion: base.profileVersion,
          },
        });
        await crashPrisma.mcpGrant.create({
          data: {
            id: grantId,
            actorUserIdSnapshot: ownerId,
            userId: ownerId,
            kind: "PAT",
            clientId: `pat:${tokenId}`,
            referenceId: "pat",
            scopes: ["mcp:write"],
            toolGroups: ["read", "edit"],
            createdKbBits: [],
            acl: { create: { kbId: crashId, bits: ["write"] } },
          },
        });
        await crashPrisma.mcpPersonalToken.create({
          data: {
            id: tokenId,
            userIdSnapshot: ownerId,
            userId: ownerId,
            name: "Crash PAT",
            lookupPrefix: token.lookupPrefix,
            secretDigest: digestPatSecret(token.secret),
            grantId,
            scopes: ["mcp:write"],
            resource: "http://git.example.invalid/mcp",
            expiresAt: new Date(Date.now() + 3600000),
          },
        });
        const assetsDir = join(crashRoot, "assets");
        await mkdir(assetsDir);
        git(["clone", "--bare", repo, kbBareRepoPath(crashRoot, crashId)]);
        const next = commit(stage, base.headSha!);
        const script = `import {Client} from 'pg';
      import {createGitHttp} from './apps/server/src/git-http.ts';
      import {createBearerAdmission} from './apps/server/src/mcp/auth.ts';
      import {sqlAuthorityStore} from './packages/api/src/lib/kb/permissions.ts';
      import {createMemoryRatePort} from './packages/api/src/lib/kb/limits.ts';
      import {runStartupJournalRecovery} from './packages/api/src/lib/kb/recovery.ts';
      import {PrismaClient} from './packages/db/prisma/generated/client.ts';
      import {createPrismaPgAdapter} from './packages/db/src/prisma-adapter.ts';
      import {assertProcessFence,pingProcessFence} from './apps/server/src/kb-process.ts';
      import {serve} from './apps/server/node_modules/@hono/node-server/dist/index.mjs';
      const db=new Client({connectionString:process.env.KB_TEST_CONNECTION}); await db.connect();
      const query=(sql,values)=>db.query(sql,values);
      const prisma=new PrismaClient({adapter:createPrismaPgAdapter({connectionString:process.env.KB_TEST_CONNECTION})});
      await pingProcessFence();
      await runStartupJournalRecovery(prisma,process.env.KB_DATA_ROOT+'/repos',process.env.KB_TEST_ASSETS,process.env.KB_TEST_CONNECTION,assertProcessFence);
      const endpoint=createGitHttp({reposDir:process.env.KB_DATA_ROOT+'/repos',store:sqlAuthorityStore(query),retainedRefs:async()=>['refs/heads/main'],
        admit:createBearerAdmission({query,origin:'http://git.example.invalid'}),
        push:{connectionString:process.env.KB_TEST_CONNECTION,canonicalOrigin:'http://git.example.invalid',ratePort:createMemoryRatePort(),barrier:process.env.KB_TEST_FAULT?{[process.env.KB_TEST_FAULT]:async()=>{process.kill(process.pid,'SIGKILL');await new Promise(()=>{});}}:{}}});
      serve({fetch:endpoint.app.fetch,hostname:'127.0.0.1',port:0},info=>process.stdout.write('PORT='+info.port+'\\n'));`;
        async function startServer(fault: string) {
          const child = spawn(
            join(root, "apps/server/native/kb-supervisor"),
            ["--", process.execPath, "--import", "tsx", "--input-type=module", "-e", script],
            {
              cwd: root,
              env: {
                PATH: process.env.PATH,
                KB_DATA_ROOT: crashData,
                KB_TEST_CONNECTION: crashDb!.urls.applier,
                KB_TEST_ASSETS: assetsDir,
                KB_TEST_FAULT: fault,
              },
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          ownedChild = child;
          let diagnostics = "";
          child.stderr.on("data", (chunk) => {
            diagnostics = `${diagnostics}${chunk.toString()}`.slice(-16_384);
          });
          const exited = once(child, "exit");
          ownedExit = exited;
          void exited.catch(() => {});
          const port = await new Promise<string>((resolve, reject) => {
            let output = "";
            const timer = setTimeout(
              () => reject(new Error("Crash server startup timed out")),
              180_000,
            );
            child.stdout.on("data", (chunk) => {
              output += chunk.toString();
              const match = /PORT=(\d+)/.exec(output);
              if (match) {
                clearTimeout(timer);
                resolve(match[1]!);
              }
            });
            child.once("error", (error) => {
              clearTimeout(timer);
              reject(error);
            });
            child.once("exit", () => {
              clearTimeout(timer);
              reject(
                new Error(
                  `Crash server exited before readiness: ${diagnostics.replaceAll(crashDb!.urls.applier, "[fixture database]")}`,
                ),
              );
            });
          });

          return { child, exited, port };
        }
        const initial = await startServer(stage);
        return {
          startServer,
          crashPrisma,
          crashId,
          base,
          next,
          port: initial.port,
          crashRoot,
          exited: initial.exited,
        };
      }
      let fixture: Awaited<ReturnType<typeof prepare>>;
      let setup: Promise<void> | undefined;
      let action: Promise<void> | undefined;
      beforeAll(() => {
        // Each real server startup acquires the native fence and runs journal recovery.
        // Product publication is bounded by its own 60s scope; client/drain
        // scheduling belongs to the 120s fixture watchdog.
        setup = prepare().then((prepared) => {
          fixture = prepared;
        });
        return setup;
      }, 180_000);
      afterAll(async () => {
        if (ownedChild && ownedChild.exitCode === null && ownedChild.signalCode === null)
          ownedChild.kill("SIGTERM");
        await ownedExit?.catch(() => {}); // Native fence drains before fixture reclamation.
        await setup?.catch(() => {});
        await action?.catch(() => {});
        await crashPrisma?.$disconnect();
        await crashDb?.close();
        if (ownedRoot) await rm(ownedRoot, { recursive: true, force: true });
      }, 180_000);
      it("drains the native fence after the interrupted publication", () => {
        action = runOwnedGitPushAction(async () => {
          const { crashId, next, port, exited } = fixture;
          await expect(
            remote([
              "-C",
              clone,
              "push",
              `http://127.0.0.1:${port}/git/${crashId}.git`,
              `${next}:refs/heads/main`,
            ]),
          ).rejects.toThrow();
          await exited;
        });
        return action;
      });
      it.each([1, 2])("recovery sweep %s preserves one ref, intent, audit and index effect", () => {
        action = runOwnedGitPushAction(async () => {
          const { startServer, crashPrisma, crashId, base, next, crashRoot } = fixture;
          const restarted = await startServer("");
          try {
            const history = await crashPrisma.quotaAccount.findFirstOrThrow({
              where: { subjectId: crashId, dimension: "KB_HISTORY_BYTES" },
            });
            expect(history.reserved).toBe(0n);
            if (stage === "afterCommitting") {
              expect(history.committed).toBe(0n);
              expect(() =>
                git(["cat-file", "-e", next], kbBareRepoPath(crashRoot, crashId)),
              ).toThrow();
            } else expect(history.committed).toBeGreaterThan(0n);
            expect(
              (await readdir(join(crashRoot, ".private/tmp"))).filter((name) =>
                name.startsWith("git-"),
              ),
            ).toEqual([]);
            expect(git(["rev-parse", "refs/heads/main"], kbBareRepoPath(crashRoot, crashId))).toBe(
              stage === "afterCommitting" ? base.headSha : next,
            );
            expect(
              await crashPrisma.operationIntent.count({
                where: {
                  kbId: crashId,
                  operation: "GIT_PUSH",
                  newRef: next,
                  phase: stage === "afterCommitting" ? "ABORTED" : "FINALIZED",
                },
              }),
            ).toBe(1);
            expect(
              await crashPrisma.auditEvent.count({
                where: { kbId: crashId, revision: next, action: "git_push" },
              }),
            ).toBe(stage === "afterCommitting" ? 0 : 1);
            const recovered = await crashPrisma.operationIntent.findFirstOrThrow({
              where: { kbId: crashId, operation: "GIT_PUSH", newRef: next },
            });
            expect(
              await crashPrisma.auditEvent.count({
                where: { opId: recovered.opId, action: "git_push", outcome: "FAILURE" },
              }),
            ).toBe(stage === "afterCommitting" ? 1 : 0);
            expect(
              await crashPrisma.durableJob.count({
                where: { dedupKey: { startsWith: `index:${crashId}:` } },
              }),
              // The lexical companion and the semantic build, exactly once.
            ).toBe(stage === "afterCommitting" ? 0 : 2);
          } finally {
            restarted.child.kill("SIGTERM");
            await restarted.exited;
          }
        });
        return action;
      });
      it("accepts a retry after real startup recovery", () => {
        return runOwnedGitPushAction(async () => {
          const restarted = await fixture.startServer("");
          try {
            const head = git(
              ["rev-parse", "refs/heads/main"],
              kbBareRepoPath(fixture.crashRoot, fixture.crashId),
            );
            const retry = commit(`retry ${stage}`, head);
            await remote([
              "-C",
              clone,
              "push",
              `http://127.0.0.1:${restarted.port}/git/${fixture.crashId}.git`,
              `${retry}:refs/heads/main`,
            ]);
            expect(
              git(
                ["rev-parse", "refs/heads/main"],
                kbBareRepoPath(fixture.crashRoot, fixture.crashId),
              ),
            ).toBe(retry);
            const history = await fixture.crashPrisma.quotaAccount.findFirstOrThrow({
              where: { subjectId: fixture.crashId, dimension: "KB_HISTORY_BYTES" },
            });
            expect(history.reserved).toBe(0n);
            expect(history.committed).toBeGreaterThan(0n);
          } finally {
            restarted.child.kill("SIGTERM");
            await restarted.exited;
          }
        });
      });
    },
  );
  it("push keeps revoked references only in unchanged documents across branches and intermediate commits", {
    timeout: 120_000,
  }, () => {
    return runOwnedGitPushAction(async () => {
      const kb = await prisma.knowledgeBase.findUniqueOrThrow({ where: { id } });
      if (!kb.ownerId) throw new Error("fixture owner required");
      const namespace = remoteSealedNamespace("http://git.example.invalid", id);
      const recordId = randomUUID();
      await prisma.sealedRecord.create({
        data: {
          namespace,
          recordId,
          kbId: id,
          ownerId: kb.ownerId,
          ownerSnapshot: kb.ownerId,
          ciphertext: "fixture-only-unused",
        },
      });
      const reference = `{{sealed:v1:knowledge_base:${namespace}:${recordId}}}`;
      const manifest = '{"version":1,"entries":[]}\n';
      const retained = { "secret.md": reference };
      const base = commit("write live reference", current(), tree("base", manifest, retained));
      await push(`${base}:refs/heads/main`);
      await prisma.sealedRecord.update({
        where: { namespace_recordId: { namespace, recordId } },
        data: { ciphertext: null, revokedAt: new Date() },
      });
      const one = commit("unrelated edit one", base, tree("one", manifest, retained));
      const two = commit("unrelated edit two", one, tree("two", manifest, retained));
      await push(`${two}:refs/heads/main`);
      expect(current()).toBe(two);
      const branch = `refs/heads/sealed-${recordId}`;
      const branchOne = commit("branch edit", two, tree("branch", manifest, retained));
      await push(`${branchOne}:${branch}`);
      const branchTwo = commit(
        "existing branch edit",
        branchOne,
        tree("branch two", manifest, retained),
      );
      await push(`${branchTwo}:${branch}`);
      expect(git(["rev-parse", branch], repo)).toBe(branchTwo);
      // The tip cannot hide a changed document or new reference in its history.
      const bad = commit(
        "changed revoked document",
        two,
        tree("bad", manifest, { "secret.md": `${reference} changed` }),
      );
      const masksBad = commit("remove bad document at tip", bad, tree("clean"));
      for (const ref of ["refs/heads/main", `refs/heads/rejected-${recordId}`]) {
        await expect(push(`${masksBad}:${ref}`)).rejects.toThrow();
      }
      expect(current()).toBe(two);
      // Parent order does not change which documents the published branch changes.
      const reorderedRetained = git([
        "commit-tree",
        tree("retain revoked document", manifest, retained),
        "-p",
        first,
        "-p",
        two,
        "-m",
        "branch tip is the second parent",
      ]);
      await push(`${reorderedRetained}:refs/heads/main`);
      // Clean the fixture's current tree through an ordinary accepted deletion.
      const clean = commit("delete retained fixture reference", reorderedRetained, tree("clean"));
      await push(`${clean}:refs/heads/main`);
      const restoredThroughOldParent = git([
        "commit-tree",
        tree("revoked restore", manifest, retained),
        "-p",
        two,
        "-p",
        clean,
        "-m",
        "old first parent cannot grandfather revoked references",
      ]);
      for (const ref of ["refs/heads/main", `refs/heads/reordered-${recordId}`]) {
        await expect(push(`${restoredThroughOldParent}:${ref}`)).rejects.toThrow();
      }
      expect(current()).toBe(clean);
      const oldTip = commit("advance past deletion", clean, tree("still clean"));
      await push(`${oldTip}:refs/heads/main`);
      const retainedSide = commit(
        "side history retains document",
        two,
        tree("side", manifest, retained),
      );
      for (const [n, parents] of [
        [two, clean],
        [retainedSide, clean],
        [clean, retainedSide],
      ].entries()) {
        const side = git([
          "commit-tree",
          tree("hidden restoration", manifest, retained),
          ...parents.flatMap((parent) => ["-p", parent]),
          "-m",
          `side restoration ${n}`,
        ]);
        const tip = git([
          "commit-tree",
          tree("clean tip"),
          "-p",
          oldTip,
          "-p",
          side,
          "-m",
          "tip masks side restoration",
        ]);
        for (const ref of ["refs/heads/main", `refs/heads/side-${n}-${recordId}`]) {
          await expect(push(`${tip}:${ref}`)).rejects.toThrow();
        }
      }
      expect(current()).toBe(oldTip);
      // Agreement across side parents retains a document without reintroducing it.
      const unchangedSide = git([
        "commit-tree",
        tree("unchanged side document", manifest, retained),
        "-p",
        two,
        "-p",
        retainedSide,
        "-m",
        "all side parents retain the same blob",
      ]);
      const unchangedTip = git([
        "commit-tree",
        tree("clean tip with unchanged side history"),
        "-p",
        oldTip,
        "-p",
        unchangedSide,
        "-m",
        "retained side documents remain valid",
      ]);
      await push(`${unchangedTip}:refs/heads/main`);
      expect(current()).toBe(unchangedTip);
    });
  });
  it("revocation while waiting for the authority lock prevents reservation", () => {
    return runOwnedGitPushAction(async () => {
      const client = new Client({ connectionString: db.urls.applier });
      await client.connect();
      const { AUTHORITY_LOCK_CLASSID, AUTHORITY_LOCK_OBJID } = await import(
        "@knowledge-base/api/lib/kb/lock"
      );
      await client.query("SELECT pg_advisory_lock($1,$2)", [
        AUTHORITY_LOCK_CLASSID,
        AUTHORITY_LOCK_OBJID,
      ]);
      const head = current(),
        next = commit("revoked", head),
        pending = push(`${next}:refs/heads/main`);
      const result = pending.then(
        () => false,
        () => true,
      );
      try {
        let waiting = false;
        for (let n = 0; n < 100; n++) {
          const locks = await client.query(
            "SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND classid=$1 AND objid=$2",
            [AUTHORITY_LOCK_CLASSID, AUTHORITY_LOCK_OBJID],
          );
          if (locks.rows.length) {
            waiting = true;
            break;
          }
          await delay(20);
        }
        expect(waiting).toBe(true);
        await client.query('UPDATE mcp_grant SET "revokedAt"=now() WHERE id=$1', [grantId]);
        await client.query("SELECT pg_advisory_unlock($1,$2)", [
          AUTHORITY_LOCK_CLASSID,
          AUTHORITY_LOCK_OBJID,
        ]);
        expect(await result).toBe(true);
        expect(current()).toBe(head);
      } finally {
        await client.query("SELECT pg_advisory_unlock($1,$2)", [
          AUTHORITY_LOCK_CLASSID,
          AUTHORITY_LOCK_OBJID,
        ]);
        await client.end();
        await result;
      }
    });
  });
});

it("container executes the bundled hook over a private socket and drains it on parent kill", () => {
  return runOwnedGitPushAction(async () => {
    const root = new URL("../../../../", import.meta.url).pathname;
    const scratch = await mkdtemp(join(tmpdir(), "kb-hook-smoke-"));
    try {
      await copyFile(
        requireBuiltArtifact(
          buildArtifactPath("static-supervisor"),
          "pnpm test:kb --build-only git-push",
        ),
        join(scratch, "kb-supervisor"),
      );
      requireBuiltArtifact(
        join(root, "apps/server/dist/hooks/pre-receive"),
        "pnpm test:kb --build-only git-push",
      );
      // GitHub's runner UID differs from the container's uid 1000. The fixture
      // contains only this executable; let the container traverse the mount.
      await chmod(scratch, 0o755);
      const script = `import fs from 'node:fs'; import net from 'node:net'; import {spawn} from 'node:child_process';
      const dir='/tmp/repos/hook-test'; fs.mkdirSync(dir,{mode:0o700}); fs.mkdirSync(dir+'/objects');
      const path=dir+'/sock'; const hook='/app/apps/server/dist/hooks/pre-receive'; fs.accessSync(hook,fs.constants.X_OK);
      const server=net.createServer(s=>{s.once('data', b=>{const m=JSON.parse(b.toString());
        if(m.nonce!=='a'.repeat(64) || (fs.statSync(path).mode&511)!==384) process.exit(2);
        process.stdout.write('HOOK_CONNECTED_PRIVATE_SOCKET\\n',()=>process.kill(process.pid,'SIGKILL'));
      });}); server.listen(path,()=>{fs.chmodSync(path,0o600);
        const child=spawn(hook,[],{cwd:dir,env:{PATH:process.env.PATH,KB_PUSH_SOCKET:path,KB_PUSH_NONCE:'a'.repeat(64)},stdio:['pipe','inherit','inherit',Number(process.env.KB_FENCE_FD)]});
        child.on('error',()=>process.exit(3)); child.stdin.end('1'.repeat(40)+' '+'2'.repeat(40)+' refs/heads/main\\n');
      });`;
      const name = `kb-push-hook-${randomUUID()}`;
      const result = await withDockerContainer(name, () =>
        client(
          "docker",
          [
            "run",
            "--name",
            name,
            ...dockerFixtureLabels(),
            "--rm",
            "--network=none",
            "--user=1000:1000",
            "-e",
            "KB_DATA_ROOT=/tmp",
            "-v",
            `${root}:/app:ro`,
            "-v",
            `${scratch}:/native:ro`,
            NODE_BASE_IMAGE,
            "sh",
            "-c",
            'mkdir -p /tmp/repos/.private && exec /native/kb-supervisor -- node --input-type=module -e "$1"',
            "sh",
            script,
          ],
          { timeout: 60000 },
        ).catch((error: { stdout: string; stderr: string; code: number }) => error),
      );
      expect(result.stdout, result.stderr).toContain("HOOK_CONNECTED_PRIVATE_SOCKET");
      expect("code" in result && result.code).not.toBe(0);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
}, 65000);
