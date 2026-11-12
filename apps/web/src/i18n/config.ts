import { isSupportedLocale, type Locale } from "@knowledge-base/config/locales";

// Locale constants live in `@knowledge-base/config/locales` so the API package can
// import the same source of truth (it's the only thing that prevents
// SUPPORTED_LOCALES drifting between the auth router
// and this file). Re-exported here so existing call sites keep working.
export {
  DEFAULT_LOCALE,
  isSupportedLocale,
  type Locale,
  SUPPORTED_LOCALES,
} from "@knowledge-base/config/locales";

export const NAMESPACES = [
  "common",
  "auth",
  "errors",
  "validation",
  "admin",
  "consent",
  "dashboard",
  "settings",
  "nav",
  "kb",
] as const;

/**
 * Parse the locale prefix out of a `/$lang/...` pathname. The single source
 * of truth for "first path segment → supported locale" — used by the client
 * bootstrap, the i18n `urlPath` detector, the root shell's `<html lang>`, and
 * the language switcher. Returns `undefined` for a missing or unsupported
 * segment.
 */
export function localeFromPathname(pathname: string): Locale | undefined {
  const segment = pathname.split("/")[1];
  return segment && isSupportedLocale(segment) ? segment : undefined;
}
