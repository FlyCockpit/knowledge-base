import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// image-smoke.sh pipes this script to `node` inside the image; run it the same way.
const script = readFileSync(new URL("./image-smoke-resolve.mjs", import.meta.url));

function resolveDist(t, files) {
  const dir = mkdtempSync(join(tmpdir(), "kb-smoke-resolve-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, source] of Object.entries(files)) writeFileSync(join(dir, name), source);
  const result = spawnSync(
    process.execPath,
    [
      "--no-warnings",
      "--experimental-vm-modules",
      "--experimental-import-meta-resolve",
      "--input-type=module",
      "-",
      dir,
    ],
    { input: script, encoding: "utf8", cwd: dir },
  );
  return { status: result.status, summary: JSON.parse(result.stdout) };
}

const specifiers = (summary) => summary.failures.map((failure) => failure.specifier);

test("an optional peer behind a guarded dynamic import is absent by design", (t) => {
  const { status, summary } = resolveDist(t, {
    "negotiate.mjs": 'export async function f() { try { await import("kerberos"); } catch {} }\n',
  });
  assert.equal(status, 0);
  assert.deepEqual(summary.failures, []);
});

test("a static import of an optional peer still fails", (t) => {
  const { status, summary } = resolveDist(t, {
    "negotiate.mjs": 'export async function f() { try { await import("kerberos"); } catch {} }\n',
    "eager.mjs": 'import "kerberos";\n',
  });
  assert.equal(status, 1);
  assert.deepEqual(specifiers(summary), ["kerberos"]);
});

test("any other unresolved dynamic import still fails", (t) => {
  const { status, summary } = resolveDist(t, {
    "missing.mjs": 'export const load = () => import("kb-smoke-missing-package");\n',
  });
  assert.equal(status, 1);
  assert.deepEqual(specifiers(summary), ["kb-smoke-missing-package"]);
});
