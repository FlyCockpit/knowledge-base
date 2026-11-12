import { execFileSync } from "node:child_process";
import { createHmac, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { reapExpiredAuthTokens } from "@knowledge-base/api/lib/auth-token-retention";
import { prismaAssetQuery } from "@knowledge-base/api/lib/kb/asset-authz";
import { remoteSealedNamespace } from "@knowledge-base/api/lib/kb/attachment";
import { runLockedOperation } from "@knowledge-base/api/lib/kb/authority-lock";
import { createKnowledgeBaseAsGrant, listKnowledgeBases } from "@knowledge-base/api/lib/kb/bases";
import { createDiskBlobStore } from "@knowledge-base/api/lib/kb/blob-store-disk";
import { type CredentialQuery, credentialQuery } from "@knowledge-base/api/lib/kb/credential-query";
import { createCursorSigner } from "@knowledge-base/api/lib/kb/cursor";
import type { GitMutatingExecutor } from "@knowledge-base/api/lib/kb/git-write";
import { createMemoryRatePort } from "@knowledge-base/api/lib/kb/limits";
import type { LockQuery } from "@knowledge-base/api/lib/kb/lock";
import { authorize, prismaAuthorityStore } from "@knowledge-base/api/lib/kb/permissions";
import type { TokenPrincipal } from "@knowledge-base/api/lib/kb/principal";
import {
  runJournalRecoverySweep,
  setKbRecoveryComplete,
} from "@knowledge-base/api/lib/kb/recovery";
import type { KbRuntimeConfig } from "@knowledge-base/api/lib/kb/runtime";
import { enrollSealedRecord, grantSealedRecord } from "@knowledge-base/api/lib/kb/sealed-records";
import {
  authenticatePersonalToken,
  countActiveCredentials,
  createGrantCredentialVerifier,
  endGrantElevation,
  generatePatSecret,
  listGrantAcl,
  listGrants,
  listPersonalTokens,
  mintPersonalToken,
  revokeAllCredentials,
  revokeGrant,
  revokePersonalToken,
  updateGrant,
} from "@knowledge-base/api/lib/mcp-token-access";
import {
  recordTwoFactorGraceStartForPolicyActivation,
  revokeLapsedTwoFactorMcpGrants,
  revokeUserMcpGrants,
} from "@knowledge-base/auth/ban";
import {
  createBootstrapDatabaseAdapter,
  rejectImpersonatedSession,
} from "@knowledge-base/auth/bootstrap";
import { createMcpConsentService } from "@knowledge-base/auth/mcp-consent";
import { MCP_TOOL_GROUPS } from "@knowledge-base/auth/mcp-tool-groups";
import type { createSessionCacheVersion as CreateSessionCacheVersion } from "@knowledge-base/auth/session-authority";
import { isTwoFactorRequirementSatisfied } from "@knowledge-base/auth/two-factor-policy";
import { lockIdentityAuthority } from "@knowledge-base/db/authority-lock";
import { betterAuth } from "better-auth";
import { admin, twoFactor } from "better-auth/plugins";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openKbPostgresClusterFromEnv } from "./index";

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

// The routers' Redis procedure budgets are isolated here; budgets have their own unit tests.
vi.mock("../../../api/src/lib/procedure-budget", () => ({
  createProcedureBudget: () => async () => {},
}));

// The Better Auth bootstrap adapter (real ban writes) imports server env.
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
    withQuery?: CredentialQuery;
    origin: string;
    verifyOAuth(): Promise<Record<string, unknown>>;
    now?: () => Date;
    identityDb?: typeof prisma;
  }): (request: Request) => Promise<{ principal: TokenPrincipal }>;
} = await import(
  pathToFileURL(resolve(import.meta.dirname, "../../../../apps/server/src/mcp/auth.ts")).href
);
const cluster = await openKbPostgresClusterFromEnv();
const db = await cluster.createDatabase();
db.applyPrismaSchema();
const prisma = db.createPrismaClient("runtime");
const reposDir = mkdtempSync(join(tmpdir(), "kb-grants-"));
const assetsDir = mkdtempSync(join(tmpdir(), "kb-grants-assets-"));
const executor: GitMutatingExecutor = {
  exec({ cwd, argv, env }) {
    execFileSync(argv[0]!, argv.slice(1), { cwd, env, stdio: "ignore" });
  },
};
const runtime: KbRuntimeConfig = {
  prisma,
  reposDir,
  assetsDir,
  blobStore: createDiskBlobStore(assetsDir),
  connectionString: db.urls.runtime,
  canonicalOrigin: "https://grants.example.invalid",
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
const { createRouterClient } = await import(
  pathToFileURL(
    resolve(import.meta.dirname, "../../../api/node_modules/@orpc/server/dist/index.mjs"),
  ).href
);
const { mcpTokensRouter } = await import(
  pathToFileURL(resolve(import.meta.dirname, "../../../api/src/routers/mcp-tokens.ts")).href
);
const { mcpGrantsRouter } = await import(
  pathToFileURL(resolve(import.meta.dirname, "../../../api/src/routers/mcp-grants.ts")).href
);
const { settingsRouter } = await import(
  pathToFileURL(resolve(import.meta.dirname, "../../../api/src/routers/settings.ts")).href
);
vi.mock("@knowledge-base/auth", () => ({ auth: { api: {} } }));
vi.mock("../../../mailer/src/index.ts", () => ({ renderInviteUser: vi.fn(), sendEmail: vi.fn() }));
const { usersRouter } = await import(
  pathToFileURL(resolve(import.meta.dirname, "../../../api/src/routers/users.ts")).href
);
const query = prismaAssetQuery(prisma);
const verifier = createGrantCredentialVerifier(query);
const store = prismaAuthorityStore(prisma);

afterAll(async () => {
  await prisma.$disconnect();
  await db.close();
  await cluster.close();
  rmSync(reposDir, { recursive: true, force: true });
  rmSync(assetsDir, { recursive: true, force: true });
});

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
      name: "Grant fixture",
      slug: `grant-${randomUUID().slice(0, 8)}`,
      description: "Grant fixture description",
      state: "ACTIVE",
      headSha: "a".repeat(40),
    },
  });
}

type MintInput = Parameters<typeof mintPersonalToken>[2];
async function mintPrincipal(userId: string, input: MintInput): Promise<TokenPrincipal> {
  const minted = await mintPersonalToken(runtime, userId, input);
  const principal = await authenticatePersonalToken(query, minted.secret, new Date());
  if (!principal) throw new Error("minted token did not authenticate");
  return principal;
}

function can(principal: TokenPrincipal, kbId: string, operation: "read" | "propose" | "write") {
  return authorize({ principal, kbId, operation, store, verifier });
}

describe("grants: PAT mint", () => {
  it("rejects control names before persistence and accepts a Unicode retry in the shared mint", async () => {
    const owner = await user();
    for (const name of ["Laptop\u0000name", "\tLaptop", "Laptop\n", "Laptop\u0085name"]) {
      await expect(
        mintPersonalToken(runtime, owner.id, {
          name,
          scopes: ["mcp:read"],
          toolGroups: [...MCP_TOOL_GROUPS],
          acl: [],
        }),
      ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
      expect(await prisma.mcpPersonalToken.count({ where: { userId: owner.id } })).toBe(0);
      expect(await prisma.mcpGrant.count({ where: { userId: owner.id } })).toBe(0);
      expect(
        await prisma.auditEvent.count({ where: { actorUserId: owner.id, action: "pat_mint" } }),
      ).toBe(0);
    }
    const minted = await mintPersonalToken(runtime, owner.id, {
      name: "  Ordinateur 日本語 💻  ",
      scopes: ["mcp:read"],
      toolGroups: [...MCP_TOOL_GROUPS],
      acl: [],
    });
    expect(minted.token.name).toBe("Ordinateur 日本語 💻");
    expect(await prisma.mcpPersonalToken.count({ where: { userId: owner.id } })).toBe(1);
  });
  it("accepts exactly one concurrent mint at the 10-token boundary and stores no secret or second ACL", async () => {
    const owner = await user();
    const kb = await activeKb(owner.id);
    const input = {
      name: "t",
      scopes: ["mcp:read" as const],
      toolGroups: [...MCP_TOOL_GROUPS],
      acl: [{ kbId: kb.id, bits: ["read" as const] }],
    };
    const secrets: string[] = [];
    for (let i = 0; i < 9; i += 1)
      secrets.push((await mintPersonalToken(runtime, owner.id, input)).secret);
    const raced = await Promise.allSettled(
      Array.from({ length: 4 }, () => mintPersonalToken(runtime, owner.id, input)),
    );
    const accepted = raced.filter((r) => r.status === "fulfilled");
    expect(accepted).toHaveLength(1);
    for (const r of raced)
      if (r.status === "rejected") expect(r.reason).toMatchObject({ code: "QUOTA_EXCEEDED" });
    secrets.push((accepted[0] as PromiseFulfilledResult<{ secret: string }>).value.secret);
    expect(await prisma.mcpPersonalToken.count({ where: { userId: owner.id } })).toBe(10);

    const dump = await prisma.$queryRaw<{ j: string }[]>`
      SELECT row_to_json(t)::text AS j FROM "mcp_personal_token" t WHERE t."userId" = ${owner.id}`;
    const text = dump.map((row) => row.j).join("\n");
    for (const secret of secrets) expect(text).not.toContain(secret);
    const columns = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'mcp_personal_token'`;
    expect(columns.map((c) => c.column_name)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/acl|bits/i)]),
    );
    // The only stored ACL: one row per grant.
    expect(await prisma.grantKbAcl.count({ where: { kbId: kb.id } })).toBe(10);
  });

  it("a duplicated secret key cannot be issued (or exposed) twice", async () => {
    const owner = await user();
    const fixed = generatePatSecret();
    const input = {
      name: "dup",
      scopes: ["mcp:read" as const],
      toolGroups: [...MCP_TOOL_GROUPS],
      acl: [],
    };
    const first = await mintPersonalToken(runtime, owner.id, input, {
      generateSecret: () => fixed,
    });
    expect(first.secret).toBe(fixed.secret);
    await expect(
      mintPersonalToken(runtime, owner.id, input, { generateSecret: () => fixed }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await prisma.mcpPersonalToken.count({ where: { userId: owner.id } })).toBe(1);
    expect(await prisma.mcpGrant.count({ where: { userId: owner.id } })).toBe(1);
  });

  it("rejects (never clips) a selection above live rights, and defaults to no create capability", async () => {
    const owner = await user();
    const other = await user();
    const kb = await activeKb(other.id);
    await prisma.kbShare.create({ data: { kbId: kb.id, userId: owner.id, bits: ["read"] } });
    await expect(
      mintPersonalToken(runtime, owner.id, {
        name: "t",
        scopes: ["mcp:write"],
        toolGroups: [...MCP_TOOL_GROUPS],
        acl: [{ kbId: kb.id, bits: ["propose"] }],
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(await prisma.mcpGrant.count({ where: { userId: owner.id } })).toBe(0);
    await mintPersonalToken(runtime, owner.id, {
      name: "t",
      scopes: ["mcp:read"],
      toolGroups: [...MCP_TOOL_GROUPS],
      acl: [],
    });
    const grant = await prisma.mcpGrant.findFirstOrThrow({ where: { userId: owner.id } });
    expect(grant).toMatchObject({ allowCreate: false, createdKbBits: [], kind: "PAT" });
    const token = await prisma.mcpPersonalToken.findFirstOrThrow({ where: { userId: owner.id } });
    const days = ((token.expiresAt?.getTime() ?? 0) - token.createdAt.getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(90);
  });
});

describe("grants: creation implies kb_admin (e2e decision 7)", () => {
  it("rejects create without kb_admin on mint and edit", async () => {
    const owner = await user();
    const kb = await activeKb(owner.id);
    const create = { allowCreate: true, createdKbBits: ["read"] as ("read" | "propose")[] };
    await expect(
      mintPersonalToken(runtime, owner.id, {
        name: "no-admin",
        scopes: ["mcp:write"],
        toolGroups: ["read", "edit"],
        acl: [],
        ...create,
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(await prisma.mcpGrant.count({ where: { userId: owner.id } })).toBe(0);
    const plain = await mintPrincipal(owner.id, {
      name: "plain",
      scopes: ["mcp:write"],
      toolGroups: ["read", "edit"],
      acl: [{ kbId: kb.id, bits: ["read"] }],
    });
    await expect(
      updateGrant(runtime, owner.id, { id: plain.grantId, ...create }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      updateGrant(runtime, owner.id, {
        id: plain.grantId,
        toolGroups: ["read", "edit", "kb_admin"],
        ...create,
      }),
    ).resolves.toMatchObject({ widened: true });
  });
});

describe("grants: effective authority = grant ceiling ∩ live bits", () => {
  it("owner with a read-only token cannot mutate; unrelated KB is invisible", async () => {
    const owner = await user();
    const kb = await activeKb(owner.id);
    const unrelated = await activeKb(owner.id);
    const principal = await mintPrincipal(owner.id, {
      name: "ro",
      scopes: ["mcp:write"],
      toolGroups: [...MCP_TOOL_GROUPS],
      acl: [{ kbId: kb.id, bits: ["read"] }],
    });
    await expect(can(principal, kb.id, "read")).resolves.toMatchObject({ bits: ["read"] });
    await expect(can(principal, kb.id, "propose")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(can(principal, unrelated.id, "read")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("mcp:read cannot mutate even with a manage ACL", async () => {
    const owner = await user();
    const kb = await activeKb(owner.id);
    const principal = await mintPrincipal(owner.id, {
      name: "manage-read-scope",
      scopes: ["mcp:read"],
      toolGroups: [...MCP_TOOL_GROUPS],
      acl: [{ kbId: kb.id, bits: ["manage"] }],
    });
    await expect(can(principal, kb.id, "read")).resolves.toBeDefined();
    await expect(can(principal, kb.id, "write")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("a granted KB removed from the live share is denied", async () => {
    const owner = await user();
    const member = await user();
    const kb = await activeKb(owner.id);
    await prisma.kbShare.create({ data: { kbId: kb.id, userId: member.id, bits: ["write"] } });
    const principal = await mintPrincipal(member.id, {
      name: "shared",
      scopes: ["mcp:write"],
      toolGroups: [...MCP_TOOL_GROUPS],
      acl: [{ kbId: kb.id, bits: ["write"] }],
    });
    await expect(can(principal, kb.id, "write")).resolves.toBeDefined();
    await prisma.kbShare.update({
      where: { kbId_userId: { kbId: kb.id, userId: member.id } },
      data: { revokedAt: new Date() },
    });
    await expect(can(principal, kb.id, "read")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("grants: creator ACL append", () => {
  const request = () => ({
    name: "Created by token",
    slug: `tok-${randomUUID().slice(0, 8)}`,
    description: "created through a creation-capable grant",
    idempotencyKey: `create-${randomUUID()}`,
  });

  it("allowCreate=false rejects before any CREATING row or intent", async () => {
    setKbRecoveryComplete(true);
    const owner = await user();
    const principal = await mintPrincipal(owner.id, {
      name: "nc",
      scopes: ["mcp:write"],
      toolGroups: [...MCP_TOOL_GROUPS],
      acl: [],
    });
    const kbBefore = await prisma.knowledgeBase.count();
    const intentsBefore = await prisma.operationIntent.count();
    await expect(
      createKnowledgeBaseAsGrant(runtime, principal, verifier, request()),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await prisma.knowledgeBase.count()).toBe(kbBefore);
    expect(await prisma.operationIntent.count()).toBe(intentsBefore);
  });

  it("crash/retry appends the new KB once with the selected ceiling; other grants get nothing", async () => {
    setKbRecoveryComplete(true);
    const owner = await user();
    const creator = await mintPrincipal(owner.id, {
      name: "creator",
      scopes: ["mcp:write"],
      toolGroups: [...MCP_TOOL_GROUPS],
      acl: [],
      allowCreate: true,
      createdKbBits: ["propose", "read"],
    });
    const sibling = await mintPrincipal(owner.id, {
      name: "sibling",
      scopes: ["mcp:write"],
      toolGroups: [...MCP_TOOL_GROUPS],
      acl: [],
      allowCreate: true,
      createdKbBits: ["manage", "read"],
    });
    const input = request();
    const interrupted: KbRuntimeConfig = {
      ...runtime,
      createGitExecutor: () => ({
        exec(call) {
          executor.exec(call);
          if (call.argv.includes("update-ref")) throw new Error("create interrupted");
        },
      }),
    };
    await expect(createKnowledgeBaseAsGrant(interrupted, creator, verifier, input)).rejects.toThrow(
      "create interrupted",
    );
    const intent = await prisma.operationIntent.findFirstOrThrow({
      where: { actorKey: `grant:${creator.grantId}`, idempotencyKey: input.idempotencyKey },
    });
    expect(intent.phase).toBe("COMMITTING");
    const kbId = intent.reservedKbId!;
    expect(await prisma.grantKbAcl.count({ where: { kbId } })).toBe(0);
    for (let pass = 0; pass < 2; pass += 1)
      await runJournalRecoverySweep(prisma, reposDir, assetsDir, db.urls.runtime, () => {});
    const replay = await createKnowledgeBaseAsGrant(runtime, creator, verifier, input);
    const replayAgain = await createKnowledgeBaseAsGrant(runtime, creator, verifier, input);
    expect((replay.kb as { id: string }).id).toBe(kbId);
    expect(replay.operationId).toBe(intent.opId);
    expect(replayAgain).toEqual(replay);
    expect((replay.kb as { capabilities: string[] }).capabilities).toEqual(["read", "propose"]);
    const acl = await prisma.grantKbAcl.findMany({ where: { kbId } });
    expect(acl).toHaveLength(1);
    expect(acl[0]).toMatchObject({ grantId: creator.grantId, bits: ["read", "propose"] });
    expect(await prisma.grantKbAcl.count({ where: { grantId: sibling.grantId } })).toBe(0);
    // Ownership never overrides the ceiling.
    const kb = await prisma.knowledgeBase.findUniqueOrThrow({ where: { id: kbId } });
    expect(kb.ownerId).toBe(owner.id);
    await expect(can(creator, kbId, "propose")).resolves.toBeDefined();
    await expect(can(creator, kbId, "write")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(can(sibling, kbId, "read")).rejects.toMatchObject({ code: "NOT_FOUND" });
    // A replayed private receipt still needs live permission.
    await revokeGrant(runtime, owner.id, creator.grantId);
    await expect(
      createKnowledgeBaseAsGrant(runtime, creator, verifier, input),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});

describe("grants: in-place edit (mcpGrants.updateMine)", () => {
  const grantOf = async (principal: TokenPrincipal) =>
    prisma.mcpGrant.findUniqueOrThrow({
      where: { id: principal.grantId },
      include: { acl: { orderBy: { kbId: "asc" } }, personalToken: true },
    });
  const editEvents = (grantId: string) =>
    prisma.auditEvent.findMany({
      where: {
        grantIdSnapshot: grantId,
        action: { in: ["MCP_GRANT_WIDENED", "MCP_GRANT_NARROWED"] },
      },
      orderBy: [{ createdAt: "asc" }, { action: "asc" }],
    });
  /** The next call: the same secret identified again, as every request does. */
  const nextCall = async (secret: string) => {
    const principal = await authenticatePersonalToken(query, secret, new Date());
    if (!principal) throw new Error("edited token no longer authenticates");
    return principal;
  };

  it("cannot edit another user's grant, and a missing id looks the same", async () => {
    const owner = await user();
    const intruder = await user();
    const kb = await activeKb(owner.id);
    const principal = await mintPrincipal(owner.id, {
      name: "foreign",
      scopes: ["mcp:read"],
      toolGroups: ["read"],
      acl: [{ kbId: kb.id, bits: ["read"] }],
    });
    const before = await grantOf(principal);
    for (const id of [principal.grantId, randomUUID()]) {
      await expect(
        updateGrant(runtime, intruder.id, { id, toolGroups: ["read", "edit"] }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    await expect(
      updateGrant(runtime, intruder.id, {
        id: principal.grantId,
        acl: [{ kbId: kb.id, bits: [] }],
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await grantOf(principal)).toEqual(before);
    expect(await editEvents(principal.grantId)).toEqual([]);
  });

  it("refuses widening beyond live authority (never clipped) and changes nothing", async () => {
    const owner = await user();
    const member = await user();
    const kb = await activeKb(owner.id);
    const unshared = await activeKb(owner.id);
    await prisma.kbShare.create({ data: { kbId: kb.id, userId: member.id, bits: ["read"] } });
    const principal = await mintPrincipal(member.id, {
      name: "member",
      scopes: ["mcp:read"],
      toolGroups: ["read"],
      acl: [{ kbId: kb.id, bits: ["read"] }],
    });
    const before = await grantOf(principal);
    const widenings: NonNullable<Parameters<typeof updateGrant>[2]["acl"]>[] = [
      [{ kbId: kb.id, bits: ["write"] }],
      [{ kbId: unshared.id, bits: ["read"] }],
      // A valid narrowing does not carry an invalid widening through.
      [
        { kbId: unshared.id, bits: ["read"] },
        { kbId: kb.id, bits: [] },
      ],
    ];
    for (const acl of widenings) {
      await expect(
        updateGrant(runtime, member.id, { id: principal.grantId, acl }),
      ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    }
    // Shape rules shared with minting: create needs mcp:write and read-bearing bits.
    await expect(
      updateGrant(runtime, member.id, {
        id: principal.grantId,
        allowCreate: true,
        createdKbBits: ["read"],
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(await grantOf(principal)).toEqual(before);
    expect(await editEvents(principal.grantId)).toEqual([]);
    // A share revoked after mint cannot be widened back in either.
    await prisma.kbShare.update({
      where: { kbId_userId: { kbId: kb.id, userId: member.id } },
      data: { bits: ["write"], revokedAt: new Date() },
    });
    await expect(
      updateGrant(runtime, member.id, {
        id: principal.grantId,
        acl: [{ kbId: kb.id, bits: ["write"] }],
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    // Narrowing needs no live right: removing the dead entry still works.
    await expect(
      updateGrant(runtime, member.id, { id: principal.grantId, acl: [{ kbId: kb.id, bits: [] }] }),
    ).resolves.toEqual({ id: principal.grantId, widened: false, narrowed: true });
    expect((await grantOf(principal)).acl).toEqual([]);
  });

  it("widening reaches the existing token on its next call; narrowing denies it, PAT scopes both ways", async () => {
    const owner = await user();
    const kb = await activeKb(owner.id);
    const other = await activeKb(owner.id);
    const minted = await mintPersonalToken(runtime, owner.id, {
      name: "edited",
      scopes: ["mcp:read"],
      toolGroups: ["read"],
      acl: [{ kbId: kb.id, bits: ["read"] }],
      expiresAt: null,
    });
    const first = await nextCall(minted.secret);
    await expect(can(first, kb.id, "write")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(can(first, other.id, "read")).rejects.toMatchObject({ code: "NOT_FOUND" });

    // Replacing a scope is not a pure widening: work issued with the old scope loses it.
    // Widen scopes, groups, KB bits, a new KB and create capability in one edit.
    await expect(
      updateGrant(runtime, owner.id, {
        id: first.grantId,
        scopes: ["mcp:read", "mcp:write"],
        toolGroups: ["read", "edit", "kb_admin"],
        acl: [
          { kbId: kb.id, bits: ["write"] },
          { kbId: other.id, bits: ["read"] },
        ],
        allowCreate: true,
        createdKbBits: ["read", "write"],
      }),
    ).resolves.toEqual({ id: first.grantId, widened: true, narrowed: false });
    const widened = await grantOf(first);
    expect(widened).toMatchObject({
      id: first.grantId,
      scopes: ["mcp:read", "mcp:write"],
      toolGroups: ["read", "edit", "kb_admin"],
      allowCreate: true,
      createdKbBits: ["read", "propose", "write"],
      revokedAt: null,
      personalToken: { scopes: ["mcp:read", "mcp:write"], revokedAt: null },
    });
    expect(widened.widenedAt).toBeInstanceOf(Date);
    expect(widened.acl.map((a) => [a.kbId, a.bits])).toEqual(
      [
        [kb.id, ["read", "propose", "write"]],
        [other.id, ["read"]],
      ].sort(([a], [b]) => String(a).localeCompare(String(b))),
    );
    // Same generation: the existing secret gains the access on its next call.
    const second = await nextCall(minted.secret);
    expect(second.grantId).toBe(first.grantId);
    await expect(can(second, kb.id, "write")).resolves.toBeDefined();
    await expect(can(second, other.id, "read")).resolves.toBeDefined();
    expect((await verifier.inspect(second)).toolGroups).toEqual(["read", "edit", "kb_admin"]);
    // Work admitted before the widening stays admissible (its scopes are still held).
    expect((await verifier.inspect(first)).generationActive).toBe(true);

    // Narrow everything back. Work admitted with mcp:write is denied on its next recheck.
    await expect(
      updateGrant(runtime, owner.id, {
        id: first.grantId,
        scopes: ["mcp:read"],
        toolGroups: ["read"],
        acl: [
          { kbId: kb.id, bits: ["read"] },
          { kbId: other.id, bits: [] },
        ],
        allowCreate: false,
      }),
    ).resolves.toEqual({ id: first.grantId, widened: false, narrowed: true });
    expect((await verifier.inspect(second)).generationActive).toBe(false);
    await expect(can(second, kb.id, "read")).rejects.toBeDefined();
    // The token itself stays valid at its narrowed scope.
    const third = await nextCall(minted.secret);
    expect(third.scopes).toEqual(["mcp:read"]);
    expect(await verifier.inspect(third)).toMatchObject({
      generationActive: true,
      toolGroups: ["read"],
    });
    await expect(can(third, kb.id, "read")).resolves.toBeDefined();
    await expect(can(third, kb.id, "propose")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(can(third, other.id, "read")).rejects.toMatchObject({ code: "NOT_FOUND" });
    const narrowed = await grantOf(first);
    expect(narrowed).toMatchObject({ allowCreate: false, createdKbBits: [] });
    expect(narrowed.widenedAt).toEqual(widened.widenedAt);

    // A no-op edit changes nothing and writes no event.
    await expect(
      updateGrant(runtime, owner.id, { id: first.grantId, toolGroups: ["read"] }),
    ).resolves.toEqual({ id: first.grantId, widened: false, narrowed: false });

    // Audit: one event per direction, with exactly the changed values.
    const events = await editEvents(first.grantId);
    expect(events.map((event) => [event.action, event.outcome, event.actorUserId])).toEqual([
      ["MCP_GRANT_WIDENED", "SUCCESS", owner.id],
      ["MCP_GRANT_NARROWED", "SUCCESS", owner.id],
    ]);
    const metadata = events.map((event) => event.metadata as { before: string; after: string });
    expect(JSON.parse(metadata[0]!.before)).toMatchObject({
      scopes: ["mcp:read"],
      toolGroups: ["read"],
      allowCreate: false,
      createdKbBits: [],
      acl: { [kb.id]: ["read"], [other.id]: [] },
    });
    expect(JSON.parse(metadata[0]!.after)).toMatchObject({
      scopes: ["mcp:read", "mcp:write"],
      toolGroups: ["read", "edit", "kb_admin"],
      allowCreate: true,
      acl: { [kb.id]: ["read", "propose", "write"], [other.id]: ["read"] },
    });
    expect(JSON.parse(metadata[1]!.after)).toMatchObject({
      scopes: ["mcp:read"],
      acl: { [kb.id]: ["read"], [other.id]: [] },
    });
    // The owner's list shows the widening date.
    const listed = await listGrants(runtime, owner.id, { kind: "PAT" });
    expect(listed.items.find((item) => item.id === first.grantId)?.widenedAt).toEqual(
      widened.widenedAt,
    );
  });

  it("an edit that both adds and removes writes both events in one operation", async () => {
    const owner = await user();
    const kb = await activeKb(owner.id);
    const principal = await mintPrincipal(owner.id, {
      name: "both",
      scopes: ["mcp:write"],
      toolGroups: ["read", "edit"],
      acl: [{ kbId: kb.id, bits: ["write"] }],
    });
    await expect(
      updateGrant(runtime, owner.id, { id: principal.grantId, toolGroups: ["read", "assets"] }),
    ).resolves.toEqual({ id: principal.grantId, widened: true, narrowed: true });
    const events = await editEvents(principal.grantId);
    expect(events.map((event) => event.action).sort()).toEqual([
      "MCP_GRANT_NARROWED",
      "MCP_GRANT_WIDENED",
    ]);
    expect(new Set(events.map((event) => event.opId)).size).toBe(1);
    expect((await verifier.inspect(principal)).toolGroups).toEqual(["read", "assets"]);
    // Replacing mcp:write with mcp:read only narrows, yet the old token scope is gone.
    await expect(
      updateGrant(runtime, owner.id, { id: principal.grantId, scopes: ["mcp:read"] }),
    ).resolves.toEqual({ id: principal.grantId, widened: false, narrowed: true });
    expect((await verifier.inspect(principal)).generationActive).toBe(false);
  });

  it("a preset cap narrows a 257-entry creator-expanded ACL atomically with a bounded audit", async () => {
    const owner = await user();
    const kbIds = Array.from({ length: 257 }, (_, i) => `cap${String(i).padStart(21, "0")}`);
    await prisma.knowledgeBase.createMany({
      data: kbIds.map((id) => ({
        id,
        ownerId: owner.id,
        name: "Cap fixture",
        slug: `cap-${randomUUID().slice(0, 8)}-${id.slice(-3)}`,
        description: "Cap fixture",
        state: "ACTIVE",
        headSha: "a".repeat(40),
      })),
    });
    const principal = await mintPrincipal(owner.id, {
      name: "large",
      scopes: ["mcp:write"],
      toolGroups: ["read", "edit"],
      acl: kbIds.slice(0, 256).map((kbId) => ({ kbId, bits: ["write"] })),
    });
    // The 257th entry arrives the way a creator append does, beyond any 256-entry payload.
    await prisma.grantKbAcl.create({
      data: { grantId: principal.grantId, kbId: kbIds[256]!, bits: ["read", "propose", "write"] },
    });
    // A per-entry patch cannot carry it...
    await expect(
      updateGrant(runtime, owner.id, {
        id: principal.grantId,
        acl: kbIds.map((kbId) => ({ kbId, bits: ["read"] })),
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    // ...the cap does, in one operation, together with the preset's groups and one patch.
    await expect(
      updateGrant(runtime, owner.id, {
        id: principal.grantId,
        toolGroups: ["read"],
        aclCap: ["read"],
        acl: [{ kbId: kbIds[0]!, bits: [] }],
      }),
    ).resolves.toEqual({ id: principal.grantId, widened: false, narrowed: true });
    const rows = await prisma.grantKbAcl.findMany({
      where: { grantId: principal.grantId },
      select: { kbId: true, bits: true },
      take: 300,
    });
    expect(rows).toHaveLength(256);
    expect(rows.every((row) => JSON.stringify(row.bits) === '["read"]')).toBe(true);
    expect(rows.map((row) => row.kbId)).not.toContain(kbIds[0]);
    await expect(can(principal, kbIds[256]!, "propose")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    const [event] = await editEvents(principal.grantId);
    expect(event?.action).toBe("MCP_GRANT_NARROWED");
    const metadata = event!.metadata as { before: string; after: string };
    expect(JSON.parse(metadata.after)).toEqual({
      toolGroups: ["read"],
      acl: { [kbIds[0]!]: [] },
      aclCapped: 256,
      aclCap: ["read"],
    });
    expect(metadata.before.length + metadata.after.length).toBeLessThan(1024);
    // A cap that removes nothing is a no-op.
    await expect(
      updateGrant(runtime, owner.id, { id: principal.grantId, aclCap: ["read"] }),
    ).resolves.toEqual({ id: principal.grantId, widened: false, narrowed: false });
  });

  it("a large patch is audited by counts, never entry by entry", async () => {
    const owner = await user();
    const kbIds = Array.from({ length: 30 }, (_, i) => `aud${String(i).padStart(21, "0")}`);
    await prisma.knowledgeBase.createMany({
      data: kbIds.map((id) => ({
        id,
        ownerId: owner.id,
        name: "Audit fixture",
        slug: `aud-${randomUUID().slice(0, 8)}-${id.slice(-3)}`,
        description: "Audit fixture",
        state: "ACTIVE",
        headSha: "a".repeat(40),
      })),
    });
    const principal = await mintPrincipal(owner.id, {
      name: "audit",
      scopes: ["mcp:read"],
      toolGroups: ["read"],
      acl: [],
    });
    await updateGrant(runtime, owner.id, {
      id: principal.grantId,
      acl: kbIds.map((kbId) => ({ kbId, bits: ["read"] })),
    });
    const [event] = await editEvents(principal.grantId);
    expect(JSON.parse((event!.metadata as { after: string }).after)).toEqual({
      aclEntriesChanged: 30,
    });
  });

  it("refuses revoked and expired grants", async () => {
    const owner = await user();
    const kb = await activeKb(owner.id);
    const mint = (name: string) =>
      mintPersonalToken(runtime, owner.id, {
        name,
        scopes: ["mcp:read"],
        toolGroups: ["read"],
        acl: [{ kbId: kb.id, bits: ["read"] }],
      });
    const revoked = await mint("revoked");
    await revokePersonalToken(runtime, owner.id, revoked.token.id);
    const expired = await mint("expired");
    await prisma.mcpPersonalToken.update({
      where: { id: expired.token.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    for (const minted of [revoked, expired]) {
      const { grantId } = await prisma.mcpPersonalToken.findUniqueOrThrow({
        where: { id: minted.token.id },
        select: { grantId: true },
      });
      const edits: Omit<Parameters<typeof updateGrant>[2], "id">[] = [
        { toolGroups: ["read", "edit"] },
        { allowCreate: false },
      ];
      for (const edit of edits) {
        await expect(
          updateGrant(runtime, owner.id, { id: grantId, ...edit }),
        ).rejects.toMatchObject({ code: "CONFLICT" });
      }
      expect(await editEvents(grantId)).toEqual([]);
    }
    // A grant tombstoned directly (OAuth revoke) is refused the same way.
    const oauth = await prisma.mcpGrant.create({
      data: {
        id: randomUUID(),
        kind: "OAUTH",
        actorUserIdSnapshot: owner.id,
        userId: owner.id,
        clientId: "edit-revoked-client",
        referenceId: randomUUID(),
        scopes: ["mcp:read"],
        toolGroups: ["read"],
        createdKbBits: [],
      },
    });
    await revokeGrant(runtime, owner.id, oauth.id);
    await expect(
      updateGrant(runtime, owner.id, { id: oauth.id, toolGroups: ["read", "edit"] }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("OAuth: scopes are fixed, sealed is refused, and removing write groups keeps the token working", async () => {
    const owner = await user();
    const kb = await activeKb(owner.id);
    const grant = await prisma.mcpGrant.create({
      data: {
        id: randomUUID(),
        kind: "OAUTH",
        actorUserIdSnapshot: owner.id,
        userId: owner.id,
        clientId: "edit-oauth-client",
        referenceId: randomUUID(),
        scopes: ["mcp:write", "offline_access"],
        toolGroups: ["read", "edit"],
        createdKbBits: [],
        acl: { create: [{ kbId: kb.id, bits: ["read", "propose", "write"] }] },
      },
    });
    // An access token issued with the grant's scopes.
    const principal: TokenPrincipal = {
      kind: "token",
      userId: owner.id,
      grantId: grant.id,
      grantGeneration: grant.id,
      scopes: ["mcp:write"],
      expiresAt: new Date(Date.now() + 600_000),
      storedAcl: new Map(),
    };
    await expect(can(principal, kb.id, "write")).resolves.toBeDefined();
    for (const scopes of [["mcp:read"], ["mcp:read", "mcp:write"], ["mcp:write"]] as const) {
      await expect(
        updateGrant(runtime, owner.id, { id: grant.id, scopes: [...scopes] }),
      ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    }
    await expect(
      updateGrant(runtime, owner.id, { id: grant.id, toolGroups: ["read", "edit", "sealed"] }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      updateGrant(runtime, owner.id, { id: grant.id, toolGroups: ["read"] }),
    ).resolves.toEqual({ id: grant.id, widened: false, narrowed: true });
    const after = await prisma.mcpGrant.findUniqueOrThrow({ where: { id: grant.id } });
    expect(after.scopes).toEqual(["mcp:write", "offline_access"]);
    expect(await verifier.inspect(principal)).toMatchObject({
      generationActive: true,
      consumerKind: "oauth",
      toolGroups: ["read"],
    });
    await expect(can(principal, kb.id, "read")).resolves.toBeDefined();
    // Widening the groups back keeps the same token too; creation is allowed (mcp:write held).
    await expect(
      updateGrant(runtime, owner.id, {
        id: grant.id,
        toolGroups: ["read", "edit", "kb_admin"],
        allowCreate: true,
        createdKbBits: ["read"],
      }),
    ).resolves.toEqual({ id: grant.id, widened: true, narrowed: false });
    expect((await verifier.inspect(principal)).toolGroups).toEqual(["read", "edit", "kb_admin"]);
  });
});

describe("grants: temporary access (elevations)", () => {
  const elevationEvents = (grantId: string) =>
    prisma.auditEvent.findMany({
      where: {
        grantIdSnapshot: grantId,
        action: {
          in: [
            "MCP_GRANT_ELEVATED",
            "MCP_GRANT_ELEVATION_ENDED",
            "MCP_GRANT_WIDENED",
            "MCP_GRANT_NARROWED",
          ],
        },
      },
      orderBy: [{ createdAt: "asc" }, { action: "asc" }],
    });
  const nextCall = async (secret: string) => {
    const principal = await authenticatePersonalToken(query, secret, new Date());
    if (!principal) throw new Error("token no longer authenticates");
    return principal;
  };
  /** Moves an elevation's expiry into the past by the database clock. */
  const lapse = (elevationId: string) =>
    prisma.$executeRaw`UPDATE "mcp_grant_elevation"
       SET "expiresAt" = clock_timestamp() - interval '1 second'
     WHERE id = ${elevationId}::uuid`;
  const createRequest = () => ({
    name: "Created while elevated",
    slug: `elev-${randomUUID().slice(0, 8)}`,
    description: "created through temporary access",
    idempotencyKey: `create-${randomUUID()}`,
  });

  it("widens on the next call, expires by the database clock, and keeps a KB created meanwhile", async () => {
    setKbRecoveryComplete(true);
    const owner = await user();
    const kb = await activeKb(owner.id);
    const other = await activeKb(owner.id);
    const minted = await mintPersonalToken(runtime, owner.id, {
      name: "temporary",
      scopes: ["mcp:write"],
      toolGroups: ["read"],
      acl: [{ kbId: kb.id, bits: ["read"] }],
    });
    const base = await nextCall(minted.secret);
    await expect(can(base, kb.id, "write")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(can(base, other.id, "read")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      createKnowledgeBaseAsGrant(runtime, base, verifier, createRequest()),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const before = await prisma.mcpGrant.findUniqueOrThrow({
      where: { id: base.grantId },
      include: { acl: true },
    });

    const result = await updateGrant(runtime, owner.id, {
      id: base.grantId,
      toolGroups: ["read", "edit", "kb_admin"],
      acl: [
        { kbId: kb.id, bits: ["write"] },
        { kbId: other.id, bits: ["read"] },
      ],
      allowCreate: true,
      createdKbBits: ["read", "propose"],
      duration: "1h",
    });
    expect(result).toMatchObject({ id: base.grantId, widened: true, narrowed: false });
    const elevationId = result.elevation!.id;
    const stored = await prisma.mcpGrantElevation.findUniqueOrThrow({
      where: { id: elevationId },
      include: { acl: { orderBy: { kbId: "asc" } } },
    });
    // Only the additions are stored; the base grant is untouched.
    expect(stored).toMatchObject({
      grantId: base.grantId,
      toolGroups: ["edit", "kb_admin"],
      allowCreate: true,
      createdKbBits: ["read", "propose"],
      revokedAt: null,
      createdByUserIdSnapshot: owner.id,
    });
    expect(stored.expiresAt.getTime() - stored.createdAt.getTime()).toBe(3_600_000);
    expect(stored.expiresAt).toEqual(result.elevation!.expiresAt);
    expect(stored.acl.map((a) => [a.kbId, a.bits])).toEqual(
      [
        [kb.id, ["read", "propose", "write"]],
        [other.id, ["read"]],
      ].sort(([a], [b]) => String(a).localeCompare(String(b))),
    );
    expect(
      await prisma.mcpGrant.findUniqueOrThrow({
        where: { id: base.grantId },
        include: { acl: true },
      }),
    ).toEqual(before);

    // The same secret gains the access on its next call.
    const elevated = await nextCall(minted.secret);
    expect((await verifier.inspect(elevated)).toolGroups).toEqual(["read", "edit", "kb_admin"]);
    await expect(can(elevated, kb.id, "write")).resolves.toBeDefined();
    await expect(can(elevated, other.id, "read")).resolves.toBeDefined();
    // The verifier's own clock is irrelevant: elevation expiry is the database's.
    const skewed = createGrantCredentialVerifier(query, () => new Date(Date.now() + 2 * 3_600_000));
    expect((await skewed.inspect(elevated)).toolGroups).toEqual(["read", "edit", "kb_admin"]);
    const created = await createKnowledgeBaseAsGrant(runtime, elevated, verifier, createRequest());
    const createdId = (created.kb as { id: string }).id;
    // Creation writes the creator bits to the base grant, not the elevation.
    expect(
      await prisma.grantKbAcl.findUniqueOrThrow({
        where: { grantId_kbId: { grantId: base.grantId, kbId: createdId } },
      }),
    ).toMatchObject({ bits: ["read", "propose"] });

    // The owner's lists show it with its remaining time.
    const tokens = await listPersonalTokens(runtime, owner.id, {});
    const row = tokens.items.find((item) => item.grantId === base.grantId);
    expect(row?.elevations).toHaveLength(1);
    expect(row?.elevations[0]).toMatchObject({
      id: elevationId,
      toolGroups: ["edit", "kb_admin"],
      allowCreate: true,
      kbCount: 2,
    });
    expect(row?.elevations[0]?.remainingSeconds).toBeGreaterThan(3500);
    expect(row?.elevations[0]?.remainingSeconds).toBeLessThanOrEqual(3600);

    // Expiry on the database clock: the next call is back to the base grant.
    await lapse(elevationId);
    const after = await nextCall(minted.secret);
    expect((await verifier.inspect(after)).toolGroups).toEqual(["read"]);
    await expect(can(after, kb.id, "write")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(can(after, kb.id, "read")).resolves.toBeDefined();
    await expect(can(after, other.id, "read")).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Work admitted while elevated is denied on its next recheck too.
    await expect(can(elevated, kb.id, "write")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      createKnowledgeBaseAsGrant(runtime, after, verifier, createRequest()),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    // The KB created meanwhile stays accessible through the base grant.
    await expect(can(after, createdId, "propose")).resolves.toBeDefined();
    expect(
      (await listPersonalTokens(runtime, owner.id, {})).items.find(
        (item) => item.grantId === base.grantId,
      )?.elevations,
    ).toEqual([]);
    // Expired rows stay as history.
    expect(await prisma.mcpGrantElevation.count({ where: { grantId: base.grantId } })).toBe(1);

    // Audit: created once; natural expiry writes no event.
    const events = await elevationEvents(base.grantId);
    expect(events.map((event) => [event.action, event.actorKey])).toEqual([
      ["MCP_GRANT_ELEVATED", `user:${owner.id}`],
    ]);
    const createdMeta = events[0]!.metadata as Record<string, string>;
    expect(createdMeta.elevationId).toBe(elevationId);
    expect(createdMeta.expiresAt).toBe(stored.expiresAt.toISOString());
    expect(JSON.parse(createdMeta.after!)).toEqual({
      toolGroups: ["edit", "kb_admin"],
      allowCreate: true,
      createdKbBits: ["read", "propose"],
      acl: { [kb.id]: ["read", "propose", "write"], [other.id]: ["read"] },
    });
  });

  it("a creator-grown base ACL above the selection cap still gets temporary access", async () => {
    const owner = await user();
    const minted = await mintPersonalToken(runtime, owner.id, {
      name: "grown creator",
      scopes: ["mcp:write"],
      toolGroups: ["read"],
      acl: [],
    });
    const principal = await nextCall(minted.secret);
    // Creator appends grow the base ACL past MCP_GRANT_MAX_ACL_ENTRIES (256).
    const ids = Array.from(
      { length: 260 },
      (_, i) => `grow${randomUUID().replaceAll("-", "").slice(0, 16)}${String(i).padStart(4, "0")}`,
    );
    await prisma.knowledgeBase.createMany({
      data: ids.map((id) => ({
        id,
        ownerId: owner.id,
        name: "Grown",
        slug: `g-${id}`,
        description: "Creator append fixture",
        state: "ACTIVE",
        headSha: "a".repeat(40),
      })),
    });
    await prisma.grantKbAcl.createMany({
      data: ids.map((kbId) => ({ grantId: principal.grantId, kbId, bits: ["read"] })),
    });
    expect(await prisma.grantKbAcl.count({ where: { grantId: principal.grantId } })).toBe(260);

    // Only export, for an hour: not refused because of the base ACL's size.
    const groupsOnly = await updateGrant(runtime, owner.id, {
      id: principal.grantId,
      toolGroups: ["read", "export"],
      duration: "1h",
    });
    expect(groupsOnly).toMatchObject({ widened: true, narrowed: false });
    // Elevated bits on a creator-appended KB work too.
    const bits = await updateGrant(runtime, owner.id, {
      id: principal.grantId,
      acl: [{ kbId: ids[259]!, bits: ["write"] }],
      duration: "1h",
    });
    expect(bits.elevation).toBeDefined();
    expect((await verifier.inspect(principal)).toolGroups).toEqual(["read", "export"]);
    await expect(can(principal, ids[259]!, "write")).resolves.toBeDefined();
    await expect(can(principal, ids[0]!, "write")).rejects.toMatchObject({ code: "FORBIDDEN" });
    // The lists stay bounded: the base preview is capped and paged, elevations are bounded.
    const row = (await listGrants(runtime, owner.id, { kind: "PAT" })).items.find(
      (item) => item.id === principal.grantId,
    );
    expect(row?.acl).toHaveLength(256);
    expect(row?.aclNextCursor).not.toBeNull();
    expect(row?.elevations).toHaveLength(2);
    // A permanent narrowing on the grown ACL still ends both elevations.
    await updateGrant(runtime, owner.id, {
      id: principal.grantId,
      acl: [{ kbId: ids[0]!, bits: [] }],
    });
    expect((await verifier.inspect(principal)).toolGroups).toEqual(["read"]);
    await expect(can(principal, ids[259]!, "write")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  /** The readable part of a signed cursor (its body is plain base64url). */
  const cursorText = (cursor: string | null) =>
    cursor ? Buffer.from(cursor.split(".")[0]!, "base64url").toString("utf8") : "";
  const namedKb = (ownerId: string, name: string) =>
    prisma.knowledgeBase.create({
      data: {
        ownerId,
        name,
        slug: `n-${randomUUID().slice(0, 8)}`,
        description: "KB list fixture",
        state: "ACTIVE",
        headSha: "a".repeat(40),
      },
    });

  it("KB list: an elevation-only KB expiring between query and response is in neither items nor cursor", async () => {
    setKbRecoveryComplete(true);
    const owner = await user();
    const secret = await namedKb(owner.id, `Aaa secret ${randomUUID().slice(0, 6)}`);
    const visible = await namedKb(owner.id, "Zzz visible");
    const minted = await mintPersonalToken(runtime, owner.id, {
      name: "list",
      scopes: ["mcp:read"],
      toolGroups: ["read"],
      acl: [{ kbId: visible.id, bits: ["read"] }],
    });
    const principal = await nextCall(minted.secret);
    const { elevation } = await updateGrant(runtime, owner.id, {
      id: principal.grantId,
      acl: [{ kbId: secret.id, bits: ["read"] }],
      duration: "1h",
    });
    // While in force it is listed (first page of one).
    const active = await listKnowledgeBases(runtime, principal, { limit: 1 }, verifier);
    expect(active.items.map((item) => (item as { id: string }).id)).toEqual([secret.id]);
    // Lapses on the database clock between the page query and the final decision.
    await prisma.$executeRaw`UPDATE "mcp_grant_elevation"
        SET "expiresAt" = clock_timestamp() + interval '2 seconds' WHERE id = ${elevation!.id}::uuid`;
    const { expiresAt } = await prisma.mcpGrantElevation.findUniqueOrThrow({
      where: { id: elevation!.id },
    });
    let decisions = 0;
    const page = await listKnowledgeBases(runtime, principal, { limit: 1 }, verifier, {
      beforeDecision: async () => {
        decisions += 1;
        const wait = expiresAt.getTime() - Date.now() + 500;
        if (decisions === 1 && wait > 0) await new Promise((r) => setTimeout(r, wait));
      },
    });
    expect(decisions).toBe(2);
    expect(page.items.map((item) => (item as { id: string }).id)).toEqual([visible.id]);
    expect(page.nextCursor).toBeNull();
    expect(JSON.stringify(page)).not.toContain(secret.id);
    expect(JSON.stringify(page)).not.toContain(secret.name);
  });

  it("KB list: the base-only fallback never reports capabilities from an elevation", async () => {
    setKbRecoveryComplete(true);
    const owner = await user();
    const kb = await namedKb(owner.id, "Fallback notes");
    const minted = await mintPersonalToken(runtime, owner.id, {
      name: "fallback",
      scopes: ["mcp:write"],
      toolGroups: ["read"],
      acl: [{ kbId: kb.id, bits: ["read"] }],
    });
    const principal = await nextCall(minted.secret);
    // W adds write on the KB; X1 and X2 only change the elevation set.
    await updateGrant(runtime, owner.id, {
      id: principal.grantId,
      acl: [{ kbId: kb.id, bits: ["write"] }],
      duration: "1h",
    });
    const churn: string[] = [];
    for (const group of ["export", "pull_requests"] as const)
      churn.push(
        (
          await updateGrant(runtime, owner.id, {
            id: principal.grantId,
            toolGroups: ["read", group],
            duration: "1h",
          })
        ).elevation!.id,
      );
    const capabilities = (page: { items: unknown[] }) =>
      (page.items[0] as { capabilities: string[] }).capabilities;
    // Within its snapshot, W's write is reported.
    expect(capabilities(await listKnowledgeBases(runtime, principal, {}, verifier))).toContain(
      "write",
    );
    // The set changes before each of the two decisions: the base-only fallback is served.
    let decisions = 0;
    const page = await listKnowledgeBases(runtime, principal, {}, verifier, {
      beforeDecision: async () => {
        await endGrantElevation(runtime, owner.id, churn[decisions]!);
        decisions += 1;
      },
    });
    expect(decisions).toBe(2);
    // W is still live (live reauthorization alone would say write), yet base-only means read.
    expect(capabilities(page)).toEqual(["read"]);
  });

  it("KB list: a page whose rows are all rejected never names them in the cursor and still reaches later KBs", async () => {
    setKbRecoveryComplete(true);
    const owner = await user();
    const minted = await mintPersonalToken(runtime, owner.id, {
      name: "rejecting",
      scopes: ["mcp:read"],
      toolGroups: ["read"],
      acl: [],
    });
    const principal = await nextCall(minted.secret);
    // Rows the list query matches but authorization rejects (no read in the stored ceiling).
    const rejected = [];
    for (let i = 0; i < 6; i += 1) rejected.push(await namedKb(owner.id, `R${i} hidden`));
    const readable = [];
    for (let i = 0; i < 3; i += 1) readable.push(await namedKb(owner.id, `S${i} shown`));
    await prisma.grantKbAcl.createMany({
      data: [
        ...rejected.map((kb) => ({ grantId: principal.grantId, kbId: kb.id, bits: [] })),
        ...readable.map((kb) => ({ grantId: principal.grantId, kbId: kb.id, bits: ["read"] })),
      ],
    });
    const ids = (page: { items: unknown[] }) =>
      page.items.map((item) => (item as { id: string }).id);
    const first = await listKnowledgeBases(runtime, principal, { limit: 2 }, verifier);
    expect(ids(first)).toEqual([readable[0]!.id, readable[1]!.id]);
    const text = cursorText(first.nextCursor);
    expect(text).toContain(readable[1]!.id);
    for (const kb of rejected) {
      expect(text).not.toContain(kb.id);
      expect(text).not.toContain(kb.name);
    }
    const second = await listKnowledgeBases(
      runtime,
      principal,
      { limit: 2, cursor: first.nextCursor },
      verifier,
    );
    expect(ids(second)).toEqual([readable[2]!.id]);
    expect(second.nextCursor).toBeNull();
  });

  it("refuses an elevation beyond live rights, any removal, and shape violations; nothing is stored", async () => {
    const owner = await user();
    const member = await user();
    const kb = await activeKb(owner.id);
    const unshared = await activeKb(owner.id);
    await prisma.kbShare.create({ data: { kbId: kb.id, userId: member.id, bits: ["read"] } });
    const principal = await mintPrincipal(member.id, {
      name: "member",
      scopes: ["mcp:read"],
      toolGroups: ["read", "export"],
      acl: [{ kbId: kb.id, bits: ["read"] }],
    });
    const refused: Omit<Parameters<typeof updateGrant>[2], "id" | "duration">[] = [
      // Beyond live rights.
      { acl: [{ kbId: kb.id, bits: ["write"] }] },
      { acl: [{ kbId: unshared.id, bits: ["read"] }] },
      // Removals: temporary access only adds.
      { toolGroups: ["read", "edit"] },
      { acl: [{ kbId: kb.id, bits: [] }] },
      // Creation needs mcp:write, which an elevation never adds.
      { allowCreate: true, createdKbBits: ["read"] },
    ];
    for (const edit of refused) {
      await expect(
        updateGrant(runtime, member.id, { id: principal.grantId, ...edit, duration: "1d" }),
      ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    }
    await expect(
      updateGrant(runtime, member.id, {
        id: principal.grantId,
        scopes: ["mcp:write"],
        toolGroups: ["read", "export", "edit"],
        duration: "1h",
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(await prisma.mcpGrantElevation.count({ where: { grantId: principal.grantId } })).toBe(0);
    expect(await elevationEvents(principal.grantId)).toEqual([]);
    // A share revoked after mint cannot be elevated back in either.
    await prisma.kbShare.update({
      where: { kbId_userId: { kbId: kb.id, userId: member.id } },
      data: { revokedAt: new Date() },
    });
    await expect(
      updateGrant(runtime, member.id, {
        id: principal.grantId,
        acl: [{ kbId: kb.id, bits: ["read", "propose"] }],
        duration: "1h",
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    // An OAuth grant never gains sealed temporarily.
    const oauth = await prisma.mcpGrant.create({
      data: {
        id: randomUUID(),
        kind: "OAUTH",
        actorUserIdSnapshot: owner.id,
        userId: owner.id,
        clientId: "elevate-oauth-client",
        referenceId: randomUUID(),
        scopes: ["mcp:write"],
        toolGroups: ["read"],
        createdKbBits: [],
      },
    });
    await expect(
      updateGrant(runtime, owner.id, {
        id: oauth.id,
        toolGroups: ["read", "sealed"],
        duration: "1h",
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    // Revoked grants cannot be elevated.
    await revokeGrant(runtime, owner.id, oauth.id);
    await expect(
      updateGrant(runtime, owner.id, {
        id: oauth.id,
        toolGroups: ["read", "edit"],
        duration: "1h",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("another user can neither elevate nor end someone else's temporary access", async () => {
    const owner = await user();
    const intruder = await user();
    const kb = await activeKb(owner.id);
    const minted = await mintPersonalToken(runtime, owner.id, {
      name: "owned",
      scopes: ["mcp:write"],
      toolGroups: ["read"],
      acl: [{ kbId: kb.id, bits: ["read"] }],
    });
    const principal = await nextCall(minted.secret);
    await expect(
      updateGrant(runtime, intruder.id, {
        id: principal.grantId,
        toolGroups: ["read", "edit"],
        duration: "1h",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const { elevation } = await updateGrant(runtime, owner.id, {
      id: principal.grantId,
      toolGroups: ["read", "edit"],
      duration: "1d",
    });
    for (const id of [elevation!.id, randomUUID()]) {
      await expect(endGrantElevation(runtime, intruder.id, id)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    }
    const row = await prisma.mcpGrantElevation.findUniqueOrThrow({ where: { id: elevation!.id } });
    expect(row.revokedAt).toBeNull();
    expect((await verifier.inspect(principal)).toolGroups).toEqual(["read", "edit"]);
    const events = await elevationEvents(principal.grantId);
    expect(events.map((event) => event.action)).toEqual(["MCP_GRANT_ELEVATED"]);
  });

  it("End now denies the next call; at most five are active; ended rows are history", async () => {
    const owner = await user();
    const kb = await activeKb(owner.id);
    const minted = await mintPersonalToken(runtime, owner.id, {
      name: "capped",
      scopes: ["mcp:write"],
      toolGroups: ["read"],
      acl: [{ kbId: kb.id, bits: ["read"] }],
    });
    const principal = await nextCall(minted.secret);
    const groups = ["edit", "assets", "export", "pull_requests", "index_admin"] as const;
    const ids: string[] = [];
    for (const [n, group] of groups.entries()) {
      const result = await updateGrant(runtime, owner.id, {
        id: principal.grantId,
        toolGroups: ["read", group],
        duration: (["1h", "1d", "7d"] as const)[n % 3],
      });
      ids.push(result.elevation!.id);
    }
    // The sixth active elevation is refused.
    await expect(
      updateGrant(runtime, owner.id, {
        id: principal.grantId,
        toolGroups: ["read", "kb_admin"],
        duration: "1h",
      }),
    ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    expect((await verifier.inspect(principal)).toolGroups).toEqual(["read", ...groups]);
    // Every active one is listed (bounded), soonest expiry first.
    const listed = await listGrants(runtime, owner.id, { kind: "PAT" });
    const row = listed.items.find((item) => item.id === principal.grantId);
    expect(row?.elevations).toHaveLength(5);
    const remaining = row!.elevations.map((elevation) => elevation.remainingSeconds);
    expect([...remaining].sort((a, b) => a - b)).toEqual(remaining);

    // End now: immediate, on the very next call, audited once; a repeat is a no-op.
    await expect(endGrantElevation(runtime, owner.id, ids[0]!)).resolves.toEqual({
      id: ids[0],
      ended: true,
    });
    expect((await verifier.inspect(principal)).toolGroups).not.toContain("edit");
    await expect(endGrantElevation(runtime, owner.id, ids[0]!)).resolves.toEqual({
      id: ids[0],
      ended: false,
    });
    // An expired one cannot be "ended" either, and is not audited as ended.
    await lapse(ids[1]!);
    await expect(endGrantElevation(runtime, owner.id, ids[1]!)).resolves.toEqual({
      id: ids[1],
      ended: false,
    });
    // Ending and expiry free slots for new temporary access.
    await updateGrant(runtime, owner.id, {
      id: principal.grantId,
      toolGroups: ["read", "kb_admin"],
      duration: "1h",
    });
    expect((await verifier.inspect(principal)).toolGroups).toEqual([
      "read",
      "export",
      "pull_requests",
      "index_admin",
      "kb_admin",
    ]);
    const events = await elevationEvents(principal.grantId);
    expect(events.filter((event) => event.action === "MCP_GRANT_ELEVATED")).toHaveLength(6);
    const ended = events.filter((event) => event.action === "MCP_GRANT_ELEVATION_ENDED");
    expect(ended.map((event) => (event.metadata as Record<string, string>).elevationId)).toEqual([
      ids[0],
    ]);
    expect(ended[0]?.actorUserId).toBe(owner.id);
    expect(await prisma.mcpGrantElevation.count({ where: { grantId: principal.grantId } })).toBe(6);
    // An elevation is never a permanent widening.
    expect(
      (await prisma.mcpGrant.findUniqueOrThrow({ where: { id: principal.grantId } })).widenedAt,
    ).toBeNull();
  });
});

describe("grants: tombstones", () => {
  it("revoke and ban then unban/reconsent never reactivate an old generation; sealed approvals stay bound", async () => {
    const owner = await user();
    const kb = await activeKb(owner.id);
    const master = randomBytes(32).toString("base64");
    const enrolled = await enrollSealedRecord(
      runtime,
      { kind: "browser", userId: owner.id },
      {
        kbId: kb.id,
        namespace: remoteSealedNamespace(runtime.canonicalOrigin, kb.id),
        plaintext: "grant-canary",
        idempotencyKey: randomUUID(),
      },
      master,
    );
    const revoked = await mintPrincipal(owner.id, {
      name: "a",
      scopes: ["mcp:read"],
      toolGroups: [...MCP_TOOL_GROUPS],
      acl: [{ kbId: kb.id, bits: ["read"] }],
    });
    const banned = await mintPrincipal(owner.id, {
      name: "b",
      scopes: ["mcp:read"],
      toolGroups: [...MCP_TOOL_GROUPS],
      acl: [{ kbId: kb.id, bits: ["read"] }],
    });
    const approve = (consumerId: string) =>
      grantSealedRecord(
        runtime,
        { kind: "browser", userId: owner.id },
        {
          kbId: kb.id,
          reference: enrolled.reference,
          consumerKind: "pat",
          consumerId,
          recipientKeyId: randomUUID(),
          recipientPublicKey: generateKeyPairSync("x25519")
            .publicKey.export({ format: "der", type: "spki" })
            .subarray(-32)
            .toString("base64"),
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          idempotencyKey: randomUUID(),
        },
      );
    await approve(revoked.grantId);
    await expect(approve(randomUUID())).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

    const token = await prisma.mcpPersonalToken.findFirstOrThrow({
      where: { grantId: revoked.grantId },
    });
    await revokePersonalToken(runtime, owner.id, token.id);
    expect((await verifier.inspect(revoked)).generationActive).toBe(false);
    await expect(approve(revoked.grantId)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

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
    for (const old of [revoked, banned]) {
      expect((await verifier.inspect(old)).generationActive).toBe(false);
      await expect(can(old, kb.id, "read")).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    }
    const fresh = await mintPrincipal(owner.id, {
      name: "reconsent",
      scopes: ["mcp:read"],
      toolGroups: [...MCP_TOOL_GROUPS],
      acl: [{ kbId: kb.id, bits: ["read"] }],
    });
    expect(fresh.grantId).not.toBe(revoked.grantId);
    expect(fresh.grantId).not.toBe(banned.grantId);
    await expect(can(fresh, kb.id, "read")).resolves.toBeDefined();
    expect((await verifier.inspect(banned)).generationActive).toBe(false);

    const approvals = await prisma.sealedConsumerGrant.findMany({
      where: { consumerId: revoked.grantId },
    });
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.grantId).toBe(revoked.grantId);
    const tomb = await prisma.mcpGrant.findUniqueOrThrow({ where: { id: revoked.grantId } });
    expect(tomb.revokedAt).not.toBeNull();
  });
});

const DAY_MS = 86_400_000;
/** Real unified MCP bearer admission (PAT path) over the live database. */
function admitAt(now?: () => Date) {
  return createBearerAdmission({
    identityDb: prisma,
    query,
    origin: runtime.canonicalOrigin,
    verifyOAuth: async () => {
      throw new Error("PAT never invokes OAuth");
    },
    now,
  });
}
const bearer = (secret: string) =>
  new Request(`${runtime.canonicalOrigin}/mcp`, {
    headers: { authorization: `Bearer ${secret}` },
  });
/** Better Auth's own admin ban/unban writes go through the bootstrap adapter. */
const betterAuthUserWrite = (id: string, update: Record<string, unknown>) =>
  createBootstrapDatabaseAdapter(prisma)({ plugins: [admin(), twoFactor()] }).update({
    model: "user",
    where: [{ field: "id", value: id }],
    update,
  });
const readOnly = { scopes: ["mcp:read" as const], toolGroups: [...MCP_TOOL_GROUPS], acl: [] };

describe("grants: forced-2FA grace", () => {
  it("keeps an unenrolled member's PAT live inside the grace and revokes it once the grace ends", async () => {
    await prisma.appSetting.upsert({
      where: { key: "force2faPublicUsers" },
      create: { key: "force2faPublicUsers", value: "true" },
      update: { value: "true" },
    });
    try {
      const member = await prisma.user.create({
        data: {
          name: "Unenrolled",
          email: `${randomUUID()}@example.invalid`,
          emailVerified: true,
          twoFactorEnabled: false,
          createdAt: new Date(Date.now() - 3_600_000),
        },
      });
      const minted = await mintPersonalToken(runtime, member.id, { name: "grace", ...readOnly });
      const admit = admitAt();
      await expect(admit(bearer(minted.secret))).resolves.toBeDefined();
      const live = await prisma.mcpGrant.findFirstOrThrow({ where: { userId: member.id } });
      expect(live.revokedAt).toBeNull();

      // The clock passes the 24h enrollment grace: admission refuses and revokes.
      await prisma.user.update({
        where: { id: member.id },
        data: { createdAt: new Date(Date.now() - 25 * 3_600_000) },
      });
      await expect(admit(bearer(minted.secret))).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      const grant = await prisma.mcpGrant.findFirstOrThrow({ where: { userId: member.id } });
      expect(grant.revokedAt).not.toBeNull();
      expect(grant.revokeReason).toBe("forced_2fa");
      const token = await prisma.mcpPersonalToken.findFirstOrThrow({
        where: { userId: member.id },
      });
      expect(token.revokedAt).not.toBeNull();

      // Enrolling afterwards never resurrects the revoked generation.
      await prisma.user.update({ where: { id: member.id }, data: { twoFactorEnabled: true } });
      await expect(admit(bearer(minted.secret))).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    } finally {
      await prisma.appSetting.delete({ where: { key: "force2faPublicUsers" } });
    }
  });
});

describe("grants: ban suspension vs revocation", () => {
  it("a temporary ban suspends; the lifted ban re-admits the same PAT; one revoked meanwhile stays revoked", async () => {
    const member = await user();
    const kept = await mintPersonalToken(runtime, member.id, { name: "kept", ...readOnly });
    const killed = await mintPersonalToken(runtime, member.id, { name: "killed", ...readOnly });
    const admit = admitAt();
    await expect(admit(bearer(kept.secret))).resolves.toBeDefined();

    // Human revocation requires an admissible identity, so revoke before the ban.
    await revokePersonalToken(runtime, member.id, killed.token.id);
    await betterAuthUserWrite(member.id, {
      banned: true,
      banReason: "cool-off",
      banExpires: new Date(Date.now() + 3_600_000),
    });
    await expect(admit(bearer(kept.secret))).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(admit(bearer(killed.secret))).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    // Suspended, not revoked.
    const keptRow = await prisma.mcpPersonalToken.findUniqueOrThrow({
      where: { id: kept.token.id },
      include: { grant: true },
    });
    expect(keptRow.revokedAt).toBeNull();
    expect(keptRow.grant.revokedAt).toBeNull();
    const killedRow = await prisma.mcpPersonalToken.findUniqueOrThrow({
      where: { id: killed.token.id },
      include: { grant: true },
    });
    expect(killedRow.grant.revokeReason).toBe("user_revoke");

    // The ban lapses on its own: no user action, the same PAT is admitted again.
    await prisma.user.update({
      where: { id: member.id },
      data: { banExpires: new Date(Date.now() - 1_000) },
    });
    const again = await admit(bearer(kept.secret));
    expect(again.principal.credential?.tokenId).toBe(kept.token.id);
    await expect(admit(bearer(killed.secret))).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    // An explicit unban (Better Auth writes banned=false) behaves the same.
    await betterAuthUserWrite(member.id, {
      banned: true,
      banReason: null,
      banExpires: new Date(Date.now() + 3_600_000),
    });
    await expect(admit(bearer(kept.secret))).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await betterAuthUserWrite(member.id, { banned: false, banReason: null, banExpires: null });
    await expect(admit(bearer(kept.secret))).resolves.toBeDefined();
    await expect(admit(bearer(killed.secret))).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("a permanent ban revokes, and unbanning never reactivates the generation", async () => {
    const member = await user();
    const minted = await mintPersonalToken(runtime, member.id, { name: "perm", ...readOnly });
    const admit = admitAt();
    await expect(admit(bearer(minted.secret))).resolves.toBeDefined();
    await betterAuthUserWrite(member.id, { banned: true, banReason: null, banExpires: null });
    const grant = await prisma.mcpGrant.findFirstOrThrow({ where: { userId: member.id } });
    expect(grant.revokedAt).not.toBeNull();
    expect(grant.revokeReason).toBe("ban");
    await betterAuthUserWrite(member.id, { banned: false, banReason: null, banExpires: null });
    await expect(admit(bearer(minted.secret))).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("grants: PAT expiry", () => {
  it("omitted = now+90d, 400 days rejected, explicit null never expires", async () => {
    const owner = await user();
    const now = new Date();
    const omitted = await mintPersonalToken(
      runtime,
      owner.id,
      { name: "default", ...readOnly },
      { now: () => now },
    );
    expect(omitted.token.expiresAt?.getTime()).toBe(now.getTime() + 90 * DAY_MS);

    await expect(
      mintPersonalToken(runtime, owner.id, {
        name: "too-long",
        ...readOnly,
        expiresAt: new Date(Date.now() + 400 * DAY_MS),
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

    const dated = await mintPersonalToken(runtime, owner.id, {
      name: "year",
      ...readOnly,
      expiresAt: new Date(Date.now() + 365 * DAY_MS - 60_000),
    });
    const never = await mintPersonalToken(runtime, owner.id, {
      name: "never",
      ...readOnly,
      expiresAt: null,
    });
    expect(never.token.expiresAt).toBeNull();
    const row = await prisma.mcpPersonalToken.findUniqueOrThrow({ where: { id: never.token.id } });
    expect(row.expiresAt).toBeNull();

    const later = admitAt(() => new Date(Date.now() + 400 * DAY_MS));
    const admitted = await later(bearer(never.secret));
    expect(admitted.principal.expiresAt).toBeNull();
    await expect(later(bearer(dated.secret))).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(later(bearer(omitted.secret))).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

async function consentCreator(aclCount = 0) {
  const u = await user();
  const session = await prisma.session.create({
    data: {
      userId: u.id,
      token: randomUUID(),
      expiresAt: new Date(Date.now() + 3600_000),
    },
  });
  const sharers = await Promise.all(Array.from({ length: Math.ceil(aclCount / 20) }, () => user()));
  const shared = sharers.length
    ? await prisma.knowledgeBase.createManyAndReturn({
        data: Array.from({ length: aclCount }, (_, i) => ({
          ownerId: sharers[Math.floor(i / 20)]!.id,
          name: `Shared ${i}`,
          slug: `shared-${randomUUID()}`,
          description: "R34a shared KB fixture",
          state: "ACTIVE" as const,
          headSha: "a".repeat(40),
        })),
        select: { id: true },
      })
    : [];
  if (shared.length)
    await prisma.kbShare.createMany({
      data: shared.map((kb) => ({ kbId: kb.id, userId: u.id, bits: ["read"] })),
    });
  const acl = shared.map((kb) => ({ kbId: kb.id, bits: ["read" as const] }));
  const clientId = randomUUID();
  const resource = `${runtime.canonicalOrigin}/mcp`;
  await prisma.oauthResource.upsert({
    where: { identifier: resource },
    create: {
      identifier: resource,
      name: "MCP",
      allowedScopes: ["mcp:write"],
    },
    update: {},
  });
  await prisma.oauthClient.create({
    data: {
      clientId,
      redirectUris: ["https://client.invalid/cb"],
      scopes: ["mcp:write"],
      contacts: [],
      grantTypes: ["authorization_code"],
      responseTypes: ["code"],
      postLogoutRedirectUris: [],
      clientResources: { create: { resourceId: resource } },
    },
  });
  const secret = "disposable-R30-consent-secret";
  const service = createMcpConsentService({ db: prisma, secret, resource });
  const actor = { userId: u.id, sessionId: session.id };
  async function approve(bits: ["read"] | ["read", "manage"], reuseGrantId?: string) {
    const p = new URLSearchParams({
      client_id: clientId,
      redirect_uri: "https://client.invalid/cb",
      resource,
      scope: "mcp:write",
      state: randomUUID(),
      response_type: "code",
      code_challenge: "a".repeat(43),
      code_challenge_method: "S256",
      exp: String(Math.floor(Date.now() / 1000) + 600),
    });
    p.sort();
    p.set("sig", createHmac("sha256", secret).update(p.toString()).digest("base64"));
    const oauthQuery = p.toString();
    const prepared = await service.prepare(actor, oauthQuery);
    return service.approve(actor, {
      ...prepared,
      oauthQuery,
      reuseGrantId,
      explicitConsent: true,
      selection: {
        scopes: ["mcp:write"],
        toolGroups: MCP_TOOL_GROUPS.filter((group) => group !== "sealed"),
        acl,
        allowCreate: true,
        createdKbBits: bits,
      },
    });
  }
  const grant = await approve(["read", "manage"]);
  const principal: TokenPrincipal = {
    kind: "token",
    userId: u.id,
    grantId: grant.grantId,
    grantGeneration: grant.grantId,
    scopes: ["mcp:write"],
    expiresAt: new Date(Date.now() + 3600_000),
    storedAcl: new Map(),
    credential: { kind: "OAUTH", clientId, resource },
  };
  return { u, session, principal, shrink: () => approve(["read"], grant.grantId) };
}

describe("R30 regressions", () => {
  const adapter = () => createBootstrapDatabaseAdapter(prisma)({ plugins: [admin(), twoFactor()] });
  const context = (u: Awaited<ReturnType<typeof user>>, sessionPatch = {}) => ({
    session: { user: u, session: { impersonatedBy: null, ...sessionPatch } },
  });
  const clients = (u: Awaited<ReturnType<typeof user>>, sessionPatch = {}) => {
    const ctx = context(
      u,
      sessionPatch,
    ) as unknown as import("@knowledge-base/api/context").Context;
    return {
      tokens: createRouterClient(mcpTokensRouter, { context: ctx }),
      grants: createRouterClient(mcpGrantsRouter, { context: ctx }),
      settings: createRouterClient(settingsRouter, { context: ctx }),
    };
  };
  // Both grace bases: creation, and a recorded start such as promotion.
  const pastGrace = (userId: string) =>
    prisma.user.update({
      where: { id: userId },
      data: {
        createdAt: new Date(Date.now() - 2 * 86_400_000),
        twoFactorGraceStartedAt: new Date(Date.now() - 2 * 86_400_000),
      },
    });
  const bearer = (secret: string) =>
    new Request(`${runtime.canonicalOrigin}/mcp`, {
      headers: { authorization: `Bearer ${secret}` },
    });

  it.each(["PREPARED", "COMMITTING"] as const)(
    "F1 consent shrink at %s respects reservation",
    async (phase) => {
      setKbRecoveryComplete(true);
      const f = await consentCreator();
      const input = {
        name: "R30",
        slug: `r30-${randomUUID().slice(0, 8)}`,
        description: "R30 consent shrink fixture",
        idempotencyKey: randomUUID(),
      };
      const interrupted: KbRuntimeConfig =
        phase === "PREPARED"
          ? {
              ...runtime,
              coordinator: {
                run: (o) =>
                  runtime.coordinator.run({
                    ...o,
                    barrier: o.barrier
                      ? {
                          ...o.barrier,
                          prepare: async (lease) => {
                            await o.barrier!.prepare?.(lease);
                            throw new Error("R30 interruption");
                          },
                        }
                      : undefined,
                  }),
              },
            }
          : {
              ...runtime,
              createGitExecutor: () => ({
                exec(call) {
                  executor.exec(call);
                  if (call.argv.includes("update-ref")) throw new Error("R30 interruption");
                },
              }),
            };
      await expect(
        createKnowledgeBaseAsGrant(interrupted, f.principal, verifier, input),
      ).rejects.toThrow("R30 interruption");
      const intent = await prisma.operationIntent.findFirstOrThrow({
        where: { actorKey: `grant:${f.principal.grantId}`, idempotencyKey: input.idempotencyKey },
      });
      expect(intent.phase).toBe(phase);
      expect((await f.shrink()).grantId).toBe(f.principal.grantId);
      if (phase === "PREPARED") {
        await expect(
          createKnowledgeBaseAsGrant(runtime, f.principal, verifier, input),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
        expect(await prisma.grantKbAcl.count({ where: { kbId: intent.reservedKbId! } })).toBe(0);
        expect(
          (await prisma.operationIntent.findUniqueOrThrow({ where: { opId: intent.opId } })).phase,
        ).toBe("PREPARED");
      } else {
        await runJournalRecoverySweep(prisma, reposDir, assetsDir, db.urls.runtime, () => {});
        expect(
          (
            await prisma.grantKbAcl.findUniqueOrThrow({
              where: {
                grantId_kbId: { grantId: f.principal.grantId, kbId: intent.reservedKbId! },
              },
            })
          ).bits,
        ).toEqual(["read", "propose", "write", "review", "manage"]);
      }
    },
  );
  it.each(["policy", "enrollment"])(
    "F2 stale admission preserves successor after %s change",
    async (change) => {
      const u = await user();
      await prisma.user.update({
        where: { id: u.id },
        data: { role: "admin", twoFactorEnabled: false },
      });
      const old = await mintPersonalToken(runtime, u.id, {
        name: "old",
        scopes: ["mcp:read"],
        toolGroups: [...MCP_TOOL_GROUPS],
        acl: [],
      });
      await pastGrace(u.id);
      let release = () => {};
      let enter = () => {};
      const blocked = new Promise<void>((r) => {
        release = r;
      });
      const entered = new Promise<void>((r) => {
        enter = r;
      });
      let paused = false;
      const q: LockQuery = async <R>(sql: string, params?: unknown[]) => {
        const result = await query<R>(sql, params);
        if (!paused && sql.includes('pub.value AS "forcePublic"')) {
          paused = true;
          enter();
          await blocked;
        }
        return result;
      };
      const admission = createBearerAdmission({
        query: q,
        origin: runtime.canonicalOrigin,
        identityDb: prisma,
        verifyOAuth: async () => ({}),
      })(bearer(old.secret));
      const result = admission.catch((e: unknown) => e);
      await entered;
      const administrator = await user();
      const liveAdministrator = await prisma.user.update({
        where: { id: administrator.id },
        data: { role: "admin" },
      });
      const control = clients(liveAdministrator);
      try {
        if (change === "policy")
          await control.settings.update({ key: "force2faInternalUsers", value: "false" });
        else
          await adapter().update({
            model: "user",
            where: [{ field: "id", value: u.id }],
            update: { twoFactorEnabled: true },
          });
        const successor = await mintPersonalToken(runtime, u.id, {
          name: "new",
          scopes: ["mcp:read"],
          toolGroups: [...MCP_TOOL_GROUPS],
          acl: [],
        });
        release();
        await result;
        await expect(
          createBearerAdmission({
            query,
            origin: runtime.canonicalOrigin,
            identityDb: prisma,
            verifyOAuth: async () => ({}),
          })(bearer(successor.secret)),
        ).resolves.toBeDefined();
        expect(
          (await prisma.mcpPersonalToken.findUniqueOrThrow({ where: { id: successor.token.id } }))
            .revokedAt,
        ).toBeNull();
        await expect(
          createBearerAdmission({
            query,
            origin: runtime.canonicalOrigin,
            identityDb: prisma,
            verifyOAuth: async () => ({}),
          })(bearer(old.secret)),
        ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      } finally {
        release();
        await result;
        if (change === "policy")
          await control.settings.update({ key: "force2faInternalUsers", value: "true" });
      }
    },
  );
  it.each([false, true])("F3 quiet grace lapse before enrollment (late=%s)", async (late) => {
    const u = await user();
    await prisma.user.update({
      where: { id: u.id },
      data: { role: "admin", twoFactorEnabled: false },
    });
    const minted = await mintPersonalToken(runtime, u.id, {
      name: "grace",
      scopes: ["mcp:read"],
      toolGroups: [...MCP_TOOL_GROUPS],
      acl: [],
    });
    if (late) await pastGrace(u.id);
    await adapter().update({
      model: "user",
      where: [{ field: "id", value: u.id }],
      update: { twoFactorEnabled: true },
    });
    const admit = createBearerAdmission({
      query,
      origin: runtime.canonicalOrigin,
      identityDb: prisma,
      verifyOAuth: async () => ({}),
    });
    if (late) {
      await expect(admit(bearer(minted.secret))).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      expect(
        (await prisma.mcpPersonalToken.findUniqueOrThrow({ where: { id: minted.token.id } }))
          .revokedAt,
      ).not.toBeNull();
    } else await expect(admit(bearer(minted.secret))).resolves.toBeDefined();
  });
  it.each([
    {
      role: "reader,\u0009\u000a\u000b\u000c\u000d \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeffaDmIn\ufeff,reader",
      revoked: true,
    },
    { role: "ADM\u0130N", revoked: false },
  ])("F2/F3 SQL role matching agrees with JS (revoked=$revoked)", async ({ role, revoked }) => {
    const u = await user();
    await prisma.user.update({
      where: { id: u.id },
      data: { role, twoFactorEnabled: false },
    });
    const minted = await mintPersonalToken(runtime, u.id, {
      name: "role-parity",
      scopes: ["mcp:read"],
      toolGroups: [...MCP_TOOL_GROUPS],
      acl: [],
    });
    await pastGrace(u.id);
    await adapter().update({
      model: "user",
      where: [{ field: "id", value: u.id }],
      update: { twoFactorEnabled: true },
    });
    const token = await prisma.mcpPersonalToken.findUniqueOrThrow({
      where: { id: minted.token.id },
    });
    expect(token.revokedAt !== null).toBe(revoked);
    const admit = createBearerAdmission({
      query,
      origin: runtime.canonicalOrigin,
      identityDb: prisma,
      verifyOAuth: async () => ({}),
    });
    if (revoked)
      await expect(admit(bearer(minted.secret))).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    else await expect(admit(bearer(minted.secret))).resolves.toBeDefined();
  });
  it.each(["ban", "2fa"])(
    "F4 all five controls deny a stale session after %s before effects",
    async (loss) => {
      const u = await user();
      const minted = await mintPersonalToken(runtime, u.id, {
        name: "control",
        scopes: ["mcp:read"],
        toolGroups: [...MCP_TOOL_GROUPS],
        acl: [],
      });
      const token = await prisma.mcpPersonalToken.findUniqueOrThrow({
        where: { id: minted.token.id },
      });
      const control = clients(u);
      expect((await control.tokens.listMine({})).items).toHaveLength(1);
      expect((await control.grants.listMine({})).items).toHaveLength(1);
      await pastGrace(u.id);
      await adapter().update({
        model: "user",
        where: [{ field: "id", value: u.id }],
        update:
          loss === "ban"
            ? { banned: true, banExpires: new Date(Date.now() + 3600_000) }
            : { role: "admin", twoFactorEnabled: false },
      });
      const auditBefore = await prisma.auditEvent.count();
      for (const op of [
        () =>
          control.tokens.create({
            name: "denied",
            scopes: ["mcp:read"],
            toolGroups: [...MCP_TOOL_GROUPS],
            acl: [],
          }),
        () => control.tokens.listMine({}),
        () => control.grants.listMine({}),
        () => control.tokens.revokeMine({ id: token.id }),
        () => control.grants.revokeMine({ id: token.grantId }),
      ])
        await expect(op()).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(await prisma.auditEvent.count()).toBe(auditBefore);
      expect(await prisma.mcpPersonalToken.count({ where: { userId: u.id } })).toBe(1);
      if (loss === "ban") {
        expect(
          (await prisma.mcpPersonalToken.findUniqueOrThrow({ where: { id: token.id } })).revokedAt,
        ).toBeNull();
        await adapter().update({
          model: "user",
          where: [{ field: "id", value: u.id }],
          update: { banned: false },
        });
        await expect(control.tokens.revokeMine({ id: token.id })).resolves.toMatchObject({
          revoked: true,
        });
      }
    },
  );
  it("F2 settlement excludes enrollment until paired tombstones commit; rollback/re-entry stays atomic", async () => {
    const u = await user();
    await prisma.user.update({
      where: { id: u.id },
      data: { role: "admin", twoFactorEnabled: false },
    });
    const minted = await mintPersonalToken(runtime, u.id, {
      name: "atomic",
      scopes: ["mcp:read"],
      toolGroups: [...MCP_TOOL_GROUPS],
      acl: [],
    });
    const pat = await prisma.mcpPersonalToken.findUniqueOrThrow({ where: { id: minted.token.id } });
    await pastGrace(u.id);
    const settle = (tx: import("@knowledge-base/db/client").Prisma.TransactionClient) =>
      revokeLapsedTwoFactorMcpGrants((sql, params) => tx.$executeRawUnsafe(sql, ...params), u.id);
    await expect(
      prisma.$transaction(async (tx) => {
        await lockIdentityAuthority(tx);
        await settle(tx);
        throw new Error("fixture rollback");
      }),
    ).rejects.toThrow("fixture rollback");
    expect(
      (await prisma.mcpGrant.findUniqueOrThrow({ where: { id: pat.grantId } })).revokedAt,
    ).toBeNull();
    expect(
      (await prisma.mcpPersonalToken.findUniqueOrThrow({ where: { id: pat.id } })).revokedAt,
    ).toBeNull();
    let release = () => {};
    let enter = () => {};
    const blocked = new Promise<void>((r) => {
      release = r;
    });
    const entered = new Promise<void>((r) => {
      enter = r;
    });
    const settlement = prisma.$transaction(
      async (tx) => {
        await lockIdentityAuthority(tx);
        await settle(tx);
        enter();
        await blocked;
      },
      { timeout: 10000 },
    );
    await entered;
    const enrollment = adapter().update({
      model: "user",
      where: [{ field: "id", value: u.id }],
      update: { twoFactorEnabled: true },
    });
    try {
      let waiting = false;
      for (let n = 0; n < 200 && !waiting; n++) {
        const observed = await query<{ waiting: boolean }>(`SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
            AND wait_event = 'advisory' AND query LIKE '%pg_advisory_xact_lock%') AS waiting`);
        waiting = observed.rows[0]!.waiting;
        if (!waiting) await new Promise((r) => setTimeout(r, 10));
      }
      expect(waiting).toBe(true);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).twoFactorEnabled).toBe(
        false,
      );
      expect(
        (await prisma.mcpGrant.findUniqueOrThrow({ where: { id: pat.grantId } })).revokedAt,
      ).toBeNull();
    } finally {
      release();
      await settlement;
      await enrollment;
    }
    const grant = await prisma.mcpGrant.findUniqueOrThrow({ where: { id: pat.grantId } });
    const token = await prisma.mcpPersonalToken.findUniqueOrThrow({ where: { id: pat.id } });
    expect(grant.revokedAt).not.toBeNull();
    expect(token.revokedAt).toEqual(grant.revokedAt);
    await prisma.$transaction(async (tx) => {
      await lockIdentityAuthority(tx);
      await settle(tx);
    });
    expect(
      (await prisma.mcpGrant.findUniqueOrThrow({ where: { id: pat.grantId } })).revokedAt,
    ).toEqual(grant.revokedAt);
  });
  it("a legacy covered admin (NULL grace start) gets no second grace via Better Auth set-role", async () => {
    const u = await user();
    await prisma.user.update({
      where: { id: u.id },
      data: {
        role: "admin",
        twoFactorEnabled: false,
        createdAt: new Date(Date.now() - 10 * 86_400_000),
        twoFactorGraceStartedAt: null,
      },
    });
    for (const role of ["user", "admin"]) {
      await adapter().update({
        model: "user",
        where: [{ field: "id", value: u.id }],
        update: { role },
      });
    }
    const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(row.role).toBe("admin");
    expect(row.twoFactorGraceStartedAt).toEqual(row.createdAt);
    expect(isTwoFactorRequirementSatisfied(row, true)).toBe(false);
  });

  it.each(["enrollment", "role", "sweep"])(
    "F3 quiet OAuth lapse is durable across %s",
    async (transition) => {
      const f = await consentCreator();
      await adapter().update({
        model: "user",
        where: [{ field: "id", value: f.u.id }],
        update: { role: "admin", twoFactorEnabled: false },
      });
      await pastGrace(f.u.id);
      if (transition === "sweep") await reapExpiredAuthTokens(new Date(), prisma);
      else
        await adapter().update({
          model: "user",
          where: [{ field: "id", value: f.u.id }],
          update: transition === "enrollment" ? { twoFactorEnabled: true } : { role: "user" },
        });
      expect(
        (await prisma.mcpGrant.findUniqueOrThrow({ where: { id: f.principal.grantId } })).revokedAt,
      ).not.toBeNull();
      await adapter().update({
        model: "user",
        where: [{ field: "id", value: f.u.id }],
        update: { twoFactorEnabled: true },
      });
      expect((await verifier.inspect(f.principal)).generationActive).toBe(false);
    },
  );
});

describe("R30 F6 library identity-taking capabilities", () => {
  it("rejects legacy impersonated consent without changing its approved grant", async () => {
    const f = await consentCreator();
    expect((await f.shrink()).grantId).toBe(f.principal.grantId);
    const before = await prisma.mcpGrant.findUniqueOrThrow({ where: { id: f.principal.grantId } });
    const impersonator = await user();
    await prisma.session.update({
      where: { id: f.session.id },
      data: { impersonatedBy: impersonator.id },
    });
    await expect(f.shrink()).rejects.toThrow();
    expect(await prisma.mcpGrant.findUniqueOrThrow({ where: { id: f.principal.grantId } })).toEqual(
      before,
    );
  });

  it("denies impersonation/password/email takeover and retains account management", async () => {
    const administrator = await user();
    await prisma.user.update({ where: { id: administrator.id }, data: { role: "admin" } });
    const target = await user();
    const kb = await activeKb(target.id);
    await expect(
      authorize({
        principal: { kind: "browser", userId: administrator.id },
        kbId: kb.id,
        operation: "read",
        store,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const secret = "disposable-R30-auth-signing-secret";
    const { knowledgeBaseAdminPermissions } = await import("@knowledge-base/auth/roles");
    const { defaultAc, userAc } = await import(
      pathToFileURL(
        resolve(
          import.meta.dirname,
          "../../../auth/node_modules/better-auth/dist/plugins/admin/access/index.mjs",
        ),
      ).href
    );
    const auth = betterAuth({
      baseURL: runtime.canonicalOrigin,
      secret,
      database: createBootstrapDatabaseAdapter(prisma),
      hooks: { before: rejectImpersonatedSession },
      trustedOrigins: [runtime.canonicalOrigin],
      rateLimit: { enabled: false },
      plugins: [
        admin({
          defaultRole: "user",
          roles: { admin: defaultAc.newRole(knowledgeBaseAdminPermissions), user: userAc },
        }),
        twoFactor(),
      ],
    });
    const ctx = await auth.$context;
    const session = await ctx.internalAdapter.createSession(administrator.id);
    const signature = createHmac("sha256", secret).update(session.token).digest("base64");
    const headers = {
      origin: runtime.canonicalOrigin,
      "content-type": "application/json",
      cookie: `${ctx.authCookies.sessionToken.name}=${encodeURIComponent(`${session.token}.${signature}`)}`,
    };
    const post = (route: string, body: object) =>
      auth.handler(
        new Request(`${runtime.canonicalOrigin}/api/auth/admin/${route}`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        }),
      );
    const before = await prisma.session.count({ where: { userId: target.id } });
    const impersonation = await post("impersonate-user", { userId: target.id });
    expect(impersonation.status).toBe(403);
    expect(await prisma.session.count({ where: { userId: target.id } })).toBe(before);
    expect(
      (
        await post("set-user-password", {
          userId: target.id,
          newPassword: "disposable-test-password",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await post("update-user", {
          userId: target.id,
          data: { email: "takeover@example.invalid", emailVerified: true },
        })
      ).status,
    ).toBe(403);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: target.id } })).email).toBe(
      target.email,
    );
    expect((await post("set-role", { userId: target.id, role: "user" })).status).toBe(200);
    expect(
      (
        await auth.handler(
          new Request(`${runtime.canonicalOrigin}/api/auth/admin/list-users`, { headers }),
        )
      ).status,
    ).toBe(200);
    const legacy = await prisma.session.create({
      data: {
        userId: target.id,
        token: randomUUID(),
        expiresAt: new Date(Date.now() + 3600_000),
        impersonatedBy: administrator.id,
      },
    });
    const legacySignature = createHmac("sha256", secret).update(legacy.token).digest("base64");
    const legacyHeaders = {
      ...headers,
      cookie: `${ctx.authCookies.sessionToken.name}=${encodeURIComponent(`${legacy.token}.${legacySignature}`)}`,
    };
    const legacyContext = {
      session: { user: target, session: legacy },
    } as unknown as import("@knowledge-base/api/context").Context;
    const controls = {
      tokens: createRouterClient(mcpTokensRouter, { context: legacyContext }),
      grants: createRouterClient(mcpGrantsRouter, { context: legacyContext }),
    };
    const auditBefore = await prisma.auditEvent.count();
    for (const action of [
      () =>
        controls.tokens.create({
          name: "takeover",
          scopes: ["mcp:write"],
          toolGroups: [...MCP_TOOL_GROUPS],
          acl: [{ kbId: kb.id, bits: ["manage"] }],
        }),
      () => controls.tokens.listMine({}),
      () => controls.tokens.revokeMine({ id: "irrelevant" }),
      () => controls.grants.listMine({}),
      () => controls.grants.revokeMine({ id: randomUUID() }),
    ]) {
      await expect(action()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    }
    expect(await prisma.auditEvent.count()).toBe(auditBefore);
    expect(await prisma.mcpPersonalToken.count({ where: { userId: target.id } })).toBe(0);
    for (const state of ["demoted", "banned", "removed"]) {
      if (state === "removed") await prisma.user.delete({ where: { id: administrator.id } });
      else
        await prisma.user.update({
          where: { id: administrator.id },
          data: state === "demoted" ? { role: "user" } : { banned: true },
        });
      expect(
        (
          await auth.handler(
            new Request(`${runtime.canonicalOrigin}/api/auth/get-session`, {
              headers: legacyHeaders,
            }),
          )
        ).status,
      ).toBe(403);
    }
    const signout = await auth.handler(
      new Request(`${runtime.canonicalOrigin}/api/auth/sign-out`, {
        method: "POST",
        headers: legacyHeaders,
        body: "{}",
      }),
    );
    expect(signout.status).toBe(200);
    expect(await prisma.session.findUnique({ where: { id: legacy.id } })).toBeNull();
  });
});

describe("R46r2 live committing policy authority", () => {
  beforeEach(async () => {
    await prisma.appSetting.upsert({
      where: { key: "force2faPublicUsers" },
      create: { key: "force2faPublicUsers", value: "false" },
      update: { value: "false" },
    });
    await prisma.appSetting.upsert({
      where: { key: "force2faInternalUsers" },
      create: { key: "force2faInternalUsers", value: "true" },
      update: { value: "true" },
    });
  });

  const ctx = (u: Awaited<ReturnType<typeof user>>) =>
    ({
      session: { user: u, session: { impersonatedBy: null } },
    }) as unknown as import("@knowledge-base/api/context").Context;

  it.each(["role", "ban", "2fa", "email", "deleted"])(
    "denies stale administrator %s at all four writers without effects",
    async (loss) => {
      const actor = await prisma.user.create({
        data: {
          name: "Live admin",
          email: `${randomUUID()}@example.invalid`,
          role: "admin",
          emailVerified: true,
          twoFactorEnabled: true,
          createdAt: new Date(Date.now() - 2 * DAY_MS),
        },
      });
      const target = await user();
      const minted = await mintPersonalToken(runtime, target.id, {
        name: "untouched",
        ...readOnly,
      });
      const setting = await prisma.appSetting.findUnique({
        where: { key: "force2faInternalUsers" },
      });
      const context = ctx(actor);
      if (loss === "deleted") await prisma.user.delete({ where: { id: actor.id } });
      else
        await betterAuthUserWrite(
          actor.id,
          loss === "role"
            ? { role: "user" }
            : loss === "ban"
              ? { banned: true, banExpires: new Date(Date.now() + DAY_MS) }
              : loss === "email"
                ? { emailVerified: false }
                : { twoFactorEnabled: false },
        );
      const settings = createRouterClient(settingsRouter, { context });
      const users = createRouterClient(usersRouter, { context });
      const attempts = await Promise.allSettled([
        settings.update({ key: "force2faInternalUsers", value: "false" }),
        users.setRole({ userId: target.id, role: "admin" }),
        users.archive({ userId: target.id }),
        users.unarchive({ userId: target.id }),
      ]);
      expect(attempts.map((attempt) => attempt.status)).toEqual(Array(4).fill("rejected"));
      for (const attempt of attempts) {
        if (attempt.status === "rejected")
          expect(attempt.reason).toMatchObject({ code: "NOT_FOUND" });
      }
      expect(
        await prisma.appSetting.findUnique({ where: { key: "force2faInternalUsers" } }),
      ).toEqual(setting);
      expect(await prisma.user.findUnique({ where: { id: target.id } })).toMatchObject({
        role: target.role,
        banned: target.banned,
      });
      expect(
        (await prisma.mcpPersonalToken.findUniqueOrThrow({ where: { id: minted.token.id } }))
          .revokedAt,
      ).toBeNull();
    },
  );

  it("requires live enrollment when enabling policy, even inside grace with an enrolled snapshot", async () => {
    const actor = await prisma.user.create({
      data: {
        name: "Grace admin",
        email: `${randomUUID()}@example.invalid`,
        role: "admin",
        emailVerified: true,
        twoFactorEnabled: true,
      },
    });
    const settings = createRouterClient(settingsRouter, { context: ctx(actor) });
    await betterAuthUserWrite(actor.id, { twoFactorEnabled: false });
    const before = await prisma.appSetting.findUnique({ where: { key: "force2faPublicUsers" } });
    await expect(
      settings.update({ key: "force2faPublicUsers", value: "true" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await prisma.appSetting.findUnique({ where: { key: "force2faPublicUsers" } })).toEqual(
      before,
    );
    await expect(
      settings.update({ key: "force2faInternalUsers", value: "false" }),
    ).resolves.toEqual({ success: true });
    await prisma.appSetting.upsert({
      where: { key: "force2faInternalUsers" },
      create: { key: "force2faInternalUsers", value: "true" },
      update: { value: "true" },
    });
  });

  it("reloads the actor after waiting for authority; legitimate policy/role/archive/unarchive still work", async () => {
    const actor = await prisma.user.create({
      data: {
        name: "Admin",
        email: `${randomUUID()}@example.invalid`,
        role: "admin",
        emailVerified: true,
        twoFactorEnabled: true,
      },
    });
    const target = await user();
    const settings = createRouterClient(settingsRouter, { context: ctx(actor) });
    const users = createRouterClient(usersRouter, { context: ctx(actor) });
    await settings.update({ key: "force2faPublicUsers", value: "false" });
    await users.setRole({ userId: target.id, role: "admin" });
    await users.archive({ userId: target.id });
    await users.unarchive({ userId: target.id });
    expect(await prisma.user.findUnique({ where: { id: target.id } })).toMatchObject({
      role: "admin",
      banned: false,
    });
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((r) => {
      release = r;
    });
    const ready = new Promise<void>((r) => {
      entered = r;
    });
    const change = prisma.$transaction(
      async (tx) => {
        await lockIdentityAuthority(tx);
        await tx.user.update({ where: { id: actor.id }, data: { role: "user" } });
        entered();
        await blocked;
      },
      { timeout: 10000 },
    );
    await ready;
    const mutation = settings.update({ key: "force2faPublicUsers", value: "true" });
    const denial = expect(mutation).rejects.toMatchObject({ code: "NOT_FOUND" });
    try {
      await waitForDatabaseLock("advisory", "pg_advisory_xact_lock");
    } finally {
      release();
      await change;
    }
    await denial;
    expect(
      await prisma.appSetting.findUnique({ where: { key: "force2faPublicUsers" } }),
    ).toMatchObject({ value: "false" });
    await prisma.appSetting.delete({ where: { key: "force2faPublicUsers" } });
  });
});

async function waitForDatabaseLock(event: string, text: string) {
  for (let n = 0; n < 250; n++) {
    const result = await query<{ waiting: boolean }>(
      `SELECT EXISTS (
      SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
        AND wait_event_type = 'Lock' AND ($1 = '*' OR wait_event = $1)
        AND query LIKE $2) AS waiting`,
      [event, `%${text}%`],
    );
    if (result.rows[0]?.waiting) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`No observed database lock: ${event}/${text}`);
}

function admitOwned() {
  return createBearerAdmission({
    withQuery: credentialQuery(db.urls.runtime),
    origin: runtime.canonicalOrigin,
    verifyOAuth: async () => {
      throw new Error("PAT never invokes OAuth");
    },
  });
}

describe("R46r2 outgoing lapse across real row contention", () => {
  beforeEach(async () => {
    await prisma.appSetting.upsert({
      where: { key: "force2faPublicUsers" },
      create: { key: "force2faPublicUsers", value: "false" },
      update: { value: "false" },
    });
    await prisma.appSetting.upsert({
      where: { key: "force2faInternalUsers" },
      create: { key: "force2faInternalUsers", value: "true" },
      update: { value: "true" },
    });
  });

  it.each(["exact", "bulk", "transactional", "role", "policy", "before-deadline"])(
    "%s preserves the outgoing deadline and exact generation",
    async (mode) => {
      const actor = await prisma.user.create({
        data: {
          name: "Admin",
          email: `${randomUUID()}@example.invalid`,
          role: "admin",
          emailVerified: true,
          twoFactorEnabled: true,
        },
      });
      const member = await prisma.user.create({
        data: {
          name: "Deadline",
          email: `${randomUUID()}@example.invalid`,
          role: "admin",
          emailVerified: true,
          twoFactorEnabled: false,
        },
      });
      const minted = await mintPersonalToken(runtime, member.id, { name: "outgoing", ...readOnly });
      const token = await prisma.mcpPersonalToken.findUniqueOrThrow({
        where: { id: minted.token.id },
      });
      const adapter = createBootstrapDatabaseAdapter(prisma)({ plugins: [admin(), twoFactor()] });
      // A wall-clock deadline, not a fake verifier clock: the production SQL owns it.
      const deadline = Date.now() + (mode === "before-deadline" ? 60000 : 1600);
      await prisma.user.update({
        where: { id: member.id },
        data: { createdAt: new Date(deadline - DAY_MS) },
      });
      if (mode === "policy")
        await prisma.appSetting.upsert({
          where: { key: "force2faInternalUsers" },
          create: { key: "force2faInternalUsers", value: "true" },
          update: { value: "true" },
        });
      let release!: () => void;
      let entered!: () => void;
      const blocked = new Promise<void>((r) => {
        release = r;
      });
      const ready = new Promise<void>((r) => {
        entered = r;
      });
      const blocker = prisma.$transaction(
        async (tx) => {
          if (mode === "policy")
            await tx.$queryRaw`SELECT key FROM app_setting WHERE key = 'force2faInternalUsers' FOR UPDATE`;
          else await tx.$queryRaw`SELECT id FROM "user" WHERE id = ${member.id} FOR UPDATE`;
          entered();
          await blocked;
        },
        { timeout: 10000 },
      );
      await ready;
      const args = {
        model: "user",
        where: [{ field: "id", value: member.id }],
        update: { twoFactorEnabled: true },
      };
      const mutation =
        mode === "bulk"
          ? adapter.updateMany(args)
          : mode === "transactional"
            ? adapter.transaction((tx) => tx.update(args))
            : mode === "role"
              ? createRouterClient(usersRouter, {
                  context: { session: { user: actor, session: {} } },
                }).setRole({ userId: member.id, role: "user" })
              : mode === "policy"
                ? createRouterClient(settingsRouter, {
                    context: { session: { user: actor, session: {} } },
                  }).update({ key: "force2faInternalUsers", value: "false" })
                : adapter.update(args);
      // Observe the production UPDATE waiting while outgoing evidence is still live.
      const finished = mutation.then(
        () => null,
        (error: unknown) => error,
      );
      try {
        await waitForDatabaseLock(
          "*",
          // A writer's first user-row UPDATE may be the grace-start write-down
          // (`UPDATE "user" u ...`) rather than Prisma's `UPDATE "public"."user"`.
          mode === "policy" ? "app_setting" : 'UPDATE "%user"',
        );
        expect(Date.now()).toBeLessThan(deadline);
        if (mode !== "before-deadline")
          await new Promise((r) => setTimeout(r, Math.max(0, deadline + 100 - Date.now())));
      } finally {
        release();
        await blocker;
      }
      expect(await finished).toBeNull();
      const old = await prisma.mcpPersonalToken.findUniqueOrThrow({
        where: { id: token.id },
        include: { grant: true },
      });
      const admission = await admitOwned()(bearer(minted.secret)).then(
        () => "admitted",
        () => "denied",
      );
      expect({
        patRevoked: old.revokedAt !== null,
        grantRevoked: old.grant.revokedAt !== null,
        admission,
      }).toEqual(
        mode === "before-deadline"
          ? { patRevoked: false, grantRevoked: false, admission: "admitted" }
          : { patRevoked: true, grantRevoked: true, admission: "denied" },
      );
      if (mode !== "before-deadline") {
        expect(old.grant.revokeReason).toBe("forced_2fa");
        expect(old.revokedAt).toEqual(old.grant.revokedAt);
      }
      const fresh = await mintPersonalToken(runtime, member.id, { name: "successor", ...readOnly });
      await betterAuthUserWrite(member.id, { name: "Later update" });
      expect(
        (await prisma.mcpPersonalToken.findUniqueOrThrow({ where: { id: fresh.token.id } }))
          .revokedAt,
      ).toBeNull();
      await expect(admitOwned()(bearer(fresh.secret))).resolves.toBeDefined();
      if (mode === "policy")
        await prisma.appSetting.delete({ where: { key: "force2faInternalUsers" } });
    },
  );

  it.each([false, true])(
    "settles an outer transaction callback delayed past grace (late=%s)",
    async (late) => {
      const member = await prisma.user.create({
        data: {
          name: "Commit deadline",
          email: `${randomUUID()}@example.invalid`,
          role: "admin",
          emailVerified: true,
          twoFactorEnabled: false,
        },
      });
      const minted = await mintPersonalToken(runtime, member.id, {
        name: "commit deadline",
        ...readOnly,
      });
      const deadline = Date.now() + 1600;
      await prisma.user.update({
        where: { id: member.id },
        data: { createdAt: new Date(deadline - DAY_MS) },
      });
      const adapter = createBootstrapDatabaseAdapter(prisma)({ plugins: [admin(), twoFactor()] });
      await adapter.transaction(async (tx) => {
        await tx.update({
          model: "user",
          where: [{ field: "id", value: member.id }],
          update: { twoFactorEnabled: true },
        });
        expect(Date.now()).toBeLessThan(deadline);
        if (late) await new Promise((r) => setTimeout(r, Math.max(0, deadline + 100 - Date.now())));
      });
      const old = await prisma.mcpPersonalToken.findUniqueOrThrow({
        where: { id: minted.token.id },
        include: { grant: true },
      });
      const admission = await admitOwned()(bearer(minted.secret)).then(
        () => "admitted",
        () => "denied",
      );
      expect({
        patRevoked: old.revokedAt !== null,
        grantRevoked: old.grant.revokedAt !== null,
        admission,
      }).toEqual(
        late
          ? { patRevoked: true, grantRevoked: true, admission: "denied" }
          : { patRevoked: false, grantRevoked: false, admission: "admitted" },
      );
      const fresh = await mintPersonalToken(runtime, member.id, {
        name: "commit successor",
        ...readOnly,
      });
      await expect(admitOwned()(bearer(fresh.secret))).resolves.toBeDefined();
    },
  );

  it("adapter rollback discards outgoing tombstones; re-entry and repeated updates preserve enrolled generations", async () => {
    const member = await prisma.user.create({
      data: {
        name: "Rollback",
        email: `${randomUUID()}@example.invalid`,
        role: "admin",
        emailVerified: true,
        twoFactorEnabled: false,
      },
    });
    const minted = await mintPersonalToken(runtime, member.id, { name: "rollback", ...readOnly });
    await prisma.user.update({
      where: { id: member.id },
      data: { createdAt: new Date(Date.now() - 2 * DAY_MS) },
    });
    const adapter = createBootstrapDatabaseAdapter(prisma)({ plugins: [admin(), twoFactor()] });
    const args = {
      model: "user",
      where: [{ field: "id", value: member.id }],
      update: { twoFactorEnabled: true },
    };
    await expect(
      adapter.transaction(async (tx) => {
        await tx.update(args);
        throw new Error("outgoing rollback");
      }),
    ).rejects.toThrow("outgoing rollback");
    expect(
      (await prisma.mcpPersonalToken.findUniqueOrThrow({ where: { id: minted.token.id } }))
        .revokedAt,
    ).toBeNull();
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: member.id } })).twoFactorEnabled,
    ).toBe(false);
    await adapter.update(args);
    expect(
      (await prisma.mcpPersonalToken.findUniqueOrThrow({ where: { id: minted.token.id } }))
        .revokedAt,
    ).not.toBeNull();
    const fresh = await mintPersonalToken(runtime, member.id, { name: "reenrolled", ...readOnly });
    await adapter.transaction(async (tx) => {
      await tx.update(args);
      await tx.update({ ...args, update: { name: "metadata" } });
    });
    expect(
      (await prisma.mcpPersonalToken.findUniqueOrThrow({ where: { id: fresh.token.id } }))
        .revokedAt,
    ).toBeNull();
  });
});

describe("R34a complete credential inspection", () => {
  let creator: Awaited<ReturnType<typeof consentCreator>>;
  // Seed the realistic 13-owner/256-share approval under the existing fixture
  // hook budget; the behavioral test retains the suite's unchanged deadline.
  beforeAll(async () => {
    setKbRecoveryComplete(true);
    creator = await consentCreator(256);
  });
  it("F5 pages the 257th creator ACL without clipping a 256-entry approval or duplicating a retry", async () => {
    setKbRecoveryComplete(true);
    const f = creator;
    const before = await listGrants(runtime, f.u.id, { kind: "OAUTH" });
    expect(before.items[0]?.acl).toHaveLength(256);
    expect(before.items[0]?.aclNextCursor).toBeNull();
    const repeated = (await listGrants(runtime, f.u.id, { kind: "OAUTH" })).items[0]!;
    expect(repeated.acl).toEqual(before.items[0]?.acl);
    expect(repeated.aclSnapshot).not.toBe(before.items[0]?.aclSnapshot);
    const input = {
      name: "R34a creator",
      slug: `r34a-${randomUUID().slice(0, 8)}`,
      description: "R34a creator ACL fixture",
      idempotencyKey: randomUUID(),
    };
    const created = await createKnowledgeBaseAsGrant(runtime, f.principal, verifier, input);
    const retry = await createKnowledgeBaseAsGrant(runtime, f.principal, verifier, input);
    const createdKb = created.kb as { id: string };
    expect((retry.kb as { id: string }).id).toBe(createdKb.id);
    const row = (await listGrants(runtime, f.u.id, { kind: "OAUTH" })).items[0]!;
    expect(row.acl).toHaveLength(256);
    expect(row.aclNextCursor).not.toBeNull();
    const remainder = await listGrantAcl(runtime, f.u.id, {
      grantId: row.id,
      cursor: row.aclNextCursor,
      limit: 50,
    });
    const all = [...row.acl, ...remainder.items];
    expect(all).toHaveLength(257);
    expect(new Set(all.map((a) => a.kbId)).size).toBe(257);
    expect(all).toContainEqual({
      kbId: createdKb.id,
      bits: ["read", "propose", "write", "review", "manage"],
      // The creator owns it, so the row carries its name for display.
      name: input.name,
    });
    expect(remainder.nextCursor).toBeNull();
    const stranger = await user();
    await expect(listGrantAcl(runtime, stranger.id, { grantId: row.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await revokeGrant(runtime, f.u.id, row.id);
    expect((await listGrantAcl(runtime, f.u.id, { grantId: row.id, limit: 2 })).items).toHaveLength(
      2,
    );
    expect(await prisma.grantKbAcl.count({ where: { grantId: row.id } })).toBe(257);
  });

  it("F6 filters kinds before pagination while preserving PAT and OAuth tombstones", async () => {
    const owner = await user();
    await prisma.mcpGrant.createMany({
      data: Array.from({ length: 20 }, (_, i) => ({
        id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        userId: owner.id,
        actorUserIdSnapshot: owner.id,
        kind: "PAT" as const,
        clientId: `pat-${i}`,
        referenceId: randomUUID(),
        scopes: ["mcp:read"],
        toolGroups: ["read"],
        createdKbBits: [],
        revokedAt: new Date(),
      })),
    });
    const appIds = ["ffffffff-ffff-4fff-8fff-fffffffffff1", "ffffffff-ffff-4fff-8fff-fffffffffff2"];
    await prisma.mcpGrant.createMany({
      data: appIds.map((id, i) => ({
        id,
        userId: owner.id,
        actorUserIdSnapshot: owner.id,
        kind: "OAUTH" as const,
        clientId: `app-${i}`,
        referenceId: randomUUID(),
        scopes: ["mcp:read"],
        toolGroups: ["read"],
        createdKbBits: [],
        revokedAt: i ? new Date() : null,
      })),
    });
    const all = await listGrants(runtime, owner.id, { limit: 20 });
    expect(all.items).toHaveLength(20);
    expect(all.items.every((g) => g.kind === "PAT" && g.revokedAt)).toBe(true);
    expect(all.nextCursor).not.toBeNull();
    const first = await listGrants(runtime, owner.id, { kind: "OAUTH", limit: 1 });
    expect(first.items.map((g) => g.id)).toEqual([appIds[0]]);
    const second = await listGrants(runtime, owner.id, {
      kind: "OAUTH",
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(second.items[0]?.id).toBe(appIds[1]);
    expect(second.items[0]?.revokedAt).not.toBeNull();
    expect(second.nextCursor).toBeNull();
    expect((await listGrants(runtime, (await user()).id, { kind: "OAUTH" })).items).toEqual([]);
  });
});

describe("revoke all after a password reset", () => {
  it("counts and revokes live credentials past more than 1,000 historical rows", async () => {
    const owner = await user();
    const other = await user();
    // 1,050 OAuth grants in id order; only #5 and #1,020 are live (pages 1 and
    // 51 of a 20-row list), the rest are revoked history.
    const prefix = randomUUID().slice(0, 8);
    const id = (n: number) => `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;
    await prisma.mcpGrant.createMany({
      data: Array.from({ length: 1050 }, (_, i) => ({
        id: id(i + 1),
        kind: "OAUTH" as const,
        actorUserIdSnapshot: owner.id,
        userId: owner.id,
        clientId: "history-client",
        referenceId: `ref-${i + 1}`,
        scopes: ["mcp:read"],
        toolGroups: ["read"],
        createdKbBits: [],
        revokedAt: i + 1 === 5 || i + 1 === 1020 ? null : new Date(),
      })),
    });
    const pat = await mintPersonalToken(runtime, owner.id, {
      name: "live-pat",
      scopes: ["mcp:read"],
      toolGroups: ["read"],
      acl: [],
    });
    const othersPat = await mintPersonalToken(runtime, other.id, {
      name: "someone-else",
      scopes: ["mcp:read"],
      toolGroups: ["read"],
      acl: [],
    });

    await expect(countActiveCredentials(runtime, owner.id)).resolves.toEqual({
      tokens: 1,
      apps: 2,
    });
    await expect(revokeAllCredentials(runtime, owner.id)).resolves.toEqual({
      tokens: 1,
      apps: 2,
    });
    await expect(countActiveCredentials(runtime, owner.id)).resolves.toEqual({
      tokens: 0,
      apps: 0,
    });
    expect(await prisma.mcpGrant.count({ where: { userId: owner.id, revokedAt: null } })).toBe(0);
    // Every revoked credential has its own audit event (not just the first).
    const patGrant = await prisma.mcpPersonalToken.findUniqueOrThrow({
      where: { id: pat.token.id },
      select: { grantId: true },
    });
    const revokedIds = [id(5), id(1020), patGrant.grantId];
    const events = await prisma.auditEvent.findMany({
      where: { action: "grant_revoke", grantIdSnapshot: { in: revokedIds } },
      select: { grantIdSnapshot: true, opId: true },
      // pagination:audited — bounded by the three revoked grants
      take: 10,
    });
    expect(new Set(events.map((event) => event.grantIdSnapshot))).toEqual(new Set(revokedIds));
    expect(new Set(events.map((event) => event.opId)).size).toBe(3);
    expect(
      (await prisma.mcpPersonalToken.findUniqueOrThrow({ where: { id: pat.token.id } })).revokedAt,
    ).not.toBeNull();
    // Another user's credentials are untouched; a second run is a no-op.
    expect(
      (await prisma.mcpPersonalToken.findUniqueOrThrow({ where: { id: othersPat.token.id } }))
        .revokedAt,
    ).toBeNull();
    await expect(revokeAllCredentials(runtime, owner.id)).resolves.toEqual({
      tokens: 0,
      apps: 0,
    });
  });
});

type Versioner = ReturnType<typeof CreateSessionCacheVersion>;

describe("R3 cached session authority and server-owned user columns", () => {
  const secret = "disposable-R3-cookie-cache-signing-secret";
  let resetToken = "";
  async function authWithCookieCache(aroundVersion?: (version: Versioner) => Versioner) {
    const { knowledgeBaseAdminPermissions } = await import("@knowledge-base/auth/roles");
    const { createSessionCacheVersion } = await import("@knowledge-base/auth/session-authority");
    const { defaultAc, userAc } = await import(
      pathToFileURL(
        resolve(
          import.meta.dirname,
          "../../../auth/node_modules/better-auth/dist/plugins/admin/access/index.mjs",
        ),
      ).href
    );
    // The production session settings: 60 s signed cookie cache, versioned by
    // the live session/user lookup; reset revokes every session.
    return betterAuth({
      baseURL: runtime.canonicalOrigin,
      secret,
      database: createBootstrapDatabaseAdapter(prisma),
      trustedOrigins: [runtime.canonicalOrigin],
      rateLimit: { enabled: false },
      emailAndPassword: {
        enabled: true,
        revokeSessionsOnPasswordReset: true,
        sendResetPassword: async ({ token }) => {
          resetToken = token;
        },
      },
      user: {
        additionalFields: {
          twoFactorGraceStartedAt: { type: "date", required: false, input: false },
          authorityVersion: { type: "number", required: false, defaultValue: 0, input: false },
        },
      },
      session: {
        cookieCache: {
          enabled: true,
          maxAge: 60,
          version: (aroundVersion ?? ((v: Versioner) => v))(createSessionCacheVersion(prisma)),
        },
      },
      plugins: [
        admin({
          defaultRole: "user",
          roles: { admin: defaultAc.newRole(knowledgeBaseAdminPermissions), user: userAc },
        }),
        twoFactor(),
      ],
    });
  }
  type Auth = Awaited<ReturnType<typeof authWithCookieCache>>;
  const cookiesOf = (res: Response) =>
    res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0] ?? "")
      .filter((c) => !c.endsWith("="))
      .join("; ");
  async function signedIn(auth: Auth, email: string, password: string) {
    const res = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
    expect(res.status).toBe(200);
    const cookie = cookiesOf(res);
    // The cached copy is what a stolen cookie would replay.
    expect(cookie).toContain("session_data=");
    return cookie;
  }
  const cookiesOfHeaders = (headers: Headers | null | undefined) =>
    (headers?.getSetCookie() ?? [])
      .map((c) => c.split(";")[0] ?? "")
      .filter((c) => !c.endsWith("="))
      .join("; ");
  const sessionFor = (auth: Auth, cookie: string) =>
    auth.api.getSession({ headers: new Headers({ cookie }) });
  const mintWith = async (auth: Auth, cookie: string, name: string) =>
    createRouterClient(mcpTokensRouter, {
      context: { session: await sessionFor(auth, cookie) } as never,
    }).create({ name, scopes: ["mcp:read"], toolGroups: ["read"], acl: [] });

  it("a pre-reset cookie (with its signed cache) authenticates nothing after a reset", async () => {
    const auth = await authWithCookieCache();
    const email = `${randomUUID()}@example.invalid`;
    await auth.api.signUpEmail({ body: { email, password: "first-password-123", name: "R" } });
    const cookie = await signedIn(auth, email, "first-password-123");
    await mintWith(auth, cookie, "before-reset");
    const owner = await prisma.user.findUniqueOrThrow({ where: { email } });

    await auth.api.requestPasswordReset({ body: { email, redirectTo: "/reset" } });
    await auth.api.resetPassword({
      body: { newPassword: "second-password-456", token: resetToken },
    });

    expect(await sessionFor(auth, cookie)).toBeNull();
    await expect(mintWith(auth, cookie, "stolen")).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(await prisma.mcpPersonalToken.count({ where: { userId: owner.id } })).toBe(1);
  });

  // The same cache must not hide any other security event: each one deletes
  // the session row or rewrites the user, and the next request sees it.
  it.each([
    ["session revoked", "revoke"],
    ["sessions revoked by a temporary ban", "ban"],
    ["role changed", "role"],
    ["2FA enabled", "2fa-on"],
  ] as const)("a cached cookie sees %s on the next request", async (_name, event) => {
    const auth = await authWithCookieCache();
    const email = `${randomUUID()}@example.invalid`;
    await auth.api.signUpEmail({ body: { email, password: "first-password-123", name: "R" } });
    const cookie = await signedIn(auth, email, "first-password-123");
    const u = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect((await sessionFor(auth, cookie))?.user.role).toBe("user");
    const write = (update: Record<string, unknown>) =>
      createBootstrapDatabaseAdapter(prisma)({ plugins: [admin(), twoFactor()] }).update({
        model: "user",
        where: [{ field: "id", value: u.id }],
        update,
      });
    if (event === "revoke") await prisma.session.deleteMany({ where: { userId: u.id } });
    if (event === "ban") {
      await write({ banned: true, banExpires: new Date(Date.now() + 3600_000) });
      await prisma.session.deleteMany({ where: { userId: u.id } });
    }
    if (event === "role") await write({ role: "admin" });
    if (event === "2fa-on") await write({ twoFactorEnabled: true });
    const seen = await sessionFor(auth, cookie);
    if (event === "revoke" || event === "ban") expect(seen).toBeNull();
    if (event === "role") expect(seen?.user.role).toBe("admin");
    if (event === "2fa-on") expect(seen?.user.twoFactorEnabled).toBe(true);
  });

  it("an unchanged session keeps reusing its cache (the version is not a nonce)", async () => {
    const versions: string[] = [];
    const auth = await authWithCookieCache((version) => async (session, user) => {
      const value = await version(session, user);
      versions.push(value);
      return value;
    });
    const email = `${randomUUID()}@example.invalid`;
    await auth.api.signUpEmail({ body: { email, password: "first-password-123", name: "R" } });
    const signIn = await auth.api.signInEmail({
      body: { email, password: "first-password-123" },
      asResponse: true,
    });
    // The sign-in response may stamp its cache before its own session row is
    // visible (a nonce: one extra load, never a reusable stale cache). Take
    // the cache from a settled read and reuse that.
    const warm = await auth.api.getSession({
      headers: new Headers({ cookie: cookiesOf(signIn) }),
      query: { disableCookieCache: true },
      returnHeaders: true,
    });
    const cookie = [cookiesOf(signIn), cookiesOfHeaders(warm.headers)].join("; ");
    versions.length = 0;
    expect(await sessionFor(auth, cookie)).not.toBeNull();
    expect(await sessionFor(auth, cookie)).not.toBeNull();
    expect(versions.length).toBe(2);
    expect(versions.filter((value) => value.startsWith("stale."))).toEqual([]);
  });

  // Better Auth stamps the version when it WRITES the cache, from the
  // snapshot it just loaded. A reset or demotion landing between the load
  // and the stamp must not yield a cache that later requests accept.
  it.each([
    ["the session is revoked (reset)", "revoke"],
    ["the user is demoted", "demote"],
  ] as const)("a cache written while %s concurrently is never reused", async (_name, race) => {
    let target = "";
    let armed = false;
    const auth = await authWithCookieCache((version) => async (session, user) => {
      if (armed) {
        armed = false;
        if (race === "revoke") await prisma.session.deleteMany({ where: { userId: target } });
        else await prisma.user.update({ where: { id: target }, data: { role: "user" } });
      }
      return version(session, user);
    });
    const email = `${randomUUID()}@example.invalid`;
    await auth.api.signUpEmail({ body: { email, password: "first-password-123", name: "R" } });
    const u = await prisma.user.update({ where: { email }, data: { role: "admin" } });
    target = u.id;
    const cookie = await signedIn(auth, email, "first-password-123");
    // Force a fresh load + cache write; the race runs inside its stamp.
    armed = true;
    const fresh = await auth.api.getSession({
      headers: new Headers({ cookie }),
      query: { disableCookieCache: true },
      returnHeaders: true,
    });
    expect(fresh.response?.user.role).toBe("admin"); // the stale snapshot
    const rewritten = [cookie, cookiesOfHeaders(fresh.headers)].filter(Boolean).join("; ");
    const later = await sessionFor(auth, rewritten);
    if (race === "revoke") expect(later).toBeNull();
    else expect(later?.user.role).toBe("user");
  });

  it("a cached cookie sees a grace start written by policy activation (raw SQL)", async () => {
    const auth = await authWithCookieCache();
    const email = `${randomUUID()}@example.invalid`;
    await auth.api.signUpEmail({ body: { email, password: "first-password-123", name: "R" } });
    await prisma.user.update({
      where: { email },
      data: { createdAt: new Date(Date.now() - 10 * 86_400_000) },
    });
    const cookie = await signedIn(auth, email, "first-password-123");
    expect((await sessionFor(auth, cookie))?.user.twoFactorGraceStartedAt ?? null).toBeNull();
    await prisma.$transaction((tx) =>
      recordTwoFactorGraceStartForPolicyActivation(
        (sql, params) => tx.$executeRawUnsafe(sql, ...params),
        "force2faPublicUsers",
      ),
    );
    const seen = await sessionFor(auth, cookie);
    expect(seen?.user.twoFactorGraceStartedAt).toBeTruthy();
  });

  it("Better Auth /admin/create-user cannot smuggle server-owned columns through `data`", async () => {
    const auth = await authWithCookieCache();
    const administrator = await user();
    await prisma.user.update({ where: { id: administrator.id }, data: { role: "admin" } });
    const ctx = await auth.$context;
    const session = await ctx.internalAdapter.createSession(administrator.id);
    const signature = createHmac("sha256", secret).update(session.token).digest("base64");
    const email = `${randomUUID()}@example.invalid`;
    const res = await auth.handler(
      new Request(`${runtime.canonicalOrigin}/api/auth/admin/create-user`, {
        method: "POST",
        headers: {
          origin: runtime.canonicalOrigin,
          "content-type": "application/json",
          cookie: `${ctx.authCookies.sessionToken.name}=${encodeURIComponent(`${session.token}.${signature}`)}`,
        },
        body: JSON.stringify({
          email,
          name: "Smuggler",
          role: "user",
          data: {
            id: "chosen-id-chosen-id-chosen-id12",
            createdAt: "2099-01-01T00:00:00.000Z",
            updatedAt: "2099-01-01T00:00:00.000Z",
            twoFactorEnabled: true,
            twoFactorGraceStartedAt: "2099-01-01T00:00:00.000Z",
            operationalAlerts: false,
          },
        }),
      }),
    );
    expect(res.status).toBe(200);
    const row = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(row.id).not.toBe("chosen-id-chosen-id-chosen-id12");
    expect(row.createdAt.getTime()).toBeLessThan(Date.now() + 60_000);
    expect(row.twoFactorEnabled).toBe(false);
    expect(row.twoFactorGraceStartedAt).toBeNull();
    expect(row.operationalAlerts).toBe(true);
    // A later promotion derives the grace start on the server, now.
    await createBootstrapDatabaseAdapter(prisma)({ plugins: [admin(), twoFactor()] }).update({
      model: "user",
      where: [{ field: "id", value: row.id }],
      update: { role: "admin", twoFactorGraceStartedAt: new Date("2099-01-01") },
    });
    const promoted = await prisma.user.findUniqueOrThrow({ where: { id: row.id } });
    expect(promoted.twoFactorGraceStartedAt?.getTime() ?? 0).toBeLessThan(Date.now() + 60_000);
  });
});
