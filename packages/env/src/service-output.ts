/** The service's descriptor boundary. Only this process can publish log content;
 * application code, threads, addons and descendants inherit private pipes. */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { constants } from "node:os";
import { fileURLToPath } from "node:url";
import { type LogRecord, logRecord, validateLogRecord } from "./log-record.js";

const MAX_RECORD_BYTES = 16 * 1024;
/** After the direct child exits, descendants still holding its pipes get this
 * long to drain. A normal native-supervisor exit has already reaped them all;
 * output that outlives it means the supervisor itself was killed. */
const OUTLIVED_DRAIN_MS = 5_000;

/** A bounded newline protocol. Oversized/invalid frames are dropped as a unit. */
export function recordReader(accept: (record: LogRecord) => void) {
  let pending = Buffer.alloc(0);
  let oversized = false;
  let rejected = 0;
  return {
    write(chunk: Buffer) {
      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf(10, start);
        const end = newline < 0 ? chunk.length : newline;
        const part = chunk.subarray(start, end);
        if (!oversized) {
          if (pending.length + part.length > MAX_RECORD_BYTES) {
            pending = Buffer.alloc(0);
            oversized = true;
          } else pending = Buffer.concat([pending, part]);
        }
        if (newline < 0) break;
        let record: LogRecord | undefined;
        if (!oversized) {
          try {
            record = validateLogRecord(JSON.parse(pending.toString("utf8")));
          } catch {}
        }
        if (record) accept(record);
        else rejected++;
        pending = Buffer.alloc(0);
        oversized = false;
        start = newline + 1;
      }
    },
    finish() {
      return rejected + (oversized || pending.length > 0 ? 1 : 0);
    },
  };
}

/** With --fenced, keep the native supervisor immediately above the real service:
 * its PID admission, inherited fence descriptor, subreaper and drain stay intact.
 * Bare invocation still contains import failures before fence validation. */
export function superviseService(service: "server" | "worker", entry: URL): void {
  const args = process.argv.slice(2);
  const fenced = args[0] === "--fenced";
  if (fenced) args.shift();
  const nodeArgs = [...process.execArgv, fileURLToPath(entry), ...args];
  const native = existsSync("/usr/local/bin/kb-supervisor")
    ? "/usr/local/bin/kb-supervisor"
    : fileURLToPath(
        new URL(
          service === "server" ? "../native/kb-supervisor" : "../../server/native/kb-supervisor",
          entry,
        ),
      );
  const publish = (record: LogRecord) =>
    process.stdout.write(`${JSON.stringify(renderServiceRecord(record))}\n`);
  publish(logRecord("service.start", { service }));
  const child = spawn(
    fenced ? native : process.execPath,
    fenced
      ? [...(service === "worker" ? ["--worker"] : []), "--", process.execPath, ...nodeArgs]
      : nodeArgs,
    {
      // The record channel is named, never assumed: the native supervisor and
      // the service's connectServiceLog() both read KB_LOG_FD.
      env: { ...process.env, KB_LOG_FD: "3" },
      stdio: ["inherit", "pipe", "pipe", "pipe"],
    },
  );
  let stdoutBytes = 0;
  let stderrBytes = 0;
  child.stdout!.on("data", (bytes: Buffer) => {
    stdoutBytes += bytes.length;
  });
  child.stderr!.on("data", (bytes: Buffer) => {
    stderrBytes += bytes.length;
  });
  const reader = recordReader(publish);
  child.stdio[3]!.on("data", (bytes: Buffer) => reader.write(bytes));
  const term = () => {
    child.kill("SIGTERM");
  };
  const interrupt = () => {
    child.kill("SIGINT");
  };
  process.on("SIGTERM", term);
  process.on("SIGINT", interrupt);
  child.once("error", () => {
    publish(logRecord("service.spawn-failed", { service }));
  });
  let finished = false;
  const finish = (code: number | null, signal: NodeJS.Signals | null, outlived: boolean) => {
    if (finished) return;
    finished = true;
    clearTimeout(outlivedTimer);
    process.off("SIGTERM", term);
    process.off("SIGINT", interrupt);
    for (const [stream, bytes] of [
      ["stdout", stdoutBytes],
      ["stderr", stderrBytes],
    ] as const)
      publish(logRecord("service.output", { service, stream, bytes }));
    const rejected = reader.finish();
    if (rejected) publish(logRecord("service.records-rejected", { service, count: rejected }));
    publish(
      logRecord("service.exit", {
        service,
        exitCode: code,
        signal,
        reason: outlived ? "DESCENDANTS_OUTLIVED_SERVICE" : undefined,
      }),
    );
    process.exitCode = code ?? (signal ? 128 + constants.signals[signal] : 1);
    // Stop reading pipes an orphaned descendant still holds; this process
    // (and with it the container's PID namespace) then ends.
    if (outlived) for (const stream of child.stdio) stream?.destroy();
  };
  let outlivedTimer: ReturnType<typeof setTimeout> | undefined;
  // close, rather than exit: keep draining all three pipes to EOF, including
  // descendant output, before publishing the exit record or releasing the PID.
  child.once("close", (code, signal) => finish(code, signal, false));
  // ...but only for a bounded time once the direct child is gone.
  child.once("exit", (code, signal) => {
    outlivedTimer = setTimeout(() => finish(code, signal, true), OUTLIVED_DRAIN_MS);
  });
}

/** Called only after validation; all interpolated values have closed formats. */
export function renderServiceRecord(record: LogRecord): LogRecord {
  if (record.site !== "password-pepper") return record;
  const { event, fingerprint, previousFingerprint, unknownFingerprint, count, docs } = record;
  let message: string;
  let level = "info";
  switch (event) {
    case "ok":
      message = `password pepper: ok (key fp ${fingerprint})`;
      break;
    case "sealed":
      message = `password pepper: sealed ${count} existing password hash(es) under key ${fingerprint}`;
      break;
    case "rewrapped-complete":
      message = `password pepper: re-wrapped ${count} password hash(es) from key ${previousFingerprint} to key ${fingerprint}; none remain under the previous key, so BETTER_AUTH_SECRET_PREVIOUS can now be removed`;
      break;
    case "previous-remaining":
      level = "warn";
      message = `password pepper: ${count} password hash(es) are still under previous key ${previousFingerprint} (corrupt, or written by a replica still running the old configuration); keep BETTER_AUTH_SECRET_PREVIOUS set and restart again; see ${docs}`;
      break;
    case "unusable":
      level = "warn";
      message = `password pepper: ${count} stored password value(s) are corrupt or not a password hash and can never sign in; run \`pnpm auth:pepper:reset-unusable\` (${docs})`;
      break;
    case "key-refused":
      level = "error";
      message = `password pepper: ${count} stored password hash(es) are sealed under unconfigured keys including ${unknownFingerprint}; configured BETTER_AUTH_SECRET key is ${fingerprint}${previousFingerprint ? ` (previous: ${previousFingerprint})` : ""}. Refusing to start. Restore the original BETTER_AUTH_SECRET as the current or previous secret; if lost, reset those passwords with \`pnpm auth:pepper:reset-unusable\` while the server is stopped; see ${docs}.`;
      break;
    default:
      return record;
  }
  return { ...record, level, message };
}
