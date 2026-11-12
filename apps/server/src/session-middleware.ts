import { auth, type Session } from "@knowledge-base/auth";
import { isImpersonatedSession } from "@knowledge-base/auth/roles";
import { logInternalError } from "@knowledge-base/env/log";
import type { Context, Next } from "hono";

// Resolves the Better-Auth session once per request and stashes it on the
// Hono context. Downstream consumers (rate limiter, oRPC createContext, the
// /sw/push-renew handler) read `c.get("session")` instead of each making
// their own database hit.
//
// Failure mode: a Better-Auth blip becomes "no session" rather than a 500
// for the entire request. The downstream `requireAuth` gates will still
// return 401 if a real session was needed.
//
// SECURITY: `Authorization` is stripped before resolving, so the routes this
// middleware guards (/rpc/*, /sw/*) authenticate by cookie ONLY.
//
// Defense in depth. This template ships no bearer-token credential, but a
// Better-Auth plugin that adds one (API keys, OAuth access tokens) typically
// mocks a session for the credential's owner inside `getSession` — and no oRPC
// procedure here checks a credential's scope. Stripping the header keeps that
// from silently turning these cookie surfaces into token surfaces. A future
// bearer surface should resolve and scope-check its own credential rather than
// relax this.
export async function sessionMiddleware(c: Context, next: Next) {
  let session: Session | null = null;
  try {
    const cookieOnly = new Headers(c.req.raw.headers);
    cookieOnly.delete("authorization");
    session = (await auth.api.getSession({ headers: cookieOnly })) as Session | null;
  } catch (err) {
    logInternalError("session.lookup", err);
    session = null;
  }
  c.set("session", isImpersonatedSession(session) ? null : (session ?? null));
  await next();
}
