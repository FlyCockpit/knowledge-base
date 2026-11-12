import { logEvent } from "./log.js";
import { serverVars } from "./vars/server.js";
import { sharedVars } from "./vars/shared.js";
import { webVars } from "./vars/web.js";

type ConfigSetting = keyof typeof serverVars | keyof typeof sharedVars | keyof typeof webVars;
const settings = new Set<string>([
  ...Object.keys(serverVars),
  ...Object.keys(sharedVars),
  ...Object.keys(webVars),
]);
const CONFIG_REASONS = [
  "ASSET_STORAGE_INVALID",
  "WEAK_SECRET",
  "REQUIRED_FOR_FORCE_SSO",
  "VAPID_PARTIAL",
  "SMTP_FROM_MISSING",
  "HTTPS_REQUIRED",
  "SIGNUP_WITHOUT_SMTP",
] as const;
type ConfigReason = (typeof CONFIG_REASONS)[number];
const SCHEMA_REASONS = {
  invalid_type: "INVALID_TYPE",
  invalid_value: "INVALID_VALUE",
  invalid_format: "INVALID_FORMAT",
  too_small: "TOO_SMALL",
  too_big: "TOO_BIG",
  custom: "CUSTOM",
  unrecognized_keys: "UNRECOGNIZED_KEYS",
  invalid_union: "INVALID_UNION",
  invalid_key: "INVALID_KEY",
  invalid_element: "INVALID_ELEMENT",
  not_multiple_of: "NOT_MULTIPLE_OF",
} as const;
type ConfigDiagnostic = {
  setting: ConfigSetting | "UNKNOWN";
  reason: ConfigReason | (typeof SCHEMA_REASONS)[keyof typeof SCHEMA_REASONS] | "INVALID";
};
/** A production guard is a normal schema issue with closed detail. */
export function configIssue(setting: ConfigSetting, reason: ConfigReason) {
  return { code: "custom" as const, path: [setting], message: reason };
}

/** Thrown when env validation fails: fixed text, never a value. */
class EnvValidationError extends Error {
  override name = "EnvValidationError";
  readonly code = "INVALID_ENV";
  constructor(readonly issues: readonly ConfigDiagnostic[]) {
    super("Invalid environment variables");
  }
  logDetail() {
    return this.issues[0] ?? {};
  }
}

/** A Standard Schema issue (zod adds a `code` at runtime). */
type Issue = {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined;
};

/**
 * `createEnv` onValidationError: one fixed `server.config-invalid` record per
 * invalid setting (its name and the zod issue code — never the value or the
 * zod message, which can quote input), then a typed error.
 */
export function onEnvValidationError(issues: readonly Issue[]): never {
  const details: ConfigDiagnostic[] = [];
  for (const issue of issues) {
    const first = issue.path?.[0];
    const key = typeof first === "object" && first !== null ? first.key : first;
    const code = (issue as { code?: unknown }).code;
    const setting: ConfigDiagnostic["setting"] =
      typeof key === "string" && settings.has(key) ? (key as ConfigSetting) : "UNKNOWN";
    const reason: ConfigDiagnostic["reason"] =
      (code === "custom" ? CONFIG_REASONS.find((reason) => reason === issue.message) : undefined) ??
      (typeof code === "string" && Object.hasOwn(SCHEMA_REASONS, code)
        ? SCHEMA_REASONS[code as keyof typeof SCHEMA_REASONS]
        : "INVALID");
    const detail = { setting, reason };
    details.push(detail);
    logEvent("server.config-invalid", detail);
  }
  throw new EnvValidationError(details);
}
