// Own the pinned Prisma CLI and every native schema-engine/version-probe
// through the Linux parent-death guard. Deploy/resolve use their own completed
// RPC evidence; diff additionally requires exitCode 0 from the matching result.
// This is a pinned CLI lifecycle adapter, not a sandbox for arbitrary configs.
import childProcess from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { boundedChild } from "../../lib/bounded-child.mjs";

const exit = process.exit.bind(process);
const abort = new AbortController();
// Prisma's migrate diff drives the pinned engine binary more than once: it runs
// `schema-engine --version` to verify the (possibly freshly cached) binary
// before it spawns the long-lived diff engine it speaks JSON-RPC to. Both are
// native schema-engine processes we must own and drain so a CLI exit can never
// orphan one holding the database — so we track every one, not just the first.
const engines = [];
let finishing = false;
let expectedEngineHash;
let operation;
const guard = process.argv[2];
const requiredMethod = () =>
  operation === "diff"
    ? "diff"
    : operation === "deploy"
      ? "applyMigrations"
      : process.argv.includes("--applied")
        ? "markMigrationApplied"
        : "markMigrationRolledBack";

// A rejected child is otherwise an opaque `null` two processes away. Name the
// offending child on stderr (collect-prisma inherits it) so a changed Prisma or
// runtime contract is diagnosable from a CI/deploy log rather than guessed at.
function report(reason, file) {
  console.error(`prisma-owner: ${reason}: ${basename(String(file))}`);
}

// Observe the pinned CLI's newline-delimited native RPC without changing its
// bytes or replacing its handlers. Printed SQL is only a notification: success
// requires the matching diff result, not Node's beforeExit(0) with a pending RPC.
function comparisonProtocol(child) {
  let requested = false;
  let completed = false;
  const pending = new Map();
  let targetSucceeded = false;
  let rpcSucceeded = true;
  let valid = true;
  const fail = () => {
    valid = false;
    cancel();
  };
  const reader = (accept) => {
    // A JSON string can expand each SQL byte to six code units (\u0001).
    // Preserve the collector's full 16 MiB SQL allowance plus RPC envelopes.
    const maxFrameLength = 6 * 16 * 1024 * 1024 + 64 * 1024;
    // Match readline/JSON.parse: a BOM is a byte in the frame, not permission
    // to manufacture a parseable result by silently removing that byte.
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    let pending = "";
    let closed = false;
    const parse = (line) => {
      if (line.trim()) accept(JSON.parse(line));
    };
    const push = (bytes, final = false) => {
      if (closed || !valid) return;
      try {
        pending += decoder.decode(bytes, { stream: !final });
        let newline = pending.indexOf("\n");
        while (newline !== -1) {
          // Bound native protocol frames independently of collected SQL output.
          if (newline > maxFrameLength) throw new Error("RPC frame too large.");
          parse(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
          newline = pending.indexOf("\n");
        }
        if (pending.length > maxFrameLength) throw new Error("RPC frame too large.");
        if (final) {
          closed = true;
          parse(pending);
          pending = "";
        }
      } catch {
        fail();
      }
    };
    return { push, end: () => push(undefined, true) };
  };
  const requests = reader((frame) => {
    if (frame.jsonrpc !== "2.0") throw new Error("Unsupported RPC.");
    const allowed = new Set([
      requiredMethod(),
      "ensureConnectionValidity",
      "diagnoseMigrationHistory",
      "getDatabaseVersion",
    ]);
    if (frame.method !== undefined) {
      if (!allowed.has(frame.method) || frame.id === undefined || pending.has(frame.id))
        throw new Error("Unsupported migration RPC request.");
      pending.set(frame.id, frame.method);
      requested = true;
      completed = false;
    } else if (frame.result === undefined) throw new Error("Unsupported migration RPC reply.");
  });
  const responses = reader((frame) => {
    if (frame.jsonrpc !== "2.0") throw new Error("Unsupported RPC.");
    if (frame.method === "print" && typeof frame.params?.content === "string") return;
    const method = pending.get(frame.id);
    if (
      !method ||
      frame.method !== undefined ||
      (frame.result === undefined && frame.error === undefined)
    )
      throw new Error("Unmatched migration RPC result.");
    pending.delete(frame.id);
    rpcSucceeded &&= frame.error === undefined;
    if (
      method === requiredMethod() &&
      frame.error === undefined &&
      (method !== "diff" || frame.result?.exitCode === 0)
    )
      targetSucceeded = true;
    completed = pending.size === 0;
  });
  if (!child.stdin || !child.stdout) {
    fail();
  } else {
    const write = child.stdin.write.bind(child.stdin);
    child.stdin.write = (chunk, encoding, callback) => {
      requests.push(
        typeof chunk === "string"
          ? Buffer.from(chunk, typeof encoding === "string" ? encoding : undefined)
          : chunk,
      );
      return write(chunk, encoding, callback);
    };
    child.stdout.on("data", responses.push);
    child.stdout.once("end", responses.end);
  }
  return {
    succeeded: () => valid && requested && completed,
    targetSucceeded: () => targetSucceeded,
    finish: () => {
      requests.end();
      responses.end();
      return valid && requested && completed && rpcSucceeded;
    },
  };
}

// The persistent RPC server has no clean one-shot exit. Its owned stop must
// therefore never erase independent failure evidence. Accept only the pinned
// engine's exact informational startup record; reject every other diagnostic,
// including unknown panic formats, malformed UTF-8/JSON and truncated records.
// Keep observing through close: stderr and stdout are independent pipes, so a
// diagnostic can arrive after both the successful RPC and the stop request.
function nativeDiagnostics(child, startupMessage) {
  const chunks = [];
  let bytes = 0;
  let overflow = false;
  child.stderr.on("data", (chunk) => {
    if (overflow) return;
    bytes += chunk.length;
    if (bytes > 64 * 1024) {
      overflow = true;
      chunks.length = 0;
      cancel();
    } else chunks.push(chunk);
  });
  return () => {
    if (overflow) return false;
    try {
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        Buffer.concat(chunks, bytes),
      );
      let observedIdentity = false;
      const accepted = text.split("\n").every((line) => {
        if (!line) return true;
        const record = JSON.parse(line);
        const startup =
          JSON.stringify(record) === line &&
          Object.keys(record).sort().join(",") === "fields,level,target,timestamp" &&
          record.level === "INFO" &&
          record.target === "schema_engine" &&
          typeof record.timestamp === "string" &&
          /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(record.timestamp) &&
          Object.keys(record.fields).sort().join(",") === "git_hash,message" &&
          record.fields.message === startupMessage &&
          record.fields.git_hash === expectedEngineHash;
        if (startup) observedIdentity = true;
        else
          console.error(
            `prisma-owner: unexpected native diagnostic (${record.level === "INFO" ? "info" : "non-info"}; target=${/^[a-zA-Z0-9_:]+$/.test(record.target) ? record.target : "unknown"}).`,
          );
        return startup;
      });
      // Quiet logging (including RUST_LOG=off) is not evidence of identity.
      // Version probes are not RPC servers and cannot identify a later spawn.
      return accepted && (!startupMessage || observedIdentity);
    } catch {
      return false;
    }
  };
}

async function finish(code = 1) {
  if (finishing) return;
  finishing = true;
  // Only a CLI-requested stop may still be draining at successful CLI exit.
  // Every other live engine is an incomplete comparison and must be cancelled.
  for (const engine of engines)
    if (
      engine.child.exitCode === null &&
      engine.child.signalCode === null &&
      !(engine.cliStopped && !abort.signal.aborted)
    ) {
      code = 1;
      abort.abort();
    }
  // Close is acknowledged only after every owned native client has drained.
  // Parent death or a fatal signal cannot manufacture this acknowledgement.
  const drains = await Promise.all(
    engines.map((engine) =>
      engine.done.then(
        () => true,
        (error) => {
          // Both pinned CLI stop requests map to owned termination below.
          // Success still requires native close, CLI success, no cancellation
          // and the completed successful RPC checked separately below.
          const expected =
            !abort.signal.aborted &&
            engine.cliStopped &&
            error.code === "CHILD_CLI_STOP" &&
            !error.cause &&
            (error.exitCode === 0 || (error.exitCode === null && error.signal === "SIGKILL"));
          if (!expected)
            console.error(
              `prisma-owner: native drain failed (${error.code}; status=${error.exitCode}; signal=${error.signal}).`,
            );
          return expected;
        },
      ),
    ),
  );
  if (drains.some((drained) => !drained) || abort.signal.aborted) code = 1;
  if (code === 0 && engines.some((engine) => !engine.diagnostics())) {
    console.error("prisma-owner: native diagnostics rejected; comparison failed.");
    code = 1;
  }
  const comparisons = engines.filter((engine) => engine.comparison);
  if (
    code === 0 &&
    (!comparisons.length ||
      comparisons.some((engine) => !engine.comparison.finish()) ||
      !comparisons.some((engine) => engine.comparison.targetSucceeded()))
  ) {
    if (code === 0) console.error("prisma-owner: no completed successful diff RPC.");
    code = 1;
  }
  if (process.connected) process.send({ schemaPrismaDrained: true }, () => exit(code));
  else exit(code);
}

const cancel = () => {
  abort.abort();
  void finish(1);
};
for (const name of ["SIGTERM", "SIGINT", "SIGHUP", "disconnect"]) process.on(name, cancel);
process.channel?.unref();
process.on("uncaughtException", cancel);
process.on("unhandledRejection", cancel);
process.once("beforeExit", (code) => void finish(code));
process.exit = (code) => void finish(Number(code ?? process.exitCode ?? 0));

// Every native schema-engine Prisma spawns — the `--version` probe and the diff
// engine alike — is owned and drained here. Anything else through async spawn
// (a renamed/wrapped engine, an unexpected descendant) fails closed: silently
// returning a bogus (empty) diff to apply to a database is exactly the costly
// mistake this guard exists to prevent. A shell/detached engine, or a spawn
// after shutdown, is likewise a changed contract and fails closed.
childProcess.spawn = (file, args, options) => {
  if (
    finishing ||
    abort.signal.aborted ||
    !basename(String(file)).startsWith("schema-engine-") ||
    options?.shell ||
    options?.detached
  ) {
    report("refused unowned spawn", file, args, options);
    throw new Error("Unsupported schema comparison child contract.");
  }
  const versionProbe = args?.length === 1 && args[0] === "--version";
  const cliAt = args?.indexOf("cli") ?? -1;
  const connectivityProbe =
    cliAt >= 0 && args[cliAt + 1] === "can-connect-to-database" && args.length === cliAt + 2;
  if (cliAt >= 0 && !connectivityProbe) {
    report("refused native CLI command", file);
    throw new Error("Unsupported native schema preflight command.");
  }
  const rpc = !versionProbe && !connectivityProbe;
  // Even Prisma's debug mode must leave stderr observable by this owner.
  const engine = boundedChild(guard, [String(process.pid), file, ...(args ?? [])], {
    ...options,
    // Keep the required identity record independent of caller log settings;
    // suppress unrelated informational connector logs, never errors/panics.
    env: {
      ...process.env,
      ...options?.env,
      RUST_LOG: "error,schema_engine=info,schema_engine::=error",
    },
    stdio: ["pipe", "pipe", "pipe"],
    signal: abort.signal,
  });
  engine.diagnostics = nativeDiagnostics(
    engine.child,
    versionProbe
      ? null
      : connectivityProbe
        ? "Starting schema engine CLI"
        : "Starting schema engine RPC server",
  );
  // Native close can reject before Prisma returns from stop(). Observe it now
  // so unhandledRejection cannot cancel a completed comparison; finish() still
  // awaits and classifies the original promise before acknowledging drain.
  void engine.done.catch(() => {});
  engine.cliStopped = false;
  const cliStop = () => {
    if (
      !engine.cliStopped &&
      !finishing &&
      !abort.signal.aborted &&
      engine.child.exitCode === null &&
      engine.child.signalCode === null
    ) {
      // Receiving the successful response proves the read-only comparison,
      // but not completion of Tokio's asynchronous stdout flush. Both EOF and
      // SIGTERM cancel that task during runtime shutdown and can panic (101)
      // even after its bytes reached us. Bypass runtime teardown only after
      // the matching successful RPC; OS close still proves native/DB drain.
      // Success also requires the final diagnostic check above: this signal
      // can replace exit 101, but can never erase its stderr evidence.
      if (!engine.comparison?.succeeded()) {
        cancel();
        return;
      }
      engine.cliStopped = true;
      engine.stop("CHILD_CLI_STOP", "SIGKILL");
    }
  };
  if (rpc && engine.child.stdin) {
    const stdin = engine.child.stdin;
    stdin.end = (...args) => {
      if (args.length) {
        report("refused changed stdin close contract", file, []);
        throw new Error("Unsupported schema comparison stdin close contract.");
      }
      // The pinned CLI ends stdin before its zero-delay kill timer. Neither
      // request may enter Tokio's flush-cancelling graceful shutdown path.
      cliStop();
      return stdin;
    };
  }
  if (rpc) {
    const kill = engine.child.kill.bind(engine.child);
    engine.child.kill = (signal) => {
      if (signal === undefined || signal === "SIGTERM" || signal === 15) {
        // stdin.end() and the CLI timer are one request. Never forward a second
        // signal after the owned stop (including while its close is pending).
        cliStop();
        return engine.child.killed;
      }
      return kill(signal);
    };
  }
  engines.push(engine);
  if (rpc) engine.comparison = comparisonProtocol(engine.child);
  return engine.child;
};

// Platform detection may only invoke these fixed read-only probes. Everything
// streaming the engine must pass through spawn and the every-edge native guard.
for (const method of ["exec", "execSync", "execFile", "execFileSync", "spawnSync"]) {
  const original = childProcess[method].bind(childProcess);
  childProcess[method] = (file, ...rest) => {
    const shellProbe = /^(?:ldconfig -p|openssl version(?: -v)?|uname -m)$/.test(String(file));
    const args = Array.isArray(rest[0]) ? rest[0] : [];
    const directProbe =
      /^(ldconfig|openssl|uname)$/.test(basename(String(file))) &&
      ((basename(String(file)) === "ldconfig" && args.join(" ") === "-p") ||
        (basename(String(file)) === "openssl" && /^(version|version -v)$/.test(args.join(" "))) ||
        (basename(String(file)) === "uname" && args.join(" ") === "-m"));
    if (!shellProbe && !directProbe) {
      report("refused probe escape", file);
      throw new Error("Unsupported Prisma platform probe.");
    }
    return original(file, ...rest);
  };
}
childProcess.fork = (modulePath, args) => {
  report("refused fork", modulePath, Array.isArray(args) ? args : []);
  throw new Error("Unsupported schema comparison child contract.");
};

try {
  const [, , , cli, ...args] = process.argv;
  operation = args[1];
  if (
    !process.send ||
    !cli ||
    args[0] !== "migrate" ||
    !new Set(["diff", "deploy", "resolve"]).has(operation)
  )
    throw new Error("Invalid schema comparison owner invocation.");
  // Resolve through the real CLI and its engine dependency, just as Prisma
  // does. This also works with pnpm/deployed symlinks without a root import or
  // another version pin. Missing/malformed package identity fails closed.
  const cliRequire = createRequire(realpathSync(resolve(cli)));
  const engineRequire = createRequire(cliRequire.resolve("@prisma/engines"));
  expectedEngineHash = engineRequire("@prisma/engines-version").enginesVersion;
  if (typeof expectedEngineHash !== "string" || !/^[a-f0-9]{40}$/.test(expectedEngineHash))
    throw new Error("Pinned Prisma engine identity unavailable.");
  process.env.CHECKPOINT_DISABLE = "1";
  process.argv = [process.execPath, resolve(cli), ...args];
  createRequire(import.meta.url)(resolve(cli));
} catch {
  report("owner invocation failed", "prisma", []);
  cancel();
}
