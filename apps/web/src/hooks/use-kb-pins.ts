import { toast } from "@knowledge-base/ui/components/sileo";
import {
  hashKey,
  type QueryClient,
  type QueryKey,
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useRef } from "react";
import { useTranslation } from "react-i18next";

import { useAuthSession } from "@/hooks/use-auth-session";
import { isSessionRejection, reportSessionRejected } from "@/lib/document-identity";
import { isQueryAccessError } from "@/lib/query-access-error";
import { orpc } from "@/utils/orpc";

export type PinnedKb = { kbId: string; name: string; slug: string };
type PinList = { items: PinnedKb[]; recent?: PinnedKb[] };

/** Pure: the list after moving one pin by `delta` places (clamped); unchanged when it can't move. */
export function movePin(items: readonly PinnedKb[], kbId: string, delta: number): PinnedKb[] {
  const from = items.findIndex((item) => item.kbId === kbId);
  if (from < 0) return [...items];
  const to = Math.min(items.length - 1, Math.max(0, from + delta));
  if (to === from) return [...items];
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

/** Pure: the list after dragging `kbId` onto the place of `overId`. */
export function dropPin(items: readonly PinnedKb[], kbId: string, overId: string): PinnedKb[] {
  const to = items.findIndex((item) => item.kbId === overId);
  const from = items.findIndex((item) => item.kbId === kbId);
  if (to < 0 || from < 0) return [...items];
  return movePin(items, kbId, to - from);
}

/** A pin change in flight, as `shownPins` reads it. */
export type PendingPinChange = { unpin: string } | { reorder: readonly string[] } | null;

/**
 * Pure: the pins to show while a change is in flight. Derived from the
 * server's latest answer, never written to the cache: it can only hide a row
 * being unpinned or reorder the rows the server returned, so it never shows
 * a KB the server no longer returns, and it is gone the moment the change
 * settles (done or refused, whether or not the list can be read again).
 */
export function shownPins(items: readonly PinnedKb[], change: PendingPinChange): PinnedKb[] {
  if (!change) return [...items];
  if ("unpin" in change) return items.filter((item) => item.kbId !== change.unpin);
  const rank = (id: string) => {
    const at = change.reorder.indexOf(id);
    return at < 0 ? change.reorder.length : at;
  };
  return [...items].sort((a, b) => rank(a.kbId) - rank(b.kbId));
}

/**
 * A pin change finished (done or refused): the lists are read again from the
 * server, the only source of what is shown. (The cache is one identity's: a
 * different one replaces the document, docs/ui.md § Query cache follows identity.)
 */
export function settlePinChange(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: orpc.kbPins.list.key() });
}

/**
 * Access to a KB is gone (or it was deleted): every cached pin list drops it
 * at once. Lists still in flight are cancelled
 * first: they were admitted before the loss, so their answers must not land.
 * The fresh reads that follow start after the loss and are the truth (a KB
 * readable again comes back through them).
 */
export async function forgetKbPin(queryClient: QueryClient, kbId: string): Promise<void> {
  const filters = { queryKey: orpc.kbPins.list.key() };
  await queryClient.cancelQueries(filters);
  queryClient.setQueriesData<PinList>(filters, (data) =>
    data
      ? {
          ...data,
          items: data.items.filter((item) => item.kbId !== kbId),
          ...(data.recent ? { recent: data.recent.filter((item) => item.kbId !== kbId) } : {}),
        }
      : data,
  );
  await queryClient.invalidateQueries(filters);
}

/**
 * A pin change or read refused for the whole session (signed out, or a
 * refusal that names no one KB): every cached pin list (the sidebar's with
 * recents, the buttons' without) is emptied at once, in-flight
 * reads cancelled first, so no earlier name stays cached behind a later
 * transient failure. After a pin change the lists are read again (the truth);
 * after a refused read (`except`: that read's own key, which answers empty
 * itself) they are not, so two refused reads never set each other off.
 */
export async function forgetAllPins(
  queryClient: QueryClient,
  options: { except?: QueryKey } = {},
): Promise<void> {
  const skip = options.except ? hashKey(options.except) : null;
  const filters = {
    queryKey: orpc.kbPins.list.key(),
    predicate: (query: { queryHash: string }) => query.queryHash !== skip,
  };
  await queryClient.cancelQueries(filters);
  // A list whose first read was cancelled here gets the empty answer too, so
  // it never waits idle with no data (nothing else would read it again).
  queryClient.setQueriesData<PinList>(filters, (data) =>
    data
      ? { ...data, items: [], ...(data.recent ? { recent: [] } : {}) }
      : { items: [], recent: [] },
  );
  if (!skip) await queryClient.invalidateQueries(filters);
}

/** Refused because the pins changed meanwhile (also a pin revoked since: never told apart). */
function isPinsChanged(error: unknown): boolean {
  const data = (error as { data?: { reason?: unknown } } | null)?.data;
  return data?.reason === "PINS_CHANGED";
}

/**
 * What a refused pin change forgets: refused as unreadable, that KB in every
 * cached list; refused for the whole session, or a reorder refused as stale
 * (a pin in it may have been revoked; which one is never said), all the
 * names until a fresh read says otherwise.
 */
export async function forgetOnPinRefusal(
  queryClient: QueryClient,
  error: unknown,
  input: unknown,
): Promise<void> {
  const kbId = (input as { kbId?: unknown } | null)?.kbId;
  if (typeof kbId === "string" && isNotFound(error)) return forgetKbPin(queryClient, kbId);
  if (isQueryAccessError(error) || isPinsChanged(error)) return forgetAllPins(queryClient);
}

/** A KB's name or slug changed: every cached pin list reads it again. */
export function refreshKbPins(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: orpc.kbPins.list.key() });
}

/** Any pin, unpin or reorder in flight (from any control): the others wait. */
export function useKbPinsBusy(): boolean {
  return useIsMutating({ mutationKey: orpc.kbPins.key({ type: "mutation" }) }) > 0;
}

/** Refused as unreadable (NOT_FOUND / FORBIDDEN, as `isAccessLoss` reads them). */
function isNotFound(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "NOT_FOUND" || code === "FORBIDDEN";
}

/**
 * A pin list read whose denial (signed out, refused) answers "nothing" rather
 * than failing: TanStack keeps the last data on a failed refetch, so a failure
 * would leave the earlier names cached (and shown again after any later
 * transient error). The empty answer replaces them, and `onDenied` lets the
 * other pin lists forget theirs; other failures still fail (loaded rows
 * stay, with a retry).
 */
export async function readPinsOrForget<T>(
  read: () => T | Promise<T>,
  empty: T,
  onDenied?: () => void,
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (isQueryAccessError(error)) {
      // Answered empty, the read no longer reaches the global error handler:
      // a session refusal still asks for the session check it would have
      // (a session lost elsewhere then replaces the document).
      if (isSessionRejection(error)) reportSessionRejected();
      onDenied?.();
      return empty;
    }
    throw error;
  }
}

/**
 * The viewer's pinned knowledge bases (only those they can read now, in
 * their order) and the pin / unpin / reorder actions. What is shown is always
 * the server's latest answer; while an unpin or reorder from this control is
 * in flight it is shown applied (`shownPins`), and a pin shows as pinned on
 * its button. A refusal says so (toast) and the list is read again.
 * The cache is the signed-in viewer's own: another identity replaces the
 * document (docs/ui.md § Query cache follows identity).
 * `recent`: remembered recently opened ids, named when still readable.
 */
export function useKbPins(options: { recent?: readonly string[]; enabled?: boolean } = {}) {
  const { t } = useTranslation("kb");
  const queryClient = useQueryClient();
  const auth = useAuthSession();
  const viewerId = auth.state.status === "authenticated" ? auth.state.session.user.id : null;
  const viewer = useRef(viewerId);
  viewer.current = viewerId;
  const recent = options.recent?.length ? [...options.recent] : undefined;
  const base = orpc.kbPins.list.queryOptions({ input: recent ? { recent } : {} });
  const {
    data,
    isPending: listPending,
    isError: listFailed,
    fetchStatus,
    refetch: refetchList,
  } = useQuery({
    ...base,
    queryFn: (context) =>
      readPinsOrForget(
        () => base.queryFn(context),
        { items: [], recent: [] },
        // The other pin lists forget their names too.
        () => void forgetAllPins(queryClient, { except: context.queryKey }),
      ),
    enabled: (options.enabled ?? true) && viewerId !== null,
    retry: false,
  });
  const served = data?.items ?? [];
  const busy = useKbPinsBusy();

  type Context = { viewerId: string | null };
  const settle = {
    onMutate: (): Context => ({ viewerId: viewer.current }),
    onError: (error: unknown, input: unknown, context: Context | undefined) => {
      // A viewer who signed out meanwhile hears nothing of it.
      if (!context || context.viewerId !== viewer.current) return;
      void forgetOnPinRefusal(queryClient, error, input);
      toast.error(t("pins.failed"));
    },
    onSettled: (_data: unknown, _error: unknown, _input: unknown, context: Context | undefined) => {
      if (!context || context.viewerId !== viewer.current) return;
      return settlePinChange(queryClient);
    },
    meta: { skipGlobalErrorToast: true },
  };
  const pinMutation = useMutation(orpc.kbPins.pin.mutationOptions(settle));
  const unpinMutation = useMutation(orpc.kbPins.unpin.mutationOptions(settle));
  const reorderMutation = useMutation(orpc.kbPins.reorder.mutationOptions(settle));

  const change: PendingPinChange =
    unpinMutation.isPending && unpinMutation.variables
      ? { unpin: unpinMutation.variables.kbId }
      : reorderMutation.isPending && reorderMutation.variables
        ? { reorder: reorderMutation.variables.kbIds }
        : null;
  const items = shownPins(served, change);
  const pinning = pinMutation.isPending ? (pinMutation.variables?.kbId ?? null) : null;

  return {
    items,
    recent: data?.recent ?? [],
    /** No answer yet (nothing to show but a skeleton). */
    isPending: listPending && viewerId !== null,
    /** No answer yet and the first read waits for the network (offline). */
    isOffline: listPending && viewerId !== null && fetchStatus === "paused",
    /** The last read failed (rows already loaded stay; a refusal reads as no pins). */
    isError: listFailed,
    refetch: () => void refetchList(),
    isPinned: (kbId: string) => kbId === pinning || items.some((item) => item.kbId === kbId),
    pin: (kb: PinnedKb) => {
      if (!busy && !served.some((item) => item.kbId === kb.kbId))
        pinMutation.mutate({ kbId: kb.kbId });
    },
    unpin: (kbId: string) => {
      if (!busy) unpinMutation.mutate({ kbId });
    },
    /** `onSettled(done)`: the reorder finished, taken (`true`) or refused. */
    reorder: (next: readonly PinnedKb[], onSettled?: (done: boolean) => void) => {
      if (busy) return;
      reorderMutation.mutate(
        { kbIds: next.map((item) => item.kbId) },
        { onSuccess: () => onSettled?.(true), onError: () => onSettled?.(false) },
      );
    },
    /** The KB a pin request is in flight for (its toggle shows pressed meanwhile). */
    pinning,
    /** A pin change is in flight (any control): pin, unpin and reorder wait for it. */
    busy,
  };
}
