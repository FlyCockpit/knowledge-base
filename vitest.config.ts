import { fileURLToPath } from "node:url";

import { configDefaults, defineConfig } from "vitest/config";

const testIoGuard = fileURLToPath(new URL("./scripts/test-io-guard.ts", import.meta.url));

export default defineConfig({
  test: {
    // Turbo runs two test packages at once. Keep one worker per package so
    // nested pools do not contend with the real-Git fixtures' fixed deadlines.
    maxWorkers: 1,
    globals: false,
    environment: "node",
    passWithNoTests: true,
    setupFiles: [testIoGuard],
    exclude: [
      ...configDefaults.exclude,
      "**/dist/**",
      "**/dev-dist/**",
      "**/*.contract.test.ts",
      "**/*.integration.test.ts",
      // Real-browser specs run only under Playwright (`pnpm test:kb -- browser`).
      "apps/web/tests/kb-*.spec.ts",
    ],
  },
});
