import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { compile } from "tailwindcss";
import { describe, expect, it } from "vitest";

/**
 * WCAG 2.x contrast of the theme tokens in packages/ui globals.css. Text
 * colors must reach AA (4.5:1) on the surfaces they are used on, including
 * the translucent tints components put behind them (composited in sRGB, as
 * browsers do).
 */
const css = readFileSync(
  resolve(import.meta.dirname, "../../../../packages/ui/src/styles/globals.css"),
  "utf8",
);

type Rgb = [number, number, number];

function block(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`missing ${selector}`);
  return css.slice(start, css.indexOf("\n}", start));
}

function token(scope: string, name: string): Rgb {
  const match = new RegExp(`--${name}:\\s*oklch\\(([\\d.]+) ([\\d.]+) ([\\d.]+)\\)`).exec(
    block(scope),
  );
  if (!match) throw new Error(`--${name} is not an oklch() literal in ${scope}`);
  return oklchToSrgb(Number(match[1]), Number(match[2]), Number(match[3]));
}

function oklchToSrgb(l: number, c: number, hue: number): Rgb {
  const a = c * Math.cos((hue * Math.PI) / 180);
  const b = c * Math.sin((hue * Math.PI) / 180);
  const lms = [
    (l + 0.3963377774 * a + 0.2158037573 * b) ** 3,
    (l - 0.1055613458 * a - 0.0638541728 * b) ** 3,
    (l - 0.0894841775 * a - 1.291485548 * b) ** 3,
  ] as const;
  const linear = [
    4.0767416621 * lms[0] - 3.3077115913 * lms[1] + 0.2309699292 * lms[2],
    -1.2684380046 * lms[0] + 2.6097574011 * lms[1] - 0.3413193965 * lms[2],
    -0.0041960863 * lms[0] - 0.7034186147 * lms[1] + 1.707614701 * lms[2],
  ];
  const encode = (x: number) => {
    const v = Math.min(1, Math.max(0, x));
    return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  };
  return [encode(linear[0] ?? 0), encode(linear[1] ?? 0), encode(linear[2] ?? 0)];
}

/** `fg` at `alpha` over `bg`, as `bg-x/NN` composites. */
function over(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  return [0, 1, 2].map((i) => (fg[i] ?? 0) * alpha + (bg[i] ?? 0) * (1 - alpha)) as Rgb;
}

function luminance([r, g, b]: Rgb): number {
  const decode = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * decode(r) + 0.7152 * decode(g) + 0.0722 * decode(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const AA = 4.5;

const buttonSource = readFileSync(
  resolve(import.meta.dirname, "../../../../packages/ui/src/components/button.tsx"),
  "utf8",
);

/**
 * Alpha of the default button's link hover fill (`[a]:hover:bg-primary/NN`, optionally `dark:`-prefixed). Dark mode
 * uses the unprefixed fill unless a `dark:` one overrides it.
 */
function linkHoverAlpha(prefix: "" | "dark:"): number {
  const find = (p: string) =>
    new RegExp(`(?:^|[\\s"])${p}\\[a\\]:hover:bg-primary/(\\d+)`).exec(buttonSource);
  const match = find(prefix) ?? (prefix ? find("") : null);
  if (!match) throw new Error(`no ${prefix}[a]:hover:bg-primary/NN in button.tsx`);
  return Number(match[1]) / 100;
}

const pillSource = readFileSync(
  resolve(import.meta.dirname, "../components/status-pill.tsx"),
  "utf8",
);
const tailwindTheme = readFileSync(
  resolve(import.meta.dirname, "../../node_modules/tailwindcss/theme.css"),
  "utf8",
);

/** A Tailwind palette color (`--color-<name>: oklch(L% C H)`). */
function palette(name: string): Rgb {
  const match = new RegExp(`--color-${name}:\\s*oklch\\(([\\d.]+)% ([\\d.]+) ([\\d.]+)\\)`).exec(
    tailwindTheme,
  );
  if (!match) throw new Error(`no --color-${name} in tailwindcss/theme.css`);
  return oklchToSrgb(Number(match[1]) / 100, Number(match[2]), Number(match[3]));
}

describe("theme token contrast (WCAG AA)", () => {
  it("keeps every StatusPill tone readable on its tint over the page and card", () => {
    for (const hue of ["emerald", "amber", "sky"]) {
      const shades = new RegExp(`bg-${hue}-500/15 text-${hue}-(\\d+) dark:text-${hue}-(\\d+)`).exec(
        pillSource,
      );
      if (!shades) throw new Error(`no ${hue} tone in status-pill.tsx`);
      for (const [scope, text] of [
        [":root", `${hue}-${shades[1]}`],
        [".dark", `${hue}-${shades[2]}`],
      ] as const) {
        for (const surface of ["background", "card"]) {
          const fill = over(palette(`${hue}-500`), 0.15, token(scope, surface));
          expect(
            contrast(palette(text), fill),
            `${hue} ${scope} ${surface}`,
          ).toBeGreaterThanOrEqual(AA);
        }
      }
    }
    for (const scope of [":root", ".dark"]) {
      const destructive = token(scope, "destructive");
      for (const surface of ["background", "card"]) {
        const fill = over(destructive, 0.15, token(scope, surface));
        expect(contrast(destructive, fill), `bad ${scope} ${surface}`).toBeGreaterThanOrEqual(AA);
      }
    }
  });

  it("keeps light-mode destructive text readable on every surface it sits on", () => {
    const destructive = token(":root", "destructive");
    const background = token(":root", "background");
    for (const surface of ["background", "card", "popover", "muted"]) {
      expect(contrast(destructive, token(":root", surface)), surface).toBeGreaterThanOrEqual(AA);
    }
    // The destructive button: `bg-destructive/10 text-destructive`.
    expect(contrast(destructive, over(destructive, 0.1, background))).toBeGreaterThanOrEqual(AA);
  });

  it("keeps dark-mode primary readable as text and under its own foreground", () => {
    const primary = token(".dark", "primary");
    for (const surface of ["background", "card", "popover", "muted"]) {
      expect(contrast(primary, token(".dark", surface)), surface).toBeGreaterThanOrEqual(AA);
    }
    expect(contrast(token(".dark", "primary-foreground"), primary)).toBeGreaterThanOrEqual(AA);
    // Selected options: `bg-primary/10` behind primary text.
    const background = token(".dark", "background");
    expect(contrast(primary, over(primary, 0.1, background))).toBeGreaterThanOrEqual(AA);
  });

  it("keeps the other primary and destructive pairs at AA", () => {
    expect(
      contrast(token(":root", "primary-foreground"), token(":root", "primary")),
    ).toBeGreaterThanOrEqual(AA);
    expect(
      contrast(token(":root", "primary"), token(":root", "background")),
    ).toBeGreaterThanOrEqual(AA);
    const darkDestructive = token(".dark", "destructive");
    const darkBackground = token(".dark", "background");
    expect(contrast(darkDestructive, darkBackground)).toBeGreaterThanOrEqual(AA);
    expect(contrast(darkDestructive, token(".dark", "card"))).toBeGreaterThanOrEqual(AA);
    // Dark destructive button: `dark:bg-destructive/20`.
    expect(
      contrast(darkDestructive, over(darkDestructive, 0.2, darkBackground)),
    ).toBeGreaterThanOrEqual(AA);
  });

  it("keeps the default link-button label readable on its hover fill", () => {
    // `[a]:hover:bg-primary/NN` lets the surface behind the button show through.
    for (const [scope, prefix] of [
      [":root", ""],
      [".dark", "dark:"],
    ] as const) {
      const alpha = linkHoverAlpha(prefix);
      const primary = token(scope, "primary");
      const foreground = token(scope, "primary-foreground");
      for (const surface of ["background", "card", "popover", "muted"]) {
        const fill = over(primary, alpha, token(scope, surface));
        expect(contrast(foreground, fill), `${scope} ${surface}`).toBeGreaterThanOrEqual(AA);
      }
    }
  });

  it("keeps muted text readable on the background, card and muted surfaces in both themes", () => {
    for (const scope of [":root", ".dark"]) {
      const muted = token(scope, "muted-foreground");
      for (const surface of ["background", "card", "popover", "muted"]) {
        expect(
          contrast(muted, token(scope, surface)),
          `${scope} ${surface}`,
        ).toBeGreaterThanOrEqual(AA);
      }
    }
  });

  it("keeps the focus ring at 3:1 (WCAG 1.4.11) on every surface in both themes", () => {
    for (const scope of [":root", ".dark"]) {
      for (const ring of ["ring", "sidebar-ring"]) {
        for (const surface of ["background", "card", "popover", "muted", "sidebar"]) {
          expect(
            contrast(token(scope, ring), token(scope, surface)),
            `${scope} ${ring} on ${surface}`,
          ).toBeGreaterThanOrEqual(3);
        }
      }
      // Destructive buttons ring in their own color.
      expect(
        contrast(token(scope, "destructive"), token(scope, "background")),
      ).toBeGreaterThanOrEqual(3);
    }
    // Rings are drawn at full opacity: a translucent ring re-introduces the
    // R2-5 failure (the old 50% ring measured about 1.4:1).
    for (const file of [
      "button",
      "input",
      "textarea",
      "select",
      "checkbox",
      "toggle",
      "input-group",
    ]) {
      const source = readFileSync(
        resolve(import.meta.dirname, `../../../../packages/ui/src/components/${file}.tsx`),
        "utf8",
      );
      expect(source, file).not.toMatch(/focus-visible\]?:ring-(ring|destructive)\//);
    }
    expect(css).not.toMatch(/outline-ring\//);
    expect(contrast(oklchToSrgb(0.723, 0.014, 214.4), token(":root", "background"))).toBeLessThan(
      3,
    );
  });

  it("measures the old tokens as failing, so the check discriminates", () => {
    const oldLight = oklchToSrgb(0.577, 0.245, 27.325);
    expect(contrast(oldLight, token(":root", "muted"))).toBeLessThan(AA);
    const oldDark = oklchToSrgb(0.443, 0.11, 240.79);
    const oldMuted = oklchToSrgb(0.56, 0.021, 213.5);
    expect(contrast(oldMuted, token(":root", "muted"))).toBeLessThan(AA);
    expect(contrast(oldDark, token(".dark", "background"))).toBeLessThan(AA);
    // The old 80% link hover fill under the new dark primary.
    const darkPrimary = token(".dark", "primary");
    const darkHover = over(darkPrimary, 0.8, token(".dark", "background"));
    expect(contrast(token(".dark", "primary-foreground"), darkHover)).toBeLessThan(AA);
  });
});

describe("toast titles", () => {
  it("override sileo's capitalize so titles keep their locale's sentence case (R2-10)", () => {
    expect(css).toMatch(/:root \[data-sileo-title\] \{\s*text-transform: none;/);
  });
});

/**
 * The focus ring of an invalid field (R2-5, review): `aria-invalid:ring-*`
 * utilities come after the focus rules in the generated CSS, so an invalid
 * focused control would show the faint 20%/40% error ring. Compile each
 * control's real classes with Tailwind and resolve the cascade (specificity,
 * then source order) for the focused + invalid state in both themes.
 */
describe("invalid + focused controls keep an opaque 2px ring", () => {
  type Rule = { selector: string; body: string; index: number };
  const stripEscapes = (selector: string) => selector.replace(/\\./g, "_");
  const specificity = (selector: string) => {
    const plain = stripEscapes(selector);
    const classes = plain.match(/\.[\w-]+/g)?.length ?? 0;
    const attrs = plain.match(/\[[^\]]*\]/g)?.length ?? 0;
    const pseudo = plain.match(/:(?!:)(?!is\(|has\(|where\(|not\()[\w-]+/g)?.length ?? 0;
    return classes + attrs + pseudo;
  };
  const OTHER_STATE =
    /:hover|:active|:disabled|:checked|aria-expanded|aria-checked|aria-pressed|data-state|data-align|data-checked|data-unchecked|data-pressed|data-size|data-disabled|combobox|:focus-within|::|>textarea/;
  async function rules(classes: string[]): Promise<Rule[]> {
    const input = `${tailwindTheme}
@custom-variant dark (&:is(.dark *));
@theme inline { --color-ring: var(--ring); --color-destructive: var(--destructive); --color-background: var(--background); --color-border: var(--border); --color-input: var(--input); --color-foreground: var(--foreground); --color-primary: var(--primary); }
@tailwind utilities;`;
    const compiler = await compile(input, {
      base: import.meta.dirname,
      loadStylesheet: async () => ({ path: "", base: "", content: "" }),
    });
    const css = compiler.build(classes);
    return [...css.matchAll(/^(\.[^\n{]+) \{\n([\s\S]*?)\n\}/gm)].map((m, index) => ({
      selector: m[1] ?? "",
      body: m[2] ?? "",
      index,
    }));
  }
  function winner(all: Rule[], dark: boolean, property: string): Rule | undefined {
    return all
      .filter((rule) => {
        const sel = stripEscapes(rule.selector);
        if (!rule.body.includes(property)) return false;
        if (OTHER_STATE.test(sel)) return false;
        if (sel.includes(".dark") && !dark) return false;
        return true;
      })
      .sort((a, b) => specificity(a.selector) - specificity(b.selector) || a.index - b.index)
      .at(-1);
  }
  const lastValue = (body: string, property: string) =>
    [...body.matchAll(new RegExp(`${property}: ([^;]+);`, "g"))].at(-1)?.[1] ?? "";

  it.each(["button", "input", "textarea", "select", "checkbox", "toggle", "input-group"])(
    "%s",
    async (file) => {
      const source = readFileSync(
        resolve(import.meta.dirname, `../../../../packages/ui/src/components/${file}.tsx`),
        "utf8",
      );
      const classes = [...new Set(source.match(/[^\s"'`]+/g) ?? [])];
      const all = await rules(classes);
      for (const dark of [false, true]) {
        const color = winner(all, dark, "--tw-ring-color");
        const width = winner(all, dark, "--tw-ring-shadow");
        expect(color, `${file} dark=${dark}`).toBeDefined();
        const sel = stripEscapes(color?.selector ?? "");
        expect(sel, `${file} dark=${dark}`).toMatch(/focus-visible/);
        expect(sel, `${file} dark=${dark}`).toMatch(/aria-invalid/);
        expect(lastValue(color?.body ?? "", "--tw-ring-color")).toBe("var(--destructive)");
        expect(lastValue(width?.body ?? "", "--tw-ring-shadow")).toMatch(/calc\(2px/);
      }
    },
  );
});
