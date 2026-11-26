/**
 * Getting-started checklist core: progress and the per-user "hidden" flag. No
 * React; `components/home/getting-started.tsx` is the UI over it.
 * docs/ui.md § The signed-in home.
 *
 * Steps are never ticked by hand. Each step's `done` comes from real data (a
 * knowledge base exists, an AI client is connected, a second account exists), so the
 * list can only say what is actually true, and it disappears by itself once
 * everything is done. The one choice the user makes is to hide it early.
 *
 * That choice is stored in `localStorage` under a key that includes the
 * user's id, so on a shared browser one person hiding the list does not hide
 * it for the next, and it survives reloads and sign-outs. It is per browser,
 * not per account: a new device shows the list again until it is done or
 * hidden there too. An app that wants it to follow the account stores the
 * flag server-side instead (a user preference).
 *
 * Storage access is guarded like lib/consent.ts: Safari private mode and
 * "block all site data" throw on `localStorage`, and a checklist that crashes
 * the home is worse than one that comes back.
 */

export type GettingStartedProgress = {
  done: number;
  total: number;
  /** Every step is done: the checklist renders nothing. */
  allDone: boolean;
};

export function gettingStartedProgress(
  steps: readonly { done: boolean }[],
): GettingStartedProgress {
  const done = steps.filter((step) => step.done).length;
  return { done, total: steps.length, allDone: done === steps.length };
}

/**
 * Collapsed by default below Tailwind's `sm` (40rem: phones), where the open
 * list would push the page's main list below the fold; expanded from `sm` up.
 * Read once, when the checklist mounts, so rotating a phone does not toggle it
 * under the user's finger.
 */
export const GETTING_STARTED_EXPANDED_QUERY = "(min-width: 40rem)";

export function defaultGettingStartedExpanded(
  matchMedia: ((query: string) => { matches: boolean }) | undefined = typeof window === "undefined"
    ? undefined
    : window.matchMedia?.bind(window),
): boolean {
  if (!matchMedia) return true;
  return matchMedia(GETTING_STARTED_EXPANDED_QUERY).matches;
}

/** The subset of `Storage` this module uses (injectable for tests). */
export type FlagStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** The storage key for one user's "hidden" flag. `scope` is the user id. */
export function gettingStartedStorageKey(scope: string): string {
  return `knowledge-base.getting-started.hidden.${scope}`;
}

function browserStorage(): FlagStorage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

const listeners = new Set<() => void>();

/** Subscribe to changes of any scope's flag (this tab and, via `storage`, others). */
export function subscribeGettingStartedHidden(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key.startsWith("knowledge-base.getting-started.hidden."))
      listener();
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

/**
 * This tab's answer for a scope whose last write storage refused (private
 * mode, quota, disabled): Hide still hides for the rest of the session instead
 * of showing "hidden" over a visible checklist. A successful write clears it,
 * so normally the stored flag (shared with other tabs) is the answer.
 */
const sessionHidden = new Map<string, boolean>();

export function isGettingStartedHidden(
  scope: string,
  storage: FlagStorage | undefined = browserStorage(),
): boolean {
  const key = gettingStartedStorageKey(scope);
  const inSession = sessionHidden.get(key);
  if (inSession !== undefined) return inSession;
  try {
    return storage?.getItem(key) === "1";
  } catch {
    return false;
  }
}

export function setGettingStartedHidden(
  scope: string,
  hidden: boolean,
  storage: FlagStorage | undefined = browserStorage(),
): void {
  const key = gettingStartedStorageKey(scope);
  try {
    if (!storage) throw new Error("no storage");
    if (hidden) storage.setItem(key, "1");
    else storage.removeItem(key);
    sessionHidden.delete(key);
  } catch {
    // Unwritable storage: remember it for this session, back next visit.
    sessionHidden.set(key, hidden);
  }
  for (const listener of listeners) listener();
}

/**
 * Hide the checklist for `scope` and hand the caller an undo, which the UI
 * puts on its "Hidden" toast. Undo clears the stored flag, so the list is back
 * on this and every later visit.
 */
export function hideGettingStarted(
  scope: string,
  offerUndo: (undo: () => void) => void,
  storage: FlagStorage | undefined = browserStorage(),
): void {
  setGettingStartedHidden(scope, true, storage);
  offerUndo(() => setGettingStartedHidden(scope, false, storage));
}
