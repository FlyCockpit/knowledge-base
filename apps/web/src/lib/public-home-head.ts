import {
  DEFAULT_LOCALE,
  isSupportedLocale,
  SUPPORTED_LOCALES,
} from "@knowledge-base/config/locales";

/** The value when it is a bare http(s) origin, otherwise undefined. */
export function parseCanonicalOrigin(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    return url.origin === value ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The origin of the server-rendered `<link rel="canonical">`, if any. That
 * link is written only from the configured origin (`x-canonical-origin`), so
 * the client reuses it rather than trusting `window.location`.
 */
export function canonicalOriginFromDocument(
  doc: Pick<Document, "querySelector">,
): string | undefined {
  const href = doc.querySelector('link[rel="canonical"]')?.getAttribute("href");
  if (!href) return undefined;
  try {
    return parseCanonicalOrigin(new URL(href).origin);
  } catch {
    return undefined;
  }
}

/** Open Graph spells locales with an underscore (`en_US`). */
function ogLocale(tag: string): string {
  return tag.replace("-", "_");
}

/**
 * Translated social/canonical metadata for the PUBLIC home page only: the app
 * name, the translated public tagline and the localized home URLs. Nothing
 * here may come from session or KB data. Without a trusted origin (or for an
 * unsupported locale) it emits nothing rather than a relative or guessed URL.
 * URLs match `/sitemap.xml` (apps/server/src/seo.ts): `${origin}/${locale}`.
 */
export function publicHomeHead(input: {
  origin: string | undefined;
  lang: string;
  appName: string;
  description: string;
}) {
  const { origin, lang, appName, description } = input;
  if (!origin || !isSupportedLocale(lang)) return { meta: [], links: [] };
  const url = (locale: string) => `${origin}/${locale}`;
  return {
    meta: [
      { name: "description", content: description },
      { property: "og:type", content: "website" },
      { property: "og:site_name", content: appName },
      { property: "og:title", content: appName },
      { property: "og:description", content: description },
      { property: "og:url", content: url(lang) },
      { property: "og:locale", content: ogLocale(lang) },
      ...SUPPORTED_LOCALES.filter((locale) => locale !== lang).map((locale) => ({
        property: "og:locale:alternate",
        content: ogLocale(locale),
      })),
    ],
    links: [
      { rel: "canonical", href: url(lang) },
      ...SUPPORTED_LOCALES.map((locale) => ({
        rel: "alternate",
        hrefLang: locale,
        href: url(locale),
      })),
      { rel: "alternate", hrefLang: "x-default", href: url(DEFAULT_LOCALE) },
    ],
  };
}
