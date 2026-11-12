import { z } from "zod";

import {
  assertToolResponseUtf8Budget,
  closed,
  indexStateSchema,
  KB_PROTOCOL_VERSION,
  kbIdSchema,
  safeIntSchema,
  shaSchema,
} from "./common";

export const KB_PROTOCOL_ERROR_CODES = [
  "INVALID_ARGUMENT",
  "INVALID_CURSOR",
  "NOT_FOUND",
  "FORBIDDEN",
  "CONFLICT",
  "IDEMPOTENCY_MISMATCH",
  "RATE_LIMITED",
  "QUOTA_EXCEEDED",
  "INDEX_UNAVAILABLE",
  "STORAGE_UNAVAILABLE",
  "SENSITIVE_QUERY",
  "EMBEDDING_INPUT_TOO_LONG",
  "UPLOAD_INCOMPLETE",
  "UPLOAD_EXPIRED",
  "UNRESOLVED_REFERENCE",
  "CANCELLED",
  "DEADLINE_EXCEEDED",
  "REPAIR_REQUIRED",
  "INTERNAL",
] as const;

export type KbProtocolErrorCode = (typeof KB_PROTOCOL_ERROR_CODES)[number];

export const KB_RETRYABLE_ERROR_CODES = new Set<KbProtocolErrorCode>([
  "RATE_LIMITED",
  "STORAGE_UNAVAILABLE",
  "INDEX_UNAVAILABLE",
  "DEADLINE_EXCEEDED",
]);

export const TOO_MANY_CHANGES_MESSAGE =
  "At most 32 changes per call. Each call commits on success: apply the first 32 now, then send the rest in another call using the returned commit as baseRevision.";

export const KB_ERROR_MESSAGES: Record<KbProtocolErrorCode, string> = {
  INVALID_ARGUMENT: "Invalid argument",
  INVALID_CURSOR: "Invalid cursor",
  NOT_FOUND: "Not found",
  FORBIDDEN: "Forbidden",
  CONFLICT: "Conflict",
  IDEMPOTENCY_MISMATCH: "Idempotency mismatch",
  RATE_LIMITED: "Rate limited",
  QUOTA_EXCEEDED: "Quota exceeded",
  INDEX_UNAVAILABLE: "Index unavailable",
  STORAGE_UNAVAILABLE: "Storage unavailable",
  SENSITIVE_QUERY: "Sensitive query rejected",
  EMBEDDING_INPUT_TOO_LONG: "Embedding input too long",
  UPLOAD_INCOMPLETE: "Upload incomplete",
  UPLOAD_EXPIRED: "Upload expired",
  UNRESOLVED_REFERENCE: "Unresolved reference",
  CANCELLED: "Cancelled",
  DEADLINE_EXCEEDED: "Deadline exceeded",
  REPAIR_REQUIRED: "Repair required",
  INTERNAL: "Internal error",
};

const conflictDetailsSchema = closed({
  headSha: shaSchema,
  proposalNumber: safeIntSchema.nullable(),
});

/**
 * Why an argument was refused (additive): a closed, non-sensitive code
 * plus, where known, a JSON pointer into the tool arguments. A pointer never
 * echoes arbitrary caller text: every segment is an identifier or an index.
 */
export const KB_INVALID_ARGUMENT_REASONS = [
  "SCHEMA",
  "UNKNOWN_ARGUMENT",
  "MISSING_ARGUMENT",
  "TOO_MANY_CHANGES",
  "CONFIRM_REQUIRED",
  "INVALID_PREFIX",
  "QUERY_TOO_LONG",
  "LIMIT_OUT_OF_RANGE",
  "INVALID_PATH",
  "RESERVED_PATH",
  "PATH_CASE_COLLISION",
  "PATH_NOT_FOUND",
  "NOT_MARKDOWN_PATH",
  "INVALID_FRONT_MATTER",
  "CONTROL_CHARACTER",
  "INVALID_MARKDOWN",
  "DUPLICATE_DOCUMENT_ID",
  "SEALED_REFERENCE_REVOKED",
  "TOO_LARGE",
] as const;
export type KbInvalidArgumentReason = (typeof KB_INVALID_ARGUMENT_REASONS)[number];

/** RFC 6901 pointer, identifier/index segments only, at most 8 deep. */
export const KB_FIELD_POINTER_RE = /^(\/[A-Za-z0-9_]{1,64}){1,8}$/;
const fieldPointerSchema = z.string().regex(KB_FIELD_POINTER_RE);

/**
 * `min` / `max`: the inclusive bound a too-short, too-long, too-few,
 * too-many or out-of-range value broke (e.g. `changes` at most 32), so a
 * caller can correct it without re-reading the tool schema.
 */
const invalidArgumentDetailsSchema = closed({
  reason: z.enum(KB_INVALID_ARGUMENT_REASONS),
  field: fieldPointerSchema.optional(),
  min: safeIntSchema.optional(),
  max: safeIntSchema.optional(),
});

/**
 * Why a write met stored state it cannot apply to (additive): creating
 * a path that already exists, a profile revision that is not the provider's
 * usable one, upload bytes or a content hash that disagree with what the
 * upload already holds, or an upload that no longer takes writes.
 */
export const KB_CONFLICT_REASONS = [
  "PATH_EXISTS",
  "REVISION_NOT_CURRENT",
  "CONTENT_HASH_MISMATCH",
  "UPLOAD_BYTES_MISMATCH",
  "UPLOAD_NOT_WRITABLE",
] as const;
export type KbConflictReason = (typeof KB_CONFLICT_REASONS)[number];

const reasonedConflictDetailsSchema = closed({
  reason: z.enum(KB_CONFLICT_REASONS),
  field: fieldPointerSchema.optional(),
});

/** Most conflicted paths a PROPOSAL_CONFLICT lists. */
export const PROPOSAL_CONFLICT_MAX_PATHS = 50;
/** Combined UTF-8 budget of the inline base/theirs/yours contents. */
export const PROPOSAL_CONFLICT_CONTENT_MAX_BYTES = 256 * 1024;

/**
 * A proposal that no longer applies to main and was not resolved by the
 * update. `headSha` is current main (propose against it again, writing
 * each conflicted path in full); `baseSha` the proposal's merge base and
 * `proposalHeadSha` its head. Contents are inline when they fit the budget;
 * otherwise all null and readable with documents_get at those revisions.
 */
const proposalConflictDetailsSchema = closed({
  headSha: shaSchema,
  proposalNumber: safeIntSchema,
  reason: z.literal("PROPOSAL_CONFLICT"),
  baseSha: shaSchema,
  proposalHeadSha: shaSchema,
  contentIncluded: z.boolean(),
  paths: z
    .array(
      closed({
        path: z.string().min(1).max(4096),
        /** What resolves it: document operations or asset operations. */
        kind: z.enum(["document", "asset"]),
        base: z.string().nullable(),
        theirs: z.string().nullable(),
        yours: z.string().nullable(),
        /** The exact revisions the three versions were read at (readable while recorded). */
        baseSha: shaSchema,
        theirsSha: shaSchema,
        yoursSha: shaSchema,
      }),
    )
    .min(1)
    .max(PROPOSAL_CONFLICT_MAX_PATHS),
});

const indexDetailsSchema = closed({
  generationId: kbIdSchema.nullable(),
  state: indexStateSchema,
});

const rateLimitDetailsSchema = closed({
  retryAfterSeconds: safeIntSchema.min(1),
});

const emptyErrorDetailsSchema = closed({});

/**
 * A document read of a path the revision doesn't hold, told apart
 * from an unknown KB, PR or revision, which keep empty details.
 */
const pathNotFoundDetailsSchema = closed({
  reason: z.literal("PATH_NOT_FOUND"),
  field: fieldPointerSchema.optional(),
});

export const kbErrorDetailsSchema = z.union([
  emptyErrorDetailsSchema,
  conflictDetailsSchema,
  indexDetailsSchema,
  rateLimitDetailsSchema,
  invalidArgumentDetailsSchema,
  reasonedConflictDetailsSchema,
  proposalConflictDetailsSchema,
  pathNotFoundDetailsSchema,
]);

function errorDetailsSchemaForCode(code: KbProtocolErrorCode): z.ZodTypeAny {
  switch (code) {
    case "INVALID_ARGUMENT":
      return z.union([emptyErrorDetailsSchema, invalidArgumentDetailsSchema]);
    case "CONFLICT":
      return z.union([
        emptyErrorDetailsSchema,
        conflictDetailsSchema,
        reasonedConflictDetailsSchema,
        proposalConflictDetailsSchema,
      ]);
    case "INDEX_UNAVAILABLE":
      return z.union([emptyErrorDetailsSchema, indexDetailsSchema]);
    case "RATE_LIMITED":
      return z.union([emptyErrorDetailsSchema, rateLimitDetailsSchema]);
    case "NOT_FOUND":
      return z.union([emptyErrorDetailsSchema, pathNotFoundDetailsSchema]);
    default:
      return emptyErrorDetailsSchema;
  }
}

export function parseKbErrorDetailsForCode(
  code: KbProtocolErrorCode,
  details: unknown,
): z.infer<typeof kbErrorDetailsSchema> {
  const parsed = errorDetailsSchemaForCode(code).safeParse(details);
  if (!parsed.success) {
    throw new Error("invalid kb protocol error details");
  }
  return parsed.data as z.infer<typeof kbErrorDetailsSchema>;
}

export const kbProtocolErrorSchema = closed({
  code: z.enum(KB_PROTOCOL_ERROR_CODES),
  message: z.string(),
  retryable: z.boolean(),
  details: kbErrorDetailsSchema,
}).superRefine((value, ctx) => {
  if (value.message !== kbProtocolMessageForCode(value.code, value.details)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "message must match error code",
      path: ["message"],
    });
  }
  if (value.retryable !== KB_RETRYABLE_ERROR_CODES.has(value.code)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "retryable must match error code",
      path: ["retryable"],
    });
  }
});

export const kbSuccessEnvelopeSchema = <T extends z.ZodTypeAny>(data: T) =>
  closed({
    schemaVersion: z.literal(KB_PROTOCOL_VERSION),
    data,
  });

export const kbErrorEnvelopeSchema = closed({
  schemaVersion: z.literal(KB_PROTOCOL_VERSION),
  error: kbProtocolErrorSchema,
});

export type KbCallToolSuccess<T> = {
  isError: false;
  structuredContent: { schemaVersion: typeof KB_PROTOCOL_VERSION; data: T };
  /** The JSON envelope first; optional one-line human-readable warnings after it. */
  content: [{ type: "text"; text: string }, ...Array<{ type: "text"; text: string }>];
};

export type KbCallToolFailure = {
  isError: true;
  structuredContent: {
    schemaVersion: typeof KB_PROTOCOL_VERSION;
    error: z.infer<typeof kbProtocolErrorSchema>;
  };
  content: [{ type: "text"; text: string }];
};

export function kbProtocolMessageForCode(code: KbProtocolErrorCode, details?: unknown): string {
  if (
    code === "INVALID_ARGUMENT" &&
    details !== null &&
    typeof details === "object" &&
    "reason" in details &&
    details.reason === "TOO_MANY_CHANGES"
  )
    return TOO_MANY_CHANGES_MESSAGE;
  return KB_ERROR_MESSAGES[code];
}

export function kbProtocolRetryable(code: KbProtocolErrorCode): boolean {
  return KB_RETRYABLE_ERROR_CODES.has(code);
}

function finalizeCallToolResult<T extends KbCallToolSuccess<unknown> | KbCallToolFailure>(
  result: T,
): T {
  assertToolResponseUtf8Budget(result);
  return result;
}

export function buildKbSuccessCallToolResult<T>(
  data: T,
  warnings: readonly string[] = [],
): KbCallToolSuccess<T> {
  const envelope = { schemaVersion: KB_PROTOCOL_VERSION, data };
  const text = JSON.stringify(envelope);
  return finalizeCallToolResult({
    isError: false,
    structuredContent: envelope,
    content: [
      { type: "text", text },
      ...warnings.map((warning) => ({ type: "text" as const, text: warning })),
    ],
  });
}

export function buildKbErrorCallToolResult(
  code: KbProtocolErrorCode,
  details: unknown = {},
): KbCallToolFailure {
  // Every INVALID_ARGUMENT says why; a refusal without a narrower reason is SCHEMA.
  const reasoned =
    code === "INVALID_ARGUMENT" &&
    (details === null ||
      (typeof details === "object" && Object.keys(details as object).length === 0))
      ? { reason: "SCHEMA" }
      : details;
  const validatedDetails = parseKbErrorDetailsForCode(code, reasoned);
  const envelope = {
    schemaVersion: KB_PROTOCOL_VERSION,
    error: {
      code,
      message: kbProtocolMessageForCode(code, validatedDetails),
      retryable: kbProtocolRetryable(code),
      details: validatedDetails,
    },
  };
  const text = JSON.stringify(envelope);
  return finalizeCallToolResult({
    isError: true,
    structuredContent: envelope,
    content: [{ type: "text", text }],
  });
}

export function assertMatchingToolTextEnvelope(
  result: KbCallToolSuccess<unknown> | KbCallToolFailure,
): void {
  const fromText = JSON.parse(result.content[0]!.text);
  if (JSON.stringify(fromText) !== JSON.stringify(result.structuredContent)) {
    throw new Error("structuredContent and text envelope mismatch");
  }
  if (fromText.schemaVersion !== KB_PROTOCOL_VERSION) {
    throw new Error("invalid schemaVersion discriminator");
  }
}
