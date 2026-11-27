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
 * - cumulative layout shift exceeds 0.05: on a page whose content does not fit
 *   the viewport, a shift whose every moved box is the public footer pushed
 *   below the first screen does not count (a long list pushing the footer
 *   below the fold moves nothing the reader sees);
 * - the loaded content fits the viewport but the page's public footer
 *   (`[data-public-footer]`, where it has one) is not in it.
 * The same rules as tunnel's reload-shell check (crates/web/checks/reload-shell-judge.mjs).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { byRole, type CheckRun, sessionName, withBrowser } from "./browser-check-lib.ts";
import { MOCK_SERVER, SHELL_PAGES, type ShellPage, signIn } from "./browser-checks.config.ts";

// One session per run, so runs in other checkouts on this machine are untouched.
const SESSION = sessionName("check-shell-loading");
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

/** The loaded page: a frame plus what the footer rule needs, measured once. */
export interface LoadedFrame extends ShellFrame {
  /** The public footer (`[data-public-footer]`), or null: the app shell has none. */
  footer: Box | null;
  vh: number;
  /**
   * Where the content ends: the lowest visible box without children, or run
   * of text beside child elements, in `<main>` (the footer's excluded), plus
   * the bottom padding of the boxes around it.
   */
  contentEnd: number;
}

/** A layout-shift entry; `below`: it only pushed the footer below the first screen. */
export interface Shift {
  v: number;
  below: boolean;
}

/**
 * A moved box of a layout-shift entry, as the page saw it when the entry
 * arrived: `top` is its live top (null when no longer in the page), `rect`
 * the entry's `currentRect` (clipped to the viewport).
 */
export interface ShiftSource {
  footer: boolean;
  top: number | null;
  rect: { top: number; width: number; height: number };
}

/**
 * Whether a layout-shift entry only pushed the footer below the first screen:
 * every moved box is the footer, and its live position is at or below the
 * fold. A footer that went up (no live position, or above the fold) counts,
 * as does any other moved box. Runs in the page too (INIT_SCRIPT embeds its
 * source): plain JavaScript once the types are stripped, no closures.
 */
export function footerPushedBelow(sources: ShiftSource[], vh: number): boolean {
  return (
    sources.length > 0 &&
    sources.every(
      (s) =>
        s.footer &&
        s.top !== null &&
        s.top >= vh &&
        (!(s.rect.width || s.rect.height) || s.rect.top >= vh),
    )
  );
}

/**
 * Whether the loaded content fits the first screen with its footer. Measured
 * from where the content ends, so a page held taller than its content (a
 * min-height) still counts as fitting.
 */
export function fits(final: LoadedFrame): boolean {
  return final.contentEnd + (final.footer?.[3] ?? 0) <= final.vh + 1;
}

export interface ShellRecording {
  frames: ShellFrame[];
  /** The loaded page, measured after the content arrived. */
  final: LoadedFrame;
  shifts: Shift[];
}

/**
 * The layout shift that counts (`cls`), what was below the fold of a long page
 * (`belowFold`: shifts that only pushed the footer out of the first screen of a
 * page that does not fit), and all of it (`all`: what a browser reports as CLS).
 */
export function shiftScore(
  shifts: Shift[],
  final: LoadedFrame,
): { cls: number; belowFold: number; all: number } {
  const long = !fits(final);
  const sum = (list: Shift[]) => Math.round(list.reduce((n, s) => n + s.v, 0) * 1000) / 1000;
  return {
    cls: sum(shifts.filter((s) => !(long && s.below))),
    belowFold: sum(shifts.filter((s) => long && s.below)),
    all: sum(shifts),
  };
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
  const { cls } = shiftScore(recording.shifts, final);
  if (cls > MAX_CLS)
    bad.push(`${label}: cumulative layout shift ${cls.toFixed(3)} exceeds ${MAX_CLS}`);
  // A page whose content fits the viewport ends with its public footer on screen.
  const { footer, vh } = final;
  if (footer && fits(final) && !(footer[1] >= 0 && footer[1] + footer[3] <= vh + 1))
    bad.push(
      `${label}: the content fits the viewport, but the footer (${show(footer)}) is not in it`,
    );
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
  // The lowest visible content in <main> outside the footer: a childless
  // box, or a run of text beside child elements (a paragraph with an early
  // inline link), plus the bottom padding of the boxes around it (up to
  // <main>, whose own padding is the cookie banner's room).
  const textBox = (node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    return range.getBoundingClientRect();
  };
  const contentEnd = (main) => {
    let end = 0;
    let padFrom = null;
    if (main) for (const el of main.querySelectorAll("*")) {
      if (el.closest("[data-public-footer]") || getComputedStyle(el).visibility !== "visible") continue;
      // A childless box includes its own padding; text inside a box with
      // children sits above that box's padding. Only whether a text run is
      // blank is read here, never the text itself (a signed-in page shows the
      // user's own data).
      const boxes = el.children.length
        ? [...el.childNodes].filter((n) => n.nodeType === 3 && /\\S/.test(n.nodeValue)).map((n) => [textBox(n), el])
        : [[el.getBoundingClientRect(), el.parentElement]];
      for (const [r, from] of boxes)
        if ((r.width || r.height) && r.bottom > end) {
          end = r.bottom;
          padFrom = from;
        }
    }
    for (let el = padFrom; el && el !== main; el = el.parentElement) end += parseFloat(getComputedStyle(el).paddingBottom) || 0;
    return Math.round(end);
  };
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
  // The loaded page, with what the footer rule needs (too slow for every frame).
  window.__shellLoaded = () => {
    const main = seen("#main-content");
    return { ...snap(), footer: box(seen("[data-public-footer]")), vh: window.innerHeight, contentEnd: contentEnd(main) };
  };
  const shifts = [];
  window.__shellShifts = shifts;
  const footerPushedBelow = ${footerPushedBelow.toString()};
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.hadRecentInput) continue;
        // Read when the entry arrives: where each moved box is now. A box
        // inside the footer moves with it, so it counts as the footer.
        const sources = (entry.sources || []).map((s) => {
          const live = s.node && s.node.nodeType === 1 && s.node.isConnected ? s.node : null;
          const rect = s.currentRect;
          return { footer: !!live && !!live.closest("[data-public-footer]"), top: live ? live.getBoundingClientRect().top : null, rect: { top: rect.top, width: rect.width, height: rect.height } };
        });
        shifts.push({ v: entry.value, below: footerPushedBelow(sources, window.innerHeight) });
      }
    }).observe({ type: "layout-shift", buffered: true });
  } catch {}
  const tick = () => {
    if (frames.length < 2000) frames.push(snap());
    if (!window.__shellDone) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();`;

/** Ends the recording and returns it (a `ShellRecording` as JSON). */
export const READ = `(() => {
  window.__shellDone = true;
  return JSON.stringify({ frames: window.__shellFrames || [], final: window.__shellLoaded(), shifts: window.__shellShifts || [] });
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
async function waitLoaded({ browser }: CheckRun, { ready, needs }: ShellPage): Promise<void> {
  const loaded = `!!document.querySelector(${JSON.stringify(ready)}) && !document.querySelector('#main-content [data-slot="skeleton"], #main-content [data-route-skeleton]')`;
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    if ((await browser.run(["eval", loaded])) === "true") {
      await browser.run(["wait", "1000"]);
      return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `still loading after 60s (waiting for ${ready} and no skeleton)${needs ? `; this page needs ${needs}` : ""}`,
  );
}

const VIEWPORTS = [
  [1280, 800],
  [390, 844],
] as const;

/** One page: warm it, then hard-reload it throttled and judge the recording. */
async function reload(run: CheckRun, page: ShellPage, label: string): Promise<string[]> {
  const { base, browser } = run;
  // Slow responses (2s per call) keep the auth check and the page's data
  // pending long enough to be recorded.
  await signIn(run, page.role);
  await browser.run(["eval", "localStorage.setItem('vite-ui-theme', 'dark'); true"]);
  // Warm the dev server's module graph, so the measured load is the app's,
  // not Vite's first transform.
  await browser.run(["open", `${base}${page.path}`]);
  try {
    await browser.run(["wait", page.ready]);
  } catch {
    throw new Error(
      `${page.ready} never appeared${page.needs ? `; this page needs ${page.needs}` : ""}`,
    );
  }
  await signIn(run, page.role, { slow: true });
  await browser.run(["eval", "localStorage.setItem('vite-ui-theme', 'dark'); true"]);
  const release = await throttle(run);
  try {
    await browser.run(["open", `${base}${page.path}`]);
    await waitLoaded(run, page);
    const recording = await browser.evalJson<ShellRecording>(READ);
    const firstPaint = recording.frames.find((frame) => frame.painted);
    const score = shiftScore(recording.shifts, recording.final);
    console.log(
      `check:shell-loading: ${label}: ${recording.frames.length} frames, first paint at ${Math.round(firstPaint?.t ?? 0)}ms, CLS ${score.cls}${score.belowFold ? ` (+${score.belowFold} below the fold)` : ""}`,
    );
    return judgeShellLoading(label, recording, true);
  } finally {
    release();
  }
}

async function measure(run: CheckRun): Promise<string[]> {
  const { browser } = run;
  const failures: string[] = [];
  // Stored dark, OS light: the first frame must already follow the stored choice.
  await browser.run(["set", "media", "light"]);
  for (const [w, h] of VIEWPORTS) {
    await browser.run(["set", "viewport", String(w), String(h)]);
    // Grouped by role, so a real stack signs in once per role and viewport.
    for (const page of byRole(SHELL_PAGES)) {
      const label = `${page.name} ${w}×${h}`;
      try {
        failures.push(...(await reload(run, page, label)));
      } catch (error) {
        failures.push(`${label}: did not load: ${(error as Error).message.split("\n")[0]}`);
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
