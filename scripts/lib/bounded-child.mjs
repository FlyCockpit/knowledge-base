/** Own one direct native client through timeout/cancellation and final close. */
import { spawn } from "node:child_process";
import { closeSync, constants, openSync, readSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function boundedChild(
  file,
  args,
  { env = process.env, cwd, signal, timeout = 0, stdio = "inherit", cooperative = false } = {},
) {
  if (signal?.aborted)
    throw Object.assign(new Error("Client cancelled before start."), { code: "CHILD_CANCELLED" });
  const child = spawn(file, args, { env, cwd, stdio });
  // Keep ownership independent of adapters wrapping the public child handle.
  const kill = child.kill.bind(child);
  let stopped = false;
  let failure;
  let reason;
  let escalation;
  const stop = (code = "CHILD_CANCELLED", terminationSignal = "SIGTERM") => {
    if (stopped || child.exitCode !== null || child.signalCode !== null) return;
    stopped = true;
    reason = code;
    kill(terminationSignal);
    // Node owns the native process handle and observes exit before another JS
    // callback can signal it. A shell's saved $! does not have that property.
    // Known nested owners must finish their own leaf drain and EXIT cleanup;
    // forcing them down would orphan that leaf. Only native leaves escalate.
    if (!cooperative && terminationSignal !== "SIGKILL")
      escalation = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) kill("SIGKILL");
      }, 5_000);
  };
  const abort = () => stop();
  signal?.addEventListener("abort", abort, { once: true });
  const deadline = timeout ? setTimeout(() => stop("CHILD_DEADLINE"), timeout) : undefined;
  const done = new Promise((resolve, reject) => {
    // An error can also mean a failed signal while the process is still alive.
    // Only close is evidence that this owner may acknowledge its final drain.
    child.on("error", (error) => {
      failure = error;
    });
    child.once("close", (code) => {
      clearTimeout(deadline);
      clearTimeout(escalation);
      signal?.removeEventListener("abort", abort);
      if (failure || stopped || code !== 0) {
        const failureCode =
          reason ??
          (failure
            ? failure.syscall?.startsWith("spawn")
              ? "CHILD_SPAWN"
              : "CHILD_ERROR"
            : "CHILD_EXIT");
        const message =
          failureCode === "CHILD_DEADLINE"
            ? `Client deadline exceeded (${timeout}ms).`
            : failureCode === "CHILD_CANCELLED"
              ? "Client cancelled."
              : failure
                ? `Client error (${failure.code ?? "unknown"}).`
                : `Client exited with ${code === null ? `signal ${child.signalCode}` : `status ${code}`}.`;
        // Never include argv/env: callers may pass connection strings or tokens.
        reject(
          Object.assign(new Error(message), {
            code: failureCode,
            timeout,
            exitCode: code,
            signal: child.signalCode,
            ...(failure
              ? {
                  cause: Object.assign(new Error("Native client process error."), {
                    code: failure.code,
                  }),
                }
              : {}),
          }),
        );
      } else resolve();
    });
  });
  return { child, done, stop };
}

// A nonblocking read binds cancellation to this opened FIFO, including parent
// death/EOF. Read once before spawn so cancellation during publication admits
// no command. Polling the descriptor avoids a blocking thread-pool FIFO read
// preventing supervisor exit; nothing polls a PID or reopens the pathname.
export function childControl(channel, descriptor, abort) {
  let fd;
  try {
    fd = openSync(channel, constants.O_RDONLY | constants.O_NONBLOCK);
  } finally {
    closeSync(descriptor);
  }
  const byte = Buffer.alloc(1);
  const check = () => {
    try {
      // Any byte or EOF closes admission. EAGAIN alone means a live parent
      // still owns the write peer and has not requested cancellation.
      readSync(fd, byte, 0, 1, null);
      abort.abort();
    } catch (error) {
      if (error.code !== "EAGAIN") abort.abort();
    }
  };
  check();
  const poll = setInterval(check, 25);
  return () => {
    clearInterval(poll);
    closeSync(fd);
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const abort = new AbortController();
  for (const name of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(name, () => abort.abort());
  let closeControl;
  let channel;
  let owner;
  let cooperative = false;
  try {
    let offset = 2;
    if (process.argv[offset] === "--control") {
      channel = process.argv[offset + 1];
      const descriptor = Number(process.argv[offset + 2]);
      if (!channel || ![6, 7, 8, 9].includes(descriptor)) throw new Error("Invalid child channel.");
      closeControl = childControl(channel, descriptor, abort);
      offset += 3;
    }
    if (process.argv[offset] === "--cooperative") {
      cooperative = true;
      offset++;
    }
    const timeout = Number(process.argv[offset++]);
    const forwardInput = process.argv[offset] === "--close-input";
    if (forwardInput) offset++;
    if (!Number.isSafeInteger(timeout) || timeout < 0 || !process.argv[offset])
      throw new Error("Invalid client deadline.");
    owner = boundedChild(process.argv[offset], process.argv.slice(offset + 1), {
      signal: abort.signal,
      timeout,
      cooperative,
      stdio: forwardInput ? ["pipe", "inherit", "inherit"] : "inherit",
    });
    let inputDeadline;
    if (forwardInput) {
      owner.child.stdin.on("error", () => {});
      process.stdin.pipe(owner.child.stdin);
      process.stdin.once("end", () => {
        inputDeadline = setTimeout(owner.stop, 5_000);
      });
    }
    try {
      await owner.done;
    } finally {
      clearTimeout(inputDeadline);
      if (forwardInput) {
        process.stdin.unpipe(owner.child.stdin);
        process.stdin.destroy();
      }
    }
  } catch {
    console.error(
      "FATAL: database/preparation client failed or was cancelled; no success is implied.",
    );
    process.exitCode = channel && owner?.child.exitCode ? owner.child.exitCode : 1;
  } finally {
    closeControl?.();
    // Native close proves the direct client stopped. Cooperative owners use
    // exit 125 to propagate missing nested acknowledgement; a fatal signal or
    // a killed supervisor cannot attest that a descendant has drained.
    if (
      channel &&
      (!owner || !cooperative || (owner.child.signalCode === null && owner.child.exitCode !== 125))
    ) {
      writeFileSync(`${channel}.drained`, "drained\n", { flag: "wx", mode: 0o600 });
    }
  }
}
