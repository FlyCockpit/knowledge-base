import { Button } from "@knowledge-base/ui/components/button";
import { useTranslation } from "react-i18next";

import { useConsent } from "@/hooks/use-consent";
import { analyticsConfigured } from "@/lib/analytics";

import { reserveConsentInset } from "./consent-inset";

/**
 * First-visit cookie banner, only in an app that has analytics
 * (`analyticsConfigured`, lib/analytics.ts). Without it there is nothing to
 * ask: strictly necessary cookies need no consent, so it renders nothing and
 * reserves no space. Mounted once from `__root.tsx` inside
 * `<ClientOnly>` so it is never server-rendered (no hydration mismatch, and
 * nothing in the SSR HTML depends on a per-visitor decision).
 *
 * Non-modal on purpose: it does not trap focus or block the page. Nor does it
 * cover it: it publishes its height (`reserveConsentInset`) and the shells'
 * `<main>` scrollers pad their bottom by that much, so every line of the page
 * (the auth pages' links above all) scrolls into view above it. The shell
 * frames are not padded: the header, a sidebar and the BottomNav still span
 * the viewport. See docs/ui.md § Shell rules
 *
 * What actually stops analytics from loading is the gate — `useAnalyticsConsent()`
 * calls `loadAnalytics()` only after a positive decision — not this UI.
 *
 * Both choices are one tap, the same size, and the same variant: under GDPR,
 * refusing must be exactly as easy as accepting. Do not promote one of these
 * buttons, shrink the other, or add a "not now" that stores nothing.
 */
export function ConsentBanner() {
  const { t } = useTranslation("consent");
  const { decided, accept, reject } = useConsent();

  if (!analyticsConfigured || decided) return null;

  return (
    <section
      ref={reserveConsentInset}
      aria-label={t("banner.title")}
      // Stays below the modal layer (Dialog/Sheet/AlertDialog are z-50): an
      // open modal makes the page inert, so a banner drawn over it would hide
      // the modal's buttons yet be unreachable by keyboard. It sits under the
      // mobile BottomNav (z-50) too. Its bottom padding is the home-indicator
      // inset, plus, on phones while the BottomNav is mounted
      // (`data-bottom-nav`, the app shell only), the nav's 3.5rem, so the nav
      // paints over that padding. Public pages, the 404 and the standalone
      // device/OAuth pages have no BottomNav, so they reserve nothing for it.
      // On md+ it floats as a card and only the inset matters. Entrance animation is disabled
      // automatically under `prefers-reduced-motion` by the global rule in
      // packages/ui/src/styles/globals.css.
      className="fixed inset-x-0 bottom-0 z-40 animate-in border-t bg-background/95 fade-in-0 pb-[var(--safe-area-bottom)] backdrop-blur-lg slide-in-from-bottom-2 max-md:[:root:has([data-bottom-nav])_&]:pb-[calc(3.5rem_+_var(--safe-area-bottom))] md:inset-x-auto md:right-4 md:bottom-4 md:max-w-md md:border md:ring-1 md:ring-foreground/10"
      style={{
        paddingLeft: "var(--safe-area-left)",
        paddingRight: "var(--safe-area-right)",
      }}
    >
      {/* Below `sm` the banner is one short line over two side-by-side
          buttons (~92px above the BottomNav at 320px), so a first visit on a
          phone still shows the page it opened; the full title and message
          return from `sm` up. The section's aria-label carries the title at
          every width. */}
      <div className="mx-auto flex max-w-3xl flex-col gap-2 px-4 py-2.5 sm:gap-3 sm:p-4">
        <p className="text-foreground text-xs/relaxed sm:hidden">{t("banner.short")}</p>
        <div className="hidden space-y-1 sm:block">
          <p className="font-medium text-foreground text-sm">{t("banner.title")}</p>
          <p className="text-muted-foreground text-xs/relaxed">{t("banner.message")}</p>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:flex sm:justify-end">
          <Button
            variant="outline"
            size="touch"
            className="min-w-0 max-sm:px-2 sm:min-w-40"
            onClick={reject}
          >
            {t("banner.reject")}
          </Button>
          <Button
            variant="outline"
            size="touch"
            className="min-w-0 max-sm:px-2 sm:min-w-40"
            onClick={accept}
          >
            {t("banner.accept")}
          </Button>
        </div>
      </div>
    </section>
  );
}
