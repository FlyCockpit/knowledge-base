import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  argumentDetails,
  fieldPointer,
  markdownIssueReason,
  pathExists,
  pathIssueReason,
  reasonedConflict,
  schemaIssueDetails,
  treeFailureDetails,
} from "./argument-reasons";
import {
  buildKbErrorCallToolResult,
  kbProtocolErrorSchema,
  parseKbErrorDetailsForCode,
} from "./protocol/envelope";
import { kbReadToolSchemas } from "./protocol/reads";
import { kbWriteToolSchemas } from "./protocol/writes";

const KB = "a".repeat(24);
const SHA = "b".repeat(40);
const schemas = { ...kbReadToolSchemas, ...kbWriteToolSchemas };
function details(name: keyof typeof schemas, input: unknown) {
  const parsed = schemas[name].input.safeParse(input);
  if (parsed.success) throw new Error("expected a refusal");
  const out = schemaIssueDetails(parsed.error, input, name);
  // Every produced shape is a valid kb/1 INVALID_ARGUMENT detail.
  expect(parseKbErrorDetailsForCode("INVALID_ARGUMENT", out)).toEqual(out);
  return out;
}
const create = (path: string, markdown = "body") => ({
  op: "create" as const,
  path,
  content: { markdown },
});
const apply = (changes: unknown[]) => ({
  kbId: KB,
  idempotencyKey: "k".repeat(16),
  mode: "edit",
  baseRevision: SHA,
  title: "t",
  changes,
  sourceSessionIds: [],
});

describe("INVALID_ARGUMENT reasons (L-9 cases)", () => {
  it("names unknown arguments by pointer and missing ones apart from wrong ones", () => {
    expect(details("knowledge_documents_get", { kbId: KB, path: "a.md", revision: SHA })).toEqual({
      reason: "UNKNOWN_ARGUMENT",
      field: "/revision",
    });
    expect(details("knowledge_documents_list", { kbId: KB, pathPrefix: "notes" })).toEqual({
      reason: "UNKNOWN_ARGUMENT",
      field: "/pathPrefix",
    });
    // An unsafe key name is never echoed back.
    expect(details("knowledge_documents_get", { kbId: KB, path: "a.md", "x y": 1 })).toEqual({
      reason: "UNKNOWN_ARGUMENT",
    });
    expect(details("knowledge_documents_get", { kbId: KB })).toEqual({
      reason: "MISSING_ARGUMENT",
      field: "/path",
    });
  });
  it("covers prefix, query length and limit bounds", () => {
    // L-22: one trailing slash is valid; a traversal is not.
    expect(details("knowledge_documents_list", { kbId: KB, prefix: "../notes/" })).toEqual({
      reason: "INVALID_PREFIX",
      field: "/prefix",
    });
    expect(details("knowledge_search", { kbId: KB, query: "q".repeat(1025) })).toMatchObject({
      reason: "QUERY_TOO_LONG",
    });
    expect(details("knowledge_search", { kbId: KB, query: "q", limit: 21 })).toMatchObject({
      reason: "LIMIT_OUT_OF_RANGE",
      field: "/limit",
    });
  });
  it("covers too many changes, reserved names and the delete confirmation", () => {
    const batch = Array.from({ length: 33 }, (_, n) => create(`n${n}.md`));
    expect(details("knowledge_changes_apply", apply(batch))).toEqual({
      reason: "TOO_MANY_CHANGES",
      field: "/changes",
      max: 32,
    });
    const refusal = buildKbErrorCallToolResult(
      "INVALID_ARGUMENT",
      details("knowledge_changes_apply", apply(batch)),
    );
    expect(refusal.structuredContent.error.message).toContain(
      "Each call commits on success: apply the first 32 now",
    );
    expect(kbProtocolErrorSchema.safeParse(refusal.structuredContent.error).success).toBe(true);
    expect(details("knowledge_changes_apply", apply([create("con.md")]))).toEqual({
      reason: "RESERVED_PATH",
      field: "/changes/0/path",
    });
    expect(
      details("knowledge_documents_delete", {
        kbId: KB,
        path: "a.md",
        baseRevision: SHA,
        idempotencyKey: "k".repeat(16),
      }),
    ).toMatchObject({ reason: "CONFIRM_REQUIRED", field: "/confirm" });
  });
  it("maps path, Markdown and whole-tree failures", () => {
    expect(pathIssueReason("PATH_WINDOWS_RESERVED")).toBe("RESERVED_PATH");
    expect(pathIssueReason("PATH_CASE_COLLISION")).toBe("PATH_CASE_COLLISION");
    expect(pathIssueReason("PATH_DOT")).toBe("INVALID_PATH");
    expect(markdownIssueReason("MARKDOWN_YAML")).toBe("INVALID_FRONT_MATTER");
    expect(markdownIssueReason("MARKDOWN_CONTROL")).toBe("CONTROL_CHARACTER");
    const at = (path: string | undefined, key: "path" | "content") =>
      path === "CAPS.md" ? `/changes/1/${key}` : undefined;
    expect(
      treeFailureDetails({ code: "TREE_PATH", path: "CAPS.md", issue: "PATH_CASE_COLLISION" }, at),
    ).toEqual({ reason: "PATH_CASE_COLLISION", field: "/changes/1/path" });
    expect(treeFailureDetails({ code: "TREE_SEALED", path: "CAPS.md" }, at)).toEqual({
      reason: "SEALED_REFERENCE_REVOKED",
      field: "/changes/1/content",
    });
    expect(treeFailureDetails({ code: "TREE_MODE" }, at)).toEqual({ reason: "SCHEMA" });
  });
  it("creating an existing path is a CONFLICT with PATH_EXISTS", () => {
    const error = pathExists("path already exists: index.md", "/changes/0/path");
    expect(error.code).toBe("CONFLICT");
    expect(parseKbErrorDetailsForCode("CONFLICT", error.details)).toEqual({
      reason: "PATH_EXISTS",
      field: "/changes/0/path",
    });
  });
  it("states the bounds a size or range refusal broke, as kb/1 declares them (R3-W9)", () => {
    // Both declared ends, whichever was broken; an unsafe integer too.
    for (const limit of [21, 0, 2 ** 53])
      expect(details("knowledge_search", { kbId: KB, query: "q", limit })).toEqual({
        reason: "LIMIT_OUT_OF_RANGE",
        field: "/limit",
        min: 1,
        max: 20,
      });
    expect(details("knowledge_search", { kbId: KB, query: "q".repeat(1025) })).toEqual({
      reason: "QUERY_TOO_LONG",
      field: "/query",
      min: 1,
      max: 1024,
    });
    expect(
      details("knowledge_bases_create", {
        name: "N",
        slug: "n",
        description: "short",
        idempotencyKey: "k".repeat(16),
      }),
    ).toEqual({ reason: "SCHEMA", field: "/description", min: 10, max: 2000 });
  });
  it("a confirmation of any wrong value or type is CONFIRM_REQUIRED", () => {
    for (const confirm of [null, "RUN", 5])
      expect(
        details("knowledge_documents_delete", {
          kbId: KB,
          path: "a.md",
          baseRevision: SHA,
          idempotencyKey: "k".repeat(16),
          confirm,
        }),
      ).toEqual({ reason: "CONFIRM_REQUIRED", field: "/confirm" });
  });
  it("a bound inside a content union is the value's own branch bound (R4 review)", () => {
    const huge = "a".repeat(131073);
    expect(
      details("knowledge_documents_create", {
        kbId: KB,
        baseRevision: SHA,
        idempotencyKey: "k".repeat(16),
        path: "a.md",
        content: { markdown: huge },
      }),
    ).toEqual({ reason: "TOO_LARGE", field: "/content/markdown", max: 131072 });
    expect(
      details(
        "knowledge_changes_apply",
        apply([{ op: "replace", path: "a.md", content: { markdown: huge } }]),
      ),
    ).toEqual({ reason: "TOO_LARGE", field: "/changes/0/content/markdown", max: 131072 });
  });
  it("selects union branches, missing union fields and bounds from the artifact (R4 review)", () => {
    const input = { kbId: KB, baseRevision: SHA, idempotencyKey: "k".repeat(16), path: "a.md" };
    for (const name of ["knowledge_documents_create", "knowledge_documents_update"] as const) {
      expect(details(name, { ...input, content: { markdown: 1 } })).toEqual({
        reason: "SCHEMA",
        field: "/content/markdown",
      });
      expect(
        details(name, { ...input, content: { markdown: "x".repeat(131073), uploadId: "invalid" } }),
      ).toEqual({ reason: "TOO_LARGE", field: "/content/markdown", max: 131072 });
    }
    expect(
      details(
        "knowledge_changes_apply",
        apply([{ op: "replace", path: "a.md", content: { markdown: 1 } }]),
      ),
    ).toEqual({ reason: "SCHEMA", field: "/changes/0/content/markdown" });
    expect(
      details("knowledge_embedding_profile_set", {
        kbId: KB,
        confirm: "RUN",
        idempotencyKey: "k".repeat(16),
      }),
    ).toEqual({ reason: "MISSING_ARGUMENT", field: "/providerId" });
    expect(
      details("knowledge_pull_requests_create", {
        ...input,
        headBranch: "",
        expectedHeadSha: SHA,
        expectedTargetSha: SHA,
        title: "t",
      }),
    ).toEqual({ reason: "SCHEMA", field: "/headBranch", min: 1, max: 256 });
  });
  it("a wrong type is SCHEMA wherever it is, never a domain reason (R3-L12)", () => {
    for (const [name, input, field] of [
      ["knowledge_search", { kbId: KB, query: "q", limit: "5" }, "/limit"],
      ["knowledge_documents_list", { kbId: KB, prefix: 5 }, "/prefix"],
      ["knowledge_documents_get", { kbId: KB, path: 5 }, "/path"],
      ["knowledge_search", { kbId: KB, query: 5 }, "/query"],
    ] as const)
      expect(details(name, input)).toEqual({ reason: "SCHEMA", field });
  });
  it.each(["short", "?".repeat(20)])(
    "a malformed idempotency key includes its bounds: %s",
    (idempotencyKey) => {
      expect(
        details("knowledge_changes_apply", { ...apply([create("a.md")]), idempotencyKey }),
      ).toEqual({ reason: "SCHEMA", field: "/idempotencyKey", min: 16, max: 128 });
    },
  );
  it("every refinement names the argument it refuses", () => {
    expect(
      details("knowledge_changes_apply", apply([create("a.md"), create("b.md"), create("a.md")])),
    ).toEqual({ reason: "PATH_CASE_COLLISION", field: "/changes/2/path" });
    expect(details("knowledge_changes_apply", apply([create("A.md"), create("a.md")]))).toEqual({
      reason: "PATH_CASE_COLLISION",
      field: "/changes/1/path",
    });
    const id = "0b5b7a3e-1d6c-4c1e-9f39-6f5c2f0d4a11";
    expect(
      details("knowledge_changes_apply", {
        ...apply([create("a.md")]),
        sourceSessionIds: [id, id],
      }),
    ).toEqual({ reason: "SCHEMA", field: "/sourceSessionIds/1" });
  });
  it("a dream with work that omits its sessions is MISSING_ARGUMENT; an empty list is SCHEMA", () => {
    const dream = {
      kbId: KB,
      idempotencyKey: "k".repeat(16),
      mode: "dream",
      baseRevision: SHA,
      title: "Dream",
      changes: [],
      dream: {
        model: { provider: "fixture", model: "fixture" },
        redactionApplied: true,
        upserts: [
          {
            id: "concept",
            type: "concept",
            title: null,
            body: "Alpha dream source",
            citations: [],
            provenance: "dream",
          },
        ],
      },
    };
    expect(details("knowledge_changes_apply", dream)).toEqual({
      reason: "MISSING_ARGUMENT",
      field: "/sourceSessionIds",
    });
    expect(details("knowledge_changes_apply", { ...dream, sourceSessionIds: [] })).toEqual({
      reason: "SCHEMA",
      field: "/sourceSessionIds",
    });
  });
  it("an edit may omit sourceSessionIds", () => {
    const { sourceSessionIds: _omitted, ...edit } = apply([create("a.md")]);
    expect(kbWriteToolSchemas.knowledge_changes_apply.input.safeParse(edit).success).toBe(true);
  });
  it("the KB namespace is reserved for documents, whatever the extension", () => {
    const at = (path: string | undefined) => (path ? "/changes/0/path" : undefined);
    expect(
      treeFailureDetails(
        { code: "TREE_FILE_KIND", path: ".assets/x.md", issue: "PATH_GIT_RESERVED" },
        at,
      ),
    ).toEqual({ reason: "RESERVED_PATH", field: "/changes/0/path" });
    expect(treeFailureDetails({ code: "TREE_FILE_KIND", path: "a.txt" }, at)).toEqual({
      reason: "NOT_MARKDOWN_PATH",
      field: "/changes/0/path",
    });
  });
  it("reasoned conflicts and a missing document stay valid kb/1 details", () => {
    for (const reason of [
      "REVISION_NOT_CURRENT",
      "CONTENT_HASH_MISMATCH",
      "UPLOAD_BYTES_MISMATCH",
      "UPLOAD_NOT_WRITABLE",
    ] as const) {
      const error = reasonedConflict("x", reason, "/revision");
      expect(parseKbErrorDetailsForCode("CONFLICT", error.details)).toEqual({
        reason,
        field: "/revision",
      });
    }
    expect(
      parseKbErrorDetailsForCode("NOT_FOUND", { reason: "PATH_NOT_FOUND", field: "/path" }),
    ).toEqual({ reason: "PATH_NOT_FOUND", field: "/path" });
    expect(() => parseKbErrorDetailsForCode("NOT_FOUND", { reason: "PATH_EXISTS" })).toThrow();
    expect(() =>
      parseKbErrorDetailsForCode("INVALID_ARGUMENT", { reason: "SCHEMA", min: 1.5 }),
    ).toThrow();
  });
  it("pointers carry only identifier and index segments", () => {
    expect(fieldPointer(["changes", 3, "path"])).toBe("/changes/3/path");
    expect(fieldPointer(["a/b"])).toBeUndefined();
    expect(fieldPointer([])).toBeUndefined();
    expect(argumentDetails("SCHEMA", "/../x")).toEqual({ reason: "SCHEMA" });
    expect(() => parseKbErrorDetailsForCode("INVALID_ARGUMENT", { reason: "NOPE" })).toThrow();
    expect(() =>
      parseKbErrorDetailsForCode("INVALID_ARGUMENT", { reason: "SCHEMA", field: "x" }),
    ).toThrow();
    // Reasonless `{}` stays valid; reasons stay code-specific.
    expect(parseKbErrorDetailsForCode("INVALID_ARGUMENT", {})).toEqual({});
    expect(() => parseKbErrorDetailsForCode("NOT_FOUND", { reason: "SCHEMA" })).toThrow();
    expect(z.string().safeParse(1).success).toBe(false);
  });
});
