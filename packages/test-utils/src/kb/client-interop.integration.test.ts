/**
 * The Rust `kb-client` against the official TS SDK server.
 * Runs `apps/cli/crates/kb-client/tests/sdk_interop.rs` (ignored by default)
 * with the fixture's loopback resource, then asserts what the SDK observed.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sdkInteropBinary } from "./build-artifacts.mjs";
import { type ClientInteropFixture, startClientInteropFixture } from "./client-interop";

const run = promisify(execFile);

describe("kb-client ↔ TS SDK interop (profile 2026-07-28)", () => {
  let fixture: ClientInteropFixture;
  let output = "";
  const token = `kb_pat_interop_${randomBytes(12).toString("hex")}`;

  beforeAll(async () => {
    const binary = sdkInteropBinary();
    fixture = await startClientInteropFixture(token);
    const { stdout, stderr } = await run(binary, ["--ignored", "--test-threads=1"], {
      env: {
        ...process.env,
        KB_INTEROP_RESOURCE: fixture.resource,
        KB_INTEROP_TOKEN: token,
      },
      maxBuffer: 64 * 1024 * 1024,
    });
    output = `${stdout}\n${stderr}`;
  }, 900_000);

  afterAll(async () => {
    await fixture?.close();
  });

  it("runs every Rust interop test and they all pass", () => {
    expect(output).toMatch(/test result: ok\. 6 passed; 0 failed; 0 ignored/);
    expect(output).not.toContain(token);
  });

  it("speaks only the stateless 2026-07-28 profile with standard headers", () => {
    expect(fixture.requests.length).toBeGreaterThanOrEqual(8);
    const methods = new Set<string>();
    for (const { headers, body } of fixture.requests) {
      const method = String(body.method);
      methods.add(method);
      expect(body.jsonrpc).toBe("2.0");
      expect(typeof body.id).toBe("number");
      expect(headers["content-type"]).toBe("application/json");
      expect(headers["mcp-protocol-version"]).toBe("2026-07-28");
      expect(headers["mcp-method"]).toBe(method);
      expect(headers["mcp-session-id"]).toBeUndefined();
      expect(headers.cookie).toBeUndefined();
      expect(body.params?._meta).toMatchObject({
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
      });
      if (method === "tools/call") expect(headers["mcp-name"]).toBe(body.params?.name);
      else expect(headers["mcp-name"]).toBeUndefined();
    }
    expect([...methods].sort()).toEqual(["server/discover", "tools/call", "tools/list"]);
  });

  it("retried the mutation with one idempotency key and saw the cancel", () => {
    expect(fixture.mutationKeys).toHaveLength(2);
    expect(new Set(fixture.mutationKeys).size).toBe(1);
    expect(fixture.aborted).toEqual(["knowledge_index_status"]);
  });

  it("sent eight dream upserts as exactly one atomic changes_apply call", () => {
    expect(fixture.dreamApplies).toHaveLength(1);
    const [args] = fixture.dreamApplies;
    expect(args).toMatchObject({ mode: "dream", changes: [], baseRevision: "0".repeat(40) });
    const dream = args?.dream as { upserts: unknown[]; redactionApplied: boolean };
    expect(dream.upserts).toHaveLength(8);
    expect(dream.redactionApplied).toBe(true);
    expect(args?.sourceSessionIds).toHaveLength(2);
    expect(typeof args?.idempotencyKey).toBe("string");
  });

  it("presented the wrong-token request only to this origin and rejected it", () => {
    const unauthorized = fixture.requests.filter(
      ({ headers }) => headers.authorization !== `Bearer ${token}`,
    );
    expect(unauthorized).toHaveLength(1);
  });
});
