/**
 * Index reader thread entry, emitted flat as `dist/kb-index-reader.mjs` (tsdown entry
 * `kb-index-reader`) so the server's reader pool can start it with
 * `new URL("./kb-index-reader.mjs", import.meta.url)`. It only re-exports the thread module;
 * that module installs its message loop when started by the pool.
 */
export * from "@knowledge-base/api/lib/kb/index-file/reader-thread";
