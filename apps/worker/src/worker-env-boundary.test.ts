import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "@babel/parser";
import { describe, expect, it } from "vitest";

// The dedicated worker validates only `@knowledge-base/env/shared`; it has no
// BETTER_AUTH_*, admin or other server-only variable (the generated Compose
// gives it none). `@knowledge-base/env/server` validates those at import, so
// any module on the worker's graph that reaches it — even behind a lazy
// `import()` in a job handler — fails that job (or boot) on every run.
//
// Two guards: a static walk of the worker's whole module graph (static and
// string-literal dynamic imports, type-only imports skipped) from the built
// entry, and a child process with ONLY the worker's environment importing
// every module the walk found.

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const ENTRY = join(ROOT, "apps/worker/src/bootstrap.ts");
const SERVER_ENV = join(ROOT, "packages/env/src/server.ts");

type Manifest = { dir: string; exports?: Record<string, unknown>; main?: string };
const workspaces = new Map<string, Manifest>();
for (const group of ["apps", "packages"])
  for (const name of readdirSync(join(ROOT, group))) {
    const file = join(ROOT, group, name, "package.json");
    if (!existsSync(file)) continue;
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    workspaces.set(manifest.name, { dir: dirname(file), ...manifest });
  }

function asFile(path: string): string | undefined {
  for (const candidate of [
    path,
    path.replace(/\.js$/, ".ts"),
    `${path}.ts`,
    `${path}.tsx`,
    join(path, "index.ts"),
  ])
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  return undefined;
}

function exportTarget(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "default" in value)
    return exportTarget((value as { default: unknown }).default);
  return undefined;
}

/** A workspace file, null for a third-party/builtin module. Throws when a
 * workspace specifier does not resolve, so the walk never silently stops. */
function resolveImport(specifier: string, from: string): string | null {
  if (specifier.startsWith(".")) {
    const file = asFile(resolve(dirname(from), specifier));
    if (!file) throw new Error(`Unresolved ${specifier} from ${relative(ROOT, from)}`);
    return file;
  }
  const match = /^(@[^/]+\/[^/]+|[^@/][^/]*)(\/.*)?$/.exec(specifier);
  const manifest = match?.[1] ? workspaces.get(match[1]) : undefined;
  if (!match || !manifest) return null;
  const subpath = `.${match[2] ?? ""}`;
  let target = exportTarget(manifest.exports?.[subpath]);
  for (const [key, value] of Object.entries(manifest.exports ?? {}))
    if (!target && key.endsWith("/*") && subpath.startsWith(key.slice(0, -1)))
      target = exportTarget(value)?.replace("*", subpath.slice(key.length - 1));
  if (!target && subpath === "." && !manifest.exports) target = manifest.main;
  const file = target ? asFile(resolve(manifest.dir, target)) : undefined;
  if (!file) throw new Error(`Unresolved ${specifier} from ${relative(ROOT, from)}`);
  return file;
}

type AstNode = { type: string; [key: string]: unknown };
function runtimeImports(file: string): string[] {
  const ast = parse(readFileSync(file, "utf8"), {
    sourceType: "module",
    plugins: file.endsWith(".tsx") ? ["typescript", "jsx"] : ["typescript"],
  });
  const found: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    const node = value as AstNode;
    const source = node.source as { type?: string; value?: string } | undefined;
    if (
      (node.type === "ImportDeclaration" ||
        node.type === "ExportNamedDeclaration" ||
        node.type === "ExportAllDeclaration") &&
      typeof source?.value === "string"
    ) {
      const specifiers = (node.specifiers ?? []) as { importKind?: string; exportKind?: string }[];
      const typeOnly =
        node.importKind === "type" ||
        node.exportKind === "type" ||
        (specifiers.length > 0 &&
          specifiers.every((s) => s.importKind === "type" || s.exportKind === "type"));
      if (!typeOnly) found.push(source.value);
    }
    if (node.type === "ImportExpression" && source?.type === "StringLiteral" && source.value)
      found.push(source.value);
    for (const [key, child] of Object.entries(node))
      if (key !== "loc" && key !== "start" && key !== "end") visit(child);
  };
  visit(ast.program);
  return found;
}

/** Every workspace module reachable from `entry`, with the first importer of each. */
function moduleGraph(entry: string): Map<string, string | null> {
  const parents = new Map<string, string | null>([[entry, null]]);
  const queue = [entry];
  for (let file = queue.shift(); file; file = queue.shift()) {
    if (!/\.tsx?$/.test(file)) continue;
    for (const specifier of runtimeImports(file)) {
      const target = resolveImport(specifier, file);
      if (target && !parents.has(target)) {
        parents.set(target, file);
        queue.push(target);
      }
    }
  }
  return parents;
}

function chain(graph: Map<string, string | null>, file: string): string {
  const path: string[] = [];
  for (let at: string | null | undefined = file; at; at = graph.get(at))
    path.unshift(relative(ROOT, at));
  return path.join("\n  -> ");
}

describe("worker environment boundary", () => {
  const graph = moduleGraph(ENTRY);

  it("never reaches @knowledge-base/env/server from the worker entry", () => {
    // Not vacuous: the walk follows the lazy handler imports.
    expect(graph.has(join(ROOT, "apps/worker/src/runtime.ts"))).toBe(true);
    expect(graph.has(join(ROOT, "apps/worker/src/handlers/index-kb.ts"))).toBe(true);
    expect(graph.has(SERVER_ENV) ? chain(graph, SERVER_ENV) : null).toBeNull();
  });

  it("detects a server-env import (walker self-test)", () => {
    const server = moduleGraph(join(ROOT, "packages/api/src/lib/web-push.ts"));
    expect(server.has(SERVER_ENV)).toBe(true);
  });

  it("imports the whole worker graph with only the worker's environment", () => {
    // Entrypoints start the process or load the developer's `.env`; neither
    // belongs in a check of what the deployed worker environment can import.
    const skipped = new Set(
      [
        "apps/worker/src/bootstrap.ts",
        "apps/worker/src/index.ts",
        "packages/env/src/load-dotenv.ts",
        "packages/env/src/root-env.ts",
      ].map((file) => join(ROOT, file)),
    );
    const modules = [...graph.keys()].filter((file) => /\.tsx?$/.test(file) && !skipped.has(file));
    const tsx = pathToFileURL(createRequire(ENTRY).resolve("tsx/esm")).href;
    // No network either: queue barrels open Redis connections at import, so
    // every TCP connect fails on the next tick without leaving the process
    // (like scripts/test-io-guard.ts, which this child does not load).
    const script = [
      'import net from "node:net";',
      'import { readFileSync } from "node:fs";',
      'import { pathToFileURL } from "node:url";',
      "let blocked = 0;",
      "net.Socket.prototype.connect = function blockedConnect() {",
      "  blocked += 1;",
      '  const error = Object.assign(new Error("boundary test: network blocked"), { code: "ECONNREFUSED" });',
      "  process.nextTick(() => this.destroy(error));",
      "  return this;",
      "};",
      'const files = JSON.parse(readFileSync(0, "utf8"));',
      "for (const file of files) {",
      "  try { await import(pathToFileURL(file).href); }",
      '  catch (error) { console.error("IMPORT_FAILED " + file); console.error(error); process.exit(1); }',
      "}",
      'console.log("IMPORTED " + files.length + " (blocked " + blocked + " TCP connects)");',
      "process.exit(0);",
    ].join("\n");
    // The dedicated worker's variables only (dummy, disposable, unreachable).
    // The generated Compose's worker block (scripts/generate-dokploy-config.ts)
    // minus the optional, empty-by-default SMTP_*, BACKUP_* and KB_ASSET_* keys.
    const workerEnv = {
      PATH: process.env.PATH ?? "",
      NODE_ENV: "production",
      MIGRATE_ON_START: "false",
      DATABASE_URL: "postgresql://worker:disposable@127.0.0.1:1/worker",
      REDIS_URL: "redis://127.0.0.1:1",
      KB_DATA_ROOT: "/nonexistent/knowledge-base",
    };
    const child = spawnSync(
      process.execPath,
      ["--import", tsx, "--input-type=module", "--eval", script],
      {
        cwd: ROOT,
        env: workerEnv,
        input: JSON.stringify(modules),
        encoding: "utf8",
        timeout: 90_000,
      },
    );
    expect(child.stderr.includes("IMPORT_FAILED") ? child.stderr : "").toBe("");
    expect(child.status).toBe(0);
    expect(child.stdout).toContain(`IMPORTED ${modules.length}`);
  }, 120_000);
});
