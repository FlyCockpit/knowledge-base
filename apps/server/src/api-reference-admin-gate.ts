import type { Context, Next } from "hono";

import { requireVerifiedAdminSession } from "./admin-session-gate";

// Production gate for the OpenAPI reference page (`/api-reference/*`), served by
// the oRPC `OpenAPIReferencePlugin`. That page documents the request/response
// shape of every procedure, so in production it must not be public — only a
// verified admin may load it. Reuses `requireVerifiedAdminSession` (the same
// rule as the better-auth admin gate) but collapses every
// failure mode to a 404 rather than 401/403, so a non-admin can't even confirm
// the page exists — matching the `adminOr404Procedure` convention used for the
// other 404-hidden admin surfaces.
//
// Mounted only when NODE_ENV=production (see apps/server/src/index.ts); in
// development the reference stays open for local API exploration.
export async function apiReferenceAdminGate(c: Context, next: Next) {
  const result = await requireVerifiedAdminSession(c.req.raw.headers);
  if (!result.ok) {
    return c.json({ error: "Not found" }, 404);
  }
  await next();
}
