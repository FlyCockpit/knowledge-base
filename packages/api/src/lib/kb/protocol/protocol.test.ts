import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { casefoldPathKey, normalizeKbPath } from "../paths";
import {
  assertCatalogMatchesSchemas,
  assertDecisionVariantsWellFormed,
  assertForbiddenNamesAbsent,
  assertToolGroupsWellFormed,
  assertWriteToolsRequireMcpWrite,
  KB_TOOL_CATALOG,
  KB_TOOL_GROUPS,
  KB_TOOL_NAMES,
  KB_TOOL_PRESETS,
} from "./catalog";
import {
  applyResultSchema,
  assertToolResponseUtf8Budget,
  citationHitSchema,
  compareIsoUtc,
  documentSchema,
  frontMatterSchema,
  isoSchema,
  MAX_TOOL_RESPONSE_UTF8_BYTES,
  parseIsoUtcParts,
  structuredRowSchema,
  textInputMarkdownSchema,
  textInputSchema,
} from "./common";
import {
  assertMatchingToolTextEnvelope,
  buildKbErrorCallToolResult,
  buildKbSuccessCallToolResult,
  KB_PROTOCOL_ERROR_CODES,
  KB_RETRYABLE_ERROR_CODES,
} from "./envelope";
import { FIXTURE_KB_ID, FIXTURE_KEY, FIXTURE_PATH, FIXTURE_SHA } from "./fixture-data";
import { kbReadToolSchemas } from "./reads";
import { kbWriteToolSchemas } from "./writes";

const PROTOCOL_DIR = dirname(fileURLToPath(import.meta.url));

function loadJson(name: string): unknown {
  return JSON.parse(readFileSync(join(PROTOCOL_DIR, name), "utf8"));
}

function schemaFor(name: string) {
  const read = kbReadToolSchemas[name as keyof typeof kbReadToolSchemas];
  const write = kbWriteToolSchemas[name as keyof typeof kbWriteToolSchemas];
  return read ?? write;
}

const FIXTURE_HASH = "sha256:0000000000000000000000000000000000000000000000000000000000000000";

// ---------------------------------------------------------------------------
// Reference evaluator for the generated artifact: the draft-2020-12 subset the
// generator emits plus the documented x-kb-* portable vocabulary. Proves the
// exported schema alone accepts every valid fixture and rejects every invalid
// one, the same verdict the runtime Zod schemas produce.
// ---------------------------------------------------------------------------

type ArtifactSchema = boolean | Record<string, unknown>;

const BASE64_ALPHABET_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function scalarCount(value: string): number {
  let count = 0;
  for (const _scalar of value) count += 1;
  return count;
}

function jsonDepth(value: unknown): number {
  if (value === null || typeof value !== "object") return 0;
  let max = 0;
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    max = Math.max(max, jsonDepth(child));
  }
  return max + 1;
}

function selectValues(root: unknown, selector: string): unknown[] {
  let current: unknown[] = [root];
  for (const segment of selector.split(".")) {
    const iteratesArray = segment.endsWith("[]");
    const key = iteratesArray ? segment.slice(0, -2) : segment;
    const next: unknown[] = [];
    for (const base of current) {
      if (base === null || typeof base !== "object") continue;
      const value = (base as Record<string, unknown>)[key];
      if (value === undefined) continue;
      if (iteratesArray) {
        if (Array.isArray(value)) next.push(...value);
      } else {
        next.push(value);
      }
    }
    current = next;
  }
  return current;
}

function typeMatches(type: string, value: unknown): boolean {
  switch (type) {
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return false;
  }
}

function validatePortableKeywords(schema: Record<string, unknown>, value: unknown): boolean {
  if (typeof value === "string") {
    if (
      schema["x-kb-metadata-text"] === "name" &&
      Array.from(value).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
    )
      return false;
    if (
      schema["x-kb-metadata-text"] === "description" &&
      Array.from(value).some((c) => {
        const code = c.charCodeAt(0);
        return code === 127 || (code < 32 && code !== 9 && code !== 10 && code !== 13);
      })
    )
      return false;
    const utf8MaxBytes = schema["x-kb-utf8-max-bytes"];
    if (typeof utf8MaxBytes === "number" && new TextEncoder().encode(value).length > utf8MaxBytes) {
      return false;
    }
    if (schema["x-kb-no-control-chars"] === true) {
      for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        if (code < 32 && code !== 9 && code !== 10 && code !== 13) return false;
      }
    }
    const base64 = schema["x-kb-base64-canonical"];
    if (base64 && typeof base64 === "object") {
      const bounds = base64 as { minBytes: number; maxBytes: number };
      if (!BASE64_ALPHABET_RE.test(value) || value.length % 4 !== 0) return false;
      const decoded = Buffer.from(value, "base64");
      if (decoded.toString("base64") !== value) return false;
      if (decoded.length < bounds.minBytes || decoded.length > bounds.maxBytes) return false;
    }
    if (schema["x-kb-path"] === true && !normalizeKbPath(value).ok) return false;
    if (
      schema["x-kb-path-prefix"] === true &&
      !normalizeKbPath(value.endsWith("/") ? value.slice(0, -1) : value).ok
    )
      return false;
    if (schema["x-kb-iso-utc-instant"] === true && parseIsoUtcParts(value) === null) return false;
  }
  if (typeof value === "object" && value !== null) {
    const jsonMaxBytes = schema["x-kb-json-encoded-max-bytes"];
    if (
      typeof jsonMaxBytes === "number" &&
      Buffer.byteLength(JSON.stringify(value), "utf8") > jsonMaxBytes
    ) {
      return false;
    }
    const jsonDepthMax = schema["x-kb-json-depth-max"];
    if (typeof jsonDepthMax === "number" && jsonDepth(value) > jsonDepthMax) return false;
    const isoRange = schema["x-kb-iso-range"];
    if (isoRange && typeof isoRange === "object") {
      const { after, before } = isoRange as { after: string; before: string };
      const afterValues = selectValues(value, after);
      const beforeValues = selectValues(value, before);
      if (afterValues.length > 0 && beforeValues.length > 0) {
        const order = compareIsoUtc(afterValues[0] as string, beforeValues[0] as string);
        if (order !== -1) return false;
      }
    }
    const uniqueItems = schema["x-kb-unique-items"];
    if (Array.isArray(uniqueItems)) {
      for (const selector of uniqueItems) {
        const items = selectValues(value, String(selector));
        if (new Set(items).size !== items.length) return false;
      }
    }
    const changePaths = schema["x-kb-change-paths"];
    if (Array.isArray(changePaths)) {
      for (const selector of changePaths) {
        const named = new Set<string>();
        const written = new Set<string>();
        for (const item of selectValues(value, String(selector))) {
          const { op, path } = item as { op: string; path: string };
          const kind = op === "assetPut" || op === "assetRemove" ? "asset" : "document";
          if (named.has(`${kind}\0${path}`)) return false;
          named.add(`${kind}\0${path}`);
          if (op === "delete" || op === "assetRemove") continue;
          if (written.has(casefoldPathKey(path))) return false;
          written.add(casefoldPathKey(path));
        }
      }
    }
  }
  return true;
}

function validateAgainstArtifact(schema: ArtifactSchema, value: unknown): boolean {
  if (schema === true) return true;
  if (schema === false) return false;

  const type = schema.type;
  if (typeof type === "string" && !typeMatches(type, value)) return false;
  if (Array.isArray(type) && !type.some((candidate) => typeMatches(String(candidate), value))) {
    return false;
  }
  if (!validatePortableKeywords(schema, value)) return false;

  if (schema.enum !== undefined) {
    const match = (schema.enum as unknown[]).some(
      (option) => JSON.stringify(option) === JSON.stringify(value),
    );
    if (!match) return false;
  }
  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value)) {
    return false;
  }

  if (typeof value === "string") {
    const { pattern, minLength, maxLength } = schema as {
      pattern?: string;
      minLength?: number;
      maxLength?: number;
    };
    if (pattern !== undefined && !new RegExp(pattern).test(value)) return false;
    if (minLength !== undefined && scalarCount(value) < minLength) return false;
    if (maxLength !== undefined && scalarCount(value) > maxLength) return false;
  }

  if (typeof value === "number") {
    const { minimum, maximum } = schema as { minimum?: number; maximum?: number };
    if (minimum !== undefined && value < minimum) return false;
    if (maximum !== undefined && value > maximum) return false;
  }

  if (Array.isArray(value)) {
    const { items, minItems, maxItems } = schema as {
      items?: ArtifactSchema;
      minItems?: number;
      maxItems?: number;
    };
    if (items !== undefined) {
      for (const item of value) {
        if (!validateAgainstArtifact(items, item)) return false;
      }
    }
    if (minItems !== undefined && value.length < minItems) return false;
    if (maxItems !== undefined && value.length > maxItems) return false;
  }

  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, ArtifactSchema>;
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (Object.hasOwn(record, key) && !validateAgainstArtifact(propertySchema, record[key]))
        return false;
    }
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!Object.hasOwn(record, key)) return false;
      }
    }
    const additionalProperties = schema.additionalProperties;
    for (const key of Object.keys(record)) {
      if (Object.hasOwn(properties, key)) continue;
      if (additionalProperties === false) return false;
      if (
        additionalProperties !== undefined &&
        additionalProperties !== true &&
        !validateAgainstArtifact(additionalProperties as ArtifactSchema, record[key])
      ) {
        return false;
      }
    }
    if (schema.propertyNames !== undefined) {
      for (const key of Object.keys(record)) {
        if (!validateAgainstArtifact(schema.propertyNames as ArtifactSchema, key)) return false;
      }
    }
  }

  if (
    Array.isArray(schema.anyOf) &&
    !schema.anyOf.some((option) => validateAgainstArtifact(option as ArtifactSchema, value))
  ) {
    return false;
  }
  if (
    Array.isArray(schema.allOf) &&
    !schema.allOf.every((option) => validateAgainstArtifact(option as ArtifactSchema, value))
  ) {
    return false;
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((option) =>
      validateAgainstArtifact(option as ArtifactSchema, value),
    );
    if (matches.length !== 1) return false;
  }
  if (schema.not !== undefined && validateAgainstArtifact(schema.not as ArtifactSchema, value)) {
    return false;
  }
  if (schema.if !== undefined) {
    const conditionHolds = validateAgainstArtifact(schema.if as ArtifactSchema, value);
    if (conditionHolds && schema.then !== undefined) {
      if (!validateAgainstArtifact(schema.then as ArtifactSchema, value)) return false;
    }
    if (!conditionHolds && schema.else !== undefined) {
      if (!validateAgainstArtifact(schema.else as ArtifactSchema, value)) return false;
    }
  }

  return true;
}

function artifactTools() {
  return (
    loadJson("schema.json") as {
      tools: Record<string, { input: Record<string, unknown>; output: Record<string, unknown> }>;
    }
  ).tools;
}

function fixtures() {
  return loadJson("fixtures.json") as {
    tools: Record<
      string,
      {
        validInput: unknown;
        validOutput: unknown;
        invalidInputs: { label: string; value: unknown }[];
        validInputVariants: { label: string; value: unknown }[];
        validOutputVariants: { label: string; value: unknown }[];
        invalidOutputs: { label: string; value: unknown }[];
      }
    >;
  };
}

describe("kb/1 protocol catalog", () => {
  it("every content publication accepts an optional positive proposal number", () => {
    const corpus = fixtures();
    const contentTools = Object.entries(kbWriteToolSchemas).filter(
      ([, schemas]) => schemas.output === applyResultSchema,
    );
    expect(contentTools.map(([name]) => name).sort()).toEqual([
      "knowledge_assets_import",
      "knowledge_assets_put",
      "knowledge_changes_apply",
      "knowledge_documents_create",
      "knowledge_documents_delete",
      "knowledge_documents_update",
    ]);
    for (const [name, schemas] of contentTools) {
      const input = corpus.tools[name].validInput as Record<string, unknown>;
      expect(schemas.input.parse({ ...input, proposalNumber: 7 }), name).toMatchObject({
        proposalNumber: 7,
      });
      expect(schemas.input.safeParse(input).success, name).toBe(true);
      for (const proposalNumber of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, null, "7"]) {
        expect(schemas.input.safeParse({ ...input, proposalNumber }).success, name).toBe(false);
      }
    }
  });

  it("matches explicit CONTRACT tool enumeration", () => {
    assertCatalogMatchesSchemas();
    assertForbiddenNamesAbsent();
    assertWriteToolsRequireMcpWrite();
    assertDecisionVariantsWellFormed();
    assertToolGroupsWellFormed();
    const schemaTools = Object.keys(
      (loadJson("schema.json") as { tools: Record<string, unknown> }).tools,
    ).sort();
    expect([...KB_TOOL_NAMES].sort()).toEqual(schemaTools);
    expect(new Set(KB_TOOL_NAMES).size).toBe(KB_TOOL_NAMES.length);
  });

  it("assigns every tool its groups and copies them into schema.json", () => {
    const expected: Record<string, readonly string[]> = {
      read: [
        "knowledge_documents_list",
        "knowledge_documents_get",
        "knowledge_search",
        "knowledge_structured_search",
      ],
      edit: [
        "knowledge_changes_apply",
        "knowledge_documents_create",
        "knowledge_documents_update",
        "knowledge_documents_delete",
        "knowledge_upload_begin",
        "knowledge_upload_write",
        "knowledge_upload_finish",
      ],
      assets: [
        "knowledge_upload_begin",
        "knowledge_upload_write",
        "knowledge_upload_finish",
        "knowledge_assets_put",
        "knowledge_assets_import",
        "knowledge_assets_list",
      ],
      export: ["knowledge_export_prepare", "knowledge_transfer_read", "knowledge_export_complete"],
      pull_requests: [
        "knowledge_pull_requests_list",
        "knowledge_pull_requests_get",
        "knowledge_pull_requests_create",
        "knowledge_pull_requests_review",
      ],
      index_admin: [
        "knowledge_index_status",
        "knowledge_index_rebuild",
        "knowledge_embedding_profile_get",
        "knowledge_embedding_profile_set",
      ],
      kb_admin: ["knowledge_bases_create", "knowledge_bases_update", "knowledge_bases_delete"],
      sealed: ["knowledge_sealed_resolve"],
    };
    expect(Object.keys(expected)).toEqual([...KB_TOOL_GROUPS]);
    for (const group of KB_TOOL_GROUPS) {
      expect(KB_TOOL_NAMES.filter((name) => KB_TOOL_CATALOG[name].groups.includes(group))).toEqual(
        expected[group],
      );
    }
    expect(KB_TOOL_NAMES.filter((name) => KB_TOOL_CATALOG[name].groups.length === 0)).toEqual([
      "knowledge_bases_list",
      "knowledge_bases_get",
    ]);
    const artifact = loadJson("schema.json") as {
      tools: Record<string, { catalog: { groups: unknown } }>;
    };
    for (const name of KB_TOOL_NAMES) {
      expect(artifact.tools[name]?.catalog.groups).toEqual(KB_TOOL_CATALOG[name].groups);
    }
  });

  it("carries the group order and presets the CLI's local --tools flag reads", () => {
    const artifact = loadJson("schema.json") as {
      toolGroups: unknown;
      toolPresets: Record<string, unknown>;
    };
    expect(artifact.toolGroups).toEqual([...KB_TOOL_GROUPS]);
    expect(Object.keys(artifact.toolPresets).sort()).toEqual(Object.keys(KB_TOOL_PRESETS).sort());
    for (const [preset, groups] of Object.entries(KB_TOOL_PRESETS)) {
      expect(artifact.toolPresets[preset]).toEqual(
        KB_TOOL_GROUPS.filter((group) => (groups as readonly string[]).includes(group)),
      );
    }
  });

  it("records decision-dependent review authority and confirm", () => {
    const expectedVariants = [
      {
        decision: "merge",
        minimumAccess: { kind: "permission", bit: "review" },
        confirm: "MERGE",
      },
      {
        decision: "close",
        minimumAccess: {
          kind: "any_of",
          of: [{ kind: "permission", bit: "review" }, { kind: "author_with_propose" }],
        },
        confirm: "CLOSE",
      },
    ];
    const entry = KB_TOOL_CATALOG.knowledge_pull_requests_review;
    expect(entry.confirm).toBeUndefined();
    expect(entry.decisionVariants).toEqual(expectedVariants);
    expect(entry.minimumAccess).toEqual({
      kind: "any_of",
      of: [{ kind: "permission", bit: "review" }, { kind: "author_with_propose" }],
    });
    const artifactCatalog = (
      loadJson("schema.json") as {
        tools: Record<string, { catalog: Record<string, unknown> }>;
      }
    ).tools.knowledge_pull_requests_review.catalog;
    expect(artifactCatalog).toEqual(
      expect.objectContaining({ decisionVariants: expectedVariants }),
    );
    expect(artifactCatalog.confirm).toBeUndefined();
  });

  it("accepts the contract-valid close decision with CLOSE confirm", () => {
    const value = {
      kbId: FIXTURE_KB_ID,
      number: 1,
      decision: "close",
      expectedHeadSha: FIXTURE_SHA,
      expectedTargetSha: FIXTURE_SHA,
      idempotencyKey: FIXTURE_KEY,
      confirm: "CLOSE",
    };
    expect(kbWriteToolSchemas.knowledge_pull_requests_review.input.safeParse(value).success).toBe(
      true,
    );
    expect(
      validateAgainstArtifact(artifactTools().knowledge_pull_requests_review.input, value),
    ).toBe(true);
  });

  it("emits closed validating JSON Schema artifacts", () => {
    const raw = readFileSync(join(PROTOCOL_DIR, "schema.json"), "utf8");
    expect(raw).not.toContain("unsupported:");
    const artifact = loadJson("schema.json") as {
      tools: Record<string, { input: Record<string, unknown>; output: Record<string, unknown> }>;
    };
    for (const name of KB_TOOL_NAMES) {
      const row = artifact.tools[name];
      expect(row?.input.type, `${name}.input`).toBe("object");
      expect(row?.output.type, `${name}.output`).toBe("object");
      expect(row?.input.additionalProperties, `${name}.input`).toBe(false);
      expect(row?.output.additionalProperties, `${name}.output`).toBe(false);
    }
  });

  it("L-22: path prefixes accept one trailing slash and keep it", () => {
    const list = kbReadToolSchemas.knowledge_documents_list.input;
    expect(list.parse({ kbId: FIXTURE_KB_ID, prefix: "notes/" }).prefix).toBe("notes/");
    expect(list.parse({ kbId: FIXTURE_KB_ID, prefix: "notes" }).prefix).toBe("notes");
    for (const bad of ["notes//", "/", "../x/", ""])
      expect(list.safeParse({ kbId: FIXTURE_KB_ID, prefix: bad }).success).toBe(false);
    const search = kbReadToolSchemas.knowledge_search.input;
    expect(search.safeParse({ kbId: FIXTURE_KB_ID, query: "q", pathPrefix: "a/b/" }).success).toBe(
      true,
    );
  });
  it("rejects write tools tagged mcp:read only", () => {
    for (const name of KB_TOOL_NAMES) {
      const entry = (
        loadJson("schema.json") as {
          tools: Record<string, { catalog: { readOnly: boolean; requiredMcpScope: string } }>;
        }
      ).tools[name];
      if (!entry.catalog.readOnly) {
        expect(entry.catalog.requiredMcpScope).toBe("mcp:write");
      }
    }
  });
});

describe("kb/1 fixtures corpus", () => {
  it("covers every catalog row with valid and invalid samples", () => {
    const corpus = fixtures();
    for (const name of KB_TOOL_NAMES) {
      const row = corpus.tools[name];
      expect(row, name).toBeDefined();
      const schemas = schemaFor(name);
      expect(schemas.input.safeParse(row.validInput).success).toBe(true);
      expect(schemas.output.safeParse(row.validOutput).success).toBe(true);
      for (const invalid of row.invalidInputs) {
        expect(schemas.input.safeParse(invalid.value).success, `${name}:${invalid.label}`).toBe(
          false,
        );
      }
      for (const variant of row.validInputVariants) {
        expect(schemas.input.safeParse(variant.value).success, `${name}:${variant.label}`).toBe(
          true,
        );
      }
      for (const variant of row.validOutputVariants) {
        expect(schemas.output.safeParse(variant.value).success, `${name}:${variant.label}`).toBe(
          true,
        );
      }
      for (const invalid of row.invalidOutputs) {
        expect(schemas.output.safeParse(invalid.value).success, `${name}:${invalid.label}`).toBe(
          false,
        );
      }
    }
  });

  it("carries shared conformance cases for nulls, numbers, timestamps, base64 and caps", () => {
    const corpus = fixtures();
    const labels = (name: string) => corpus.tools[name].invalidInputs.map((entry) => entry.label);
    expect(labels("knowledge_transfer_read")).toEqual(
      expect.arrayContaining(["unsafe-offset", "fractional-offset"]),
    );
    expect(labels("knowledge_structured_search")).toEqual(
      expect.arrayContaining(["impossible-calendar-date", "equal-timestamps"]),
    );
    expect(labels("knowledge_upload_write")).toEqual(
      expect.arrayContaining(["non-canonical-padding-bits", "missing-padding"]),
    );
    expect(labels("knowledge_changes_apply")).toContain("dream-body-over-64kib-utf8");
    expect(labels("knowledge_documents_get")).toContain("null-optional-rev");
    for (const name of KB_TOOL_NAMES) {
      expect(
        corpus.tools[name].invalidOutputs.some((entry) => entry.label === "unknown-field"),
        name,
      ).toBe(true);
    }
  });

  it("contains no secret-like fixture strings", () => {
    const raw = readFileSync(join(PROTOCOL_DIR, "fixtures.json"), "utf8");
    expect(raw.toLowerCase()).not.toMatch(/sk-[a-z0-9]{10,}/);
    expect(raw).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{20,}/);
  });
});

describe("kb/1 envelope", () => {
  it("mirrors structuredContent in text for success and error", () => {
    const success = buildKbSuccessCallToolResult({ ok: true });
    assertMatchingToolTextEnvelope(success);
    const failure = buildKbErrorCallToolResult("RATE_LIMITED", { retryAfterSeconds: 5 });
    assertMatchingToolTextEnvelope(failure);
  });

  it("uses kb/1 discriminator and fixed retryability set", () => {
    for (const code of KB_PROTOCOL_ERROR_CODES) {
      const result = buildKbErrorCallToolResult(code);
      expect(result.structuredContent.schemaVersion).toBe("kb/1");
      expect(result.structuredContent.error.retryable).toBe(KB_RETRYABLE_ERROR_CODES.has(code));
    }
  });

  it("rejects encoded responses above 8 MiB before emission", () => {
    const huge = "x".repeat(MAX_TOOL_RESPONSE_UTF8_BYTES);
    expect(() => buildKbSuccessCallToolResult({ blob: huge })).toThrow(/encoded size budget/);
  });

  it("counts duplicated JSON text in the MCP payload budget", () => {
    const quotes = '"'.repeat(1_500_000);
    expect(() => buildKbSuccessCallToolResult({ markdown: quotes })).toThrow(/encoded size budget/);
  });

  it("rejects undocumented error details before emission", () => {
    expect(() =>
      buildKbErrorCallToolResult("INTERNAL", { privateException: "SYNTHETIC_PRIVATE_DATA" }),
    ).toThrow(/invalid kb protocol error details/);
  });
});

describe("TextInput", () => {
  it("accepts inline markdown or staged upload id exclusively", () => {
    expect(textInputSchema.safeParse({ markdown: "# ok\n" }).success).toBe(true);
    expect(
      textInputSchema.safeParse({ uploadId: "00000000-0000-4000-8000-000000000001" }).success,
    ).toBe(true);
    expect(
      textInputSchema.safeParse({
        markdown: "# x",
        uploadId: "00000000-0000-4000-8000-000000000001",
      }).success,
    ).toBe(false);
  });

  it("rejects markdown above 128 KiB UTF-8", () => {
    const big = "a".repeat(128 * 1024 + 1);
    expect(textInputMarkdownSchema.safeParse({ markdown: big }).success).toBe(false);
  });
});

describe("nullable output keys", () => {
  it("requires explicit nulls on nullable fields", () => {
    const parsed = kbReadToolSchemas.knowledge_bases_get.output.safeParse({
      kb: {
        id: "abcdefghijklmnopqrstuvwx",
        name: "n",
        slug: "n",
        description: "1234567890",
        defaultBranch: "main",
        headSha: "0000000000000000000000000000000000000000",
        metadataVersion: 1,
        capabilities: ["read"],
        writeMode: "direct",
        embeddingGeneration: null,
        attachmentLocator:
          "kb-local://00000000-0000-4000-8000-000000000001/abcdefghijklmnopqrstuvwx",
        sealedNamespace: "00000000-0000-4000-8000-000000000001",
      },
      index: {
        activeGenerationId: null,
        desiredGenerationId: null,
        desiredEpoch: "",
        activeState: null,
        desiredState: "PENDING",
        indexedCommitSha: null,
        headSha: "0000000000000000000000000000000000000000",
        dimensions: null,
        fingerprint: null,
        freshness: "unavailable",
        errorCode: null,
        rebuildPending: null,
      },
    });
    expect(parsed.success).toBe(true);
    const omitted = kbReadToolSchemas.knowledge_bases_get.output.safeParse({
      kb: {
        id: "abcdefghijklmnopqrstuvwx",
        name: "n",
        slug: "n",
        description: "1234567890",
        defaultBranch: "main",
        headSha: "0000000000000000000000000000000000000000",
        metadataVersion: 1,
        capabilities: ["read"],
        writeMode: "direct",
        attachmentLocator:
          "kb-local://00000000-0000-4000-8000-000000000001/abcdefghijklmnopqrstuvwx",
        sealedNamespace: "00000000-0000-4000-8000-000000000001",
      },
      index: {
        activeGenerationId: null,
        desiredGenerationId: null,
        desiredEpoch: "",
        activeState: null,
        desiredState: "PENDING",
        indexedCommitSha: null,
        headSha: "0000000000000000000000000000000000000000",
        dimensions: null,
        fingerprint: null,
        freshness: "unavailable",
        errorCode: null,
      },
    });
    expect(omitted.success).toBe(false);
  });
});

describe("response budget helper", () => {
  it("passes for small payloads", () => {
    expect(() =>
      assertToolResponseUtf8Budget(buildKbSuccessCallToolResult({ ok: true })),
    ).not.toThrow();
  });
});

describe("iso and document byte limits", () => {
  it("rejects impossible calendar values", () => {
    expect(isoSchema.safeParse("2026-99-99T99:99:99Z").success).toBe(false);
  });

  it("rejects document markdown above 2 MiB UTF-8", () => {
    const markdown = "é".repeat(1_100_000);
    expect(
      documentSchema.safeParse({
        path: "docs/x.md",
        documentId: null,
        markdown,
        frontMatter: {},
        commitSha: "0000000000000000000000000000000000000000",
        blobSha: "0000000000000000000000000000000000000000",
        contentHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        documentCitations: [],
        assetRefs: [],
      }).success,
    ).toBe(false);
  });
});

describe("structured search timestamps", () => {
  it("accepts subsecond ranges that are not lexicographically ordered", () => {
    const parsed = kbReadToolSchemas.knowledge_structured_search.input.safeParse({
      kbId: "abcdefghijklmnopqrstuvwx",
      timestamp: { after: "2026-01-01T00:00:00Z", before: "2026-01-01T00:00:00.500Z" },
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts ranges separated below millisecond precision", () => {
    const parsed = kbReadToolSchemas.knowledge_structured_search.input.safeParse({
      kbId: "abcdefghijklmnopqrstuvwx",
      timestamp: {
        after: "2026-01-01T00:00:00.000001Z",
        before: "2026-01-01T00:00:00.000002Z",
      },
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects ranges inverted below millisecond precision", () => {
    const parsed = kbReadToolSchemas.knowledge_structured_search.input.safeParse({
      kbId: "abcdefghijklmnopqrstuvwx",
      timestamp: {
        after: "2026-01-01T00:00:00.000002Z",
        before: "2026-01-01T00:00:00.000001Z",
      },
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects equal instants written at different precisions", () => {
    const parsed = kbReadToolSchemas.knowledge_structured_search.input.safeParse({
      kbId: "abcdefghijklmnopqrstuvwx",
      timestamp: { after: "2026-01-01T00:00:00Z", before: "2026-01-01T00:00:00.000Z" },
    });
    expect(parsed.success).toBe(false);
  });
});

describe("CitationHit snippet counts Unicode scalar values", () => {
  const hitWith = (snippet: string) => ({
    knowledgeBaseId: FIXTURE_KB_ID,
    knowledgeBaseName: "Fixture knowledge base",
    path: FIXTURE_PATH,
    documentId: null,
    commitSha: FIXTURE_SHA,
    blobSha: FIXTURE_SHA,
    contentHash: FIXTURE_HASH,
    chunkIndex: 0,
    span: { startToken: 0, endToken: 1, startByte: 0, endByte: 1 },
    snippet,
    score: 1.5,
    mode: "hybrid" as const,
    indexGenerationId: FIXTURE_KB_ID,
    freshness: "current" as const,
    documentCitations: [],
    assetRefs: [],
    matchedRow: null,
  });

  it("accepts 240 supplementary-plane scalars", () => {
    expect(citationHitSchema.safeParse(hitWith("😀".repeat(240))).success).toBe(true);
  });

  it("rejects 241 supplementary-plane scalars", () => {
    expect(citationHitSchema.safeParse(hitWith("😀".repeat(241))).success).toBe(false);
  });

  it("rejects unpaired surrogates", () => {
    expect(citationHitSchema.safeParse(hitWith("\uD800")).success).toBe(false);
  });
});

describe("bounded strings count Unicode scalar values in runtime and artifact", () => {
  const createInput = (overrides: Record<string, unknown>) => ({
    name: "New KB",
    slug: "new-kb",
    description: "Synthetic create fixture for protocol corpus.",
    idempotencyKey: FIXTURE_KEY,
    ...overrides,
  });
  const artifactInput = () => artifactTools().knowledge_bases_create.input;

  it("rejects a description below minLength in runtime and artifact", () => {
    const value = createInput({ description: "😀".repeat(5) });
    expect(kbWriteToolSchemas.knowledge_bases_create.input.safeParse(value).success).toBe(false);
    expect(validateAgainstArtifact(artifactInput(), value)).toBe(false);
  });

  it("accepts 120 supplementary-plane scalars as a name in runtime and artifact", () => {
    const value = createInput({ name: "😀".repeat(120) });
    expect(kbWriteToolSchemas.knowledge_bases_create.input.safeParse(value).success).toBe(true);
    expect(validateAgainstArtifact(artifactInput(), value)).toBe(true);
  });

  it("rejects 121 supplementary-plane scalars as a name in runtime and artifact", () => {
    const value = createInput({ name: "😀".repeat(121) });
    expect(kbWriteToolSchemas.knowledge_bases_create.input.safeParse(value).success).toBe(false);
    expect(validateAgainstArtifact(artifactInput(), value)).toBe(false);
  });

  it("rejects unpaired surrogates at runtime", () => {
    const value = createInput({ name: "a\uD800b" });
    expect(kbWriteToolSchemas.knowledge_bases_create.input.safeParse(value).success).toBe(false);
  });
});

describe("PrDetail page bounds", () => {
  const outputWith = (files: unknown[]) => ({
    ...(fixtures().tools.knowledge_pull_requests_get.validOutput as Record<string, unknown>),
    files,
  });
  const deltas = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      path: `docs/file-${index}.md`,
      status: "modified",
      beforeBlobSha: FIXTURE_SHA,
      afterBlobSha: FIXTURE_SHA,
    }));

  it("caps file deltas and touched assets at 200 per page in the artifact", () => {
    const properties = artifactTools().knowledge_pull_requests_get.output.properties as Record<
      string,
      { maxItems?: number }
    >;
    expect(properties.files.maxItems).toBe(200);
    expect(properties.touchedAssets.maxItems).toBe(200);
  });

  it("accepts 200 file deltas and rejects 201 in runtime and artifact", () => {
    const schema = kbReadToolSchemas.knowledge_pull_requests_get.output;
    const artifactOutput = artifactTools().knowledge_pull_requests_get.output;
    expect(schema.safeParse(outputWith(deltas(200))).success).toBe(true);
    expect(validateAgainstArtifact(artifactOutput, outputWith(deltas(200)))).toBe(true);
    expect(schema.safeParse(outputWith(deltas(201))).success).toBe(false);
    expect(validateAgainstArtifact(artifactOutput, outputWith(deltas(201)))).toBe(false);
  });
});

describe("kb/1 artifact validation contract", () => {
  it("documents every portable keyword used by the artifact", () => {
    const artifact = loadJson("schema.json") as {
      validationContract: { keywords: Record<string, unknown> };
      tools: unknown;
    };
    const documented = new Set(Object.keys(artifact.validationContract.keywords));
    const used = new Set<string>();
    const collect = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const item of node) collect(item);
        return;
      }
      if (typeof node !== "object" || node === null) return;
      for (const [key, value] of Object.entries(node)) {
        if (key.startsWith("x-kb-")) used.add(key);
        collect(value);
      }
    };
    collect(artifact.tools);
    expect([...used].every((keyword) => documented.has(keyword))).toBe(true);
    expect([...documented].every((keyword) => used.has(keyword))).toBe(true);
  });

  it("agrees with the runtime Zod verdicts on the whole fixture corpus", () => {
    const tools = artifactTools();
    const corpus = fixtures();
    for (const name of KB_TOOL_NAMES) {
      const row = corpus.tools[name];
      expect(validateAgainstArtifact(tools[name].input, row.validInput), `${name}.input`).toBe(
        true,
      );
      expect(validateAgainstArtifact(tools[name].output, row.validOutput), `${name}.output`).toBe(
        true,
      );
      for (const invalid of row.invalidInputs) {
        expect(
          validateAgainstArtifact(tools[name].input, invalid.value),
          `${name}:${invalid.label}`,
        ).toBe(false);
      }
      for (const variant of row.validInputVariants) {
        expect(
          validateAgainstArtifact(tools[name].input, variant.value),
          `${name}:${variant.label}`,
        ).toBe(true);
      }
      for (const variant of row.validOutputVariants) {
        expect(
          validateAgainstArtifact(tools[name].output, variant.value),
          `${name}:${variant.label}`,
        ).toBe(true);
      }
      for (const invalid of row.invalidOutputs) {
        expect(
          validateAgainstArtifact(tools[name].output, invalid.value),
          `${name}:${invalid.label}`,
        ).toBe(false);
      }
    }
  });

  it("rejects the shared invalid corpus through representable constraints alone", () => {
    const tools = artifactTools();
    const corpus = fixtures();
    const stripPortable = (node: unknown): unknown => {
      if (Array.isArray(node)) return node.map(stripPortable);
      if (typeof node !== "object" || node === null) return node;
      const stripped: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node)) {
        if (key.startsWith("x-kb-")) continue;
        stripped[key] = stripPortable(value);
      }
      return stripped;
    };
    const representableOnly = new Set([
      "knowledge_bases_update:no-fields",
      "knowledge_changes_apply:empty-edit",
      "knowledge_pull_requests_review:bad-confirm",
      "knowledge_structured_search:empty-filters",
    ]);
    for (const key of representableOnly) {
      const [name, label] = key.split(":");
      const invalid = corpus.tools[name].invalidInputs.find((entry) => entry.label === label);
      expect(invalid, key).toBeDefined();
      const plainSchema = stripPortable(tools[name].input) as Record<string, unknown>;
      expect(validateAgainstArtifact(plainSchema, invalid?.value), key).toBe(false);
    }
  });

  it("enforces the exported UTF-8 byte bound on document markdown", () => {
    const tools = artifactTools();
    const valid = fixtures().tools.knowledge_documents_get.validOutput;
    const oversized = { ...valid, markdown: "é".repeat(1024 * 1024 + 1) };
    expect(validateAgainstArtifact(tools.knowledge_documents_get.output, valid)).toBe(true);
    expect(validateAgainstArtifact(tools.knowledge_documents_get.output, oversized)).toBe(false);
  });

  it("counts Unicode scalar values for snippet maxLength in the artifact", () => {
    const tools = artifactTools();
    const searchOutput = tools.knowledge_search.output;
    const hitWith = (snippet: string) => ({
      results: [
        {
          knowledgeBaseId: FIXTURE_KB_ID,
          knowledgeBaseName: "Fixture knowledge base",
          path: FIXTURE_PATH,
          documentId: null,
          commitSha: FIXTURE_SHA,
          blobSha: FIXTURE_SHA,
          contentHash: FIXTURE_HASH,
          chunkIndex: 0,
          span: { startToken: 0, endToken: 1, startByte: 0, endByte: 1 },
          snippet,
          score: 1.5,
          mode: "hybrid",
          indexGenerationId: FIXTURE_KB_ID,
          freshness: "current",
          documentCitations: [],
          assetRefs: [],
          matchedRow: null,
        },
      ],
      generationId: FIXTURE_KB_ID,
      freshness: "current",
      indexedCommitSha: FIXTURE_SHA,
      headSha: FIXTURE_SHA,
      indexNotices: [],
    });
    expect(validateAgainstArtifact(searchOutput, hitWith("😀".repeat(240)))).toBe(true);
    expect(validateAgainstArtifact(searchOutput, hitWith("😀".repeat(241)))).toBe(false);
  });

  it("enforces the portable iso range ordering the runtime rejects", () => {
    const tools = artifactTools();
    const input = tools.knowledge_structured_search.input;
    expect(
      validateAgainstArtifact(input, {
        kbId: FIXTURE_KB_ID,
        timestamp: {
          after: "2026-01-01T00:00:00.000001Z",
          before: "2026-01-01T00:00:00.000002Z",
        },
      }),
    ).toBe(true);
    expect(
      validateAgainstArtifact(input, {
        kbId: FIXTURE_KB_ID,
        timestamp: {
          after: "2026-01-01T00:00:00.000002Z",
          before: "2026-01-01T00:00:00.000001Z",
        },
      }),
    ).toBe(false);
  });

  it("compares validated instants exactly at the accepted precision", () => {
    expect(compareIsoUtc("2026-01-01T00:00:00.000001Z", "2026-01-01T00:00:00.000002Z")).toBe(-1);
    expect(compareIsoUtc("2026-01-01T00:00:00Z", "2026-01-01T00:00:00.000Z")).toBe(0);
    expect(compareIsoUtc("2026-01-01T00:00:00.500Z", "2026-01-01T00:00:00.5Z")).toBe(0);
    expect(compareIsoUtc("2026-01-01T00:00:00.1Z", "2026-01-01T00:00:00.02Z")).toBe(1);
  });
});

describe("sealed shared wire vector", () => {
  it("uses a decryptable envelope in the generated cross-backend corpus", async () => {
    const { default: sealed } = await import("../fixtures/sealed.json");
    expect(fixtures().tools.knowledge_sealed_resolve.validOutput).toEqual(sealed.result);
  });
});

describe("search index notices", () => {
  const base = {
    results: [],
    generationId: FIXTURE_KB_ID,
    freshness: "current" as const,
    indexedCommitSha: FIXTURE_SHA,
    headSha: FIXTURE_SHA,
  };
  const notice = {
    kbId: FIXTURE_KB_ID,
    code: "EMBEDDING_REBUILD_PENDING" as const,
    detail: "EMBEDDING_SETTINGS_CHANGED" as const,
  };
  const search = kbReadToolSchemas.knowledge_search.output;
  const structured = kbReadToolSchemas.knowledge_structured_search.output;

  it("both search outputs require a machine-readable indexNotices array", () => {
    expect(search.safeParse(base).success).toBe(false);
    expect(search.safeParse({ ...base, indexNotices: [] }).success).toBe(true);
    expect(search.safeParse({ ...base, indexNotices: [notice] }).success).toBe(true);
    const { results: _results, ...rest } = base;
    expect(
      structured.safeParse({ ...rest, items: [], nextCursor: null, indexNotices: [notice] })
        .success,
    ).toBe(true);
    expect(structured.safeParse({ ...rest, items: [], nextCursor: null }).success).toBe(false);
  });

  it("rejects unknown codes, unknown details and extra fields", () => {
    for (const bad of [
      { ...notice, code: "OTHER" },
      { ...notice, detail: "SOMETHING" },
      { ...notice, extra: true },
    ])
      expect(search.safeParse({ ...base, indexNotices: [bad] }).success).toBe(false);
  });
});

describe("open JSON dictionaries", () => {
  it("retains and validates every own reserved key on repeated parse and JSON round-trip", () => {
    const input = Object.fromEntries([
      ["__proto__", "present"],
      ["constructor", "ctor"],
      ["prototype", "proto"],
    ]);
    for (const schema of [frontMatterSchema, structuredRowSchema]) {
      const output = schema.parse(schema.parse(JSON.parse(JSON.stringify(input))));
      expect(Object.keys(output)).toEqual(Object.keys(input));
      expect(Object.hasOwn(output, "__proto__")).toBe(true);
      expect(JSON.stringify(output)).toBe(JSON.stringify(input));
      expect(Object.getPrototypeOf(output)).toBe(Object.prototype);
    }
    expect(
      structuredRowSchema.safeParse(Object.fromEntries([["__proto__", { bad: true }]])).success,
    ).toBe(false);
    expect(
      structuredRowSchema.safeParse(Object.fromEntries([["__proto__", "x".repeat(1025)]])).success,
    ).toBe(false);
    expect(structuredRowSchema.safeParse([]).success).toBe(false);
  });
});
