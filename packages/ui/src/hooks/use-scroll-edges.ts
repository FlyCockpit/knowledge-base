import * as React from "react";

export type ScrollEdges = { start: boolean; end: boolean };

type ScrollMetrics = { scrollLeft: number; scrollWidth: number; clientWidth: number };

const NONE: ScrollEdges = { start: false, end: false };

/**
 * Which horizontal edges of a scroller have more content past them. A 1px
 * tolerance absorbs sub-pixel layout, so a row that just fits shows no fade.
 */
export function scrollEdges({ scrollLeft, scrollWidth, clientWidth }: ScrollMetrics): ScrollEdges {
  const max = scrollWidth - clientWidth;
  if (max <= 1) return NONE;
  // Math.abs: an RTL scroller reports scrollLeft from 0 down to -max.
  const offset = Math.abs(scrollLeft);
  return { start: offset > 1, end: offset < max - 1 };
}

type ScrollTarget = ScrollMetrics &
  Pick<HTMLElement, "addEventListener" | "removeEventListener"> & {
    firstElementChild: Element | null;
  };

/**
 * Report `scrollEdges(el)` now and again on every scroll and on every resize
 * of the scroller or its first child (the track). Returns the cleanup.
 */
export function observeScrollEdges(
  el: ScrollTarget,
  onChange: (edges: ScrollEdges) => void,
): () => void {
  let last: ScrollEdges | undefined;
  const update = () => {
    const next = scrollEdges(el);
    if (last && last.start === next.start && last.end === next.end) return;
    last = next;
    onChange(next);
  };
  update();
  el.addEventListener("scroll", update, { passive: true });
  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
  observer?.observe(el as unknown as Element);
  if (el.firstElementChild) observer?.observe(el.firstElementChild);
  return () => {
    el.removeEventListener("scroll", update);
    observer?.disconnect();
  };
}

/**
 * Edge state of a horizontal scroller, for the `scroll-fade-x` mask in
 * globals.css. Spread `edgeAttributes(edges)` on the scroller. Pass
 * `contentKey` (e.g. the rendered text) when the content can change without
 * resizing an element, so the edges are measured again.
 */
export function useScrollEdges<T extends HTMLElement>(
  ref: React.RefObject<T | null>,
  contentKey?: unknown,
): ScrollEdges {
  const [edges, setEdges] = React.useState<ScrollEdges>(NONE);
  // biome-ignore lint/correctness/useExhaustiveDependencies: contentKey re-measures changed text
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return observeScrollEdges(el, setEdges);
  }, [ref, contentKey]);
  return edges;
}

/** `data-overflow-start` / `data-overflow-end`, present only while true. */
export function edgeAttributes(edges: ScrollEdges) {
  return {
    "data-overflow-start": edges.start ? "" : undefined,
    "data-overflow-end": edges.end ? "" : undefined,
  };
}
