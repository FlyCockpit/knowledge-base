/**
 * Runs INSIDE the built server image (piped to `node` by scripts/image-smoke.sh;
 * needs --experimental-vm-modules --experimental-import-meta-resolve).
 *
 * Every bare-specifier import of the shipped bundles must resolve from the
 * importing file's own directory. Bundlers inline workspace packages but leave
 * their npm deps external, so a dep declared only by an inlined package exists
 * in the workspace yet not in the runtime image (the class of `pg` missing from
 * apps/web/dist/server). Resolution is checked without evaluating any module.
 *
 * Static imports/re-exports come from V8's own parser; dynamic `import("x")`
 * with a string literal is matched textually outside block comments. Prints
 * one JSON summary line.
 */
import { readdirSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";

const roots = process.argv.slice(2);
if (roots.length === 0) throw new Error("usage: image-smoke-resolve.mjs <dist-dir>...");

function* moduleFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* moduleFiles(path);
    else if (/\.m?js$/.test(entry.name)) yield path;
  }
}

const bare = (specifier) =>
  !isBuiltin(specifier) &&
  !/^(\.{1,2}\/|\/|[a-z][a-z0-9+.-]*:)/i.test(specifier) &&
  !specifier.startsWith("#");

const DYNAMIC = /\bimport\(\s*(["'])([^"'`\s]+)\1\s*\)/g;
let files = 0;
let checked = 0;
const unparsed = [];
const failures = [];
for (const root of roots) {
  for (const file of moduleFiles(root)) {
    files += 1;
    const source = readFileSync(file, "utf8");
    const specifiers = new Set();
    try {
      for (const request of new vm.SourceTextModule(source, { identifier: file }).moduleRequests)
        specifiers.add(request.specifier);
    } catch {
      // Not an ES module (e.g. a CommonJS helper); dynamic imports still apply.
      unparsed.push(file);
    }
    // Block comments hold JSDoc `{import("pkg").Type}` references, not imports.
    for (const match of source.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(DYNAMIC))
      specifiers.add(match[2]);
    const parent = pathToFileURL(file).href;
    for (const specifier of specifiers) {
      if (!bare(specifier)) continue;
      checked += 1;
      try {
        import.meta.resolve(specifier, parent);
      } catch (error) {
        failures.push({ file, specifier, code: error?.code ?? String(error) });
      }
    }
  }
}
console.log(JSON.stringify({ files, checked, unparsed: unparsed.length, failures }));
process.exitCode = failures.length > 0 || files === 0 ? 1 : 0;
