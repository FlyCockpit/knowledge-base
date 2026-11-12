import { describe, expect, it } from "vitest";

import {
  canonicalOriginFromDocument,
  parseCanonicalOrigin,
  publicHomeHead,
} from "./public-home-head";

const base = { origin: "https://kb.example", appName: "KnowledgeBase" };

describe("publicHomeHead (F17)", () => {
  it("emits translated og metadata, canonical and hreflang alternates for en-US", () => {
    const head = publicHomeHead({ ...base, lang: "en-US", description: "Self-hosted." });
    expect(head.meta).toEqual([
      { name: "description", content: "Self-hosted." },
      { property: "og:type", content: "website" },
      { property: "og:site_name", content: "KnowledgeBase" },
      { property: "og:title", content: "KnowledgeBase" },
      { property: "og:description", content: "Self-hosted." },
      { property: "og:url", content: "https://kb.example/en-US" },
      { property: "og:locale", content: "en_US" },
      { property: "og:locale:alternate", content: "es_MX" },
    ]);
    expect(head.links).toEqual([
      { rel: "canonical", href: "https://kb.example/en-US" },
      { rel: "alternate", hrefLang: "en-US", href: "https://kb.example/en-US" },
      { rel: "alternate", hrefLang: "es-MX", href: "https://kb.example/es-MX" },
      { rel: "alternate", hrefLang: "x-default", href: "https://kb.example/en-US" },
    ]);
  });

  it("localizes the URL, locale and description for es-MX", () => {
    const head = publicHomeHead({ ...base, lang: "es-MX", description: "Autoalojadas." });
    expect(head.meta).toContainEqual({ property: "og:url", content: "https://kb.example/es-MX" });
    expect(head.meta).toContainEqual({ property: "og:locale", content: "es_MX" });
    expect(head.meta).toContainEqual({ property: "og:locale:alternate", content: "en_US" });
    expect(head.meta).toContainEqual({ property: "og:description", content: "Autoalojadas." });
    expect(head.links[0]).toEqual({ rel: "canonical", href: "https://kb.example/es-MX" });
    // x-default always points at the default locale.
    expect(head.links.at(-1)).toEqual({
      rel: "alternate",
      hrefLang: "x-default",
      href: "https://kb.example/en-US",
    });
  });

  it("emits nothing without a trusted origin or for an unsupported locale", () => {
    expect(publicHomeHead({ ...base, origin: undefined, lang: "en-US", description: "x" })).toEqual(
      { meta: [], links: [] },
    );
    expect(publicHomeHead({ ...base, lang: "xx-XX", description: "x" })).toEqual({
      meta: [],
      links: [],
    });
  });
});

describe("parseCanonicalOrigin", () => {
  it("accepts only a bare http(s) origin", () => {
    expect(parseCanonicalOrigin("https://kb.example")).toBe("https://kb.example");
    expect(parseCanonicalOrigin("http://localhost:3000")).toBe("http://localhost:3000");
    for (const value of [
      undefined,
      null,
      "",
      "kb.example",
      "https://kb.example/",
      "https://kb.example/en-US",
      "https://kb.example?x=1",
      "javascript:alert(1)",
      "https://user@kb.example",
      'https://kb.example"><script>',
    ]) {
      expect(parseCanonicalOrigin(value), String(value)).toBeUndefined();
    }
  });
});

describe("canonicalOriginFromDocument", () => {
  const doc = (href: string | null) => ({
    querySelector: (selector: string) =>
      selector === 'link[rel="canonical"]' && href !== null
        ? ({ getAttribute: (name: string) => (name === "href" ? href : null) } as Element)
        : null,
  });

  it("reuses the origin the server rendered, never the visited host", () => {
    expect(canonicalOriginFromDocument(doc("https://kb.example/es-MX"))).toBe("https://kb.example");
  });

  it("returns undefined without a usable canonical link", () => {
    expect(canonicalOriginFromDocument(doc(null))).toBeUndefined();
    expect(canonicalOriginFromDocument(doc("not a url"))).toBeUndefined();
    expect(canonicalOriginFromDocument(doc("javascript:alert(1)"))).toBeUndefined();
  });
});
