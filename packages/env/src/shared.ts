import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";
import { assetRuntimeConfig } from "./asset-storage-config.js";
import { backupCommonConfigWarnings, backupWarningCode } from "./backup-config.js";
import { logEvent } from "./log.js";
import { configIssue, onEnvValidationError } from "./validation-error.js";
import { sharedVars } from "./vars/shared.js";

// ---------------------------------------------------------------------------
// Worker-safe environment — validation only.
//
// This module validates ONLY the variables that the BullMQ worker (and the
// packages it shares with the server: @knowledge-base/db, @knowledge-base/queue,
// @knowledge-base/api/lib/backup-freshness, @knowledge-base/i18n-translate,
// @knowledge-base/mailer) actually read. It is the import target for every
// worker-reachable module.
//
// The server's full surface lives in ./server.ts, which `extends` this module
// and adds the server-only variables (Better-Auth, CORS, SSO, VAPID,
// rate limits, admin emails, …). Importing `@knowledge-base/env/server`
// from worker-graph code would force the worker to set BETTER_AUTH_URL,
// BETTER_AUTH_SECRET, etc. — variables the worker never uses. SMTP is included
// here because the worker can send operational-alert emails without needing
// Better-Auth URL/secret validation.
//
// The strict-boolean helper lives in ./vars/shared.ts.
//
// Do NOT load `.env` here. This file is imported by auth/db and by the web SSR
// graph; a dotenv side effect left `dotenv` as a Vite SSR runtime external and
// broke production containers. Process entrypoints load the root `.env` first,
// via `@knowledge-base/env/load-dotenv` or `loadRootDotenv()` — see that file for the
// full rule, and `pnpm env:check-entrypoints` for the gate that enforces it.
//
// The variable declarations themselves live in ./vars/shared.ts — a
// side-effect-free module, so `pnpm env:check` can read the key set without
// triggering validation. Declare new variables there, never inline in the
// `createEnv` call.
// ---------------------------------------------------------------------------

export {
  type BackupConfig,
  backupCommonConfigWarnings,
  backupMonitorConfigWarnings,
} from "./backup-config.js";

export const env = createEnv({
  server: sharedVars,
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
  onValidationError: onEnvValidationError,
  createFinalSchema: (shape) =>
    z.object(shape).superRefine((value, ctx) => {
      try {
        assetRuntimeConfig(value);
      } catch {
        ctx.addIssue(configIssue("KB_ASSET_S3_ENABLED", "ASSET_STORAGE_INVALID"));
      }
      if (value.SMTP_HOST && !value.SMTP_FROM) {
        if (value.NODE_ENV === "production")
          ctx.addIssue(configIssue("SMTP_FROM", "SMTP_FROM_MISSING"));
        else logEvent("server.config", { setting: "SMTP_FROM", reason: "SMTP_FROM_MISSING" });
      }
      // These are shared backup-location warnings only. Writer and freshness
      // credentials intentionally have different grants, so their validators
      // run at their respective consumers rather than making a monitor-only
      // worker look misconfigured for lacking the dump key.
      for (const warning of backupCommonConfigWarnings(value)) {
        logEvent("backup.config", { reason: backupWarningCode(warning) });
      }
    }),
});
