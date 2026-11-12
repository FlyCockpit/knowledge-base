import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sealedVector from "../packages/api/src/lib/kb/fixtures/sealed.json" with { type: "json" };
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
} from "../packages/api/src/lib/kb/protocol/catalog.js";
import {
  BUILTIN_PROVIDER_REF,
  KB_PROTOCOL_VERSION,
} from "../packages/api/src/lib/kb/protocol/common.js";
import {
  FIXTURE_INDEX_STATUS,
  FIXTURE_KB_ATTACHMENT,
  FIXTURE_KB_ID,
  FIXTURE_KEY,
  FIXTURE_PATH,
  FIXTURE_SHA,
  FIXTURE_UUID,
} from "../packages/api/src/lib/kb/protocol/fixture-data.js";
import { kbReadToolSchemas } from "../packages/api/src/lib/kb/protocol/reads.js";
import { kbWriteToolSchemas } from "../packages/api/src/lib/kb/protocol/writes.js";
import { stableStringify, zodToJsonSchema } from "./lib/zod-json-schema.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROTOCOL_DIR = join(ROOT, "packages/api/src/lib/kb/protocol");

// Resolve from the server workspace so this is exactly its pinned SDK, without
// adding an SDK dependency to the root or mirroring any metadata field names.
const sdk = createRequire(join(ROOT, "apps/server/package.json"))(
  "@modelcontextprotocol/server",
) as {
  specTypeSchemas: {
    RequestMeta: {
      "~standard": {
        jsonSchema: { input(options: { target: "draft-2020-12" }): Record<string, unknown> };
        validate(value: unknown): { issues?: readonly unknown[] };
      };
    };
  };
};
const requestMeta = sdk.specTypeSchemas.RequestMeta["~standard"];

export type KbProtocolArtifacts = {
  schemaVersion: typeof KB_PROTOCOL_VERSION;
  validationContract: typeof KB_VALIDATION_CONTRACT;
  builtinProvider: typeof BUILTIN_PROVIDER_REF;
  requestMeta: Record<string, unknown>;
  /** Every tool group, in canonical order (the closed set grants hold). */
  toolGroups: readonly string[];
  /** Preset name -> its groups, in canonical order. */
  toolPresets: Record<string, readonly string[]>;
  tools: Record<
    string,
    {
      catalog: (typeof KB_TOOL_CATALOG)[keyof typeof KB_TOOL_CATALOG];
      input: ReturnType<typeof zodToJsonSchema>;
      output: ReturnType<typeof zodToJsonSchema>;
    }
  >;
};

export type KbFixtureCorpus = {
  requestMetadata: { label: string; value: unknown; valid: boolean }[];
  schemaVersion: typeof KB_PROTOCOL_VERSION;
  tools: Record<
    string,
    {
      validInput: unknown;
      validOutput: unknown;
      invalidInputs: { label: string; value: unknown }[];
      /** Extra accepted inputs at contract boundaries (every consumer must accept them). */
      validInputVariants: { label: string; value: unknown }[];
      /** Extra accepted outputs (e.g. populated citation spans) for round-trip parity. */
      validOutputVariants: { label: string; value: unknown }[];
      /** Outputs every consumer must reject (absent nullable keys, unsafe numbers, ...). */
      invalidOutputs: { label: string; value: unknown }[];
    }
  >;
};

type FixtureRow = {
  validInput: unknown;
  validOutput: unknown;
  invalidInputs: { label: string; value: unknown }[];
};

/**
 * Portable validation contract for the generated artifact. Standard JSON
 * Schema keywords are enforceable by any draft-2020-12 validator; every
 * `x-kb-*` keyword documents a rule those validators cannot express, and
 * consumers of the artifact (including the later Rust client) MUST enforce
 * them. Generation fails when a keyword is used without being defined here,
 * or documented without being used.
 */
const KB_VALIDATION_CONTRACT = {
  dialect: "https://json-schema.org/draft/2020-12/schema",
  stringLengthUnits: "unicode-scalar-values",
  stringLengthNote:
    "minLength and maxLength count Unicode scalar values (JSON Schema code-point semantics). The TypeScript runtime enforces exactly the same bounds by counting Unicode scalar values and rejecting unpaired surrogates, so runtime and artifact verdicts agree for every bounded string; fields whose ASCII-anchored pattern already restricts the alphabet (slug) coincide by construction. Unpaired surrogates cannot appear in server-emitted outputs because the runtime rejects them on every bounded string.",
  selectorNotation:
    "Dot-separated object property path from the schema root; a [] segment iterates array elements (e.g. dream.upserts[].id).",
  keywords: {
    "x-kb-utf8-max-bytes": {
      applies: "string",
      rule: "The UTF-8 encoding of the value is at most this many bytes.",
    },
    "x-kb-no-control-chars": {
      applies: "string",
      rule: "C0 control characters other than tab (U+0009), line feed (U+000A) and carriage return (U+000D) are rejected.",
    },
    "x-kb-metadata-text": {
      applies: "string",
      params: ["name", "description"],
      rule: "name rejects C0 (U+0000..U+001F) and DEL (U+007F). description follows the Markdown control policy because it is embedded in the generated index.md: C0 (including NUL, which PostgreSQL text cannot store) and DEL are rejected except tab (U+0009), line feed (U+000A) and carriage return (U+000D). Both preserve ZWJ/ZWNJ and other Unicode scalar values within their character bounds.",
    },
    "x-kb-base64-canonical": {
      applies: "string",
      params: ["minBytes", "maxBytes"],
      rule: "Canonical base64 (standard alphabet, length divisible by 4, exact re-encoding) whose decoded byte length is between minBytes and maxBytes inclusive.",
    },
    "x-kb-path": {
      applies: "string",
      rule: "A single kb repository path accepted by the server path normalizer: forward-slash separated clean relative path, no leading slash, no . or .. segments, no drive letters or UNC hosts, bounded length.",
    },
    "x-kb-path-prefix": {
      applies: "string",
      rule: "A raw document-path prefix: an x-kb-path value, optionally followed by one trailing slash (`notes/` matches only paths under the `notes` directory).",
    },
    "x-kb-iso-utc-instant": {
      applies: "string",
      rule: "RFC 3339 UTC instant with a 4-digit year, Z offset, optional 1-9 fractional digits, and a real calendar date/time.",
    },
    "x-kb-json-encoded-max-bytes": {
      applies: "object",
      rule: "The UTF-8 byte length of the compact JSON encoding (JSON.stringify) of the value is at most this many bytes.",
    },
    "x-kb-json-depth-max": {
      applies: "object",
      rule: "JSON nesting depth of the value is at most this number; scalars are depth 0 and each array or object level adds one.",
    },
    "x-kb-iso-range": {
      applies: "object",
      params: ["after", "before"],
      rule: "The instants selected by the after and before selectors (selector notation) must satisfy after < before compared as exact UTC instants at the accepted fractional precision; equal instants are rejected.",
    },
    "x-kb-unique-items": {
      applies: "object",
      rule: "Each selector resolves to a list; every element of that list must be pairwise distinct.",
    },
    "x-kb-change-paths": {
      applies: "object",
      rule: "Each selector resolves to a list of changes ({op, path}). No path may appear twice for the same kind (assetPut/assetRemove are asset changes, every other op a document change), and no two changes other than removals (delete, assetRemove) may have the same Unicode case-folded path. A removal may share a case-folded path with any other change.",
    },
  },
} as const;

function collectUsedContractKeywords(node: unknown, used: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectUsedContractKeywords(item, used);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("x-kb-")) used.add(key);
    collectUsedContractKeywords(value, used);
  }
}

function assertValidationContractCovers(tools: KbProtocolArtifacts["tools"]): void {
  const used = new Set<string>();
  collectUsedContractKeywords(tools, used);
  const documented = new Set(Object.keys(KB_VALIDATION_CONTRACT.keywords));
  for (const keyword of used) {
    if (!documented.has(keyword)) {
      throw new Error(`validation contract does not define used keyword ${keyword}`);
    }
  }
  for (const keyword of documented) {
    if (!used.has(keyword)) {
      throw new Error(`validation contract documents unused keyword ${keyword}`);
    }
  }
}

function buildSchemaArtifact(): KbProtocolArtifacts {
  assertCatalogMatchesSchemas();
  assertForbiddenNamesAbsent();
  assertWriteToolsRequireMcpWrite();
  assertDecisionVariantsWellFormed();
  assertToolGroupsWellFormed();

  const tools: KbProtocolArtifacts["tools"] = {};
  for (const name of KB_TOOL_NAMES) {
    const read = kbReadToolSchemas[name as keyof typeof kbReadToolSchemas];
    const write = kbWriteToolSchemas[name as keyof typeof kbWriteToolSchemas];
    const schemas = read ?? write;
    if (!schemas) throw new Error(`missing schemas for ${name}`);
    tools[name] = {
      catalog: KB_TOOL_CATALOG[name],
      input: zodToJsonSchema(schemas.input),
      output: zodToJsonSchema(schemas.output),
    };
  }
  assertValidationContractCovers(tools);
  return {
    schemaVersion: KB_PROTOCOL_VERSION,
    validationContract: KB_VALIDATION_CONTRACT,
    builtinProvider: BUILTIN_PROVIDER_REF,
    requestMeta: requestMeta.jsonSchema.input({ target: "draft-2020-12" }),
    toolGroups: [...KB_TOOL_GROUPS],
    toolPresets: Object.fromEntries(
      Object.entries(KB_TOOL_PRESETS).map(([name, groups]) => [
        name,
        KB_TOOL_GROUPS.filter((group) => (groups as readonly string[]).includes(group)),
      ]),
    ),
    tools,
  };
}

const UNSAFE_INTEGER = 2 ** 53;
const FIXTURE_HASH_ZERO = `sha256:${"0".repeat(64)}`;

function toolSchemas(name: string) {
  const read = kbReadToolSchemas[name as keyof typeof kbReadToolSchemas];
  const write = kbWriteToolSchemas[name as keyof typeof kbWriteToolSchemas];
  const schemas = read ?? write;
  if (!schemas) throw new Error(`no runtime schema for ${name}`);
  return schemas;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * First top-level key (sorted) whose replacement by `replacement` makes the
 * runtime schema reject the value; null when no key qualifies.
 */
function firstRejectingReplacement(
  schema: { safeParse: (value: unknown) => { success: boolean } },
  value: unknown,
  eligible: (current: unknown) => boolean,
  replacement: unknown,
): { key: string; value: Record<string, unknown> } | null {
  if (!isRecord(value)) return null;
  for (const key of Object.keys(value).sort()) {
    if (!eligible(value[key])) continue;
    const candidate = { ...value, [key]: replacement };
    if (!schema.safeParse(candidate).success) return { key, value: candidate };
  }
  return null;
}

const SEARCH_HIT = {
  knowledgeBaseId: FIXTURE_KB_ID,
  knowledgeBaseName: "Fixture knowledge base",
  path: FIXTURE_PATH,
  documentId: "doc-guide",
  commitSha: FIXTURE_SHA,
  blobSha: FIXTURE_SHA,
  contentHash: FIXTURE_HASH_ZERO,
  chunkIndex: 2,
  span: { startToken: 7, endToken: 19, startByte: 41, endByte: 133 },
  snippet: "Fixture snippet with ünïcödé 😀 text",
  score: 0.03278688524590164,
  mode: "structured",
  indexGenerationId: FIXTURE_KB_ID,
  freshness: "stale",
  documentCitations: [{ label: "Episode", target: "cockpit://episode/fixture" }],
  assetRefs: [{ path: "assets/x.png", hash: FIXTURE_HASH_ZERO, size: 12, mime: "image/png" }],
  matchedRow: { name: "alpha", count: 3, ratio: 0.5, active: true, note: null },
};

/**
 * Shared conformance cases every kb/1 consumer (TS runtime, artifact
 * evaluator, Rust kb-client) must agree on: exact nulls, unsafe numbers,
 * timestamps, canonical base64 and Unicode scalar/byte caps. Every generated
 * verdict is checked against the runtime Zod schemas here, so the corpus can
 * never carry a case the reference runtime disagrees with.
 */
function addConformanceCases(base: Record<string, FixtureRow>): KbFixtureCorpus["tools"] {
  const tools: KbFixtureCorpus["tools"] = {};
  for (const [name, row] of Object.entries(base)) {
    tools[name] = { ...row, validInputVariants: [], validOutputVariants: [], invalidOutputs: [] };
  }
  const row = (name: string) => {
    const entry = tools[name];
    if (!entry) throw new Error(`missing fixtures for ${name}`);
    return entry;
  };
  const input = (name: string) => row(name).validInput as Record<string, unknown>;
  const output = (name: string) => row(name).validOutput as Record<string, unknown>;

  for (const name of [
    "knowledge_changes_apply",
    "knowledge_documents_create",
    "knowledge_documents_update",
    "knowledge_documents_delete",
    "knowledge_assets_put",
    "knowledge_assets_import",
  ]) {
    row(name).validInputVariants.push({
      label: "explicit proposal",
      value: { ...input(name), proposalNumber: 7 },
    });
    for (const proposalNumber of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, null, "7"]) {
      row(name).invalidInputs.push({
        label: `invalid proposal number ${JSON.stringify(proposalNumber)}`,
        value: { ...input(name), proposalNumber },
      });
    }
  }

  const builtinProfile = {
    ...output("knowledge_embedding_profile_get"),
    profile: {
      providerId: FIXTURE_KB_ID,
      revision: 1,
      kind: "SYSTEM_BUILTIN",
      name: "Built-in embedding model",
      model: "embeddinggemma-2-q8_0",
      dimensions: 768,
      contextTokens: 1024,
      status: "ready",
    },
  };
  row("knowledge_embedding_profile_get").validOutputVariants.push({
    label: "builtin-model-neutral",
    value: builtinProfile,
  });
  for (const name of Object.keys(tools).sort()) {
    const entry = row(name);
    const schemas = toolSchemas(name);
    const nullInput = firstRejectingReplacement(
      schemas.input,
      entry.validInput,
      (current) => current !== null,
      null,
    );
    if (nullInput)
      entry.invalidInputs.push({ label: `null-${nullInput.key}`, value: nullInput.value });
    const unsafeInput = firstRejectingReplacement(
      schemas.input,
      entry.validInput,
      (current) => typeof current === "number",
      UNSAFE_INTEGER,
    );
    if (unsafeInput) {
      entry.invalidInputs.push({ label: `unsafe-${unsafeInput.key}`, value: unsafeInput.value });
    }
    const out = entry.validOutput;
    if (isRecord(out)) {
      for (const key of Object.keys(out).sort()) {
        if (out[key] !== null) continue;
        const { [key]: _absent, ...rest } = out;
        entry.invalidOutputs.push({ label: `absent-nullable-${key}`, value: rest });
        break;
      }
      const nullOutput = firstRejectingReplacement(
        schemas.output,
        out,
        (current) => current !== null,
        null,
      );
      if (nullOutput) {
        entry.invalidOutputs.push({ label: `null-${nullOutput.key}`, value: nullOutput.value });
      }
      const unsafeOutput = firstRejectingReplacement(
        schemas.output,
        out,
        (current) => typeof current === "number",
        UNSAFE_INTEGER,
      );
      if (unsafeOutput) {
        entry.invalidOutputs.push({
          label: `unsafe-${unsafeOutput.key}`,
          value: unsafeOutput.value,
        });
      }
      entry.invalidOutputs.push({ label: "unknown-field", value: { ...out, extra: true } });
    }
  }

  // Safe-integer boundary and non-integer numbers.
  const transfer = input("knowledge_transfer_read");
  row("knowledge_transfer_read").validInputVariants.push(
    { label: "max-safe-offset", value: { ...transfer, offset: Number.MAX_SAFE_INTEGER } },
    { label: "max-bytes-cap", value: { ...transfer, maxBytes: 196608 } },
  );
  row("knowledge_transfer_read").invalidInputs.push(
    { label: "fractional-offset", value: { ...transfer, offset: 1.5 } },
    { label: "negative-offset", value: { ...transfer, offset: -1 } },
    { label: "max-bytes-over-cap", value: { ...transfer, maxBytes: 196609 } },
    { label: "string-offset", value: { ...transfer, offset: "0" } },
  );

  // Timestamps.
  const structured = input("knowledge_structured_search");
  row("knowledge_structured_search").validInputVariants.push(
    {
      label: "leap-day-nanosecond-range",
      value: {
        ...structured,
        timestamp: { after: "2024-02-29T23:59:59.999999999Z", before: "2024-03-01T00:00:00Z" },
      },
    },
    {
      label: "open-ended-after",
      value: { kbId: FIXTURE_KB_ID, timestamp: { after: "2026-01-15T12:30:00.5Z" } },
    },
    {
      label: "row-filters",
      value: {
        kbId: FIXTURE_KB_ID,
        structured: [
          { column: "name", equals: "alpha" },
          { column: "count", equals: 3 },
          { column: "active", equals: true },
          { column: "note", equals: null },
        ],
      },
    },
  );
  row("knowledge_structured_search").invalidInputs.push(
    {
      label: "impossible-calendar-date",
      value: { ...structured, timestamp: { after: "2026-02-30T00:00:00Z" } },
    },
    {
      label: "non-utc-offset",
      value: { ...structured, timestamp: { after: "2026-01-01T00:00:00+00:00" } },
    },
    {
      label: "ten-fraction-digits",
      value: { ...structured, timestamp: { after: "2026-01-01T00:00:00.0000000001Z" } },
    },
    {
      label: "equal-timestamps",
      value: {
        ...structured,
        timestamp: { after: "2026-01-01T00:00:00.5Z", before: "2026-01-01T00:00:00.500Z" },
      },
    },
    {
      label: "null-timestamp-after",
      value: { ...structured, timestamp: { after: null } },
    },
    {
      label: "object-equals",
      value: { kbId: FIXTURE_KB_ID, structured: [{ column: "name", equals: { a: 1 } }] },
    },
    { label: "empty-tags-only", value: { kbId: FIXTURE_KB_ID, tags: [] } },
    { label: "empty-timestamp-only", value: { kbId: FIXTURE_KB_ID, timestamp: {} } },
  );

  row("knowledge_structured_search").validInputVariants.push(
    {
      label: "open-ended-before",
      value: { kbId: FIXTURE_KB_ID, timestamp: { before: "2026-01-15T12:30:00Z" } },
    },
    {
      label: "empty-timestamp-with-query",
      value: { kbId: FIXTURE_KB_ID, query: "alpha", timestamp: {} },
    },
    { label: "empty-timestamp-with-filter", value: { ...structured, timestamp: {} } },
    { label: "unicode-joiners", value: { kbId: FIXTURE_KB_ID, title: "a\u200cb\u200dc" } },
  );
  for (const query of [undefined, "alpha"])
    for (const [field, filter] of Object.entries({
      type: { type: "canary\0value" },
      title: { title: "canary\0value" },
      tags: { tags: ["canary\0value"] },
      column: { structured: [{ column: "canary\0value", equals: "value" }] },
      equals: { structured: [{ column: "name", equals: "canary\0value" }] },
    }))
      row("knowledge_structured_search").invalidInputs.push({
        label: `nul-${field}-${query === undefined ? "queryless" : "hybrid"}`,
        value: { kbId: FIXTURE_KB_ID, ...(query ? { query } : {}), ...filter },
      });
  for (const tool of ["knowledge_search", "knowledge_structured_search"] as const) {
    for (const count of [512, 513, 1024])
      row(tool).validInputVariants.push({
        label: `astral-query-${count}`,
        value: { kbId: FIXTURE_KB_ID, query: "😀".repeat(count) },
      });
    row(tool).validInputVariants.push({
      label: "mixed-scalar-query",
      value: { kbId: FIXTURE_KB_ID, query: "a😀".repeat(512) },
    });
    row(tool).invalidInputs.push(
      { label: "nul-query", value: { kbId: FIXTURE_KB_ID, query: "canary\0value" } },
      { label: "astral-query-over-cap", value: { kbId: FIXTURE_KB_ID, query: "😀".repeat(1025) } },
    );
  }

  // Canonical base64.
  const upload = input("knowledge_upload_write");
  row("knowledge_upload_write").validInputVariants.push(
    { label: "padded-one-byte", value: { ...upload, bytesBase64: "Zg==" } },
    { label: "padded-two-bytes", value: { ...upload, bytesBase64: "Zm8=" } },
  );
  row("knowledge_upload_write").invalidInputs.push(
    { label: "non-canonical-padding-bits", value: { ...upload, bytesBase64: "Zh==" } },
    { label: "missing-padding", value: { ...upload, bytesBase64: "Zg" } },
    { label: "url-safe-alphabet", value: { ...upload, bytesBase64: "_-8=" } },
    { label: "empty-chunk", value: { ...upload, bytesBase64: "" } },
    { label: "embedded-newline", value: { ...upload, bytesBase64: "Zm9v\nYmFy" } },
  );

  // Unicode scalar caps (not UTF-16 units, not bytes) and UTF-8 byte caps.
  const search = input("knowledge_search");
  row("knowledge_search").validInputVariants.push({
    label: "query-1024-astral-scalars",
    value: { ...search, query: "😀".repeat(1024) },
  });
  row("knowledge_search").invalidInputs.push(
    { label: "query-1025-scalars", value: { ...search, query: "😀".repeat(1025) } },
    { label: "empty-query", value: { ...search, query: "" } },
    { label: "limit-over-cap", value: { ...search, limit: 21 } },
  );
  const create = input("knowledge_bases_create");
  row("knowledge_bases_create").validInputVariants.push({
    label: "name-120-scalars",
    value: { ...create, name: "é".repeat(120) },
  });
  row("knowledge_bases_create").invalidInputs.push(
    { label: "name-121-scalars", value: { ...create, name: "é".repeat(121) } },
    { label: "slug-uppercase", value: { ...create, slug: "New-KB" } },
    { label: "short-idempotency-key", value: { ...create, idempotencyKey: "short" } },
  );
  for (const name of ["knowledge_bases_create", "knowledge_bases_update"] as const) {
    const base = input(name);
    for (const size of [119, 120])
      row(name).validInputVariants.push({
        label: `name-${size}-astral-scalars`,
        value: { ...base, name: "😀".repeat(size) },
      });
    for (const size of [10, 1999, 2000])
      row(name).validInputVariants.push({
        label: `description-${size}-astral-scalars`,
        value: { ...base, description: "😀".repeat(size) },
      });
    row(name).validInputVariants.push({
      label: "description-permitted-controls",
      value: { ...base, description: "Description\t\n\r\u200c\u200d" },
    });
    row(name).invalidInputs.push(
      { label: "name-121-astral-scalars", value: { ...base, name: "😀".repeat(121) } },
      { label: "description-9-scalars", value: { ...base, description: "😀".repeat(9) } },
      { label: "description-2001-scalars", value: { ...base, description: "😀".repeat(2001) } },
      { label: "description-nul", value: { ...base, description: "description\u0000bad" } },
      { label: "description-c0", value: { ...base, description: "description\u0001bad" } },
      { label: "description-del", value: { ...base, description: "description\u007fbad" } },
      ...["\u0000", "\t", "\n", "\u007f"].map((control, i) => ({
        label: `name-control-${i}`,
        value: { ...base, name: `bad${control}name` },
      })),
    );
  }
  for (const name of [
    "knowledge_bases_get",
    "knowledge_bases_create",
    "knowledge_bases_update",
  ] as const) {
    const base = output(name) as { kb: Record<string, unknown> };
    row(name).invalidOutputs.push({
      label: "attachment-null-head",
      value: { ...base, kb: { ...base.kb, headSha: null } },
    });
  }
  row("knowledge_bases_list").invalidOutputs.push({
    label: "attachment-null-head",
    value: {
      items: [{ ...(output("knowledge_bases_get").kb as Record<string, unknown>), headSha: null }],
      nextCursor: null,
    },
  });
  const dreamInput = {
    kbId: FIXTURE_KB_ID,
    baseRevision: FIXTURE_SHA,
    idempotencyKey: FIXTURE_KEY,
    mode: "dream",
    title: "Dream",
    changes: [],
    sourceSessionIds: [FIXTURE_UUID],
    dream: {
      model: { provider: "fixture", model: "fixture-model" },
      redactionApplied: true,
      upserts: [
        {
          id: "concept-a",
          type: "concept",
          title: null,
          body: "é".repeat(32768),
          citations: [{ label: "Episode", target: "cockpit://episode/fixture" }],
          provenance: "dream",
        },
      ],
    },
  };
  const withBody = (body: string) => ({
    ...dreamInput,
    dream: { ...dreamInput.dream, upserts: [{ ...dreamInput.dream.upserts[0], body }] },
  });
  const batchChanges = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      op: "create",
      path: `batch/${i}.md`,
      content: { markdown: "# Batch\n" },
    }));
  row("knowledge_changes_apply").validInputVariants.push({
    label: "32-changes",
    value: { ...input("knowledge_changes_apply"), changes: batchChanges(32) },
  });
  row("knowledge_changes_apply").invalidInputs.push({
    label: "33-changes",
    value: { ...input("knowledge_changes_apply"), changes: batchChanges(33) },
  });
  const { title: _editTitle, ...titlelessEdit } = input("knowledge_changes_apply");
  row("knowledge_changes_apply").validInputVariants.push(
    {
      label: "edit-without-title",
      value: titlelessEdit,
    },
    {
      label: "32-changes-without-title",
      value: { ...titlelessEdit, changes: batchChanges(32) },
    },
  );
  row("knowledge_pull_requests_review").validInputVariants.push({
    label: "close-confirmation",
    value: { ...input("knowledge_pull_requests_review"), decision: "close", confirm: "CLOSE" },
  });
  row("knowledge_changes_apply").validInputVariants.push({
    label: "dream-body-64kib-utf8",
    value: dreamInput,
  });
  row("knowledge_changes_apply").validInputVariants.push({
    // Resolving a case clash removes one side and writes the other.
    label: "case-variant-removal-and-write",
    value: {
      ...input("knowledge_changes_apply"),
      changes: [
        { op: "assetRemove", path: "docs/strasse.md" },
        { op: "create", path: "Docs/Straße.md", content: { markdown: "# A\n" } },
      ],
    },
  });
  row("knowledge_changes_apply").invalidInputs.push(
    { label: "dream-body-over-64kib-utf8", value: withBody("é".repeat(32769)) },
    {
      label: "dream-without-sessions",
      value: { ...dreamInput, sourceSessionIds: [] },
    },
    {
      label: "case-colliding-paths",
      value: {
        ...input("knowledge_changes_apply"),
        changes: [
          { op: "create", path: "Docs/Straße.md", content: { markdown: "# A\n" } },
          { op: "create", path: "docs/STRASSE.md", content: { markdown: "# B\n" } },
        ],
      },
    },
  );
  const { title: _dreamTitle, ...titlelessDream } = dreamInput;
  row("knowledge_changes_apply").invalidInputs.push({
    label: "dream-without-title",
    value: titlelessDream,
  });
  const docCreate = input("knowledge_documents_create");
  row("knowledge_documents_create").invalidInputs.push(
    {
      label: "markdown-control-char",
      value: { ...docCreate, content: { markdown: "bell\u0007" } },
    },
    { label: "path-not-nfc", value: { ...docCreate, path: "café.md" } },
    { label: "path-git-metadata", value: { ...docCreate, path: "docs/.GIT/config" } },
    { label: "path-windows-reserved", value: { ...docCreate, path: "docs/con.txt.md" } },
  );
  row("knowledge_documents_create").validInputVariants.push({
    label: "unicode-path-and-tab-markdown",
    value: { ...docCreate, path: "notes/café.md", content: { markdown: "a\tb\r\nc" } },
  });
  row("knowledge_documents_get").invalidInputs.push({
    label: "null-optional-rev",
    value: { ...input("knowledge_documents_get"), rev: null },
  });
  row("knowledge_bases_list").validInputVariants.push(
    { label: "empty-page", value: {} },
    { label: "string-cursor", value: { cursor: "opaque-cursor" } },
  );
  row("knowledge_bases_list").validOutputVariants.push({
    label: "empty-page",
    value: { items: [], nextCursor: null },
  });
  const proposal = output("knowledge_pull_requests_create").pr;
  row("knowledge_changes_apply").validOutputVariants.push({
    label: "active-proposal-noop",
    value: { ...output("knowledge_changes_apply"), proposal },
  });

  row("knowledge_changes_apply").validOutputVariants.push({
    label: "32-asset-removal-warnings",
    value: {
      ...output("knowledge_changes_apply"),
      warnings: Array.from({ length: 32 }, (_, i) => ({
        code: "ASSET_STILL_REFERENCED",
        path: `images/${i}.png`,
        referencedBy: ["notes/references.md"],
      })),
    },
  });

  // Populated outputs: citation spans, matched rows, nested front matter.
  const searchOut = output("knowledge_search");
  row("knowledge_search").validOutputVariants.push({
    label: "populated-hit",
    value: { ...searchOut, results: [SEARCH_HIT] },
  });
  row("knowledge_search").invalidOutputs.push(
    {
      label: "hit-missing-matched-row",
      value: {
        ...searchOut,
        results: [
          Object.fromEntries(Object.entries(SEARCH_HIT).filter(([key]) => key !== "matchedRow")),
        ],
      },
    },
    {
      label: "hit-snippet-241-scalars",
      value: { ...searchOut, results: [{ ...SEARCH_HIT, snippet: "😀".repeat(241) }] },
    },
    {
      label: "hit-span-extra-field",
      value: { ...searchOut, results: [{ ...SEARCH_HIT, span: { ...SEARCH_HIT.span, x: 1 } }] },
    },
    {
      label: "two-notices",
      value: {
        ...searchOut,
        indexNotices: [searchOut.indexNotices, searchOut.indexNotices].flat(),
      },
    },
  );
  const reservedRow = Object.fromEntries([
    ["__proto__", "present"],
    ["constructor", "ctor"],
    ["prototype", "proto"],
  ]);
  for (const name of ["knowledge_search", "knowledge_structured_search"] as const) {
    const field = name === "knowledge_search" ? "results" : "items";
    row(name).validOutputVariants.push({
      label: "reserved-own-row-keys",
      value: { ...output(name), [field]: [{ ...SEARCH_HIT, matchedRow: reservedRow }] },
    });
    row(name).invalidOutputs.push({
      label: "invalid-reserved-row-value",
      value: {
        ...output(name),
        [field]: [
          { ...SEARCH_HIT, matchedRow: Object.fromEntries([["__proto__", { bad: true }]]) },
        ],
      },
    });
  }
  const docOut = output("knowledge_documents_get");
  row("knowledge_documents_get").validOutputVariants.push({
    label: "reserved-frontmatter-key",
    value: { ...docOut, frontMatter: reservedRow },
  });
  row("knowledge_documents_get").validOutputVariants.push({
    label: "nested-front-matter",
    value: {
      ...docOut,
      frontMatter: {
        title: "Guide",
        tags: ["a", "b"],
        nested: { level: { deeper: [1, 2.5, null, true] } },
        citations: [{ label: "Source", target: "https://example.test/a" }],
      },
    },
  });
  row("knowledge_documents_get").invalidOutputs.push({
    label: "front-matter-bad-citations",
    value: { ...docOut, frontMatter: { citations: [{ label: "x" }] } },
  });

  // Every generated verdict must match the reference runtime.
  for (const [name, entry] of Object.entries(tools)) {
    const schemas = toolSchemas(name);
    for (const variant of entry.validInputVariants) {
      if (!schemas.input.safeParse(variant.value).success) {
        throw new Error(`${name}:${variant.label} valid input variant rejected by runtime`);
      }
    }
    for (const variant of entry.validOutputVariants) {
      if (!schemas.output.safeParse(variant.value).success) {
        throw new Error(`${name}:${variant.label} valid output variant rejected by runtime`);
      }
    }
    for (const invalid of entry.invalidInputs) {
      if (schemas.input.safeParse(invalid.value).success) {
        throw new Error(`${name}:${invalid.label} invalid input accepted by runtime`);
      }
    }
    for (const invalid of entry.invalidOutputs) {
      if (schemas.output.safeParse(invalid.value).success) {
        throw new Error(`${name}:${invalid.label} invalid output accepted by runtime`);
      }
    }
  }
  return tools;
}

function pageFixture() {
  return { limit: 20, cursor: null };
}

function buildFixtureCorpus(): KbFixtureCorpus {
  const basePageOutput = { items: [FIXTURE_KB_ATTACHMENT], nextCursor: null };
  const applyOutput = {
    operationId: FIXTURE_UUID,
    kind: "noop" as const,
    commitSha: FIXTURE_SHA,
    baseRevision: FIXTURE_SHA,
    proposal: null,
    changedPaths: [],
    sourceSessionIds: [],
    indexJobId: null,
  };

  const baseTools: Record<string, FixtureRow> = {
    knowledge_bases_list: {
      validInput: pageFixture(),
      validOutput: basePageOutput,
      invalidInputs: [{ label: "unknown-field", value: { limit: 20, cursor: null, extra: true } }],
    },
    knowledge_bases_get: {
      validInput: { kbId: FIXTURE_KB_ID },
      validOutput: { kb: FIXTURE_KB_ATTACHMENT, index: FIXTURE_INDEX_STATUS },
      invalidInputs: [{ label: "unknown-field", value: { kbId: FIXTURE_KB_ID, extra: true } }],
    },
    knowledge_bases_create: {
      validInput: {
        name: "New KB",
        slug: "new-kb",
        description: "Synthetic create fixture for protocol corpus.",
        idempotencyKey: FIXTURE_KEY,
      },
      validOutput: { operationId: FIXTURE_UUID, kb: FIXTURE_KB_ATTACHMENT },
      invalidInputs: [
        {
          label: "unknown-field",
          value: {
            name: "x",
            slug: "x",
            description: "1234567890",
            idempotencyKey: FIXTURE_KEY,
            extra: 1,
          },
        },
      ],
    },
    knowledge_bases_update: {
      validInput: {
        kbId: FIXTURE_KB_ID,
        idempotencyKey: FIXTURE_KEY,
        metadataVersion: 1,
        name: "Renamed",
      },
      validOutput: { operationId: FIXTURE_UUID, kb: FIXTURE_KB_ATTACHMENT },
      invalidInputs: [
        {
          label: "no-fields",
          value: {
            kbId: FIXTURE_KB_ID,
            idempotencyKey: FIXTURE_KEY,
            metadataVersion: 1,
          },
        },
        {
          label: "bad-confirm",
          value: {
            kbId: FIXTURE_KB_ID,
            idempotencyKey: FIXTURE_KEY,
            metadataVersion: 1,
            confirm: "DELETE",
          },
        },
      ],
    },
    knowledge_bases_delete: {
      validInput: {
        kbId: FIXTURE_KB_ID,
        idempotencyKey: FIXTURE_KEY,
        metadataVersion: 1,
        confirm: "DELETE",
      },
      validOutput: { operationId: FIXTURE_UUID, tombstoned: true },
      invalidInputs: [
        {
          label: "bad-confirm",
          value: {
            kbId: FIXTURE_KB_ID,
            idempotencyKey: FIXTURE_KEY,
            metadataVersion: 1,
            confirm: "RUN",
          },
        },
      ],
    },
    knowledge_documents_list: {
      validInput: { kbId: FIXTURE_KB_ID, ...pageFixture() },
      validOutput: {
        items: [
          {
            path: FIXTURE_PATH,
            documentId: null,
            commitSha: FIXTURE_SHA,
            blobSha: FIXTURE_SHA,
            size: 12,
          },
        ],
        nextCursor: null,
      },
      invalidInputs: [
        { label: "unknown-field", value: { kbId: FIXTURE_KB_ID, limit: 20, extra: 1 } },
      ],
    },
    knowledge_documents_get: {
      validInput: { kbId: FIXTURE_KB_ID, path: FIXTURE_PATH },
      validOutput: {
        path: FIXTURE_PATH,
        documentId: null,
        markdown: "# Fixture\n",
        frontMatter: {},
        commitSha: FIXTURE_SHA,
        blobSha: FIXTURE_SHA,
        contentHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        documentCitations: [],
        assetRefs: [],
      },
      invalidInputs: [
        { label: "unknown-field", value: { kbId: FIXTURE_KB_ID, path: FIXTURE_PATH, extra: true } },
        { label: "bad-path", value: { kbId: FIXTURE_KB_ID, path: "../private" } },
      ],
    },
    knowledge_search: {
      validInput: { kbId: FIXTURE_KB_ID, query: "fixture query" },
      validOutput: {
        results: [],
        generationId: FIXTURE_KB_ID,
        freshness: "current",
        indexedCommitSha: FIXTURE_SHA,
        headSha: FIXTURE_SHA,
        indexNotices: [
          {
            kbId: FIXTURE_KB_ID,
            code: "EMBEDDING_REBUILD_PENDING",
            detail: "EMBEDDING_SETTINGS_CHANGED",
          },
        ],
      },
      invalidInputs: [
        { label: "unknown-field", value: { kbId: FIXTURE_KB_ID, query: "q", extra: true } },
      ],
    },
    knowledge_structured_search: {
      validInput: { kbId: FIXTURE_KB_ID, type: "note" },
      validOutput: {
        items: [],
        nextCursor: null,
        generationId: FIXTURE_KB_ID,
        freshness: "current",
        indexedCommitSha: FIXTURE_SHA,
        headSha: FIXTURE_SHA,
        indexNotices: [],
      },
      invalidInputs: [
        { label: "empty-filters", value: { kbId: FIXTURE_KB_ID } },
        {
          label: "inverted-timestamps",
          value: {
            kbId: FIXTURE_KB_ID,
            timestamp: {
              after: "2026-01-01T00:00:00.000002Z",
              before: "2026-01-01T00:00:00.000001Z",
            },
          },
        },
      ],
    },
    knowledge_changes_apply: {
      validInput: {
        kbId: FIXTURE_KB_ID,
        baseRevision: FIXTURE_SHA,
        idempotencyKey: FIXTURE_KEY,
        mode: "edit",
        title: "Batch",
        changes: [{ op: "replace", path: FIXTURE_PATH, content: { markdown: "# Batch\n" } }],
        sourceSessionIds: [],
      },
      validOutput: applyOutput,
      invalidInputs: [
        {
          label: "empty-edit",
          value: {
            kbId: FIXTURE_KB_ID,
            baseRevision: FIXTURE_SHA,
            idempotencyKey: FIXTURE_KEY,
            mode: "edit",
            title: "Batch",
            changes: [],
            sourceSessionIds: [],
          },
        },
        {
          label: "unknown-field",
          value: {
            kbId: FIXTURE_KB_ID,
            baseRevision: FIXTURE_SHA,
            mode: "edit",
            title: "t",
            changes: [{ op: "replace", path: FIXTURE_PATH, content: { markdown: "x" } }],
            sourceSessionIds: [],
            extra: 1,
          },
        },
        {
          label: "duplicate-session",
          value: {
            kbId: FIXTURE_KB_ID,
            baseRevision: FIXTURE_SHA,
            idempotencyKey: FIXTURE_KEY,
            mode: "edit",
            title: "Batch",
            changes: [{ op: "replace", path: FIXTURE_PATH, content: { markdown: "# Batch\n" } }],
            sourceSessionIds: [FIXTURE_UUID, FIXTURE_UUID],
          },
        },
      ],
    },
    knowledge_documents_create: {
      validInput: {
        kbId: FIXTURE_KB_ID,
        baseRevision: FIXTURE_SHA,
        idempotencyKey: FIXTURE_KEY,
        path: "new.md",
        content: { markdown: "# New\n" },
      },
      validOutput: applyOutput,
      invalidInputs: [
        {
          label: "dual-text-input",
          value: {
            kbId: FIXTURE_KB_ID,
            baseRevision: FIXTURE_SHA,
            idempotencyKey: FIXTURE_KEY,
            path: "new.md",
            content: { markdown: "# x", uploadId: FIXTURE_UUID },
          },
        },
      ],
    },
    knowledge_documents_update: {
      validInput: {
        kbId: FIXTURE_KB_ID,
        baseRevision: FIXTURE_SHA,
        idempotencyKey: FIXTURE_KEY,
        path: FIXTURE_PATH,
        content: { uploadId: FIXTURE_UUID },
      },
      validOutput: applyOutput,
      invalidInputs: [
        {
          label: "unknown-field",
          value: {
            kbId: FIXTURE_KB_ID,
            baseRevision: FIXTURE_SHA,
            idempotencyKey: FIXTURE_KEY,
            path: FIXTURE_PATH,
            content: { markdown: "a" },
            extra: true,
          },
        },
      ],
    },
    knowledge_documents_delete: {
      validInput: {
        kbId: FIXTURE_KB_ID,
        baseRevision: FIXTURE_SHA,
        idempotencyKey: FIXTURE_KEY,
        path: FIXTURE_PATH,
        confirm: "DELETE",
      },
      validOutput: applyOutput,
      invalidInputs: [
        {
          label: "bad-confirm",
          value: {
            kbId: FIXTURE_KB_ID,
            baseRevision: FIXTURE_SHA,
            idempotencyKey: FIXTURE_KEY,
            path: FIXTURE_PATH,
            confirm: "MERGE",
          },
        },
      ],
    },
    knowledge_upload_begin: {
      validInput: {
        kbId: FIXTURE_KB_ID,
        idempotencyKey: FIXTURE_KEY,
        kind: "markdown",
        size: 10,
        contentHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        mime: "text/markdown",
      },
      validOutput: {
        operationId: FIXTURE_UUID,
        uploadId: FIXTURE_UUID,
        offset: 0,
        expiresAt: "2026-01-15T12:30:00.000Z",
        maxChunkBytes: 196608,
      },
      invalidInputs: [
        {
          label: "unknown-field",
          value: {
            kbId: FIXTURE_KB_ID,
            idempotencyKey: FIXTURE_KEY,
            kind: "markdown",
            size: 1,
            contentHash: "sha256:00",
            mime: "text/markdown",
            extra: 1,
          },
        },
      ],
    },
    knowledge_upload_write: {
      validInput: { kbId: FIXTURE_KB_ID, uploadId: FIXTURE_UUID, offset: 0, bytesBase64: "Zml4" },
      validOutput: { uploadId: FIXTURE_UUID, offset: 4 },
      invalidInputs: [
        {
          label: "unknown-field",
          value: {
            kbId: FIXTURE_KB_ID,
            uploadId: FIXTURE_UUID,
            offset: 0,
            bytesBase64: "Zml4",
            extra: true,
          },
        },
        {
          label: "bad-base64",
          value: { kbId: FIXTURE_KB_ID, uploadId: FIXTURE_UUID, offset: 0, bytesBase64: "!!!" },
        },
      ],
    },
    knowledge_upload_finish: {
      validInput: { kbId: FIXTURE_KB_ID, uploadId: FIXTURE_UUID },
      validOutput: {
        uploadId: FIXTURE_UUID,
        contentHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        size: 4,
        mime: "text/markdown",
        state: "READY",
        expiresAt: "2026-01-15T12:30:00.000Z",
      },
      invalidInputs: [
        {
          label: "unknown-field",
          value: { kbId: FIXTURE_KB_ID, uploadId: FIXTURE_UUID, extra: 1 },
        },
      ],
    },
    knowledge_assets_put: {
      validInput: {
        kbId: FIXTURE_KB_ID,
        baseRevision: FIXTURE_SHA,
        idempotencyKey: FIXTURE_KEY,
        path: "assets/x.png",
        uploadId: FIXTURE_UUID,
      },
      validOutput: applyOutput,
      invalidInputs: [
        {
          label: "unknown-field",
          value: {
            kbId: FIXTURE_KB_ID,
            baseRevision: FIXTURE_SHA,
            idempotencyKey: FIXTURE_KEY,
            path: "a",
            uploadId: FIXTURE_UUID,
            extra: 1,
          },
        },
      ],
    },
    knowledge_assets_import: {
      validInput: {
        kbId: FIXTURE_KB_ID,
        baseRevision: FIXTURE_SHA,
        idempotencyKey: FIXTURE_KEY,
        path: "assets/x.png",
        source: {
          kbId: FIXTURE_KB_ID,
          rev: FIXTURE_SHA,
          hash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        },
      },
      validOutput: applyOutput,
      invalidInputs: [
        {
          label: "unknown-field",
          value: {
            kbId: FIXTURE_KB_ID,
            baseRevision: FIXTURE_SHA,
            idempotencyKey: FIXTURE_KEY,
            path: "a",
            source: { kbId: FIXTURE_KB_ID, rev: FIXTURE_SHA, hash: "sha256:00" },
            extra: 1,
          },
        },
      ],
    },
    knowledge_assets_list: {
      validInput: { kbId: FIXTURE_KB_ID, ...pageFixture() },
      validOutput: { items: [], nextCursor: null },
      invalidInputs: [
        { label: "unknown-field", value: { kbId: FIXTURE_KB_ID, limit: 20, extra: 1 } },
      ],
    },
    knowledge_export_prepare: {
      validInput: { kbId: FIXTURE_KB_ID, kind: "assets", idempotencyKey: FIXTURE_KEY },
      validOutput: {
        operationId: FIXTURE_UUID,
        transferId: FIXTURE_UUID,
        rev: FIXTURE_SHA,
        size: 0,
        contentHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        expiresAt: "2026-01-15T12:30:00.000Z",
        mime: "application/zip",
      },
      invalidInputs: [
        {
          label: "unknown-field",
          value: { kbId: FIXTURE_KB_ID, kind: "assets", idempotencyKey: FIXTURE_KEY, extra: 1 },
        },
      ],
    },
    knowledge_transfer_read: {
      validInput: { kbId: FIXTURE_KB_ID, transferId: FIXTURE_UUID, offset: 0 },
      validOutput: {
        transferId: FIXTURE_UUID,
        offset: 0,
        nextOffset: 0,
        bytesBase64: "AA==",
        eof: true,
        contentHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      },
      invalidInputs: [
        {
          label: "unknown-field",
          value: { kbId: FIXTURE_KB_ID, transferId: FIXTURE_UUID, offset: 0, extra: 1 },
        },
      ],
    },
    knowledge_export_complete: {
      validInput: { kbId: FIXTURE_KB_ID, transferId: FIXTURE_UUID },
      validOutput: { transferId: FIXTURE_UUID, released: true },
      invalidInputs: [
        {
          label: "unknown-field",
          value: { kbId: FIXTURE_KB_ID, transferId: FIXTURE_UUID, extra: 1 },
        },
      ],
    },
    knowledge_index_status: {
      validInput: { kbId: FIXTURE_KB_ID },
      validOutput: FIXTURE_INDEX_STATUS,
      invalidInputs: [{ label: "unknown-field", value: { kbId: FIXTURE_KB_ID, extra: 1 } }],
    },
    knowledge_index_rebuild: {
      validInput: { kbId: FIXTURE_KB_ID, idempotencyKey: FIXTURE_KEY, confirm: "RUN" },
      validOutput: {
        operationId: FIXTURE_UUID,
        generationId: FIXTURE_KB_ID,
        jobId: FIXTURE_UUID,
        state: "PENDING",
      },
      invalidInputs: [
        {
          label: "bad-confirm",
          value: { kbId: FIXTURE_KB_ID, idempotencyKey: FIXTURE_KEY, confirm: "DELETE" },
        },
      ],
    },
    knowledge_embedding_profile_get: {
      validInput: { kbId: FIXTURE_KB_ID },
      validOutput: { profile: null, index: FIXTURE_INDEX_STATUS },
      invalidInputs: [{ label: "unknown-field", value: { kbId: FIXTURE_KB_ID, extra: 1 } }],
    },
    knowledge_embedding_profile_set: {
      validInput: {
        kbId: FIXTURE_KB_ID,
        providerId: FIXTURE_KB_ID,
        revision: 1,
        idempotencyKey: FIXTURE_KEY,
        confirm: "RUN",
      },
      validOutput: {
        operationId: FIXTURE_UUID,
        generationId: FIXTURE_KB_ID,
        jobId: FIXTURE_UUID,
        state: "PENDING",
      },
      invalidInputs: [
        {
          label: "bad-confirm",
          value: {
            kbId: FIXTURE_KB_ID,
            providerId: FIXTURE_KB_ID,
            revision: 1,
            idempotencyKey: FIXTURE_KEY,
            confirm: "DELETE",
          },
        },
      ],
    },
    knowledge_pull_requests_list: {
      validInput: { kbId: FIXTURE_KB_ID, ...pageFixture() },
      validOutput: { items: [], nextCursor: null },
      invalidInputs: [
        { label: "unknown-field", value: { kbId: FIXTURE_KB_ID, limit: 20, extra: 1 } },
      ],
    },
    knowledge_pull_requests_get: {
      validInput: { kbId: FIXTURE_KB_ID, number: 1 },
      validOutput: {
        pr: {
          number: 1,
          title: "Fixture PR",
          sourceBranch: "feature/fixture",
          targetBranch: "main",
          baseSha: FIXTURE_SHA,
          headSha: FIXTURE_SHA,
          targetSha: FIXTURE_SHA,
          status: "OPEN",
          authorActorKey: "actor:fixture",
          version: 1,
          mergeCommitSha: null,
        },
        files: [],
        touchedAssets: [],
        nextCursor: null,
      },
      invalidInputs: [
        { label: "unknown-field", value: { kbId: FIXTURE_KB_ID, number: 1, extra: 1 } },
      ],
    },
    knowledge_pull_requests_create: {
      validInput: {
        kbId: FIXTURE_KB_ID,
        headBranch: "feature/fixture",
        expectedHeadSha: FIXTURE_SHA,
        expectedTargetSha: FIXTURE_SHA,
        title: "Fixture PR",
        idempotencyKey: FIXTURE_KEY,
      },
      validOutput: {
        operationId: FIXTURE_UUID,
        pr: {
          number: 1,
          title: "Fixture PR",
          sourceBranch: "feature/fixture",
          targetBranch: "main",
          baseSha: FIXTURE_SHA,
          headSha: FIXTURE_SHA,
          targetSha: FIXTURE_SHA,
          status: "OPEN",
          authorActorKey: "actor:fixture",
          version: 1,
          mergeCommitSha: null,
        },
      },
      invalidInputs: [
        {
          label: "unknown-field",
          value: {
            kbId: FIXTURE_KB_ID,
            headBranch: "b",
            expectedHeadSha: FIXTURE_SHA,
            expectedTargetSha: FIXTURE_SHA,
            title: "t",
            idempotencyKey: FIXTURE_KEY,
            extra: 1,
          },
        },
      ],
    },
    knowledge_pull_requests_review: {
      validInput: {
        kbId: FIXTURE_KB_ID,
        number: 1,
        decision: "merge",
        expectedHeadSha: FIXTURE_SHA,
        expectedTargetSha: FIXTURE_SHA,
        idempotencyKey: FIXTURE_KEY,
        confirm: "MERGE",
      },
      validOutput: {
        operationId: FIXTURE_UUID,
        pr: {
          number: 1,
          title: "Fixture PR",
          sourceBranch: "feature/fixture",
          targetBranch: "main",
          baseSha: FIXTURE_SHA,
          headSha: FIXTURE_SHA,
          targetSha: FIXTURE_SHA,
          status: "MERGED",
          authorActorKey: "actor:fixture",
          version: 2,
          mergeCommitSha: FIXTURE_SHA,
        },
      },
      invalidInputs: [
        {
          label: "bad-confirm",
          value: {
            kbId: FIXTURE_KB_ID,
            number: 1,
            decision: "merge",
            expectedHeadSha: FIXTURE_SHA,
            expectedTargetSha: FIXTURE_SHA,
            idempotencyKey: FIXTURE_KEY,
            confirm: "DELETE",
          },
        },
      ],
    },
    knowledge_sealed_resolve: {
      validInput: {
        kbId: FIXTURE_KB_ID,
        path: FIXTURE_PATH,
        reference: sealedVector.result.reference,
        recipientKeyId: sealedVector.result.recipientKeyId,
      },
      validOutput: sealedVector.result,
      invalidInputs: [
        {
          label: "unknown-field",
          value: {
            kbId: FIXTURE_KB_ID,
            path: FIXTURE_PATH,
            reference: "r",
            recipientKeyId: FIXTURE_UUID,
            extra: 1,
          },
        },
      ],
    },
  };

  const tools = addConformanceCases(baseTools);
  tools.knowledge_embedding_profile_set!.invalidInputs.push(
    ...[-1, 0].map((revision) => ({
      label: `nonpositive-revision-${revision}`,
      value: { ...(baseTools.knowledge_embedding_profile_set!.validInput as object), revision },
    })),
  );
  tools.knowledge_embedding_profile_set!.validInputVariants.push(
    ...[BUILTIN_PROVIDER_REF.name, BUILTIN_PROVIDER_REF.id].flatMap((providerId) =>
      [undefined, 1, 99].map((revision) => ({
        label: `builtin-${providerId}-${revision ?? "omitted"}`,
        value: {
          kbId: FIXTURE_KB_ID,
          providerId,
          confirm: "RUN",
          idempotencyKey: FIXTURE_KEY,
          ...(revision === undefined ? {} : { revision }),
        },
      })),
    ),
  );

  if (Object.keys(tools).length !== KB_TOOL_NAMES.length) {
    throw new Error("fixture corpus tool count mismatch");
  }
  for (const name of KB_TOOL_NAMES) {
    if (!tools[name]) throw new Error(`missing fixtures for ${name}`);
  }
  const requestMetadata = [
    { label: "empty", value: {} },
    { label: "foreign extension", value: { extension: [1, null] } },
    ...[null, 5, [], "meta"].map((value) => ({
      label: `nonobject-${JSON.stringify(value)}`,
      value,
    })),
    ...[null, {}, true, 1.5, 2 ** 53, -(2 ** 53), "progress", 0, 2 ** 53 - 1, -(2 ** 53 - 1)].map(
      (value) => ({ label: `progress-${JSON.stringify(value)}`, value: { progressToken: value } }),
    ),
    ...[
      5,
      null,
      [],
      {},
      { taskId: 1 },
      { taskId: null },
      { taskId: "task" },
      { taskId: "task", extension: true },
    ].map((value) => ({
      label: `related-task-${JSON.stringify(value)}`,
      value: { "io.modelcontextprotocol/related-task": value },
    })),
  ].map((row) => ({ ...row, valid: requestMeta.validate(row.value).issues === undefined }));
  return { schemaVersion: KB_PROTOCOL_VERSION, requestMetadata, tools };
}

export function generateKbProtocolArtifacts(): {
  schema: KbProtocolArtifacts;
  fixtures: KbFixtureCorpus;
} {
  return { schema: buildSchemaArtifact(), fixtures: buildFixtureCorpus() };
}

export function writeKbProtocolArtifacts(directory = PROTOCOL_DIR): void {
  const { schema, fixtures } = generateKbProtocolArtifacts();
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "schema.json"), stableStringify(schema));
  writeFileSync(join(directory, "fixtures.json"), stableStringify(fixtures));
}

export function checkKbProtocolArtifacts(directory = PROTOCOL_DIR): boolean {
  try {
    const expectedSchema = stableStringify(buildSchemaArtifact());
    const expectedFixtures = stableStringify(buildFixtureCorpus());
    const onDiskSchema = readFileSync(join(directory, "schema.json"), "utf8");
    const onDiskFixtures = readFileSync(join(directory, "fixtures.json"), "utf8");
    return onDiskSchema === expectedSchema && onDiskFixtures === expectedFixtures;
  } catch {
    return false;
  }
}

const check = process.argv.includes("--check");
const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (check) {
    if (!checkKbProtocolArtifacts()) {
      console.error("kb protocol artifacts are out of date — run pnpm kb:protocol:generate");
      process.exit(1);
    }
    process.exit(0);
  }
  writeKbProtocolArtifacts();
}
