/** Fixed operational records: a closed site, its fixed level and message,
 * and typed identifier-like fields (./log-record.ts). They carry no free text
 * and no secret by construction, so any descriptor may receive them.
 *
 * Where records go is a property of the process (its realm):
 *   - by default, stderr. Every host works without setup: an operator CLI,
 *     `vite dev`, a test's child process, a script. Loading this module and
 *     logging never throw.
 *   - a supervised service connects the output supervisor's record channel
 *     (connectServiceLog, KB_LOG_FD) at startup, because the supervisor counts
 *     and drops its stderr. That bootstrap is the only place a channel is
 *     required, and it refuses to start without one.
 * Protocol-only processes (the pre-receive hook, the mirror helper, the model
 * child, the index reader thread) never load this module; their build fails
 * if a bundle entry's chunks contain it (scripts/lib/protocol-only-bundle.mjs). */
import { ConnectionConfigError } from "./connection-config.js";
import {
  errorCodeOf,
  type LogFields,
  type LogLevel,
  type LogRecord,
  type LogSite,
  logRecord,
  type StartupStage,
} from "./log-record.js";

export * from "./log-record.js";

export type LogSink = (line: string, level: LogLevel) => void;

/** Thrown when a service names no record channel, or one that is not an open
 * pipe or socket. */
class LogChannelUnavailableError extends Error {
  readonly code = "LOG_CHANNEL_UNAVAILABLE";
  constructor() {
    super("This process has no log record channel");
  }
}

function descriptorSink(fd: number): LogSink {
  const { writeSync } = process.getBuiltinModule("node:fs");
  return (line) => {
    try {
      writeSync(fd, `${line}\n`);
    } catch {
      // A closed descriptor (shutdown, a gone terminal) must not turn logging into a crash.
    }
  };
}

/** The sink belongs to the process (its realm), not to one copy of this
 * module: bundled chunks, a re-evaluated module and Vite's SSR module runner
 * share it. A worker thread is its own realm and starts on stderr. */
const SINK = Symbol.for("knowledge-base.log-sink");
type Channel = { sink: LogSink };
const channel: Channel =
  (Reflect.get(globalThis, SINK) as Channel | undefined) ??
  (() => {
    const created: Channel = { sink: descriptorSink(2) };
    Reflect.set(globalThis, SINK, created);
    return created;
  })();

/** Called once by the real service bootstrap, before its application graph
 * loads: the output supervisor's record channel, named by KB_LOG_FD. A
 * descriptor is never assumed (fd 3 may be something else, such as the volume
 * fence), so a service started outside the output supervisor refuses to start. */
export function connectServiceLog(): void {
  const { fstatSync } = process.getBuiltinModule("node:fs");
  const fd = Number(process.env.KB_LOG_FD);
  let named = false;
  try {
    const stat = Number.isSafeInteger(fd) && fd >= 3 ? fstatSync(fd) : undefined;
    named = Boolean(stat && (stat.isFIFO() || stat.isSocket()));
  } catch {}
  if (!named) throw new LogChannelUnavailableError();
  channel.sink = descriptorSink(fd);
}

/** Test seam: replace the sink; returns a restore function. */
export function setLogSink(next: LogSink): () => void {
  const previous = channel.sink;
  channel.sink = next;
  return () => {
    channel.sink = previous;
  };
}

/** Test helper: collect the records emitted until `restore()`. */
export function captureLog(): { records: LogRecord[]; restore: () => void } {
  const records: LogRecord[] = [];
  const restore = setLogSink((line) => records.push(JSON.parse(line) as LogRecord));
  return { records, restore };
}

/** logRecord builds every record with the validator's own per-key
 * predicates, so each sink, stderr included, gets exactly what the output
 * supervisor would publish. */
function emit(record: LogRecord): void {
  channel.sink(JSON.stringify(record), record.level as LogLevel);
}
/** Log one event (no error) at its site's fixed level. */
export function logEvent(site: LogSite, fields: LogFields = {}): void {
  emit(logRecord(site, fields));
}

/** Log one unexpected failure: its class and stable code, never its text. */
export function logInternalError(site: LogSite, error: unknown, fields: LogFields = {}): void {
  emit(logRecord(site, fields, error));
}

/** Process-lifetime count of mergeability refresh failures (R3-W3). */
let mergeabilityFailures = 0;
export function countMergeabilityFailure(): number {
  mergeabilityFailures += 1;
  return mergeabilityFailures;
}

/**
 * A failed startup at a typed `stage` (e.g. "import", "data-root",
 * "index-reader"). An unsupported git (code UNSUPPORTED_GIT) gets its own
 * site and message, with gitVersion and minGitVersion as typed detail.
 */
export function logStartupFailure(
  processName: "server" | "worker",
  error: unknown,
  stage: StartupStage,
): void {
  const site: LogSite =
    errorCodeOf(error) === "UNSUPPORTED_GIT" ? "git.unsupported" : `${processName}.startup`;
  // A driver construction failure is the connection's own stage; its setting
  // and reason travel as the error's typed detail. Every other failure keeps
  // the caller's stage and the driver's own class and stable code.
  logInternalError(site, error, {
    stage: error instanceof ConnectionConfigError ? error.stage : stage,
  });
}
