import { useRouter } from "@tanstack/react-router";

import { MAIN_SCROLLER_SELECTOR } from "@/lib/main-scroller";

import { useMountEffect } from "./use-mount-effect";

/** How long a `#id` link waits for its target to mount (gated pages render after session/data load). */
export const HASH_TARGET_WAIT_MS = 8000;

const FOCUSABLE =
  "a[href], area[href], button, input:not([type='hidden']), select, textarea, summary, iframe, [tabindex], [contenteditable='true']";

/** Input that means the person has taken over: a late hash scroll must not yank the page. */
const TAKEOVER_EVENTS = ["wheel", "touchstart", "keydown", "pointerdown"] as const;

/** The element id a URL hash names (`#a%20b` or `a%20b` -> `a b`); null for an empty hash. */
export function hashTargetId(hash: string): string | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function isFocusable(element: Element): element is HTMLElement {
  return (
    element instanceof HTMLElement && element.matches(FOCUSABLE) && !element.matches(":disabled")
  );
}

/**
 * Scrolls the element with `id` into view and focuses it when it is focusable. The document never
 * scrolls, so `scrollIntoView` moves <main>. When the target is not mounted yet, waits for it
 * (MutationObserver) up to `timeoutMs`, and gives up quietly on timeout or as soon as the person
 * scrolls, taps or types. Returns a function that cancels the wait.
 */
export function revealHashTarget(id: string, timeoutMs = HASH_TARGET_WAIT_MS): () => void {
  let done = false;
  let observer: MutationObserver | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const stop = () => {
    if (done) return;
    done = true;
    observer?.disconnect();
    clearTimeout(timer);
    for (const type of TAKEOVER_EVENTS) window.removeEventListener(type, stop, true);
  };
  const reveal = (element: Element) => {
    stop();
    // A fixed element does not move with <main>; scrolling "to" it only jumps the page.
    if (getComputedStyle(element).position !== "fixed") {
      element.scrollIntoView({ block: "start" });
    }
    if (isFocusable(element)) element.focus({ preventScroll: true });
  };

  const existing = document.getElementById(id);
  if (existing) {
    reveal(existing);
    return stop;
  }
  observer = new MutationObserver(() => {
    const element = document.getElementById(id);
    if (element) reveal(element);
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["id"],
  });
  timer = setTimeout(stop, timeoutMs);
  for (const type of TAKEOVER_EVENTS) {
    window.addEventListener(type, stop, { capture: true, passive: true });
  }
  return stop;
}

/**
 * The `#id` of a plain same-page link (`<a href="#id">`, not a router Link, which prevents the
 * default), relative to the router's location; null for anything else.
 */
function samePageHash(event: MouseEvent, here: { pathname: string; searchStr: string }) {
  if (event.defaultPrevented || event.button !== 0) return null;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
  const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
  if (!(anchor instanceof HTMLAnchorElement)) return null;
  if (anchor.target && anchor.target !== "_self") return null;
  if (anchor.hasAttribute("download")) return null;
  const href = anchor.getAttribute("href") ?? "";
  if (href.startsWith("#")) return href.length > 1 ? href : null;
  const url = new URL(href, window.location.href);
  if (url.origin !== window.location.origin) return null;
  if (url.pathname !== here.pathname || url.search !== here.searchStr) return null;
  return url.hash.length > 1 ? url.hash : null;
}

/**
 * Opts the document's first history entry out of the router's own hash scroll, which on
 * back/forward scrolls an entry's hash target into view unless the entry says not to, overriding
 * the restored position. Entries the router creates already say so (`defaultHashScrollIntoView`).
 * The router keys the first entry at startup; the native replaceState keeps every field and does
 * not notify the router (it patches the instance method).
 */
function optOutOfRouterHashScroll(): void {
  const state: unknown = window.history.state;
  if (!state || typeof state !== "object" || !("__TSR_key" in state)) return;
  const current = state as Record<string, unknown>;
  if (current.__hashScrollIntoViewOptions === false) return;
  History.prototype.replaceState.call(
    window.history,
    { ...current, __hashScrollIntoViewOptions: false },
    "",
  );
}

/** Was this document opened fresh (typed, linked), rather than reloaded or restored from history? */
function isFreshDocumentLoad(): boolean {
  const entry = performance.getEntriesByType?.("navigation")[0];
  const type = entry && "type" in entry ? (entry as PerformanceNavigationTiming).type : "navigate";
  return type === "navigate";
}

/**
 * `#id` deep links for the app shell, whose <main> is the only scroller. The router's own hash
 * scroll is off (`defaultHashScrollIntoView: false` in router.tsx): it runs before gated page
 * content mounts and, on back/forward, would fight scroll restoration. Instead:
 * - a fresh document load with a hash, and router PUSH navigations to one (and REPLACEs that change
 *   the hash), wait for the target, then scroll <main> to it and focus it when focusable;
 * - back/forward/go leave the router's restored position alone;
 * - plain same-page `#id` links become router pushes (a proper history entry, revealed the same
 *   way); one naming the current hash just reveals it again.
 * Mount once, in the root component.
 */
export function useHashTargetScroll(): void {
  const router = useRouter();

  useMountEffect(() => {
    let cancel: (() => void) | undefined;
    let lastAction: string | undefined;
    let resetScroll = true;
    const reveal = (hash: string) => {
      cancel?.();
      const id = hashTargetId(hash);
      cancel = id ? revealHashTarget(id) : undefined;
    };

    optOutOfRouterHashScroll();
    if (window.location.hash && isFreshDocumentLoad()) reveal(window.location.hash);

    const unsubscribeHistory = router.history.subscribe(({ action }) => {
      lastAction = action.type;
      cancel?.();
      cancel = undefined;
    });
    // Capture before onRendered: the router's own listener resets this flag
    // there, before ours runs. Locale switches deliberately preserve scroll.
    const unsubscribeBeforeLoad = router.subscribe("onBeforeLoad", () => {
      resetScroll = router._scroll.n;
    });
    const unsubscribeRendered = router.subscribe("onRendered", (event) => {
      const action = lastAction;
      lastAction = undefined;
      if (!resetScroll || !event.toLocation.hash) return;
      if (action === "PUSH" || (action === "REPLACE" && (event.hashChanged || event.pathChanged))) {
        // The router skips its top reset when there is a hash; a new page still starts at the
        // top, so a missing target leaves it there rather than at the old page's position.
        const main = document.querySelector(MAIN_SCROLLER_SELECTOR);
        if ((event.pathChanged || event.hrefChanged) && main) main.scrollTop = 0;
        reveal(event.toLocation.hash);
      }
    });
    const onClick = (event: MouseEvent) => {
      const here = router.latestLocation;
      const hash = samePageHash(event, here);
      if (!hash) return;
      event.preventDefault();
      if (hashTargetId(hash) === hashTargetId(here.hash)) reveal(hash);
      else void router.navigate({ href: `${here.pathname}${here.searchStr}${hash}` });
    };
    document.addEventListener("click", onClick);

    return () => {
      cancel?.();
      unsubscribeHistory();
      unsubscribeBeforeLoad();
      unsubscribeRendered();
      document.removeEventListener("click", onClick);
    };
  });
}
