import { defineRequestState, hasRequestState } from "@better-auth/core/context";
import { SIGNUP_ENABLED } from "@knowledge-base/env/server";
import { BASE_ERROR_CODES, type BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware, isAPIError } from "better-auth/api";
import { getAllowedUserCreationMode } from "./user-creation-policy.js";

export const SIGN_UP_EMAIL_PATH = "/sign-up/email";

// The one body `/sign-up/email` ever answers with on success. No client reads
// the success body (the web form reads only `error`, the image smoke only the
// status), and with `requireEmailVerification` there is never a session.
const NEUTRAL_SIGN_UP_RESPONSE = { token: null, user: null } as const;

// Set by the user.create database hook once a user row is committed in this
// request. Better Auth scopes the state to one endpoint call.
const userCreatedInRequest = defineRequestState(() => false);

/** `databaseHooks.user.create.after`: records a real creation for the sign-up after-hook. */
export async function markUserCreatedInRequest(): Promise<void> {
  if (await hasRequestState()) await userCreatedInRequest.set(true);
}

const failedToCreateUser = () =>
  APIError.from("UNPROCESSABLE_ENTITY", BASE_ERROR_CODES.FAILED_TO_CREATE_USER);

/**
 * Makes `/sign-up/email` answer the same for a free and a registered address,
 * so it is no account-existence oracle.
 *
 * With `requireEmailVerification`, Better Auth answers a sign-up for a
 * registered address with a synthetic "pretend it worked" user. That user is
 * built without plugin defaults (the admin plugin's `role` is null instead of
 * "user"), so its body tells a registered address from a free one. Any future
 * plugin field would reopen that, so every success body is replaced with one
 * fixed shape instead of patching the synthetic user.
 *
 * Better Auth also returns that synthetic 200 before `createUser`, so with
 * sign-up disabled the bootstrap adapter's rejection (422
 * FAILED_TO_CREATE_USER, bootstrap.ts) only ever reached free addresses.
 *  - before: once bootstrap is complete and sign-up is disabled, every address
 *    is rejected (decideUserCreate), so refuse here with that same 422 for all
 *    of them. The check reads only the bootstrap state, never the address, so
 *    a free address no longer pays the adapter transaction a registered one
 *    skips (timing).
 *  - after: while sign-up is disabled a 200 stands only if this request really
 *    created the user (the first-user / ADMIN_EMAIL bootstrap); anything else
 *    (a bootstrap that completed between the two checks) gets the same 422.
 * Error responses are left alone: they are already address-independent.
 *
 * Registered last in `plugins`: plugin after-hooks run after the global one, so
 * this body is the final one.
 */
export function neutralSignUpResponse(opts: {
  isBootstrapComplete: () => Promise<boolean>;
}): BetterAuthPlugin {
  return {
    id: "neutral-sign-up-response",
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === SIGN_UP_EMAIL_PATH,
          handler: createAuthMiddleware(async () => {
            if (SIGNUP_ENABLED || getAllowedUserCreationMode() === "admin-invite") return;
            if (await opts.isBootstrapComplete()) throw failedToCreateUser();
          }),
        },
      ],
      after: [
        {
          matcher: (ctx) => ctx.path === SIGN_UP_EMAIL_PATH,
          handler: createAuthMiddleware(async (ctx) => {
            if (isAPIError(ctx.context.returned)) return;
            if (!SIGNUP_ENABLED && !(await userCreatedInRequest.get())) throw failedToCreateUser();
            return ctx.json(NEUTRAL_SIGN_UP_RESPONSE);
          }),
        },
      ],
    },
  };
}
