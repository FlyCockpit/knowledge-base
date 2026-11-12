#!/usr/bin/env node
/**
 * `pnpm deploy:check <url> [--commit <sha>] [--timeout <seconds>]`
 *
 * Accepts a deploy from OUTSIDE the server: polls `<url>/ready` until the app
 * reports the expected commit AND is ready, then prints PASS (exit 0). If the
 * timeout passes first it prints FAIL with what it last saw (exit 1). Needs no
 * SSH, no Docker and no credentials; any machine with Node can run it, and so
 * can CI (.github/workflows/deploy-check.yml).
 *
 * Why: Dokploy's "Deploy Success" fires when the build finishes, before
 * migrations and health checks. A refused migration or a crash loop looks like
 * a success there; here it shows up as "still serving the old commit".
 *
 * The expected commit defaults to `git rev-parse HEAD` (pull the default
 * branch first). Short and full SHAs both match (at least 7 characters).
 * Polls every 10 s: the /ready limiter allows 60 a minute per IP.
 * Exit codes: 0 pass, 1 fail, 2 usage.
 */
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

export const USAGE = `Usage: pnpm deploy:check <https://your-app.example.com> [--commit <sha>] [--timeout <seconds>]

Waits until <url>/ready reports the expected commit and is ready.
  --commit   the commit that should be live (default: git rev-parse HEAD)
  --timeout  how long to wait, in seconds (default 10800 = 3 hours, max 21600)`;

export class UsageError extends Error {}

/** @param {readonly string[]} argv */
export function parseArgs(argv) {
  /** @type {{ url: string, commit: string | null, timeoutSeconds: number }} */
  const options = { url: "", commit: null, timeoutSeconds: 10800 };
  const args = [...argv];
  /** @type {string[]} */
  const positional = [];
  while (args.length) {
    const arg = /** @type {string} */ (args.shift());
    const [flag, inline] = arg.startsWith("--") ? arg.split(/=(.*)/s, 2) : [arg, undefined];
    const value = () => {
      const next = inline ?? args.shift();
      if (!next || (inline === undefined && next.startsWith("--")))
        throw new UsageError(`${flag} needs a value.`);
      return next;
    };
    if (flag === "--commit") options.commit = value();
    else if (flag === "--timeout") options.timeoutSeconds = Number(value());
    else if (flag === "-h" || flag === "--help") throw new UsageError("");
    else if (arg.startsWith("-")) throw new UsageError(`Unknown option: ${arg}`);
    else positional.push(arg);
  }
  if (positional.length !== 1) throw new UsageError("Give exactly one URL.");
  let url;
  try {
    url = new URL(/** @type {string} */ (positional[0]));
  } catch {
    throw new UsageError("The URL is not valid (example: https://app.example.com).");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:"))
    throw new UsageError("The URL must start with https:// (http:// only for localhost).");
  if (url.username || url.password || url.search || url.hash)
    throw new UsageError("The URL must not contain credentials, a query, or a fragment.");
  options.url = url.origin;
  if (options.commit !== null) {
    options.commit = options.commit.trim().toLowerCase();
    if (!/^[0-9a-f]{7,40}$/.test(options.commit))
      throw new UsageError("--commit must be a commit SHA (7 to 40 hex characters).");
  }
  if (
    !Number.isInteger(options.timeoutSeconds) ||
    options.timeoutSeconds < 1 ||
    options.timeoutSeconds > 21600
  )
    throw new UsageError("--timeout must be a whole number of seconds between 1 and 21600.");
  return options;
}

/** Does the reported commit name the expected one? Either may be short. */
export function sameCommit(reported, expected) {
  if (typeof reported !== "string" || !expected) return false;
  const a = reported.trim().toLowerCase();
  const b = expected.trim().toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(a) || !/^[0-9a-f]{7,40}$/.test(b)) return false;
  return a.startsWith(b) || b.startsWith(a);
}

/**
 * Classify one /ready answer.
 * @param {{ status: number, body: unknown } | { error: string }} answer
 * @param {string} expected
 * @returns {{ state: "pass" | "old" | "unknown-commit" | "not-ready" | "throttled" | "unreachable", detail: string }}
 */
export function classify(answer, expected) {
  if ("error" in answer) return { state: "unreachable", detail: answer.error };
  if (answer.status === 429)
    return { state: "throttled", detail: "rate limited (429); slowing down" };
  const body = /** @type {{ ok?: unknown, commit?: unknown, checks?: unknown }} */ (
    answer.body && typeof answer.body === "object" ? answer.body : {}
  );
  if (!("commit" in body)) {
    return {
      state: "unreachable",
      detail: `HTTP ${answer.status} without a readiness answer (the app may be restarting)`,
    };
  }
  const checks = body.checks ? ` ${JSON.stringify(body.checks)}` : "";
  if (body.commit === null)
    return {
      state: "unknown-commit",
      detail:
        "the app does not know its commit (image built without git metadata; pass BUILD_VERSION=<sha> to the build)",
    };
  if (!sameCommit(body.commit, expected))
    return {
      state: "old",
      detail: `serving ${String(body.commit).slice(0, 12)}, not ${expected.slice(0, 12)} yet`,
    };
  if (answer.status !== 200 || body.ok !== true)
    return {
      state: "not-ready",
      detail: `new commit is up but not ready (HTTP ${answer.status})${checks}`,
    };
  return { state: "pass", detail: `serving ${String(body.commit).slice(0, 12)} and ready` };
}

/** One GET of <origin>/ready, never throwing. */
export async function probe(origin, { fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  try {
    const response = await fetchImpl(`${origin}/ready`, {
      headers: { accept: "application/json", "cache-control": "no-cache" },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return { status: response.status, body };
  } catch (error) {
    const cause = /** @type {{ cause?: { code?: string } }} */ (error).cause;
    return { error: cause?.code ?? (error instanceof Error ? error.message : String(error)) };
  }
}

/** "45 s" under a minute, else whole minutes ("20 min"). @param {number} seconds */
export function formatWait(seconds) {
  return seconds < 60 ? `${seconds} s` : `${Math.round(seconds / 60)} min`;
}

/**
 * Poll until pass (two answers in a row) or timeout.
 * @param {{ url: string, commit: string, timeoutSeconds: number }} options
 * @param {{ fetchImpl?: typeof fetch, pollMs?: number, now?: () => number,
 *   sleep?: (ms: number) => Promise<unknown>, log?: (line: string) => void }} [seams]
 * @returns {Promise<{ pass: boolean, last: ReturnType<typeof classify> | null }>}
 */
export async function waitForRelease(options, seams = {}) {
  const pollMs = seams.pollMs ?? 10_000;
  const now = seams.now ?? Date.now;
  const sleep = seams.sleep ?? delay;
  const log = seams.log ?? ((line) => console.log(line));
  const deadline = now() + options.timeoutSeconds * 1000;
  /** @type {ReturnType<typeof classify> | null} */
  let last = null;
  let passes = 0;
  for (;;) {
    const result = classify(
      await probe(options.url, { fetchImpl: seams.fetchImpl }),
      options.commit,
    );
    if (result.state !== last?.state || result.detail !== last?.detail)
      log(`[deploy:check] ${result.detail}`);
    last = result;
    passes = result.state === "pass" ? passes + 1 : 0;
    if (passes >= 2) return { pass: true, last };
    const wait = result.state === "throttled" ? pollMs * 3 : pollMs;
    if (now() + wait > deadline) return { pass: false, last };
    await sleep(wait);
  }
}

/** Plain-English next step for a failed check. */
export function failureHint(last) {
  switch (last?.state) {
    case "old":
      return "The new release never started serving. Open the app's logs in Dokploy: a refused migration or a crash at startup is printed there. For a deeper look on the server, run `pnpm dokploy:verify` (docs/deploy.md § Confirming a deploy is live).";
    case "not-ready":
      return "The new release is up but not ready: a database, Redis or the background jobs are not reachable. Check the app's logs in Dokploy.";
    case "unknown-commit":
      return "The app cannot say which commit it runs. Rebuild with git metadata or BUILD_VERSION (docs/deploy.md § Confirming a deploy is live).";
    default:
      return "The app did not answer. Check that the URL is right, that the domain points at the server, and the app's logs in Dokploy.";
  }
}

function localHead() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(error.message ? `${error.message}\n\n${USAGE}` : USAGE);
      return error.message ? 2 : 0;
    }
    throw error;
  }
  const commit = options.commit ?? localHead();
  if (!commit) {
    console.error("Could not read the local commit (git rev-parse HEAD). Pass --commit <sha>.");
    return 2;
  }
  console.log(
    `[deploy:check] waiting up to ${formatWait(options.timeoutSeconds)} for ${options.url} to serve ${commit.slice(0, 12)}${options.commit ? "" : " (your local HEAD)"} …`,
  );
  const result = await waitForRelease({ ...options, commit });
  if (result.pass) {
    console.log(`PASS: ${options.url} is serving ${commit.slice(0, 12)} and is ready.`);
    return 0;
  }
  console.log(`FAIL: ${options.url} is not serving ${commit.slice(0, 12)} and ready.`);
  console.log(`      Last seen: ${result.last?.detail ?? "nothing"}`);
  console.log(`      ${failureHint(result.last)}`);
  return 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
