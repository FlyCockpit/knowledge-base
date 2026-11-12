/**
 * Enforces three AGENTS.md rules that neither the compiler nor Biome can see.
 * Each gate is cheap (a file walk + @babel/parser, no typecheck, no app-code
 * imports) and false-positive-free on the current tree.
 *
 *   node scripts/check-agent-rules.ts
 *   node scripts/check-agent-rules.ts --self-test
 *   (production wiring: scripts/policy-checks.sh → pnpm policy:checks →
 *    pnpm verify:fast; the self-test rides policy:checks:self-test nightly.)
 *
 * GATE 1 — ROUTE-EXPORT LINT (AGENTS.md § React and AGENTS.md § Performance: "Never
 *   `export` a component function from a route file"). Every VALUE export
 *   from a .ts/.tsx file under apps/web/src/routes must be named exactly
 *   `Route`. Type-only exports (`export type`, `export interface`,
 *   `export { type X }`) are erasures and stay allowed. `export default` and
 *   `export *` fail closed: neither shape exists in a route file today, and
 *   both hide what they re-export from this scan.
 *
 * GATE 2 — t()-COVERAGE HEURISTIC (AGENTS.md § Internationalization.
 * "Every user-facing string goes through t()"). Scans JSX in .tsx files under
 *   apps/web/src/components and apps/web/src/routes, and flags a literal only
 *   when ALL of the following hold:
 *     - it is JSXText (text between tags — `{t(...)}` children are expression
 *       containers and never JSXText) or the StringLiteral value of a
 *       user-facing attribute: placeholder, title, label, aria-label,
 *       aria-description, aria-placeholder, alt, emptyText;
 *     - after trim it contains an ASCII letter and no `{` or `}`;
 *     - it is sentence-like: ends in . , : ; ? !  OR has at least 2 words and
 *       a vowel OR is a single word of length at least 2 with a vowel
 *       (single-word labels like "Beta" are translatable too; unit tokens
 *       without vowels — "KB", "SRT", "000000" — and pure symbols pass);
 *     - it is not inside a code/pre/kbd/samp element (code strings), not
 *       inside an element whose className contains `sr-only` (accessibility
 *       text is an explicit AGENTS.md exception), and not matched by a
 *       reviewed entry in scripts/lib/agent-rules-allowlist.json.
 *   Colocated tests (.test.tsx / .spec.tsx) are skipped — fixtures stub copy
 *   on purpose. A stale allowlist entry fails: the list only shrinks.
 *
 * GATE 3 — SITEMAP SYNC (AGENTS.md § Sitemap.
 * PUBLIC_PATHS and sitemap.md are
 *   maintained together). Every `path:` entry in the PUBLIC_PATHS array in
 *   apps/server/src/seo.ts must appear in sitemap.md in its `/{lang}`
 *   notation (path "" → `/{lang}/`). The check is one-way by design:
 *   sitemap.md's Public Routes table intentionally lists router-public pages
 *   that are excluded from SEO discovery, so extra rows there are not
 *   violations. A PUBLIC_PATHS array this cannot parse fails closed.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import process from "node:process";

const { parse } = createRequire(import.meta.url)("@babel/parser") as typeof import("@babel/parser");

const ROOT = resolve(import.meta.dirname!, "..");
const ROUTES_DIR = resolve(ROOT, "apps/web/src/routes");
const JSX_SCAN_DIRS = [
  resolve(ROOT, "apps/web/src/components"),
  resolve(ROOT, "apps/web/src/routes"),
];
const SEO_FILE = resolve(ROOT, "apps/server/src/seo.ts");
const SEO_FILE_REL = "apps/server/src/seo.ts";
const SITEMAP_FILE = resolve(ROOT, "sitemap.md");
const SITEMAP_FILE_REL = "sitemap.md";
const ALLOWLIST_FILE = resolve(ROOT, "scripts/lib/agent-rules-allowlist.json");
const ALLOWLIST_FILE_REL = "scripts/lib/agent-rules-allowlist.json";

// -- AST plumbing (same shape as scripts/check-access-matrix.ts) -------------

type AstNode = {
  type: string;
  [key: string]: unknown;
};

function node(value: unknown): AstNode | undefined {
  return typeof value === "object" && value !== null && "type" in value
    ? (value as AstNode)
    : undefined;
}

function identifierName(value: unknown): string | undefined {
  const current = node(value);
  return current?.type === "Identifier" ? (current.name as string) : undefined;
}

function startLine(value: AstNode | undefined): number | undefined {
  const loc = value?.loc as { start?: { line?: unknown } } | undefined;
  const line = loc?.start?.line;
  return typeof line === "number" ? line : undefined;
}

/** Throws on unparsable source; callers fail closed on the thrown error. */
function parseSource(rel: string, source: string): AstNode {
  try {
    return parse(source, {
      sourceType: "module",
      sourceFilename: rel,
      plugins: ["typescript", "jsx"],
      allowUndeclaredExports: true,
    }) as unknown as AstNode;
  } catch (error) {
    throw new Error(`${rel} cannot be parsed: ${(error as Error).message}`);
  }
}

function programOf(ast: AstNode): AstNode | undefined {
  return node(ast.program);
}

/** Recursive walk with the ancestor chain, for JSX-context checks. */
function walkWithAncestors(
  current: AstNode,
  ancestors: AstNode[],
  visit: (n: AstNode, ancestors: AstNode[]) => void,
): void {
  visit(current, ancestors);
  const next = [...ancestors, current];
  for (const key of Object.keys(current)) {
    if (key === "loc" || key === "type" || key.endsWith("Comments")) continue;
    const value = current[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        const itemNode = node(item);
        if (itemNode) walkWithAncestors(itemNode, next, visit);
      }
      continue;
    }
    const child = node(value);
    if (child) walkWithAncestors(child, next, visit);
  }
}

// -- gate 1: route-export lint ----------------------------------------------

const ROUTE_VALUE_EXPORTS = new Set(["Route"]);

type RouteExportFinding = {
  rel: string;
  line: number | undefined;
  name: string;
  kind: string;
};

const DECLARATION_KINDS: Record<string, string> = {
  FunctionDeclaration: "export function",
  ClassDeclaration: "export class",
  TSEnumDeclaration: "export enum",
  TSModuleDeclaration: "export namespace",
};

function collectRouteExports(rel: string, source: string): RouteExportFinding[] {
  const program = programOf(parseSource(rel, source));
  const findings: RouteExportFinding[] = [];
  for (const item of (program?.body as unknown[]) ?? []) {
    const statement = node(item);
    if (!statement) continue;
    const line = startLine(statement);
    if (statement.type === "ExportDefaultDeclaration") {
      findings.push({ rel, line, name: "default", kind: "export default" });
      continue;
    }
    if (statement.type === "ExportAllDeclaration") {
      findings.push({ rel, line, name: "*", kind: "export *" });
      continue;
    }
    if (statement.type !== "ExportNamedDeclaration") continue;
    const declaration = node(statement.declaration);
    if (declaration) {
      // Type-only declarations are erasures — no runtime export at all.
      if (
        declaration.type === "TSInterfaceDeclaration" ||
        declaration.type === "TSTypeAliasDeclaration"
      ) {
        continue;
      }
      if (declaration.type === "VariableDeclaration") {
        for (const declarator of (declaration.declarations as unknown[]) ?? []) {
          const name = identifierName(node(declarator)?.id);
          if (name && !ROUTE_VALUE_EXPORTS.has(name)) {
            findings.push({ rel, line, name, kind: "export const" });
          }
        }
        continue;
      }
      const kind = DECLARATION_KINDS[declaration.type] ?? "export declaration";
      const name = identifierName(declaration.id) ?? "<anonymous>";
      if (!ROUTE_VALUE_EXPORTS.has(name)) {
        findings.push({ rel, line, name, kind });
      }
      continue;
    }
    if (statement.exportKind === "type") continue;
    for (const specifier of (statement.specifiers as unknown[]) ?? []) {
      const spec = node(specifier);
      if (spec?.type !== "ExportSpecifier") continue;
      if (spec.exportKind === "type") continue;
      const exported = identifierName(spec.exported) ?? identifierName(spec.local);
      if (exported && !ROUTE_VALUE_EXPORTS.has(exported)) {
        findings.push({ rel, line, name: exported, kind: "export { … }" });
      }
    }
  }
  return findings;
}

// -- gate 2: t()-coverage heuristic ------------------------------------------

const JSX_TEXT_PROPS = new Set([
  "placeholder",
  "title",
  "label",
  "aria-label",
  "aria-description",
  "aria-placeholder",
  "alt",
  "emptyText",
]);
const CODE_ELEMENT_NAMES = new Set(["code", "pre", "kbd", "samp"]);

type JsxLiteral = {
  rel: string;
  line: number | undefined;
  text: string;
  where: string;
};

function elementName(element: AstNode | undefined): string | undefined {
  const nameNode = node(node(element?.openingElement)?.name);
  return nameNode?.type === "JSXIdentifier" ? (nameNode.name as string) : undefined;
}

/** Any className value (literal, template, or nested in cn(…)) hiding from sight. */
function classNameHidesFromSight(value: AstNode | undefined): boolean {
  if (!value) return false;
  if (value.type === "StringLiteral") return /\bsr-only\b/.test(String(value.value));
  if (value.type === "TemplateLiteral") {
    return ((value.quasis as unknown[]) ?? []).some((quasiItem) => {
      const cooked = (node(quasiItem)?.value as { cooked?: string } | undefined)?.cooked;
      return typeof cooked === "string" && /\bsr-only\b/.test(cooked);
    });
  }
  for (const key of Object.keys(value)) {
    if (key === "loc" || key === "type") continue;
    const child = value[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (classNameHidesFromSight(node(item))) return true;
      }
      continue;
    }
    if (classNameHidesFromSight(node(child))) return true;
  }
  return false;
}

function isSrOnlyElement(element: AstNode | undefined): boolean {
  const opening = node(element?.openingElement);
  for (const item of (opening?.attributes as unknown[]) ?? []) {
    const attr = node(item);
    const nameNode = attr?.type === "JSXAttribute" ? node(attr.name) : undefined;
    if (nameNode?.type !== "JSXIdentifier" || nameNode.name !== "className") continue;
    if (attr && classNameHidesFromSight(node(attr.value))) return true;
  }
  return false;
}

function insideCodeOrSrOnly(ancestors: AstNode[]): boolean {
  return ancestors.some(
    (ancestor) =>
      ancestor.type === "JSXElement" &&
      (CODE_ELEMENT_NAMES.has(elementName(ancestor) ?? "") || isSrOnlyElement(ancestor)),
  );
}

/**
 * Sentence-like copy test, precisely:
 *   - no ASCII letter (symbols/units/digits: "·", "—", "000000") → false;
 *   - contains `{` or `}` (expression fragments) → false;
 *   - ends in . , : ; ? ! → true (any lettered text);
 *   - at least 2 words AND a vowel → true;
 *   - exactly 1 word, length at least 2, with a vowel → true ("Beta"; "p",
 *     "SRT" stay false).
 */
function isSentenceLike(text: string): boolean {
  const trimmed = text.trim();
  if (!/[a-zA-Z]/.test(trimmed)) return false;
  if (trimmed.includes("{") || trimmed.includes("}")) return false;
  const collapsed = trimmed.replace(/\s+/g, " ");
  const wordCount = collapsed.split(" ").filter(Boolean).length;
  const hasVowel = /[aeiouAEIOU]/.test(collapsed);
  if (/[.,:;?!]$/.test(collapsed)) return true;
  if (wordCount >= 2) return hasVowel;
  return wordCount === 1 && hasVowel && trimmed.length >= 2;
}

function isJsxScanTarget(rel: string): boolean {
  if (rel.endsWith(".ts")) return !rel.endsWith(".test.ts") && !rel.endsWith(".spec.ts");
  if (rel.endsWith(".tsx")) return !rel.endsWith(".test.tsx") && !rel.endsWith(".spec.tsx");
  return false;
}

function collectJsxLiterals(rel: string, source: string): JsxLiteral[] {
  const literals: JsxLiteral[] = [];
  const program = programOf(parseSource(rel, source));
  if (!program) return literals;
  walkWithAncestors(program, [], (current, ancestors) => {
    if (current.type === "JSXText") {
      const text = String(current.value ?? "").trim();
      if (text && isSentenceLike(text) && !insideCodeOrSrOnly(ancestors)) {
        literals.push({ rel, line: startLine(current), text, where: "JSX text" });
      }
      return;
    }
    if (current.type === "JSXAttribute") {
      const nameNode = node(current.name);
      const attrName = nameNode?.type === "JSXIdentifier" ? (nameNode.name as string) : undefined;
      const value = node(current.value);
      if (attrName && JSX_TEXT_PROPS.has(attrName) && value?.type === "StringLiteral") {
        const text = String(value.value).trim();
        if (text && isSentenceLike(text) && !insideCodeOrSrOnly(ancestors)) {
          literals.push({ rel, line: startLine(current), text, where: attrName });
        }
      }
    }
  });
  return literals;
}

type AllowlistEntry = { path: string; text: string; reason: string };

function allowlistKey(path: string, text: string): string {
  return `${path} :: ${text}`;
}

function loadAllowlist(file = ALLOWLIST_FILE): { entries: AllowlistEntry[]; problems: string[] } {
  const problems: string[] = [];
  if (!existsSync(file)) {
    return {
      entries: [],
      problems: [`${ALLOWLIST_FILE_REL} is missing — create it (an empty list is valid)`],
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { entries: [], problems: [`${ALLOWLIST_FILE_REL} is not valid JSON`] };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { entries: [], problems: [`${ALLOWLIST_FILE_REL} must be a JSON object`] };
  }
  const record = parsed as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter((key) => key !== "jsxLiterals");
  if (unknownKeys.length > 0) {
    problems.push(`${ALLOWLIST_FILE_REL}: unknown key(s) ${unknownKeys.join(", ")}`);
  }
  const entries: AllowlistEntry[] = [];
  const seen = new Set<string>();
  for (const item of (record.jsxLiterals as unknown[]) ?? []) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      problems.push(`${ALLOWLIST_FILE_REL}: every jsxLiterals entry must be an object`);
      continue;
    }
    const entry = item as Record<string, unknown>;
    const path = typeof entry.path === "string" ? entry.path : undefined;
    const text = typeof entry.text === "string" ? entry.text : undefined;
    const reason = typeof entry.reason === "string" ? entry.reason : undefined;
    if (!path || !text || !reason || Object.keys(entry).length !== 3) {
      problems.push(
        `${ALLOWLIST_FILE_REL}: every jsxLiterals entry needs exactly the string fields path, text, reason`,
      );
      continue;
    }
    if (seen.has(allowlistKey(path, text))) {
      problems.push(`${ALLOWLIST_FILE_REL}: duplicate entry for ${allowlistKey(path, text)}`);
      continue;
    }
    seen.add(allowlistKey(path, text));
    entries.push({ path, text, reason });
  }
  return { entries, problems };
}

type JsxGateReport = { findings: string[]; staleAllowlist: string[] };

function evaluateJsxGate(
  files: Array<{ rel: string; source: string }>,
  entries: AllowlistEntry[],
): JsxGateReport {
  const allowed = new Set(entries.map((entry) => allowlistKey(entry.path, entry.text)));
  const findings: string[] = [];
  const matched = new Set<string>();
  for (const file of files) {
    for (const literal of collectJsxLiterals(file.rel, file.source)) {
      const key = allowlistKey(literal.rel, literal.text);
      if (allowed.has(key)) {
        matched.add(key);
        continue;
      }
      findings.push(
        `${literal.rel}:${literal.line ?? "?"} hardcoded ${literal.where} copy ${JSON.stringify(
          literal.text.slice(0, 90),
        )} — route it through t(), or add a reviewed, reasoned entry to ${ALLOWLIST_FILE_REL} (AGENTS.md § Internationalization)`,
      );
    }
  }
  const staleAllowlist = entries
    .filter((entry) => !matched.has(allowlistKey(entry.path, entry.text)))
    .map(
      (entry) =>
        `${ALLOWLIST_FILE_REL} entry ${allowlistKey(entry.path, entry.text)} matches no current literal — remove it (the allowlist only shrinks)`,
    );
  return { findings, staleAllowlist };
}

// -- gate 3: sitemap sync -----------------------------------------------------

function parsePublicPaths(seoSource: string): string[] | undefined {
  const declStart = seoSource.indexOf("export const PUBLIC_PATHS");
  if (declStart === -1) return undefined;
  const close = seoSource.indexOf("];", declStart);
  if (close === -1) return undefined;
  const paths = [...seoSource.slice(declStart, close).matchAll(/path:\s*"([^"]*)"/g)].map(
    (match) => match[1] ?? "",
  );
  return paths.length > 0 ? paths : undefined;
}

function sitemapNotation(path: string): string {
  return path === "" ? "`/{lang}/`" : "`/{lang}" + path + "`";
}

function checkSitemapSync(seoSource: string, sitemapSource: string): string[] {
  const paths = parsePublicPaths(seoSource);
  if (!paths) {
    return [
      `${SEO_FILE_REL} — could not read any \`path: "…"\` entries from the PUBLIC_PATHS array; the sitemap-sync gate refuses a silent pass`,
    ];
  }
  const failures: string[] = [];
  for (const path of paths) {
    if (!sitemapSource.includes(sitemapNotation(path))) {
      failures.push(
        `${SEO_FILE_REL} PUBLIC_PATHS entry ${JSON.stringify(path)} is missing from ${SITEMAP_FILE_REL} (expected the notation ${sitemapNotation(
          path,
        )} in the Public Routes table) — update sitemap.md in the same change (AGENTS.md § SEO discoverability files)`,
      );
    }
  }
  return failures;
}

// -- file walking -------------------------------------------------------------

function listSourceFiles(dir: string, keep: (rel: string) => boolean): string[] {
  const files: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const abs = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        stack.push(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = relative(ROOT, abs);
      if (keep(rel)) files.push(abs);
    }
  }
  return files.sort();
}

// -- main ---------------------------------------------------------------------

function main(): void {
  const failures: string[] = [];

  // Gate 1: route files export only `Route`.
  for (const file of listSourceFiles(ROUTES_DIR, (rel) => /\.[jt]sx?$/.test(rel))) {
    const rel = relative(ROOT, file);
    try {
      for (const finding of collectRouteExports(rel, readFileSync(file, "utf8"))) {
        failures.push(
          `${finding.rel}:${finding.line ?? "?"} exports \`${finding.name}\` (\`${finding.kind}\`) — route files may only export \`Route\` (plus type exports); move components/helpers to apps/web/src/components and import them (AGENTS.md § React and AGENTS.md § Performance)`,
        );
      }
    } catch (error) {
      failures.push((error as Error).message);
    }
  }

  // Gate 2: no NEW hardcoded user-facing JSX copy.
  const allowlist = loadAllowlist();
  failures.push(...allowlist.problems);
  const jsxFiles = JSX_SCAN_DIRS.flatMap((dir) =>
    listSourceFiles(dir, isJsxScanTarget).map((file) => ({
      rel: relative(ROOT, file),
      source: readFileSync(file, "utf8"),
    })),
  );
  const jsxReport = evaluateJsxGate(jsxFiles, allowlist.entries);
  failures.push(...jsxReport.findings, ...jsxReport.staleAllowlist);

  // Gate 3: sitemap.md mirrors PUBLIC_PATHS.
  for (const [file, rel] of [
    [SEO_FILE, SEO_FILE_REL],
    [SITEMAP_FILE, SITEMAP_FILE_REL],
    [ALLOWLIST_FILE, ALLOWLIST_FILE_REL],
  ] as const) {
    if (!existsSync(file)) {
      failures.push(`${rel} is missing — the agent-rules gate fails closed without it`);
    }
  }
  if (existsSync(SEO_FILE) && existsSync(SITEMAP_FILE)) {
    failures.push(
      ...checkSitemapSync(readFileSync(SEO_FILE, "utf8"), readFileSync(SITEMAP_FILE, "utf8")),
    );
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`POLICY VIOLATION: ${failure}`);
    }
    process.exit(1);
  }
  console.log(
    "agent rules passed: route exports clean, JSX literal gate clean, sitemap.md in sync with PUBLIC_PATHS.",
  );
}

// -- self-test ----------------------------------------------------------------

let failures = 0;

function check(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  ok   ${label}`);
    return;
  }
  failures += 1;
  console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
}

const FIXTURE_ROUTE_CLEAN = [
  'import { createFileRoute } from "@tanstack/react-router";',
  'export const Route = createFileRoute("/$lang/thing")({ component: Thing });',
  "function Thing() { return null; }",
].join("\n");

const FIXTURE_ROUTE_VIOLATION = [
  'import { createFileRoute } from "@tanstack/react-router";',
  'export const Route = createFileRoute("/$lang/thing")({ component: Thing });',
  "export function HeroBadge() { return null; }",
  "function Thing() { return null; }",
].join("\n");

const FIXTURE_JSX_CLEAN = [
  'import { useTranslation } from "react-i18next";',
  "function Clean() {",
  "  const { t } = useTranslation();",
  "  return (",
  '    <div aria-label={t("a11y.close")}>',
  '      <p>{t("greeting.hello")}</p>',
  '      <input placeholder={t("form.name")} />',
  "      <span>·</span>",
  '      <code>assetRef.safeParse("01hxyz") is safe.</code>',
  '      <span className="sr-only">Loading content, please wait.</span>',
  "    </div>",
  "  );",
  "}",
].join("\n");

const FIXTURE_JSX_VIOLATION = [
  "function Bad() {",
  "  return (",
  "    <section>",
  "      <p>Your session ended.</p>",
  '      <input placeholder="Enter your name" />',
  '      <button type="button">Beta</button>',
  "    </section>",
  "  );",
  "}",
].join("\n");

const FIXTURE_JSX_EXEMPT = [
  "<div>",
  "<pre>run `pnpm db:migrate:apply` to apply.</pre>",
  '<span className="flex sr-only items-center">Screen reader intro text.</span>',
  '<span className={cn("x", cond && "sr-only")}>Dynamic sr-only label here.</span>',
  "</div>",
].join("\n");

function runSelfTest(): void {
  console.log("== agent-rules self-test ==");

  console.log("-- gate 1: route-export lint --");
  check(
    "route file exporting only Route passes",
    collectRouteExports("clean.tsx", FIXTURE_ROUTE_CLEAN).length === 0,
  );
  const violation = collectRouteExports("violation.tsx", FIXTURE_ROUTE_VIOLATION);
  check(
    "route file exporting a component is caught",
    violation.length === 1 && violation[0]?.name === "HeroBadge",
    JSON.stringify(violation),
  );
  check(
    "multi-declarator export const Route = …, helper = … is caught",
    collectRouteExports("multi.tsx", "export const Route = 1, helper = 2;").some(
      (finding) => finding.name === "helper",
    ),
  );
  check(
    "export default in a route file is caught",
    collectRouteExports("default.tsx", "export default function Page() {}").some(
      (finding) => finding.name === "default",
    ),
  );
  check(
    "export * in a route file is caught",
    collectRouteExports("star.ts", 'export * from "../components/hero";').some(
      (finding) => finding.kind === "export *",
    ),
  );
  check(
    "type-only exports are allowed",
    collectRouteExports(
      "types.ts",
      [
        "export interface RouterAppContext { orpc: unknown }",
        "export type Ctx = { x: 1 };",
        "export type { Ctx as Alias };",
      ].join("\n"),
    ).length === 0,
  );
  check(
    "a value re-export other than Route is caught",
    collectRouteExports("reexport.ts", "const helper = () => null;\nexport { helper };").some(
      (finding) => finding.name === "helper",
    ),
  );
  let parseThrew = false;
  try {
    collectRouteExports("broken.tsx", "export const Route = {{{");
  } catch {
    parseThrew = true;
  }
  check("an unparsable route file fails closed", parseThrew);

  console.log("-- gate 2: t()-coverage heuristic --");
  check(
    "non-copy tokens pass",
    ["·", "—", "/", "000000", "KB", "SRT", "kbps", "p", "50%"].every(
      (text) => !isSentenceLike(text),
    ),
  );
  check(
    "sentence-like copy is detected",
    isSentenceLike("Your session ended.") &&
      isSentenceLike("Enter your name") &&
      isSentenceLike("Beta") &&
      isSentenceLike("Ready:") &&
      isSentenceLike("WebVTT") &&
      isSentenceLike("AI v2"),
  );
  check(
    "test/spec files are not scan targets",
    !isJsxScanTarget("apps/web/src/components/x.test.tsx") &&
      !isJsxScanTarget("apps/web/src/components/x.spec.tsx") &&
      !isJsxScanTarget("apps/web/src/components/x.test.ts") &&
      isJsxScanTarget("apps/web/src/components/x.tsx") &&
      isJsxScanTarget("apps/web/src/components/x.tsx"),
  );
  check(
    "a component using t() everywhere passes",
    collectJsxLiterals("apps/web/src/components/clean.tsx", FIXTURE_JSX_CLEAN).length === 0,
    JSON.stringify(collectJsxLiterals("apps/web/src/components/clean.tsx", FIXTURE_JSX_CLEAN)),
  );
  const jsxFindings = collectJsxLiterals(
    "apps/web/src/routes/$lang/bad.tsx",
    FIXTURE_JSX_VIOLATION,
  );
  check(
    'hardcoded JSX copy is caught (text "Your session ended.", placeholder, single-word label)',
    jsxFindings.length === 3 &&
      jsxFindings.some((finding) => finding.text === "Your session ended.") &&
      jsxFindings.some((finding) => finding.where === "placeholder") &&
      jsxFindings.some((finding) => finding.text === "Beta"),
    JSON.stringify(jsxFindings),
  );
  check(
    "sr-only and code-element children are exempt",
    collectJsxLiterals("apps/web/src/components/exempt.tsx", FIXTURE_JSX_EXEMPT).length === 0,
    JSON.stringify(collectJsxLiterals("apps/web/src/components/exempt.tsx", FIXTURE_JSX_EXEMPT)),
  );
  const gateFiles = [
    { rel: "apps/web/src/components/bad.tsx", source: FIXTURE_JSX_VIOLATION },
    { rel: "apps/web/src/components/clean.tsx", source: FIXTURE_JSX_CLEAN },
  ];
  const gate = evaluateJsxGate(gateFiles, [
    { path: "apps/web/src/components/bad.tsx", text: "Beta", reason: "fixture" },
  ]);
  check(
    "an allowlist entry suppresses exactly its literal",
    gate.findings.length === 2 && gate.staleAllowlist.length === 0,
    JSON.stringify(gate),
  );
  const stale = evaluateJsxGate(gateFiles, [
    { path: "apps/web/src/components/gone.tsx", text: "Removed", reason: "fixture" },
  ]);
  check(
    "a stale allowlist entry fails so the list only shrinks",
    stale.staleAllowlist.length === 1 && stale.findings.length === 3,
    JSON.stringify(stale),
  );

  const allowlistDir = mkdtempSync(join(tmpdir(), "agent-rules-allowlist-"));
  try {
    const badJson = join(allowlistDir, "bad.json");
    writeFileSync(badJson, "{not json", "utf8");
    check("an unparsable allowlist fails closed", loadAllowlist(badJson).problems.length > 0);
    const missingReason = join(allowlistDir, "reason.json");
    writeFileSync(
      missingReason,
      JSON.stringify({ jsxLiterals: [{ path: "a.tsx", text: "Hi there." }] }),
      "utf8",
    );
    check(
      "an allowlist entry without a reason fails",
      loadAllowlist(missingReason).problems.length > 0,
    );
  } finally {
    rmSync(allowlistDir, { recursive: true, force: true });
  }

  console.log("-- gate 3: sitemap sync --");
  check(
    "the current PUBLIC_PATHS / sitemap.md pair is in sync",
    checkSitemapSync(readFileSync(SEO_FILE, "utf8"), readFileSync(SITEMAP_FILE, "utf8")).length ===
      0,
  );
  check(
    "a PUBLIC_PATHS entry missing from sitemap.md is caught",
    checkSitemapSync(
      'export const PUBLIC_PATHS: PublicPath[] = [\n  { path: "", title: "Home" },\n  { path: "/pricing", title: "Pricing" },\n];',
      "| `/{lang}/` | Home |",
    ).some((failure) => failure.includes('"/pricing"') && failure.includes("`/{lang}/pricing`")),
  );
  check(
    "the locale-root path maps to the /{lang}/ notation",
    sitemapNotation("") === "`/{lang}/`" && sitemapNotation("/about") === "`/{lang}/about`",
  );
  check(
    "an unreadable PUBLIC_PATHS array fails closed",
    checkSitemapSync("export const PUBLIC_PATHS = [];", "").length === 1,
  );

  if (failures > 0) {
    console.error(`agent-rules self-test FAILED (${failures} failing check(s)).`);
    process.exit(1);
  }
  console.log("agent-rules self-test passed.");
}

if (process.argv[2] === "--self-test") {
  runSelfTest();
} else {
  main();
}
