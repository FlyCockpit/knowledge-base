// Load repo-root `.env` before any `@knowledge-base/env/*` validation (and before
// packages that import it: auth, db, api). Must stay the first import.
import "@knowledge-base/env/load-dotenv";

import { createHash } from "node:crypto";
import { serve } from "@hono/node-server";
import { createContext } from "@knowledge-base/api/context";
import { credentialQuery } from "@knowledge-base/api/lib/kb/credential-query";
import { prismaAuthorityStore } from "@knowledge-base/api/lib/kb/permissions";
import { getKbRuntime } from "@knowledge-base/api/lib/kb/runtime";
import { revokePersonalToken } from "@knowledge-base/api/lib/mcp-token-access";
import {
  pushSubscriptionInputSchema,
  upsertPushSubscription,
} from "@knowledge-base/api/lib/push-subscription";
import { isTwoFactorPolicySatisfied } from "@knowledge-base/api/lib/two-factor-policy";
import { appRouter } from "@knowledge-base/api/routers/index";
import { auth, type Session } from "@knowledge-base/auth";
import { isUserBanned } from "@knowledge-base/auth/ban";
import { createDeviceApprovalService } from "@knowledge-base/auth/device-approval";
import { canonicalMcpResource } from "@knowledge-base/auth/mcp-config";
import { isImpersonatedSession } from "@knowledge-base/auth/roles";
import { CANONICAL_ORIGIN_HEADER } from "@knowledge-base/config/locales";
import { ORPC_BATCH_MAX_SIZE } from "@knowledge-base/config/orpc-batch";
import { THEME_INIT_SCRIPT } from "@knowledge-base/config/theme-init";
import prisma from "@knowledge-base/db";
import { logEvent, logInternalError } from "@knowledge-base/env/log";
import { ADMIN_EMAIL, env } from "@knowledge-base/env/server";
import { kbDataPaths } from "@knowledge-base/env/topology";
import { QUEUE_NAMES, redisConnection } from "@knowledge-base/queue";
import { hasExternalConsumer } from "@knowledge-base/queue/consumer-health";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { ORPCError, onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { BatchHandlerPlugin, SimpleCsrfProtectionHandlerPlugin } from "@orpc/server/plugins";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { RateLimiterRedis } from "rate-limiter-flexible";
import { betterAuthRemoveUser } from "./admin-remove-user.js";
import { apiReferenceAdminGate } from "./api-reference-admin-gate.js";
import { betterAuthAdminGate } from "./better-auth-admin-gate.js";
import { bodyPolicyMiddleware } from "./body-policy.js";
import { readBuildCommit } from "./build-commit.js";
import { resolveClientIp } from "./client-ip.js";
import { CORS_ALLOW_HEADERS } from "./cors-headers.js";
import { guardDeviceApproval } from "./device-approval-gate";
import {
  EMAIL_RECIPIENT_PATHS,
  emailRecipientLimit,
  FORM_OR_JSON_MEDIA_TYPES,
  SIGNIN_RECIPIENT_PATH,
  SIGNUP_RECIPIENT_PATH,
  signinSentMail,
} from "./email-recipient-limit.js";
import { createGitHttp } from "./git-http.js";
import { createKbAssetRoutes } from "./kb-asset-routes.js";
import { createKbExportRoutes } from "./kb-export-routes.js";
import { createKbTokenRoutes } from "./kb-token-routes.js";
import { createServerLifecycle, withTimeout } from "./lifecycle.js";
import {
  LOCALE_MODULEPRELOAD_HEADER,
  loadLocaleModulePreloads,
  resolveLocaleModulePreload,
} from "./locale-modulepreload.js";
import { createAdmissionGate } from "./mcp/admission.js";
import { createBearerAdmission } from "./mcp/auth.js";
import { createMcpEndpoint } from "./mcp/handler.js";
import { mountMcpOAuth } from "./mcp-discovery.js";
import { deviceStartLimiter } from "./rate-limit";
import {
  authLimiter,
  createRateLimiterMiddleware,
  credentialBurstLimiter,
  credentialLimiter,
  mcpConsentLimiter,
  mcpRegistrationLimiter,
  readyLimiter,
  resolveKey,
  rpcLimiter,
  signinRecipientLimiter,
  signupLimiter,
  signupRecipientLimiter,
  ssrLimiter,
} from "./rate-limit.js";
import { requestLog } from "./request-log.js";
import { validateSameSiteJsonRequest } from "./request-origin.js";
import { mountSecurityHeaders } from "./security-headers.js";
import { registerSeoRoutes } from "./seo.js";
import { sessionMiddleware } from "./session-middleware.js";
import { SIGNIN_FAILURE_PATH, signinFailureLimit } from "./signin-failure-limit.js";
import { adminBootstrapMarker } from "./signup-gate.js";
import { handleSsrRequest } from "./ssr-cache.js";
import { TWO_FACTOR_OTP_PATH, twoFactorOtpLimit } from "./two-factor-otp-limit.js";

// ---------------------------------------------------------------------------
// Startup guards
// ---------------------------------------------------------------------------

// Non-production banner. NODE_ENV defaults to "development" (see
// packages/env/src/vars/shared.ts), which silently weakens several guards for
// anyone running the server by hand outside Docker — where NODE_ENV is often
// simply unset. Say so loudly at boot, naming what is weaker.
if (process.env.NODE_ENV !== "production") {
  logEvent("server.non-production", { mode: process.env.NODE_ENV ?? "development" });
}

// ---------------------------------------------------------------------------
// App + global middleware
// ---------------------------------------------------------------------------

type AppVariables = {
  requestId: string;
  session: Session | null;
};

const buildCommit = readBuildCommit();
const app = new Hono<{ Variables: AppVariables }>();

// Request-ID — attach a short random ID to every request for log correlation.
// The ID is stored in `c.var.requestId` and included in the logger output.
app.use("/*", async (c, next) => {
  const id = crypto.randomUUID().slice(0, 8);
  c.set("requestId", id);
  await next();
});

// Request log: route template, method, status, duration, request id — never the
// raw path or query (reset/verification tokens travel in both).
app.use("/*", requestLog());

// Secure-headers — sets a battery of security headers (X-Content-Type-Options,
// X-Frame-Options, Strict-Transport-Security, etc.) on every response, plus the
// raw-asset `sandbox` CSP override. Ordering between the two is load-bearing and
// lives in mountSecurityHeaders (see its doc comment + security-headers.test.ts).
// CSP: tighten per route if third-party scripts/analytics are needed.
//
const cspConnectSrc = ["'self'", ...(env.CORS_ORIGIN ? [env.CORS_ORIGIN] : [])];

// CSP hash authorizing the inlined anti-FOUC theme bootstrap (THEME_INIT_SCRIPT,
// injected into <head> by apps/web/src/routes/__root.tsx). Computed from the
// shared string at startup, so it can never drift from the inlined content. An
// inline script needs a nonce or hash to run under `script-src 'self' 'nonce-…'`;
// this static bootstrap can't carry a per-request nonce, so it uses a hash.
const themeInitCspHash = `'sha256-${createHash("sha256").update(THEME_INIT_SCRIPT).digest("base64")}'`;
mountSecurityHeaders(app, { cspConnectSrc, themeInitCspHash });

// Route-specific body limits — MCP 1 MiB, upload frames capped, default 10 MiB.
const ordinaryBodyPolicy = bodyPolicyMiddleware({ clientKey: resolveClientIp });
app.use("/*", (c, next) =>
  c.req.path === "/mcp" || c.req.path === "/api/kb/token/revoke-self"
    ? next()
    : ordinaryBodyPolicy(c, next),
);
const httpGate = createAdmissionGate();
app.use("/*", async (c, next) => {
  if (c.req.path === "/health") return next();
  const permit = httpGate.admit(c.req.raw.signal);
  if (!permit || lifecycle.isShuttingDown()) {
    permit?.release();
    return c.body(null, 503);
  }
  try {
    await next();
  } finally {
    permit.release();
  }
});
const mcpAuthHandler = mountMcpOAuth(app, {
  baseUrl: env.BETTER_AUTH_URL,
  webOrigin: env.CORS_ORIGIN,
  handler: auth.handler,
});

// Catch any uncaught error from a route/middleware so admins get a fixed record
// (request id, error class and code) instead of an opaque 500 in the client.
app.onError((err, c) => {
  const reqId = c.get("requestId") ?? "-";
  logInternalError("http.unhandled", err, { requestId: reqId, method: c.req.method });
  return c.json({ error: "Something didn't work on our end. Try again in a moment." }, 500);
});

// Shared oRPC error logger. Skips expected client errors (4xx ORPCErrors like
// UNAUTHORIZED / NOT_FOUND / METHOD_NOT_SUPPORTED) so logs only contain real
// problems. Transient 5xx codes (502/503/504 — usually upstream infra blipping)
// log at warn so they don't pollute error dashboards alongside genuine bugs.
function logOrpcError(error: unknown) {
  if (error instanceof ORPCError && error.status < 500) {
    return;
  }
  const isTransient5xx = error instanceof ORPCError && error.status > 500;
  logInternalError(isTransient5xx ? "orpc.transient" : "orpc", error);
}
if (env.CORS_ORIGIN) {
  app.use(
    "/*",
    cors({
      origin: env.CORS_ORIGIN,
      allowMethods: ["GET", "POST", "OPTIONS"],
      // Adding a header the client sets? It must go in CORS_ALLOW_HEADERS or
      // the preflight fails and the request never leaves the browser — a
      // failure mode invisible in local dev. See cors-headers.ts.
      allowHeaders: [...CORS_ALLOW_HEADERS],
      credentials: true,
    }),
  );
}

// Liveness probe — answers whether this Node process can serve HTTP. Keep this
// independent of external services so orchestrators do not restart healthy app
// containers during a transient Postgres/Redis failover.
app.get("/health", (c) => c.json({ ok: true }));

// Readiness probe — checks dependencies for deploy gates and manual diagnosis.
// Rate-limited (unlike /health) because it touches Postgres and Redis on every
// call, so an unthrottled public probe is a cheap way to load the datastores.
// Fail-open: an orchestrator must still be able to read readiness during a
// Redis blip, which is exactly when it matters most.
//
// Its OWN bucket, not a remount of `rpcLimiter`: readiness and app traffic are
// exactly the two things that must stay independent during an incident.
const bearerGate = createAdmissionGate();
const bearer = createBearerAdmission({
  withQuery: credentialQuery(env.DATABASE_URL.reveal()),
  gate: bearerGate,
  origin: new URL(env.BETTER_AUTH_URL).origin,
  isClosing: () => bearerGate.closed,
  // In-process key store: never fetch our own public origin (hairpin/TLS).
  loadJwks: () => auth.api.getJwks(),
});
const mcpEndpoint = createMcpEndpoint({
  admit: bearer,
  gate: bearerGate,
  origin: new URL(env.BETTER_AUTH_URL).origin,
});
const gitHttp = createGitHttp({
  push: {
    connectionString: env.DATABASE_URL.reveal(),
    canonicalOrigin: new URL(env.BETTER_AUTH_URL).origin,
    ratePort: { consume: (...args) => getKbRuntime().ratePort.consume(...args) },
  },
  reposDir: kbDataPaths(env.KB_DATA_ROOT).reposDir,
  admit: bearer,
  store: prismaAuthorityStore(prisma),
  retainedRefs: async (kbId) => {
    // Fail closed before the native control-frame budget; never silently omit branches.
    const rows = await prisma.branchOwner.findMany({
      where: { kbId },
      select: { refName: true },
      take: 1025,
    });
    if (rows.length > 1024) throw new Error("Git ref inventory exceeds transport budget");
    return ["refs/heads/main", ...rows.map((row) => row.refName)];
  },
});
const lifecycle = createServerLifecycle({
  closeGitAdmission: () => gitHttp.close(),
  closeBearerAdmission: () => {
    const drain = Promise.all([httpGate.close(), bearerGate.close()]);
    return drain.then(() => mcpEndpoint.close());
  },
});
const gitHttpLimiter = new RateLimiterRedis({
  storeClient: redisConnection,
  keyPrefix: "rl:git-http",
  points: 120,
  duration: 60,
});
app.use("/git/*", createRateLimiterMiddleware(gitHttpLimiter, { failClosed: true }));
app.route("/", gitHttp.app);
const mcpHttpLimiter = new RateLimiterRedis({
  storeClient: redisConnection,
  keyPrefix: "rl:mcp-http",
  points: 120,
  duration: 60,
});
app.use("/mcp", createRateLimiterMiddleware(mcpHttpLimiter, { failClosed: true }));
app.all("/mcp", (c) => mcpEndpoint.fetch(c.req.raw, c.get("requestId")));
const selfRevokeLimiter = new RateLimiterRedis({
  storeClient: redisConnection,
  keyPrefix: "rl:kb-token-self-revoke",
  points: 10,
  duration: 60,
});
app.route(
  "/",
  createKbTokenRoutes({
    admit: bearer,
    gate: bearerGate,
    isClosing: () => bearerGate.closed,
    charge: async (c) => {
      await selfRevokeLimiter.consume(resolveKey(c));
    },
    revoke: (userId, tokenId) => revokePersonalToken(getKbRuntime(), userId, tokenId),
  }),
);

const kbExportHttpLimiter = new RateLimiterRedis({
  storeClient: redisConnection,
  keyPrefix: "rl:kb-export-http",
  points: 10,
  duration: 60,
});
app.use("/kb-exports/*", createRateLimiterMiddleware(kbExportHttpLimiter, { failClosed: true }));
app.route(
  "/",
  createKbExportRoutes({
    runtime: getKbRuntime,
    bearer,
    session: async (headers) => {
      const session = await auth.api.getSession({ headers });
      return isImpersonatedSession(session) ? null : session;
    },
    isShuttingDown: lifecycle.isShuttingDown,
  }),
);

const kbAssetHttpLimiter = new RateLimiterRedis({
  storeClient: redisConnection,
  keyPrefix: "rl:kb-asset-http",
  points: 120,
  duration: 60,
});

app.use("/kb-assets/*", createRateLimiterMiddleware(kbAssetHttpLimiter, { failClosed: true }));
app.route(
  "/",
  createKbAssetRoutes({
    runtime: getKbRuntime,
    bearer,
    session: async (headers) => {
      const session = await auth.api.getSession({ headers });
      return isImpersonatedSession(session) ? null : session;
    },
    isShuttingDown: lifecycle.isShuttingDown,
    chargeAssetWork: async (c, points) => {
      if (points > 0) await kbAssetHttpLimiter.consume(resolveKey(c), points);
    },
  }),
);

// The drain answer comes BEFORE the limiter, and must stay there. During a
// rolling deploy the load balancer polls readiness about once a second and the
// only correct reply is 503 "draining" — but a limiter placed first will start
// answering 429 partway through the drain window, which an orchestrator reads
// as "probe failed for an unknown reason", not as "stop sending me traffic".
// The check is a boolean read of process state: it touches neither Postgres nor
// Redis, so it costs nothing to serve unthrottled and there is nothing here for
// a limiter to protect. Everything past this point does hit the datastores, and
// that is what `readyLimiter` still guards.
app.use("/ready", async (c, next) => {
  if (lifecycle.isShuttingDown()) {
    return c.json({ ok: false, commit: buildCommit, checks: { shuttingDown: true } }, 503);
  }
  await next();
});
app.use("/ready", createRateLimiterMiddleware(readyLimiter));
app.get("/ready", async (c) => {
  const checks = {
    postgres: false,
    redis: false,
    workers: false,
  };
  const [postgres, redis, workers] = await Promise.allSettled([
    Promise.resolve().then(() =>
      withTimeout(prisma.$queryRaw`SELECT 1`, 3000, "postgres readiness check"),
    ),
    Promise.resolve().then(() =>
      withTimeout(redisConnection.ping(), 3000, "redis readiness check"),
    ),
    Promise.resolve().then(() =>
      withTimeout(
        hasExternalConsumer(redisConnection, Object.values(QUEUE_NAMES)),
        3000,
        "consumer readiness check",
      ),
    ),
  ]);
  // Preserve the sequential probe's failure-prefix values even though all
  // dependency checks now run concurrently.
  if (postgres.status === "rejected")
    return c.json({ ok: false, commit: buildCommit, checks }, 503);
  checks.postgres = true;
  if (redis.status === "rejected") return c.json({ ok: false, commit: buildCommit, checks }, 503);
  checks.redis = true;
  if (workers.status === "rejected") return c.json({ ok: false, commit: buildCommit, checks }, 503);
  checks.workers = workers.value;
  return c.json({ ok: checks.workers, commit: buildCommit, checks }, checks.workers ? 200 : 503);
});

// SEO / discoverability: /robots.txt, /sitemap.xml, /llms.txt. Registered here
// — before the static-asset middleware and the SSR catch-all below — so the
// `/$lang/...` router never swallows them and returns the SPA HTML shell.
registerSeoRoutes(app);

// ADMIN_EMAIL bootstrap marker (see signup-gate.ts). Pass-through by design:
// it marks the configured identity for admin-bootstrap mode but NEVER rejects,
// so member and non-member addresses are indistinguishable at this layer.
//
// SIGNUP_ENABLED=false and first-admin selection are enforced inside the
// wrapped Better Auth adapter transaction (packages/auth/src/bootstrap.ts).
// An earlier revision additionally rejected non-members here with an
// immediate 403 while members proceeded into Better-Auth — the immediate-403
// vs Better-Auth-processing split (shape + timing) revealed which emails are
// admins, so it was removed. Do NOT re-add an email-based early reject here.
app.use("/api/auth/sign-up/email", adminBootstrapMarker(ADMIN_EMAIL));

app.use(
  "/api/auth/oauth2/register",
  createRateLimiterMiddleware(mcpRegistrationLimiter, { failClosed: true }),
);
for (const path of [
  "/api/auth/oauth2/authorize",
  "/api/auth/oauth2/consent",
  "/api/auth/oauth2/continue",
]) {
  app.use(path, createRateLimiterMiddleware(mcpConsentLimiter, { failClosed: true }));
}

// Signup-specific rate limiter — stricter than the general auth limiter.
// Must be mounted BEFORE the general authLimiter so signup traffic is throttled
// at the tighter limit first.
app.use("/api/auth/sign-up/*", createRateLimiterMiddleware(signupLimiter, { failClosed: true }));

// `get-session` is a benign, cookie-authenticated read that the SPA polls on
// navigation/focus — many calls per minute under normal use. It must NOT be
// subject to the strict credential-stuffing limiter below: at 10/60s with a
// 15-minute block, normal polling locks legitimate users out, and because
// sign-in/sign-up share the /api/auth/* bucket, it blocks those too (a fresh
// user hits "Too many attempts" on their very first signup). Give it the
// general RPC ceiling instead. Mounted BEFORE the strict limiter.
app.use("/api/auth/get-session", createRateLimiterMiddleware(rpcLimiter));

// Credential endpoints — the tight bucket. Sign-in and 2FA verification are
// the only routes where an attacker's guess is worth something, so they get a
// much smaller budget than the rest of the auth surface. Mounted BEFORE the
// general limiter, which still applies as a second layer.
//
// Keeping this separate is what lets the general limiter below be generous:
// these limiters key on client IP, and an office or mobile carrier shares one,
// so a single tight limit across all of /api/auth/* would lock a shared
// network out of password reset and email verification — exactly what a user
// who just failed to sign in needs next.
// TWO windows on the same routes. The 60-second bucket bounds sustained
// guessing; the 10-second one bounds a burst, which is the shape credential
// stuffing actually has — 10/60s on its own happily permits ten guesses inside
// one second. Better-Auth's built-in limiter carried a 3-per-10s rule and we
// disable it (its key degenerates to one shared bucket behind a two-hop proxy;
// see packages/auth/src/index.ts), so this is what replaces that rule rather
// than dropping it.
for (const path of ["/api/auth/sign-in/*", "/api/auth/two-factor/*"]) {
  app.use(path, createRateLimiterMiddleware(credentialBurstLimiter, { failClosed: true }));
  app.use(path, createRateLimiterMiddleware(credentialLimiter, { failClosed: true }));
}

// Two-factor OTP resends, capped per CHALLENGE. Mounted here so it runs after
// the fail-closed IP-keyed pair above — its own key is a cookie, i.e.
// caller-supplied, and must sit behind something coarser. See
// `twoFactorOtpLimiter` for why Better-Auth leaves this endpoint uncapped and
// why the key is the challenge rather than the recipient.
app.use(TWO_FACTOR_OTP_PATH, twoFactorOtpLimit());

// Rate limit the remaining auth endpoints, EXCEPT get-session (handled above).
// Must be mounted BEFORE the auth handler so every auth request is throttled.
const authRateLimit = createRateLimiterMiddleware(authLimiter, { failClosed: true });
app.use("/api/auth/*", async (c, next) => {
  if (c.req.path.endsWith("/get-session")) return next();
  return authRateLimit(c, next);
});

// Per-RECIPIENT cap on the anonymous endpoints that mail a caller-supplied
// address. Mounted AFTER the IP limiter above (which is the fail-closed
// security control) because this is the anti-abuse layer on top: the IP
// limiter bounds one caller, this bounds one mailbox, and rotating IPs defeat
// only the former. See email-recipient-limit.ts.
for (const path of EMAIL_RECIPIENT_PATHS) {
  app.use(path, emailRecipientLimit());
}
// Signup mails a caller-supplied address too, and `signupLimiter` above is
// IP-keyed — the exact control rotating IPs defeat. Its own bucket and budget:
// see signupRecipientLimiter. Mounted here, so it runs AFTER the ADMIN_EMAIL
// bootstrap marker and signupLimiter: a request rejected by those never
// reaches this limiter and so never spends a point from the recipient's
// budget. (SIGNUP_ENABLED=false rejections happen downstream in the auth
// database hook, so blocked signups DO reach this limiter — same as any other
// request Better-Auth itself rejects.)
// `/sign-up/email` is the one route that widens Better-Auth's global
// JSON-only `allowedMediaTypes` to also accept form-urlencoded, so the limiter
// has to accept exactly that pair here — see FORM_OR_JSON_MEDIA_TYPES.
app.use(
  SIGNUP_RECIPIENT_PATH,
  emailRecipientLimit(signupRecipientLimiter, FORM_OR_JSON_MEDIA_TYPES),
);
// Sign-in mails too, but only against an unverified account and only because
// `requireEmailVerification` + `sendOnSignIn` are both on — see
// SIGNIN_RECIPIENT_PATH. Mounted after the fail-closed credentialBurstLimiter /
// credentialLimiter pair above, which stays the primary control here: the
// password is checked before any mail is sent, so this bucket is a backstop
// against a leaked-credential mail loop, not an anti-spam gate.
//
// DEFERRED metering (`signinSentMail`) — this must not charge a point for every
// sign-in attempt. The bucket keys on the caller-supplied address, so a
// per-attempt charge would let anyone who knows your email 429 you out of your
// own login. See the `ConsumeWhen` doc comment.
//
// Form-urlencoded as well as JSON: `/sign-in/email` widens the global media
// types exactly as `/sign-up/email` does (`sign-in.mjs:155`), and declaring
// JSON-only here would 415 legitimate form posts before Better-Auth sees them.
app.use(
  SIGNIN_RECIPIENT_PATH,
  emailRecipientLimit(signinRecipientLimiter, FORM_OR_JSON_MEDIA_TYPES, signinSentMail),
);

// Per-EMAIL cap on FAILED password sign-ins — the layer the IP-keyed pair
// above cannot provide: a rotating-IP stuffing campaign against ONE account
// gets a fresh 10/60s budget from every address it holds, and only this
// counter bounds it per account. Charged ONLY on 401 responses (see
// `signinFailedCredentials`), reserve-then-refund so successes never
// accumulate, 10 failures / 15 min → 10-minute block, keyed on a SHA-256 of
// the normalized email so no address ever sits in a Redis key, and fail-OPEN
// with in-memory insurance — the fail-closed IP pair stays the security floor
// on this route. Sign-in ONLY: signup/forgot-password stay IP-keyed, where a
// per-email counter would be a pure lockout lever. Full rationale:
// `signinFailureLimiter` in rate-limit.ts and signin-failure-limit.ts.
app.use(SIGNIN_FAILURE_PATH, signinFailureLimit());

// Admin gate for Better-Auth's admin plugin endpoints. The plugin role-checks
// by default. Only account-management permissions are enabled; they also
// honor this app's verified-admin
// and forced-2FA policy before the Better-Auth handler sees the request.
app.use("/api/auth/admin/*", betterAuthAdminGate);

// Serve `/admin/remove-user` from this app rather than the plugin: the plugin
// deletes credentials before its user-delete hook can block the removal (see
// admin-remove-user.ts). Registered after the gate middleware and before the
// catch-all so the gate still runs and Better-Auth's cascade never does.
app.on("POST", "/api/auth/admin/remove-user", betterAuthRemoveUser);

app.use(
  "/api/auth/device/code",
  createRateLimiterMiddleware(deviceStartLimiter, { failClosed: true }),
);
const deviceApproval = createDeviceApprovalService({
  db: prisma,
  resource: canonicalMcpResource(env.BETTER_AUTH_URL),
});
app.use("/api/auth/*", async (c, next) => {
  const rejected = await guardDeviceApproval(c.req.raw, {
    baseUrl: env.BETTER_AUTH_URL,
    webOrigin: env.CORS_ORIGIN || env.BETTER_AUTH_URL,
    getSession: auth.api.getSession,
    service: deviceApproval,
  });
  if (rejected) return rejected;
  return next();
});
app.on(["POST", "GET"], "/api/auth/*", (c) => mcpAuthHandler(c.req.raw));

// Resolve the Better-Auth session once per request on paths that need it.
// Mounted BEFORE the rate limiters so they can key on the user id without
// each making their own getSession() call. Not mounted on /api/auth/*
// (Better-Auth does its own lookup) or /health / SSR / dev-only routes.
app.use("/rpc/*", sessionMiddleware);
app.use("/sw/*", sessionMiddleware);

// Rate limit RPC endpoint — general API traffic.
// Uses Redis-backed limiter with in-memory insurance fallback (fail-open).
app.use("/rpc/*", createRateLimiterMiddleware(rpcLimiter));
app.use("/api-reference/*", createRateLimiterMiddleware(rpcLimiter));

// In production the OpenAPI reference is admin-only: it documents every
// procedure and shouldn't be a public surface. Non-admins get a 404 (not
// 401/403) so the page isn't enumerable, matching the adminOr404 convention.
// Mounted after the rate limiter so brute-forcing the gate is throttled first.
// In development it stays open for local API exploration.
if (env.NODE_ENV === "production") {
  app.use("/api-reference/*", apiReferenceAdminGate);
}

// Unknown API paths must never fall through to static files or the SPA shell.
// Registered after the live /api routes above.
app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

// ---------------------------------------------------------------------------
// Service-worker push-subscription renewal
// ---------------------------------------------------------------------------
// Dedicated HTTP endpoint for the `pushsubscriptionchange` handler in
// `apps/web/src/sw.ts`. The service worker runs in a separate execution
// context that cannot easily import the oRPC client, so it needs a plain
// HTTP route. Narrow blast radius: authenticated via Better-Auth session
// cookie, accepts only a push-subscription body, rate-limited the same way
// as `push.subscribe` (same underlying `upsertPushSubscription` helper).
//
// CSRF: both oRPC handlers always require the SimpleCsrfProtectionHandlerPlugin
// header, independent of CORS configuration. It does not guard the Hono app,
// so this route uses a plain HTTP guard
// instead: JSON-only body, same-site fetch metadata, and Origin allowlist.
app.use("/sw/*", createRateLimiterMiddleware(rpcLimiter));
app.post("/sw/push-renew", async (c) => {
  const rejected = validateSameSiteJsonRequest(c);
  if (rejected) return rejected;

  const session = c.get("session");
  if (!session?.user || isImpersonatedSession(session) || isUserBanned(session.user)) {
    return c.json({ error: "You're not signed in. Please sign in and try again." }, 401);
  }
  if (!(await isTwoFactorPolicySatisfied(session.user))) {
    return c.json({ error: "Two-factor authentication setup is required." }, 403);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Request must be valid JSON." }, 400);
  }

  const parsed = pushSubscriptionInputSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Request contains missing or invalid fields." }, 400);
  }

  try {
    await upsertPushSubscription(session.user.id, parsed.data);
  } catch (error) {
    if (error instanceof ORPCError && error.code === "CONFLICT") {
      return c.json({ error: error.message }, 409);
    }
    throw error;
  }
  return c.json({ success: true });
});

// Always require x-csrf-token: orpc on both oRPC handlers, including same-origin
// deployments: simple multipart requests can carry cookies from sibling origins.
// The web client's SimpleCsrfProtectionLinkPlugin sends it; non-browser callers must too.
const csrfPlugins = [new SimpleCsrfProtectionHandlerPlugin()];

export const apiHandler = new OpenAPIHandler(appRouter, {
  plugins: [
    new OpenAPIReferencePlugin({
      schemaConverters: [new ZodToJsonSchemaConverter()],
    }),
    ...csrfPlugins,
  ],
  interceptors: [onError(logOrpcError)],
});

// `BatchHandlerPlugin` matches the client's `BatchLinkPlugin` (see
// `apps/web/src/utils/orpc.ts`). Without it, any time the SPA fires multiple
// concurrent queries with a shared router prefix the client wraps them into
// a single `/rpc/<prefix>/__batch__` POST that the server otherwise 404s.
//
// `maxSize` must stay in sync with the client — both read the shared
// `ORPC_BATCH_MAX_SIZE`, never a literal. If this drops below the client's
// value, the server rejects the entire batch with HTTP 413 ("Batch request
// size exceeds the maximum allowed size") and every query in it fails. That
// 413 is a *procedure count* limit, not `bodyLimit` and not a proxy payload
// limit. See `packages/config/src/orpc-batch.ts`.
export const rpcHandler = new RPCHandler(appRouter, {
  plugins: [new BatchHandlerPlugin({ maxSize: ORPC_BATCH_MAX_SIZE }), ...csrfPlugins],
  interceptors: [onError(logOrpcError)],
});

// oRPC's own prefix test (`pathname.startsWith(`${prefix}/`) || pathname === prefix`).
// Hono's `c.req.path` only differs from the URL pathname by percent-decoding,
// which cannot remove a literal prefix, so this never skips a path oRPC matches.
const ORPC_PREFIXES = ["/rpc", "/api-reference"] as const;
const mayMatchOrpc = (path: string) =>
  ORPC_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));

app.use("/*", async (c, next) => {
  // Static assets and SSR never reach oRPC: skip the context (a session
  // lookup on the fallback path) instead of resolving it on every request.
  if (!mayMatchOrpc(c.req.path)) return next();
  const context = await createContext({ context: c, clientIp: resolveClientIp(c) });

  const rpcResult = await rpcHandler.handle(c.req.raw, {
    prefix: "/rpc",
    context: context,
  });

  if (rpcResult.matched) {
    return c.newResponse(rpcResult.response.body, rpcResult.response);
  }

  const apiResult = await apiHandler.handle(c.req.raw, {
    prefix: "/api-reference",
    context: context,
  });

  if (apiResult.matched) {
    return c.newResponse(apiResult.response.body, apiResult.response);
  }

  await next();
});

if (env.NODE_ENV === "production") {
  const { serveStatic } = await import("@hono/node-server/serve-static");
  const { fileURLToPath, pathToFileURL } = await import("node:url");
  const { dirname, join } = await import("node:path");

  // The built web assets live at apps/web/dist — a sibling of apps/server.
  // Resolve them from THIS module's location, not the process CWD: the bundle
  // runs as /app/apps/server/dist/index.mjs with CWD=/app, so a CWD- or
  // module-relative "../web/dist" lands in the wrong place. `serveStatic`
  // (CWD-relative) and dynamic import (module-relative) disagree on the base,
  // so we hand both an absolute path computed from import.meta.url.
  const webDist = join(dirname(fileURLToPath(import.meta.url)), "../../web/dist");

  // Serve static client assets (JS, CSS, images)
  // Vite/rolldown content-hashes every file under /assets, so each URL is
  // immutable: a code change produces a new filename, never a new body at the
  // same URL. Safe to cache for a year. This middleware runs before the
  // serveStatic below (sets the header, then defers to it).
  // IMPORTANT: do NOT add long caching to the catch-all /* serveStatic or the
  // SSR shell — index.html and version.json must stay revalidated so new
  // deploys are picked up.
  app.use("/assets/*", async (c, next) => {
    c.header("Cache-Control", "public, max-age=31536000, immutable");
    await next();
  });
  app.use("/assets/*", serveStatic({ root: join(webDist, "client") }));

  // `build.manifest: true` (apps/web/vite.config.ts) writes the client Vite
  // manifest INTO the static root at `.vite/manifest.json`, and Hono's
  // serveStatic happily serves dotfile directories. That file maps every source
  // path to its hashed asset — including admin-only route chunks — and its
  // node_modules keys leak the exact installed version of every dependency,
  // which is free reconnaissance for anyone probing for a known CVE. The server
  // reads it from disk at startup; nothing needs it over HTTP. Deny it before
  // the catch-all static handler can find it. See locale-modulepreload.ts.
  app.all("/.vite/*", (c) => c.text("Not Found", 404));

  app.use("/*", serveStatic({ root: join(webDist, "client") }));

  // Mount TanStack Start for SSR — handles all non-static requests. The bundle
  // is produced by `apps/web` at build time and doesn't exist when this file is
  // type-checked, so the specifier is computed at runtime (a non-literal import
  // is left external by rolldown automatically).
  const startHandlerUrl = pathToFileURL(join(webDist, "server/server.js")).href;
  const { default: startHandler } = await import(startHandlerUrl);

  // Content-hashed locale aggregate chunks for SSR modulepreload. Built from
  // the client Vite manifest (apps/web `build.manifest: true`). Missing in
  // incomplete builds is non-fatal — visitors still load the locale on demand.
  loadLocaleModulePreloads(join(webDist, "client"));

  // Throttle the SSR catch-all. Everything above this line is either a static
  // file or an already-limited API route; everything reaching here renders
  // React on the server. Public pages are cached for SSR_CACHE_TTL_SECONDS,
  // but that cache is in-memory, per-replica, and keyed by URL — so a loop
  // appending a junk query string misses it every time and renders on each
  // request. Generous and fail-open on purpose: this is CPU protection, not a
  // security control, and it must never be why a real visitor can't load the
  // site. Mounted only in production, matching the SSR handler itself.
  app.use("/*", createRateLimiterMiddleware(ssrLimiter));

  app.all("/*", async (c) => {
    // Forward the per-request CSP nonce (from secureHeaders) to the SSR
    // renderer via a request header. getRouter() reads it server-side and sets
    // router.options.ssr.nonce, so TanStack Start stamps the matching nonce on
    // every inline script it injects — otherwise script-src would block them.
    //
    // Also forward the active non-default locale's aggregate chunk URL so the
    // SSR root can emit `<link rel="modulepreload">`. Both headers are
    // server-controlled: strip any client-supplied values first.
    const nonce = c.get("secureHeadersNonce");
    const headers = new Headers(c.req.raw.headers);
    headers.delete("x-csp-nonce");
    headers.delete(LOCALE_MODULEPRELOAD_HEADER);
    headers.delete(CANONICAL_ORIGIN_HEADER);
    // Configured origin for the public home page's canonical/og URLs (F17).
    headers.set(CANONICAL_ORIGIN_HEADER, new URL(env.BETTER_AUTH_URL).origin);
    if (typeof nonce === "string") {
      headers.set("x-csp-nonce", nonce);
    }
    const localePreload = resolveLocaleModulePreload(new URL(c.req.raw.url).pathname);
    if (localePreload) {
      headers.set(LOCALE_MODULEPRELOAD_HEADER, localePreload);
    }
    const request = new Request(c.req.raw, { headers });
    // Public, anonymous GETs are served from a bounded in-memory HTML cache
    // (TTL via SSR_CACHE_TTL_SECONDS); everything else falls straight through
    // to the renderer. The nonce is swapped per request inside the cache.
    return handleSsrRequest({
      request,
      nonce: typeof nonce === "string" ? nonce : undefined,
      render: (req) => startHandler.fetch(req),
    });
  });
} else {
  app.get("/", (c) => {
    return c.text("OK");
  });
}

await lifecycle.start((onListening) =>
  serve(
    {
      fetch: app.fetch,
      port: env.SERVER_PORT ?? env.PORT ?? 3000,
      // Node's default keepAliveTimeout (5s) is shorter than the idle-reuse window of
      // fronting proxies (nginx keepalive_timeout defaults to 60-75s; Traefik similar),
      // so the app would drop sockets the proxy still considers open → sporadic 502s/
      // ECONNRESETs. The app timeout must exceed the proxy's (65s here), and Node
      // requires headersTimeout > keepAliveTimeout (66s).
      serverOptions: {
        keepAliveTimeout: 65_000,
        headersTimeout: 66_000,
      },
    },
    (info) => {
      logEvent("server.listening", { port: info.port });
      onListening();
    },
  ),
);
