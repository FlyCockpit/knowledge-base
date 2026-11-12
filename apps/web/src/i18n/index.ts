import i18n, { type i18n as I18nInstance } from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";

import {
  DEFAULT_LOCALE,
  isSupportedLocale,
  type Locale,
  localeFromPathname,
  NAMESPACES,
  SUPPORTED_LOCALES,
} from "./config";
import { installZodErrorMap } from "./zod";

type ResourceBundle = Record<string, unknown>;
type ResourceTree = Record<string, Record<string, ResourceBundle>>;

// The locale JSON bundles live in the shared `@knowledge-base/locales` package
// (`packages/locales/src/<locale>/<ns>.json`). The `@locales` Vite alias (see apps/web/vite.config.ts)
// points these globs at that package source; `import.meta.glob` supports
// aliased patterns, so the eager/lazy per-locale code-splitting is unchanged by
// the move.
//
// Only the default locale is bundled eagerly. Keeping it in the initial bundle
// means first paint and the synchronous Zod error-map install (below) never
// wait on a network round-trip, and the `fallbackLng` always has its strings on
// hand. Every OTHER locale is fetched on demand by `loadLocale()` — so adding a
// language costs nothing in the base bundle.
//
// The lazy glob below imports each namespace separately, but a `manualChunks`
// rule in apps/web/vite.config.ts collapses all of one locale's namespaces into
// a single `locale-<tag>` chunk, so a first visit to /es-MX/ is ONE request
// rather than one per namespace. That grouping lives in the bundler on purpose:
// there is no per-locale aggregate module to hand-maintain, so adding a
// namespace can't silently leave non-default visitors on the English fallback.
//
// `import.meta.glob` needs *static* patterns, so the eager glob and the lazy
// glob's negative pattern both hardcode the default-locale folder. If you
// change DEFAULT_LOCALE you must update both patterns (the dev-time assert
// below will flag the mismatch).
const eagerDefaultModules = import.meta.glob("@locales/en-US/*.json", {
  eager: true,
  import: "default",
}) as Record<string, ResourceBundle>;

// Lazy loaders for every non-default locale namespace. Each entry is a
// `() => import("@locales/<locale>/<ns>.json")`; the `manualChunks` rule groups
// one locale's entries into a single emitted chunk, so the N imports below cost
// one network request. Nothing here ships in the base bundle. Keep the negative
// patterns aligned with the eager default-locale glob above so those JSON files
// are never both statically and dynamically imported.
const lazyLocaleModules = import.meta.glob(["@locales/*/*.json", "!@locales/en-US/*.json"], {
  import: "default",
}) as Record<string, () => Promise<ResourceBundle>>;

if (import.meta.env.DEV && DEFAULT_LOCALE !== "en-US") {
  console.warn(
    `[i18n] DEFAULT_LOCALE is "${DEFAULT_LOCALE}" but the locale globs in i18n/index.ts are pinned to "en-US". ` +
      "Update both the eager glob and the negative lazy-glob pattern so the default locale ships only in the base bundle.",
  );
}

function parseLocalePath(path: string): { locale: string; ns: string } | undefined {
  // The glob keys are `@locales/<locale>/<ns>.json` (aliased to
  // packages/locales/src). Match the trailing `<locale>/<ns>.json` so this stays
  // agnostic to whether the bundler emits the alias, a relative, or an absolute
  // path for the key.
  const match = /([^/]+)\/([^/]+)\.json$/.exec(path);
  if (!match?.[1] || !match[2]) return undefined;
  return { locale: match[1], ns: match[2] };
}

function buildEagerResources(): ResourceTree {
  const out: ResourceTree = {};
  for (const [path, mod] of Object.entries(eagerDefaultModules)) {
    const parsed = parseLocalePath(path);
    if (!parsed) continue;
    const localeResources = out[parsed.locale] ?? {};
    out[parsed.locale] = localeResources;
    localeResources[parsed.ns] = mod;
  }
  return out;
}

const resources = buildEagerResources();

// Locales whose bundles are already registered with i18next. Seeded with every
// eagerly-bundled locale so we never re-fetch the default.
const loadedLocales = new Set<string>(Object.keys(resources));

/**
 * Fetch and register a locale's namespace bundles on demand. Idempotent and
 * safe to call repeatedly (concurrent calls dedupe via the in-flight map).
 * After the bundles register, react-i18next re-renders subscribed components,
 * so a non-default-locale visitor sees the default-language fallback for the
 * few milliseconds the chunk takes to load, then the localized strings.
 *
 * A failed load (a rejected chunk `import()` — plausible during a PWA
 * deploy/cache transition or a transient network blip) is recoverable: the
 * locale is NOT marked loaded and the in-flight entry is cleared either way, so
 * the next `languageChanged` (or an explicit retry) re-attempts the fetch
 * instead of being pinned forever to the same rejected promise.
 */
const inFlight = new Map<string, Promise<void>>();

// Fetched-bundle memo shared by every consumer (the app singleton and the
// per-request server instances). Bundle JSON is immutable, so caching the
// fetch across requests is safe — only i18n *instances* must be per-request
// on the server. A rejected fetch evicts itself so it stays retryable.
const bundleCache = new Map<string, Promise<Record<string, ResourceBundle>>>();
function fetchLocaleBundles(locale: string): Promise<Record<string, ResourceBundle>> {
  const existing = bundleCache.get(locale);
  if (existing) return existing;

  // Single pass over the module map: parse each path once and, for the paths
  // that belong to this locale, kick off the namespace load. Every one of these
  // imports resolves to the same emitted `locale-<tag>` chunk (see the
  // `manualChunks` rule in vite.config.ts), so this is one network request.
  const loads: Promise<readonly [string, ResourceBundle]>[] = [];
  for (const [path, load] of Object.entries(lazyLocaleModules)) {
    const parsed = parseLocalePath(path);
    if (parsed?.locale !== locale) continue;
    loads.push(load().then((bundle) => [parsed.ns, bundle] as const));
  }

  if (loads.length === 0) {
    // No JSON on disk for a locale that passed `isSupportedLocale` — the tag
    // was added to SUPPORTED_LOCALES without its bundle directory. Don't cache
    // the empty result, so it resolves once the files land.
    if (import.meta.env.DEV) {
      console.warn(
        `[i18n] No locale bundles found for "${locale}". Add packages/locales/src/${locale}/*.json ` +
          "— until then this locale falls back to DEFAULT_LOCALE strings.",
      );
    }
    return Promise.resolve({});
  }

  const task = Promise.all(loads)
    .then((pairs) => Object.fromEntries(pairs))
    .catch((error) => {
      bundleCache.delete(locale);
      throw error;
    });
  bundleCache.set(locale, task);
  return task;
}

/**
 * Did this locale's bundles already register on this instance? Registration is
 * atomic (one synchronous loop once the fetch resolves), so probing the first
 * namespace answers for all of them. Keyed off `NAMESPACES[0]` rather than a
 * hardcoded name so renaming a namespace can't silently turn this into a
 * permanent `false` — which would re-register (and re-render) on every call.
 */
function isLocaleRegistered(instance: I18nInstance, locale: string): boolean {
  return instance.hasResourceBundle(locale, NAMESPACES[0]);
}

/**
 * Register a locale's namespace bundles on the given i18n instance. Used by
 * `loadLocale` (app singleton) and by the `$lang` route's `beforeLoad` against
 * the per-request server instance from the router context.
 */
export function loadLocaleInto(instance: I18nInstance, locale: string): Promise<void> {
  if (!isSupportedLocale(locale) || locale === DEFAULT_LOCALE) return Promise.resolve();
  // Already registered on this instance → no-op. This guards re-renders, not
  // just wasted work: every addResourceBundle emits the store's "added" event,
  // and with `bindI18nStore: "added"` each re-register re-renders every
  // subscribed component — `$lang`'s beforeLoad calls this on every
  // client-side navigation. Registration is atomic (one synchronous loop once
  // the fetch resolves), so checking a single namespace is sufficient.
  if (isLocaleRegistered(instance, locale)) return Promise.resolve();
  return fetchLocaleBundles(locale).then((bundles) => {
    for (const [ns, bundle] of Object.entries(bundles)) {
      // `deep`+`overwrite` so a re-register is a no-op rather than a merge bug.
      instance.addResourceBundle(locale, ns, bundle, true, true);
    }
  });
}

export function loadLocale(locale: string): Promise<void> {
  if (loadedLocales.has(locale)) return Promise.resolve();
  const existing = inFlight.get(locale);
  if (existing) return existing;

  const task = loadLocaleInto(i18n, locale)
    // Only mark the locale loaded once its namespaces actually registered — a
    // locale with no bundles on disk (empty successful load), a partial
    // register, or a failed load must stay retryable rather than sticky-empty.
    .then(() => {
      if (isLocaleRegistered(i18n, locale)) {
        loadedLocales.add(locale);
      }
    })
    // Always release the in-flight slot, success or failure, so a rejected load
    // never permanently blocks future attempts.
    .finally(() => {
      inFlight.delete(locale);
    });

  inFlight.set(locale, task);
  return task;
}

/**
 * Per-request i18n instance for the SSR server. The module-level `i18n`
 * default export is a singleton; on the server, mutating its language from a
 * request handler would race concurrent requests for different locales and
 * bleed one request's language into another's HTML. `getRouter()` (which the
 * server calls once per request) puts a fresh instance in the router context
 * instead; the `$lang` route's `beforeLoad` loads bundles into it and sets its
 * language, and the root `I18nextProvider` renders from it. The client branch
 * of that context is the singleton, so nothing changes in the browser.
 *
 * No language detector (the URL is the only signal on the server) and no Zod
 * error map (form validation is client-only under `_app`). `initAsync: false`
 * makes init synchronous — the eager default resources are already in memory,
 * so the instance is usable the moment this returns.
 */
export function createRequestI18n(): I18nInstance {
  const instance = i18n.createInstance();
  // i18next's ResourceStore keeps a reference to (and `addResourceBundle`
  // mutates) the object it's given — copy the two outer levels so per-request
  // bundle registration never touches the shared eager `resources`. The leaf
  // bundle objects are never mutated, so they can be shared.
  const resourcesCopy: ResourceTree = Object.fromEntries(
    Object.entries(resources).map(([locale, namespaces]) => [locale, { ...namespaces }]),
  );
  void instance.init({
    resources: resourcesCopy,
    lng: DEFAULT_LOCALE,
    fallbackLng: DEFAULT_LOCALE,
    supportedLngs: SUPPORTED_LOCALES as unknown as string[],
    ns: NAMESPACES as unknown as string[],
    defaultNS: "common",
    interpolation: { escapeValue: false },
    initAsync: false,
    react: {
      useSuspense: false,
      bindI18nStore: "added",
    },
  });
  return instance;
}

export function getInitialLocale(): Locale {
  if (typeof window === "undefined") return DEFAULT_LOCALE;
  // The URL wins. If the visitor lands on `/es-MX/dashboard` we want that to
  // beat whatever localStorage or the navigator says — the URL is the most
  // explicit signal.
  const fromPath = localeFromPathname(window.location.pathname);
  if (fromPath) return fromPath;
  const stored = window.localStorage.getItem("locale");
  if (stored && isSupportedLocale(stored)) return stored;
  const nav = window.navigator?.language;
  if (nav && isSupportedLocale(nav)) return nav;
  return DEFAULT_LOCALE;
}

/**
 * Custom i18next-browser-languagedetector entry that reads `/:lang/...` from
 * `window.location.pathname` first. Ordered ahead of `localStorage` and
 * `navigator` so a `/es-MX/...` URL beats every stored preference. The
 * `$lang` route layout already rewrites unknown locales to `DEFAULT_LOCALE`,
 * so anything we read here is guaranteed to be a supported value.
 */
const URL_PATH_DETECTOR = {
  name: "urlPath" as const,
  lookup(): string | undefined {
    if (typeof window === "undefined") return undefined;
    return localeFromPathname(window.location.pathname);
  },
};

if (!i18n.isInitialized) {
  const detector = new LanguageDetector();
  detector.addDetector(URL_PATH_DETECTOR);

  // Every locale switch funnels through `i18n.changeLanguage` (the language
  // switcher, the user-locale sync hook, the change-language hook), which emits
  // `languageChanged`. Hooking it here covers all of them with one handler:
  // when a non-default locale becomes active and its bundles aren't loaded yet,
  // fetch them. i18next also emits this once on init for the detected initial
  // language, so a deep-linked `/es-MX/...` visit loads es-MX automatically.
  i18n.on("languageChanged", (lng) => {
    if (!isSupportedLocale(lng)) return;
    // Swallow + log here so a failed locale fetch doesn't surface as an
    // unhandled rejection. loadLocale() leaves the locale retryable, and the
    // visitor keeps the fallback strings until the next switch re-attempts it.
    void loadLocale(lng).catch((error) => {
      console.error(`[i18n] failed to load locale "${lng}"`, error);
    });
  });

  const initPromise = i18n
    .use(detector)
    .use(initReactI18next)
    .init({
      resources,
      fallbackLng: DEFAULT_LOCALE,
      supportedLngs: SUPPORTED_LOCALES as unknown as string[],
      ns: NAMESPACES as unknown as string[],
      defaultNS: "common",
      interpolation: { escapeValue: false },
      // The detection chain is split between this synchronous detector list
      // and the async `useUserLocaleSync()` hook. Order of precedence:
      //   1. `urlPath` — the URL is the most explicit signal. The `$lang`
      //      layout has already validated the segment by the time this runs.
      //   2. `localStorage` — an explicit "I picked this on this device"
      //      choice from the language switcher.
      //   3. `user.locale` (server-side, via `useUserLocaleSync`) — a
      //      signed-in user's preference; resolves async after the session
      //      query loads, so it cannot live in this detector array. The hook
      //      navigates to `/${user.locale}/...` only when localStorage is
      //      empty, preserving the order described here.
      //   4. `navigator` — fall back to the device's UI language.
      //   5. `DEFAULT_LOCALE` — final fallback.
      detection: {
        order: ["urlPath", "localStorage", "navigator"],
        lookupLocalStorage: "locale",
        caches: ["localStorage"],
      },
      react: {
        useSuspense: false,
        // Lazy locales arrive AFTER `languageChanged` already fired (see
        // loadLocale), so we must re-render on the store's `added` event too —
        // otherwise a non-default-locale visitor would be stuck on the
        // fallback strings even after their bundle finished loading.
        bindI18nStore: "added",
      },
    });

  // Install the locale-aware Zod error map once init resolves so every form
  // schema's validation messages render in the active language. Resources are
  // eager-globbed above so this resolves synchronously in practice. Phase 6.
  void initPromise.then(() => installZodErrorMap(i18n));
}

export default i18n;
