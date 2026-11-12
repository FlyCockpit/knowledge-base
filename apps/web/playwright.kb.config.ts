import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { defineConfig, devices } from "@playwright/test";

/**
 * Real-browser KB viewer suite. Run ONLY through `pnpm test:kb -- browser`,
 * which provisions the disposable PostgreSQL the fixture seeds and fails when
 * no browser test executed. Ordinary Vitest never collects these specs.
 */
export default defineConfig({
  testDir: "./tests",
  testMatch: "kb-*.spec.ts",
  outputDir: join(
    process.env.KB_BROWSER_REPORT ? dirname(process.env.KB_BROWSER_REPORT) : tmpdir(),
    `kb-browser-results-${process.pid}`,
  ),
  globalSetup: "./tests/kb-browser.setup.ts",
  forbidOnly: true,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // The runner reads this JSON report to fail when zero tests executed.
  reporter: process.env.KB_BROWSER_REPORT
    ? [["list"], ["json", { outputFile: process.env.KB_BROWSER_REPORT }]]
    : [["list"]],
  use: {
    trace: "retain-on-failure",
    acceptDownloads: true,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
