/** Narrow source guard for the authoritative CAS boundary. Staging, ZIP artifacts,
 * Git object stores and the CLI's independent local store are separate surfaces.
 * Exceptions grant specific operations, never exemption from scanning a file.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "@babel/parser";

const ROOT = resolve(import.meta.dirname, "..");
const DISK = "packages/api/src/lib/kb/blob-store-disk.ts";
const CACHE = "packages/api/src/lib/kb/asset-cache.ts";
const DISK_FD = "packages/api/src/lib/kb/cas-fd.ts";
const OFFLINE = new Set(["scripts/lib/kb-backup.mjs", "scripts/lib/kb-restore.mjs"]);
const DISK_FIXTURES = new Set([
  "packages/api/src/lib/kb/cas.test.ts",
  "packages/api/src/lib/kb/cas-temp-race.test.ts",
  "packages/api/src/lib/kb/blob-store-disk.test.ts",
  "packages/api/src/lib/kb/authorized-stream.test.ts",
  "packages/test-utils/src/kb/cas.integration.test.ts",
  // Offline backup fixtures deliberately inventory retained/corrupt disk payload.
  "packages/test-utils/src/kb/backup.integration.test.ts",
  // Explicit cache corruption/occupancy fixture; production IO stays in asset-cache.
  "packages/test-utils/src/kb/asset-storage.integration.test.ts",
  // Offline migration fixture verifies trim, corruption and retained orphan paths.
  "packages/test-utils/src/kb/asset-storage-migration.integration.test.ts",
  "packages/test-utils/src/kb/asset-http.integration.test.ts",
  "packages/test-utils/src/kb/asset-manifest.integration.test.ts",
  "packages/test-utils/src/kb/exports.integration.test.ts",
  "packages/test-utils/src/kb/export-fixture.ts",
]);
const PATH_HELPERS = new Set(["casBlobPath", "casObjectsRoot", "casInode", "assertCasTempPath"]);
const FD_HELPERS = new Set(["openCasShardDir", "fsyncCasPublishBarriers"]);
const PATH_CALL =
  /^(join|resolve|open|openSync|readFile|readFileSync|createReadStream|linkSync|stat|statSync|lstat|lstatSync|unlink|unlinkSync)$/;

export function casOwnershipViolations(path, source) {
  const violations = [];
  const fail = (node, message) => violations.push(`${path}:${node.loc.start.line}: ${message}`);
  let ast;
  try {
    ast = parse(source, {
      sourceType: "unambiguous",
      plugins: path.endsWith(".tsx") ? ["typescript", "jsx"] : ["typescript"],
    });
  } catch {
    return [`${path}: cannot parse source for CAS ownership`];
  }
  const text = (node) => source.slice(node.start, node.end);
  const walk = (node) => {
    if (node.type === "Identifier") {
      const name = node.name;
      if (name === "readCasBlobSync") fail(node, "synchronous CAS reader bypass is forbidden");
      if (PATH_HELPERS.has(name) && path !== DISK && !DISK_FIXTURES.has(path))
        fail(node, "CAS paths/inodes belong to the disk backend or an explicit disk fixture");
      if (FD_HELPERS.has(name) && path !== DISK && path !== DISK_FD && path !== CACHE)
        fail(node, "CAS publication descriptors belong to the disk backend");
    }
    const moduleSource =
      (node.type === "ImportDeclaration" && node.importKind !== "type") ||
      node.type === "ExportNamedDeclaration" ||
      node.type === "ExportAllDeclaration" ||
      node.type === "ImportExpression"
        ? node.source?.value
        : node.type === "CallExpression" &&
            (node.callee.type === "Import" ||
              (node.callee.type === "Identifier" && node.callee.name === "require"))
          ? node.arguments[0]?.value
          : undefined;
    if (
      [
        DISK,
        DISK_FD,
        "packages/api/src/lib/kb/blob-store.ts",
        "packages/api/src/lib/kb/cas.ts",
      ].includes(path) &&
      typeof moduleSource === "string" &&
      /(@aws-sdk|@knowledge-base\/(db|queue)|\/env\/(server|worker))/.test(moduleSource)
    )
      fail(node, "disk storage modules must stay import-pure and disk-only");
    if (node.type === "CallExpression") {
      const callee = node.callee.type === "MemberExpression" ? node.callee.property : node.callee;
      const args = node.arguments.map(text).join(",");
      // Recognize conventional assetsDir roots as well as literal CAS paths.
      // Generic Git/private-tmp fd operations have neither shape.
      if (
        callee.type === "Identifier" &&
        PATH_CALL.test(callee.name) &&
        (/assets\/objects(?:\/|["'`])/.test(args) ||
          (/\bassetsDir\b/.test(args) && /["'`]objects(?:\/|["'`])/.test(args))) &&
        path !== DISK &&
        !OFFLINE.has(path) &&
        !DISK_FIXTURES.has(path)
      )
        fail(node, "raw CAS path IO belongs to storage/offline modules or explicit disk fixtures");
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) if (child?.type) walk(child);
      } else if (value?.type) walk(value);
    }
  };
  walk(ast);
  return [...new Set(violations)];
}

function scan(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return scan(path);
    if (!/\.(?:[cm]?[jt]s|[jt]sx)$/.test(entry.name) || /\.d\.[cm]?ts$/.test(entry.name)) return [];
    return casOwnershipViolations(relative(ROOT, path), readFileSync(path, "utf8"));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const violations = [
    "packages/api/src",
    "packages/test-utils/src/kb",
    "apps/server/src",
    "apps/worker/src",
    "scripts",
  ].flatMap((dir) => scan(join(ROOT, dir)));
  if (violations.length) {
    process.stderr.write(`${violations.join("\n")}\n`);
    process.exitCode = 1;
  } else process.stdout.write("CAS source ownership passed.\n");
}
