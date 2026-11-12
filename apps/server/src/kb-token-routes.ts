import { type Context, Hono } from "hono";
import { RateLimiterRes } from "rate-limiter-flexible";
import { createAdmissionGate } from "./mcp/admission";
import type { BearerAdmitter } from "./mcp/context";
import { admissionErrorResponse } from "./mcp/errors";

/** The only bearer credential-control endpoint. No caller-selected identity or token id. */
export function createKbTokenRoutes(options: {
  admit: BearerAdmitter;
  revoke(userId: string, tokenId: string): Promise<unknown>;
  charge(context: Context): Promise<void>;
  gate?: ReturnType<typeof createAdmissionGate>;
  isClosing(): boolean;
}) {
  const app = new Hono();
  const gate = options.gate ?? createAdmissionGate();
  app.post("/api/kb/token/revoke-self", async (c) => {
    if (options.isClosing()) return c.body(null, 503);
    const permit = gate.admit(c.req.raw.signal);
    if (!permit) return c.body(null, 503);
    try {
      const request = new Request(c.req.raw, { signal: permit.signal });
      await options.charge(c);
      permit.signal.throwIfAborted();
      // Reading one byte is enough to reject every nonempty/chunked body.
      const reader = request.body?.getReader();
      if (reader) {
        const cancel = () => {
          void reader.cancel().catch(() => {});
        };
        permit.signal.addEventListener("abort", cancel, { once: true });
        try {
          const first = await reader.read();
          permit.signal.throwIfAborted();
          if (!first.done) {
            cancel();
            return c.body(null, 400);
          }
        } finally {
          permit.signal.removeEventListener("abort", cancel);
          reader.releaseLock();
        }
      }
      const actor = await options.admit(request, { selfRevoke: true });
      const credential = actor.principal.credential;
      if (credential?.kind !== "PAT" || !credential.tokenId) return c.body(null, 401);
      if (options.isClosing()) return c.body(null, 503);
      await options.revoke(actor.principal.userId, credential.tokenId);
      return c.body(null, 204);
    } catch (error) {
      if (error instanceof RateLimiterRes)
        return c.json({ error: "RATE_LIMITED" }, 429, {
          "Retry-After": String(Math.ceil(error.msBeforeNext / 1000)),
        });
      // This endpoint never advertises OAuth as a way to revoke a PAT.
      const response = admissionErrorResponse(error, new URL(c.req.url).origin);
      response.headers.delete("www-authenticate");
      return response;
    } finally {
      permit.release();
    }
  });
  app.all("/api/kb/token/revoke-self", (c) => c.body(null, 405));
  return app;
}
