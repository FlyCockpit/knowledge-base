import { createFileRoute, redirect } from "@tanstack/react-router";

import { loadLocaleInto } from "@/i18n";
import { isSupportedLocale, type Locale } from "@/i18n/config";
import { decideLocaleRedirect } from "@/i18n/redirect-to-default";

/**
 * Locale-prefix layout. Every URL in the app lives under `/$lang/...` —
 * this route validates the param and swaps the active i18n language; the
 * nested page renders through the default `<Outlet />`.
 *
 * Validation contract:
 *  - `params.lang` is a supported locale (en-US, es-MX, …) → render.
 *  - `params.lang` is anything else (a missing-prefix path like `/dashboard`,
 *    or an unknown locale like `/xx-XX/about`) → 302 to `/${DEFAULT_LOCALE}`
 *    plus the rest of the URL, preserving search + hash.
 *
 * The redirect logic is in `i18n/redirect-to-default.ts` so the
 * decision-making is unit-testable without dragging in React-only modules.
 */
export const Route = createFileRoute("/$lang")({
  beforeLoad: async ({ params, location, context }) => {
    const instruction = decideLocaleRedirect({ params, location });
    if (instruction) throw redirect(instruction);

    // `context.i18n` is the per-request instance on the server and the app
    // singleton on the client (router.tsx `getI18n`), so this is race-free
    // under concurrent SSR and a cheap memoized no-op on client navigations.
    // Initial client hydration never re-runs this beforeLoad (SSR'd matches
    // rehydrate their server context instead) — client.tsx preloads the URL
    // locale before hydrateRoot to keep the markup matching.
    //
    // On the client, `changeLanguage` also persists the choice: the language
    // detector's `caches: ["localStorage"]` (i18n/index.ts) writes the
    // `locale` key on every language change, so no separate effect is needed.
    if (isSupportedLocale(params.lang)) {
      try {
        await loadLocaleInto(context.i18n, params.lang);
      } catch (error) {
        // Recoverable — same policy as client.tsx and the `languageChanged`
        // handler: a failed locale-chunk fetch (plausible during a PWA
        // deploy/cache transition) degrades to default-language fallback
        // strings instead of failing the whole navigation with an error
        // screen. fetchLocaleBundles leaves a rejected locale retryable, so
        // the next navigation re-attempts the fetch.
        console.error(`[i18n] failed to load locale "${params.lang}"`, error);
      }
      if (context.i18n.language !== params.lang) {
        await context.i18n.changeLanguage(params.lang as Locale);
      }
    }
  },
});
