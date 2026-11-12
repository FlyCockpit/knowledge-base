import { z } from "zod";
import { validateKbMasterKeyFormat } from "../kb-master-key.js";
import { smtpFromSchema } from "../mailbox.js";
import { toSecret } from "../secret.js";
import { httpUrl, originUrl } from "../url.js";

// ---------------------------------------------------------------------------
// Worker-safe variable DECLARATIONS.
//
// Split out of ../shared.ts so that tooling can read the key set without
// importing that module — which runs validation that throws when the variables
// are unset (exactly the situation in CI). Nothing in this directory may have
// import side effects. Dotenv loading lives in ../load-dotenv.ts / ../root-env.ts
// and is imported only from process entrypoints.
//
// `pnpm env:check` (scripts/lib/env-schema.ts) enumerates every module in this
// directory and takes `Object.keys()` of each exported declaration object, so a
// new variable is visible to the manifest check the moment it is added here.
// Declaring one inline in ../shared.ts instead would hide it — the check fails
// on that too.
// ---------------------------------------------------------------------------

export const strictBooleanFlag = (defaultValue: boolean = false) =>
  z
    .enum(["true", "false"])
    .default(defaultValue ? "true" : "false")
    .transform((value) => value === "true");

export const sharedVars = {
  // Connection syntax belongs to each driver (including hostless and socket
  // forms). The process output boundary contains constructor diagnostics.
  DATABASE_URL: z.string().min(1).transform(toSecret),
  REDIS_URL: z.string().min(1).transform(toSecret),
  // Max connections in this process's Postgres pool (node-postgres `max`).
  // Default 10 matches the driver default — raise it only against the
  // database's connection budget, since every server/worker replica holds its
  // own pool.
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  // ---- Encrypted full-bundle backups (optional). The shell scripts under
  // scripts/ (backup.sh, backup/schedule.mjs) read these directly; the worker reads
  // them here to run the backup FRESHNESS check — a scheduled job that lists
  // the backup bucket and alerts admins when the newest bundle is older than
  // BACKUP_MAX_AGE_HOURS. A dead backup schedule produces no error of its own, so
  // "the newest bundle is too old" is the only signal that covers both "ran and
  // failed" and "never ran". The check runs whenever BACKUP_ENABLED is true —
  // including before a bucket exists (`setup-missing`) — and is omitted only on
  // an explicitly disabled freshness monitor (BACKUP_ENABLED=false).
  // BACKUP_S3_* must be a dedicated backup-bucket key with bundle-only grants.
  // Asset location and cache configuration shared by both runtime roles.
  KB_ASSET_S3_ENABLED: strictBooleanFlag(),
  KB_ASSET_CACHE_MAX_BYTES: z.string().optional(),
  KB_ASSET_S3_BUCKET: z.string().optional(),
  KB_ASSET_S3_ENDPOINT: z.string().optional(),
  KB_ASSET_S3_REGION: z.string().optional(),
  KB_ASSET_S3_PREFIX: z.string().optional(),
  KB_ASSET_S3_FORCE_PATH_STYLE: z.string().optional(),
  KB_ASSET_S3_ACCESS_KEY_ID: z.string().optional().transform(toSecret),
  KB_ASSET_S3_OPERATOR_ACCESS_KEY_ID: z.string().optional().transform(toSecret),
  KB_ASSET_S3_OPERATOR_SECRET_ACCESS_KEY: z.string().optional().transform(toSecret),
  BACKUP_ENABLED: strictBooleanFlag(true),
  BACKUP_AGE_RECIPIENT: z.string().optional(),
  BACKUP_S3_BUCKET: z.string().optional(),
  BACKUP_S3_ACCESS_KEY_ID: z.string().optional().transform(toSecret),
  BACKUP_S3_SECRET_ACCESS_KEY: z.string().optional().transform(toSecret),
  // The worker only lists objects for freshness; it never reads or writes a
  // bundle. Keep that ListBucket-only identity separate from the dump key.
  BACKUP_MONITOR_S3_ACCESS_KEY_ID: z.string().optional().transform(toSecret),
  BACKUP_MONITOR_S3_SECRET_ACCESS_KEY: z.string().optional().transform(toSecret),
  BACKUP_S3_REGION: z.string().default("auto"),
  BACKUP_S3_ENDPOINT: httpUrl("BACKUP_S3_ENDPOINT").optional(),
  BACKUP_S3_PREFIX: z.string().default("database"),
  BACKUP_S3_FORCE_PATH_STYLE: strictBooleanFlag(),
  // Newest dump older than this = stale. 36h tolerates one missed nightly
  // run plus clock skew without paging anyone; two misses always alert.
  BACKUP_MAX_AGE_HOURS: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 30)
    .default(36),
  // Entrypoint-generated UUID shared with migration admission and runtime heartbeat.
  KB_INSTANCE_ID: z.uuid().optional(),
  // ---- Translation provider (optional). Used by `pnpm i18n:translate` to
  // fill non-default locale bundles. The validator keeps both API keys optional so the rest of the
  // app boots without them; the provider factory throws at first use if the
  // key for the chosen provider is missing.
  //
  // Default provider is `openrouter` because it's the cheapest path to
  // claude-haiku-4-5 + gives a single account multi-model access for A/B
  // experiments. Set TRANSLATION_PROVIDER=anthropic to call the Anthropic
  // API directly with ANTHROPIC_API_KEY.
  OPENROUTER_API_KEY: z.string().min(1).optional().transform(toSecret),
  ANTHROPIC_API_KEY: z.string().min(1).optional().transform(toSecret),
  TRANSLATION_PROVIDER: z.enum(["openrouter", "anthropic"]).default("openrouter"),
  // Optional public origin metadata for translation providers such as
  // OpenRouter. This is not used for auth and is safe for worker-only env.
  PUBLIC_APP_URL: originUrl("PUBLIC_APP_URL").optional(),
  // ---- Email transport (optional). Shared because both the server and the
  // worker use @knowledge-base/mailer. Keeping SMTP here lets worker-only deploys
  // opt into failure-alert emails without setting Better-Auth server vars.
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional().transform(toSecret),
  SMTP_FROM: smtpFromSchema.optional(),
  // Per-call model override. Falls through to the provider's default
  // (`anthropic/claude-haiku-4-5` for OpenRouter, `claude-haiku-4-5` for
  // direct Anthropic) when unset.
  TRANSLATION_MODEL: z.string().min(1).optional(),
  // ---- Knowledge-base data volume. One root holds repos/, assets/, models/
  // and index/ (layout in packages/env/src/topology.ts). It is local to one
  // host; a network filesystem or multi-host layout fails startup.
  KB_DATA_ROOT: z.string().min(1).default("/var/lib/knowledge-base"),
  KB_RUNTIME_UID: z.coerce.number().int().min(1).max(65534).default(1000),
  KB_RUNTIME_GID: z.coerce.number().int().min(1).max(65534).default(1000),
  // At-rest encryption for deploy keys, provider secrets, share emails, and
  // transient query payloads. Shared by server and worker; never a VITE_* client
  // var. Packaged server/worker startup requires it. When set it must be canonical base64 of exactly 32 bytes — validated
  // through the same helper the encryption path uses, so runtime env never
  // accepts a key (permissive base64, whitespace, wrong length) that
  // encryption would later reject. kb-master-key.ts is side-effect free.
  KB_MASTER_KEY: z
    .string()
    .min(1)
    .optional()
    .superRefine((value, ctx) => {
      if (value === undefined) return;
      const validation = validateKbMasterKeyFormat(value);
      if (!validation.ok) {
        ctx.addIssue({ code: "custom", message: validation.reason });
      }
    })
    .transform(toSecret),
};
