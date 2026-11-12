import { z } from "zod";
import { toSecret } from "../secret.js";
import { originUrl } from "../url.js";
import { strictBooleanFlag } from "./shared.js";

// ---------------------------------------------------------------------------
// Server-only variable DECLARATIONS. See ./shared.ts for why these live in a
// side-effect-free module of their own.
//
// Disjointness contract: no key declared here may also appear in ./shared.ts —
// `extends` merges, it does not allow overriding.
// ---------------------------------------------------------------------------

export const serverVars = {
  KB_ASSET_S3_SECRET_ACCESS_KEY: z.string().optional().transform(toSecret),
  // Optional process port override. Portless and production platforms inject
  // `PORT`; `SERVER_PORT` is only for raw local runs or container overrides.
  PORT: z.coerce.number().int().min(1).max(65_535).optional(),
  SERVER_PORT: z.coerce.number().int().min(1).max(65_535).optional(),
  BETTER_AUTH_SECRET: z.string().min(32).transform(toSecret),
  BETTER_AUTH_URL: originUrl("BETTER_AUTH_URL"),
  CORS_ORIGIN: originUrl("CORS_ORIGIN").optional(),
  SSO_ENABLED: strictBooleanFlag(),
  SSO_CLIENT_ID: z.string().optional(),
  SSO_CLIENT_SECRET: z.string().optional().transform(toSecret),
  SSO_ISSUER: z.string().optional(),
  SSO_PROVIDER_NAME: z.string().default("SSO"),
  FORCE_SSO: strictBooleanFlag(),
  SIGNUP_ENABLED: strictBooleanFlag(),
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional().transform(toSecret),
  // Web Push contact URI sent to push services (RFC 8292 requires a mailto:
  // or https: URL the service can use to reach you about problems).
  VAPID_SUBJECT: z
    .string()
    .regex(/^(mailto:|https:)/, "VAPID_SUBJECT must be a mailto: or https: URL")
    .optional(),
  // ---- Rate limiting: three named budgets, two knobs each. -----------------
  // Each budget describes its family's REFERENCE member (the number below);
  // every other limiter in the family keeps its ratio to that reference, so
  // setting a budget re-tunes the whole family coherently:
  //
  //   • POINTS multiplies every family member's points by provided/reference.
  //   • WINDOW_SECONDS multiplies every member's window AND block duration by
  //     the same factor (the window:block ratio is part of each member's
  //     design and moves as a unit).
  //
  // Why not one knob per limiter: a per-surface
  // knob invites squeezing one budget to "be safe" — which locks out a
  // shared office behind one NAT IP — instead of SPLITTING the surface that
  // needs its own bucket. Tighter is not safer; if one surface 429s
  // legitimate users, split the surface instead of shrinking a budget.
  // Burst/sustained ratios, bucket keying, and fail-open/fail-closed stay
  // fixed in code (apps/server/src/rate-limit.ts +
  // packages/api/src/lib/rate-limit-families.ts). Defaults reproduce the
  // shipped numbers exactly.
  //
  // AUTH family — the fail-closed /api/auth/* limiters: general auth surface
  // (this reference, 30/60 s + 5-min block), credential (10/60 s),
  // credential burst (3/10 s), signup (10/h), and 2FA-OTP resend
  // (3/15 min). IP-keyed, so shared-NAT
  // offices share these budgets — size for several concurrent humans.
  RATE_LIMIT_AUTH_POINTS: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_AUTH_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  // RPC family — ordinary request volume: /rpc/* (this reference, 100/60 s),
  // /ready (60), and the SSR catch-all (300).
  RATE_LIMIT_RPC_POINTS: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_RPC_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  // EMAIL family — per-RECIPIENT caps on the anonymous endpoints that mail a
  // caller-supplied address: verification resend / password reset (this
  // reference, 3 per hour), signup (6), and sign-in-triggered mails (10).
  // The 0-second block stays code-fixed: a block on a caller-supplied key is
  // an unauthenticated lockout lever against that user's password reset.
  RATE_LIMIT_EMAIL_POINTS: z.coerce.number().int().min(0).default(3),
  RATE_LIMIT_EMAIL_WINDOW_SECONDS: z.coerce.number().int().positive().default(3600),
  // Exact number of trusted reverse proxies between the client and the app,
  // for deriving the client IP used as the anonymous rate-limit key
  // (apps/server/src/client-ip.ts). 0 (the default) keys on the socket peer
  // and ignores X-Forwarded-For; behind a proxy that shares every client into
  // one bucket. 1 for a single proxy (the generated Dokploy Compose sets 1 for
  // Traefik); add one per extra proxy whose header the next proxy keeps (2 for
  // Cloudflare -> Traefik only with Traefik trusting Cloudflare's ranges). With
  // N > 0 the app must be reachable only through those proxies.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(0),
  // Sole production bootstrap identity. One trimmed, lowercase, valid email.
  // Unset is allowed (dev/test first-user bootstrap; provisioned installs).
  ADMIN_EMAIL: z.string().trim().email().toLowerCase().optional(),
  // TTL (seconds) for the in-memory SSR HTML cache of public pages
  // (apps/server/src/ssr-cache.ts). 0 disables the cache entirely; the
  // default keeps a cached public render for up to a minute. Edits to a live
  // URL can take up to this long to appear.
  SSR_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).default(60),
};
