import { KB_EXPORT_ACK_TIMEOUT_MS } from "@knowledge-base/config/orpc-batch";
import { type UseMutationOptions, useMutation } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

export type ExportKind = "assets" | "whole";
export type ExportPrepareInput = {
  kbId: string;
  rev: string;
  kind: ExportKind;
  idempotencyKey: string;
};
/** The fields of `knowledge_export_prepare` output this flow relies on. */
export type ExportPrepared = {
  transferId: string;
  rev: string;
  size: number;
  contentHash: string;
  expiresAt: string;
  mime: "application/zip";
};
export type ExportState =
  | { status: "idle" }
  | { status: "preparing"; kind: ExportKind }
  | { status: "downloading"; kind: ExportKind }
  | { status: "done"; kind: ExportKind; size: number }
  | { status: "expired"; kind: ExportKind }
  | { status: "error"; kind: ExportKind };
export type ExportOutcome = Extract<ExportState, { status: "done" | "expired" | "error" }>;

const KB_ID = /^[a-z0-9]{24,32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Same-origin, session-authenticated artifact route. The URL carries no token
 * and no query: authority is the browser session, rechecked per frame.
 */
export function kbExportDownloadUrl(kbId: string, transferId: string): string {
  if (!KB_ID.test(kbId) || !UUID.test(transferId)) throw new Error("Invalid transfer reference");
  return `/kb-exports/${kbId}/${transferId}`;
}

async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `sha256:${Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Fetches the prepared artifact and hands it to `save` only when the bytes
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

/**
 * Prepare (via the caller's `kbExports.prepare` mutation options) then
 * download one ZIP at an immutable revision and acknowledge it
 * (`kbExports.complete`). Each click is a new export
 * (fresh idempotency key); one attempt per current selection runs at a time.
 */
export type ExportCompleteInput = { kbId: string; transferId: string };

export function useKbExport({
  kbId,
  rev,
  prepare,
  complete,
}: {
  kbId: string;
  rev: string;
  prepare: Pick<
    UseMutationOptions<ExportPrepared, Error, ExportPrepareInput>,
    "mutationFn" | "mutationKey"
  >;
  /** The caller's `kbExports.complete` mutation options. */
  complete: Pick<
    UseMutationOptions<unknown, Error, ExportCompleteInput>,
    "mutationFn" | "mutationKey"
  >;
}) {
  const mutation = useMutation<ExportPrepared, Error, ExportPrepareInput>({
    ...prepare,
    // This panel owns inline feedback, including suppression after navigation.
    meta: { skipGlobalErrorToast: true },
  });
  const acknowledge = useMutation<unknown, Error, ExportCompleteInput>({
    ...complete,
    // Completion failure is nonfatal to the saved download (server EOF grace).
    meta: { skipGlobalErrorToast: true },
    // Bound even a custom caller's never-settling completion. The production
    // oRPC transport also aborts the request at this deadline.
    mutationFn: async (input, context) => {
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
  const owner = useMemo(() => ({ kbId, rev, active: true, busy: false, attempt: 0 }), [kbId, rev]);
  useEffect(() => {
    owner.active = true;
    return () => {
      owner.active = false;
    };
  }, [owner]);
  const [feedback, setFeedback] = useState<{ owner: typeof owner; state: ExportState }>({
    owner,
    state: { status: "idle" },
  });
  const state: ExportState = feedback.owner === owner ? feedback.state : { status: "idle" };
  const start = async (kind: ExportKind) => {
    if (!owner.active || owner.busy) return;
    owner.busy = true;
    const attempt = ++owner.attempt;
    const publish = (state: ExportState) => {
      if (owner.active && owner.attempt === attempt) setFeedback({ owner, state });
    };
    publish({ status: "preparing", kind });
    let prepared: ExportPrepared;
    try {
      prepared = await mutation.mutateAsync({
        kbId,
        rev,
        kind,
        idempotencyKey: crypto.randomUUID(),
      });
    } catch {
      owner.busy = false;
      publish({ status: "error", kind });
      return;
    }
    publish({ status: "downloading", kind });
    // An explicitly requested download continues with its original KB/rev
    // after navigation/unmount. It still saves/acknowledges its own transfer;
    // only the current mount/selection/attempt may publish panel feedback.
    const outcome = await downloadPreparedExport({
      kbId,
      kind,
      prepared,
      save: saveBlob,
      acknowledge: acknowledge.mutateAsync,
    });
    owner.busy = false;
    publish(outcome);
  };
  return { state, start };
}
