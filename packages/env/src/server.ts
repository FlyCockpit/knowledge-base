import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";
import { DEFAULT_APP_NAME } from "./app-name.js";
import { assetServerConfig } from "./asset-storage-config.js";
import { logEvent } from "./log.js";
import { env as sharedEnv } from "./shared.js";
import { configIssue, onEnvValidationError } from "./validation-error.js";
import { serverVars } from "./vars/server.js";
import { webVars } from "./vars/web.js";

// ---------------------------------------------------------------------------
// Full server environment.
//
// `extends: [sharedEnv]` merges in everything ./shared.ts already validated
// (database, redis, backups, translation) so server-side code keeps seeing a
// single `env` with every field. This module adds only the server-only
// variables and the startup guards that depend on them. The worker never
// imports this file, so a worker-only deployment is not required to set
// BETTER_AUTH_URL, BETTER_AUTH_SECRET, the rate-limit knobs, etc.
//
// The variable declarations themselves live in ./vars/server.ts — a
// side-effect-free module, so `pnpm env:check` can read the key set without
// running the startup guards below. Declare new variables there, never inline
// in the `createEnv` call.
//
// Disjointness contract: no key declared in ./vars/server.ts may also appear in
// ./vars/shared.ts — `extends` merges, it does not allow overriding.
// ---------------------------------------------------------------------------

export const env = createEnv({
  extends: [sharedEnv],
  server: serverVars,
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
  onValidationError: onEnvValidationError,
  createFinalSchema: (shape) =>
    z.object(shape).superRefine((serverValue, ctx) => {
      const value = { ...sharedEnv, ...serverValue };
      try {
        assetServerConfig({ ...sharedEnv, ...serverValue });
      } catch {
        ctx.addIssue(configIssue("KB_ASSET_S3_ENABLED", "ASSET_STORAGE_INVALID"));
      }
      // Cross-setting guards are validation, just like the individual schemas.
      // The issue carries only a closed setting/reason; no credential or prose.
      const guard = (
        setting: Parameters<typeof configIssue>[0],
        reason: Parameters<typeof configIssue>[1],
      ) => {
        if (value.NODE_ENV === "production") ctx.addIssue(configIssue(setting, reason));
        else logEvent("server.config", { setting, reason });
      };
      if (isWeakSecret(value.BETTER_AUTH_SECRET.reveal()))
        guard("BETTER_AUTH_SECRET", "WEAK_SECRET");
      if (value.SSO_CLIENT_SECRET && isWeakSecret(value.SSO_CLIENT_SECRET.reveal()))
        guard("SSO_CLIENT_SECRET", "WEAK_SECRET");
      if (value.FORCE_SSO && value.NODE_ENV === "production") {
        for (const setting of [
          "SSO_ENABLED",
          "SSO_CLIENT_ID",
          "SSO_CLIENT_SECRET",
          "SSO_ISSUER",
        ] as const) {
          if (!value[setting]) ctx.addIssue(configIssue(setting, "REQUIRED_FOR_FORCE_SSO"));
        }
      }
      const vapid = ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"] as const;
      const missing = vapid.filter((setting) => !value[setting]);
      if (missing.length > 0 && missing.length < 3) {
        for (const setting of missing) guard(setting, "VAPID_PARTIAL");
      }
      if (value.NODE_ENV === "production") {
        for (const setting of ["BETTER_AUTH_URL", "CORS_ORIGIN", "PUBLIC_APP_URL"] as const) {
          if (value[setting]?.startsWith("http:"))
            ctx.addIssue(configIssue(setting, "HTTPS_REQUIRED"));
        }
      }
      if (value.SIGNUP_ENABLED && !value.SMTP_HOST) guard("SMTP_HOST", "SIGNUP_WITHOUT_SMTP");
    }),
});

// Canonical production bootstrap identity. Zod already trimmed and lowercased.
export const ADMIN_EMAIL: string | undefined = env.ADMIN_EMAIL;

export {
  kbMasterKeyConfigured,
  validateKbMasterKeyFormat,
} from "./kb-master-key.js";

export const SSO_ENABLED: boolean = env.SSO_ENABLED;
export const FORCE_SSO: boolean = env.FORCE_SSO;
export const SIGNUP_ENABLED: boolean = env.SIGNUP_ENABLED;

// Server-side display name. VITE_APP_NAME is declared exactly once — in
// ./vars/web.ts (the one-surface rule in scripts/lib/env-schema.ts forbids
// re-declaring it here) — but the server needs it too (seo.ts renders it into
// /llms.txt, and the Docker image carries it as a runtime ENV). resolveAppName
// validates the raw runtime value against that same canonical schema instead
// of reading process.env inline, so an overlong/mistyped value fails fast at
// boot like every other env var instead of shipping into public SEO files.
export function resolveAppName(raw: string | undefined = process.env.VITE_APP_NAME): string {
  const result = webVars.VITE_APP_NAME.safeParse(raw || undefined);
  if (!result.success) {
    onEnvValidationError(
      result.error.issues.map((issue) => ({ ...issue, path: ["VITE_APP_NAME", ...issue.path] })),
    );
  }
  return result.data ?? DEFAULT_APP_NAME;
}

/** Entropy policy shared by both live authentication secrets. */
function isWeakSecret(secret: string): boolean {
  return (
    new Set(secret).size < 10 ||
    /^(..)\1+$/.test(secret) ||
    ["changeme", "secret", "password", "your-secret-here", "replace-me", "placeholder"].some(
      (word) => secret.toLowerCase().includes(word),
    )
  );
}

// A provisioned instance may omit the bootstrap identity; keep these warnings.
if (!ADMIN_EMAIL && env.NODE_ENV === "production") {
  logEvent("server.config", { setting: "ADMIN_EMAIL", reason: "ADMIN_EMAIL_UNSET" });
} else if (!ADMIN_EMAIL && !SIGNUP_ENABLED) {
  logEvent("server.config", { setting: "ADMIN_EMAIL", reason: "NO_BOOTSTRAP_ADMIN" });
}
