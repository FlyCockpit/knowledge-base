import { describe, expect, it } from "vitest";
import type { LockQuery } from "./kb/lock";
import type { LiveAuthorityStore } from "./kb/permissions";
import type { TokenPrincipal } from "./kb/principal";
import {
  authenticatePersonalToken,
  createGrantCredentialVerifier,
  digestPatSecret,
  generatePatSecret,
  listGrants,
  listPersonalTokens,
  patLookupPrefix,
  updateGrant,
  validateAclAgainstLive,
} from "./mcp-token-access";

type Row = Record<string, unknown>;

/** Routes SQL by a distinctive table name; records every statement. */
function fakeQuery(tables: Record<string, Row[]>): LockQuery & { calls: string[] } {
  const calls: string[] = [];
  const query = (async (text: string) => {
    calls.push(text);
    for (const [needle, rows] of Object.entries(tables)) {
      if (text.includes(needle)) return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: 0 };
  }) as LockQuery & { calls: string[] };
  query.calls = calls;
  return query;
}

describe("PAT secret material", () => {
  it("produces a high-entropy secret whose lookup prefix is recoverable and digest is not the secret", () => {
    const a = generatePatSecret();
    const b = generatePatSecret();
    expect(a.secret).not.toBe(b.secret);
    expect(a.secret).toMatch(/^kbp_[a-z0-9]{16}_[A-Za-z0-9_-]{43}$/);
    expect(patLookupPrefix(a.secret)).toBe(a.lookupPrefix);
    const digest = digestPatSecret(a.secret);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain(a.secret.slice(-43));
  });

  it("rejects malformed presented secrets before any lookup", async () => {
    const query = fakeQuery({});
    for (const raw of ["", "kbp_", "Bearer x", `kbp_${"a".repeat(16)}_short`]) {
      expect(patLookupPrefix(raw)).toBeNull();
      expect(await authenticatePersonalToken(query, raw, new Date())).toBeNull();
    }
    expect(query.calls).toHaveLength(0);
  });
});

describe("authenticatePersonalToken is identification, not admission", () => {
  const { secret, lookupPrefix } = generatePatSecret();
  const future = new Date(Date.now() + 86_400_000);
  const row = {
    id: "tok",
    userId: "u1",
    grantId: "11111111-1111-4111-8111-111111111111",
    secretDigest: digestPatSecret(secret),
    scopes: ["mcp:read"],
    expiresAt: future,
    revokedAt: null,
  };

  it("returns a token principal for the exact digest, without any ACL snapshot", async () => {
    const principal = await authenticatePersonalToken(
      fakeQuery({ mcp_personal_token: [row] }),
      secret,
      new Date(),
    );
    expect(principal).toMatchObject({
      kind: "token",
      userId: "u1",
      grantId: row.grantId,
      grantGeneration: row.grantId,
      scopes: ["mcp:read"],
    });
    expect(principal?.storedAcl.size).toBe(0);
  });

  it("rejects wrong digest, revoked, expired and ownerless tokens", async () => {
    const other = generatePatSecret().secret.replace(/^kbp_[a-z0-9]{16}/, `kbp_${lookupPrefix}`);
    for (const [raw, patch] of [
      [other, {}],
      [secret, { revokedAt: new Date() }],
      [secret, { expiresAt: new Date(Date.now() - 1) }],
      [secret, { userId: null }],
    ] as const) {
      expect(
        await authenticatePersonalToken(
          fakeQuery({ mcp_personal_token: [{ ...row, ...patch }] }),
          raw,
          new Date(),
        ),
      ).toBeNull();
    }
  });

  it("refuses an unreadable stored expiry plainly, never as an ended (null) token", async () => {
    const refusal = await authenticatePersonalToken(
      fakeQuery({ mcp_personal_token: [{ ...row, expiresAt: "not a date" }] }),
      secret,
      new Date(),
    ).catch((error: unknown) => error);
    expect(refusal).toMatchObject({ code: "UNAUTHORIZED" });
    expect((refusal as { details?: unknown }).details).toBeUndefined();
  });
});

const E1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const E2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("grant credential verifier (full validity callback)", () => {
  const principal: TokenPrincipal = {
    kind: "token",
    userId: "u1",
    grantId: "11111111-1111-4111-8111-111111111111",
    grantGeneration: "11111111-1111-4111-8111-111111111111",
    scopes: ["mcp:write"],
    expiresAt: new Date(Date.now() + 60_000),
    storedAcl: new Map(),
  };
  const liveGrant = {
    id: principal.grantId,
    userId: "u1",
    kind: "PAT",
    scopes: ["mcp:write"],
    toolGroups: ["read", "edit"],
    revokedAt: null,
    tokenRevokedAt: null,
    tokenExpiresAt: principal.expiresAt,
    // Not a REST API key's child and not an API key's grant.
    parentApiKeyId: null,
    parentLive: null,
    apiKeyId: null,
    apiKeyLive: null,
  };
  const user = {
    banned: false,
    banExpires: null,
    twoFactorEnabled: true,
    role: "user",
    createdAt: new Date(),
    forcePublic: null,
    forceInternal: null,
  };

  it("admits only the exact active generation for its live owner", async () => {
    const verifier = createGrantCredentialVerifier(
      fakeQuery({ mcp_grant: [liveGrant], '"user"': [user] }),
    );
    expect(await verifier.inspect(principal)).toMatchObject({
      generationActive: true,
      banned: false,
      twoFactorSatisfied: true,
      expired: false,
      consumerKind: "pat",
      toolGroups: ["read", "edit"],
    });
    for (const patch of [
      { revokedAt: new Date() },
      { tokenRevokedAt: new Date() },
      { userId: null },
      { userId: "someone-else" },
      // A grant row with an empty, unknown or non-canonical group set fails closed.
      { toolGroups: [] },
      { toolGroups: null },
      { toolGroups: ["read", "everything"] },
      { toolGroups: ["edit", "read"] },
    ]) {
      const v = createGrantCredentialVerifier(
        fakeQuery({ mcp_grant: [{ ...liveGrant, ...patch }], '"user"': [user] }),
      );
      expect(await v.inspect(principal)).toMatchObject({ generationActive: false, toolGroups: [] });
    }
    const missing = createGrantCredentialVerifier(fakeQuery({ '"user"': [user] }));
    expect((await missing.inspect(principal)).generationActive).toBe(false);
    const banned = createGrantCredentialVerifier(
      fakeQuery({ mcp_grant: [liveGrant], '"user"': [{ ...user, banned: true }] }),
    );
    expect((await banned.inspect(principal)).banned).toBe(true);
  });

  it("reports ended only for a missing row, a tombstone or a readable past expiry", async () => {
    const inspect = (patch: Record<string, unknown> | null, value = principal) =>
      createGrantCredentialVerifier(
        fakeQuery({
          ...(patch ? { mcp_grant: [{ ...liveGrant, ...patch }] } : {}),
          '"user"': [user],
        }),
      ).inspect(value);
    for (const patch of [
      null,
      { revokedAt: new Date() },
      { tokenRevokedAt: new Date() },
      { tokenExpiresAt: new Date(Date.now() - 1) },
      { parentApiKeyId: "k".repeat(24), parentBinds: true, parentLive: false },
      { kind: "API_KEY", apiKeyLive: false },
    ]) {
      expect(await inspect(patch)).toMatchObject({ generationActive: false, ended: true });
    }
    // Refused now, but not final: a stale principal, an unreadable expiry, a
    // binding or owner mismatch, a corrupt group set, or a live but banned owner.
    for (const patch of [
      { scopes: ["mcp:read"] },
      { tokenExpiresAt: "not a date" },
      { userId: "someone-else" },
      { toolGroups: null },
    ]) {
      expect(await inspect(patch)).toMatchObject({ generationActive: false, ended: false });
    }
    expect((await inspect({})).ended).toBeUndefined();
    // An independent child outlives its dead key.
    expect(
      await inspect({ parentApiKeyId: "k".repeat(24), parentBinds: false, parentLive: false }),
    ).toMatchObject({ generationActive: true });
  });

  it("unites live elevation groups with the base groups, canonical and fail-closed", async () => {
    const inspect = (patch: Record<string, unknown>, kind = "PAT") =>
      createGrantCredentialVerifier(
        fakeQuery({ mcp_grant: [{ ...liveGrant, kind, ...patch }], '"user"': [user] }),
      ).inspect(principal);
    expect(
      (
        await inspect({
          elevations: [
            { id: E1, toolGroups: ["kb_admin", "everything"], expiresAt: "2099-01-02T00:00:00Z" },
            { id: E2, toolGroups: ["edit"], expiresAt: "2099-01-01T00:00:00Z" },
          ],
        })
      ).toolGroups,
    ).toEqual(["read", "edit", "kb_admin"]);
    // An inactive base never gains groups from an elevation.
    expect(
      (
        await inspect({
          elevations: [{ id: E1, toolGroups: ["kb_admin"], expiresAt: "2099-01-01T00:00:00Z" }],
          revokedAt: new Date(),
        })
      ).toolGroups,
    ).toEqual([]);
    // An OAuth grant never gains `sealed` through an elevation.
    expect(
      (
        await createGrantCredentialVerifier(
          fakeQuery({
            mcp_grant: [
              {
                ...liveGrant,
                kind: "OAUTH",
                elevations: [
                  { id: E1, toolGroups: ["sealed", "export"], expiresAt: "2099-01-01T00:00:00Z" },
                ],
              },
            ],
            '"user"': [user],
          }),
        ).inspect({ ...principal, expiresAt: new Date(Date.now() + 60_000) })
      ).toolGroups,
    ).toEqual(["read", "edit", "export"]);
    // The admission names the elevations it saw and the earliest expiry among them.
    expect(
      (
        await inspect({
          elevations: [
            { id: E2, toolGroups: ["edit"], expiresAt: "2099-01-01T00:00:00Z" },
            { id: E1, toolGroups: ["export"], expiresAt: "2099-01-02T00:00:00Z" },
            { id: "not-a-uuid", toolGroups: ["kb_admin"], expiresAt: "2099-01-01T00:00:00Z" },
          ],
        })
      ).elevations,
    ).toEqual({ ids: [E2, E1], validUntil: new Date("2099-01-01T00:00:00Z") });
    // The active-elevation predicate uses the database clock, never `now()`.
    let sql = "";
    await createGrantCredentialVerifier(async <R>(text: string) => {
      if (text.includes("mcp_grant_elevation")) sql = text;
      return { rows: [] as R[], rowCount: 0 };
    }).inspect(principal);
    expect(sql).toContain('e."expiresAt" > clock_timestamp()');
    expect(sql).toContain('e."revokedAt" IS NULL');
  });

  it("reads the live stored ACL from grant_kb_acl, not the principal snapshot", async () => {
    const verifier = createGrantCredentialVerifier(
      fakeQuery({ grant_kb_acl: [{ bits: ["read", "propose"] }] }),
    );
    expect(await verifier.grantBits?.(principal, "kb1")).toEqual(["read", "propose"]);
    const none = createGrantCredentialVerifier(fakeQuery({}));
    expect(await none.grantBits?.(principal, "kb1")).toEqual([]);
  });
});

describe("grant credential verifier: REST API keys and their children", () => {
  const keyId = "k".repeat(24);
  const grantId = "22222222-2222-4222-8222-222222222222";
  const resource = "https://kb.example.invalid/api/v1";
  const keyBinding = {
    kind: "API_KEY" as const,
    clientId: `apikey:${keyId}`,
    resource,
    tokenId: keyId,
  };
  const keyPrincipal: TokenPrincipal = {
    kind: "token",
    userId: "u1",
    grantId,
    grantGeneration: grantId,
    scopes: ["mcp:write"],
    expiresAt: new Date(Date.now() + 60_000),
    storedAcl: new Map(),
    credential: keyBinding,
  };
  const keyGrant = {
    id: grantId,
    userId: "u1",
    kind: "API_KEY",
    clientId: `apikey:${keyId}`,
    scopes: ["mcp:write"],
    toolGroups: ["kb_admin"],
    revokedAt: null,
    tokenId: null,
    resource: null,
    tokenRevokedAt: null,
    tokenExpiresAt: null,
    parentApiKeyId: null,
    parentLive: null,
    apiKeyId: keyId,
    apiKeyLive: true,
  };
  const user = {
    banned: false,
    banExpires: null,
    twoFactorEnabled: true,
    role: "user",
    createdAt: new Date(),
    forcePublic: null,
    forceInternal: null,
  };
  const inspect = (row: Record<string, unknown>, principal: TokenPrincipal) =>
    createGrantCredentialVerifier(fakeQuery({ mcp_grant: [row], '"user"': [user] }), undefined, {
      resource,
    }).inspect(principal);

  it("admits an API_KEY grant only for an API_KEY binding naming that live key", async () => {
    expect(await inspect(keyGrant, keyPrincipal)).toMatchObject({
      generationActive: true,
      toolGroups: ["kb_admin"],
    });
    const { credential: _none, ...unbound } = keyPrincipal;
    for (const [label, principal, row] of [
      ["no binding", unbound, keyGrant],
      [
        "a PAT binding",
        { ...keyPrincipal, credential: { ...keyBinding, kind: "PAT" as const } },
        keyGrant,
      ],
      [
        "an OAuth binding",
        {
          ...keyPrincipal,
          credential: { kind: "OAUTH" as const, clientId: keyBinding.clientId, resource },
        },
        keyGrant,
      ],
      [
        "another key's id",
        { ...keyPrincipal, credential: { ...keyBinding, tokenId: "x".repeat(24) } },
        keyGrant,
      ],
      ["a revoked or expired key row", keyPrincipal, { ...keyGrant, apiKeyLive: false }],
      ["a missing key row", keyPrincipal, { ...keyGrant, apiKeyId: null, apiKeyLive: null }],
      ["a PAT grant", keyPrincipal, { ...keyGrant, kind: "PAT" }],
      ["an OAuth grant", keyPrincipal, { ...keyGrant, kind: "OAUTH" }],
    ] as const) {
      expect(
        (await inspect(row as Record<string, unknown>, principal as TokenPrincipal))
          .generationActive,
        label,
      ).toBe(false);
    }
  });

  it("admits a child of a key whose children end with it only while that key and its grant are live", async () => {
    const child = {
      id: grantId,
      userId: "u1",
      kind: "PAT",
      clientId: "pat:t",
      scopes: ["mcp:read"],
      toolGroups: ["read"],
      revokedAt: null,
      tokenId: "t",
      resource: "https://kb.example.invalid/mcp",
      tokenRevokedAt: null,
      tokenExpiresAt: new Date(Date.now() + 60_000),
      parentApiKeyId: keyId,
      parentLive: true,
      parentBinds: true,
      apiKeyId: null,
      apiKeyLive: null,
    };
    const childPrincipal: TokenPrincipal = {
      ...keyPrincipal,
      scopes: ["mcp:read"],
      credential: {
        kind: "PAT",
        clientId: "pat:t",
        resource: "https://kb.example.invalid/mcp",
        tokenId: "t",
      },
    };
    const mcp = (row: Record<string, unknown>) =>
      createGrantCredentialVerifier(fakeQuery({ mcp_grant: [row], '"user"': [user] })).inspect(
        childPrincipal,
      );
    expect((await mcp(child)).generationActive).toBe(true);
    expect((await mcp({ ...child, parentLive: false })).generationActive).toBe(false);
    expect((await mcp({ ...child, parentLive: null })).generationActive).toBe(false);
    // An unreadable setting fails closed (binds).
    expect((await mcp({ ...child, parentLive: false, parentBinds: null })).generationActive).toBe(
      false,
    );
    // An independent child (childrenEndWithKey off) outlives its key's
    // revocation or expiry and stands on its own tombstone/expiry.
    const independent = { ...child, parentBinds: false };
    expect((await mcp({ ...independent, parentLive: false })).generationActive).toBe(true);
    expect((await mcp({ ...independent, parentLive: null })).generationActive).toBe(true);
    expect(
      (await mcp({ ...independent, parentLive: false, tokenRevokedAt: new Date() }))
        .generationActive,
    ).toBe(false);
    expect(
      (
        await mcp({
          ...independent,
          parentLive: false,
          tokenExpiresAt: new Date(Date.now() - 1000),
        })
      ).generationActive,
    ).toBe(false);
    // A never-expiring independent child stays active.
    expect(
      (await mcp({ ...independent, parentLive: false, tokenExpiresAt: null })).generationActive,
    ).toBe(true);
  });

  it("reads the parent and key liveness on the database clock in the same statement", async () => {
    let sql = "";
    await createGrantCredentialVerifier(async <R>(text: string) => {
      if (text.includes('FROM "mcp_grant" g')) sql = text;
      return { rows: [] as R[], rowCount: 0 };
    }).inspect(keyPrincipal);
    expect(sql).toContain('(pk."expiresAt" IS NULL OR pk."expiresAt" > clock_timestamp())');
    expect(sql).toContain('(k."expiresAt" IS NULL OR k."expiresAt" > clock_timestamp())');
    expect(sql).toContain('pk."childrenEndWithKey" AS "parentBinds"');
    expect(sql).toContain('pg."revokedAt" IS NULL');
  });
});

describe("validateAclAgainstLive", () => {
  const kbA = "a".repeat(24);
  const kbB = "b".repeat(24);
  const store: LiveAuthorityStore = {
    async loadKb(id) {
      if (id === kbA) return { id, ownerId: "u1", state: "ACTIVE" };
      if (id === kbB) return { id, ownerId: "other", state: "ACTIVE" };
      return null;
    },
    async loadShare(kbId, userId) {
      return kbId === kbB && userId === "u1" ? { bits: ["read"], revokedAt: null } : null;
    },
    async loadIdentity() {
      return { banned: false, twoFactorSatisfied: true, instanceEnabled: true };
    },
  };

  it("stores expanded requested bits when every expanded bit is held live", async () => {
    expect(
      await validateAclAgainstLive(store, "u1", [
        { kbId: kbA, bits: ["write"] },
        { kbId: kbB, bits: ["read"] },
      ]),
    ).toEqual([
      { kbId: kbA, bits: ["read", "propose", "write"] },
      { kbId: kbB, bits: ["read"] },
    ]);
  });

  it("rejects instead of clipping when any expanded bit is not held, or the KB is unknown", async () => {
    await expect(
      validateAclAgainstLive(store, "u1", [{ kbId: kbB, bits: ["propose"] }]),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      validateAclAgainstLive(store, "u1", [{ kbId: "c".repeat(24), bits: ["read"] }]),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});

describe("updateGrant input", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const kbId = "a".repeat(24);
  const runtime = {
    canonicalOrigin: "https://kb.example.invalid",
    coordinator: {
      run: () => {
        throw new Error("an invalid edit must not take the authority lock");
      },
    },
  } as unknown as Parameters<typeof updateGrant>[0];

  it.each([
    ["no field to change", { id }],
    ["an empty group set", { id, toolGroups: [] }],
    ["an unknown group", { id, toolGroups: ["everything"] }],
    ["offline_access", { id, scopes: ["offline_access"] }],
    [
      "a duplicated KB",
      {
        id,
        acl: [
          { kbId, bits: ["read"] },
          { kbId, bits: [] },
        ],
      },
    ],
    ["an empty ACL patch", { id, acl: [] }],
    ["an unknown field", { id, allowCreate: true, expiresAt: null }],
    ["an empty cap", { id, aclCap: [] }],
    ["an unknown cap bit", { id, aclCap: ["admin"] }],
    ["a duration over 7 days", { id, toolGroups: ["read", "kb_admin"], duration: "8d" }],
    ["a duration in another unit", { id, toolGroups: ["read", "kb_admin"], duration: 3600 }],
    ["a duration alone", { id, duration: "1h" }],
    ["temporary scopes", { id, scopes: ["mcp:write"], duration: "1h" }],
    ["a temporary cap", { id, aclCap: ["read"], duration: "1d" }],
  ])("rejects %s before any authority work", async (_name, input) => {
    await expect(
      updateGrant(runtime, "u1", input as Parameters<typeof updateGrant>[2]),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});

describe("credential lists carry the write mode", () => {
  const grantId = "11111111-1111-4111-8111-111111111111";
  const runtimeWith = (query: LockQuery) =>
    ({
      coordinator: {
        run: ({ run }: { run: (ctx: unknown) => unknown }) =>
          run({ lease: { transaction: (work: (q: LockQuery) => unknown) => work(query) } }),
      },
    }) as unknown as Parameters<typeof listGrants>[0];
  const identity = {
    banned: false,
    banExpires: null,
    twoFactorEnabled: true,
    role: "user",
    createdAt: new Date(),
    twoFactorGraceStartedAt: null,
    forcePublic: null,
    forceInternal: null,
  };

  it("selects the stored mode and returns it in lowercase (null when read-only)", async () => {
    const tokens = fakeQuery({
      "FOR UPDATE": [{ id: "u1" }],
      "u.banned": [identity],
      "FROM mcp_personal_token t JOIN": [
        { id: "t1", grantId, authoringMode: "DREAM", elevations: [] },
        { id: "t2", grantId, authoringMode: null, elevations: [] },
      ],
    });
    const page = await listPersonalTokens(runtimeWith(tokens), "u1", { limit: 5 });
    expect(page.items.map((item) => item.authoringMode)).toEqual(["dream", null]);
    expect(tokens.calls.find((sql) => sql.includes("mcp_personal_token t JOIN"))).toContain(
      'g."authoringMode"::text AS "authoringMode"',
    );
    const grants = fakeQuery({
      "FOR UPDATE": [{ id: "u1" }],
      "u.banned": [identity],
      "FROM mcp_grant g WHERE": [
        { id: grantId, kind: "OAUTH", authoringMode: "BOTH", acl: [], elevations: [] },
      ],
    });
    const listed = await listGrants(runtimeWith(grants), "u1", { limit: 5 });
    expect(listed.items[0]?.authoringMode).toBe("both");
  });
});
