import { describe, expect, it } from "vitest";

import {
  deriveMcpConsentReferenceId,
  McpGrantSelectionError,
  newMcpGrantGeneration,
  normalizeGrantCeiling,
  resolveMcpGrantDecision,
} from "./mcp-grant";

describe("grant generations", () => {
  it("mints distinct random UUID generations", () => {
    const a = newMcpGrantGeneration();
    const b = newMcpGrantGeneration();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
  });

  it("never reuses a tombstoned generation on code exchange or refresh", () => {
    const tomb = {
      id: "g",
      userId: "u",
      clientId: "c",
      referenceId: "r",
      revokedAt: new Date(),
    };
    for (const grantType of ["authorization_code", "refresh_token"] as const) {
      expect(
        resolveMcpGrantDecision({ grantType, userId: "u", referenceId: "r", existing: tomb }),
      ).toEqual({ action: "reject", reason: "tombstone" });
    }
    expect(
      resolveMcpGrantDecision({
        grantType: "refresh_token",
        userId: "u",
        referenceId: "r",
        existing: null,
      }),
    ).toEqual({ action: "reject", reason: "inactive-on-refresh" });
  });

  it("code exchange cannot synthesize a missing durable consent grant", () => {
    expect(
      resolveMcpGrantDecision({
        grantType: "authorization_code",
        userId: "u",
        referenceId: "r",
        existing: null,
      }),
    ).toEqual({ action: "reject", reason: "missing-consent" });
  });

  it("derives a deterministic fixed-length consent reference", () => {
    const a = deriveMcpConsentReferenceId({
      secret: "s",
      sessionId: "x",
      nonce: "n",
      clientId: "c",
    });
    expect(a).toHaveLength(64);
    expect(
      deriveMcpConsentReferenceId({ secret: "s", sessionId: "x", nonce: "n", clientId: "c" }),
    ).toBe(a);
    expect(
      deriveMcpConsentReferenceId({ secret: "s", sessionId: "x", nonce: "n", clientId: "d" }),
    ).not.toBe(a);
  });
});

describe("normalizeGrantCeiling", () => {
  const base = {
    scopes: ["mcp:read"],
    toolGroups: ["read"],
    acl: [],
    allowCreate: false,
    createdKbBits: [],
  };

  it("defaults allowCreate false with no created bits and accepts an explicit empty ACL", () => {
    expect(normalizeGrantCeiling({ scopes: ["mcp:read"], toolGroups: ["read"], acl: [] })).toEqual({
      scopes: ["mcp:read"],
      toolGroups: ["read"],
      acl: [],
      allowCreate: false,
      createdKbBits: [],
    });
  });

  it("rejects created bits unless creation was explicitly allowed", () => {
    expect(() => normalizeGrantCeiling({ ...base, createdKbBits: ["read"] })).toThrow(
      McpGrantSelectionError,
    );
  });

  it("requires read in created bits and literal mcp:write for creation", () => {
    expect(() =>
      normalizeGrantCeiling({
        ...base,
        scopes: ["mcp:write"],
        allowCreate: true,
        createdKbBits: [],
      }),
    ).toThrow(McpGrantSelectionError);
    expect(() =>
      normalizeGrantCeiling({
        ...base,
        scopes: ["mcp:write"],
        allowCreate: true,
        createdKbBits: ["propose"],
      }),
    ).toThrow(McpGrantSelectionError);
    expect(() =>
      normalizeGrantCeiling({ ...base, allowCreate: true, createdKbBits: ["read"] }),
    ).toThrow(McpGrantSelectionError);
    expect(
      normalizeGrantCeiling({
        ...base,
        scopes: ["mcp:write", "mcp:read"],
        toolGroups: ["read", "kb_admin"],
        allowCreate: true,
        createdKbBits: ["propose", "read"],
      }),
    ).toMatchObject({
      scopes: ["mcp:read", "mcp:write"],
      allowCreate: true,
      createdKbBits: ["read", "propose"],
    });
  });

  it("decision 7: creation always requires the kb_admin group", () => {
    const create = {
      ...base,
      scopes: ["mcp:write"],
      allowCreate: true,
      createdKbBits: ["read"],
    };
    expect(() => normalizeGrantCeiling(create)).toThrow(/kb_admin/);
    expect(normalizeGrantCeiling({ ...create, toolGroups: ["kb_admin", "read"] })).toMatchObject({
      toolGroups: ["read", "kb_admin"],
      allowCreate: true,
    });
  });

  it("rejects unknown, duplicated, empty and offline scopes and unknown bits", () => {
    for (const scopes of [[], ["offline_access"], ["mcp:read", "mcp:read"], ["MCP:READ"]]) {
      expect(() => normalizeGrantCeiling({ ...base, scopes })).toThrow(McpGrantSelectionError);
    }
    expect(() =>
      normalizeGrantCeiling({ ...base, acl: [{ kbId: "k".repeat(24), bits: ["admin"] }] }),
    ).toThrow(McpGrantSelectionError);
    expect(() =>
      normalizeGrantCeiling({ ...base, acl: [{ kbId: "k".repeat(24), bits: [] }] }),
    ).toThrow(McpGrantSelectionError);
    expect(() =>
      normalizeGrantCeiling({
        ...base,
        acl: [
          { kbId: "k".repeat(24), bits: ["read"] },
          { kbId: "k".repeat(24), bits: ["write"] },
        ],
      }),
    ).toThrow(McpGrantSelectionError);
  });
});

describe("tool groups", () => {
  const base = { scopes: ["mcp:read"], acl: [] };

  it("requires a non-empty set of known, distinct groups and stores it in canonical order", () => {
    expect(
      normalizeGrantCeiling({ ...base, toolGroups: ["sealed", "read", "edit"] }).toolGroups,
    ).toEqual(["read", "edit", "sealed"]);
    for (const toolGroups of [[], ["read", "read"], ["admin"], ["READ"]]) {
      expect(() => normalizeGrantCeiling({ ...base, toolGroups })).toThrow(McpGrantSelectionError);
    }
  });
});
