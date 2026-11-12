import { DEFAULT_LOCALE, isSupportedLocale } from "@knowledge-base/config/locales";
import prisma from "@knowledge-base/db";
import { env, FORCE_SSO, SSO_ENABLED } from "@knowledge-base/env/server";
import {
  isEmailConfigured,
  renderResetPassword,
  renderTwoFactorOtp,
  renderVerifyEmail,
  sendEmail,
} from "@knowledge-base/mailer";
import { type BetterAuthPlugin, betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { admin, genericOAuth, twoFactor } from "better-auth/plugins";
import { defaultAc, userAc } from "better-auth/plugins/admin/access";
import { assertOrdinaryAccountDeletionAllowed } from "./account-deletion-policy.js";
import { authLogger } from "./auth-logger";
import { createBootstrapDatabaseAdapter, rejectImpersonatedSession } from "./bootstrap.js";
import { resolveDevicePlugins } from "./device-approval";
import { resolveMcpPlugins } from "./mcp-plugins.js";
import { knowledgeBaseAdminPermissions } from "./roles";
import { createSessionCacheVersion } from "./session-authority";
import { resolveSignupLocale } from "./signup-locale.js";
import { TWO_FACTOR_ALLOW_PASSWORDLESS_ENROLLMENT } from "./two-factor-policy.js";
import { ADMIN_CREATE_USER_PATH } from "./user-columns.js";
import { withVerificationCallback } from "./verification-callback.js";

const ssoEnabled = SSO_ENABLED;
const forceSso = FORCE_SSO;
const isCrossOrigin = !!env.CORS_ORIGIN;

const twoFactorPlugin = twoFactor({
  issuer: "knowledge-base",
  // SSO-only users have no credential password to confirm. Better Auth
  // still requires a password whenever a credential account exists, so
  // this lets an authenticated SSO session enroll without weakening the
  // password-confirmation boundary for email/password accounts.
  allowPasswordless: TWO_FACTOR_ALLOW_PASSWORDLESS_ENROLLMENT,
  // Email OTP as a second factor — only wired when SMTP is configured.
  // TOTP + backup codes always remain available regardless.
  //
  // Caveat (documented, mitigated elsewhere): Better-Auth's send-otp
  // endpoint catches a thrown/rejected sendOTP and still returns
  // { status: true } (otp/index.ts) — it will NOT surface an SMTP failure to
  // the caller. The login challenge therefore preflights SMTP reachability
  // via `auth.verifyEmailTransport` (→ mailer `verifyTransport()`) before
  // claiming a code was sent. Here we just do the real send and let a
  // failure throw so it is logged server-side.
  ...(isEmailConfigured()
    ? {
        otpOptions: {
          // Hash codes at rest rather than storing them in plaintext
          // (Better-Auth's default).
          storeOTP: "hashed" as const,
          sendOTP: async ({ user, otp }: { user: { id: string; email: string }; otp: string }) => {
            // additionalFields like `locale` aren't on the callback's typed
            // user shape — fetch the row so the code email is localized
            // (renderer falls back to en-US for missing/unsupported values).
            const row = await prisma.user.findUnique({
              where: { id: user.id },
              select: { locale: true },
            });
            const { subject, html } = renderTwoFactorOtp({
              otp,
              locale: row?.locale ?? "en-US",
            });
            await sendEmail({ to: user.email, subject, html });
          },
        },
      }
    : {}),
});

/**
 * Social ID-token sign-in (`POST /sign-in/social` with `idToken`) mints a
 * session directly and is never matched by the 2FA plugin's credential
 * sign-in hook or the SSO callback hook above. The app only signs in through
 * the redirect flow, so refuse the ID-token form outright.
 */
const rejectIdTokenSignIn = {
  id: "reject-id-token-sign-in",
  hooks: {
    before: [
      {
        matcher: (ctx: { path?: string }) => ctx.path === "/sign-in/social",
        handler: createAuthMiddleware(async (ctx) => {
          const body: unknown = ctx.body;
          if (body && typeof body === "object" && "idToken" in body && body.idToken != null) {
            throw new APIError("FORBIDDEN", { message: "ID token sign-in is not supported." });
          }
        }),
      },
    ],
  },
} satisfies BetterAuthPlugin;

export const auth = betterAuth({
  database: createBootstrapDatabaseAdapter(prisma),
  hooks: {
    before: rejectImpersonatedSession,
    after: createAuthMiddleware(async (ctx) => {
      // Generic OAuth 1.7.10 registers a social provider on the core callback.
      // The built-in 2FA matcher covers credential sign-ins only.
      if (ctx.path !== "/callback/:id" || ctx.params?.id !== "sso") return;
      const data = ctx.context.newSession;
      if (!data?.user.twoFactorEnabled) return;
      const webOrigin = env.CORS_ORIGIN || env.BETTER_AUTH_URL;
      const callback = new URL(ctx.context.responseHeaders?.get("location") || "/", webOrigin);
      const callbackLang = callback.pathname.split("/")[1];
      const userLocale = "locale" in data.user ? data.user.locale : undefined;
      const lang =
        callback.origin === new URL(webOrigin).origin && isSupportedLocale(callbackLang)
          ? callbackLang
          : isSupportedLocale(userLocale)
            ? userLocale
            : DEFAULT_LOCALE;
      // Reuse the configured plugin handler: it owns trusted-device validation,
      // session deletion/cache-cookie scrubbing and signed pending-2FA records.
      // Better Call's middleware return type omits the returnHeaders envelope.
      const result: unknown = await twoFactorPlugin.hooks.after[0]!.handler({
        ...ctx,
        returnHeaders: true,
      });
      if (
        !result ||
        typeof result !== "object" ||
        !("headers" in result) ||
        !(result.headers instanceof Headers) ||
        !("response" in result)
      ) {
        throw ctx.error("INTERNAL_SERVER_ERROR");
      }
      for (const cookie of result.headers.getSetCookie()) {
        ctx.responseHeaders.append("set-cookie", cookie);
      }
      const response = result.response;
      if (
        !response ||
        typeof response !== "object" ||
        !("twoFactorRedirect" in response) ||
        response.twoFactorRedirect !== true
      )
        return;
      const challenge = new URL(`/${lang}/login`, webOrigin);
      challenge.searchParams.set("twoFactor", "true");
      challenge.searchParams.set(
        "redirectTo",
        callback.origin === new URL(webOrigin).origin
          ? `${callback.pathname}${callback.search}${callback.hash}`
          : `/${lang}/dashboard`,
      );
      throw ctx.redirect(challenge.toString());
    }),
  },

  logger: authLogger,

  trustedOrigins: isCrossOrigin ? [env.CORS_ORIGIN!, env.BETTER_AUTH_URL] : [env.BETTER_AUTH_URL],
  user: {
    additionalFields: {
      // Surface the Prisma `User.locale` column on the typed session so the
      // web app can read `session.user.locale` (and the i18n hook can sync it
      // into i18next). Default mirrors the Prisma `@default("en-US")` so a
      // pre-existing user that hasn't picked a locale yet reads as en-US.
      locale: {
        type: "string",
        required: false,
        defaultValue: "en-US",
        input: false, // not settable via signUp/updateUser; goes through the dedicated procedure
      },
      operationalAlerts: {
        type: "boolean",
        required: false,
        defaultValue: true,
        input: false,
      },
      // When forced 2FA first applied to this user; the enrollment grace
      // runs from here (NULL: from createdAt). Server-written only.
      twoFactorGraceStartedAt: {
        type: "date",
        required: false,
        input: false,
      },
      // Bound into the session cookie cache (session-authority.ts): a cached
      // snapshot is reused only while this equals the live row's. Maintained
      // solely by a database trigger.
      authorityVersion: {
        type: "number",
        required: false,
        defaultValue: 0,
        input: false,
      },
    },
  },
  emailAndPassword: {
    enabled: !forceSso,
    requireEmailVerification: true,
    // Better-Auth's default floor is 8. There is no breached-password check in
    // this template, so length is the only guessing cost. The signup and
    // reset-password forms mirror this; the login form deliberately does not,
    // since an account created under an older policy must still be able to
    // authenticate.
    minPasswordLength: 12,
    // A reset is the "my account may be compromised" path: sign out every
    // browser session in the same transaction as the password write.
    // A cached cookie of a deleted session is refused on its next request
    // (session-authority.ts versions the cache by the live session/user). PATs
    // and OAuth grants are NOT revoked; the reset success screen sends the
    // user to review them (settings/mcp?review=password-reset).
    revokeSessionsOnPasswordReset: true,
    // A redeemed reset link proves control of the mailbox it was sent to, so
    // it also verifies the address. This is how an admin invitation's one-time
    // "set your password" link verifies the invitee in the same step.
    // Written through the adapter, so the identity authority lock applies.
    onPasswordReset: async ({ user }) => {
      if (user.emailVerified) return;
      const context = await auth.$context;
      await context.internalAdapter.updateUser(user.id, { emailVerified: true });
    },
    sendResetPassword: async ({ user, url }) => {
      // Same locale-resolution dance as sendVerificationEmail: Better-Auth's
      // callback `user` is typed against the base user shape, so `locale`
      // (an additionalField) isn't on it. Fetch the row via Prisma so the
      // reset email routes through the recipient's preferred locale (the
      // renderer falls back to en-US for any unsupported / missing value).
      //
      // `url` already points at Better-Auth's /api/auth/reset-password/:token
      // endpoint, which validates the token and redirects to the `redirectTo`
      // passed by the client (the web /$lang/reset-password page) with
      // `?token=` appended (or `?error=INVALID_TOKEN` on a bad token).
      const row = await prisma.user.findUnique({
        where: { id: user.id },
        select: { locale: true },
      });
      const { subject, html } = renderResetPassword({
        url,
        locale: row?.locale ?? "en-US",
      });
      await sendEmail({
        to: user.email,
        subject,
        html,
      });
    },
  },
  emailVerification: {
    sendVerificationEmail: async ({ user, url }) => {
      // Better-Auth's `additionalFields` are present at runtime but the
      // sendVerificationEmail callback's `user` is typed against the base
      // user shape — `locale` isn't on it. Fetch the row via Prisma so the
      // recipient's preferred locale routes through to the renderer (which
      // falls back to en-US for any unsupported / missing value).
      const row = await prisma.user.findUnique({
        where: { id: user.id },
        select: { locale: true },
      });
      const { subject, html } = renderVerifyEmail({
        // `url` points at Better-Auth's /api/auth/verify-email endpoint, which
        // validates the token and then redirects to the `callbackURL` query
        // param — defaulting to `/` if nobody sets one. Rewrite it here (rather
        // than at each call site) so every verification email, whatever
        // triggered it, lands on the web /$lang/verify-email page with either a
        // confirmation or Better-Auth's `?error=` code.
        // CORS_ORIGIN is the web app's origin when it is served from a
        // different host than this API. Passing it makes the callback absolute
        // so the emailed link lands on the app, not on the API hostname.
        url: withVerificationCallback(url, row?.locale, env.CORS_ORIGIN),
        locale: row?.locale ?? "en-US",
      });
      await sendEmail({
        to: user.email,
        subject,
        html,
      });
    },
    sendOnSignUp: true,
    // `requireEmailVerification` above rejects a correct password on an
    // unverified account. Without this, that rejection is a dead end: the
    // original link expires after an hour and nothing re-sends it. The login
    // form additionally links to /$lang/verify-email for the case where the
    // re-sent mail doesn't arrive either.
    sendOnSignIn: true,
  },
  secret: env.BETTER_AUTH_SECRET.reveal(),
  baseURL: env.BETTER_AUTH_URL,
  session: {
    // session:30d, refresh every 1d
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
    // Short-lived signed cookie cache: skips Better Auth's full session/user
    // load on most requests. The cached snapshot is bound to the live session
    // row and the user's trigger-maintained authorityVersion on every request
    // (one indexed lookup), so revocation, reset, ban, role, 2FA, grace-start
    // and credential changes and a restore invalidate it at once
    // (session-authority.ts).
    cookieCache: {
      enabled: true,
      maxAge: 60,
      version: createSessionCacheVersion(prisma),
    },
  },
  advanced: {
    defaultCookieAttributes: isCrossOrigin
      ? { sameSite: "none", secure: true, httpOnly: true }
      : { httpOnly: true, secure: env.NODE_ENV === "production" },
  },
  // Better-Auth ships its own rate limiter, enabled by default in production
  // only. We turn it OFF and rely on the Redis-backed limiters in
  // `apps/server/src/rate-limit.ts`, which cover the same routes. This is a
  // consolidation, not a removal.
  //
  // Why: the built-in limiter defaults to `storage: "memory"` and keys on
  // `${ip}|${path}`. Two problems compound in a real deployment.
  //   1. Memory storage is per-process, so the effective limit multiplies by
  //      replica count and resets on every deploy.
  //   2. Its IP resolution returns null when `X-Forwarded-For` carries more
  //      than one entry and no `trustedProxies` is configured — the normal
  //      case behind Render or any two-hop proxy. The key then degenerates to
  //      the literal string "no-trusted-ip", SHARED BY EVERY CLIENT. Its
  //      built-in rule of 3 sign-ins per 10s would then apply to the whole
  //      deployment at once: a self-inflicted outage that is also no defense,
  //      announced by a single startup warning.
  // The limiters in apps/server are Redis-backed (correct across replicas,
  // survive deploys), key on the app's own proxy-aware `resolveClientIp`, and
  // are tunable via RATE_LIMIT_* env vars. Running both would double-count
  // and make 429s impossible to attribute.
  //
  // If you re-enable this, configure `advanced.ipAddress.trustedProxies` AND
  // a `secondaryStorage` first — the defaults are not safe behind a proxy.
  rateLimit: { enabled: false },
  plugins: [
    rejectIdTokenSignIn,
    ...resolveDevicePlugins({
      db: prisma,
      canonicalOrigin: new URL(env.BETTER_AUTH_URL).origin,
      baseUrl: env.BETTER_AUTH_URL,
      webOrigin: env.CORS_ORIGIN || env.BETTER_AUTH_URL,
    }),
    ...resolveMcpPlugins({
      db: prisma,
      baseUrl: env.BETTER_AUTH_URL,
      secret: env.BETTER_AUTH_SECRET.reveal(),
    }),
    admin({
      defaultRole: "user",
      roles: { admin: defaultAc.newRole(knowledgeBaseAdminPermissions), user: userAc },
    }),
    twoFactorPlugin,
    ...(ssoEnabled && env.SSO_CLIENT_ID && env.SSO_CLIENT_SECRET && env.SSO_ISSUER
      ? [
          genericOAuth({
            config: [
              {
                providerId: "sso",
                discoveryUrl: `${env.SSO_ISSUER}/.well-known/openid-configuration`,
                clientId: env.SSO_CLIENT_ID,
                clientSecret: env.SSO_CLIENT_SECRET.reveal(),
                scopes: ["openid", "profile", "email"],
              },
            ],
          }),
        ]
      : []),
  ],
  databaseHooks: {
    user: {
      create: {
        before: async (user, context) => {
          const locale = resolveSignupLocale(context?.headers);
          // Locale, and admin-created accounts start unverified (only the
          // emailed set-password link proves the mailbox). First-admin
          // selection, role assignment, signup-disabled enforcement and the
          // server-owned column allowlist run inside the wrapped adapter
          // transaction (bootstrap.ts, user-columns.ts).
          const adminCreated = context?.path === ADMIN_CREATE_USER_PATH;
          return {
            data: { ...user, locale, ...(adminCreated ? { emailVerified: false } : {}) },
          };
        },
      },
      delete: {
        before: async (user) => {
          const userId = typeof user.id === "string" ? user.id : undefined;
          if (!userId) return;
          await assertOrdinaryAccountDeletionAllowed(prisma, userId);
        },
      },
    },
  },
});

export type Session = typeof auth.$Infer.Session;
