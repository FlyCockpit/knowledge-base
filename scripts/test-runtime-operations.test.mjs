import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./test-runtime-operations.mjs", import.meta.url));

/**
 * Runs the smoke with a fake `docker` that records its arguments and refuses
 * `docker run`, so the run stops at its first container and cleans up. No real
 * Docker, database or Redis.
 */
function smoke(env) {
  const dir = mkdtempSync(join(tmpdir(), "kb-runtime-operations-test-"));
  try {
    const calls = join(dir, "calls.jsonl");
    writeFileSync(
      join(dir, "docker"),
      `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
if (args[0] === "image" && args[1] === "inspect") process.stdout.write("sha256:fixture\\n");
else if (args[0] === "run") process.exit(1);
`,
    );
    chmodSync(join(dir, "docker"), 0o755);
    const result = spawnSync(process.execPath, [script, "--disposable-services"], {
      encoding: "utf8",
      timeout: 60_000,
      env: { PATH: `${dir}:${process.env.PATH}`, ...env },
    });
    let recorded = [];
    try {
      recorded = readFileSync(calls, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {}
    return { ...result, calls: recorded };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Every Docker name the smoke chose: the built tag, container names, removals. */
function chosenNames(calls) {
  const names = [];
  for (const args of calls) {
    const after = (flag) => args[args.indexOf(flag) + 1];
    if (args[0] === "build") names.push(after("-t"));
    if (args[0] === "run") names.push(after("--name"));
    if (args[0] === "rm") names.push(args.at(-1));
    if (args[0] === "image" && args[1] === "rm") names.push(args.at(-1));
  }
  return names;
}

test("runtime:test-operations puts every Docker name it chooses under KB_TEST_NAME_PREFIX", () => {
  const result = smoke({ KB_TEST_NAME_PREFIX: "rp-unit" });
  assert.equal(result.status, 1, result.stderr);
  const names = chosenNames(result.calls);
  // The worker base image, the Postgres container and both removals.
  assert.ok(names.length >= 4, JSON.stringify(result.calls));
  for (const name of names) assert.match(name, /^rp-unit-knowledge-base-runtime-/);
  // Cleanup removes every container it started (and the reserved names of any
  // it had not started yet) and the image it built.
  const removed = result.calls.filter((args) => args[0] === "rm").map((args) => args.at(-1));
  for (const args of result.calls.filter((call) => call[0] === "run"))
    assert.ok(removed.includes(args[args.indexOf("--name") + 1]), JSON.stringify(result.calls));
  const built = result.calls.find((args) => args[0] === "build");
  const removedImages = result.calls.filter((args) => args[0] === "image" && args[1] === "rm");
  assert.deepEqual(
    removedImages.map((args) => args.at(-1)),
    [built[built.indexOf("-t") + 1]],
  );
});

test("runtime:test-operations without a prefix uses its own unprefixed names", () => {
  const result = smoke({});
  assert.equal(result.status, 1, result.stderr);
  const names = chosenNames(result.calls);
  assert.ok(names.length >= 4);
  for (const name of names) assert.match(name, /^knowledge-base-runtime-/);
});

test("runtime:test-operations refuses an invalid KB_TEST_NAME_PREFIX before any Docker call", () => {
  const result = smoke({ KB_TEST_NAME_PREFIX: "Bad_Prefix" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /KB_TEST_NAME_PREFIX must be/);
  assert.deepEqual(result.calls, []);
});
