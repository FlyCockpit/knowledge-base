import { runWithAllowedUserCreation } from "@knowledge-base/auth/user-creation-policy";
import type { Context, Next } from "hono";

// ADMIN_EMAIL bootstrap marker for the email/password signup path. When the
// request carries the configured operator address it runs downstream inside
// the `admin-bootstrap` creation mode. Authorization still happens in the
// wrapped Better Auth adapter transaction (packages/auth/src/bootstrap.ts);
// this middleware NEVER rejects, so member and non-member addresses stay
// indistinguishable at this layer:
//
//   - An earlier revision rejected non-members here with an immediate 403
//     while members proceeded into Better-Auth. The immediate-403 vs
//     Better-Auth-processing split (different status/body shapes AND different
//     timing) let anyone probe which emails are admins. Any email-based early
//     reject reintroduces that oracle — including for malformed bodies, where
//     Better-Auth would otherwise return identical 400s for every address.
//   - With pass-through, every input class yields identical responses for
//     member and non-member addresses: same 400s for invalid input, same
//     generic 200 for already-registered emails, same 422 for a blocked
//     signup (both pay the password-hash cost before the adapter rejects, so
//     timing is normalized too). The only divergence is a VALID new-admin
//     signup succeeding — which inherently creates an account and emails the
//     owner, and whose pre-claim window is mitigated by
//     requireEmailVerification + password reset (unchanged).
export function adminBootstrapMarker(adminEmail: string | undefined) {
  return async function adminBootstrapMarkerMiddleware(c: Context, next: Next) {
    if (!adminEmail) return next();
    try {
      const body = (await c.req.raw.clone().json()) as { email?: unknown };
      const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : null;
      if (email && email === adminEmail) {
        return runWithAllowedUserCreation("admin-bootstrap", next);
      }
    } catch {
      // Better-Auth returns its normal validation error for malformed signup
      // bodies; the marker must not respond (or throw) for any body shape.
    }
    return next();
  };
}
