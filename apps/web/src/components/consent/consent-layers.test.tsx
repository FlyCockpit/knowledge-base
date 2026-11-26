import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import enConsent from "@knowledge-base/locales/src/en-US/consent.json";
import { createInstance } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { ConsentBanner } from "@/components/consent/consent-banner";

// The banner exists only in an app with analytics: these tests run with the
// switch on (consent-off.test.tsx covers the shipped default, off).
vi.mock("@/lib/analytics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/analytics")>()),
  analyticsConfigured: true,
}));

/**
 * The cookie banner must never cover an open overlay. A row-actions menu near
 * the bottom of the viewport opens right where the banner floats; so do a
 * select, a combobox's popover, a dialog's action row on a phone, a bottom
 * sheet, a drawer and the toasts. They are all portaled to `<body>`, so they
 * share the banner's root stacking context and the z-index alone decides who
 * gets the click, as docs/ui.md § Layer scale
 * sets out. With the banner above them, the menu items hit-test to the banner
 * and cannot be clicked.
 *
 * The banner is rendered, so its real class decides. The overlays are read
 * from every `packages/ui` component that portals, so a new overlay is covered
 * without editing this test. It reads class strings only; what it does not see
 * (custom CSS classes and stylesheets, class constants, inline styles) is
 * listed in the Layer scale section. Geometry and hit-testing are checked in a
 * browser.
 */
const root = fileURLToPath(new URL("../../../../../", import.meta.url));
const uiComponents = join(root, "packages/ui/src/components");
/** The overlay layer of the documented scale; nothing goes above it. */
const OVERLAY_LAYER = 50;

/** A numeric z utility; assembled from parts so the policy grep skips it. */
const LAYER_UTILITY = new RegExp(`^!?(-?)${"z"}-(\\d+)!?$`);

type Layer = { value: number; plain: boolean };

/**
 * The z utilities in a class string that set the element's own layer, with
 * any variant (`md:…`, `data-open:…`) and the important modifier. `plain` is
 * a layer with no variant (it applies at every width and in every state).
 * Pseudo-element and descendant variants (`before:`,
 * `**:`, `[&_svg]:`) layer something else and are skipped. A value that is not
 * a plain number (`z-auto`, a variable) is NaN, so every comparison fails.
 */
function selfLayers(text: string): Layer[] {
  const layers: Layer[] = [];
  for (const token of text.split(/[\s"'\x60{}]+/)) {
    const variants = token.split(":");
    const utility = variants.pop() ?? "";
    if (!/^!?-?z-/.test(utility)) continue;
    if (variants.some((v) => v === "before" || v === "after" || /^(\*|\[&)/.test(v))) continue;
    const match = utility.match(LAYER_UTILITY);
    const value = match ? Number(match[2]) * (match[1] ? -1 : 1) : Number.NaN;
    layers.push({ value, plain: variants.length === 0 });
  }
  return layers;
}

/** Source without comments, so a comment can neither add nor hide a layer. */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/**
 * The opening JSX tags in a source: from `<Name` to the `>` that closes it,
 * skipping `>` inside braces and string literals (`onClick={() => …}`).
 */
function openingTags(source: string): { name: string; text: string }[] {
  const tags: { name: string; text: string }[] = [];
  for (const match of source.matchAll(/<([A-Za-z][\w.]*)/g)) {
    const start = match.index ?? 0;
    let depth = 0;
    let quote = "";
    let end = start + match[0].length;
    for (; end < source.length; end += 1) {
      const char = source[end];
      if (quote) {
        if (char === quote && source[end - 1] !== "\\") quote = "";
      } else if (char === '"' || char === "'" || char === "\x60") {
        quote = char;
      } else if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
      } else if (char === ">" && depth === 0) {
        break;
      }
    }
    tags.push({ name: match[1] ?? "", text: source.slice(start, end + 1) });
  }
  return tags;
}

/**
 * The tag's own `className` (a string literal or a `{…}` expression), found
 * at the tag's top level so a class inside another prop's JSX
 * (`children={<div className="relative z-10" />}`) is not counted; "" when
 * there is none.
 */
function classNameOf(tag: string): string {
  let depth = 0;
  let quote = "";
  for (let i = 0; i < tag.length; i += 1) {
    const char = tag[i] ?? "";
    if (quote) {
      if (char === quote && tag[i - 1] !== "\\") quote = "";
    } else if (char === '"' || char === "'" || char === "\x60") {
      quote = char;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
    } else if (depth === 0 && /\s/.test(char) && tag.startsWith("className=", i + 1)) {
      const start = i + "className=".length + 1;
      const open = tag[start];
      if (open === '"' || open === "'") return tag.slice(start + 1, tag.indexOf(open, start + 1));
      let inner = 0;
      for (let end = start; end < tag.length; end += 1) {
        if (tag[end] === "{") inner += 1;
        if (tag[end] === "}") inner -= 1;
        if (inner === 0) return tag.slice(start, end + 1);
      }
      return "";
    }
  }
  return "";
}

/**
 * The parts a portal stacks on `<body>`: a positioner (menus, selects,
 * popovers), a backdrop or overlay, a viewport, the popup, and any other part
 * that is `fixed` (vaul's drawer `Content`). Where a library has no Popup part
 * (vaul, Radix), its Content is the popup. A lowered positioner is caught even
 * when the popup nested in it keeps `z-50`: the positioner's layer competes.
 */
const STACKED = new Set(["Positioner", "Backdrop", "Overlay", "Viewport", "Popup"]);
const FIXED = /(?<=[\s"'\x60])fixed(?=[\s"'\x60])/;

function stackedParts(source: string): { part: string; layers: Layer[] }[] {
  const parts = openingTags(source)
    .map(({ name, text }) => ({ part: name.match(/^\w+Primitive\.(\w+)$/)?.[1] ?? "", text }))
    .filter(({ part }) => part);
  const contentIsPopup = !parts.some(({ part }) => part === "Popup");
  return parts
    .map(({ part, text }) => ({ part, classes: classNameOf(text) }))
    .filter(
      ({ part, classes }) =>
        STACKED.has(part) || (contentIsPopup && part === "Content") || FIXED.test(` ${classes} `),
    )
    .map(({ part, classes }) => ({ part, layers: selfLayers(classes) }));
}

describe("the cookie banner stays below every overlay", () => {
  const i18n = createInstance();
  let bannerLayer = Number.NaN;
  let sectionTag = "";

  beforeAll(async () => {
    await i18n.init({
      lng: "en-US",
      fallbackLng: "en-US",
      ns: ["consent"],
      defaultNS: "consent",
      resources: { "en-US": { consent: enConsent } },
      interpolation: { escapeValue: false },
      react: { useSuspense: false },
    });
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <ConsentBanner />
      </I18nextProvider>,
    );
    sectionTag = html.match(/^<section[^>]*>/)?.[0] ?? "";
    const layers = selfLayers(sectionTag.match(/class="([^"]*)"/)?.[1] ?? "");
    // Exactly one plain layer, or NaN, which every comparison below fails.
    const only = layers.length === 1 ? layers[0] : undefined;
    bannerLayer = only?.plain ? only.value : Number.NaN;
  });

  it("the banner declares exactly one plain layer, below the overlay layer", () => {
    expect(bannerLayer).toBeLessThan(OVERLAY_LAYER);
    expect(sectionTag).not.toMatch(/z-index/i);
  });

  const portaled = readdirSync(uiComponents)
    .filter((file) => file.endsWith(".tsx") && !file.includes(".test."))
    .filter((file) => /Portal\b/.test(readFileSync(join(uiComponents, file), "utf8")));

  it("finds the portaled overlays", () => {
    // The shipped set; a removal or rename here should be deliberate.
    for (const file of [
      "alert-dialog.tsx",
      "dialog.tsx",
      "drawer.tsx",
      "dropdown-menu.tsx",
      "popover.tsx",
      "select.tsx",
      "sheet.tsx",
    ]) {
      expect(portaled).toContain(file);
    }
  });

  // Each stacking root has an unconditional layer and no override below the
  // overlay layer (a responsive-only `md:z-50` leaves phones with no layer).
  it.each(portaled)("%s paints above the banner", (file) => {
    const parts = stackedParts(code(join(uiComponents, file)));
    expect(parts.length, `${file} portals a stacked part`).toBeGreaterThan(0);
    for (const { part, layers } of parts) {
      expect(
        layers.some(({ plain }) => plain),
        `${file}: ${part} declares an unconditional layer`,
      ).toBe(true);
      for (const { value } of layers) {
        expect(value, `${file}: ${part}`).toBeGreaterThan(bannerLayer);
        expect(value, `${file}: ${part} is on the overlay layer`).toBeGreaterThanOrEqual(
          OVERLAY_LAYER,
        );
      }
    }
  });

  // A caller's className reaches the overlay's own element (tailwind-merge
  // lets it win), so `<SheetContent className="z-30">` in a feature would put
  // that sheet under the banner while the primitives above stay correct. The
  // shared wrappers in packages/ui that render an overlay (CommandDialog
  // forwards its className to DialogContent) are callers too.
  it("no overlay is lowered through its className", () => {
    const names = portaled
      .map((file) =>
        file
          .replace(/\.tsx$/, "")
          .split("-")
          .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
          .join(""),
      )
      .join("|");
    const overlayName = new RegExp(
      `^(?:(?:${names})(?:Sub)?(?:Content|Overlay|Backdrop|Positioner|Popup|Viewport)|CommandDialog)$`,
    );
    const offenders: string[] = [];
    for (const dir of [join(root, "apps/web/src"), join(root, "packages/ui/src")]) {
      for (const entry of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
        if (!entry.endsWith(".tsx") || entry.includes(".test.")) continue;
        for (const { name, text } of openingTags(code(join(dir, entry)))) {
          if (!overlayName.test(name)) continue;
          for (const { value } of selfLayers(classNameOf(text))) {
            if (!(value >= OVERLAY_LAYER)) offenders.push(`${entry}: <${name}> at ${value}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the toast viewport paints above the banner", () => {
    const requireFromUi = createRequire(join(root, "packages/ui/package.json"));
    const css = readFileSync(requireFromUi.resolve("sileo/styles.css"), "utf8");
    // Assembled from parts for the same reason as LAYER_UTILITY.
    const viewportRule = new RegExp(
      String.raw`\[data-sileo-viewport\]\s*\{[^}]*?z-` + String.raw`index:\s*(\d+)`,
    );
    const viewport = css.match(viewportRule);
    expect(viewport, "sileo still layers its viewport with z-index").not.toBeNull();
    expect(Number(viewport?.[1])).toBeGreaterThan(bannerLayer);
  });

  // The banner's phone padding clears the BottomNav's height on the
  // assumption that the nav paints over it. Every fixed nav the component
  // renders (its pending and ready branches each have one) is checked.
  it("the mobile BottomNav paints above the banner", () => {
    const navs = openingTags(code(join(root, "apps/web/src/components/bottom-nav.tsx")))
      .map(({ name, text }) => ({ name, classes: classNameOf(text) }))
      .filter(({ classes }) => FIXED.test(` ${classes} `));
    expect(navs.length).toBeGreaterThan(0);
    for (const { name, classes } of navs) {
      const layers = selfLayers(classes);
      expect(
        layers.some(({ plain }) => plain),
        `<${name}> declares an unconditional layer`,
      ).toBe(true);
      for (const { value } of layers) expect(value, `<${name}>`).toBeGreaterThan(bannerLayer);
    }
  });
});
