import { defineConfig } from "tsdown";

import { assertProtocolOnlyBundle } from "../../scripts/lib/protocol-only-bundle.mjs";

export default defineConfig({
  // index owns process output; service is the dotenv/bootstrap child entry.
  // Keep this boundary in sync with the server.
  // `qwen-child` is the forked model child (src/lib/qwen-child.ts): the only
  // bundle that may import the node-llama-cpp native addon.
  entry: {
    index: "./src/output.ts",
    service: "./src/bootstrap.ts",
    "ssh-wrapper": "./src/ssh-wrapper.ts",
    "qwen-child": "./src/lib/qwen-child.ts",
  },
  // The mirror helper replies on its fd-3 frame and the model child over IPC:
  // neither may ever load the logger.
  hooks: { "build:done": assertProtocolOnlyBundle(["ssh-wrapper", "qwen-child"]) },
  format: "esm",
  outDir: "./dist",
  clean: true,
  // Bundle the workspace (@knowledge-base/*) packages into the output. The runtime
  // image (Dockerfile.worker) ships only this app's dist + node_modules — it
  // does NOT copy packages/*/dist — so anything left external would resolve to
  // a dangling node_modules symlink and crash at boot with ERR_MODULE_NOT_FOUND
  // (e.g. "Cannot find package '@knowledge-base/env'"). Mirrors apps/server.
  deps: {
    // Bundle dotenv with `@knowledge-base/env/load-dotenv` so the worker image does not
    // need a resolvable `dotenv` package at runtime. Validation modules never
    // import dotenv. `dotenv` is not a dependency of this app on purpose — it
    // resolves transitively through `@knowledge-base/env`, the only workspace package
    // that declares it. Same rule as apps/server.
    alwaysBundle: [/@knowledge-base\/.*/, "dotenv"],
    // sharp is a native module pulled in transitively via @knowledge-base/api. Bundling its JS
    // detaches it from its platform binary (@img/sharp-linux-x64) and crashes at
    // runtime. Keep it external so it resolves from node_modules — this requires
    // sharp to be a direct dependency of this package (see package.json), so pnpm
    // places it where the bundled output can resolve it. Same rule as apps/server.
    // node-llama-cpp is the same: its source-built addon and shared libraries
    // must resolve from node_modules, and only dist/qwen-child.mjs imports it.
    // better-sqlite3 and sqlite-vec (SQLite index files) are native as well.
    neverBundle: ["sharp", "node-llama-cpp", "better-sqlite3", "sqlite-vec"],
  },
});
