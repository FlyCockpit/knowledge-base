import { z } from "zod";

import {
  kbDescriptionSchema as metadataDescriptionSchema,
  kbNameSchema as metadataNameSchema,
  refineUnicodeScalarBounds,
} from "../../schemas";

export { countUnicodeScalars, refineUnicodeScalarBounds } from "../../schemas";

import { normalizeKbPath } from "../paths";
import { PERMISSIONS } from "../permissions";

export const KB_PROTOCOL_VERSION = "kb/1" as const;

export const KB_PAGE_DEFAULT = 20;
export const KB_PAGE_MAX = 50;
export const KB_CURSOR_MAX_BYTES = 1024;
export const PR_DETAIL_MAX_DELTAS_PER_PAGE = 200;

export const TEXT_INPUT_INLINE_MAX_BYTES = 128 * 1024;
export const TEXT_INPUT_STAGED_MAX_BYTES = 2 * 1024 * 1024;
export const DOCUMENT_MARKDOWN_MAX_BYTES = 2 * 1024 * 1024;
export const MAX_TOOL_RESPONSE_UTF8_BYTES = 8 * 1024 * 1024;

export const FRONT_MATTER_MAX_BYTES = 64 * 1024;
export const FRONT_MATTER_MAX_DEPTH = 16;

const ID_RE = /^[a-z0-9]{24,32}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const KEY_RE = /^[A-Za-z0-9_-]{16,128}$/;
const KB_SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;
const CANONICAL_BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

const DREAM_UPSERT_BODY_MAX_BYTES = 64 * 1024;

/** Closed object helper — unknown keys fail validation. */
export function closed<T extends z.ZodRawShape>(shape: T) {
  return z.object(shape).strict();
}

/**
 * Portable validation contract attached to a Zod schema node. Keys are merged
 * verbatim into the generated JSON Schema artifact: representable constraints
 * (`anyOf`/`if`/`then`/`else`/`not`/`maxLength`) are enforceable by any
 * draft-2020-12 validator; `x-kb-*` keywords are the documented portable
 * vocabulary that every consumer of the artifact must enforce. A schema that
 * carries a runtime refinement without one of these keys fails generation.
 */
export type KbContractPayload = {
  [key: `x-kb-${string}`]: unknown;
} & {
  allOf?: unknown[];
  anyOf?: unknown[];
  if?: unknown;
  then?: unknown;
  else?: unknown;
  not?: unknown;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  type?: string;
  additionalProperties?: unknown;
};

/** Registers the contract payload on the schema instance; the refinement itself must already be attached. */
export function withKbContract<T extends z.ZodType>(schema: T, payload: KbContractPayload): T {
  z.globalRegistry.add(schema, payload);
  return schema;
}

export const kbIdSchema = z.string().regex(ID_RE, "invalid Id");
export const uuidSchema = z.string().regex(UUID_RE, "invalid Uuid");
export const shaSchema = z.string().regex(SHA_RE, "invalid Sha");
export const hashSchema = z.string().regex(HASH_RE, "invalid Hash");
export const keySchema = z.string().min(16).max(128).regex(KEY_RE, "invalid Key");
/**
 * Exact instant decomposition — whole UTC seconds plus the fractional part at
 * the precision the protocol accepts (1-9 digits, trailing zeros stripped).
 * Never truncated through JavaScript milliseconds: comparing two instants must
 * preserve sub-millisecond precision.
 */
export type IsoUtcParts = { epochSeconds: number; fraction: string };

export function parseIsoUtcParts(value: string): IsoUtcParts | null {
  const match = ISO_RE.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7];
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  const epochSeconds = Date.UTC(year, month - 1, day, hour, minute, second) / 1000;
  const probe = new Date(epochSeconds * 1000);
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day ||
    probe.getUTCHours() !== hour ||
    probe.getUTCMinutes() !== minute ||
    probe.getUTCSeconds() !== second
  ) {
    return null;
  }
  return { epochSeconds, fraction: fraction ? fraction.replace(/0+$/, "") : "" };
}

/** Exact comparison of two validated instants at accepted precision: -1, 0 or 1; null when unparsable. */
export function compareIsoUtc(a: string, b: string): number | null {
  const pa = parseIsoUtcParts(a);
  const pb = parseIsoUtcParts(b);
  if (pa === null || pb === null) return null;
  if (pa.epochSeconds !== pb.epochSeconds) {
    return pa.epochSeconds < pb.epochSeconds ? -1 : 1;
  }
  const width = Math.max(pa.fraction.length, pb.fraction.length);
  const fa = pa.fraction.padEnd(width, "0");
  const fb = pb.fraction.padEnd(width, "0");
  if (fa === fb) return 0;
  return fa < fb ? -1 : 1;
}

export const isoSchema = withKbContract(
  z
    .string()
    .regex(ISO_RE, "invalid Iso")
    .superRefine((value, ctx) => {
      if (parseIsoUtcParts(value) === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "invalid Iso instant" });
      }
    }),
  { "x-kb-iso-utc-instant": true },
);

export function refineCanonicalBase64(
  value: string,
  ctx: z.RefinementCtx,
  bounds: { minBytes: number; maxBytes: number },
): void {
  if (!CANONICAL_BASE64_RE.test(value) || value.length % 4 !== 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "invalid base64" });
    return;
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "non-canonical base64" });
    return;
  }
  if (decoded.length < bounds.minBytes || decoded.length > bounds.maxBytes) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "base64 decoded length out of range",
    });
  }
}

export function canonicalBase64Schema(bounds: { minBytes: number; maxBytes: number }) {
  return withKbContract(
    z
      .string()
      .min(1)
      .superRefine((value, ctx) => {
        refineCanonicalBase64(value, ctx, bounds);
      }),
    { "x-kb-base64-canonical": { minBytes: bounds.minBytes, maxBytes: bounds.maxBytes } },
  );
}

export function utf8MaxBytes(maxBytes: number) {
  return (value: string, ctx: z.RefinementCtx) => {
    if (Buffer.byteLength(value, "utf8") > maxBytes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "exceeds UTF-8 byte limit",
      });
    }
  };
}

/** Bounded string whose byte limit is exported to the artifact as `x-kb-utf8-max-bytes`. */
function utf8BoundedString(maxBytes: number, payload: KbContractPayload = {}) {
  return withKbContract(z.string().superRefine(utf8MaxBytes(maxBytes)), {
    "x-kb-utf8-max-bytes": maxBytes,
    ...payload,
  });
}

/**
 * Bounded string whose character limits count Unicode scalar values — exactly
 * the semantics of the exported `minLength`/`maxLength`. Zod's own `.min()` /
 * `.max()` count UTF-16 code units and must not be used for character bounds.
 */
export function unicodeBoundedString(bounds: {
  min?: number;
  max?: number;
  postgresText?: boolean;
}) {
  const payload: KbContractPayload = {};
  if (bounds.min !== undefined) payload.minLength = bounds.min;
  if (bounds.max !== undefined) payload.maxLength = bounds.max;
  if (bounds.postgresText) payload.pattern = "^[^\\u0000]*$";
  return withKbContract(
    z.string().superRefine((value, ctx) => {
      refineUnicodeScalarBounds(value, ctx, bounds);
      if (bounds.postgresText && value.includes("\0"))
        ctx.addIssue({ code: "custom", message: "NUL is not valid PostgreSQL text" });
    }),
    payload,
  );
}

/** Metadata uses the same browser-safe validation in every transport. */
export const kbNameSchema = withKbContract(metadataNameSchema, {
  minLength: 1,
  maxLength: 120,
  "x-kb-metadata-text": "name",
});
export const kbDescriptionSchema = withKbContract(metadataDescriptionSchema, {
  minLength: 10,
  maxLength: 2000,
  "x-kb-metadata-text": "description",
});

export const pathSchema = withKbContract(
  z.string().superRefine((value, ctx) => {
    const normalized = normalizeKbPath(value);
    if (!normalized.ok) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: normalized.issue.message });
    }
  }),
  { "x-kb-path": true },
);

/**
 * L-22: a path prefix is a raw prefix of document paths and may end with one
 * `/` (`notes/` lists only the `notes` directory, `notes` also `notes-old.md`);
 * the part before that slash must be a valid path.
 */
export const pathPrefixSchema = withKbContract(
  z.string().superRefine((value, ctx) => {
    const normalized = normalizeKbPath(value.endsWith("/") ? value.slice(0, -1) : value);
    if (!normalized.ok) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: normalized.issue.message });
    }
  }),
  { "x-kb-path-prefix": true },
);

export const safeIntSchema = z.number().int().safe();

export const pageInputSchema = closed({
  limit: z.number().int().min(1).max(KB_PAGE_MAX).optional(),
  cursor: unicodeBoundedString({ max: KB_CURSOR_MAX_BYTES }).nullable().optional(),
});

export function pageOutputSchema<T extends z.ZodTypeAny>(item: T) {
  return closed({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  });
}

export const kbBaseInputSchema = closed({
  kbId: kbIdSchema,
});

export const kbRevInputSchema = kbBaseInputSchema.extend({
  rev: shaSchema.optional(),
});

export const kbMutationInputSchema = kbBaseInputSchema.extend({
  baseRevision: shaSchema,
  idempotencyKey: keySchema,
});

/**
 * The input of every content write (one that publishes a commit and answers
 * with an ApplyResult): the mutation base plus the proposal it targets.
 * The single source for that field; a catalog test pins every such tool to it.
 */
export const kbContentWriteInputSchema = kbMutationInputSchema.extend({
  proposalNumber: safeIntSchema.min(1).optional(),
  /**
   * The head of the caller's pull request this write was prepared against.
   * Required with proposalNumber to overwrite any PR-changed path,
   * including fresh/recorded conflicts and writes based on the PR head.
   * Whenever given, a PR that moved since is CONFLICT.
   */
  proposalHeadSha: shaSchema.optional(),
});

export const kbMetadataMutationInputSchema = kbBaseInputSchema.extend({
  metadataVersion: safeIntSchema,
  idempotencyKey: keySchema,
});

export const textInputMarkdownSchema = closed({
  markdown: withKbContract(
    z.string().superRefine((markdown, ctx) => {
      refineUnicodeScalarBounds(markdown, ctx, { max: TEXT_INPUT_INLINE_MAX_BYTES });
      utf8MaxBytes(TEXT_INPUT_INLINE_MAX_BYTES)(markdown, ctx);
      for (let i = 0; i < markdown.length; i++) {
        const code = markdown.charCodeAt(i);
        if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "markdown contains disallowed control characters",
          });
          return;
        }
      }
    }),
    {
      maxLength: TEXT_INPUT_INLINE_MAX_BYTES,
      "x-kb-utf8-max-bytes": TEXT_INPUT_INLINE_MAX_BYTES,
      "x-kb-no-control-chars": true,
    },
  ),
});

export const textInputUploadSchema = closed({
  uploadId: uuidSchema,
});

export const textInputSchema = z.union([textInputMarkdownSchema, textInputUploadSchema]);

export const permissionSchema = z.enum(PERMISSIONS);
export const writeModeSchema = z.enum(["direct", "proposal_required", "read_only"]);
export const indexStateSchema = z.enum([
  "PENDING",
  "BUILDING",
  "INDEXING",
  "COMPLETE",
  "FAILED",
  "SUPERSEDED",
]);
export const freshnessSchema = z.enum(["current", "stale", "building", "failed", "unavailable"]);

export const kbAttachmentSchema = closed({
  id: kbIdSchema,
  name: kbNameSchema,
  slug: z.string().regex(KB_SLUG_RE).max(63),
  description: kbDescriptionSchema,
  defaultBranch: z.literal("main"),
  headSha: shaSchema,
  metadataVersion: safeIntSchema,
  capabilities: z.array(permissionSchema),
  writeMode: writeModeSchema,
  embeddingGeneration: kbIdSchema.nullable(),
  attachmentLocator: unicodeBoundedString({ min: 1, max: 2048 }),
  sealedNamespace: uuidSchema,
});

export const indexStatusSchema = closed({
  activeGenerationId: kbIdSchema.nullable(),
  desiredGenerationId: kbIdSchema.nullable(),
  desiredEpoch: z.string(),
  activeState: indexStateSchema.nullable(),
  desiredState: indexStateSchema.nullable(),
  indexedCommitSha: shaSchema.nullable(),
  headSha: shaSchema,
  dimensions: safeIntSchema.nullable(),
  fingerprint: hashSchema.nullable(),
  freshness: freshnessSchema,
  errorCode: z.string().nullable(),
  /**
   * The active generation was built under previous built-in embedder
   * settings (still query-compatible) or an older model identity (lexical-only);
   * a sequential rebuild is pending. EMBEDDING_RUNTIME_RELOADING = the
   * built-in runtime is briefly stopped for a config load probe (lexical-only).
   */
  rebuildPending: z
    .enum(["EMBEDDING_SETTINGS_CHANGED", "EMBEDDING_MODEL_CHANGED", "EMBEDDING_RUNTIME_RELOADING"])
    .nullable(),
});

/**
 * Machine-readable notice on every search page, including queryless
 * structured pages: the served index uses previous embedding settings or model
 * identity, or the built-in runtime is stopped for a config load probe.
 * The transport's human warning describes the actual search mode.
 */
export const indexNoticeSchema = z.union([
  closed({
    kbId: kbIdSchema,
    code: z.literal("EMBEDDING_REBUILD_PENDING"),
    detail: z.enum([
      "EMBEDDING_SETTINGS_CHANGED",
      "EMBEDDING_MODEL_CHANGED",
      "EMBEDDING_RUNTIME_RELOADING",
    ]),
  }),
  /**
   * The KB was searched over its lexical-only (FTS5) generation because it has no
   * embedding profile, its profile can no longer embed (revoked, or otherwise unusable),
   * or its hybrid generation is still being built.
   */
  closed({
    kbId: kbIdSchema,
    code: z.literal("LEXICAL_ONLY"),
    detail: z.enum([
      "NO_EMBEDDING_PROFILE",
      "EMBEDDING_PROFILE_REVOKED",
      "EMBEDDING_PROFILE_UNAVAILABLE",
      /** A healthy profile's first (or next) hybrid generation is still being built. */
      "SEMANTIC_INDEX_BUILDING",
    ]),
  }),
]);
export type IndexNotice = z.infer<typeof indexNoticeSchema>;

/**
 * An embedding provider: a registered provider ID, or `builtin` for the
 * built-in local model (a local store reports its built-in as `builtin`).
 */
export const providerRefSchema = z.union([kbIdSchema, z.literal("builtin")]);

/** Registry identity is private storage detail; inputs use one logical built-in. */
export const BUILTIN_PROVIDER_REF = { id: "builtinembeddingmodel000", name: "builtin" } as const;
export function canonicalProviderRef(id: string): string {
  return id === BUILTIN_PROVIDER_REF.id ? BUILTIN_PROVIDER_REF.name : id;
}

export const providerSummarySchema = closed({
  providerId: providerRefSchema,
  revision: safeIntSchema,
  kind: z.enum(["OPENAI_COMPAT", "SYSTEM_BUILTIN"]),
  name: unicodeBoundedString({ min: 1, max: 200 }),
  model: unicodeBoundedString({ min: 1, max: 200 }),
  dimensions: safeIntSchema,
  contextTokens: safeIntSchema.nullable(),
  status: z.enum(["ready", "revoked", "unavailable"]),
});

export const docCitationSchema = closed({
  label: unicodeBoundedString({ max: 240 }),
  target: unicodeBoundedString({ max: 2048 }),
});

export const TRUSTED_MIME_TYPES = [
  "text/markdown",
  "text/plain",
  "text/csv",
  "application/json",
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "audio/mpeg",
  "audio/wav",
  "audio/ogg",
  "video/mp4",
  "video/webm",
] as const;

export const mimeSchema = z.enum(TRUSTED_MIME_TYPES);

/**
 * MIME types `knowledge_upload_begin` admits: Markdown plus the sniffable CAS
 * media set (`CAS_SNIFF_MIME_TYPES` in `lib/sniff-mime.ts`, kept equal by
 * `uploads.test.ts`). Types the trusted boundary refuses (SVG, HTML, plain
 * text, CSV, JSON) are not advertised.
 */
export const UPLOAD_MIME_TYPES = [
  "text/markdown",
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "audio/mpeg",
  "audio/wav",
  "audio/ogg",
  "video/mp4",
  "video/webm",
] as const satisfies readonly (typeof TRUSTED_MIME_TYPES)[number][];

export const assetRefSchema = closed({
  path: pathSchema,
  hash: hashSchema,
  size: safeIntSchema.min(0),
  mime: mimeSchema,
});

function jsonValueDepth(value: unknown, depth = 0): number {
  if (depth > FRONT_MATTER_MAX_DEPTH) return depth;
  if (value === null || typeof value !== "object") return depth;
  if (Array.isArray(value)) {
    let max = depth;
    for (const item of value) {
      max = Math.max(max, jsonValueDepth(item, depth + 1));
    }
    return max;
  }
  let max = depth;
  for (const v of Object.values(value as Record<string, unknown>)) {
    max = Math.max(max, jsonValueDepth(v, depth + 1));
  }
  return max;
}

/** JSON Schema for the bounded citations array — generated from the authoritative Zod shape so it cannot drift. */
const frontMatterCitationsFragment = (() => {
  const { $schema: _stripped, ...fragment } = z.toJSONSchema(
    z.array(docCitationSchema).max(100),
  ) as Record<string, unknown>;
  return fragment;
})();

/** Validate JSON dictionaries without rebuilding through Zod's reserved-key-dropping record decoder. */
function ownKeyDictionary<T extends z.ZodType>(valueSchema: T) {
  const schema = z.unknown().superRefine((value, ctx) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      ctx.addIssue({ code: "custom", message: "expected a JSON object" });
      return;
    }
    for (const [key, cell] of Object.entries(value)) {
      const parsed = valueSchema.safeParse(cell);
      if (!parsed.success)
        for (const issue of parsed.error.issues)
          ctx.addIssue({ ...issue, path: [key, ...issue.path] });
    }
  });
  const { $schema: _stripped, ...additionalProperties } = z.toJSONSchema(valueSchema);
  // The refinement establishes this type and retains every enumerable own JSON key.
  // No assignment to a plain object (and hence no __proto__ setter) occurs here.
  return withKbContract(schema, { type: "object", additionalProperties }) as z.ZodType<
    Record<string, z.output<T>>
  >;
}

/** Bounded front matter — only explicitly open object in the protocol. */
export const frontMatterSchema = withKbContract(
  ownKeyDictionary(z.unknown()).superRefine((value, ctx) => {
    const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
    if (bytes > FRONT_MATTER_MAX_BYTES) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "frontMatter exceeds byte budget" });
    }
    if (jsonValueDepth(value) > FRONT_MATTER_MAX_DEPTH) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "frontMatter exceeds depth budget" });
    }
    const citations = (value as { citations?: unknown }).citations;
    if (citations !== undefined) {
      const parsed = z.array(docCitationSchema).max(100).safeParse(citations);
      if (!parsed.success) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "invalid citations in frontMatter" });
      }
    }
  }),
  {
    "x-kb-json-encoded-max-bytes": FRONT_MATTER_MAX_BYTES,
    "x-kb-json-depth-max": FRONT_MATTER_MAX_DEPTH,
    if: { properties: { citations: true }, required: ["citations"] },
    // biome-ignore lint/suspicious/noThenProperty: JSON Schema conditional keyword, not a thenable.
    then: { properties: { citations: frontMatterCitationsFragment } },
  },
);

export const structuredRowSchema = ownKeyDictionary(
  z.union([unicodeBoundedString({ max: 1024 }), z.boolean(), z.null(), z.number().finite()]),
);

export const documentSchema = closed({
  path: pathSchema,
  documentId: unicodeBoundedString({ max: 256 }).nullable(),
  markdown: utf8BoundedString(DOCUMENT_MARKDOWN_MAX_BYTES),
  frontMatter: frontMatterSchema,
  commitSha: shaSchema,
  blobSha: shaSchema,
  contentHash: hashSchema,
  documentCitations: z.array(docCitationSchema),
  assetRefs: z.array(assetRefSchema),
});

export const citationSpanSchema = closed({
  startToken: safeIntSchema.min(0),
  endToken: safeIntSchema.min(0),
  startByte: safeIntSchema.min(0),
  endByte: safeIntSchema.min(0),
});

export const CITATION_SNIPPET_MAX_SCALARS = 240;

/** CONTRACT: snippet is capped at Unicode scalar values, like every bounded string. */
const citationSnippetSchema = unicodeBoundedString({ max: CITATION_SNIPPET_MAX_SCALARS });

export const citationHitSchema = closed({
  knowledgeBaseId: kbIdSchema,
  knowledgeBaseName: unicodeBoundedString({ min: 1, max: 120 }),
  path: pathSchema,
  documentId: unicodeBoundedString({ max: 256 }).nullable(),
  commitSha: shaSchema,
  blobSha: shaSchema,
  contentHash: hashSchema,
  chunkIndex: safeIntSchema.min(0),
  span: citationSpanSchema,
  snippet: citationSnippetSchema,
  score: z.number().finite(),
  mode: z.enum(["hybrid", "structured", "lexical"]),
  indexGenerationId: kbIdSchema,
  freshness: freshnessSchema,
  documentCitations: z.array(docCitationSchema),
  assetRefs: z.array(assetRefSchema),
  matchedRow: structuredRowSchema.nullable(),
});

export const prSummarySchema = closed({
  number: safeIntSchema.min(1),
  title: unicodeBoundedString({ max: 200 }),
  sourceBranch: unicodeBoundedString({ min: 1, max: 256 }),
  targetBranch: z.literal("main"),
  baseSha: shaSchema,
  headSha: shaSchema,
  targetSha: shaSchema,
  status: z.enum(["OPEN", "CONFLICT", "CLOSED", "MERGED"]),
  authorActorKey: unicodeBoundedString({ min: 1, max: 256 }),
  version: safeIntSchema.min(1),
  mergeCommitSha: shaSchema.nullable(),
});

export const fileDeltaSchema = closed({
  path: pathSchema,
  status: z.enum(["added", "modified", "deleted"]),
  beforeBlobSha: shaSchema.nullable(),
  afterBlobSha: shaSchema.nullable(),
});

export const assetDeltaSchema = closed({
  path: pathSchema,
  before: assetRefSchema.nullable(),
  after: assetRefSchema.nullable(),
});

/**
 * L-22: a non-blocking note about an applied change. An asset was removed
 * while documents of the resulting tree still link to it (their images or
 * links now dangle); `referencedBy` lists up to 20 of them.
 */
export const applyWarningSchema = closed({
  code: z.literal("ASSET_STILL_REFERENCED"),
  path: pathSchema,
  referencedBy: z.array(pathSchema).min(1).max(20),
});

export type ApplyWarning = z.infer<typeof applyWarningSchema>;

export const applyResultSchema = closed({
  operationId: uuidSchema,
  kind: z.enum(["applied", "proposed", "noop"]),
  commitSha: shaSchema,
  baseRevision: shaSchema,
  proposal: prSummarySchema.nullable(),
  changedPaths: z.array(pathSchema),
  sourceSessionIds: z.array(uuidSchema),
  indexJobId: uuidSchema.nullable(),
  /** Present only when there is something to warn about. */
  warnings: z.array(applyWarningSchema).min(1).max(32).optional(),
});

export const dreamMetadataSchema = closed({
  model: closed({
    provider: unicodeBoundedString({ min: 1, max: 120 }),
    model: unicodeBoundedString({ min: 1, max: 200 }),
  }),
  redactionApplied: z.literal(true),
  upserts: z
    .array(
      closed({
        id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,127}$/),
        type: unicodeBoundedString({ min: 1, max: 128 }),
        title: unicodeBoundedString({ max: 200 }).nullable(),
        body: utf8BoundedString(DREAM_UPSERT_BODY_MAX_BYTES),
        citations: z.array(docCitationSchema).max(100),
        provenance: z.literal("dream"),
      }),
    )
    .max(8),
});

export const changeCreateSchema = closed({
  op: z.literal("create"),
  path: pathSchema,
  content: textInputSchema,
});

export const changeReplaceSchema = closed({
  op: z.literal("replace"),
  path: pathSchema,
  content: textInputSchema,
});

export const changeDeleteSchema = closed({
  op: z.literal("delete"),
  path: pathSchema,
});

export const changeAssetPutSchema = closed({
  op: z.literal("assetPut"),
  path: pathSchema,
  uploadId: uuidSchema,
});

export const changeAssetRemoveSchema = closed({
  op: z.literal("assetRemove"),
  path: pathSchema,
});

export const changeSchema = z.discriminatedUnion("op", [
  changeCreateSchema,
  changeReplaceSchema,
  changeDeleteSchema,
  changeAssetPutSchema,
  changeAssetRemoveSchema,
]);

export const deleteConfirmSchema = z.literal("DELETE");
export const runConfirmSchema = z.literal("RUN");
export const mergeConfirmSchema = z.literal("MERGE");

/** Budget for the full MCP JSON-RPC payload that carries a CallToolResult. */
export function assertToolResponseUtf8Budget(callToolResult: unknown): void {
  const rpc = { jsonrpc: "2.0", id: 1, result: callToolResult };
  const bytes = Buffer.byteLength(JSON.stringify(rpc), "utf8");
  if (bytes > MAX_TOOL_RESPONSE_UTF8_BYTES) {
    throw new Error("tool response exceeds encoded size budget");
  }
}
