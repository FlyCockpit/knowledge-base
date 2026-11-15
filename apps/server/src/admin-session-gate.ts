import { checkAdminAuthority } from "@knowledge-base/api";
import { auth, type Session } from "@knowledge-base/auth";

type AdminSessionGateResult =
  | { ok: true; session: Session }
  | { ok: false; status: 401 | 403; error: string; errorDescription: string };

// This gate protects Better-Auth plugin endpoints whose request surface is
// reached without any oRPC context. It applies the single admin rule the oRPC
// `requireAdmin` / `requireAdminOr404` middleware apply (`checkAdminAuthority`
// in @knowledge-base/api: non-impersonated session, not banned, verified email,
// admin role, forced 2FA) and only maps the failure to this gate's response.
export async function requireVerifiedAdminSession(
  headers: Headers,
): Promise<AdminSessionGateResult> {
  let session: Session | null = null;
  try {
    // Cookies only, exactly as `sessionMiddleware` does for /rpc, and for the
    // same reason — see the long comment there. A Better-Auth plugin that adds
    // a bearer credential typically installs a before-hook that fires on ANY
    // endpoint carrying one and assigns `ctx.context.session`, which
    // `getSessionFromCtx` then short-circuits on. Without this delete such a
    // credential would authenticate as its owner here, and every surface behind
    // this gate would accept it — currently `/api/auth/admin/*`
    // (`better-auth-admin-gate.ts`) and the OpenAPI reference
    // (`api-reference-admin-gate.ts`), both of which can escalate privilege.
    //
    // These are cookie-authenticated admin-UI surfaces. Nothing legitimate
    // presents a bearer to them.
    const cookieOnly = new Headers(headers);
    cookieOnly.delete("authorization");
    session = (await auth.api.getSession({ headers: cookieOnly })) as Session | null;
  } catch {
    session = null;
  }

  // The admin plugin only rejects a banned user when a session is CREATED
  // (`session.create.before`), never on `getSession` — so nothing downstream of
  // here notices a ban on its own; checkAdminAuthority's ban check does.
  //
  // Be precise about what this does and does not buy, because the obvious
  // reading is wrong. It does NOT close the 60s cookie-cache window: on a cache
  // hit `getSession` returns the cached user verbatim without touching the DB,
  // so `banned` is the stale pre-ban value and this check sees false. What
  // actually closes that window is that both ban paths delete the session rows,
  // so once the cache lapses the request 401s anyway.
  //
  // What it does buy is coverage for a ban applied WITHOUT clearing sessions —
  // a direct DB update, a future admin path that forgets to, or a session minted
  // between the two statements. Defense in depth.
  const authority = await checkAdminAuthority(session);
  if (!authority.ok) {
    if (authority.reason === "unauthenticated") {
      return {
        ok: false,
        status: 401,
        error: "unauthorized",
        errorDescription: "Authentication required",
      };
    }
    return {
      ok: false,
      status: 403,
      error: "access_denied",
      errorDescription:
        authority.reason === "two-factor"
          ? "Two-factor authentication setup is required"
          : "Verified admin access required",
    };
  }

  return { ok: true, session: authority.session };
}
