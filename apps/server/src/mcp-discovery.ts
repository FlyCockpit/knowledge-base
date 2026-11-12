import type { Env, Hono } from "hono";
import { z } from "zod";
import { canonicalOAuthRequest, guardMcpAuthorize } from "./mcp-authorize-scope-guard";

export const MCP_DISCOVERY_PATHS = [
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-authorization-server/api/auth",
  "/api/auth/.well-known/oauth-authorization-server",
] as const;

/** Mounted before auth, static content and SSR. MCP is always on. */
export function mountMcpOAuth<E extends Env>(
  app: Hono<E>,
  options: {
    baseUrl: string;
    webOrigin?: string;
    handler: (request: Request) => Promise<Response>;
  },
) {
  app.use("*", async (c, next) => {
    const path = new URL(c.req.raw.url).pathname;
    let decoded: string;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      return c.notFound();
    }
    const discovery = MCP_DISCOVERY_PATHS.some((p) => p === path);
    const oauth =
      decoded.startsWith("/api/auth/oauth2/") ||
      decoded === "/api/auth/jwks" ||
      decoded.startsWith("/api/auth/jwks/");
    const metadata =
      decoded.startsWith("/.well-known/oauth-") || decoded.startsWith("/api/auth/.well-known/");
    const mcp = decoded === "/mcp" || decoded.startsWith("/mcp/");
    if (!oauth && !metadata && !mcp) return next();
    if (path !== decoded || path.endsWith("/") || (metadata && !discovery)) return c.notFound();
    if (discovery && !["GET", "HEAD"].includes(c.req.method))
      return c.newResponse(null, 405, { Allow: "GET, HEAD" });
    let request: Request;
    try {
      request = canonicalOAuthRequest(c.req.raw, options.baseUrl, options.webOrigin);
    } catch {
      return c.newResponse(null, 400);
    }
    const rejected = await guardMcpAuthorize(c.req.raw, options.baseUrl);
    if (rejected) return rejected;
    if (discovery) {
      let response = await options.handler(
        c.req.method === "HEAD" ? new Request(request, { method: "GET" }) : request,
      );
      if (response.ok && path.includes("oauth-authorization-server")) {
        // Application grant controls own revocation. The provider's artifact-only
        // mutation endpoint is rejected, so do not advertise it to clients.
        const metadata = z.record(z.string(), z.unknown()).parse(await response.json());
        for (const key of Object.keys(metadata))
          if (key === "revocation_endpoint" || key.startsWith("revocation_endpoint_"))
            delete metadata[key];
        const headers = new Headers(response.headers);
        headers.delete("content-length");
        response = Response.json(metadata, { status: response.status, headers });
      }
      return c.req.method === "HEAD"
        ? new Response(null, { status: response.status, headers: response.headers })
        : response;
    }
    // Only the exact resource reaches unified bearer admission; no SPA fallback.
    if (mcp) return decoded === "/mcp" ? next() : c.notFound();
    // OAuth requests continue through the existing rate limiters and admin gates.
    // Hono's Request wrapper is rebuilt around the canonical request at the final
    // handler too; here validation runs before any route can bypass it.
    return next();
  });
  return (request: Request) => {
    const path = new URL(request.url).pathname;
    return options.handler(
      path.startsWith("/api/auth/oauth2/") || path === "/api/auth/jwks"
        ? canonicalOAuthRequest(request, options.baseUrl, options.webOrigin)
        : request,
    );
  };
}
