import { type Mutation, onlineManager, type QueryClient } from "@tanstack/react-query";

/**
 * The app's offline mutation policy, installed once on the QueryClient in
 * `router.tsx`. See docs/ui.md § Offline.
 *
 * - Default: fail fast. `networkMode: "always"` sends the request even while
 *   offline, so it fails at once with a network error that `friendly()` maps
 *   to "You're offline. Check your connection and try again." TanStack's
 *   default ("online") would instead pause the mutation: the button spins,
 *   Cancel stays disabled, and the write lands silently minutes later.
 * - Opt-in queue: `meta: { offline: "queue" }` keeps TanStack's paused
 *   behaviour for writes that are safe to replay (idempotent saves, drafts,
 *   preferences). The user is told it is waiting ("This change will be sent
 *   when you reconnect") and told again when it is sent. Paused mutations live
 *   in memory only: closing the tab drops them, and the copy says so.
 * - `meta: { offline: "queue", offlineNotice: "inline" }`: queued the same way,
 *   but the call site already says so from `isPaused` (the document editor's
 *   "The change will be sent when you reconnect."), so no toast: one notice,
 *   not two.
 *
 * An explicit `networkMode` on a call (or in `setMutationDefaults`) wins.
 */
export type OfflineMutationNotices = {
  /** A queued mutation is waiting for the network. */
  queued: () => void;
  /** A mutation that waited offline has now succeeded. */
  sent: () => void;
};

export function installOfflineMutationPolicy(
  queryClient: QueryClient,
  notices: OfflineMutationNotices,
): () => void {
  // TanStack's onlineManager assumes "online" until the first online/offline
  // event, so an app opened from cache while offline would run (and fail) a
  // queued mutation instead of pausing it. Start from the browser's answer;
  // the manager's own listeners take over from there. (On the server
  // `navigator.onLine` is undefined, so nothing changes.)
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    onlineManager.setOnline(false);
  }
  const defaultMutationOptions = queryClient.defaultMutationOptions.bind(queryClient);
  queryClient.defaultMutationOptions = ((options) => {
    const merged = defaultMutationOptions(options);
    if (merged.networkMode) return merged;
    return {
      ...merged,
      networkMode: merged.meta?.offline === "queue" ? "online" : "always",
    };
  }) as QueryClient["defaultMutationOptions"];

  // Mutations that have shown the "will be sent" notice, so they get exactly
  // one, and a "sent" toast once they land.
  const waited = new WeakSet<Mutation<unknown, unknown, unknown, unknown>>();
  return queryClient.getMutationCache().subscribe((event) => {
    if (event.type !== "updated") return;
    const { mutation } = event;
    // `isPaused` also marks a mutation waiting behind another one with the
    // same `scope.id`, online or not. Only a queued mutation waiting for the
    // network is news: a fail-fast one (`networkMode: "always"`) paused by its
    // scope runs, and fails, as soon as its turn comes.
    if (mutation.meta?.offlineNotice === "inline") return;
    if (
      mutation.state.isPaused &&
      !onlineManager.isOnline() &&
      mutation.options.networkMode !== "always"
    ) {
      if (waited.has(mutation)) return;
      waited.add(mutation);
      notices.queued();
      return;
    }
    if (event.action.type === "success" && waited.delete(mutation)) notices.sent();
    if (event.action.type === "error") waited.delete(mutation);
  });
}
