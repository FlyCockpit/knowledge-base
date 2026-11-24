import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import { wrappedBody } from "./lib/replaces.mjs";
import { checkWrapper, wrapTransactional } from "./lib/sql.mjs";
import { buildRelease, releaseSlug } from "./release-squash.mjs";

const sha = (t) => createHash("sha256").update(t).digest("hex");
const migration = (name, sql, contract = null) => ({
  name,
  sql,
  checksum: sha(sql),
  contract: contract ? { sql: contract, checksum: sha(contract) } : null,
});
const R = "20990110000000_release_1_2_0";

describe("releaseSlug", () => {
  test("version-like names become folder-safe", () => {
    assert.equal(releaseSlug("1.2.0"), "1_2_0");
    assert.equal(releaseSlug("v2.0.0-rc.1"), "2_0_0_rc_1");
    assert.throws(() => releaseSlug("..."), /no usable folder name/);
  });
});

describe("buildRelease", () => {
  const a = migration(
    "20990101000000_a",
    wrapTransactional(
      'ALTER TABLE "t" ADD COLUMN "b" TEXT;\nUPDATE "t" SET "b" = upper("a") WHERE "b" IS NULL;',
    ),
  );
  const b = migration(
    "20990102000000_b",
    wrapTransactional('ALTER TABLE "t" ADD COLUMN "c" TEXT;'),
    'ALTER TABLE "t" DROP COLUMN "z";\n', // destructive:audited — fixture text, never executed.
  );
  test("concatenates the bodies in order inside one intact wrapper, with the manifest", () => {
    const built = buildRelease({ release: R, tag: "v1.1.0", migrations: [a, b] });
    assert.deepEqual(built.problems, []);
    assert.equal(checkWrapper(built.migrationSql).ok, true);
    const body = wrappedBody(built.migrationSql);
    assert.ok(
      body.indexOf("-- knowledge-base:from 20990101000000_a") <
        body.indexOf("-- knowledge-base:from 20990102000000_b"),
    );
    assert.match(body, /UPDATE "t" SET "b" = upper\("a"\)/);
    assert.equal(built.contractSql.match(/-- knowledge-base:from /g).length, 1);
    assert.deepEqual(built.manifest, {
      format: 1,
      release: R,
      tag: "v1.1.0",
      replaces: [
        { name: a.name, checksum: a.checksum, contractChecksum: null },
        { name: b.name, checksum: b.checksum, contractChecksum: b.contract.checksum },
      ],
    });
  });
  test("no contract.sql when nothing it replaces had one", () => {
    assert.equal(buildRelease({ release: R, tag: "v1", migrations: [a] }).contractSql, null);
  });
  test("refuses a migration without the wrapper and an enum-remove block", () => {
    const plain = migration("20990103000000_c", 'CREATE INDEX CONCURRENTLY "i" ON "t"("b");');
    assert.match(
      buildRelease({ release: R, tag: "v1", migrations: [a, plain] }).problems.join(),
      /no intact transactional wrapper/,
    );
    const enumRemove = migration(
      "20990104000000_d",
      wrapTransactional(
        '-- knowledge-base:enum-remove v1 "E" "B" -> "A" columns "t"."e"\nSELECT 1;',
      ),
    );
    assert.match(
      buildRelease({ release: R, tag: "v1", migrations: [enumRemove] }).problems.join(),
      /enum-remove block names objects after its folder/,
    );
  });
});
