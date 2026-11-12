import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { AppBrand } from "@/components/app-brand";
import { LanguageSwitcher } from "@/components/language-switcher";
import { ModeToggle } from "@/components/mode-toggle";
import { MAIN_SCROLLER_ID } from "@/lib/main-scroller";
import { getNavItems, toLangRoute } from "@/lib/nav-items";

export const Route = createFileRoute("/$lang/_public")({
  component: PublicLayout,
});

function PublicLayout() {
  return (
    <div
      className="grid h-svh min-w-0 grid-rows-[auto_1fr]"
      style={{
        paddingTop: "var(--safe-area-top)",
        paddingBottom: "var(--safe-area-bottom)",
        paddingLeft: "var(--safe-area-left)",
        paddingRight: "var(--safe-area-right)",
      }}
    >
      <PublicHeader />
      <main
        data-scroll-restoration-id={MAIN_SCROLLER_ID}
        className="relative min-h-0 min-w-0 overflow-y-auto overflow-x-clip overscroll-contain [scrollbar-gutter:stable]"
      >
        <Outlet />
      </main>
    </div>
  );
}

function PublicHeader() {
  const { lang } = Route.useParams();
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
      <div className="flex min-w-0 flex-row items-center gap-4 px-4 py-2">
        <AppBrand lang={lang} />
        {/* Visible on every viewport — the public branch has no BottomNav, so
            this scrollable row is the only navigation mobile visitors get. */}
        <nav
          aria-label={t("mainNav.ariaLabel")}
          className="min-w-0 flex-1 overflow-x-auto overflow-y-hidden overscroll-x-contain no-scrollbar"
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
            className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            {t("userMenu.signIn")}
          </Link>
        </div>
      </div>
      <hr />
    </header>
  );
}
