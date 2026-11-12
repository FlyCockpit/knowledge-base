/** Offline, resumable authority conversion. Native dual fences precede DB locks. */
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import {
  assertNoStorageMigration,
  installStorageMigrationControl,
  MIGRATION_ITEMS,
  MIGRATION_TABLE,
} from "./asset-storage-control.mjs";
import { assetOperatorEnv, assetStorageDomain } from "./asset-storage-domain.mjs";
import { boundedChild } from "./bounded-child.mjs";
import { assertOfflineFence } from "./kb-backup.mjs";

const REQUEST = "kb.maintenance.request";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const LOCKS = [0x4b424d52, 0x4b424d41, 1145389648];
const fail = (code) => {
  throw new Error(code);
};
async function connect(connectionString) {
  const client = new Client({
    connectionString,
    application_name: "kb-asset-storage-migration",
    connectionTimeoutMillis: 5000,
    statement_timeout: 60000,
    options: "-c lock_timeout=5000 -c idle_in_transaction_session_timeout=60000",
  });
  client.on("error", () => {});
  await client.connect();
  return client;
}
async function transaction(client, work) {
  await client.query("BEGIN");
  try {
    const result = await work();
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  }
}
async function setting(client, key, value) {
  await client.query(
    'INSERT INTO app_setting (key,value,"createdAt","updatedAt") VALUES($1,$2,now(),now()) ON CONFLICT(key) DO UPDATE SET value=excluded.value,"updatedAt"=now()',
    [key, value],
  );
}
async function marker(client, domain) {
  const row = (await client.query("SELECT value FROM app_setting WHERE key='kb.asset-storage'"))
    .rows[0];
  return row ? domain.parseAssetStorageMarker(row.value) : undefined;
}
async function* pages(client, sql, values = []) {
  let after = "";
  for (;;) {
    const rows = (await client.query(sql, [after, ...values])).rows;
    if (!rows.length) break;
    for (const row of rows) yield row;
    after = rows.at(-1).hash;
  }
}
export async function storageStatus({ connectionString }) {
  const client = await connect(connectionString);
  try {
    const domain = await assetStorageDomain();
    const active = await marker(client, domain);
    const present = (await client.query(`SELECT to_regclass('${MIGRATION_TABLE}') AS present`))
      .rows[0]?.present;
    const attempts = present
      ? (
          await client.query(
            `SELECT "attemptId",source,target,state,"inventoryDigest","itemCount","lastHash" FROM ${MIGRATION_TABLE} ORDER BY (state='READY'),"attemptId" LIMIT 20`,
          )
        ).rows
      : [];
    return { active: active ?? null, attempts };
  } finally {
    await client.end();
  }
}

/** A PG-backed sorted spool stays outside imported metadata. It is immutable
 * after COPYING; counters are diagnostic and never authorize skipping bytes. */
async function scanInventory(client, domain, source, copier, assetsDir, signal) {
  await client.query(
    "CREATE TEMP TABLE IF NOT EXISTS asset_migration_scan(hash text PRIMARY KEY,size integer NOT NULL,required boolean NOT NULL,materialized boolean NOT NULL)",
  );
  await client.query("DELETE FROM asset_migration_scan WHERE hash<>''");
  const add = async (row, required, materialized) => {
    domain.checkAssetInventoryRow({ hash: row.hash, size: row.size });
    await client.query(
      `INSERT INTO asset_migration_scan VALUES($1,$2,$3,$4)
      ON CONFLICT(hash) DO UPDATE SET size=CASE WHEN asset_migration_scan.size=excluded.size THEN excluded.size ELSE -1 END,
      required=asset_migration_scan.required OR excluded.required,materialized=asset_migration_scan.materialized OR excluded.materialized`,
      [row.hash, row.size, required, materialized],
    );
  };
  for await (const row of pages(
    client,
    "SELECT hash,size FROM asset_blob WHERE hash>$1 ORDER BY hash LIMIT 1000",
  )) {
    signal?.throwIfAborted();
    await add(row, true, false);
  }
  if (source.mode === "disk") {
    for await (const row of domain.offlineDiskInventory(assetsDir, signal))
      await add(row, false, true);
  } else {
    const current = domain.currentAssetObligation(source);
    for await (const row of pages(
      client,
      'SELECT hash,size,state FROM asset_retained_object WHERE hash>$1 AND "storageGeneration"=$2::uuid AND locator=$3 ORDER BY hash LIMIT 1000',
      [current.generation, current.locator],
    )) {
      signal?.throwIfAborted();
      await add(row, row.state === "DURABLE", false);
    }
    for await (const row of copier.list()) await add(row, false, true);
  }
  const digest = createHash("sha256");
  let count = 0;
  for await (const row of pages(
    client,
    "SELECT hash,size,required,materialized FROM asset_migration_scan WHERE hash>$1 ORDER BY hash LIMIT 1000",
  )) {
    signal?.throwIfAborted();
    const expected = domain.checkAssetInventoryRow({ hash: row.hash, size: row.size });
    const exists = source.mode === "s3" ? await copier.exists(expected) : row.materialized;
    if (!exists) {
      if (row.required || row.materialized) fail("ASSET_MIGRATION_MISSING_SOURCE");
      await client.query("DELETE FROM asset_migration_scan WHERE hash=$1", [row.hash]);
      continue; // An uncatalogued absent PENDING intent never materialized.
    }
    digest.update(`${JSON.stringify(expected)}\n`);
    count++;
  }
  return { digest: digest.digest("hex"), count };
}
async function inventoryDigest(client, attemptId) {
  const hash = createHash("sha256");
  let count = 0;
  for await (const row of pages(
    client,
    `SELECT hash,size FROM ${MIGRATION_ITEMS} WHERE hash>$1 AND "attemptId"=$2::uuid ORDER BY hash LIMIT 1000`,
    [attemptId],
  )) {
    hash.update(`${JSON.stringify(row)}\n`);
    count++;
  }
  return { digest: hash.digest("hex"), count };
}
async function clearCache(client, cacheId) {
  for (const [table, key, predicate] of [
    [
      "asset_cache_pin",
      "id",
      'incarnation IN (SELECT incarnation FROM asset_cache_entry WHERE "cacheId"=$1)',
    ],
    ["asset_cache_entry", "incarnation", '"cacheId"=$1'],
    ["asset_cache_owner", "epoch", '"cacheId"=$1'],
  ]) {
    for (;;) {
      const changed = await client.query(
        `DELETE FROM ${table} WHERE "${key}" IN (SELECT "${key}" FROM ${table} WHERE ${predicate} ORDER BY "${key}" LIMIT 1000) RETURNING "${key}"`,
        [cacheId],
      );
      if (!changed.rows.length) break;
    }
  }
  await client.query("DELETE FROM asset_cache_state WHERE id=$1", [cacheId]);
}

async function clearParticipants(client) {
  for (;;) {
    const rows = await client.query(
      "DELETE FROM app_setting WHERE key IN (SELECT key FROM app_setting WHERE key LIKE 'kb.maintenance.participant.%' ORDER BY key LIMIT 1000) RETURNING key",
    );
    if (!rows.rows.length) break;
  }
}

export async function migrateStorageOffline({
  connectionString,
  dataDir,
  to,
  attemptId,
  dryRun = false,
  reconcile = false,
  assetEnvironment = process.env,
  request,
  signal,
  barrier = async () => {},
  diskMeter,
}) {
  if (!["disk", "s3"].includes(to) || !UUID.test(attemptId)) fail("ASSET_MIGRATION_ARGUMENTS");
  signal?.throwIfAborted();
  const assetsDir = join(dataDir, "assets"),
    reposDir = join(dataDir, "repos");
  await assertOfflineFence(reposDir);
  const domain = await assetStorageDomain();
  const assertFences = domain.offlineAssetFenceProof(reposDir);
  assertFences();
  const client = await connect(connectionString);
  let copier;
  try {
    for (const lock of [72707370, ...LOCKS, 72707369])
      if (
        !(await client.query("SELECT pg_try_advisory_lock($1::bigint) AS held", [lock])).rows[0]
          ?.held
      )
        fail("ASSET_MIGRATION_BUSY");
    const pendingRestore = (
      await client.query("SELECT to_regclass('knowledge_base_control.kb_restore') AS present")
    ).rows[0]?.present;
    if (
      pendingRestore &&
      (
        await client.query(
          "SELECT 1 FROM knowledge_base_control.kb_restore WHERE singleton AND state<>'READY' LIMIT 1",
        )
      ).rows.length
    )
      fail("ASSET_MIGRATION_PENDING_RESTORE");
    if (
      (await client.query("SELECT value FROM app_setting WHERE key=$1", [REQUEST])).rows[0]
        ?.value !== request
    )
      fail("ASSET_MIGRATION_REQUEST_CHANGED");
    await installStorageMigrationControl(client);
    let attempt = (
      await client.query(`SELECT * FROM ${MIGRATION_TABLE} WHERE "attemptId"=$1::uuid`, [attemptId])
    ).rows[0];
    const targetReplay = attempt?.state === "READY" || attempt?.state === "VERIFYING";
    const active = await marker(client, domain);
    let source = attempt?.source ?? active;
    // An existing unmarked instance is disk. This observation is dual-fenced.
    if (!source) source = { version: 1, mode: "disk", activeGeneration: randomUUID() };
    const config =
      to === "s3" || (source.mode === "s3" && !targetReplay)
        ? domain.offlineAssetConfig({ ...assetEnvironment, KB_ASSET_S3_ENABLED: "true" })
        : { mode: "disk" };
    const limit =
      to === "s3" ? domain.offlineCacheLimit(assetEnvironment.KB_ASSET_CACHE_MAX_BYTES) : null;
    const targetSelection = to === "s3" ? { mode: to, locator: config.locator } : { mode: to };
    if (attempt) {
      if (
        !domain.sameAssetStorage(attempt.target, targetSelection) ||
        attempt.cacheLimit !== (limit?.toString() ?? null)
      )
        fail("ASSET_MIGRATION_ATTEMPT_CONFLICT");
      const expected = targetReplay ? attempt.target : attempt.source;
      if (!active || JSON.stringify(active) !== JSON.stringify(expected)) {
        // JSONB key order is immaterial; compare fields and generation.
        if (
          !active ||
          !domain.sameAssetStorage(active, expected) ||
          active.activeGeneration !== expected.activeGeneration
        )
          fail("ASSET_MIGRATION_SOURCE_CHANGED");
      }
    } else {
      await assertNoStorageMigration(client);
      if (
        reconcile
          ? !(
              source.mode === "s3" &&
              to === "s3" &&
              domain.sameAssetStorage(source, targetSelection)
            )
          : domain.sameAssetStorage(source, targetSelection) ||
            (source.mode === "s3" && to === "s3")
      )
        fail("ASSET_MIGRATION_DIRECTION");
    }
    if (targetReplay) {
      if (dryRun) fail("ASSET_MIGRATION_RESUME_REQUIRED");
      // Active authority was matched above. Close admission before observing
      // the mounted volume: even a missing/replaced root must fail closed.
      await client.query(
        `UPDATE ${MIGRATION_TABLE} SET state='VERIFYING' WHERE "attemptId"=$1::uuid`,
        [attemptId],
      );
      await barrier("reverify");
    }
    const binding = await domain.assetCacheBinding({
      assetsDir,
      storageGeneration: source.activeGeneration,
      configuration: "migration",
      limit: 26214400n,
    });
    if (attempt && attempt.cacheId !== binding.cacheId) fail("ASSET_MIGRATION_ATTEMPT_CONFLICT");
    if (source.mode === "s3" && !targetReplay && config.locator !== source.locator)
      fail("ASSET_MIGRATION_SOURCE_LOCATOR");
    if (!attempt && !dryRun) {
      const target = { version: 1, ...targetSelection, activeGeneration: randomUUID() };
      await transaction(client, async () => {
        if (!active) await setting(client, "kb.asset-storage", JSON.stringify(source));
        await client.query(
          `INSERT INTO ${MIGRATION_TABLE}("attemptId",source,target,"targetGeneration","targetLocator","targetMode","cacheLimit","cacheId",state) VALUES($1::uuid,$2::jsonb,$3::jsonb,$4::uuid,$5,$6,$7,$8,'INVENTORY')`,
          [
            attemptId,
            JSON.stringify(source),
            JSON.stringify(target),
            target.activeGeneration,
            to === "s3" ? target.locator : null,
            to,
            limit?.toString() ?? null,
            binding.cacheId,
          ],
        );
      });
      attempt = (
        await client.query(`SELECT * FROM ${MIGRATION_TABLE} WHERE "attemptId"=$1::uuid`, [
          attemptId,
        ])
      ).rows[0];
      await barrier("intent");
    }
    if (config.mode === "s3")
      copier = domain.createOfflineAssetCopier({
        config,
        assetsDir,
        connectionString,
        attemptId,
        generation:
          to === "s3" ? (attempt?.targetGeneration ?? randomUUID()) : source.activeGeneration,
        assertOfflineFences: assertFences,
        signal,
        barrier,
        meter: diskMeter,
      });
    if (dryRun) {
      if (attempt?.state === "CONVERTING" || targetReplay) fail("ASSET_MIGRATION_RESUME_REQUIRED");
      const scanned = await scanInventory(client, domain, source, copier, assetsDir, signal);
      await client.query("DELETE FROM app_setting WHERE key=$1 AND value=$2", [REQUEST, request]);
      await clearParticipants(client);
      return { dryRun: true, ...scanned };
    }
    if (!targetReplay) {
      await domain.recoverOfflineMigrationScratch({
        assetsDir,
        connectionString,
        attemptId,
        assertOfflineFences: assertFences,
        signal,
      });
      if (attempt.state === "INVENTORY")
        await domain.drainOfflineAssetCache({
          assetsDir,
          connectionString,
          assertOfflineFences: assertFences,
          signal,
        });
      if (attempt.state !== "CONVERTING") {
        const scanned = await scanInventory(client, domain, source, copier, assetsDir, signal);
        if (attempt.state === "INVENTORY") {
          await transaction(client, async () => {
            await client.query(
              `INSERT INTO ${MIGRATION_ITEMS}("attemptId",hash,size) SELECT $1::uuid,hash,size FROM asset_migration_scan ORDER BY hash`,
              [attemptId],
            );
            await client.query(
              `UPDATE ${MIGRATION_TABLE} SET state='COPYING',"inventoryDigest"=$2,"itemCount"=$3 WHERE "attemptId"=$1::uuid`,
              [attemptId, scanned.digest, scanned.count],
            );
          });
          attempt.state = "COPYING";
          attempt.inventoryDigest = scanned.digest;
          attempt.itemCount = scanned.count;
          await barrier("inventory");
        } else if (
          scanned.digest !== attempt.inventoryDigest ||
          scanned.count !== Number(attempt.itemCount)
        )
          fail("ASSET_MIGRATION_INVENTORY_CHANGED");
      }
    }
    const persisted = await inventoryDigest(client, attemptId);
    if (
      persisted.digest !== attempt.inventoryDigest ||
      persisted.count !== Number(attempt.itemCount)
    )
      fail("ASSET_MIGRATION_INVENTORY_CHANGED");
    for await (const row of pages(
      client,
      `SELECT hash,size FROM ${MIGRATION_ITEMS} WHERE hash>$1 AND "attemptId"=$2::uuid ORDER BY hash LIMIT 1000`,
      [attemptId],
    )) {
      signal?.throwIfAborted();
      assertFences();
      if (targetReplay || attempt.state === "CONVERTING") {
        if (to === "s3") {
          if (!(await copier.exists(row))) fail("ASSET_MIGRATION_MISSING_TARGET");
        } else await domain.offlineDiskBytes(assetsDir, row, () => {}, signal);
      } else {
        if (to === "s3") {
          if (source.mode === "s3") await copier.retainRemote(row);
          else await copier.toRemote(row);
        } else await copier.toDisk(row);
        await barrier("copied");
        await client.query(
          `UPDATE ${MIGRATION_TABLE} SET "lastHash"=$2 WHERE "attemptId"=$1::uuid`,
          [attemptId, row.hash],
        );
      }
    }
    await barrier("verified");
    if (!targetReplay) {
      await client.query(
        `UPDATE ${MIGRATION_TABLE} SET state='CONVERTING' WHERE "attemptId"=$1::uuid`,
        [attemptId],
      );
      attempt.state = "CONVERTING";
      await barrier("conversion");
      if (to === "s3") {
        // Empty is a valid bounded cache. Every unlink is authorized by an
        // attempt-inventory row AND a freshly verified remote counterpart.
        for await (const row of pages(
          client,
          `SELECT hash,size FROM ${MIGRATION_ITEMS} WHERE hash>$1 AND "attemptId"=$2::uuid ORDER BY hash LIMIT 1000`,
          [attemptId],
        )) {
          signal?.throwIfAborted();
          assertFences();
          if (!(await copier.exists(row))) fail("ASSET_MIGRATION_MISSING_TARGET");
          await domain.removeOfflineDiskObject(assetsDir, row, signal);
          await barrier("trimmed");
        }
      }
      await clearCache(client, binding.cacheId);
      if (to === "s3")
        await domain.initializeOfflineAssetCache({
          assetsDir,
          connectionString,
          generation: attempt.targetGeneration,
          locator: attempt.targetLocator,
          limit,
          assertOfflineFences: assertFences,
          signal,
        });
      await barrier("fsynced");
      for await (const row of pages(
        client,
        `SELECT hash,size FROM ${MIGRATION_ITEMS} WHERE hash>$1 AND "attemptId"=$2::uuid ORDER BY hash LIMIT 1000`,
        [attemptId],
      )) {
        signal?.throwIfAborted();
        if (to === "s3") {
          if (!(await copier.exists(row))) fail("ASSET_MIGRATION_MISSING_TARGET");
        } else await domain.offlineDiskBytes(assetsDir, row, () => {}, signal);
      }
      assertFences();
      signal?.throwIfAborted();
      await transaction(client, async () => {
        await setting(client, "kb.asset-storage", JSON.stringify(attempt.target));
        await client.query(
          `UPDATE ${MIGRATION_TABLE} SET state='READY' WHERE "attemptId"=$1::uuid AND state='CONVERTING'`,
          [attemptId],
        );
        await client.query("DELETE FROM app_setting WHERE key=$1 AND value=$2", [REQUEST, request]);
      });
      await barrier("activated");
    } else {
      await transaction(client, async () => {
        await client.query(
          `UPDATE ${MIGRATION_TABLE} SET state='READY' WHERE "attemptId"=$1::uuid AND state='VERIFYING'`,
          [attemptId],
        );
        await client.query("DELETE FROM app_setting WHERE key=$1 AND value=$2", [REQUEST, request]);
      });
    }
    await clearParticipants(client);
    return { state: "READY", ...persisted };
  } finally {
    try {
      await copier?.close();
    } finally {
      await client.end().catch(() => {});
    }
  }
}

/** Existing durable request/drain handoff; child owns both native fences before
 * acquiring runner -> request -> maintenance -> DADP -> Prisma locks for any byte operation. */
export async function coordinateStorageMigration({
  connectionString,
  dataDir,
  to,
  attemptId,
  dryRun = false,
  reconcile = false,
  assetEnvironment = process.env,
  supervisor = "/usr/local/bin/kb-supervisor",
  signal,
}) {
  if (!["disk", "s3"].includes(to) || !UUID.test(attemptId)) fail("ASSET_MIGRATION_ARGUMENTS");
  const client = await connect(connectionString);
  const request = JSON.stringify({ assetStorageAttempt: attemptId, runId: randomUUID() });
  try {
    if (
      !(await client.query("SELECT pg_try_advisory_lock($1::bigint) AS held", [72707370])).rows[0]
        ?.held
    )
      fail("ASSET_MIGRATION_BUSY");
    if (
      !(await client.query("SELECT pg_try_advisory_lock($1::bigint) AS held", [LOCKS[0]])).rows[0]
        ?.held
    )
      fail("ASSET_MIGRATION_BUSY");
    const previous = (await client.query("SELECT value FROM app_setting WHERE key=$1", [REQUEST]))
      .rows[0];
    if (previous && JSON.parse(previous.value).assetStorageAttempt !== attemptId)
      fail("ASSET_MIGRATION_OTHER_MAINTENANCE");
    await setting(client, REQUEST, request);
    const end = performance.now() + 300000;
    for (;;) {
      signal?.throwIfAborted();
      if (
        (await client.query("SELECT pg_try_advisory_lock($1::bigint) AS held", [LOCKS[1]])).rows[0]
          ?.held
      )
        break;
      if (performance.now() >= end) fail("ASSET_MIGRATION_DRAIN_TIMEOUT");
      await new Promise((r) => setTimeout(r, 100));
    }
    if (
      !previous &&
      (
        await client.query(
          "SELECT key FROM app_setting WHERE key LIKE 'kb.maintenance.participant.%' AND value<>$1 LIMIT 1",
          [`${request}:DRAINED`],
        )
      ).rows.length
    )
      fail("ASSET_MIGRATION_UNCLEAN_DRAIN");
    await client.query("SELECT pg_advisory_unlock($1::bigint)", [LOCKS[1]]);
    await client.query("SELECT pg_advisory_unlock($1::bigint)", [LOCKS[0]]);
    await client.query("SELECT pg_advisory_unlock($1::bigint)", [72707370]);
    const env = assetOperatorEnv(assetEnvironment);
    await boundedChild(
      supervisor,
      [
        "--asset-storage",
        "--",
        process.execPath,
        fileURLToPath(import.meta.url),
        "offline",
        "--to",
        to,
        "--attempt",
        attemptId,
        ...(dryRun ? ["--dry-run"] : []),
        ...(reconcile ? ["--reconcile"] : []),
        "--request",
        request,
      ],
      {
        signal,
        cooperative: true,
        timeout: 24 * 60 * 60 * 1000,
        stdio: "inherit",
        env: {
          ...env,
          KB_ASSET_CACHE_MAX_BYTES: assetEnvironment.KB_ASSET_CACHE_MAX_BYTES,
          PATH: process.env.PATH,
          TMPDIR: process.env.TMPDIR,
          DATABASE_URL: connectionString,
          KB_DATA_ROOT: dataDir,
        },
      },
    ).done;
  } finally {
    await client.end().catch(() => {});
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const abort = new AbortController();
  for (const name of ["SIGTERM", "SIGINT", "SIGHUP"]) process.once(name, () => abort.abort());
  try {
    const [command, ...args] = process.argv.slice(2);
    const input = {
      connectionString: process.env.DATABASE_URL,
      dataDir: process.env.KB_DATA_ROOT,
      signal: abort.signal,
    };
    if (command === "status" && !args.length)
      console.log(JSON.stringify(await storageStatus(input), null, 2));
    else {
      const options = {};
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "--reconcile" && command === "offline" && !options.reconcile)
          options.reconcile = true;
        else if (args[i] === "--request" && command === "offline" && !options.request)
          options.request = args[++i];
        else if (args[i] === "--limit" && command === "cache-reconcile" && !options.limit)
          options.limit = args[++i];
        else if (args[i] === "--dry-run" && options.dryRun === undefined) options.dryRun = true;
        else if (args[i] === "--to" && !options.to) options.to = args[++i];
        else if (args[i] === "--attempt" && !options.attemptId) options.attemptId = args[++i];
        else fail("ASSET_MIGRATION_ARGUMENTS");
      }
      if (command === "cache-reconcile") {
        const domain = await assetStorageDomain();
        domain.offlineCacheLimit(options.limit);
        await coordinateStorageMigration({
          ...input,
          ...options,
          to: "s3",
          reconcile: true,
          assetEnvironment: { ...process.env, KB_ASSET_CACHE_MAX_BYTES: options.limit },
        });
      } else if (command === "migrate") await coordinateStorageMigration({ ...input, ...options });
      else if (command === "offline")
        console.log(
          JSON.stringify(
            await migrateStorageOffline({
              ...input,
              ...options,
              request: options.request,
            }),
          ),
        );
      else fail("ASSET_MIGRATION_ARGUMENTS");
    }
  } catch {
    console.error(
      "FATAL: asset storage migration refused or interrupted. Inspect status and retry the same attempt/configuration offline; retained bytes and pending intent are preserved.",
    );
    process.exitCode = 1;
  }
}
