#!/usr/bin/env node
/**
 * `pnpm deploy:generate-admin [--url <origin>] [--email <address>]`
 *
 * Creates the FIRST admin of a deploy that has `SETUP_KEY` set, without email:
 * asks for the app's URL, the setup key (not echoed) and the admin's email
 * (ADMIN_EMAIL in production), calls `POST <url>/api/setup/admin`, and prints
 * a one-time set-password link. Open it, choose a password, sign in, then
 * REMOVE `SETUP_KEY` and redeploy.
 *
 * No password crosses the wire: the server answers with a short-lived
 * set-password link (apps/server/src/setup-routes.ts). The admin account is
 * created when the link is spent, and that completes the bootstrap. The route
 * refuses once bootstrap is complete. Re-running before then prints a fresh
 * link (the earlier one stops working).
 *
 * Scripted use: pass --url and --email, and pipe the key on stdin
 * (`printf '%s\n' "$KEY" | pnpm deploy:generate-admin --url … --email …`).
 * The key is never accepted as an argument — arguments end up in shell
 * history and process listings.
 *
 * Exit codes: 0 link printed, 1 refused or failed, 2 usage.
 */
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export const SETUP_PATH = "/api/setup/admin";

export const USAGE = `Usage: pnpm deploy:generate-admin [--url <https://your-app.example.com>] [--email <you@example.com>]

Creates the first admin on a deploy that has SETUP_KEY set and prints a
one-time set-password link. In production the email must be ADMIN_EMAIL.
Asks for anything not given; the setup key is always read from the terminal
(not echoed) or from stdin, never from argv.`;

export class UsageError extends Error {}

/** @param {readonly string[]} argv */
export function parseArgs(argv) {
  /** @type {{ url: string | null, email: string | null }} */
  const options = { url: null, email: null };
  const args = [...argv];
  while (args.length) {
    const arg = /** @type {string} */ (args.shift());
    const [flag, inline] = arg.startsWith("--") ? arg.split(/=(.*)/s, 2) : [arg, undefined];
    const value = () => {
      const next = inline ?? args.shift();
      if (!next || (inline === undefined && next.startsWith("--")))
        throw new UsageError(`${flag} needs a value.`);
      return next;
    };
    if (flag === "--url") options.url = value();
    else if (flag === "--email") options.email = value();
    else if (flag === "--key")
      throw new UsageError(
        "The setup key is never taken as an argument; type it at the prompt or pipe it on stdin.",
      );
    else if (flag === "-h" || flag === "--help") throw new UsageError("");
    else throw new UsageError(`Unknown argument: ${arg}`);
  }
  return options;
}

/**
 * The app's origin. https only, except plain http to this machine — the setup
 * key travels in the request body.
 * @param {string} raw
 */
export function parseOrigin(raw) {
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new UsageError("The URL is not valid (example: https://kb.example.com).");
  }
  const local =
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.hostname.endsWith(".localhost");
  if (url.protocol !== "https:" && !(local && url.protocol === "http:"))
    throw new UsageError("The URL must start with https:// (http:// only for localhost).");
  if (url.username || url.password || url.search || url.hash)
    throw new UsageError("The URL must not contain credentials, a query, or a fragment.");
  return url.origin;
}

/** @param {string} raw */
export function parseEmail(raw) {
  const email = raw.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)
    throw new UsageError("That doesn't look like an email address.");
  return email;
}

/**
 * One POST to the setup route, never throwing. `redirect: "manual"`: a
 * redirect must never carry the key to another address.
 * @param {string} origin
 * @param {{ key: string, email: string }} body
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [seams]
 * @returns {Promise<{ status: number, body: unknown, retryAfter: string | null } | { error: string }>}
 */
export async function requestLink(origin, body, { fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  try {
    const response = await fetchImpl(`${origin}${SETUP_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    return {
      status: response.status,
      body: parsed,
      retryAfter: response.headers.get("retry-after"),
    };
  } catch (error) {
    const cause = /** @type {{ cause?: { code?: string } }} */ (error).cause;
    return { error: cause?.code ?? (error instanceof Error ? error.message : String(error)) };
  }
}

/**
 * Turn the server's answer into what to print.
 * @param {Awaited<ReturnType<typeof requestLink>>} answer
 * @returns {{ ok: true, url: string, expiresAt: string, email: string } | { ok: false, message: string }}
 */
export function interpret(answer) {
  if ("error" in answer)
    return {
      ok: false,
      message: `Could not reach the app (${answer.error}). Check the URL and that the app is running.`,
    };
  const body = /** @type {Record<string, unknown>} */ (
    answer.body && typeof answer.body === "object" ? answer.body : {}
  );
  const code = typeof body.error === "string" ? body.error : null;
  if (
    answer.status === 200 &&
    typeof body.url === "string" &&
    typeof body.expiresAt === "string" &&
    typeof body.email === "string"
  ) {
    return { ok: true, url: body.url, expiresAt: body.expiresAt, email: body.email };
  }
  if (answer.status >= 300 && answer.status < 400)
    return {
      ok: false,
      message: `The app answered with a redirect (HTTP ${answer.status}); the key was not resent. Use the app's final https:// origin.`,
    };
  if (answer.status === 404)
    return {
      ok: false,
      message:
        "The setup route is not enabled there: SETUP_KEY is not set on that deploy (or the URL is not this app). Set SETUP_KEY (32+ characters), redeploy, and run this again.",
    };
  if (answer.status === 401) return { ok: false, message: "Wrong setup key." };
  if (answer.status === 400)
    return { ok: false, message: "The server rejected that email address." };
  if (answer.status === 413)
    return {
      ok: false,
      message: "The request was too large (the setup key is at most 512 characters).",
    };
  if (answer.status === 429)
    return {
      ok: false,
      message: `Too many attempts from this address. Try again in ${answer.retryAfter ?? "a few"} seconds.`,
    };
  if (answer.status === 409) {
    switch (code) {
      case "bootstrap_complete":
        return {
          ok: false,
          message:
            "Bootstrap is already complete (an admin was created, or accounts already exist), so SETUP_KEY can never create another admin. Sign in as that admin, and remove SETUP_KEY from the environment.",
        };
      case "email_not_allowed":
        return {
          ok: false,
          message:
            "The server does not accept that address as the first admin. In production it must be exactly ADMIN_EMAIL, and ADMIN_EMAIL must be set on the deploy.",
        };
      case "password_signin_disabled":
        return {
          ok: false,
          message:
            "FORCE_SSO is on, so password sign-in is disabled and a new admin could never sign in. Unset FORCE_SSO for the setup, or remove SETUP_KEY.",
        };
    }
  }
  if (answer.status === 503)
    return {
      ok: false,
      message: "The app is temporarily unavailable (HTTP 503). Try again shortly.",
    };
  return {
    ok: false,
    message: `Unexpected answer from the app (HTTP ${answer.status}${code ? `: ${code}` : ""}). Check the app's logs.`,
  };
}

/** @param {{ url: string, expiresAt: string, email: string }} result */
export function successText(result, now = new Date()) {
  const minutes = Math.max(0, Math.round((Date.parse(result.expiresAt) - now.getTime()) / 60_000));
  return [
    `Setup link for the admin ${result.email} (any earlier link no longer works).`,
    "",
    "Open it to choose the password; that creates the account (one use, expires in about " +
      minutes +
      " minutes):",
    "",
    `  ${result.url}`,
    "",
    "Then sign in, set up two-factor authentication when asked, and REMOVE SETUP_KEY",
    "from the app's environment and redeploy. Admins see a warning until you do.",
  ].join("\n");
}

/**
 * Read answers: the terminal when interactive (key not echoed), else lines
 * from stdin in the order asked.
 */
function createAsker() {
  const interactive = Boolean(process.stdin.isTTY);
  if (interactive) {
    return {
      /** @param {string} message @param {boolean} secret */
      async ask(message, secret) {
        const { input, password } = await import("@inquirer/prompts");
        const io = { output: process.stderr };
        return secret
          ? password({ message }, io)
          : input({ message, validate: (v) => v.trim() !== "" || "Required" }, io);
      },
      close() {},
    };
  }
  const rl = createInterface({ input: process.stdin });
  /** @type {string[]} */
  const queue = [];
  /** @type {((line: string | null) => void) | null} */
  let waiter = null;
  let ended = false;
  rl.on("line", (line) => {
    if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve(line);
    } else queue.push(line);
  });
  rl.on("close", () => {
    ended = true;
    if (waiter) waiter(null);
  });
  return {
    /** @param {string} message @param {boolean} _secret */
    async ask(message, _secret) {
      process.stderr.write(`${message}: `);
      const line =
        queue.shift() ??
        (ended
          ? null
          : await new Promise((resolve) => {
              waiter = resolve;
            }));
      process.stderr.write("\n");
      if (line === null) throw new UsageError(`Input ended before "${message}" was answered.`);
      return line.replace(/\r$/, "");
    },
    close() {
      rl.close();
    },
  };
}

/** @param {readonly string[]} argv */
export async function main(argv, { fetchImpl = fetch } = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    if (error.message) console.error(error.message);
    console.error(USAGE);
    return 2;
  }
  const asker = createAsker();
  try {
    const origin = parseOrigin(options.url ?? (await asker.ask("App URL (https://…)", false)));
    const key = await asker.ask("Setup key (SETUP_KEY; not shown)", true);
    if (!key) throw new UsageError("The setup key is required.");
    const email = parseEmail(
      options.email ?? (await asker.ask("Admin email (ADMIN_EMAIL in production)", false)),
    );
    const result = interpret(await requestLink(origin, { key, email }, { fetchImpl }));
    if (!result.ok) {
      console.error(`[deploy:generate-admin] ${result.message}`);
      return 1;
    }
    console.log(successText(result));
    return 0;
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`[deploy:generate-admin] ${error.message}`);
    return 2;
  } finally {
    asker.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
