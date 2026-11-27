/**
 * Shared plumbing for the real-browser checks (`pnpm check:layout`,
 * `pnpm check:dialogs`, `pnpm check:shell-loading`;
 * patterns/agent-ui-testing.md): one agent-browser session per check, a mock
 * dev server started on a free port (or a running app passed with `--url`),
 * and the mock session cookie. What differs per app (how to sign in, which
 * dialogs and pages to measure) lives in `browser-checks.config.ts`; this
 * file stays identical to the template's. Not part of CI: it needs
 * agent-browser and its Chromium.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { createServer } from "node:net";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

/**
 * The agent-browser session of one check run: `<prefix><check>-<pid>`. The
 * process id keeps two runs at once (two checkouts, two agents) out of each
 * other's browser; `BROWSER_CHECK_SESSION_PREFIX` (optional) lets a harness
 * tell its runs' sessions apart from everyone else's.
 */
/**
 * Reads `agent-browser eval` output. It prints the script's value as JSON, and
 * page scripts return `JSON.stringify(...)`, so a string value is parsed once
 * more. A page script must therefore never return a bare string: wrap it in
 * `JSON.stringify` like every other result.
 */
export function parseEvalOutput(out: string): unknown {
  const value: unknown = JSON.parse(out);
  return typeof value === "string" ? JSON.parse(value) : value;
}

export function sessionName(
  check: string,
  prefix = process.env.BROWSER_CHECK_SESSION_PREFIX ?? "",
  pid = process.pid,
): string {
  return `${prefix}${check}-${pid}`;
}

interface Browser {
  /** One agent-browser command; resolves with its trimmed stdout. */
  run(args: string[], input?: string): Promise<string>;
  /** Runs a script in the page and parses the JSON string it returns. */
  evalJson<T>(script: string): Promise<T>;
  close(): void;
}

/**
 * An agent-browser session. Commands are asynchronous, so a signal (Ctrl+C, a
 * kill) is handled between commands instead of after the whole run.
 */
function agentBrowser(session: string): Browser {
  const run = (args: string[], input?: string) =>
    new Promise<string>((done, fail) => {
      const child = spawn("agent-browser", ["--session", session, ...args], {
        stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
        out += chunk;
      });
      child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
        err += chunk;
      });
      child.on("error", fail);
      child.on("close", (code) =>
        code === 0
          ? done(out.trim())
          : fail(new Error(`agent-browser ${args.join(" ")} exited ${code}: ${err.trim()}`)),
      );
      if (input !== undefined) child.stdin?.end(input);
    });
  return {
    run,
    async evalJson<T>(script: string): Promise<T> {
      return parseEvalOutput(await run(["eval", "--stdin"], script)) as T;
    },
    close() {
      try {
        execFileSync("agent-browser", ["--session", session, "close"], { stdio: "ignore" });
      } catch {}
    },
  };
}

async function freePort(): Promise<number> {
  return await new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => done(typeof address === "object" && address ? address.port : 0));
    });
  });
}

async function waitFor(url: string, ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`mock dev server did not answer ${url} within ${ms / 1000}s`);
}

/** SIGTERM the process group, then SIGKILL whatever is left after 5 seconds. */
function stopGroup(pid: number | undefined): void {
  if (!pid) return;
  const alive = () => {
    try {
      process.kill(-pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    return;
  }
  const until = Date.now() + 5000;
  while (alive() && Date.now() < until)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  if (alive()) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
  }
}

function mockCookie(
  role: string,
  overrides: Record<string, string> = {},
  scenario = "default",
): string {
  return encodeURIComponent(JSON.stringify({ role, scenario, overrides, locale: "en-US" }));
}

export interface CheckRun {
  base: string;
  browser: Browser;
  args: string[];
}

export interface BrowserOptions {
  /** Extra `agent-browser open` options for the launch (`--init-script <file>`). */
  launch?: string[];
  /**
   * Start a mock-mode dev server when no `--url` is given (default). An app
   * without mock mode sets `mockServer: false` and is checked against a
   * running stack: `--url` is then required.
   */
  mockServer?: boolean;
}

/**
 * Runs `body` with the app (a mock dev server of its own, unless `--url` is
 * given) and an open agent-browser session, and tears both down on every exit
 * path, signals included. Returns the process exit code: 1 when `body`
 * reports failures (or the app cannot be reached), 0 otherwise.
 */
export async function withBrowser(
  name: string,
  session: string,
  body: (run: CheckRun) => Promise<string[]>,
  { launch = [], mockServer = true }: BrowserOptions = {},
): Promise<number> {
  const args = process.argv.slice(2);
  const urlIndex = args.indexOf("--url");
  let base = urlIndex >= 0 ? args[urlIndex + 1] : undefined;
  let server: ReturnType<typeof spawn> | undefined;
  if (!base && !mockServer) {
    console.error(`${name}: this app has no mock mode; pass --url <the running app>`);
    return 1;
  }
  if (!base) {
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    server = spawn(
      "pnpm",
      [
        "-F",
        "web",
        "exec",
        "vite",
        "dev",
        "--port",
        String(port),
        "--strictPort",
        "--host",
        "127.0.0.1",
      ],
      { cwd: ROOT, env: { ...process.env, VITE_MOCK: "1" }, detached: true, stdio: "ignore" },
    );
    server.on("error", (error) => console.error(`${name}: mock dev server: ${error.message}`));
    console.log(`${name}: mock dev server on ${base}`);
  }
  const browser = agentBrowser(session);
  // The server runs in its own process group (detached), so Ctrl+C on this
  // script does not reach it: stop it on every exit path, signals included.
  const stopServer = () => stopGroup(server?.pid);
  const onSignal = (signal: NodeJS.Signals) => {
    stopServer();
    browser.close();
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  let failures: string[] = [];
  try {
    await waitFor(`${base}/en-US`, 120_000);
    await browser.run([
      "open",
      "about:blank",
      ...launch,
      ...(args.includes("--no-sandbox") ? ["--args", "--no-sandbox"] : []),
    ]);
    failures = await body({ base, browser, args });
  } catch (error) {
    // A missing precondition (no running app, a seeded row that is not there)
    // ends the run with what to do, not a stack trace.
    failures = [`stopped: ${(error as Error).message.split("\n")[0]}`];
  } finally {
    browser.close();
    stopServer();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
  for (const failure of failures) console.error(`${name}: ${failure}`);
  console.log(failures.length ? `${name}: ${failures.length} failure(s)` : `${name}: passed`);
  return failures.length ? 1 : 0;
}

/**
 * Records a decided cookie consent on the open page's origin
 * (`apps/web/src/lib/consent.ts`), so the banner is not part of what a check
 * measures.
 */
export async function decideConsent({ browser }: Pick<CheckRun, "browser">): Promise<void> {
  await browser.run([
    "eval",
    "localStorage.setItem('knowledge-base.consent.v1', JSON.stringify({ v: 1, analytics: false, decidedAt: Date.now() })); true",
  ]);
}

/**
 * Signs the session in as a mock `role` (the `starter-mock` cookie) and
 * records a decided cookie consent, so the banner is not part of what a check
 * measures. Leaves the browser on the sign-in page.
 */
export async function mockSession(
  { base, browser }: Pick<CheckRun, "base" | "browser">,
  role: string,
  overrides: Record<string, string> = {},
  /** "default", "empty", "error" or "slow" (every procedure answers after 2s). */
  scenario = "default",
): Promise<void> {
  const origin = new URL(base);
  await browser.run([
    "cookies",
    "set",
    "starter-mock",
    mockCookie(role, overrides, scenario),
    "--domain",
    origin.hostname,
    "--path",
    "/",
  ]);
  await browser.run(["open", `${base}/en-US/login`]);
  await decideConsent({ browser });
}

/**
 * The cases grouped by role (the listed order within each role, the roles in
 * order of first appearance), so a real stack signs in once per role, not
 * once per case.
 */
export function byRole<T extends { role: string }>(cases: T[]): T[] {
  const roles = [...new Set(cases.map((item) => item.role))];
  return roles.flatMap((role) => cases.filter((item) => item.role === role));
}

/** CDP's errors for an evaluation cut off by a page load (not a closed browser or session). */
const PAGE_NAVIGATED =
  /Inspected target navigated|Execution context was destroyed|Cannot find context with specified id/;

type Run = (args: string[], input?: string) => Promise<string>;
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/**
 * Polls `probe` (a page expression that is a string once there, else null) with
 * one short evaluation at a time, every 500ms for 20s at most. Never one long
 * in-page loop: a sign-in that ends in a full page load (`window.location.assign`
 * in login.tsx) aborts any evaluation still running in the old page
 * ("Inspected target navigated or closed"), so a navigation only means "look
 * again". Resolves with the probe's string, or `still on <path> after 20s`;
 * rejects at once on any other failure (a closed browser), and with the
 * navigation error if the page was still navigating at the end.
 */
export async function pollPage(run: Run, probe: string, pause = sleep): Promise<string> {
  let last = "an unknown page";
  let navigating: unknown;
  for (let i = 0; i < 40; i++) {
    try {
      const step: unknown = JSON.parse(await run(["eval", probe]));
      if (typeof step === "string") return step;
      last = JSON.parse(await run(["eval", "location.pathname"])) as string;
      navigating = undefined;
    } catch (error) {
      if (!PAGE_NAVIGATED.test(String(error))) throw error;
      navigating = error;
    }
    await pause(500);
  }
  // Still mid-navigation after 20s: that error says more than the last page seen.
  if (navigating) throw navigating;
  return `still on ${last} after 20s`;
}

/** Types a value into a React-controlled input through the native setter. */
function fillScript(selector: string, value: string): string {
  return `(() => { const el = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`;
}

const PASSWORD = "input[autocomplete=current-password]";

/** The sign-in form once React has hydrated it ("ready"); a submit before that reloads the page. */
const FORM_HYDRATED = `(() => { const form = document.querySelector(${JSON.stringify(PASSWORD)})?.form; return form && Object.keys(form).some((key) => key.startsWith("__reactProps")) ? "ready" : null; })()`;

/** Clicks Verify (the button after the code field) once React has enabled it for the typed code. */
const VERIFY_CODE = `(() => { const button = document.getElementById("totp-code")?.closest("div")?.nextElementSibling; if (!button || button.disabled) return null; button.click(); return "clicked"; })()`;

export interface Account {
  email: string;
  password: string;
  /** A current one-time code, for an account with a second factor. */
  totp?: () => string;
}

/**
 * Signs in through the app's own sign-in form (a running stack, not mock
 * mode) and records a decided cookie consent. It asks for `landing` as the
 * `redirectTo`, so the sign-in ends in a full page load there; every wait
 * after the submit is a `pollPage`, which survives that load. The password and
 * the code go to the page over stdin, so they never appear in a process's
 * arguments or in a failure message.
 */
export async function formSignIn(
  { base, browser }: CheckRun,
  account: Account,
  landing = "/en-US/settings",
  pause = sleep,
): Promise<void> {
  const run: Run = (args, input) => browser.run(args, input);
  const at = `location.pathname === ${JSON.stringify(landing)} ? "app" : null`;
  await run(["open", `${base}/en-US/login?redirectTo=${encodeURIComponent(landing)}`]);
  // A dev server's first load can outlast agent-browser's 25s limit for one wait.
  for (let attempt = 1; ; attempt++) {
    try {
      await run(["wait", PASSWORD]);
      break;
    } catch (error) {
      if (attempt === 4) throw error;
    }
  }
  if ((await pollPage(run, FORM_HYDRATED, pause)) !== "ready")
    throw new Error("the sign-in form did not hydrate within 20s");
  await run(["eval", "--stdin"], fillScript("input[type=email]", account.email));
  try {
    await run(["eval", "--stdin"], fillScript(PASSWORD, account.password));
  } catch {
    // agent-browser may echo the failing script; never pass its output on.
    throw new Error("could not type the password into the sign-in form");
  }
  // Submitted in the page, not clicked: a click lands on whatever covers the button.
  await run([
    "eval",
    `document.querySelector(${JSON.stringify(PASSWORD)}).form.requestSubmit(); true`,
  ]);
  const step = await pollPage(
    run,
    `location.pathname === ${JSON.stringify(landing)} ? "app" : document.getElementById("totp-code") ? "code" : null`,
    pause,
  );
  if (step === "code") {
    if (!account.totp) throw new Error(`${account.email} has a second factor and no code source`);
    try {
      await run(["eval", "--stdin"], fillScript("#totp-code", account.totp()));
    } catch {
      throw new Error("could not type the verification code");
    }
    if ((await pollPage(run, VERIFY_CODE, pause)) !== "clicked")
      throw new Error("the Verify button did not enable for the typed code");
    const done = await pollPage(run, at, pause);
    if (done !== "app")
      throw new Error(`the verification code was not accepted (${done}); is the clock right?`);
  } else if (step !== "app") {
    throw new Error(
      `sign-in did not open the app (${step}); check the account's password, or reseed it`,
    );
  }
  await decideConsent({ browser });
}

/**
 * The current RFC 6238 code (6 digits, 30s) for a TOTP secret: a string is
 * keyed on its UTF-8 bytes as Better-Auth keys it
 * (packages/auth/src/e2e-credentials.ts `totpCode`), bytes as they are (a
 * decoded authenticator key).
 */
export function totpCode(secret: string | Uint8Array, nowMs = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(nowMs / 30_000)));
  const key = typeof secret === "string" ? Buffer.from(secret, "utf8") : secret;
  const mac = createHmac("sha1", key).update(counter).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 15;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}
