/**
 * First-run onboarding script. Idempotent — safe to re-run.
 *
 * One command takes a fresh clone to a runnable state:
 *   1. Copy .env.example -> .env if .env does not exist.
 *   2. Copy apps/web/.env.example -> apps/web/.env if it does not exist.
 *   4. Generate BETTER_AUTH_SECRET if it is empty in .env.
 *   5. Ask for the developer's email and write it to ADMIN_EMAIL in .env, so
 *      their first local sign-up becomes the first admin.
 *   6. Point SMTP_* at the local mailpit sink (email verification is enforced
 *      on signup — without this, first login has no way to receive the
 *      verification link). A real provider configured in .env is left alone.
 *   7. Start the local Docker services — Postgres + Redis + mailpit
 *      (`pnpm dev:services`, the canonical root docker-compose.dev.yml).
 *   8. Wait for Postgres, Redis, and the sink to accept connections.
 *   9. Apply the schema (`pnpm db:migrate:apply`).
 *  10. Check whether the global portless CLI is available for `pnpm dev`.
 *  11. Install the Claude Code safety hooks into .claude/settings.json (harmless
 *      for other harnesses).
 *
 * After this, `pnpm dev` is the only remaining step.
 *
 * Run: `pnpm run setup` (the explicit `run` form — `setup` is also a pnpm
 * builtin, and on some pnpm versions the bare `pnpm setup` invokes the builtin
 * instead of this script)
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import { installClaudeHooks } from "./install-claude-hooks.js";
import { looksLikeEmail, readAdminEmailValue, withAdminEmail } from "./lib/admin-email-env.js";
import { readSmtpHostValue, withDevSmtpSink } from "./lib/smtp-env.js";

const ROOT = resolve(import.meta.dirname!, "..");
const ENV_PATH = resolve(ROOT, ".env");
const ENV_EXAMPLE_PATH = resolve(ROOT, ".env.example");
const WEB_ENV_PATH = resolve(ROOT, "apps/web/.env");
const WEB_ENV_EXAMPLE_PATH = resolve(ROOT, "apps/web/.env.example");

function log(msg: string) {
  console.log(`[setup] ${msg}`);
}

function fail(msg: string): never {
  console.error(`[setup] ERROR: ${msg}`);
  process.exit(1);
}

function run(command: string, args: string[]) {
  log(`running: ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    fail(`command failed: ${command} ${args.join(" ")}`);
  }
}

function commandExists(command: string): boolean {
  const result = spawnSync(command, ["--version"], {
    cwd: ROOT,
    stdio: "ignore",
    shell: process.platform === "win32",
  });
  return result.status === 0;
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

function checkPnpmHome() {
  const pnpmHome = process.env.PNPM_HOME;
  if (!pnpmHome) return;

  const mismatch = detectCrossPlatformPnpmHome(pnpmHome);
  if (!mismatch) return;

  fail(
    `PNPM_HOME points at ${pnpmHome} (${mismatch}). ` +
      "Unset PNPM_HOME in this shell, then remove or fix the stale export in your shell profile. " +
      "On Linux/WSL, either leave PNPM_HOME unset or set it to $HOME/.local/share/pnpm.",
  );
}

// ---------------------------------------------------------------------------
// 1. Copy .env.example -> .env
// ---------------------------------------------------------------------------
function ensureEnvFile() {
  if (existsSync(ENV_PATH)) {
    log(".env already exists — leaving it alone");
    return;
  }
  if (!existsSync(ENV_EXAMPLE_PATH)) {
    fail(".env.example not found at repo root");
  }
  const template = readFileSync(ENV_EXAMPLE_PATH, "utf-8");
  writeFileSync(ENV_PATH, template, "utf-8");
  log("created .env from .env.example");
}

// ---------------------------------------------------------------------------
// 2. Copy apps/web/.env.example -> apps/web/.env
//
// apps/web/.env.example is all-optional (every VITE_ var is commented out),
// so copying it verbatim is a safe, runnable default. Without this file the
// web app still boots, but onboarding docs previously made this a manual step
// the user had to remember — fold it into `pnpm run setup` instead.
// ---------------------------------------------------------------------------
function ensureWebEnvFile() {
  if (existsSync(WEB_ENV_PATH)) {
    log("apps/web/.env already exists — leaving it alone");
    return;
  }
  if (!existsSync(WEB_ENV_EXAMPLE_PATH)) {
    fail("apps/web/.env.example not found");
  }
  const template = readFileSync(WEB_ENV_EXAMPLE_PATH, "utf-8");
  writeFileSync(WEB_ENV_PATH, template, "utf-8");
  log("created apps/web/.env from apps/web/.env.example");
}

// ---------------------------------------------------------------------------
// 4. Generate BETTER_AUTH_SECRET and KB_MASTER_KEY if missing/empty
// ---------------------------------------------------------------------------
function ensureEnvSecret(key: "BETTER_AUTH_SECRET" | "KB_MASTER_KEY", label: string) {
  const contents = readFileSync(ENV_PATH, "utf-8");
  const lines = contents.split("\n");
  let touched = false;
  let foundLine = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    if (line.trim().startsWith("#")) continue;
    const match = line.match(new RegExp(`^(\\s*)${key}\\s*=\\s*(.*?)\\s*$`));
    if (!match) continue;
    foundLine = true;
    const value = (match[2] ?? "").replace(/^["']|["']$/g, "");
    if (value.length > 0) {
      log(`${key} already set — leaving it alone`);
      return;
    }
    const secret = randomBytes(32).toString("base64");
    lines[i] = `${match[1]}${key}=${secret}`;
    touched = true;
    log(`generated and wrote a new ${label}`);
    break;
  }

  if (!foundLine) {
    const secret = randomBytes(32).toString("base64");
    lines.push(`${key}=${secret}`);
    touched = true;
    log(`${key} line was missing — appended a generated value`);
  }

  if (touched) {
    writeFileSync(ENV_PATH, lines.join("\n"), "utf-8");
  }
}

function ensureBetterAuthSecret() {
  ensureEnvSecret("BETTER_AUTH_SECRET", "BETTER_AUTH_SECRET");
}

function ensureKbMasterKey() {
  ensureEnvSecret("KB_MASTER_KEY", "KB_MASTER_KEY");
}

// ---------------------------------------------------------------------------
// 5. Ask for the developer's email -> ADMIN_EMAIL in .env
//
// This is the gap that leaves a fresh clone unable to sign in: SIGNUP_ENABLED
// defaults false and ADMIN_EMAIL defaults empty. Local and test still admit
// the first valid account when unconfigured; writing the address here matches
// the production identity so the same signup becomes the first admin. Asking
// once, up front, fills the value locally.
//
// Non-interactive use (CI, agents, scripted installs): pass
// `--admin-email <addr>` or set the ADMIN_EMAIL process env. The flag is not
// a second app env var — it becomes the ADMIN_EMAIL value written into .env.
// ---------------------------------------------------------------------------
function parseAdminEmailFlag(argv: string[]): string | null {
  const index = argv.indexOf("--admin-email");
  if (index === -1) return null;
  const value = argv[index + 1];
  return value && value.length > 0 ? value : null;
}

async function promptForAdminEmail(): Promise<string | null> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      "Your email address. You'll sign up with it to become the first admin " +
        "(leave blank to skip): ",
    );
    const trimmed = answer.trim();
    return trimmed.length > 0 ? trimmed : null;
  } finally {
    rl.close();
  }
}

async function ensureAdminEmail() {
  const contents = readFileSync(ENV_PATH, "utf-8");
  if (readAdminEmailValue(contents) !== null) {
    log("ADMIN_EMAIL is already set in .env — leaving it alone");
    return;
  }

  const flagEmail = parseAdminEmailFlag(process.argv.slice(2));
  const envEmail = process.env.ADMIN_EMAIL;
  let rawEmail: string | null;

  if (flagEmail) {
    rawEmail = flagEmail;
  } else if (envEmail) {
    rawEmail = envEmail;
  } else if (!process.stdin.isTTY) {
    log(
      "Skipping admin email setup (no interactive terminal). To finish: add " +
        "ADMIN_EMAIL=<your email> to .env yourself, or re-run " +
        "`pnpm run setup --admin-email <you@example.com>`.",
    );
    return;
  } else {
    rawEmail = await promptForAdminEmail();
    if (!rawEmail) {
      log(
        "Skipping admin email setup — add ADMIN_EMAIL=<your email> to .env " +
          "later, then restart the dev server, to sign up as the first admin.",
      );
      return;
    }
  }

  const normalized = rawEmail.trim().toLowerCase();
  if (!looksLikeEmail(normalized)) {
    log(
      `"${rawEmail.trim()}" doesn't look like an email address — skipping ADMIN_EMAIL setup. ` +
        "Add ADMIN_EMAIL=<your email> to .env yourself when ready.",
    );
    return;
  }

  writeFileSync(ENV_PATH, withAdminEmail(contents, normalized), "utf-8");
  log(
    `Wrote ADMIN_EMAIL=${normalized} to .env — sign up with that address to become the first admin.`,
  );
}

// ---------------------------------------------------------------------------
// 6. Point SMTP_* at the local mailpit sink
//
// Email verification is enforced on signup, so a fresh clone with no SMTP
// config can never complete first login — the verification link has nowhere
// to land. The dev compose stack runs a mailpit sink on localhost:1025; this
// step activates the SMTP_* lines in .env to use it. A developer who later
// configures a real provider is never overwritten (withDevSmtpSink is a no-op
// when SMTP_HOST has a value).
// ---------------------------------------------------------------------------
function ensureDevSmtp() {
  const contents = readFileSync(ENV_PATH, "utf-8");
  const current = readSmtpHostValue(contents);
  if (current !== null) {
    log(`SMTP_HOST already set (${current}) — leaving it alone`);
    return;
  }
  writeFileSync(ENV_PATH, withDevSmtpSink(contents), "utf-8");
  log("pointed SMTP_* at the local mailpit sink (SMTP_HOST=localhost:1025)");
}

// ---------------------------------------------------------------------------
// 7. Start Docker services — Postgres + Redis + mailpit
//
// Uses `pnpm dev:services` (root docker-compose.dev.yml), the canonical
// local-services command referenced everywhere else in the docs.
// Starting Redis here too means queue-backed features (BullMQ
// workers, rate limiting) work out of the box without a remembered extra
// step.
// ---------------------------------------------------------------------------
function startDocker() {
  run("pnpm", ["dev:services"]);
}

// ---------------------------------------------------------------------------
// 8. Wait for Postgres + Redis (+ the mail sink when we pointed .env at it)
// ---------------------------------------------------------------------------
function parseEnvUrl(varName: string, defaultPort: number): { host: string; port: number } | null {
  const contents = readFileSync(ENV_PATH, "utf-8");
  for (const raw of contents.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(new RegExp(`^${varName}\\s*=\\s*(.*)$`));
    if (!match) continue;
    const value = (match[1] ?? "").trim().replace(/^["']|["']$/g, "");
    if (!value) return null;
    try {
      const url = new URL(value);
      const host = url.hostname || "localhost";
      const port = url.port ? Number(url.port) : defaultPort;
      return { host, port };
    } catch {
      return null;
    }
  }
  return null;
}

function tcpProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const socket = connect({ host, port });
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolveProbe(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function waitForService(
  label: string,
  envVar: string,
  defaultPort: number,
  containerHint: string,
) {
  const target = parseEnvUrl(envVar, defaultPort);
  if (!target) {
    log(`could not parse ${envVar} — skipping ${label} readiness wait`);
    return;
  }
  await waitForHostPort(label, target.host, target.port, containerHint);
}

async function waitForHostPort(label: string, host: string, port: number, containerHint: string) {
  log(`waiting for ${label} at ${host}:${port} (up to 30s)`);
  const deadline = Date.now() + 30_000;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    const ok = await tcpProbe(host, port, 1500);
    if (ok) {
      log(`${label} is accepting connections (after ${attempt} attempt(s))`);
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  fail(
    `${label} did not become ready within 30s at ${host}:${port}. ` +
      `Check Docker is running and \`docker ps\` shows the ${containerHint} container.`,
  );
}

// ---------------------------------------------------------------------------
// 9. Apply schema
// ---------------------------------------------------------------------------
function applySchema() {
  if (!existsSync("/usr/local/bin/kb-child-guard")) {
    log("Machine owner: compile and install the required native guard before retrying setup:");
    log("cc -O2 -Wall -Wextra -Werror apps/worker/src/native/child-guard.c -o /tmp/kb-child-guard");
    log("install -m 0755 /tmp/kb-child-guard /usr/local/bin/kb-child-guard");
    fail(
      "The migration wrappers require /usr/local/bin/kb-child-guard. Use packaged development or ask the machine owner to install the compiled apps/worker/src/native/child-guard.c helper before continuing; never bypass it.",
    );
  }
  run("pnpm", ["db:worktree"]);
  run("pnpm", ["db:migrate:apply"]);
}

// ---------------------------------------------------------------------------
// 10. Check global portless CLI
// ---------------------------------------------------------------------------
function checkPortless() {
  if (commandExists("portless")) {
    log("portless is available — `pnpm dev` will use https://knowledge-base.localhost");
    return;
  }
  log(
    "portless is not installed. Install it globally with `npm install -g portless` " +
      "before running `pnpm dev`, or use `pnpm dev:raw` as the manual-port fallback.",
  );
}

/** Read the SMTP_HOST/SMTP_PORT pair from .env, or null when unset. */
function readSmtpTarget(): { host: string; port: number } | null {
  const contents = readFileSync(ENV_PATH, "utf-8");
  const host = readSmtpHostValue(contents);
  if (host === null) return null;
  let port = 1025;
  for (const raw of contents.split("\n")) {
    if (raw.trim().startsWith("#")) continue;
    const match = raw.match(/^\s*SMTP_PORT\s*=\s*(\d+)\s*$/);
    if (match) {
      port = Number(match[1]);
      break;
    }
  }
  return { host, port };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  log("starting first-run setup");
  checkPnpmHome();
  ensureEnvFile();
  ensureWebEnvFile();
  ensureBetterAuthSecret();
  ensureKbMasterKey();
  await ensureAdminEmail();
  ensureDevSmtp();
  startDocker();
  await waitForService("Postgres", "DATABASE_URL", 5432, "postgres");
  await waitForService("Redis", "REDIS_URL", 6379, "redis");
  // Wait for the mail sink only when .env actually points at one — a real
  // provider configured by the developer is not ours to probe.
  const smtpTarget = readSmtpTarget();
  if (smtpTarget?.host === "localhost" || smtpTarget?.host === "127.0.0.1") {
    await waitForHostPort("Mailpit (mail sink)", smtpTarget.host, smtpTarget.port, "mailpit");
  }
  applySchema();
  checkPortless();
  installClaudeHooks();
  log("Ready. Run `pnpm dev` to start.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
