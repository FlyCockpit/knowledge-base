/**
 * Recovery for a tab that outlived a deploy. Each deploy replaces the hashed
 * /assets/* chunks, so a tab still running the old build fails to import a
 * route or lazy component it has not loaded yet. Vite reports that as a
 * `vite:preloadError` window event; route chunks fail through it too, because
 * TanStack's lazyRouteComponent wraps Vite's preload helper.
 *
 * Recovery is one full document navigation to the page the user was going
 * to. The SW updates silently, so a reload is never forced for any other
 * reason.
 */

export const STALE_BUILD_RELOAD_KEY = "kb:stale-build-reload-at";
export const STALE_BUILD_RELOAD_COOLDOWN_MS = 10_000;
/** How recent a click or key press must be to count as the cause of a failed import. */
export const USER_INPUT_WINDOW_MS = 1_000;

type Location = { href: string; publicHref: string };

type StaleBuildRouter = {
  latestLocation: Location;
  state: { resolvedLocation?: { href: string }; isLoading: boolean };
};

export type StaleBuildRecoveryEnv = {
  router: StaleBuildRouter;
  /** undefined when sessionStorage cannot be opened. */
  storage: Pick<Storage, "getItem" | "setItem"> | undefined;
  now: number;
  /** Captured at navigation start, never from unrelated input during a load. */
  activatedNavigationHref?: string;
  /** `navigator.onLine === false`: the chunk is missing because the network is. */
  offline?: boolean;
  assign: (href: string) => void;
};

/** The URL the router is navigating to, or undefined when no navigation is in flight. */
function pendingNavigationHref(router: StaleBuildRouter): string | undefined {
  const target = router.latestLocation;
  const resolved = router.state.resolvedLocation;
  if (
    !router.state.isLoading ||
    !resolved ||
    resolved.href.split("#")[0] === target.href.split("#")[0]
  )
    return undefined;
  return target.publicHref;
}

/**
 * Takes the once-per-cooldown reload slot. Without working storage there is
 * no loop guard, so it refuses rather than risk a reload loop.
 */
export function claimReloadSlot(storage: StaleBuildRecoveryEnv["storage"], now: number): boolean {
  if (!storage) return false;
  try {
    const last = Number(storage.getItem(STALE_BUILD_RELOAD_KEY));
    if (last > 0 && now >= last && now - last < STALE_BUILD_RELOAD_COOLDOWN_MS) return false;
    storage.setItem(STALE_BUILD_RELOAD_KEY, String(now));
    return true;
  } catch {
    return false;
  }
}

/** Recover only the pending navigation that began with the user's activation. */
export function recoverFromStaleChunk(env: StaleBuildRecoveryEnv): boolean {
  // Offline, a deploy did not replace the chunk; a reload would only land on
  // the browser's offline page. ErrorState shows the offline state instead
  // and retries on reconnect.
  if (env.offline) return false;
  const target = pendingNavigationHref(env.router);
  if (!target || target !== env.activatedNavigationHref) return false;
  if (!claimReloadSlot(env.storage, env.now)) return false;
  env.assign(target);
  return true;
}

/** The messages TanStack's `isModuleNotFoundError` treats as a missing module. */
const MODULE_LOAD_FAILURE_PREFIXES = [
  "Failed to fetch dynamically imported module",
  "error loading dynamically imported module",
  "Importing a module script failed",
];

/**
 * TanStack's lazyRouteComponent reloads the page itself on the first failure
 * of each module, whatever the connectivity. Offline that reload lands on the
 * browser's offline page instead of the app's offline error state. Marking
 * its per-error slot (`tanstack_router_reload:<message>`, which mirrors the
 * installed lazyRouteComponent) before the rejection reaches it lets the error
 * through to ErrorState, which retries on reconnect.
 */
export function suppressRouterReload(
  error: unknown,
  storage: Pick<Storage, "setItem"> | undefined,
): void {
  if (!error || typeof error !== "object" || !("message" in error)) return;
  const message = error.message;
  if (typeof message !== "string") return;
  if (!MODULE_LOAD_FAILURE_PREFIXES.some((prefix) => message.startsWith(prefix))) return;
  try {
    storage?.setItem(`tanstack_router_reload:${message}`, "1");
  } catch {
    /* Unavailable storage: TanStack keeps its own behaviour. */
  }
}
