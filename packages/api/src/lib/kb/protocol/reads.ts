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
    output: closed({
      operationId: uuidSchema,
      transferId: uuidSchema,
      rev: shaSchema,
      size: safeIntSchema.min(0),
      contentHash: hashSchema,
      expiresAt: isoSchema,
      mime: z.literal("application/zip"),
    }),
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
