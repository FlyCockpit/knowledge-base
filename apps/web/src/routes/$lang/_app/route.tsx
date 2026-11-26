import { cn } from "@knowledge-base/ui/lib/utils";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { createFileRoute, Outlet } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import { useTranslation } from "react-i18next";
import { AdminSetupBanner } from "@/components/admin-setup-banner";
import { AppSidebar } from "@/components/app-sidebar";
import BottomNav from "@/components/bottom-nav";
import Header from "@/components/header";
import { useDocumentLang } from "@/hooks/use-document-lang";
import { useMobileKeyboard } from "@/hooks/use-mobile-keyboard";
import { useUserLocaleSync } from "@/hooks/use-user-locale-sync";
import { MAIN_SCROLLER_ID } from "@/lib/main-scroller";

export const Route = createFileRoute("/$lang/_app")({
  // App/auth/admin surfaces depend on browser-only auth, PWA, viewport, and
  // navigation side effects. Keep this branch client-rendered while public
  // pages remain SSR-capable under `/$lang/_public`.
  ssr: false,
  component: AppShellLayout,
});

function AppShellLayout() {
  // Service-worker registration (useAppUpdate) lives in __root so public
  // pages get it too — don't re-add it here.
  useDocumentLang();
  useUserLocaleSync();
  const mobileKeyboardOpen = useMobileKeyboard();
  const { t } = useTranslation("nav");

  return (
    <>
      {/* First tab stop: past the header and sidebar to the page (WCAG 2.4.1). */}
      <a
        href="#main-content"
        className="sr-only z-50 bg-background text-sm font-medium focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:px-4 focus:py-3 focus:outline-none focus:ring-2 focus:ring-ring"
      >
        {t("skipToContent")}
      </a>
      <div
        className={cn(
          "grid h-svh min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[auto_1fr_auto] md:grid-rows-[auto_1fr] md:pb-(--consent-clearance)",
          // The bottom reserve: the cookie banner's clearance (index.css; 0
          // without a banner) and, on phones with no keyboard up, at least the
          // BottomNav's. The banner reaches down behind the BottomNav, so it
          // is the larger while it shows.
          mobileKeyboardOpen
            ? "pb-(--consent-clearance)"
            : "pb-[max(calc(3.5rem_+_var(--safe-area-bottom)),var(--consent-clearance))]",
        )}
        style={{
          paddingTop: "var(--safe-area-top)",
          paddingLeft: "var(--safe-area-left)",
          paddingRight: "var(--safe-area-right)",
        }}
      >
        <div>
          <Header />
          <AdminSetupBanner />
        </div>
        <div className="flex min-h-0 min-w-0">
          <AppSidebar />
          {/* No `scrollbar-gutter: stable`: the banners and sticky sub-navs
              inside the scroller are full-bleed. This shell has no footer:
              phones get the BottomNav, and Cookie preferences sits in Settings.
              See docs/ui.md § Shell rules. */}
          <main
            id="main-content"
            tabIndex={-1}
            data-scroll-restoration-id={MAIN_SCROLLER_ID}
            className="relative min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-clip overscroll-contain outline-none"
          >
            <Outlet />
          </main>
        </div>
        <BottomNav hidden={mobileKeyboardOpen} />
      </div>
      {import.meta.env.DEV && (
        <>
          <TanStackRouterDevtools position="bottom-left" />
          <ReactQueryDevtools position="bottom" buttonPosition="bottom-right" />
        </>
      )}
    </>
  );
}
