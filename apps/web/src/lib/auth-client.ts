import type { auth } from "@knowledge-base/auth";
import { APP_LOCALE_HEADER } from "@knowledge-base/config/locales";
import { env } from "@knowledge-base/env/web";
import { adminClient, inferAdditionalFields, twoFactorClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

import i18n from "@/i18n";

export const authClient = createAuthClient({
  baseURL: env.VITE_SERVER_URL,
  fetchOptions: {
    // Tell the server which locale the user is actually using. `User.locale` is
    // `input: false` (it belongs to the dedicated preferences procedure, not to
    // arbitrary signUp/updateUser payloads), so a brand-new row would otherwise
    // take the Prisma `@default("en-US")` — and the verification email that
    // goes out during signup would be English no matter which `/$lang/` the
    // user signed up under. `packages/auth`'s user-create hook narrows this
    // against SUPPORTED_LOCALES, so an unrecognized value is inert.
    //
    // Read from the live i18n instance rather than a value captured at module
    // load, so a language switch mid-session is reflected.
    //
    // The header name is shared with the server's CORS `allowHeaders` list via
    // APP_LOCALE_HEADER — a custom header the server doesn't allow fails
    // preflight and blocks every auth request on a split-origin deploy.
    onRequest(context) {
      context.headers.set(APP_LOCALE_HEADER, i18n.language);
      return context;
    },
  },
  sessionOptions: {
    // Better Auth owns session revalidation. Keep event-driven refreshes on,
    // skip requests while offline, and avoid periodic polling.
    refetchOnWindowFocus: true,
    refetchWhenOffline: false,
    refetchInterval: 0,
  },
  plugins: [
    // Surface server-side `user.additionalFields` (e.g. `locale`) on the
    // typed session. Without this, `session.user.locale` is unknown to the
    // type system even though the runtime payload includes it.
    inferAdditionalFields<typeof auth>(),
    adminClient(),
    twoFactorClient(),
  ],
});

/** Consent owns its redirect only while its signed request is still mounted. */
export const consentAuthClient = createAuthClient({
  baseURL: env.VITE_SERVER_URL,
  disableDefaultFetchPlugins: true,
  fetchOptions: {
    onRequest(context) {
      context.headers.set(APP_LOCALE_HEADER, i18n.language);
      return context;
    },
  },
});
