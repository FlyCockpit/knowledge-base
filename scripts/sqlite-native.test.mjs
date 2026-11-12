import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkSqliteNative,
  EXPECTED_VEC_VERSION,
  failureMessage,
  parseArgs,
  resolveNativePackages,
} from "./sqlite-native.mjs";

const PATHS = {
  sqliteEntry: "/pkg/better-sqlite3/lib/index.js",
  vecEntry: "/pkg/sqlite-vec/index.cjs",
};

/** A fake addon: `opens` decides whether `new Database(":memory:")` succeeds. */
function fakeLoader(state) {
  class Database {
    constructor() {
      if (!state.opens()) throw new Error("Cannot find module '../prebuilds/linux-x64.node'");
    }
    loadExtension(path) {
      state.loaded = path;
    }
    prepare() {
      return { get: () => ({ v: state.version ?? EXPECTED_VEC_VERSION }) };
    }
    exec(sql) {
      state.exec = sql;
      if (state.noFts) throw new Error("no such module: fts5");
    }
    close() {}
  }
  return {
    loadDatabase: () => Database,
    loadVec: () => ({ getLoadablePath: () => "/pkg/sqlite-vec/vec0.so" }),
  };
}

const quiet = () => {};

test("parseArgs takes exactly one workspace directory", () => {
  assert.deepEqual(parseArgs(["apps/server"]), { workspaceDir: "apps/server" });
  for (const argv of [[], ["a", "b"], [""], ["--prune"]]) {
    assert.throws(() => parseArgs(argv), /usage: node scripts\/sqlite-native\.mjs/);
  }
});

test("a loadable pair passes the vec and fts5 probe", () => {
  const state = { opens: () => true };
  checkSqliteNative({
    workspaceDir: "apps/server",
    resolvePackages: () => PATHS,
    loader: fakeLoader(state),
    log: quiet,
  });
  assert.equal(state.loaded, "/pkg/sqlite-vec/vec0.so");
  assert.equal(state.exec, "CREATE VIRTUAL TABLE temp.t USING fts5(x)");
});

test("failures name the failing check with platform, arch and ABI; nothing is fetched", () => {
  for (const [state, pattern] of [
    [{ opens: () => false }, /Cannot find module '\.\.\/prebuilds\/linux-x64\.node'/],
    [{ opens: () => true, version: "v0.1.6" }, /vec_version\(\) is v0\.1\.6, expected v0\.1\.9/],
    [{ opens: () => true, noFts: true }, /no such module: fts5/],
  ]) {
    assert.throws(
      () =>
        checkSqliteNative({
          workspaceDir: "apps/server",
          resolvePackages: () => PATHS,
          loader: fakeLoader(state),
          log: quiet,
        }),
      (error) => {
        assert.match(error.message, /^sqlite-native: native probe failed: /);
        assert.match(error.message, pattern);
        assert.match(
          error.message,
          new RegExp(`platform=${process.platform} arch=${process.arch}`),
        );
        assert.match(error.message, new RegExp(`node-abi=${process.versions.modules}`));
        return true;
      },
    );
  }
});

test("failureMessage reports the runtime", () => {
  const message = failureMessage("boom", {
    platform: "linux",
    arch: "arm64",
    versions: { modules: "137" },
  });
  assert.equal(message, "sqlite-native: boom\n  platform=linux arch=arm64 node-abi=137");
});

test("the real workspace resolves both packages and passes the probe", () => {
  for (const workspace of ["../apps/server", "../apps/worker"]) {
    const workspaceDir = fileURLToPath(new URL(workspace, import.meta.url));
    const paths = resolveNativePackages(workspaceDir);
    assert.match(paths.sqliteEntry, /better-sqlite3[/\\]lib[/\\]index\.js$/);
    checkSqliteNative({ workspaceDir, log: quiet });
  }
});
