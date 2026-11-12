/**
 * THE canonical description of every environment variable in this repo.
 *
 * Three things read this file:
 *   1. `pnpm generate:secrets`  (scripts/generate-secrets.ts)  — builds a
 *      ready-to-paste production env block, generating what it can and
 *      prompting for what it can't.
 *   2. `pnpm env:sync`          (scripts/sync-env-example.ts)  — regenerates
 *      `.env.example`, `apps/web/.env.example`.
 *      Those files are GENERATED. Do not hand-edit them; edit this
 *      manifest and re-run the script.
 *   3. `pnpm env:check`         (same script, `--check`)       — CI gate. Fails
 *      when a key declared in a `packages/env/src/vars/*.ts` Zod schema is
 *      missing here, or when a generated `.env.example` is stale.
 *
 * ---------------------------------------------------------------------------
 * ADDING A NEW ENVIRONMENT VARIABLE
 * ---------------------------------------------------------------------------
 *   1. Declare it in the right `packages/env/src/vars/*.ts` object (shared =
 *      server + worker, server = server-only, web = VITE_*) — never inline in the `createEnv({…})` call one
 *      directory up, which the scan cannot see.
 *   2. Add an entry to `ENV_VARS` below, in an existing group or a new one.
 *   3. Run `pnpm env:sync` and commit the regenerated `.env.example` files.
 *
 * Skipping step 2 fails CI — that is deliberate. A variable that the generator
 * doesn't know about is a variable that silently goes missing from a
 * production deploy and surfaces as a boot crash weeks later.
 *
 * REMOVING A FEATURE MODULE: delete that module's
 * group and its vars from this file, then run `pnpm env:sync`.
 */

// ---------------------------------------------------------------------------
// Deploy targets
// ---------------------------------------------------------------------------

/**
 * Deploy targets the generator knows about. Dokploy on a VPS is the repo's
 * deployment target. The migration contract lives in docs/schema-migrations.md.
 */
export const DEPLOY_TARGETS = [
  {
    id: "vps",
    label: "VPS / Dokploy",
    doc: "AGENTS.md",
    injects: [],
    note: "You own the Postgres and Valkey instances, so you supply both connection strings.",
  },
  {
    id: "other",
    label: "Other / not sure",
    doc: "AGENTS.md",
    injects: [],
    note: "Prompting for every non-defaulted variable. Delete anything your platform injects for you.",
  },
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Which .env file a variable belongs to. */
export type EnvFile = "root" | "web";

interface EnvGroup {
  id: string;
  /** Section heading in the generated .env.example. */
  title: string;
  file?: EnvFile;
  /** Always included; never prompted for. */
  always?: boolean;
  /**
   * Yes/no question gating the whole group in `pnpm generate:secrets`.
   * Omitted for `always` groups and for `tuning` groups.
   */
  prompt?: string;
  /** Default answer to `prompt`. */
  default?: boolean;
  /**
   * Tuning-only group: every var has a schema default, so the generator emits
   * the whole group commented out and never prompts.
   */
  tuning?: boolean;
  /**
   * Force this group on (skipping its yes/no) when an earlier answer makes it
   * mandatory — e.g. SMTP is not optional once SIGNUP_ENABLED is true, because
   * the server hard-throws at boot without it. Without this, the contradiction
   * only surfaces in the final validation pass, after every prompt has been
   * answered, and the whole run has to be redone.
   */
  requiredWhen?: { key: string; equals: string; because: string };
  /**
   * Offer to reuse this group's values from the shell environment the script
   * runs in, when they are already set there. Meant for credentials you hold
   * once and point several prototype apps at (SMTP, object storage, an LLM
   * key) — not for per-app values like BETTER_AUTH_URL or DATABASE_URL, where
   * silently inheriting another app's value is a footgun.
   */
  reuseFromEnv?: boolean;
  /** Comment block emitted above the section. */
  comment?: string[];
}

export interface EnvVar {
  key: string;
  group: string;
  /**
   * - `generate`: the script produces a value with `generator`.
   * - `prompt`:   only you know it — the script asks.
   * - `confirm`:  yes/no question; emits `"true"` only when the answer is yes
   *               (schema default covers the no case).
   * - `enable`:   when this var's group is selected, emit `"true"` automatically
   *               (feature flags that must flip on with their optional block).
   * - `default`:  a documented default value covers it, so the generator never
   *               asks and omits the key (shown commented out under `--all`).
   * - `manual`:   deliberate opt-in with no useful prompt; same emission as
   *               `default`, but documented in `.env.example` (rare — prefer
   *               `prompt`).
   */
  source: "generate" | "prompt" | "confirm" | "enable" | "default" | "manual";
  generator?: "secret32" | "secret32b64" | "vapid-public" | "vapid-private";
  /**
   * The effective default, for documentation only — setting this changes
   * nothing at runtime. Usually mirrors a Zod `.default()`; see `defaultFrom`
   * for the handful that come from application code instead.
   */
  default?: string;
  /**
   * Where `default` actually comes from. `"schema"` (the assumed case) means a
   * Zod `.default()`. `"app"` means the schema field is optional and the
   * fallback lives in application code — say so explicitly, because
   * `pnpm env:check` compares key sets, not defaults, and cannot catch this
   * drifting.
   */
  defaultFrom?: "schema" | "app";
  /**
   * Fixed set of valid values. Rendered as an `Allowed: …` line in
   * `.env.example`, and offered as a pick-list instead of a free-text prompt.
   */
  choices?: Array<{ value: string; label?: string; description?: string }>;
  /**
   * Shape-check applied at the prompt, mirroring the Zod refinement that would
   * otherwise only fire in the final validation pass — so a typo costs one
   * retry instead of the whole run.
   */
  format?: "origin" | "push-subject";
  /**
   * Set `false` to keep this var OUT of its group's reuse-from-environment
   * offer, even when the group has `reuseFromEnv`. For values that identify one
   * specific app rather than a shared provider account — inheriting those
   * silently points the new app at the previous one's resources.
   */
  reusable?: boolean;
  /**
   * Let the operator skip this otherwise-required var (empty answer = omit).
   * For values a platform may supply out of band — the generator records the
   * omission in the output header instead of blocking on it.
   */
  omittable?: boolean;
  /** Required once its group is enabled. Prompts are re-asked until answered. */
  required?: boolean;
  /** Question text for `source: "prompt"` / `source: "confirm"`. */
  prompt?: string;
  /** Default answer for `source: "confirm"` (false when omitted). */
  confirmDefault?: boolean;
  /** Extra guidance printed under the prompt. */
  hint?: string;
  /** Placeholder shown in the generated .env.example. */
  example?: string;
  /**
   * Emit this var UNCOMMENTED in the generated .env.example. Reserve it for
   * vars whose `example` is a working local-dev value — a live line with a
   * non-functional placeholder is worse than a commented one, because
   * `emptyStringAsUndefined` won't save you from a wrong value.
   * `source: "generate"` vars are always emitted live but empty.
   */
  exampleSet?: boolean;
  /** True for values that must never be echoed back or logged. */
  secret?: boolean;
  file?: EnvFile;
  /**
   * Set `false` for variables read outside the Zod schemas (e.g. by a shell
   * entrypoint). Excludes the key from the schema-coverage check's expectation
   * that every manifest key is also a schema key.
   */
  inSchema?: boolean;
  /** Comment lines emitted above the var. */
  comment?: string[];
  /**
   * Render into the trailing "Advanced tuning" section of the root
   * `.env.example` instead of the var's own feature section — for one-off
   * knobs a nontechnical operator should never touch (rate-limit budgets,
   * codec settings, cache TTLs). Always commented with the default shown.
   * The manifest and `generate:secrets --all` are unaffected; only the
   * `.env.example` placement moves.
   */
  advanced?: boolean;
  /**
   * Omit from the generated `.env.example` entirely. For deep one-shot knobs
   * (restore confirmations, runtime instance identity) whose audience
   * reads the docs/ operator guides, not the example file — the full catalog stays
   * here and in the Zod schema. Only valid on `source: "default"` /
   * `"manual"` vars (never on anything prompted, generated, or enabling).
   */
  hidden?: boolean;
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

export const ENV_GROUPS: EnvGroup[] = [
  {
    id: "core",
    title: "Datastores — [shared] (server + worker)",
    always: true,
  },
  {
    id: "runtime",
    title: "Runtime + migrations — [shared]",
    always: true,
    comment: [
      "Server startup applies committed migrations by default; workers wait and register.",
      "Use MIGRATE_ON_START=false with a one-shot migrate job before rollout.",
      "See docs/schema-migrations.md for backup requirements and deletion holds.",
    ],
  },
  {
    id: "assets",
    title: "Optional S3 asset authority and bounded local cache",
    prompt: "Configure S3 asset storage?",
    default: false,
    comment: [
      "Default OFF: assets remain authoritative on disk. See docs/assets.md before enabling.",
      "Provision offline with the migration command before starting S3 runtimes.",
    ],
  },
  {
    id: "backups",
    title: "Encrypted full-bundle backups — [shared]",
    prompt: "Configure off-site database backups (S3/R2)?",
    default: true,
    comment: [
      "Encrypted Postgres + Git + file-store bundles; BACKUP_AGE_RECIPIENT is required.",
      "Local completed bundles are valid; configured S3 uploads must succeed before migrations.",
      "Dedicated backup writer and ListBucket-only monitor credentials stay separate.",
      "The server image provides backup, backup-schedule and offline restore commands.",
      "See docs/backup-restore.md. Daily scheduling is off until explicitly enabled.",
    ],
  },
  {
    id: "auth",
    title: "Auth — [server-only]",
    always: true,
  },
  {
    id: "admin",
    title: "Admin + signup — [server-only]",
    always: true,
  },
  {
    id: "smtp",
    reuseFromEnv: true,
    title: "Email (SMTP) — [shared]",
    prompt: "Configure outgoing email (SMTP)?",
    default: true,
    requiredWhen: {
      key: "SIGNUP_ENABLED",
      equals: "true",
      because:
        "public signup is enabled, and Better-Auth enforces email verification — " +
        "the server refuses to boot in production without SMTP",
    },
    comment: [
      "REQUIRED if SIGNUP_ENABLED=true — Better-Auth enforces email verification",
      "on signup, and the server refuses to boot in production without it.",
      "Local dev: `pnpm dev:services` starts a mailpit sink and `pnpm run setup`",
      "  fills these three lines automatically; read captured mail at",
      "  http://localhost:8025",
    ],
  },
  {
    id: "sso",
    title: "SSO / enterprise login — [server-only]",
    prompt: "Configure SSO (OIDC) login?",
    default: false,
    comment: [
      "Optional. FORCE_SSO=true in production requires SSO_ENABLED plus all",
      "three SSO_CLIENT_ID / SSO_CLIENT_SECRET / SSO_ISSUER values, or the",
      "server throws at boot.",
    ],
  },
  {
    id: "push",
    title: "Web Push (VAPID) — [server-only]",
    prompt: "Enable web push notifications?",
    default: false,
    comment: [
      "Optional — the app runs fine without these. Set ALL THREE or none.",
      "The keypair is generated for you by `pnpm generate:secrets`; you supply",
      "VAPID_SUBJECT, a real mailto: or https: URL push services use to reach",
      "YOU about delivery problems.",
    ],
  },
  {
    id: "translation",
    reuseFromEnv: true,
    title: "Translation provider — [shared]",
    prompt: "Enable i18n bundle translation?",
    default: false,
    comment: [
      "Used by `pnpm i18n:translate`.",
      "The app boots without these; the worker throws on the first job if the",
      "chosen provider's key is missing. Default provider is `openrouter` with",
      "`anthropic/claude-haiku-4-5` (~$0.05 for a full UI bundle).",
    ],
  },
  {
    id: "ratelimit",
    title: "Rate limiting — [server-only]",
    tuning: true,
    comment: [
      "Three named budgets (AUTH, RPC, EMAIL), two knobs",
      "each. Each budget describes its family's reference member; every other",
      "limiter in the family scales with it at its designed ratio, so setting",
      "a budget re-tunes the whole family coherently. Defaults are sensible;",
      "tighter is not safer — if a surface 429s legitimate users, split the",
      "surface instead of shrinking a budget. See AGENTS.md § Rate limiting — one bucket per surface.",
    ],
  },
  {
    id: "limits",
    title: "Cache limits — [server-only]",
    tuning: true,
    comment: ["Optional tuning. Sensible defaults are built in."],
  },
  // --- apps/web/.env ---
  {
    id: "web",
    title: "Web app (build-time, public)",
    file: "web",
    always: true,
    comment: [
      "These are BUILD-TIME client vars — they are inlined into the browser",
      "bundle and are therefore public. Never put a secret here.",
    ],
  },
];

// ---------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------

export const ENV_VARS: EnvVar[] = [
  // --- core ----------------------------------------------------------------
  {
    key: "DATABASE_URL",
    group: "core",
    source: "prompt",
    required: true,
    omittable: true,
    secret: true,
    prompt: "PostgreSQL connection string",
    hint: "e.g. postgresql://user:password@host:5432/dbname — or leave blank to omit and set it on the platform",
    example: "postgresql://postgres:password@localhost:5432/knowledge_base",
    exampleSet: true,
  },
  {
    key: "REDIS_URL",
    group: "core",
    source: "prompt",
    required: true,
    omittable: true,
    secret: true,
    prompt: "Valkey (Redis-compatible) connection string",
    hint: "e.g. redis://default:password@host:6379 (BullMQ + rate limiting) — or leave blank to omit and set it on the platform",
    comment: ["Valkey (Redis-compatible; Redis also works), used by BullMQ and rate limiting."],
    example: "redis://localhost:6379",
    exampleSet: true,
  },
  {
    key: "DATABASE_POOL_MAX",
    group: "core",
    source: "default",
    default: "10",
    advanced: true,
    comment: [
      "Max connections in this process's Postgres pool (node-postgres `max`).",
      "Default 10 matches the driver default — raise it only against the",
      "database's connection budget, since every server/worker replica holds its own pool.",
    ],
  },

  {
    key: "MIGRATE_ON_START",
    group: "runtime",
    source: "default",
    inSchema: false,
    choices: [{ value: "true" }, { value: "false" }],
    example: "true",
    comment: [
      "Server default true; worker default false. Wait mode registers an instance and waits up to 300 seconds.",
      "Use the migrate image command for a one-shot before rollout.",
    ],
  },
  {
    key: "KB_INSTANCE_ID",
    group: "runtime",
    source: "default",
    hidden: true,
    comment: ["Fresh UUID generated by the entrypoint per runtime start. Leave unset."],
  },
  {
    key: "CHECK_DATABASE_URL",
    group: "core",
    source: "manual",
    inSchema: false,
    hidden: true,
    secret: true,
    comment: ["Disposable Postgres server for migration CI scratch databases; never production."],
  },
  {
    key: "EXPECTED_DB",
    group: "core",
    source: "manual",
    inSchema: false,
    hidden: true,
    comment: ["Override the main checkout local database name; worktree names remain derived."],
  },
  {
    key: "EXPECTED_PORT",
    group: "core",
    source: "manual",
    inSchema: false,
    hidden: true,
    default: "5432",
    comment: ["Local Postgres guard port. Never widens the localhost allowlist."],
  },
  {
    key: "BACKUP_SCHEDULE",
    group: "backups",
    source: "default",
    inSchema: false,
    default: "off",
    choices: [{ value: "off" }, { value: "daily" }],
    example: "off",
    comment: ["Opt in to one verified encrypted full bundle per UTC day in the backup service."],
  },
  {
    key: "BACKUP_HOUR_UTC",
    group: "backups",
    source: "default",
    inSchema: false,
    hidden: true,
    default: "3",
    comment: ["Hour (0-23 UTC) for daily bundles."],
  },
  {
    key: "BACKUP_KEEP",
    group: "backups",
    source: "default",
    inSchema: false,
    hidden: true,
    default: "14",
    comment: [
      "Completed daily bundle pairs retained locally (1-365). Configure S3 lifecycle separately.",
    ],
  },

  // --- runtime -------------------------------------------------------------
  {
    key: "NODE_ENV",
    group: "runtime",
    source: "default",
    default: "development",
    choices: [{ value: "production" }, { value: "development" }, { value: "test" }],
    example: "production",
    comment: [
      "Set to `production` on every deployed environment. Several env guards",
      "escalate from a warning to a hard boot failure when this is `production`",
      "— that is intentional, do not weaken it to silence a startup error.",
    ],
  },
  {
    key: "BACKUP_ENABLED",
    group: "backups",
    source: "default",
    default: "true",
    choices: [{ value: "true" }, { value: "false" }],
    example: "true",
    comment: [
      "Master switch for full-bundle backups and freshness monitoring. When false, manual and",
      "scheduled runs are disabled; initialized-database migration/drop hooks refuse mutation.",
    ],
  },
  {
    key: "PORT",
    hidden: true,
    group: "runtime",
    source: "default",
    comment: [
      "[server-only] Injected by most platforms. Leave unset unless you are",
      "running the container by hand.",
    ],
  },
  {
    key: "SERVER_PORT",
    hidden: true,
    group: "runtime",
    source: "default",
    default: "3000",
    defaultFrom: "app",
    comment: [
      "[server-only] Raw local runs (`pnpm dev:raw`) and container overrides",
      "only. Leave unset for the default portless dev flow — portless injects",
      "PORT per app. The schema field is optional with no Zod default; 3000 is",
      "the fallback in apps/server/src/index.ts.",
    ],
  },

  {
    key: "KB_DATA_ROOT",
    group: "runtime",
    source: "default",
    default: "/var/lib/knowledge-base",
    comment: [
      "[shared] One local data volume: repos/ (bare Git repos), assets/ (content-addressed",
      "blobs), models/ (optional local embedding weights) and index/. Server and worker",
      "both mount it read-write. Must be a local filesystem on the same host.",
      "Local raw dev should override to a writable directory.",
    ],
  },
  {
    key: "KB_RUNTIME_UID",
    group: "runtime",
    source: "default",
    default: "1000",
    comment: [
      "[shared] Fixed nonroot UID that owns the volume directories (node:26-trixie-slim `node` user).",
    ],
  },
  {
    key: "KB_RUNTIME_GID",
    group: "runtime",
    source: "default",
    default: "1000",
    comment: ["[shared] Fixed nonroot GID that owns the volume directories."],
  },
  {
    key: "KB_MASTER_KEY",
    group: "runtime",
    source: "generate",
    generator: "secret32b64",
    required: true,
    secret: true,
    comment: [
      "[shared] REQUIRED on server and worker for at-rest encryption and cursor signing.",
      "Canonical base64 of exactly 32 bytes. Server and worker both receive it;",
      "it is never a VITE_* client variable and is not inlined into the SPA.",
    ],
  },

  // --- auth ----------------------------------------------------------------
  {
    key: "BETTER_AUTH_SECRET",
    group: "auth",
    source: "generate",
    generator: "secret32",
    required: true,
    secret: true,
    comment: [
      "REQUIRED, minimum 32 characters. The env validator rejects weak and",
      "placeholder values in production. Rotating this invalidates every",
      "existing session — generate once per environment and keep it stable.",
      "",
      "For LOCAL dev this is filled in for you by `pnpm run setup`; to mint one",
      "by hand use `pnpm generate:secret` and paste it below. For a PRODUCTION",
      "environment prefer `pnpm generate:secrets`, which generates this along",
      "with the rest of the block and validates the result.",
    ],
  },
  {
    key: "BETTER_AUTH_URL",
    format: "origin",
    group: "auth",
    source: "prompt",
    required: true,
    prompt: "Public app origin (used by auth callbacks and for SEO URLs)",
    hint: "Origin only — no path, query, hash, or credentials. e.g. https://app.example.com",
    example: "https://knowledge-base.localhost",
    exampleSet: true,
  },
  {
    key: "CORS_ORIGIN",
    format: "origin",
    group: "auth",
    source: "manual",
    example: "https://app.example.com",
    comment: [
      "Optional. Set ONLY when the browser app runs on a different origin than",
      "the API (raw web dev, split-origin deploys). Leave unset for",
      "the default same-origin flow. No path, query, or hash.",
    ],
  },
  {
    key: "TRUST_PROXY_HOPS",
    advanced: true,
    group: "auth",
    source: "default",
    default: "0",
    comment: [
      "Exact number of trusted reverse proxies in front of the app, for",
      "deriving the client IP used as the anonymous rate-limit key. 0 (default)",
      "keys on the socket peer and ignores X-Forwarded-For; behind a proxy that",
      "puts every client in one shared bucket. 1 behind a single proxy (the",
      "generated Dokploy Compose sets 1); 2 for Cloudflare -> Traefik only when",
      "Traefik trusts Cloudflare's ranges (docs/deploy.md). With N > 0 the app",
      "must be reachable only through those proxies.",
    ],
  },

  // --- admin ---------------------------------------------------------------
  {
    key: "ADMIN_EMAIL",
    group: "admin",
    source: "prompt",
    required: true,
    prompt: "Production bootstrap admin email (blank to skip)",
    hint: "One operator address. Trimmed and lowercased. Production first-user creation requires this identity even when public signup is enabled. After bootstrap completes, the address never re-promotes a demoted user. Dev/test may bootstrap the first valid account when this is unset.",
    example: "admin@example.com",
    comment: [
      "Canonical owner email for the first production admin. Matching is",
      "case-insensitive and surrounding whitespace is ignored; one address only.",
      "Required before a fresh production database can bootstrap, including when",
      "SIGNUP_ENABLED=true. After bootstrap, admins persist in the database.",
    ],
  },
  {
    key: "SIGNUP_ENABLED",
    group: "admin",
    source: "confirm",
    confirmDefault: false,
    prompt: "Enable public signup",
    hint: "Leave off for internal tools. On requires SMTP below — email verification is enforced and production refuses to boot without it.",
    default: "false",
    example: "false",
    comment: [
      "DISABLED by default: account creation is rejected and the signup form is",
      "hidden — the safe default for internal tools. Set `true` for a",
      "customer-facing app, which also REQUIRES SMTP below (email verification",
      "is enforced on signup and the server refuses to boot without it).",
    ],
  },

  // --- smtp ----------------------------------------------------------------
  {
    key: "SMTP_HOST",
    group: "smtp",
    source: "prompt",
    required: true,
    prompt: "SMTP host",
    hint: "e.g. smtp.resend.com, smtp.postmarkapp.com, email-smtp.us-east-1.amazonaws.com",
    example: "localhost",
  },
  {
    key: "SMTP_PORT",
    group: "smtp",
    source: "prompt",
    required: true,
    prompt: "SMTP port",
    hint: "587 for STARTTLS (most providers), 465 for implicit TLS, 1025 for a local mailpit sink",
    example: "1025",
  },
  {
    key: "SMTP_USER",
    group: "smtp",
    source: "prompt",
    prompt: "SMTP username (blank if your provider doesn't require auth)",
    example: "",
  },
  {
    key: "SMTP_PASS",
    group: "smtp",
    source: "prompt",
    secret: true,
    prompt: "SMTP password / API key (blank if not required)",
    example: "",
  },
  {
    key: "SMTP_FROM",
    group: "smtp",
    source: "prompt",
    required: true,
    // Excluded from the group's reuse offer: this is the app's own From:
    // identity, so inheriting it sends the new app's mail branded as the old.
    reusable: false,
    prompt: "From: address for outgoing mail",
    hint: 'One mailbox, e.g. "App Name <no-reply@yourdomain.com>". Required whenever SMTP_HOST is set.',
    example: "noreply@example.com",
  },

  // --- sso -----------------------------------------------------------------
  {
    key: "SSO_ENABLED",
    group: "sso",
    // Flipped to true automatically when the SSO group is enabled — credentials
    // alone do not turn SSO on (packages/auth gates on this flag).
    source: "enable",
    default: "false",
    example: "true",
  },
  {
    key: "SSO_CLIENT_ID",
    group: "sso",
    source: "prompt",
    required: true,
    prompt: "SSO client ID",
    example: "",
  },
  {
    key: "SSO_CLIENT_SECRET",
    group: "sso",
    source: "prompt",
    required: true,
    secret: true,
    prompt: "SSO client secret",
    example: "",
  },
  {
    key: "SSO_ISSUER",
    group: "sso",
    source: "prompt",
    required: true,
    prompt: "SSO issuer URL",
    hint: "e.g. https://your-org.okta.com",
    example: "https://your-org.okta.com",
  },
  {
    key: "SSO_PROVIDER_NAME",
    group: "sso",
    source: "prompt",
    default: "SSO",
    prompt: "SSO provider display name (shown on the login button)",
    hint: 'e.g. "Okta", "Entra ID", "Google Workspace"',
    example: "Okta",
  },
  {
    key: "FORCE_SSO",
    advanced: true,
    group: "sso",
    source: "default",
    default: "false",
    example: "false",
    comment: [
      "true disables password login entirely. In production this requires",
      "SSO_ENABLED plus all three SSO credentials or the server throws at boot.",
    ],
  },

  // --- push ----------------------------------------------------------------
  {
    key: "VAPID_PUBLIC_KEY",
    group: "push",
    source: "generate",
    generator: "vapid-public",
    required: true,
  },
  {
    key: "VAPID_PRIVATE_KEY",
    group: "push",
    source: "generate",
    generator: "vapid-private",
    required: true,
    secret: true,
  },
  {
    key: "VAPID_SUBJECT",
    format: "push-subject",
    group: "push",
    source: "prompt",
    required: true,
    prompt: "VAPID contact URI",
    hint: "A mailto: or https: URL push services use to contact YOU about delivery problems. Use a real, monitored address.",
    example: "mailto:you@yourdomain.com",
  },

  // --- backups -------------------------------------------------------------
  {
    key: "BACKUP_AGE_RECIPIENT",
    group: "backups",
    source: "prompt",
    required: true,
    reusable: false,
    prompt: "Operator age backup public recipient",
    hint: "Use pinned age v1.3.2. Recommend age-keygen -pq (age1pq1 recipient); classic age1 accepted. Keep the private identity and master/auth secrets separately; mount the KB_DATA_ROOT data volume read-only on the offline backup role.",
    example: "",
  },
  {
    key: "KB_ASSET_CACHE_MAX_BYTES",
    group: "assets",
    source: "prompt",
    required: false,
    hint: "Required S3 cache payload limit in bytes (at least 26214400).",
    example: "",
    prompt: "KB_ASSET_CACHE_MAX_BYTES",
  },
  {
    key: "KB_ASSET_S3_ENABLED",
    group: "assets",
    source: "prompt",
    required: false,
    prompt: "KB_ASSET_S3_ENABLED",
    hint: "Default false: authoritative disk CAS. Enable only after offline initialization/migration; see docs/assets.md.",
    example: "false",
  },
  {
    key: "KB_ASSET_S3_BUCKET",
    group: "assets",
    source: "prompt",
    required: false,
    prompt: "KB_ASSET_S3_BUCKET",
    hint: "Dedicated private asset namespace, separate from backup dumps. Must match the recorded locator.",
    example: "",
  },
  {
    key: "KB_ASSET_S3_ENDPOINT",
    group: "assets",
    source: "prompt",
    required: false,
    prompt: "KB_ASSET_S3_ENDPOINT",
    hint: "Optional HTTP(S) origin for S3-compatible storage, without credentials, path, query or fragment.",
    example: "",
  },
  {
    key: "KB_ASSET_S3_REGION",
    group: "assets",
    source: "prompt",
    required: false,
    prompt: "KB_ASSET_S3_REGION",
    hint: "Required when enabled. Use a real AWS region without a custom endpoint; auto requires an endpoint.",
    example: "",
  },
  {
    key: "KB_ASSET_S3_PREFIX",
    group: "assets",
    source: "prompt",
    required: false,
    prompt: "KB_ASSET_S3_PREFIX",
    hint: "Optional dedicated key prefix; outer slashes are normalized and traversal is refused.",
    example: "",
  },
  {
    key: "KB_ASSET_S3_FORCE_PATH_STYLE",
    group: "assets",
    source: "prompt",
    required: false,
    prompt: "KB_ASSET_S3_FORCE_PATH_STYLE",
    hint: "Strict true/false, default false. Include this in every role locator.",
    example: "false",
  },
  {
    key: "KB_ASSET_S3_ACCESS_KEY_ID",
    group: "assets",
    source: "prompt",
    required: false,
    secret: true,
    prompt: "KB_ASSET_S3_ACCESS_KEY_ID",
    hint: "Actual runtime writer ID. Forward this same ID unchanged to offline dump consumers for comparison only.",
    example: "",
  },
  {
    key: "KB_ASSET_S3_SECRET_ACCESS_KEY",
    group: "assets",
    source: "prompt",
    required: false,
    secret: true,
    prompt: "Runtime asset writer secret",
    hint: "Server only. Never forward to workers, backup, restore or migration roles.",
    example: "",
  },
  {
    key: "KB_ASSET_S3_OPERATOR_ACCESS_KEY_ID",
    group: "assets",
    source: "prompt",
    required: false,
    secret: true,
    prompt: "KB_ASSET_S3_OPERATOR_ACCESS_KEY_ID",
    hint: "Separate offline asset identity. Every enabled dump consumer compares its dump key against both asset IDs.",
    example: "",
  },
  {
    // Server image startup may pass this to its pre-migrate snapshot child.
    // docker-entrypoint.sh strips it before exec of the server/worker runtime.
    key: "KB_ASSET_S3_OPERATOR_SECRET_ACCESS_KEY",
    group: "assets",
    source: "prompt",
    required: false,
    secret: true,
    prompt: "KB_ASSET_S3_OPERATOR_SECRET_ACCESS_KEY",
    hint: "Offline only. Use read-only asset grants for backup/restore and List/Get/Put for migration; never give this secret to server/worker.",
    example: "",
  },
  {
    key: "BACKUP_S3_BUCKET",
    group: "backups",
    source: "prompt",
    required: true,
    reusable: false,
    prompt: "Backup bucket name",
    hint: "Private bucket for pg_dump custom-format dumps. Prefer a dedicated bucket, not the app-assets bucket.",
    example: "",
  },
  {
    key: "BACKUP_S3_ACCESS_KEY_ID",
    group: "backups",
    source: "prompt",
    required: true,
    secret: true,
    prompt: "Backup S3 access key ID",
    hint: "Required for dump writers. Must be a distinct GetObject/PutObject/AbortMultipartUpload key.",
    example: "",
  },
  {
    key: "BACKUP_S3_SECRET_ACCESS_KEY",
    group: "backups",
    source: "prompt",
    required: true,
    secret: true,
    prompt: "Backup S3 secret access key",
    example: "",
  },
  {
    key: "BACKUP_MONITOR_S3_ACCESS_KEY_ID",
    group: "backups",
    source: "prompt",
    required: true,
    secret: true,
    prompt: "Backup-monitor S3 access key ID",
    hint: "ListBucket-only key for the worker freshness check; never reuse the dump read/write key.",
    example: "",
  },
  {
    key: "BACKUP_MONITOR_S3_SECRET_ACCESS_KEY",
    group: "backups",
    source: "prompt",
    required: true,
    secret: true,
    prompt: "Backup-monitor S3 secret access key",
    example: "",
  },
  {
    key: "BACKUP_S3_REGION",
    group: "backups",
    source: "prompt",
    default: "auto",
    prompt: "Backup S3 region",
    hint: '"auto" for Cloudflare R2; a real region for AWS S3',
    example: "auto",
  },
  {
    key: "BACKUP_S3_ENDPOINT",
    group: "backups",
    source: "prompt",
    prompt: "Backup S3 endpoint URL (blank for AWS S3; required for R2/MinIO/B2/Spaces)",
    example: "",
  },
  {
    key: "BACKUP_S3_PREFIX",
    hidden: true,
    group: "backups",
    source: "default",
    default: "database",
    example: "database",
  },
  {
    key: "BACKUP_S3_FORCE_PATH_STYLE",
    hidden: true,
    group: "backups",
    source: "default",
    default: "false",
    example: "false",
  },
  {
    key: "BACKUP_S3_SSE",
    hidden: true,
    group: "backups",
    source: "default",
    inSchema: false,
    example: "",
    comment: [
      "Leave empty for R2 and most S3-compatible providers. Set to AES256 only",
      "for AWS S3 when you want SSE-S3 on backup objects.",
    ],
  },
  {
    key: "BACKUP_MAX_AGE_HOURS",
    hidden: true,
    group: "backups",
    source: "default",
    default: "36",
    example: "36",
    comment: [
      "Backup freshness check (worker, every 6h): alert admins and flag the",
      "admin dashboard when the newest dump in BACKUP_S3_BUCKET is older than",
      "this many hours. 36 tolerates one missed nightly run; two always alert.",
    ],
  },
  {
    key: "BACKUP_HEARTBEAT_URL",
    hidden: true,
    group: "backups",
    source: "default",
    inSchema: false,
    example: "",
    comment: [
      "Optional dead-man's-switch ping. After a dump uploads successfully,",
      "scripts/backup.sh sends one HTTP GET to this URL (healthchecks.io,",
      "Cronitor, Uptime Kuma push, or any self-hosted endpoint). Leave empty to",
      "skip. The service you point it at alerts when the ping stops arriving.",
    ],
  },

  // --- translation ---------------------------------------------------------
  {
    key: "PUBLIC_APP_URL",
    hidden: true,
    format: "origin",
    group: "translation",
    source: "manual",
    example: "https://app.example.com",
    comment: [
      "Optional origin metadata sent to translation providers such as",
      "OpenRouter. Not used for auth — it is declared in the shared schema, so",
      "a worker-only deploy can set it.",
    ],
  },
  {
    key: "TRANSLATION_PROVIDER",
    group: "translation",
    source: "prompt",
    default: "openrouter",
    prompt: "Translation provider",
    choices: [
      {
        value: "openrouter",
        label: "OpenRouter (default)",
        description: "Cheapest path to claude-haiku-4-5, plus multi-model access from one account",
      },
      {
        value: "anthropic",
        label: "Anthropic direct",
        description: "Calls the Anthropic API directly with ANTHROPIC_API_KEY",
      },
    ],
    example: "openrouter",
  },
  {
    key: "OPENROUTER_API_KEY",
    group: "translation",
    source: "prompt",
    secret: true,
    prompt: "OpenRouter API key (blank if using anthropic)",
    hint: "Required when TRANSLATION_PROVIDER=openrouter",
    example: "",
  },
  {
    key: "ANTHROPIC_API_KEY",
    group: "translation",
    source: "prompt",
    secret: true,
    prompt: "Anthropic API key (blank if using openrouter)",
    hint: "Required when TRANSLATION_PROVIDER=anthropic",
    example: "",
  },
  {
    key: "TRANSLATION_MODEL",
    hidden: true,
    group: "translation",
    source: "manual",
    example: "anthropic/claude-haiku-4-5",
    comment: [
      "Per-call model override. Defaults to `anthropic/claude-haiku-4-5`",
      "(OpenRouter) or `claude-haiku-4-5` (Anthropic direct) when unset.",
    ],
  },

  // --- ratelimit (tuning) --------------------------------------------------
  // Four named budgets, two knobs per family.
  // Family-scaling semantics: a budget describes its family's
  // REFERENCE member; every other member keeps its ratio to that reference,
  // so POINTS multiplies every member's points by (provided/reference) and
  // WINDOW_SECONDS multiplies every member's window AND block duration by the
  // same factor. Burst/sustained ratios, bucket keying, and fail-open vs
  // fail-closed stay fixed in code (packages/api/src/lib/rate-limit-families.ts
  // + apps/server/src/rate-limit.ts). Tighter is not safer — if one surface
  // 429s legitimate users, split the surface instead of shrinking a budget.
  {
    key: "RATE_LIMIT_AUTH_POINTS",
    group: "ratelimit",
    advanced: true,
    source: "default",
    default: "30",
    hint: "Auth family reference: requests per IP per window on the general /api/auth/* surface (password reset, verification, session ops). Setting it rescales the whole fail-closed auth family at each member's designed ratio: credential 10, credential-burst 3/10s, signup 10/h, 2FA-OTP 3/15min.",
  },
  {
    key: "RATE_LIMIT_AUTH_WINDOW_SECONDS",
    group: "ratelimit",
    advanced: true,
    source: "default",
    default: "60",
    hint: "Window (seconds) for the auth family reference. Scales every auth-family window AND block duration by the same factor.",
  },
  {
    key: "RATE_LIMIT_RPC_POINTS",
    group: "ratelimit",
    advanced: true,
    source: "default",
    default: "100",
    hint: "RPC family reference: requests per user (per IP signed out) per window on /rpc/*. /ready (60) and the SSR catch-all (300) scale with it. One batched request can carry up to ORPC_BATCH_MAX_SIZE procedures.",
  },
  {
    key: "RATE_LIMIT_RPC_WINDOW_SECONDS",
    group: "ratelimit",
    advanced: true,
    source: "default",
    default: "60",
    hint: "Window (seconds) for the RPC family reference; scales /ready and SSR with it.",
  },
  {
    key: "RATE_LIMIT_EMAIL_POINTS",
    group: "ratelimit",
    advanced: true,
    source: "default",
    default: "3",
    hint: "Email family reference: mails per RECIPIENT per window on the anonymous send-mail endpoints (verification resend, password reset). Signup (6) and sign-in-triggered mails (10) scale with it. Keyed on the mailbox, so rotating IPs cannot flood one inbox. 0 disables the whole recipient family.",
  },
  {
    key: "RATE_LIMIT_EMAIL_WINDOW_SECONDS",
    group: "ratelimit",
    advanced: true,
    source: "default",
    default: "3600",
    hint: "Window (seconds) for the email family reference; scales all three recipient buckets with it.",
  },

  // --- limits (tuning) -----------------------------------------------------
  {
    key: "SSR_CACHE_TTL_SECONDS",
    advanced: true,
    group: "limits",
    source: "default",
    default: "60",
    comment: [
      "In-memory SSR HTML cache for anonymous GETs of public routes. 0 disables",
      "it. Public content edits can take up to this long to appear live.",
    ],
  },

  // --- apps/web/.env -------------------------------------------------------
  {
    key: "VITE_APP_NAME",
    group: "web",
    file: "web",
    source: "default",
    default: "KnowledgeBase",
    // Not a Zod default: web.ts declares this `.optional()` and applies
    // DEFAULT_APP_NAME (packages/env/src/app-name.ts) through a getter.
    defaultFrom: "app",
    example: "Acme Docs",
    comment: [
      "Optional product name override: page titles, header brand, PWA manifest",
      "and the email sender name. Unset shows KnowledgeBase (KB on phones).",
    ],
  },
  {
    key: "VITE_SERVER_URL",
    group: "web",
    file: "web",
    source: "manual",
    example: "http://localhost:3000",
    comment: [
      "API origin. Defaults to window.location.origin at runtime — leave unset",
      "for the portless/Vite proxy flow. No path, query string, or hash.",
    ],
  },
  {
    key: "VITE_DEV_PORT",
    group: "web",
    file: "web",
    source: "manual",
    example: "3001",
    comment: [
      "Raw dev-server knobs. Leave unset with portless, which assigns ports and",
      "proxies /api, /rpc, /sw, /ws. Without portless, Vite listens on",
      "3001 and proxies to 3000.",
    ],
  },
  {
    key: "VITE_DEV_SERVER_URL",
    group: "web",
    file: "web",
    source: "manual",
    example: "http://localhost:3000",
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function groupsForFile(file: EnvFile): EnvGroup[] {
  return ENV_GROUPS.filter((g) => (g.file ?? "root") === file);
}

export function varsInGroup(groupId: string): EnvVar[] {
  return ENV_VARS.filter((v) => v.group === groupId);
}
