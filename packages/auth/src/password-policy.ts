/**
 * The password length policy, in one dependency-free module so the server and
 * the browser read the same numbers: `packages/auth/src/index.ts` hands them to
 * Better-Auth, and the web's new-password forms (signup, reset/invite/setup,
 * change password) build their Zod rule and the rule shown under the field from
 * them (`apps/web/src/lib/password-policy.ts`). Change a number here and both
 * sides move together.
 *
 * The sign-in form deliberately does not use the minimum: an account created
 * under an older policy must still be able to sign in.
 */

/** Better-Auth's default floor is 8; there is no breached-password check, so length is the only guessing cost. */
export const PASSWORD_MIN_LENGTH = 12;

/** Better-Auth's default `maxPasswordLength`. */
export const PASSWORD_MAX_LENGTH = 128;
