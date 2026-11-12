import { z } from "zod";

import { casefoldPathKey } from "../paths";
import {
  applyResultSchema,
  canonicalBase64Schema,
  changeSchema,
  closed,
  deleteConfirmSchema,
  dreamMetadataSchema,
  hashSchema,
  isoSchema,
  kbAttachmentSchema,
  kbBaseInputSchema,
  kbContentWriteInputSchema,
  kbDescriptionSchema,
  kbIdSchema,
  kbMetadataMutationInputSchema,
  kbNameSchema,
  keySchema,
  mergeConfirmSchema,
  mimeSchema,
  pathSchema,
  providerRefSchema,
  prSummarySchema,
  runConfirmSchema,
  safeIntSchema,
  shaSchema,
  textInputSchema,
  UPLOAD_MIME_TYPES,
  unicodeBoundedString,
  uuidSchema,
  withKbContract,
} from "./common";

const uploadChunkBase64Schema = canonicalBase64Schema({ minBytes: 1, maxBytes: 196_608 });

const REMOVAL_OPS: ReadonlySet<string> = new Set(["delete", "assetRemove"]);
const ASSET_CHANGE_OPS: ReadonlySet<string> = new Set(["assetPut", "assetRemove"]);

/**
 * Whether a change set names one path twice (same path and kind) or writes
 * two case-colliding paths, whose result would collide. Removals may meet any
 * case variant: resolving a case clash takes one side away and keeps (or
 * writes) the other in the same request.
 */
export function changePathsCollide(changes: readonly { op: string; path: string }[]): boolean {
  return collidingChangeIndex(changes) !== -1;
}

/** The index of the change that repeats or case-collides with an earlier one, else -1. */
export function collidingChangeIndex(changes: readonly { op: string; path: string }[]): number {
  const named = new Set<string>();
  const written = new Set<string>();
  for (const [index, change] of changes.entries()) {
    const kind = ASSET_CHANGE_OPS.has(change.op) ? "asset" : "document";
    const exact = `${kind}\0${change.path}`;
    if (named.has(exact)) return index;
    named.add(exact);
    if (REMOVAL_OPS.has(change.op)) continue;
    const key = casefoldPathKey(change.path);
    if (written.has(key)) return index;
    written.add(key);
  }
  return -1;
}

export function refineKnowledgeChangesApply(
  value: {
    mode: "edit" | "dream";
    title?: string;
    changes: { op: string; path: string }[];
    sourceSessionIds?: string[];
    dream?: z.infer<typeof dreamMetadataSchema>;
  },
  ctx: z.RefinementCtx,
): void {
  // Every refinement names the argument it refuses (`field`).
  const sourceSessionIds = value.sourceSessionIds ?? [];
  const sessionIds = new Set<string>();
  for (const [index, sessionId] of sourceSessionIds.entries()) {
    if (sessionIds.has(sessionId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "sourceSessionIds must be unique",
        path: ["sourceSessionIds", index],
      });
      return;
    }
    sessionIds.add(sessionId);
  }

  const colliding = collidingChangeIndex(value.changes);
  if (colliding !== -1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "duplicate or case-colliding change paths",
      path: ["changes", colliding, "path"],
    });
    return;
  }

  if (value.mode === "edit") {
    if (value.changes.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "edit mode requires at least one change",
        path: ["changes"],
      });
    }
    if (value.dream !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "dream metadata is not allowed in edit mode",
        path: ["dream"],
      });
    }
    return;
  }

  if (value.title === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "dream mode requires a title",
      path: ["title"],
    });
  }
  if (value.changes.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "dream mode requires empty changes",
      path: ["changes"],
    });
  }
  if (value.dream === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "dream metadata is required in dream mode",
      path: ["dream"],
    });
    return;
  }

  const upsertIds = new Set<string>();
  for (const [index, upsert] of value.dream.upserts.entries()) {
    if (upsertIds.has(upsert.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "duplicate dream upsert ids",
        path: ["dream", "upserts", index, "id"],
      });
      return;
    }
    upsertIds.add(upsert.id);
  }

  const dreamHasWork = value.dream.upserts.length > 0;
  if (dreamHasWork && sourceSessionIds.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "nonempty dream work requires sourceSessionIds",
      path: ["sourceSessionIds"],
    });
  }
}

export const CHANGES_APPLY_MAX_CHANGES = 32;

/** Shared validation for HTTP/MCP and internal batch publication (edit mode only). */
export const changesApplyRequestSchema = closed({
  mode: z.literal("edit"),
  baseRevision: shaSchema,
  title: unicodeBoundedString({ min: 1, max: 200, postgresText: true }),
  changes: z
    .array(changeSchema)
    .min(1, "edit mode requires at least one change")
    .max(CHANGES_APPLY_MAX_CHANGES),
  sourceSessionIds: z.array(uuidSchema).max(100),
  ...kbContentWriteInputSchema.pick({ proposalNumber: true, proposalHeadSha: true }).shape,
}).superRefine((value, ctx) =>
  refineKnowledgeChangesApply({ ...value, mode: value.mode, dream: undefined }, ctx),
);

export const kbWriteToolSchemas = {
  knowledge_bases_create: {
    input: closed({
      name: kbNameSchema,
      slug: z
        .string()
        .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
        .max(63),
      description: kbDescriptionSchema,
      idempotencyKey: keySchema,
    }),
    output: closed({
      operationId: uuidSchema,
      kb: kbAttachmentSchema,
    }),
  },
  knowledge_bases_update: {
    input: withKbContract(
      kbMetadataMutationInputSchema
        .merge(
          closed({
            name: kbNameSchema.optional(),
            description: kbDescriptionSchema.optional(),
          }),
        )
        .superRefine((value, ctx) => {
          if (value.name === undefined && value.description === undefined) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "at least one of name or description is required",
            });
          }
        }),
      { anyOf: [{ required: ["name"] }, { required: ["description"] }] },
    ),
    output: closed({
      operationId: uuidSchema,
      kb: kbAttachmentSchema,
    }),
  },
  knowledge_bases_delete: {
    input: kbMetadataMutationInputSchema.merge(
      closed({
        confirm: deleteConfirmSchema,
      }),
    ),
    output: closed({
      operationId: uuidSchema,
      tombstoned: z.literal(true),
    }),
  },
  knowledge_changes_apply: {
    input: withKbContract(
      kbContentWriteInputSchema
        .merge(
          closed({
            mode: z.enum(["edit", "dream"]),
            title: unicodeBoundedString({ min: 1, max: 200, postgresText: true }).optional(),
            changes: z.array(changeSchema).max(CHANGES_APPLY_MAX_CHANGES),
            // Sessions a dream distils; an edit names none, so it may omit them.
            sourceSessionIds: z.array(uuidSchema).max(100).optional(),
            dream: dreamMetadataSchema.optional(),
          }),
        )
        .superRefine(refineKnowledgeChangesApply),
      {
        allOf: [
          {
            if: { properties: { mode: { const: "edit" } }, required: ["mode"] },
            // biome-ignore lint/suspicious/noThenProperty: JSON Schema conditional keyword, not a thenable.
            then: {
              properties: { changes: { type: "array", minItems: 1 } },
              not: { required: ["dream"] },
            },
          },
          {
            if: { properties: { mode: { const: "dream" } }, required: ["mode"] },
            // biome-ignore lint/suspicious/noThenProperty: JSON Schema conditional keyword, not a thenable.
            then: {
              properties: { changes: { type: "array", maxItems: 0 } },
              required: ["dream", "title"],
            },
          },
          {
            if: {
              properties: {
                mode: { const: "dream" },
                dream: {
                  properties: { upserts: { type: "array", minItems: 1 } },
                  required: ["upserts"],
                },
              },
              required: ["mode", "dream"],
            },
            // biome-ignore lint/suspicious/noThenProperty: JSON Schema conditional keyword, not a thenable.
            then: {
              properties: { sourceSessionIds: { type: "array", minItems: 1 } },
              required: ["sourceSessionIds"],
            },
          },
        ],
        "x-kb-unique-items": ["sourceSessionIds[]", "dream.upserts[].id"],
        "x-kb-change-paths": ["changes[]"],
      },
    ),
    output: applyResultSchema,
  },
  knowledge_documents_create: {
    input: kbContentWriteInputSchema.merge(
      closed({
        path: pathSchema,
        content: textInputSchema,
      }),
    ),
    output: applyResultSchema,
  },
  knowledge_documents_update: {
    input: kbContentWriteInputSchema.merge(
      closed({
        path: pathSchema,
        content: textInputSchema,
      }),
    ),
    output: applyResultSchema,
  },
  knowledge_documents_delete: {
    input: kbContentWriteInputSchema.merge(
      closed({
        path: pathSchema,
        confirm: deleteConfirmSchema,
      }),
    ),
    output: applyResultSchema,
  },
  knowledge_upload_begin: {
    input: kbBaseInputSchema.merge(
      closed({
        idempotencyKey: keySchema,
        kind: z.enum(["markdown", "asset"]),
        size: safeIntSchema.min(1),
        contentHash: hashSchema,
        mime: z.enum(UPLOAD_MIME_TYPES),
      }),
    ),
    output: closed({
      operationId: uuidSchema,
      uploadId: uuidSchema,
      offset: z.literal(0),
      expiresAt: isoSchema,
      maxChunkBytes: z.literal(196608),
    }),
  },
  knowledge_upload_write: {
    input: kbBaseInputSchema.merge(
      closed({
        uploadId: uuidSchema,
        offset: safeIntSchema.min(0),
        bytesBase64: uploadChunkBase64Schema,
      }),
    ),
    output: closed({
      uploadId: uuidSchema,
      offset: safeIntSchema.min(0),
    }),
  },
  knowledge_upload_finish: {
    input: kbBaseInputSchema.merge(
      closed({
        uploadId: uuidSchema,
      }),
    ),
    output: closed({
      uploadId: uuidSchema,
      contentHash: hashSchema,
      size: safeIntSchema.min(0),
      mime: mimeSchema,
      state: z.literal("READY"),
      expiresAt: isoSchema,
    }),
  },
  knowledge_assets_put: {
    input: kbContentWriteInputSchema.merge(
      closed({
        path: pathSchema,
        uploadId: uuidSchema,
      }),
    ),
    output: applyResultSchema,
  },
  knowledge_assets_import: {
    input: kbContentWriteInputSchema.merge(
      closed({
        path: pathSchema,
        source: closed({
          kbId: kbIdSchema,
          rev: shaSchema,
          hash: hashSchema,
        }),
      }),
    ),
    output: applyResultSchema,
  },
  knowledge_index_rebuild: {
    input: kbBaseInputSchema.merge(
      closed({
        idempotencyKey: keySchema,
        confirm: runConfirmSchema,
      }),
    ),
    output: closed({
      operationId: uuidSchema,
      generationId: kbIdSchema,
      jobId: uuidSchema,
      state: z.literal("PENDING"),
    }),
  },
  knowledge_embedding_profile_set: {
    input: kbBaseInputSchema.merge(
      closed({
        providerId: providerRefSchema,
        /** Required for a registered provider; optional for `builtin` (the current one). */
        revision: safeIntSchema.min(1).optional(),
        idempotencyKey: keySchema,
        confirm: runConfirmSchema,
      }),
    ),
    output: closed({
      operationId: uuidSchema,
      generationId: kbIdSchema,
      jobId: uuidSchema,
      // CURRENT: that profile's semantic generation of the head already
      // serves, so nothing was started (re-attaching is a no-op).
      state: z.enum(["PENDING", "CURRENT"]),
    }),
  },
  knowledge_pull_requests_create: {
    input: kbBaseInputSchema.merge(
      closed({
        headBranch: unicodeBoundedString({ min: 1, max: 256 }),
        expectedHeadSha: shaSchema,
        expectedTargetSha: shaSchema,
        title: unicodeBoundedString({ min: 1, max: 200, postgresText: true }),
        idempotencyKey: keySchema,
      }),
    ),
    output: closed({
      operationId: uuidSchema,
      pr: prSummarySchema,
    }),
  },
  knowledge_pull_requests_review: {
    input: withKbContract(
      kbBaseInputSchema
        .merge(
          closed({
            number: safeIntSchema.min(1),
            decision: z.enum(["merge", "close"]),
            expectedHeadSha: shaSchema,
            expectedTargetSha: shaSchema,
            idempotencyKey: keySchema,
            confirm: z.union([mergeConfirmSchema, z.literal("CLOSE")]),
          }),
        )
        .superRefine((value, ctx) => {
          const expected = value.decision === "merge" ? "MERGE" : "CLOSE";
          if (value.confirm !== expected) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "confirm must match decision",
              path: ["confirm"],
            });
          }
        }),
      {
        if: { properties: { decision: { const: "merge" } }, required: ["decision"] },
        // biome-ignore lint/suspicious/noThenProperty: JSON Schema conditional keyword, not a thenable.
        then: { properties: { confirm: { const: "MERGE" } }, required: ["confirm"] },
        else: { properties: { confirm: { const: "CLOSE" } }, required: ["confirm"] },
      },
    ),
    output: closed({
      operationId: uuidSchema,
      pr: prSummarySchema,
    }),
  },
} as const;
