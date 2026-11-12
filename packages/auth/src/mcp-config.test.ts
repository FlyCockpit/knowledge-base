import { describe, expect, it } from "vitest";

import {
  canonicalMcpResource,
  MCP_PAT_DEFAULT_TTL_DAYS,
  MCP_PAT_MAX_ACTIVE_PER_USER,
  MCP_PAT_MAX_TTL_DAYS,
  MCP_PAT_SCOPES,
  mcpScopesAllow,
  parseMcpScopes,
  patDisplayName,
  resolvePatExpiry,
  resolvePatMintExpiry,
} from "./mcp-config";

const DAY = 86_400_000;

describe("PAT display names", () => {
  it("rejects every C0/DEL/C1 control before trimming, including at the edges", () => {
    for (let code = 0; code <= 159; code++) {
      if (code >= 32 && code < 127) continue;
      const control = String.fromCodePoint(code);
      for (const name of [`Laptop${control}name`, `${control}Laptop`, `Laptop${control}`])
        expect(patDisplayName.safeParse(name).success).toBe(false);
    }
  });
  it("preserves Unicode display text, trims spaces and keeps the existing bounds", () => {
    expect(patDisplayName.parse("  Ordinateur 日本語 💻  ")).toBe("Ordinateur 日本語 💻");
    expect(patDisplayName.parse("a".repeat(120))).toHaveLength(120);
    for (const name of ["", "  ", "a".repeat(121)])
      expect(patDisplayName.safeParse(name).success).toBe(false);
  });
});

describe("PAT limits", () => {
  it("pins the product budget: 10 live tokens, 90d default, 365d cap", () => {
    expect(MCP_PAT_MAX_ACTIVE_PER_USER).toBe(10);
    expect(MCP_PAT_DEFAULT_TTL_DAYS).toBe(90);
    expect(MCP_PAT_MAX_TTL_DAYS).toBe(365);
  });

  it("never offers refresh/offline_access on a PAT", () => {
    expect(MCP_PAT_SCOPES).toEqual(["mcp:read", "mcp:write"]);
    expect(MCP_PAT_SCOPES).not.toContain("offline_access");
  });

  it("defaults an omitted expiry to exactly 90 days", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    expect(resolvePatExpiry(undefined, now)).toEqual(new Date(now.getTime() + 90 * DAY));
  });

  it("accepts the 365 day boundary and rejects past, now, >365d and non-expiring", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const cap = new Date(now.getTime() + 365 * DAY);
    expect(resolvePatExpiry(cap, now)).toEqual(cap);
    expect(() => resolvePatExpiry(new Date(cap.getTime() + 1), now)).toThrow();
    expect(() => resolvePatExpiry(now, now)).toThrow();
    expect(() => resolvePatExpiry(new Date(now.getTime() - 1), now)).toThrow();
    expect(() => resolvePatExpiry(null as unknown as Date, now)).toThrow();
    expect(() => resolvePatExpiry(new Date(Number.NaN), now)).toThrow();
  });
});

describe("human PAT mint expiry", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  it("omitted is now+90d, a dated expiry is bounded, explicit null never expires", () => {
    expect(resolvePatMintExpiry(undefined, now)).toEqual(new Date(now.getTime() + 90 * DAY));
    expect(resolvePatMintExpiry(null, now)).toBeNull();
    const cap = new Date(now.getTime() + 365 * DAY);
    expect(resolvePatMintExpiry(cap, now)).toEqual(cap);
    expect(() => resolvePatMintExpiry(new Date(now.getTime() + 400 * DAY), now)).toThrow();
    expect(() => resolvePatMintExpiry(new Date(now.getTime() - 1), now)).toThrow();
  });
});

describe("scope matcher", () => {
  it("uses literal space-separated tokens only", () => {
    expect(parseMcpScopes("mcp:read mcp:write")).toEqual(["mcp:read", "mcp:write"]);
    expect(parseMcpScopes(" mcp:write")).toEqual([]);
    expect(parseMcpScopes(["MCP:WRITE"])).toEqual(["MCP:WRITE"]);
  });

  it("reads accept read or write; mutations need literal mcp:write", () => {
    expect(mcpScopesAllow(["mcp:read"], "read")).toBe(true);
    expect(mcpScopesAllow(["mcp:write"], "read")).toBe(true);
    expect(mcpScopesAllow(["mcp:read"], "write")).toBe(false);
    expect(mcpScopesAllow(["MCP:WRITE"], "write")).toBe(false);
  });

  it("derives the canonical MCP resource from the origin", () => {
    expect(canonicalMcpResource("https://kb.example.com")).toBe("https://kb.example.com/mcp");
  });
});
