import { type QueryClient, queryOptions } from "@tanstack/react-query";

import { getSessionCookieHint } from "@/server/auth-session";

/**
 * The public pages' "is this visitor probably signed in?" hint, as one shared
 * query: the `_public` layout seeds it in `beforeLoad` (so a cookie-bearing SSR
 * render already has the answer, and the router's SSR query integration ships
 * it to the client), the landing page's redirect reads the same entry instead
 * of calling the server function again, and the public header (also under the
 * 404, which no `_public` route wraps) reads it with `useQuery`.
 *
 * It is `getSessionCookieHint` (server/auth-session.ts): cookie presence only,
 * a routing and chrome hint, never an access check. No Better-Auth client code
 * is involved, so public modules can import this file. A failure reads as
 * "signed out": the hint is a convenience and the anonymous chrome is always a
 * correct fallback. docs/ui.md § Public header session hint.
 */
export const SESSION_HINT_QUERY_KEY = ["session-cookie-hint"] as const;

export function sessionHintQueryOptions() {
  return queryOptions({
    queryKey: SESSION_HINT_QUERY_KEY,
    queryFn: async () => {
      try {
        return await getSessionCookieHint();
      } catch {
        return false;
      }
    },
    // A minute: long enough that the layout seed and the landing redirect (and
    // the header) share one answer, short enough that a sign-in in another tab
    // shows up on the next public navigation. The app's own gate updates it at
    // once (`setSessionHint`).
    staleTime: 60_000,
    retry: false,
    // Run even while the browser reports offline: an "online" query would
    // pause, and the `_public` layout's `beforeLoad` would wait on it until
    // the connection came back. Offline, the server function fails at once
    // and the hint reads as signed out, like any other failure.
    networkMode: "always",
    meta: { skipGlobalErrorToast: true },
  });
}

/**
 * The hint for a routing decision: the cached answer while it is fresh (so the
 * layout seed and the landing redirect share one request), otherwise a new
 * one, awaited. A stale answer is never used to decide, so signing in in
 * another tab is seen by the next public navigation once the minute is up.
 * Never throws.
 */
export function ensureSessionHint(queryClient: QueryClient): Promise<boolean> {
  return queryClient.fetchQuery(sessionHintQueryOptions());
}

/**
 * Record what the app's own session check just learned, so a later public
 * page agrees with it without asking: `true` once the `_auth` gate confirmed a
 * session (after signing in, the landing page forwards and the public header
 * offers the app), `false` when it confirmed there is none. Sign-out reloads
 * the page, which drops the cache.
 */
export function setSessionHint(queryClient: QueryClient, signedIn: boolean): void {
  queryClient.setQueryData(SESSION_HINT_QUERY_KEY, signedIn);
}
