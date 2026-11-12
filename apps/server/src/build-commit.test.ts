import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readBuildCommit } from "./build-commit";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it("reads the baked SHA beside the actual entrypoint and normalizes case", () => {
  const root = mkdtempSync(join(tmpdir(), "kb-build-commit-"));
  roots.push(root);
  const dist = join(root, "dist");
  mkdirSync(dist);
  writeFileSync(join(dist, "BUILD_COMMIT"), ` ${"A".repeat(40)}\n`);
  expect(readBuildCommit(join(dist, "index.mjs"))).toBe("a".repeat(40));
  expect(readBuildCommit(join(root, "index.mjs"))).toBeNull();
  for (const invalid of ["a".repeat(7), "release/v1", `${"a".repeat(40)} extra`]) {
    writeFileSync(join(dist, "BUILD_COMMIT"), invalid);
    expect(readBuildCommit(join(dist, "index.mjs"))).toBeNull();
  }
});
