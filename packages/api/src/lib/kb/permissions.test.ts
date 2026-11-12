import { describe, expect, it } from "vitest";
import type { HeldLockLease } from "./lock";
import {
  authorize,
  expandBits,
  intersectBits,
  type LiveAuthorityStore,
  recheckRead,
  recheckWriteBeforeReservation,
} from "./permissions";
import type { CredentialVerifier, LiveIdentity, Principal, TokenPrincipal } from "./principal";

const kb = { id: "kb1", ownerId: "owner", state: "ACTIVE" as const };

const allowedIdentity: LiveIdentity = {
  banned: false,
  twoFactorSatisfied: true,
  instanceEnabled: true,
};

function store(options?: {
  kb?: typeof kb | null;
  shares?: Record<string, { bits: string[]; revokedAt: Date | null }>;
  identity?: LiveIdentity | null | (() => LiveIdentity | null);
}): LiveAuthorityStore {
  return {
    async loadKb() {
      return options?.kb === undefined ? kb : options.kb;
    },
    async loadShare(_kbId, userId) {
      return options?.shares?.[userId] ?? null;
    },
    async loadIdentity() {
      const value = options?.identity;
      if (typeof value === "function") return value();
      if (value === null) return null;
      return value ?? allowedIdentity;
    },
  };
}

function browser(
  userId: string,
  extra: Partial<Extract<Principal, { kind: "browser" }>> = {},
): Principal {
  return { kind: "browser", userId, ...extra };
}

function token(extra: Partial<TokenPrincipal> & { acl?: readonly string[] } = {}): TokenPrincipal {
  const acl = extra.acl ?? ["manage"];
  return {
    kind: "token",
    userId: extra.userId ?? "owner",
    grantId: extra.grantId ?? "grant1",
    grantGeneration: extra.grantGeneration ?? "gen1",
    scopes: extra.scopes ?? ["mcp:write"],
    expiresAt: extra.expiresAt ?? new Date("2099-01-01"),
    storedAcl: extra.storedAcl ?? new Map([["kb1", acl]]),
  };
}

const okVerifier: CredentialVerifier = {
  async inspect() {
    return {
      generationActive: true,
      instanceEnabled: true,
      expired: false,
      banned: false,
      twoFactorSatisfied: true,
    };
  },
};

function verifier(
  flags: Partial<Awaited<ReturnType<CredentialVerifier["inspect"]>>>,
): CredentialVerifier {
  return {
    async inspect() {
      return {
        generationActive: true,
        instanceEnabled: true,
        expired: false,
        banned: false,
        twoFactorSatisfied: true,
        ...flags,
      };
    },
  };
}

describe("bit expansion", () => {
  it("expands grants before intersection and never lets write imply review", () => {
    expect(expandBits(["manage"])).toEqual(["read", "propose", "write", "review", "manage"]);
    expect(expandBits(["write"])).toEqual(["read", "propose", "write"]);
    expect(expandBits(["review"])).toEqual(["read", "review"]);
    expect(expandBits(["propose"])).toEqual(["read", "propose"]);
    expect(intersectBits(expandBits(["write"]), expandBits(["review"]))).toEqual(["read"]);
  });
});

describe("authorize truth table", () => {
  it("grants the owner every live bit and hides missing, tombstoned, and unreadable kbs", async () => {
    await expect(
      authorize({ principal: browser("owner"), kbId: "kb1", operation: "manage", store: store() }),
    ).resolves.toMatchObject({ bits: expandBits(["manage"]) });
    await expect(
      authorize({
        principal: browser("stranger"),
        kbId: "kb1",
        operation: "read",
        store: store({ kb: null }),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      authorize({
        principal: browser("owner"),
        kbId: "kb1",
        operation: "read",
        store: store({ kb: { ...kb, state: "TOMBSTONED" } }),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      authorize({ principal: browser("stranger"), kbId: "kb1", operation: "read", store: store() }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("uses live share bits for browser principals and ignores instance admin", async () => {
    const shares = { member: { bits: ["review"], revokedAt: null } };
    await expect(
      authorize({
        principal: browser("member"),
        kbId: "kb1",
        operation: "review",
        store: store({ shares }),
      }),
    ).resolves.toMatchObject({ bits: ["read", "review"] });
    await expect(
      authorize({
        principal: browser("member"),
        kbId: "kb1",
        operation: "write",
        store: store({ shares }),
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      authorize({
        principal: browser("admin", { isInstanceAdmin: true }),
        kbId: "kb1",
        operation: "read",
        store: store(),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("limits configure_index_limit to the owner holding manage", async () => {
    const shares = { manager: { bits: ["manage"], revokedAt: null } };
    await expect(
      authorize({
        principal: browser("owner"),
        kbId: "kb1",
        operation: "configure_index_limit",
        store: store({ shares }),
      }),
    ).resolves.toMatchObject({ ownerId: "owner" });
    await expect(
      authorize({
        principal: browser("manager"),
        kbId: "kb1",
        operation: "configure_index_limit",
        store: store({ shares }),
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    // A manager non-owner still passes plain manage.
    await expect(
      authorize({
        principal: browser("manager"),
        kbId: "kb1",
        operation: "manage",
        store: store({ shares }),
      }),
    ).resolves.toMatchObject({ ownerId: "owner" });
    await expect(
      authorize({
        principal: token({ acl: ["write"] }),
        kbId: "kb1",
        operation: "configure_index_limit",
        store: store(),
        verifier: okVerifier,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      authorize({
        principal: token({ acl: ["manage"] }),
        kbId: "kb1",
        operation: "configure_index_limit",
        store: store(),
        verifier: okVerifier,
      }),
    ).resolves.toMatchObject({ ownerId: "owner" });
  });

  it("intersects stored token ACL with live owner bits so a read-only token cannot write", async () => {
    const access = await authorize({
      principal: token({ acl: ["read"] }),
      kbId: "kb1",
      operation: "read",
      store: store(),
      verifier: okVerifier,
    });
    expect(access.bits).toEqual(["read"]);
    await expect(
      authorize({
        principal: token({ acl: ["read"] }),
        kbId: "kb1",
        operation: "write",
        store: store(),
        verifier: okVerifier,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("treats review without write as readable but not mutable", async () => {
    const shares = { reviewer: { bits: ["review"], revokedAt: null } };
    await expect(
      authorize({
        principal: token({ userId: "reviewer", acl: ["review", "write"], scopes: ["mcp:write"] }),
        kbId: "kb1",
        operation: "review",
        store: store({ shares }),
        verifier: okVerifier,
      }),
    ).resolves.toMatchObject({ bits: ["read", "review"] });
    await expect(
      authorize({
        principal: token({ userId: "reviewer", acl: ["review", "write"], scopes: ["mcp:write"] }),
        kbId: "kb1",
        operation: "write",
        store: store({ shares }),
        verifier: okVerifier,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("keeps OAuth write-scope independent of stored ACL bits", async () => {
    await expect(
      authorize({
        principal: token({ acl: ["manage"], scopes: ["mcp:read"] }),
        kbId: "kb1",
        operation: "write",
        store: store(),
        verifier: okVerifier,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      authorize({
        principal: token({ acl: ["read"], scopes: ["mcp:write"] }),
        kbId: "kb1",
        operation: "write",
        store: store(),
        verifier: okVerifier,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      authorize({
        principal: token({ acl: ["read"], scopes: ["mcp:read"] }),
        kbId: "kb1",
        operation: "read",
        store: store(),
        verifier: okVerifier,
      }),
    ).resolves.toMatchObject({ bits: ["read"] });
  });

  it("rejects banned, 2FA-unsatisfied, and revoked token principals", async () => {
    await expect(
      authorize({
        principal: browser("owner"),
        kbId: "kb1",
        operation: "read",
        store: store({ identity: { ...allowedIdentity, banned: true } }),
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      authorize({
        principal: browser("owner"),
        kbId: "kb1",
        operation: "read",
        store: store({ identity: { ...allowedIdentity, twoFactorSatisfied: false } }),
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      authorize({
        principal: browser("owner"),
        kbId: "kb1",
        operation: "read",
        store: store({ identity: null }),
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      authorize({
        principal: token(),
        kbId: "kb1",
        operation: "read",
        store: store(),
        verifier: verifier({ banned: true }),
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      authorize({
        principal: token(),
        kbId: "kb1",
        operation: "read",
        store: store(),
        verifier: verifier({ twoFactorSatisfied: false }),
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      authorize({
        principal: token(),
        kbId: "kb1",
        operation: "read",
        store: store(),
        verifier: verifier({ generationActive: false }),
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      authorize({
        principal: token(),
        kbId: "kb1",
        operation: "read",
        store: store(),
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rechecks writes only while the authority lock is held", async () => {
    const held = { holdingAuthority: () => true, opId: "op1" } as HeldLockLease;
    await expect(
      recheckWriteBeforeReservation(held, {
        principal: browser("owner"),
        kbId: "kb1",
        operation: "write",
        store: store(),
      }),
    ).resolves.toMatchObject({ kbId: "kb1" });
    const missing = { holdingAuthority: () => false, opId: "op1" } as HeldLockLease;
    await expect(
      recheckWriteBeforeReservation(missing, {
        principal: browser("owner"),
        kbId: "kb1",
        operation: "write",
        store: store(),
      }),
    ).rejects.toMatchObject({ code: "NOT_HELD" });
  });

  it("observes a live ban and 2FA change between admission and recheck", async () => {
    const identity = { ...allowedIdentity };
    const live = store({ identity: () => ({ ...identity }) });
    await expect(
      authorize({
        principal: browser("owner"),
        kbId: "kb1",
        operation: "write",
        store: live,
      }),
    ).resolves.toMatchObject({ kbId: "kb1" });
    identity.banned = true;
    await expect(
      recheckRead({
        principal: browser("owner"),
        kbId: "kb1",
        operation: "read",
        store: live,
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    identity.banned = false;
    identity.twoFactorSatisfied = false;
    const held = { holdingAuthority: () => true, opId: "op1" } as HeldLockLease;
    await expect(
      recheckWriteBeforeReservation(held, {
        principal: browser("owner"),
        kbId: "kb1",
        operation: "write",
        store: live,
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("live grant ceiling from the verifier", () => {
  it("prefers the verifier's stored GrantKbAcl over the principal snapshot", async () => {
    const live: CredentialVerifier = {
      ...okVerifier,
      async grantBits(_principal, kbId) {
        return kbId === "kb1" ? ["read"] : [];
      },
    };
    // Snapshot says manage; the live ceiling says read only.
    const principal = token({ acl: ["manage"] });
    await expect(
      authorize({ principal, kbId: "kb1", operation: "read", store: store(), verifier: live }),
    ).resolves.toMatchObject({ bits: ["read"] });
    await expect(
      authorize({ principal, kbId: "kb1", operation: "write", store: store(), verifier: live }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    // A KB removed from the live ceiling is not found even with a snapshot entry.
    const gone: CredentialVerifier = { ...okVerifier, grantBits: async () => [] };
    await expect(
      authorize({ principal, kbId: "kb1", operation: "read", store: store(), verifier: gone }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
