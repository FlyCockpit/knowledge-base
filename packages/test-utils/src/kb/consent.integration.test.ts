import { createHmac, randomUUID } from "node:crypto";
import { prismaAssetQuery } from "@knowledge-base/api/lib/kb/asset-authz";
import { createGrantCredentialVerifier } from "@knowledge-base/api/lib/mcp-token-access";
import { createMcpConsentService, McpSealedConsentError } from "@knowledge-base/auth/mcp-consent";
import { issueMcpGenerationClaims } from "@knowledge-base/auth/mcp-refresh";
import { MCP_TOOL_GROUPS } from "@knowledge-base/auth/mcp-tool-groups";
import { lockIdentityAuthority } from "@knowledge-base/db/authority-lock";
import { afterAll, describe, expect, it } from "vitest";
import { openKbPostgresClusterFromEnv } from "./index";

const cluster = await openKbPostgresClusterFromEnv();
const db = await cluster.createDatabase();
db.applyPrismaSchema();
const prisma = db.createPrismaClient("runtime");
const secret = "disposable-consent-integration-secret";
const resource = "https://consent.example.invalid/mcp";
const service = createMcpConsentService({ db: prisma, secret, resource });
type Selection = Parameters<typeof service.approve>[1]["selection"];
const verifier = createGrantCredentialVerifier(prismaAssetQuery(prisma));
afterAll(async () => {
  await prisma.$disconnect();
  await db.close();
  await cluster.close();
});

async function fixture() {
  const user = await prisma.user.create({
    data: { name: "Consent", email: `${randomUUID()}@example.invalid`, twoFactorEnabled: true },
  });
  const session = await prisma.session.create({
    data: { userId: user.id, token: randomUUID(), expiresAt: new Date(Date.now() + 3600_000) },
  });
  const clientId = randomUUID();
  await prisma.oauthResource.upsert({
    where: { identifier: resource },
    create: {
      identifier: resource,
      name: "MCP",
      allowedScopes: ["mcp:read", "mcp:write", "offline_access"],
    },
    update: {},
  });
  await prisma.oauthClient.create({
    data: {
      clientId,
      redirectUris: ["https://client.invalid/cb"],
      scopes: ["mcp:read", "mcp:write", "offline_access"],
      contacts: [],
      grantTypes: ["authorization_code", "refresh_token"],
      responseTypes: ["code"],
      postLogoutRedirectUris: [],
      clientResources: { create: { resourceId: resource } },
    },
  });
  const kb = await prisma.knowledgeBase.create({
    data: {
      ownerId: user.id,
      name: "Consent",
      slug: `c-${randomUUID()}`,
      description: "Consent integration fixture",
      state: "ACTIVE",
      headSha: "a".repeat(40),
    },
  });
  const actor = { userId: user.id, sessionId: session.id };
  function query(changes: Record<string, string> = {}) {
    const p = new URLSearchParams({
      client_id: clientId,
      redirect_uri: "https://client.invalid/cb",
      resource,
      scope: "mcp:read mcp:write offline_access",
      state: randomUUID(),
      response_type: "code",
      code_challenge: "a".repeat(43),
      code_challenge_method: "S256",
      exp: String(Math.floor(Date.now() / 1000) + 600),
      ...changes,
    });
    const entries = [...p].sort(([a, av], [b, bv]) =>
      a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0,
    );
    p.set(
      "sig",
      createHmac("sha256", secret).update(new URLSearchParams(entries).toString()).digest("base64"),
    );
    return p.toString();
  }
  const selection: Selection = {
    scopes: ["mcp:read", "mcp:write", "offline_access"],
    toolGroups: MCP_TOOL_GROUPS.filter((group) => group !== "sealed"),
    acl: [{ kbId: kb.id, bits: ["read"] }],
  };
  async function approve(selected = selection, explicitConsent = true, reuseGrantId?: string) {
    const oauthQuery = query();
    const intent = await service.prepare(actor, oauthQuery);
    const input = { ...intent, oauthQuery, selection: selected, explicitConsent, reuseGrantId };
    return { ...(await service.approve(actor, input)), input };
  }
  return { actor, kb, query, selection, approve, clientId };
}
function claims(
  f: Awaited<ReturnType<typeof fixture>>,
  a: { referenceId: string; grantId: string },
  more = {},
) {
  return {
    ...a,
    userId: f.actor.userId,
    clientId: f.clientId,
    resource,
    scopes: ["mcp:read"],
    grantType: "authorization_code" as const,
    ...more,
  };
}
async function revoke(grantId: string) {
  await prisma.$transaction(async (tx) => {
    await lockIdentityAuthority(tx);
    await tx.mcpGrant.update({ where: { id: grantId }, data: { revokedAt: new Date() } });
  });
}
function principal(f: Awaited<ReturnType<typeof fixture>>, grantId: string) {
  return {
    kind: "token" as const,
    userId: f.actor.userId,
    grantId,
    grantGeneration: grantId,
    scopes: ["mcp:read"],
    expiresAt: new Date(Date.now() + 600_000),
    storedAcl: new Map<string, string[]>(),
  };
}

describe("consent durable authority", () => {
  it("rejects signed tamper, wrong user/resource/nonce and expiry with no grant minted", async () => {
    const f = await fixture();
    const oauthQuery = f.query();
    const intent = await service.prepare(f.actor, oauthQuery);
    const input = { ...intent, oauthQuery, selection: f.selection, explicitConsent: true };
    const altered = new URLSearchParams(oauthQuery);
    altered.set("client_id", "evil");
    for (const [actor, body] of [
      [{ ...f.actor, userId: "evil" }, input],
      [f.actor, { ...input, nonce: randomUUID() }],
      [f.actor, { ...input, oauthQuery: altered.toString() }],
      [f.actor, { ...input, oauthQuery: f.query({ resource: "https://wrong.invalid/mcp" }) }],
    ] as const)
      await expect(service.approve(actor, body)).rejects.toThrow();
    await prisma.consentIntent.update({
      where: { referenceId: intent.referenceId },
      data: { expiresAt: new Date(0) },
    });
    await expect(service.approve(f.actor, input)).rejects.toThrow();
    expect(await prisma.mcpGrant.count({ where: { userId: f.actor.userId } })).toBe(0);
  });
  it("revalidates live ACL, session and client redirect/resource linkage", async () => {
    const f = await fixture();
    const invalidQueries: Record<string, string>[] = [
      { redirect_uri: "https://evil.invalid/cb" },
      { client_id: "absent" },
    ];
    for (const changes of invalidQueries)
      await expect(service.prepare(f.actor, f.query(changes))).rejects.toThrow();
    const oauthQuery = f.query();
    const intent = await service.prepare(f.actor, oauthQuery);
    await prisma.knowledgeBase.update({
      where: { id: f.kb.id },
      data: { ownerId: null, state: "TOMBSTONED" },
    });
    await expect(
      service.approve(f.actor, {
        ...intent,
        oauthQuery,
        selection: f.selection,
        explicitConsent: true,
      }),
    ).rejects.toThrow();
    await prisma.session.update({
      where: { id: f.actor.sessionId },
      data: { expiresAt: new Date(0) },
    });
    await expect(service.prepare(f.actor, f.query())).rejects.toThrow();
    expect(await prisma.mcpGrant.count({ where: { userId: f.actor.userId } })).toBe(0);
  });
  it("empty selection is explicit; replay is idempotent and cannot broaden", async () => {
    const f = await fixture();
    const empty: Selection = {
      scopes: ["mcp:read"],
      toolGroups: MCP_TOOL_GROUPS.filter((group) => group !== "sealed"),
      acl: [],
    };
    const a = await f.approve(empty);
    expect(await prisma.grantKbAcl.count({ where: { grantId: a.grantId } })).toBe(0);
    expect(await service.approve(f.actor, a.input)).toMatchObject({ grantId: a.grantId });
    await expect(
      service.approve(f.actor, { ...a.input, selection: f.selection }),
    ).rejects.toThrow();
    expect(await prisma.mcpGrant.count({ where: { userId: f.actor.userId } })).toBe(1);
    expect((await service.prepare(f.actor, a.input.oauthQuery)).nonce).toBe(a.input.nonce);
  });
  it("narrow reuse works, each expansion needs explicit consent and a fresh generation", async () => {
    const f = await fixture();
    const a = await f.approve();
    const narrow = await f.approve(
      { scopes: ["mcp:read"], toolGroups: ["read"], acl: [] },
      false,
      a.grantId,
    );
    expect(narrow.grantId).toBe(a.grantId);
    // Reuse narrowed the shared generation's tool groups too.
    expect(
      (await prisma.mcpGrant.findUniqueOrThrow({ where: { id: a.grantId } })).toolGroups,
    ).toEqual(["read"]);
    for (const selection of [
      // Widening only the tool groups is an expansion as well.
      { scopes: ["mcp:read"], toolGroups: ["read", "edit"], acl: [] },
      f.selection,
      { ...f.selection, acl: [{ kbId: f.kb.id, bits: ["write"] }] },
      { ...f.selection, allowCreate: true, createdKbBits: ["read"] },
    ] satisfies Selection[]) {
      const oauthQuery = f.query();
      const intent = await service.prepare(f.actor, oauthQuery);
      const input = {
        ...intent,
        oauthQuery,
        selection,
        reuseGrantId: a.grantId,
        explicitConsent: false,
      };
      await expect(service.approve(f.actor, input)).rejects.toThrow();
      expect(
        (await service.approve(f.actor, { ...input, explicitConsent: true })).grantId,
      ).not.toBe(a.grantId);
    }
    await expect(
      issueMcpGenerationClaims(prisma, claims(f, a, { scopes: ["mcp:write"] })),
    ).rejects.toThrow();
  });
  it("narrowing consent reuse ends active temporary access; identical reuse keeps it", async () => {
    const f = await fixture();
    const narrowSelection: Selection = {
      scopes: ["mcp:read", "mcp:write", "offline_access"],
      toolGroups: ["read", "edit"],
      acl: [{ kbId: f.kb.id, bits: ["read"] }],
    };
    const a = await f.approve(narrowSelection);
    const elevate = async () => {
      const id = randomUUID();
      await prisma.mcpGrantElevation.create({
        data: {
          id,
          grantId: a.grantId,
          expiresAt: new Date(Date.now() + 3600_000),
          toolGroups: ["export"],
          createdKbBits: [],
          createdByUserIdSnapshot: f.actor.userId,
        },
      });
      return id;
    };
    const first = await elevate();
    const p = principal(f, a.grantId);
    expect((await verifier.inspect(p)).toolGroups).toEqual(["read", "edit", "export"]);
    // Identical reuse removes nothing: the elevation stays.
    await f.approve(narrowSelection, false, a.grantId);
    expect(
      (await prisma.mcpGrantElevation.findUniqueOrThrow({ where: { id: first } })).revokedAt,
    ).toBeNull();
    // Narrowing reuse (edit removed) ends it in the same transaction.
    const narrowed = await f.approve(
      { ...narrowSelection, toolGroups: ["read"] },
      false,
      a.grantId,
    );
    expect(narrowed.grantId).toBe(a.grantId);
    expect(
      (await prisma.mcpGrantElevation.findUniqueOrThrow({ where: { id: first } })).revokedAt,
    ).toBeInstanceOf(Date);
    expect((await verifier.inspect(p)).toolGroups).toEqual(["read"]);
    const ended = await prisma.auditEvent.findMany({
      where: { grantIdSnapshot: a.grantId, action: "MCP_GRANT_ELEVATION_ENDED" },
    });
    expect(ended).toHaveLength(1);
    expect(ended[0]?.opId).toBe(narrowed.input.nonce);
    expect(JSON.parse((ended[0]!.metadata as Record<string, string>).elevationIds!)).toEqual([
      first,
    ]);
  });
  it("narrowing check covers a creator-grown ACL above the selection cap without loading it", async () => {
    const f = await fixture();
    const kept: Selection = {
      scopes: ["mcp:read", "mcp:write", "offline_access"],
      toolGroups: ["read", "edit"],
      acl: [{ kbId: f.kb.id, bits: ["read"] }],
    };
    const a = await f.approve(kept);
    const ids = Array.from(
      { length: 300 },
      (_, i) =>
        `cgrow${randomUUID().replaceAll("-", "").slice(0, 15)}${String(i).padStart(4, "0")}`,
    );
    await prisma.knowledgeBase.createMany({
      data: ids.map((id) => ({
        id,
        ownerId: f.actor.userId,
        name: "Grown",
        slug: `cg-${id}`,
        description: "Creator append fixture",
        state: "ACTIVE",
        headSha: "a".repeat(40),
      })),
    });
    await prisma.grantKbAcl.createMany({
      data: ids.map((kbId) => ({ grantId: a.grantId, kbId, bits: ["read"] })),
    });
    const elevation = randomUUID();
    await prisma.mcpGrantElevation.create({
      data: {
        id: elevation,
        grantId: a.grantId,
        expiresAt: new Date(Date.now() + 3600_000),
        toolGroups: ["export"],
        createdKbBits: [],
        createdByUserIdSnapshot: f.actor.userId,
      },
    });
    // Same groups and scopes, but the 300 appended KBs are dropped: a narrowing.
    await f.approve(kept, false, a.grantId);
    expect(
      (await prisma.mcpGrantElevation.findUniqueOrThrow({ where: { id: elevation } })).revokedAt,
    ).toBeInstanceOf(Date);
    expect(await prisma.grantKbAcl.count({ where: { grantId: a.grantId } })).toBe(1);
  });
  it("a consent request asking for a sealed recipient capability is rejected with a typed error and creates no grant", async () => {
    const f = await fixture();
    const record = await prisma.sealedRecord.create({
      data: {
        namespace: randomUUID(),
        recordId: randomUUID(),
        kbId: f.kb.id,
        ownerId: f.actor.userId,
        ownerSnapshot: f.actor.userId,
        ciphertext: "fixture",
      },
    });
    const recipient = {
      kbId: f.kb.id,
      namespace: record.namespace,
      recordId: record.recordId,
      recipientKeyId: randomUUID(),
      recipientPublicKey: Buffer.alloc(32, 7).toString("base64"),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    };
    const grantsBefore = await prisma.mcpGrant.count();
    const oauthQuery = f.query();
    const intent = await service.prepare(f.actor, oauthQuery);
    const input = {
      ...intent,
      oauthQuery,
      selection: { ...f.selection, recipients: [recipient] },
      explicitConsent: true,
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const error = await service.approve(f.actor, input).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(McpSealedConsentError);
      expect(error).toMatchObject({
        code: "SEALED_VALUES_REQUIRE_CLI_OR_PAT",
        message: expect.stringMatching(/CLI or a personal access token/),
      });
    }
    expect(await prisma.mcpGrant.count()).toBe(grantsBefore);
    expect(await prisma.sealedConsumerGrant.count({ where: { consumerKind: "oauth" } })).toBe(0);
    const stored = await prisma.consentIntent.findUniqueOrThrow({
      where: { referenceId: intent.referenceId },
    });
    expect(stored.grantId).toBeNull();
    expect(stored.approvedAt).toBeNull();
    // The same consent without the sealed request is still approvable.
    const ok = await service.approve(f.actor, { ...input, selection: f.selection });
    expect(await prisma.mcpGrant.findUniqueOrThrow({ where: { id: ok.grantId } })).toMatchObject({
      kind: "OAUTH",
      revokedAt: null,
    });
    // An explicit empty recipient list asks for nothing sealed.
    const second = f.query();
    const other = await service.prepare(f.actor, second);
    await expect(
      service.approve(f.actor, {
        ...other,
        oauthQuery: second,
        selection: { ...f.selection, recipients: [] },
        explicitConsent: true,
        reuseGrantId: ok.grantId,
      }),
    ).resolves.toMatchObject({ grantId: ok.grantId });
  });
  it("revoke in the consumed-code/artifact-free gap makes late access and refresh inert", async () => {
    const f = await fixture();
    const a = await f.approve();
    // Model the provider's code-consume/claims/artifact phases explicitly. No OAuth
    // HTTP plugin is installed until 31b; actual grant admission is exercised here.
    const code = await prisma.verification.create({
      data: {
        identifier: randomUUID(),
        value: a.referenceId,
        expiresAt: new Date(Date.now() + 600_000),
      },
    });
    await prisma.verification.delete({ where: { id: code.id } });
    const payload = await issueMcpGenerationClaims(prisma, claims(f, a));
    expect(payload.mcp_grant_id).toBe(a.grantId);
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    const insertion = (async () => {
      await paused;
      return prisma.oauthAccessToken.create({
        data: {
          token: randomUUID(),
          clientId: f.clientId,
          userId: f.actor.userId,
          referenceId: a.referenceId,
          scopes: ["mcp:read"],
          resources: [resource],
          requestedUserInfoClaims: [],
          expiresAt: new Date(Date.now() + 600_000),
        },
      });
    })();
    await revoke(a.grantId);
    release();
    await insertion;
    expect((await verifier.inspect(principal(f, payload.mcp_grant_id))).generationActive).toBe(
      false,
    );
    await expect(
      issueMcpGenerationClaims(
        prisma,
        claims(f, a, {
          grantType: "refresh_token",
          tokenScopes: ["mcp:read", "offline_access"],
          tokenExpiresAt: new Date(Date.now() + 10000),
        }),
      ),
    ).rejects.toThrow();
    expect(await prisma.consentIntent.count({ where: { referenceId: a.referenceId } })).toBe(1);
  });
  it("refresh never creates missing/tombstoned generations, substitutes siblings, expands scopes or revives expired refresh", async () => {
    const f = await fixture();
    const a = await f.approve();
    const sibling = await f.approve();
    const request = claims(f, a, {
      grantType: "refresh_token",
      tokenScopes: ["mcp:read", "offline_access"],
      tokenExpiresAt: new Date(Date.now() + 10000),
    });
    expect((await issueMcpGenerationClaims(prisma, request)).mcp_grant_id).toBe(a.grantId);
    for (const change of [
      { grantId: randomUUID() },
      { grantId: sibling.grantId },
      { scopes: ["openid"] },
      { scopes: ["mcp:write"] },
      { tokenExpiresAt: new Date(0) },
    ])
      await expect(issueMcpGenerationClaims(prisma, { ...request, ...change })).rejects.toThrow();
    await revoke(a.grantId);
    await expect(issueMcpGenerationClaims(prisma, request)).rejects.toThrow();
    expect(await prisma.mcpGrant.count({ where: { userId: f.actor.userId } })).toBe(2);
  });
  it("cached refresh pair delivered after revoke is rejected by live admission", async () => {
    const f = await fixture();
    const a = await f.approve();
    const cached = await issueMcpGenerationClaims(
      prisma,
      claims(f, a, {
        grantType: "refresh_token",
        tokenScopes: ["mcp:read", "offline_access"],
        tokenExpiresAt: new Date(Date.now() + 10000),
      }),
    );
    expect((await verifier.inspect(principal(f, cached.mcp_grant_id))).generationActive).toBe(true);
    await revoke(a.grantId);
    expect((await verifier.inspect(principal(f, cached.mcp_grant_id))).generationActive).toBe(
      false,
    );
    await expect(
      issueMcpGenerationClaims(
        prisma,
        claims(f, a, {
          grantType: "refresh_token",
          tokenScopes: ["mcp:read", "offline_access"],
          tokenExpiresAt: new Date(Date.now() + 10000),
        }),
      ),
    ).rejects.toThrow();
  });
  it("review projects only server-validated request facts and the live previous generation", async () => {
    const f = await fixture();
    const oauthQuery = f.query({ scope: "mcp:read" });
    const first = await service.review(f.actor, oauthQuery);
    expect(first).toMatchObject({
      client: { clientId: f.clientId, name: null, uri: null },
      redirectUri: "https://client.invalid/cb",
      resource,
      scopes: ["mcp:read"],
      previousGrantId: null,
      approval: null,
    });
    // OAuth consent never offers a sealed recipient capability.
    expect(first).not.toHaveProperty("recipientOffers");
    // review is prepare: the same durable intent/nonce, no grant minted
    expect(await service.prepare(f.actor, oauthQuery)).toEqual({
      referenceId: first.referenceId,
      nonce: first.nonce,
    });
    expect(await prisma.mcpGrant.count({ where: { userId: f.actor.userId } })).toBe(0);
    const a = await f.approve();
    const reopened = await service.review(f.actor, a.input.oauthQuery);
    const receipt = await prisma.consentIntent.findUniqueOrThrow({
      where: { referenceId: a.referenceId },
    });
    expect(reopened.approval).toEqual({ grantId: a.grantId, selection: receipt.selection });
    expect(reopened.nonce).toBe(receipt.nonce);
    expect((await service.review(f.actor, f.query())).previousGrantId).toBe(a.grantId);
    await revoke(a.grantId);
    expect((await service.review(f.actor, f.query())).previousGrantId).toBeNull();
    await expect(service.review(f.actor, f.query({ client_id: "evil" }))).rejects.toThrow();
  });
});
