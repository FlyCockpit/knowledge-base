import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const testIoGuard = fileURLToPath(new URL("./test-io-guard.ts", import.meta.url));

// This config is only for the caught-attempt child fixture. The fixture stays
// excluded from ordinary discovery because it intentionally makes teardown
// fail after proving a caught guard error cannot be ignored.
export default defineConfig({
  test: {
    // One fixture needs one worker. Keep it inside the owned CLI process so
    // the parent's timeout also terminates the worker without an orphan fork.
    pool: "threads",
    maxWorkers: 1,
    include: ["src/test-io-guard-caught.fixture.ts"],
    setupFiles: [testIoGuard],
  },
});
