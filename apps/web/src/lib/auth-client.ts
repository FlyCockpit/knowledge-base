import type { auth } from "@knowledge-base/auth";
import { APP_LOCALE_HEADER } from "@knowledge-base/config/locales";
import { env } from "@knowledge-base/env/web";
import { adminClient, inferAdditionalFields, twoFactorClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

import i18n from "@/i18n";
import {
  announceSessionChange,
  guardIdentityResponse,
  identityVerificationGeneration,
  withExpectedIdentity,
} from "@/lib/document-identity";
import {
  recordSessionRetryAfter,
  trackNativeSessionCheck,
  waitForSessionCooldown,
} from "@/lib/session-retry";

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
    async onRequest(context) {
      context.headers.set(APP_LOCALE_HEADER, i18n.language);
      const path = new URL(context.url).pathname;
      // Native reconnect/storage/mount refreshes bypass runSessionCheck.
      // Share their entire atom update with it, including cooldown waits.
      if (path.endsWith("/get-session")) {
        const signal = context.signal;
        if (signal) trackSessionAtomRefresh(signal);
        await waitForSessionCooldown(signal);
      }
      if (!/\/(get-session|sign-out)\/?$/.test(path)) {
        context.headers = withExpectedIdentity(context.headers);
      }
      return context;
    },
    async onResponse({ response, request }) {
      const path = new URL(request.url).pathname;
      // An explicit sign-out owns its navigation even if a peer replaced the
      // identity meanwhile. Its success callback must still leave for login.
      if (path.endsWith("/sign-out")) return;
      if (path.endsWith("/get-session")) {
        recordSessionRetryAfter(response);
      }
      await guardIdentityResponse(response);
    },
  },
  sessionOptions: {
    // The watcher owns focus/visibility checks through the document scheduler.
    // Native reconnect and storage refreshes share its cooldown in onRequest.
    refetchOnWindowFocus: false,
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

// Keep the request generation with its settled snapshot even when no watcher
// is mounted. A route guard can verify the document without updating this atom.
const sessionAnswerGenerations = new WeakMap<object, number>();

export function readSessionIdentityGeneration(): number | undefined {
  const snapshot = authClient.$store.atoms.session?.get();
  return snapshot ? sessionAnswerGenerations.get(snapshot) : undefined;
}

function trackSessionAtomRefresh(signal: AbortSignal): void {
  const session = authClient.$store.atoms.session;
  // Reading value avoids mounting the atom for an imperative getSession().
  if (!session?.value.isRefetching) return;
  const since = identityVerificationGeneration();
  const finish = trackNativeSessionCheck();
  const stop = () => {
    unlisten();
    signal.removeEventListener("abort", stop);
    finish();
  };
  const unlisten = session.listen((snapshot) => {
    if (!snapshot.isPending && !snapshot.isRefetching) {
      sessionAnswerGenerations.set(snapshot, since);
      stop();
    }
  });
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
}

// A session change made in this tab (sign-in, 2FA, sign-up, …: Better Auth's
// session signal) is announced to the other open tabs before the flow
// navigates anywhere, so they re-check whose session the shared cookie holds
// now, whatever page this tab lands on. docs/ui.md § Query cache follows
// identity.
authClient.$store.atoms.$sessionSignal?.listen(() => announceSessionChange());

/** Consent owns its redirect only while its signed request is still mounted. */
export const consentAuthClient = createAuthClient({
  baseURL: env.VITE_SERVER_URL,
  disableDefaultFetchPlugins: true,
  fetchOptions: {
    onRequest(context) {
      context.headers.set(APP_LOCALE_HEADER, i18n.language);
      if (!/\/(get-session|sign-out)\/?$/.test(new URL(context.url).pathname)) {
        context.headers = withExpectedIdentity(context.headers);
      }
      return context;
    },
    async onResponse({ response }) {
      await guardIdentityResponse(response);
    },
  },
});
