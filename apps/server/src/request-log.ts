import { logEvent } from "@knowledge-base/env/log";
import type { MiddlewareHandler } from "hono";
import { routePath } from "hono/route";

/**
 * One fixed `http.request` record per request (R3-W3): the matched route
 * TEMPLATE (`/api/auth/*`, `/git/:kb/*`), never the raw path or query, so a
 * reset-password or verification token in the URL never reaches a log line;
 * plus method, status, duration and the request id.
 */
export function requestLog(): MiddlewareHandler<{ Variables: { requestId?: string } }> {
  return async (c, next) => {
    const started = performance.now();
    try {
      await next();
    } finally {
      // Hono keeps the last EXECUTED route index after next(); later matching
      // catch-all handlers may be registered but never run.
      let route = "unmatched";
      try {
        route = routePath(c) || route;
      } catch {
        // No route matched (e.g. a 404 before routing).
      }
      logEvent("http.request", {
        requestId: c.get("requestId"),
        method: c.req.method,
        route,
        status: c.res.status,
        durationMs: Math.round(performance.now() - started),
      });
    }
  };
}
