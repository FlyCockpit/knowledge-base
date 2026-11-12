import { useRouter } from "@tanstack/react-router";

import { useMountEffect } from "@/hooks/use-mount-effect";
import { recoverFromStaleChunk, USER_INPUT_WINDOW_MS } from "@/lib/stale-build-recovery";

function openSessionStorage(): Storage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

/**
 * After a deploy, recovers a tab running the old build when it fails to load
 * a chunk: one full navigation to the page the user was going to (see
 * lib/stale-build-recovery).
 */
export function useStaleBuildRecovery() {
  const router = useRouter();
  useMountEffect(() => {
    let recovering = false;
    // Our own input clock, not navigator.userActivation (sticky for ~5 s): a
    // hover or Tab focus preloads chunks and must never cause a reload.
    let lastInputAt = Number.NEGATIVE_INFINITY;
    let activatedNavigationHref: string | undefined;
    const unsubscribeNavigation = router.subscribe("onBeforeNavigate", ({ toLocation }) => {
      activatedNavigationHref =
        Date.now() - lastInputAt < USER_INPUT_WINDOW_MS ? toLocation.publicHref : undefined;
      lastInputAt = Number.NEGATIVE_INFINITY;
    });
    const unsubscribeRendered = router.subscribe("onRendered", () => {
      activatedNavigationHref = undefined;
      recovering = false;
    });
    const onPointerDown = () => {
      lastInputAt = Date.now();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") lastInputAt = Date.now();
    };
    // A page restored from the back/forward cache must be able to recover again.
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) recovering = false;
    };
    const onPreloadError = (event: Event) => {
      // One failed navigation can fail several chunks; the page is already leaving.
      if (recovering) {
        event.preventDefault();
        return;
      }
      const started = recoverFromStaleChunk({
        router,
        storage: openSessionStorage(),
        now: Date.now(),
        activatedNavigationHref,
        assign: (href) => window.location.assign(href),
      });
      if (!started) return;
      recovering = true;
      event.preventDefault();
    };
    window.addEventListener("vite:preloadError", onPreloadError);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      unsubscribeNavigation();
      unsubscribeRendered();
      window.removeEventListener("vite:preloadError", onPreloadError);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pageshow", onPageShow);
    };
  });
}
