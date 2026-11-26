/**
 * The web shell rules a static check can see, ported from the template's
 * scripts/check-web-conventions.ts with its rule ids. Called by check-agent-rules.ts; syntax only,
 * no app imports or I/O beyond source reads. The template's other web rules (G1–G7) are not ported
 * here: this repo enforces its own conventions elsewhere (policy-checks.sh, Biome, oxlint).
 * Rules: docs/ui.md § Shell rules
 *
 *   G8: a page scroller (`<main>`) reserves no scrollbar gutter, and a route file renders no site
 *       `<footer>` (footer content belongs to components/public-footer.tsx).
 *   G9: web source follows the app theme: no literal colours, no Tailwind arbitrary colour values and
 *       no `prefers-color-scheme` outside packages/ui/src/styles/globals.css, unless the line carries
 *       a reasoned `theme-exempt: <reason>` comment.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const { parse } = createRequire(import.meta.url)("@babel/parser") as typeof import("@babel/parser");

type Node = { type: string; [key: string]: unknown };
type Binding = { value?: Node; ancestors: Node[]; source?: string; imported?: string };
export type Finding = { file: string; line: number; rule: string; message: string };

function node(value: unknown): Node | undefined {
  return value !== null && typeof value === "object" && "type" in value
    ? (value as Node)
    : undefined;
}
function name(value: unknown): string | undefined {
  const n = node(value);
  return n?.type === "Identifier" || n?.type === "JSXIdentifier"
    ? String(n.name)
    : n?.type === "StringLiteral"
      ? String(n.value)
      : undefined;
}
function children(value: unknown): Node[] {
  return Array.isArray(value) ? value.flatMap((item) => node(item) ?? []) : [];
}
function walk(n: Node, ancestors: Node[], visit: (n: Node, ancestors: Node[]) => void): void {
  visit(n, ancestors);
  for (const [key, value] of Object.entries(n)) {
    if (["loc", "tokens", "comments"].includes(key) || key.endsWith("Comments")) continue;
    for (const child of Array.isArray(value) ? children(value) : [node(value)]) {
      if (child) walk(child, [...ancestors, n], visit);
    }
  }
}
function line(n: Node): number {
  return (n.loc as { start: { line: number } } | undefined)?.start.line ?? 1;
}
function offsetLine(source: string, offset: number): number {
  return source.slice(0, offset).split("\n").length;
}
function unwrap(n: Node | undefined): Node | undefined {
  while (
    n &&
    [
      "TSAsExpression",
      "TSSatisfiesExpression",
      "TSNonNullExpression",
      "ParenthesizedExpression",
    ].includes(n.type)
  )
    n = node(n.expression);
  return n;
}
function property(n: Node | undefined): string | undefined {
  return n && (!n.computed || node(n.property)?.type === "StringLiteral")
    ? name(n.property)
    : undefined;
}
function isScope(n: Node): boolean {
  return [
    "Program",
    "BlockStatement",
    "ArrowFunctionExpression",
    "FunctionExpression",
    "FunctionDeclaration",
    "CatchClause",
  ].includes(n.type);
}

/** Local binding provenance prevents aliased imports bypassing rules and shadowed names triggering them. */
function bindings(ast: Node) {
  const scopes = new WeakMap<Node, Map<string, Binding>>();
  function put(scope: Node | undefined, id: unknown, binding: Binding): void {
    if (!scope) return;
    const n = node(id);
    if (n?.type === "Identifier") {
      if (!scopes.has(scope)) scopes.set(scope, new Map());
      scopes.get(scope)?.set(String(n.name), binding);
    } else if (n?.type === "ObjectPattern" || n?.type === "ArrayPattern") {
      for (const part of children(n.properties ?? n.elements))
        put(scope, part.type === "ObjectProperty" ? part.value : part, {
          ancestors: binding.ancestors,
        });
    } else if (n?.type === "AssignmentPattern") put(scope, n.left, binding);
    else if (n?.type === "RestElement") put(scope, n.argument, binding);
  }
  walk(ast, [], (n, ancestors) => {
    const scope = [...ancestors].reverse().find(isScope);
    if (n.type === "VariableDeclarator") {
      const declaration = ancestors.at(-1);
      const owner =
        declaration?.kind === "var"
          ? [...ancestors].reverse().find((item) => isScope(item) && item.type !== "BlockStatement")
          : scope;
      put(owner, n.id, { value: node(n.init), ancestors });
    }
    if (n.type === "FunctionDeclaration") put(scope, n.id, { value: n, ancestors });
    if (["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(n.type)) {
      for (const param of children(n.params)) put(n, param, { ancestors: [...ancestors, n] });
    }
    if (n.type === "CatchClause") put(n, n.param, { ancestors: [...ancestors, n] });
    if (n.type === "ImportDeclaration" && n.importKind !== "type") {
      for (const spec of children(n.specifiers)) {
        if (spec.importKind !== "type")
          put(scope, spec.local, {
            ancestors,
            source: name(n.source),
            imported:
              spec.type === "ImportNamespaceSpecifier" ? "*" : (name(spec.imported) ?? "default"),
          });
      }
    }
  });
  function lookup(id: string, ancestors: Node[]): Binding | undefined {
    for (const ancestor of [...ancestors].reverse()) {
      const found = scopes.get(ancestor)?.get(id);
      if (found) return found;
    }
    return undefined;
  }
  function resolve(
    n: Node | undefined,
    ancestors: Node[],
    seen = new Set<Node>(),
  ): { value?: Node; ancestors: Node[] } {
    n = unwrap(n);
    if (n?.type !== "Identifier" || seen.has(n)) return { value: n, ancestors };
    seen.add(n);
    const binding = lookup(String(n.name), ancestors);
    return binding?.value
      ? resolve(binding.value, binding.ancestors, seen)
      : { value: n, ancestors };
  }
  function imported(
    n: Node | undefined,
    ancestors: Node[],
    source: string,
    symbol: string,
  ): boolean {
    const resolved = resolve(n, ancestors);
    n = resolved.value;
    if (n?.type === "Identifier") {
      const binding = lookup(String(n.name), resolved.ancestors);
      return binding?.source === source && binding.imported === symbol;
    }
    if (
      ["MemberExpression", "OptionalMemberExpression"].includes(n?.type ?? "") &&
      property(n) === symbol
    ) {
      const binding = lookup(name(n?.object) ?? "", resolved.ancestors);
      return binding?.source === source && binding.imported === "*";
    }
    return false;
  }
  return { lookup, resolve, imported };
}

type Context = ReturnType<typeof bindings>;

/** A style object's string values with their keys, following bindings and spreads. */
function styleEntries(
  n: Node | undefined,
  ancestors: Node[],
  context: Context,
  depth = 0,
): Array<{ key: string | undefined; text: string; at: Node }> {
  if (depth > 20) return [];
  const resolved = context.resolve(n, ancestors);
  if (resolved.value?.type !== "ObjectExpression") return [];
  return children(resolved.value.properties).flatMap((prop) => {
    if (prop.type === "SpreadElement")
      return styleEntries(node(prop.argument), resolved.ancestors, context, depth + 1);
    if (prop.type !== "ObjectProperty") return [];
    const value = context.resolve(node(prop.value), resolved.ancestors).value;
    const text =
      value?.type === "StringLiteral"
        ? String(value.value)
        : value?.type === "TemplateLiteral"
          ? children(value.quasis)
              .map((q) => String((q.value as { raw?: string })?.raw))
              .join(" ")
          : "";
    // Reported at the property, so a theme-exempt comment above a multiline style's entry applies.
    return [{ key: prop.computed ? undefined : name(prop.key), text, at: prop }];
  });
}

type ClassSet = { tokens: string[]; when: Map<string, boolean> };
const classSet = (tokens: string[] = []): ClassSet => ({ tokens, when: new Map() });
function combine(left: ClassSet[], right: ClassSet[]): ClassSet[] {
  const result: ClassSet[] = [];
  for (const a of left)
    for (const b of right) {
      if ([...b.when].some(([key, value]) => a.when.has(key) && a.when.get(key) !== value))
        continue;
      result.push({ tokens: [...a.tokens, ...b.tokens], when: new Map([...a.when, ...b.when]) });
      if (result.length > 128)
        throw new Error(
          "Too many static class branches to check. Fix: fold the conditional classes into fewer conditional strings (docs/ui.md § Shell rules).",
        );
    }
  return result;
}
/** Preserve exclusive branches and correlate repeated simple conditions within cn/arrays/templates. */
function classSets(root: Node | undefined, rootAncestors: Node[], context: Context): ClassSet[] {
  const conditionIds = new Map<Binding | string, number>();
  function condition(n: Node | undefined, ancestors: Node[], truthy: boolean): ClassSet[] {
    n = unwrap(n);
    if (n?.type === "UnaryExpression" && n.operator === "!")
      return condition(node(n.argument), ancestors, !truthy);
    const resolved = context.resolve(n, ancestors).value;
    if (resolved?.type === "BooleanLiteral") return resolved.value === truthy ? [classSet()] : [];
    if (n?.type !== "Identifier") return [classSet()]; // complex expressions are not assumed equivalent
    const binding = context.lookup(String(n.name), ancestors) ?? String(n.name);
    if (!conditionIds.has(binding)) conditionIds.set(binding, conditionIds.size);
    return [{ tokens: [], when: new Map([[String(conditionIds.get(binding)), truthy]]) }];
  }
  function collect(n: Node | undefined, ancestors: Node[], depth: number): ClassSet[] {
    if (!n || depth > 20) return [classSet()];
    const resolved = context.resolve(n, ancestors);
    n = resolved.value;
    ancestors = resolved.ancestors;
    const recur = (value: unknown) => collect(node(value), ancestors, depth + 1);
    const branch = (test: unknown, truthy: boolean, choices: ClassSet[]) =>
      combine(condition(node(test), ancestors, truthy), choices);
    if (!n) return [classSet()];
    if (n.type === "JSXExpressionContainer") return recur(n.expression);
    if (n.type === "StringLiteral") return [classSet(String(n.value).split(/\s+/).filter(Boolean))];
    if (n.type === "TemplateLiteral") {
      // Literal portions only; dynamically constructed utility names are outside this finite proof.
      return children(n.quasis).reduce(
        (sets, quasi, index) => {
          const raw = (quasi.value as { raw: string }).raw;
          const parts = [classSet(raw.split(/\s+/).filter(Boolean))];
          return combine(combine(sets, parts), recur(children(n?.expressions)[index]));
        },
        [classSet()],
      );
    }
    if (n.type === "ConditionalExpression")
      return [
        ...branch(n.test, true, recur(n.consequent)),
        ...branch(n.test, false, recur(n.alternate)),
      ];
    if (n.type === "LogicalExpression") {
      if (n.operator === "&&")
        return [...branch(n.left, false, [classSet()]), ...branch(n.left, true, recur(n.right))];
      return [...branch(n.left, true, recur(n.left)), ...branch(n.left, false, recur(n.right))];
    }
    if (n.type === "BinaryExpression" && n.operator === "+")
      return combine(recur(n.left), recur(n.right));
    if (n.type === "ArrayExpression")
      return children(n.elements).reduce((sets, item) => combine(sets, recur(item)), [classSet()]);
    if (
      n.type === "CallExpression" &&
      (["cn", "clsx", "classnames"].includes(name(n.callee) ?? "") ||
        context.imported(node(n.callee), ancestors, "@knowledge-base/ui/lib/utils", "cn"))
    ) {
      return children(n.arguments).reduce((sets, item) => combine(sets, recur(item)), [classSet()]);
    }
    if (n.type === "ObjectExpression")
      return children(n.properties).reduce(
        (sets, prop) => {
          if (prop.type === "SpreadElement") return combine(sets, recur(prop.argument));
          if (prop.type !== "ObjectProperty" || prop.computed) return sets;
          const tokens = (name(prop.key) ?? "").split(/\s+/).filter(Boolean);
          return combine(sets, [
            ...branch(prop.value, false, [classSet()]),
            ...branch(prop.value, true, [classSet(tokens)]),
          ]);
        },
        [classSet()],
      );
    return [classSet()];
  }
  return collect(root, rootAncestors, 0);
}

/** Split only outside arbitrary Tailwind variants such as [&:hover]:. */
function utility(token: string): { prefix: string; base: string } {
  let bracketDepth = 0;
  let boundary = -1;
  for (let i = 0; i < token.length; i++) {
    if (token[i] === "[") bracketDepth++;
    else if (token[i] === "]") bracketDepth--;
    else if (token[i] === ":" && bracketDepth === 0) boundary = i;
  }
  return {
    prefix: token.slice(0, boundary + 1),
    base: token.slice(boundary + 1).replace(/^!|!$/g, ""),
  };
}
/**
 * Elements whose <footer> is that element's own (author line, citation, card
 * actions), not site chrome: HTML's sectioning content and sectioning roots.
 */
const SECTION_TAGS = new Set([
  "article",
  "aside",
  "nav",
  "section",
  "blockquote",
  "details",
  "dialog",
  "fieldset",
  "figure",
  "td",
]);
/**
 * A selector list split at its top-level commas, with pseudo-class arguments removed
 * (`.pane:not(main, #main-content)` → `.pane:not`): those arguments never name the styled element.
 */
function topLevelSelectors(selectorList: string): string[] {
  let list = selectorList;
  while (/\([^()]*\)/.test(list)) list = list.replace(/\([^()]*\)/g, "");
  return list
    .split(",")
    .map((selector) => selector.trim())
    .filter(Boolean);
}
/** The theme's token file: the one place literal colours and color-scheme queries belong. */
const THEME_TOKENS = "packages/ui/src/styles/globals.css";
const LITERAL_COLOR = /#[0-9a-f]{3,8}(?![\w-])|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i;
/**
 * A CSS `url(…)` value: `url(#fade)`, `url(/shapes.svg#fade)`, `url("data:…")`. Its `#…` is an element
 * reference (clip path, mask, gradient), not a colour, so the whole value is dropped before the check;
 * a colour next to it (`url(#grad) #fff`) still counts.
 */
const CSS_URL = /\burl\(\s*(?:"[^"]*"|'[^']*'|[^)"']*)\s*\)/gi;
function hasLiteralColor(text: string): boolean {
  return LITERAL_COLOR.test(text.replace(CSS_URL, "url()"));
}
/** A Tailwind arbitrary value that is a literal colour: `bg-[#fff]`, `text-[oklch(…)]`. */
const ARBITRARY_COLOR =
  /-\[(?:color:)?(?:#[0-9a-f]{3,8}|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\()/i;
const THEME_MESSAGE =
  "follows the OS or a fixed colour instead of the app theme (stored choice > OS, the `.dark` class). Fix: use the theme tokens (bg-popover, text-foreground, var(--state-*)…) and `dark:` variants; new colours become tokens in packages/ui/src/styles/globals.css (docs/ui.md § Shell rules).";
function isThemeScanned(file: string): boolean {
  return (
    /^(apps\/web|packages\/ui)\/src\//.test(file) &&
    file !== THEME_TOKENS &&
    !/\.test\.[cm]?[jt]sx?$/.test(file)
  );
}

/**
 * A deliberate fixed colour (a QR code that must stay dark-on-white to scan, a chess board, a share
 * image) carries `theme-exempt: <reason>` in a comment on the line above it, on its line, or inside
 * the flagged className/style value; the reason is required. G9 skips that finding and nothing else.
 */
const THEME_EXEMPT = /theme-exempt:\s*\S.{3,}/;
function withoutThemeExemptions(
  source: string,
  findings: Finding[],
  ends: ReadonlyMap<Finding, number> = new Map(),
): Finding[] {
  const lines = source.split("\n");
  const exempt = (finding: Finding) =>
    lines
      .slice(Math.max(0, finding.line - 2), ends.get(finding) ?? finding.line)
      .some((text) => THEME_EXEMPT.test(text));
  return findings.filter((finding) => finding.rule !== "G9" || !exempt(finding));
}

export function scanWebSource(file: string, source: string): Finding[] {
  const findings: Finding[] = [];
  // Where each finding's flagged node ends, so a theme-exempt comment inside a multiline
  // className/style value (above the literal it covers) still applies.
  const ends = new Map<Finding, number>();
  const add = (n: Node, rule: string, message: string) => {
    const finding = { file, line: line(n), rule, message };
    ends.set(finding, (n.loc as { end: { line: number } } | undefined)?.end.line ?? finding.line);
    findings.push(finding);
  };
  let ast: Node;
  try {
    ast = parse(source, {
      sourceType: "unambiguous",
      // `.ts` files are not JSX: there `<T>(value: T) => …` is a generic arrow.
      plugins: /\.[cm]?ts$/.test(file) ? ["typescript"] : ["typescript", "jsx"],
      allowUndeclaredExports: true,
    }) as unknown as Node;
  } catch (error) {
    const location = (error as { loc?: { line?: number } }).loc;
    return [
      {
        file,
        line: location?.line ?? 1,
        rule: "parse",
        message: `Cannot parse source: ${(error as Error).message}. Fix the syntax and rerun pnpm policy:checks.`,
      },
    ];
  }
  const context = bindings(ast);
  walk(ast, [], (n, ancestors) => {
    if (n.type === "JSXOpeningElement") {
      const attrs = children(n.attributes);
      const tag = name(n.name);
      for (const attr of attrs) {
        if (name(attr.name) !== "className") continue;
        let sets: ClassSet[];
        try {
          sets = classSets(node(attr.value), ancestors, context);
        } catch (error) {
          add(attr, "G9", (error as Error).message);
          continue;
        }
        const gutters = new Set<string>();
        const colors = new Set<string>();
        for (const set of sets) {
          for (const u of set.tokens.map(utility)) {
            if (tag === "main" && /scrollbar-gutter:(?!auto\])/.test(u.base)) gutters.add(u.base);
            if (isThemeScanned(file) && ARBITRARY_COLOR.test(u.base)) colors.add(u.base);
          }
        }
        if (gutters.size)
          add(
            attr,
            "G8",
            `The page scroller reserves a scrollbar gutter (${[...gutters].join(", ")}), so every full-bleed rule inside it (footer, sub-nav, banners) stops short of the viewport edge with classic scrollbars. Fix: remove it from <main>; nested panes may keep it (docs/ui.md § Shell rules).`,
          );
        if (colors.size)
          add(attr, "G9", `Literal colour class (${[...colors].join(", ")}) ${THEME_MESSAGE}`);
      }
      const style = attrs.find((attr) => name(attr.name) === "style");
      const styleValue = node(style?.value);
      if (styleValue?.type === "JSXExpressionContainer") {
        for (const entry of styleEntries(node(styleValue.expression), ancestors, context)) {
          if (isThemeScanned(file) && hasLiteralColor(entry.text))
            add(
              entry.at,
              "G9",
              `A literal colour in an inline style (${entry.text}) ${THEME_MESSAGE}`,
            );
          if (
            tag === "main" &&
            entry.key === "scrollbarGutter" &&
            !/^\s*auto\s*(?:!\s*important\s*)?$/i.test(entry.text)
          )
            add(
              entry.at,
              "G8",
              `The page scroller reserves a scrollbar gutter (scrollbarGutter: ${JSON.stringify(entry.text)}), so every full-bleed rule inside it stops short of the viewport edge with classic scrollbars. Fix: remove it from <main>; nested panes may keep it (docs/ui.md § Shell rules).`,
            );
        }
      }
      if (
        tag === "footer" &&
        file.startsWith("apps/web/src/routes/") &&
        !ancestors.some(
          (a) =>
            a.type === "JSXElement" && SECTION_TAGS.has(name(node(a.openingElement)?.name) ?? ""),
        )
      )
        add(
          n,
          "G8",
          "A route renders a site footer, which follows the page content instead of sitting at the bottom of a short page and repeats per page. Fix: put footer content in the public shell's footer (apps/web/src/components/public-footer.tsx); a footer that belongs to an <article>, <section> or similar stays inside that element (docs/ui.md § Shell rules).",
        );
    }
    if (
      isThemeScanned(file) &&
      ((n.type === "StringLiteral" && /prefers-color-scheme/i.test(String(n.value))) ||
        (n.type === "TemplateElement" &&
          /prefers-color-scheme/i.test(String((n.value as { raw?: string })?.raw))))
    )
      add(n, "G9", `A prefers-color-scheme query ${THEME_MESSAGE}`);
  });
  return withoutThemeExemptions(source, findings, ends);
}

/** CSS lexical blocks: comments and strings are masked before selectors and declarations are read. */
export function scanWebCss(file: string, source: string): Finding[] {
  const findings: Finding[] = [];
  const masked = source.replace(/\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, (part) =>
    part.replace(/[^\n]/g, " "),
  );
  const stack: Array<{
    start: number;
    selector: string;
    declarations: Array<{ text: string; offset: number }>;
  }> = [];
  let start = 0;
  const declaration = (end: number) => {
    const text = masked.slice(start, end).trim();
    if (text) stack.at(-1)?.declarations.push({ text, offset: start });
  };
  for (let i = 0; i < masked.length; i++) {
    const char = masked[i];
    if (char === "{") {
      const selector = masked.slice(start, i);
      if (isThemeScanned(file) && /prefers-color-scheme/i.test(selector))
        findings.push({
          file,
          line: offsetLine(masked, start + selector.search(/\S/)),
          rule: "G9",
          message: `A prefers-color-scheme query ${THEME_MESSAGE}`,
        });
      stack.push({ start: i, selector, declarations: [] });
      start = i + 1;
    } else if (char === ";") {
      declaration(i);
      start = i + 1;
    } else if (char === "}") {
      declaration(i);
      const block = stack.pop();
      if (!block)
        findings.push({
          file,
          line: offsetLine(masked, i),
          rule: "parse",
          message: "Unmatched CSS closing brace. Fix the syntax and rerun pnpm policy:checks.",
        });
      for (const d of block?.declarations ?? []) {
        const at = () => offsetLine(masked, d.offset + masked.slice(d.offset).search(/\S/));
        if (isThemeScanned(file) && hasLiteralColor(d.text.replace(/^[^:]*:/, "")))
          findings.push({
            file,
            line: at(),
            rule: "G9",
            message: `A literal colour ${THEME_MESSAGE}`,
          });
        if (
          /^scrollbar-gutter\s*:/i.test(d.text) &&
          !/^scrollbar-gutter\s*:\s*auto\s*(?:!\s*important\s*)?$/i.test(d.text) &&
          topLevelSelectors(block?.selector ?? "").some((selector) => {
            // The element the rule styles is the selector's last compound.
            const target = selector.split(/[\s>+~]+/).at(-1) ?? "";
            return /^main(?![\w-])|#main-content(?![\w-])/.test(target);
          })
        )
          findings.push({
            file,
            line: at(),
            rule: "G8",
            message:
              "The page scroller reserves a scrollbar gutter, so every full-bleed rule inside it stops short of the viewport edge with classic scrollbars. Fix: remove scrollbar-gutter from <main> (docs/ui.md § Shell rules).",
          });
      }
      start = i + 1;
    }
  }
  if (stack.length)
    findings.push({
      file,
      line: offsetLine(masked, stack.at(-1)?.start ?? 0),
      rule: "parse",
      message: "Unclosed CSS rule. Fix the syntax and rerun pnpm policy:checks.",
    });
  return withoutThemeExemptions(source, findings);
}

export function formatFinding(finding: Finding): string {
  return `${finding.file}:${finding.line} ${finding.rule}: ${finding.message}`;
}

/** Scans every tracked or non-ignored web/ui source file (deleted files are skipped). */
export function checkWebConventions(root: string): string[] {
  let paths: string[];
  try {
    paths = [
      ...new Set(
        execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
          cwd: root,
          encoding: "utf8",
          maxBuffer: 16 * 1024 * 1024,
          stdio: ["ignore", "pipe", "pipe"],
        })
          .split("\0")
          .filter(Boolean),
      ),
    ].sort();
  } catch (error) {
    return [
      `scripts/check-web-conventions.ts:1 Cannot enumerate tracked/nonignored source. Fix Git access and rerun pnpm policy:checks: ${(error as Error).message}`,
    ];
  }
  const failures: string[] = [];
  for (const file of paths) {
    if (
      !/^(apps\/web|packages\/ui)\/src\//.test(file) ||
      !/\.(?:[cm]?[jt]sx?|css)$/.test(file) ||
      !existsSync(join(root, file))
    )
      continue;
    try {
      const source = readFileSync(join(root, file), "utf8");
      failures.push(
        ...(file.endsWith(".css") ? scanWebCss(file, source) : scanWebSource(file, source)).map(
          formatFinding,
        ),
      );
    } catch (error) {
      failures.push(
        `${file}:1 Cannot read/check source. Fix the file and rerun pnpm policy:checks: ${(error as Error).message}`,
      );
    }
  }
  return failures;
}
