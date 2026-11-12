import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { compareTree, FORK_EDITS, pinProblems } from "./sync-cli-vendor-inventory.mjs";

const vendor = new URL("../apps/cli/vendor/", import.meta.url);
const inventory = JSON.parse(readFileSync(new URL("inventory.json", vendor), "utf8"));

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "kb-vendor-inventory-test-"));
  const files = {};
  for (const [path, body] of [
    ["llama-cpp-2/src/lib.rs", "lib"],
    ["llama-cpp-sys-2/llama.cpp/src/llama.cpp", "llama"],
  ]) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), body);
    files[path] = createHash("sha256").update(body).digest("hex");
  }
  writeFileSync(join(dir, "README.md"), "ours");
  return { dir, files };
}

test("the checked-in vendor tree matches its inventory and pins", () => {
  assert.deepEqual(compareTree(fileURLToPath(vendor), inventory.files), []);
  assert.deepEqual(pinProblems(inventory), []);
});

test("added, removed, changed and executable vendored files all fail", () => {
  const { dir, files } = fixture();
  try {
    assert.deepEqual(compareTree(dir, files), []);
    writeFileSync(join(dir, "llama-cpp-2/src/extra.rs"), "x");
    writeFileSync(join(dir, "llama-cpp-sys-2/llama.cpp/src/llama.cpp"), "patched");
    rmSync(join(dir, "llama-cpp-2/src/lib.rs"));
    writeFileSync(join(dir, "stray.txt"), "x");
    assert.deepEqual(compareTree(dir, files).sort(), [
      "added: llama-cpp-2/src/extra.rs",
      "added: stray.txt",
      "changed: llama-cpp-sys-2/llama.cpp/src/llama.cpp",
      "removed: llama-cpp-2/src/lib.rs",
    ]);
    if (process.platform !== "win32") {
      const clean = fixture();
      chmodSync(join(clean.dir, "llama-cpp-2/src/lib.rs"), 0o755);
      assert.deepEqual(compareTree(clean.dir, clean.files), ["executable: llama-cpp-2/src/lib.rs"]);
      rmSync(clean.dir, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every fork edit is documented with its upstream hash, and pins cannot drift", () => {
  const edits = inventory.crates.flatMap((crate) => Object.entries(crate.forkEdits));
  assert.deepEqual(
    Object.fromEntries(edits.map(([path, edit]) => [path, edit.reason])),
    FORK_EDITS,
  );
  for (const [path, edit] of edits) {
    assert.match(edit.upstreamSha256, /^[0-9a-f]{64}$/);
    assert.notEqual(edit.upstreamSha256, inventory.files[path], path);
  }
  const drifted = structuredClone(inventory);
  drifted.llamaCpp.commit = "0".repeat(40);
  drifted.crates[0].version = "0.0.0";
  delete drifted.crates[1].forkEdits["llama-cpp-sys-2/build.rs"];
  assert.deepEqual(pinProblems(drifted), [
    "llama.cpp commit drifts from the server pin",
    "llama-cpp-2 version drifts from its Cargo.toml",
    "inventory fork edits differ from the documented FORK_EDITS list",
  ]);
});

test("a copied real tree detects a one-byte edit in a vendored llama.cpp source", () => {
  const dir = mkdtempSync(join(tmpdir(), "kb-vendor-inventory-copy-"));
  try {
    cpSync(fileURLToPath(vendor), dir, { recursive: true });
    const target = join(dir, "llama-cpp-sys-2/llama.cpp/src/llama-graph.cpp");
    writeFileSync(target, `${readFileSync(target, "utf8")} `);
    assert.deepEqual(compareTree(dir, inventory.files), [
      "changed: llama-cpp-sys-2/llama.cpp/src/llama-graph.cpp",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
