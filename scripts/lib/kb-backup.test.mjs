import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { putPinnedAgeOnPath } from "./age-pin.mjs";
import {
  coordinateBackup,
  encryptBundle,
  readBundle,
  verifyEncryptedBundle,
} from "./kb-backup.mjs";

// Real age for fixtures and the code under test: the repo's pinned release.
await putPinnedAgeOnPath();

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "kb-backup-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const identity = join(dir, "identity");
  const recipient = execFileSync("age-keygen", ["-pq", "-o", identity], { stdio: "pipe" });
  assert.ok(recipient !== undefined);
  const key = execFileSync("age-keygen", ["-y", identity], { encoding: "utf8" }).trim();
  const source = join(dir, "blob");
  await writeFile(source, "historic bytes");
  return { dir, identity, key, source, file: join(dir, "backup.age") };
}
const metadata = {
  version: 1,
  storage: { mode: "disk" },
  cutoff: "2026-10-08T00:00:00.000Z",
  instanceId: "test",
  authorityEpoch: "1",
  heads: [],
  migrationHistory: { version: 1, schema: "public", migrations: [], applied: [], contracts: [] },
  sourceCatalog: [],
};

test("empty bundle and primary encrypted action verify every byte with a PQ key", async (t) => {
  const f = await fixture(t);
  for (const sources of [
    [],
    [
      {
        path: `assets/objects/${createHash("sha256").update("historic bytes").digest("hex").slice(0, 2)}/${createHash("sha256").update("historic bytes").digest("hex").slice(2)}`,
        source: f.source,
      },
    ],
  ]) {
    const file = sources.length ? f.file : join(f.dir, "empty.age");
    await encryptBundle({ ...f, file, metadata, sources, recipient: f.key });
    await verifyEncryptedBundle(file);
    const result = await readBundle(file, f.identity);
    assert.equal(result.metadata.cutoff, metadata.cutoff);
    assert.equal(result.files.length, sources.length);
    if (sources.length) assert.equal(result.files[0].bytes.toString(), "historic bytes");
    assert.ok(!(await readFile(file)).includes(Buffer.from("historic bytes")));
  }
});

test("wrong identity, truncated cipher, missing completion and hash mismatch are rejected", async (t) => {
  const f = await fixture(t);
  await encryptBundle({ ...f, metadata, sources: [], recipient: f.key });
  const other = join(f.dir, "other");
  execFileSync("age-keygen", ["-o", other], { stdio: "pipe" });
  await assert.rejects(readBundle(f.file, other));
  const bytes = Buffer.from("a dump"),
    path = "postgres.dump";
  const bad = Buffer.concat([
    Buffer.from(
      "kb/backup/1\n" +
        JSON.stringify({
          metadata,
          inventory: [{ path, size: bytes.length, sha256: "0".repeat(64) }],
        }) +
        "\n" +
        JSON.stringify({ path, size: bytes.length }) +
        "\n",
    ),
    bytes,
    Buffer.from('\n{"complete":true}\n'),
  ]);
  const cipher = execFileSync("age", ["-r", f.key], { input: bad });
  await writeFile(f.file, cipher);
  await writeFile(
    `${f.file}.complete`,
    JSON.stringify({
      version: 1,
      size: cipher.length,
      sha256: createHash("sha256").update(cipher).digest("hex"),
    }),
  );
  await verifyEncryptedBundle(f.file);
  await assert.rejects(readBundle(f.file, f.identity), /hash/);
  await writeFile(f.file, (await readFile(f.file)).subarray(0, 40));
  await assert.rejects(verifyEncryptedBundle(f.file));
  await rm(`${f.file}.complete`);
  await assert.rejects(readBundle(f.file, f.identity));
});

test("path traversal, symlink sources, excluded roots and duplicate paths never become valid", async (t) => {
  const f = await fixture(t);
  const link = join(f.dir, "link");
  await symlink(f.source, link);
  for (const sources of [
    [{ path: "../escape", source: f.source }],
    [{ path: "models/weights", source: f.source }],
    [{ path: "schema/sql/manifest.json", source: f.source }],
    [{ path: "schema/migrations/0_init/untrusted.mjs", source: f.source }],
    [
      {
        path: "assets/objects/aa/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        source: f.source,
      },
    ],
    [{ path: "repos/kb_aaaaaaaaaaaaaaaaaaaaaaaa.git/config", source: link }],
    [
      { path: "postgres.dump", source: f.source },
      { path: "postgres.dump", source: f.source },
    ],
  ]) {
    await assert.rejects(encryptBundle({ ...f, metadata, sources, recipient: f.key }));
    await assert.rejects(verifyEncryptedBundle(f.file));
  }
});

test("failure at file/encryption boundaries leaves prior backup untouched and no valid partial", async (t) => {
  const f = await fixture(t);
  await encryptBundle({ ...f, metadata, sources: [], recipient: f.key });
  const previous = await readFile(f.file);
  for (const boundary of ["file", "encryption", "publish"]) {
    const file = join(f.dir, `${boundary}.age`);
    await assert.rejects(
      encryptBundle({
        ...f,
        file,
        metadata,
        recipient: f.key,
        sources: [{ path: "postgres.dump", source: f.source }],
        barrier: async (stage) => {
          if (stage === boundary) throw new Error("inert failure");
        },
      }),
    );
    await assert.rejects(verifyEncryptedBundle(file));
    assert.deepEqual(await readFile(f.file), previous);
  }
});

test("maintenance budget cannot be zero, unbounded, or extended beyond five minutes", async (t) => {
  const f = await fixture(t);
  for (const timeout of [0, -1, Number.NaN, 300001])
    await assert.rejects(
      coordinateBackup({
        connectionString: "postgresql://inert:inert@127.0.0.1:1/inert",
        recipient: f.key,
        dataDir: f.dir,
        backupDir: f.dir,
        timeout,
      }),
      /Invalid maintenance drain budget/,
    );
});

test("a missing or relative data root is refused before connecting", async (t) => {
  const f = await fixture(t);
  for (const dataDir of [undefined, "relative/data"])
    await assert.rejects(
      coordinateBackup({
        connectionString: "postgresql://inert:inert@127.0.0.1:1/inert",
        recipient: f.key,
        dataDir,
        backupDir: join(f.dir, "never-created"),
      }),
      /requires KB_DATA_ROOT/,
    );
  await assert.rejects(readFile(join(f.dir, "never-created")), { code: "ENOENT" });
});

test("S3 variant has only an encrypted streamed reference file and rechecks before completion", async (t) => {
  const f = await fixture(t);
  const { assetStorageDomain } = await import("./asset-storage-domain.mjs");
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
  const sources = [{ path: "asset-inventory.jsonl", source: f.source }];
  await writeFile(f.source, JSON.stringify({ hash: `sha256:${"a".repeat(64)}`, size: 5 }) + "\n");
  const s3Metadata = { ...metadata, storage };
  await encryptBundle({ ...f, metadata: s3Metadata, sources, recipient: f.key });
  const result = await readBundle(f.file, f.identity);
  assert.equal(result.metadata.version, 1);
  assert.deepEqual(
    result.files.map((e) => e.path),
    ["asset-inventory.jsonl"],
  );
  for (const [m, paths] of [
    [metadata, sources],
    [s3Metadata, []],
    [{ ...s3Metadata, storage: { ...storage, secret: "no" } }, sources],
  ]) {
    await assert.rejects(
      encryptBundle({
        ...f,
        file: join(f.dir, "invalid.age"),
        metadata: m,
        sources: paths,
        recipient: f.key,
      }),
    );
  }
  let checked = false;
  const failed = join(f.dir, "failed.age");
  await assert.rejects(
    encryptBundle({
      ...f,
      file: failed,
      metadata: s3Metadata,
      sources,
      recipient: f.key,
      beforeComplete: async () => {
        checked = true;
        throw Error("remote disappeared");
      },
    }),
  );
  assert.ok(checked);
  await assert.rejects(verifyEncryptedBundle(failed));
  const swapped = join(f.dir, "swapped.age");
  await assert.rejects(
    encryptBundle({
      ...f,
      file: swapped,
      metadata: s3Metadata,
      sources,
      recipient: f.key,
      beforeComplete: async () => {
        await writeFile(f.source, "");
      },
    }),
    /Asset inventory changed/,
  );
  await assert.rejects(verifyEncryptedBundle(swapped));
  assert.equal(
    (await assetStorageDomain()).checkAssetBundleStorage(storage).locator,
    storage.locator,
  );
});

test("dump identities and child forwarding preserve runtime comparison without its secret", async () => {
  const { validateAssetDumpIdentity } = await import("./backup-s3-env.mjs");
  const { assetOperatorEnv } = await import("./asset-storage-domain.mjs");
  const env = {
    KB_ASSET_S3_ENABLED: "true",
    KB_ASSET_S3_ACCESS_KEY_ID: "runtime-sentinel",
    KB_ASSET_S3_SECRET_ACCESS_KEY: "never-forward-sentinel",
    KB_ASSET_S3_OPERATOR_ACCESS_KEY_ID: "operator-sentinel",
    KB_ASSET_S3_OPERATOR_SECRET_ACCESS_KEY: "operator-secret-sentinel",
    BACKUP_S3_ACCESS_KEY_ID: "dump-sentinel",
  };
  validateAssetDumpIdentity(env);
  for (const patch of [
    { BACKUP_S3_ACCESS_KEY_ID: env.KB_ASSET_S3_ACCESS_KEY_ID },
    { BACKUP_S3_ACCESS_KEY_ID: env.KB_ASSET_S3_OPERATOR_ACCESS_KEY_ID },
    { KB_ASSET_S3_ACCESS_KEY_ID: undefined },
    { KB_ASSET_S3_OPERATOR_ACCESS_KEY_ID: undefined },
  ]) {
    assert.throws(
      () => validateAssetDumpIdentity({ ...env, ...patch }),
      (error) => !String(error).includes("sentinel"),
    );
  }
  assert.equal(assetOperatorEnv(env).KB_ASSET_S3_SECRET_ACCESS_KEY, undefined);
  assert.equal(assetOperatorEnv(env).KB_ASSET_S3_ACCESS_KEY_ID, "runtime-sentinel");
  assert.equal(
    assetOperatorEnv(env).KB_ASSET_S3_OPERATOR_SECRET_ACCESS_KEY,
    "operator-secret-sentinel",
  );
});

test("invalid bundle output identity is rejected before child admission or database IO", async () => {
  for (const patch of [{ backupDir: "relative" }, { runId: "bad-run-id" }]) {
    await assert.rejects(
      coordinateBackup({
        dataDir: "/tmp/inert-kb-root",
        backupDir: "/tmp/inert-backup-root",
        connectionString: "postgresql://inert:inert@127.0.0.1:1/inert",
        ...patch,
      }),
      /absolute BACKUP_DIR|Invalid backup run ID/,
    );
  }
});

for (const scenario of [
  "snapshot-failure",
  "incomplete-drain",
  "inherited-request",
  "snapshot-still-owns-lock",
])
  test(`maintenance cleanup: ${scenario}`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "kb-maintenance-test-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    let requested,
      cleared = false,
      locks = 0;
    const client = {
      end: async () => {},
      query: async (sql, params = []) => {
        if (/pg_try_advisory_lock/.test(sql)) {
          locks++;
          return { rows: [{ held: !(scenario === "snapshot-still-owns-lock" && locks === 3) }] };
        }
        if (/SELECT value FROM app_setting/.test(sql))
          return { rows: scenario === "inherited-request" ? [{ value: "prior" }] : [] };
        if (/INSERT INTO app_setting/.test(sql)) requested = params[1];
        if (/SELECT key FROM app_setting/.test(sql))
          return { rows: scenario === "incomplete-drain" ? [{ key: "unclean" }] : [] };
        if (/DELETE FROM app_setting WHERE key=\$1 AND value=\$2/.test(sql)) {
          assert.equal(params[1], requested);
          cleared = true;
        }
        return { rows: [] };
      },
    };
    let children = 0;
    await assert.rejects(
      coordinateBackup({
        assetEnvironment: {},
        dataDir: join(dir, "data"),
        backupDir: dir,
        recipient: "age1synthetic",
        connectionString: "unused",
        connectClient: async () => client,
        runChild: () => {
          children++;
          return {
            child: { stdin: { end() {} } },
            done: children === 1 ? Promise.resolve() : Promise.reject(Error("snapshot failed")),
          };
        },
      }),
    );
    assert.equal(cleared, scenario === "snapshot-failure");
    assert.equal(children, scenario === "incomplete-drain" ? 1 : 2);
  });

test("a database holding large objects is refused at backup time, before any dump", async () => {
  const { refuseLargeObjects } = await import("./kb-backup.mjs");
  const sent = [];
  const client = (present) => ({
    async query(sql) {
      sent.push(sql);
      return { rows: [{ present }] };
    },
  });
  await assert.rejects(refuseLargeObjects(client(true)), (error) => {
    assert.equal(error.code, "BACKUP_LARGE_OBJECTS");
    assert.match(error.message, /large objects[\s\S]*restore refuses/);
    return true;
  });
  await refuseLargeObjects(client(false));
  assert.deepEqual(sent, [
    "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_largeobject_metadata) AS present",
    "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_largeobject_metadata) AS present",
  ]);
});

test("the large-object check runs inside the exported snapshot, before pg_dump", async () => {
  const source = await readFile(new URL("./kb-backup.mjs", import.meta.url), "utf8");
  const snapshot = source.indexOf("SELECT pg_export_snapshot()");
  const check = source.indexOf("await refuseLargeObjects(client);");
  const dump = source.indexOf('"pg_dump",');
  assert.ok(snapshot > 0 && check > snapshot && dump > check, "snapshot → check → pg_dump");
  assert.ok(check < source.indexOf('open(dump, "wx"'), "no dump file is created first");
});

test("the CLI entry never holds module evaluation, so its upload import cannot deadlock", async () => {
  // deliverBackup imports upload-backup-to-s3.mjs, which imports kb-backup.mjs.
  // A top-level await in the entry would keep that import pending forever.
  // A slow fake `age` preflight keeps the CLI busy; evaluation must finish first.
  const dir = await mkdtemp(join(tmpdir(), "kb-backup-entry-"));
  try {
    await writeFile(join(dir, "age"), "#!/bin/sh\nsleep 1\nexit 1\n", { mode: 0o755 });
    const entry = new URL("./kb-backup.mjs", import.meta.url).pathname;
    const script = `process.argv.splice(1, Infinity, ${JSON.stringify(entry)}, "coordinate");
await import(${JSON.stringify(entry)});
console.error("EVALUATED");`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      env: {
        PATH: `${dir}:/usr/bin:/bin`,
        KB_DATA_ROOT: join(dir, "data"),
        BACKUP_DIR: join(dir, "backups"),
        BACKUP_AGE_RECIPIENT: "age1entrytest",
      },
      timeout: 30_000,
    });
    const output = result.stderr;
    assert.ok(output.includes("FATAL: quiesced backup failed"), output);
    assert.ok(output.indexOf("EVALUATED") < output.indexOf("FATAL"), output);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** A structurally valid completed pair (not a recovery bundle). */
async function syntheticPair(dir) {
  const file = join(dir, "backup-11111111-2222-4333-8444-555555555555.age");
  const bytes = Buffer.from("age-encryption.org/v1\nsynthetic test bytes, not a recovery bundle");
  await writeFile(file, bytes);
  await writeFile(
    `${file}.complete`,
    JSON.stringify({
      version: 1,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }),
  );
  return file;
}

test("a hung upload that ignores its signal and holds a live handle still ends the one-shot process", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kb-backup-abandoned-"));
  try {
    const file = await syntheticPair(dir);
    const entry = new URL("./kb-backup.mjs", import.meta.url).pathname;
    const script = `import { deliverBackup, exitAfterAbandonedUpload } from ${JSON.stringify(entry)};
try {
  await deliverBackup({
    file: ${JSON.stringify(file)},
    configured: true,
    uploadTimeoutMs: 200,
    uploadAbortGraceMs: 200,
    // A live handle and no reaction to abort: only an explicit exit ends this.
    upload: () => { setInterval(() => {}, 1000); return new Promise(() => {}); },
  });
} catch (error) {
  console.error("code=" + error.code);
  process.exitCode = 1;
  exitAfterAbandonedUpload(error);
}`;
    const started = Date.now();
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      env: { PATH: process.env.PATH },
      timeout: 15_000,
      killSignal: "SIGKILL",
    });
    assert.equal(result.status, 1, `${result.signal ?? ""} ${result.stderr}`);
    assert.match(result.stderr, /code=UPLOAD_TIMEOUT/);
    assert.ok(Date.now() - started < 10_000);
    const recorded = JSON.parse(await readFile(`${file}.result.json`, "utf8"));
    assert.deepEqual(recorded.upload, {
      configured: true,
      outcome: "failed",
      code: "UPLOAD_TIMEOUT",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  // Both one-shot CLIs end themselves after reporting such a failure.
  for (const path of ["./kb-backup.mjs", "../upload-backup-to-s3.mjs"]) {
    const source = await readFile(new URL(path, import.meta.url), "utf8");
    assert.match(source, /process\.exitCode = 1;\n\s*exitAfterAbandonedUpload\(error\);/, path);
  }
});

test("a cancel gives the upload time to clean up; only an upload that ignores it is abandoned", async () => {
  const { deliverBackup, exitAfterAbandonedUpload } = await import("./kb-backup.mjs");
  const dir = await mkdtemp(join(tmpdir(), "kb-backup-cancel-"));
  try {
    const file = await syntheticPair(dir);
    // Honours its signal, but its cleanup (a multipart abort) takes a while.
    let cleaned = false;
    const honouring = new AbortController();
    await assert.rejects(
      deliverBackup({
        file,
        configured: true,
        signal: honouring.signal,
        uploadAbortGraceMs: 5_000,
        upload: ({ signal }) =>
          new Promise((_, reject) => {
            signal.addEventListener("abort", () =>
              setTimeout(() => {
                cleaned = true;
                reject(signal.reason);
              }, 200),
            );
            // Cancel only once the upload is running.
            honouring.abort();
          }),
      }),
      (error) => {
        assert.equal(error.code, "CANCELLED");
        assert.equal(error.name, "AbortError");
        assert.equal(error.abandoned, undefined);
        return true;
      },
    );
    assert.equal(cleaned, true, "deliverBackup waited for the upload's cleanup");
    // Ignores its signal: settles after the grace, abandoned.
    const ignoring = new AbortController();
    const started = Date.now();
    await assert.rejects(
      deliverBackup({
        file,
        configured: true,
        signal: ignoring.signal,
        uploadAbortGraceMs: 100,
        upload: () => {
          ignoring.abort();
          return new Promise(() => {});
        },
      }),
      (error) => {
        assert.equal(error.code, "CANCELLED");
        assert.equal(error.abandoned, true);
        return true;
      },
    );
    assert.ok(Date.now() - started < 5_000);
    // An upload that failed by itself is not abandoned: no forced exit.
    let exited = false;
    await assert.rejects(
      deliverBackup({
        file,
        configured: true,
        upload: async () => {
          throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
        },
      }),
      (error) => {
        exitAfterAbandonedUpload(error, () => {
          exited = true;
        });
        return error.code === "ECONNREFUSED";
      },
    );
    assert.equal(exited, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
