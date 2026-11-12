import { defineConfig } from "vitest/config";

const include = (process.env.KB_TEST_INCLUDE ?? "")
  .split("\n")
  .map((entry) => entry.trim())
  .filter(Boolean);

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    passWithNoTests: false,
    fileParallelism: false,
    pool: "forks",
    maxWorkers: 2,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    include,
    // Only the supervised lane (scripts/test-kb.mjs) sets this; see the setup file.
    globalSetup:
      process.env.KB_TEST_SUPERVISED === "1" ? ["./scripts/kb-supervised-vitest-setup.ts"] : [],
    exclude: ["**/node_modules/**", "**/dist/**", "**/dev-dist/**"],
  },
});
