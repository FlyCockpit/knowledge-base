import { describe, expect, it } from "vitest";
import {
  actorKeyFor,
  assertLiveIdentity,
  assertTokenAdmissible,
  demandToolGroups,
  type TokenPrincipal,
  tokenHasOauthScope,
  toolGroupsSatisfy,
} from "./principal";

const token: TokenPrincipal = {
  kind: "token",
  userId: "user1",
  grantId: "grant1",
  grantGeneration: "gen1",
  scopes: ["mcp:read"],
  expiresAt: new Date("2099-01-01"),
  storedAcl: new Map(),
};

describe("principal", () => {
  it("derives actor keys and treats mcp:write as sufficient for reads", () => {
    expect(actorKeyFor({ kind: "browser", userId: "u1" })).toBe("user:u1");
    expect(actorKeyFor(token)).toBe("grant:grant1");
    expect(tokenHasOauthScope(["mcp:read"], false)).toBe(true);
    expect(tokenHasOauthScope(["mcp:write"], false)).toBe(true);
    expect(tokenHasOauthScope(["mcp:read"], true)).toBe(false);
    expect(tokenHasOauthScope(["mcp:write"], true)).toBe(true);
  });

  it("fails closed for banned browsers and revoked credentials", async () => {
    expect(() =>
      assertLiveIdentity({ banned: false, twoFactorSatisfied: true, instanceEnabled: true }),
    ).not.toThrow();
    expect(() => assertLiveIdentity(null)).toThrow(/not admissible/);
    expect(() =>
      assertLiveIdentity({ banned: true, twoFactorSatisfied: true, instanceEnabled: true }),
    ).toThrow(/not admissible/);
    expect(() =>
      assertLiveIdentity({ banned: false, twoFactorSatisfied: false, instanceEnabled: true }),
    ).toThrow(/not admissible/);
    expect(() =>
      assertLiveIdentity({ banned: false, twoFactorSatisfied: true, instanceEnabled: false }),
    ).toThrow(/not admissible/);
    await expect(
      assertTokenAdmissible(token, {
        async inspect() {
          return {
            generationActive: true,
            instanceEnabled: false,
            expired: false,
            banned: false,
            twoFactorSatisfied: true,
          };
        },
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      assertTokenAdmissible(token, {
        async inspect() {
          return {
            generationActive: true,
            instanceEnabled: true,
            expired: true,
            banned: false,
            twoFactorSatisfied: true,
          };
        },
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED", details: { reason: "CREDENTIAL_ENDED" } });
  });

  it("marks only a credential that can never be admitted again as ended", async () => {
    const refusal = (patch: Record<string, boolean>) =>
      assertTokenAdmissible(token, {
        async inspect() {
          return {
            generationActive: true,
            instanceEnabled: true,
            expired: false,
            banned: false,
            twoFactorSatisfied: true,
            ...patch,
          };
        },
      }).catch((error: unknown) => error);
    const ended = { code: "UNAUTHORIZED", details: { reason: "CREDENTIAL_ENDED" } };
    // Revoked/tombstoned or expired: terminal (even with a banned owner).
    expect(await refusal({ generationActive: false, ended: true })).toMatchObject(ended);
    expect(await refusal({ expired: true })).toMatchObject(ended);
    expect(await refusal({ generationActive: false, ended: true, banned: true })).toMatchObject(
      ended,
    );
    // An unreadable expiry fails closed but proves nothing.
    const unreadable = await assertTokenAdmissible(
      { ...token, expiresAt: new Date(Number.NaN) },
      {
        async inspect() {
          return {
            generationActive: true,
            instanceEnabled: true,
            expired: true,
            banned: false,
            twoFactorSatisfied: true,
          };
        },
      },
    ).catch((error: unknown) => error);
    expect(unreadable).toMatchObject({ code: "UNAUTHORIZED" });
    expect((unreadable as { details?: unknown }).details).toBeUndefined();
    // A stale principal or a suspension of a live credential: a plain refusal.
    for (const patch of [
      { generationActive: false },
      { banned: true },
      { twoFactorSatisfied: false },
      { instanceEnabled: false },
    ]) {
      const error = await refusal(patch);
      expect(error).toMatchObject({ code: "UNAUTHORIZED" });
      expect((error as { details?: unknown }).details).toBeUndefined();
    }
  });
});

describe("tool-group demands", () => {
  const admission = (toolGroups?: string[]) => ({
    async inspect() {
      return {
        generationActive: true,
        instanceEnabled: true,
        expired: false,
        banned: false,
        twoFactorSatisfied: true,
        toolGroups,
      };
    },
  });

  it("accumulates any-of demands on token principals only", () => {
    expect(demandToolGroups(token, [])).toBe(token);
    const browser = { kind: "browser" as const, userId: "u1" };
    expect(demandToolGroups(browser, ["edit"])).toBe(browser);
    const scoped = demandToolGroups(demandToolGroups(token, ["edit", "assets"]), ["assets"]);
    expect(scoped.toolGroupDemands).toEqual([["edit", "assets"], ["assets"]]);
    expect(token.toolGroupDemands).toBeUndefined();
    expect(toolGroupsSatisfy(scoped.toolGroupDemands, ["assets"])).toBe(true);
    expect(toolGroupsSatisfy(scoped.toolGroupDemands, ["edit"])).toBe(false);
    expect(toolGroupsSatisfy(undefined, undefined)).toBe(true);
  });

  it("admission denies an ungranted group with FORBIDDEN on the same live read", async () => {
    const scoped = demandToolGroups(token, ["edit"]);
    await expect(assertTokenAdmissible(scoped, admission(["read", "edit"]))).resolves.toMatchObject(
      { toolGroups: ["read", "edit"] },
    );
    await expect(assertTokenAdmissible(scoped, admission(["read"]))).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    // A verifier that reports no groups satisfies no demand.
    await expect(assertTokenAdmissible(scoped, admission())).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(assertTokenAdmissible(token, admission())).resolves.toBeDefined();
  });
});
