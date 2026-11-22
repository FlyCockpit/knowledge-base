import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  describeUrl,
  isLocalHost,
  localDatabaseNames,
  shadowName,
  withDatabase,
  worktreeName,
} from "./local-db-name.mjs";

// A git hook (or any caller) may export GIT_DIR, GIT_WORK_TREE and the like;
// inherited by local-db-name.mjs's git calls, they would resolve the
// not-a-repository temp dir below to the caller's repository. Drop every GIT_*
// variable and stop discovery at the temp dir, which may sit inside a checkout
// (localDatabaseNames' env option never reaches git).
for (const name of Object.keys(process.env)) if (name.startsWith("GIT_")) delete process.env[name];
process.env.GIT_CEILING_DIRECTORIES = tmpdir();

test("main and linked worktree names use the exact git directory without git writes", () => {
  const gitRead = (cwd, args) => (args.includes("--git-common-dir") ? "/main/.git" : `${cwd}/.git`);
  const main = localDatabaseNames({ cwd: "/main", env: {}, gitRead });
  assert.deepEqual(
    [main.main, main.shadow, main.worktree],
    ["knowledge_base", "knowledge_base_shadow", false],
  );
  assert.equal(
    localDatabaseNames({ cwd: "/main", env: { EXPECTED_DB: "myapp" }, gitRead }).main,
    "myapp",
  );
  const wt = localDatabaseNames({ cwd: "/wt", env: { EXPECTED_DB: "myapp" }, gitRead });
  assert.match(wt.main, /^knowledge_base_wt_[0-9a-f]{10}$/);
  assert.equal(wt.shadow, `${wt.main}_shadow`);
  assert.equal(wt.worktree, true);
  assert.equal(localDatabaseNames({ cwd: "/wt", env: {}, gitRead }).main, wt.main);
  assert.ok(wt.shadow.length < 63);
});

test("outside git behaves as the main checkout", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dbname-nogit-"));
  try {
    assert.equal(localDatabaseNames({ cwd: dir, env: {} }).main, "knowledge_base");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("helpers", () => {
  assert.notEqual(worktreeName("/a/.git/worktrees/x"), worktreeName("/b/.git/worktrees/x"));
  assert.equal(shadowName("knowledge_base"), "knowledge_base_shadow");
  assert.equal(
    describeUrl(withDatabase("postgresql://u:p@[::1]:5433/knowledge_base", "x")).database,
    "x",
  );
  assert.deepEqual(describeUrl("postgresql://u:p@[::1]/s"), {
    host: "::1",
    port: "5432",
    database: "s",
  });
  assert.equal(isLocalHost("host.docker.internal"), false);
});
