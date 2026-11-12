/**
 * Bundled process entry. Exists purely to guarantee load-before-validate order
 * in the BUILT artifact; `tsx` dev runs use this same boundary.
 *
 * The problem it solves: `import "@knowledge-base/env/load-dotenv"` being the first
 * import of `index.ts` is correct under plain ESM — static imports evaluate in
 * order, so the loader runs before `@knowledge-base/db` pulls in `@knowledge-base/env/shared`.
 * It is NOT sufficient after bundling. tsdown/rolldown inlines the tiny
 * `load-dotenv` body into the entry chunk's *body* while hoisting
 * `@knowledge-base/env/shared` into a separate chunk that the entry imports
 * statically — and ESM evaluates every static import before any of the
 * importer's own statements. The result is `createEnv()` running, and throwing
 * on missing vars, before `loadRootDotenv()` is ever reached. A populated root
 * `.env` sitting next to the bundle is silently ignored.
 *
 * A dynamic `import()` is the fix: it defers evaluation of the entire rest of
 * the graph — including every statically-hoisted chunk it depends on — until
 * after this module's body has run. Do not convert it to a static import, and
 * do not add any other static import to this file; either one reintroduces the
 * bug in a form that looks correct in source. `pnpm env:check-entrypoints`
 * enforces exactly that shape.
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
  logStartupFailure("server", error, "import");
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
