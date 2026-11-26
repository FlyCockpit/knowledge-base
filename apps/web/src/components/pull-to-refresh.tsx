import { Loader2 } from "lucide-react";
import { useCallback, useRef } from "react";

interface PullToRefreshProps {
  onRefresh: () => Promise<void>;
  children: React.ReactNode;
}

const THRESHOLD = 80;
const MAX_PULL = 128;
/** Longest the indicator spins before the gesture is released. */
const REFRESH_TIMEOUT_MS = 10_000;

/**
 * Regions that must not start a pull (ones that own their own vertical
 * gestures) mark an ancestor with this attribute.
 */
const OPT_OUT_SELECTOR = '[data-pull-to-refresh="off"]';
const EDITABLE_SELECTOR = 'input, textarea, select, [contenteditable="true"]';

// A pull only starts when every scroller between the finger and the document
// is already at its top; otherwise the gesture is an ordinary scroll-up.
function isAnyAncestorScrolled(target: Element): boolean {
  let current: Element | null = target;
  while (current) {
    if (current.scrollTop > 0) return true;
    current = current.parentElement;
  }
  return false;
}

/**
 * Wraps a page (the knowledge bases home) inside the app shell's `main`. The wrapper is
 * `display: contents` — it adds no box, so the page is exactly as tall as its
 * content and a banner above it does not make `main` scroll — and the
 * indicator floats over content like the browser's own spinner. The nearest
 * positioned ancestor (the shell's `main`) must be `relative`.
 */
export default function PullToRefresh({ onRefresh, children }: PullToRefreshProps) {
  // Refresh progress is shown imperatively via the indicator/icon refs, never
  // through rendered JSX, so a ref (not state) is the right primitive — it gates
  // the gesture handlers without triggering a re-render.
  const refreshing = useRef(false);
  const touchStartX = useRef(0);
  const touchStartY = useRef(0);
  const pulling = useRef(false);
  const pullDistanceRef = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const indicatorRef = useRef<HTMLDivElement>(null);
  const iconRef = useRef<SVGSVGElement>(null);

  // Only touches refs and module constants, so it is stable for the lifetime
  // of the component — memoized here so the touch handlers below can list it as
  // the dependency it actually is instead of closing over a per-render copy.
  const updateIndicator = useCallback((distance: number) => {
    const indicator = indicatorRef.current;
    const icon = iconRef.current;
    if (!indicator || !icon) return;
    const progress = Math.min(distance / THRESHOLD, 1);
    Object.assign(indicator.style, {
      opacity: String(progress),
      transform: `translateY(${distance - 40}px)`,
    });
    icon.style.transform = `rotate(${progress * 360}deg)`;
  }, []);

  const resetPull = useCallback(() => {
    pulling.current = false;
    pullDistanceRef.current = 0;
    if (indicatorRef.current) {
      indicatorRef.current.style.transitionDuration = "200ms";
    }
    updateIndicator(0);
  }, [updateIndicator]);

  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (refreshing.current) return;
      const container = containerRef.current;
      const touch = e.touches[0];
      const target = e.target;
      if (
        !container ||
        !touch ||
        e.touches.length !== 1 ||
        !(target instanceof Element) ||
        // React touch events bubble through portals, so a touch inside a
        // Dialog/Sheet/Drawer would otherwise reach this handler.
        !container.contains(target) ||
        target.closest(OPT_OUT_SELECTOR) ||
        target.closest(EDITABLE_SELECTOR) ||
        isAnyAncestorScrolled(target)
      ) {
        // Adding a second finger cancels an already-started pull too. Waiting
        // for touchcancel is unreliable when the gesture begins at scroll-top.
        resetPull();
        return;
      }
      touchStartX.current = touch.clientX;
      touchStartY.current = touch.clientY;
      pulling.current = true;
      if (indicatorRef.current) {
        indicatorRef.current.style.transitionDuration = "0ms";
      }
    },
    [resetPull],
  );

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (refreshing.current) return;
      if (e.touches.length !== 1) {
        resetPull();
        return;
      }
      const touch = e.touches[0];
      if (!pulling.current || !touch) return;
      const deltaX = touch.clientX - touchStartX.current;
      const deltaY = touch.clientY - touchStartY.current;
      // Upward or mostly-sideways (carousels, SelectorRow) — not a pull.
      if (deltaY < 0 || (pullDistanceRef.current === 0 && Math.abs(deltaX) > deltaY)) {
        resetPull();
        return;
      }
      const dampened = Math.min(deltaY * 0.5, MAX_PULL);
      pullDistanceRef.current = dampened;
      updateIndicator(dampened);
    },
    [resetPull, updateIndicator],
  );

  const handleTouchEnd = useCallback(async () => {
    if (refreshing.current || !pulling.current) return;
    const distance = pullDistanceRef.current;
    // Consume the gesture before awaiting. Indicator progress is independent
    // of the completed gesture, so another touch-end cannot replay it.
    pulling.current = false;
    pullDistanceRef.current = 0;

    if (indicatorRef.current) {
      indicatorRef.current.style.transitionDuration = "200ms";
    }

    if (distance >= THRESHOLD) {
      refreshing.current = true;
      updateIndicator(THRESHOLD);
      if (iconRef.current) {
        iconRef.current.style.animation = "spin 0.8s linear infinite";
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // A hung request (offline, stalled socket) must not leave the spinner
        // up and the gesture locked forever. The refetch keeps running in the
        // background; the queries on screen show their own result or error.
        await Promise.race([
          onRefresh(),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, REFRESH_TIMEOUT_MS);
          }),
        ]);
      } finally {
        clearTimeout(timer);
        refreshing.current = false;
        resetPull();
        if (iconRef.current) {
          iconRef.current.style.animation = "none";
        }
      }
    } else {
      resetPull();
    }
  }, [onRefresh, resetPull, updateIndicator]);

  const handleTouchCancel = useCallback(() => {
    // A later cancelled gesture must not hide an in-flight refresh.
    if (!refreshing.current) resetPull();
  }, [resetPull]);

  return (
    <div
      ref={containerRef}
      className="contents"
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchCancel}
    >
      <div
        ref={indicatorRef}
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center transition-[transform,opacity] duration-200 motion-reduce:transition-none"
        style={{ opacity: 0, transform: "translateY(-40px)" }}
      >
        <span className="flex size-9 items-center justify-center rounded-full border bg-background shadow-sm">
          <Loader2 ref={iconRef} className="size-5 text-muted-foreground" />
        </span>
      </div>
      {children}
    </div>
  );
}
