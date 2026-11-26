import { admitRouteIdentity } from "@/lib/document-identity";
import type { RouteSessionResolution } from "@/lib/route-session-access";
import { getRouteSession } from "@/server/auth-session";

/**
 * The session guards' probe: `getRouteSession()`, then the document's
 * identity check (`lib/document-identity.ts`). When the server answers with a
 * different identity than the one this document's cached data belongs to (a
 * switch made while no `_app` page was open, or in another tab), the document
 * is replaced and this never settles, so nothing under the guard renders the
 * previous identity's data. Every session guard uses this, never
 * `getRouteSession()` alone.
 */
export async function resolveRouteSession(): Promise<RouteSessionResolution> {
  const resolution = await getRouteSession();
  await admitRouteIdentity(resolution);
  return resolution;
}
