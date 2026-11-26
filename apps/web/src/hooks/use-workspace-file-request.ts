import { useEffect, useRef } from "react";

import {
  FILE_REQUEST_TTL_MS,
  useKbWorkspaceStore,
  type WorkspaceFileRequest,
} from "@/stores/kb-workspace";

type Pending = {
  owner: string;
  kbId: string;
  request: WorkspaceFileRequest;
  at: number;
  id: number;
};

/**
 * Pure: whether a pending tree request is for this page now: the same viewer
 * and KB, still fresh, and accepted by `accepts` (its kind and path).
 */
export function fileRequestFor<K extends WorkspaceFileRequest["kind"]>(
  pending: Pending | null,
  owner: string | null,
  kbId: string,
  kind: K,
  accepts: (request: Extract<WorkspaceFileRequest, { kind: K }>) => boolean,
  now: number,
): Extract<WorkspaceFileRequest, { kind: K }> | null {
  if (!pending || owner === null || pending.owner !== owner || pending.kbId !== kbId) return null;
  if (now - pending.at > FILE_REQUEST_TTL_MS) return null;
  const { request } = pending;
  if (!isKind(request, kind)) return null;
  return accepts(request) ? request : null;
}

const isKind = <K extends WorkspaceFileRequest["kind"]>(
  request: WorkspaceFileRequest,
  kind: K,
): request is Extract<WorkspaceFileRequest, { kind: K }> => request.kind === kind;

/**
 * Claims `pending` for this page and runs it: `apply` runs only for the one
 * caller whose claim succeeds (a replayed effect claims nothing).
 */
export function claimFileRequest<R>(
  pending: { id: number },
  request: R,
  take: (id: number) => boolean,
  apply: (request: R) => void,
): boolean {
  if (!take(pending.id)) return false;
  apply(request);
  return true;
}

/**
 * Carries out a file operation the workspace tree asked for, once this page
 * can (`ready`): the request is taken exactly once, then `apply` runs it with
 * the page's own session. A request this page can't take stays for no one
 * else and goes stale.
 */
export function useWorkspaceFileRequest<K extends WorkspaceFileRequest["kind"]>({
  owner,
  kbId,
  kind,
  ready,
  accepts,
  apply,
}: {
  /** The viewer this page belongs to (`user:<id>`; null: takes nothing). */
  owner: string | null;
  kbId: string;
  kind: K;
  ready: boolean;
  accepts: (request: Extract<WorkspaceFileRequest, { kind: K }>) => boolean;
  apply: (request: Extract<WorkspaceFileRequest, { kind: K }>) => void;
}) {
  const pending = useKbWorkspaceStore((state) => state.fileRequest);
  // The latest callbacks, read when a request arrives (a new closure alone runs nothing).
  const handlers = useRef({ accepts, apply });
  handlers.current = { accepts, apply };
  useEffect(() => {
    if (!ready || !pending) return;
    const request = fileRequestFor(
      pending,
      owner,
      kbId,
      kind,
      handlers.current.accepts,
      Date.now(),
    );
    if (!request) return;
    // Claimed before it runs: a request is carried out once.
    claimFileRequest(
      pending,
      request,
      useKbWorkspaceStore.getState().takeFileRequest,
      handlers.current.apply,
    );
  }, [ready, pending, owner, kbId, kind]);
}
