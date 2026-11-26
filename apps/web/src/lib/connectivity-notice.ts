/**
 * What the shell's offline band says: "offline" while `navigator.onLine` is
 * false, then "back-online" for a few seconds after reconnecting, then
 * nothing. A tiny external store so the band (useSyncExternalStore) and its
 * test share one implementation. See docs/ui.md § Offline.
 */
export type ConnectivityNotice = "offline" | "back-online" | null;

/** How long "Back online" stays before the band empties. */
export const BACK_ONLINE_MS = 4000;

type Target = Pick<EventTarget, "addEventListener" | "removeEventListener">;

export type ConnectivityNoticeStore = {
  getSnapshot: () => ConnectivityNotice;
  subscribe: (listener: () => void) => () => void;
};

export function createConnectivityNotice(
  target: Target,
  isOnline: () => boolean,
  timers: {
    set: (fn: () => void, ms: number) => unknown;
    clear: (handle: unknown) => void;
  } = {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  },
): ConnectivityNoticeStore {
  let notice: ConnectivityNotice = isOnline() ? null : "offline";
  let timer: unknown;
  const listeners = new Set<() => void>();

  const set = (next: ConnectivityNotice) => {
    if (next === notice) return;
    notice = next;
    for (const listener of listeners) listener();
  };
  const stopTimer = () => {
    if (timer !== undefined) timers.clear(timer);
    timer = undefined;
  };
  const onOffline = () => {
    stopTimer();
    set("offline");
  };
  const onOnline = () => {
    // Only a reconnect earns "Back online"; a stray `online` event does not.
    if (notice !== "offline") return;
    set("back-online");
    stopTimer();
    timer = timers.set(() => {
      timer = undefined;
      set(null);
    }, BACK_ONLINE_MS);
  };

  return {
    getSnapshot: () => notice,
    subscribe(listener) {
      if (listeners.size === 0) {
        target.addEventListener("offline", onOffline);
        target.addEventListener("online", onOnline);
        // Catch up on a change that happened while nobody listened.
        if (!isOnline()) onOffline();
        else if (notice === "offline") set(null);
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        target.removeEventListener("offline", onOffline);
        target.removeEventListener("online", onOnline);
        stopTimer();
        if (notice === "back-online") notice = null;
      };
    },
  };
}
