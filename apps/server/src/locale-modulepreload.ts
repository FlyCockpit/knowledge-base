import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_LOCALE,
  isSafeAssetScriptPath,
  isSupportedLocale,
  LOCALE_CHUNK_PREFIX,
  SUPPORTED_LOCALES,
} from "@knowledge-base/config/locales";
import { logEvent, logInternalError } from "@knowledge-base/env/log";

/**
 * Internal request header: same-origin asset URL of the active non-default
 * locale's bundle chunk. Set only by this process when forwarding
 * a request to the TanStack Start SSR renderer — never trusted from clients.
 * The SSR root route emits `<link rel="modulepreload">` from it.
 */
export const LOCALE_MODULEPRELOAD_HEADER = "x-locale-modulepreload";

/**
 * Namespace JSON under a locale directory, e.g.
 * `../../packages/locales/src/es-MX/common.json`. Only present when the
 * `manualChunks` grouping is NOT in effect (each namespace becomes its own
 * chunk with its own source-path key). Supported as a fallback so dropping the
 * grouping degrades to "preload one namespace's chunk" rather than to nothing.
 */
const LOCALE_BUNDLE_KEY = /(?:^|\/)packages\/locales\/src\/([^/]+)\/[^/]+\.json$/;

/**
 * Pick the supported locale tag that matches a chunk-name suffix after
 * `LOCALE_CHUNK_PREFIX` (and before `.js`), e.g. `es-MX-AbCd1234` → `es-MX`.
 *
 * Prefer the **longest** matching tag so a future list containing both a short
 * prefix and a longer sibling (`pt` and `pt-BR`, `zh` and `zh-CN`) does not
 * map `locale-pt-BR-<hash>.js` to `pt` under insertion-order `find`. Exact
 * match and `startsWith(`${locale}-`)` both count; among matches, length wins.
 *
 * Exported for unit tests (including with synthetic locale lists).
 */
export function matchLocaleChunkTag(
  rest: string,
  locales: readonly string[] = SUPPORTED_LOCALES,
): string | undefined {
  let best: string | undefined;
  for (const locale of locales) {
    if (rest === locale || rest.startsWith(`${locale}-`)) {
      if (!best || locale.length > best.length) best = locale;
    }
  }
  return best;
}

/**
 * `_locale-es-MX-AbCd1234.js` → `es-MX` (leading `_` is Vite's own prefix).
 *
 * Vite keys manual chunks by emitted filename rather than source path — a
 * manual chunk has no single source module — so the shared
 * `LOCALE_CHUNK_PREFIX` name is all there is to match on.
 *
 * Matched FORWARD against the known locale tags, never by splitting the hash
 * off the end: rolldown content hashes use a base64url alphabet, so a hash may
 * itself contain `-` (`post-form-D_-OG_qP.js` is a real chunk from this app's
 * build). Cutting at the last hyphen would then yield `es-MX-D_` and silently
 * drop the preload on ~1 build in 8.
 */
function localeFromChunkKey(key: string): string | undefined {
  const name = key.replace(/^_/, "");
  if (!name.startsWith(LOCALE_CHUNK_PREFIX) || !name.endsWith(".js")) return undefined;
  const rest = name.slice(LOCALE_CHUNK_PREFIX.length, -".js".length);
  return matchLocaleChunkTag(rest);
}

type ViteManifestChunk = {
  file: string;
  src?: string;
  isEntry?: boolean;
  isDynamicEntry?: boolean;
  imports?: string[];
  dynamicImports?: string[];
  css?: string[];
  assets?: string[];
};

type ViteManifest = Record<string, ViteManifestChunk>;

/** locale → absolute-path asset URL (`/assets/….js`). */
let preloadByLocale: Map<string, string> = new Map();

/**
 * Same-origin `/assets/...` URL only, so a corrupted manifest cannot emit an
 * off-origin modulepreload (or worse) into SSR HTML. The predicate itself is
 * shared with the SSR-side check in `apps/web/src/router.tsx` — see
 * `isSafeAssetScriptPath` in `@knowledge-base/config/locales`.
 */
export const isSafeModulePreloadHref = isSafeAssetScriptPath;

/**
 * Build the locale → hashed asset map from a Vite client manifest object.
 * Exported for unit tests.
 */
export function buildLocaleModulePreloadMap(manifest: ViteManifest): Map<string, string> {
  const map = new Map<string, string>();

  const add = (locale: string | undefined, chunk: ViteManifestChunk) => {
    if (!locale || !isSupportedLocale(locale) || locale === DEFAULT_LOCALE) return;
    if (typeof chunk.file !== "string" || chunk.file.length === 0) return;
    const href = chunk.file.startsWith("/") ? chunk.file : `/${chunk.file}`;
    if (!isSafeModulePreloadHref(href)) return;
    // With the grouping in place a locale has exactly one chunk. Without it,
    // several source-path keys map to different per-namespace chunks; preload
    // the first (correct, just incomplete) and stay stable across key ordering.
    if (!map.has(locale)) map.set(locale, href);
  };

  // Preferred shape: the grouped `locale-<tag>` chunk.
  for (const [key, chunk] of Object.entries(manifest)) {
    add(localeFromChunkKey(key), chunk);
  }

  // Fallback: ungrouped per-namespace JSON keys. Always run so a partial
  // preferred pass (one locale grouped, another only as source-path keys) still
  // fills missing locales. `add` already no-ops when the locale is present, so
  // preferred wins per locale when both shapes appear for the same tag.
  for (const [key, chunk] of Object.entries(manifest)) {
    add(LOCALE_BUNDLE_KEY.exec(key)?.[1], chunk);
  }
  return map;
}

/**
 * Load the client Vite manifest from `clientDistDir/.vite/manifest.json` and
 * cache locale → asset URL lookups. Safe to call with a missing file (dev /
 * incomplete build): the map stays empty and no modulepreloads are emitted.
 */
export function loadLocaleModulePreloads(clientDistDir: string): void {
  const manifestPath = join(clientDistDir, ".vite", "manifest.json");
  if (!existsSync(manifestPath)) {
    preloadByLocale = new Map();
    // Non-default locales get no SSR modulepreload hints.
    logEvent("locale-preload", { reason: "MANIFEST_NOT_FOUND" });
    return;
  }

  try {
    const raw: unknown = JSON.parse(readFileSync(manifestPath, "utf-8"));
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error("manifest root is not an object");
    }
    preloadByLocale = buildLocaleModulePreloadMap(raw as ViteManifest);
    if (preloadByLocale.size === 0) {
      logEvent("locale-preload", { reason: "NO_LOCALE_ENTRIES" });
    } else {
      logEvent("locale-preload.ready", { count: preloadByLocale.size });
    }
  } catch (error) {
    preloadByLocale = new Map();
    logInternalError("locale-preload", error);
  }
}

/** Test/reset helper — replaces the in-memory map. */
export function setLocaleModulePreloadMapForTests(map: Map<string, string>): void {
  preloadByLocale = map;
}

/**
 * Resolve the modulepreload href for the locale in `pathname` (`/$lang/...`).
 * Returns undefined for the default locale, unsupported segments, or when the
 * manifest has no matching locale entry.
 */
export function resolveLocaleModulePreload(pathname: string): string | undefined {
  const segment = pathname.split("/").filter(Boolean)[0];
  if (!segment || !isSupportedLocale(segment) || segment === DEFAULT_LOCALE) {
    return undefined;
  }
  return preloadByLocale.get(segment);
}
