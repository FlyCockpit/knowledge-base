/** The fixed operational record format: sites, fields and validation. Pure (no
 * I/O), so the output supervisors (which validate and publish records) and
 * protocol-only processes (which only classify errors) import it instead of
 * `./log.js`. */

export type LogLevel = "error" | "warn" | "info";

/** Each site has a fixed level and message. */
export const LOG_SITES = {
  // R3-W3: the request paths that answered only with a generic code.
  "mcp.tool": ["error", "MCP tool call failed with an internal error"],
  "mcp.endpoint": ["error", "MCP endpoint failed before answering"],
  "mcp.oauth": ["error", "signing-key service unavailable"],
  "git-http": ["error", "Git smart-HTTP request failed with a server error"],
  "git-http.refused": ["info", "Git push refused"],
  "git-http.audit-unavailable": ["warn", "rejected push audit unavailable"],
  "pr-mergeability": ["error", "pull request mergeability refresh failed"],
  // HTTP.
  "http.request": ["info", "request"],
  "http.unhandled": ["error", "unhandled error in an HTTP route"],
  orpc: ["error", "oRPC procedure failed with a server error"],
  "orpc.transient": ["warn", "oRPC procedure failed with a transient upstream error"],
  "service.start": ["info", "service process starting"],
  "service.exit": ["info", "service process exited"],
  "service.spawn-failed": ["error", "service process could not start"],
  "service.output": ["info", "service output streams drained"],
  "service.records-rejected": ["warn", "invalid service log records discarded"],
  // The native fence supervisor (apps/server/native/kb-supervisor.c) writes
  // these exact records; kb-process.test.ts keeps the two tables identical.
  "supervisor.fatal": ["error", "native supervisor could not start"],
  "supervisor.shutdown": ["info", "native supervisor shutdown started"],
  "supervisor.admission-closed": ["info", "native supervisor closed operation admission"],
  "supervisor.op-spawned": ["info", "fenced operation spawned"],
  "supervisor.op-reaped": ["info", "fenced operation group reaped"],
  "supervisor.op-rejected": ["warn", "fenced operation request rejected"],
  "supervisor.op-drain": ["warn", "fenced operation drain started"],
  "supervisor.op-kill": ["error", "fenced operation killed after drain timeout"],
  // Server lifecycle.
  "server.listening": ["info", "server listening"],
  "server.non-production": [
    "warn",
    "NON-PRODUCTION MODE: cookies not Secure, /api-reference public, weak secrets warn-only, http:// URLs allowed; never expose this process publicly",
  ],
  "server.git": ["info", "git capability probe passed"],
  "server.dependency-ready": ["info", "dependency reachable"],
  "server.dependency-retry": ["warn", "dependency not ready; retrying"],
  "server.shutdown-start": ["info", "graceful shutdown started"],
  "server.startup": ["error", "server startup failed"],
  "worker.startup": ["error", "worker startup failed"],
  "git.unsupported": ["error", "git >= 2.45 is required; use the trixie-based images"],
  "server.shutdown": ["error", "server shutdown failed"],
  "server.control-socket": ["error", "process fence control socket failed"],
  "server.unhandled-rejection": ["error", "server unhandled promise rejection"],
  "server.uncaught-exception": ["error", "server uncaught exception"],
  "server.config": ["warn", "server configuration warning"],
  "server.config-invalid": ["error", "invalid environment variable"],
  "session.lookup": ["warn", "session lookup failed; request treated as anonymous"],
  "locale-preload": ["warn", "locale modulepreload manifest unavailable"],
  "locale-preload.ready": ["info", "locale modulepreload manifest loaded"],
  "instance.unregistered": [
    "warn",
    "instance has no schema level; scheduled deletions wait while it runs",
  ],
  "instance.registry-missing": [
    "warn",
    "scheduled-deletion registry missing; instance not tracked until migration runner creates it",
  ],
  "instance.heartbeat": ["error", "instance heartbeat failed"],
  // Libraries.
  "auth.library": ["warn", "authentication library reported a problem"],
  "auth.library.error": ["error", "authentication library reported an error"],
  "redis.connection": ["warn", "Redis connection error"],
  "child.output": ["warn", "child output discarded"],
  "child.closed": ["info", "child output streams closed"],
  "qwen.library": ["error", "native model library reported an error"],
  // Server features.
  "admin.remove-user": ["error", "account removal failed"],
  "client-ip.proxy-hops": [
    "warn",
    "X-Forwarded-For from a private peer ignored because TRUST_PROXY_HOPS is 0; behind a reverse proxy every client shares one rate-limit bucket",
  ],
  "rate-limit.store": ["error", "rate limiter store failed"],
  "rate-limit.refund": ["error", "rate limiter refund failed"],
  "rate-limit.procedure-budget": ["error", "procedure budget limiter unavailable; failing closed"],
  "rate-limit.procedure-budget.open": [
    "warn",
    "procedure budget limiter unavailable; failing open",
  ],
  "kb.staging-cleanup": ["error", "query data janitor failed"],
  "kb.recovery-sweep": ["error", "journal recovery sweep failed"],
  "kb.index-build": ["error", "index build failed"],
  "kb.index-missing": ["error", "integrity: index file missing for a complete generation"],
  "kb.index-reader": ["warn", "index reader thread lost; replacing it"],
  "kb.search": ["error", "search read failed"],
  "kb.export-reclaim": ["error", "export reclamation failed"],
  "kb.retention": ["warn", "index directory entry skipped by retention"],
  "kb.retention-row": ["error", "retention row rolled back; it is selected again on the next run"],
  "kb.retention-cleanup": [
    "error",
    "retention row committed; its file cleanup failed and the index file reconciler removes the files",
  ],
  "kb.dispatch-recovery": ["error", "expired job lease recovery failed; the job stays running"],
  "push.delivery": ["warn", "web push delivery failed"],
  "users.invite": ["error", "invited account creation failed"],
  "users.invite-email": ["warn", "invite email failed"],
  "users.remove": ["error", "account removal failed"],
  "backup.config": ["warn", "backup configuration warning"],
  // Worker.
  "worker.started": ["info", "worker consumers started"],
  "worker.git": ["info", "git capability probe passed"],
  "worker.shutdown-start": ["info", "worker shutdown started"],
  "worker.drain": ["error", "worker drain was unclean"],
  "worker.unhandled-rejection": ["error", "worker unhandled promise rejection"],
  "worker.uncaught-exception": ["error", "worker uncaught exception"],
  "worker.consumer": ["error", "queue consumer stopped unexpectedly"],
  "worker.consumer-connection": ["error", "queue consumer connection error"],
  "worker.health": ["error", "worker health listener failed"],
  "worker.job": ["error", "queue job failed"],
  "worker.job-completed": ["info", "queue job completed"],
  "worker.scheduler": ["error", "queue job scheduler registration failed"],
  "worker.scheduler-registered": ["info", "queue job scheduler registered"],
  "worker.dispatcher": ["error", "durable job dispatcher cycle failed"],
  "worker.alert-cooldown": ["warn", "operational alert skipped: cooldown reservation failed"],
  "worker.alert-send": ["error", "operational alert could not be sent"],
  "worker.backup-freshness": ["info", "backup freshness checked"],
  "worker.reap-auth-tokens": ["info", "expired auth tokens reaped"],
  "worker.kb-git-rollup": ["info", "KB Git rollup pass"],
  "worker.kb-retention": ["info", "knowledge-base retention pass finished"],
  "worker.data-deletion": ["warn", "scheduled data deletion completed; notifying admins"],
  "worker.data-deletion-send": [
    "error",
    "data deletion alert not delivered; retrying on the next run",
  ],
  "worker.data-deletion-record": [
    "error",
    "data deletion alert sent but not recorded; it may be sent again",
  ],
  "worker.data-deletions": ["info", "data deletion notices handled"],
  "worker.seed": ["info", "database seed job"],
  "qwen.memory-report": ["error", "built-in model memory budget report failed"],
  "qwen.reembed": ["error", "built-in model re-embed tick failed"],
  "qwen.config-probe": ["error", "built-in model config probe tick failed"],
} as const satisfies Record<string, readonly [LogLevel, string]>;
export type LogSite = keyof typeof LOG_SITES;

/** Every field a record may carry. Values are validated before printing. */
const FIELD_KEYS = [
  "requestId",
  "opId",
  "kbId",
  "generationId",
  "userId",
  "tool",
  "service",
  "code",
  "pr",
  "failures",
  "method",
  "route",
  "status",
  "durationMs",
  "mode",
  "stage",
  "reason",
  "queue",
  "jobId",
  "limiter",
  "dependency",
  "attempt",
  "delayMs",
  "signal",
  "port",
  "gitVersion",
  "setting",
  "connection",
  "count",
  "host",
  "steps",
  "exitCode",
  "deleted",
  "state",
  "resultCode",
  "bytes",
  "stream",
  "sweep",
  "rowId",
  "kind",
] as const;
export type LogFieldKey = (typeof FIELD_KEYS)[number];
// Startup diagnostics are constants, never exception text or a caller's URL.
export type StartupStage =
  | "import"
  | "config"
  | "git"
  | "maintenance"
  | "process-fence"
  | "data-root"
  | "push-spools"
  | "postgres"
  | "redis"
  | "journal-recovery"
  | "staging-cleanup"
  | "write-coordinator"
  | "index-reader"
  | "kb-runtime"
  | "exports"
  | "listen"
  | "model-runtime"
  | "consumers"
  | "mirror-storage"
  | "mirror-recovery"
  | "schedulers"
  | "consumer-ready"
  | "heartbeat"
  | "dispatcher";
export type LogFields = {
  [K in Exclude<LogFieldKey, "stage">]?: string | number | null | undefined;
} & {
  stage?:
    | StartupStage
    | "http-close"
    | "start"
    | "finished"
    | "minute"
    | "hourly"
    | "router"
    | "force"
    | "structured-read"
    | "hybrid-connect"
    | "hybrid-read"
    | "recovered"
    | "backoff"
    | "idle"
    | "completed"
    | "deferred"
    | "pass";
};

/** An error that carries its own typed, enumerated log detail. */
export interface LogDetail {
  logDetail(): Record<string, string | number>;
}

/** Identifier-like text only (our own ids and enumerated names): no `/`, `@`, `=`, `?`, `%`. */
const SAFE_TEXT = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
/** Error codes are constants (ENOENT, STORAGE_UNAVAILABLE, ERR_JWKS_TIMEOUT, SQLSTATE 57014). */
const CODE_TEXT = /^[A-Z0-9][A-Z0-9_]{0,63}$/;
/** Class names are PascalCase identifiers. */
const CLASS_TEXT = /^[A-Z][A-Za-z0-9_]{0,63}$/;
/** A dotted version (git 2.39.5). */
const VERSION_TEXT = /^\d{1,4}(?:\.\d{1,6}){1,3}$/;
const DETAIL_KEYS = [
  "hookErrorClass",
  "hookErrorCode",
  "gitVersion",
  "minGitVersion",
  "setting",
  "reason",
] as const;
/** A route TEMPLATE as registered (`/git/:kbId{[a-z0-9]+}/*`): no `%`, `=`, `&` or `?`-query. */
const ROUTE_TEXT = /^(?:\*|\/[A-Za-z0-9_.:/*{}[\]|+()^$\\-]{0,199}|unmatched)$/;

function safeText(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_TEXT.test(value) ? value : undefined;
}
function safeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
type Accept = (value: unknown) => string | number | undefined;
const text =
  (pattern: RegExp): Accept =>
  (value) =>
    typeof value === "string" && pattern.test(value) ? value : undefined;
const code: Accept = (value) =>
  text(CODE_TEXT)(value) ??
  (typeof value === "number" && Number.isSafeInteger(value) ? value : undefined);
const field: Accept = (value) => safeText(value) ?? safeNumber(value);

/** The one predicate per record key. logRecord stores a value only when its
 * key's predicate accepts it, and validateLogRecord checks the same predicate,
 * so every produced record is valid by construction. */
const ACCEPTS: Readonly<Record<string, Accept>> = {
  ...Object.fromEntries(FIELD_KEYS.map((key) => [key, field])),
  route: text(ROUTE_TEXT),
  errorClass: text(CLASS_TEXT),
  hookErrorClass: text(CLASS_TEXT),
  errorCode: code,
  hookErrorCode: code,
  minGitVersion: text(VERSION_TEXT),
};
/** Typed detail carries names, codes or versions (never ids or text), and
 * must also satisfy its key's own predicate. */
const detailValue = (key: string, value: unknown) => {
  const shaped =
    typeof value === "number"
      ? Number.isSafeInteger(value)
      : typeof value === "string" &&
        (CLASS_TEXT.test(value) || CODE_TEXT.test(value) || VERSION_TEXT.test(value));
  return shaped ? ACCEPTS[key]?.(value) : undefined;
};

/** A thrown primitive or null is named by a closed set of class names. */
const PRIMITIVE_CLASS: Readonly<Record<string, string>> = {
  string: "String",
  number: "Number",
  bigint: "BigInt",
  boolean: "Boolean",
  symbol: "Symbol",
  undefined: "Undefined",
  function: "Function",
};

/** The class name of a thrown value, from its constructor (never its message). */
export function errorClassOf(error: unknown): string {
  if (error === null) return "Null";
  if (typeof error !== "object") return PRIMITIVE_CLASS[typeof error] ?? "Unknown";
  try {
    const name = (error as { constructor?: { name?: unknown } }).constructor?.name;
    return typeof name === "string" && CLASS_TEXT.test(name) ? name : "Unknown";
  } catch {
    return "Unknown";
  }
}

/** A stable code: a constant-like string code or an integer exit status. */
export function errorCodeOf(error: unknown): string | number | undefined {
  if (error === null || typeof error !== "object") return undefined;
  for (const key of ["code", "status"] as const) {
    let value: unknown;
    try {
      value = (error as Record<string, unknown>)[key];
    } catch {
      continue;
    }
    if (typeof value === "string" && CODE_TEXT.test(value)) return value;
    if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  }
  return undefined;
}

export type LogRecord = Record<string, string | number>;

/** The record for one event; exported for tests. */
export function logRecord(site: LogSite, fields: LogFields = {}, error?: unknown): LogRecord {
  const [level, message] = LOG_SITES[site];
  const record: LogRecord = { level, site, message };
  const put = (key: string, value: string | number | undefined) => {
    if (value !== undefined && !(key in record)) record[key] = value;
  };
  if (error !== undefined) {
    put("errorClass", ACCEPTS.errorClass!(errorClassOf(error)));
    put("errorCode", ACCEPTS.errorCode!(errorCodeOf(error)));
  }
  for (const key of FIELD_KEYS) put(key, ACCEPTS[key]!(fields[key]));
  try {
    const detail = (error as Partial<LogDetail> | null)?.logDetail;
    if (typeof detail === "function")
      for (const [key, value] of Object.entries(detail.call(error)))
        if ((DETAIL_KEYS as readonly string[]).includes(key)) put(key, detailValue(key, value));
  } catch {
    // Detail is optional; the fixed record still stands.
  }
  return record;
}

/** Validate the entire wire record, including its closed keys and fixed message.
 * Never print a child-provided serialization, even when it looks like JSON. */
export function validateLogRecord(value: unknown): LogRecord | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return;
  const input = value as Record<string, unknown>;
  if (typeof input.site !== "string" || !Object.hasOwn(LOG_SITES, input.site)) return;
  const site = input.site as LogSite;
  const [level, message] = LOG_SITES[site];
  if (input.level !== level || input.message !== message) return;
  const result: LogRecord = { level, site, message };
  for (const [key, value] of Object.entries(input)) {
    if (key === "site" || key === "level" || key === "message") continue;
    const safe = Object.hasOwn(ACCEPTS, key) ? ACCEPTS[key]!(value) : undefined;
    if (safe === undefined) return;
    result[key] = safe;
  }
  return result;
}
