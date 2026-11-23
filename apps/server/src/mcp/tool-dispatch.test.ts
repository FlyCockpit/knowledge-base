import { kbListRetryError, mapKbDomainError } from "@knowledge-base/api/lib/kb/bases";
import { KbDomainError } from "@knowledge-base/api/lib/kb/errors";
import { KbLockError, type KbLockErrorCode } from "@knowledge-base/api/lib/kb/lock";
import { KB_TOOL_NAMES } from "@knowledge-base/api/lib/kb/protocol/catalog";
import fixtures from "@knowledge-base/api/lib/kb/protocol/fixtures.json";
import { kbReadToolSchemas } from "@knowledge-base/api/lib/kb/protocol/reads";
import type { KbRuntimeConfig } from "@knowledge-base/api/lib/kb/runtime";
import { captureLog } from "@knowledge-base/env/log";
import { describe, expect, it, vi } from "vitest";
import { type BearerAdmission, bindBearerAdmission } from "./context";
import { dispatchTool, toolFailure, toolSuccess } from "./tool-dispatch";

describe("closed MCP envelopes", () => {
  const lockCases: Record<KbLockErrorCode, [string, boolean]> = {
    LOCK_TIMEOUT: ["STORAGE_UNAVAILABLE", true],
    CONNECTION_LOST: ["STORAGE_UNAVAILABLE", true],
    ADMISSION_CLOSED: ["STORAGE_UNAVAILABLE", true],
    DEADLINE_EXCEEDED: ["DEADLINE_EXCEEDED", true],
    REVOKED: ["CANCELLED", false],
    LOCK_ORDER: ["INTERNAL", false],
    AUTHORITY_HELD: ["INTERNAL", false],
    NOT_HELD: ["INTERNAL", false],
  };
  it.each(Object.entries(lockCases))(
    "maps typed lock failure %s through domain wrapping and MCP",
    (kind, [code, retryable]) => {
      const error = new KbLockError(
        kind as KbLockErrorCode,
        "private coordinator detail",
        "private-op",
      );
      for (const failure of [error, mapKbDomainError(error)]) {
        const result = toolFailure(failure);
        expect(result.structuredContent.error).toMatchObject({ code, retryable, details: {} });
        expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
        expect(JSON.stringify(result)).not.toContain("private");
      }
    },
  );
  it.each(KB_TOOL_NAMES)(
    "validates %s output and preserves all nulls in identical JSON",
    (name) => {
      const data = fixtures.tools[name].validOutput;
      const result = toolSuccess(name, data);
      expect(result.structuredContent).toEqual({ schemaVersion: "kb/1", data });
      expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
      expect(() => toolSuccess(name, { ...data, privateKey: "must never escape" })).toThrow();
    },
  );
  it("reports a KB list scan exhausted mid-race as retryable, without its detail", () => {
    for (const failure of [kbListRetryError(), mapKbDomainError(kbListRetryError())]) {
      const result = toolFailure(failure);
      expect(result.structuredContent.error).toMatchObject({
        code: "STORAGE_UNAVAILABLE",
        retryable: true,
        details: {},
      });
      expect(JSON.stringify(result)).not.toContain("changed");
    }
  });
  it("never returns raw exception/provider messages or invalid details", () => {
    expect(toolFailure(new Error("provider password"))).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "INTERNAL", message: "Internal error", details: {} } },
    });
    const conflict = new KbDomainError("CONFLICT", "private branch", undefined, {
      headSha: "a".repeat(40),
      proposalNumber: null,
    });
    expect(toolFailure(conflict).structuredContent.error.details).toEqual({
      headSha: "a".repeat(40),
      proposalNumber: null,
    });
    expect(
      toolFailure(new KbDomainError("RATE_LIMITED", "secret", 3)).structuredContent.error.details,
    ).toEqual({ retryAfterSeconds: 3 });
    expect(
      toolFailure(new KbDomainError("INDEX_UNAVAILABLE", "provider raw")).structuredContent.error
        .details,
    ).toEqual({});
  });
  it("logs server-side failures with their context and nothing else (R3-W3)", () => {
    const logged = captureLog();
    try {
      toolFailure(new Error("Command failed: git merge-tree token=CANARY_TOOL"), {
        tool: "knowledge_pull_requests_merge",
        kbId: "kb1",
        requestId: "req1",
      });
      toolFailure(new KbDomainError("STORAGE_UNAVAILABLE", "CANARY_TOOL unavailable"), {
        tool: "t",
      });
      toolFailure(new KbDomainError("CONFLICT", "caller's own conflict"));
      toolFailure(new KbDomainError("NOT_FOUND", "missing"));
      const lines = logged.records.map((record) => JSON.stringify(record));
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]!)).toEqual({
        level: "error",
        site: "mcp.tool",
        message: "MCP tool call failed with an internal error",
        errorClass: "Error",
        requestId: "req1",
        tool: "knowledge_pull_requests_merge",
        kbId: "kb1",
        code: "INTERNAL",
      });
      expect(JSON.parse(lines[1]!)).toEqual({
        level: "error",
        site: "mcp.tool",
        message: "MCP tool call failed with an internal error",
        errorClass: "KbDomainError",
        errorCode: "STORAGE_UNAVAILABLE",
        tool: "t",
        code: "STORAGE_UNAVAILABLE",
      });
      expect(lines.join("\n")).not.toContain("CANARY_TOOL");
    } finally {
      logged.restore();
    }
  });
  it("rejects malformed output and encoded response overflow", () => {
    expect(() => toolSuccess("knowledge_bases_list", { items: [] })).toThrow();
    expect(() =>
      toolSuccess("knowledge_documents_get", {
        ...fixtures.tools.knowledge_documents_get.validOutput,
        markdown: "x".repeat(8 * 1024 * 1024),
      }),
    ).toThrow();
  });
});

describe("EMBEDDING_REBUILD_PENDING search notice", () => {
  const kbId = "k".repeat(24);
  const sha = "a".repeat(40);
  const search = (indexNotices: unknown[]) => ({
    results: [],
    generationId: "g".repeat(24),
    freshness: "current",
    indexedCommitSha: sha,
    headSha: sha,
    indexNotices,
  });

  it("adds exactly one human-readable warning line per notice after the JSON envelope", () => {
    const pending = toolSuccess(
      "knowledge_search",
      search([{ kbId, code: "EMBEDDING_REBUILD_PENDING", detail: "EMBEDDING_SETTINGS_CHANGED" }]),
    );
    expect(pending.content).toHaveLength(2);
    // The envelope stays the first text item and still equals structuredContent.
    expect(JSON.parse(pending.content[0].text)).toEqual(pending.structuredContent);
    const warning = pending.content[1]!.text;
    expect(warning.split("\n")).toHaveLength(1);
    expect(warning).toContain(kbId);
    expect(warning).toMatch(/previous embedding settings/i);
    expect(warning).toMatch(/rebuild pending/i);

    const lexical = toolSuccess(
      "knowledge_search",
      search([{ kbId, code: "EMBEDDING_REBUILD_PENDING", detail: "EMBEDDING_MODEL_CHANGED" }]),
    );
    expect(lexical.content[1]!.text).toMatch(/lexical-only/i);

    // Stop-then-probe gap: lexical-only while the built-in runtime reloads.
    const reloading = toolSuccess(
      "knowledge_search",
      search([{ kbId, code: "EMBEDDING_REBUILD_PENDING", detail: "EMBEDDING_RUNTIME_RELOADING" }]),
    );
    expect(reloading.content[1]!.text).toMatch(/lexical-only/i);
    expect(reloading.content[1]!.text).toMatch(/reload/i);
    expect(reloading.content[1]!.text).not.toMatch(/model changed/i);
  });

  it.each(["EMBEDDING_SETTINGS_CHANGED", "EMBEDDING_MODEL_CHANGED", "EMBEDDING_RUNTIME_RELOADING"])(
    "queryless structured %s warns without claiming semantic ranking",
    (detail) => {
      const output = kbReadToolSchemas.knowledge_structured_search.output.parse(
        fixtures.tools.knowledge_structured_search.validOutput,
      );
      for (const items of [[], output.items.map((item) => ({ ...item, mode: "structured" }))]) {
        const result = toolSuccess("knowledge_structured_search", {
          ...output,
          items,
          indexNotices: [{ kbId, code: "EMBEDDING_REBUILD_PENDING", detail }],
        });
        expect(result.content).toHaveLength(2);
        expect(result.content[1]!.text).toMatch(/previous index/);
        expect(result.content[1]!.text).not.toMatch(/semantic ranking|lexical-only/);
        expect(result.content[1]!.text).toMatch(
          detail === "EMBEDDING_RUNTIME_RELOADING" ? /runtime is reloading/ : /rebuild pending/,
        );
      }
    },
  );

  it.each([
    ["NO_EMBEDDING_PROFILE", /no embedding model is selected/],
    ["EMBEDDING_PROFILE_REVOKED", /embedding provider was revoked/],
    ["EMBEDDING_PROFILE_UNAVAILABLE", /embedding model isn't available/],
    ["SEMANTIC_INDEX_BUILDING", /semantic index is still building/],
  ])("LEXICAL_ONLY %s says why the search was lexical-only", (detail, why) => {
    const result = toolSuccess(
      "knowledge_search",
      search([{ kbId, code: "LEXICAL_ONLY", detail }]),
    );
    expect(result.content).toHaveLength(2);
    const warning = result.content[1]!.text;
    expect(warning.split("\n")).toHaveLength(1);
    expect(warning).toContain(`knowledge base ${kbId} was searched lexical-only`);
    expect(warning).toMatch(why);
    // A building semantic index needs no action from the user.
    if (detail === "SEMANTIC_INDEX_BUILDING") expect(warning).not.toMatch(/settings/);
    else expect(warning).toMatch(/knowledge base settings/);
  });

  it("a search without notices has no warning text", () => {
    expect(toolSuccess("knowledge_search", search([])).content).toHaveLength(1);
  });
});

describe("tool-group authorization at dispatch", () => {
  const admission = {
    generationActive: true,
    instanceEnabled: true,
    expired: false,
    banned: false,
    twoFactorSatisfied: true,
    toolGroups: ["read"],
  };
  // Any domain or storage access fails the test: a denied group stops first.
  const runtime = new Proxy({} as KbRuntimeConfig, {
    get(_target, key) {
      if (key === "then") return undefined;
      throw new Error(`runtime.${String(key)} touched`);
    },
  });
  const inspect = vi.fn(async () => admission);
  const actor = (): BearerAdmission =>
    bindBearerAdmission(
      {
        kind: "token",
        userId: "u",
        grantId: "g",
        grantGeneration: "g",
        scopes: ["mcp:write"],
        expiresAt: new Date("2099-01-01"),
        storedAcl: new Map(),
      },
      { inspect },
    );

  it("refuses a tool outside the connection's groups with FORBIDDEN before any domain call", async () => {
    const a = actor();
    const result = await dispatchTool(
      "knowledge_bases_create",
      { name: "x", slug: "x", idempotencyKey: "00000000-0000-4000-8000-000000000000" } as never,
      { runtime, actor: a, signal: new AbortController().signal },
    );
    expect(result.structuredContent).toMatchObject({ error: { code: "FORBIDDEN" } });
    // Only the first recheck (with the tool's demand) and the error-path read check ran.
    expect(inspect).toHaveBeenCalled();
  });

  it("a denied KB-scoped tool stays FORBIDDEN through the error-path recheck", async () => {
    const a = actor();
    const result = await dispatchTool(
      "knowledge_changes_apply",
      { kbId: "k".repeat(24), idempotencyKey: "i", mode: "edit", changes: [] } as never,
      {
        runtime: { prisma: {} } as unknown as KbRuntimeConfig,
        actor: a,
        signal: new AbortController().signal,
      },
    );
    expect(result.structuredContent).toMatchObject({ error: { code: "FORBIDDEN" } });
  });
});

describe("write-mode authorization at dispatch", () => {
  const groups = ["read", "edit", "assets", "export", "pull_requests", "index_admin", "kb_admin"];
  const actor = (authoringMode: "dream" | "edit" | "both") =>
    bindBearerAdmission(
      {
        kind: "token",
        userId: "u",
        grantId: "g",
        grantGeneration: "g",
        scopes: ["mcp:read", "mcp:write"],
        expiresAt: new Date("2099-01-01"),
        storedAcl: new Map(),
      },
      {
        inspect: async () => ({
          generationActive: true,
          instanceEnabled: true,
          expired: false,
          banned: false,
          twoFactorSatisfied: true,
          toolGroups: groups,
          authoringMode,
        }),
      },
    );
  // An empty Prisma stub: a call that got past admission would fail as INTERNAL,
  // never as the write-mode refusal asserted here.
  const runtime = { prisma: {} } as unknown as KbRuntimeConfig;
  const kbId = "k".repeat(24);
  const key = "00000000-0000-4000-8000-000000000000";
  const sha = "a".repeat(40);
  const calls: Record<string, { need: "dream" | "edit"; input: Record<string, unknown> }> = {
    "knowledge_changes_apply:edit": {
      need: "edit",
      input: { kbId, idempotencyKey: key, mode: "edit", baseRevision: sha, changes: [] },
    },
    "knowledge_changes_apply:dream": {
      need: "dream",
      input: { kbId, idempotencyKey: key, mode: "dream", baseRevision: sha, changes: [] },
    },
    knowledge_documents_create: { need: "edit", input: { kbId, idempotencyKey: key } },
    knowledge_documents_update: { need: "edit", input: { kbId, idempotencyKey: key } },
    knowledge_documents_delete: { need: "edit", input: { kbId, idempotencyKey: key } },
    knowledge_upload_begin: { need: "edit", input: { kbId, idempotencyKey: key } },
    knowledge_upload_write: { need: "edit", input: { kbId } },
    knowledge_upload_finish: { need: "edit", input: { kbId } },
    knowledge_assets_put: { need: "edit", input: { kbId, idempotencyKey: key } },
    knowledge_assets_import: { need: "edit", input: { kbId, idempotencyKey: key } },
    knowledge_pull_requests_create: { need: "edit", input: { kbId, idempotencyKey: key } },
    "knowledge_pull_requests_review:merge": {
      need: "edit",
      input: { kbId, idempotencyKey: key, decision: "merge" },
    },
    knowledge_bases_create: { need: "edit", input: { name: "x", slug: "x", idempotencyKey: key } },
    knowledge_bases_delete: { need: "edit", input: { kbId, idempotencyKey: key } },
  };

  it("refuses each authoring call the write mode does not allow, before any domain call, with WRITE_MODE details", async () => {
    for (const [label, { need, input }] of Object.entries(calls)) {
      const name = label.split(":")[0] as (typeof KB_TOOL_NAMES)[number];
      const refusing = need === "dream" ? "edit" : "dream";
      const result = await dispatchTool(name, input as never, {
        runtime,
        actor: actor(refusing),
        signal: new AbortController().signal,
      });
      expect(result.structuredContent, label).toMatchObject({
        error: { code: "FORBIDDEN", details: { reason: "WRITE_MODE", required: need } },
      });
    }
  });

  it("lets the matching mode and `both` past the write-mode check (then the stub fails)", async () => {
    for (const [label, { need, input }] of Object.entries(calls)) {
      const name = label.split(":")[0] as (typeof KB_TOOL_NAMES)[number];
      for (const mode of [need, "both"] as const) {
        const result = await dispatchTool(name, input as never, {
          runtime,
          actor: actor(mode),
          signal: new AbortController().signal,
        });
        expect(
          (result.structuredContent as { error?: { details?: { reason?: string } } }).error?.details
            ?.reason,
          `${label} ${mode}`,
        ).not.toBe("WRITE_MODE");
      }
    }
  });

  it("closing a PR and reading need no write mode", async () => {
    for (const [name, input] of [
      ["knowledge_pull_requests_review", { kbId, idempotencyKey: key, decision: "close" }],
      ["knowledge_documents_get", { kbId, path: "a.md" }],
    ] as const) {
      const result = await dispatchTool(name, input as never, {
        runtime,
        actor: actor("dream"),
        signal: new AbortController().signal,
      });
      expect(
        (result.structuredContent as { error?: { details?: { reason?: string } } }).error?.details
          ?.reason,
      ).not.toBe("WRITE_MODE");
    }
  });
});
