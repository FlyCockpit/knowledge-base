import assert from "node:assert/strict";
import { test } from "node:test";
import { foldFixtures, inventory } from "./baseline.mjs";

const R = "20990110000000_release_2";
const P1 = "20990101000000_one";

test("foldFixtures concatenates fixtures and checks in apply order", () => {
  const files = {
    "0_init.sql": "INSERT INTO t VALUES (1);\n",
    [`${R}/${P1}.sql`]: "INSERT INTO t VALUES (2);",
    [`${R}.check.sql`]: "SELECT 1 WHERE false;",
  };
  const folded = foldFixtures(["0_init", `${R}/${P1}`, R], (f) => files[f] ?? null);
  assert.equal(
    folded[".sql"],
    `-- from 0_init.sql\nINSERT INTO t VALUES (1);\n\n-- from ${R}/${P1}.sql\nINSERT INTO t VALUES (2);\n`,
  );
  assert.equal(folded[".check.sql"], `-- from ${R}.check.sql\nSELECT 1 WHERE false;\n`);
  assert.deepEqual(
    foldFixtures(["0_init"], () => null),
    { ".sql": null, ".check.sql": null },
  );
});

test("inventory: the files a template history holds are recognized, in apply order", () => {
  const listing = inventory({
    folders: [
      { name: "0_init", entries: ["migration.sql"] },
      {
        name: R,
        entries: ["migration.sql", "contract.sql", "replaces.json", `replaced/${P1}/migration.sql`],
      },
    ],
    releases: [{ name: R, replaces: [{ name: P1 }] }],
    sections: new Map([[R, [P1]]]),
    fixtures: [
      { name: "0_init.sql", inner: null },
      { name: R, inner: [`${P1}.sql`] },
      { name: `${R}.check.sql`, inner: null },
    ],
    other: ["migration_lock.toml"],
  });
  assert.deepEqual(listing, { unknown: [], stems: ["0_init", `${R}/${P1}`, R] });
});

test("inventory: anything else is reported (baseline would otherwise delete it)", () => {
  const listing = inventory({
    folders: [{ name: "0_init", entries: ["migration.sql", "notes.md"] }],
    releases: [],
    fixtures: [
      { name: "draft.sql", inner: null },
      { name: "0_init.sql", inner: null },
      { name: "stray", inner: ["x.sql"] },
    ],
    other: ["migration_lock.toml", "README.md"],
  });
  assert.deepEqual(listing.unknown.sort(), [
    "fixtures/draft.sql",
    "fixtures/stray/x.sql",
    "migrations/0_init/notes.md",
    "migrations/README.md",
  ]);
});

test("inventory: one release later (replaces.json gone) its fixtures are still recognized through its sections", () => {
  const listing = inventory({
    folders: [
      { name: "0_init", entries: ["migration.sql"] },
      { name: R, entries: ["migration.sql", "contract.sql"] },
    ],
    releases: [],
    sections: new Map([
      ["0_init", []],
      [R, [P1]],
    ]),
    fixtures: [
      { name: R, inner: [`${P1}.sql`] },
      { name: `${R}.check.sql`, inner: null },
    ],
    other: ["migration_lock.toml"],
  });
  assert.deepEqual(listing, { unknown: [], stems: ["0_init", `${R}/${P1}`, R] });
});
