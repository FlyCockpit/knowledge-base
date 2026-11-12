import { useSyncExternalStore } from "react";

/** Matches Tailwind `md` and `useIsMobile()` (`min-width: 768px`). */
export const MOBILE_BREAKPOINT_PX = 768;
export const DESKTOP_MEDIA_QUERY = `(min-width: ${MOBILE_BREAKPOINT_PX}px)`;

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (callback) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", callback);
      return () => mql.removeEventListener("change", callback);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

export function useIsMobile(): boolean {
  return !useMediaQuery(DESKTOP_MEDIA_QUERY);
}
