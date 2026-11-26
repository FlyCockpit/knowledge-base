/**
 * `pnpm check:layout --url <dev server>`: real-browser geometry check of the
 * shell rules against a running dev stack (`pnpm dev:docker <port>`; this app
 * has no mock mode). It is not part of CI: it needs agent-browser and its
 * Chromium. Run it after touching a shell, the footer, the header, page-level
 * chrome or the toast theme. Rules: docs/ui.md § Shell rules
 *
 *   pnpm check:layout --url http://127.0.0.1:3001
 *   pnpm check:layout --url … --state signed-in.json   also an admin page and a toast
 *   pnpm check:layout --url … --no-sandbox            Ubuntu 23.10+ (AppArmor) Chromium
 *
 * `--state` is an agent-browser state file (`agent-browser state save <path>`
 * after signing in as an instance admin). At 390×844, 1280×800, 1440×1600 and
 * 390×300 (where every page scrolls), on the landing page, the 404 and the
 * sign-in page (plus, with `--state`, the admin users page), it checks that:
 * - the document never scrolls and the page's one `<main>` is the scroller;
 * - the public shell's footer is the scroller's last box: scrolled to the end,
 *   its bottom is the scroller's bottom (±1px), so on a short page it sits at
 *   the bottom of the viewport and on a long one it follows the content;
 * - the 404 renders inside the public shell (header and footer present);
 * - `<main>` reserves no scrollbar gutter, and every full-width rule (header
 *   `<hr>`, footer `border-t`, the admin sub-nav's `border-b`) spans the
 *   viewport (inside a scrolling `<main>`, up to its visible scrollbar);
 * - with a cookie banner's reserve applied (`--consent-inset` set as the
 *   banner sets it; the banner itself shows only in an app with analytics),
 *   the shell frame, `<main>`'s box and anything beside it (the app sidebar)
 *   keep their full height to the bottom of the viewport, and the page's
 *   content, scrolled to its end, ends above where the banner starts.
 * With `--state` it also opens the signed-in home (`/kbs`) with every `/rpc` call failing, so
 * the global query-error toast (with its "Try again" action) shows, stored theme
 * light then dark with the OS set to the other one, and checks the toast renders
 * in the stored theme, is filled with its popover colour (not inverted) and its
 * title, badge and action reach 4.5:1 on it.
 *
 * Classic (non-overlay) scrollbars are what expose a reserved gutter; headless
 * Chromium on Linux draws them, overlay scrollbars on macOS hide the defect.
 */
import { execFileSync, spawn } from "node:child_process";

// One session per run: a just-closed session of the same name may still be shutting down.
const SESSION = `check-layout-${process.pid}`;

/** What the in-page probe reports. Pure data, so `judgeLayout` is testable. */
export interface Probe {
  vw: number;
  docScroll: number;
  /** A shell header: an `<hr>` above the scroller. */
  header: boolean;
  /**
   * `scrollbar`: the width `<main>` gives up to a scrollbar right now (offsetWidth − clientWidth).
   * `left`: its left edge (the signed-in sidebar sits left of it from `md:`).
   */
  main: { left: number; bottom: number; scrollable: boolean; scrollbar: number } | null;
  /** The public footer after scrolling `<main>` to its end, or null. */
  footer: { bottom: number; lastInMain: boolean; position: string } | null;
  /**
   * `inMain`: the rule is inside the scroller, so it starts at the scroller's left edge and a
   * visible scrollbar is its right edge.
   */
  rules: { name: string; left: number; right: number; inMain: boolean }[];
  toast: {
    dark: boolean;
    fill: string;
    popover: string;
    title: number;
    badge: number;
    button: number | null;
  } | null;
}

export interface Expect {
  footer: boolean;
  /** The theme the stored choice asks for; the OS is set to the opposite one. */
  toast?: "light" | "dark";
}

/** Returns one message per broken rule; empty means the page passes. */
export function judgeLayout(page: string, probe: Probe, expect: Expect): string[] {
  const bad: string[] = [];
  if (probe.docScroll > 0)
    bad.push(`${page}: the document scrolls by ${probe.docScroll}px; only <main> may scroll`);
  if (!probe.main) bad.push(`${page}: no single <main> scroller`);
  if (!probe.header) bad.push(`${page}: no shell header`);
  if (expect.footer) {
    if (!probe.footer) bad.push(`${page}: no public footer`);
    else {
      if (!probe.footer.lastInMain)
        bad.push(`${page}: the footer is not the last box in the scroller's content column`);
      // A fixed or sticky footer can end at the scroller's bottom while covering
      // the content instead of following it.
      if (!["static", "relative"].includes(probe.footer.position))
        bad.push(
          `${page}: the footer is position: ${probe.footer.position}; it must follow the content in the flow`,
        );
      if (probe.main && Math.abs(probe.footer.bottom - probe.main.bottom) > 1)
        bad.push(
          `${page}: scrolled to the end, the footer ends at ${probe.footer.bottom}px, the scroller at ${probe.main.bottom}px (${probe.main.scrollable ? "long" : "short"} page)`,
        );
    }
  }
  // A scrollable scroller shows a scrollbar at the viewport's right edge, and a
  // rule inside it meets that scrollbar, as on any scrolling page. A scroller
  // that does not scroll but still gives up width reserves an empty gutter.
  const scrollbar = probe.main?.scrollable ? probe.main.scrollbar : 0;
  if (probe.main && !probe.main.scrollable && probe.main.scrollbar > 0)
    bad.push(
      `${page}: <main> reserves a ${probe.main.scrollbar}px scrollbar gutter on a page that does not scroll`,
    );
  for (const rule of probe.rules) {
    const start = rule.inMain ? (probe.main?.left ?? 0) : 0;
    const edge = probe.vw - (rule.inMain ? scrollbar : 0);
    if (rule.left > start || edge - rule.right > 0)
      bad.push(
        `${page}: ${rule.name} spans ${rule.left}…${rule.right}px, not ${start}…${edge}px; full-bleed rules reach both edges`,
      );
  }
  if (expect.toast) {
    const toast = probe.toast;
    if (!toast) bad.push(`${page}: no toast appeared`);
    else {
      if (toast.dark !== (expect.toast === "dark"))
        bad.push(
          `${page}: the stored ${expect.toast} theme lost to the OS (the page rendered ${toast.dark ? "dark" : "light"})`,
        );
      if (toast.fill !== toast.popover)
        bad.push(
          `${page}: the toast is filled ${toast.fill}, not the ${toast.dark ? "dark" : "light"} theme's popover ${toast.popover}`,
        );
      for (const [part, ratio] of [
        ["title", toast.title],
        ["badge", toast.badge],
        ["action", toast.button],
      ] as const) {
        if (ratio !== null && ratio < 4.5)
          bad.push(`${page}: toast ${part} contrast ${ratio}:1 is below 4.5:1`);
      }
    }
  }
  return bad;
}

/** The banner-reserve probe: the same boxes measured without and with the reserve. */
export interface ReserveProbe {
  vh: number;
  inset: number;
  /** `<main>` and its ancestors (the outermost is the frame), each followed by what sits beside it. */
  before: { name: string; bottom: number }[];
  after: { name: string; bottom: number }[];
  /** With the reserve, scrolled to the end: the bottom of `<main>`'s rendered content. */
  contentEnd: number;
  /** The public footer's bottom at that point, or null (the app shell has none). */
  footer: number | null;
}

/** One message per broken reserve rule (docs/ui.md § Shell rules). */
export function judgeReserve(page: string, probe: ReserveProbe | null): string[] {
  if (!probe) return [`${page}: no single <main> scroller`];
  const bad: string[] = [];
  const frame = probe.before.filter((box) => !box.name.startsWith("beside ")).at(-1);
  if (frame && Math.abs(frame.bottom - probe.vh) > 1)
    bad.push(
      `${page}: the shell frame ends at ${frame.bottom}px, not the viewport bottom (${probe.vh}px)`,
    );
  probe.before.forEach((box, i) => {
    const moved = probe.after[i];
    if (!moved || moved.name !== box.name || Math.abs(moved.bottom - box.bottom) > 1)
      bad.push(
        `${page}: with a cookie banner's reserve, ${box.name} ends at ${moved?.bottom ?? "?"}px instead of ${box.bottom}px; the shell chrome keeps the full height, only <main>'s padding makes room`,
      );
  });
  const bannerTop = probe.vh - probe.inset;
  if (probe.contentEnd > bannerTop + 1)
    bad.push(
      `${page}: scrolled to the end, the page ends at ${probe.contentEnd}px, under a banner starting at ${bannerTop}px`,
    );
  // A short public page's footer sits right on top of the banner, as it sits on the viewport bottom without one.
  if (probe.footer !== null && Math.abs(probe.footer - bannerTop) > 1)
    bad.push(
      `${page}: scrolled to the end, the footer ends at ${probe.footer}px, not where the banner starts (${bannerTop}px)`,
    );
  return bad;
}

/**
 * The most the reserve probe pretends a banner covers, and its share of a
 * short viewport: on phones a real banner's own content is about 90px (one
 * line over two buttons; over the BottomNav it reserves that plus the nav's
 * 3.5rem and the safe area), and as a desktop card it stays under 200px, so a
 * fixed 200px would leave no room under a tall header at 390×300. Both exceed
 * the BottomNav's reserve while the safe area is under about 34px.
 */
const RESERVE_INSET = 200;
const RESERVE_SHARE = 0.3;

// Runs in the page (agent-browser eval). Self-contained: no closures.
const RESERVE_PROBE = `(async () => {
  const html = document.documentElement;
  // The page's one <main> (the public shell's has no id), as PROBE finds it.
  const mains = document.querySelectorAll("main");
  const main = mains.length === 1 ? mains[0] : null;
  if (!main) return JSON.stringify(null);
  const settle = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const label = (el) => el === main ? "<main>" : el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (el.dataset.slot ? "[data-slot=" + el.dataset.slot + "]" : "");
  const boxes = () => {
    const out = [];
    for (let el = main; el && el !== document.body; el = el.parentElement) {
      const r = el.getBoundingClientRect();
      out.push({ name: label(el), bottom: Math.round(r.bottom) });
      for (const sib of el.parentElement ? el.parentElement.children : []) {
        if (sib === el || ["absolute", "fixed"].includes(getComputedStyle(sib).position)) continue;
        const s = sib.getBoundingClientRect();
        // Beside, not above: a sidebar starts no lower than this box and sits left or right of it.
        if (s.width && s.height && s.top <= r.top + 1 && (s.right <= r.left + 1 || s.left >= r.right - 1))
          out.push({ name: "beside " + label(el) + ": " + label(sib), bottom: Math.round(s.bottom) });
      }
    }
    return out;
  };
  const before = boxes();
  // A real banner's reservation (an app with analytics) is put back afterwards.
  const previous = html.style.getPropertyValue("--consent-inset");
  const inset = Math.min(${RESERVE_INSET}, Math.round(window.innerHeight * ${RESERVE_SHARE}));
  html.style.setProperty("--consent-inset", inset + "px");
  await settle();
  const after = boxes();
  // Where the content would be scrolled to the end, computed rather than
  // scrolled: a late scroll reset (hydration, restoration) cannot skew it.
  const toEnd = main.scrollHeight - main.clientHeight - main.scrollTop;
  // Through \`display: contents\` wrappers (pull-to-refresh), which have no box of their own.
  const end = (el) => {
    let bottom = 0;
    for (const child of el.children) {
      const style = getComputedStyle(child);
      if (["absolute", "fixed"].includes(style.position) || style.display === "none") continue;
      bottom = Math.max(bottom, style.display === "contents" ? end(child) : Math.round(child.getBoundingClientRect().bottom));
    }
    return bottom;
  };
  const contentEnd = end(main) - toEnd;
  const footer = main.querySelector("footer[data-public-footer]");
  const footerEnd = footer ? Math.round(footer.getBoundingClientRect().bottom) - toEnd : null;
  if (previous) html.style.setProperty("--consent-inset", previous);
  else html.style.removeProperty("--consent-inset");
  return JSON.stringify({ vh: window.innerHeight, inset, before, after, contentEnd, footer: footerEnd });
})()`;

// Runs in the page (agent-browser eval). Self-contained: no closures.
const PROBE = `(async () => {
  const html = document.documentElement;
  const vw = html.clientWidth;
  const mains = document.querySelectorAll("main");
  const main = mains.length === 1 ? mains[0] : null;
  const out = { vw, docScroll: document.scrollingElement.scrollHeight - window.innerHeight, header: false, main: null, footer: null, rules: [], toast: null };
  if (main) {
    main.scrollTop = main.scrollHeight;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    out.main = { left: Math.round(main.getBoundingClientRect().left), bottom: Math.round(main.getBoundingClientRect().bottom), scrollable: main.scrollHeight > main.clientHeight, scrollbar: main.offsetWidth - main.clientWidth };
    const footer = main.querySelector("footer[data-public-footer]");
    if (footer) {
      const column = footer.parentElement;
      out.footer = { bottom: Math.round(footer.getBoundingClientRect().bottom), position: getComputedStyle(footer).position, lastInMain: column.parentElement === main && column.lastElementChild === footer && main.children.length === 1 };
      out.rules.push({ name: "footer border-t", left: Math.round(footer.getBoundingClientRect().left), right: Math.round(footer.getBoundingClientRect().right), inMain: true });
    }
    main.scrollTop = 0;
  }
  // The shell header's rule: an <hr> above the scroller (the app header is a <div>, the public one a <header>).
  for (const hr of document.querySelectorAll("hr")) {
    if (main && main.contains(hr)) continue;
    out.header = true;
    out.rules.push({ name: "header <hr>", left: Math.round(hr.getBoundingClientRect().left), right: Math.round(hr.getBoundingClientRect().right), inMain: false });
  }
  for (const nav of document.querySelectorAll("main nav.border-b")) out.rules.push({ name: "sub-nav border-b", left: Math.round(nav.getBoundingClientRect().left), right: Math.round(nav.getBoundingClientRect().right), inMain: true });
  const pill = document.querySelector("[data-sileo-viewport] [data-sileo-pill]");
  if (pill) {
    const ctx = document.createElement("canvas").getContext("2d");
    const rgb = (c) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = "#000"; ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3); };
    const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    const lum = (p) => 0.2126 * lin(p[0]) + 0.7152 * lin(p[1]) + 0.0722 * lin(p[2]);
    const ratio = (a, b) => { const x = lum(a), y = lum(b); return Math.round(((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)) * 100) / 100; };
    const probe = document.createElement("div");
    probe.style.color = "var(--popover)";
    document.body.append(probe);
    const popover = rgb(getComputedStyle(probe).color);
    probe.remove();
    const fill = rgb(getComputedStyle(pill).fill);
    const color = (sel) => { const el = document.querySelector("[data-sileo-viewport] " + sel); return el ? rgb(getComputedStyle(el).color) : null; };
    const title = color("[data-sileo-title]"), badge = color("[data-sileo-badge]"), button = color("[data-sileo-button]");
    out.toast = { dark: html.classList.contains("dark"), fill: fill.join(","), popover: popover.join(","), title: title ? ratio(title, fill) : 0, badge: badge ? ratio(badge, fill) : 0, button: button ? ratio(button, fill) : null };
  }
  return JSON.stringify(out);
})()`;

/**
 * One agent-browser command. Asynchronous, so a signal (Ctrl+C, a kill) is
 * handled between commands instead of after the whole run.
 */
function browser(args: string[], input?: string): Promise<string> {
  return new Promise((done, fail) => {
    const child = spawn("agent-browser", ["--session", SESSION, ...args], {
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
}

function closeBrowser(): void {
  try {
    execFileSync("agent-browser", ["--session", SESSION, "close"], { stdio: "ignore" });
  } catch {}
}

async function evalJson<T>(script: string): Promise<T> {
  let value: unknown = JSON.parse(await browser(["eval", "--stdin"], script));
  if (typeof value === "string") value = JSON.parse(value);
  return value as T;
}

async function waitFor(url: string, ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`the dev server did not answer ${url} within ${ms / 1000}s`);
}

interface Page {
  name: string;
  path: string;
  expect: Expect;
  /** Wait for this selector before probing. */
  ready: string;
  /** Needs the signed-in `--state`. */
  signedIn?: boolean;
}

const PAGES: Page[] = [
  { name: "landing", path: "/en-US", expect: { footer: true }, ready: "footer" },
  {
    name: "404",
    path: "/en-US/check-layout-missing",
    expect: { footer: true },
    ready: "footer",
  },
  { name: "sign-in", path: "/en-US/login", expect: { footer: false }, ready: "main form" },
  // The owner's case: the sidebar must reach the bottom with a banner up.
  {
    name: "home",
    path: "/en-US/kbs",
    expect: { footer: false },
    ready: "main",
    signedIn: true,
  },
  {
    name: "admin users",
    path: "/en-US/admin/users",
    expect: { footer: false },
    ready: "main nav.border-b",
    signedIn: true,
  },
];
const VIEWPORTS = [
  [390, 844],
  [1280, 800],
  [1440, 1600],
  [390, 300],
] as const;
const CONSENT_DECIDED =
  "localStorage.setItem('knowledge-base.consent.v1', JSON.stringify({ v: 1, analytics: false, decidedAt: Date.now() })); true";

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const option = (name: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const base = option("--url")?.replace(/\/$/, "");
  const state = option("--state");
  if (!base) {
    console.error(
      "check:layout: pass --url <dev server> (start one with `pnpm dev:docker <port>`); see docs/ui.md § Shell rules",
    );
    return 2;
  }
  const onSignal = (signal: NodeJS.Signals) => {
    closeBrowser();
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  const failures: string[] = [];
  try {
    await waitFor(`${base}/en-US`, 120_000);
    await browser([
      "open",
      "about:blank",
      ...(args.includes("--no-sandbox") ? ["--args", "--no-sandbox"] : []),
    ]);
    for (const signedIn of state ? [false, true] : [false]) {
      if (signedIn && state) await browser(["state", "load", state]);
      for (const [w, h] of VIEWPORTS) {
        await browser(["set", "viewport", String(w), String(h)]);
        for (const page of PAGES.filter((p) => Boolean(p.signedIn) === signedIn)) {
          await browser(["open", `${base}/en-US`]);
          // A decided consent: the banner is not part of the page geometry.
          await browser(["eval", CONSENT_DECIDED]);
          await browser(["open", `${base}${page.path}`]);
          await browser(["wait", page.ready]);
          await browser(["wait", "500"]);
          const label = `${page.name} ${w}×${h}`;
          const probe = await evalJson<Probe>(PROBE);
          failures.push(...judgeLayout(label, probe, page.expect));
          failures.push(...judgeReserve(label, await evalJson<ReserveProbe | null>(RESERVE_PROBE)));
          console.log(
            `check:layout: ${label} measured (${probe.main?.scrollable ? "long" : "short"} page)`,
          );
        }
      }
    }
    if (state) {
      // Toasts: every /rpc call fails, so the global query-error toast (with
      // its "Try again" action) shows. Light and dark, at one width.
      await browser(["set", "viewport", "1280", "800"]);
      for (const theme of ["light", "dark"] as const) {
        await browser(["set", "media", theme === "dark" ? "light" : "dark"]);
        await browser(["open", `${base}/en-US`]);
        await browser(["eval", `localStorage.setItem('vite-ui-theme', '${theme}'); true`]);
        await browser(["network", "route", `${base}/rpc/**`, "--abort"]);
        await browser(["open", `${base}/en-US/kbs`]);
        // The query retries with backoff before it fails; a slow dev server can
        // take longer than one 25-second wait.
        await browser(["wait", "[data-sileo-viewport] [data-sileo-pill]"]).catch(() =>
          browser(["wait", "[data-sileo-viewport] [data-sileo-pill]"]),
        );
        await browser(["wait", "800"]);
        failures.push(
          ...judgeLayout(`toast ${theme}`, await evalJson<Probe>(PROBE), {
            footer: false,
            toast: theme,
          }),
        );
        await browser(["network", "unroute"]);
        console.log(`check:layout: toast ${theme} measured`);
      }
    } else console.log("check:layout: no --state, so the admin page and the toast were skipped");
  } finally {
    closeBrowser();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
  for (const failure of failures) console.error(`check:layout: ${failure}`);
  console.log(
    failures.length ? `check:layout: ${failures.length} failure(s)` : "check:layout: passed",
  );
  return failures.length ? 1 : 0;
}

if (import.meta.filename === process.argv[1]) process.exitCode = await main();
