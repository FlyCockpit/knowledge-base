/**
 * Environment health-check. Validates env vars and tests connectivity to
 * Postgres, Redis, and (optionally) SMTP. Does NOT mutate any state.
 *
 * Exit code: 0 if all required checks pass, 1 otherwise.
 *
 * Run: `pnpm doctor`
 */

// Load repo-root `.env` before `@knowledge-base/env/server` validation below.
import "@knowledge-base/env/load-dotenv";

import { spawnSync } from "node:child_process";
import { connect } from "node:net";
import { resolve } from "node:path";

import { validateKbMasterKeyFormat } from "@knowledge-base/env/kb-master-key";

import { claudeHooksStatus } from "./install-claude-hooks.js";

const ROOT = resolve(import.meta.dirname!, "..");

/**
 * Runs a tiny inline Node script inside a workspace package so we can use
 * dependencies (`@knowledge-base/db`, `ioredis`) that live in that package without
 * adding them to the root package.json.
 */
function runInPackage(filter: string, script: string): { ok: boolean; output: string } {
  const result = spawnSync(
    "pnpm",
    ["--silent", "-F", filter, "exec", "node", "--input-type=module", "-e", script],
    {
      cwd: ROOT,
      encoding: "utf-8",
      shell: process.platform === "win32",
    },
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return { ok: result.status === 0, output };
}

type CheckStatus = "ok" | "fail" | "warn" | "skip";

interface CheckResult {
  name: string;
  status: CheckStatus;
  detail?: string;
  hint?: string;
  required: boolean;
}

const results: CheckResult[] = [];

function record(result: CheckResult) {
  results.push(result);
}

function parseBooleanEnv(name: string): boolean | null {
  const value = process.env[name];
  if (value === undefined) return null;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be exactly "true" or "false" when set.`);
}

function isLocalDatabaseHost(host: string): boolean {
  return (
    host === "localhost" ||
    host === "postgres" ||
    host === "db" ||
    host === "database" ||
    host === "host.docker.internal" ||
    host.startsWith("127.") ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
}

function detectCrossPlatformPnpmHome(pnpmHome: string): string | null {
  const normalized = pnpmHome.replace(/\\/g, "/");
  if (process.platform === "linux" && normalized.startsWith("/Users/")) {
    return "macOS-style /Users path on Linux/WSL";
  }
  if (process.platform === "linux" && /^\/mnt\/[a-z]\/Users\//i.test(normalized)) {
    return "Windows home mounted into WSL";
  }
  if (process.platform === "darwin" && normalized.startsWith("/home/")) {
    return "Linux-style /home path on macOS";
  }
  if (process.platform !== "win32" && /^[A-Za-z]:\//.test(normalized)) {
    return "Windows drive path in a Unix-like shell";
  }
  return null;
}

// ---------------------------------------------------------------------------
// 0. pnpm home sanity check
// ---------------------------------------------------------------------------
function checkPnpmHome() {
  const pnpmHome = process.env.PNPM_HOME;
  if (!pnpmHome) {
    record({
      name: "pnpm home",
      status: "ok",
      detail: "PNPM_HOME is unset; pnpm will use the OS-local default",
      required: true,
    });
    return;
  }

  const mismatch = detectCrossPlatformPnpmHome(pnpmHome);
  if (!mismatch) {
    record({
      name: "pnpm home",
      status: "ok",
      detail: pnpmHome,
      required: true,
    });
    return;
  }

  record({
    name: "pnpm home",
    status: "fail",
    detail: `PNPM_HOME=${pnpmHome} (${mismatch})`,
    hint:
      "Unset PNPM_HOME in this shell, then remove or fix the stale export in your shell profile. " +
      "On Linux/WSL, either leave PNPM_HOME unset or set it to $HOME/.local/share/pnpm.",
    required: true,
  });
}

// ---------------------------------------------------------------------------
// 1. Portless CLI (global dev prerequisite)
// ---------------------------------------------------------------------------
function checkPortless() {
  const result = spawnSync("portless", ["--version"], {
    cwd: ROOT,
    encoding: "utf-8",
    shell: process.platform === "win32",
  });
  if (result.status === 0) {
    const version = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    record({
      name: "portless CLI",
      status: "ok",
      detail: version || "installed",
      required: true,
    });
    return;
  }
  record({
    name: "portless CLI",
    status: "warn",
    detail: "portless is not available on PATH",
    hint: "Install it globally with `npm install -g portless`, then run `portless trust` if the CLI asks you to trust its local CA. Use `pnpm dev:raw` only as a fallback.",
    required: false,
  });
}

// ---------------------------------------------------------------------------
// 2. KB_MASTER_KEY shape (never logs the value)
// ---------------------------------------------------------------------------
function checkKbMasterKey() {
  const raw = process.env.KB_MASTER_KEY;
  if (raw === undefined || raw === "") {
    record({
      name: "kb master key",
      status: "warn",
      detail: "KB_MASTER_KEY is unset — at-rest encryption stays unavailable",
      hint: "Run `pnpm run setup` or `pnpm generate:secrets` to mint KB_MASTER_KEY for server and worker.",
      required: false,
    });
    return;
  }
  const result = validateKbMasterKeyFormat(raw);
  if (!result.ok) {
    record({
      name: "kb master key",
      status: "fail",
      detail: result.reason,
      hint: "Replace KB_MASTER_KEY with canonical base64 of exactly 32 random bytes.",
      required: true,
    });
    return;
  }
  record({
    name: "kb master key",
    status: "ok",
    detail: "configured (32-byte key present)",
    required: false,
  });
}

// ---------------------------------------------------------------------------
// 3. Env validation via @knowledge-base/env (zod)
// ---------------------------------------------------------------------------
async function checkEnv() {
  try {
    await import("@knowledge-base/env/server");
    record({ name: "env (zod schema)", status: "ok", required: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    record({
      name: "env (zod schema)",
      status: "fail",
      detail: message,
      hint: "Open .env at the repo root and fix the variables called out above.",
      required: true,
    });
  }
}

// ---------------------------------------------------------------------------
// 3. Database connection (uses `pg` from @knowledge-base/db's deps via workspace exec)
// ---------------------------------------------------------------------------
function checkDatabase() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    record({
      name: "database",
      status: "fail",
      detail: "DATABASE_URL is not set",
      hint: "Set DATABASE_URL in .env or run `pnpm run setup`.",
      required: true,
    });
    return;
  }
  try {
    const host = new URL(url).hostname;
    if (!isLocalDatabaseHost(host)) {
      record({
        name: "database target",
        status: "warn",
        detail: `DATABASE_URL points at non-local host ${host}`,
        hint: "Use read-only tools for production inspection. Destructive schema commands are intended for local Postgres only.",
        required: false,
      });
    }
  } catch {
    // Env validation will report the malformed URL; avoid duplicate noise here.
  }
  // Inline script runs inside @knowledge-base/db so it can resolve `pg`.
  const script = `
    import pg from "pg";
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 3000 });
    try {
      await client.connect();
      await client.query("SELECT 1");
      console.log("ok");
      await client.end();
      process.exit(0);
    } catch (err) {
      console.error(err && err.message ? err.message : String(err));
      process.exit(1);
    }
  `;
  const { ok, output } = runInPackage("@knowledge-base/db", script);
  if (ok) {
    record({ name: "database", status: "ok", detail: "connected", required: true });
  } else {
    record({
      name: "database",
      status: "fail",
      detail: output || "connection failed",
      hint:
        "Is the Postgres container running? Try `pnpm dev:services`, then `pnpm db:migrate:apply`. " +
        "Verify DATABASE_URL host/port/credentials.",
      required: true,
    });
  }
}

// ---------------------------------------------------------------------------
// 4. Redis connection (uses `ioredis` from @knowledge-base/queue via workspace exec)
// ---------------------------------------------------------------------------
function checkRedis() {
  const url = process.env.REDIS_URL;
  if (!url) {
    record({
      name: "redis",
      status: "fail",
      detail: "REDIS_URL is not set",
      hint: "Set REDIS_URL in .env (e.g. redis://localhost:6379).",
      required: true,
    });
    return;
  }
  const script = `
    import IORedis from "ioredis";
    const client = new IORedis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      connectTimeout: 3000,
    });
    try {
      await client.connect();
      const pong = await client.ping();
      client.disconnect();
      if (pong === "PONG") {
        console.log("ok");
        process.exit(0);
      }
      console.error("unexpected PING reply: " + pong);
      process.exit(1);
    } catch (err) {
      console.error(err && err.message ? err.message : String(err));
      process.exit(1);
    }
  `;
  const { ok, output } = runInPackage("@knowledge-base/queue", script);
  if (ok) {
    record({ name: "redis", status: "ok", detail: "PONG", required: true });
  } else {
    record({
      name: "redis",
      status: "fail",
      detail: output || "connection failed",
      hint: "Is Redis running? Try `pnpm dev:services`. Verify REDIS_URL host/port.",
      required: true,
    });
  }
}

// ---------------------------------------------------------------------------
// 5. SMTP connectivity (optional — warn-only)
// ---------------------------------------------------------------------------
function checkSmtp(): Promise<void> {
  return new Promise((done) => {
    const host = process.env.SMTP_HOST;
    const portStr = process.env.SMTP_PORT;
    let signupEnabled = false;
    try {
      signupEnabled = parseBooleanEnv("SIGNUP_ENABLED") ?? false;
    } catch (err) {
      record({
        name: "smtp",
        status: "fail",
        detail: err instanceof Error ? err.message : String(err),
        hint: "Set boolean env flags to exactly true or false in the root .env.",
        required: true,
      });
      done();
      return;
    }
    if (!host || !portStr) {
      if (signupEnabled) {
        record({
          name: "smtp",
          status: "fail",
          detail: "SMTP_HOST/SMTP_PORT not set but SIGNUP_ENABLED=true",
          hint:
            "Email verification is enforced on signup. Set SMTP_HOST/SMTP_PORT/SMTP_FROM " +
            "(and SMTP_USER/SMTP_PASS if your provider requires auth), or set " +
            "SIGNUP_ENABLED=false until SMTP is wired up.",
          required: true,
        });
      } else {
        record({
          name: "smtp",
          status: "skip",
          detail: "SMTP_HOST/SMTP_PORT not set — email is optional",
          required: false,
        });
      }
      // Mirror @knowledge-base/env's ADMIN_EMAIL parsing: trimmed, empty string
      // counts as unset.
      const adminEmail = (process.env.ADMIN_EMAIL ?? "").trim();
      if (adminEmail.length > 0) {
        record({
          name: "admin bootstrap",
          status: "warn",
          detail:
            "ADMIN_EMAIL is set but SMTP_HOST is not — admin endpoints require a verified email, " +
            "so the configured owner cannot complete first-admin bootstrap without SMTP",
          hint:
            "Set SMTP_HOST/SMTP_PORT/SMTP_FROM (and SMTP_USER/SMTP_PASS if your provider " +
            "requires auth) so verification emails deliver, or grant the admin role through " +
            "your approved admin/provisioning path instead.",
          required: false,
        });
      }
      done();
      return;
    }
    const port = Number(portStr);
    if (!Number.isFinite(port) || port <= 0) {
      record({
        name: "smtp",
        status: "warn",
        detail: `SMTP_PORT is not a valid number: ${portStr}`,
        required: false,
      });
      done();
      return;
    }
    const socket = connect({ host, port });
    let settled = false;
    const finish = (status: CheckStatus, detail: string, hint?: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      record({ name: "smtp", status, detail, hint, required: false });
      done();
    };
    socket.setTimeout(3000);
    socket.once("connect", () => finish("ok", `connected to ${host}:${port}`));
    socket.once("timeout", () =>
      finish(
        "warn",
        `timed out connecting to ${host}:${port}`,
        "Email sends will fail until SMTP is reachable.",
      ),
    );
    socket.once("error", (err) =>
      finish(
        "warn",
        `could not connect to ${host}:${port}: ${err.message}`,
        "Email sends will fail until SMTP is reachable.",
      ),
    );
  });
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------
function statusLabel(status: CheckStatus): string {
  switch (status) {
    case "ok":
      return "OK  ";
    case "fail":
      return "FAIL";
    case "warn":
      return "WARN";
    case "skip":
      return "SKIP";
  }
}

function printSummary() {
  console.log("");
  console.log("=== doctor: summary ===");
  for (const r of results) {
    const tag = statusLabel(r.status);
    const detail = r.detail ? ` — ${r.detail}` : "";
    console.log(`[${tag}] ${r.name}${detail}`);
    if (r.hint && (r.status === "fail" || r.status === "warn")) {
      console.log(`        hint: ${r.hint}`);
    }
  }
  console.log("");
}

function checkNodeVersion() {
  const [major = 0, minor = 0, patch = 0] = process.versions.node.split(".").map(Number);
  if (major > 26 || (major === 26 && (minor > 13 || (minor === 13 && patch >= 1)))) {
    record({
      name: "node",
      status: "ok",
      detail: process.versions.node,
      required: true,
    });
    return;
  }
  record({
    name: "node",
    status: "fail",
    detail: process.versions.node,
    hint: "This repo requires Node 26.13.1 or newer. See .nvmrc (`nvm use`).",
    required: true,
  });
}

// ---------------------------------------------------------------------------
// Claude Code safety hooks (.claude/settings.json)
// ---------------------------------------------------------------------------
// `.claude/` is gitignored, so a fresh clone has no hook until `pnpm run setup`
// installs one. Warn rather than fail: the hook is a safety net for AI agents,
// not a prerequisite for running the app.
function checkClaudeHooks() {
  const status = claudeHooksStatus();
  const remedy = "Run `pnpm run setup` (or `pnpm claude:hooks:install`) to install/merge them.";
  if (status.state === "ok") {
    record({
      name: "claude code hooks",
      status: "ok",
      detail: ".claude/settings.json is up to date",
      required: false,
    });
    return;
  }
  if (status.state === "missing") {
    record({
      name: "claude code hooks",
      status: "warn",
      detail: ".claude/settings.json is missing — the PreToolUse safety hook is not installed",
      hint: remedy,
      required: false,
    });
    return;
  }
  if (status.state === "invalid") {
    record({
      name: "claude code hooks",
      status: "warn",
      detail: `.claude/settings.json is not valid JSON (${status.detail})`,
      hint: "Fix the JSON (or delete the file), then run `pnpm claude:hooks:install`.",
      required: false,
    });
    return;
  }
  if (status.state === "local-invalid") {
    record({
      name: "claude code hooks",
      status: "warn",
      detail: `.claude/settings.local.json is not valid JSON (${status.detail})`,
      hint: "Fix that higher-precedence personal settings file, then run `pnpm claude:hooks:install`.",
      required: false,
    });
    return;
  }
  if (status.state === "local-hooks-disabled") {
    record({
      name: "claude code hooks",
      status: "warn",
      detail:
        ".claude/settings.local.json sets disableAllHooks: true, which takes precedence over the project PreToolUse safety hook",
      hint: "Remove that local override yourself, then run `pnpm claude:hooks:install` to verify the project hook.",
      required: false,
    });
    return;
  }
  const missing = [
    ...status.missingHooks.map((matcher) => `PreToolUse hook for ${matcher}`),
    ...status.missingDeny.map((rule) => `deny rule ${rule}`),
  ];
  record({
    name: "claude code hooks",
    status: "warn",
    detail: `.claude/settings.json is out of date vs scripts/claude-hooks/settings.json — missing: ${missing.join(", ")}`,
    hint: remedy,
    required: false,
  });
}

function checkDockerDaemon() {
  const result = spawnSync("docker", ["info"], {
    cwd: ROOT,
    encoding: "utf-8",
    shell: process.platform === "win32",
  });
  if (result.status === 0) {
    record({
      name: "docker daemon",
      status: "ok",
      detail: "reachable",
      required: false,
    });
    return;
  }
  record({
    name: "docker daemon",
    status: "warn",
    detail: "docker info failed",
    hint: "Local Postgres/Redis via `pnpm dev:services` need a running Docker (or Podman) daemon.",
    required: false,
  });
}

async function main() {
  checkNodeVersion();
  checkDockerDaemon();
  checkClaudeHooks();
  checkPnpmHome();
  const pnpmHomeOk = results.find((r) => r.name === "pnpm home")?.status === "ok";
  if (!pnpmHomeOk) {
    printSummary();
    console.log("doctor: fix pnpm home before running package-backed checks.");
    process.exit(1);
  }

  checkPortless();
  checkKbMasterKey();
  await checkEnv();
  // Stop further checks if env failed — they would all fail with confusing
  // messages and the user needs to fix env first.
  const envOk = results.find((r) => r.name === "env (zod schema)")?.status === "ok";
  if (envOk) {
    checkDatabase();
    checkRedis();
    await checkSmtp();
  } else {
    record({
      name: "database",
      status: "skip",
      detail: "skipped because env validation failed",
      required: true,
    });
    record({
      name: "redis",
      status: "skip",
      detail: "skipped because env validation failed",
      required: true,
    });
    record({
      name: "smtp",
      status: "skip",
      detail: "skipped because env validation failed",
      required: false,
    });
  }

  printSummary();

  const requiredFailed = results.some(
    (r) => r.required && (r.status === "fail" || r.status === "skip"),
  );
  if (requiredFailed) {
    console.log("doctor: one or more required checks failed.");
    process.exit(1);
  }
  console.log("doctor: all required checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
