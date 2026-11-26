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
import { createServer } from "node:net";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

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
      let value: unknown = JSON.parse(await run(["eval", "--stdin"], script));
      if (typeof value === "string") value = JSON.parse(value);
      return value as T;
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
 * Signs the session in as a mock `role` (the `starter-mock` cookie) and
 * records a decided cookie consent, so the banner is not part of what a check
 * measures. Leaves the browser on the sign-in page.
 */
export async function mockSession(
  { base, browser }: CheckRun,
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
  await browser.run([
    "eval",
    "localStorage.setItem('starter.consent.v1', JSON.stringify({ v: 1, analytics: false, decidedAt: Date.now() })); true",
  ]);
}
