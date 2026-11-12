import type { ExportActor } from "@knowledge-base/api/lib/kb/exports";
import {
  type CredentialVerifier,
  demandToolGroups,
  type TokenPrincipal,
} from "@knowledge-base/api/lib/kb/principal";
import { kbIdSchema, uuidSchema } from "@knowledge-base/api/lib/kb/protocol/common";
import type { KbRuntimeConfig } from "@knowledge-base/api/lib/kb/runtime";
import { downloadExport } from "@knowledge-base/api/lib/kb/transfers";
import { logInternalError } from "@knowledge-base/env/log";
import { Hono } from "hono";

export function createKbExportRoutes(options: {
  runtime(): KbRuntimeConfig;
  session(headers: Headers): Promise<{ user: { id: string } } | null>;
  bearer?: (
    request: Request,
  ) => Promise<{ principal: TokenPrincipal; verifier: CredentialVerifier }>;
  isShuttingDown?: () => boolean;
}) {
  // requestId: set by the server-wide request-id middleware when mounted.
  const app = new Hono<{ Variables: { requestId?: string } }>();
  app.get("/kb-exports/:kbId/:transferId", async (c) => {
    try {
      // Hono dispatches HEAD through GET; do not allocate an unread stream for it.
      if (c.req.method !== "GET") return c.json({ error: "NOT_FOUND" }, 404);
      const runtime = options.runtime();
      if (
        (c.req.header("origin") !== undefined &&
          c.req.header("origin") !== runtime.canonicalOrigin) ||
        ![undefined, "same-origin", "none"].includes(c.req.header("sec-fetch-site"))
      )
        return c.json({ error: "FORBIDDEN" }, 403);
      let actor: ExportActor;
      if (c.req.header("authorization") !== undefined) {
        if (!options.bearer) return c.json({ error: "UNAUTHORIZED" }, 401);
        const { principal, verifier } = await options.bearer(c.req.raw);
        // Export downloads belong to the `export` tool group.
        actor = { principal: demandToolGroups(principal, ["export"]), verifier };
      } else {
        const session = await options.session(c.req.raw.headers);
        if (!session) return c.json({ error: "UNAUTHORIZED" }, 401);
        actor = { principal: { kind: "browser", userId: session.user.id } };
      }
      const kbId = kbIdSchema.safeParse(c.req.param("kbId"));
      const id = uuidSchema.safeParse(c.req.param("transferId"));
      if (!kbId.success || !id.success || new URL(c.req.url).search)
        return c.json({ error: "INVALID_ARGUMENT" }, 400);
      const { body, size } = await downloadExport(runtime, actor, {
        kbId: kbId.data,
        transferId: id.data,
        signal: c.req.raw.signal,
        isShuttingDown: options.isShuttingDown,
      });
      c.header("Content-Type", "application/zip");
      c.header("Content-Disposition", 'attachment; filename="knowledge-base.zip"');
      c.header("Content-Length", String(size));
      return c.body(body);
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : null;
      if (code === "NOT_FOUND") return c.json({ error: "NOT_FOUND" }, 404);
      if (code === "UNAUTHORIZED") return c.json({ error: "UNAUTHORIZED" }, 401);
      if (code === "FORBIDDEN") return c.json({ error: "FORBIDDEN" }, 403);
      // Unexpected: the client sees only 503, so the operator log carries the
      // cause (R3-W3). A disconnect is not an outage.
      if (!c.req.raw.signal.aborted)
        logInternalError("http.unhandled", error, {
          requestId: c.get("requestId"),
          method: c.req.method,
          route: "/kb-exports/:kbId/:transferId",
          code: typeof code === "string" ? code : undefined,
        });
      return c.json({ error: "STORAGE_UNAVAILABLE" }, 503);
    }
  });
  app.all("/kb-exports/*", (c) => c.json({ error: "NOT_FOUND" }, 404));
  return app;
}
