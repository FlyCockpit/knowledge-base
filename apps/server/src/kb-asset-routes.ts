import { prismaAssetQuery } from "@knowledge-base/api/lib/kb/asset-authz";
import {
  AssetRangeError,
  authorizedAssetStream,
} from "@knowledge-base/api/lib/kb/authorized-stream";
import { prismaAuthorityStore } from "@knowledge-base/api/lib/kb/permissions";
import {
  type CredentialVerifier,
  demandToolGroups,
  KbAdmissionError,
  type Principal,
  type TokenPrincipal,
} from "@knowledge-base/api/lib/kb/principal";
import { hashSchema, kbIdSchema, shaSchema } from "@knowledge-base/api/lib/kb/protocol/common";
import type { KbRuntimeConfig } from "@knowledge-base/api/lib/kb/runtime";
import { logInternalError } from "@knowledge-base/env/log";
import { type Context, Hono } from "hono";
import { RateLimiterRes } from "rate-limiter-flexible";

/** Full admission supplies the live verifier used before every frame. */
type AssetBearerAdmission = (request: Request) => Promise<{
  principal: TokenPrincipal;
  verifier: CredentialVerifier;
}>;
type AssetRouteOptions = {
  runtime: () => Pick<KbRuntimeConfig, "prisma" | "reposDir" | "blobStore" | "canonicalOrigin">;
  session: (headers: Headers) => Promise<{ user: { id: string } } | null>;
  bearer?: AssetBearerAdmission;
  isShuttingDown?: () => boolean;
  chargeAssetWork?: (c: Context, points: number) => Promise<void>;
};

export function createKbAssetRoutes(options: AssetRouteOptions) {
  // requestId: set by the server-wide request-id middleware when mounted.
  const app = new Hono<{ Variables: { requestId?: string } }>();
  app.on(["GET", "HEAD"], "/kb-assets/:kbId/:hash", async (c) => {
    try {
      const runtime = options.runtime();
      const origin = c.req.header("origin");
      const site = c.req.header("sec-fetch-site");
      if (
        (origin !== undefined && origin !== runtime.canonicalOrigin) ||
        (site !== undefined && site !== "same-origin" && site !== "none")
      )
        return c.json({ error: "FORBIDDEN" }, 403);
      let principal: Principal;
      let verifier: CredentialVerifier | undefined;
      if (c.req.header("authorization") !== undefined) {
        // A presented token never falls back to broader cookie authority.
        if (!options.bearer) throw new KbAdmissionError("UNAUTHORIZED", "Unauthorized");
        const admitted = await options.bearer(c.req.raw);
        // Asset reads belong to the `read` tool group, on every frame's recheck.
        principal = demandToolGroups(admitted.principal, ["read"]);
        verifier = admitted.verifier;
      } else {
        const headers = new Headers(c.req.raw.headers);
        headers.delete("authorization");
        const session = await options.session(headers);
        if (!session) throw new KbAdmissionError("UNAUTHORIZED", "Unauthorized");
        principal = { kind: "browser", userId: session.user.id };
      }
      const kbId = kbIdSchema.safeParse(c.req.param("kbId"));
      const hash = hashSchema.safeParse(c.req.param("hash"));
      const rev = shaSchema.safeParse(c.req.query("rev"));
      const params = new URL(c.req.url).searchParams;
      if (!kbId.success || !hash.success || !rev.success || params.size !== 1 || !params.has("rev"))
        return c.json({ error: "INVALID_ARGUMENT" }, 400);
      const { body, asset, range } = await authorizedAssetStream({
        principal,
        verifier,
        kbId: kbId.data,
        hash: hash.data,
        rev: rev.data,
        operation: "read",
        store: prismaAuthorityStore(runtime.prisma),
        query: prismaAssetQuery(runtime.prisma),
        reposDir: runtime.reposDir,
        blobStore: runtime.blobStore,
        purpose: "download",
        signal: c.req.raw.signal,
        isShuttingDown: options.isShuttingDown,
        range: c.req.header("range") ?? null,
        head: c.req.method === "HEAD",
        chargeWork: options.chargeAssetWork
          ? (points) => options.chargeAssetWork!(c, points)
          : undefined,
      });
      c.header("Content-Type", asset.mime);
      c.header("Content-Disposition", asset.mime === "application/pdf" ? "attachment" : "inline");
      c.header("Accept-Ranges", "bytes");
      c.header("Content-Length", String(range.end - range.start + 1));
      if (range.partial)
        c.header("Content-Range", `bytes ${range.start}-${range.end}/${asset.size}`);
      return body
        ? c.body(body, range.partial ? 206 : 200)
        : c.body(null, range.partial ? 206 : 200);
    } catch (error) {
      if (error instanceof RateLimiterRes) {
        const retryAfter = Math.ceil(error.msBeforeNext / 1000);
        c.header("Retry-After", String(retryAfter));
        return c.json({ error: "Too many attempts. Please wait a moment and try again." }, 429);
      }
      if (error instanceof AssetRangeError) {
        c.header("Content-Range", `bytes */${error.size}`);
        return c.json({ error: "RANGE_NOT_SATISFIABLE" }, 416);
      }
      const code = error instanceof Error && "code" in error ? error.code : null;
      if (code === "UNAUTHORIZED") return c.json({ error: "UNAUTHORIZED" }, 401);
      if (code === "NOT_FOUND") return c.json({ error: "NOT_FOUND" }, 404);
      if (code === "FORBIDDEN") return c.json({ error: "FORBIDDEN" }, 403);
      if (code === "REPAIR_REQUIRED") return c.json({ error: "REPAIR_REQUIRED" }, 503);
      // Unexpected: the client sees only 503, so the operator log carries the
      // cause (R3-W3). A disconnect is not an outage.
      if (!c.req.raw.signal.aborted)
        logInternalError("http.unhandled", error, {
          requestId: c.get("requestId"),
          method: c.req.method,
          route: "/kb-assets/:kbId/:hash",
          code: typeof code === "string" ? code : undefined,
        });
      return c.json({ error: "STORAGE_UNAVAILABLE" }, 503);
    }
  });
  // Never reach the SPA catch-all through malformed paths or other methods.
  app.all("/kb-assets/*", (c) => c.json({ error: "NOT_FOUND" }, 404));
  return app;
}
