import type { Session } from "@knowledge-base/auth";
import type { Context, Next } from "hono";

import { sessionMiddleware } from "./session-middleware.js";

/**
 * Reject an old document before its reads or writes run as a new cookie user.
 * Cookie surfaces reuse their stashed session. Better Auth compares inside
 * its own before hook so its endpoint can reuse that session resolution.
 * This is a consistency guard, never an authentication/authorization grant.
 */
export async function expectedIdentity(c: Context, next: Next) {
  const expected = c.req.header("X-Expected-User");
  if (!expected) {
    return next();
  }
  if (c.get("session") === undefined) {
    await sessionMiddleware(c, async () => {});
  }
  if (c.get("sessionLookupFailed")) {
    return c.json({ code: "SESSION_UNAVAILABLE" }, 503);
  }
  const session = c.get("session") as Session | null;
  const cookieOwner = c.get("sessionCookieOwner") ?? session?.user?.id;
  if (cookieOwner && cookieOwner !== expected) {
    return c.json({ code: "IDENTITY_CHANGED" }, 409);
  }
  return next();
}
