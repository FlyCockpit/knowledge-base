import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { encryptBundle } from "./kb-backup.mjs";
import { extractBundle, RESTORE_SURFACE, restoreOffline } from "./kb-restore.mjs";

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "kb-restore-unit-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const identity = join(dir, "identity");
  execFileSync("age-keygen", ["-pq", "-o", identity], { stdio: "pipe" });
  const recipient = execFileSync("age-keygen", ["-y", identity], { encoding: "utf8" }).trim();
  const file = join(dir, "backup.age");
  const stage = join(dir, "stage");
  await mkdir(stage);
  return { dir, identity, recipient, file, stage };
}
const metadata = {
  version: 3,
  storage: { mode: "disk" },
  instanceId: "00000000-0000-4000-8000-000000000001",
  authorityEpoch: "1",
  cutoff: "2026-10-08T00:00:00.000Z",
  heads: [],
  migrationHistory: { version: 1, schema: "public", migrations: [], applied: [], contracts: [] },
  sourceCatalog: [],
};
async function forged(f, inventory, bytes = Buffer.from("dump"), extra = "") {
  inventory = [
    ...inventory,
    ...["schema/migrations/migration_lock.toml", "schema/migrations/0_init/migration.sql"].map(
      (path) => ({
        path,
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      }),
    ),
  ];
  const body = Buffer.concat([
    Buffer.from("kb/backup/3\n" + JSON.stringify({ metadata, inventory }) + "\n"),
    ...inventory.flatMap((entry) => [
      Buffer.from(JSON.stringify({ path: entry.path, size: entry.size }) + "\n"),
      bytes,
      Buffer.from("\n"),
    ]),
    Buffer.from('{"complete":true}\n' + extra),
  ]);
  const cipher = execFileSync("age", ["-r", f.recipient], { input: body });
  await writeFile(f.file, cipher);
  await writeFile(
    `${f.file}.complete`,
    JSON.stringify({
      version: 1,
      size: cipher.length,
      sha256: createHash("sha256").update(cipher).digest("hex"),
    }),
  );
}

test("empty/default restore and unfenced caller fail before any destination mutation", async (t) => {
  const f = await fixture(t);
  await encryptBundle({ ...f, metadata, sources: [] });
  await assert.rejects(extractBundle(f.file, f.identity, f.stage), /Incomplete restore inventory/);
  await assert.rejects(restoreOffline({ dataDir: f.dir, attemptId: randomUUID() }), /fence/);
});

test("a missing or relative data root is refused before the fence check or any IO", async (t) => {
  const f = await fixture(t);
  const relative = `kb-restore-relative-${randomUUID()}`;
  for (const dataDir of [undefined, relative]) {
    await assert.rejects(
      restoreOffline({ dataDir, file: join(f.dir, "missing.age"), attemptId: randomUUID() }),
      (error) => error.code === "RESTORE_DATA_ROOT_REQUIRED",
    );
  }
  await assert.rejects(stat(relative), { code: "ENOENT" });
});

test("streamed extraction verifies frames, hashes, terminator, budgets and safe paths", async (t) => {
  const f = await fixture(t);
  const bytes = Buffer.from("dump");
  const entry = {
    path: "postgres.dump",
    size: 4,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  for (const inventory of [
    [entry, { ...entry, path: "../escape" }],
    [entry, { ...entry, path: "schema/../escape" }],
    [entry, entry],
    [{ ...entry, size: -1 }],
    [{ ...entry, sha256: "0".repeat(64) }],
    [entry, { ...entry, path: "models/weights" }],
    [
      entry,
      { ...entry, path: "schema/migrations/0_init" },
      { ...entry, path: "schema/migrations/0_init/migration.sql" },
    ],
  ]) {
    await forged(f, inventory);
    await assert.rejects(extractBundle(f.file, f.identity, f.stage));
  }
  await forged(f, [entry], bytes, "trailing");
  await assert.rejects(
    extractBundle(f.file, f.identity, f.stage),
    /INCOMPLETE_RESTORE_BUNDLE|RESTORE_TRAILING_BYTES/,
  );
  await forged(f, [entry]);
  const verified = await extractBundle(f.file, f.identity, f.stage);
  assert.equal(verified.inventory.length, 3);
  assert.equal(await readFile(join(f.stage, "postgres.dump"), "utf8"), "dump");
  await assert.rejects(extractBundle(f.file, f.identity, f.stage, { maxBytes: 1 }));
  const wrong = join(f.dir, "wrong");
  execFileSync("age-keygen", ["-o", wrong], { stdio: "pipe" });
  await assert.rejects(extractBundle(f.file, wrong, f.stage));
});

test("extraction rejects symlink staging parents and leaves prior target untouched", async (t) => {
  const f = await fixture(t);
  const previous = join(f.dir, "previous");
  await mkdir(previous);
  await writeFile(join(previous, "sentinel"), "prior live bytes");
  const stage = join(f.dir, "link");
  await symlink(previous, stage);
  const bytes = Buffer.from("dump");
  await forged(f, [
    { path: "postgres.dump", size: 4, sha256: createHash("sha256").update(bytes).digest("hex") },
  ]);
  await assert.rejects(extractBundle(f.file, f.identity, stage));
  assert.equal(await readFile(join(previous, "sentinel"), "utf8"), "prior live bytes");
});

test("S3 extraction dispatches explicitly, excludes CAS and validates streamed inventory rows", async (t) => {
  const f = await fixture(t);
  const storage = {
    mode: "s3",
    locator: JSON.stringify({
      version: 1,
      mode: "s3",
      endpoint: null,
      bucket: "assets",
      region: "us-east-1",
      prefix: "",
      forcePathStyle: true,
    }),
  };
  const v2 = { ...metadata, version: 3, storage };
  const inventory = join(f.dir, "refs");
  const bytes = JSON.stringify({ hash: `sha256:${"a".repeat(64)}`, size: 5 }) + "\n";
  const source = join(f.dir, "data");
  await writeFile(source, "dump");
  for (const [i, text] of [
    bytes,
    bytes + bytes,
    "x".repeat(257),
    JSON.stringify({ hash: `sha256:${"a".repeat(64)}`, size: 0 }) + "\n",
    bytes.trim(),
  ].entries()) {
    await writeFile(inventory, text);
    const file = join(f.dir, `s3-${i}.age`);
    await encryptBundle({
      ...f,
      file,
      metadata: v2,
      sources: [
        ...[
          "postgres.dump",
          "schema/migrations/migration_lock.toml",
          "schema/migrations/0_init/migration.sql",
        ].map((path) => ({ path, source })),
        { path: "asset-inventory.jsonl", source: inventory },
      ],
    });
    const stage = join(f.dir, `stage-${i}`);
    await mkdir(stage);
    if (i === 0) assert.equal((await extractBundle(file, f.identity, stage)).metadata.version, 3);
    else await assert.rejects(extractBundle(file, f.identity, stage));
  }
});

test("compatibility accepts an older applied prefix and retained pre-contract columns", async () => {
  const { validateRestoreCompatibility } = await import("./kb-restore.mjs");
  const { baseline, later, snapshot } = compatibilityFixture();
  assert.doesNotThrow(() => validateRestoreCompatibility(snapshot, [baseline], [baseline, later]));
  const beforeDrop = structuredClone(snapshot);
  beforeDrop.migrationHistory.migrations.push({
    name: later.name,
    checksum: later.checksum,
    contractChecksum: later.contract.checksum,
  });
  beforeDrop.migrationHistory.applied.push({ name: later.name, checksum: later.checksum });
  beforeDrop.migrationHistory.contracts.push({
    name: later.name,
    contract_checksum: later.contract.checksum,
    contract_applied_at: null,
  });
  beforeDrop.sourceCatalog.push({
    kind: "column",
    identity: "account.retired",
    definition: '["text",false,"","",null]',
  });
  assert.doesNotThrow(() =>
    validateRestoreCompatibility(beforeDrop, [baseline, later], [baseline, later]),
  );
});

function compatibilityFixture() {
  const baseline = {
    name: "0_init",
    checksum: "a".repeat(64),
    contract: null,
    sql: readFileSync(
      new URL("../../packages/db/prisma/migrations/0_init/migration.sql", import.meta.url),
      "utf8",
    ),
  };
  const later = {
    name: "1_later",
    checksum: "b".repeat(64),
    sql: "-- expansion",
    contract: { checksum: "c".repeat(64), sql: "-- future deletion" },
  };
  const snapshot = {
    migrationHistory: {
      version: 1,
      schema: "public",
      migrations: [{ name: baseline.name, checksum: baseline.checksum, contractChecksum: null }],
      applied: [{ name: baseline.name, checksum: baseline.checksum }],
      contracts: [],
    },
    sourceCatalog: [],
  };
  for (const table of baseline.sql.matchAll(/CREATE TABLE "([^"\n]+)" \(([\s\S]*?)\n\);/g)) {
    for (const column of table[2].matchAll(/^ {4}"([^"\n]+)" ([^\n]+)$/gm)) {
      const type = column[2].split(/ NOT NULL| DEFAULT|,$/)[0];
      snapshot.sourceCatalog.push({
        kind: "column",
        identity: `${table[1]}.${column[1]}`,
        definition: JSON.stringify([
          type,
          column[2].includes(" NOT NULL"),
          "",
          "",
          column[2].includes(" DEFAULT ") ? "default" : null,
        ]),
      });
    }
  }
  for (const type of baseline.sql.matchAll(/CREATE TYPE "([^"\n]+)" AS ENUM \(([^;]+)\);/g)) {
    snapshot.sourceCatalog.push({
      kind: "enum",
      identity: type[1],
      definition: [...type[2].matchAll(/'((?:''|[^'])*)'/g)]
        .map((m) => m[1].replaceAll("''", "'"))
        .join(","),
    });
  }
  return { baseline, later, snapshot };
}

test("compatibility refuses unknown history/checksums and every unsupported projection before import", async () => {
  const { validateRestoreCompatibility } = await import("./kb-restore.mjs");
  const { baseline, snapshot } = compatibilityFixture();
  for (const mutate of [
    (m) => (m.migrationHistory.applied[0].checksum = "d".repeat(64)),
    (m) =>
      m.sourceCatalog.splice(
        m.sourceCatalog.findIndex((r) => r.identity === "account.id"),
        1,
      ),
    (m) =>
      (m.sourceCatalog.find((r) => r.identity === "account.id").definition =
        '["integer",true,"","",null]'),
    (m) => (m.sourceCatalog.find((r) => r.identity === "DurableJobKind").definition = "PROBE"),
    (m) =>
      (m.sourceCatalog.find((r) => r.identity === "account.accessToken").definition =
        '["text",true,"","",null]'),
    (m) =>
      m.sourceCatalog.push({
        kind: "column",
        identity: "durable_job.requiredNewField",
        definition: '["text",true,"","",null]',
      }),
  ]) {
    const altered = structuredClone(snapshot);
    mutate(altered);
    assert.throws(() => validateRestoreCompatibility(altered, [baseline], [baseline]));
  }
  assert.throws(
    () =>
      validateRestoreCompatibility(
        snapshot,
        [baseline],
        [{ ...baseline, checksum: "e".repeat(64) }],
      ),
    /COMPATIBLE_IMAGE/,
  );
});

test("prerelease encrypted bundle headers are explicitly refused", async (t) => {
  const f = await fixture(t);
  for (const version of [1, 2]) {
    const cipher = execFileSync("age", ["-r", f.recipient], {
      input: `kb/backup/${version}\n{}\n`,
    });
    await writeFile(f.file, cipher);
    await writeFile(
      `${f.file}.complete`,
      JSON.stringify({
        version: 1,
        size: cipher.length,
        sha256: createHash("sha256").update(cipher).digest("hex"),
      }),
    );
    await assert.rejects(
      extractBundle(f.file, f.identity, f.stage),
      /PRERELEASE_FORMAT_UNSUPPORTED/,
    );
  }
});

test("source catalog comparison ignores only privileges omitted by pg_dump", async () => {
  const { comparableRestoreCatalog, validateRestoreCompatibility } = await import(
    "./kb-restore.mjs"
  );
  const a = [
    { kind: "relation", identity: "account", definition: '["r",["source=arwdDxt/source"],null]' },
    { kind: "schema", identity: "public", definition: "source privileges" },
    { kind: "constraint", identity: "account.pk", definition: "PRIMARY KEY (id)" },
  ];
  const b = structuredClone(a);
  b[0].definition = '["r",null,null]';
  b[1].definition = "target privileges";
  assert.deepEqual(comparableRestoreCatalog(a), comparableRestoreCatalog(b));
  b[2].definition = "PRIMARY KEY (other)";
  assert.notDeepEqual(comparableRestoreCatalog(a), comparableRestoreCatalog(b));
  const { baseline, snapshot } = compatibilityFixture();
  baseline.sql = baseline.sql.replaceAll("TIMESTAMP(3)", "TIMESTAMPTZ(3)");
  for (const row of snapshot.sourceCatalog) {
    const definition = row.kind === "column" ? JSON.parse(row.definition) : null;
    if (definition?.[0] === "TIMESTAMP(3)") {
      definition[0] = "timestamp(3) with time zone";
      row.definition = JSON.stringify(definition);
    }
  }
  assert.doesNotThrow(() => validateRestoreCompatibility(snapshot, [baseline], [baseline]));
});

test("same-image post-contract restore permits retired baseline columns and unused enum labels", async () => {
  const { validateRestoreCompatibility } = await import("./kb-restore.mjs");
  const { baseline, later, snapshot } = compatibilityFixture();
  snapshot.migrationHistory.migrations.push({
    name: later.name,
    checksum: later.checksum,
    contractChecksum: later.contract.checksum,
  });
  snapshot.migrationHistory.applied.push({ name: later.name, checksum: later.checksum });
  snapshot.migrationHistory.contracts.push({
    name: later.name,
    contract_checksum: later.contract.checksum,
    contract_applied_at: new Date().toISOString(),
  });
  snapshot.sourceCatalog = snapshot.sourceCatalog.filter((r) => r.identity !== "user.image");
  const kind = snapshot.sourceCatalog.find(
    (r) => r.kind === "enum" && r.identity === "DurableJobKind",
  );
  kind.definition = kind.definition
    .split(",")
    .filter((label) => label !== "PROBE")
    .join(",");
  assert.doesNotThrow(() =>
    validateRestoreCompatibility(snapshot, [baseline, later], [baseline, later]),
  );
});

test("every explicit restore column and enum label is required before import", async () => {
  const { validateRestoreCompatibility } = await import("./kb-restore.mjs");
  const { baseline, snapshot } = compatibilityFixture();
  for (const [table, columns] of Object.entries(RESTORE_SURFACE.columns)) {
    for (const column of columns.split(" ")) {
      const altered = structuredClone(snapshot);
      altered.sourceCatalog = altered.sourceCatalog.filter(
        (r) => r.identity !== `${table}.${column}`,
      );
      assert.throws(
        () => validateRestoreCompatibility(altered, [baseline], [baseline]),
        /COMPATIBLE_IMAGE/,
        `${table}.${column}`,
      );
    }
  }
  for (const [type, labels] of Object.entries(RESTORE_SURFACE.enums)) {
    for (const label of labels.split(" ")) {
      const altered = structuredClone(snapshot);
      const row = altered.sourceCatalog.find((r) => r.kind === "enum" && r.identity === type);
      row.definition = row.definition
        .split(",")
        .filter((value) => value !== label)
        .join(",");
      assert.throws(
        () => validateRestoreCompatibility(altered, [baseline], [baseline]),
        /COMPATIBLE_IMAGE/,
        `${type}.${label}`,
      );
    }
  }
});
