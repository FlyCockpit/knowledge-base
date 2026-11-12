import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KbLockError } from "./lock";
import { assertGitWriteCapability, isGitWriteCapability } from "./write-capability";

describe("git write capability", () => {
  it("is opaque: a forged object is not admitted", () => {
    const forged = { opId: "op_cap", kbId: "kb1" };
    expect(isGitWriteCapability(forged)).toBe(false);
    expect(() => assertGitWriteCapability(forged)).toThrow(KbLockError);
  });

  it("is excluded from the worker source tree", () => {
    const workerRoot = join(import.meta.dirname, "../../../../../apps/worker/src");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) files.push(path);
      }
    };
    walk(workerRoot);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(/write-capability|GitWriteCapability|issueGitWriteCapability/);
      expect(source).not.toMatch(
        /issue-write-capability|issue-git-write-capability|kb-write-coordinator/,
      );
    }
  });
});
