import { auth, type Session } from "@knowledge-base/auth";
import { isImpersonatedSession } from "@knowledge-base/auth/roles";
import type { Context as HonoContext } from "hono";

export type CreateContextOptions = {
  context: HonoContext;
  /** Resolved once per HTTP request by the Hono layer (never by a procedure). */
  clientIp?: string;
};

export async function createContext({ context, clientIp }: CreateContextOptions) {
  // The session is resolved once per request by `sessionMiddleware` in
  // apps/server. Test harnesses that bypass the Hono middleware stack will
  // see undefined here — fall back to a direct lookup so they still work.
  const preresolved = context.get("session") as Session | null | undefined;
  if (preresolved !== undefined) {
    return { session: isImpersonatedSession(preresolved) ? null : preresolved, clientIp };
  }
  // Fallback path. Strip `Authorization` for the same reason sessionMiddleware
  // does: a Better-Auth plugin that adds a bearer credential would otherwise
  // mock a session for its owner here, and oRPC procedures never check a
  // credential's scope. oRPC is a cookie-authenticated surface.
  const cookieOnly = new Headers(context.req.raw.headers);
  cookieOnly.delete("authorization");
  const session = (await auth.api.getSession({ headers: cookieOnly })) as Session | null;
  return {
    session: isImpersonatedSession(session) ? null : session,
    clientIp,
  };
}

export type Context = Awaited<ReturnType<typeof createContext>>;
