import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { admitAssetStorage } from "@knowledge-base/api/lib/kb/asset-storage-mode";
import { offlineAssetConfig } from "@knowledge-base/api/lib/kb/asset-storage-offline";
import { casBlobPath, createDiskBlobStore } from "@knowledge-base/api/lib/kb/blob-store-disk";
import { startMaintenanceParticipant } from "@knowledge-base/api/lib/kb/maintenance";
import { Client } from "pg";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { initKbVolumes } from "../../../../scripts/init-kb-volumes.mjs";
import { type KbPostgresDatabase, openKbPostgresClusterFromEnv } from "./postgres";
import { createAssetS3Fixture } from "./s3-fixture";

const root = resolve(import.meta.dirname, "../../../..");
const native = join(root, "apps/server/native/kb-supervisor");
const moduleUrl = pathToFileURL(join(root, "scripts/lib/asset-storage-migration.mjs")).href;
const cluster = await openKbPostgresClusterFromEnv();
const databases: KbPostgresDatabase[] = [];
const roots: string[] = [];
const fixtures: Awaited<ReturnType<typeof createAssetS3Fixture>>[] = [];
const children = new Set<ChildProcess>();
afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
  }
  children.clear();
  for (const fixture of fixtures.splice(0)) await fixture.close();
  for (const db of databases.splice(0)) await db.close();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
afterAll(() => cluster.close());
function hash(bytes: Buffer) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
function wav(size = 48, variant = 0) {
  const b = Buffer.alloc(size, variant);
  b.write("RIFF");
  b.writeUInt32LE(size - 8, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(16000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(size - 44, 40);
  return b;
}
async function fixture() {
  const db = await cluster.createDatabase();
  databases.push(db);
  db.applyPrismaSchema();

  const data = mkdtempSync(join(tmpdir(), "s3-p6-migration-"));
  roots.push(data);
  initKbVolumes({ KB_DATA_ROOT: data });
  const s3 = await createAssetS3Fixture();
  fixtures.push(s3);
  s3.setListPageSize(2);
  const env = {
    KB_ASSET_S3_ENABLED: "true",
    KB_ASSET_S3_BUCKET: "assets",
    KB_ASSET_S3_ENDPOINT: s3.endpoint,
    KB_ASSET_S3_REGION: "us-east-1",
    KB_ASSET_S3_FORCE_PATH_STYLE: "true",
    KB_ASSET_S3_ACCESS_KEY_ID: "runtime-comparison",
    KB_ASSET_S3_OPERATOR_ACCESS_KEY_ID: "operator",
    KB_ASSET_S3_OPERATOR_SECRET_ACCESS_KEY: "fixture-secret",
    KB_ASSET_CACHE_MAX_BYTES: "26214400",
  };
  const assets = join(data, "assets");
  const query = (sql: string, values: unknown[] = []) => db.query("applier", sql, values);
  const seed = async (bytes: Buffer, catalog = true) => {
    const row = { hash: hash(bytes), size: bytes.length };
    await createDiskBlobStore(assets).publishVerified({
      declaredHash: row.hash,
      declaredSize: row.size,
      declaredMime: "audio/wav",
      bytes,
    });
    if (catalog)
      await query(
        "INSERT INTO asset_blob(hash,size,mime,\"verifiedAt\") VALUES($1,$2,'audio/wav',now())",
        [row.hash, row.size],
      );
    return row;
  };
  const marker = async () => {
    const r = (await query("SELECT value FROM app_setting WHERE key='kb.asset-storage'")).rows[0];
    return r
      ? (JSON.parse(String(r.value)) as {
          mode: string;
          locator?: string;
          activeGeneration: string;
        })
      : undefined;
  };
  return { db, data, assets, s3, env, query, seed, marker };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function run(
  f: Fixture,
  to: "s3" | "disk",
  attemptId = randomUUID(),
  options: {
    cut?: string;
    kill?: boolean;
    dryRun?: boolean;
    env?: Record<string, string>;
    reconcile?: boolean;
    lowDisk?: boolean;
    descendant?: boolean;
    crashDiskPublication?: boolean;
    traceDiskFsync?: boolean;
    cancelCacheScan?: boolean;
  } = {},
) {
  const request = JSON.stringify({ assetStorageAttempt: attemptId });
  await f.query(
    'INSERT INTO app_setting(key,value,"createdAt","updatedAt") VALUES(\'kb.maintenance.request\',$1,now(),now()) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    [request],
  );
  const code = `import { migrateStorageOffline } from ${JSON.stringify(moduleUrl)};
import { spawn } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const fsync = fs.fsyncSync;
fs.fsyncSync = fd => {
  const path = fs.readlinkSync('/proc/self/fd/'+fd);
  if (${!!options.crashDiskPublication} && /\\/objects\\/[a-f0-9]{2}$/.test(path)) process.kill(process.pid,'SIGKILL');
  fsync(fd);
  if (${!!options.traceDiskFsync}) console.log('SYNC '+path);
};
const opendir = fs.opendirSync;
let scanCancelled = false;
fs.opendirSync = (...args) => {
  const dir = opendir(...args);
  const read = dir.readSync.bind(dir);
  dir.readSync = () => {
    const entry = read();
    if (${!!options.cancelCacheScan} && !scanCancelled && entry && /^[a-f0-9]{62}$/.test(entry.name)) {
      scanCancelled = true;
      process.emit('SIGTERM');
      console.log('CACHE_SCAN_CANCELLED');
    }
    return entry;
  };
  return dir;
};
syncBuiltinESMExports();
const abort=new AbortController();
for(const s of ['SIGTERM','SIGINT']) process.once(s,()=>abort.abort());
try {
  const result=await migrateStorageOffline({
    connectionString:process.env.DATABASE_URL,dataDir:process.env.KB_DATA_ROOT,
    to:${JSON.stringify(to)},attemptId:${JSON.stringify(attemptId)},dryRun:${!!options.dryRun},reconcile:${!!options.reconcile},
    request:${JSON.stringify(request)},signal:abort.signal,
    diskMeter:${options.lowDisk ? "{freeBytes:async()=>0n}" : "undefined"},
    barrier:async phase=>{
      if(phase!==${JSON.stringify(options.cut ?? "")}) return;
      if(${!!options.kill}) {
        if(${!!options.descendant}) {
          const d=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{detached:true,stdio:'ignore'});
          console.log('DESC '+d.pid);
        }
        console.log('CUT '+process.pid); await new Promise(()=>{});
      } else throw Error('TEST_CUT');
    }
  });
  console.log('RESULT '+JSON.stringify(result));
} catch(e) { console.error(e.message?.startsWith('ASSET_') || e.message==='TEST_CUT' ? e.message : e.stack); process.exitCode=1; }`;

  const child = spawn(
    native,
    ["--asset-storage", "--", process.execPath, "--input-type=module", "-e", code],
    {
      env: {
        ...process.env,
        ...f.env,
        ...options.env,
        DATABASE_URL: f.db.urls.applier,
        KB_DATA_ROOT: f.data,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  children.add(child);
  let output = "",
    error = "";
  child.stdout!.on("data", (b) => {
    output += b.toString();
  });
  child.stderr!.on("data", (b) => {
    error += b.toString();
  });
  if (options.kill) {
    await new Promise<void>((resolveReady, reject) => {
      const timer = setTimeout(() => reject(Error(`boundary not reached: ${error}`)), 20000);
      const check = () => {
        const pid = /CUT (\d+)/.exec(output)?.[1];
        if (pid) {
          clearTimeout(timer);
          process.kill(Number(pid), "SIGKILL");
          resolveReady();
        }
      };
      child.stdout!.on("data", check);
      child.once("exit", () => {
        clearTimeout(timer);
        if (!output.includes("CUT")) reject(Error(error));
      });
    });
  }
  const [status] = await once(child, "exit");
  children.delete(child);
  return {
    status,
    output,
    error: error
      .split("\n")
      .filter((line) => !line.includes('"level":"info"'))
      .join("\n")
      .trim(),
    attemptId,
  };
}
async function assertBlocked(f: Fixture) {
  let recovered = false;
  await expect(
    startMaintenanceParticipant(
      f.db.urls.applier,
      () => {},
      async () => {
        recovered = true;
      },
    ),
  ).rejects.toThrow(/migration/);
  expect(recovered).toBe(false);
}
function remoteKey(hash: string) {
  return `/assets/objects/${hash.slice(7, 9)}/${hash.slice(9)}`;
}

async function configuredRuntime(
  f: Fixture,
  role: "SERVER" | "WORKER",
  action: "attach" | "publish" | "read",
  limit = "26214400",
) {
  const code = `
import { tsImport } from 'tsx/esm/api';
import { Client } from 'pg';
const {createRuntimeAssetStore,attachRuntimeAssetCache,assetRoleFenceProof} = await tsImport(${JSON.stringify(join(root, "packages/api/src/lib/kb/asset-storage-runtime.ts"))},import.meta.url);
const {createAssetStorageLifecycle} = await tsImport(${JSON.stringify(join(root, "packages/api/src/lib/kb/asset-storage-lifecycle.ts"))},import.meta.url);
const lifecycle=createAssetStorageLifecycle(${JSON.stringify(role)});
const db=new Client({connectionString:process.env.DATABASE_URL});
try {
 await db.connect();
 const marker=JSON.parse((await db.query("SELECT value FROM app_setting WHERE key='kb.asset-storage'")).rows[0].value);
 const input={env:{...process.env,KB_ASSET_S3_ENABLED:true},assetsDir:process.env.KB_DATA_ROOT+'/assets',connectionString:process.env.DATABASE_URL,marker,lifecycle,assertRoleFence:assetRoleFenceProof(process.env.KB_DATA_ROOT+'/repos',${JSON.stringify(role.toLowerCase())})};
 if(${JSON.stringify(role)}==='WORKER') { await attachRuntimeAssetCache(input); console.log('WORKER_READY'); }
 else {
  const store=await createRuntimeAssetStore(input);
  console.log('ATTACHED '+store.backend);
  const bytes=Buffer.from(${JSON.stringify(wav().toString("base64"))},'base64');
  const hash=${JSON.stringify(hash(wav()))};
  if(${JSON.stringify(action)}==='publish') { await store.publishVerified({declaredHash:hash,declaredSize:bytes.length,declaredMime:'audio/wav',bytes}); console.log('PUBLISHED'); }
  if(${JSON.stringify(action)}!=='attach') {
   const r=await store.open({hash,size:bytes.length,purpose:'download',signal:new AbortController().signal});
   try { await r.preflight(); const got=await r.readFrame(0,bytes.length); await r.complete(); if(!Buffer.from(got).equals(bytes)) throw Error('bad bytes'); r.sampleDownload?.(); }
   finally { await r.close(); }
   console.log('BYTES_OK');
  }
 }
} catch(e) { console.log('REFUSED '+(e.code??'CONFIGURATION')); process.exitCode=1; }
finally { await lifecycle.stop(); await db.end(); }
`;
  const child = spawn(
    native,
    [
      ...(role === "WORKER" ? ["--worker"] : []),
      "--",
      process.execPath,
      "--input-type=module",
      "-e",
      code,
    ],
    {
      env: {
        ...process.env,
        ...f.env,
        KB_ASSET_S3_SECRET_ACCESS_KEY: role === "SERVER" ? "runtime-fixture-secret" : "",
        KB_ASSET_S3_OPERATOR_ACCESS_KEY_ID: "",
        KB_ASSET_S3_OPERATOR_SECRET_ACCESS_KEY: "",
        KB_ASSET_CACHE_MAX_BYTES: limit,
        KB_DATA_ROOT: f.data,
        DATABASE_URL: f.db.urls.runtime,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  children.add(child);
  let output = "";
  child.stdout!.on("data", (b) => {
    output += b;
  });
  child.stderr!.on("data", (b) => {
    output += b;
  });
  const [status] = await once(child, "exit");
  children.delete(child);
  return { status, output };
}

describe("native-fenced offline storage migration", () => {
  it("cancels the production migration during cache scanning and preserves blocked authority until retry", async () => {
    const f = await fixture();
    expect((await run(f, "s3")).status).toBe(0);
    const published = await configuredRuntime(f, "SERVER", "publish");
    expect(published.status, published.output).toBe(0);
    const before = await f.marker();
    const attempt = randomUUID();
    const cancelled = await run(f, "s3", attempt, { reconcile: true, cancelCacheScan: true });
    expect(cancelled.output).toContain("CACHE_SCAN_CANCELLED");
    expect(cancelled.status).not.toBe(0);
    expect(await f.marker()).toEqual(before);
    await assertBlocked(f);
    expect((await f.query("SELECT id FROM asset_cache_pin LIMIT 1")).rows).toEqual([]);
    expect(
      (await f.query("SELECT id FROM quota_reservation WHERE outcome='RESERVED' LIMIT 1")).rows,
    ).toEqual([]);
    expect(
      (await f.query('SELECT state::text,"cleanupOwner","cleanupAttempt" FROM asset_cache_entry'))
        .rows,
    ).toEqual([{ state: "READY", cleanupOwner: null, cleanupAttempt: null }]);
    const resumed = await run(f, "s3", attempt, { reconcile: true });
    expect(resumed.status, resumed.error).toBe(0);
    expect((await f.marker())?.activeGeneration).not.toBe(before?.activeGeneration);
  });
  it("activates configured server/worker roles after offline initialization and restarts cached reads during outage", async () => {
    const f = await fixture();
    expect((await run(f, "s3")).status).toBe(0);
    // The runtime may observe operator control but cannot lock/update its rows.
    await expect(
      f.db.query(
        "runtime",
        "SELECT state FROM knowledge_base_control.asset_storage_migration LIMIT 1 FOR SHARE",
      ),
    ).rejects.toMatchObject({ code: "42501" });
    f.s3.requests.length = 0;
    const worker = await configuredRuntime(f, "WORKER", "attach");
    expect(worker, worker.output).toMatchObject({ status: 0 });
    expect(f.s3.requests).toHaveLength(0);
    const attached = await configuredRuntime(f, "SERVER", "attach");
    expect(attached, attached.output).toMatchObject({ status: 0 });
    expect(f.s3.requests).toHaveLength(0);
    const published = await configuredRuntime(f, "SERVER", "publish");
    expect(
      published,
      published.output +
        JSON.stringify(f.s3.requests.map((r) => ({ method: r.method, key: r.key }))),
    ).toMatchObject({ status: 0 });
    expect(published.output).toContain("BYTES_OK");
    expect(f.s3.requests.some((r) => r.method === "PUT")).toBe(true);
    f.s3.setGetStatus(503);
    f.s3.requests.length = 0;
    const restarted = await configuredRuntime(f, "SERVER", "read");
    expect(restarted, restarted.output).toMatchObject({ status: 0 });
    expect(restarted.output).toContain("BYTES_OK");
    expect(f.s3.requests).toHaveLength(0);
    for (const role of ["SERVER", "WORKER"] as const) {
      const mismatch = await configuredRuntime(f, role, "attach", "52428800");
      expect(mismatch.status).toBe(1);
    }
    expect(f.s3.requests).toHaveLength(0);
    expect((await f.query("SELECT id FROM asset_cache_pin LIMIT 1")).rows).toHaveLength(0);
  });

  it("copies >cache-limit disk inventory including orphans, survives trim death, and cycles A -> disk -> B -> disk without A", async () => {
    const f = await fixture();
    const a = await f.seed(wav(14 * 1024 * 1024, 1));
    const orphan = await f.seed(wav(14 * 1024 * 1024, 2), false);
    const stage = join(f.assets, ".private/staging/ready-proof");
    await writeFile(stage, "READY staging stays");
    const cut = await run(f, "s3", undefined, { cut: "trimmed", kill: true });
    expect(cut.status).not.toBe(0);
    await assertBlocked(f);
    expect((await f.marker())?.mode).toBe("disk");
    const resumed = await run(f, "s3", cut.attemptId);
    expect(resumed.error).toBe("");
    expect(resumed.status).toBe(0);
    expect(existsSync(casBlobPath(f.assets, a.hash))).toBe(false);
    expect(existsSync(stage)).toBe(true);
    const activeA = await f.marker();
    expect(activeA?.mode).toBe("s3");
    expect(await readdir(join(f.assets, ".private/tmp"))).toEqual([]);
    const r = await run(f, "s3", cut.attemptId);
    expect(r.status).toBe(0); // Lost final ACK replay.
    // A materialized PENDING orphan and an absent unmaterialized attempt.
    const remoteOrphan = wav(50, 3),
      pendingHash = hash(remoteOrphan);
    f.s3.objects.set(remoteKey(pendingHash), { bytes: remoteOrphan, metadata: {} });
    for (const [h, size, state] of [
      [pendingHash, 50, "PENDING"],
      [`sha256:${"f".repeat(64)}`, 48, "PENDING"],
    ])
      await f.query(
        'INSERT INTO asset_retained_object("storageGeneration",locator,hash,size,state) VALUES($1::uuid,$2,$3,$4,$5::"AssetRetainedStatus")',
        [activeA!.activeGeneration, activeA!.locator, h, size, state],
      );
    const local = await run(f, "disk", undefined, {
      env: { ...f.env, KB_ASSET_S3_ENABLED: "false" },
      cut: "copied",
    });
    expect(local.status).not.toBe(0);
    await assertBlocked(f);
    const down = await run(f, "disk", local.attemptId, {
      env: { ...f.env, KB_ASSET_S3_ENABLED: "false" },
    });
    expect(down.error).toBe("");
    expect(down.status).toBe(0);
    expect(existsSync(casBlobPath(f.assets, orphan.hash))).toBe(true);
    expect(existsSync(casBlobPath(f.assets, pendingHash))).toBe(true);
    f.s3.setGetStatus(503);
    const b = await createAssetS3Fixture();
    fixtures.push(b);
    b.setListPageSize(1);
    const bEnv = {
      ...f.env,
      KB_ASSET_S3_ENDPOINT: b.endpoint,
      KB_ASSET_S3_OPERATOR_ACCESS_KEY_ID: "rotated-operator",
    };
    const upB = await run(f, "s3", undefined, { env: bEnv });
    expect(upB.error).toBe("");
    expect(upB.status).toBe(0);
    expect(b.objects.size).toBe(3);
    const downB = await run(f, "disk", undefined, {
      env: { ...bEnv, KB_ASSET_S3_ENABLED: "false" },
    });
    expect(downB.error).toBe("");
    expect(downB.status).toBe(0);
    expect(existsSync(casBlobPath(f.assets, orphan.hash))).toBe(true);
    expect(
      (
        await f.query(
          'SELECT state FROM asset_retained_object WHERE "storageGeneration"=$1::uuid AND hash=$2',
          [activeA!.activeGeneration, `sha256:${"f".repeat(64)}`],
        )
      ).rows[0]?.state,
    ).toBe("PENDING");
    expect(
      b.requests.filter((r) => r.method === "GET" && r.key.replace(/\/$/, "") === "/assets").length,
    ).toBeGreaterThan(2);
    expect(
      [...f.s3.requests, ...b.requests].every((r) => ["HEAD", "GET", "PUT"].includes(r.method)),
    ).toBe(true);
  }, 120000);

  it.each(["intent", "inventory", "copied", "conversion", "fsynced", "activated"])(
    "retries the same attempt after %s without losing source or fabricating lineage",
    async (cut) => {
      const f = await fixture();
      const row = await f.seed(wav());
      const interrupted = await run(f, "s3", undefined, { cut });
      expect(interrupted.status).not.toBe(0);
      if (!["fsynced", "activated"].includes(cut))
        expect(existsSync(casBlobPath(f.assets, row.hash))).toBe(true);
      if (cut !== "activated") await assertBlocked(f);
      expect((await run(f, "s3", interrupted.attemptId)).status).toBe(0);
      expect((await f.query("SELECT count(*)::int AS n FROM asset_blob")).rows[0]?.n).toBe(1);
      expect((await f.marker())?.mode).toBe("s3");
    },
    30000,
  );

  it("dry-run verifies without byte removal or authority changes; immutable attempt/locator mismatches refuse", async () => {
    const f = await fixture();
    const row = await f.seed(wav());
    expect((await run(f, "s3", undefined, { dryRun: true })).status).toBe(0);
    expect(await f.marker()).toBeUndefined();
    expect(f.s3.objects.size).toBe(0);
    expect(existsSync(casBlobPath(f.assets, row.hash))).toBe(true);
    const cut = await run(f, "s3", undefined, { cut: "inventory" });
    const changed = await run(f, "s3", cut.attemptId, {
      env: { ...f.env, KB_ASSET_S3_PREFIX: "changed" },
    });
    expect(changed.error).toContain("ATTEMPT_CONFLICT");
    expect((await run(f, "s3")).status).not.toBe(0);
    expect((await run(f, "s3", cut.attemptId)).status).toBe(0);
  });

  it("missing active DURABLE bytes block, historical intents are ignored, malformed current keys block", async () => {
    const f = await fixture();
    await f.seed(wav());
    expect((await run(f, "s3")).status).toBe(0);
    const active = await f.marker();
    const absent = `sha256:${"e".repeat(64)}`;
    await f.query(
      "INSERT INTO asset_retained_object(\"storageGeneration\",locator,hash,size,state) VALUES($1::uuid,$2,$3,48,'DURABLE')",
      [active!.activeGeneration, active!.locator, absent],
    );
    const attempt = await run(f, "disk");
    expect(attempt.error).toContain("MISSING_SOURCE");
    await assertBlocked(f);
    // This reviewed fixture-only mutation retires the missing obligation; runtime cannot do this.
    await f.query('UPDATE asset_retained_object SET "storageGeneration"=$1::uuid WHERE hash=$2', [
      randomUUID(),
      absent,
    ]);
    f.s3.objects.set("/assets/objects/malformed", { bytes: Buffer.from("bad"), metadata: {} });
    expect((await run(f, "disk", attempt.attemptId)).status).not.toBe(0);
    f.s3.objects.delete("/assets/objects/malformed");
    expect((await run(f, "disk", attempt.attemptId)).status).toBe(0);
  });

  it("retains every disk byte on S3 403 and rejects corrupt sources without overwriting them", async () => {
    const f = await fixture();
    const row = await f.seed(wav());
    f.s3.setPutStatus(403);
    const failed = await run(f, "s3");
    expect(failed.status).not.toBe(0);
    expect(existsSync(casBlobPath(f.assets, row.hash))).toBe(true);
    await assertBlocked(f);
    f.s3.setPutStatus(200);
    await writeFile(casBlobPath(f.assets, row.hash), wav(48, 3));
    expect((await run(f, "s3", failed.attemptId)).status).not.toBe(0);
  });

  it("startup initializes only fenced empty servers, rejects stale env before recovery, and tolerates S3 outage", async () => {
    const f = await fixture();
    const client = new Client({ connectionString: f.db.urls.applier });
    await client.connect();
    try {
      let fenced = false;
      const admit = (
        role: "SERVER" | "WORKER",
        selection: { mode: "disk" } | { mode: "s3"; locator: string },
      ) =>
        admitAssetStorage({
          query: (sql, values) => client.query(sql, values),
          selection,
          assetsDir: f.assets,
          role,
          deadlineAt: Date.now(),
          assertServerFence: () => {
            fenced = true;
          },
        });
      await expect(admit("WORKER", { mode: "disk" })).rejects.toThrow(/fenced server/);
      await f.seed(wav());
      const config = offlineAssetConfig(f.env);
      if (config.mode !== "s3") throw Error("fixture");
      await expect(admit("SERVER", config)).rejects.toThrow(/offline migration/);
      expect(fenced).toBe(true);
      await admit("SERVER", { mode: "disk" });
      expect((await run(f, "s3")).status).toBe(0);
      f.s3.setGetStatus(503);
      await admit("SERVER", config);
      await admit("WORKER", config);
      await expect(admit("WORKER", { mode: "disk" })).rejects.toThrow(/offline migration/);
    } finally {
      await client.end();
    }
  });

  it("recovers a killed allocation and drains detached descendants before releasing both fences", async () => {
    const f = await fixture();
    await f.seed(wav());
    const killed = await run(f, "s3", undefined, {
      cut: "allocation",
      kill: true,
      descendant: true,
    });
    expect(killed.status).not.toBe(0);
    const descendant = /DESC (\d+)/.exec(killed.output)?.[1];
    expect(descendant).toBeDefined();
    expect(() => process.kill(Number(descendant), 0)).toThrow();
    expect(
      (await f.query(`SELECT id FROM quota_reservation WHERE outcome='RESERVED' LIMIT 1`)).rows,
    ).toHaveLength(1);
    const retry = await run(f, "s3", killed.attemptId);
    expect(retry.error).toBe("");
    expect(retry.status).toBe(0);
    expect(
      (await f.query(`SELECT id FROM quota_reservation WHERE outcome='RESERVED' LIMIT 1`)).rows,
    ).toHaveLength(0);
  });

  it("recovers a disk hardlink and scratch alias after death before directory barriers, then synchronizes every target", async () => {
    const f = await fixture();
    const row = await f.seed(wav());
    expect((await run(f, "s3")).status).toBe(0);
    const crashed = await run(f, "disk", undefined, { crashDiskPublication: true });
    expect(crashed.status).not.toBe(0);
    const path = casBlobPath(f.assets, row.hash);
    expect(existsSync(path)).toBe(true);
    expect(await readdir(join(f.assets, ".private/tmp"))).toEqual([
      `migration-${crashed.attemptId}`,
    ]);
    await assertBlocked(f);
    const recovered = await run(f, "disk", crashed.attemptId, { traceDiskFsync: true });
    expect(recovered.status, recovered.error).toBe(0);
    expect(await readdir(join(f.assets, ".private/tmp"))).toEqual([]);
    // Existing-file shortcut AND final activation verification both cross all
    // four barriers; replay must do so again without consulting retired S3.
    const barriers = [
      path,
      join(f.assets, "objects", row.hash.slice(7, 9)),
      join(f.assets, "objects"),
      f.assets,
    ];
    for (const barrier of barriers)
      expect(
        recovered.output.split("\n").filter((line) => line === `SYNC ${barrier}`).length,
      ).toBeGreaterThanOrEqual(2);
    const replay = await run(f, "disk", crashed.attemptId, { traceDiskFsync: true });
    expect(replay.status, replay.error).toBe(0);
    for (const barrier of barriers) expect(replay.output).toContain(`SYNC ${barrier}\n`);
  });

  it.each(["missing", "replaced"])(
    "closes completed disk replay before observing a %s assets mount",
    async (mount) => {
      const f = await fixture();
      await f.seed(wav());
      expect((await run(f, "s3")).status).toBe(0);
      const disk = await run(f, "disk");
      expect(disk.status, disk.error).toBe(0);
      const saved = join(f.data, "detached-assets");
      await rename(f.assets, saved);
      if (mount === "replaced") await mkdir(f.assets);
      const replay = await run(f, "disk", disk.attemptId);
      expect(replay.status).not.toBe(0);
      expect(
        (
          await f.query(
            'SELECT state FROM knowledge_base_control.asset_storage_migration WHERE "attemptId"=$1::uuid',
            [disk.attemptId],
          )
        ).rows[0]?.state,
      ).toBe("VERIFYING");
      await assertBlocked(f);
      if (mount === "replaced") await rm(f.assets, { recursive: true });
      await rename(saved, f.assets);
      const recovered = await run(f, "disk", disk.attemptId);
      expect(recovered.status, recovered.error).toBe(0);
    },
  );

  it("a completed disk attempt rechecks with readiness closed and never needs the retired S3 source", async () => {
    const f = await fixture();
    await f.seed(wav());
    expect((await run(f, "s3")).status).toBe(0);
    const disk = await run(f, "disk");
    expect(disk.status).toBe(0);
    f.s3.setGetStatus(503);
    const cut = await run(f, "disk", disk.attemptId, { cut: "reverify" });
    expect(cut.status).not.toBe(0);
    await assertBlocked(f);
    expect((await run(f, "disk", disk.attemptId)).status).toBe(0);
  });

  it("low disk blocks the disk destination and preserves the S3 source for retry", async () => {
    const f = await fixture();
    const row = await f.seed(wav());
    expect((await run(f, "s3")).status).toBe(0);
    const low = await run(f, "disk", undefined, { lowDisk: true });
    expect(low.status).not.toBe(0);
    expect(f.s3.objects.has(remoteKey(row.hash))).toBe(true);
    expect(existsSync(casBlobPath(f.assets, row.hash))).toBe(false);
    await assertBlocked(f);
    expect((await run(f, "disk", low.attemptId)).status).toBe(0);
  });

  it("the operator coordinator drains maintenance and forwards its exact request through the native role", async () => {
    const f = await fixture();
    await f.seed(wav());
    let participant!: Awaited<ReturnType<typeof startMaintenanceParticipant>>;
    participant = await startMaintenanceParticipant(f.db.urls.applier, () => {
      void participant.release();
    });
    const migration = await import(moduleUrl);
    await migration.coordinateStorageMigration({
      connectionString: f.db.urls.applier,
      dataDir: f.data,
      to: "s3",
      attemptId: randomUUID(),
      assetEnvironment: f.env,
      supervisor: native,
    });
    await participant.release();
    const status = await migration.storageStatus({ connectionString: f.db.urls.applier });
    expect(status.active.mode).toBe("s3");
    expect(status.attempts).toHaveLength(1);
    expect(JSON.stringify(status)).not.toContain(f.env.KB_ASSET_S3_OPERATOR_SECRET_ACCESS_KEY);
    expect((await f.marker())?.mode).toBe("s3");
    expect(
      (await f.query("SELECT key FROM app_setting WHERE key LIKE 'kb.maintenance.%' LIMIT 1")).rows,
    ).toHaveLength(0);
  });

  it("cache reconciliation trims under dual fences and installs a new bounded generation", async () => {
    const f = await fixture();
    await f.seed(wav());
    expect(
      (await run(f, "s3", undefined, { env: { ...f.env, KB_ASSET_CACHE_MAX_BYTES: "52428800" } }))
        .status,
    ).toBe(0);
    const first = await f.marker();
    const shrink = await run(f, "s3", undefined, { reconcile: true });
    expect(shrink.error).toBe("");
    expect(shrink.status).toBe(0);
    expect((await f.marker())?.activeGeneration).not.toBe(first?.activeGeneration);
    expect(
      (await f.query('SELECT "effectiveLimit"::text AS n FROM asset_cache_state LIMIT 1')).rows[0]
        ?.n,
    ).toBe("26214400");
  });
});
