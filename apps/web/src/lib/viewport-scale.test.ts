import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postcss from "postcss";
import { describe, expect, it } from "vitest";

// One root font-size rule grows every rem size above a 1920 CSS px long side,
// up to 150 % at 3840. See docs/ui.md § Viewport scale
const ui = resolve(import.meta.dirname, "../../../../packages/ui/src");
const web = resolve(import.meta.dirname, "..");
const globals = readFileSync(resolve(ui, "styles/globals.css"), "utf8");
const RULE = "clamp(100%, calc(100% + (max(100vw, 100vh) - 1920px) / 240), 150%)";

function rootFontSizes(css: string) {
  const found: { selector: string; value: string }[] = [];
  postcss.parse(css).walkDecls("font-size", (decl) => {
    const rule = decl.parent;
    if (rule?.type !== "rule") return;
    const selectors = rule.selector.split(",").map((s) => s.trim());
    if (selectors.some((s) => s === "html" || s === ":root")) {
      found.push({ selector: rule.selector, value: decl.value.replace(/\s+/g, " ") });
    }
  });
  return found.map((f) => ({ ...f, value: f.value.replace(/\( /g, "(").replace(/ \)/g, ")") }));
}

/** The rule evaluated the way the browser does, for a 16px browser default. */
function rootPx(value: string, width: number, height: number, browserDefault = 16) {
  const match =
    /^clamp\((\d+)%, calc\((\d+)% \+ \(max\(100vw, 100vh\) - (\d+)px\) \/ (\d+)\), (\d+)%\)$/.exec(
      value,
    );
  const [min, base, start, per, max] = (match?.slice(1) ?? []).map(Number);
  if (
    min === undefined ||
    base === undefined ||
    start === undefined ||
    per === undefined ||
    max === undefined
  )
    throw new Error(`Unexpected root font-size: ${value}`);
  const ramp = (browserDefault * base) / 100 + (Math.max(width, height) - start) / per;
  return Math.min(Math.max(ramp, (browserDefault * min) / 100), (browserDefault * max) / 100);
}

describe("viewport scale (root font size)", () => {
  const sizes = rootFontSizes(globals);

  it("is set once, on html, as the documented ramp", () => {
    expect(sizes).toEqual([{ selector: "html", value: RULE }]);
  });

  it.each([
    [320, 568, 16],
    [390, 844, 16],
    [1280, 720, 16],
    [1920, 1080, 16],
    [1080, 1920, 16],
    [2560, 1440, 16 + 640 / 240],
    [3840, 2160, 24],
    [2160, 3840, 24],
    [5120, 2880, 24],
  ])("at %ix%i the root is %fpx", (width, height, px) => {
    expect(rootPx(sizes[0]?.value ?? "", width, height)).toBeCloseTo(px, 5);
  });

  it("keeps the user's own default font size below 1920", () => {
    expect(rootPx(sizes[0]?.value ?? "", 1440, 900, 20)).toBe(20);
  });

  it("is not overridden by the app stylesheet", () => {
    expect(rootFontSizes(readFileSync(resolve(web, "index.css"), "utf8"))).toEqual([]);
  });
});
