/** Fail closed before audit's single patched-package false-positive exemption. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PATCH_HASH = "e3552c5f7f0d1b0460431f5580a23216fbf3234657bfc1669aea1aedf0c29a4c";

export function checkPatchConfiguration(workspace, lock, patch) {
  assert.equal(
    createHash("sha256").update(patch).digest("hex"),
    PATCH_HASH,
    "review the changed security patch",
  );
  assert.match(workspace, /^ {2}braces@3\.0\.3: patches\/braces@3\.0\.3\.patch$/m);
  assert.match(workspace, /^ {4}- GHSA-vfj7-8cjw-p6xm$/m);
  assert.match(lock, new RegExp(`^  braces@3\\.0\\.3: ${PATCH_HASH}$`, "m"));
  const versions = [...lock.matchAll(/^ {2}braces@([^:]+):$/gm)].map((m) => m[1]);
  assert.deepEqual(
    versions,
    ["3.0.3", `3.0.3(patch_hash=${PATCH_HASH})`],
    "every braces version must be patched",
  );
  const edges = [...lock.matchAll(/^\s+braces: (.+)$/gm)].map((m) => m[1]);
  assert.ok(edges.length > 0, "braces consumer inventory must be nonempty");
  assert.ok(
    edges.every((edge) => edge === `3.0.3(patch_hash=${PATCH_HASH})`),
    "unpatched braces edge",
  );
}

function deepAst() {
  const root = { type: "root", nodes: [] };
  let parent = root;
  for (let i = 0; i < 256; i++) {
    const child = {
      type: "brace",
      nodes: [],
      parent,
      commas: 1,
      ranges: 0,
      open: true,
      close: true,
    };
    parent.nodes.push(child);
    parent = child;
  }
  parent.nodes.push({ type: "text", value: "x" });
  return root;
}

function checkInstalledBraces(braces) {
  const rejected = { name: "RangeError", message: "braces nesting depth exceeds 128" };
  for (const method of ["parse", "compile", "expand", "stringify"]) {
    for (const [open, close] of [
      ["{a,", "}"],
      ["(", ")"],
      ["{", ""],
    ]) {
      assert.throws(() => braces[method](open.repeat(2000) + "x" + close.repeat(2000)), rejected);
    }
  }
  // AST arguments bypass the parser, so each recursive walker needs its own guard.
  for (const method of ["compile", "expand", "stringify"]) {
    assert.throws(() => braces[method](deepAst()), rejected);
  }
  assert.deepEqual(braces.expand("src/{a,b}/{1..3}.ts"), [
    "src/a/1.ts",
    "src/a/2.ts",
    "src/a/3.ts",
    "src/b/1.ts",
    "src/b/2.ts",
    "src/b/3.ts",
  ]);
  assert.equal(braces.compile("{a,b}"), "(a|b)");
  assert.equal(braces.compile("\\{".repeat(2000)), "{".repeat(2000));
  assert.equal(braces.stringify(braces.parse("a/{b,c}/d")), "a/{b,c}/d");
  for (const literal of ["{x}", "{{x}"])
    assert.equal(braces.stringify(braces.parse(literal), { escapeInvalid: true }), literal);
  // Leaf nodes do not add nesting: every API accepts the advertised boundary.
  const boundary = "{a,".repeat(128) + "x" + "}".repeat(128);
  assert.ok(braces.compile(boundary).length > 0);
  assert.equal(braces.expand(boundary).length, 129);
  assert.equal(braces.stringify(braces.parse(boundary)), boundary);
  for (const method of ["parse", "compile", "expand", "stringify"])
    for (const [open, close] of [
      ["{a,", "}"],
      ["(", ")"],
    ])
      assert.throws(() => braces[method](open.repeat(129) + "x" + close.repeat(129)), rejected);
  assert.ok(braces.compile("{a,".repeat(32) + "x" + "}".repeat(32)).length > 0);
}

export function checkSecurityPatches() {
  checkPatchConfiguration(
    readFileSync(resolve(ROOT, "pnpm-workspace.yaml"), "utf8"),
    readFileSync(resolve(ROOT, "pnpm-lock.yaml"), "utf8"),
    readFileSync(resolve(ROOT, "patches/braces@3.0.3.patch")),
  );
  // The lockfile's complete braces edge inventory is micromatch; resolve its
  // actual installed dependency, rather than an inactive virtual-store archive.
  const consumer = realpathSync(resolve(ROOT, "node_modules/.pnpm/node_modules/micromatch"));
  const require = createRequire(resolve(consumer, "package.json"));
  checkInstalledBraces(require(resolve(consumer, "..", "braces")));
  console.log("Security patch hash, every lockfile edge, and installed API probes passed.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  checkSecurityPatches();
