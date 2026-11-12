import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { checkPatchConfiguration, checkSecurityPatches } from "./check-security-patches.mjs";

test("every installed braces API rejects excessive depth and retains legitimate patterns", () => {
  checkSecurityPatches();
});

test("audit exemption cannot survive a missing patch, altered patch, new version or unpatched edge", () => {
  const workspace = readFileSync(new URL("../pnpm-workspace.yaml", import.meta.url), "utf8");
  const lock = readFileSync(new URL("../pnpm-lock.yaml", import.meta.url), "utf8");
  const patch = readFileSync(new URL("../patches/braces@3.0.3.patch", import.meta.url), "utf8");
  for (const [w, l, p] of [
    [workspace.replace("braces@3.0.3: patches/braces@3.0.3.patch", ""), lock, patch],
    [workspace, lock, `${patch}\n`],
    [workspace, `${lock}\n  braces@3.0.2:\n`, patch],
    [workspace, lock.replace(/braces: 3\.0\.3\(patch_hash=[a-f0-9]+\)/g, "braces: 3.0.3"), patch],
  ])
    assert.throws(() => checkPatchConfiguration(w, l, p));
});
