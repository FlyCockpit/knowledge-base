import { useSyncExternalStore } from "react";

import { MAIN_SCROLLER_SELECTOR } from "@/lib/main-scroller";

/**
 * The visible height of the layout's one `<main>` scroller, in px (0 before it
 * exists). Panes that stay in view while the document scrolls (the file
 * tree) are sticky inside it and sized to exactly this.
 */
export function useMainScrollerHeight(): number {
  return useSyncExternalStore(subscribe, snapshot, () => 0);
}

function scroller(): HTMLElement | null {
  return typeof document === "undefined"
    ? null
    : document.querySelector<HTMLElement>(MAIN_SCROLLER_SELECTOR);
}

function snapshot(): number {
  return scroller()?.clientHeight ?? 0;
}

function subscribe(callback: () => void): () => void {
  const element = scroller();
  window.addEventListener("resize", callback);
  const observer =
    element && typeof ResizeObserver !== "undefined" ? new ResizeObserver(callback) : null;
  if (element) observer?.observe(element);
  return () => {
    window.removeEventListener("resize", callback);
    observer?.disconnect();
  };
}
