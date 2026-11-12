import { StartClient } from "@tanstack/react-start/client";
import { StrictMode, startTransition } from "react";
import { hydrateRoot } from "react-dom/client";

import i18n, { loadLocale } from "@/i18n";
import { localeFromPathname } from "@/i18n/config";

/**
 * Ensure the URL locale's bundles are registered before hydration. The server
 * rendered a non-default-locale page with that locale's strings (see
 * `$lang`'s `beforeLoad` + `createRequestI18n`), but SSR'd matches do NOT
 * re-run `beforeLoad` on the client during hydration — without this preload,
 * React would hydrate localized HTML against default-language fallback
 * strings and mismatch on every translated node.
 */
async function prepareI18n(): Promise<void> {
  const segment = localeFromPathname(window.location.pathname);
  if (!segment) return;
  try {
    await loadLocale(segment);
    if (i18n.language !== segment) {
      await i18n.changeLanguage(segment);
    }
  } catch {
    // Recoverable: loadLocale leaves a failed locale retryable, and hydrating
    // with fallback strings beats never hydrating. The next `languageChanged`
    // re-attempts the fetch.
  }
}

// Hydration must never hang on the locale fetch: `prepareI18n` handles a
// REJECTED chunk request, but a request that stalls forever (proxy buffering,
// a dropped mobile connection) would otherwise leave the SSR HTML visible with
// every button permanently dead. Past the deadline, hydrate with fallback
// strings and let React recover from any localized-text mismatches — the
// locale stays retryable and swaps in when the fetch finally lands.
//
// `startTransition` keeps hydration interruptible. It measured as a coin flip
// on this app — don't remove it on that basis, and re-measure with an
// interleaved A/B/A before claiming otherwise.
const I18N_HYDRATION_TIMEOUT_MS = 3000;

void Promise.race([
  prepareI18n(),
  new Promise<void>((resolve) => {
    window.setTimeout(resolve, I18N_HYDRATION_TIMEOUT_MS);
  }),
]).then(() => {
  startTransition(() => {
    hydrateRoot(
      document,
      <StrictMode>
        <StartClient />
      </StrictMode>,
    );
  });
});
