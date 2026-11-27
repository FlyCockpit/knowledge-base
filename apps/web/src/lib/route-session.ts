import { appShellHydrated } from "@/lib/app-shell-hydration";
import { admitRouteIdentity } from "@/lib/document-identity";
import type { RouteSessionResolution } from "@/lib/route-session-access";
import { getRouteSession } from "@/server/auth-session";

/**
 * The session guards' probe: `getRouteSession()`, then the document's
 * identity check (`lib/document-identity.ts`). When the server answers with a
 * different identity than the one this document's cached data belongs to (a
 * switch made while no `_app` page was open, or in another tab), the document
 * is replaced and this never settles, so nothing under the guard renders the
 * previous identity's data. It also waits for the server-rendered app shell
 * to hydrate, so a guard's redirect never lands mid-hydration. Every session
 * guard uses this, never `getRouteSession()` alone.
 */
export async function resolveRouteSession(): Promise<RouteSessionResolution> {
  // Nothing a guard decides (redirect, not-found, error) may reach the router
  // while the server-rendered app shell is still hydrating
  // (lib/app-shell-hydration.ts). The wait runs alongside the probe, and a
  // failed probe (a transport error) also waits before it reaches the router.
  const [probe] = await Promise.allSettled([getRouteSession(), appShellHydrated()]);
  if (probe.status === "rejected") throw probe.reason;
  const resolution = probe.value;
  await admitRouteIdentity(resolution);
  return resolution;
}
