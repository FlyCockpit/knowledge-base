/**
 * Bundled process entry. Exists purely to guarantee load-before-validate order
 * in the BUILT artifact; `tsx` dev runs use this same boundary.
 *
 * Same rule as `apps/server/src/bootstrap.ts` — read the explanation there. In
 * short: `import "@knowledge-base/env/load-dotenv"` first in `index.ts` is correct
 * under plain ESM but not after bundling, because rolldown inlines the loader
 * into the entry body while hoisting `@knowledge-base/env/shared` into a statically
 * imported chunk, and static imports evaluate first. The dynamic `import()`
 * below defers the whole graph until after the `.env` is read.
 *
 * Do not add any other static import to this file.
 *
 * See AGENTS.md § Environment variables — schema + manifest, always both
 */
import "@knowledge-base/env/load-dotenv";

// Import-time failures (env validation, a client constructor) never reach
// Node's default handler, which would print the raw error and its stack: they
// become one fixed startup record and a non-zero exit (R3-W3). The handlers
// cover rejections escaping the import too, and hand over to the runtime's own
// handlers once the application graph has loaded.
// The output supervisor's record channel first, before anything can log: this
// service's stderr is counted and dropped. It refuses to start without one.
const { connectServiceLog, logStartupFailure } = await import("@knowledge-base/env/log");
connectServiceLog();
const failed = (error: unknown) => {
  logStartupFailure("worker", error, "import");
  process.exit(1);
};
process.on("uncaughtException", failed);
process.on("unhandledRejection", failed);
try {
  await import("./index.js");
} catch (error) {
  failed(error);
} finally {
  process.off("uncaughtException", failed);
  process.off("unhandledRejection", failed);
}
