/**
 * `pnpm check:dialogs`: opens every dialog listed in
 * `scripts/browser-checks.config.ts` (`DIALOGS`) in a real browser (mock mode) and fails
 * when one does not fit: a dialog is for confirmations and short forms, and it
 * must show all of itself without inner scrolling at 1280×800 and 390×844.
 * Rule: patterns/design-system.md § Form surfaces
 * Usage: patterns/agent-ui-testing.md § Dialog fit check
 *
 *   pnpm check:dialogs                    starts its own mock dev server
 *   pnpm check:dialogs --url http://127.0.0.1:3001   uses a running app
 *   pnpm check:dialogs --no-sandbox       Ubuntu 23.10+ (AppArmor) Chromium
 *   pnpm check:dialogs --only "Create project"       one dialog by name
 *
 * For each dialog and viewport it fails when:
 * - the popup (`[data-slot=dialog-content]` / `alert-dialog-content`) or any
 *   element inside it scrolls vertically (content taller than its box, with
 *   `overflow-y: auto | scroll`);
 * - the sticky header or action bar covers any of the content at rest;
 * - the popup reaches outside the viewport on any side;
 * - no dialog opened.
 * A form too long for this moves to a page (`FormPage`) or a wide side sheet,
 * and leaves this list.
 */

import { type CheckRun, withBrowser } from "./browser-check-lib.ts";
import {
  DIALOGS,
  type DialogCase,
  type DialogStep,
  MOCK_SERVER,
  signIn,
} from "./browser-checks.config.ts";

// One session per run, so runs in other checkouts on this machine are untouched.
const SESSION = `check-dialogs-${process.pid}`;
export const DIALOG_VIEWPORTS = [
  [1280, 800],
  [390, 844],
] as const;

/** What the in-page probe reports. Pure data, so `judgeDialog` is testable. */
export interface DialogProbe {
  vw: number;
  vh: number;
  popup: { top: number; bottom: number; left: number; right: number } | null;
  /** Elements in the popup (itself included) that scroll vertically. */
  scrollers: { name: string; scrollHeight: number; clientHeight: number }[];
  /**
   * Visible content that the sticky header or action bar covers at rest (a
   * sticky box pushed over the fields, as negative margins once did).
   */
  covered: { bar: string; what: string; overlap: number }[];
}

/** Returns one message per broken rule; empty means the dialog fits. */
export function judgeDialog(label: string, probe: DialogProbe): string[] {
  if (!probe.popup) return [`${label}: no dialog opened`];
  const bad: string[] = [];
  for (const scroller of probe.scrollers)
    bad.push(
      `${label}: ${scroller.name} scrolls (${scroller.scrollHeight}px of content in ${scroller.clientHeight}px); move the form to a page or a wide side sheet, or shorten it`,
    );
  for (const hit of probe.covered)
    bad.push(`${label}: the ${hit.bar} covers ${hit.overlap}px of ${hit.what}`);
  const { top, bottom, left, right } = probe.popup;
  if (top < 0 || left < 0 || bottom > probe.vh || right > probe.vw)
    bad.push(
      `${label}: the dialog spans ${left}…${right} × ${top}…${bottom}px, outside the ${probe.vw}×${probe.vh} viewport`,
    );
  return bad;
}

// Runs in the page (agent-browser eval). Self-contained: no closures.
const PROBE = `(() => {
  const popups = [...document.querySelectorAll('[data-slot="dialog-content"], [data-slot="alert-dialog-content"]')];
  const popup = popups[popups.length - 1];
  const out = { vw: document.documentElement.clientWidth, vh: window.innerHeight, popup: null, scrollers: [], covered: [] };
  if (!popup) return JSON.stringify(out);
  const r = popup.getBoundingClientRect();
  out.popup = { top: Math.floor(r.top), bottom: Math.ceil(r.bottom), left: Math.floor(r.left), right: Math.ceil(r.right) };
  for (const el of [popup, ...popup.querySelectorAll("*")]) {
    const oy = getComputedStyle(el).overflowY;
    if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 1) {
      const slot = el.getAttribute("data-slot");
      out.scrollers.push({ name: slot ? "[data-slot=" + slot + "]" : "<" + el.tagName.toLowerCase() + ">", scrollHeight: el.scrollHeight, clientHeight: el.clientHeight });
    }
  }
  const bars = [...popup.querySelectorAll('[data-slot$="dialog-header"], [data-slot$="dialog-footer"]')];
  const name = (el) => el.getAttribute("data-slot") || el.getAttribute("aria-label") || el.tagName.toLowerCase();
  for (const bar of bars) {
    const b = bar.getBoundingClientRect();
    for (const el of popup.querySelectorAll("*")) {
      if (bars.some((other) => other === el || other.contains(el) || el.contains(other))) continue;
      // The close button is drawn on the header's corner on purpose.
      if (el.closest('[data-slot="dialog-close"]')) continue;
      if (el.children.length > 0 && !el.matches("input, textarea, select, button")) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || getComputedStyle(el).visibility === "hidden") continue;
      const overlap = Math.min(r.bottom, b.bottom) - Math.max(r.top, b.top);
      const across = Math.min(r.right, b.right) - Math.max(r.left, b.left);
      if (overlap > 1 && across > 1) {
        out.covered.push({ bar: bar.getAttribute("data-slot").replace(/^(alert-)?dialog-/, "") === "footer" ? "action bar" : "header", what: name(el), overlap: Math.round(overlap) });
        break;
      }
    }
  }
  return JSON.stringify(out);
})()`;

/** A step as page script: click by CSS selector, or the button/link whose text is exactly `text`. */
export function stepScript(step: DialogStep): string {
  if ("click" in step)
    return `(() => { const el = document.querySelector(${JSON.stringify(step.click)}); if (!el) throw new Error("no element " + ${JSON.stringify(step.click)}); el.click(); return true; })()`;
  return `(() => { const want = ${JSON.stringify(step.clickText)}; const el = [...document.querySelectorAll('button, a, [role="menuitem"]')].find((e) => e.textContent.trim() === want); if (!el) throw new Error("nothing labelled " + want); el.click(); return true; })()`;
}

async function openDialog(run: CheckRun, dialog: DialogCase): Promise<void> {
  const { base, browser } = run;
  await signIn(run, dialog.role, { overrides: dialog.overrides });
  await browser.run(["open", `${base}${dialog.path}`]);
  await browser.run(["wait", dialog.ready]);
  for (const step of dialog.steps) {
    await browser.run(["eval", "--stdin"], stepScript(step));
    // Base UI opens on the next frame and animates in for ~100ms.
    await browser.run(["wait", "300"]);
  }
  await browser.run(["wait", '[data-slot="dialog-content"], [data-slot="alert-dialog-content"]']);
  await browser.run(["wait", "300"]);
}

async function measure(run: CheckRun): Promise<string[]> {
  const only = run.args.includes("--only") ? run.args[run.args.indexOf("--only") + 1] : undefined;
  const cases = DIALOGS.filter((dialog) => !only || dialog.name === only);
  if (cases.length === 0) return [`no dialog named ${only} in browser-checks.config.ts`];
  const failures: string[] = [];
  for (const [w, h] of DIALOG_VIEWPORTS) {
    await run.browser.run(["set", "viewport", String(w), String(h)]);
    for (const dialog of cases) {
      const label = `${dialog.name} ${w}×${h}`;
      try {
        await openDialog(run, dialog);
        failures.push(...judgeDialog(label, await run.browser.evalJson<DialogProbe>(PROBE)));
        console.log(`check:dialogs: ${label} measured`);
      } catch (error) {
        failures.push(`${label}: could not open: ${(error as Error).message.split("\n")[0]}`);
      }
    }
  }
  return failures;
}

if (import.meta.filename === process.argv[1])
  process.exitCode = await withBrowser("check:dialogs", SESSION, measure, {
    mockServer: MOCK_SERVER,
  });
