import { execFile, spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { removeUserAccount } from "@knowledge-base/api/lib/kb/account-removal";
import { prismaAssetQuery } from "@knowledge-base/api/lib/kb/asset-authz";
import { remoteSealedNamespace } from "@knowledge-base/api/lib/kb/attachment";
import { runLockedOperation } from "@knowledge-base/api/lib/kb/authority-lock";
import { deleteKnowledgeBase } from "@knowledge-base/api/lib/kb/bases";
import { createDiskBlobStore } from "@knowledge-base/api/lib/kb/blob-store-disk";
import { type ApplyResult, createChangesPublication } from "@knowledge-base/api/lib/kb/changes";
import { createCursorSigner } from "@knowledge-base/api/lib/kb/cursor";
import { readDocumentAtRevision } from "@knowledge-base/api/lib/kb/documents-read";
import { kbBareRepoPath, readHeadSha, readRefSha } from "@knowledge-base/api/lib/kb/git-read";
import {
  type GitMutatingExecutor,
  writeInitialMainCommit,
} from "@knowledge-base/api/lib/kb/git-write";
import { createMemoryRatePort } from "@knowledge-base/api/lib/kb/limits";
import { canonicalRequestHash } from "@knowledge-base/api/lib/kb/operation-intent";
import { type Permission, prismaAuthorityStore } from "@knowledge-base/api/lib/kb/permissions";
import type { Principal } from "@knowledge-base/api/lib/kb/principal";
import {
  buildKbErrorCallToolResult,
  buildKbSuccessCallToolResult,
} from "@knowledge-base/api/lib/kb/protocol/envelope";
import {
  getPullRequest,
  getPullRequestConflicts,
  mutatePullRequest,
} from "@knowledge-base/api/lib/kb/pull-requests";
import { setKbRecoveryComplete } from "@knowledge-base/api/lib/kb/recovery";
import type { KbRuntimeConfig } from "@knowledge-base/api/lib/kb/runtime";
import {
  decryptSealedRecord,
  enrollSealedRecord,
  grantSealedRecord,
  revokeSealedRecord,
} from "@knowledge-base/api/lib/kb/sealed-records";
import { parseSealedReference } from "@knowledge-base/api/lib/kb/sealed-reference";
import {
  resolveSealedReference,
  type SealedCredentialVerifier,
} from "@knowledge-base/api/lib/kb/sealed-resolve";
import { shareRevoke, shareSetSealedValues } from "@knowledge-base/api/lib/kb/shares";
import {
  authenticatePersonalToken,
  createGrantCredentialVerifier,
  mintPersonalToken,
  revokePersonalToken,
} from "@knowledge-base/api/lib/mcp-token-access";
import { runWithAllowedAccountDeletion } from "@knowledge-base/auth/account-deletion-policy";
import { MCP_TOOL_GROUPS } from "@knowledge-base/auth/mcp-tool-groups";
import { captureLog } from "@knowledge-base/env/log";
import { afterAll, describe, expect, it, vi } from "vitest";

const { Secret } = await vi.hoisted(() => import("@knowledge-base/env/secret"));

import { openKbPostgresClusterFromEnv } from "./index";

const wiring = vi.hoisted(() => ({ runtime: {}, masterKey: "", settings: vi.fn() }));
vi.mock("@knowledge-base/db", () => ({
  default: { appSetting: { findMany: (args: unknown) => wiring.settings(args) } },
}));
vi.mock("@knowledge-base/env/shared", () => ({
  env: {
    get KB_MASTER_KEY() {
      return new Secret(wiring.masterKey);
    },
  },
}));
vi.mock("@knowledge-base/api/lib/kb/runtime", () => ({ getKbRuntime: () => wiring.runtime }));

const cluster = await openKbPostgresClusterFromEnv();
const db = await cluster.createDatabase();
db.applyPrismaSchema();
const prisma = db.createPrismaClient("runtime");
wiring.settings.mockImplementation((args) => prisma.appSetting.findMany(args));
const reposDir = mkdtempSync(join(tmpdir(), "kb-sealed-"));
const executor: GitMutatingExecutor = {
  exec({ cwd, argv, env }) {
    return new Promise<void>((resolve, reject) => {
      const child = spawn(argv[0]!, argv.slice(1), { cwd, env, stdio: "ignore" });
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0 ? resolve() : reject(new Error("fixture Git failed")),
      );
    });
  },
};
const runtime: KbRuntimeConfig = {
  prisma,
  reposDir,
  assetsDir: reposDir,
  blobStore: createDiskBlobStore(reposDir),
  connectionString: db.urls.runtime,
  canonicalOrigin: "https://sealed.example.invalid",
  cursorSigner: createCursorSigner(randomBytes(32)),
  ratePort: createMemoryRatePort(),
  diskMeter: { freeBytes: async () => 1n << 40n },
  createGitExecutor: () => executor,
  coordinator: {
    run: (options) =>
      runLockedOperation({
        ...options,
        connectionString: db.urls.runtime,
        kind: options.kind === "authority" ? "authority" : "kb-write",
        run: (lease) =>
          options.run({
            lease,
            signal: lease.scope.signal,
            issueWriteCapability() {
              throw new Error("unused fixture capability");
            },
          }),
      }),
  },
};
const master = randomBytes(32),
  masterKey = master.toString("base64"),
  canary = "sealed-private-canary-λ";
wiring.runtime = runtime;
wiring.masterKey = masterKey;
// Load the real router/middleware; only their singleton fixture adapters are redirected.
const { kbSealedRouter } = await import(
  pathToFileURL(resolve(import.meta.dirname, "../../../api/src/routers/kb-sealed.ts")).href
);
const { createRouterClient } = await import(
  pathToFileURL(
    resolve(import.meta.dirname, "../../../api/node_modules/@orpc/server/dist/index.mjs"),
  ).href
);
const actor = (userId: string) => ({ kind: "browser" as const, userId });
async function user() {
  return prisma.user.create({
    data: {
      name: "Fixture",
      email: `${randomUUID()}@example.invalid`,
      emailVerified: true,
      twoFactorEnabled: true,
    },
  });
}
async function setup() {
  const owner = await user(),
    other = await user();
  const kb = await prisma.knowledgeBase.create({
    data: {
      ownerId: owner.id,
      name: "Sealed fixture",
      slug: `sealed-${randomUUID().slice(0, 8)}`,
      description: "Sealed fixture description",
      state: "CREATING",
    },
  });
  const recordId = randomUUID();
  const base = await writeInitialMainCommit(
    { reposDir, kbId: kb.id, executor },
    {
      message: "fixture",
      description: "Fixture description",
    },
  );
  await prisma.knowledgeBase.update({
    where: { id: kb.id },
    data: { state: "ACTIVE", headSha: base },
  });
  setKbRecoveryComplete(true);
  runtime.ratePort = createMemoryRatePort();
  const input = {
    kbId: kb.id,
    namespace: remoteSealedNamespace(runtime.canonicalOrigin, kb.id),
    plaintext: canary,
    recordId,
    idempotencyKey: randomUUID(),
  };
  const enroll = (patch: Partial<typeof input> = {}, principal: Principal = actor(owner.id)) =>
    enrollSealedRecord(runtime, principal, { ...input, ...patch }, masterKey);
  return { owner, other, kbId: kb.id, base, input, enroll, repo: kbBareRepoPath(reposDir, kb.id) };
}
function approval(kbId: string, reference: string) {
  const { publicKey } = generateKeyPairSync("x25519");
  return {
    kbId,
    reference,
    consumerKind: "pat" as const,
    consumerId: randomUUID(),
    recipientKeyId: randomUUID(),
    recipientPublicKey: publicKey
      .export({ format: "der", type: "spki" })
      .subarray(-32)
      .toString("base64"),
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    idempotencyKey: randomUUID(),
  };
}
async function apply(
  kbId: string,
  userId: string,
  baseRevision: string,
  markdown: string,
  path = "sealed.md",
  op: "create" | "replace" = "create",
) {
  const request = {
    mode: "edit" as const,
    baseRevision,
    title: "fixture",
    changes: [{ op, path, content: { markdown } }],
    sourceSessionIds: [],
  };
  const publication = createChangesPublication({
    store: prismaAuthorityStore(prisma),
    principal: actor(userId),
    reposDir,
    kbId,
    canonicalOrigin: runtime.canonicalOrigin,
    idempotencyKey: randomUUID(),
    request,
    operation: "CHANGES_APPLY",
    requestHash: canonicalRequestHash(request),
  });
  return (await runtime.coordinator.run({
    opId: randomUUID(),
    kind: "git-write",
    kbIds: [kbId],
    barrier: publication.barrier,
    run: ({ lease }) => publication.publish(lease, executor),
  })) as ApplyResult;
}
async function denied(result: Promise<unknown>, code: string) {
  await expect(result).rejects.toMatchObject({ code });
}
type Fixture = Awaited<ReturnType<typeof setup>>;
const rowFor = (f: Fixture) => prisma.sealedRecord.findFirstOrThrow({ where: { kbId: f.kbId } });
const grantCount = (f: Fixture) =>
  prisma.sealedConsumerGrant.count({ where: { namespace: f.input.namespace } });
const readSource = (f: Fixture, sha: string) =>
  readDocumentAtRevision({ reposDir, kbId: f.kbId, commitSha: sha, path: "sealed.md" });
/** pat/oauth approvals bind to a real grant generation (foreign key); create it on demand. */
async function ensureConsumerGrant(ownerId: string, kind: string, consumerId: string) {
  if (kind === "local" || !/^[0-9a-f-]{36}$/.test(consumerId)) return;
  await prisma.mcpGrant.upsert({
    where: { id: consumerId },
    update: {},
    create: {
      id: consumerId,
      actorUserIdSnapshot: ownerId,
      userId: ownerId,
      kind: kind === "oauth" ? "OAUTH" : "PAT",
      clientId: `fixture:${consumerId}`,
      referenceId: "fixture",
      scopes: ["mcp:read"],
      toolGroups: ["read", "sealed"],
      createdKbBits: [],
    },
  });
}
const grantAs = async (
  f: Fixture,
  input: Parameters<typeof grantSealedRecord>[2],
  userId = f.owner.id,
) => {
  await ensureConsumerGrant(f.owner.id, input.consumerKind, input.consumerId);
  return grantSealedRecord(runtime, actor(userId), input);
};
const revoke = (f: Fixture, reference: string, idempotencyKey = randomUUID()) =>
  revokeSealedRecord(runtime, actor(f.owner.id), { kbId: f.kbId, reference, idempotencyKey });
const merge = (f: Fixture, p: ApplyResult, selectedRuntime = runtime) =>
  mutatePullRequest(selectedRuntime, f.owner.id, {
    kind: "review",
    kbId: f.kbId,
    number: p.proposal!.number,
    expectedHeadSha: p.commitSha,
    expectedTargetSha: f.base,
    decision: "merge",
    confirm: "MERGE",
    idempotencyKey: randomUUID(),
  });
afterAll(async () => {
  await prisma.$disconnect();
  await db.close();
  await cluster.close();
  rmSync(reposDir, { recursive: true, force: true });
});

describe("sealed real authority, PostgreSQL and Git", () => {
  it("runs Rust host/projection and noop/merge ledger checks through production MCP with real PAT admission", async () => {
    const { createMcpEndpoint } = await import(
      new URL("../../../../apps/server/src/mcp/handler.ts", import.meta.url).href
    );
    const { createBearerAdmission } = await import(
      new URL("../../../../apps/server/src/mcp/auth.ts", import.meta.url).href
    );
    const { createAdmissionGate } = await import(
      new URL("../../../../apps/server/src/mcp/admission.ts", import.meta.url).href
    );
    let endpoint:
      | { fetch(request: Request): Promise<Response>; close(): Promise<void> }
      | undefined;
    const replies: unknown[] = [];
    const faults: string[] = [];
    const log = captureLog();
    const http = createServer((req, res) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const bytes = Buffer.concat(chunks);
        const request = JSON.parse(bytes.toString("utf8"));
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers))
          if (typeof value === "string") headers.set(key, value);
        if (!endpoint) throw new Error("fixture endpoint unavailable");
        const response = await endpoint.fetch(
          new Request(`${runtime.canonicalOrigin}/mcp`, { method: "POST", headers, body: bytes }),
        );
        const body = (await response.json()) as {
          result: {
            structuredContent: { schemaVersion: string; data: { kind: string; commitSha: string } };
            content: { text: string }[];
          };
        };
        // Mutate an actual production noop after dispatch to exercise the remote-response boundary.
        if (request.params?.arguments?.title === "fault-noop") {
          const envelope = body.result.structuredContent;
          expect(envelope.data.kind).toBe("noop");
          envelope.data.commitSha = "f".repeat(40);
          body.result.content[0]!.text = JSON.stringify(envelope);
          faults.push("noop-commit");
        }
        replies.push(body);
        res.writeHead(response.status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      })().catch(() => {
        res.writeHead(500);
        res.end();
      });
    });
    const oldOrigin = runtime.canonicalOrigin;
    http.listen(0, "127.0.0.1");
    await once(http, "listening");
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("fixture port unavailable");
    runtime.canonicalOrigin = `http://127.0.0.1:${address.port}`;
    try {
      const f = await setup(),
        created = await f.enroll();
      const mint = (bits: Permission[]) =>
        mintPersonalToken(runtime, f.owner.id, {
          name: "Rust production fixture",
          scopes: ["mcp:write"],
          toolGroups: [...MCP_TOOL_GROUPS],
          acl: [{ kbId: f.kbId, bits }],
        });
      const proposer = await mint(["read", "propose"]),
        owner = await mint(["read", "write", "review"]);
      const pat = await prisma.mcpPersonalToken.findUniqueOrThrow({
        where: { id: proposer.token.id },
      });
      const { publicKey, privateKey } = generateKeyPairSync("x25519");
      const grant = {
        ...approval(f.kbId, created.reference),
        consumerId: pat.grantId,
        recipientPublicKey: publicKey
          .export({ format: "der", type: "spki" })
          .subarray(-32)
          .toString("base64"),
      };
      await grantSealedRecord(runtime, actor(f.owner.id), grant);
      await apply(f.kbId, f.owner.id, f.base, created.reference);
      const gate = createAdmissionGate();
      endpoint = createMcpEndpoint({
        gate,
        origin: runtime.canonicalOrigin,
        admit: createBearerAdmission({
          query: prismaAssetQuery(prisma),
          origin: runtime.canonicalOrigin,
          verifyOAuth: async () => {
            throw new Error("PAT fixture only");
          },
        }),
        runtime: () => runtime,
        masterKey: () => masterKey,
      });
      const { stdout, stderr } = await promisify(execFile)(
        "cargo",
        [
          "test",
          "--locked",
          "-j3",
          "-p",
          "kb-client",
          "--test",
          "production_adapters",
          "--",
          "--ignored",
          "--test-threads=1",
        ],
        {
          cwd: resolve(import.meta.dirname, "../../../../apps/cli"),
          env: {
            ...process.env,
            CARGO_TARGET_DIR: resolve(import.meta.dirname, "../../../../apps/cli/target"),
            KB_R50_RESOURCE: `${runtime.canonicalOrigin}/mcp`,
            KB_R50_PAT: proposer.secret,
            KB_R50_OWNER_PAT: owner.secret,
            KB_R50_FIXTURE: JSON.stringify({
              kbId: f.kbId,
              reference: created.reference,
              recipientKeyId: grant.recipientKeyId,
              privateKey: [...privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32)],
              canary,
            }),
          },
          timeout: 600_000,
          maxBuffer: 1024 * 1024,
        },
      ).catch((error: unknown) => {
        if (error instanceof Error && "stdout" in error && typeof error.stdout === "string") {
          const output = [canary, proposer.secret, owner.secret].reduce(
            (text, value) => text.replaceAll(value, "[redacted fixture value]"),
            error.stdout,
          );
          throw new Error(output);
        }
        throw error;
      });
      expect(`${stdout}\n${stderr}`).toContain("1 passed; 0 failed; 0 ignored");
      expect(faults).toEqual(["noop-commit"]);
      const receipts = await prisma.operationIntent.findMany({ where: { kbId: f.kbId }, take: 20 });
      const rows = await prisma.sealedRecord.findMany({ where: { kbId: f.kbId }, take: 20 });
      const audits = await prisma.auditEvent.findMany({ where: { kbId: f.kbId }, take: 20 });
      const captured = JSON.stringify([
        stdout,
        stderr,
        replies,
        receipts,
        rows,
        audits,
        log.records,
      ]);
      for (const value of [canary, proposer.secret, owner.secret])
        expect(captured).not.toContain(value);
    } finally {
      await endpoint?.close();
      http.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        http.close((err) => (err ? reject(err) : resolve())),
      );
      runtime.canonicalOrigin = oldOrigin;
      log.restore();
    }
  }, 900_000);

  it("enrolls once on concurrent retry; keeps plaintext out of storage projections, receipts, audit and logs", async () => {
    const f = await setup();
    expect(await prisma.sealedRecord.count({ where: { kbId: f.kbId } })).toBe(0);
    const log = captureLog();
    try {
      const [a, b] = await Promise.all([f.enroll(), f.enroll()]);
      expect(a).toEqual(b);
      const row = await rowFor(f);
      expect(row.version).toBe(1);
      const literal = decryptSealedRecord(
        row.ciphertext!,
        { ...f.input, version: row.version },
        master,
      );
      literal.use((bytes) => expect(bytes.toString("utf8")).toBe(canary));
      literal.destroy();
      const audit = await prisma.auditEvent.findMany({ where: { kbId: f.kbId }, take: 20 });
      expect(audit.filter((e) => e.action === "sealed_enroll")).toHaveLength(1);
      const receipts = await prisma.operationIntent.findMany({ where: { kbId: f.kbId }, take: 20 });
      expect(JSON.stringify([a, row, audit, receipts, log.records])).not.toContain(canary);
      await denied(f.enroll({ plaintext: "different" }), "IDEMPOTENCY_MISMATCH");
      await denied(f.enroll({ idempotencyKey: randomUUID() }), "CONFLICT");
      const automatic = await f.enroll({ recordId: undefined, idempotencyKey: randomUUID() });
      expect(automatic.reference).not.toBe(a.reference);
    } finally {
      log.restore();
    }
  });
  it("rejects foreign namespace, wrong authorizer, manage-only, token owner and stale identity", async () => {
    const f = await setup();
    await prisma.kbShare.create({ data: { kbId: f.kbId, userId: f.other.id, bits: ["manage"] } });
    await expect(f.enroll({}, actor(f.other.id))).rejects.toThrow();
    await denied(f.enroll({ namespace: randomUUID() }), "UNRESOLVED_REFERENCE");
    const token = {
      kind: "token" as const,
      userId: f.owner.id,
      grantId: randomUUID(),
      grantGeneration: randomUUID(),
      scopes: ["mcp:write"],
      expiresAt: new Date(Date.now() + 60000),
      storedAcl: new Map([[f.kbId, ["manage"]]]),
    };
    await denied(f.enroll({}, token), "FORBIDDEN");
    await prisma.user.update({ where: { id: f.owner.id }, data: { banned: true } });
    await expect(f.enroll()).rejects.toThrow();
    await prisma.user.update({
      where: { id: f.owner.id },
      data: { banned: false, role: "admin", createdAt: new Date(0), twoFactorEnabled: false },
    });
    await expect(f.enroll()).rejects.toThrow();
    expect(await prisma.sealedRecord.count({ where: { kbId: f.kbId } })).toBe(0);
  });
  it("pins each exact consumer/key/expiry, rejects substitutions and dead grants, and never resurrects a revoked version", async () => {
    const f = await setup(),
      created = await f.enroll();
    const grant = approval(f.kbId, created.reference);
    const first = await grantAs(f, grant);
    expect(await grantAs(f, grant)).toEqual(first);
    expect(
      await prisma.sealedConsumerGrant.findFirst({
        where: { namespace: f.input.namespace, recordId: f.input.recordId },
      }),
    ).toMatchObject({
      consumerId: grant.consumerId,
      recipientKeyId: grant.recipientKeyId,
      recipientPublicKey: grant.recipientPublicKey,
      expiresAt: new Date(grant.expiresAt),
    });
    for (const change of [
      { recipientPublicKey: approval(f.kbId, created.reference).recipientPublicKey },
      { expiresAt: new Date(Date.now() + 7200000).toISOString() },
    ])
      await denied(
        grantAs(f, {
          ...grant,
          ...change,
          idempotencyKey: randomUUID(),
        }),
        "CONFLICT",
      );
    await expect(grantAs(f, grant, f.other.id)).rejects.toThrow();
    await expect(grantAs(f, { ...grant, consumerId: "*" })).rejects.toThrow();
    for (const patch of [
      { recipientPublicKey: Buffer.alloc(32).toString("base64") },
      { expiresAt: new Date(0).toISOString() },
    ])
      await expect(
        grantAs(f, { ...grant, ...patch, idempotencyKey: randomUUID() }),
      ).rejects.toThrow();
    const revoke = { kbId: f.kbId, reference: created.reference, idempotencyKey: randomUUID() };
    const revoked = await revokeSealedRecord(runtime, actor(f.owner.id), revoke);
    expect(await revokeSealedRecord(runtime, actor(f.owner.id), revoke)).toEqual(revoked);
    await denied(f.enroll(), "UNRESOLVED_REFERENCE");
    await denied(grantAs(f, grant), "UNRESOLVED_REFERENCE");
    await denied(f.enroll({ idempotencyKey: randomUUID() }), "CONFLICT");
    expect(await rowFor(f)).toMatchObject({
      ciphertext: null,
      version: 1,
      revokedAt: expect.any(Date),
    });
    expect(await grantCount(f)).toBe(0);
  });
  it("serializes grant/revoke races and a failed rate admission leaves no record", async () => {
    const f = await setup(),
      created = await f.enroll();
    const outcomes = await Promise.allSettled([
      grantAs(f, approval(f.kbId, created.reference)),
      revoke(f, created.reference),
    ]);
    expect(outcomes[1]!.status).toBe("fulfilled");
    expect(await grantCount(f)).toBe(0);
    runtime.ratePort = { consume: async () => ({ unavailable: true }) };
    await expect(
      f.enroll({ recordId: randomUUID(), idempotencyKey: randomUUID() }),
    ).rejects.toThrow();
    expect(await prisma.sealedRecord.count({ where: { kbId: f.kbId } })).toBe(1);
  });
  it("publishes live symbols unchanged, rejects cross-KB copies on direct/proposal writes, and allows explicit re-enrollment", async () => {
    const f = await setup(),
      target = await setup(),
      created = await f.enroll();
    const direct = await apply(f.kbId, f.owner.id, f.base, created.reference);
    expect((await readSource(f, direct.commitSha)).markdown).toBe(created.reference);
    await prisma.kbShare.create({
      data: { kbId: target.kbId, userId: target.other.id, bits: ["propose"] },
    });
    for (const userId of [target.owner.id, target.other.id]) {
      await expect(apply(target.kbId, userId, target.base, created.reference)).rejects.toThrow();
      expect(readHeadSha(target.repo)).toBe(target.base);
      expect(await prisma.pullRequest.count({ where: { kbId: target.kbId } })).toBe(0);
    }
    const destination = await target.enroll({ recordId: f.input.recordId });
    expect(parseSealedReference(destination.reference).namespace).not.toBe(
      parseSealedReference(created.reference).namespace,
    );
    expect(
      (await apply(target.kbId, target.owner.id, target.base, destination.reference)).kind,
    ).toBe("applied");
  });
  it("rechecks sealed authority for merge and rejects dead symbols anywhere in direct/proposal trees", async () => {
    const f = await setup(),
      created = await f.enroll();
    await prisma.kbShare.create({ data: { kbId: f.kbId, userId: f.other.id, bits: ["propose"] } });
    const proposal = await apply(f.kbId, f.other.id, f.base, created.reference);
    const read = {
      ...runtime,
      store: prismaAuthorityStore(prisma),
      principal: actor(f.other.id),
      query: prismaAssetQuery(prisma),
    };
    const selector = { kbId: f.kbId, number: proposal.proposal!.number };
    expect((await getPullRequest(read, selector)).pr.status).toBe("OPEN");
    const generation = (await prisma.knowledgeBase.findUniqueOrThrow({ where: { id: f.kbId } }))
      .sealedPolicyGeneration;
    await revoke(f, created.reference);
    expect(readHeadSha(f.repo)).toBe(f.base);
    expect(
      (await prisma.knowledgeBase.findUniqueOrThrow({ where: { id: f.kbId } }))
        .sealedPolicyGeneration,
    ).toBe(generation + 1n);
    expect((await getPullRequest(read, selector)).pr.status).toBe("CONFLICT");
    expect((await getPullRequestConflicts(read, selector)).status).toBe("CONFLICT");
    await denied(merge(f, proposal), "CONFLICT");
    for (const userId of [f.owner.id, f.other.id])
      await expect(
        apply(
          f.kbId,
          userId,
          userId === f.owner.id ? f.base : proposal.commitSha,
          created.reference,
          "dead.md",
        ),
      ).rejects.toThrow();
    expect(readHeadSha(f.repo)).toBe(f.base);
    // The summary carries the branch label (`pr/<n>`); the Git ref lives under refs/heads/.
    expect(readRefSha(f.repo, `refs/heads/${proposal.proposal!.sourceBranch}`)).toBe(
      proposal.commitSha,
    );
    expect(await prisma.pullRequest.findFirst({ where: { kbId: f.kbId } })).toMatchObject({
      status: "CONFLICT",
    });
    expect((await readSource(f, proposal.commitSha)).markdown).toBe(created.reference);
  });
  it("the conflicts endpoint retries when sealed policy changes after refresh with unchanged heads", async () => {
    const f = await setup(),
      created = await f.enroll();
    await prisma.kbShare.create({ data: { kbId: f.kbId, userId: f.other.id, bits: ["propose"] } });
    const proposal = await apply(f.kbId, f.other.id, f.base, created.reference);
    const read = {
      ...runtime,
      store: prismaAuthorityStore(prisma),
      principal: actor(f.other.id),
      query: prismaAssetQuery(prisma),
    };
    const selector = { kbId: f.kbId, number: proposal.proposal!.number };
    expect((await getPullRequest(read, selector)).pr.status).toBe("OPEN");
    // Origin is a validation input too: an unchanged Git snapshot at another
    // configured origin cannot reuse the original namespace's OPEN result.
    expect(
      (await getPullRequest({ ...read, canonicalOrigin: "https://other.invalid" }, selector)).pr
        .status,
    ).toBe("CONFLICT");
    let revoked = false;
    const result = await getPullRequestConflicts(read, selector, {
      afterRefresh: async () => {
        if (!revoked) {
          revoked = true;
          await revoke(f, created.reference);
        }
      },
    });
    expect(result).toMatchObject({
      status: "CONFLICT",
      targetSha: f.base,
      headSha: proposal.commitSha,
    });
  });
  it("permits a live symbol through reviewed merge and leaves record authority intact", async () => {
    const f = await setup(),
      created = await f.enroll();
    await prisma.kbShare.create({ data: { kbId: f.kbId, userId: f.other.id, bits: ["propose"] } });
    const p = await apply(f.kbId, f.other.id, f.base, created.reference);
    await denied(
      merge(f, p, { ...runtime, canonicalOrigin: "https://reattached.invalid" }),
      "CONFLICT",
    );
    expect(readHeadSha(f.repo)).toBe(f.base);
    const merged = await merge(f, p);
    expect(merged.pr.status).toBe("MERGED");
    expect(readHeadSha(f.repo)).toBe(p.commitSha);
  });
  it("KB and forced-account teardown erase ciphertext and grants while preserving tombstones", async () => {
    for (const mode of ["kb", "account"] as const) {
      const f = await setup(),
        created = await f.enroll();
      await grantAs(f, approval(f.kbId, created.reference));
      if (mode === "kb")
        await deleteKnowledgeBase(runtime, f.owner.id, {
          kbId: f.kbId,
          metadataVersion: 1,
          idempotencyKey: randomUUID(),
          confirm: "DELETE",
        });
      else {
        const admin = await user();
        await prisma.user.update({ where: { id: admin.id }, data: { role: "admin" } });
        await runWithAllowedAccountDeletion("admin-force", () =>
          removeUserAccount(runtime, f.owner.id, { actingUserId: admin.id }),
        );
      }
      expect(await rowFor(f)).toMatchObject({
        ciphertext: null,
        revokedAt: expect.any(Date),
      });
      expect(await grantCount(f)).toBe(0);
      expect(await prisma.knowledgeBase.findUnique({ where: { id: f.kbId } })).toMatchObject({
        state: "TOMBSTONED",
      });
      await expect(f.enroll()).rejects.toThrow();
    }
  });
});

describe("R29a sealed control regressions", () => {
  it.each(["public-unforced", "admin-grace"])(
    "requires live enrolled 2FA for every real-router owner operation: %s",
    async (policy) => {
      const f = await setup();
      const created = await f.enroll();
      const grant = approval(f.kbId, created.reference);
      await ensureConsumerGrant(f.owner.id, "pat", grant.consumerId);
      const liveUser = await prisma.user.update({
        where: { id: f.owner.id },
        data: {
          role: policy === "admin-grace" ? "admin" : "user",
          createdAt: policy === "admin-grace" ? new Date() : new Date(0),
          twoFactorEnabled: false,
        },
      });
      // Public forcing is absent/default false. Admin forcing is default true,
      // but general admission allows its enrollment grace. A stale enrolled
      // session snapshot must also fail at the committing sealed gate.
      const client = createRouterClient(kbSealedRouter, {
        context: () => ({
          session: { user: { ...liveUser, twoFactorEnabled: policy === "public-unforced" } },
        }),
      });
      const before = await prisma.operationIntent.count({ where: { kbId: f.kbId } });
      for (const operation of [
        () => client.enroll({ ...f.input, recordId: randomUUID(), idempotencyKey: randomUUID() }),
        () => client.enroll(f.input), // replay reauthorizes, too
        () => client.grant(grant),
        () =>
          client.revoke({
            kbId: f.kbId,
            reference: created.reference,
            idempotencyKey: randomUUID(),
          }),
      ])
        await expect(operation()).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(await prisma.sealedRecord.count({ where: { kbId: f.kbId } })).toBe(1);
      expect((await rowFor(f)).ciphertext).not.toBeNull();
      expect(await grantCount(f)).toBe(0);
      expect(await prisma.operationIntent.count({ where: { kbId: f.kbId } })).toBe(before);
      await prisma.user.update({ where: { id: f.owner.id }, data: { twoFactorEnabled: true } });
      expect(await client.enroll(f.input)).toEqual(created);
      await client.grant(grant);
      expect(await grantCount(f)).toBe(1);
      expect(
        (
          await client.revoke({
            kbId: f.kbId,
            reference: created.reference,
            idempotencyKey: randomUUID(),
          })
        ).revoked,
      ).toBe(true);
    },
  );

  it("rejects remote local approvals instead of creating an unusable capability", async () => {
    const f = await setup(),
      created = await f.enroll();
    const grant = approval(f.kbId, created.reference);
    await ensureConsumerGrant(f.owner.id, "pat", grant.consumerId);
    await expect(
      grantSealedRecord(runtime, actor(f.owner.id), { ...grant, consumerKind: "local" } as never),
    ).rejects.toThrow();
    expect(await grantCount(f)).toBe(0);
  });

  it("rejects expiry precision that PostgreSQL would round up before any approval write", async () => {
    const f = await setup(),
      created = await f.enroll();
    const grant = approval(f.kbId, created.reference);
    await ensureConsumerGrant(f.owner.id, "pat", grant.consumerId);
    for (const fraction of ["1236", "123600000", "123000000"]) {
      await expect(
        grantSealedRecord(runtime, actor(f.owner.id), {
          ...grant,
          expiresAt: grant.expiresAt.replace(/\.\d{3}Z$/, `.${fraction}Z`),
        }),
      ).rejects.toThrow();
      expect(await grantCount(f)).toBe(0);
    }
    await grantAs(f, grant);
    const stored = await prisma.sealedConsumerGrant.findFirstOrThrow({
      where: { consumerId: grant.consumerId },
    });
    expect(stored.expiresAt.toISOString()).toBe(grant.expiresAt);
  });

  it("round trips the sole remote kind through real PAT admission, with exact expiry and revocation", async () => {
    const f = await setup(),
      created = await f.enroll();
    const minted = await mintPersonalToken(runtime, f.owner.id, {
      name: "Sealed recipient",
      scopes: ["mcp:read"],
      toolGroups: [...MCP_TOOL_GROUPS],
      acl: [{ kbId: f.kbId, bits: ["read"] }],
    });
    const pat = await prisma.mcpPersonalToken.findUniqueOrThrow({ where: { id: minted.token.id } });
    const grant = {
      ...approval(f.kbId, created.reference),
      consumerId: pat.grantId,
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    };
    await grantSealedRecord(runtime, actor(f.owner.id), grant);
    const published = await apply(f.kbId, f.owner.id, f.base, created.reference);
    const query = prismaAssetQuery(prisma);
    const principal = await authenticatePersonalToken(query, minted.secret, new Date());
    if (!principal) throw new Error("PAT identification failed");
    const options = { verifier: createGrantCredentialVerifier(query), masterKey };
    const request = {
      kbId: f.kbId,
      path: "sealed.md",
      rev: published.commitSha,
      reference: created.reference,
      recipientKeyId: grant.recipientKeyId,
    };
    const result = await resolveSealedReference(runtime, principal, request, options);
    expect(result.expiresAt).toBe(grant.expiresAt);
    expect(JSON.stringify(result)).not.toContain(canary);
    const cancelled = new AbortController();
    cancelled.abort();
    await denied(
      resolveSealedReference(runtime, principal, request, { ...options, signal: cancelled.signal }),
      "CANCELLED",
    );
    expect((await resolveSealedReference(runtime, principal, request, options)).reference).toBe(
      created.reference,
    );
    await denied(
      resolveSealedReference(runtime, principal, request, {
        ...options,
        beforeFinalRead: async () => {
          await revokePersonalToken(runtime, f.owner.id, minted.token.id);
        },
      }),
      "UNRESOLVED_REFERENCE",
    );
  });
});

describe("sealed recipient resolution against real SQL and pinned Git", () => {
  async function ready() {
    const f = await setup(),
      created = await f.enroll();
    const grant = approval(f.kbId, created.reference);
    await grantAs(f, grant);
    const published = await apply(f.kbId, f.owner.id, f.base, created.reference);
    const principal = {
      kind: "token" as const,
      userId: f.owner.id,
      grantId: grant.consumerId,
      grantGeneration: "1",
      scopes: ["mcp:read"],
      expiresAt: new Date(Date.now() + 3600000),
      storedAcl: new Map([[f.kbId, ["read"]]]),
    };
    // Auth-registry adapter is chunk30+: only credential admission is a fixture here.
    const verifier: SealedCredentialVerifier = {
      inspect: async () => ({
        generationActive: true,
        instanceEnabled: true,
        expired: false,
        banned: false,
        twoFactorSatisfied: true,
        consumerKind: "pat",
      }),
    };
    const input = {
      kbId: f.kbId,
      path: "sealed.md",
      rev: published.commitSha,
      reference: created.reference,
      recipientKeyId: grant.recipientKeyId,
    };
    const options = { verifier, masterKey };
    return { ...f, grant, principal, request: input, options, published };
  }
  it("resolves exact historical source, pins default main, and makes fresh ciphertext-only replies", async () => {
    const f = await ready(),
      start = Date.now();
    const first = await resolveSealedReference(
      runtime,
      f.principal,
      { ...f.request, rev: undefined },
      f.options,
    );
    const second = await resolveSealedReference(runtime, f.principal, f.request, f.options);
    expect(first.reference).toBe(f.request.reference);
    expect(first.envelope.ephemeralPublicKey).not.toBe(second.envelope.ephemeralPublicKey);
    expect(first.envelope.nonce).not.toBe(second.envelope.nonce);
    expect(Date.parse(first.expiresAt)).toBeGreaterThan(start);
    expect(Date.parse(first.expiresAt)).toBeLessThanOrEqual(Date.now() + 60000);
    await apply(
      f.kbId,
      f.owner.id,
      f.published.commitSha,
      "No reference now",
      "sealed.md",
      "replace",
    );
    await denied(
      resolveSealedReference(runtime, f.principal, { ...f.request, rev: undefined }, f.options),
      "UNRESOLVED_REFERENCE",
    );
    expect(
      (await resolveSealedReference(runtime, f.principal, f.request, f.options)).reference,
    ).toBe(f.request.reference);
    const audit = await prisma.auditEvent.findMany({ where: { kbId: f.kbId }, take: 50 });
    expect(JSON.stringify([buildKbSuccessCallToolResult(first), audit])).not.toContain(canary);
  });
  it("returns identical unresolved errors for wrong path/revision/KB/consumer/key, no grant and missing record", async () => {
    const f = await ready(),
      other = await setup();
    const attempts = [
      ...[
        { path: "index.md" },
        { path: "missing.md" },
        { rev: f.base },
        { rev: "0".repeat(40) },
        { kbId: other.kbId },
        { recipientKeyId: randomUUID() },
        { reference: f.request.reference.replace(f.input.recordId, randomUUID()) },
      ].map(
        (patch) => () =>
          resolveSealedReference(runtime, f.principal, { ...f.request, ...patch }, f.options),
      ),
      ...[
        { ...f.principal, grantId: randomUUID() },
        { ...f.principal, storedAcl: new Map() },
      ].map((principal) => () => resolveSealedReference(runtime, principal, f.request, f.options)),
      () =>
        resolveSealedReference(runtime, f.principal, f.request, {
          ...f.options,
          verifier: {
            inspect: async (p) => ({
              ...(await f.options.verifier.inspect(p)),
              consumerKind: "oauth",
            }),
          },
        }),
    ];
    const outcomes = [];
    for (const attempt of attempts) outcomes.push(...(await Promise.allSettled([attempt()])));
    for (const outcome of outcomes) {
      expect(outcome.status).toBe("rejected");
      if (outcome.status !== "rejected") throw new Error("unexpected resolution");
      expect(outcome.reason).toMatchObject({
        code: "UNRESOLVED_REFERENCE",
        message: "Unresolved reference",
      });
      expect(buildKbErrorCallToolResult(outcome.reason.code)).toEqual(
        buildKbErrorCallToolResult("UNRESOLVED_REFERENCE"),
      );
    }
    await prisma.sealedConsumerGrant.updateMany({
      where: { namespace: f.request.reference.split(":")[3] },
      data: { expiresAt: new Date(0) },
    });
    await denied(
      resolveSealedReference(runtime, f.principal, f.request, f.options),
      "UNRESOLVED_REFERENCE",
    );
    await revoke(f, f.request.reference);
    await denied(
      resolveSealedReference(runtime, f.principal, f.request, f.options),
      "UNRESOLVED_REFERENCE",
    );
  });
  it("revoke winning at final-read barrier suppresses the reply; no sleep-based race", async () => {
    const f = await ready();
    let crossed = false;
    await denied(
      resolveSealedReference(runtime, f.principal, f.request, {
        ...f.options,
        beforeFinalRead: async () => {
          await revoke(f, f.request.reference);
          crossed = true;
        },
      }),
      "UNRESOLVED_REFERENCE",
    );
    expect(crossed).toBe(true);
    expect(await grantCount(f)).toBe(0);
    expect(await rowFor(f)).toMatchObject({ ciphertext: null });
  });
  it("suppresses a reply when the real current-read share is revoked at the final barrier", async () => {
    const f = await ready();
    await prisma.kbShare.create({
      data: { kbId: f.kbId, userId: f.other.id, bits: ["read"], includeSealedValues: true },
    });
    const principal = { ...f.principal, userId: f.other.id };
    await resolveSealedReference(runtime, principal, f.request, f.options);
    await denied(
      resolveSealedReference(runtime, principal, f.request, {
        ...f.options,
        beforeFinalRead: async () => {
          await shareRevoke(runtime, f.owner.id, { kbId: f.kbId, shareUserId: f.other.id });
        },
      }),
      "UNRESOLVED_REFERENCE",
    );
  });
  it("requires exact source bytes, not stripped or partial tokens", async () => {
    const f = await ready();
    for (const source of [f.request.reference.slice(2, -2), ""]) {
      const changed = await apply(
        f.kbId,
        f.owner.id,
        readHeadSha(f.repo)!,
        source,
        "sealed.md",
        "replace",
      );
      await denied(
        resolveSealedReference(
          runtime,
          f.principal,
          { ...f.request, rev: changed.commitSha },
          f.options,
        ),
        "UNRESOLVED_REFERENCE",
      );
    }
  });
  it("a share without includeSealedValues never yields sealed access; only the owner's flag enables it", async () => {
    const f = await ready();
    const member = f.other;
    // A manage share (every permission bit) without the option.
    await prisma.kbShare.create({
      data: {
        kbId: f.kbId,
        userId: member.id,
        bits: ["manage", "write", "review", "propose", "read"],
      },
    });
    const memberGrant = { ...approval(f.kbId, f.request.reference) };
    await ensureConsumerGrant(member.id, "pat", memberGrant.consumerId);
    // Grant creation refuses a PAT whose holder has no sealed-eligible share.
    await denied(grantSealedRecord(runtime, actor(f.owner.id), memberGrant), "INVALID_ARGUMENT");
    expect(
      await prisma.sealedConsumerGrant.count({ where: { consumerId: memberGrant.consumerId } }),
    ).toBe(0);
    // Even an approval row that exists (for example issued before the flag was
    // cleared) never resolves while the share lacks the option.
    const identity = parseSealedReference(f.request.reference);
    await prisma.sealedConsumerGrant.create({
      data: {
        namespace: identity.namespace,
        recordId: identity.recordId,
        consumerKind: "pat",
        consumerId: memberGrant.consumerId,
        grantId: memberGrant.consumerId,
        recipientKeyId: memberGrant.recipientKeyId,
        recipientPublicKey: memberGrant.recipientPublicKey,
        authorizerId: f.owner.id,
        expiresAt: new Date(Date.now() + 3600000),
      },
    });
    const principal = {
      ...f.principal,
      userId: member.id,
      grantId: memberGrant.consumerId,
    };
    const request = { ...f.request, recipientKeyId: memberGrant.recipientKeyId };
    await denied(
      resolveSealedReference(runtime, principal, request, f.options),
      "UNRESOLVED_REFERENCE",
    );
    // A non-owner manager cannot turn it on for themselves.
    await denied(
      shareSetSealedValues(runtime, member.id, {
        kbId: f.kbId,
        shareUserId: member.id,
        includeSealedValues: true,
      }),
      "FORBIDDEN",
    );
    await denied(
      resolveSealedReference(runtime, principal, request, f.options),
      "UNRESOLVED_REFERENCE",
    );
    // The owner flips it: sealed access follows immediately.
    await shareSetSealedValues(runtime, f.owner.id, {
      kbId: f.kbId,
      shareUserId: member.id,
      includeSealedValues: true,
    });
    expect((await resolveSealedReference(runtime, principal, request, f.options)).reference).toBe(
      f.request.reference,
    );
    const fresh = approval(f.kbId, f.request.reference);
    await ensureConsumerGrant(member.id, "pat", fresh.consumerId);
    await grantSealedRecord(runtime, actor(f.owner.id), fresh);
    // Flipping it back off is live: the existing approval stops resolving.
    await shareSetSealedValues(runtime, f.owner.id, {
      kbId: f.kbId,
      shareUserId: member.id,
      includeSealedValues: false,
    });
    await denied(
      resolveSealedReference(runtime, principal, request, f.options),
      "UNRESOLVED_REFERENCE",
    );
  });
  it("removing a member ends the approvals bound to their PATs on that KB; reviving the share never resurrects them", async () => {
    const f = await ready();
    const member = f.other;
    const manager = await user();
    await prisma.kbShare.create({
      data: {
        kbId: f.kbId,
        userId: manager.id,
        bits: ["manage", "write", "review", "propose", "read"],
      },
    });
    await prisma.kbShare.create({
      data: { kbId: f.kbId, userId: member.id, bits: ["read"], includeSealedValues: true },
    });
    const memberGrant = approval(f.kbId, f.request.reference);
    await ensureConsumerGrant(member.id, "pat", memberGrant.consumerId);
    await grantSealedRecord(runtime, actor(f.owner.id), memberGrant);
    const principal = { ...f.principal, userId: member.id, grantId: memberGrant.consumerId };
    const request = { ...f.request, recipientKeyId: memberGrant.recipientKeyId };
    expect((await resolveSealedReference(runtime, principal, request, f.options)).reference).toBe(
      f.request.reference,
    );
    const approvalsOf = (consumerId: string) =>
      prisma.sealedConsumerGrant.count({ where: { consumerId } });
    expect(await approvalsOf(memberGrant.consumerId)).toBe(1);
    expect(await approvalsOf(f.grant.consumerId)).toBe(1);

    // A manager (not only the owner) removes the member.
    await shareRevoke(runtime, manager.id, { kbId: f.kbId, shareUserId: member.id });
    expect(await approvalsOf(memberGrant.consumerId)).toBe(0);
    // Unrelated approvals (the owner's own PAT) are untouched.
    expect(await approvalsOf(f.grant.consumerId)).toBe(1);
    expect(
      (await resolveSealedReference(runtime, f.principal, f.request, f.options)).reference,
    ).toBe(f.request.reference);
    // Even a share revived with the flag on cannot resurrect the removed approval.
    await prisma.kbShare.update({
      where: { kbId_userId: { kbId: f.kbId, userId: member.id } },
      data: { revokedAt: null, includeSealedValues: true },
    });
    await denied(
      resolveSealedReference(runtime, principal, request, f.options),
      "UNRESOLVED_REFERENCE",
    );
    // The owner can issue a fresh approval on the new share.
    const fresh = approval(f.kbId, f.request.reference);
    await ensureConsumerGrant(member.id, "pat", fresh.consumerId);
    await grantSealedRecord(runtime, actor(f.owner.id), fresh);
    expect(await approvalsOf(fresh.consumerId)).toBe(1);
  });
  it("OAuth consumers can never hold a sealed approval", async () => {
    const f = await ready();
    const oauthGrant = { ...approval(f.kbId, f.request.reference), consumerKind: "oauth" };
    await ensureConsumerGrant(f.owner.id, "oauth", oauthGrant.consumerId);
    const before = await grantCount(f);
    await expect(
      grantSealedRecord(runtime, actor(f.owner.id), oauthGrant as never),
    ).rejects.toThrow();
    expect(await grantCount(f)).toBe(before);
    // A PAT generation of the same owner still receives one.
    await grantAs(f, approval(f.kbId, f.request.reference));
    expect(await grantCount(f)).toBe(before + 1);
  });
});
