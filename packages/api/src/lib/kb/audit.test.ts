import { describe, expect, it } from "vitest";
import { recordAuditEvent, recordAuditFailure, sanitizeAuditMetadata } from "./audit";

describe("audit metadata", () => {
  it("keeps the allowlist and refuses source or error bodies", () => {
    expect(sanitizeAuditMetadata({ reasonCode: "denied", kbId: "kb1" })).toEqual({
      reasonCode: "denied",
      kbId: "kb1",
    });
    expect(() => sanitizeAuditMetadata({ error: "boom" })).toThrow(/allowlisted/);
    expect(() => sanitizeAuditMetadata({ source: "SELECT 1" })).toThrow(/allowlisted/);
    expect(() => sanitizeAuditMetadata({ stack: "x" })).toThrow(/allowlisted/);
  });
});

describe("index settings audit metadata (§1.9)", () => {
  it.each([
    ["index_quantization_set", { kbId: "kb1", state: "int8" }],
    ["index_chunk_limit_set", { kbId: "kb1", amount: "250000" }],
    ["index_chunk_limit_set", { kbId: "kb1", amount: "default" }],
    ["index_chunk_ceiling_set", { state: "binary_int8_rescore", amount: "4000000" }],
  ])("%s uses only allowlisted keys", async (action, metadata) => {
    expect(sanitizeAuditMetadata(metadata)).toEqual(metadata);
    const values: unknown[][] = [];
    await recordAuditEvent(
      async (_text, params = []) => {
        values.push(params);
        return { rows: [], rowCount: 1 };
      },
      {
        opId: "op-1",
        action,
        outcome: "SUCCESS",
        actorKey: "user:u1",
        actorUserIdSnapshot: "u1",
        metadata,
      },
    );
    expect(values[0]?.[2]).toBe(action);
    expect(JSON.parse(String(values[0]?.[10]))).toEqual(metadata);
  });
});

describe("audit uniqueness", () => {
  it("inserts success rows with (opId, action, outcome) conflict ignored", async () => {
    const sql: string[] = [];
    await recordAuditEvent(
      async (text, values) => {
        sql.push(text);
        expect(values?.[1]).toBe("op-1");
        expect(values?.[3]).toBe("SUCCESS");
        return { rows: [], rowCount: 1 };
      },
      {
        opId: "op-1",
        action: "kb.create",
        outcome: "SUCCESS",
        actorKey: "user:u1",
        actorUserIdSnapshot: "u1",
        metadata: { kbId: "kb1" },
      },
    );
    expect(sql[0]).toMatch(/ON CONFLICT \("opId", action, outcome\) DO NOTHING/);
  });

  it("records failures under a request id rather than an attacker-selected op id", async () => {
    const valuesSeen: unknown[][] = [];
    const requestId = await recordAuditFailure(
      async (_text, values = []) => {
        valuesSeen.push(values);
        return { rows: [], rowCount: 1 };
      },
      {
        action: "authz.denied",
        actorKey: "user:u1",
        actorUserIdSnapshot: "u1",
        metadata: { reasonCode: "not_found", requestId: "attacker-chosen" },
      },
    );
    expect(requestId).not.toBe("attacker-chosen");
    expect(String(valuesSeen[0]?.[10])).not.toContain("attacker-chosen");
    expect(requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(valuesSeen[0]?.[1]).toBe(requestId);
    expect(valuesSeen[0]?.[3]).toBe("FAILURE");
    expect(String(valuesSeen[0]?.[10])).toContain(requestId);
    expect(String(valuesSeen[0]?.[10])).not.toContain("SELECT");
  });
});
