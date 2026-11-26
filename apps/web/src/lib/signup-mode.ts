/**
 * How a visitor gets an account on this server, read from the public
 * `appConfig` (packages/api/src/routers/index.ts). The landing page, sign-in
 * and `/signup` all branch on this one value so they always tell the same
 * story. docs/ui.md § Sign-up modes.
 *
 * - `open`: anyone can create an account (`SIGNUP_ENABLED=true`).
 * - `bootstrap`: sign-up is closed, but no administrator exists yet, so the
 *   first account (in production only `ADMIN_EMAIL`) can still be created and
 *   becomes the administrator (`isAdminBootstrapSignupEnabled`,
 *   packages/auth/src/bootstrap.ts). The flag clears once that account
 *   exists; the copy for this mode still tells everyone else the server is
 *   invite-only.
 * - `closed`: invite-only; an administrator creates accounts.
 * - `sso`: `FORCE_SSO`; the identity provider is the only way in, and the SSO
 *   sign-in page keeps its own copy.
 */
export type SignupMode = "open" | "bootstrap" | "closed" | "sso";

type SignupConfig = {
  forceSso?: boolean;
  signupEnabled?: boolean;
  adminBootstrapSignupEnabled?: boolean;
};

export function signupMode(config: SignupConfig): SignupMode {
  if (config.forceSso === true) return "sso";
  if (config.signupEnabled === true) return "open";
  if (config.adminBootstrapSignupEnabled === true) return "bootstrap";
  return "closed";
}
