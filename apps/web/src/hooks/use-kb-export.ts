import { KB_EXPORT_ACK_TIMEOUT_MS } from "@knowledge-base/config/orpc-batch";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import { isAccessLoss, useKbAccessLoss } from "@/hooks/use-kb-editor";
import { orpc } from "@/utils/orpc";

export type ExportKind = "assets" | "whole";
/** The ready fields of a `knowledge_export_prepare` job this download relies on. */
export type ExportPrepared = {
  transferId: string;
  size: number;
  contentHash: string;
  expiresAt: string;
};
/** A background export job (`exportJobSchema`). */
export type ExportJob = {
  transferId: string;
  kind: ExportKind;
  rev: string;
  state: "pending" | "building" | "ready" | "failed" | "cancelled" | "expired";
  progress: { doneBytes: number; totalBytes: number | null };
  size: number | null;
  contentHash: string | null;
  expiresAt: string | null;
  error: { code: string; message: string } | null;
};
export type DownloadState =
  | { status: "downloading" }
  | { status: "done"; size: number }
  | { status: "expired" }
  | { status: "error" };
export type ExportOutcome =
  | { status: "done"; kind: ExportKind; size: number }
  | { status: "expired"; kind: ExportKind }
  | { status: "error"; kind: ExportKind };
export type ExportCompleteInput = { kbId: string; transferId: string };

/** What the downloads panel shows. */
export type ExportView =
  | { status: "loading" }
  | { status: "idle"; lookupFailed: boolean }
  | { status: "preparing"; job: ExportJob; percent: number | null }
  | { status: "ready"; job: ExportJob; download: DownloadState | null }
  | { status: "failed"; job: ExportJob }
  | { status: "cancelled"; job: ExportJob }
  | { status: "expired"; job: ExportJob };
/** Why a start was refused: capacity (another job holds the slot) or anything else. */
export type StartError = "capacity" | "other";

const KB_ID = /^[a-z0-9]{24,32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Status poll while a job is pending or building. */
export const EXPORT_POLL_MS = 1500;

/**
 * Same-origin, session-authenticated artifact route. The URL carries no token
 * and no query: authority is the browser session, rechecked per frame.
 */
export function kbExportDownloadUrl(kbId: string, transferId: string): string {
  if (!KB_ID.test(kbId) || !UUID.test(transferId)) throw new Error("Invalid transfer reference");
  return `/kb-exports/${kbId}/${transferId}`;
}

export function isActiveJob(job: ExportJob | null | undefined): boolean {
  return job?.state === "pending" || job?.state === "building";
}

/** Whole percent of content written, once the total is known. */
export function exportPercent(job: ExportJob): number | null {
  const { doneBytes, totalBytes } = job.progress;
  if (totalBytes === null) return null;
  if (totalBytes === 0) return job.state === "ready" ? 100 : 0;
  return Math.min(100, Math.floor((doneBytes / totalBytes) * 100));
}

/**
 * The panel state for one job. A job from an earlier visit that was cancelled
 * or expired is history, not news: it shows as idle. A failure is shown
 * either way, so a job that failed while the page was closed is reported.
 */
export function exportView(input: {
  job: ExportJob | null;
  startedHere: boolean;
  download: DownloadState | null;
  lookupPending: boolean;
  lookupFailed: boolean;
}): ExportView {
  const { job } = input;
  if (!job) {
    if (input.lookupPending) return { status: "loading" };
    return { status: "idle", lookupFailed: input.lookupFailed };
  }
  if (isActiveJob(job)) return { status: "preparing", job, percent: exportPercent(job) };
  if (job.state === "ready") return { status: "ready", job, download: input.download };
  if (job.state === "failed") return { status: "failed", job };
  // A finished download is acknowledged, which releases it (state "expired").
  if (input.download?.status === "done") return { status: "ready", job, download: input.download };
  if (!input.startedHere) return { status: "idle", lookupFailed: false };
  return job.state === "cancelled" ? { status: "cancelled", job } : { status: "expired", job };
}

/**
 * Poll while the job is pending/building. Until a status read succeeds, the
 * started/latest job decides, so a failed first read keeps polling
 * (transient-error recovery) instead of stalling on "preparing".
 */
export function statusPollInterval(
  data: ExportJob | undefined,
  fallback: ExportJob | null,
  error: unknown = null,
): number | false {
  // A denial (lost read access, or the job is no longer ours) stops polling.
  if (isAccessLoss(error)) return false;
  return isActiveJob(data ?? fallback) ? EXPORT_POLL_MS : false;
}

/** The job the panel shows: the freshest read of the tracked job, never a denied one. */
export function visibleJob(input: {
  denied: boolean;
  trackedId: string | null;
  status: ExportJob | undefined;
  own: ExportJob | null;
  latest: ExportJob | null | undefined;
}): ExportJob | null {
  if (input.denied || !input.trackedId) return null;
  if (input.status?.transferId === input.trackedId) return input.status;
  if (input.own) return input.own;
  return input.latest?.transferId === input.trackedId ? input.latest : null;
}

/** A failed cancel is reported only for the job it was sent for. */
export function cancelFailedFor(
  job: ExportJob | null,
  cancel: { failed: boolean; transferId: string | undefined },
): boolean {
  return cancel.failed && job !== null && cancel.transferId === job.transferId;
}

/** Cached job data is hidden once the KB, or the job itself, is denied. */
export function exportDenied(lost: boolean, errors: readonly unknown[]): boolean {
  return lost || errors.some(isAccessLoss);
}

async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `sha256:${Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Fetches the ready artifact and hands it to `save` only when the bytes
 * are exactly the prepared artifact (size + SHA-256), then acknowledges the
 * completed download in the background so the server releases it.
 * Saved-download success does not wait for acknowledgement. Expired/revoked
 * transfers (client-side expiry or a 401/403/404 from the route) are
 * `expired`; every other failure is `error`. Nothing is saved on failure.
 */
export async function downloadPreparedExport(input: {
  kbId: string;
  kind: ExportKind;
  prepared: ExportPrepared;
  fetchImpl?: typeof fetch;
  now?: () => number;
  save: (blob: Blob, filename: string) => void;
  /** Tells the server the download is complete (releases the slot). */
  acknowledge: (input: { kbId: string; transferId: string }) => Promise<unknown>;
}): Promise<ExportOutcome> {
  const { kind, prepared } = input;
  const now = input.now ?? Date.now;
  const expiresAt = Date.parse(prepared.expiresAt);
  if (!Number.isFinite(expiresAt) || now() >= expiresAt) return { status: "expired", kind };
  let url: string;
  try {
    url = kbExportDownloadUrl(input.kbId, prepared.transferId);
  } catch {
    return { status: "error", kind };
  }
  try {
    const response = await (input.fetchImpl ?? fetch)(url, {
      credentials: "same-origin",
      cache: "no-store",
    });
    if ([401, 403, 404].includes(response.status)) return { status: "expired", kind };
    if (!response.ok) return { status: "error", kind };
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength !== prepared.size || (await sha256(bytes)) !== prepared.contentHash)
      return { status: "error", kind };
    input.save(
      new Blob([bytes], { type: "application/zip" }),
      `knowledge-base-${input.kbId}-${kind}.zip`,
    );
    // Acknowledge only after the verified bytes are saved. A failed
    // acknowledgement is not a failed download: the server's grace window
    // releases the export on its own.
    void Promise.resolve()
      .then(() => input.acknowledge({ kbId: input.kbId, transferId: prepared.transferId }))
      .catch(() => undefined);
    return { status: "done", kind, size: bytes.byteLength };
  } catch {
    return { status: "error", kind };
  }
}

/** Browser save of a verified Blob; the object URL never leaves this page. */
function saveBlob(blob: Blob, filename: string) {
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(href), 60_000);
}

function startError(error: unknown): StartError {
  const code = error && typeof error === "object" && "code" in error ? error.code : null;
  return code === "TOO_MANY_REQUESTS" ? "capacity" : "other";
}

/**
 * One KB's background export job. The server owns the build: the panel finds
 * the requester's latest job on mount (so it survives a reload or a closed
 * browser), polls it while pending/building, and downloads only on a click
 * once it is ready. Each start uses a fresh idempotency key; the server
 * returns the existing job for a repeated scope instead of building twice.
 */
export function useKbExport({ kbId, rev }: { kbId: string; rev: string }) {
  const queryClient = useQueryClient();
  const [started, setStarted] = useState<{ kbId: string; job: ExportJob } | null>(null);
  const [startFailure, setStartFailure] = useState<{ kbId: string; error: StartError } | null>(
    null,
  );
  const [downloads, setDownloads] = useState<Record<string, DownloadState>>({});
  const latest = useQuery(orpc.kbExports.latest.queryOptions({ input: { kbId }, staleTime: 0 }));
  const own = started?.kbId === kbId ? started.job : null;
  const trackedId = own?.transferId ?? latest.data?.transferId ?? null;
  const status = useQuery({
    ...orpc.kbExports.status.queryOptions({
      input: trackedId ? { kbId, transferId: trackedId } : skipToken,
      staleTime: 0,
    }),
    refetchInterval: (query) =>
      statusPollInterval(query.state.data, own ?? latest.data ?? null, query.state.error),
  });
  const prepare = useMutation({
    ...orpc.kbExports.prepare.mutationOptions(),
    // This panel owns inline feedback.
    meta: { skipGlobalErrorToast: true },
  });
  const cancel = useMutation({
    ...orpc.kbExports.cancel.mutationOptions({
      onSuccess: (job, variables) => {
        queryClient.setQueryData(
          orpc.kbExports.status.queryKey({
            input: { kbId: variables.kbId, transferId: job.transferId },
          }),
          job,
        );
      },
    }),
    meta: { skipGlobalErrorToast: true },
  });
  const complete = orpc.kbExports.complete.mutationOptions();
  const acknowledge = useMutation({
    mutationKey: complete.mutationKey,
    // Completion failure is nonfatal to the saved download (server EOF grace).
    meta: { skipGlobalErrorToast: true },
    // Bound even a never-settling completion. The production oRPC
    // transport also aborts the request at this deadline.
    mutationFn: async (input: ExportCompleteInput, context) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          complete.mutationFn?.(input, context),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Export acknowledgement timed out")),
              KB_EXPORT_ACK_TIMEOUT_MS,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  });
  // A download continues after unmount (it saves and acknowledges its own
  // transfer); only the mounted panel publishes its outcome.
  const owner = useMemo(() => ({ kbId, active: true }), [kbId]);
  useEffect(() => {
    owner.active = true;
    return () => {
      owner.active = false;
    };
  }, [owner]);

  // Denials reach the KB's shared access-loss handling; cached job data is
  // hidden as soon as read access (or the job itself) is denied.
  const lost = useKbAccessLoss(kbId, [latest.error, status.error, cancel.error]);
  const denied = exportDenied(lost, [status.error, latest.error]);
  const job = visibleJob({ denied, trackedId, status: status.data, own, latest: latest.data });
  const view = exportView({
    job,
    startedHere: own !== null && own.transferId === job?.transferId,
    download: job ? (downloads[job.transferId] ?? null) : null,
    lookupPending: latest.isPending,
    lookupFailed: latest.isError,
  });

  const start = async (kind: ExportKind) => {
    if (prepare.isPending || isActiveJob(job)) return;
    setStartFailure(null);
    try {
      const prepared = await prepare.mutateAsync({
        kbId,
        rev,
        kind,
        idempotencyKey: crypto.randomUUID(),
      });
      if (owner.active) setStarted({ kbId, job: prepared });
    } catch (error) {
      if (owner.active) setStartFailure({ kbId, error: startError(error) });
    }
  };
  const stop = () => {
    if (!job || cancel.isPending) return;
    cancel.reset();
    cancel.mutate({ kbId, transferId: job.transferId });
  };
  const download = async () => {
    if (job?.state !== "ready" || job.size === null || !job.contentHash || !job.expiresAt) return;
    const target = job;
    const prepared: ExportPrepared = {
      transferId: job.transferId,
      size: job.size,
      contentHash: job.contentHash,
      expiresAt: job.expiresAt,
    };
    const publish = (state: DownloadState) => {
      if (owner.active) setDownloads((all) => ({ ...all, [target.transferId]: state }));
    };
    if (downloads[target.transferId]?.status === "downloading") return;
    publish({ status: "downloading" });
    const outcome = await downloadPreparedExport({
      kbId,
      kind: target.kind,
      prepared,
      save: saveBlob,
      acknowledge: acknowledge.mutateAsync,
    });
    publish(
      outcome.status === "done"
        ? { status: "done", size: outcome.size }
        : { status: outcome.status },
    );
  };
  return {
    view,
    startError: startFailure?.kbId === kbId ? startFailure.error : null,
    starting: prepare.isPending,
    cancelling: cancel.isPending,
    /** The last cancel/discard failed (not a denial); pressing it again retries. */
    cancelFailed: cancelFailedFor(job, {
      failed: cancel.isError && !denied,
      transferId: cancel.variables?.transferId,
    }),
    start,
    cancel: stop,
    download,
    retryLookup: () => void latest.refetch(),
  };
}
