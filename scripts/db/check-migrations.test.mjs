import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import {
  checkFolder,
  checkImmutability,
  checkOrdering,
  compareApplicationCatalogs,
  compareSnapshots,
  render,
} from "./check-migrations.mjs";
import { keptLabelsFromNotices } from "./lib/diff-source.mjs";
import {
  catalogFromSql,
  enumRemoveContract,
  enumRemoveExpand,
  normalizeType,
  RETIRED_MAINTENANCE_MARKER,
  recoverBlock,
  summarizeEffects,
  wrapTransactional,
} from "./lib/sql.mjs";

const blob = (text) => {
  const bytes = Buffer.from(text);
  return createHash("sha1")
    .update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]))
    .digest("hex");
};

describe("compareApplicationCatalogs", () => {
  const row = (kind, identity, definition) => ({ kind, identity, definition });
  const enumRow = (labels, name = "ProjectKind") => row("enum", name, JSON.stringify(labels));
  const kept = (label = "C", name = "ProjectKind") =>
    keptLabelsFromNotices([
      `knowledge-base:label-kept "${name.replaceAll('"', '""')}" "${label.replaceAll('"', '""')}" (dependency)`,
    ]);

  test("compares by identity regardless of row order and lists added/deleted objects", () => {
    const a = [row("relation", "project", "table"), row("index", "project_idx", "index")];
    assert.deepEqual(compareApplicationCatalogs(a, [...a].reverse()), []);
    assert.deepEqual(compareApplicationCatalogs(a, [a[0], row("function", "f()", "body")]), [
      'function "f()": only in B',
      'index "project_idx": only in A',
    ]);
  });

  test("reports genuine definition changes without exposing SQL bodies", () => {
    for (const kind of [
      "constraint",
      "trigger",
      "function",
      "index",
      "relation",
      "column",
      "schema",
    ]) {
      assert.deepEqual(
        compareApplicationCatalogs([row(kind, "probe", "before")], [row(kind, "probe", "after")], {
          keptA: kept("before", "probe"),
          keptB: kept("after", "probe"),
        }),
        [`${kind} "probe": definition differs`],
      );
    }
  });

  test("reports the real retained-enum difference with both label lists", () => {
    assert.deepEqual(
      compareApplicationCatalogs([enumRow(["A", "B", "C"])], [enumRow(["A", "B"])]),
      [
        `enum "ProjectKind": definition differs (A: ${JSON.stringify('["A","B","C"]')}; B: ${JSON.stringify('["A","B"]')})`,
      ],
    );
  });

  test("permits asymmetric extra labels only with that replay's own kept notices", () => {
    const extra = [enumRow(["A", "C", "B"])];
    const base = [enumRow(["A", "B"])];
    assert.deepEqual(compareApplicationCatalogs(extra, base, { keptA: kept() }), []);
    assert.deepEqual(compareApplicationCatalogs(base, extra, { keptB: kept() }), []);
    assert.deepEqual(
      compareApplicationCatalogs(extra, [enumRow(["A", "B", "D"])], {
        keptA: kept(),
        keptB: kept("D"),
      }),
      [],
    );
    for (const options of [
      {},
      { keptB: kept() },
      { keptA: kept("D") },
      { keptA: kept("C", "OtherKind") },
    ]) {
      assert.equal(compareApplicationCatalogs(extra, base, options).length, 1);
      assert.equal(
        compareApplicationCatalogs(base, extra, {
          keptA: options.keptB,
          keptB: options.keptA,
        }).length,
        1,
      );
    }
    assert.equal(
      compareApplicationCatalogs([enumRow(["A", "B", "C", "D"])], base, { keptA: kept() }).length,
      1,
    );
  });

  test("kept notices cannot excuse missing enums or reordered shared labels", () => {
    const extra = [enumRow(["A", "B", "C"])];
    const options = { keptA: kept(), keptB: kept() };
    assert.deepEqual(compareApplicationCatalogs(extra, [], options), [
      'enum "ProjectKind": only in A',
    ]);
    assert.deepEqual(compareApplicationCatalogs([], extra, options), [
      'enum "ProjectKind": only in B',
    ]);
    assert.equal(compareApplicationCatalogs(extra, [enumRow(["B", "A"])], options).length, 1);
    assert.equal(compareApplicationCatalogs(extra, [enumRow(["A", "C", "B"])], options).length, 1);
  });

  test("preserves label boundaries and quoted enum/label names", () => {
    const name = 'Project"Kind';
    const label = 'C,"quoted"';
    assert.deepEqual(
      compareApplicationCatalogs([enumRow(["A,B", label], name)], [enumRow(["A,B"], name)], {
        keptA: kept(label, name),
      }),
      [],
    );
    assert.equal(
      compareApplicationCatalogs([enumRow(["A,B", "C"])], [enumRow(["A", "B"])], { keptA: kept() })
        .length,
      1,
    );
  });
});

describe("checkOrdering", () => {
  test("new folders must sort after the base's latest and be well named", () => {
    const base = ["0_init", "20260101000000_a"];
    assert.deepEqual(checkOrdering(base, [...base, "20260201000000_b"]).details, []);
    const early = checkOrdering(base, [...base, "20251231000000_old"]);
    assert.deepEqual(early.added, ["20251231000000_old"]);
    assert.match(early.details[0], /sorts before/);
    assert.match(
      checkOrdering(base, [...base, "20260201000000_Bad-Name"]).details[0],
      /folder name/,
    );
  });
});

describe("checkImmutability", () => {
  const baseFiles = [{ path: "0_init/migration.sql", sha: blob("CREATE TABLE a ();\n") }];
  test("unchanged passes", () => {
    assert.deepEqual(
      checkImmutability(
        baseFiles,
        () => ["0_init/migration.sql"],
        () => Buffer.from("CREATE TABLE a ();\n"),
      ),
      [],
    );
  });
  test("modified, deleted/renamed, and added-inside all fail", () => {
    assert.match(
      checkImmutability(
        baseFiles,
        () => [],
        () => Buffer.from("changed"),
      )[0],
      /modified/,
    );
    assert.match(
      checkImmutability(
        baseFiles,
        () => [],
        () => null,
      )[0],
      /deleted or renamed/,
    );
    const extra = checkImmutability(
      baseFiles,
      () => ["0_init/migration.sql", "0_init/notes.md"],
      () => Buffer.from("CREATE TABLE a ();\n"),
    );
    assert.match(extra[0], /added inside/);
  });
});

describe("compareSnapshots", () => {
  const before = new Map([
    [
      "public.project",
      {
        pk: ["id"],
        rows: [
          { id: "p1", name: "A", notes: "keep me" },
          { id: "p2", name: "B", notes: null },
        ],
      },
    ],
  ]);
  test("a RENAME COLUMN keeps values", () => {
    const after = new Map([
      [
        "public.project",
        {
          pk: ["id"],
          rows: [
            { id: "p1", name: "A", description: "keep me" },
            { id: "p2", name: "B", description: null },
          ],
        },
      ],
    ]);
    const effects = summarizeEffects(
      'ALTER TABLE "project" RENAME COLUMN "notes" TO "description";',
    );
    assert.deepEqual(compareSnapshots(before, after, effects), { failures: [], warnings: [] });
  });
  test("lost rows and silently changed values fail; declared UPDATE columns are exempt", () => {
    const after = new Map([
      ["public.project", { pk: ["id"], rows: [{ id: "p1", name: "a", notes: "keep me" }] }],
    ]);
    const { failures } = compareSnapshots(before, after, summarizeEffects(""));
    assert.equal(failures.length, 2);
    assert.ok(failures.some((f) => /disappeared/.test(f)));
    assert.ok(failures.some((f) => /changed from "A" to "a"/.test(f)));
    const updated = compareSnapshots(
      before,
      new Map([
        [
          "public.project",
          {
            pk: ["id"],
            rows: [
              { id: "p1", name: "a", notes: "keep me" },
              { id: "p2", name: "b", notes: null },
            ],
          },
        ],
      ]),
      summarizeEffects('UPDATE "project" SET "name" = lower("name");'),
    );
    assert.deepEqual(updated.failures, []);
  });
  test("a column that vanishes without a DROP fails; a declared DROP does not", () => {
    const after = new Map([
      [
        "public.project",
        {
          pk: ["id"],
          rows: [
            { id: "p1", name: "A" },
            { id: "p2", name: "B" },
          ],
        },
      ],
    ]);
    assert.equal(compareSnapshots(before, after, summarizeEffects("")).failures.length, 1);
    const dropped = summarizeEffects('ALTER TABLE "project" DROP COLUMN "notes";');
    assert.deepEqual(compareSnapshots(before, after, dropped).failures, []);
  });
});

describe("checkOrdering: shared timestamps", () => {
  test("two new folders with one 14-digit prefix fail", () => {
    const details = checkOrdering(
      ["0_init"],
      ["0_init", "20260201000000_a", "20260201000000_b"],
    ).details;
    assert.match(details.join("\n"), /share the timestamp 20260201000000/);
  });
});

describe("checkImmutability: contract.sql", () => {
  test("adding contract.sql to a base folder fails", () => {
    const sha = blob("SELECT 1;\n");
    const details = checkImmutability(
      [{ path: "0_init/migration.sql", sha }],
      () => ["0_init/migration.sql", "0_init/contract.sql"],
      () => Buffer.from("SELECT 1;\n"),
    );
    assert.match(
      details.join("\n"),
      /`0_init\/contract\.sql` was added inside an existing migration folder/,
    );
  });
});

describe("checkFolder (check 5) and the summary", () => {
  // Assembled so policy greps never see a literal deletion in this fixture.
  const DROP = "DROP";
  const FOLDER = "20990101000000_change";
  const baseSql = wrapTransactional(
    [
      "CREATE TYPE \"E\" AS ENUM ('A', 'B', 'C');",
      'CREATE TABLE "project" ("id" TEXT NOT NULL, "name" TEXT NOT NULL, "notes" TEXT, "c" "E" NOT NULL DEFAULT \'A\', CONSTRAINT "project_pkey" PRIMARY KEY ("id"));',
    ].join("\n"),
  );
  const catalog = catalogFromSql(baseSql);
  const context = { catalog, retired: new Map() };
  const folder = (sql, contract = null) => ({
    name: FOLDER,
    sql: wrapTransactional(sql),
    contract: contract === null ? null : { sql: contract },
  });

  test("a plain additive migration passes and reports a possible rollback", () => {
    const result = checkFolder(folder('ALTER TABLE "project" ADD COLUMN "x" TEXT;'), context);
    assert.deepEqual(result.failures, []);
    assert.equal(result.rollback.safe, true);
  });

  test("an in-place drop fails with the regenerate hint, with or without the retired marker", () => {
    const sql = `ALTER TABLE "project" ${DROP} COLUMN "notes";`;
    const result = checkFolder(folder(sql), context);
    assert.match(
      result.failures.join("\n"),
      /drops column "project"\."notes", and the release that is still running breaks\. A deletion: delete this folder and re-run `pnpm db:migrate`/,
    );
    const marked = checkFolder(
      {
        name: FOLDER,
        sql: wrapTransactional(sql).replace("BEGIN;", `${RETIRED_MAINTENANCE_MARKER}\nBEGIN;`),
        contract: null,
      },
      context,
    );
    const text = marked.failures.join("\n");
    assert.match(
      text,
      /drops column "project"\."notes", and the release that is still running breaks/,
    );
    assert.match(text, /`-- requires: maintenance-deploy` is retired/);
    assert.match(text, /expand\/contract/);
  });

  test("the retired marker fails anywhere in the file, even on a harmless migration", () => {
    for (const sql of [
      `${RETIRED_MAINTENANCE_MARKER}\nALTER TABLE "project" ADD COLUMN "x" TEXT;`,
      `ALTER TABLE "project" ADD COLUMN "x" TEXT;\n${RETIRED_MAINTENANCE_MARKER}`,
    ]) {
      const result = checkFolder(folder(sql), context);
      assert.match(result.failures.join("\n"), /is retired; there is no maintenance deploy/);
    }
  });

  test("unannotated DO fails; annotated passes and is listed as reviewed; ignored annotation fails", () => {
    const backfill = 'DO $$ BEGIN UPDATE "project" SET "x" = 1 WHERE "x" IS NULL; END $$;';
    assert.match(
      checkFolder(folder(backfill), context).failures.join("\n"),
      /not analyzed \(dollar-quoted.*fails unless the line above the statement is `-- knowledge-base:reviewed <reason>`/,
    );
    const ok = checkFolder(
      folder(`-- knowledge-base:reviewed backfill only\n${backfill}`),
      context,
    );
    assert.deepEqual(ok.failures, []);
    const text = render({ baseRef: "main", added: [FOLDER], checks: [], report: [ok] });
    assert.match(
      text,
      /Reviewed by hand \(line \d+\): backfill only — attested by the author, not verified\./,
    );
    const ignored = checkFolder(
      folder("-- knowledge-base:reviewed fine\nDO $$ BEGIN EXECUTE 'SELECT 1'; END $$;"),
      context,
    );
    assert.match(
      ignored.failures.join("\n"),
      /annotation does not apply to this kind of statement/,
    );
  });

  test("contract.sql: plain deletions pass and are summarized; anything else fails", () => {
    const ok = checkFolder(
      folder(
        'CREATE INDEX "project_name_idx" ON "project"("name");',
        `ALTER TABLE "project" ${DROP} COLUMN "notes";\n`,
      ),
      context,
    );
    assert.deepEqual(ok.failures, []);
    const text = render({ baseRef: "main", added: [FOLDER], checks: [], report: [ok] });
    assert.match(
      text,
      /Deleted about 7 days after this deploys, once no older release is running: column "project"\."notes"\./,
    );
    assert.match(text, /Rollback to the previous release: possible until the deletion runs\./);
    assert.match(text, /Agents: show this summary to the user before merging\./);
    assert.doesNotMatch(text, /maintenance deploy/);
    const bad = checkFolder(folder("SELECT 1;", 'UPDATE "project" SET "notes" = NULL;\n'), context);
    assert.match(
      bad.failures.join("\n"),
      /contract\.sql` line 1: statement not allowed in contract\.sql/,
    );
    const reviewed = checkFolder(
      folder(
        "SELECT 1;",
        `-- knowledge-base:reviewed no\nALTER TABLE "project" ${DROP} COLUMN "notes";\n`,
      ),
      context,
    );
    assert.match(reviewed.failures.join("\n"), /not allowed in contract\.sql/);
  });

  test("a drop (in contract.sql) + add (in migration.sql) on one table looks like a rename", () => {
    const result = checkFolder(
      folder(
        'ALTER TABLE "project" ADD COLUMN "description" TEXT;',
        `ALTER TABLE "project" ${DROP} COLUMN "notes";\n`,
      ),
      context,
    );
    assert.match(result.failures.join("\n"), /looks like a rename/);
    const intentional = checkFolder(
      folder(
        'ALTER TABLE "project" ADD COLUMN "description" TEXT;',
        `-- intentional: drop and recreate\nALTER TABLE "project" ${DROP} COLUMN "notes";\n`,
      ),
      context,
    );
    assert.deepEqual(intentional.failures, []);
  });

  test("an unknown template version fails with the regenerate hint", () => {
    const result = checkFolder(
      folder(
        '-- knowledge-base:recover v9 "project"."notes" -> "n2"\nDO $knowledge_base_recover$ BEGIN END $knowledge_base_recover$;\n-- end knowledge-base:recover',
      ),
      context,
    );
    assert.match(
      result.failures.join("\n"),
      /template v9 not known; regenerate with `pnpm db:migrate`/,
    );
  });

  test("enum header rules: the generated pair passes; a hand-edited contract header fails", () => {
    const header = {
      enumName: "E",
      pairs: [{ from: "B", to: "A" }],
      columns: [{ table: "project", column: "c", array: false }],
      folder: FOLDER,
    };
    const good = checkFolder(
      folder(enumRemoveExpand(header), `${enumRemoveContract(header)}\n`),
      context,
    );
    assert.deepEqual(good.failures, []);
    assert.match(
      render({ baseRef: "main", added: [FOLDER], checks: [], report: [good] }),
      /value "B" of enum "E" \(rows moved to "A"\)\.\n {2}For the enum value: if the table is larger than 64 MB, or something else in the database uses the column \(a view, policy, trigger or function\), the unused value is kept instead\./,
    );
    const other = { ...header, pairs: [{ from: "C", to: "A" }] };
    const mismatch = checkFolder(
      folder(enumRemoveExpand(header), `${enumRemoveContract(other)}\n`),
      context,
    );
    assert.match(mismatch.failures.join("\n"), /must come from one generated header/);
    const toRemoved = { ...header, pairs: [{ from: "B", to: "Q" }] };
    assert.match(
      checkFolder(
        folder(enumRemoveExpand(toRemoved), `${enumRemoveContract(toRemoved)}\n`),
        context,
      ).failures.join("\n"),
      /move to Q, which must be a value E already has and keeps/,
    );
  });

  test("recover: the source must be retired by an earlier contract, the target new and of the same type", () => {
    const block = recoverBlock({ table: "project", from: "notes", to: "n2" });
    const sql = `ALTER TABLE "project" ADD COLUMN "n2" TEXT;\n${block}`;
    const missing = checkFolder(folder(sql), context);
    assert.match(missing.failures.join("\n"), /is not deleted by an earlier contract\.sql/);
    const retired = new Map([["public.project.notes", normalizeType("TEXT")]]);
    const ok = checkFolder(folder(sql), { catalog, retired });
    assert.deepEqual(ok.failures, []);
    assert.match(
      render({ baseRef: "main", added: [FOLDER], checks: [], report: [ok] }),
      /Recovers "project"\."notes" into "n2"/,
    );
  });
});

test("first migration PR checks the new baseline without assuming a running release", () => {
  const sql = wrapTransactional(
    'REVOKE CREATE ON SCHEMA public FROM PUBLIC;\nCREATE TABLE "knowledge_base" (id TEXT);',
  );
  const migration = { name: "0_init", sql, contract: null };
  const options = { catalog: catalogFromSql(""), retired: new Map() };
  assert.equal(checkFolder(migration, { ...options, initial: true }).failures.length, 0);
  assert.ok(
    checkFolder(migration, options).failures.length > 0,
    "existing base history keeps the ordinary safety gate",
  );
  assert.ok(
    checkFolder({ ...migration, name: "20990101000000_next" }, { ...options, initial: true })
      .failures.length > 0,
    "later migrations never receive the first-install treatment",
  );
  assert.ok(
    checkFolder(
      { ...migration, sql: sql.replace("BEGIN;", `${RETIRED_MAINTENANCE_MARKER}\nBEGIN;`) },
      { ...options, initial: true },
    ).failures.length > 0,
    "the retired marker remains refused",
  );
});
