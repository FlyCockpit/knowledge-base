/**
 * Guards the "one test file per source file" rule for oRPC routers and
 * BullMQ worker handlers.
 *
 *   pnpm policy:test-colocation
 *
 * A missing sibling `*.test.ts` is a failure unless the source is on the
 * dated allowlist below. Adding a new router or handler without a test is
 * the thing this check exists to catch — do not grow the allowlist silently.
 * When a listed file gains a test, delete its allowlist entry in the same
 * change (stale entries fail).
 */

import { existsSync, readdirSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import process from "node:process";

const ROOT = resolve(import.meta.dirname!, "..");

/** Gaps as of 2026-09-02. Shrink this list; do not grow it without a reason. */
const ALLOWLIST: ReadonlyArray<{
  file: string;
  since: string;
  reason: string;
}> = [];

const ALLOWLIST_PATHS = new Set(ALLOWLIST.map((entry) => entry.file));

const SCAN_DIRS = ["packages/api/src/routers", "apps/worker/src/handlers"] as const;

function listSources(dir: string): string[] {
  const abs = resolve(ROOT, dir);
  if (!existsSync(abs)) {
    throw new Error(
      `scan root missing: ${dir} — if you removed this tree, update scripts/check-test-colocation.ts`,
    );
  }
  const out: string[] = [];
  const walk = (currentAbs: string, relPrefix: string) => {
    for (const entry of readdirSync(currentAbs, { withFileTypes: true })) {
      const relPath = join(relPrefix, entry.name).replaceAll("\\", "/");
      const entryAbs = join(currentAbs, entry.name);
      if (entry.isDirectory()) {
        walk(entryAbs, relPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        out.push(relPath);
      }
    }
  };
  walk(abs, dir);
  return out;
}

function siblingTest(file: string): string {
  return file.replace(/\.ts$/, ".test.ts");
}

const missing: string[] = [];
const stale: string[] = [];
const sources = SCAN_DIRS.flatMap(listSources);

for (const file of sources) {
  const testFile = siblingTest(file);
  const hasTest = existsSync(resolve(ROOT, testFile));
  const allowlisted = ALLOWLIST_PATHS.has(file);
  if (!hasTest && !allowlisted) {
    missing.push(file);
  }
  if (hasTest && allowlisted) {
    stale.push(file);
  }
}

const unknownAllow = ALLOWLIST.filter((entry) => !sources.includes(entry.file));

if (missing.length === 0 && stale.length === 0 && unknownAllow.length === 0) {
  console.log("test-colocation policy passed.");
  process.exit(0);
}

if (missing.length > 0) {
  console.error("POLICY VIOLATION: source file has no sibling *.test.ts:");
  for (const file of missing) {
    console.error(`  ${file}  (expected ${basename(siblingTest(file))} next to it)`);
  }
  console.error("");
  console.error(
    "Current dated allowlist (do not copy a new file onto this list without a reason):",
  );
  for (const entry of ALLOWLIST) {
    console.error(`  ${entry.file}  since ${entry.since} — ${entry.reason}`);
  }
  console.error("");
}

if (stale.length > 0) {
  console.error(
    "POLICY VIOLATION: allowlisted file now has a sibling test — remove it from the allowlist:",
  );
  for (const file of stale) {
    console.error(`  ${file}`);
  }
  console.error("");
}

if (unknownAllow.length > 0) {
  console.error("POLICY VIOLATION: allowlist entry does not match a scanned source file:");
  for (const entry of unknownAllow) {
    console.error(`  ${entry.file}`);
  }
  console.error("");
}

console.error(`See ${relative(ROOT, resolve(ROOT, "scripts/check-test-colocation.ts"))}.`);
process.exit(1);
