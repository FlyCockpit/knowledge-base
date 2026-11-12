/**
 * The only importer of `better-sqlite3` and `sqlite-vec` (decision 21: stock prebuilt binaries,
 * plain-path opens, no URI, no env handling). Both packages are resolved at run time with
 * `createRequire(import.meta.url)`, so a bundled app resolves them from its own node_modules
 * (both are `neverBundle` in the server and worker tsdown configs).
 */
import { createRequire } from "node:module";
import type BetterSqlite3 from "better-sqlite3";
import { VEC_VERSION } from "./format";

export type SqliteDatabase = BetterSqlite3.Database;
export type SqliteConstructor = typeof BetterSqlite3;
export type SqliteStatement = BetterSqlite3.Statement;

const runtimeRequire = createRequire(import.meta.url);

export function loadSqlite(): SqliteConstructor {
  return runtimeRequire("better-sqlite3") as SqliteConstructor;
}

/** Loads sqlite-vec into `db` through the native API (SQL `load_extension()` stays disabled). */
export function loadVec(db: SqliteDatabase): string {
  const { getLoadablePath } = runtimeRequire("sqlite-vec") as { getLoadablePath(): string };
  db.loadExtension(getLoadablePath());
  const version = (db.prepare("SELECT vec_version() AS v").get() as { v: unknown } | undefined)?.v;
  if (version !== VEC_VERSION) throw new Error("Unexpected sqlite-vec version");
  return version;
}
