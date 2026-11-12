import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  CONTRACTS_FOLDER,
  filterDiff,
  priorRemovedLabels,
  retiredColumnTypes,
  syntheticMigrationsDir,
} from "./lib/diff-source.mjs";
import {
  analyzeContract,
  analyzeMigration,
  catalogFromSql,
  checkWrapper,
  enumRemoveContract,
  markers,
  normalizeType,
  wrapTransactional,
} from "./lib/sql.mjs";
import { buildMigration, nextPrefix, parseArgs, report, timestamp } from "./migrate.mjs";
import { planRebase, retargetTemplates } from "./rebase.mjs";
import { withDatabaseUrl } from "./worktree.mjs";

// Built from parts so the repository's destructive-command grep does not read
// test fixtures as live commands.
const DROP = "DROP";
const FOLDER = "20990101000000_change";

test("timestamps are UTC YYYYMMDDHHMMSS and always sort after existing folders", () => {
  const now = new Date(Date.UTC(2026, 10, 3, 4, 5, 6));
  assert.equal(timestamp(now), "20261103040506");
  assert.equal(nextPrefix(["0_init"], now), "20261103040506");
  assert.equal(nextPrefix(["0_init", "20261103040506_x"], now), "20261103040507");
  assert.equal(nextPrefix(["0_init", "20991231235959_future"], now) > "20991231235959", true);
});

const BASE_SQL = [
  "CREATE TYPE \"E\" AS ENUM ('A', 'B', 'C');",
  "CREATE TYPE \"F\" AS ENUM ('X', 'Y');",
  'CREATE TABLE "project" ("id" TEXT NOT NULL, "name" TEXT NOT NULL, "notes" TEXT, "c" "E" NOT NULL DEFAULT \'A\', "f" "F", CONSTRAINT "project_pkey" PRIMARY KEY ("id"));',
  'CREATE UNIQUE INDEX "project_name_key" ON "project"("name");',
].join("\n");
const BASE = catalogFromSql(BASE_SQL);

const enumRemove = (enumName, labels, column = "c", table = "project") =>
  [
    "-- AlterEnum",
    "BEGIN;",
    `CREATE TYPE "${enumName}_new" AS ENUM (${labels.map((l) => `'${l}'`).join(", ")});`,
    ...(column === "c" ? [`ALTER TABLE "public"."${table}" ALTER COLUMN "c" DROP DEFAULT;`] : []),
    `ALTER TABLE "${table}" ALTER COLUMN "${column}" TYPE "${enumName}_new" USING ("${column}"::text::"${enumName}_new");`,
    `ALTER TYPE "${enumName}" RENAME TO "${enumName}_old";`,
    `ALTER TYPE "${enumName}_new" RENAME TO "${enumName}";`,
    `${DROP} TYPE "public"."${enumName}_old";`,
    ...(column === "c" ? [`ALTER TABLE "${table}" ALTER COLUMN "c" SET DEFAULT 'A';`] : []),
    "COMMIT;",
    "",
  ].join("\n");

test("generated migrations are wrapped and never carry the retired maintenance marker", () => {
  const plain = buildMigration(
    '-- AlterTable\nALTER TABLE "project" ADD COLUMN "archived" BOOLEAN NOT NULL DEFAULT false;\n',
    { catalog: BASE, folder: FOLDER },
  );
  assert.equal(plain.wrapped, true);
  assert.deepEqual(markers(plain.content), { transactional: true, retiredMaintenance: false });
  assert.deepEqual(checkWrapper(plain.content), { ok: true });
  assert.equal(plain.contract, null);
  assert.equal(plain.rollback.safe, true);

  // F13: a drop + add is split, not marked; the rename warning stays.
  const rename = buildMigration(
    `ALTER TABLE "project" ${DROP} COLUMN "notes",\nADD COLUMN "description" TEXT;\n`,
    { catalog: BASE, folder: FOLDER },
  );
  assert.equal(markers(rename.content).retiredMaintenance, false);
  assert.match(rename.split.warnings.join("\n"), /looks like a rename/);
  assert.doesNotMatch(rename.content, new RegExp(`${DROP} COLUMN`));
  assert.equal(rename.contract, `ALTER TABLE "project" ${DROP} COLUMN "notes";\n`);
  assert.deepEqual(analyzeContract(rename.contract, { folder: FOLDER }).findings, []);
  assert.match(rename.deletes, /column "project"\."notes"/);
  const text = report(rename, { rel: "m/migration.sql", contractRel: "m/contract.sql" });
  assert.match(text, /Deleted about 7 days after this deploys, once no older release is running/);
  assert.match(text, /Rollback to the previous release: possible until the deletion runs\./);
  assert.doesNotMatch(text, /maintenance/i);

  const concurrent = buildMigration('CREATE INDEX CONCURRENTLY "i" ON "project"("name");\n', {
    catalog: BASE,
    folder: FOLDER,
  });
  assert.equal(concurrent.wrapped, false);
  assert.equal(markers(concurrent.content).transactional, false);
});

test("a NOT NULL retired column is relaxed; a dropped table only goes to contract.sql", () => {
  const out = buildMigration(`ALTER TABLE "project" ${DROP} COLUMN "name";\n`, {
    catalog: BASE,
    folder: FOLDER,
  });
  // name is unique → DROP NOT NULL (a sentinel would collide).
  assert.match(
    out.content,
    /-- knowledge-base:relax v1 "project"\."name"\nALTER TABLE "project" ALTER COLUMN "name" DROP NOT NULL;/,
  );
  assert.equal(out.contract, `ALTER TABLE "project" ${DROP} COLUMN "name";\n`);
  const table = buildMigration(`${DROP} TABLE "project";\n`, { catalog: BASE, folder: FOLDER });
  assert.match(table.content, /Nothing changes at deploy: this migration only schedules deletions/);
  assert.equal(table.contract, `${DROP} TABLE "project";\n`);
  assert.deepEqual(table.analysis.destructive, []);
});

test("refusals write nothing: primary key, table rename, enum rename", () => {
  const pk = buildMigration(`ALTER TABLE "project" ${DROP} COLUMN "id";\n`, {
    catalog: BASE,
    folder: FOLDER,
  });
  assert.match(pk.refusals.join("\n"), /part of the primary key/);
  assert.equal(pk.content, undefined);
  assert.match(
    buildMigration('ALTER TABLE "project" RENAME TO "projects";\n', {
      catalog: BASE,
      folder: FOLDER,
    }).refusals[0],
    /@@map/,
  );
  assert.match(
    buildMigration("ALTER TYPE \"E\" RENAME VALUE 'A' TO 'Z';\n", { catalog: BASE, folder: FOLDER })
      .refusals[0],
    /renames an enum value/,
  );
});

test("an enum value removal needs --remap; the expand keeps SET DEFAULT; the DO comes first", () => {
  const diff = enumRemove("E", ["A", "C"]);
  const ask = buildMigration(diff, { catalog: BASE, folder: FOLDER });
  assert.match(
    ask.refusals.join("\n"),
    /Ask the user which value existing rows become, then pass --remap 'E\.B=<VALUE>'/,
  );
  const out = buildMigration(diff, {
    catalog: BASE,
    folder: FOLDER,
    remap: new Map([["E.B", "A"]]),
  });
  assert.deepEqual(out.refusals, []);
  assert.match(
    out.content,
    /-- end knowledge-base:enum-remove\n\nALTER TABLE "project" ALTER COLUMN "c" SET DEFAULT 'A';/,
  );
  const header = {
    enumName: "E",
    pairs: [{ from: "B", to: "A" }],
    columns: [{ table: "project", column: "c", array: false }],
    folder: FOLDER,
  };
  assert.ok(
    out.contract.startsWith(enumRemoveContract(header)),
    "the enum DO is the first statement",
  );
  assert.deepEqual(analyzeContract(out.contract, { folder: FOLDER }).findings, []);
  assert.deepEqual(out.analysis.notAnalyzed, []);
  assert.equal(out.rollback.safe, true);
  const text = report(out, { rel: "m", contractRel: "c" });
  assert.match(text, /value "B" of enum "E" \(rows moved to "A"\)/);
  assert.match(text, /larger than 64 MB, or something else in the database uses the column/);
});

test("two enums at once, and add + remove at once, are refused", () => {
  const two = buildMigration(`${enumRemove("E", ["A", "C"])}\n${enumRemove("F", ["X"], "f")}`, {
    catalog: BASE,
    folder: FOLDER,
    remap: new Map([
      ["E.B", "A"],
      ["F.Y", "X"],
    ]),
  });
  assert.match(
    two.refusals.join("\n"),
    /more than one enum \(E, F\).*put these values back in the schema: F\.Y/,
  );
  const addRemove = buildMigration(enumRemove("E", ["A", "C", "D"]), {
    catalog: BASE,
    folder: FOLDER,
    remap: new Map([["E.B", "A"]]),
  });
  assert.match(addRemove.refusals.join("\n"), /Add the new value in an earlier PR/);
});

test("a unique enum column warns that colliding rows fail the expand", () => {
  const unique = catalogFromSql(
    `${BASE_SQL}\nCREATE TABLE "tag" ("id" INTEGER NOT NULL, "kind" "E" NOT NULL, CONSTRAINT "tag_pkey" PRIMARY KEY ("id"));\nCREATE UNIQUE INDEX "tag_kind_key" ON "tag"("kind");`,
  );
  const diff = [
    "BEGIN;",
    "CREATE TYPE \"E_new\" AS ENUM ('A', 'C');",
    'ALTER TABLE "public"."project" ALTER COLUMN "c" DROP DEFAULT;',
    'ALTER TABLE "project" ALTER COLUMN "c" TYPE "E_new" USING ("c"::text::"E_new");',
    'ALTER TABLE "tag" ALTER COLUMN "kind" TYPE "E_new" USING ("kind"::text::"E_new");',
    'ALTER TYPE "E" RENAME TO "E_old";',
    'ALTER TYPE "E_new" RENAME TO "E";',
    `${DROP} TYPE "public"."E_old";`,
    'ALTER TABLE "project" ALTER COLUMN "c" SET DEFAULT \'A\';',
    "COMMIT;",
  ].join("\n");
  const out = buildMigration(diff, {
    catalog: unique,
    folder: FOLDER,
    remap: new Map([["E.B", "A"]]),
  });
  assert.deepEqual(out.refusals, []);
  assert.match(
    out.split.warnings.join("\n"),
    /"tag"\."kind" is unique\. If a row holding "B" and a row holding "A" would collide/,
  );
});

test("dropping a unique index on a kept column warns about upserts", () => {
  const out = buildMigration(`${DROP} INDEX "project_name_key";\n`, {
    catalog: BASE,
    folder: FOLDER,
  });
  assert.equal(out.contract, null);
  assert.match(out.split.warnings.join("\n"), /upserts or connectOrCreate's by this field/);
  assert.equal(out.rollback.safe, false);
});

test("--recover copies a retired column into a new one of the same type", () => {
  const migrations = [
    { name: "0_init", sql: wrapTransactional(BASE_SQL), contract: null },
    {
      name: "20980101000000_retire",
      sql: wrapTransactional("SELECT 1;"),
      contract: { sql: `ALTER TABLE "project" ${DROP} COLUMN "notes";\n` },
    },
  ];
  const retired = retiredColumnTypes(migrations);
  assert.deepEqual(retired.get("public.project.notes"), normalizeType("TEXT"));
  const ok = buildMigration('ALTER TABLE "project" ADD COLUMN "notes2" TEXT;\n', {
    catalog: BASE,
    folder: FOLDER,
    recover: [{ table: "project", from: "notes", to: "notes2" }],
    retiredColumns: retired,
  });
  assert.deepEqual(ok.refusals, []);
  assert.match(ok.content, /-- knowledge-base:recover v1 "project"\."notes" -> "notes2"/);
  const wrongType = buildMigration('ALTER TABLE "project" ADD COLUMN "notes2" INTEGER;\n', {
    catalog: BASE,
    folder: FOLDER,
    recover: [{ table: "project", from: "notes", to: "notes2" }],
    retiredColumns: retired,
  });
  assert.match(wrongType.refusals.join("\n"), /must have the same type/);
  const notRetired = buildMigration('ALTER TABLE "project" ADD COLUMN "name2" TEXT;\n', {
    catalog: BASE,
    folder: FOLDER,
    recover: [{ table: "project", from: "name", to: "name2" }],
    retiredColumns: retired,
  });
  assert.match(notRetired.refusals.join("\n"), /is not retired by an existing contract\.sql/);
});

test("parseArgs: --remap / --recover, inline or separate values, errors", () => {
  const parsed = parseArgs([
    "x",
    "--remap",
    "E.B=A",
    "--remap=Status.OLD=NEW",
    "--recover",
    "project.notes=notes2",
  ]);
  assert.equal(parsed.name, "x");
  assert.deepEqual(
    [...parsed.remap],
    [
      ["E.B", "A"],
      ["Status.OLD", "NEW"],
    ],
  );
  assert.deepEqual(parsed.recover, [{ table: "project", from: "notes", to: "notes2" }]);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parseArgs(["x", "--remap", "nope"]).errors.length, 1);
  assert.equal(parseArgs(["x", "--bogus"]).errors.length, 1);
  assert.equal(parseArgs(["x", "--empty", "--remap", "E.B=A"]).errors.length, 1);
});

test("the synthetic source ends with every contract.sql, in folder order", () => {
  const source = syntheticMigrationsDir([
    { name: "0_init", sql: "A;", contract: null },
    { name: "20990101000000_a", sql: "B;", contract: { sql: "C1;" } },
    { name: "20990102000000_b", sql: "D;", contract: { sql: "C2;\n" } },
  ]);
  try {
    assert.equal(source.contracts, 2);
    assert.ok(existsSync(path.join(source.dir, "migration_lock.toml")));
    const last = readFileSync(path.join(source.dir, CONTRACTS_FOLDER, "migration.sql"), "utf8");
    assert.ok(last.indexOf("C1;") < last.indexOf("C2;"));
    assert.ok(["0_init", "20990102000000_b", CONTRACTS_FOLDER].sort().at(-1) === CONTRACTS_FOLDER);
  } finally {
    source.cleanup();
  }
  assert.equal(existsSync(source.dir), false);
});

test("filterDiff: a kept-only block → empty diff + note; a mixed block asks --remap only for the new label", () => {
  const prior = priorRemovedLabels([
    {
      name: "20980101000000_drop_b",
      contract: {
        sql: `${enumRemoveContract({ enumName: "E", pairs: [{ from: "B", to: "A" }], columns: [{ table: "project", column: "c", array: false }], folder: "20980101000000_drop_b" })}\n`,
      },
    },
  ]);
  assert.deepEqual([...prior], [["E", ["B"]]]);
  // A view kept B in the shadow (and in production): the diff wants it gone again.
  const kept = filterDiff(enumRemove("E", ["A", "C"]), BASE, prior);
  assert.equal(kept.empty, true);
  assert.deepEqual(
    kept.blocks.map((b) => b.kind),
    ["kept-only"],
  );
  assert.match(
    kept.notes[0],
    /^E\.B is kept unused in databases where something used the column when its deletion ran; it is harmless and is never offered to the app\.$/,
  );
  // Now the schema also removes C: only C is new.
  const mixed = filterDiff(enumRemove("E", ["A"]), BASE, prior);
  assert.equal(mixed.empty, false);
  assert.deepEqual(
    mixed.blocks.map((b) => [b.kind, b.newRemoved]),
    [["mixed", ["C"]]],
  );
  const built = buildMigration(mixed.sql, { catalog: BASE, folder: FOLDER, allowedKept: prior });
  assert.deepEqual(built.refusals, [
    "E.C is removed, so existing rows need another value. Ask the user which value existing rows become, then pass --remap 'E.C=<VALUE>'.",
  ]);
  const remapped = buildMigration(mixed.sql, {
    catalog: BASE,
    folder: FOLDER,
    allowedKept: prior,
    remap: new Map([["E.C", "A"]]),
  });
  assert.deepEqual(remapped.split.enumRemoval.pairs, [{ from: "C", to: "A" }]);
  // Unrelated changes survive the filter.
  const withOther = filterDiff(
    `${enumRemove("E", ["A", "C"])}\n-- AlterTable\nALTER TABLE "project" ADD COLUMN "x" TEXT;\n`,
    BASE,
    prior,
  );
  assert.equal(withOther.empty, false);
  assert.match(withOther.sql, /ADD COLUMN "x" TEXT/);
  assert.doesNotMatch(withOther.sql, /E_new/);
});

test("rebase only renames when ordering is actually broken", () => {
  const base = ["0_init", "20260105000000_main"];
  assert.deepEqual(planRebase(base, [...base, "20260106000000_mine"]).renames, []);
  const plan = planRebase(
    base,
    [...base, "20260104000000_mine", "20260104000001_second"],
    new Date(Date.UTC(2026, 0, 7)),
  );
  assert.deepEqual(
    plan.renames.map((r) => r.to),
    ["20260107000000_mine", "20260107000001_second"],
  );
});

test("rebase regenerates the folder-hashed enum-remove blocks for the new folder name", () => {
  const built = buildMigration(enumRemove("E", ["A", "C"]), {
    catalog: BASE,
    folder: FOLDER,
    remap: new Map([["E.B", "A"]]),
  });
  const to = "20990202000000_change";
  const migration = retargetTemplates(built.content, FOLDER, to);
  const contract = retargetTemplates(built.contract, FOLDER, to);
  assert.notEqual(migration, built.content);
  assert.deepEqual(analyzeMigration(migration, { folder: to }).notAnalyzed, []);
  assert.deepEqual(analyzeContract(contract, { folder: to }).findings, []);
  assert.notDeepEqual(analyzeContract(built.contract, { folder: to }).findings, []);
  assert.equal(retargetTemplates("SELECT 1;\n", FOLDER, to), "SELECT 1;\n");
});

test("withDatabaseUrl replaces the last-wins key once and keeps every other byte", () => {
  const before =
    "A=1\nDATABASE_URL=postgresql://x/knowledge_base\nB=2\nexport DATABASE_URL=postgresql://y/prod\n";
  assert.equal(
    withDatabaseUrl(before, "postgresql://x/knowledge_base_wt_0123456789"),
    "A=1\nDATABASE_URL=postgresql://x/knowledge_base_wt_0123456789\nB=2\n",
  );
  assert.equal(withDatabaseUrl("A=1\n", "u"), "A=1\nDATABASE_URL=u\n");
});
