/**
 * The server opens SQLite index files only read-only, through one helper (decisions 5 + 21).
 *
 * No data-flow tracking: outside the two allowlisted modules, any server-reachable file that so
 * much as *names* the native loader module, `better-sqlite3`, `sqlite-vec` or `loadSqlite` is a
 * violation, whatever the import form or binding names. The single constructor call in
 * `reader.ts` must use an exact literal options object; `openIndexReadOnly` additionally refuses
 * any handle whose `readonly` flag is not set (runtime enforcement, reader.test.ts).
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const { parse } = createRequire(import.meta.url)("@babel/parser") as typeof import("@babel/parser");

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const INDEX_FILE = "packages/api/src/lib/kb/index-file";
const SQLITE_MODULE = `${INDEX_FILE}/sqlite.ts`;
const READER_MODULE = `${INDEX_FILE}/reader.ts`;
/** The only server-reachable files allowed to name the loader, the native packages or the factory. */
const ALLOWED = new Set([SQLITE_MODULE, READER_MODULE]);
const FORBIDDEN_MODULES = [`${INDEX_FILE}/writer.ts`, "packages/api/src/lib/kb/index-build.ts"];
// Spelled in parts so this file does not trip the repo-wide scans below.
const NODE_SQLITE = ["node", "sqlite"].join(":");
const BANNED_STRINGS = new Set(["better-sqlite3", "sqlite-vec", "loadSqlite"]);
const LOADER_SPECIFIER = /(^|\/)index-file\/sqlite(\.[cm]?[jt]sx?)?$/;
const ENTRIES = [
  "apps/server/src/bootstrap.ts",
  "apps/server/src/git-pre-receive.ts",
  "apps/server/src/kb-index-reader.ts",
];
const MAIN_ENTRIES = ENTRIES.slice(0, 2);
const SHAPE =
  "must open with exactly { readonly: true, fileMustExist: true } (literal, no spread, no variables, no duplicates)";

type Node = { type: string; [key: string]: unknown };
type ModuleInfo = {
  /** Repo-relative workspace files this one can load (static, dynamic or require-style). */
  imports: string[];
  /** Every string literal value and template-literal text in the file. */
  strings: string[];
  /** Whether an identifier named `loadSqlite` occurs anywhere. */
  namesFactory: boolean;
  ast: Node;
};

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && typeof (value as Node).type === "string";
}

function walkAst(node: unknown, visit: (node: Node) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) walkAst(child, visit);
    return;
  }
  if (!isNode(node)) return;
  visit(node);
  for (const [key, child] of Object.entries(node)) {
    if (key === "loc" || key === "start" || key === "end" || key === "extra") continue;
    if (typeof child === "object" && child !== null) walkAst(child, visit);
  }
}

function workspaceExport(specifier: string): string | null {
  const match = /^@knowledge-base\/([^/]+)(\/.*)?$/.exec(specifier);
  if (!match) return null;
  const pkgDir = join(ROOT, "packages", match[1]!);
  const manifest = join(pkgDir, "package.json");
  if (!existsSync(manifest)) return null;
  const exportsMap =
    (JSON.parse(readFileSync(manifest, "utf8")) as { exports?: Record<string, unknown> }).exports ??
    {};
  const key = `.${match[2] ?? ""}`;
  const target = (value: unknown): string | null =>
    typeof value === "string"
      ? value
      : typeof value === "object" && value !== null
        ? ((value as { default?: string }).default ?? null)
        : null;
  if (key in exportsMap) {
    const found = target(exportsMap[key]);
    return found ? join(pkgDir, found) : null;
  }
  for (const [pattern, value] of Object.entries(exportsMap)) {
    if (!pattern.endsWith("/*") || !key.startsWith(pattern.slice(0, -1))) continue;
    const found = target(value);
    if (found) return join(pkgDir, found.replace("*", key.slice(pattern.length - 1)));
  }
  return null;
}

function resolveFile(base: string): string | null {
  const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")];
  if (/\.(m?js)$/.test(base)) candidates.push(base.replace(/\.m?js$/, ".ts"));
  for (const candidate of candidates)
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  return null;
}

/** The repo-relative workspace source a specifier written in `file` resolves to, else null. */
function resolveSpecifier(file: string, specifier: string): string | null {
  const base = specifier.startsWith(".")
    ? resolve(dirname(file), specifier)
    : workspaceExport(specifier);
  const target = base ? resolveFile(base) : null;
  return target && /\.(c|m)?[jt]sx?$/.test(target) ? relative(ROOT, target) : null;
}

/** `new URL("<string naming a declared entry>", import.meta.url)`. */
function isWorkerEntryUrl(file: string, node: Node): boolean {
  if (node.type !== "NewExpression") return false;
  const callee = node.callee as Node | undefined;
  const args = (node.arguments as Node[] | undefined) ?? [];
  if (callee?.type !== "Identifier" || callee.name !== "URL" || args.length !== 2) return false;
  const [specifier, base] = args as [Node, Node];
  const meta = base.object as Node | undefined;
  const property = base.property as Node | undefined;
  if (
    specifier.type !== "StringLiteral" ||
    base.type !== "MemberExpression" ||
    meta?.type !== "MetaProperty" ||
    property?.type !== "Identifier" ||
    property.name !== "url"
  )
    return false;
  const target = resolveSpecifier(file, specifier.value as string);
  return target !== null && ENTRIES.includes(target);
}

const analyzed = new Map<string, ModuleInfo>();

/** Parses each file once per run. */
function analyze(file: string): ModuleInfo {
  const cached = analyzed.get(file);
  if (cached) return cached;
  const ast = parse(readFileSync(file, "utf8"), {
    sourceType: "module",
    // Babel 8 parses import attributes by default; there is no plugin for it.
    plugins: ["typescript", ...(extname(file) === ".tsx" ? (["jsx"] as const) : [])],
  }).program as unknown as Node;
  const strings: string[] = [];
  const edges = new Set<string>();
  let namesFactory = false;
  // The specifier of a type-only import/re-export is erased at build time: it is neither an
  // edge nor a string that could load anything (the declaration is visited before its source).
  const erased = new WeakSet<Node>();
  walkAst(ast, (node) => {
    if (node.type === "StringLiteral") {
      if (!erased.has(node)) strings.push(node.value as string);
    } else if (node.type === "TemplateLiteral")
      strings.push(
        ((node.quasis as Node[]) ?? [])
          .map((quasi) => (quasi.value as { cooked?: string }).cooked ?? "")
          .join(""),
      );
    else if (node.type === "Identifier" && node.name === "loadSqlite") namesFactory = true;
    // Only `new URL("<declared entry>", import.meta.url)` — a worker-thread entry, built and
    // checked as its own entry — is not a load of that entry. Dynamic import, require and any
    // other use of the same specifier still are.
    else if (isWorkerEntryUrl(file, node)) erased.add((node.arguments as Node[])[0]!);
    // Type-only imports and re-exports load nothing at run time.
    if (
      (node.type === "ImportDeclaration" ||
        node.type === "ExportNamedDeclaration" ||
        node.type === "ExportAllDeclaration") &&
      isNode(node.source)
    ) {
      const specs = (node.specifiers as Node[] | undefined) ?? [];
      const typeOnly =
        node.importKind === "type" ||
        node.exportKind === "type" ||
        (node.type === "ImportDeclaration" &&
          specs.length > 0 &&
          specs.every((spec) => spec.importKind === "type"));
      if (typeOnly) erased.add(node.source);
      const target = typeOnly ? null : resolveSpecifier(file, node.source.value as string);
      if (target) edges.add(target);
    }
  });
  // Any other string that resolves to a workspace source (dynamic import, require,
  // createRequire, ...) is a possible runtime load: follow it.
  for (const value of strings)
    if (value.startsWith(".") || value.startsWith("@knowledge-base/")) {
      const target = resolveSpecifier(file, value);
      if (target) edges.add(target);
    }
  const info = { imports: [...edges], strings, namesFactory, ast };
  analyzed.set(file, info);
  return info;
}

type Reach = { modules: Map<string, ModuleInfo>; parents: Map<string, string> };

function reachable(entries: readonly string[]): Reach {
  const modules = new Map<string, ModuleInfo>();
  const parents = new Map<string, string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (modules.has(current)) continue;
    const info = analyze(join(ROOT, current));
    modules.set(current, info);
    for (const next of info.imports)
      if (!modules.has(next)) {
        if (!parents.has(next)) parents.set(next, current);
        queue.push(next);
      }
  }
  return { modules, parents };
}

function chain(reach: Reach, module: string): string {
  const path = [module];
  for (let at = reach.parents.get(module); at; at = reach.parents.get(at)) path.unshift(at);
  return path.join(" -> ");
}

function namesLoader(module: string, value: string): boolean {
  if (LOADER_SPECIFIER.test(value)) return true;
  return (
    (value.startsWith(".") || value.startsWith("@knowledge-base/")) &&
    resolveSpecifier(join(ROOT, module), value) === SQLITE_MODULE
  );
}

/** The one construction in the reader: `new Database(path, { readonly: true, fileMustExist: true })`. */
function readerShapeProblems(readerModule: string): string[] {
  const { ast } = analyze(join(ROOT, readerModule));
  const problems: string[] = [];
  const news: Node[] = [];
  const bindings: Node[] = [];
  walkAst(ast, (node) => {
    if (node.type === "NewExpression" && isNode(node.callee) && node.callee.name === "Database")
      news.push(node);
    if (node.type === "VariableDeclarator" && isNode(node.id) && node.id.name === "Database")
      bindings.push(node);
  });
  const init = bindings[0]?.init as Node | undefined;
  if (
    bindings.length !== 1 ||
    init?.type !== "CallExpression" ||
    (init.callee as Node).name !== "loadSqlite" ||
    (init.arguments as Node[]).length !== 0
  )
    problems.push(`${readerModule} must bind Database once, as loadSqlite()`);
  if (news.length !== 1) problems.push(`${readerModule} must construct exactly one database`);
  for (const construction of news) {
    const args = construction.arguments as Node[];
    const options = args[1];
    const properties = options?.type === "ObjectExpression" ? (options.properties as Node[]) : [];
    const exact =
      args.length === 2 &&
      properties.length === 2 &&
      properties.every(
        (property) =>
          property.type === "ObjectProperty" &&
          property.computed === false &&
          property.shorthand === false &&
          isNode(property.key) &&
          property.key.type === "Identifier" &&
          isNode(property.value) &&
          property.value.type === "BooleanLiteral" &&
          property.value.value === true,
      ) &&
      properties
        .map((property) => (property.key as Node).name as string)
        .sort()
        .join(",") === "fileMustExist,readonly";
    if (!exact) problems.push(`${readerModule} ${SHAPE}`);
  }
  return problems;
}

/** Every policy violation for these entries (empty = compliant). */
function violations(
  entries: readonly string[],
  mainEntries: readonly string[],
  readerModule = READER_MODULE,
): string[] {
  const reach = reachable(entries);
  const allowed = new Set([...ALLOWED, readerModule]);
  const problems: string[] = [];
  for (const [module, info] of reach.modules) {
    if (FORBIDDEN_MODULES.includes(module))
      problems.push(`server reaches ${module}: ${chain(reach, module)}`);
    if (info.strings.includes(NODE_SQLITE)) problems.push(`${module} names ${NODE_SQLITE}`);
    if (allowed.has(module)) continue;
    for (const value of info.strings) {
      if (BANNED_STRINGS.has(value)) problems.push(`${module} names "${value}"`);
      else if (namesLoader(module, value))
        problems.push(`${module} names the sqlite loader module`);
    }
    if (info.namesFactory) problems.push(`${module} names loadSqlite`);
  }
  const mainReach = reachable(mainEntries);
  if (mainReach.modules.has(SQLITE_MODULE))
    problems.push(
      `a main server entry reaches ${SQLITE_MODULE}: ${chain(mainReach, SQLITE_MODULE)}`,
    );
  problems.push(...readerShapeProblems(readerModule));
  return problems;
}

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** A throwaway module inside the repo tree so relative and workspace specifiers resolve. */
function fixtureModule(name: string, source: string): string {
  const dir = mkdtempSync(join(ROOT, "apps/server/src/.index-policy-"));
  scratch.push(dir);
  const file = join(dir, name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, source);
  return relative(ROOT, file);
}

const LOADER = "../../../../packages/api/src/lib/kb/index-file/sqlite";

describe("index file policy (server)", () => {
  it("server entries reach index files only through the read-only helper", () => {
    expect(violations(ENTRIES, MAIN_ENTRIES)).toEqual([]);
    const reach = reachable(ENTRIES);
    // The walk is not vacuous: the thread entry reaches the reader and the loader.
    expect(reach.modules.has(READER_MODULE)).toBe(true);
    expect(reach.modules.get(SQLITE_MODULE)?.strings).toEqual(
      expect.arrayContaining(["better-sqlite3", "sqlite-vec"]),
    );
    expect(reach.modules.size).toBeGreaterThan(100);
  }, 60_000);

  it("reports a module that imports the writer", () => {
    const writerImport = fixtureModule(
      "uses-writer.ts",
      `import "@knowledge-base/api/lib/kb/index-file/reader-thread";\nimport "../../../../packages/api/src/lib/kb/index-file/writer";\n`,
    );
    expect(violations([writerImport], [])).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/server reaches packages\/api\/src\/lib\/kb\/index-file\/writer\.ts/),
      ]),
    );
  });

  it("exempts only the worker-entry URL: dynamic import or require of the reader entry is a load", () => {
    const entry = "../kb-index-reader.ts";
    const loads: Record<string, string> = {
      "dyn-import-entry.ts": `export const load = () => import("${entry}");\n`,
      "require-entry.ts": `import { createRequire } from "node:module";\nconst load = createRequire(import.meta.url);\nexport const thread = () => load("${entry}");\n`,
      "url-other-base.ts": `export const url = new URL("${entry}", "file:///elsewhere/");\nexport const load = () => import(url.href);\n`,
    };
    for (const [name, source] of Object.entries(loads)) {
      const module = fixtureModule(name, source);
      expect(violations([module], [module]), name).toEqual(
        expect.arrayContaining([
          expect.stringMatching(
            /main server entry reaches packages\/api\/src\/lib\/kb\/index-file\/sqlite\.ts/,
          ),
        ]),
      );
    }
    // Positive control: the worker-thread construction kb-runtime.ts uses is not a load.
    const url = fixtureModule(
      "worker-url.ts",
      `export const entry = new URL("${entry}", import.meta.url);\n`,
    );
    expect(violations([url], [url])).toEqual([]);
  });

  it("reports reader copies whose constructor options are not the exact literal", () => {
    const original = readFileSync(join(ROOT, READER_MODULE), "utf8");
    const call = "new Database(path, { readonly: true, fileMustExist: true })";
    expect(original).toContain(call);
    for (const [name, replacement] of [
      ["no-readonly.ts", "new Database(path, { fileMustExist: true })"],
      // (b) a later spread overrides the flag; the native constructor would open read-write.
      [
        "spread-override.ts",
        "new Database(path, { readonly: true, fileMustExist: true, ...{ readonly: false } })",
      ],
      [
        "duplicate-key.ts",
        "new Database(path, { readonly: true, fileMustExist: true, readonly: true })",
      ],
      ["variable.ts", "new Database(path, { readonly: READONLY, fileMustExist: true })"],
      ["computed.ts", 'new Database(path, { ["readonly"]: true, fileMustExist: true })'],
      ["options-variable.ts", "new Database(path, OPTIONS)"],
      [
        "extra-option.ts",
        "new Database(path, { readonly: true, fileMustExist: true, timeout: 1 })",
      ],
    ] as const) {
      const copy = fixtureModule(name, original.replace(call, replacement));
      expect(violations([copy], [], copy), name).toContain(`${copy} ${SHAPE}`);
    }
  });

  it("reports any server-reachable file that names the loader, the native packages or the factory", () => {
    const forms: Record<string, string> = {
      "static-named.ts": `import { loadSqlite } from "${LOADER}";\nconst Sqlite = loadSqlite();\nexport const open = (p: string) => new Sqlite(p);\n`,
      "static-namespace.ts": `import * as native from "${LOADER}";\nexport const open = (p: string) => new (native.loadSqlite())(p);\n`,
      "static-renamed.ts": `import { loadSqlite as make } from "${LOADER}.ts";\nexport const open = (p: string) => new (make())(p);\n`,
      "dyn-destructured.ts": `export async function open(p: string) {\n  const { loadSqlite: make } = await import("${LOADER}");\n  const Native = make();\n  return new Native(p);\n}\n`,
      "dyn-computed.ts": `export async function open(p: string) {\n  const ns = await import("${LOADER}");\n  return new (ns["load" + "Sqlite"]())(p);\n}\n`,
      "dyn-template.ts":
        "export const load = () => import(`../../../../packages/api/src/lib/kb/index-file/sqlite`);\n",
      "workspace-specifier.ts": `export const load = () => import("@knowledge-base/api/lib/kb/index-file/sqlite");\n`,
      // (a) createRequire bound to a variable, then a literal loader path.
      "create-require-alias.ts": `import { createRequire } from "node:module";\nconst load = createRequire(import.meta.url);\nexport const open = (p: string) => new (load("${LOADER}").loadSqlite())(p);\n`,
      "native-package.ts": `import { createRequire } from "node:module";\nconst load = createRequire(import.meta.url);\nexport const open = (p: string) => new (load("better-sqlite3"))(p);\n`,
      "native-vec.ts": `export const vec = () => import("sqlite-vec");\n`,
      "built-in.ts": `import "${NODE_SQLITE}";\n`,
    };
    for (const [name, source] of Object.entries(forms)) {
      const module = fixtureModule(name, source);
      const found = violations([module], []);
      expect(
        found.filter((problem) => problem.startsWith(`${module} names`)),
        name,
      ).not.toEqual([]);
    }
  });

  it(`${["node", "sqlite"].join(" ")} built-in is banned in app and package sources`, () => {
    const roots = [
      "apps/server/src",
      "apps/worker/src",
      "apps/web/src",
      ...readdirSync(join(ROOT, "packages")).map((pkg) => `packages/${pkg}/src`),
    ];
    const hits: string[] = [];
    const scan = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "node_modules" && !entry.name.startsWith(".index-policy-")) scan(path);
        } else if (
          /\.(c|m)?[jt]sx?$/.test(entry.name) &&
          readFileSync(path, "utf8").includes(NODE_SQLITE)
        ) {
          hits.push(relative(ROOT, path));
        }
      }
    };
    for (const root of roots) scan(join(ROOT, root));
    expect(hits).toEqual([]);
  });
});
