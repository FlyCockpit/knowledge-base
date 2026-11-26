import { useEffect } from "react";

import { analyticsConfigured, disableAnalytics, loadAnalytics } from "@/lib/analytics";

import { useConsent } from "./use-consent";

/**
 * The analytics gate. Mounted once from `__root.tsx`; it renders nothing and
 * synchronizes the provider whenever the visitor's decision changes.
 * `loadAnalytics()` latches internally, so a re-decision or a cross-tab
 * `storage` event cannot load the snippet twice; `disableAnalytics()` tears
 * it down immediately when consent is withdrawn.
 *
 * The effect lives in a hook (this file) because direct `useEffect` is banned
 * in `apps/web/src/components/**` and `apps/web/src/routes/**`. It never runs
 * during SSR, and consent is always `false` until the client has read storage,
 * so nothing analytics-related can execute before a decision exists. In an
 * app with no provider (`analyticsConfigured` false, the default) it never
 * calls the seam at all, whatever an old stored decision says.
 */
export function useAnalyticsConsent(): void {
  const { analytics } = useConsent();

  useEffect(() => {
    if (!analyticsConfigured) return;
    if (analytics) {
      loadAnalytics();
    } else {
      disableAnalytics();
    }
  }, [analytics]);
}
