import { createHash } from "node:crypto";
import { z } from "zod";
import { invalidArgument, pathExists, pathIssueReason } from "./argument-reasons";

import type { PlannedChange } from "./changes-plan";
import { walkGitTreeAtCommit } from "./changes-plan";
import { KbDomainError } from "./errors";
import {
  finishGitReadAsync,
  type GitReadOptions,
  type GitReadSteps,
  gitReadOptions,
  gitReadStep,
  readBlobContentAsync,
  readBlobsAsync,
  readCommitTreeShaAsync,
  TreeReadBudgetError,
  walkGitTreeEntriesAsync,
} from "./git-read";
import { KB_TREE_LIMITS } from "./limits";
import {
  type DreamDocumentFields,
  findSealedReferences,
  parseMarkdownDocument,
  readDocumentProvenance,
  serializeDreamMarkdown,
} from "./parse-markdown";
import { isMarkdownPath, normalizeKbPath } from "./paths";
import {
  closed,
  dreamMetadataSchema,
  kbContentWriteInputSchema,
  shaSchema,
  unicodeBoundedString,
  uuidSchema,
} from "./protocol/common";
import { refineKnowledgeChangesApply } from "./protocol/writes";
import { containsKnownCredentialPatterns, redactSensitiveSubstrings } from "./sensitive-text";

export type DreamMetadata = z.infer<typeof dreamMetadataSchema>;

/**
 * One dream-touched path for an id. `existedAtBase` records whether the path
 * existed as a blob at the proposal's original main base, so the merge guard
 * only treats disappearance as a post-proposal deletion when the path was
 * actually there when the dream was proposed.
 */
export type DreamGuardPathRecord = { path: string; existedAtBase: boolean };

/** Server-persisted merge-guard fields (not accepted from clients). */
export type PersistedDreamMetadata = DreamMetadata & {
  guardTouchedPaths: Record<string, DreamGuardPathRecord[]>;
};

const dreamChangesApplyRequestSchema = closed({
  mode: z.literal("dream"),
  baseRevision: shaSchema,
  title: unicodeBoundedString({ min: 1, max: 200, postgresText: true }),
  changes: z.array(z.never()).max(0),
  sourceSessionIds: z.array(uuidSchema).max(100),
  ...kbContentWriteInputSchema.pick({ proposalNumber: true, proposalHeadSha: true }).shape,
  dream: dreamMetadataSchema,
}).superRefine((value, ctx) =>
  refineKnowledgeChangesApply(
    {
      mode: "dream",
      title: value.title,
      changes: [],
      sourceSessionIds: value.sourceSessionIds,
      dream: value.dream,
    },
    ctx,
  ),
);

export type DreamChangesApplyRequest = z.infer<typeof dreamChangesApplyRequestSchema>;

export function parseDreamChangesApplyRequest(body: unknown): DreamChangesApplyRequest {
  if (body && typeof body === "object") {
    const changes = (body as { changes?: unknown }).changes;
    if (Array.isArray(changes) && changes.length > 0) {
      throw new KbDomainError("INVALID_ARGUMENT", "dream mode requires empty changes");
    }
  }
  const parsed = dreamChangesApplyRequestSchema.safeParse(body);
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "invalid dream changes apply request";
    throw new KbDomainError("INVALID_ARGUMENT", message);
  }
  return parsed.data;
}

export async function dreamGuardTouchedPathsForUpserts(
  input: {
    repoPath: string;
    /** Request base — the doc-ID map the client planned against (PR head for appends). */
    baseRevision: string;
    /** Existence baseline — the proposal's original main base, immutable per PR. */
    guardBaseRevision: string;
    dream: DreamMetadata;
  } & GitReadOptions,
): Promise<Record<string, DreamGuardPathRecord[]>> {
  const idMap = await buildDocumentIdPathMapAsync(input.repoPath, input.baseRevision, input);
  const baseBlobPaths = await blobPathsAtCommitAsync(
    input.repoPath,
    input.guardBaseRevision,
    input,
  );
  const paths: Record<string, DreamGuardPathRecord[]> = {};
  for (const [index, upsert] of input.dream.upserts.entries()) {
    const path = resolveDreamPath(upsert.id, idMap, index);
    paths[upsert.id] = [{ path, existedAtBase: baseBlobPaths.has(path) }];
  }
  return paths;
}

/**
 * Own-property-safe guard-record lookup. Document ids like "constructor" are
 * contract-valid, and the dictionaries are plain objects (freshly built or
 * loaded from persisted JSON), so an unguarded `dict[id]` would resolve to an
 * inherited Object.prototype member instead of the id's records.
 */
function guardRecordsFor(
  dict: Record<string, DreamGuardPathRecord[]>,
  id: string,
): DreamGuardPathRecord[] {
  return Object.hasOwn(dict, id) && Array.isArray(dict[id]) ? dict[id]! : [];
}

export function mergePersistedDreamMetadata(
  existing: PersistedDreamMetadata | DreamMetadata | null,
  incoming: DreamMetadata,
  touchedPaths: Record<string, DreamGuardPathRecord[]>,
): PersistedDreamMetadata {
  const upsertById = new Map<string, DreamMetadata["upserts"][number]>();
  for (const upsert of existing?.upserts ?? []) {
    upsertById.set(upsert.id, upsert);
  }
  for (const upsert of incoming.upserts) {
    upsertById.set(upsert.id, upsert);
  }
  const mergedUpserts = [...upsertById.values()].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  // Guard records are cumulative per id: a dream id that later moves to another
  // path keeps every path it was ever dreamed at, so a human edit at any
  // earlier path still conflicts at merge. Re-recording a path keeps
  // existedAtBase sticky (once a path existed at base, deleting it on main
  // afterwards stays a violation).
  const existingGuard =
    existing && "guardTouchedPaths" in existing ? existing.guardTouchedPaths : {};
  const guardTouchedPaths: Record<string, DreamGuardPathRecord[]> = {};
  for (const id of new Set([...Object.keys(existingGuard), ...Object.keys(touchedPaths)])) {
    const byPath = new Map<string, DreamGuardPathRecord>();
    for (const record of guardRecordsFor(existingGuard, id)) {
      byPath.set(record.path, { path: record.path, existedAtBase: record.existedAtBase });
    }
    for (const record of guardRecordsFor(touchedPaths, id)) {
      const prior = byPath.get(record.path);
      byPath.set(record.path, {
        path: record.path,
        existedAtBase: (prior?.existedAtBase ?? false) || record.existedAtBase,
      });
    }
    guardTouchedPaths[id] = [...byPath.values()].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    );
  }
  return {
    model: incoming.model,
    redactionApplied: incoming.redactionApplied,
    upserts: mergedUpserts,
    guardTouchedPaths,
  };
}

function sanitizeDreamCommitTitle(title: string): string {
  return title.replace(/\r\n?|\n/g, " ").trim();
}

export function scanDreamRequestForSensitive(request: DreamChangesApplyRequest): void {
  const fields = [request.title, request.dream.model.provider, request.dream.model.model];
  for (const text of fields) {
    if (containsKnownCredentialPatterns(text)) {
      throw new KbDomainError(
        "INVALID_ARGUMENT",
        redactSensitiveSubstrings("dream request contains a known credential pattern"),
      );
    }
  }
}

/** Each document id's path at a commit, from cancellable, deadline-bound reads. */
async function buildDocumentIdPathMapAsync(
  repoPath: string,
  commitSha: string,
  options: GitReadOptions,
): Promise<Map<string, string>> {
  const lifetime = gitReadOptions(options);
  const documents = (
    await walkGitTreeEntriesAsync(
      repoPath,
      await readCommitTreeShaAsync(repoPath, commitSha, lifetime),
      { entries: 0, maxEntries: KB_TREE_LIMITS.maxEntries },
      lifetime,
    )
  ).filter((entry) => entry.type === "blob" && isMarkdownPath(entry.path));
  const bodies = await readBlobsAsync(
    repoPath,
    documents.map((entry) => entry.sha),
    { maxBytes: KB_TREE_LIMITS.maxMarkdownBytes, totalMaxBytes: KB_TREE_LIMITS.maxTreeBytes },
    lifetime,
  );
  const map = new Map<string, string>();
  for (const entry of documents) {
    const parsed = parseMarkdownDocument(bodies.get(entry.sha)!);
    if ("code" in parsed || !parsed.documentId) continue;
    map.set(parsed.documentId, entry.path);
  }
  return map;
}

async function blobPathsAtCommitAsync(
  repoPath: string,
  commitSha: string,
  options: GitReadOptions,
): Promise<Map<string, string>> {
  const lifetime = gitReadOptions(options);
  const entries = await walkGitTreeEntriesAsync(
    repoPath,
    await readCommitTreeShaAsync(repoPath, commitSha, lifetime),
    { entries: 0, maxEntries: KB_TREE_LIMITS.maxEntries },
    lifetime,
  );
  return new Map(entries.filter((e) => e.type === "blob").map((e) => [e.path, e.sha]));
}

/** The JSON pointer naming upsert `index`'s member `key` in the tool arguments. */
const upsertField = (index: number | undefined, key?: "id") =>
  index === undefined ? undefined : `/dream/upserts/${index}${key ? `/${key}` : ""}`;

/**
 * An upsert's path: its id's current path, or `concepts/<id>.md` for a new
 * id. An id that maps to a path the KB refuses (a reserved name such as
 * `con`) says why, at that upsert's `id`.
 */
function resolveDreamPath(id: string, idMap: Map<string, string>, index?: number): string {
  const existing = idMap.get(id);
  if (existing) return existing;
  const path = `concepts/${id}.md`;
  const norm = normalizeKbPath(path);
  if (!norm.ok) {
    throw invalidArgument(
      `dream upsert id maps to a refused path: ${norm.issue.message}`,
      pathIssueReason(norm.issue.code),
      upsertField(index, "id"),
    );
  }
  return norm.path;
}

function scanUpsertForSealed(fields: DreamDocumentFields, index: number): void {
  const markdown = serializeDreamMarkdown(fields);
  for (const reference of findSealedReferences(markdown)) {
    throw invalidArgument(
      `dream upsert ${fields.id} must not contain sealed reference ${reference}`,
      "SCHEMA",
      upsertField(index),
    );
  }
}

function scanUpsertForSensitive(fields: DreamDocumentFields, index: number): void {
  // Scan the original field strings, not only the serialized Markdown: YAML
  // scalars are JSON.stringify-escaped there, so whitespace inside a front
  // matter value (e.g. "Bearer<TAB>token") would otherwise hide a recognized
  // credential literal until the document is parsed back out of Git.
  const texts = [
    fields.id,
    fields.type,
    fields.title ?? "",
    fields.body,
    ...fields.citations.flatMap((citation) => [citation.label, citation.target]),
    serializeDreamMarkdown(fields),
  ];
  for (const text of texts) {
    if (containsKnownCredentialPatterns(text)) {
      throw invalidArgument(
        redactSensitiveSubstrings("dream upsert contains a known credential pattern"),
        "SCHEMA",
        upsertField(index),
      );
    }
  }
}

export function dreamUpsertToFields(upsert: DreamMetadata["upserts"][number]): DreamDocumentFields {
  return {
    id: upsert.id,
    type: upsert.type,
    title: upsert.title,
    citations: upsert.citations,
    body: upsert.body,
  };
}

export async function dreamUpsertsToPlannedChanges(
  input: {
    repoPath: string;
    baseRevision: string;
    dream: DreamMetadata;
  } & GitReadOptions,
): Promise<PlannedChange[]> {
  const idMap = await buildDocumentIdPathMapAsync(input.repoPath, input.baseRevision, input);
  const baseBlobs = await blobPathsAtCommitAsync(input.repoPath, input.baseRevision, input);
  const seenIds = new Set<string>();
  const changes: PlannedChange[] = [];
  for (const [index, upsert] of input.dream.upserts.entries()) {
    if (seenIds.has(upsert.id)) {
      throw invalidArgument("duplicate dream upsert ids", "SCHEMA", upsertField(index, "id"));
    }
    seenIds.add(upsert.id);
    const fields = dreamUpsertToFields(upsert);
    scanUpsertForSealed(fields, index);
    scanUpsertForSensitive(fields, index);
    const path = resolveDreamPath(upsert.id, idMap, index);
    const exists = idMap.has(upsert.id);
    const blobSha = exists ? baseBlobs.get(path) : undefined;
    if (blobSha !== undefined) {
      const parsed = parseMarkdownDocument(
        await readBlobContentAsync(
          input.repoPath,
          blobSha,
          { maxBytes: KB_TREE_LIMITS.maxMarkdownBytes },
          input,
        ),
      );
      if ("code" in parsed) throw new KbDomainError("INVALID_ARGUMENT", parsed.message);
      if (readDocumentProvenance(parsed.frontMatter) !== "dream") {
        throw new KbDomainError(
          "FORBIDDEN",
          "cannot overwrite document with human or unspecified provenance",
        );
      }
    }
    const markdown = serializeDreamMarkdown(fields);
    changes.push({
      op: exists ? "replace" : "create",
      path,
      content: { markdown },
    });
  }
  return changes;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
}

export function dreamOperationDigest(
  dream: DreamMetadata,
  sourceSessionIds: readonly string[],
): string {
  const payload = {
    dream,
    sourceSessionIds: [...sourceSessionIds].sort(),
  };
  return createHash("sha256").update(stableJson(payload)).digest("hex");
}

export function dreamSourceSessionsDigest(sourceSessionIds: readonly string[]): string {
  return createHash("sha256")
    .update(stableJson([...sourceSessionIds].sort()))
    .digest("hex");
}

export function formatDreamCommitMessage(
  title: string,
  sourceSessionIds: readonly string[],
  dream: DreamMetadata,
): string {
  const safeTitle = sanitizeDreamCommitTitle(title);
  const opDigest = dreamOperationDigest(dream, sourceSessionIds);
  const sourceDigest = dreamSourceSessionsDigest(sourceSessionIds);
  return `${safeTitle}\n\nKb-Op-Digest: sha256:${opDigest}\nKb-Source-Digest: sha256:${sourceDigest}`;
}

export type DreamMergeGuardResult = { ok: true } | { ok: false; message: string };

/**
 * Merge-time provenance guard, invoked by reviewed PR merge preparation.
 * Rejects when current main has human or absent provenance at any dream-touched
 * path, at the current main path of a touched id, or removed a path that
 * existed at the proposal's original main base. A path that was brand new when
 * the dream was proposed may legitimately still be absent from main.
 */
export async function evaluateDreamMergeGuardAsync(
  input: {
    repoPath: string;
    mainHead: string;
    dream: DreamMetadata | PersistedDreamMetadata;
  } & GitReadOptions,
): Promise<DreamMergeGuardResult> {
  const options = gitReadOptions(input);
  const entries = await walkGitTreeEntriesAsync(
    input.repoPath,
    await readCommitTreeShaAsync(input.repoPath, input.mainHead, options),
    { entries: 0, maxEntries: KB_TREE_LIMITS.maxEntries },
    options,
  );
  const mainBlobs = new Map(entries.filter((e) => e.type === "blob").map((e) => [e.path, e.sha]));
  const idMap = new Map<string, string>();
  const provenance = new Map<string, ReturnType<typeof readDocumentProvenance>>();
  let bytesRead = 0;
  const documents = entries.filter((e) => e.type === "blob" && isMarkdownPath(e.path));
  // One batched read for every document (never one process per entry).
  const bodies = await readBlobsAsync(
    input.repoPath,
    documents.map((entry) => entry.sha),
    { maxBytes: KB_TREE_LIMITS.maxMarkdownBytes, totalMaxBytes: KB_TREE_LIMITS.maxTreeBytes },
    options,
  ).catch((error: unknown) => {
    if (error instanceof TreeReadBudgetError)
      throw new KbDomainError("STORAGE_UNAVAILABLE", "Dream tree exceeds read budget");
    throw error;
  });
  for (const entry of documents) {
    const bytes = bodies.get(entry.sha)!;
    bytesRead += bytes.length;
    if (bytesRead > KB_TREE_LIMITS.maxTreeBytes)
      throw new KbDomainError("STORAGE_UNAVAILABLE", "Dream tree exceeds read budget");
    const parsed = parseMarkdownDocument(bytes);
    if ("code" in parsed) throw new KbDomainError("INVALID_ARGUMENT", parsed.message);
    if (parsed.documentId) idMap.set(parsed.documentId, entry.path);
    provenance.set(entry.sha, readDocumentProvenance(parsed.frontMatter));
  }
  return finishGitReadAsync(
    dreamGuardSteps(input.dream, mainBlobs, idMap, (sha) => {
      const value = provenance.get(sha);
      if (value === undefined)
        throw new KbDomainError("INVALID_ARGUMENT", "Dream path is not Markdown");
      return value;
    }),
    options,
  );
}
function* dreamGuardSteps(
  dream: DreamMetadata | PersistedDreamMetadata,
  mainBlobs: Map<string, string>,
  idMap: Map<string, string>,
  readProvenance: (
    sha: string,
  ) =>
    | ReturnType<typeof readDocumentProvenance>
    | Promise<ReturnType<typeof readDocumentProvenance>>,
): GitReadSteps<DreamMergeGuardResult> {
  const guardRecords = "guardTouchedPaths" in dream ? dream.guardTouchedPaths : {};
  const checkedPaths = new Set<string>();
  const checkPath = function* (
    path: string,
    existedAtBase: boolean,
  ): GitReadSteps<DreamMergeGuardResult | null> {
    yield undefined;
    checkedPaths.add(path);
    const blobSha = mainBlobs.get(path);
    if (blobSha === undefined) {
      if (existedAtBase) {
        return {
          ok: false,
          message: `main document at ${path} was removed after the dream proposal`,
        };
      }
      return null;
    }
    if ((yield* gitReadStep(readProvenance(blobSha))) !== "dream") {
      return {
        ok: false,
        message: `main document at ${path} was modified with human provenance after the dream proposal`,
      };
    }
    return null;
  };
  for (const id of Object.keys(guardRecords).sort()) {
    for (const record of guardRecordsFor(guardRecords, id)) {
      const violation = yield* checkPath(record.path, record.existedAtBase);
      if (violation) return violation;
    }
  }
  // Also cover each touched id's current main path, so a human takeover of the
  // id at a path the proposal never recorded still conflicts.
  const ids = new Set<string>([
    ...dream.upserts.map((upsert) => upsert.id),
    ...Object.keys(guardRecords),
  ]);
  for (const id of ids) {
    const currentPath = idMap.get(id) ?? resolveDreamPath(id, idMap);
    if (checkedPaths.has(currentPath)) continue;
    const violation = yield* checkPath(currentPath, false);
    if (violation) return violation;
  }
  return { ok: true };
}

export async function planDreamPublication(input: {
  repoPath: string;
  baseRevision: string;
  dream: DreamMetadata;
  sourceSessionIds: readonly string[];
}) {
  if (input.dream.upserts.length === 0) {
    return { changes: [] as PlannedChange[], noop: true as const };
  }
  const changes = await dreamUpsertsToPlannedChanges({
    repoPath: input.repoPath,
    baseRevision: input.baseRevision,
    dream: input.dream,
  });
  const planned = await walkGitTreeAtCommit({
    repoPath: input.repoPath,
    baseRevision: input.baseRevision,
    changes,
  });
  if (!planned.ok) {
    // The same codes as publication: a taken path is CONFLICT.
    throw planned.reason === "PATH_EXISTS"
      ? pathExists(planned.message)
      : new KbDomainError("INVALID_ARGUMENT", planned.message);
  }
  return { changes, noop: planned.noop, planned };
}
