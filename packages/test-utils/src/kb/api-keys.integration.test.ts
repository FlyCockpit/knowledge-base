import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ApiKeyInadmissibleError,
  type ApiKeyMintInput,
  assertApiKeyMayDelete,
  authenticateApiKey,
  canonicalApiResource,
  describeApiKey,
  digestApiKeySecret,
  listApiKeyChildren,
  listApiKeyChildrenForOwner,
  listApiKeys,
  mintApiKey,
  mintApiKeyChild,
  revokeApiKey,
  revokeApiKeyChild,
} from "@knowledge-base/api/lib/api-keys";
import { prismaAssetQuery } from "@knowledge-base/api/lib/kb/asset-authz";
import { runLockedOperation } from "@knowledge-base/api/lib/kb/authority-lock";
import {
  createKnowledgeBaseAsGrant,
  deleteKnowledgeBase,
  getKnowledgeBaseAttachment,
  listKnowledgeBases,
} from "@knowledge-base/api/lib/kb/bases";
import { createDiskBlobStore } from "@knowledge-base/api/lib/kb/blob-store-disk";
import { createCursorSigner } from "@knowledge-base/api/lib/kb/cursor";
import type { GitMutatingExecutor } from "@knowledge-base/api/lib/kb/git-write";
import { createMemoryRatePort } from "@knowledge-base/api/lib/kb/limits";
import type { LockQuery } from "@knowledge-base/api/lib/kb/lock";
import {
  authorize,
  type KbOperation,
  prismaAuthorityStore,
} from "@knowledge-base/api/lib/kb/permissions";
import type { TokenPrincipal } from "@knowledge-base/api/lib/kb/principal";
import { setKbRecoveryComplete } from "@knowledge-base/api/lib/kb/recovery";
import type { KbRuntimeConfig } from "@knowledge-base/api/lib/kb/runtime";
import {
  authenticatePersonalToken,
  countActiveCredentials,
  createGrantCredentialVerifier,
  listGrants,
  listPersonalTokens,
  mintPersonalToken,
  revokeAllCredentials,
  revokeGrant,
  updateGrant,
} from "@knowledge-base/api/lib/mcp-token-access";
import { revokeUserMcpGrants } from "@knowledge-base/auth/ban";
import { MCP_TOOL_GROUPS } from "@knowledge-base/auth/mcp-tool-groups";
import { lockIdentityAuthority } from "@knowledge-base/db/authority-lock";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openKbPostgresClusterFromEnv } from "./index";

/**
 * REST API keys (kbk_) and their child MCP tokens against real Postgres with
 * the committed migrations: mint validation, authority = key ceiling ∩ live
 * bits on every call, the child ceilings and cap, idempotency, the revoke
 * cascade, the credential-family split and the migration's CHECKs.
 */

const bindings = vi.hoisted(() => ({ client: null as object | null, runtime: {} }));
vi.mock("@knowledge-base/db", () => ({
  default: new Proxy(
    {},
    {
      get(_target, key) {
        if (!bindings.client) throw new Error("fixture DB not ready");
        const value = Reflect.get(bindings.client, key);
        return typeof value === "function" ? value.bind(bindings.client) : value;
      },
    },
  ),
}));
vi.mock("@knowledge-base/api/lib/kb/runtime", async (original) => ({
  ...(await original<typeof import("@knowledge-base/api/lib/kb/runtime")>()),
  getKbRuntime: () => bindings.runtime,
}));
vi.mock("@knowledge-base/env/server", () => ({
  ADMIN_EMAIL: undefined,
  SIGNUP_ENABLED: true,
  env: { NODE_ENV: "test" },
}));

const {
  createBearerAdmission,
}: {
  createBearerAdmission(options: {
    query?: LockQuery;
    origin: string;
    verifyOAuth(): Promise<Record<string, unknown>>;
    credential?: "mcp" | "api_key";
  }): (request: Request, mode?: { selfRevoke?: boolean }) => Promise<{ principal: TokenPrincipal }>;
} = await import(
  pathToFileURL(resolve(import.meta.dirname, "../../../../apps/server/src/mcp/auth.ts")).href
);

const cluster = await openKbPostgresClusterFromEnv();
const db = await cluster.createDatabase();
db.applyPrismaSchema();
const prisma = db.createPrismaClient("runtime");
const reposDir = mkdtempSync(join(tmpdir(), "kb-api-keys-"));
const assetsDir = mkdtempSync(join(tmpdir(), "kb-api-keys-assets-"));
const executor: GitMutatingExecutor = {
  exec({ cwd, argv, env }) {
    execFileSync(argv[0]!, argv.slice(1), { cwd, env, stdio: "ignore" });
  },
};
const ORIGIN = "https://api-keys.example.invalid";
const RESOURCE = canonicalApiResource(ORIGIN);
const runtime: KbRuntimeConfig = {
  prisma,
  reposDir,
  assetsDir,
  blobStore: createDiskBlobStore(assetsDir),
  connectionString: db.urls.runtime,
  canonicalOrigin: ORIGIN,
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
bindings.client = prisma;
bindings.runtime = runtime;
const query = prismaAssetQuery(prisma);
/** The MCP-surface verifier (child tokens). */
const verifier = createGrantCredentialVerifier(query);
/** The REST-surface verifier (bound to the /api/v1 resource, as the admitter binds it). */
const keyVerifier = createGrantCredentialVerifier(query, undefined, { resource: RESOURCE });
const store = prismaAuthorityStore(prisma);

// KB reads (list/get) are gated on journal recovery; this database starts clean.
beforeAll(() => setKbRecoveryComplete(true));

/** A KB the key cannot reach: the same NOT_FOUND as a KB that does not exist. */
const unreachableKb = { code: "NOT_FOUND" };

afterAll(async () => {
  await prisma.$disconnect();
  await db.close();
  await cluster.close();
  rmSync(reposDir, { recursive: true, force: true });
  rmSync(assetsDir, { recursive: true, force: true });
});

const DAY = 86_400_000;
const days = (n: number) => new Date(Date.now() + n * DAY);

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

async function activeKb(ownerId: string) {
  return prisma.knowledgeBase.create({
    data: {
      ownerId,
      name: "Key fixture",
      slug: `key-${randomUUID().slice(0, 8)}`,
      description: "API key fixture description",
      state: "ACTIVE",
      headSha: "a".repeat(40),
    },
  });
}

async function share(kbId: string, userId: string, bits: string[]) {
  await prisma.kbShare.create({ data: { kbId, userId, bits } });
}

async function setShare(kbId: string, userId: string, data: { bits?: string[]; revokedAt?: Date }) {
  await prisma.kbShare.update({ where: { kbId_userId: { kbId, userId } }, data });
}

const keyInput = (patch: Partial<ApiKeyMintInput> = {}): ApiKeyMintInput => ({
  name: "automation",
  reach: "created",
  bits: ["read"],
  ...patch,
});

async function mintKey(userId: string, patch: Partial<ApiKeyMintInput> = {}) {
  const minted = await mintApiKey(runtime, userId, keyInput(patch));
  const principal = await authenticateApiKey(query, minted.secret, new Date(), RESOURCE);
  if (!principal) throw new Error("minted key did not authenticate");
  return { ...minted, principal };
}

let idem = 0;
const nextKey = () => `idem-${++idem}-${randomUUID().slice(0, 8)}`;

async function mintChild(
  principal: TokenPrincipal,
  kbId: string,
  patch: Record<string, unknown> = {},
  idempotencyKey = nextKey(),
) {
  return mintApiKeyChild(
    runtime,
    principal,
    RESOURCE,
    kbId,
    { name: "child", bits: ["read"], toolGroups: ["read"], ...patch } as never,
    idempotencyKey,
  );
}

async function childPrincipal(secret: string | null): Promise<TokenPrincipal> {
  if (!secret) throw new Error("no child secret");
  const principal = await authenticatePersonalToken(query, secret, new Date());
  if (!principal) throw new Error("child did not authenticate");
  return principal;
}

function can(principal: TokenPrincipal, kbId: string, operation: KbOperation, v = verifier) {
  return authorize({ principal, kbId, operation, store, verifier: v });
}
const keyCan = (principal: TokenPrincipal, kbId: string, operation: KbOperation) =>
  can(principal, kbId, operation, keyVerifier);

const listedIds = async (principal: TokenPrincipal) =>
  (await listKnowledgeBases(runtime, principal, { limit: 50 }, keyVerifier)).items.map(
    (kb) => kb.id,
  );

const active = async (principal: TokenPrincipal, v = verifier) =>
  (await v.inspect(principal)).generationActive;

// --- 2. mint validation -------------------------------------------------------

describe("api keys: mint validation", () => {
  it("stores only a digest, shows the secret once and audits the mint without it", async () => {
    const owner = await user();
    const kb = await activeKb(owner.id);
    const minted = await mintApiKey(
      runtime,
      owner.id,
      keyInput({ reach: "selected", kbIds: [kb.id], bits: ["write"], allowCreate: true }),
    );
    expect(minted.secret).toMatch(/^kbk_[a-z0-9]{16}_[A-Za-z0-9_-]{43}$/);
    expect(minted.key).toMatchObject({
      reach: "selected",
      bits: ["read", "propose", "write"],
      allowCreate: true,
      allowDelete: false,
      allowMintChildren: false,
      childToolGroups: ["read"],
      childAuthoringMode: null,
      kbCount: 1,
      liveChildren: 0,
    });
    expect(JSON.stringify(minted.key)).not.toContain(minted.secret);
    const row = await prisma.apiKey.findUniqueOrThrow({ where: { id: minted.key.id } });
    expect(row.secretDigest).toBe(digestApiKeySecret(minted.secret));
    const dump = await prisma.$queryRaw<{ j: string }[]>`
      SELECT row_to_json(k)::text AS j FROM "api_key" k WHERE k."userId" = ${owner.id}`;
    expect(dump.map((r) => r.j).join("\n")).not.toContain(minted.secret.slice(-43));
    // Listing never returns a secret.
    const listed = await listApiKeys(runtime, owner.id, { limit: 10 });
    expect(listed.items.map((key) => key.id)).toEqual([minted.key.id]);
    expect(JSON.stringify(listed)).not.toContain(minted.secret.slice(-43));
    expect(listed.items[0]).not.toHaveProperty("secret");
    // The grant: one API_KEY generation with the selected KB's ceiling.
    const grant = await prisma.mcpGrant.findUniqueOrThrow({
      where: { id: minted.key.grantId },
      include: { acl: true },
    });
    expect(grant).toMatchObject({ kind: "API_KEY", allowCreate: true, allKbsBits: [] });
    expect(grant.acl).toEqual([
      expect.objectContaining({ kbId: kb.id, bits: ["read", "propose", "write"] }),
    ]);
    const audit = await prisma.auditEvent.findFirstOrThrow({
      where: { action: "api_key_mint", grantIdSnapshot: minted.key.grantId },
    });
    expect(audit).toMatchObject({ actorKey: `user:${owner.id}`, outcome: "SUCCESS" });
    expect(audit.metadata).toMatchObject({ apiKeyId: minted.key.id, reach: "selected" });
    expect(JSON.stringify(audit)).not.toContain(minted.secret.slice(-43));
  });

  it("rejects (never clips) a selection above live rights and stores nothing", async () => {
    const owner = await user();
    const member = await user();
    const kb = await activeKb(owner.id);
    await share(kb.id, member.id, ["read"]);
    const refused = [
      keyInput({ reach: "selected", kbIds: [kb.id], bits: ["propose"] }),
      keyInput({ reach: "selected", kbIds: [], bits: ["read"] }),
      keyInput({ reach: "selected", bits: ["read"] }),
      keyInput({ reach: "selected", kbIds: [kb.id, kb.id], bits: ["read"] }),
      keyInput({ reach: "selected", kbIds: ["z".repeat(24)], bits: ["read"] }),
      keyInput({ reach: "all", kbIds: [kb.id], bits: ["read"] }),
      keyInput({ reach: "created", kbIds: [kb.id], bits: ["read"] }),
      keyInput({ bits: [] }),
      keyInput({ bits: ["read"], allowDelete: true }),
      keyInput({ bits: ["write"], allowDelete: true }),
      keyInput({ childToolGroups: ["sealed"] as never }),
      keyInput({ expiresAt: new Date(Date.now() - 1000) }),
      keyInput({ expiresAt: days(366) }),
    ];
    for (const input of refused)
      await expect(
        mintApiKey(runtime, member.id, input),
        JSON.stringify(input),
      ).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
    expect(await prisma.apiKey.count({ where: { userId: member.id } })).toBe(0);
    expect(await prisma.mcpGrant.count({ where: { userId: member.id } })).toBe(0);
    expect(await prisma.auditEvent.count({ where: { actorUserId: member.id } })).toBe(0);
    // The held bit is accepted; allowDelete with manage is accepted.
    await expect(
      mintApiKey(runtime, member.id, keyInput({ reach: "selected", kbIds: [kb.id] })),
    ).resolves.toBeDefined();
    await expect(
      mintApiKey(runtime, owner.id, keyInput({ bits: ["manage"], allowDelete: true })),
    ).resolves.toMatchObject({ key: { allowDelete: true } });
  });

  it("defaults expiry to 90 days, accepts up to 365, and caps live keys at 10", async () => {
    const owner = await user();
    const first = await mintApiKey(runtime, owner.id, keyInput());
    const ttl = (first.key.expiresAt.getTime() - first.key.createdAt.getTime()) / DAY;
    expect(Math.round(ttl)).toBe(90);
    const max = await mintApiKey(runtime, owner.id, keyInput({ expiresAt: days(364) }));
    expect(max.key.expiresAt.getTime()).toBeGreaterThan(days(363).getTime());
    for (let i = 0; i < 8; i += 1) await mintApiKey(runtime, owner.id, keyInput());
    await expect(mintApiKey(runtime, owner.id, keyInput())).rejects.toMatchObject({
      code: "QUOTA_EXCEEDED",
    });
    expect(await prisma.apiKey.count({ where: { userId: owner.id } })).toBe(10);
    // A revoked key frees its slot; an expired one too.
    await revokeApiKey(runtime, owner.id, first.key.id);
    await expect(mintApiKey(runtime, owner.id, keyInput())).resolves.toBeDefined();
    await prisma.apiKey.update({
      where: { id: max.key.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await expect(mintApiKey(runtime, owner.id, keyInput())).resolves.toBeDefined();
    await expect(mintApiKey(runtime, owner.id, keyInput())).rejects.toMatchObject({
      code: "QUOTA_EXCEEDED",
    });
  });
});

// --- 1. the credential families never cross ---------------------------------

describe("api keys: credential binding", () => {
  it("an API_KEY grant is admitted only for an API_KEY binding naming that key", async () => {
    const owner = await user();
    const key = await mintKey(owner.id);
    const other = await mintKey(owner.id);
    expect(await active(key.principal, keyVerifier)).toBe(true);
    const binding = key.principal.credential!;
    const { credential: _drop, ...unbound } = key.principal;
    for (const [label, principal] of [
      ["unbound", unbound],
      ["PAT binding", { ...key.principal, credential: { ...binding, kind: "PAT" as const } }],
      [
        "OAuth binding",
        {
          ...key.principal,
          credential: { kind: "OAUTH" as const, clientId: binding.clientId, resource: RESOURCE },
        },
      ],
      ["another key's id", { ...key.principal, credential: { ...binding, tokenId: other.key.id } }],
      ["another key's binding", { ...key.principal, credential: other.principal.credential }],
    ] as const) {
      expect(await active(principal as TokenPrincipal), label).toBe(false);
      await expect(
        keyCan(principal as TokenPrincipal, "x".repeat(24), "read"),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    }
  });

  it("a PAT or OAuth principal pointed at an API_KEY grant, or a key binding at a PAT grant, is inactive", async () => {
    const owner = await user();
    const key = await mintKey(owner.id);
    const pat = await mintPersonalToken(runtime, owner.id, {
      name: "pat",
      scopes: ["mcp:write"],
      authoringMode: "both",
      toolGroups: [...MCP_TOOL_GROUPS],
      acl: [],
    });
    const patPrincipal = await childPrincipal(pat.secret);
    expect(await active(patPrincipal)).toBe(true);
    const atKeyGrant = {
      ...patPrincipal,
      grantId: key.principal.grantId,
      grantGeneration: key.principal.grantId,
    };
    expect(await active(atKeyGrant)).toBe(false);
    expect(
      await active({
        ...atKeyGrant,
        credential: {
          kind: "OAUTH",
          clientId: key.principal.credential!.clientId,
          resource: `${ORIGIN}/mcp`,
        },
      }),
    ).toBe(false);
    const keyAtPat = {
      ...key.principal,
      grantId: patPrincipal.grantId,
      grantGeneration: patPrincipal.grantId,
    };
    expect(await active(keyAtPat, keyVerifier)).toBe(false);
  });

  it("the admitters split the families end to end on real rows", async () => {
    const owner = await user();
    const key = await mintKey(owner.id);
    const pat = await mintPersonalToken(runtime, owner.id, {
      name: "pat",
      scopes: ["mcp:read"],
      toolGroups: ["read"],
      acl: [],
    });
    const verifyOAuth = vi.fn(async () => ({}));
    const restAdmit = createBearerAdmission({
      query,
      origin: ORIGIN,
      verifyOAuth,
      credential: "api_key",
    });
    const mcpAdmit = createBearerAdmission({ query, origin: ORIGIN, verifyOAuth });
    const request = (secret: string) =>
      new Request(`${ORIGIN}/api/v1/kbs`, { headers: { authorization: `Bearer ${secret}` } });
    await expect(restAdmit(request(key.secret))).resolves.toMatchObject({
      principal: { credential: { kind: "API_KEY", tokenId: key.key.id } },
    });
    await expect(mcpAdmit(request(pat.secret))).resolves.toBeDefined();
    await expect(restAdmit(request(pat.secret))).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(mcpAdmit(request(key.secret))).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(mcpAdmit(request(key.secret), { selfRevoke: true })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(verifyOAuth).not.toHaveBeenCalled();
    // A revoked key no longer authenticates.
    await revokeApiKey(runtime, owner.id, key.key.id);
    await expect(restAdmit(request(key.secret))).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(await authenticateApiKey(query, key.secret, new Date(), RESOURCE)).toBeNull();
    // An already-admitted principal of the revoked key is refused by the KB
    // functions with UNAUTHORIZED (the REST app answers 401).
    await expect(
      listKnowledgeBases(runtime, key.principal, { limit: 5 }, keyVerifier),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

// --- 3. authority = ceiling ∩ live bits ---------------------------------------

describe("api keys: authority is the key ceiling ∩ live bits, rechecked", () => {
  it("selected: a share removed or downgraded is lost by the key and its existing children", async () => {
    const owner = await user();
    const member = await user();
    const kb = await activeKb(owner.id);
    const unrelated = await activeKb(member.id);
    await share(kb.id, member.id, ["write"]);
    const key = await mintKey(member.id, {
      reach: "selected",
      kbIds: [kb.id],
      bits: ["write"],
      allowMintChildren: true,
      childToolGroups: ["read", "edit"],
      childAuthoringMode: "edit",
    });
    expect(await listedIds(key.principal)).toEqual([kb.id]);
    await expect(keyCan(key.principal, kb.id, "write")).resolves.toBeDefined();
    await expect(keyCan(key.principal, unrelated.id, "read")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const child = await mintChild(key.principal, kb.id, {
      bits: ["propose"],
      toolGroups: ["read", "edit"],
      authoringMode: "edit",
    });
    const childP = await childPrincipal(child.secret);
    await expect(can(childP, kb.id, "propose")).resolves.toBeDefined();
    await expect(can(childP, kb.id, "write")).rejects.toMatchObject({ code: "FORBIDDEN" });

    // Downgrade the live share to read: the key and the child lose propose/write.
    await setShare(kb.id, member.id, { bits: ["read"] });
    await expect(keyCan(key.principal, kb.id, "read")).resolves.toMatchObject({ bits: ["read"] });
    await expect(keyCan(key.principal, kb.id, "write")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(can(childP, kb.id, "propose")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      mintChild(key.principal, kb.id, {
        bits: ["propose"],
        toolGroups: ["read", "edit"],
        authoringMode: "edit",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const got = await getKnowledgeBaseAttachment(runtime, key.principal, kb.id, keyVerifier);
    expect(got.capabilities).toEqual(["read"]);

    // Remove the share: the KB disappears for both.
    await setShare(kb.id, member.id, { revokedAt: new Date() });
    expect(await listedIds(key.principal)).toEqual([]);
    await expect(
      getKnowledgeBaseAttachment(runtime, key.principal, kb.id, keyVerifier),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(can(childP, kb.id, "read")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(mintChild(key.principal, kb.id)).rejects.toMatchObject(unreachableKb);
    expect(await prisma.mcpPersonalToken.count({ where: { parentApiKeyId: key.key.id } })).toBe(1);
  });

  it("all: every KB the owner can access now, capped at the key's bits", async () => {
    const owner = await user();
    const other = await user();
    const own = await activeKb(owner.id);
    const shared = await activeKb(other.id);
    const foreign = await activeKb(other.id);
    await share(shared.id, owner.id, ["read"]);
    const key = await mintKey(owner.id, { reach: "all", bits: ["propose"] });
    const grant = await prisma.mcpGrant.findUniqueOrThrow({ where: { id: key.key.grantId } });
    expect(grant.allKbsBits).toEqual(["read", "propose"]);
    expect(await prisma.grantKbAcl.count({ where: { grantId: key.key.grantId } })).toBe(0);
    expect((await listedIds(key.principal)).sort()).toEqual([own.id, shared.id].sort());
    await expect(keyCan(key.principal, own.id, "propose")).resolves.toBeDefined();
    // Ceiling caps ownership; live caps the ceiling.
    await expect(keyCan(key.principal, own.id, "write")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(keyCan(key.principal, shared.id, "propose")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(keyCan(key.principal, foreign.id, "read")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    // A KB that appears later is reached without touching the key.
    const later = await activeKb(owner.id);
    expect(await listedIds(key.principal)).toContain(later.id);
    // A PAT grant never gains every-KB reach (allKbsBits is API_KEY-only).
    const pat = await childPrincipal(
      (
        await mintPersonalToken(runtime, owner.id, {
          name: "p",
          scopes: ["mcp:read"],
          toolGroups: ["read"],
          acl: [],
        })
      ).secret,
    );
    await expect(can(pat, own.id, "read")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("created: the key reaches only KBs it created, appended at create time", async () => {
    setKbRecoveryComplete(true);
    const owner = await user();
    const existing = await activeKb(owner.id);
    const noCreate = await mintKey(owner.id, { bits: ["manage"] });
    const key = await mintKey(owner.id, { bits: ["manage"], allowCreate: true, allowDelete: true });
    expect(await listedIds(key.principal)).toEqual([]);
    await expect(keyCan(key.principal, existing.id, "read")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const request = {
      name: "Made by key",
      slug: `made-${randomUUID().slice(0, 8)}`,
      description: "created through a REST API key",
      idempotencyKey: nextKey(),
    };
    await expect(
      createKnowledgeBaseAsGrant(runtime, noCreate.principal, keyVerifier, request),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const created = await createKnowledgeBaseAsGrant(runtime, key.principal, keyVerifier, request);
    const kbId = (created.kb as { id: string }).id;
    const row = await prisma.knowledgeBase.findUniqueOrThrow({ where: { id: kbId } });
    expect(row.ownerId).toBe(owner.id);
    expect(await prisma.grantKbAcl.findMany({ where: { kbId } })).toEqual([
      expect.objectContaining({ grantId: key.key.grantId }),
    ]);
    expect(await listedIds(key.principal)).toEqual([kbId]);
    await expect(keyCan(key.principal, kbId, "manage")).resolves.toBeDefined();
    await expect(keyCan(noCreate.principal, kbId, "read")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect((await describeApiKey(runtime, key.principal, RESOURCE)).kbCount).toBe(1);

    // 6. Delete through the key: allowDelete + ownership + live manage.
    await expect(assertApiKeyMayDelete(runtime, key.principal, RESOURCE)).resolves.toBeUndefined();
    await expect(keyCan(key.principal, kbId, "delete")).resolves.toBeDefined();
    const deleted = await deleteKnowledgeBase(
      runtime,
      key.principal,
      {
        kbId,
        metadataVersion: row.metadataVersion,
        idempotencyKey: nextKey(),
        confirm: "DELETE",
      },
      keyVerifier,
    );
    expect(deleted.tombstoned).toBe(true);
    expect((await prisma.knowledgeBase.findUniqueOrThrow({ where: { id: kbId } })).state).toBe(
      "TOMBSTONED",
    );
    expect(await listedIds(key.principal)).toEqual([]);
  });
});

// --- 6. delete gate -----------------------------------------------------------

describe("api keys: delete gate", () => {
  it("needs allowDelete, ownership and manage in ceiling ∩ live", async () => {
    const owner = await user();
    const manager = await user();
    const kb = await activeKb(owner.id);
    await share(kb.id, manager.id, ["manage"]);
    const noDelete = await mintKey(owner.id, { reach: "all", bits: ["manage"] });
    await expect(
      assertApiKeyMayDelete(runtime, noDelete.principal, RESOURCE),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const ownerKey = await mintKey(owner.id, { reach: "all", bits: ["manage"], allowDelete: true });
    await expect(
      assertApiKeyMayDelete(runtime, ownerKey.principal, RESOURCE),
    ).resolves.toBeUndefined();
    await expect(keyCan(ownerKey.principal, kb.id, "delete")).resolves.toBeDefined();
    // A shared manager is not the owner: delete is refused even with manage.
    const managerKey = await mintKey(manager.id, {
      reach: "selected",
      kbIds: [kb.id],
      bits: ["manage"],
      allowDelete: true,
    });
    await expect(keyCan(managerKey.principal, kb.id, "manage")).resolves.toBeDefined();
    await expect(keyCan(managerKey.principal, kb.id, "delete")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    // allowDelete binds the key on the shared delete authorization itself, not
    // only on the REST pre-check: the key without it is refused there too.
    await expect(keyCan(noDelete.principal, kb.id, "manage")).resolves.toBeDefined();
    await expect(keyCan(noDelete.principal, kb.id, "delete")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    // A revoked key cannot pass the gate.
    await revokeApiKey(runtime, owner.id, ownerKey.key.id);
    await expect(
      assertApiKeyMayDelete(runtime, ownerKey.principal, RESOURCE),
    ).rejects.toBeInstanceOf(ApiKeyInadmissibleError);
  });
});

describe("api keys: a child never deletes beyond its key's allowDelete", () => {
  it("a manage + kb_admin child of a key without allowDelete cannot tombstone the KB over MCP", async () => {
    setKbRecoveryComplete(true);
    const owner = await user();
    const kb = await activeKb(owner.id);
    const toggles = {
      reach: "selected" as const,
      kbIds: [kb.id],
      bits: ["manage" as const],
      allowMintChildren: true,
      childToolGroups: ["read" as const, "kb_admin" as const],
      childAuthoringMode: "edit" as const,
    };
    const body = { bits: ["manage"], toolGroups: ["read", "kb_admin"], authoringMode: "edit" };
    const noDelete = await mintKey(owner.id, toggles);
    const child = await childPrincipal((await mintChild(noDelete.principal, kb.id, body)).secret);
    await expect(can(child, kb.id, "manage")).resolves.toBeDefined();
    await expect(can(child, kb.id, "delete")).rejects.toMatchObject({ code: "FORBIDDEN" });
    // The MCP tool's domain call (same barrier, lock-held recheck) refuses it.
    await expect(
      deleteKnowledgeBase(
        runtime,
        child,
        {
          kbId: kb.id,
          metadataVersion: kb.metadataVersion,
          idempotencyKey: nextKey(),
          confirm: "DELETE",
        },
        verifier,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await prisma.knowledgeBase.findUniqueOrThrow({ where: { id: kb.id } })).state).toBe(
      "ACTIVE",
    );
    // A child of a key WITH allowDelete may (the owner allowed it).
    const withDelete = await mintKey(owner.id, { ...toggles, allowDelete: true });
    const allowed = await childPrincipal(
      (await mintChild(withDelete.principal, kb.id, body)).secret,
    );
    await expect(can(allowed, kb.id, "delete")).resolves.toBeDefined();
  });
});

// --- 4. child mint -------------------------------------------------------------

describe("api keys: child tokens", () => {
  async function minter(patch: Partial<ApiKeyMintInput> = {}) {
    const owner = await user();
    const kb = await activeKb(owner.id);
    const key = await mintKey(owner.id, {
      reach: "selected",
      kbIds: [kb.id],
      bits: ["propose"],
      allowMintChildren: true,
      childToolGroups: ["read", "edit"],
      childAuthoringMode: "edit",
      ...patch,
    });
    return { owner, kb, key };
  }

  it("mints an ordinary PAT for one KB, audited as the key, usable on MCP", async () => {
    const { owner, kb, key } = await minter();
    const minted = await mintChild(key.principal, kb.id, {
      bits: ["propose"],
      toolGroups: ["read", "edit"],
      authoringMode: "edit",
    });
    expect(minted).toMatchObject({ replayed: false, secret: expect.stringMatching(/^kbp_/) });
    expect(minted.token).toMatchObject({
      apiKeyId: key.key.id,
      kbId: kb.id,
      bits: ["read", "propose"],
      scopes: ["mcp:read", "mcp:write"],
      toolGroups: ["read", "edit"],
      authoringMode: "edit",
    });
    const row = await prisma.mcpPersonalToken.findUniqueOrThrow({ where: { id: minted.token.id } });
    expect(row.parentApiKeyId).toBe(key.key.id);
    const grant = await prisma.mcpGrant.findUniqueOrThrow({ where: { id: row.grantId } });
    expect(grant).toMatchObject({ kind: "PAT", allowCreate: false, allKbsBits: [] });
    const audit = await prisma.auditEvent.findFirstOrThrow({
      where: { action: "api_key_child_mint", grantIdSnapshot: row.grantId },
    });
    expect(audit.actorKey).toBe(`grant:${key.key.grantId}`);
    expect(audit.actorUserId).toBe(owner.id);
    expect(audit.metadata).toMatchObject({ apiKeyId: key.key.id });
    const child = await childPrincipal(minted.secret);
    await expect(can(child, kb.id, "propose")).resolves.toBeDefined();
    expect((await describeApiKey(runtime, key.principal, RESOURCE)).liveChildren).toBe(1);
    // A child mints nothing: it is not an API-key principal.
    await expect(mintChild(child, kb.id)).rejects.toBeInstanceOf(ApiKeyInadmissibleError);
    expect(await prisma.mcpPersonalToken.count({ where: { parentApiKeyId: key.key.id } })).toBe(1);
  });

  it("refuses bits beyond the key's live reach, groups beyond the child ceiling and a wider write mode", async () => {
    const { kb, key } = await minter();
    const forbidden = [
      { bits: ["write"] },
      { bits: ["manage"] },
      { toolGroups: ["read", "export"] },
      { toolGroups: ["kb_admin"] },
      { authoringMode: "both", toolGroups: ["read", "edit"], bits: ["propose"] },
      { authoringMode: "dream", toolGroups: ["read", "edit"], bits: ["propose"] },
    ];
    for (const patch of forbidden)
      await expect(
        mintChild(key.principal, kb.id, patch),
        JSON.stringify(patch),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Sealed values are never reachable through a key (schema-level).
    await expect(
      mintChild(key.principal, kb.id, { toolGroups: ["read", "sealed"] }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(await prisma.mcpPersonalToken.count({ where: { parentApiKeyId: key.key.id } })).toBe(0);
    // Within every ceiling: accepted.
    await expect(
      mintChild(key.principal, kb.id, {
        bits: ["propose"],
        toolGroups: ["edit"],
        authoringMode: "edit",
      }),
    ).resolves.toBeDefined();
    // A KB outside the key's reach (even one the owner owns) is refused exactly
    // like a KB that does not exist: no existence oracle.
    const outside = await activeKb(key.principal.userId);
    const unreachable = await mintChild(key.principal, outside.id).catch((e: unknown) => e);
    const missing = await mintChild(key.principal, "q".repeat(24)).catch((e: unknown) => e);
    expect(unreachable).toMatchObject(unreachableKb);
    expect((unreachable as { code: string }).code).toBe((missing as { code: string }).code);
    expect(await prisma.mcpPersonalToken.count({ where: { parentApiKeyId: key.key.id } })).toBe(1);
  });

  it("write mode: a 'both' ceiling admits dream and edit; a read-only ceiling admits only read-only children", async () => {
    const both = await minter({ childAuthoringMode: "both" });
    for (const mode of ["dream", "edit", "both", null])
      await expect(
        mintChild(both.key.principal, both.kb.id, {
          bits: ["propose"],
          toolGroups: ["read", "edit"],
          authoringMode: mode,
        }),
        String(mode),
      ).resolves.toBeDefined();
    const readOnly = await minter({ childAuthoringMode: null });
    for (const mode of ["dream", "edit", "both"])
      await expect(
        mintChild(readOnly.key.principal, readOnly.kb.id, { authoringMode: mode }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const ro = await mintChild(readOnly.key.principal, readOnly.kb.id, { authoringMode: null });
    expect(ro.token).toMatchObject({ scopes: ["mcp:read"], authoringMode: null });
  });

  it("expires no later than the key: default min(90 days, key expiry)", async () => {
    const short = await minter({ expiresAt: days(10) });
    const keyExpiry = (await prisma.apiKey.findUniqueOrThrow({ where: { id: short.key.key.id } }))
      .expiresAt;
    const defaulted = await mintChild(short.key.principal, short.kb.id);
    expect(defaulted.token.expiresAt?.getTime()).toBe(keyExpiry.getTime());
    await expect(
      mintChild(short.key.principal, short.kb.id, { expiresAt: days(11) }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      mintChild(short.key.principal, short.kb.id, { expiresAt: new Date(Date.now() - 1000) }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      mintChild(short.key.principal, short.kb.id, { expiresAt: days(5) }),
    ).resolves.toBeDefined();
    const long = await minter({ expiresAt: days(300) });
    const ninety = await mintChild(long.key.principal, long.kb.id);
    const ttl = ((ninety.token.expiresAt?.getTime() ?? 0) - ninety.token.createdAt.getTime()) / DAY;
    expect(Math.round(ttl)).toBe(90);
  });

  it("allowMintChildren=false is FORBIDDEN and stores nothing", async () => {
    const { kb, key } = await minter({ allowMintChildren: false });
    await expect(mintChild(key.principal, kb.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await prisma.mcpPersonalToken.count({ where: { parentApiKeyId: key.key.id } })).toBe(0);
  });

  it("children do not count toward the 10-PAT cap", async () => {
    const { owner, kb, key } = await minter();
    const pat = () =>
      mintPersonalToken(runtime, owner.id, {
        name: "p",
        scopes: ["mcp:read"],
        toolGroups: ["read"],
        acl: [],
      });
    for (let i = 0; i < 9; i += 1) await pat();
    for (let i = 0; i < 3; i += 1) await mintChild(key.principal, kb.id);
    await expect(pat()).resolves.toBeDefined();
    await expect(pat()).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    // ...and a full PAT cap never blocks a child.
    await expect(mintChild(key.principal, kb.id)).resolves.toBeDefined();
    const listed = await listPersonalTokens(runtime, owner.id, { limit: 50 });
    expect(listed.items).toHaveLength(10);
    expect(await countActiveCredentials(runtime, owner.id)).toEqual({
      tokens: 10,
      apps: 0,
      apiKeys: 1,
    });
  });

  it("enforces the per-key cap from the live instance setting; a refused mint stores nothing", async () => {
    const setting = "kb.limits.childTokensPerApiKey";
    await prisma.appSetting.upsert({
      where: { key: setting },
      create: { key: setting, value: "2" },
      update: { value: "2" },
    });
    try {
      const { owner, kb, key } = await minter();
      const first = await mintChild(key.principal, kb.id);
      await mintChild(key.principal, kb.id);
      const retryKey = nextKey();
      await expect(mintChild(key.principal, kb.id, {}, retryKey)).rejects.toMatchObject({
        code: "QUOTA_EXCEEDED",
      });
      expect(await prisma.mcpPersonalToken.count({ where: { parentApiKeyId: key.key.id } })).toBe(
        2,
      );
      expect(await prisma.mcpPersonalToken.count({ where: { idempotencyKey: retryKey } })).toBe(0);
      // The cap is per key: another key of the same owner is unaffected.
      const sibling = await mintKey(owner.id, {
        reach: "selected",
        kbIds: [kb.id],
        allowMintChildren: true,
      });
      await expect(mintChild(sibling.principal, kb.id)).resolves.toBeDefined();
      // Free a slot (revoke one child): the same Idempotency-Key now succeeds.
      await revokeApiKeyChild(
        runtime,
        { principal: key.principal, resource: RESOURCE },
        first.token.id,
      );
      const retried = await mintChild(key.principal, kb.id, {}, retryKey);
      expect(retried.replayed).toBe(false);
      expect(retried.secret).toMatch(/^kbp_/);
      // Raising the setting applies at once.
      await prisma.appSetting.update({ where: { key: setting }, data: { value: "3" } });
      await expect(mintChild(key.principal, kb.id)).resolves.toBeDefined();
    } finally {
      await prisma.appSetting.deleteMany({ where: { key: setting } });
    }
  });

  it("each mint tombstones the key's expired children (listed as expired), keeping history bounded", async () => {
    const { kb, key } = await minter();
    const old = await mintChild(key.principal, kb.id);
    await prisma.mcpPersonalToken.update({
      where: { id: old.token.id },
      data: { expiresAt: new Date(Date.now() - DAY) },
    });
    await mintChild(key.principal, kb.id);
    const swept = await prisma.mcpPersonalToken.findUniqueOrThrow({
      where: { id: old.token.id },
      include: { grant: true },
    });
    expect(swept.revokedAt).not.toBeNull();
    expect(swept.grant.revokedAt).not.toBeNull();
    expect(swept.grant.revokeReason).toBe("expired");
    const listed = await listApiKeyChildren(runtime, key.principal, RESOURCE, { limit: 50 });
    const row = listed.items.find((item) => item.id === old.token.id);
    expect(row?.revokedAt).toBeNull();
    expect(row?.expiresAt?.getTime()).toBeLessThan(Date.now());
    expect(
      await prisma.mcpPersonalToken.count({
        where: { parentApiKeyId: key.key.id, revokedAt: null },
      }),
    ).toBe(1);
  });

  it("charges every mint (not a replay) to the key's hourly budget; a refusal stores nothing", async () => {
    const { kb, key } = await minter();
    const consume = vi.fn(async () => ({ retryAfterSeconds: 42 }) as const);
    const limited = { ...runtime, ratePort: { consume } };
    const k = nextKey();
    const call = () =>
      mintApiKeyChild(
        limited,
        key.principal,
        RESOURCE,
        kb.id,
        { name: "child", bits: ["read"], toolGroups: ["read"] },
        k,
      );
    await expect(call()).rejects.toMatchObject({ code: "RATE_LIMITED", retryAfterSeconds: 42 });
    expect(consume).toHaveBeenCalledWith("kb:child-mint", `apikey:${key.key.id}`, 1);
    expect(await prisma.mcpPersonalToken.count({ where: { parentApiKeyId: key.key.id } })).toBe(0);
    // After the wait the same key mints; a replay is not charged again.
    consume.mockResolvedValue({ ok: true } as never);
    await expect(call()).resolves.toMatchObject({ replayed: false });
    const calls = consume.mock.calls.length;
    await expect(call()).resolves.toMatchObject({ replayed: true, secret: null });
    expect(consume.mock.calls.length).toBe(calls);
  });

  it("replays the same Idempotency-Key with the same token and no secret; a different body is a mismatch", async () => {
    const { kb, key } = await minter();
    const k = nextKey();
    const body = { bits: ["propose"], toolGroups: ["read", "edit"], authoringMode: "edit" };
    const first = await mintChild(key.principal, kb.id, body, k);
    const again = await mintChild(key.principal, kb.id, body, k);
    expect(again).toEqual({ token: first.token, secret: null, replayed: true });
    expect(await prisma.mcpPersonalToken.count({ where: { parentApiKeyId: key.key.id } })).toBe(1);
    await expect(
      mintChild(key.principal, kb.id, { ...body, name: "different" }, k),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_MISMATCH" });
    const otherKb = await activeKb(key.principal.userId);
    await expect(mintChild(key.principal, otherKb.id, body, k)).rejects.toMatchObject({
      code: "IDEMPOTENCY_MISMATCH",
    });
    // Two explicit expiries are two different requests (a Date must not hash as {}).
    const dated = nextKey();
    await mintChild(key.principal, kb.id, { ...body, expiresAt: days(30) }, dated);
    await expect(
      mintChild(key.principal, kb.id, { ...body, expiresAt: days(1) }, dated),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_MISMATCH" });
    // A refused body under a fresh key stores nothing; a valid one then succeeds with that key.
    const fresh = nextKey();
    await expect(mintChild(key.principal, kb.id, { bits: ["write"] }, fresh)).rejects.toMatchObject(
      {
        code: "FORBIDDEN",
      },
    );
    await expect(mintChild(key.principal, kb.id, {}, fresh)).resolves.toMatchObject({
      replayed: false,
    });
  });

  it("lists and revokes only the key's own children", async () => {
    const { owner, kb, key } = await minter();
    const other = await minter();
    const mine = await mintChild(key.principal, kb.id);
    const theirs = await mintChild(other.key.principal, other.kb.id);
    const listed = await listApiKeyChildren(runtime, key.principal, RESOURCE, { limit: 10 });
    expect(listed.items.map((item) => item.id)).toEqual([mine.token.id]);
    expect(
      (await listApiKeyChildren(runtime, key.principal, RESOURCE, { kbId: other.kb.id })).items,
    ).toEqual([]);
    await expect(
      revokeApiKeyChild(runtime, { principal: key.principal, resource: RESOURCE }, theirs.token.id),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      revokeApiKeyChild(runtime, { userId: owner.id, apiKeyId: other.key.key.id }, theirs.token.id),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      listApiKeyChildrenForOwner(runtime, owner.id, other.key.key.id, {}),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await revokeApiKeyChild(runtime, { userId: owner.id, apiKeyId: key.key.id }, mine.token.id);
    expect(await active(await childPrincipal(theirs.secret))).toBe(true);
    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { action: "api_key_child_revoke", actorUserId: owner.id },
    });
    expect(event.actorKey).toBe(`user:${owner.id}`);
  });
});

// --- 5. cascade ----------------------------------------------------------------

describe("api keys: revocation cascade", () => {
  async function keyWithChildren(n: number) {
    const owner = await user();
    const kb = await activeKb(owner.id);
    const key = await mintKey(owner.id, {
      reach: "selected",
      kbIds: [kb.id],
      allowMintChildren: true,
    });
    const children = [];
    for (let i = 0; i < n; i += 1) {
      const minted = await mintChild(key.principal, kb.id);
      children.push({ ...minted, principal: await childPrincipal(minted.secret) });
    }
    for (const child of children) expect(await active(child.principal)).toBe(true);
    return { owner, kb, key, children };
  }

  it("revoking the key tombstones every child token and grant, each audited", async () => {
    const { owner, kb, key, children } = await keyWithChildren(3);
    await expect(revokeApiKey(runtime, owner.id, key.key.id)).resolves.toEqual({
      id: key.key.id,
      revoked: true,
      children: 3,
    });
    for (const child of children) {
      const row = await prisma.mcpPersonalToken.findUniqueOrThrow({
        where: { id: child.token.id },
        include: { grant: true },
      });
      expect(row.revokedAt).not.toBeNull();
      expect(row.grant.revokedAt).not.toBeNull();
      expect(row.grant.revokeReason).toBe("api_key_revoke");
      expect(await active(child.principal)).toBe(false);
      await expect(can(child.principal, kb.id, "read")).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
    }
    const events = await prisma.auditEvent.findMany({
      where: {
        action: "api_key_child_revoke",
        grantIdSnapshot: { in: children.map((c) => c.token.grantId) },
      },
      // pagination:audited — bounded by the three children
      take: 10,
    });
    expect(events).toHaveLength(3);
    expect(new Set(events.map((e) => e.opId)).size).toBe(3);
    expect(
      (await prisma.apiKey.findUniqueOrThrow({ where: { id: key.key.id } })).revokedAt,
    ).not.toBeNull();
    expect(await active(key.principal, keyVerifier)).toBe(false);
    // Idempotent: a second revoke cascades nothing more.
    await expect(revokeApiKey(runtime, owner.id, key.key.id)).resolves.toMatchObject({
      children: 0,
    });
    // Another user cannot revoke (or learn of) the key.
    const stranger = await user();
    await expect(revokeApiKey(runtime, stranger.id, key.key.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("revocation is one set-based statement over the key's untombstoned children, expired ones included", async () => {
    const { owner, key, children } = await keyWithChildren(2);
    // Simulate a long history: many children that expired untombstoned.
    const [first] = children;
    const historic = await prisma.mcpPersonalToken.findUniqueOrThrow({
      where: { id: first!.token.id },
    });
    await prisma.mcpPersonalToken.update({
      where: { id: historic.id },
      data: { expiresAt: new Date(Date.now() - DAY) },
    });
    await expect(revokeApiKey(runtime, owner.id, key.key.id)).resolves.toMatchObject({
      children: 2,
    });
    const expired = await prisma.mcpPersonalToken.findUniqueOrThrow({
      where: { id: historic.id },
      include: { grant: true },
    });
    expect(expired.revokedAt).not.toBeNull();
    expect(expired.grant.revokeReason).toBe("api_key_revoke");
    expect(await active(first!.principal)).toBe(false);
    const live = await prisma.mcpPersonalToken.findUniqueOrThrow({
      where: { id: children[1]!.token.id },
      include: { grant: true },
    });
    expect(live.revokedAt).not.toBeNull();
    expect(live.grant.revokeReason).toBe("api_key_revoke");
    const audit = await prisma.auditEvent.findFirstOrThrow({
      where: { action: "api_key_child_revoke", grantIdSnapshot: live.grantId },
    });
    expect(audit.actorKey).toBe(`user:${owner.id}`);
    expect(audit.metadata).toMatchObject({ apiKeyId: key.key.id, reasonCode: "api_key_revoke" });
  });

  it("the key's expiry alone (no tombstone) ends every child", async () => {
    const { kb, key, children } = await keyWithChildren(2);
    await prisma.apiKey.update({
      where: { id: key.key.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    for (const child of children) {
      const row = await prisma.mcpPersonalToken.findUniqueOrThrow({
        where: { id: child.token.id },
      });
      expect(row.revokedAt).toBeNull();
      expect(await active(child.principal)).toBe(false);
      await expect(can(child.principal, kb.id, "read")).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
    }
    expect(await active(key.principal, keyVerifier)).toBe(false);
  });

  it("a tombstoned key grant (row not yet marked) also ends its children", async () => {
    const { key, children } = await keyWithChildren(1);
    await prisma.mcpGrant.update({
      where: { id: key.key.grantId },
      data: { revokedAt: new Date() },
    });
    expect(await active(children[0]!.principal)).toBe(false);
  });

  it("a ban revokes the key and every child", async () => {
    const { owner, key, children } = await keyWithChildren(2);
    await prisma.$transaction(async (tx) => {
      await lockIdentityAuthority(tx);
      await tx.user.update({ where: { id: owner.id }, data: { banned: true } });
      await revokeUserMcpGrants(
        (sql, params) => tx.$executeRawUnsafe(sql, ...params),
        owner.id,
        "ban",
      );
    });
    await prisma.user.update({ where: { id: owner.id }, data: { banned: false } });
    expect(
      (await prisma.apiKey.findUniqueOrThrow({ where: { id: key.key.id } })).revokedAt,
    ).not.toBeNull();
    expect(await active(key.principal, keyVerifier)).toBe(false);
    for (const child of children) expect(await active(child.principal)).toBe(false);
    expect(await authenticateApiKey(query, key.secret, new Date(), RESOURCE)).toBeNull();
  });

  it("revoke-all includes API keys (and so their children)", async () => {
    const { owner, key, children } = await keyWithChildren(2);
    await mintPersonalToken(runtime, owner.id, {
      name: "pat",
      scopes: ["mcp:read"],
      toolGroups: ["read"],
      acl: [],
    });
    expect(await countActiveCredentials(runtime, owner.id)).toEqual({
      tokens: 1,
      apps: 0,
      apiKeys: 1,
    });
    expect(await revokeAllCredentials(runtime, owner.id)).toEqual({
      tokens: 1,
      apps: 0,
      apiKeys: 1,
    });
    expect(await countActiveCredentials(runtime, owner.id)).toEqual({
      tokens: 0,
      apps: 0,
      apiKeys: 0,
    });
    expect(await active(key.principal, keyVerifier)).toBe(false);
    for (const child of children) expect(await active(child.principal)).toBe(false);
    expect(await prisma.mcpGrant.count({ where: { userId: owner.id, revokedAt: null } })).toBe(0);
  });

  it("revoke-all revokes keys first and never walks a key's child history one by one", async () => {
    const { owner, key, children } = await keyWithChildren(2);
    // One child expired untombstoned: history the sweep must not touch.
    await prisma.mcpPersonalToken.update({
      where: { id: children[0]!.token.id },
      data: { expiresAt: new Date(Date.now() - DAY) },
    });
    const before = await prisma.auditEvent.count({ where: { action: "grant_revoke" } });
    expect(await revokeAllCredentials(runtime, owner.id)).toEqual({
      tokens: 0,
      apps: 0,
      apiKeys: 1,
    });
    // Only the key is revoked one by one (one grant_revoke row); its children
    // go with the set-based cascade, never one by one.
    expect(await prisma.auditEvent.count({ where: { action: "grant_revoke" } })).toBe(before + 1);
    expect(await active(key.principal, keyVerifier)).toBe(false);
    const expired = await prisma.mcpPersonalToken.findUniqueOrThrow({
      where: { id: children[0]!.token.id },
    });
    expect(expired.revokedAt).not.toBeNull();
    for (const child of children) expect(await active(child.principal)).toBe(false);
    const live = await prisma.mcpPersonalToken.findUniqueOrThrow({
      where: { id: children[1]!.token.id },
    });
    expect(live.revokedAt).not.toBeNull();
  });
});

// --- 8. the MCP grant controls never touch keys or children -------------------

describe("api keys: MCP grant controls", () => {
  it("updateGrant refuses key and child grants; revokeGrant refuses key grants; lists exclude both", async () => {
    const owner = await user();
    const kb = await activeKb(owner.id);
    const key = await mintKey(owner.id, {
      reach: "selected",
      kbIds: [kb.id],
      bits: ["manage"],
      allowMintChildren: true,
    });
    const child = await mintChild(key.principal, kb.id);
    const pat = await mintPersonalToken(runtime, owner.id, {
      name: "pat",
      scopes: ["mcp:read"],
      toolGroups: ["read"],
      acl: [],
    });
    const patRow = await prisma.mcpPersonalToken.findUniqueOrThrow({ where: { id: pat.token.id } });

    await expect(
      updateGrant(runtime, owner.id, { id: key.key.grantId, toolGroups: [...MCP_TOOL_GROUPS] }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      updateGrant(runtime, owner.id, {
        id: child.token.grantId,
        toolGroups: ["read", "edit", "kb_admin"],
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      updateGrant(runtime, owner.id, {
        id: child.token.grantId,
        acl: [{ kbId: kb.id, bits: ["manage"] }],
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(
      await prisma.grantKbAcl.findUniqueOrThrow({
        where: { grantId_kbId: { grantId: child.token.grantId, kbId: kb.id } },
      }),
    ).toMatchObject({ bits: ["read"] });

    await expect(revokeGrant(runtime, owner.id, key.key.grantId)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(await active(key.principal, keyVerifier)).toBe(true);

    const grants = await listGrants(runtime, owner.id, { limit: 50 });
    expect(grants.items.map((g) => g.id)).toEqual([patRow.grantId]);
    const tokens = await listPersonalTokens(runtime, owner.id, { limit: 50 });
    expect(tokens.items.map((t) => t.id)).toEqual([pat.token.id]);

    // revokeGrant on a child is allowed (it ends just that child).
    await expect(revokeGrant(runtime, owner.id, child.token.grantId)).resolves.toMatchObject({
      revoked: true,
    });
    expect(await active(key.principal, keyVerifier)).toBe(true);
  });
});

// --- 10. migration CHECKs ---------------------------------------------------------

describe("api keys: migration constraints", () => {
  it("allKbsBits only on API_KEY grants; an idempotency key only on child tokens", async () => {
    const owner = await user();
    const pat = await mintPersonalToken(runtime, owner.id, {
      name: "pat",
      scopes: ["mcp:read"],
      toolGroups: ["read"],
      acl: [],
    });
    const row = await prisma.mcpPersonalToken.findUniqueOrThrow({ where: { id: pat.token.id } });
    await expect(
      prisma.mcpGrant.update({ where: { id: row.grantId }, data: { allKbsBits: ["read"] } }),
    ).rejects.toThrow(/mcp_grant_all_kbs_bits_api_key_only/);
    await expect(
      prisma.mcpPersonalToken.update({ where: { id: row.id }, data: { idempotencyKey: "k" } }),
    ).rejects.toThrow(/mcp_personal_token_idempotency_child_only/);
    const key = await mintKey(owner.id, { reach: "all" });
    await expect(
      prisma.mcpGrant.update({ where: { id: key.key.grantId }, data: { allKbsBits: ["read"] } }),
    ).resolves.toBeDefined();
  });
});
