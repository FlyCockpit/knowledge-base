import { describe, expect, it } from "vitest";
import type { LockQuery } from "./kb/lock";
import type { LiveAuthorityStore } from "./kb/permissions";
import type { TokenPrincipal } from "./kb/principal";
import {
  authenticatePersonalToken,
  createGrantCredentialVerifier,
  digestPatSecret,
  generatePatSecret,
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
