import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  coordinateBackup,
  encryptBundle,
  readBundle,
  verifyEncryptedBundle,
} from "./kb-backup.mjs";

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
  version: 3,
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
      "kb/backup/3\n" +
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
  const v2 = { ...metadata, version: 3, storage };
  await encryptBundle({ ...f, metadata: v2, sources, recipient: f.key });
  const result = await readBundle(f.file, f.identity);
  assert.equal(result.metadata.version, 3);
  assert.deepEqual(
    result.files.map((e) => e.path),
    ["asset-inventory.jsonl"],
  );
  for (const [m, paths] of [
    [metadata, sources],
    [v2, []],
    [{ ...v2, storage: { ...storage, secret: "no" } }, sources],
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
      metadata: v2,
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
      metadata: v2,
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
