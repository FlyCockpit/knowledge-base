import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_MAIN_DB } from "./lib/local-db-name.mjs";
import { adoptRefusal, withDatabaseUrl } from "./worktree.mjs";

/** Fake git metadata: /main is the main checkout, anything else a linked worktree. */
const gitRead = (cwd, args) => (args.includes("--git-common-dir") ? "/main/.git" : `${cwd}/.git`);

test("--adopt refuses an EXPECTED_DB that changes the main checkout's database", () => {
  assert.equal(adoptRefusal({ cwd: "/main", env: {}, gitRead }), null);
  assert.equal(
    adoptRefusal({ cwd: "/main", env: { EXPECTED_DB: DEFAULT_MAIN_DB }, gitRead }),
    null,
  );
  assert.match(
    adoptRefusal({ cwd: "/main", env: { EXPECTED_DB: "myapp" }, gitRead }) ?? "",
    /refuses EXPECTED_DB/,
  );
});

test("--adopt in a linked worktree ignores EXPECTED_DB (worktree names are always derived)", () => {
  assert.equal(adoptRefusal({ cwd: "/wt", env: { EXPECTED_DB: "myapp" }, gitRead }), null);
});

test("withDatabaseUrl replaces the live line and collapses duplicates", () => {
  assert.equal(
    withDatabaseUrl("A=1\nDATABASE_URL=x\nexport DATABASE_URL=y\n", "z"),
    "A=1\nDATABASE_URL=z\n",
  );
  assert.equal(withDatabaseUrl("A=1\n", "z"), "A=1\nDATABASE_URL=z\n");
});
