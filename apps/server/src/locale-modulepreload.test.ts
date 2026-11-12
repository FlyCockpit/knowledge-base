import { afterEach, describe, expect, it } from "vitest";

import {
  buildLocaleModulePreloadMap,
  isSafeModulePreloadHref,
  matchLocaleChunkTag,
  resolveLocaleModulePreload,
  setLocaleModulePreloadMapForTests,
} from "./locale-modulepreload.js";

describe("isSafeModulePreloadHref", () => {
  it("accepts same-origin hashed asset paths", () => {
    expect(isSafeModulePreloadHref("/assets/web-es-MX-AbCd1234.js")).toBe(true);
    expect(isSafeModulePreloadHref("/assets/locales/es-MX-web-xyz.js")).toBe(true);
  });

  it("rejects off-origin, non-js, and traversal values", () => {
    expect(isSafeModulePreloadHref("https://evil.example/assets/x.js")).toBe(false);
    expect(isSafeModulePreloadHref("//evil.example/assets/x.js")).toBe(false);
    expect(isSafeModulePreloadHref("/assets/../secret.js")).toBe(false);
    expect(isSafeModulePreloadHref("/assets/web.css")).toBe(false);
    expect(isSafeModulePreloadHref("assets/web.js")).toBe(false);
    expect(isSafeModulePreloadHref("")).toBe(false);
  });
});

describe("buildLocaleModulePreloadMap", () => {
  // Vite keys a manual chunk by its emitted filename, not by source path —
  // this is the shape a real build produces for the `locale-<tag>` group.
  it("maps the grouped locale chunk to its /assets URL", () => {
    const map = buildLocaleModulePreloadMap({
      "_locale-es-MX-AbCdEf12.js": { file: "assets/locale-es-MX-AbCdEf12.js" },
      "src/client.tsx": { file: "assets/client-XXXX.js", isEntry: true },
      "_locale-tabs-D6TEUYhS.js": { file: "assets/locale-tabs-D6TEUYhS.js" },
    });

    expect(map.get("es-MX")).toBe("/assets/locale-es-MX-AbCdEf12.js");
    // `locale-tabs` is an app component chunk, not a supported locale tag.
    expect(map.size).toBe(1);
  });

  // Regression: rolldown content hashes use a base64url alphabet, so a hash can
  // contain `-` and `_` (`post-form-D_-OG_qP.js` is real output from this app's
  // build). Splitting the tag off at the last hyphen yielded `es-MX-D_` here and
  // silently dropped the preload on roughly one build in eight.
  it("maps a chunk whose content hash contains hyphens and underscores", () => {
    const map = buildLocaleModulePreloadMap({
      "_locale-es-MX-D_-OG_qP.js": { file: "assets/locale-es-MX-D_-OG_qP.js" },
    });
    expect(map.get("es-MX")).toBe("/assets/locale-es-MX-D_-OG_qP.js");
  });

  it("does not match a chunk that merely starts with a locale-like prefix", () => {
    const map = buildLocaleModulePreloadMap({
      // `es-MXtra` is not a supported tag — a prefix match must require the
      // hash separator, not just startsWith(tag).
      "_locale-es-MXtra-AbCd1234.js": { file: "assets/locale-es-MXtra-AbCd1234.js" },
    });
    expect(map.size).toBe(0);
  });

  it("never preloads the default locale", () => {
    const map = buildLocaleModulePreloadMap({
      "_locale-en-US-AbCdEf12.js": { file: "assets/locale-en-US-AbCdEf12.js" },
    });
    expect(map.size).toBe(0);
  });

  it("falls back to source-path keys when the chunk grouping is absent", () => {
    const map = buildLocaleModulePreloadMap({
      "../../packages/locales/src/es-MX/common.json": {
        file: "assets/common-AbCdEf12.js",
        isDynamicEntry: true,
      },
      "../../packages/locales/src/es-MX/dashboard.json": {
        file: "assets/dashboard-Zz991122.js",
        isDynamicEntry: true,
      },
    });
    expect(map.get("es-MX")).toBe("/assets/common-AbCdEf12.js");
    expect(map.size).toBe(1);
  });

  it("ignores JSON outside the locales package", () => {
    const map = buildLocaleModulePreloadMap({
      "src/other/es-MX/common.json": { file: "assets/other-AbCd1234.js" },
    });
    expect(map.size).toBe(0);
  });

  it("skips unsafe file fields", () => {
    const map = buildLocaleModulePreloadMap({
      "_locale-es-MX-AbCdEf12.js": { file: "https://cdn.example/web.js" },
    });
    expect(map.size).toBe(0);
  });

  it("prefers the grouped chunk when both shapes are present for a locale", () => {
    const map = buildLocaleModulePreloadMap({
      "_locale-es-MX-AbCdEf12.js": { file: "assets/locale-es-MX-AbCdEf12.js" },
      "../../packages/locales/src/es-MX/common.json": {
        file: "assets/common-fallback.js",
        isDynamicEntry: true,
      },
    });
    expect(map.get("es-MX")).toBe("/assets/locale-es-MX-AbCdEf12.js");
    expect(map.size).toBe(1);
  });
});

describe("matchLocaleChunkTag", () => {
  // Short tag listed first would win under insertion-order find; longest match
  // must prefer `pt-BR` so the chunk is not stored under the wrong map key.
  it("prefers the longest matching locale when a shorter prefix is also listed", () => {
    const locales = ["en-US", "pt", "pt-BR"] as const;
    expect(matchLocaleChunkTag("pt-BR-AbCdEf12", locales)).toBe("pt-BR");
    expect(matchLocaleChunkTag("pt-AbCdEf12", locales)).toBe("pt");
    expect(matchLocaleChunkTag("pt-BR", locales)).toBe("pt-BR");
  });

  it("still matches when the content hash itself contains hyphens", () => {
    expect(matchLocaleChunkTag("es-MX-D_-OG_qP")).toBe("es-MX");
  });
});

describe("resolveLocaleModulePreload", () => {
  afterEach(() => {
    setLocaleModulePreloadMapForTests(new Map());
  });

  it("returns the mapped asset only for non-default supported locales", () => {
    setLocaleModulePreloadMapForTests(new Map([["es-MX", "/assets/web-AbCdEf12.js"]]));

    expect(resolveLocaleModulePreload("/es-MX/about")).toBe("/assets/web-AbCdEf12.js");
    expect(resolveLocaleModulePreload("/es-MX")).toBe("/assets/web-AbCdEf12.js");
    expect(resolveLocaleModulePreload("/en-US/about")).toBeUndefined();
    expect(resolveLocaleModulePreload("/xx-XX/about")).toBeUndefined();
    expect(resolveLocaleModulePreload("/")).toBeUndefined();
  });
});
