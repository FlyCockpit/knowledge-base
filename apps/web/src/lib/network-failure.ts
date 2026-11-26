/**
 * Classify a failure as "the network did it" so the UI can say what to do
 * ("You're offline…") instead of the generic "Something went wrong". See
 * docs/ui.md § Offline.
 *
 * `navigator.onLine === false` is reliable; `true` only means "a network
 * interface is up", so an online fetch TypeError is reported as "couldn't
 * reach the server", never as offline.
 */

/** Messages browsers use for a fetch that never got a response. */
const FETCH_FAILURE = [
  /^Failed to fetch(?! dynamically)/, // Chromium
  /^NetworkError when attempting to fetch resource/, // Firefox
  /^Load failed$/, // Safari
  /^The network connection was lost/, // Safari
  /^Network request failed/, // polyfills, React Native
];

/** Messages for a JS/CSS chunk that could not be downloaded (offline, or a replaced build). */
const CHUNK_FAILURE = [
  /^Failed to fetch dynamically imported module/,
  /^error loading dynamically imported module/,
  /^Importing a module script failed/,
  /^Unable to preload CSS/,
];

export function isBrowserOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

function messageOf(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("message" in error)) return undefined;
  return typeof error.message === "string" ? error.message : undefined;
}

/** Walk `cause` a few levels: a wrapper (oRPC, a loader) may carry the fetch error. */
function matchesChain(error: unknown, patterns: readonly RegExp[]): boolean {
  let current = error;
  for (let depth = 0; depth < 4 && current; depth++) {
    const message = messageOf(current);
    if (message && patterns.some((pattern) => pattern.test(message))) return true;
    current =
      typeof current === "object" && "cause" in current
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
  return false;
}

/** A request that got an HTTP answer was not a network failure. */
function hasHttpStatus(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "status" in error &&
    typeof error.status === "number" &&
    error.status > 0
  );
}

export function isFetchFailure(error: unknown): boolean {
  return matchesChain(error, FETCH_FAILURE);
}

export function isChunkLoadFailure(error: unknown): boolean {
  return matchesChain(error, CHUNK_FAILURE);
}

export type NetworkFailureKind = "offline" | "unreachable";

/**
 * `offline`: the browser is offline and the server never answered.
 * `unreachable`: online, but the fetch itself failed (server down, captive
 * portal, DNS). A chunk failure while online is not reported here: that is
 * usually a replaced build, which the generic error's Reload fixes.
 */
export function networkFailureKind(error: unknown): NetworkFailureKind | null {
  if (hasHttpStatus(error)) return null;
  if (isBrowserOffline()) return "offline";
  return isFetchFailure(error) ? "unreachable" : null;
}
