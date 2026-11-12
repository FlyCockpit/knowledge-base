import { describe, expect, it } from "vitest";

import { isPermanentBanWrite, isUserBanned, revokeUserMcpGrants } from "./ban";

describe("isUserBanned", () => {
  it("is false for a user who was never banned", () => {
    expect(isUserBanned({ banned: false, banExpires: null })).toBe(false);
    expect(isUserBanned({})).toBe(false);
    expect(isUserBanned({ banned: null })).toBe(false);
  });

  it("is true for a permanent ban", () => {
    // `banExpires: null` on a banned user is what `users.archive` writes.
    expect(isUserBanned({ banned: true, banExpires: null })).toBe(true);
    expect(isUserBanned({ banned: true })).toBe(true);
  });

  it("is true while a temporary ban is in force and false once it lapses", () => {
    expect(isUserBanned({ banned: true, banExpires: new Date(Date.now() + 60_000) })).toBe(true);
    expect(isUserBanned({ banned: true, banExpires: new Date(Date.now() - 60_000) })).toBe(false);
  });

  it("accepts an ISO string for banExpires, as the cookie cache hands it over", () => {
    // The regression this guards: on a Better-Auth cookie-cache HIT the session
    // user is revived from base64(JSON) and only createdAt/updatedAt become
    // Dates (`better-auth/dist/api/routes/session.mjs:110-114`), so banExpires
    // arrives as a string. Calling `.getTime()` on it threw a TypeError, which
    // for a LAPSED ban — where the answer should be "allow" — turned a
    // legitimate admin's request into a 500 until the cache expired.
    expect(
      isUserBanned({ banned: true, banExpires: new Date(Date.now() + 60_000).toISOString() }),
    ).toBe(true);
    expect(
      isUserBanned({ banned: true, banExpires: new Date(Date.now() - 60_000).toISOString() }),
    ).toBe(false);
  });

  it("stays banned when banExpires is unparseable", () => {
    // Fail closed: this predicate only ever gates access.
    expect(isUserBanned({ banned: true, banExpires: "not-a-date" })).toBe(true);
  });
});

describe("isPermanentBanWrite", () => {
  it("a ban with no expiry revokes; a dated (temporary) ban only suspends", () => {
    expect(isPermanentBanWrite({ banned: true, banExpires: null })).toBe(true);
    expect(isPermanentBanWrite({ banned: true })).toBe(true);
    expect(isPermanentBanWrite({ banned: true, banExpires: "not-a-date" })).toBe(true);
    expect(isPermanentBanWrite({ banned: true, banExpires: new Date(Date.now() + 60_000) })).toBe(
      false,
    );
    expect(
      isPermanentBanWrite({
        banned: true,
        banExpires: new Date(Date.now() + 60_000).toISOString(),
      }),
    ).toBe(false);
  });
  it("is false for unban and unrelated writes", () => {
    expect(isPermanentBanWrite({ banned: false, banExpires: null })).toBe(false);
    expect(isPermanentBanWrite({ name: "n" })).toBe(false);
  });
});

describe("revokeUserMcpGrants", () => {
  it("tombstones only the user's live PATs and grants, never clearing an existing tombstone", async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    await revokeUserMcpGrants(
      async (sql, params) => {
        calls.push({ sql, params });
      },
      "u1",
      "ban",
    );
    expect(calls).toHaveLength(2);
    expect(calls[0]!.sql).toMatch(/UPDATE "mcp_personal_token"/);
    expect(calls[1]!.sql).toMatch(/UPDATE "mcp_grant"/);
    for (const call of calls) {
      expect(call.params[0]).toBe("u1");
      expect(call.sql).toMatch(/"revokedAt" IS NULL/);
      expect(call.sql).toMatch(/COALESCE\("revokedAt", now\(\)\)/);
      expect(call.sql).not.toMatch(/"revokedAt" = NULL|DELETE/);
    }
    expect(calls[1]!.params[1]).toBe("ban");
  });
});
