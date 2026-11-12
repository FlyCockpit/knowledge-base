import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import {
  analyzeContract,
  analyzeMigration,
  COMMIT_MARKER_STATEMENT,
  CONTRACT_FILE,
  catalogFromSql,
  checkWrapper,
  classifyEnumRebuild,
  enumColumns,
  enumDefaultNamesRemoved,
  enumRemoveContract,
  enumRemoveExpand,
  findEnumRebuilds,
  findNameReuse,
  formatEnumRemoveHeader,
  HISTORY_CAPTURE_STATEMENT,
  INTENTIONAL_MARKER,
  isWidening,
  LATEST_TEMPLATE_VERSION,
  markers,
  multiEnumRefusal,
  normalizeType,
  parseTemplateHeader,
  RETIRED_MAINTENANCE_MARKER,
  REVIEWED_MARKER,
  recoverBlock,
  relax,
  relaxFor,
  rollbackSafety,
  splitForContract,
  splitStatements,
  stripBareTransactionControl,
  summarizeEffects,
  syncTriggerName,
  TEMPLATES,
  TRANSACTIONAL_MARKER,
  tableColumns,
  typeOfFromCatalog,
  unwrapBody,
  wrapTransactional,
} from "./sql.mjs";

// Built from parts so the repository's destructive-command grep does not read
// test fixtures as live commands.
const DROP = "DROP";

// Prisma 7.10.1's exact `migrate diff --script` text for removing E.B from
// enum E (columns T.c with a default, T.d without, T.tags E[] with a default,
// U.c), recorded in the Step 0 b spike. It writes the TARGET default inside
// the block and repeats the changed ones in a separate `-- AlterTable`.
const PRISMA_ENUM_REMOVE = [
  "-- AlterEnum",
  "BEGIN;",
  "CREATE TYPE \"E_new\" AS ENUM ('A', 'C');",
  'ALTER TABLE "public"."T" ALTER COLUMN "c" DROP DEFAULT;',
  'ALTER TABLE "public"."T" ALTER COLUMN "tags" DROP DEFAULT;',
  'ALTER TABLE "public"."U" ALTER COLUMN "c" DROP DEFAULT;',
  'ALTER TABLE "T" ALTER COLUMN "c" TYPE "E_new" USING ("c"::text::"E_new");',
  'ALTER TABLE "T" ALTER COLUMN "d" TYPE "E_new" USING ("d"::text::"E_new");',
  'ALTER TABLE "T" ALTER COLUMN "tags" TYPE "E_new"[] USING ("tags"::text::"E_new"[]);',
  'ALTER TABLE "U" ALTER COLUMN "c" TYPE "E_new" USING ("c"::text::"E_new");',
  'ALTER TYPE "E" RENAME TO "E_old";',
  'ALTER TYPE "E_new" RENAME TO "E";',
  `${DROP} TYPE "public"."E_old";`,
  'ALTER TABLE "T" ALTER COLUMN "c" SET DEFAULT \'C\';',
  'ALTER TABLE "T" ALTER COLUMN "tags" SET DEFAULT ARRAY[\'C\']::"E"[];',
  'ALTER TABLE "U" ALTER COLUMN "c" SET DEFAULT \'A\';',
  "COMMIT;",
  "",
  "-- AlterTable",
  'ALTER TABLE "T" ALTER COLUMN "c" SET DEFAULT \'C\',',
  'ALTER COLUMN "tags" SET DEFAULT ARRAY[\'C\']::"E"[];',
  "",
].join("\n");

// The schema before that diff, as `migrate diff --from-empty` prints it.
const ENUM_BASE = [
  "CREATE TYPE \"E\" AS ENUM ('A', 'B', 'C');",
  "CREATE TYPE \"F\" AS ENUM ('X', 'Y');",
  'CREATE TABLE "T" (',
  '    "id" INTEGER NOT NULL,',
  '    "c" "E" NOT NULL DEFAULT \'B\',',
  '    "d" "E",',
  '    "tags" "E"[] DEFAULT ARRAY[\'B\', \'C\']::"E"[],',
  '    "f" "F" NOT NULL DEFAULT \'X\',',
  '    "notes" TEXT NOT NULL,',
  '    CONSTRAINT "T_pkey" PRIMARY KEY ("id")',
  ");",
  'CREATE TABLE "U" (',
  '    "id" INTEGER NOT NULL,',
  '    "c" "E" NOT NULL DEFAULT \'A\',',
  '    CONSTRAINT "U_pkey" PRIMARY KEY ("id")',
  ");",
].join("\n");

describe("splitStatements", () => {
  test("splits on semicolons outside quotes, comments, and dollar bodies", () => {
    const sql = [
      "-- lead comment",
      "SELECT 'a;b', \"we;ird\";",
      "/* block; /* nested; */ */ SELECT E'it\\'s;';",
      "CREATE FUNCTION f() RETURNS int AS $body$ SELECT 1; $body$ LANGUAGE sql;",
      "SELECT 'one'",
      "'two';",
    ].join("\n");
    const parsed = splitStatements(sql);
    assert.equal(parsed.length, 4);
    assert.deepEqual(parsed[0].comments, ["-- lead comment"]);
    assert.equal(parsed[2].opaque, true);
    assert.equal(parsed[1].opaque, false);
    assert.equal(parsed[3].tokens.join(" "), "SELECT <literal>");
  });

  test("rejects unterminated forms", () => {
    assert.throws(() => splitStatements("SELECT 'open"));
    assert.throws(() => splitStatements("SELECT $x$ open"));
    assert.throws(() => splitStatements("/* open"));
  });
});

describe("wrapper", () => {
  const body = 'ALTER TABLE "user" ADD COLUMN "x" TEXT;';
  test("wrapTransactional output passes checkWrapper and round-trips the body", () => {
    const wrapped = wrapTransactional(body);
    assert.ok(wrapped.startsWith(`${TRANSACTIONAL_MARKER}\nBEGIN;`));
    assert.deepEqual(checkWrapper(wrapped), { ok: true });
    assert.deepEqual(markers(wrapped), { transactional: true, retiredMaintenance: false });
    assert.match(unwrapBody(wrapped), /SET LOCAL lock_timeout = '5s';[\s\S]*ADD COLUMN "x" TEXT;/);
  });

  test("detects the retired maintenance marker anywhere in the file", () => {
    const wrapped = wrapTransactional(body);
    const header = wrapped.replace(
      `${TRANSACTIONAL_MARKER}\n`,
      `${TRANSACTIONAL_MARKER}\n${RETIRED_MAINTENANCE_MARKER}\n`,
    );
    assert.equal(markers(header).retiredMaintenance, true);
    assert.equal(markers(`${wrapped}\n${RETIRED_MAINTENANCE_MARKER}\n`).retiredMaintenance, true);
    assert.equal(markers(`${RETIRED_MAINTENANCE_MARKER}\n${body}`).retiredMaintenance, true);
  });

  test("detects a broken wrapper", () => {
    const wrapped = wrapTransactional(body);
    assert.equal(checkWrapper(wrapped.replace("COMMIT;", "")).ok, false);
    assert.equal(checkWrapper(wrapped.replace(TRANSACTIONAL_MARKER, "-- something")).ok, false);
    assert.equal(checkWrapper(wrapped.replace(body, `${body}\nCOMMIT;\nBEGIN;`)).ok, false);
    assert.equal(
      checkWrapper(wrapped.replace(body, 'CREATE INDEX CONCURRENTLY "i" ON "user"("x");')).ok,
      false,
    );
    assert.equal(checkWrapper(`${wrapped}SELECT 1;\n`).ok, false);
  });

  test("requires the commit marker as the last statement before COMMIT", () => {
    const wrapped = wrapTransactional(body);
    assert.ok(wrapped.includes(`${COMMIT_MARKER_STATEMENT}\nCOMMIT;`));
    const withoutMarker = wrapped.replace(COMMIT_MARKER_STATEMENT, "");
    assert.equal(checkWrapper(withoutMarker).ok, false);
    const markerNotLast = wrapped.replace(
      `${COMMIT_MARKER_STATEMENT}\n`,
      `${COMMIT_MARKER_STATEMENT}\nSELECT 1;\n`,
    );
    assert.equal(checkWrapper(markerNotLast).ok, false);
    const editedMarker = wrapped.replace("'knowledge-base:committed'", "'knowledge-base:other'");
    assert.equal(checkWrapper(editedMarker).ok, false);
    // The marker no longer depends on search_path, so the body may change it
    // (and may use the word freely), but it may not reset the captured setting.
    for (const ok of [
      "SET LOCAL search_path = other;",
      "SET LOCAL SCHEMA 'pg_catalog';",
      'ALTER TABLE "user" ADD COLUMN "search_path" TEXT DEFAULT \'search_path\';',
    ])
      assert.deepEqual(checkWrapper(wrapped.replace(body, `${ok}\n${body}`)), { ok: true }, ok);
    for (const bad of [
      "RESET ALL;",
      "RESET knowledge_base.history;",
      "SET LOCAL knowledge_base.history = '';",
      "SELECT set_config('knowledge_base.history', '', true);",
      "DISCARD ALL;",
    ])
      assert.equal(checkWrapper(wrapped.replace(body, `${bad}\n${body}`)).ok, false, bad);
    // The preamble (including the history capture) must stay as generated.
    const noCapture = wrapped.replace(HISTORY_CAPTURE_STATEMENT, "SELECT 1;");
    assert.equal(checkWrapper(noCapture).ok, false);
  });

  test("strips Prisma's enum-rebuild BEGIN/COMMIT so ours is the only transaction", () => {
    const stripped = stripBareTransactionControl(PRISMA_ENUM_REMOVE);
    assert.doesNotMatch(stripped, /^BEGIN;|^COMMIT;/m);
    assert.match(stripped, /-- AlterEnum/);
    const wrapped = wrapTransactional(stripped);
    assert.deepEqual(checkWrapper(wrapped), { ok: true });
  });
});

describe("analyzeMigration", () => {
  test("Prisma's drop+add in one ALTER TABLE is a probable rename and incompatible with the running release", () => {
    const sql = 'ALTER TABLE "project" DROP COLUMN "notes",\nADD COLUMN     "description" TEXT;';
    const result = analyzeMigration(sql);
    assert.equal(result.renames.length, 1);
    assert.match(result.renames[0].message, /looks like a rename/);
    assert.deepEqual(
      result.destructive.map((d) => d.kind),
      ["drop-column"],
    );
    assert.equal(result.incompatible.length, 1);
  });

  test("the intentional marker suppresses the rename finding, not the destructive report", () => {
    const sql = `${INTENTIONAL_MARKER}\nALTER TABLE "project" DROP COLUMN "notes", ADD COLUMN "description" TEXT;`;
    const result = analyzeMigration(sql);
    assert.equal(result.renames.length, 0);
    assert.equal(result.destructive.length, 1);
  });

  test("RENAME COLUMN with a backfill is not destructive but is incompatible with the running release", () => {
    const sql = wrapTransactional(
      'ALTER TABLE "project" RENAME COLUMN "notes" TO "description";\nUPDATE "project" SET "description" = \'\' WHERE "description" IS NULL;',
    );
    const result = analyzeMigration(sql);
    assert.equal(result.destructive.length, 0);
    assert.equal(result.renames.length, 0);
    assert.equal(result.notAnalyzed.length, 0);
    assert.match(result.incompatible[0].what, /renames "project"."notes" to "description"/);
  });

  test("type changes, dropped tables, and constraint drops not re-added are destructive", () => {
    const sql = [
      'ALTER TABLE "user" ALTER COLUMN "age" SET DATA TYPE INTEGER;',
      `${DROP} TABLE "legacy";`,
      'ALTER TABLE "a" DROP CONSTRAINT "a_fkey";',
      'ALTER TABLE "b" DROP CONSTRAINT "b_pkey", ADD CONSTRAINT "b_pkey" PRIMARY KEY ("id");',
    ].join("\n");
    const kinds = analyzeMigration(sql)
      .destructive.map((d) => d.kind)
      .sort();
    assert.deepEqual(kinds, ["alter-type", "drop-constraint", "drop-table"]);
  });

  test("columns created in the same migration are not incompatible", () => {
    const sql =
      'CREATE TABLE "t" ("id" TEXT NOT NULL);\nALTER TABLE "t" ALTER COLUMN "id" TYPE VARCHAR(10);';
    assert.equal(analyzeMigration(sql).incompatible.length, 0);
  });

  test("dropping a table and creating a similar one is a probable rename", () => {
    const known = tableColumns(['CREATE TABLE "post" ("id" TEXT, "title" TEXT, "body" TEXT);']);
    const sql = `${DROP} TABLE "post";\nCREATE TABLE "article" ("id" TEXT, "title" TEXT, "body" TEXT);`;
    assert.equal(analyzeMigration(sql, { knownTables: known }).renames.length, 1);
    const different = `${DROP} TABLE "post";\nCREATE TABLE "audit" ("at" TIMESTAMP, "who" TEXT);`;
    assert.equal(analyzeMigration(different, { knownTables: known }).renames.length, 0);
  });

  test("dollar-quoted and DO statements are reported as not analyzed", () => {
    const sql = "DO $$ BEGIN PERFORM 1; END $$;\nSELECT 1;";
    const result = analyzeMigration(sql);
    assert.equal(result.notAnalyzed.length, 1);
    assert.equal(result.notAnalyzed[0].reviewed, null);
    assert.equal(result.statements, 2);
  });

  test("ADD COLUMN IF NOT EXISTS on an existing column does not make a rename look new", () => {
    const known = tableColumns(['CREATE TABLE "project" ("id" TEXT, "notes" TEXT);']);
    const sql =
      'ALTER TABLE "project" ADD COLUMN IF NOT EXISTS "notes" TEXT;\nALTER TABLE "project" RENAME COLUMN "notes" TO "description";';
    const result = analyzeMigration(sql, { knownTables: known });
    assert.match(result.incompatible[0]?.what ?? "", /renames "project"."notes"/);
    // A genuinely new column renamed in the same file is not incompatible.
    const fresh =
      'ALTER TABLE "project" ADD COLUMN "draft" TEXT;\nALTER TABLE "project" RENAME COLUMN "draft" TO "summary";';
    assert.equal(analyzeMigration(fresh, { knownTables: known }).incompatible.length, 0);
  });

  test("CREATE TABLE IF NOT EXISTS on an existing table does not exempt its changes", () => {
    const known = tableColumns(['CREATE TABLE "project" ("id" TEXT, "notes" TEXT);']);
    const sql =
      'CREATE TABLE IF NOT EXISTS "project" ("id" TEXT);\nALTER TABLE "project" DROP COLUMN "notes";';
    assert.equal(analyzeMigration(sql, { knownTables: known }).incompatible.length, 1);
  });

  test("dropping and recreating a table under the same name needs the intentional marker", () => {
    const known = tableColumns(['CREATE TABLE "post" ("id" TEXT, "title" TEXT);']);
    const sql = `${DROP} TABLE "post";\nCREATE TABLE "post" ("id" TEXT, "title" TEXT);`;
    const result = analyzeMigration(sql, { knownTables: known });
    assert.equal(result.renames.length, 1);
    assert.match(result.renames[0].message, /created again under the same name/);
    const marked = `${INTENTIONAL_MARKER}\n${DROP} TABLE "post";\nCREATE TABLE "post" ("id" TEXT);`;
    assert.equal(analyzeMigration(marked, { knownTables: known }).renames.length, 0);
  });

  test("drop then CREATE TABLE IF NOT EXISTS under the same name is a recreation", () => {
    const known = tableColumns(['CREATE TABLE "post" ("id" TEXT, "title" TEXT);']);
    const sql = `${DROP} TABLE "post";\nCREATE TABLE IF NOT EXISTS "post" ("id" TEXT, "title" TEXT);`;
    const result = analyzeMigration(sql, { knownTables: known });
    assert.match(result.renames[0]?.message ?? "", /created again under the same name/);
  });

  test("enum renames are incompatible; added values are not", () => {
    const rename = analyzeMigration("ALTER TYPE \"Role\" RENAME VALUE 'ADMIN' TO 'OWNER';");
    assert.match(rename.incompatible[0]?.what ?? "", /renames a value of enum "Role"/);
    assert.equal(rename.notAnalyzed.length, 0);
    const added = analyzeMigration("ALTER TYPE \"Role\" ADD VALUE 'GUEST';");
    assert.equal(added.incompatible.length + added.notAnalyzed.length, 0);
    const created = analyzeMigration(
      'CREATE TYPE "Tmp" AS ENUM (\'A\');\nALTER TYPE "Tmp" RENAME TO "Kind";',
    );
    assert.equal(created.incompatible.length, 0);
  });

  test("statements the analyzer does not recognize are reported, never silently passed", () => {
    const result = analyzeMigration(
      [
        'CREATE VIEW "v" AS SELECT 1;',
        'ALTER TABLE "project" SET SCHEMA "archive";',
        'ALTER TYPE "Role" OWNER TO someone;',
        'CREATE INDEX "i" ON "project"("id");',
        COMMIT_MARKER_STATEMENT,
      ].join("\n"),
    );
    assert.deepEqual(
      result.notAnalyzed.map((n) => n.line),
      [1, 2, 3],
    );
  });

  test("cascading drops are destructive and incompatible", () => {
    for (const statement of [
      `${DROP} SEQUENCE "project_id_seq" CASCADE;`,
      `${DROP} TYPE "Role" CASCADE;`,
    ]) {
      const result = analyzeMigration(statement);
      assert.equal(result.destructive[0]?.kind, "drop-cascade", statement);
      assert.equal(result.incompatible.length, 1, statement);
    }
    assert.equal(analyzeMigration(`${DROP} TYPE "Role";`).notAnalyzed.length, 0);
  });

  test("only known ALTER COLUMN forms are treated as analyzed", () => {
    const known = analyzeMigration(
      'ALTER TABLE "p" ALTER COLUMN "a" SET DEFAULT 1, ALTER COLUMN "b" DROP NOT NULL;',
    );
    assert.equal(known.notAnalyzed.length, 0);
    const unknown = analyzeMigration('ALTER TABLE "p" ALTER COLUMN "id" DROP IDENTITY;');
    assert.equal(unknown.notAnalyzed.length, 1);
  });

  test("a no-op CREATE TABLE IF NOT EXISTS keeps the known columns", () => {
    const known = tableColumns([
      'CREATE TABLE "project" ("id" TEXT, "notes" TEXT);',
      'CREATE TABLE IF NOT EXISTS "project" ("id" TEXT);',
    ]);
    assert.ok(known.get("public.project")?.has("notes"));
  });

  test("unlexable SQL is visibly not analyzed", () => {
    const result = analyzeMigration("SELECT 'open");
    assert.ok(result.lexError);
    assert.equal(result.notAnalyzed.length, 1);
  });
});

describe("summarizeEffects", () => {
  test("collects renames, drops, updates, and row removals", () => {
    const effects = summarizeEffects(
      [
        'ALTER TABLE "project" RENAME COLUMN "notes" TO "description";',
        'ALTER TABLE "old" RENAME TO "new";',
        'UPDATE "user" SET "name" = lower("name"), "email" = "email" WHERE true;',
        'DELETE FROM "session" WHERE "expiresAt" < now();',
        'ALTER TABLE "user" DROP COLUMN "image";',
      ].join("\n"),
    );
    assert.equal(effects.columnRenames.get("public.project.notes"), "description");
    assert.equal(effects.tableRenames.get("public.old"), "public.new");
    assert.ok(effects.updatedColumns.has("public.user.name"));
    assert.ok(effects.updatedColumns.has("public.user.email"));
    assert.ok(effects.rowsRemoved.has("public.session"));
    assert.ok(effects.droppedColumns.has("public.user.image"));
  });

  test("accepts contract SQL, including the enum template", () => {
    const effects = summarizeEffects(
      `${enumRemoveContract(HEADER)}\nALTER TABLE "t" ${DROP} COLUMN "x";\n${DROP} TYPE "Old";\n`,
      { folder: FOLDER },
    );
    assert.equal(effects.opaque, false);
    assert.deepEqual(effects.enumValuesRemoved, [
      { enum: "public.Status", removed: ["OLD"], mapped: ["NEW"] },
    ]);
    assert.ok(effects.droppedColumns.has("public.t.x"));
    assert.ok(effects.droppedTypes.has("public.Old"));
    assert.ok(effects.updatedColumns.has("public.t.tags"));
  });
});

// ---------------------------------------------------------------------------
// Expand / contract
// ---------------------------------------------------------------------------

const FOLDER = "20990101000000_remove_old";
const HEADER = {
  enumName: "Status",
  pairs: [{ from: "OLD", to: "NEW" }],
  columns: [
    { table: "t", column: "c", array: false },
    { table: "t", column: "tags", array: true },
  ],
  folder: FOLDER,
};
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const expandOf = (header = HEADER) => enumRemoveExpand(header);

describe("templates (v1)", () => {
  test("the v1 text is pinned byte for byte (never edit a released template: add v2)", () => {
    assert.equal(LATEST_TEMPLATE_VERSION, "v1");
    assert.deepEqual(Object.keys(TEMPLATES), ["v1"]);
    assert.equal(
      sha256(TEMPLATES.v1.enumRemoveExpand(HEADER)),
      "83499cf5e4fd9a127cd6087d9b9f1c6c0da927ca66d7760c9e37926eb8886c65",
    );
    assert.equal(
      sha256(TEMPLATES.v1.enumRemoveContract(HEADER)),
      "6a9cd9f9ca58d581bdd67ec3fb49e81ecfc7e1c8d69a839c036d068fc5bf24d6",
    );
    assert.equal(
      sha256(TEMPLATES.v1.recoverBlock({ table: "t", from: "x", to: "x2" })),
      "96bac344e18928fa7714f55ec7e85394a435802423ea0005676ca44e418918c1",
    );
    assert.equal(
      sha256(TEMPLATES.v1.relax({ table: "t", column: "x", sentinel: "''" })),
      "ec993641044a945dffc4b55d52395c59211881c57324cb83fc65d86bffb472d7",
    );
    assert.equal(
      expandOf().split("\n").slice(0, 2).join("\n"),
      `-- knowledge-base:enum-remove v1 "Status" "OLD"->"NEW" columns "t"."c", "t"."tags"[]\nCREATE FUNCTION "knowledge_base_sync_b777ef7e"() RETURNS trigger LANGUAGE plpgsql AS $knowledge_base$`,
    );
    assert.equal(syncTriggerName(FOLDER, "t"), "knowledge_base_sync_b777ef7e");
  });

  test("headers round-trip, including quotes in names", () => {
    const odd = {
      version: "v1",
      enumName: 'Sta"tus',
      pairs: [
        { from: "it's", to: 'we"ll' },
        { from: "B", to: "A" },
      ],
      columns: [
        { table: 'ta"ble', column: "it's", array: false },
        { table: "t", column: "tags", array: true },
      ],
    };
    const line = formatEnumRemoveHeader(odd);
    assert.deepEqual(parseTemplateHeader(line), { kind: "enum-remove", ...odd });
    assert.deepEqual(parseTemplateHeader('-- knowledge-base:recover v1 "t"."x" -> "x2"'), {
      kind: "recover",
      version: "v1",
      table: "t",
      from: "x",
      to: "x2",
    });
    assert.deepEqual(parseTemplateHeader('-- knowledge-base:relax v1 "t"."x"'), {
      kind: "relax",
      version: "v1",
      table: "t",
      column: "x",
    });
    assert.equal(parseTemplateHeader("-- knowledge-base:enum-removed v1"), null);
    assert.equal(parseTemplateHeader('-- knowledge-base:enum-remove "E"').malformed, true);
    // The generated SQL quotes the odd names and still verifies.
    const sql = wrapTransactional(enumRemoveExpand({ ...odd, folder: FOLDER }));
    const result = analyzeMigration(sql, { folder: FOLDER });
    assert.deepEqual(result.notAnalyzed, []);
    assert.equal(result.templates[0]?.kind, "enum-remove");
    assert.match(sql, /r->>'it''s' = 'it''s'/);
    assert.match(sql, /ON "ta""ble"/);
  });

  test("the expand block and contract are recognized, analyzed, and never notAnalyzed", () => {
    const migration = wrapTransactional(
      `${expandOf()}\nALTER TABLE "t" ALTER COLUMN "c" SET DEFAULT 'NEW';`,
    );
    const result = analyzeMigration(migration, { folder: FOLDER });
    assert.deepEqual(result.notAnalyzed, []);
    assert.deepEqual(
      result.templates.map((t) => t.kind),
      ["enum-remove"],
    );
    const contract = analyzeContract(`${enumRemoveContract(HEADER)}\n`, { folder: FOLDER });
    assert.deepEqual(contract.findings, []);
    assert.equal(contract.template?.enumName, "Status");
  });

  test("without the folder name, or edited by hand, the block is not analyzed", () => {
    const migration = wrapTransactional(expandOf());
    const noFolder = analyzeMigration(migration);
    assert.ok(noFolder.notAnalyzed.some((n) => /folder name/.test(n.reason)));
    const tampered = migration.replace("RETURN NEW;", "RETURN NULL;");
    const result = analyzeMigration(tampered, { folder: FOLDER });
    assert.ok(result.notAnalyzed.some((n) => /does not match the generated text/.test(n.reason)));
    assert.equal(result.templates.length, 0);
    const wrongFolder = analyzeMigration(migration, { folder: "20990101000001_other" });
    assert.ok(wrongFolder.notAnalyzed.some((n) => /does not match/.test(n.reason)));
  });

  test("an unknown template version is notAnalyzed and cannot be annotated", () => {
    const v2 = wrapTransactional(
      `${REVIEWED_MARKER} looks fine\n${expandOf().replace("enum-remove v1", "enum-remove v2")}`,
    );
    const result = analyzeMigration(v2, { folder: FOLDER });
    const entry = result.notAnalyzed.find((n) => /template v2 not known/.test(n.reason));
    assert.ok(entry);
    assert.equal(entry.reviewed, null);
    assert.equal(entry.template, true);
    const contract = analyzeContract(
      enumRemoveContract(HEADER).replace("enum-remove v1", "enum-remove v2"),
      { folder: FOLDER },
    );
    assert.match(
      contract.findings[0]?.message ?? "",
      /template v2 not known to this image: deploy a newer image/,
    );
  });

  test("the jsonb sync body never types an expression by the enum", () => {
    const body = expandOf().split("\n").slice(1).join("\n");
    assert.doesNotMatch(body, /"Status"/);
    assert.doesNotMatch(body, /::\s*"?Status/);
    assert.match(body, /to_jsonb\(NEW\)/);
    assert.match(body, /jsonb_populate_record\(NEW, p\)/);
    assert.match(body, /CASE e WHEN '"OLD"' THEN '"NEW"'::jsonb ELSE e END/);
  });

  test("the contract has the three arms, the elapsed guard and the refresh loop inside the rebuild", () => {
    const text = enumRemoveContract(HEADER);
    const rebuild = text.indexOf("  BEGIN\n    SELECT array_agg(e.enumlabel");
    const handler = text.indexOf(
      "  EXCEPTION\n    WHEN lock_not_available OR deadlock_detected THEN\n      RAISE;",
    );
    const refresh = text.indexOf(
      "FOR f IN SELECT p.oid::regprocedure AS sig, p.prosecdef FROM pg_proc p",
    );
    assert.ok(
      rebuild > 0 && refresh > rebuild && handler > refresh,
      "refresh loop sits inside the sub-block",
    );
    assert.match(
      text,
      /WHEN query_canceled THEN\n {6}IF current_setting\('statement_timeout'\) IN \('0', ''\)/,
    );
    assert.match(
      text,
      /clock_timestamp\(\) - statement_timestamp\(\)\n\s+< current_setting\('statement_timeout'\)::interval - interval '1 second'/,
    );
    assert.match(
      text,
      /WHEN OTHERS THEN\n\s+FOREACH lbl IN ARRAY removed LOOP\n\s+RAISE NOTICE 'knowledge-base:label-kept/,
    );
    assert.match(
      text,
      /EXECUTE format\('ALTER ROUTINE %s %s', f\.sig,\n\s+CASE WHEN f\.prosecdef THEN 'SECURITY DEFINER' ELSE 'SECURITY INVOKER' END\)/,
    );
    assert.doesNotMatch(text, /\bCOST\b/);
    assert.doesNotMatch(text, /ALTER FUNCTION/);
    assert.match(text, /max_bytes bigint := 67108864;/);
    assert.ok(text.startsWith(`${formatEnumRemoveHeader(HEADER)}\nDO $knowledge_base_enum$\n`));
    assert.ok(text.endsWith("END $knowledge_base_enum$;"));
  });

  test("names with $ or line breaks are refused, and enum templates need the folder", () => {
    assert.throws(() => enumRemoveExpand({ ...HEADER, enumName: "a$b" }), /unsupported character/);
    assert.throws(() => enumRemoveContract({ ...HEADER, folder: undefined }), /folder name/);
  });

  test("recover round-trips and is recognized", () => {
    const block = recoverBlock({ table: "t", from: "x", to: "x2" });
    const result = analyzeMigration(wrapTransactional(block));
    assert.deepEqual(result.notAnalyzed, []);
    assert.equal(result.templates[0]?.kind, "recover");
    assert.match(block, /RAISE WARNING 'knowledge-base:recover "t"\."x" was already deleted'/);
    assert.ok(
      analyzeMigration(wrapTransactional(block.replace("IS NULL AND", "IS NULL OR"))).notAnalyzed
        .length,
    );
  });

  test("relax statements are recognized; a marker on another statement is not", () => {
    for (const sentinel of [null, "''", "0", "false", "'{}'", "'A'"]) {
      const result = analyzeMigration(relax({ table: "t", column: "x", sentinel }));
      assert.deepEqual(result.notAnalyzed, [], String(sentinel));
      assert.equal(result.templates[0]?.kind, "relax");
    }
    const wrong = analyzeMigration(
      '-- knowledge-base:relax v1 "t"."x"\nALTER TABLE "t" ALTER COLUMN "x" SET NOT NULL;',
    );
    assert.ok(wrong.notAnalyzed.some((n) => /not the generated relax/.test(n.reason)));
    const unknown = analyzeMigration(
      '-- knowledge-base:relax v9 "t"."x"\nALTER TABLE "t" ALTER COLUMN "x" DROP NOT NULL;',
    );
    assert.ok(unknown.notAnalyzed.some((n) => /template v9 not known/.test(n.reason)));
  });
});

describe("normalizeType and widening", () => {
  test("SQL text and information_schema rows normalise the same way", () => {
    assert.deepEqual(
      normalizeType("VARCHAR(50)"),
      normalizeType({
        data_type: "character varying",
        character_maximum_length: 50,
        udt_name: "varchar",
      }),
    );
    assert.deepEqual(normalizeType("character varying(50)"), {
      base: "varchar",
      length: 50,
      array: false,
    });
    assert.deepEqual(
      normalizeType("numeric(10,2)"),
      normalizeType({
        data_type: "numeric",
        numeric_precision: 10,
        numeric_scale: 2,
        udt_name: "numeric",
      }),
    );
    assert.deepEqual(normalizeType('"E"[]'), normalizeType({ udt_name: "_E" }));
    assert.deepEqual(normalizeType('"E"[]'), normalizeType({ data_type: "ARRAY", udt_name: "_E" }));
    assert.deepEqual(normalizeType('"public"."E"[]'), { base: "E", array: true });
    assert.deepEqual(
      normalizeType("TIMESTAMP(3)"),
      normalizeType({
        data_type: "timestamp without time zone",
        datetime_precision: 3,
        udt_name: "timestamp",
      }),
    );
    assert.deepEqual(normalizeType("timestamp with time zone"), {
      base: "timestamptz",
      precision: 6,
      array: false,
    });
    assert.deepEqual(normalizeType("INTEGER"), { base: "int4", array: false });
    assert.deepEqual(normalizeType("text ARRAY"), { base: "text", array: true });
  });

  test("only the allowlisted widenings, without USING or arrays", () => {
    const t = normalizeType;
    assert.equal(isWidening(t("varchar(10)"), t("varchar(20)")), true);
    assert.equal(isWidening(t("varchar(10)"), t("varchar(10)")), true);
    assert.equal(isWidening(t("varchar(10)"), t("text")), true);
    assert.equal(isWidening(t("numeric(10,2)"), t("numeric(12,2)")), true);
    assert.equal(isWidening(t("varchar(20)"), t("varchar(10)")), false);
    assert.equal(isWidening(t("numeric(10,2)"), t("numeric(12,3)")), false);
    assert.equal(isWidening(t("numeric"), t("numeric(12,2)")), false);
    assert.equal(isWidening(t("integer"), t("bigint")), false);
    assert.equal(isWidening(t("text"), t("varchar(10)")), false);
    assert.equal(isWidening(t("varchar(10)"), t("text"), { using: true }), false);
    assert.equal(isWidening(t("varchar(10)[]"), t("text[]")), false);
    assert.equal(isWidening(t("varchar(10)"), t("text"), { array: true }), false);
  });

  test("analyzeMigration's typeOf removes widenings and same-run alters from incompatible", () => {
    const base = catalogFromSql('CREATE TABLE "t" ("a" VARCHAR(10), "b" INTEGER);');
    const run = catalogFromSql('ALTER TABLE "t" ADD COLUMN "c" INTEGER;', base);
    const typeOf = typeOfFromCatalog(run);
    assert.equal(typeOf("public.t", "c")?.newInRun, true);
    assert.equal(typeOf("public.t", "a")?.newInRun, false);
    const widen = 'ALTER TABLE "t" ALTER COLUMN "a" SET DATA TYPE VARCHAR(20);';
    assert.equal(analyzeMigration(widen, { typeOf }).incompatible.length, 0);
    assert.equal(analyzeMigration(widen).incompatible.length, 1);
    assert.equal(
      analyzeMigration('ALTER TABLE "t" ALTER COLUMN "a" TYPE TEXT USING "a"::text;', { typeOf })
        .incompatible.length,
      1,
    );
    assert.equal(
      analyzeMigration('ALTER TABLE "t" ALTER COLUMN "b" TYPE BIGINT;', { typeOf }).incompatible
        .length,
      1,
    );
    assert.equal(
      analyzeMigration('ALTER TABLE "t" ALTER "c" TYPE BIGINT;', { typeOf }).incompatible.length,
      0,
    );
  });
});

describe("catalogFromSql", () => {
  test("folds tables, constraints, indexes and enums", () => {
    const catalog = catalogFromSql([
      ENUM_BASE,
      'CREATE UNIQUE INDEX "T_notes_key" ON "T"("notes");\nCREATE INDEX "T_c_d_idx" ON "T"("c", "d" DESC);',
      'ALTER TABLE "U" ADD CONSTRAINT "U_c_fkey" FOREIGN KEY ("id") REFERENCES "T"("id") ON DELETE SET NULL ON UPDATE CASCADE;',
      "ALTER TYPE \"E\" ADD VALUE 'Z' BEFORE 'C';",
      'ALTER TABLE "T" ADD COLUMN "extra" VARCHAR(5) NOT NULL DEFAULT \'x\', ALTER COLUMN "notes" DROP NOT NULL;',
      'ALTER TABLE "T" ALTER COLUMN "extra" SET DATA TYPE TEXT;',
      'CREATE TABLE "gone" ("id" TEXT);',
      `${DROP} TABLE "gone";`,
      'CREATE VIEW "v" AS SELECT 1;',
    ]);
    const t = catalog.tables.get("public.T");
    assert.deepEqual(catalog.enums.get("public.E")?.labels, ["A", "B", "Z", "C"]);
    assert.equal(t.columns.get("c").enum, "public.E");
    assert.equal(t.columns.get("c").default, "'B'");
    assert.equal(t.columns.get("tags").default, "ARRAY['B', 'C']::\"E\"[]");
    assert.deepEqual(t.columns.get("tags").type, { base: "E", array: true });
    assert.equal(t.columns.get("notes").notNull, false);
    assert.deepEqual(t.columns.get("extra").type, { base: "text", array: false });
    assert.equal(t.columns.get("extra").default, "'x'");
    assert.equal(catalog.constraints.get("public.T:T_pkey")?.kind, "primary");
    assert.deepEqual(catalog.constraints.get("public.U:U_c_fkey"), {
      name: "U_c_fkey",
      table: "public.U",
      kind: "foreign",
      columns: ["id"],
      references: "public.T",
      onDelete: "SET NULL",
    });
    assert.equal(catalog.indexes.get("public.T_notes_key")?.unique, true);
    assert.deepEqual(catalog.indexes.get("public.T_c_d_idx")?.columns, ["c", "d"]);
    assert.equal(catalog.tables.has("public.gone"), false);
    assert.equal(catalog.unparsed.length, 1);
    assert.deepEqual(
      enumColumns(catalog, "E").map((c) => `${c.tableName}.${c.column}${c.array ? "[]" : ""}`),
      ["T.c", "T.d", "T.tags[]", "U.c"],
    );
  });

  test("folds Prisma's own enum rebuild and the schema-qualified --to-migrations form", () => {
    const after = catalogFromSql(PRISMA_ENUM_REMOVE, catalogFromSql(ENUM_BASE));
    assert.deepEqual(after.enums.get("public.E")?.labels, ["A", "C"]);
    assert.equal(after.enums.has("public.E_new"), false);
    assert.equal(after.tables.get("public.T").columns.get("c").enum, "public.E");
    assert.equal(after.tables.get("public.T").columns.get("c").default, "'C'");
    const qualified = catalogFromSql(
      'CREATE TYPE "public"."E" AS ENUM (\'A\');\nCREATE TABLE "public"."T" ("c" "public"."E"[] DEFAULT ARRAY[\'A\']::"public"."E"[]);',
    );
    assert.equal(qualified.tables.get("public.T").columns.get("c").enum, "public.E");
  });
});

describe("enum rebuilds", () => {
  const keptBase = catalogFromSql(
    ENUM_BASE.replace("DEFAULT 'B'", "DEFAULT 'C'").replace("ARRAY['B', 'C']", "ARRAY['C']"),
  );

  test("recognizes Prisma 7.10's rebuild block (Step 0 b)", () => {
    const [block, ...rest] = findEnumRebuilds(PRISMA_ENUM_REMOVE);
    assert.equal(rest.length, 0);
    assert.equal(block.enum.key, "public.E");
    assert.deepEqual(block.newLabels, ["A", "C"]);
    assert.deepEqual(
      block.columns.map((c) => `${c.table}.${c.column}${c.array ? "[]" : ""}`),
      ["public.T.c", "public.T.d", "public.T.tags[]", "public.U.c"],
    );
    assert.equal(block.dropDefaults.length, 3);
    assert.deepEqual(
      block.setDefaults.map((s) => s.expr),
      ["'C'", "ARRAY['C']::\"E\"[]", "'A'"],
    );
    // Without BEGIN/COMMIT (after stripBareTransactionControl) it is still one block.
    assert.equal(findEnumRebuilds(stripBareTransactionControl(PRISMA_ENUM_REMOVE)).length, 1);
    // Anything else in the middle: not a rebuild.
    assert.equal(
      findEnumRebuilds(PRISMA_ENUM_REMOVE.replace('ALTER TYPE "E" RENAME TO "E_old";', "")).length,
      0,
    );
  });

  test("classifyEnumRebuild: kept-only, mixed, new", () => {
    const [block] = findEnumRebuilds(PRISMA_ENUM_REMOVE);
    assert.deepEqual(classifyEnumRebuild(block, keptBase, ["B"]), {
      kind: "kept-only",
      removed: ["B"],
      newRemoved: [],
      added: [],
    });
    assert.equal(classifyEnumRebuild(block, keptBase, []).kind, "new");
    assert.deepEqual(classifyEnumRebuild(block, keptBase, []).newRemoved, ["B"]);
    const withD = catalogFromSql("ALTER TYPE \"E\" ADD VALUE 'D';", keptBase);
    assert.deepEqual(classifyEnumRebuild(block, withD, ["B"]), {
      kind: "mixed",
      removed: ["B", "D"],
      newRemoved: ["D"],
      added: [],
    });
  });

  test("classifyEnumRebuild: column-set, label-order and default mismatches are new", () => {
    const [block] = findEnumRebuilds(PRISMA_ENUM_REMOVE);
    const extraColumn = catalogFromSql('ALTER TABLE "U" ADD COLUMN "e" "E";', keptBase);
    assert.equal(classifyEnumRebuild(block, extraColumn, ["B"]).kind, "new");
    const reordered = catalogFromSql(
      ENUM_BASE.replace("('A', 'B', 'C')", "('C', 'A', 'B')")
        .replace("DEFAULT 'B'", "DEFAULT 'C'")
        .replace("ARRAY['B', 'C']", "ARRAY['C']"),
    );
    assert.equal(classifyEnumRebuild(block, reordered, ["B"]).kind, "new");
    // ENUM_BASE defaults T.c to 'B': the block's SET DEFAULT 'C' changes it.
    assert.equal(classifyEnumRebuild(block, catalogFromSql(ENUM_BASE), ["B"]).kind, "new");
    // pg_get_expr's spelling of the same defaults (CI check 1 reads the live catalog).
    const live = catalogFromSql(
      [
        'ALTER TABLE "T" ALTER COLUMN "c" SET DEFAULT \'C\'::"E";',
        'ALTER TABLE "T" ALTER COLUMN "tags" SET DEFAULT ARRAY[\'C\'::"E"];',
        'ALTER TABLE "U" ALTER COLUMN "c" SET DEFAULT \'A\'::"E";',
      ],
      keptBase,
    );
    assert.equal(classifyEnumRebuild(block, live, ["B"]).kind, "kept-only");
  });

  test("enumDefaultNamesRemoved reads every default spelling", () => {
    assert.deepEqual(enumDefaultNamesRemoved("'B'", ["B", "C"]), ["B"]);
    assert.deepEqual(enumDefaultNamesRemoved("'B'::\"E\"", ["B"]), ["B"]);
    assert.deepEqual(enumDefaultNamesRemoved("ARRAY['A', 'C']::\"E\"[]", ["B", "C"]), ["C"]);
    assert.deepEqual(enumDefaultNamesRemoved("ARRAY['C'::\"E\"]", ["C"]), ["C"]);
    assert.deepEqual(enumDefaultNamesRemoved("'{A,C}'::\"E\"[]", ["C"]), ["C"]);
    assert.deepEqual(enumDefaultNamesRemoved("'{A}'::\"E\"[]", ["C"]), []);
    assert.deepEqual(enumDefaultNamesRemoved(null, ["C"]), []);
  });
});

describe("splitForContract", () => {
  const BASE = catalogFromSql([
    ENUM_BASE,
    [
      'CREATE TABLE "parent" ("id" TEXT NOT NULL, CONSTRAINT "parent_pkey" PRIMARY KEY ("id"));',
      'CREATE TABLE "old" ("id" TEXT NOT NULL, "parentId" TEXT, "p2" TEXT, "p3" TEXT, CONSTRAINT "old_pkey" PRIMARY KEY ("id"));',
      'ALTER TABLE "old" ADD CONSTRAINT "old_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "parent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;',
      'ALTER TABLE "old" ADD CONSTRAINT "old_p2_fkey" FOREIGN KEY ("p2") REFERENCES "parent"("id") ON DELETE CASCADE ON UPDATE CASCADE;',
      'CREATE TABLE "kid" ("id" TEXT NOT NULL, "a" TEXT, "b" TEXT, "oldId" TEXT, "email" TEXT, "name" TEXT NOT NULL, CONSTRAINT "kid_pkey" PRIMARY KEY ("id"));',
      'ALTER TABLE "kid" ADD CONSTRAINT "kid_a_fkey" FOREIGN KEY ("a") REFERENCES "parent"("id") ON DELETE CASCADE ON UPDATE CASCADE;',
      'ALTER TABLE "kid" ADD CONSTRAINT "kid_b_fkey" FOREIGN KEY ("b") REFERENCES "parent"("id") ON DELETE SET NULL ON UPDATE CASCADE;',
      'ALTER TABLE "kid" ADD CONSTRAINT "kid_oldId_fkey" FOREIGN KEY ("oldId") REFERENCES "old"("id") ON DELETE SET NULL ON UPDATE CASCADE;',
      'CREATE UNIQUE INDEX "kid_email_key" ON "kid"("email");',
      'CREATE INDEX "kid_a_idx" ON "kid"("a");',
      'CREATE UNIQUE INDEX "old_p3_key" ON "old"("p3");',
    ].join("\n"),
  ]);

  test("routes every row of the split table, including the FK matrix", () => {
    const diff = [
      "-- DropForeignKey",
      'ALTER TABLE "old" DROP CONSTRAINT "old_parentId_fkey";',
      'ALTER TABLE "old" DROP CONSTRAINT "old_p2_fkey";',
      'ALTER TABLE "kid" DROP CONSTRAINT "kid_a_fkey";',
      'ALTER TABLE "kid" DROP CONSTRAINT "kid_b_fkey";',
      'ALTER TABLE "kid" DROP CONSTRAINT "kid_oldId_fkey";',
      `${DROP} INDEX "public"."kid_a_idx";`,
      `${DROP} INDEX "public"."old_p3_key";`,
      `${DROP} INDEX "public"."kid_email_key";`,
      "-- AlterTable",
      `ALTER TABLE "kid" ${DROP} COLUMN "a",\n${DROP} COLUMN "b";`,
      `${DROP} TABLE "old";`,
      'ALTER TABLE "U" ADD COLUMN "z" TEXT;',
      `${DROP} TYPE "F";`,
    ].join("\n");
    const out = splitForContract(diff, BASE, { folder: FOLDER });
    assert.deepEqual(out.refusals, []);
    const strip = (list) => list.map((s) => s.replace(/^--.*\n/gm, ""));
    assert.deepEqual(strip(out.migration), [
      'ALTER TABLE "old" DROP CONSTRAINT "old_parentId_fkey";',
      'ALTER TABLE "kid" DROP CONSTRAINT "kid_a_fkey";',
      'ALTER TABLE "kid" DROP CONSTRAINT "kid_oldId_fkey";',
      `${DROP} INDEX "public"."kid_email_key";`,
      'ALTER TABLE "U" ADD COLUMN "z" TEXT;',
    ]);
    assert.deepEqual(strip(out.contract), [
      'ALTER TABLE "old" DROP CONSTRAINT "old_p2_fkey";',
      'ALTER TABLE "kid" DROP CONSTRAINT "kid_b_fkey";',
      `${DROP} INDEX "public"."kid_a_idx";`,
      `${DROP} INDEX "public"."old_p3_key";`,
      `ALTER TABLE "kid" ${DROP} COLUMN "a";`,
      `ALTER TABLE "kid" ${DROP} COLUMN "b";`,
      `${DROP} TABLE "old";`,
      `${DROP} TYPE "F";`,
    ]);
    assert.ok(
      out.warnings.some((w) => /unique index "kid_email_key".*upserts or connectOrCreate/.test(w)),
    );
    // Prisma's leading comments stay with their statement; a folded ALTER
    // TABLE's comment rides along with its first action in each file.
    assert.match(out.migration[0], /^-- DropForeignKey\n/);
    assert.match(out.contract[4], /^-- AlterTable\n/);
    assert.doesNotMatch(out.contract[5], /^--/);
    assert.deepEqual(analyzeContract(out.contract.join("\n")).findings, []);
  });

  test("primary keys, renames and enum renames are refused", () => {
    for (const [diff, pattern] of [
      [`ALTER TABLE "kid" ${DROP} COLUMN "id";`, /primary key/],
      ['ALTER TABLE "kid" DROP CONSTRAINT "kid_pkey";', /primary key/],
      ['ALTER TABLE "kid" RENAME TO "child";', /@@map/],
      ["ALTER TYPE \"E\" RENAME VALUE 'A' TO 'AA';", /@map/],
      ['ALTER TYPE "E" RENAME TO "E2";', /@map/],
    ])
      assert.match(
        splitForContract(diff, BASE, { folder: FOLDER }).refusals.join("\n"),
        pattern,
        diff,
      );
    const rename = splitForContract('ALTER TABLE "kid" RENAME COLUMN "name" TO "title";', BASE, {
      folder: FOLDER,
    });
    assert.deepEqual(rename.refusals, []);
    assert.equal(rename.migration.length, 1);
    assert.match(rename.warnings[0], /@map/);
  });

  test("a NOT NULL retired column is relaxed in migration.sql; drop + add warns", () => {
    const out = splitForContract(
      `ALTER TABLE "kid" ${DROP} COLUMN "name",\nADD COLUMN "title" TEXT;`,
      BASE,
      { folder: FOLDER },
    );
    assert.deepEqual(out.migration, [
      relax({ table: "kid", column: "name", sentinel: "''" }),
      'ALTER TABLE "kid" ADD COLUMN "title" TEXT;',
    ]);
    assert.deepEqual(out.contract, [`ALTER TABLE "kid" ${DROP} COLUMN "name";`]);
    assert.match(out.warnings.join("\n"), /looks like a rename/);
    const typeChange = splitForContract(
      'ALTER TABLE "kid" ALTER COLUMN "name" TYPE INTEGER USING "name"::integer;',
      BASE,
      { folder: FOLDER },
    );
    assert.match(typeChange.warnings.join("\n"), /Recipe 5/);
  });

  test("an enum value removal: expand + Prisma's SET DEFAULTs, the DO first in contract.sql", () => {
    const out = splitForContract(PRISMA_ENUM_REMOVE, catalogFromSql(ENUM_BASE), {
      folder: FOLDER,
      remap: { "E.B": "A" },
    });
    assert.deepEqual(out.refusals, []);
    const header = {
      version: "v1",
      enumName: "E",
      pairs: [{ from: "B", to: "A" }],
      columns: [
        { table: "T", column: "c", array: false },
        { table: "T", column: "d", array: false },
        { table: "T", column: "tags", array: true },
        { table: "U", column: "c", array: false },
      ],
      folder: FOLDER,
    };
    assert.deepEqual(out.enumRemoval, header);
    assert.equal(out.migration[0], enumRemoveExpand(header));
    assert.deepEqual(out.migration.slice(1, 4), [
      'ALTER TABLE "T" ALTER COLUMN "c" SET DEFAULT \'C\';',
      'ALTER TABLE "T" ALTER COLUMN "tags" SET DEFAULT ARRAY[\'C\']::"E"[];',
      'ALTER TABLE "U" ALTER COLUMN "c" SET DEFAULT \'A\';',
    ]);
    assert.equal(out.contract[0], enumRemoveContract(header));
    assert.equal(out.contract.length, 1);
    assert.doesNotMatch(out.migration.join("\n"), /DROP DEFAULT|E_new|BEGIN;/);
    const contract = analyzeContract(`${out.contract.join("\n")}\n`, { folder: FOLDER });
    assert.deepEqual(contract.findings, []);
    const migration = analyzeMigration(wrapTransactional(out.migration.join("\n")), {
      folder: FOLDER,
    });
    assert.deepEqual(migration.notAnalyzed, []);
    assert.deepEqual(migration.incompatible, []);
  });

  test("enum removal refusals: no remap, bad remap, add+remove, removed default", () => {
    const base = catalogFromSql(ENUM_BASE);
    assert.match(
      splitForContract(PRISMA_ENUM_REMOVE, base, { folder: FOLDER }).refusals.join("\n"),
      /Ask the user which value existing rows become, then pass --remap 'E\.B=<VALUE>'/,
    );
    assert.match(
      splitForContract(PRISMA_ENUM_REMOVE, base, {
        folder: FOLDER,
        remap: { "E.B": "Q" },
      }).refusals.join("\n"),
      /Q must be a value E already has and keeps/,
    );
    const addAndRemove = PRISMA_ENUM_REMOVE.replace("('A', 'C')", "('A', 'C', 'D')");
    assert.match(
      splitForContract(addAndRemove, base, { folder: FOLDER, remap: { "E.B": "A" } }).refusals.join(
        "\n",
      ),
      /adds E\.D and removes E\.B in the same migration\. Add the new value in an earlier PR/,
    );
    const keepsOldDefault = PRISMA_ENUM_REMOVE.replace(
      /ALTER TABLE "T" ALTER COLUMN "c" SET DEFAULT 'C'[;,]\n/g,
      "",
    );
    assert.match(
      splitForContract(keepsOldDefault, base, {
        folder: FOLDER,
        remap: { "E.B": "A" },
      }).refusals.join("\n"),
      /"T"\."c" defaults to a removed value/,
    );
    const newDefaultRemoved = PRISMA_ENUM_REMOVE.replaceAll("SET DEFAULT 'C'", "SET DEFAULT 'B'");
    assert.match(
      splitForContract(newDefaultRemoved, base, {
        folder: FOLDER,
        remap: { "E.B": "A" },
      }).refusals.join("\n"),
      /names the removed value B/,
    );
  });

  test("two enums in one diff are refused with the values to put back", () => {
    const twoEnums = PRISMA_ENUM_REMOVE.replace(
      "COMMIT;\n",
      [
        "COMMIT;",
        "",
        "-- AlterEnum",
        "BEGIN;",
        "CREATE TYPE \"F_new\" AS ENUM ('X');",
        'ALTER TABLE "public"."T" ALTER COLUMN "f" DROP DEFAULT;',
        'ALTER TABLE "T" ALTER COLUMN "f" TYPE "F_new" USING ("f"::text::"F_new");',
        'ALTER TYPE "F" RENAME TO "F_old";',
        'ALTER TYPE "F_new" RENAME TO "F";',
        `${DROP} TYPE "public"."F_old";`,
        'ALTER TABLE "T" ALTER COLUMN "f" SET DEFAULT \'X\';',
        "COMMIT;",
        "",
      ].join("\n"),
    );
    const out = splitForContract(twoEnums, catalogFromSql(ENUM_BASE), {
      folder: FOLDER,
      remap: { "E.B": "A", "F.Y": "X" },
    });
    assert.deepEqual(out.refusals, [
      multiEnumRefusal([
        { enumName: "F", removed: ["Y"] },
        { enumName: "E", removed: ["B"] },
      ]),
    ]);
    assert.match(out.refusals[0], /removes values from more than one enum \(E, F\)/);
    assert.match(out.refusals[0], /put these values back in the schema: F\.Y\./);
    assert.match(out.refusals[0], /All of these migrations can ship in one PR/);
  });

  test("kept-only blocks are dropped with the C4-3 note; mixed asks only for the new label", () => {
    const kept = catalogFromSql(
      ENUM_BASE.replace("DEFAULT 'B'", "DEFAULT 'C'").replace("ARRAY['B', 'C']", "ARRAY['C']"),
    );
    const out = splitForContract(PRISMA_ENUM_REMOVE, kept, {
      folder: FOLDER,
      allowedKept: { E: ["B"] },
    });
    assert.deepEqual(out.refusals, []);
    assert.deepEqual(out.contract, []);
    assert.equal(out.enumRemoval, null);
    assert.match(out.notes[0], /^E\.B is kept unused in databases where something used the column/);
    const withD = catalogFromSql("ALTER TYPE \"E\" ADD VALUE 'D';", kept);
    const mixed = splitForContract(PRISMA_ENUM_REMOVE, withD, {
      folder: FOLDER,
      allowedKept: { E: ["B"] },
    });
    assert.deepEqual(mixed.refusals, [
      "E.D is removed, so existing rows need another value. Ask the user which value existing rows become, then pass --remap 'E.D=<VALUE>'.",
    ]);
    const mapped = splitForContract(PRISMA_ENUM_REMOVE, withD, {
      folder: FOLDER,
      allowedKept: { E: ["B"] },
      remap: { "E.D": "A" },
    });
    assert.deepEqual(mapped.enumRemoval?.pairs, [{ from: "D", to: "A" }]);
  });

  test("--recover adds the guarded copy; a type mismatch is refused", () => {
    const retiredColumns = new Map([["public.kid.legacy", "TEXT"]]);
    const ok = splitForContract('ALTER TABLE "kid" ADD COLUMN "legacy2" TEXT;', BASE, {
      folder: FOLDER,
      recover: [{ table: "kid", from: "legacy", to: "legacy2" }],
      retiredColumns,
    });
    assert.deepEqual(ok.refusals, []);
    assert.equal(
      ok.migration.at(-1),
      recoverBlock({ table: "kid", from: "legacy", to: "legacy2" }),
    );
    const mismatch = splitForContract('ALTER TABLE "kid" ADD COLUMN "legacy2" INTEGER;', BASE, {
      folder: FOLDER,
      recover: [{ table: "kid", from: "legacy", to: "legacy2" }],
      retiredColumns,
    });
    assert.match(mismatch.refusals.join("\n"), /must have the same type/);
    const notRetired = splitForContract('ALTER TABLE "kid" ADD COLUMN "legacy2" TEXT;', BASE, {
      folder: FOLDER,
      recover: [{ table: "kid", from: "name", to: "legacy2" }],
      retiredColumns,
    });
    assert.match(notRetired.refusals.join("\n"), /not retired by an existing contract\.sql/);
  });
});

describe("relaxFor", () => {
  const catalog = catalogFromSql([
    "CREATE TYPE \"E\" AS ENUM ('A', 'B');",
    [
      'CREATE TABLE "r" (',
      '"id" TEXT NOT NULL, "s" TEXT NOT NULL, "v" VARCHAR(5) NOT NULL, "i" INTEGER NOT NULL, "n" DECIMAL(10,2) NOT NULL,',
      '"b" BOOLEAN NOT NULL, "ts" TIMESTAMP(3) NOT NULL, "d" DATE NOT NULL, "tm" TIME NOT NULL, "j" JSONB NOT NULL,',
      '"by" BYTEA NOT NULL, "u" UUID NOT NULL, "arr" TEXT[], "arr2" INTEGER[] NOT NULL, "e" "E" NOT NULL, "ip" INET NOT NULL,',
      '"uq" TEXT NOT NULL, "fk" TEXT NOT NULL, "ck" INTEGER NOT NULL, "nul" TEXT, "dflt" TEXT NOT NULL DEFAULT \'x\',',
      'CONSTRAINT "r_pkey" PRIMARY KEY ("id"), CONSTRAINT "r_ck_check" CHECK ("ck" > 0));',
    ].join("\n"),
    'CREATE UNIQUE INDEX "r_uq_key" ON "r"("uq");',
    'ALTER TABLE "r" ADD CONSTRAINT "r_fk_fkey" FOREIGN KEY ("fk") REFERENCES "r"("id") ON DELETE CASCADE;',
  ]);
  const action = (column, removed) =>
    relaxFor(catalog, "public.r", column, {
      removedLabels: new Map([["public.E", removed ?? []]]),
    });

  test("a sentinel per type, DROP NOT NULL for constrained or unknown types", () => {
    const expected = {
      s: "SET DEFAULT ''",
      v: "SET DEFAULT ''",
      i: "SET DEFAULT 0",
      n: "SET DEFAULT 0",
      b: "SET DEFAULT false",
      ts: "SET DEFAULT '1970-01-01'",
      d: "SET DEFAULT '1970-01-01'",
      tm: "SET DEFAULT '00:00'",
      j: "SET DEFAULT '{}'",
      by: "SET DEFAULT '\\x'",
      u: "SET DEFAULT '00000000-0000-0000-0000-000000000000'",
      arr2: "SET DEFAULT '{}'",
      e: "SET DEFAULT 'A'",
      ip: "DROP NOT NULL",
      uq: "DROP NOT NULL",
      fk: "DROP NOT NULL",
      ck: "DROP NOT NULL",
    };
    for (const [column, clause] of Object.entries(expected)) {
      const result = action(column);
      assert.equal(
        result?.text,
        `-- knowledge-base:relax v1 "r"."${column}"\nALTER TABLE "r" ALTER COLUMN "${column}" ${clause};`,
        column,
      );
      assert.deepEqual(analyzeMigration(result.text).notAnalyzed, [], column);
    }
    assert.match(action("e", ["A"]).text, /SET DEFAULT 'B';$/);
    assert.match(action("e", ["A", "B"]).text, /DROP NOT NULL;$/);
  });

  test("the generator warns when a relax drops NOT NULL, and that migration is not rollback-safe", () => {
    const fk = splitForContract(`ALTER TABLE "r" ${DROP} COLUMN "fk";`, catalog, {
      folder: FOLDER,
    });
    assert.ok(fk.migration.includes(action("fk").text));
    assert.match(fk.warnings.join("\n"), /"fk" of "r" has no safe placeholder/);
    assert.match(fk.warnings.join("\n"), /not rollback-safe/);
    const unsafe = rollbackSafety(wrapTransactional(fk.migration.join("\n")), { folder: FOLDER });
    assert.equal(unsafe.safe, false);
    assert.match(unsafe.reasons.join(), /relaxes "r"\."fk" with DROP NOT NULL/);
    const sentinel = splitForContract(`ALTER TABLE "r" ${DROP} COLUMN "s";`, catalog, {
      folder: FOLDER,
    });
    assert.deepEqual(sentinel.warnings, []);
    assert.deepEqual(
      rollbackSafety(wrapTransactional(sentinel.migration.join("\n")), { folder: FOLDER }),
      { safe: true, reasons: [] },
    );
  });

  test("nullable or defaulted columns need nothing; a primary-key column is refused", () => {
    assert.equal(action("nul"), null);
    assert.equal(action("arr"), null);
    assert.equal(action("dflt"), null);
    assert.match(action("id").refuse, /primary key/);
  });
});

describe("analyzeContract", () => {
  test("accepts plain drops and the enum template first", () => {
    const sql = [
      enumRemoveContract(HEADER),
      `${DROP} TABLE "a", "b";`,
      `ALTER TABLE "t" ${DROP} COLUMN "x", DROP CONSTRAINT "t_x_fkey";`,
      `${DROP} INDEX "public"."t_x_idx";`,
      `${DROP} TYPE "Old";`,
    ].join("\n");
    const result = analyzeContract(sql, { folder: FOLDER });
    assert.deepEqual(result.findings, []);
    assert.deepEqual(
      result.drops.map((d) => `${d.kind}:${d.target}`),
      [
        "table:public.a",
        "table:public.b",
        "column:public.t.x",
        "constraint:public.t.t_x_fkey",
        "index:public.t_x_idx",
        "type:public.Old",
      ],
    );
    assert.equal(CONTRACT_FILE, "contract.sql");
  });

  test("rejects everything else", () => {
    for (const bad of [
      'UPDATE "t" SET "x" = 1 WHERE "x" IS NULL;',
      'DELETE FROM "t" WHERE true;',
      'ALTER TABLE "t" ALTER COLUMN "x" SET NOT NULL;',
      "DO $$ BEGIN PERFORM 1; END $$;",
      "BEGIN;",
      `${DROP} TRIGGER "knowledge_base_sync_00000000" ON "t";`,
      `${DROP} FUNCTION "knowledge_base_sync_00000000"();`,
      'ALTER FUNCTION "f"() COST 100;',
      'ALTER ROUTINE "f"() SECURITY INVOKER;',
      `${DROP} TABLE "t" CASCADE;`,
      `${REVIEWED_MARKER} trust me\n${DROP} TABLE "t";`,
      `ALTER TABLE "t" ${DROP} COLUMN "x", ADD COLUMN "y" TEXT;`,
      recoverBlock({ table: "t", from: "x", to: "y" }),
    ])
      assert.ok(analyzeContract(bad, { folder: FOLDER }).findings.length > 0, bad);
    const notFirst = analyzeContract(`${DROP} TABLE "a";\n${enumRemoveContract(HEADER)}`, {
      folder: FOLDER,
    });
    assert.match(notFirst.findings[0]?.message ?? "", /must be the first statement/);
    const twice = analyzeContract(`${enumRemoveContract(HEADER)}\n${enumRemoveContract(HEADER)}`, {
      folder: FOLDER,
    });
    assert.match(twice.findings[0]?.message ?? "", /more than one enum-remove block/);
    const expandInContract = analyzeContract(expandOf(), { folder: FOLDER });
    assert.ok(expandInContract.findings.length > 0);
  });
});

describe("rollbackSafety", () => {
  const prior = new Set(["public.user", "public.t"]);
  test("the positive allowlist is safe", () => {
    const sql = wrapTransactional(
      [
        "CREATE TYPE \"Kind\" AS ENUM ('A');",
        'CREATE TABLE "n" ("id" TEXT NOT NULL, "userId" TEXT, CONSTRAINT "n_pkey" PRIMARY KEY ("id"));',
        'CREATE UNIQUE INDEX "n_userId_key" ON "n"("userId");',
        'CREATE INDEX "t_x_idx" ON "t"("x");',
        'ALTER TABLE "n" ADD CONSTRAINT "n_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;',
        'ALTER TABLE "t" ADD COLUMN "note" TEXT, ADD COLUMN "flag" BOOLEAN NOT NULL DEFAULT false;',
        'ALTER TABLE "t" ADD COLUMN "slug" TEXT;',
        'CREATE UNIQUE INDEX "t_slug_key" ON "t"("slug");',
        'ALTER TABLE "t" ALTER COLUMN "x" SET DEFAULT 1;',
        'ALTER TABLE "t" DROP CONSTRAINT "t_old_fkey";',
        relax({ table: "t", column: "gone", sentinel: "''" }),
        'UPDATE "t" SET "note" = \'\' WHERE "note" IS NULL;',
        expandOf(),
        recoverBlock({ table: "t", from: "x", to: "x2" }),
      ].join("\n"),
    );
    assert.deepEqual(rollbackSafety(sql, { priorTables: prior, folder: FOLDER }), {
      safe: true,
      reasons: [],
    });
  });

  test("each unsafe form is unsafe, with a reason", () => {
    const catalog = catalogFromSql([
      'CREATE TABLE "t" ("id" TEXT, "x" TEXT);',
      'CREATE UNIQUE INDEX "t_x_key" ON "t"("x");',
      'CREATE INDEX "t_id_idx" ON "t"("id");',
    ]);
    for (const [sql, reason] of [
      ['ALTER TABLE "t" ALTER COLUMN "x" SET NOT NULL;', /SET NOT NULL/],
      ['ALTER TABLE "t" ALTER COLUMN "x" DROP DEFAULT;', /DROP DEFAULT/],
      ['ALTER TABLE "t" ALTER COLUMN "x" DROP NOT NULL;', /DROP NOT NULL/],
      [
        relax({ table: "t", column: "gone", sentinel: null }),
        /relaxes "t"\."gone" with DROP NOT NULL \(no placeholder default; older code reading it as required fails/,
      ],
      ["ALTER TYPE \"Kind\" ADD VALUE 'B';", /enum value/],
      ['ALTER TABLE "t" ADD COLUMN "y" TEXT NOT NULL;', /without a default/],
      ['CREATE UNIQUE INDEX "t_x_key2" ON "t"("x");', /existing columns/],
      [
        'ALTER TABLE "t" ADD COLUMN "y" TEXT DEFAULT \'a\';\nCREATE UNIQUE INDEX "t_y_key" ON "t"("y");',
        /non-NULL default/,
      ],
      [`${DROP} INDEX "t_x_key";`, /unique index/],
      [`${DROP} INDEX "t_mystery";`, /unknown index/],
      ['ALTER TABLE "t" ALTER COLUMN "x" SET DATA TYPE VARCHAR(20);', /changes the type/],
      [
        'ALTER TABLE "n" ADD CONSTRAINT "n_t_fkey" FOREIGN KEY ("tId") REFERENCES "t"("id") ON DELETE RESTRICT;',
        /RESTRICT foreign key/,
      ],
      [
        'ALTER TABLE "t" ADD CONSTRAINT "t_k" FOREIGN KEY ("x") REFERENCES "t"("id");',
        /NO ACTION foreign key/,
      ],
      ['ALTER TABLE "t" DROP CONSTRAINT "t_x_key";', /drops constraint/],
      ['ALTER TABLE "t" RENAME COLUMN "x" TO "y";', /RENAME/],
      ["DO $$ BEGIN PERFORM 1; END $$;", /not analyzed/],
      [`${REVIEWED_MARKER} fine\nDO $$ BEGIN PERFORM 1; END $$;`, /not analyzed/],
      ['INSERT INTO "t" ("id") VALUES (\'a\');', /not on the rollback-safe list/],
    ]) {
      const result = rollbackSafety(sql, { priorTables: prior, catalog });
      assert.equal(result.safe, false, sql);
      assert.match(result.reasons.join("\n"), reason, sql);
    }
    assert.equal(rollbackSafety(`${DROP} INDEX "t_id_idx";`, { catalog }).safe, true);
  });
});

describe("reviewed annotation (§1.9)", () => {
  const reviewed = (statement) =>
    analyzeMigration(`${REVIEWED_MARKER} batched backfill, checked on a copy\n${statement}`)
      .notAnalyzed;

  test("is accepted directly above one not-analyzed statement", () => {
    const [entry, ...rest] = reviewed(
      'DO $$ BEGIN UPDATE "t" SET "x" = 1 WHERE "x" IS NULL; END $$;',
    );
    assert.equal(rest.length, 0);
    assert.equal(entry.reviewed, "batched backfill, checked on a copy");
    assert.equal(
      analyzeMigration(`${REVIEWED_MARKER}\nCREATE VIEW "v" AS SELECT 1;`).notAnalyzed[0].reviewed,
      null,
    );
  });

  test("is ignored on forms that can break the running release", () => {
    for (const statement of [
      `${DROP} VIEW "v";`,
      'ALTER VIEW "v" RENAME TO "w";',
      "EXECUTE prepared_thing;",
      'ALTER TABLE "t" DISABLE TRIGGER ALL;',
      'CREATE RULE "r" AS ON INSERT TO "t" DO INSTEAD NOTHING;',
      'REVOKE SELECT ON "t" FROM PUBLIC;',
      'ALTER TABLE "t" ENABLE ROW LEVEL SECURITY;',
      "CREATE FUNCTION knowledge_base_helper() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;",
      'DO $$ BEGIN ALTER TABLE "t" ALTER "x" TYPE bigint; END $$;',
      'DO $$ BEGIN ALTER TABLE "t" ALTER "x" SET DATA TYPE bigint; END $$;',
      'DO $$ BEGIN ALTER TABLE "t" ALTER COLUMN "x" TYPE bigint; END $$;',
    ]) {
      const [entry] = reviewed(statement);
      assert.ok(entry, statement);
      assert.equal(entry.reviewed, null, statement);
      assert.equal(entry.reviewIgnored, true, statement);
    }
  });
});

describe("findNameReuse", () => {
  const folders = [
    { name: "1_a", sql: 'CREATE TABLE "t" ("id" TEXT, "x" TEXT);', contract: null },
    {
      name: "2_drop",
      sql: "SELECT 1;",
      contract: {
        sql: [
          enumRemoveContract({ ...HEADER, folder: "2_drop" }),
          `ALTER TABLE "t" ${DROP} COLUMN "x";`,
          `${DROP} TABLE "old";`,
          `${DROP} INDEX "public"."t_x_idx";`,
          'ALTER TABLE "t" DROP CONSTRAINT "t_k";',
          `${DROP} TYPE "Gone";`,
        ].join("\n"),
      },
    },
  ];

  test("catches a later CREATE / ADD of a name an earlier contract drops", () => {
    const later = {
      name: "3_reuse",
      sql: [
        'ALTER TABLE "t" ADD COLUMN "x" INTEGER;',
        'CREATE TABLE "old" ("id" TEXT);',
        'CREATE INDEX "t_x_idx" ON "t"("id");',
        'ALTER TABLE "t" ADD CONSTRAINT "t_k" UNIQUE ("id");',
        "CREATE TYPE \"Gone\" AS ENUM ('A');",
        "ALTER TYPE \"Status\" ADD VALUE 'OLD';",
      ].join("\n"),
      contract: null,
    };
    assert.deepEqual(
      findNameReuse([...folders, later]).map((m) => `${m.folder}:${m.key}<-${m.droppedBy}`),
      [
        "3_reuse:column:public.t.x<-2_drop",
        "3_reuse:table:public.old<-2_drop",
        "3_reuse:index:public.t_x_idx<-2_drop",
        "3_reuse:constraint:public.t.t_k<-2_drop",
        "3_reuse:type:public.Gone<-2_drop",
        "3_reuse:label:public.Status:OLD<-2_drop",
      ],
    );
  });

  test("is scoped: other tables, other enums, earlier folders and template names do not match", () => {
    const later = {
      name: "3_ok",
      sql: [
        'ALTER TABLE "u" ADD COLUMN "x" INTEGER;',
        'ALTER TABLE "u" ADD CONSTRAINT "t_k" UNIQUE ("id");',
        "ALTER TYPE \"Other\" ADD VALUE 'OLD';",
        'CREATE TABLE "knowledge_base_sync_00000000" ("id" TEXT);',
      ].join("\n"),
      contract: null,
    };
    assert.deepEqual(findNameReuse([...folders, later]), []);
    // The same folder's own migration, and earlier folders, never count.
    assert.deepEqual(findNameReuse(folders), []);
  });
});
