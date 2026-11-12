import { Loader2 } from "lucide-react";
import { useCallback, useRef } from "react";

interface PullToRefreshProps {
  onRefresh: () => Promise<void>;
  children: React.ReactNode;
}

const THRESHOLD = 80;
const MAX_PULL = 128;

function getScrollContainer(element: HTMLElement | null): HTMLElement | null {
  let current = element?.parentElement ?? null;
  while (current) {
    const overflowY = window.getComputedStyle(current).overflowY;
    if (
      (overflowY === "auto" || overflowY === "scroll") &&
      current.scrollHeight > current.clientHeight
    ) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

export default function PullToRefresh({ onRefresh, children }: PullToRefreshProps) {
  // Refresh progress is shown imperatively via the indicator/icon refs, never
  // through rendered JSX, so a ref (not state) is the right primitive — it gates
  // the gesture handlers without triggering a re-render.
  const refreshing = useRef(false);
  const touchStartY = useRef(0);
  const pulling = useRef(false);
  const pullDistanceRef = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const indicatorRef = useRef<HTMLDivElement>(null);
  const iconRef = useRef<SVGSVGElement>(null);

  // Only touches refs and a module constant, so it is stable for the lifetime
  // of the component — memoized here so the touch handlers below can list it as
  // the dependency it actually is instead of closing over a per-render copy.
  const updateIndicator = useCallback((distance: number) => {
    const indicator = indicatorRef.current;
    const icon = iconRef.current;
    if (!indicator || !icon) return;
    const progress = Math.min(distance / THRESHOLD, 1);
    indicator.style.height = distance > 0 ? `${distance}px` : "0";
    Object.assign(icon.style, {
      opacity: String(progress),
      transform: `rotate(${progress * 360}deg)`,
    });
  }, []);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    const container = containerRef.current;
    const scrollContainer = getScrollContainer(container);
    const touch = e.touches[0];
    if (!container || !touch || (scrollContainer?.scrollTop ?? 0) > 0 || refreshing.current) return;
    touchStartY.current = touch.clientY;
    pulling.current = true;
    if (indicatorRef.current) {
      indicatorRef.current.style.transitionDuration = "0ms";
    }
  }, []);

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      const touch = e.touches[0];
      if (!pulling.current || !touch) return;
      const delta = touch.clientY - touchStartY.current;
      if (delta < 0) {
        pulling.current = false;
        pullDistanceRef.current = 0;
        updateIndicator(0);
        return;
      }
      const dampened = Math.min(delta * 0.5, MAX_PULL);
      pullDistanceRef.current = dampened;
      updateIndicator(dampened);
    },
    [updateIndicator],
  );

  const handleTouchEnd = useCallback(async () => {
    if (!pulling.current && pullDistanceRef.current === 0) return;
    pulling.current = false;

    if (indicatorRef.current) {
      indicatorRef.current.style.transitionDuration = "200ms";
    }

    if (pullDistanceRef.current >= THRESHOLD) {
      refreshing.current = true;
      pullDistanceRef.current = THRESHOLD / 2;
      updateIndicator(THRESHOLD / 2);
      if (iconRef.current) {
        iconRef.current.style.animation = "spin 0.8s linear infinite";
      }
      try {
        await onRefresh();
      } finally {
        refreshing.current = false;
        pullDistanceRef.current = 0;
        updateIndicator(0);
        if (iconRef.current) {
          iconRef.current.style.animation = "none";
        }
      }
    } else {
      pullDistanceRef.current = 0;
      updateIndicator(0);
    }
  }, [onRefresh, updateIndicator]);

  return (
    <div
      ref={containerRef}
      className="relative min-h-full"
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      <div
        ref={indicatorRef}
        className="flex items-center justify-center overflow-hidden transition-[height] duration-200"
        style={{ height: 0 }}
      >
        <Loader2 ref={iconRef} className="size-5 text-muted-foreground" style={{ opacity: 0 }} />
      </div>
      {children}
    </div>
  );
}
