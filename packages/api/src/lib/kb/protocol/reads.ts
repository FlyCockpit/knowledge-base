import { z } from "zod";

import {
  assetDeltaSchema,
  assetRefSchema,
  canonicalBase64Schema,
  citationHitSchema,
  closed,
  compareIsoUtc,
  documentSchema,
  fileDeltaSchema,
  freshnessSchema,
  hashSchema,
  indexNoticeSchema,
  indexStatusSchema,
  isoSchema,
  kbAttachmentSchema,
  kbBaseInputSchema,
  kbIdSchema,
  kbRevInputSchema,
  keySchema,
  PR_DETAIL_MAX_DELTAS_PER_PAGE,
  pageInputSchema,
  pageOutputSchema,
  pathPrefixSchema,
  pathSchema,
  providerSummarySchema,
  prSummarySchema,
  SEARCH_ALL_MAX_BASES,
  SEARCH_ALL_MAX_PER_BASE,
  SEARCH_ALL_MAX_RESULTS,
  safeIntSchema,
  shaSchema,
  unicodeBoundedString,
  uuidSchema,
  withKbContract,
} from "./common";

const transferChunkBase64Schema = canonicalBase64Schema({ minBytes: 1, maxBytes: 196_608 });

const sealedEnvelopeSchema = closed({
  algorithm: z.literal("X25519-HKDF-SHA256-AES256GCM"),
  ephemeralPublicKey: canonicalBase64Schema({ minBytes: 32, maxBytes: 32 }),
  nonce: canonicalBase64Schema({ minBytes: 12, maxBytes: 12 }),
  ciphertext: canonicalBase64Schema({ minBytes: 16, maxBytes: 65_536 }),
});

const documentListItemSchema = closed({
  path: pathSchema,
  documentId: unicodeBoundedString({ max: 256 }).nullable(),
  commitSha: shaSchema,
  blobSha: shaSchema,
  size: safeIntSchema.min(0),
});

/** Why a background export build ended FAILED. */
export const EXPORT_FAILURE_CODES = [
  "DEADLINE_EXCEEDED",
  "INTERRUPTED",
  "QUOTA_EXCEEDED",
  "ACCESS_DENIED",
  "REVISION_NOT_FOUND",
  "INVALID_CONTENT",
  "STORAGE_UNAVAILABLE",
] as const;
export type ExportFailureCode = (typeof EXPORT_FAILURE_CODES)[number];

/** A background export job. Bytes are downloadable only while `state` is "ready". */
export const exportJobSchema = closed({
  operationId: uuidSchema,
  transferId: uuidSchema,
  kind: z.enum(["assets", "whole"]),
  rev: shaSchema,
  state: z.enum(["pending", "building", "ready", "failed", "cancelled", "expired"]),
  /** Content bytes written of the total (null until the inventory is known). */
  progress: closed({
    doneBytes: safeIntSchema.min(0),
    totalBytes: safeIntSchema.min(0).nullable(),
  }),
  size: safeIntSchema.min(0).nullable(),
  contentHash: hashSchema.nullable(),
  expiresAt: isoSchema.nullable(),
  error: closed({
    code: z.enum(EXPORT_FAILURE_CODES),
    message: z.string().min(1).max(200),
  }).nullable(),
  mime: z.literal("application/zip"),
});

/**
 * How one base of a knowledge_search_all call ended. `ok` and `lexical_only` were searched
 * (keyword arm only for the latter); `rebuilding` has no index to serve while its first or next
 * build runs; `unavailable` could not be searched now; `rate_limited` spent its per-base query
 * budget; `deadline` did not finish (or start) before the call's one shared deadline;
 * `not_found` is a base that does not exist or that this credential cannot read (the two are
 * never told apart).
 */
export const SEARCH_ALL_BASE_STATUSES = [
  "ok",
  "lexical_only",
  "rebuilding",
  "unavailable",
  "rate_limited",
  "deadline",
  "not_found",
] as const;

const searchAllBaseSchema = closed({
  kbId: kbIdSchema,
  status: z.enum(SEARCH_ALL_BASE_STATUSES),
  /** Hits this base contributed to `results`. */
  hitCount: safeIntSchema.min(0).max(SEARCH_ALL_MAX_PER_BASE),
  /** Set only for a searched base (`ok` / `lexical_only`); null otherwise. */
  generationId: kbIdSchema.nullable(),
  freshness: freshnessSchema.nullable(),
  indexedCommitSha: shaSchema.nullable(),
  headSha: shaSchema.nullable(),
  indexNotices: z.array(indexNoticeSchema).max(1),
  /** Set only for `rate_limited`. */
  retryAfterSeconds: safeIntSchema.min(1).nullable(),
});

/** One merged hit: a knowledge_search hit plus its rank (1 = best) inside its own base. */
export const searchAllHitSchema = citationHitSchema.extend({
  rank: safeIntSchema.min(1).max(SEARCH_ALL_MAX_PER_BASE),
});

export const kbReadToolSchemas = {
  knowledge_bases_list: {
    input: pageInputSchema,
    output: pageOutputSchema(kbAttachmentSchema),
  },
  knowledge_bases_get: {
    input: kbBaseInputSchema,
    output: closed({
      kb: kbAttachmentSchema,
      index: indexStatusSchema,
    }),
  },
  knowledge_documents_list: {
    input: kbRevInputSchema.merge(pageInputSchema).merge(
      closed({
        prefix: pathPrefixSchema.optional(),
      }),
    ),
    output: pageOutputSchema(documentListItemSchema),
  },
  knowledge_documents_get: {
    input: kbRevInputSchema.merge(
      closed({
        path: pathSchema,
      }),
    ),
    output: documentSchema,
  },
  knowledge_search: {
    input: kbBaseInputSchema.merge(
      closed({
        query: unicodeBoundedString({ min: 1, max: 1024, postgresText: true }),
        limit: z.number().int().min(1).max(20).optional(),
        pathPrefix: pathPrefixSchema.optional(),
        documentId: unicodeBoundedString({ min: 1, max: 256, postgresText: true }).optional(),
      }),
    ),
    output: closed({
      results: z.array(citationHitSchema),
      generationId: kbIdSchema,
      freshness: z.enum(["current", "stale", "building", "failed", "unavailable"]),
      indexedCommitSha: shaSchema.nullable(),
      headSha: shaSchema,
      indexNotices: z.array(indexNoticeSchema).max(1),
    }),
  },
  knowledge_search_all: {
    input: closed({
      query: unicodeBoundedString({ min: 1, max: 1024, postgresText: true }),
      /** Bases to search, in this order; omitted = every base this credential can read. */
      kbIds: z.array(kbIdSchema).min(1).max(SEARCH_ALL_MAX_BASES).optional(),
      limitPerBase: z.number().int().min(1).max(SEARCH_ALL_MAX_PER_BASE).optional(),
    }),
    output: closed({
      /**
       * Every base's rank-1 hit (in `knowledgeBases` order), then every rank-2 hit, and so on.
       * Not one relevance ranking: scores compare only within one base.
       */
      results: z.array(searchAllHitSchema).max(SEARCH_ALL_MAX_RESULTS),
      order: z.literal("rank_interleaved"),
      /** The per-base hit limit applied (the requested one, shrunk to fit the merged cap). */
      limitPerBase: safeIntSchema.min(1).max(SEARCH_ALL_MAX_PER_BASE),
      /** One row per base searched, in request order (or listing order for "all"). */
      knowledgeBases: z.array(searchAllBaseSchema).max(SEARCH_ALL_MAX_BASES),
    }),
  },
  knowledge_structured_search: {
    input: withKbContract(
      kbBaseInputSchema
        .merge(pageInputSchema)
        .merge(
          closed({
            query: unicodeBoundedString({ min: 1, max: 1024, postgresText: true }).optional(),
            type: unicodeBoundedString({ min: 1, max: 256, postgresText: true }).optional(),
            title: unicodeBoundedString({ min: 1, max: 256, postgresText: true }).optional(),
            tags: z
              .array(unicodeBoundedString({ min: 1, max: 64, postgresText: true }))
              .max(16)
              .optional(),
            timestamp: closed({
              after: isoSchema.optional(),
              before: isoSchema.optional(),
            }).optional(),
            structured: z
              .array(
                closed({
                  column: unicodeBoundedString({ min: 1, max: 256, postgresText: true }),
                  equals: z.union([
                    unicodeBoundedString({ max: 1024, postgresText: true }),
                    z.boolean(),
                    z.null(),
                    z.number().finite(),
                  ]),
                }),
              )
              .max(16)
              .optional(),
          }),
        )
        .superRefine((value, ctx) => {
          const hasQuery = value.query !== undefined;
          const hasFilter =
            value.type !== undefined ||
            value.title !== undefined ||
            (value.tags !== undefined && value.tags.length > 0) ||
            value.timestamp?.after !== undefined ||
            value.timestamp?.before !== undefined ||
            (value.structured !== undefined && value.structured.length > 0);
          if (!hasQuery && !hasFilter) {
            // Point at the first (empty) filter given, as the JSON Schema check does.
            const empty = (["tags", "timestamp", "structured"] as const).find(
              (key) => value[key] !== undefined,
            );
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "query or at least one filter is required",
              ...(empty ? { path: [empty] } : {}),
            });
          }
          const after = value.timestamp?.after;
          const before = value.timestamp?.before;
          if (after !== undefined && before !== undefined) {
            const order = compareIsoUtc(after, before);
            if (order === null || order >= 0) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "timestamp range is inverted",
              });
            }
          }
        }),
      {
        anyOf: [
          { required: ["query"] },
          { required: ["type"] },
          { required: ["title"] },
          { properties: { tags: { type: "array", minItems: 1 } }, required: ["tags"] },
          {
            properties: {
              timestamp: { anyOf: [{ required: ["after"] }, { required: ["before"] }] },
            },
            required: ["timestamp"],
          },
          { properties: { structured: { type: "array", minItems: 1 } }, required: ["structured"] },
        ],
        "x-kb-iso-range": { after: "timestamp.after", before: "timestamp.before" },
      },
    ),
    output: closed({
      items: z.array(citationHitSchema),
      nextCursor: z.string().nullable(),
      generationId: kbIdSchema,
      freshness: z.enum(["current", "stale", "building", "failed", "unavailable"]),
      indexedCommitSha: shaSchema.nullable(),
      headSha: shaSchema,
      indexNotices: z.array(indexNoticeSchema).max(1),
    }),
  },
  knowledge_assets_list: {
    input: kbRevInputSchema.merge(pageInputSchema),
    output: pageOutputSchema(assetRefSchema),
  },
  knowledge_export_prepare: {
    input: kbRevInputSchema.merge(
      closed({
        kind: z.enum(["assets", "whole"]),
        idempotencyKey: keySchema,
      }),
    ),
    output: exportJobSchema,
  },
  knowledge_export_status: {
    input: kbBaseInputSchema.merge(closed({ transferId: uuidSchema })),
    output: exportJobSchema,
  },
  knowledge_export_cancel: {
    input: kbBaseInputSchema.merge(closed({ transferId: uuidSchema })),
    output: exportJobSchema,
  },
  knowledge_transfer_read: {
    input: kbBaseInputSchema.merge(
      closed({
        transferId: uuidSchema,
        offset: safeIntSchema.min(0),
        maxBytes: z.number().int().min(1).max(196608).optional(),
      }),
    ),
    output: closed({
      transferId: uuidSchema,
      offset: safeIntSchema.min(0),
      nextOffset: safeIntSchema.min(0),
      bytesBase64: transferChunkBase64Schema,
      eof: z.boolean(),
      contentHash: hashSchema,
    }),
  },
  knowledge_export_complete: {
    input: kbBaseInputSchema.merge(closed({ transferId: uuidSchema })),
    output: closed({ transferId: uuidSchema, released: z.literal(true) }),
  },

  knowledge_index_status: {
    input: kbBaseInputSchema,
    output: indexStatusSchema,
  },
  knowledge_embedding_profile_get: {
    input: kbBaseInputSchema,
    output: closed({
      profile: providerSummarySchema.nullable(),
      index: indexStatusSchema,
    }),
  },
  knowledge_pull_requests_list: {
    input: kbBaseInputSchema.merge(pageInputSchema).merge(
      closed({
        status: z.enum(["OPEN", "CONFLICT", "CLOSED", "MERGED"]).optional(),
      }),
    ),
    output: pageOutputSchema(prSummarySchema),
  },
  knowledge_pull_requests_get: {
    input: kbBaseInputSchema.merge(
      closed({
        number: safeIntSchema.min(1),
        page: pageInputSchema.optional(),
        expectedHeadSha: shaSchema.optional(),
      }),
    ),
    output: closed({
      pr: prSummarySchema,
      files: z.array(fileDeltaSchema).max(PR_DETAIL_MAX_DELTAS_PER_PAGE),
      touchedAssets: z.array(assetDeltaSchema).max(PR_DETAIL_MAX_DELTAS_PER_PAGE),
      nextCursor: z.string().nullable(),
    }),
  },
  knowledge_sealed_resolve: {
    input: kbRevInputSchema.merge(
      closed({
        path: pathSchema,
        reference: unicodeBoundedString({ max: 160 }),
        recipientKeyId: uuidSchema,
      }),
    ),
    output: closed({
      reference: unicodeBoundedString({ max: 160 }),
      recipientKeyId: uuidSchema,
      envelope: sealedEnvelopeSchema,
      expiresAt: isoSchema,
    }),
  },
} as const;
