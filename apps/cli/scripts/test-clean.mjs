/** Own a test run's temp namespace; never inspect or delete another run's stores. */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

function localStoreLeftovers(directory) {
  return readdirSync(directory).filter((name) => name.startsWith("kb-local-"));
}

// Cargo owns the build cache and toolchain. Each Node process prepares this
// once; no ad-hoc C compiler is needed at test invocation time.
let ownerBuild;
export function testOwner() {
  ownerBuild ??= (async () => {
    const cwd = fileURLToPath(new URL("../", import.meta.url));
    const child = spawn(
      "cargo",
      ["build", "-p", "kb-local", "--bin", "kb-test-owner", "--locked", "--message-format=json"],
      {
        cwd,
        stdio: ["ignore", "pipe", "inherit"],
      },
    );
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      output += chunk;
    });
    const status = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    if (status !== 0) throw new Error("Cannot build CLI test process owner");
    const artifact = output
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find(
        (item) =>
          item.reason === "compiler-artifact" &&
          item.target.name === "kb-test-owner" &&
          item.executable,
      );
    if (!artifact) throw new Error("Cargo did not report the test owner artifact");
    return artifact.executable;
  })();
  return ownerBuild;
}

export async function runClean(command, args, { portable = false, owner } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "kb-cli-tests-"));
  let child;
  let interrupted = false;
  let admitted = false;
  const stop = () => {
    interrupted = true;
    // A file also covers cancellation before the native owner has initialized
    // its handlers. Never kill that owner before its drain acknowledgement.
    writeFileSync(join(directory, "stop"), "stop");
  };
  const interrupt = stop;
  const terminate = stop;
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    const home = join(directory, "home");
    const runtime = join(directory, "runtime");
    mkdirSync(home, { mode: 0o700 });
    mkdirSync(runtime, { mode: 0o700 });
    const supervisor = owner ?? (await testOwner());
    if (interrupted) return 1;
    child = spawn(supervisor, [directory, ...(portable ? ["--portable"] : []), command, ...args], {
      stdio: "inherit",
      env: {
        ...process.env,
        // Keep cargo's already provisioned toolchains while isolating every kb
        // subprocess from the real keyring, config and shared model cache.
        CARGO_HOME:
          process.env.CARGO_HOME ?? join(process.env.HOME ?? process.env.USERPROFILE, ".cargo"),
        RUSTUP_HOME:
          process.env.RUSTUP_HOME ?? join(process.env.HOME ?? process.env.USERPROFILE, ".rustup"),
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: join(home, "config"),
        XDG_DATA_HOME: join(home, "data"),
        XDG_CACHE_HOME: join(home, "cache"),
        XDG_RUNTIME_DIR: runtime,
        DBUS_SESSION_BUS_ADDRESS: `unix:path=${directory}/nobus`,
        TMPDIR: directory,
        TMP: directory,
        TEMP: directory,
      },
    });
    child.once("spawn", () => {
      admitted = true;
    });
    let spawnError;
    const status = await new Promise((resolve) => {
      child.once("error", (error) => {
        spawnError = error;
        stop();
        resolve(1);
      });
      child.once("exit", (code) => resolve(code ?? 1));
    });
    if (spawnError && !admitted) throw spawnError;
    if (!existsSync(join(directory, "drained")))
      throw new Error(`CLI test tree did not acknowledge drainage; retained ${directory}`);
    if (spawnError) throw spawnError;
    const leftovers = localStoreLeftovers(directory);
    if (leftovers.length) {
      console.error(
        `kb-local tests leaked ${leftovers.length} temp stores: ${leftovers.slice(0, 20).join(", ")}`,
      );
      return 1;
    }
    return interrupted ? 1 : status;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    // An owner failure cannot authorize deleting a possibly active namespace.
    if (!admitted || existsSync(join(directory, "drained")))
      rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  if (!command)
    throw new Error("Pass the test command, e.g. cargo test --workspace --all-targets --locked");
  process.exitCode = await runClean(command, args);
}
