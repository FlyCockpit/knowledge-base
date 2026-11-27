import { appShellHydrated } from "@/lib/app-shell-hydration";
import { admitRouteIdentity, identityVerificationGeneration } from "@/lib/document-identity";
import {
  failedRouteSessionResolution,
  type RouteSessionResolution,
} from "@/lib/route-session-access";
import { getRouteSession } from "@/server/auth-session";

/**
 * Probes per guard while another tab keeps announcing identity changes; see
 * `resolveRouteSession`.
 */
const MAX_PROBES = 3;

/**
 * The session guards' probe: `getRouteSession()`, then the document's
 * identity check (`lib/document-identity.ts`). When the server answers with a
 * different identity than the one this document's cached data belongs to (a
 * switch made while no `_app` page was open, or in another tab), the document
 * is replaced and this never settles, so nothing under the guard renders the
 * previous identity's data. It also waits for the server-rendered app shell
 * to hydrate, so a guard's redirect never lands mid-hydration. Every session
 * guard uses this, never `getRouteSession()` alone.
 *
 * Another tab announcing an identity change while the probe runs makes its
 * answer stale (the request may have carried the previous cookie): the guard
 * asks again before admitting anything, at most `MAX_PROBES` times in all.
 * If every answer was superseded, it admits nothing: it reports a failed
 * probe (the guard's retryable error state; the chrome stays neutral).
 */
export async function resolveRouteSession(): Promise<RouteSessionResolution> {
  for (let attempt = 1; ; attempt++) {
    // Taken before the probe: an identity change announced while it runs is
    // newer than its answer.
    const since = identityVerificationGeneration();
    // Nothing a guard decides (redirect, not-found, error) may reach the router
    // while the server-rendered app shell is still hydrating
    // (lib/app-shell-hydration.ts). The wait runs alongside the probe, and a
    // failed probe (a transport error) also waits before it reaches the router.
    const [probe] = await Promise.allSettled([getRouteSession(), appShellHydrated()]);
    if (probe.status === "rejected") throw probe.reason;
    const resolution = probe.value;
    await admitRouteIdentity(resolution, since);
    const superseded = since !== identityVerificationGeneration();
    if (!superseded) return resolution;
    if (attempt >= MAX_PROBES) return failedRouteSessionResolution();
  }
}
