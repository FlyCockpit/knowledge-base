import { useCallback, useSyncExternalStore } from "react";

import {
  type ConsentState,
  clearConsent,
  readConsent,
  readServerConsent,
  subscribeConsent,
  writeConsent,
} from "@/lib/consent";

export type UseConsentResult = {
  /** True only when the visitor explicitly allowed analytics. */
  analytics: boolean;
  /** True once a choice exists; the banner renders while this is false. */
  decided: boolean;
  /** Allow analytics. */
  accept: () => void;
  /** Refuse analytics — must be exactly as easy as `accept`. */
  reject: () => void;
  /** Forget the choice so the banner reappears (withdrawal). */
  reset: () => void;
};

/**
 * React binding for the consent core (`@/lib/consent`).
 *
 * Uses `useSyncExternalStore` so the
 * component participates in concurrent rendering instead of mirroring external
 * state through a `useEffect` (banned in components/routes by AGENTS.md).
 *
 * Hydration safety: the server snapshot is always `null` (undecided) and the
 * client snapshot is a cached-by-reference parse of `localStorage`, so the
 * value is stable across renders. The banner is additionally mounted inside
 * `<ClientOnly>` in `__root.tsx`, so no consent UI is ever server-rendered and
 * the first client render cannot disagree with the SSR HTML.
 */
export function useConsent(): UseConsentResult {
  const state: ConsentState = useSyncExternalStore(
    subscribeConsent,
    readConsent,
    readServerConsent,
  );

  const accept = useCallback(() => {
    writeConsent(true);
  }, []);
  const reject = useCallback(() => {
    writeConsent(false);
  }, []);
  const reset = useCallback(() => {
    clearConsent();
  }, []);

  return {
    analytics: state?.analytics === true,
    decided: state !== null,
    accept,
    reject,
    reset,
  };
}
