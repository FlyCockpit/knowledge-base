import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import postcss from "postcss";
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

const ui = resolve(import.meta.dirname, "../../../../packages/ui/src");
const themeScopes = [":root", ".dark"] as const;
/** Every ui control that draws a field-like border, focus ring or invalid state. */
const controls = [
  "button",
  "input",
  "textarea",
  "select",
  "checkbox",
  "toggle",
  "input-group",
  "switch",
  "radio-group",
  "tabs",
  "command",
  "combobox",
].filter((file) => existsSync(resolve(ui, `components/${file}.tsx`)));
const source = (file: string) => readFileSync(resolve(ui, `components/${file}.tsx`), "utf8");

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
    // Rings are drawn at full opacity: a translucent ring fails contrast (a 50%
    // ring measures about 1.4:1).
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

  it.each([":root", ".dark"])(
    "%s field outlines (--input) reach 3:1 on every surface a field sits on",
    (scope) => {
      // WCAG 1.4.11 non-text contrast: the border is what shows where to type.
      // --border is decorative (dividers, cards) and is not held to this.
      for (const surface of ["background", "card", "popover", "muted"]) {
        expect(
          contrast(token(scope, "input"), token(scope, surface)),
          `${scope} input on ${surface}`,
        ).toBeGreaterThanOrEqual(3);
      }
      // The dark field fill (bg-input/30) must keep placeholder text readable.
      if (scope === ".dark") {
        for (const surface of ["background", "card", "popover"]) {
          const fill = over(token(scope, "input"), 0.3, token(scope, surface));
          expect(
            contrast(token(scope, "muted-foreground"), fill),
            `${scope} placeholder on input fill over ${surface}`,
          ).toBeGreaterThanOrEqual(AA);
        }
      }
    },
  );

  it.each(themeScopes)("%s focus is clearly stronger than the resting outline", (scope) => {
    // WCAG 2.4.13 style: the focused border (border-ring) must differ from the
    // resting --input outline, not only the 2px ring around it (they were
    // 1.33:1 light and 1.50:1 dark).
    expect(
      contrast(token(scope, "ring"), token(scope, "input")),
      `${scope} ring vs input`,
    ).toBeGreaterThanOrEqual(2);
    expect(contrast(token(scope, "sidebar-ring"), token(scope, "input"))).toBeGreaterThanOrEqual(2);
    // The focused border also sits next to the field's own fill (dark bg-input/30).
    if (scope === ".dark") {
      for (const surface of ["background", "card", "popover"]) {
        const fill = over(token(scope, "input"), 0.3, token(scope, surface));
        expect(
          contrast(token(scope, "ring"), fill),
          `${scope} ring on input fill over ${surface}`,
        ).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it.each(themeScopes)(
    "%s invalid borders reach 3:1 on the surface and the field fill",
    (scope) => {
      // The border is opaque --destructive in both themes (no dark /50).
      for (const surface of ["background", "card", "popover", "muted"]) {
        const bg = token(scope, surface);
        const fills = scope === ".dark" ? [bg, over(token(scope, "input"), 0.3, bg)] : [bg];
        for (const fill of fills) {
          expect(
            contrast(token(scope, "destructive"), fill),
            `${scope} destructive border over ${surface}`,
          ).toBeGreaterThanOrEqual(3);
        }
      }
    },
  );

  it("controls draw opaque invalid borders and outline buttons use the field outline", () => {
    expect(controls).toEqual(expect.arrayContaining(["button", "input", "select", "checkbox"]));
    for (const file of controls) {
      expect(source(file), file).not.toMatch(/border-destructive\/\d+/);
    }
    // The outline button's border is its only edge (theme toggle, Sign In):
    // --input (3:1) in both themes, never the decorative --border (1.25:1).
    const outline = /outline:\s*"([^"]*)"/.exec(buttonSource)?.[1] ?? "";
    expect(outline).toMatch(/(?:^|\s)border-input(?:\s|$)/);
    expect(outline).not.toMatch(/border-border|dark:border-/);
  });

  it("draws every menu and popup on an opaque popover surface", () => {
    // A translucent menu (bg-popover/70 + blur) let a banner tint it (CTX-14),
    // and select kept it after dropdown-menu was fixed. Every class string that
    // paints a popover surface (text-popover-foreground) is checked, in every
    // ui component, so a new menu, combobox or picker is covered too.
    const surfaces: string[] = [];
    for (const file of readdirSync(resolve(ui, "components"))) {
      if (!file.endsWith(".tsx") || file.endsWith(".test.tsx")) continue;
      const text = readFileSync(resolve(ui, "components", file), "utf8");
      for (const match of text.matchAll(/"([^"\n]*text-popover-foreground[^"\n]*)"/g)) {
        const literal = match[1] ?? "";
        surfaces.push(file);
        expect(literal, file).toMatch(/(?:^|\s)bg-popover(?:\s|$)/);
        expect(literal, file).not.toMatch(/bg-popover\/\d+|backdrop-/);
      }
      expect(text, file).not.toMatch(/bg-popover\/\d+/);
    }
    for (const file of ["dropdown-menu.tsx", "select.tsx", "popover.tsx", "command.tsx"]) {
      expect(surfaces, file).toContain(file);
    }
  });

  it("measures the old focus and invalid colours as failing, so the checks discriminate", () => {
    const old = { ":root": [0.55, 0.021, 213.5], ".dark": [0.66, 0.021, 213.5] } as const;
    for (const scope of themeScopes) {
      const [l, c, h] = old[scope];
      expect(contrast(oklchToSrgb(l, c, h), token(scope, "input"))).toBeLessThan(2);
    }
    // The old dark invalid border (destructive/50) on the field fill over a card.
    const fill = over(token(".dark", "input"), 0.3, token(".dark", "card"));
    expect(contrast(over(token(".dark", "destructive"), 0.5, fill), fill)).toBeLessThan(3);
  });

  it("measures known-failing tokens as failing, so the check discriminates", () => {
    const oldLight = oklchToSrgb(0.577, 0.245, 27.325);
    expect(contrast(oldLight, token(":root", "muted"))).toBeLessThan(AA);
    const oldDark = oklchToSrgb(0.443, 0.11, 240.79);
    const oldMuted = oklchToSrgb(0.56, 0.021, 213.5);
    expect(contrast(oldMuted, token(":root", "muted"))).toBeLessThan(AA);
    expect(contrast(oldDark, token(".dark", "background"))).toBeLessThan(AA);
    // The original light --input (1.25:1 on white).
    expect(contrast(oklchToSrgb(0.925, 0.005, 214.3), token(":root", "background"))).toBeLessThan(
      3,
    );
    // An 80% link hover fill under the dark primary.
    const darkPrimary = token(".dark", "primary");
    const darkHover = over(darkPrimary, 0.8, token(".dark", "background"));
    expect(contrast(token(".dark", "primary-foreground"), darkHover)).toBeLessThan(AA);
  });
});

describe("toast titles", () => {
  it("override sileo's capitalize so titles keep their locale's sentence case", () => {
    expect(css).toMatch(/:root \[data-sileo-title\] \{\s*text-transform: none;/);
  });

  it("cap a long title to sileo's 350px pill so the icon stays inside it", () => {
    // sileo sizes the pill from the header but draws it in a fixed 350px SVG:
    // the header row is capped and the title ellipsised (the facade repeats a
    // long message in the description).
    expect(css).toMatch(
      /:root \[data-sileo-viewport\] \[data-sileo-header-inner\] \{\s*max-width: calc\(var\(--sileo-width\) - 1rem - 10px\);/,
    );
    expect(css).toMatch(
      /\[data-sileo-header-inner\] \[data-sileo-title\] \{[^}]*text-overflow: ellipsis;/,
    );
  });
});

// docs/ui.md § Shell rules
describe("state inks and toasts follow the theme", () => {
  const scopes = [":root", ".dark"] as const;

  it.each(scopes)("%s state inks reach 4.5:1 on background, card and popover", (scope) => {
    // Badges, alerts and toasts write in these colours.
    for (const ink of ["state-success", "state-warning", "state-info"]) {
      for (const surface of ["background", "card", "popover"]) {
        expect(
          contrast(token(scope, ink), token(scope, surface)),
          `${scope} ${ink} on ${surface}`,
        ).toBeGreaterThanOrEqual(AA);
      }
    }
  });

  it.each(scopes)("%s toasts are a popover surface with 4.5:1 inks", (scope) => {
    // sileo's own palette inverts the theme; globals.css repaints it from the
    // tokens. Every state ink it maps and its text colour must hold up on the
    // fill it maps.
    const rules = postcss.parse(css).nodes.filter((node) => node.type === "rule");
    const declarations = (selector: string) => {
      const rule = rules.find((node) => node.type === "rule" && node.selector === selector);
      if (rule?.type !== "rule") throw new Error(`Missing toast rule ${selector}`);
      return new Map(
        rule.nodes.flatMap((node) => (node.type === "decl" ? [[node.prop, node.value]] : [])),
      );
    };
    const alias = (value: string | undefined) => /^var\(--([\w-]+)\)$/.exec(value ?? "")?.[1];
    const fill = alias(
      declarations(":root [data-sileo-viewport] :is([data-sileo-pill], [data-sileo-body])").get(
        "fill",
      ),
    );
    expect(fill).toBe("popover");
    const surface = token(scope, "popover");
    const viewport = declarations(":root [data-sileo-viewport]");
    // `loading` maps to --state-loading, which is a var() alias of
    // --muted-foreground (covered by the muted-text test), so it is checked
    // through that token.
    const resolveInk = (name: string): string => {
      const value = new RegExp(`--${name}:\\s*var\\(--([\\w-]+)\\)`).exec(block(scope));
      return value?.[1] ?? name;
    };
    for (const state of ["success", "loading", "error", "warning", "info", "action"]) {
      const ink = alias(viewport.get(`--sileo-state-${state}`));
      expect(ink, `--sileo-state-${state} maps to a token`).toBeDefined();
      expect(
        contrast(token(scope, resolveInk(ink ?? "")), surface),
        `${scope} toast ${state} (${ink}) on popover`,
      ).toBeGreaterThanOrEqual(AA);
    }
    // The badge ink sits on the pill itself (contrast above), not on a tint.
    expect(
      declarations(":root [data-sileo-viewport] [data-sileo-badge][data-state]").get(
        "--sileo-tone-bg",
      ),
    ).toBe("transparent");
    for (const selector of [
      ":root [data-sileo-viewport] [data-sileo-title][data-state]",
      ":root [data-sileo-viewport] [data-sileo-description]",
    ]) {
      expect(alias(declarations(selector).get("color")), selector).toBe("popover-foreground");
    }
    expect(contrast(token(scope, "popover-foreground"), surface)).toBeGreaterThanOrEqual(AA);
  });
});

/**
 * The focus ring of an invalid field: `aria-invalid:ring-*`
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

describe("switch track", () => {
  it("an Off switch fills its track with the opaque --input, which the 3:1 checks cover", () => {
    // A translucent track (dark:bg-input/80) composites below 3:1 on a card.
    const source = readFileSync(
      resolve(import.meta.dirname, "../../../../packages/ui/src/components/switch.tsx"),
      "utf8",
    );
    expect(source).toContain("data-unchecked:bg-input ");
    expect(source).not.toMatch(/data-unchecked:bg-input\/\d+/);
  });
});

// docs/ui.md: fills made from the 3:1 --input must still carry muted text.
describe("field fills keep muted text readable", () => {
  const ui = resolve(import.meta.dirname, "../../../../packages/ui/src");

  it("on every hovered --input fill", () => {
    const roots = [ui, resolve(import.meta.dirname, "..")];
    const fills: string[] = [];
    for (const root of roots) {
      for (const file of readdirSync(root, { recursive: true, encoding: "utf8" })) {
        if (!/\.tsx?$/.test(file) || /\.test\.tsx?$/.test(file)) continue;
        const source = readFileSync(resolve(root, file), "utf8");
        for (const match of source.matchAll(/(?<![\w-])((?:[\w-]+:)*hover:)bg-input\/(\d+)/g)) {
          fills.push(`${file}: ${match[0]}`);
          const scopes = (match[1] ?? "").split(":").includes("dark")
            ? [".dark"]
            : [":root", ".dark"];
          for (const scope of scopes) {
            for (const surface of ["background", "card", "popover"]) {
              const fill = over(
                token(scope, "input"),
                Number(match[2]) / 100,
                token(scope, surface),
              );
              expect(
                contrast(token(scope, "muted-foreground"), fill),
                `${scope} placeholder on ${match[0]} over ${surface} (${file})`,
              ).toBeGreaterThanOrEqual(AA);
            }
          }
        }
      }
    }
    // The select, outline-button and language-switcher hovers.
    expect(fills.length).toBeGreaterThanOrEqual(3);
  });

  it.each(["command.tsx", "async-combobox.tsx", "multi-async-combobox.tsx"])(
    "%s: a muted placeholder on an opaque muted search fill",
    (file) => {
      // Tailwind's default placeholder is the text colour at 50%. Unprefixed
      // and dark: InputGroup's own `dark:bg-input/30` would otherwise win.
      const source = readFileSync(resolve(ui, "components", file), "utf8");
      expect(source).toContain("placeholder:text-muted-foreground");
      expect(source).toMatch(/InputGroup className="[^"]*(?<![\w:-])bg-muted[^"]*dark:bg-muted/);
      expect(source).not.toMatch(/InputGroup className="[^"]*bg-input\/\d+/);
    },
  );
});

describe("switch size", () => {
  it("sizes the track in rem, like its thumb, so it scales with the root font", () => {
    // A px track holds a rem thumb: at the 4K root (24px) the thumb outgrew it.
    const source = readFileSync(
      resolve(import.meta.dirname, "../../../../packages/ui/src/components/switch.tsx"),
      "utf8",
    );
    expect(source).not.toMatch(/data-\[size=[a-z]+\]:[hw]-\[[\d.]+px\]/);
    expect(source).not.toMatch(/translate-x-\[calc\(100%-\d+px\)\]/);
  });
});

describe("toast placement and touch targets", () => {
  const root = postcss.parse(css);
  // Every declaration of `prop` in rules matching `selector`, with the
  // @media params it sits under ("" at the top level or in @layer).
  function find(selector: string, prop: string) {
    const found: { value: string; media: string }[] = [];
    root.walkRules((rule) => {
      if (rule.selector !== selector) return;
      let media = "";
      for (let parent = rule.parent; parent && parent.type !== "root"; parent = parent.parent) {
        if (parent.type === "atrule" && parent.name === "media") media = parent.params;
      }
      rule.walkDecls(prop, (declaration) => {
        found.push({ value: declaration.value, media });
      });
    });
    return found;
  }

  it("bottom toasts sit above the phone bottom nav, and above the safe area without one", () => {
    expect(find(':root [data-sileo-viewport][data-position^="bottom"]', "bottom")).toEqual([
      { value: "max(var(--bottom-nav-height), var(--safe-area-bottom))", media: "" },
    ]);
    // 0 unless a bottom nav is on screen, which is only below md (48rem).
    expect(find(":root", "--bottom-nav-height")).toEqual([{ value: "0px", media: "" }]);
    expect(find(":root:has([data-bottom-nav])", "--bottom-nav-height")).toEqual([
      { value: "calc(var(--bottom-nav-bar) + var(--safe-area-bottom))", media: "(width < 48rem)" },
    ]);
    // The nav draws its bar at --bottom-nav-bar, hides from md, and pads the
    // safe area itself, so the offset is exactly the room it takes.
    expect(find(":root", "--bottom-nav-bar")).toEqual([{ value: "3.5rem", media: "" }]);
    const nav = readFileSync(resolve(import.meta.dirname, "../components/bottom-nav.tsx"), "utf8");
    const bars = [...nav.matchAll(/<nav\b[\s\S]*?<div className="([^"]*)"/g)].map((m) => m[1]);
    expect(bars.length).toBe(2);
    for (const bar of bars) expect(bar).toContain("h-(--bottom-nav-bar)");
    expect(nav.match(/data-bottom-nav\b/g)?.length).toBe(2);
    expect(nav.match(/md:hidden/g)?.length).toBe(2);
    expect(nav.match(/paddingBottom: "var\(--safe-area-bottom\)"/g)?.length).toBe(2);
  });

  it("a toast's action button is at least 44px tall on a touch screen", () => {
    // sileo draws it 1.75rem (28px) tall with a fixed `height`.
    expect(find(":root [data-sileo-viewport] [data-sileo-button]", "min-height")).toEqual([
      { value: "44px", media: "(pointer: coarse)" },
    ]);
    expect(find(":root [data-sileo-viewport] [data-sileo-button]", "height")).toEqual([
      { value: "auto", media: "(pointer: coarse)" },
    ]);
  });
});
