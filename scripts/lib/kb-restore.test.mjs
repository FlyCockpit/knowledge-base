import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { putPinnedAgeOnPath } from "./age-pin.mjs";
import { encryptBundle } from "./kb-backup.mjs";
import { extractBundle, RESTORE_SURFACE, restoreOffline } from "./kb-restore.mjs";

// Real age for fixtures and the code under test: the repo's pinned release.
await putPinnedAgeOnPath();

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
  version: 1,
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
    Buffer.from("kb/backup/1\n" + JSON.stringify({ metadata, inventory }) + "\n"),
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
  const s3Metadata = { ...metadata, storage };
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
      metadata: s3Metadata,
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
    if (i === 0) assert.equal((await extractBundle(file, f.identity, stage)).metadata.version, 1);
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
      // The format readApplicationCatalog writes: JSON array text.
      definition: JSON.stringify(
        [...type[2].matchAll(/'((?:''|[^'])*)'/g)].map((m) => m[1].replaceAll("''", "'")),
      ),
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

test("encrypted bundles with an unknown header are refused", async (t) => {
  const f = await fixture(t);
  for (const version of [0, 2]) {
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
    await assert.rejects(extractBundle(f.file, f.identity, f.stage), /INVALID_RESTORE_BUNDLE/);
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
  kind.definition = JSON.stringify(
    JSON.parse(kind.definition).filter((label) => label !== "PROBE"),
  );
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
      row.definition = JSON.stringify(
        JSON.parse(row.definition).filter((value) => value !== label),
      );
      assert.throws(
        () => validateRestoreCompatibility(altered, [baseline], [baseline]),
        /COMPATIBLE_IMAGE/,
        `${type}.${label}`,
      );
    }
  }
});

test("enum labels are read in readApplicationCatalog's JSON array format; anything else is refused", async () => {
  const { validateRestoreCompatibility } = await import("./kb-restore.mjs");
  const { baseline, snapshot } = compatibilityFixture();
  // The fixture writes what the real catalog query writes; it must pass.
  assert.doesNotThrow(() => validateRestoreCompatibility(snapshot, [baseline], [baseline]));
  const row = snapshot.sourceCatalog.find(
    (r) => r.kind === "enum" && r.identity === "DurableJobKind",
  );
  const labels = JSON.parse(row.definition);
  for (const definition of [
    labels.join(","),
    "not json",
    JSON.stringify({ labels }),
    "null",
    // Every required label present, plus a member pg_enum could never hold.
    JSON.stringify([...labels, null]),
    JSON.stringify([...labels, 1]),
    JSON.stringify([...labels, { label: "x" }]),
    JSON.stringify([...labels, ["nested"]]),
    JSON.stringify([...labels, labels[0]]),
  ]) {
    const altered = structuredClone(snapshot);
    altered.sourceCatalog.find(
      (r) => r.kind === "enum" && r.identity === "DurableJobKind",
    ).definition = definition;
    assert.throws(
      () => validateRestoreCompatibility(altered, [baseline], [baseline]),
      /COMPATIBLE_IMAGE/,
      definition,
    );
  }
});

test("a missing age client is reported as such, not as a corrupt bundle, and never hangs", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "kb-restore-no-age-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // Isolated PATH: only a `node` link, no age.
  await symlink(process.execPath, join(dir, "node"));
  const cipher = Buffer.from("age-encryption.org/v1\nfixture\n");
  const file = join(dir, "backup.age");
  await writeFile(file, cipher);
  await writeFile(
    `${file}.complete`,
    JSON.stringify({
      version: 1,
      size: cipher.length,
      sha256: createHash("sha256").update(cipher).digest("hex"),
    }),
  );
  const identity = join(dir, "identity");
  await writeFile(identity, "inert\n");
  const stage = join(dir, "stage");
  await mkdir(stage);
  const path = process.env.PATH;
  process.env.PATH = dir;
  try {
    await assert.rejects(extractBundle(file, identity, stage), {
      code: "RESTORE_DECRYPT_CLIENT_MISSING",
    });
  } finally {
    process.env.PATH = path;
  }
});

// Exit 3 ("refused, nothing changed") is host.sh's cue to start the stopped
// writers again, so it must cover exactly the refusals before this run's first
// restore-state write on a target with no earlier attempt.
const restoreModule = new URL("./kb-restore.mjs", import.meta.url).pathname;
const initVolumes = new URL("../init-kb-volumes.mjs", import.meta.url).pathname;
function fencedRestore(f, scenario) {
  // The real offline fence: both fence files flock'd (exclusive) on inherited
  // descriptors, as kb-supervisor --restore hands them over. The pg client is
  // a fake that records every statement and answers per scenario.
  const child = `
import { restoreOffline, restoreExitCode } from ${JSON.stringify(restoreModule)};
const scenario = process.env.SCENARIO;
const sent = [];
const controller = new AbortController();
if (scenario === "cancelled") controller.abort();
const createClient = () => ({
  on() {},
  async connect() {},
  async end() {},
  async query(sql) {
    sent.push(sql);
    if (sql.includes("pg_try_advisory_lock")) return { rows: [{ held: !scenario.endsWith("busy") }] };
    if (sql.includes("to_regclass('knowledge_base_control.kb_restore')")) {
      if (scenario === "probe-fails-busy") throw Object.assign(new Error("lost"), { code: "57P01" });
      return { rows: [{ present: scenario.startsWith("pending") || scenario === "ready-busy" }] };
    }
    if (sql.startsWith("SELECT 1 FROM knowledge_base_control.kb_restore WHERE singleton AND state<>'READY'"))
      return { rows: scenario.startsWith("pending") ? [{}] : [] };
    if (sql.startsWith("SELECT * FROM knowledge_base_control.kb_restore"))
      return { rows: scenario === "earlier-attempt" ? [{ attempt_id: "other", source_hash: "other", state: "STAGING" }]
        : scenario === "restored-before" ? [{ attempt_id: "other", source_hash: "other", state: "READY" }]
        : scenario === "same-ready" ? [{ attempt_id: process.env.ATTEMPT, source_hash: process.env.SOURCE_HASH, state: "READY", inventory: [] }]
        : [] };
    if (sql.startsWith("UPDATE knowledge_base_control.kb_restore SET state='PROMOTING'")) throw Object.assign(new Error("lost"), { code: "57P01" });
    if (sql.includes("FROM pg_class c JOIN pg_namespace")) return { rows: scenario === "occupied" ? [{}] : [] };
    if (sql.startsWith("INSERT INTO knowledge_base_control.kb_restore")) throw Object.assign(new Error("lost"), { code: "57P01" });
    return { rows: [] };
  },
});
try {
  await restoreOffline({ file: process.env.BUNDLE, identity: process.env.IDENTITY, attemptId: process.env.ATTEMPT,
    connectionString: "postgresql://fixture/kb", dataDir: process.env.DATA, signal: controller.signal, createClient });
  console.log(JSON.stringify({ ok: true }));
} catch (error) {
  console.log(JSON.stringify({ code: error.code, exit: restoreExitCode(error), insert: sent.some((sql) => sql.startsWith("INSERT")) }));
}`;
  const script = join(f.dir, "fenced-restore.mjs");
  return writeFile(script, child).then(() => {
    const out = execFileSync(
      "bash",
      [
        "-c",
        'set -e; exec 7<>"$REPOS/.private/server.fence"; flock -x 7; exec 8<>"$REPOS/.private/worker.fence"; flock -x 8; KB_FENCE_FD=7 KB_WORKER_FENCE_FD=8 exec node "$0"',
        script,
      ],
      {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          SCENARIO: scenario,
          BUNDLE: f.file,
          IDENTITY: f.identity,
          ATTEMPT: f.attemptId,
          SOURCE_HASH: f.sourceHash ?? "",
          DATA: f.data,
          REPOS: f.repos,
        },
      },
    );
    return JSON.parse(out.trim().split("\n").at(-1));
  });
}

test("restore refusals before any restore-state write exit 3; anything after the intent, or with an earlier attempt, exits 1", async (t) => {
  const f = await fixture(t);
  await encryptBundle({ ...f, metadata, sources: [] });
  const { ensureKbDataSkeleton, kbDataPaths } = await import(initVolumes);
  f.data = join(f.dir, "data");
  ensureKbDataSkeleton(f.data);
  f.repos = kbDataPaths(f.data).reposDir;
  f.attemptId = randomUUID();
  // verifyEncryptedBundle's source hash is the bundle's own SHA-256.
  f.sourceHash = createHash("sha256").update(readFileSync(f.file)).digest("hex");
  for (const [scenario, expected] of [
    ["occupied", { code: "RESTORE_EMPTY_TARGET_REQUIRED", exit: 3, insert: false }],
    ["busy", { code: "RESTORE_MAINTENANCE_BUSY", exit: 3, insert: false }],
    ["cancelled", { code: "RESTORE_FAILED_FENCE", exit: 3, insert: false }],
    // An earlier attempt's intent is restore state: the writers stay stopped.
    ["earlier-attempt", { code: "RESTORE_ATTEMPT_CONFLICT", exit: 1, insert: false }],
    // A pending earlier attempt seen by the probe: a refusal before its row is
    // read (busy) is not "nothing changed"; neither is an unknown probe.
    ["pending-busy", { code: "RESTORE_MAINTENANCE_BUSY", exit: 1, insert: false }],
    ["ready-busy", { code: "RESTORE_MAINTENANCE_BUSY", exit: 3, insert: false }],
    ["probe-fails-busy", { code: "RESTORE_MAINTENANCE_BUSY", exit: 1, insert: false }],
    // A finished (READY) restore is a live target that admits the writers:
    // refusing another attempt there changed nothing.
    ["restored-before", { code: "RESTORE_ATTEMPT_CONFLICT", exit: 3, insert: false }],
    // Re-entering the same READY attempt writes PROMOTING first: not refused.
    ["same-ready", { code: "RESTORE_FAILED_FENCE_57P01", exit: 1, insert: false }],
    // The intent write was sent (the session died on it): not "nothing changed".
    ["write-failed", { code: "RESTORE_FAILED_FENCE_57P01", exit: 1, insert: true }],
  ]) {
    assert.deepEqual(await fencedRestore(f, scenario), expected, scenario);
  }
  // The real CLI, fenced: a mistyped attempt UUID is named (not a generic
  // RESTORE_FAILED) and refused with nothing changed.
  const cli = spawnSync(
    "bash",
    [
      "-c",
      'exec 7<>"$REPOS/.private/server.fence"; flock -x 7; exec 8<>"$REPOS/.private/worker.fence"; flock -x 8; KB_FENCE_FD=7 KB_WORKER_FENCE_FD=8 exec node "$0" "$BUNDLE" "$IDENTITY" not-a-uuid',
      restoreModule,
    ],
    {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        BUNDLE: f.file,
        IDENTITY: f.identity,
        REPOS: f.repos,
        KB_DATA_ROOT: f.data,
      },
    },
  );
  assert.equal(cli.status, 3, cli.stderr);
  assert.match(cli.stderr, /^REFUSED: INVALID_RESTORE_ATTEMPT; nothing was changed\./);
});

test("refusals before the fence and the CLI's argument check are exit 3 too", async (t) => {
  const f = await fixture(t);
  const { restoreExitCode } = await import("./kb-restore.mjs");
  for (const [options, code] of [
    [{ dataDir: undefined }, "RESTORE_DATA_ROOT_REQUIRED"],
    [{ dataDir: f.dir }, undefined],
  ]) {
    const error = await restoreOffline({ ...options, attemptId: randomUUID() }).then(
      () => assert.fail("expected a refusal"),
      (caught) => caught,
    );
    if (code) assert.equal(error.code, code);
    else assert.match(error.message, /fence/);
    assert.equal(restoreExitCode(error), 3, String(code));
  }
  assert.equal(restoreExitCode(new Error("unclassified")), 1);
  const cli = (() => {
    try {
      execFileSync(process.execPath, [restoreModule, "a.age", "id", randomUUID(), "--bogus"], {
        encoding: "utf8",
        stdio: "pipe",
        env: { PATH: process.env.PATH },
      });
      return { status: 0 };
    } catch (error) {
      return { status: error.status, stderr: error.stderr };
    }
  })();
  assert.equal(cli.status, 3);
  assert.match(cli.stderr, /^REFUSED: RESTORE_INVALID_ARGUMENTS; nothing was changed\./);
});
