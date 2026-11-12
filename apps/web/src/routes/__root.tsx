// The bundler resolves this to the content-hashed /assets URL of the Latin
// variable Roboto subset — the one the UI actually paints (the other subsets
// stay gated behind their unicode-range). Used to <link rel="preload"> it so it
// downloads in parallel with the CSS instead of being discovered only after the
// stylesheet parses (which puts it at the tail of the critical request chain).
import robotoLatinUrl from "@fontsource-variable/roboto/files/roboto-latin-wght-normal.woff2?url";
import { THEME_INIT_SCRIPT } from "@knowledge-base/config/theme-init";
import { env } from "@knowledge-base/env/web";
import { Toaster } from "@knowledge-base/ui/components/sileo";
import type { QueryClient } from "@tanstack/react-query";
import {
  ClientOnly,
  createRootRouteWithContext,
  HeadContent,
  Outlet,
  Scripts,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import type { i18n as I18nInstance } from "i18next";
import { NuqsAdapter } from "nuqs/adapters/tanstack-router";
import type { ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import { ConsentBanner } from "@/components/consent/consent-banner";
import ErrorState from "@/components/error-state";
import { FileDropGuard } from "@/components/file-drop-guard";
import { ThemeColorSync } from "@/components/theme-color-sync";
import { ThemeProvider } from "@/components/theme-provider";
import { UiLabelsBridge } from "@/components/ui-labels-bridge";
import { useAnalyticsConsent } from "@/hooks/use-analytics-consent";
import { useAppUpdate } from "@/hooks/use-app-update";
import { useHashTargetScroll } from "@/hooks/use-hash-target-scroll";
import { useStaleBuildRecovery } from "@/hooks/use-stale-build-recovery";
import { DEFAULT_LOCALE, localeFromPathname } from "@/i18n/config";
import { I18nReady } from "@/i18n/I18nReady";
import { isNotFoundHead, pageTitle } from "@/lib/page-title";
import { orpc } from "@/utils/orpc";

import "../index.css";

export interface RouterAppContext {
  orpc: typeof orpc;
  queryClient: QueryClient;
  /**
   * Per-request instance on the server, the app singleton on the client — see
   * `getI18n` in router.tsx. Render-path code (providers, `$lang`'s
   * `beforeLoad`) must use this, never the `@/i18n` module import, or
   * concurrent SSR requests race on the shared language.
   */
  i18n: I18nInstance;
  /**
   * Server-only same-origin URL of the active non-default locale's grouped
   * bundle chunk (from the client Vite manifest via
   * `x-locale-modulepreload`). Used to emit `<link rel="modulepreload">` so
   * the browser fetches the locale chunk in parallel with hydration JS.
   * Undefined on the client and for the default locale.
   */
  localeModulePreloadUrl?: string;
  /**
   * Configured canonical app origin (server: `x-canonical-origin` from the API
   * server; client: the origin of the server-rendered canonical link). Only the public home page uses
   * it, for canonical/hreflang/og URLs. Undefined when absent or invalid.
   */
  canonicalOrigin?: string;
}

const APP_NAME = env.VITE_APP_NAME;

export const Route = createRootRouteWithContext<RouterAppContext>()({
  // Root must stay SSR-capable so public descendants can opt into full SSR.
  // Browser/auth/PWA shell behavior lives under pathless child layouts that set
  // `ssr: false`, because TanStack Start only lets children make inherited SSR
  // more restrictive.
  shellComponent: RootShell,
  component: RootComponent,
  errorComponent: ErrorState,
  head: ({ match, matches }) => ({
    meta: [
      { charSet: "utf-8" },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1.0, viewport-fit=cover",
      },
      { name: "apple-mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-status-bar-style", content: "black" },
      { name: "mobile-web-app-capable", content: "yes" },
      // NOTE: `theme-color` is intentionally NOT declared here. It is managed
      // imperatively so it tracks the RESOLVED app theme (next-themes) rather
      // than the OS prefers-color-scheme — THEME_INIT_SCRIPT creates it on the
      // first frame and `useThemeColorMeta` updates it on in-app toggles. A
      // static media-keyed meta here would fight that and reintroduce the
      // white-status-bar-in-dark-mode bug when the OS and app themes disagree.
      {
        // Deeper routes name their page; an unknown URL whose boundary has
        // no head of its own still says so (R3-W9).
        title: isNotFoundHead(matches)
          ? pageTitle(match.context.i18n.t("errors:pageNotFound.title"))
          : APP_NAME,
      },
      {
        name: "description",
        // Resolve via the ROUTER-CONTEXT instance, never the `@/i18n` module
        // singleton: on the server all language switching happens on the
        // per-request instance (`$lang`'s beforeLoad), and the singleton stays
        // pinned to DEFAULT_LOCALE — reading it here would ship a
        // default-language description in every non-default-locale SSR page.
        content: match.context.i18n.t("errors:pageDescription", { appName: APP_NAME }),
      },
    ],
    links: [
      // Preload the Latin Roboto subset to pull it out of the critical request
      // chain (HTML → CSS → @font-face → font). `crossOrigin` is required even
      // same-origin: fonts fetch in CORS mode, and an attribute mismatch with
      // the @font-face request would cause a duplicate download.
      {
        rel: "preload",
        href: robotoLatinUrl,
        as: "font",
        type: "font/woff2",
        crossOrigin: "anonymous",
      },
      // Non-default locales load as one grouped `locale-<tag>` chunk. When the API
      // server resolved that chunk from the client Vite manifest, modulepreload
      // it so the browser starts the download in parallel with the main
      // hydration graph instead of waiting for prepareI18n's dynamic import.
      // Only the active URL locale is preloaded — never every locale.
      ...(match.context.localeModulePreloadUrl
        ? [
            {
              rel: "modulepreload" as const,
              href: match.context.localeModulePreloadUrl,
            },
          ]
        : []),
      {
        rel: "icon",
        href: "/favicon.ico",
      },
      { rel: "manifest", href: "/manifest.webmanifest" },
      { rel: "apple-touch-icon", sizes: "180x180", href: "/apple-touch-icon-180x180.png" },
    ],
  }),
});

function RootShell({ children }: { children: ReactNode }) {
  const lang = useRouterState({
    select: (state) => localeFromPathname(state.location.pathname) ?? DEFAULT_LOCALE,
  });

  // suppressHydrationWarning: THEME_INIT_SCRIPT stamps the resolved theme
  // class + color-scheme style on <html> before React hydrates (by design,
  // anti-FOUC), so these attributes never match the server render.
  return (
    <html lang={lang} style={{ colorScheme: "dark light" }} suppressHydrationWarning>
      <head>
        {/* Blocking anti-FOUC theme script, inlined (not an external request) so
            it runs before first paint with zero added latency on the critical
            render path. Allowed under `script-src 'self' 'nonce-…'` via a CSP
            sha256 hash derived from THEME_INIT_SCRIPT at server startup — see
            apps/server/src/index.ts. Must stay first in <head> and must NOT be
            async/defer. */}
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: CSP sha256 of THEME_INIT_SCRIPT is allowlisted at server boot. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { i18n: i18nInstance } = Route.useRouteContext();
  // next-themes injects its own inline theme script during SSR; without the
  // per-request CSP nonce the browser blocks it (a console CSP error on every
  // document load). THEME_INIT_SCRIPT above already prevents the theme flash.
  const cspNonce = useRouter().options.ssr?.nonce;
  // Root-level (not `_app`) so PUBLIC pages register the service worker too:
  // an installed PWA's default start_url is the public home, and without
  // registration there it would neither precache nor ever pick up new builds.
  // Effect-only — it never runs during SSR.
  useAppUpdate();
  useHashTargetScroll();
  useStaleBuildRecovery();
  // The analytics gate. Renders nothing; loads the (currently empty) analytics
  // seam once, and only once the visitor has allowed it. Root-level so public
  // pages are gated too.
  useAnalyticsConsent();
  return (
    <I18nextProvider i18n={i18nInstance}>
      <I18nReady>
        <UiLabelsBridge>
          <ThemeProvider
            attribute="class"
            defaultTheme="system"
            enableSystem
            disableTransitionOnChange
            storageKey="vite-ui-theme"
            nonce={cspNonce}
          >
            <NuqsAdapter>
              <Outlet />
            </NuqsAdapter>
            <ThemeColorSync />
            {/* ClientOnly: toasts are client feedback. sileo's toast queue is
              module-scoped, so on the SSR server a toast fired during one
              request's render would persist in the process and leak into every
              later user's SSR HTML. Never server-render the viewport. */}
            <ClientOnly>
              <Toaster />
              {/* Document-level drop swallow: dragging a file onto the SPA must
                never navigate the tab. Lives beside the Toaster because its
                unclaimed-drop feedback is a toast (must not SSR) and it needs
                `document`. Root-level so public pages are guarded too. */}
              <FileDropGuard />
              {/* ClientOnly for the same reason: the decision lives in the
                visitor's localStorage, so server-rendering the banner would
                either leak a wrong first frame or mismatch on hydration. It
                renders nothing once a choice exists. */}
              <ConsentBanner />
            </ClientOnly>
          </ThemeProvider>
        </UiLabelsBridge>
      </I18nReady>
    </I18nextProvider>
  );
}
