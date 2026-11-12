/**
 * Run the Prisma CLI that packages/db pins, and load `pg` from packages/db's
 * dependency closure. Works in a checkout and in the app/worker images (both
 * ship packages/db/node_modules/prisma — see the Dockerfiles).
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boundedChild } from "../../lib/bounded-child.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DB_DIR = path.join(ROOT, "packages/db");
export const SCHEMA_DIR = path.join(DB_DIR, "prisma/schema");
export const MIGRATIONS_DIR = path.join(DB_DIR, "prisma/migrations");
export const FIXTURES_DIR = path.join(DB_DIR, "prisma/fixtures");
const PRISMA_CLI = path.join(DB_DIR, "node_modules/prisma/build/index.js");

/** @returns {typeof import("pg")} */
export function loadPg() {
  return createRequire(path.join(DB_DIR, "package.json"))("pg");
}

/**
 * Run `prisma <args>` with cwd packages/db.
 * @param {string[]} args
 * @param {{ env?: NodeJS.ProcessEnv, capture?: boolean, quiet?: boolean, timeoutMs?: number, signal?: AbortSignal, guardPath?: string }} [options]
 *   capture → resolve with { code, stdout, stderr } instead of inheriting stdio.
 *   timeoutMs → kill the child after this long; resolves with `timedOut: true`.
 * @returns {Promise<{ code: number, stdout: string, stderr: string, timedOut?: boolean }>}
 */
export async function prisma(args, options = {}) {
  if (args[0] === "migrate") {
    if (!["diff", "deploy", "resolve"].includes(args[1]))
      throw new Error("Unsupported migration command; use the reviewed migration wrappers.");
    return ownedPrisma(args, options);
  }
  const env = {
    ...process.env,
    CHECKPOINT_DISABLE: "1",
    PRISMA_HIDE_UPDATE_MESSAGE: "1",
    ...options.env,
  };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PRISMA_CLI, ...args], {
      cwd: DB_DIR,
      env,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    let timedOut = false;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, options.timeoutMs)
      : undefined;
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr, ...(timedOut ? { timedOut } : {}) });
    });
  });
}

/**
 * Write a dependency-free Prisma config pointing at an arbitrary migrations
 * folder / database (used for the base branch's migrations in CI and for
 * scratch databases). Returns the config path for `--config`.
 * @param {{ url: string, shadowUrl?: string, migrations?: string, schema?: string }} options
 */
export function tempConfig({ url, shadowUrl, migrations = MIGRATIONS_DIR, schema = SCHEMA_DIR }) {
  const dir = mkdtempSync(path.join(tmpdir(), "knowledge-base-prisma-"));
  const file = path.join(dir, "prisma.config.mjs");
  const config = {
    schema,
    migrations: { path: migrations },
    datasource: { url, shadowDatabaseUrl: shadowUrl },
  };
  writeFileSync(file, `export default ${JSON.stringify(config, null, 2)};\n`, { mode: 0o600 });
  return file;
}

/**
 * Every migration CLI AND native engine exec through kb-child-guard. Missing
 * guard fails closed; there is no production process-group/unguarded fallback.
 * Cancellation drains the cooperative CLI owner before DADP may be released.
 */
async function ownedPrisma(args, options) {
  const abort = new AbortController();
  const cancel = () => abort.abort();
  const signal = options.signal;
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) abort.abort();
  for (const name of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(name, cancel);
  const guard = options.guardPath ?? "/usr/local/bin/kb-child-guard";
  const timer = options.timeoutMs ? setTimeout(cancel, options.timeoutMs) : undefined;
  let drained = false;
  let overflow = false;
  const stdoutChunks = [];
  const stderrChunks = [];
  let outputBytes = 0;
  try {
    const owner = boundedChild(
      guard,
      [
        String(process.pid),
        process.execPath,
        path.join(ROOT, "scripts/db/lib/prisma-owner.mjs"),
        guard,
        PRISMA_CLI,
        ...args,
      ],
      {
        cwd: DB_DIR,
        env: {
          ...process.env,
          CHECKPOINT_DISABLE: "1",
          PRISMA_HIDE_UPDATE_MESSAGE: "1",
          ...options.env,
        },
        signal: abort.signal,
        cooperative: true,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    owner.child.on("message", (message) => {
      if (message?.schemaPrismaDrained === true) drained = true;
    });
    const collect = (stream, field) =>
      stream.on("data", (chunk) => {
        if (overflow) return;
        if (outputBytes + chunk.length > 16 * 1024 * 1024) {
          overflow = true;
          owner.stop();
          return;
        }
        outputBytes += chunk.length;
        if (field === "stdout") stdoutChunks.push(chunk);
        else stderrChunks.push(chunk);
        if (!options.capture) process[field].write(chunk);
      });
    collect(owner.child.stdout, "stdout");
    collect(owner.child.stderr, "stderr");
    const error = await owner.done.then(
      () => null,
      (e) => e,
    );
    if (!drained)
      throw new Error("Prisma owner did not acknowledge native drain; continuation refused.");
    // Pipe chunks may split UTF-8 characters. Decode only the bounded complete
    // stream after acknowledged native drain; invalid SQL bytes fail closed.
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    const stdout = decoder.decode(Buffer.concat(stdoutChunks));
    const stderr = decoder.decode(Buffer.concat(stderrChunks));
    return {
      code: error || overflow || abort.signal.aborted ? 1 : 0,
      stdout,
      stderr,
      ...(abort.signal.aborted && options.timeoutMs ? { timedOut: true } : {}),
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
    for (const name of ["SIGTERM", "SIGINT", "SIGHUP"]) process.removeListener(name, cancel);
  }
}
