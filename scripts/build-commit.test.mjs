import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildCommit } from "./build-commit.mjs";

const A = "a".repeat(40);
const B = "b".repeat(40);

function repo(files) {
  const dir = mkdtempSync(path.join(tmpdir(), "build-commit-"));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, ".git", name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return dir;
}

test("a full-SHA BUILD_VERSION wins over git metadata", () => {
  const dir = repo({ HEAD: `${A}\n` });
  try {
    assert.equal(buildCommit(dir, { BUILD_VERSION: B.toUpperCase() }), B);
    // Anything that is not a full SHA is ignored.
    assert.equal(buildCommit(dir, { BUILD_VERSION: "v1.2.3" }), A);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("detached HEAD, loose branch ref, and packed-refs all resolve", () => {
  const detached = repo({ HEAD: `${A}\n` });
  const loose = repo({ HEAD: "ref: refs/heads/main\n", "refs/heads/main": `${B}\n` });
  const packed = repo({
    HEAD: "ref: refs/heads/main\n",
    "packed-refs": `# pack-refs with: peeled fully-peeled sorted\n${A} refs/heads/other\n${B} refs/heads/main\n`,
  });
  try {
    assert.equal(buildCommit(detached, {}), A);
    assert.equal(buildCommit(loose, {}), B);
    assert.equal(buildCommit(packed, {}), B);
  } finally {
    for (const dir of [detached, loose, packed]) rmSync(dir, { recursive: true, force: true });
  }
});

test("unknown layouts report null instead of guessing", () => {
  const none = mkdtempSync(path.join(tmpdir(), "build-commit-"));
  const missingRef = repo({ HEAD: "ref: refs/heads/main\n" });
  const traversal = repo({ HEAD: "ref: refs/heads/../../x\n" });
  try {
    assert.equal(buildCommit(none, {}), null);
    assert.equal(buildCommit(missingRef, {}), null);
    assert.equal(buildCommit(traversal, {}), null);
  } finally {
    for (const dir of [none, missingRef, traversal]) rmSync(dir, { recursive: true, force: true });
  }
});
