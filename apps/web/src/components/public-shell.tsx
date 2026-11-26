import { buttonVariants } from "@knowledge-base/ui/components/button";
import { Link, useParams } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AppBrand } from "@/components/app-brand";
import { LanguageSwitcher } from "@/components/language-switcher";
import { ModeToggle } from "@/components/mode-toggle";
import NotFoundState from "@/components/not-found-state";
import { PublicFooter } from "@/components/public-footer";
import { DEFAULT_LOCALE, isSupportedLocale } from "@/i18n/config";
import { MAIN_SCROLLER_ID } from "@/lib/main-scroller";
import { getNavItems, toLangRoute } from "@/lib/nav-items";

/**
 * The public shell: header, the one page scroller and the footer. The `_public`
 * layout renders its routes through it, and so does the 404 for an unknown URL
 * (`$lang`'s `notFoundComponent`), so that page keeps the header's language and
 * theme controls, the footer and the scroller. See docs/ui.md § Shell rules.
 */
export function PublicShell({ children }: { children: ReactNode }) {
  return (
    <div
      className="grid h-svh min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[auto_1fr]"
      style={{
        paddingTop: "var(--safe-area-top)",
        // The home-indicator inset only: the frame always reaches the bottom
        // of the viewport. A cookie banner's reserve is <main>'s.
        paddingBottom: "var(--safe-area-bottom)",
        paddingLeft: "var(--safe-area-left)",
        paddingRight: "var(--safe-area-right)",
      }}
    >
      <PublicHeader />
      {/* No `scrollbar-gutter: stable`: a reserved gutter stops the footer's
          and every other full-bleed rule inside the scroller short of the
          viewport edge with classic scrollbars. */}
      {/* While a cookie banner shows (only in an app with analytics), the
          scroller's content ends where it starts: its bottom padding is the
          banner's clearance beyond the frame's home-indicator inset
          (index.css; 0 without a banner). */}
      <main
        data-scroll-restoration-id={MAIN_SCROLLER_ID}
        className="relative min-h-0 min-w-0 overflow-y-auto overflow-x-clip overscroll-contain pb-[max(0px,calc(var(--consent-clearance)_-_var(--safe-area-bottom)))]"
      >
        {/* At least as tall as the scroller: the page grows into the space,
            so the footer ends at the scroller's bottom on a short page and
            follows the content on a long one. */}
        <div className="flex min-h-full min-w-0 flex-col">
          <div className="flex min-w-0 flex-1 flex-col">{children}</div>
          <PublicFooter />
        </div>
      </main>
    </div>
  );
}

function PublicHeader() {
  // `strict: false`: the 404 renders this header under `$lang` as well as the
  // `_public` routes. An unsupported value never gets this far (`$lang`
  // redirects it), but fall back rather than build a broken link.
  const langParam = useParams({ strict: false, select: (p) => p.lang });
  const lang = isSupportedLocale(langParam) ? langParam : DEFAULT_LOCALE;
  const { t } = useTranslation("nav");
  // Deliberately always the logged-out nav: public pages stay fully static —
  // no session fetch, no better-auth chunk, SSR HTML identical for everyone.
  // The Sign In link below is the static auth entry point that comes with
  // that choice. Known tradeoff: a signed-in user's server-side locale
  // preference can't redirect these pages (that would need a session fetch);
  // it applies once they enter the `_app` branch (`useUserLocaleSync`).
  const items = getNavItems({ placement: "desktop", isAuthenticated: false });

  return (
    <header>
      {/* The app header's row gap: 16px from `sm:`, 8px on phones, where
          the 44px brand and the es-MX controls fit 320px with 16px edges. */}
      <div className="flex min-w-0 flex-row items-center gap-2 px-4 py-2 sm:gap-4">
        <AppBrand lang={lang} />
        {/* The public branch has no BottomNav, so from `sm:` up this
            scrollable row is its navigation. Below `sm:` there is no room for
            it next to the controls, and the brand already links home; hidden,
            it costs no gap either. */}
        <nav
          aria-label={t("mainNav.ariaLabel")}
          className="hidden min-w-0 flex-1 overflow-x-auto overflow-y-hidden overscroll-x-contain no-scrollbar sm:block"
        >
          <div className="flex w-max items-center gap-1">
            {items.map((item) => (
              <Link
                key={item.id}
                to={toLangRoute(item.path)}
                params={{ lang }}
                activeOptions={{ exact: item.exact }}
                className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 md:min-h-9"
                activeProps={{
                  className: "bg-muted text-foreground",
                }}
              >
                <item.icon aria-hidden="true" className="size-4" />
                <span>{t(item.labelKey)}</span>
              </Link>
            ))}
          </div>
        </nav>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <LanguageSwitcher />
          <ModeToggle />
          <Link
            to="/$lang/login"
            params={{ lang }}
            search={{ redirectTo: undefined }}
            // The app header's Sign In metrics (`touch`), filled: it is this
            // page's entry point. Wider, it ran past the line at 320px.
            className={buttonVariants({ size: "touch" })}
          >
            {t("userMenu.signIn")}
          </Link>
        </div>
      </div>
      <hr />
    </header>
  );
}

/**
 * The 404 for an unknown URL, which matches no layout: `$lang`'s
 * `notFoundComponent`, so it renders in `$lang`'s outlet with nothing around
 * it. Wrapped in the public shell, it keeps the header (language, theme, Sign
 * In), the footer and the scroller like every other public page.
 */
export function PublicNotFoundPage() {
  return (
    <PublicShell>
      <NotFoundState />
    </PublicShell>
  );
}
