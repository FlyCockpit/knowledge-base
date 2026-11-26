import { cn } from "@knowledge-base/ui/lib/utils";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { createFileRoute, Outlet } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AdminSetupBanner } from "@/components/admin-setup-banner";
import { AppSidebar } from "@/components/app-sidebar";
import BottomNav from "@/components/bottom-nav";
import Header from "@/components/header";
import { OfflineBand } from "@/components/offline-band";
import { RouteContentSkeleton } from "@/components/route-content-skeleton";
import { useDocumentLang } from "@/hooks/use-document-lang";
import { useMobileKeyboard } from "@/hooks/use-mobile-keyboard";
import { useReloadOnIdentityChange } from "@/hooks/use-reload-on-identity-change";
import { useUserLocaleSync } from "@/hooks/use-user-locale-sync";
import { MAIN_SCROLLER_ID } from "@/lib/main-scroller";
import { SessionUnconfirmed } from "@/lib/session-unconfirmed";

export const Route = createFileRoute("/$lang/_app")({
  // App/auth/admin surfaces depend on browser-only auth, PWA, viewport, and
  // navigation side effects. Keep this branch client-rendered while public
  // pages remain SSR-capable under `/$lang/_public`.
  ssr: false,
  // What a hard refresh paints first. With `ssr: false` the server renders
  // this route's pending component in place of the layout, and the client
  // shows it again until the layout can mount (hydration, the auth check).
  // So it is the real shell (header, sidebar, bottom nav) around a skeleton
  // of the page's content area only: no frame without the sidebar/nav, and
  // no layout jump when the page arrives; `pnpm check:shell-loading`
  // measures it. See docs/ui.md § Route pending states
  pendingComponent: AppShellPending,
  component: AppShellLayout,
});

function AppShellLayout() {
  // Service-worker registration (useAppUpdate) lives in __root so public
  // pages get it too — don't re-add it here.
  // Whose cached data this document holds: a different confirmed identity
  // replaces the document (docs/ui.md § Query cache follows identity).
  useReloadOnIdentityChange();
  useDocumentLang();
  useUserLocaleSync();

  return (
    <>
      <AppShellFrame>
        <Outlet />
      </AppShellFrame>
      {import.meta.env.DEV && (
        <>
          <TanStackRouterDevtools position="bottom-left" />
          <ReactQueryDevtools position="bottom" buttonPosition="bottom-right" />
        </>
      )}
    </>
  );
}

/** The shell around the loading page: same frame, content skeleton only. */
function AppShellPending() {
  // Painted before the session guards admit anyone: the chrome names no
  // account yet (docs/ui.md § Query cache follows identity).
  return (
    <SessionUnconfirmed>
      <AppShellFrame>
        <RouteContentSkeleton />
      </AppShellFrame>
    </SessionUnconfirmed>
  );
}

/**
 * The app frame, shared by the layout and its pending state so the two are
 * the same boxes: the header, the sidebar and the bottom nav never move when
 * the page replaces its skeleton.
 */
function AppShellFrame({ children }: { children: ReactNode }) {
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
          "grid h-svh min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[auto_1fr_auto] md:grid-rows-[auto_1fr]",
          // The frame reserves the BottomNav (phones, no keyboard up) and
          // nothing else: the header and the sidebar always reach the bottom
          // of the viewport. The cookie banner's reserve is `<main>`'s, below.
          !mobileKeyboardOpen && "pb-[calc(3.5rem_+_var(--safe-area-bottom))] md:pb-0",
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
          {/* In the top row, above the scroller: it never covers the page,
              the BottomNav or the cookie banner. */}
          <OfflineBand />
        </div>
        <div className="flex min-h-0 min-w-0">
          <AppSidebar />
          {/* No `scrollbar-gutter: stable`: the banners and sticky sub-navs
              inside the scroller are full-bleed. This shell has no footer:
              phones get the BottomNav, and Cookie preferences (with analytics) sits in Settings.
              See docs/ui.md § Shell rules. */}
          <main
            id="main-content"
            tabIndex={-1}
            data-scroll-restoration-id={MAIN_SCROLLER_ID}
            className={cn(
              "relative min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-clip overscroll-contain outline-none",
              // While a cookie banner shows (only in an app with analytics),
              // the scroller's bottom padding is the part of it the banner
              // covers (`--consent-clearance`, index.css; 0 without a banner),
              // so every line of the page scrolls into view above it. On
              // phones the frame already reserves the BottomNav, which the
              // banner reaches down behind, so only the rest is padded here.
              mobileKeyboardOpen
                ? "pb-(--consent-clearance)"
                : "pb-[max(0px,calc(var(--consent-clearance)_-_3.5rem_-_var(--safe-area-bottom)))] md:pb-(--consent-clearance)",
            )}
          >
            {children}
          </main>
        </div>
        <BottomNav hidden={mobileKeyboardOpen} />
      </div>
    </>
  );
}
