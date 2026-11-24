import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import {
  folderBoundTemplates,
  needsReconcile,
  parseManifest,
  planReconcile,
  readReleases,
  readReplacedMigrations,
  remainingContract,
  splitSections,
  wrappedBody,
} from "./replaces.mjs";
import { wrapTransactional } from "./sql.mjs";

const sha = (text) => createHash("sha256").update(text).digest("hex");
const R = "20990110000000_release_2";
const P1 = "20990101000000_one";
const P2 = "20990102000000_two";
const SQL1 = wrapTransactional('ALTER TABLE "t" ADD COLUMN "b" TEXT;');
const SQL2 = wrapTransactional('CREATE TABLE "u" ("id" INTEGER);');
const CONTRACT2 = 'ALTER TABLE "t" DROP COLUMN "a";\n'; // destructive:audited — fixture text, never executed.

const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A migrations dir holding 0_init and release R (P1, P2 replaced; P2 with a contract). */
function fixture({ tamper = false, dropCopy = false, extraCopy = false, keepP1 = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "replaces-test-"));
  dirs.push(dir);
  const write = (rel, text) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  };
  write("0_init/migration.sql", wrapTransactional('CREATE TABLE "t" ("a" TEXT);'));
  if (keepP1) write(`${P1}/migration.sql`, SQL1);
  write(`${R}/migration.sql`, wrapTransactional("SELECT 1;"));
  write(`${R}/contract.sql`, `-- knowledge-base:from ${P2}\n${CONTRACT2}`);
  write(
    `${R}/replaces.json`,
    JSON.stringify({
      format: 1,
      release: R,
      replaces: [
        { name: P1, checksum: sha(SQL1), contractChecksum: null },
        { name: P2, checksum: sha(SQL2), contractChecksum: sha(CONTRACT2) },
      ],
    }),
  );
  write(`${R}/replaced/${P1}/migration.sql`, tamper ? `${SQL1}-- x\n` : SQL1);
  if (!dropCopy) write(`${R}/replaced/${P2}/migration.sql`, SQL2);
  write(`${R}/replaced/${P2}/contract.sql`, CONTRACT2);
  if (extraCopy) write(`${R}/replaced/20990103000000_three/migration.sql`, SQL2);
  return dir;
}

describe("readReleases", () => {
  test("an intact release: its replaced copies are read and verified", () => {
    const { releases, problems } = readReleases(fixture());
    assert.deepEqual(problems, []);
    assert.equal(releases.length, 1);
    assert.equal(releases[0].name, R);
    assert.deepEqual(
      releases[0].replaces.map((e) => [e.name, e.sql !== null, e.contract]),
      [
        [P1, true, null],
        [P2, true, CONTRACT2],
      ],
    );
  });
  test("a tampered copy is a problem and is not used", () => {
    const { releases, problems } = readReleases(fixture({ tamper: true }));
    assert.equal(problems.length, 1);
    assert.match(
      problems[0],
      /does not match the checksum in replaces\.json \(edited or tampered with\)/,
    );
    assert.equal(releases[0].replaces[0].sql, null);
  });
  test("a missing copy, an unlisted copy, a replaced folder that still exists", () => {
    assert.match(
      readReleases(fixture({ dropCopy: true })).problems.join(),
      /migration\.sql is missing/,
    );
    assert.match(
      readReleases(fixture({ extraCopy: true })).problems.join(),
      /is not listed in replaces\.json/,
    );
    assert.match(
      readReleases(fixture({ keepP1: true })).problems.join(),
      /is still a migration folder of its own/,
    );
  });
});

describe("readReplacedMigrations (backup snapshots and restore)", () => {
  test("lists every replaced migration with its release and manifest checksums", () => {
    assert.deepEqual(readReplacedMigrations(fixture()), [
      { name: P1, release: R, checksum: sha(SQL1), contractChecksum: null },
      { name: P2, release: R, checksum: sha(SQL2), contractChecksum: sha(CONTRACT2) },
    ]);
  });
  test("throws on any integrity problem instead of describing a partial history", () => {
    for (const options of [{ tamper: true }, { dropCopy: true }, { extraCopy: true }])
      assert.throws(() => readReplacedMigrations(fixture(options)), /manifests are invalid/);
  });
});

describe("parseManifest", () => {
  const entry = (name) => ({ name, checksum: "a".repeat(64), contractChecksum: null });
  const parse = (json, folder = R) => parseManifest(JSON.stringify(json), folder);
  test("accepts the written shape", () => {
    assert.equal(
      parse({ format: 1, release: R, replaces: [entry(P1), entry(P2)] }).problem,
      undefined,
    );
  });
  for (const [label, json, pattern] of [
    ["unknown format", { format: 2, release: R, replaces: [entry(P1)] }, /unknown format/],
    [
      "another folder's manifest",
      { format: 1, release: P2, replaces: [entry(P1)] },
      /but it is in folder/,
    ],
    ["empty list", { format: 1, release: R, replaces: [] }, /non-empty array/],
    ["listed twice", { format: 1, release: R, replaces: [entry(P1), entry(P1)] }, /listed twice/],
    ["out of order", { format: 1, release: R, replaces: [entry(P2), entry(P1)] }, /folder order/],
    [
      "sorts after the release",
      { format: 1, release: R, replaces: [entry("20990111000000_later")] },
      /does not sort before the release folder/,
    ],
    [
      "bad checksum",
      { format: 1, release: R, replaces: [{ ...entry(P1), checksum: "x" }] },
      /malformed entry/,
    ],
  ])
    test(`refuses: ${label}`, () => assert.match(parse(json).problem, pattern));
  test("refuses invalid JSON", () => assert.match(parseManifest("{", R).problem, /not valid JSON/));
});

describe("planReconcile", () => {
  const { releases } = readReleases(fixture());
  const row = (name, checksum, extra = {}) => ({
    migration_name: name,
    checksum,
    finished_at: new Date(),
    rolled_back_at: null,
    ...extra,
  });
  const local = ["0_init", R];
  const init = row("0_init", "x");
  test("none applied: nothing to do (the release applies normally)", () => {
    assert.deepEqual(planReconcile({ rows: [init], releases, localNames: local }), {
      steps: [],
      refusals: [],
    });
  });
  test("all applied: one step, nothing missing", () => {
    const plan = planReconcile({
      rows: [init, row(P1, sha(SQL1)), row(P2, sha(SQL2))],
      releases,
      localNames: local,
    });
    assert.deepEqual(plan.refusals, []);
    assert.deepEqual(plan.steps[0].missing, []);
    assert.deepEqual(plan.steps[0].present, [P1, P2]);
  });
  test("some applied: the missing ones come from replaced/", () => {
    const plan = planReconcile({ rows: [init, row(P1, sha(SQL1))], releases, localNames: local });
    assert.deepEqual(
      plan.steps[0].missing.map((e) => e.name),
      [P2],
    );
  });
  test("a rolled-back replaced row counts as not applied", () => {
    const plan = planReconcile({
      rows: [init, row(P1, sha(SQL1)), row(P2, sha(SQL2), { rolled_back_at: new Date() })],
      releases,
      localNames: local,
    });
    assert.deepEqual(
      plan.steps[0].missing.map((e) => e.name),
      [P2],
    );
  });
  for (const [label, rows, pattern] of [
    ["checksum mismatch", [init, row(P1, "other")], /checksum mismatch/],
    [
      "a failed replaced migration",
      [init, row(P1, sha(SQL1), { finished_at: null })],
      /recorded as failed/,
    ],
    ["release and replaced both recorded", [init, row(P1, sha(SQL1)), row(R, "y")], /records both/],
    [
      "an unknown applied migration",
      [init, row(P1, sha(SQL1)), row("20990105000000_branch", "z")],
      /neither in this image nor replaced by one of its releases: 20990105000000_branch/,
    ],
  ])
    test(`refuses: ${label}`, () => {
      const plan = planReconcile({ rows, releases, localNames: local });
      assert.match(plan.refusals.join(" "), pattern);
    });
  test("refuses when a missing replaced copy is unusable", () => {
    const broken = readReleases(fixture({ tamper: true })).releases;
    const plan = planReconcile({
      rows: [init, row(P2, sha(SQL2))],
      releases: broken,
      localNames: local,
    });
    assert.match(plan.refusals.join(" "), /copy is missing or does not match/);
  });
  test("needsReconcile: only when the ahead set names a replaced migration", () => {
    assert.equal(needsReconcile({ ahead: [P1] }, releases), true);
    assert.equal(needsReconcile({ ahead: ["20990105000000_branch"] }, releases), false);
    assert.equal(needsReconcile({ ahead: [] }, releases), false);
  });
});

describe("wrappedBody / sections", () => {
  test("wrappedBody returns exactly the body wrapTransactional wrapped", () => {
    const body = '-- a comment\nALTER TABLE "t" ADD COLUMN "b" TEXT;\nUPDATE "t" SET "b" = \'x\';';
    assert.equal(wrappedBody(wrapTransactional(body)), `${body}\n`);
  });
  test("wrappedBody refuses a file without the wrapper", () => {
    assert.throws(
      () => wrappedBody('CREATE INDEX CONCURRENTLY "i" ON "t"("a");'),
      /not a generated transactional migration/,
    );
  });
  test("splitSections and remainingContract drop the sections that already ran", () => {
    const sql = `-- head\n\n-- knowledge-base:from ${P1}\nA;\n\n-- knowledge-base:from ${P2}\nB;\n`;
    const { preamble, sections } = splitSections(sql);
    assert.equal(preamble, "-- head\n");
    assert.deepEqual(
      sections.map((s) => s.name),
      [P1, P2],
    );
    const m = { name: R, contract: { sql, checksum: "c" } };
    const rest = remainingContract(m, { contract_done_parts: [P1] });
    assert.equal(rest.contract.checksum, "c");
    assert.doesNotMatch(rest.contract.sql, /A;/);
    assert.match(rest.contract.sql, /B;/);
    assert.equal(remainingContract(m, { contract_done_parts: null }), m);
    assert.equal(remainingContract(m, undefined), m);
  });
  test("folderBoundTemplates finds enum-remove headers only", () => {
    assert.equal(folderBoundTemplates('-- knowledge-base:relax v1 "t"."x"\nSELECT 1;').length, 0);
    assert.equal(
      folderBoundTemplates('-- knowledge-base:enum-remove v1 "E" "B" -> "A" columns "t"."c"')
        .length,
      1,
    );
  });
});
