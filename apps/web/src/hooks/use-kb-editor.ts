import type {
  BrowserConflictDetails,
  BrowserConflictPath,
} from "@knowledge-base/api/lib/kb/browser-conflict";
import type { AppRouterClient } from "@knowledge-base/api/routers/index";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import z from "zod";

import { useKbMutationSession } from "@/hooks/use-kb-mutation-session";
import { orpc } from "@/utils/orpc";

/**
 * Browser half of kb/1 document writes (CONTRACT: `M` mutations, TextInput,
 * ApplyResult). Every attempt carries the complete branch HEAD as
 * `baseRevision` and an idempotency key that is reused only while the exact
 * same payload is retried after an unknown outcome. The draft text is owned by
 * the caller and never replaced here: a conflict reports the actual new head
 * and waits for an explicit user decision (no automatic overwrite or rebase).
 */

export type Capability = "read" | "propose" | "write" | "review" | "manage";

const sha = z.string().regex(/^[0-9a-f]{40}$/);
/** CONTRACT ApplyResult; responses are validated, never trusted by cast. */
const applyResultSchema = z.object({
  operationId: z.string(),
  kind: z.enum(["applied", "proposed", "noop"]),
  commitSha: sha,
  baseRevision: sha,
  proposal: z
    .object({
      number: z.number().int().min(1),
      title: z.string(),
      sourceBranch: z.string(),
      targetBranch: z.literal("main"),
      baseSha: sha,
      headSha: sha,
      targetSha: sha,
      status: z.enum(["OPEN", "CONFLICT", "CLOSED", "MERGED"]),
      authorActorKey: z.string(),
      version: z.number().int(),
      mergeCommitSha: sha.nullable(),
    })
    .nullable(),
  changedPaths: z.array(z.string()),
  sourceSessionIds: z.array(z.string()),
  indexJobId: z.string().nullable(),
});
export type ApplyResultLike = z.infer<typeof applyResultSchema>;
export const parseApplyResult = (value: unknown): ApplyResultLike => applyResultSchema.parse(value);

type Client = AppRouterClient;
type UploadBegin = Awaited<ReturnType<Client["kbUploads"]["begin"]>>;

export const INLINE_MARKDOWN_MAX_BYTES = 128 * 1024;
export const STAGED_MARKDOWN_MAX_BYTES = 2 * 1024 * 1024;

export type KbControls = {
  canRead: boolean;
  /** none: no edit control; proposal: edits open/extend a PR; direct: edits land on main. */
  editMode: "none" | "proposal" | "direct";
  canManage: boolean;
  canReview: boolean;
};

/** Controls follow the KB's effective bits only; the instance admin role grants nothing here. */
export function kbControls(bits: readonly string[]): KbControls {
  const has = (bit: Capability) => bits.includes(bit);
  const canRead = has("read");
  return {
    canRead,
    editMode: !canRead ? "none" : has("write") ? "direct" : has("propose") ? "proposal" : "none",
    canManage: has("manage"),
    canReview: canRead && has("review"),
  };
}

/** A finished staged image upload the document save commits with it (R3-W7). */
export type StagedAssetInput = { path: string; uploadId: string };
/** Server ceiling on staged images per save (`DOCUMENT_STAGED_ASSETS_MAX`). */
export const DOCUMENT_STAGED_ASSETS_MAX = 7;

export type EditorOp =
  | {
      kind: "create" | "update";
      path: string;
      markdown: string;
      /** Staged images committed in the same change set as this save. */
      assets?: readonly StagedAssetInput[];
    }
  | { kind: "delete"; path: string };

/**
 * A path a PROPOSAL_CONFLICT still lists for the proposal, with the
 * revisions its base, main ("theirs") and proposal ("yours") versions are read
 * at (`BrowserConflictPath`, `@knowledge-base/api/lib/kb/browser-conflict`).
 */
export type ProposalConflictPath = BrowserConflictPath;

export type EditorOutcome =
  | { kind: "applied"; commitSha: string; indexJobId: string | null }
  | { kind: "proposed"; proposalNumber: number; proposalHead: string; created: boolean }
  | { kind: "noop"; commitSha: string }
  | {
      kind: "conflict";
      headSha: string | null;
      proposalNumber: number | null;
      /**
       * PROPOSAL_CONFLICT: the save reached the proposal but resolved
       * none of the paths it still conflicts on (listed here). `headSha` is
       * then the proposal head; `mainSha` is current main, which the next
       * save goes against.
       */
      proposalConflict?: { mainSha: string; paths: ProposalConflictPath[] };
    }
  | { kind: "retryable" }
  | {
      kind: "error";
      reason: "tooLarge" | "rejected" | "gone" | "uploadExpired" | "tooManyImages" | "unknown";
    };

/**
 * One save's exact request: what a retry resends, byte for byte, with the
 * same idempotency key and uploads (its staged images are in `op.assets`).
 */
export type SaveRequest = {
  kbId: string;
  baseRevision: string;
  op: EditorOp;
  proposalNumber: number | null;
  proposalHeadSha: string | null;
};

/**
 * The key of the attempt whose outcome is still unknown, bound to its exact
 * payload. While `request` is set that save is unresolved: it is the only
 * record a retry may send, and later draft edits never change it.
 */
export type EditorMemory = {
  fingerprint: string | null;
  key: string | null;
  upload?: { uploadId: string; offset: number; maxChunkBytes: number; finished: boolean };
  request?: SaveRequest;
};
export const initialEditorMemory = (): EditorMemory => ({ fingerprint: null, key: null });

type Content = { markdown: string } | { uploadId: string };
type MutationInput = {
  kbId: string;
  baseRevision: string;
  path: string;
  idempotencyKey: string;
  /** The proposal being edited: every write after it targets that PR. */
  proposalNumber?: number;
  /**
   * The proposal head this edit was read at: a write onto a PR that moved
   * since is refused with CONFLICT (the new head), never applied over it.
   */
  proposalHeadSha?: string;
};
type DocumentInput = MutationInput & { content: Content; assets?: StagedAssetInput[] };
export type EditorDeps = {
  create: (input: DocumentInput) => Promise<unknown>;
  update: (input: DocumentInput) => Promise<unknown>;
  remove: (input: MutationInput & { confirm: "DELETE" }) => Promise<unknown>;
  uploadBegin: (input: {
    kbId: string;
    idempotencyKey: string;
    kind: "markdown" | "asset";
    size: number;
    contentHash: string;
    mime: "text/markdown" | EditorImageMime;
  }) => Promise<Pick<NonNullable<UploadBegin>, "uploadId" | "offset" | "maxChunkBytes">>;
  uploadWrite: (input: {
    kbId: string;
    uploadId: string;
    offset: number;
    bytesBase64: string;
  }) => Promise<{ offset: number }>;
  uploadFinish: (input: { kbId: string; uploadId: string }) => Promise<unknown>;
  newKey: () => string;
  sha256Hex: (bytes: Uint8Array) => Promise<string>;
};

const errorCode = (error: unknown): string | undefined => {
  const e = error as { code?: unknown; data?: { code?: unknown } } | null;
  const data = e?.data?.code;
  if (typeof data === "string") return data;
  return typeof e?.code === "string" ? e.code : undefined;
};

/**
 * A document read of a path its (readable) revision doesn't hold: the
 * document's state at that revision, never a denial.
 */
export function isPathNotFound(error: unknown): boolean {
  const data = (error as { data?: { details?: { reason?: unknown } } } | null)?.data;
  return errorCode(error) === "NOT_FOUND" && data?.details?.reason === "PATH_NOT_FOUND";
}

export function isAccessLoss(error: unknown): boolean {
  const code = errorCode(error);
  return (code === "NOT_FOUND" && !isPathNotFound(error)) || code === "FORBIDDEN";
}

const SHA = /^[0-9a-f]{40}$/;
const isSha = (value: unknown): value is string => typeof value === "string" && SHA.test(value);

/**
 * The editor outcome for the documents router's CONFLICT details
 * (`BrowserConflictDetails`). Anything unreadable is a conflict with an
 * unknown head: never a guess.
 */
function conflictOutcome(details: unknown): Extract<EditorOutcome, { kind: "conflict" }> {
  const unknown = { kind: "conflict" as const, headSha: null, proposalNumber: null };
  if (!details || typeof details !== "object") return unknown;
  const raw = details as Partial<
    Record<keyof BrowserConflictDetails | "reason" | "mainSha" | "paths", unknown>
  >;
  if (!isSha(raw.headSha)) return unknown;
  const proposalNumber =
    typeof raw.proposalNumber === "number" &&
    Number.isSafeInteger(raw.proposalNumber) &&
    raw.proposalNumber >= 1
      ? raw.proposalNumber
      : null;
  if (raw.reason !== "PROPOSAL_CONFLICT")
    return { kind: "conflict", headSha: raw.headSha, proposalNumber };
  if (proposalNumber === null || !isSha(raw.mainSha) || !Array.isArray(raw.paths)) return unknown;
  const paths: ProposalConflictPath[] = [];
  for (const item of raw.paths) {
    const entry = (item ?? {}) as Partial<Record<keyof BrowserConflictPath, unknown>>;
    if (
      typeof entry.path !== "string" ||
      (entry.kind !== "document" && entry.kind !== "asset") ||
      !isSha(entry.baseSha) ||
      !isSha(entry.theirsSha) ||
      !isSha(entry.yoursSha)
    )
      return unknown;
    paths.push({
      path: entry.path,
      kind: entry.kind,
      baseSha: entry.baseSha,
      theirsSha: entry.theirsSha,
      yoursSha: entry.yoursSha,
    });
  }
  return {
    kind: "conflict",
    headSha: raw.headSha,
    proposalNumber,
    proposalConflict: { mainSha: raw.mainSha, paths },
  };
}

export function describeEditorError(error: unknown): EditorOutcome {
  const code = errorCode(error);
  switch (code) {
    case "CONFLICT": {
      const details = (error as { data?: { details?: unknown } }).data?.details;
      return conflictOutcome(details);
    }
    case "NOT_FOUND":
    case "FORBIDDEN":
      return { kind: "error", reason: "gone" };
    case "BAD_REQUEST":
    case "INVALID_ARGUMENT":
    case "IDEMPOTENCY_MISMATCH":
    case "UPLOAD_INCOMPLETE":
      return { kind: "error", reason: "rejected" };
    case "UPLOAD_EXPIRED":
      return { kind: "error", reason: "uploadExpired" };
    case "TOO_MANY_REQUESTS":
    case "RATE_LIMITED":
      return { kind: "retryable" };
    default:
      // Transport failures and 5xx: the server may have committed. Same key on retry.
      return { kind: "retryable" };
  }
}

export function settleOutcome(result: ApplyResultLike): EditorOutcome {
  if (result.kind === "proposed") {
    // A proposal without its PR is malformed; it must never read as a main update.
    if (!result.proposal) return { kind: "error", reason: "unknown" };
    return {
      kind: "proposed",
      proposalNumber: result.proposal.number,
      proposalHead: result.commitSha,
      // Version 1 is the proposal this edit opened; later edits update it.
      created: result.proposal.version === 1,
    };
  }
  if (result.kind === "noop") return { kind: "noop", commitSha: result.commitSha };
  return { kind: "applied", commitSha: result.commitSha, indexJobId: result.indexJobId };
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

type StageSpec = {
  kind: "markdown" | "asset";
  mime: "text/markdown" | EditorImageMime;
  /** Suffix of the upload's idempotency key, derived from the attempt key. */
  keySuffix: string;
  /** Raw bytes acknowledged so far, after every accepted frame. */
  onProgress?: (sent: number, total: number) => void;
  /**
   * Waits out the upload rate budget (`rl:kb-upload`) instead of failing: a
   * refused request is repeated after the server's `retryAfterSeconds`, from
   * the last acknowledged chunk. Without it a refusal ends the attempt.
   */
  budget?: { sleep: (ms: number) => Promise<void>; onWait?: (seconds: number) => void };
};

/** Consecutive budget refusals one request waits out before giving up. */
export const UPLOAD_BUDGET_MAX_WAITS = 8;
/** Longest single wait honoured; the upload budget's window is 60 s. */
const UPLOAD_BUDGET_MAX_WAIT_MS = 120_000;

/** The server's wait for a TOO_MANY_REQUESTS refusal, in ms, else null. */
export function retryAfterMs(error: unknown): number | null {
  if (errorCode(error) !== "TOO_MANY_REQUESTS") return null;
  const seconds = (error as { data?: { retryAfterSeconds?: unknown } } | null)?.data
    ?.retryAfterSeconds;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return null;
  const ms = Math.max(1, Math.ceil(seconds)) * 1000;
  return ms <= UPLOAD_BUDGET_MAX_WAIT_MS ? ms : null;
}

async function withBudget<T>(budget: StageSpec["budget"], request: () => Promise<T>): Promise<T> {
  for (let waits = 0; ; waits++) {
    try {
      return await request();
    } catch (error) {
      const ms = retryAfterMs(error);
      if (ms === null || !budget || waits >= UPLOAD_BUDGET_MAX_WAITS) throw error;
      budget.onWait?.(ms / 1000);
      await budget.sleep(ms);
    }
  }
}

type StageDeps = Pick<EditorDeps, "uploadBegin" | "uploadWrite" | "uploadFinish" | "sha256Hex">;

async function stageUpload(
  deps: StageDeps,
  kbId: string,
  attempt: EditorMemory & { key: string },
  bytes: Uint8Array,
  spec: StageSpec,
): Promise<{ uploadId: string }> {
  if (!attempt.upload) {
    const contentHash = `sha256:${await deps.sha256Hex(bytes)}`;
    const begin = await withBudget(spec.budget, () =>
      deps.uploadBegin({
        kbId,
        idempotencyKey: `${attempt.key}${spec.keySuffix}`,
        kind: spec.kind,
        size: bytes.length,
        contentHash,
        mime: spec.mime,
      }),
    );
    attempt.upload = { ...begin, finished: false };
  }
  const upload = attempt.upload;
  // A finished upload may already be reserved or consumed. Reuse the exact
  // document request to reach its receipt, without another write or finish.
  if (upload.finished) return { uploadId: upload.uploadId };
  const step = Math.max(1, upload.maxChunkBytes);
  spec.onProgress?.(upload.offset, bytes.length);
  while (upload.offset < bytes.length) {
    const bytesBase64 = toBase64(bytes.subarray(upload.offset, upload.offset + step));
    const next = await withBudget(spec.budget, () =>
      deps.uploadWrite({ kbId, uploadId: upload.uploadId, offset: upload.offset, bytesBase64 }),
    );
    // Lost acknowledgements repeat the exact last range; the server compares
    // those bytes and returns its contiguous offset without charging twice.
    if (next.offset <= upload.offset || next.offset > bytes.length)
      throw new Error("Invalid upload progress");
    upload.offset = next.offset;
    spec.onProgress?.(upload.offset, bytes.length);
  }
  // Lost finish acknowledgements replay finish at the completed offset.
  // Expiry is a definitive rejection, never evidence of a successful receipt.
  await withBudget(spec.budget, () => deps.uploadFinish({ kbId, uploadId: upload.uploadId }));
  upload.finished = true;
  return { uploadId: upload.uploadId };
}

const stageMarkdown = (
  deps: EditorDeps,
  kbId: string,
  attempt: EditorMemory & { key: string },
  bytes: Uint8Array,
): Promise<Content> =>
  stageUpload(deps, kbId, attempt, bytes, {
    kind: "markdown",
    mime: "text/markdown",
    keySuffix: "-md",
  });

export type EditorRun = {
  outcome: EditorOutcome;
  memory: EditorMemory;
  /** Base for the next edit: the branch the last write landed on, else unchanged. */
  nextBaseRevision: string;
  markdown: string | null;
};

function saveRequest(input: {
  kbId: string;
  baseRevision: string;
  op: EditorOp;
  proposalNumber?: number | null;
  proposalHeadSha?: string | null;
}): SaveRequest {
  const proposalNumber = input.proposalNumber ?? null;
  return {
    kbId: input.kbId,
    baseRevision: input.baseRevision,
    op: input.op,
    proposalNumber,
    proposalHeadSha: proposalNumber === null ? null : (input.proposalHeadSha ?? null),
  };
}

/** The identity of a request's exact payload (idempotency key reuse). */
function requestFingerprint(request: SaveRequest): string {
  const { op } = request;
  return JSON.stringify([
    request.kbId,
    request.baseRevision,
    request.proposalNumber,
    request.proposalHeadSha,
    op.kind,
    op.path,
    op.kind === "delete" ? null : op.markdown,
    op.kind === "delete" ? [] : (op.assets ?? []).map((asset) => [asset.path, asset.uploadId]),
  ]);
}

/** One attempt. Never retries by itself and never modifies the caller's draft. */
export async function runEditorOp(
  deps: EditorDeps,
  memory: EditorMemory,
  input: {
    kbId: string;
    baseRevision: string;
    op: EditorOp;
    proposalNumber?: number | null;
    /** The head of `proposalNumber` the editor read; sent with every PR-targeted write. */
    proposalHeadSha?: string | null;
  },
): Promise<EditorRun> {
  const request = saveRequest(input);
  const { kbId, baseRevision, op } = request;
  const proposal = request.proposalNumber;
  const proposalHead = request.proposalHeadSha;
  const markdown = op.kind === "delete" ? null : op.markdown;
  const bytes = markdown === null ? null : new TextEncoder().encode(markdown);
  const base = { memory, nextBaseRevision: baseRevision, markdown };
  if (bytes && bytes.length > STAGED_MARKDOWN_MAX_BYTES) {
    return { ...base, outcome: { kind: "error", reason: "tooLarge" } };
  }
  const assets = op.kind === "delete" ? [] : [...(op.assets ?? [])];
  if (assets.length > DOCUMENT_STAGED_ASSETS_MAX) {
    return { ...base, outcome: { kind: "error", reason: "tooManyImages" } };
  }
  const fingerprint = requestFingerprint(request);
  const key = memory.fingerprint === fingerprint && memory.key ? memory.key : deps.newKey();
  const pending: EditorMemory & { key: string } = {
    fingerprint,
    key,
    request,
    ...(memory.fingerprint === fingerprint && memory.upload
      ? { upload: { ...memory.upload } }
      : {}),
  };
  try {
    const target = {
      kbId,
      baseRevision,
      path: op.path,
      idempotencyKey: key,
      ...(proposal === null ? {} : { proposalNumber: proposal }),
      ...(proposalHead === null ? {} : { proposalHeadSha: proposalHead }),
    };
    let result: unknown;
    if (op.kind === "delete") {
      result = await deps.remove({ ...target, confirm: "DELETE" });
    } else {
      const content: Content =
        bytes && bytes.length > INLINE_MARKDOWN_MAX_BYTES
          ? await stageMarkdown(deps, kbId, pending, bytes)
          : { markdown: op.markdown };
      const document = { ...target, content, ...(assets.length > 0 ? { assets } : {}) };
      result = op.kind === "create" ? await deps.create(document) : await deps.update(document);
    }
    const parsed = parseApplyResult(result);
    const outcome = settleOutcome(parsed);
    return {
      outcome,
      memory: initialEditorMemory(),
      nextBaseRevision: outcome.kind === "noop" ? baseRevision : parsed.commitSha,
      markdown,
    };
  } catch (error) {
    const outcome = describeEditorError(error);
    return {
      ...base,
      outcome,
      // A headless conflict may be an in-progress reservation. Keep that exact
      // prepared request for explicit retry, without guessing success or a head.
      memory:
        outcome.kind === "retryable" || (outcome.kind === "conflict" && !outcome.headSha)
          ? pending
          : initialEditorMemory(),
    };
  }
}

/**
 * Images the editor's "Insert image" control stages: the inline image
 * formats the viewer renders and the server's media sniffer admits. Other
 * media still go through MCP (`knowledge_upload_begin` + `knowledge_assets_put`).
 */
export const EDITOR_IMAGE_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type EditorImageMime = (typeof EDITOR_IMAGE_MIMES)[number];
/** Server asset ceiling (`CAS_BLOB_MAX_BYTES`, docs/assets.md). */
export const ASSET_MAX_BYTES = 25 * 1024 * 1024;
const IMAGE_EXT: Record<EditorImageMime, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};
export const isEditorImageMime = (mime: string): mime is EditorImageMime =>
  (EDITOR_IMAGE_MIMES as readonly string[]).includes(mime);

/**
 * KB path for an inserted image: `assets/<name>-<hash8>.<ext>`. The name is
 * reduced to lowercase ASCII letters, digits and dashes so it is always a
 * valid portable KB path; the content-hash suffix keeps two different images
 * with the same file name (every pasted "image.png") from replacing each other.
 */
export function imageAssetPath(fileName: string, mime: EditorImageMime, hashHex: string): string {
  const stem =
    fileName
      .replace(/\.[^.]*$/, "")
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48)
      .replace(/-+$/, "") || "image";
  return `assets/${stem}-${hashHex.slice(0, 8)}.${IMAGE_EXT[mime]}`;
}

/** Markdown for an image at a KB-root path; alt text drops characters that end it. */
export function imageMarkdown(fileName: string, path: string): string {
  const alt = fileName
    .replace(/\.[^.]*$/, "")
    .replace(/[[\]\\\n\r]/g, " ")
    .trim()
    .slice(0, 120);
  // Root-relative: resolves the same from any document path (also a new
  // document whose path is still being typed), on the server and in the viewer.
  return `![${alt}](/${path})`;
}

export type AssetDeps = Pick<
  EditorDeps,
  "uploadBegin" | "uploadWrite" | "uploadFinish" | "newKey" | "sha256Hex"
> & {
  sleep: (ms: number) => Promise<void>;
};

/**
 * Image uploads that stopped before they were complete, by KB and content:
 * inserting the same image again continues from the last acknowledged chunk
 * instead of from zero.
 */
export type StagedImages = Map<string, EditorMemory & { key: string }>;

/**
 * An image staged for the next save (R3-W7): its upload is finished but
 * nothing is committed until the document is saved with it.
 */
export type StagedImage = {
  path: string;
  uploadId: string;
  hash: string;
  size: number;
  mime: EditorImageMime;
};

export type ImageStageRun =
  | { ok: true; image: StagedImage; markdown: string }
  | {
      ok: false;
      error: "type" | "tooLarge" | "retryable" | "rejected" | "gone" | "unknown";
    };

/**
 * Stages one image through the shared upload service (begin/write/finish,
 * kind "asset") and stops there: the document save commits it (R3-W7), so an
 * abandoned edit commits nothing and its upload simply expires. Rate-budget
 * refusals are waited out from the last acknowledged chunk. An interrupted
 * transfer is kept in `staged`, and inserting the same image resumes it.
 */
export async function runImageStage(
  deps: AssetDeps,
  input: {
    kbId: string;
    file: { name: string; type: string; bytes: Uint8Array };
    onProgress?: (sent: number, total: number) => void;
    /** The upload budget is spent: staging resumes after `seconds`. */
    onWait?: (seconds: number) => void;
    staged?: StagedImages;
  },
): Promise<ImageStageRun> {
  const { kbId, file, staged } = input;
  if (!isEditorImageMime(file.type)) return { ok: false, error: "type" };
  if (file.bytes.length === 0) return { ok: false, error: "rejected" };
  if (file.bytes.length > ASSET_MAX_BYTES) return { ok: false, error: "tooLarge" };
  const mime = file.type;
  let stagedKey: string | null = null;
  try {
    const hashHex = await deps.sha256Hex(file.bytes);
    const path = imageAssetPath(file.name, mime, hashHex);
    stagedKey = JSON.stringify([kbId, mime, hashHex]);
    const attempt = staged?.get(stagedKey) ?? { fingerprint: null, key: deps.newKey() };
    staged?.set(stagedKey, attempt);
    const { uploadId } = await stageUpload(
      { ...deps, sha256Hex: async () => hashHex },
      kbId,
      attempt,
      file.bytes,
      {
        kind: "asset",
        mime,
        keySuffix: "-asset",
        onProgress: input.onProgress,
        budget: { sleep: deps.sleep, onWait: input.onWait },
      },
    );
    staged?.delete(stagedKey);
    return {
      ok: true,
      image: { path, uploadId, hash: `sha256:${hashHex}`, size: file.bytes.length, mime },
      markdown: imageMarkdown(file.name, path),
    };
  } catch (error) {
    const outcome = describeEditorError(error);
    // Only an interrupted transfer (unknown outcome) is resumed; a refusal
    // starts over next time.
    if (stagedKey && outcome.kind !== "retryable") staged?.delete(stagedKey);
    if (outcome.kind === "retryable") return { ok: false, error: "retryable" };
    if (outcome.kind === "error")
      return {
        ok: false,
        error:
          outcome.reason === "gone" || outcome.reason === "unknown" ? outcome.reason : "rejected",
      };
    return { ok: false, error: "rejected" };
  }
}

/**
 * The staged images a save sends: those whose path the draft still links.
 * Paths end in a content hash, so a plain substring test is exact enough.
 */
export function linkedStagedImages<T extends { path: string }>(
  markdown: string,
  staged: readonly T[],
): T[] {
  return staged.filter((image) => markdown.includes(image.path));
}

const KB_PRIVATE_ROOTS = [
  "kbs",
  "documents",
  "search",
  "kbIndex",
  "pullRequests",
  "kbAssets",
  "kbExports",
  "kbMirror",
];

/**
 * Drops every cached query holding this KB's private data (share loss,
 * tombstone). A `kbs.get` that failed keeps its error (so the page can say the
 * KB is unavailable without refetching in a loop) but loses its old data.
 */
export function clearKbPrivateQueries(
  queryClient: QueryClient,
  kbId: string,
  options: {
    /**
     * Keep the KB's `kbs.get` entry for the caller to refetch: removing a
     * query detaches its mounted observers, which then keep showing the old
     * role and controls until a reload (R2-11).
     */
    keepAccessCheck?: boolean;
  } = {},
): void {
  for (const query of queryClient.getQueryCache().getAll()) {
    const [path, keyOptions] = query.queryKey as [unknown, { input?: { kbId?: unknown } }?];
    if (
      !Array.isArray(path) ||
      !KB_PRIVATE_ROOTS.includes(String(path[0])) ||
      keyOptions?.input?.kbId !== kbId
    )
      continue;
    if (options.keepAccessCheck && path[0] === "kbs" && path[1] === "get") continue;
    if (path[0] === "kbs" && path[1] === "get" && query.state.status === "error")
      query.setState({ data: undefined, dataUpdatedAt: 0 });
    else queryClient.removeQueries({ queryKey: query.queryKey, exact: true });
  }
}

/** Access is gone: forget the KB's private data and re-derive the KB list. */
function forgetKb(queryClient: QueryClient, kbId: string): void {
  clearKbPrivateQueries(queryClient, kbId);
  void queryClient.invalidateQueries({ queryKey: orpc.kbs.list.key() });
}

type KbGetOptions = { queryKey: readonly unknown[]; queryFn?: unknown };
export type KbAccessActor = { key: string; isCurrent: () => boolean };

/**
 * A denied action (NOT_FOUND/FORBIDDEN from a control or content call)
 * is not proof of lost access — a manager is refused owner-only actions, and a
 * missing document or PR is NOT_FOUND too. The KB's cached data is cleared
 * only when a refreshed permission check (`kbs.get`, fetched now) itself says
 * the caller can no longer read the KB. Otherwise that refetch just updates
 * the KB's live bits and `isOwner`, so stale controls re-derive and the view
 * and cache stay. A transient failure of the check clears nothing.
 */
export async function recheckKbAccess(
  queryClient: QueryClient,
  kbId: string,
  options: KbGetOptions = orpc.kbs.get.queryOptions({
    input: { kbId },
    context: { freshKbAccess: true },
  }),
  actor?: KbAccessActor,
): Promise<"kept" | "lost"> {
  // A retired UI still admits an authority check for its actor. Isolate its
  // in-flight result from another actor, then publish to the shared KB observer
  // only while that identity is still current (also after cancellation/await).
  const current = () => !actor || actor.isCurrent();
  if (!current()) return "kept";
  const queryKey = actor ? [...options.queryKey, actor.key] : options.queryKey;
  const publish = () => {
    if (!actor) return;
    const state = queryClient.getQueryState(queryKey);
    if (state)
      queryClient
        .getQueryCache()
        .find({ queryKey: options.queryKey, exact: true })
        ?.setState(state);
  };
  // staleTime alone does not bypass Query's in-flight deduplication. Cancel
  // the older result (including its later cache publication) before admitting
  // a new read. The context above also bypasses the transport's deduplication.
  await Promise.all([
    queryClient.cancelQueries({ queryKey: options.queryKey, exact: true }),
    ...(actor ? [queryClient.cancelQueries({ queryKey, exact: true })] : []),
  ]);
  if (!current()) return "kept";
  try {
    await queryClient.fetchQuery({
      ...(options as Parameters<QueryClient["fetchQuery"]>[0]),
      queryKey,
      staleTime: 0,
      retry: false,
    });
    if (current()) publish();
    return "kept";
  } catch (error) {
    if (!current() || !isAccessLoss(error)) return "kept";
    publish();
    forgetKb(queryClient, kbId);
    return "lost";
  }
}

/**
 * Whether the caller lost access to this KB, according to the KB permission
 * check (`kbs.get`) alone. Any KB-scoped query error that looks like a denial
 * triggers one fresh re-check (`recheckKbAccess`); only its answer clears data.
 */
export function useKbAccessLoss(kbId: string, errors: readonly unknown[]): boolean {
  const queryClient = useQueryClient();
  const { error: kbError } = useQuery({
    ...orpc.kbs.get.queryOptions({ input: { kbId } }),
    enabled: false,
  });
  const lost = isAccessLoss(kbError);
  const denied = errors.find((error) => error !== kbError && isAccessLoss(error));
  useEffect(() => {
    if (denied) void recheckKbAccess(queryClient, kbId);
  }, [denied, kbId, queryClient]);
  useEffect(() => {
    if (lost) forgetKb(queryClient, kbId);
  }, [lost, kbId, queryClient]);
  return lost;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * A staged image with the local object URL the live preview shows it from.
 * `sentWith` names the one save in flight that carries it; unset while it
 * waits for a save (R3-W7).
 */
export type EditorStagedImage = StagedImage & { objectUrl: string; sentWith?: string };

/**
 * Marks the waiting images the draft links as sent with save `saveId` and
 * returns them. Unlinked images stay waiting: a later save re-checks them.
 */
export function beginImageSave(
  images: readonly EditorStagedImage[],
  markdown: string,
  saveId: string,
): { images: EditorStagedImage[]; sent: EditorStagedImage[] } {
  const waiting = images.filter((image) => image.sentWith === undefined);
  const sent = new Set(linkedStagedImages(markdown, waiting));
  return {
    images: images.map((image) => (sent.has(image) ? { ...image, sentWith: saveId } : image)),
    sent: [...sent].map((image) => ({ ...image, sentWith: saveId })),
  };
}

/**
 * Settles save `saveId`: on success only the images it sent are retired
 * (committed); every other image stays staged. On failure they wait again.
 */
export function settleImageSave(
  images: readonly EditorStagedImage[],
  saveId: string,
  committed: boolean,
): { images: EditorStagedImage[]; retired: EditorStagedImage[] } {
  const mine = (image: EditorStagedImage) => image.sentWith === saveId;
  if (committed) return { images: images.filter((i) => !mine(i)), retired: images.filter(mine) };
  return {
    images: images.map((image) => {
      if (!mine(image)) return image;
      const { sentWith: _sent, ...waiting } = image;
      return waiting;
    }),
    retired: [],
  };
}

/**
 * What the preview shows after saves of this session (R3-W7): the revision
 * the last save produced and the assets saves committed, known from their
 * staging (path, hash, size, mime). Merged over the opening read's manifest
 * until that read itself lists them.
 */
export type CommittedPreview = { rev: string; assets: AssetRefLike[] };
type AssetRefLike = { path: string; hash: string; size: number; mime: string };

export function previewAfterSaves(
  opened: { rev: string; assets: readonly AssetRefLike[] },
  committed: CommittedPreview | null,
): { rev: string; assets: readonly AssetRefLike[] } {
  if (!committed) return opened;
  // Caught up once the page's own read is that revision or lists every
  // committed asset (a text-only save needs no pinning at all).
  const caughtUp =
    opened.rev === committed.rev ||
    committed.assets.every((a) =>
      opened.assets.some((b) => b.path === a.path && b.hash === a.hash),
    );
  if (caughtUp) return opened;
  return {
    rev: committed.rev,
    assets: [
      ...opened.assets.filter((a) => !committed.assets.some((b) => b.path === a.path)),
      ...committed.assets,
    ],
  };
}

/** The proposal a session edits, with the head its next write must name. */
export type EditedProposal = { number: number; headSha: string } | null;

/**
 * The proposal after a save outcome: a proposed save moves it to the new
 * head (so consecutive saves chain), a save to main leaves it, anything else
 * keeps it as it was (a stale head is only replaced by an explicit adopt).
 */
export function proposalAfterSave(current: EditedProposal, outcome: EditorOutcome): EditedProposal {
  if (outcome.kind === "proposed")
    return { number: outcome.proposalNumber, headSha: outcome.proposalHead };
  if (outcome.kind === "applied") return null;
  return current;
}

/**
 * The head a refused write of `item` may be confirmed against, or null.
 * A moved head is always asked again. A PROPOSAL_CONFLICT that lists the very
 * path being written is the consent question (overwriting what the
 * caller's PR changed needs the PR named with the head it read), so it is
 * asked again at that proposal head; one that lists only other paths is
 * blocked by them and cannot be confirmed here.
 */
export function confirmableConflict(
  outcome: Extract<EditorOutcome, { kind: "conflict" }>,
  item: { kind: ProposalConflictPath["kind"]; path: string },
): { headSha: string; proposalNumber: number | null } | null {
  if (!outcome.headSha) return null;
  if (outcome.proposalConflict) {
    const listed = outcome.proposalConflict.paths.some(
      (entry) => entry.kind === item.kind && entry.path === item.path,
    );
    if (!listed || outcome.proposalNumber === null) return null;
  }
  return { headSha: outcome.headSha, proposalNumber: outcome.proposalNumber };
}

/** The proposal after the user continues on a conflict's reported head. */
export function proposalAfterAdopt(
  outcome: Extract<EditorOutcome, { kind: "conflict" }> & { headSha: string },
): EditedProposal {
  return outcome.proposalNumber === null
    ? null
    : { number: outcome.proposalNumber, headSha: outcome.headSha };
}

/**
 * The document a session writes: its path, whether it exists there, and the
 * head its next write goes against. Receipts are the only source of a change
 * in existence; a new draft's path is fixed once a record names it.
 */
export type SessionDocument = { exists: boolean; head: string; path: string };

/** Where a session's next save goes, and what it still holds staged. */
export type SaveState = {
  memory: EditorMemory;
  images: EditorStagedImage[];
  document: SessionDocument;
  proposal: EditedProposal;
};

/**
 * What a caller asks a session for. Path and create/update are never the
 * caller's: both come from the session's document.
 */
export type SaveIntent = { kind: "write"; markdown: string } | { kind: "delete" };

function opFor(document: SessionDocument, intent: SaveIntent): EditorOp {
  if (intent.kind === "delete") return { kind: "delete", path: document.path };
  return {
    kind: document.exists ? "update" : "create",
    path: document.path,
    markdown: intent.markdown,
  };
}

type Receipt = Extract<EditorOutcome, { kind: "applied" | "proposed" | "noop" }>;
const isReceipt = (outcome: EditorOutcome): outcome is Receipt =>
  outcome.kind === "applied" || outcome.kind === "proposed" || outcome.kind === "noop";

export type SaveRun = SaveState & {
  /** The outcome of the save the user asked for (the last record sent). */
  outcome: EditorOutcome;
  /** Images whose record resolved with a receipt: committed, never sent again. */
  retired: EditorStagedImage[];
  /** The revision the last receipt names (preview pinning), else null. */
  savedRev: string | null;
  /** The last receipt of this run, also one recovered before a later refusal. */
  receipt: Receipt | null;
};

const receiptRev = (outcome: EditorOutcome): string | null =>
  outcome.kind === "applied" || outcome.kind === "noop"
    ? outcome.commitSha
    : outcome.kind === "proposed"
      ? outcome.proposalHead
      : null;

const sameOp = (a: EditorOp, b: EditorOp) =>
  a.kind === b.kind &&
  a.path === b.path &&
  (a.kind === "delete" || (b.kind !== "delete" && a.markdown === b.markdown));

/**
 * One Save (R3-W7). Each save is an immutable record (`memory.request`: key,
 * exact payload, its images) kept until its receipt resolves:
 *
 * - While a record is unresolved, Save first resends exactly that record. An
 *   unchanged draft is just that retry; a changed draft is sent as a NEW
 *   record only after the pending one got its receipt (its images are then
 *   committed, and base and proposal head advance to what it wrote).
 * - Every receipt, including a recovered one, sets the session's document
 *   (path, existence, head). The next record is derived from that document
 *   alone: its path, and create or update.
 * - A new record carries only images still staged that the draft links; each
 *   image belongs to one record at a time.
 * - A definite refusal returns the record's images to staged; an unknown
 *   outcome keeps the record (and its images) for the next retry.
 */
export async function runSave(
  deps: EditorDeps,
  state: SaveState,
  draft: {
    kbId: string;
    intent: SaveIntent;
    /** An explicit decision to write onto a conflict's reported head. */
    rebase?: { headSha: string; proposalNumber: number | null };
  },
): Promise<SaveRun> {
  let { memory, images, document, proposal } = state;
  const retired: EditorStagedImage[] = [];
  let savedRev: string | null = null;
  let receipt: Receipt | null = null;
  if (draft.rebase) {
    document = { ...document, head: draft.rebase.headSha };
    proposal = proposalAfterAdopt({
      kind: "conflict",
      headSha: draft.rebase.headSha,
      proposalNumber: draft.rebase.proposalNumber,
    });
  }
  const send = async (request: SaveRequest) => {
    const key = memory.key;
    const run = await runEditorOp(deps, memory, request);
    const rev = receiptRev(run.outcome);
    // Unresolved (unknown outcome, or a reservation still in progress):
    // the record and its images stay as they are.
    if (run.memory.request && key && run.memory.key === key) {
      memory = run.memory;
      return run.outcome;
    }
    const settled = key ? settleImageSave(images, key, rev !== null) : { images, retired: [] };
    images = settled.images;
    retired.push(...settled.retired);
    memory = initialEditorMemory();
    if (rev !== null && isReceipt(run.outcome)) {
      savedRev = rev;
      receipt = run.outcome;
      document = { exists: request.op.kind !== "delete", head: rev, path: request.op.path };
      proposal = proposalAfterSave(proposal, run.outcome);
    }
    return run.outcome;
  };
  const done = (outcome: EditorOutcome): SaveRun => ({
    memory,
    images,
    document,
    proposal,
    outcome,
    retired,
    savedRev,
    receipt,
  });
  const pending = memory.request;
  if (pending) {
    const retry = sameDraftBefore(pending, draft.kbId, document, proposal, draft.intent);
    const outcome = await send(pending);
    // A plain retry was the save asked for. A record still without a
    // receipt, or refused, stops here: the changed draft waits for the next
    // Save, never replacing a request whose outcome is unknown.
    if (retry || memory.request || receiptRev(outcome) === null) return done(outcome);
  }
  // A new record: a new key, and only the images still staged.
  let op = opFor(document, draft.intent);
  const key = deps.newKey();
  if (op.kind !== "delete") {
    const started = beginImageSave(images, op.markdown, key);
    images = started.images;
    if (started.sent.length > 0)
      op = { ...op, assets: started.sent.map(({ path, uploadId }) => ({ path, uploadId })) };
  }
  const request = saveRequest({
    kbId: draft.kbId,
    baseRevision: document.head,
    op,
    proposalNumber: proposal?.number ?? null,
    proposalHeadSha: proposal?.headSha ?? null,
  });
  memory = { fingerprint: requestFingerprint(request), key };
  return done(await send(request));
}

/** The draft is the pending record itself: Save was a plain retry. */
function sameDraftBefore(
  pending: SaveRequest,
  kbId: string,
  document: SessionDocument,
  proposal: EditedProposal,
  intent: SaveIntent,
): boolean {
  return (
    pending.kbId === kbId &&
    pending.baseRevision === document.head &&
    pending.proposalNumber === (proposal?.number ?? null) &&
    pending.proposalHeadSha === (proposal?.headSha ?? null) &&
    sameOp(pending.op, opFor(document, intent))
  );
}

/** Publish the receipt's head before any document read can follow the new target. */
async function followProposalHead(
  queryClient: QueryClient,
  kbId: string,
  proposal: NonNullable<EditedProposal>,
) {
  const options = orpc.pullRequests.get.queryOptions({
    input: { kbId, number: proposal.number },
  });
  await queryClient.cancelQueries({ queryKey: options.queryKey, exact: true });
  queryClient.setQueryData(options.queryKey, (data) =>
    data ? { ...data, pr: { ...data.pr, headSha: proposal.headSha } } : data,
  );
  await queryClient.invalidateQueries({ queryKey: options.queryKey, exact: true });
}

/** Complete identity of a document session; a main revision is an explicit read target. */
export type EditingTarget = {
  kbId: string;
  path: string;
  target: { kind: "main"; rev: string | null } | { kind: "proposal"; number: number };
};

/**
 * Everything a session owns besides the draft text: the document it writes
 * (path, existence, head), the proposal it edits, its unresolved record, and
 * the main revision it was opened at (until its first receipt). Its
 * `EditingTarget` is derived from this one object, never stored twice.
 */
type SessionTarget = {
  document: SessionDocument;
  proposal: EditedProposal;
  memory: EditorMemory;
  pinned: string | null;
  /**
   * A new draft no receipt has placed yet: its target is still the "New
   * document" page (path ""), whatever path is typed.
   */
  draft: boolean;
};

function sessionTarget(kbId: string, owned: SessionTarget): EditingTarget {
  return {
    kbId,
    path: owned.draft ? "" : owned.document.path,
    target: owned.proposal
      ? { kind: "proposal", number: owned.proposal.number }
      : { kind: "main", rev: owned.pinned },
  };
}

const sameTarget = (a: EditingTarget, b: EditingTarget) =>
  a.kbId === b.kbId &&
  a.path === b.path &&
  (a.target.kind === "main"
    ? b.target.kind === "main" && a.target.rev === b.target.rev
    : b.target.kind === "proposal" && a.target.number === b.target.number);

/** Editor state around `runSave`; the draft text lives here and only the user changes it. */
export function useKbEditor(input: {
  /**
   * The target the session opens on; afterwards the session owns it. A new
   * draft opens on path "" (the "New document" page).
   */
  target: EditingTarget;
  initialMarkdown: string;
  baseRevision: string;
  /** False for a document the next save creates (a new draft, or one its proposal deletes). */
  initialExists?: boolean;
  /**
   * A proposal target's head as read (PR mode, R3-W6), when the session's base
   * is not that head: every write names it, so a save never lands on a PR
   * that moved since (another editor, another tab).
   */
  proposalHead?: string;
  /**
   * The session's target moved (`next`) away from `previous`: a receipt
   * (including a recovered create) or an adopted proposal head.
   */
  onTargetAdvance?: (next: EditingTarget, previous: EditingTarget) => void;
}) {
  const queryClient = useQueryClient();
  const session = useKbMutationSession();
  const kbId = input.target.kbId;
  const [markdown, setMarkdown] = useState(input.initialMarkdown);
  // The session owns its target. Mirrored in a ref so an operation started
  // before React re-renders reads the target as it is now.
  const [owned, setOwnedState] = useState<SessionTarget>(() => ({
    document: {
      exists: input.initialExists ?? true,
      head: input.baseRevision,
      path: input.target.path,
    },
    proposal:
      input.target.target.kind === "proposal"
        ? {
            number: input.target.target.number,
            headSha: input.proposalHead ?? input.baseRevision,
          }
        : null,
    memory: initialEditorMemory(),
    pinned: input.target.target.kind === "main" ? input.target.target.rev : null,
    draft: input.target.path === "",
  }));
  const ownedRef = useRef(owned);
  const { onTargetAdvance } = input;
  const setOwned = useCallback(
    (next: SessionTarget) => {
      const previous = sessionTarget(kbId, ownedRef.current);
      ownedRef.current = next;
      setOwnedState(next);
      const target = sessionTarget(kbId, next);
      if (!sameTarget(previous, target)) onTargetAdvance?.(target, previous);
    },
    [kbId, onTargetAdvance],
  );
  const [outcome, setOutcome] = useState<EditorOutcome | null>(null);
  const create = useMutation(orpc.documents.create.mutationOptions());
  const update = useMutation(orpc.documents.update.mutationOptions());
  const remove = useMutation(orpc.documents.delete.mutationOptions());
  const begin = useMutation(orpc.kbUploads.begin.mutationOptions());
  const write = useMutation(orpc.kbUploads.write.mutationOptions());
  const finish = useMutation(orpc.kbUploads.finish.mutationOptions());
  // Image uploads report their own errors inline and wait out the upload
  // budget, so their refusals must not raise the global error toast.
  const quiet = { meta: { skipGlobalErrorToast: true } };
  const imageBegin = useMutation({ ...orpc.kbUploads.begin.mutationOptions(), ...quiet });
  const imageWrite = useMutation({ ...orpc.kbUploads.write.mutationOptions(), ...quiet });
  const imageFinish = useMutation({ ...orpc.kbUploads.finish.mutationOptions(), ...quiet });
  const partialImages = useRef<StagedImages>(new Map());
  // Finished image uploads waiting for the next save (R3-W7). The ref mirrors
  // the state so a save reads the list as it is when it is sent.
  const [stagedImages, setStagedImagesState] = useState<EditorStagedImage[]>([]);
  const stagedRef = useRef<EditorStagedImage[]>([]);
  const setStagedImages = useCallback((next: EditorStagedImage[]) => {
    stagedRef.current = next;
    setStagedImagesState(next);
  }, []);
  // The revision and assets this session's saves committed (preview pinning).
  const [committed, setCommitted] = useState<CommittedPreview | null>(null);
  // Object URLs belong to this session: released when it unmounts.
  useEffect(
    () => () => {
      for (const image of stagedRef.current) URL.revokeObjectURL(image.objectUrl);
    },
    [],
  );
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);

  const submit = useCallback(
    /**
     * `rebase` is an explicit user decision after a conflict (like `adoptHead`):
     * send this intent against that reported head (and the proposal it heads)
     * instead of the session's base.
     */
    async (intent: SaveIntent, rebase?: { headSha: string; proposalNumber: number | null }) => {
      if (submitting.current || !session.current) return;
      submitting.current = true;
      setPending(true);
      try {
        const before = ownedRef.current;
        // Resolves an unresolved earlier save first, then sends this draft
        // as its own record with only the images still staged (R3-W7).
        const run = await runSave(
          {
            create: create.mutateAsync,
            update: update.mutateAsync,
            remove: remove.mutateAsync,
            uploadBegin: begin.mutateAsync,
            uploadWrite: write.mutateAsync,
            uploadFinish: finish.mutateAsync,
            newKey: () => crypto.randomUUID(),
            sha256Hex,
          },
          {
            memory: before.memory,
            images: stagedRef.current,
            document: before.document,
            proposal: before.proposal,
          },
          { kbId, intent, ...(rebase ? { rebase } : {}) },
        );
        const { savedRev } = run;
        // Readers following the new target see the head this save wrote.
        if (run.receipt?.kind === "proposed" && run.proposal)
          await followProposalHead(queryClient, kbId, run.proposal);
        if (session.current) {
          setOutcome(run.outcome);
          // One update of the session's target: document, proposal head and
          // record. A changed target is reported to the page (navigation).
          setOwned({
            document: run.document,
            proposal: run.proposal,
            memory: run.memory,
            pinned: run.receipt ? null : before.pinned,
            draft: before.draft && !run.receipt,
          });
          // An image upload begun before Save can finish while its request is
          // in flight. Keep those new associations for the next draft.
          const known = new Set([...run.images, ...run.retired].map((image) => image.uploadId));
          setStagedImages([
            ...run.images,
            ...stagedRef.current.filter((image) => !known.has(image.uploadId)),
          ]);
          if (savedRev !== null) {
            // The preview now reads the saved revision, where the committed
            // images live: their local URLs are no longer needed.
            const assets = run.retired.map(({ path, hash, size, mime }) => ({
              path,
              hash,
              size,
              mime,
            }));
            setCommitted((prev) => ({
              rev: savedRev,
              assets: [
                ...(prev?.assets ?? []).filter((a) => !assets.some((b) => b.path === a.path)),
                ...assets,
              ],
            }));
          }
        }
        for (const image of run.retired) URL.revokeObjectURL(image.objectUrl);
        if (savedRev !== null) {
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: orpc.documents.key() }),
            queryClient.invalidateQueries({ queryKey: orpc.kbs.get.key() }),
            ...(run.proposal !== null
              ? [queryClient.invalidateQueries({ queryKey: orpc.pullRequests.key() })]
              : []),
            ...(run.retired.length > 0
              ? [queryClient.invalidateQueries({ queryKey: orpc.kbAssets.key() })]
              : []),
          ]);
        }
        if (run.outcome.kind === "error" && run.outcome.reason === "gone") {
          // NOT_FOUND may be a missing document, not a lost KB: re-check first.
          void recheckKbAccess(queryClient, kbId);
        }
        return session.current ? run.outcome : undefined;
      } finally {
        submitting.current = false;
        if (session.current) setPending(false);
      }
    },
    [
      session,
      create,
      update,
      remove,
      begin,
      write,
      finish,
      kbId,
      queryClient,
      setOwned,
      setStagedImages,
    ],
  );

  /**
   * Renames a new draft. The path is the session's own: fixed once the
   * document exists or while a record naming it is unresolved (a lost create
   * reply), so a save can never leave a stray copy at the previous path.
   */
  const pathEditable = !owned.document.exists && !owned.memory.request && !pending;
  const setPath = useCallback(
    (path: string) => {
      const current = ownedRef.current;
      if (current.document.exists || current.memory.request || submitting.current) return;
      setOwned({ ...current, document: { ...current.document, path } });
    },
    [setOwned],
  );

  /**
   * Stages one image for the next save (R3-W7). Nothing is committed: the
   * preview shows it from a local object URL and Save sends it with the text.
   */
  const insertImage = useCallback(
    async (
      file: File,
      onProgress?: (sent: number, total: number) => void,
      onWait?: (seconds: number) => void,
    ): Promise<ImageStageRun | undefined> => {
      if (submitting.current || !session.current) return undefined;
      // Refused before any bytes are read (the server enforces both again).
      if (!isEditorImageMime(file.type)) return { ok: false, error: "type" };
      if (file.size > ASSET_MAX_BYTES) return { ok: false, error: "tooLarge" };
      const run = await runImageStage(
        {
          uploadBegin: imageBegin.mutateAsync,
          uploadWrite: imageWrite.mutateAsync,
          uploadFinish: imageFinish.mutateAsync,
          newKey: () => crypto.randomUUID(),
          sha256Hex,
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        },
        {
          kbId,
          file: {
            name: file.name,
            type: file.type,
            bytes: new Uint8Array(await file.arrayBuffer()),
          },
          onProgress,
          onWait,
          staged: partialImages.current,
        },
      );
      if (!session.current) return undefined;
      if (run.ok) {
        // The same image inserted again replaces its earlier waiting upload.
        const replaced = stagedRef.current.filter(
          (image) => image.path === run.image.path && image.sentWith === undefined,
        );
        for (const image of replaced) URL.revokeObjectURL(image.objectUrl);
        setStagedImages([
          ...stagedRef.current.filter((image) => !replaced.includes(image)),
          { ...run.image, objectUrl: URL.createObjectURL(file) },
        ]);
      } else if (run.error === "gone") {
        void recheckKbAccess(queryClient, kbId);
      }
      return run;
    },
    [session, imageBegin, imageWrite, imageFinish, kbId, queryClient, setStagedImages],
  );

  /** Explicit user decision after a conflict: keep the draft, target the reported head. */
  const adoptHead = useCallback(() => {
    if (outcome?.kind !== "conflict" || !outcome.headSha) return;
    const current = ownedRef.current;
    // Continuing a proposal's head means editing that proposal, at that head.
    setOwned({
      ...current,
      document: { ...current.document, head: outcome.headSha },
      proposal: proposalAfterAdopt({ ...outcome, headSha: outcome.headSha }),
    });
    setOutcome(null);
  }, [outcome, setOwned]);

  return {
    markdown,
    setMarkdown,
    baseRevision: owned.document.head,
    /** The path this session writes (a new draft's typed path until it is fixed). */
    path: owned.document.path,
    setPath,
    pathEditable,
    /** Whether the session's document exists; a new draft's first save creates it. */
    exists: owned.document.exists,
    outcome,
    pending,
    paused: [
      create,
      update,
      remove,
      begin,
      write,
      finish,
      imageBegin,
      imageWrite,
      imageFinish,
    ].some((mutation) => mutation.isPaused),
    proposal: owned.proposal !== null,
    submit,
    adoptHead,
    insertImage,
    stagedImages,
    committed,
  };
}
