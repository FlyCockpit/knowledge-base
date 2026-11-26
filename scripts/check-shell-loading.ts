/**
 * `pnpm check:shell-loading`: hard-reloads signed-in pages on a throttled
 * network and CPU (mock mode, slow responses) and checks that what paints
 * first is already the app: the real header and bottom nav, in the stored
 * theme, with only the content area as a skeleton, and that nothing outside
 * the content moves until the page has loaded.
 * Rule: patterns/loading-and-errors.md § Route pending states
 * Usage: patterns/agent-ui-testing.md § Shell loading check
 *
 *   pnpm check:shell-loading                  starts its own mock dev server
 *   pnpm check:shell-loading --url http://127.0.0.1:3001   uses a running one
 *   pnpm check:shell-loading --no-sandbox     Ubuntu 23.10+ (AppArmor) Chromium
 *
 * An init script records, on every animation frame from the start of the
 * document, the boxes of the header (`[data-app-header]`), the bottom nav
 * (`[data-bottom-nav]`) and `<main>`, the theme class and whether the content
 * skeleton shows, plus the page's layout shifts. For each page, at 1280×800
 * and 390×844 with the stored theme dark and the OS light, on the pages in
 * `SHELL_PAGES` (scripts/browser-checks.config.ts), it fails when:
 * - the first painted frame has no header or `<main>` (a frame without the
 *   shell), or no bottom nav where the loaded page has one;
 * - any later frame loses the header;
 * - the header, the bottom nav or the top of `<main>` moves by more than 1px
 *   between the first paint and the loaded page;
 * - a painted frame is in the other theme;
 * - the first paint is not the content skeleton (a blank or spinner frame);
 * - cumulative layout shift exceeds 0.05.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type CheckRun, withBrowser } from "./browser-check-lib.ts";
import { MOCK_SERVER, SHELL_PAGES, signIn } from "./browser-checks.config.ts";

// One session per run, so runs in other checkouts on this machine are untouched.
const SESSION = `check-shell-loading-${process.pid}`;
const MAX_CLS = 0.05;

type Box = [left: number, top: number, width: number, height: number];

/** One animation frame as the init script saw it. */
export interface ShellFrame {
  t: number;
  /** Anything visible in the body yet. */
  painted: boolean;
  header: Box | null;
  bottomNav: Box | null;
  main: Box | null;
  dark: boolean;
  /** The route content skeleton (`[data-route-skeleton]`) is in `<main>`. */
  skeleton: boolean;
  /** Any skeleton block (`[data-slot=skeleton]`) is in `<main>`: the route's or a query's. */
  loading: boolean;
  /** Without a header: the start of what the page showed instead, for the report. */
  instead?: string;
}

export interface ShellRecording {
  frames: ShellFrame[];
  /** The loaded page, measured after the content arrived. */
  final: ShellFrame;
  cls: number;
}

function moved(a: Box | null, b: Box | null): boolean {
  if (!a || !b) return a !== b;
  return a.some((value, index) => Math.abs(value - (b[index] ?? 0)) > 1);
}

const show = (box: Box | null) => (box ? `${box[0]},${box[1]} ${box[2]}×${box[3]}` : "none");

/** Returns one message per broken rule; empty means the page loads inside its shell. */
export function judgeShellLoading(
  label: string,
  recording: ShellRecording,
  expectDark: boolean,
): string[] {
  const bad: string[] = [];
  const { final } = recording;
  const painted = recording.frames.filter((frame) => frame.painted);
  const first = painted[0];
  if (!first) return [`${label}: no painted frame was recorded`];
  // Geometry compared against a page that is still loading proves nothing.
  if (final.skeleton || final.loading)
    return [`${label}: the page never finished loading (a skeleton is still on screen)`];
  if (!final.header || !final.main)
    return [`${label}: the loaded page has no ${final.header ? "<main>" : "header"}`];
  if (!first.header) bad.push(`${label}: the first painted frame has no header`);
  if (!first.main) bad.push(`${label}: the first painted frame has no <main>`);
  if (final.bottomNav && !first.bottomNav)
    bad.push(`${label}: the first painted frame has no bottom nav`);
  if (!first.skeleton) bad.push(`${label}: the first painted frame is not the content skeleton`);
  const lost = painted.find((frame) => !frame.header);
  if (lost)
    bad.push(
      `${label}: the header is missing ${Math.round(lost.t)}ms into the load${lost.instead ? ` (showing: ${lost.instead})` : ""}`,
    );
  // Every painted frame has the parts the loaded page has, not only the first.
  const gone = painted.find(
    (frame) => (final.main && !frame.main) || (final.bottomNav && !frame.bottomNav),
  );
  if (gone)
    bad.push(
      `${label}: the ${gone.main ? "bottom nav" : "<main>"} is missing ${Math.round(gone.t)}ms into the load`,
    );
  for (const [part, pick] of [
    ["header", (frame: ShellFrame) => frame.header],
    ["bottom nav", (frame: ShellFrame) => frame.bottomNav],
  ] as const) {
    const jump = painted.find((frame) => pick(frame) && moved(pick(frame), pick(final)));
    if (jump)
      bad.push(
        `${label}: the ${part} moves while loading (${show(pick(jump))} at ${Math.round(jump.t)}ms, ${show(pick(final))} loaded)`,
      );
  }
  const mainTop = painted.find((frame) => frame.main && frame.main[1] !== final.main?.[1]);
  if (mainTop?.main && final.main)
    bad.push(
      `${label}: the content area starts at ${mainTop.main[1]}px while loading, ${final.main[1]}px loaded`,
    );
  const loadedAt = painted.findIndex((frame) => !frame.skeleton && !frame.loading);
  const relapse =
    loadedAt >= 0 ? painted.slice(loadedAt).find((frame) => frame.skeleton) : undefined;
  if (relapse)
    bad.push(
      `${label}: the page had loaded, then went back to the route skeleton ${Math.round(relapse.t)}ms into the load (something in the shell suspended)`,
    );
  const wrongTheme = painted.find((frame) => frame.dark !== expectDark);
  if (wrongTheme)
    bad.push(
      `${label}: a frame ${Math.round(wrongTheme.t)}ms into the load is ${wrongTheme.dark ? "dark" : "light"}, the stored theme is ${expectDark ? "dark" : "light"}`,
    );
  if (recording.cls > MAX_CLS)
    bad.push(`${label}: cumulative layout shift ${recording.cls.toFixed(3)} exceeds ${MAX_CLS}`);
  return bad;
}

// Registered before the first navigation; runs at document start in every
// frame of the page. Self-contained.
export const INIT_SCRIPT = `(() => {
  if (window.top !== window) return;
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.width || r.height ? [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] : null;
  };
  // The element the user sees: React hides a suspended tree with display:none
  // and shows the fallback beside it, so the first match may have no box.
  // A box alone is not enough: visibility:hidden keeps the box.
  const seen = (selector) => [...document.querySelectorAll(selector)].find((el) => box(el) && getComputedStyle(el).visibility === "visible") || null;
  const snap = () => {
    const body = document.body;
    const painted = !!body && [...body.querySelectorAll("*")].some((el) => {
      if (el.tagName === "SCRIPT" || el.tagName === "STYLE") return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
    });
    return {
      t: performance.now(),
      painted,
      header: box(seen("[data-app-header]")),
      bottomNav: box(seen("[data-bottom-nav]")),
      main: box(seen("#main-content")),
      dark: document.documentElement.classList.contains("dark"),
      skeleton: !!seen("#main-content [data-route-skeleton]"),
      loading: !!seen('#main-content [data-slot="skeleton"]'),
      // Structure only, never text: a signed-in page can show private
      // documents, which must not reach the check's output.
      instead: seen("[data-app-header]") || !body ? undefined : "(" + [...body.children].map((el) => el.tagName.toLowerCase() + (el.id ? "#" + el.id : "")).join(" ") + ")",
    };
  };
  const frames = [];
  window.__shellFrames = frames;
  window.__shellSnap = snap;
  window.__shellCls = 0;
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) if (!entry.hadRecentInput) window.__shellCls += entry.value;
    }).observe({ type: "layout-shift", buffered: true });
  } catch {}
  const tick = () => {
    if (frames.length < 2000) frames.push(snap());
    if (!window.__shellDone) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();`;

const READ = `(() => {
  window.__shellDone = true;
  return JSON.stringify({ frames: window.__shellFrames || [], final: window.__shellSnap(), cls: Math.round((window.__shellCls || 0) * 1000) / 1000 });
})()`;

/**
 * Throttles the active page through the DevTools protocol (agent-browser has
 * no throttling command): a slow connection and a 4× slower CPU, so the first
 * paint, hydration and the auth check are each long enough to be seen. The
 * emulation lasts while the returned socket stays open.
 */
async function throttle(run: CheckRun): Promise<() => void> {
  const endpoint = await run.browser.run(["get", "cdp-url"]);
  const socket = new WebSocket(endpoint.trim());
  await new Promise((done, fail) => {
    socket.addEventListener("open", done, { once: true });
    socket.addEventListener("error", () => fail(new Error(`no DevTools socket at ${endpoint}`)), {
      once: true,
    });
  });
  let id = 0;
  const pending = new Map<number, (message: { result?: unknown; error?: unknown }) => void>();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown };
    if (message.id !== undefined) pending.get(message.id)?.(message);
  });
  const send = (method: string, params: object = {}, sessionId?: string) =>
    new Promise<Record<string, unknown>>((done, fail) => {
      id += 1;
      pending.set(id, (message) =>
        message.error
          ? fail(new Error(`${method}: ${JSON.stringify(message.error)}`))
          : done((message.result ?? {}) as Record<string, unknown>),
      );
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  const { targetInfos } = (await send("Target.getTargets")) as {
    targetInfos: { targetId: string; type: string; url: string }[];
  };
  const page = targetInfos.find(
    (target) => target.type === "page" && target.url.startsWith("http"),
  );
  if (!page) throw new Error("no page target to throttle");
  const { sessionId } = (await send("Target.attachToTarget", {
    targetId: page.targetId,
    flatten: true,
  })) as { sessionId: string };
  await send("Network.enable", {}, sessionId);
  await send(
    "Network.emulateNetworkConditions",
    {
      offline: false,
      latency: 150,
      downloadThroughput: (4 * 1024 * 1024) / 8,
      uploadThroughput: (1024 * 1024) / 8,
    },
    sessionId,
  );
  await send("Emulation.setCPUThrottlingRate", { rate: 4 }, sessionId);
  return () => socket.close();
}

/**
 * Until the page's loaded-only marker is there and no skeleton is left in
 * `<main>` (60s at most), then one more second for late layout.
 */
async function waitLoaded({ browser }: CheckRun, ready: string): Promise<void> {
  const loaded = `!!document.querySelector(${JSON.stringify(ready)}) && !document.querySelector('#main-content [data-slot="skeleton"], #main-content [data-route-skeleton]')`;
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    if ((await browser.run(["eval", loaded])) === "true") {
      await browser.run(["wait", "1000"]);
      return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`still loading after 60s (waiting for ${ready} and no skeleton)`);
}

const VIEWPORTS = [
  [1280, 800],
  [390, 844],
] as const;

async function measure(run: CheckRun): Promise<string[]> {
  const { base, browser } = run;
  const failures: string[] = [];
  // Stored dark, OS light: the first frame must already follow the stored choice.
  await browser.run(["set", "media", "light"]);
  for (const [w, h] of VIEWPORTS) {
    await browser.run(["set", "viewport", String(w), String(h)]);
    for (const page of SHELL_PAGES) {
      const label = `${page.name} ${w}×${h}`;
      // Slow responses (2s per call) keep the auth check and the page's data
      // pending long enough to be recorded.
      await signIn(run, page.role);
      await browser.run(["eval", "localStorage.setItem('vite-ui-theme', 'dark'); true"]);
      // Warm the dev server's module graph, so the measured load is the app's,
      // not Vite's first transform.
      await browser.run(["open", `${base}${page.path}`]);
      await browser.run(["wait", page.ready]);
      await signIn(run, page.role, { slow: true });
      await browser.run(["eval", "localStorage.setItem('vite-ui-theme', 'dark'); true"]);
      const release = await throttle(run);
      try {
        await browser.run(["open", `${base}${page.path}`]);
        await waitLoaded(run, page.ready);
        const recording = await browser.evalJson<ShellRecording>(READ);
        failures.push(...judgeShellLoading(label, recording, true));
        const firstPaint = recording.frames.find((frame) => frame.painted);
        console.log(
          `check:shell-loading: ${label}: ${recording.frames.length} frames, first paint at ${Math.round(firstPaint?.t ?? 0)}ms, CLS ${recording.cls}`,
        );
      } catch (error) {
        failures.push(`${label}: did not load: ${(error as Error).message.split("\n")[0]}`);
      } finally {
        release();
      }
    }
  }
  return failures;
}

if (import.meta.filename === process.argv[1]) {
  const dir = mkdtempSync(join(tmpdir(), "check-shell-loading-"));
  const init = join(dir, "init.js");
  writeFileSync(init, INIT_SCRIPT);
  try {
    process.exitCode = await withBrowser("check:shell-loading", SESSION, measure, {
      launch: ["--init-script", init],
      mockServer: MOCK_SERVER,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
