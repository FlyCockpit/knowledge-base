import { chmod, mkdir, symlink } from "node:fs/promises";
import { defineConfig } from "tsdown";

import { assertProtocolOnlyBundle } from "../../scripts/lib/protocol-only-bundle.mjs";

export default defineConfig({
  // index owns process output; service defers the application graph until dotenv
  // and its dedicated log channel are ready. Both are shipped in the image.
  // kb-index-reader is the SQLite worker-thread entry.
  entry: {
    index: "./src/output.ts",
    service: "./src/bootstrap.ts",
    "git-pre-receive": "./src/git-pre-receive.ts",
    "kb-index-reader": "./src/kb-index-reader.ts",
  },
  // The hook answers on its push socket and the reader thread on its
  // MessagePort: neither may ever load the logger.
  hooks: { "build:done": assertProtocolOnlyBundle(["git-pre-receive", "kb-index-reader"]) },
  async onSuccess() {
    await mkdir("dist/hooks", { recursive: true });
    await chmod("dist/git-pre-receive.mjs", 0o755);
    await symlink("../git-pre-receive.mjs", "dist/hooks/pre-receive");
  },
  format: "esm",
  outDir: "./dist",
  clean: true,
  deps: {
    // Bundle dotenv with the entrypoint helper (`@knowledge-base/env/load-dotenv`) so
    // production images do not need a resolvable `dotenv` package for the
    // server process. Validation modules never import dotenv; only the
    // entrypoint load path does.
    //
    // `dotenv` is deliberately NOT a dependency of this app — it resolves
    // transitively through `@knowledge-base/env`, which is the only workspace package
    // that declares it. Keep it there: adding it back here would let a direct
    // `import "dotenv"` compile in server code, which is exactly what
    // `pnpm env:check-entrypoints` exists to prevent.
    alwaysBundle: [/@knowledge-base\/.*/, "dotenv"],
    // sharp is a native module: it loads a platform-specific binary
    // (@img/sharp-linux-x64) from node_modules at runtime. Bundling its JS
    // detaches it from that binary and crashes the server on boot ("Could not
    // load the sharp module using the linux-x64 runtime"). Keep it external so
    // it resolves from node_modules at runtime — this requires sharp to be a
    // direct dependency of this package (see package.json). (The TanStack Start
    // SSR handler at apps/web/dist/server is imported via a runtime-computed
    // specifier in src/index.ts, so rolldown leaves it external automatically —
    // no entry needed here.)
    // better-sqlite3 and sqlite-vec are native too (stock prebuilt
    // better_sqlite3.node and the sqlite-vec loadable); same rule.
    neverBundle: ["sharp", "better-sqlite3", "sqlite-vec"],
  },
});
