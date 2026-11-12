/** Offline, fenced kb/backup/3. No shells, tar traversal, or app secrets. */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, openSync, readFileSync } from "node:fs";
import {
  link,
  mkdir,
  mkdtemp,
  open,
  opendir,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { captureMigrationHistory } from "../db/lib/contracts.mjs";
import {
  prismaSchemaName,
  readApplicationCatalog,
  readMigrationsFolder,
} from "../db/lib/migration-state.mjs";
import { kbDataPaths } from "../init-kb-volumes.mjs";
import { assertNoStorageMigration } from "./asset-storage-control.mjs";
import {
  assetOperatorEnv,
  assetStorageDomain,
  operatorAssetConfig,
} from "./asset-storage-domain.mjs";
import { boundedChild } from "./bounded-child.mjs";

const LOCK = 0x4b424d41,
  REQUEST_LOCK = 0x4b424d52;
const REQUEST = "kb.maintenance.request";
const ROOT = resolve(import.meta.dirname, "../..");

const monotonicMs = () => Number(process.hrtime.bigint() / 1_000_000n);
const SAFE =
  /^(asset-inventory\.jsonl|postgres\.dump|schema\/migrations\/(?:migration_lock\.toml|[A-Za-z0-9_-]+\/(?:migration|contract)\.sql)|repos\/kb_[a-z0-9]{24,32}\.git\/[A-Za-z0-9_./-]+|assets\/objects\/[a-f0-9]{2}\/[a-f0-9]{62})$/;
export function pathCheck(path, directory = false) {
  if (
    !(
      SAFE.test(path) ||
      (directory &&
        /^(assets\/objects(?:\/[a-f0-9]{2})?|repos\/kb_[a-z0-9]{24,32}\.git(?:\/[A-Za-z0-9_./-]+)?|schema\/migrations\/[A-Za-z0-9_./-]+)$/.test(
          path,
        ))
    ) ||
    path.normalize("NFC") !== path ||
    path.split("/").some((p) => !p || p === "." || p === "..")
  )
    throw new Error("Invalid backup path.");
}
/** The discriminator owns the content policy; missing files never select a mode. */
export async function bundleVersion(metadata, paths) {
  const version = metadata?.version;
  if (version === 1 || version === 2)
    throw new Error(
      "Prerelease backup format is unsupported; use a migration-aware kb/backup/3 bundle.",
    );
  if (
    version === 3 &&
    metadata.storage?.mode === "disk" &&
    Object.keys(metadata.storage).length === 1 &&
    !paths.includes("asset-inventory.jsonl")
  )
    return 3;
  if (
    version === 3 &&
    metadata.storage?.mode === "s3" &&
    paths.filter((p) => p === "asset-inventory.jsonl").length === 1 &&
    !paths.some((p) => p.startsWith("assets/"))
  ) {
    (await assetStorageDomain()).checkAssetBundleStorage(metadata.storage);
    return 3;
  }
  throw new Error("Invalid bundle storage variant.");
}
export async function forAssetInventory(path, work) {
  const handle = await openPath(path);
  try {
    const domain = await assetStorageDomain();
    for await (const row of domain.readAssetInventory(
      handle.createReadStream({ autoClose: false }),
    ))
      await work(row);
  } finally {
    await handle.close();
  }
}
export async function verifyAssetInventory(path, config, signal) {
  const verifier = (await assetStorageDomain()).createOfflineAssetVerifier(config, signal);
  try {
    await forAssetInventory(path, (row) => verifier.verify(row));
  } finally {
    await verifier.close();
  }
}

export async function openPath(path, flags = constants.O_RDONLY, mode) {
  const parts = resolve(path).slice(1).split("/");
  let handle = await open("/", constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    for (let i = 0; i < parts.length; i++) {
      const next = await open(
        `/proc/self/fd/${handle.fd}/${parts[i]}`,
        i === parts.length - 1
          ? flags | constants.O_NOFOLLOW
          : constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        mode,
      );
      await handle.close();
      handle = next;
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}
export async function digest(path) {
  const handle = await openPath(path);
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw new Error("Backup requires regular files.");
    const hash = createHash("sha256");
    for await (const bytes of handle.createReadStream({ autoClose: false })) hash.update(bytes);
    return { size: st.size, sha256: hash.digest("hex") };
  } finally {
    await handle.close();
  }
}
export function syncDir(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
async function write(stream, bytes) {
  await new Promise((resolveWrite, reject) =>
    stream.write(bytes, (error) => (error ? reject(error) : resolveWrite())),
  );
}
export async function assertOfflineFence(reposDir) {
  for (const [variable, name] of [
    ["KB_FENCE_FD", "server"],
    ["KB_WORKER_FENCE_FD", "worker"],
  ]) {
    const fd = Number(process.env[variable]);
    if (!Number.isInteger(fd) || fd < 3) throw new Error("Offline volume fence is required.");
    const file = await openPath(join(reposDir, `.private/${name}.fence`));
    try {
      const expected = await file.stat(),
        actual = fstatSync(fd);
      if (
        actual.ino !== expected.ino ||
        actual.dev !== expected.dev ||
        !/FLOCK.*WRITE/.test(readFileSync(`/proc/self/fdinfo/${fd}`, "utf8"))
      )
        throw new Error("Offline volume fence is not held.");
    } finally {
      await file.close();
    }
  }
}

export async function verifyEncryptedBundle(file) {
  if (!file.endsWith(".age")) throw new Error("Encrypted bundle required.");
  const markerHandle = await openPath(`${file}.complete`);
  let marker;
  try {
    if ((await markerHandle.stat()).size > 4096) throw new Error("Invalid completion marker.");
    marker = JSON.parse(await markerHandle.readFile("utf8"));
  } finally {
    await markerHandle.close();
  }
  const header = await openPath(file);
  try {
    const bytes = Buffer.alloc(22);
    await header.read(bytes, 0, bytes.length, 0);
    if (!bytes.toString().startsWith("age-encryption.org/v1\n"))
      throw new Error("Invalid encrypted backup header.");
  } finally {
    await header.close();
  }
  const actual = await digest(file);
  if (marker.version !== 1 || marker.size !== actual.size || marker.sha256 !== actual.sha256)
    throw new Error("Incomplete or corrupt backup bundle.");
  return actual;
}

export async function encryptBundle({
  file,
  metadata,
  sources,
  recipient,
  signal,
  barrier = async () => {},
  stageDir = dirname(file),
  beforeComplete = async () => {},
}) {
  if (!/^age1(?:pq1)?[a-z0-9]+$/.test(recipient ?? ""))
    throw new Error("BACKUP_AGE_RECIPIENT is required.");
  const parent = await openPath(dirname(file), constants.O_RDONLY | constants.O_DIRECTORY);
  await parent.close();
  const stage = await mkdtemp(join(stageDir, ".kb-backup-"));
  let encrypted,
    published = false,
    markerPublished = false;
  try {
    const inventory = [],
      seen = new Set();
    for (const entry of sources) {
      signal?.throwIfAborted();
      pathCheck(entry.path);
      if (seen.has(entry.path)) throw new Error("Duplicate backup path.");
      seen.add(entry.path);
      const hashed = await digest(entry.source);
      if (
        entry.path.startsWith("assets/objects/") &&
        entry.path.slice(15).replace("/", "") !== hashed.sha256
      )
        throw new Error("CAS filename/hash mismatch.");
      inventory.push({ ...entry, ...hashed });
    }
    const format = await bundleVersion(
      metadata,
      inventory.map((e) => e.path),
    );
    const version = boundedChild("age", ["--version"], {
      signal,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
    let versionText = "";
    version.child.stdout.on("data", (b) => {
      versionText += b;
    });
    await version.done;
    if (versionText.trim() !== "v1.3.2") throw new Error("Pinned age v1.3.2 is required.");
    const output = join(stage, "bundle.age");
    const handle = await openPath(
      output,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    encrypted = boundedChild("age", ["-r", recipient], {
      signal,
      stdio: ["pipe", handle.fd, "ignore"],
      timeout: 3_600_000,
    });
    void encrypted.done.catch(() => {});
    encrypted.child.stdin.on("error", () => {});
    try {
      await barrier("encryption-started");
      const input = encrypted.child.stdin;
      await write(
        input,
        `kb/backup/${format}\n` +
          JSON.stringify({
            metadata,
            inventory: inventory.map(({ source: _, ...entry }) => entry),
          }) +
          "\n",
      );
      for (const entry of inventory) {
        await barrier("file");
        signal?.throwIfAborted();
        await write(input, JSON.stringify({ path: entry.path, size: entry.size }) + "\n");
        const source = await openPath(entry.source);
        const hash = createHash("sha256");
        let size = 0;
        try {
          await barrier("file-started");
          for await (const bytes of source.createReadStream({ autoClose: false })) {
            signal?.throwIfAborted();
            size += bytes.length;
            hash.update(bytes);
            await write(input, bytes);
          }
        } finally {
          await source.close();
        }
        if (size !== entry.size || hash.digest("hex") !== entry.sha256)
          throw new Error("Source changed during backup.");
        await write(input, "\n");
      }
      await write(input, '{"complete":true}\n');
      input.end();
      await encrypted.done;
      await barrier("encryption");
      await handle.sync();
    } finally {
      encrypted.stop();
      await encrypted.done.catch(() => {});
      await handle.close();
    }
    signal?.throwIfAborted();
    await barrier("publish");
    const actual = await digest(output);
    const marker = join(stage, "complete");
    const markerFile = await open(marker, "wx", 0o600);
    try {
      await markerFile.writeFile(
        JSON.stringify({ version: 1, ...actual, createdAt: new Date().toISOString() }),
      );
      await markerFile.sync();
    } finally {
      await markerFile.close();
    }
    await link(output, file);
    published = true;
    syncDir(dirname(file));
    await barrier("ciphertext-published");
    const referenceFile =
      metadata.storage?.mode === "s3"
        ? inventory.find((e) => e.path === "asset-inventory.jsonl")
        : undefined;
    const checkReferences = async () => {
      if (!referenceFile) return;
      const actual = await digest(referenceFile.source);
      if (actual.sha256 !== referenceFile.sha256 || actual.size !== referenceFile.size)
        throw new Error("Asset inventory changed during backup.");
    };
    await checkReferences();
    await beforeComplete();
    await checkReferences();
    signal?.throwIfAborted();
    await link(marker, `${file}.complete`);
    markerPublished = true;
    syncDir(dirname(file));
    return file;
  } catch (error) {
    if (published) {
      if (markerPublished) await unlink(`${file}.complete`);
      await unlink(file);
      syncDir(dirname(file));
    }
    throw error;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

/** Bounded verification reader for fixtures/operator inspection; no extraction. */
export async function readBundle(file, identity, { maxBytes = 256 * 1024 * 1024 } = {}) {
  await verifyEncryptedBundle(file);
  const owner = boundedChild("age", ["-d", "-i", identity, file], {
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 300_000,
  });
  void owner.done.catch(() => {});
  try {
    const chunks = [];
    let size = 0;
    for await (const bytes of owner.child.stdout) {
      size += bytes.length;
      if (size > maxBytes) throw new Error("Backup reader byte budget exceeded.");
      chunks.push(bytes);
    }
    await owner.done;
    const body = Buffer.concat(chunks);
    let offset = 0;
    const line = () => {
      const end = body.indexOf(10, offset);
      if (end < 0) throw new Error("Incomplete bundle.");
      const text = body.subarray(offset, end).toString();
      offset = end + 1;
      return text;
    };
    const magic = line();
    if (["kb/backup/1", "kb/backup/2"].includes(magic))
      throw new Error("Prerelease backup format is unsupported.");
    if (magic !== "kb/backup/3") throw new Error("Invalid bundle version.");
    const { metadata, inventory } = JSON.parse(line());
    if (
      !Array.isArray(inventory) ||
      magic !==
        `kb/backup/${await bundleVersion(
          metadata,
          inventory.map((e) => e.path),
        )}`
    )
      throw new Error("Invalid bundle metadata.");
    const files = [],
      seen = new Set();
    for (const entry of inventory) {
      pathCheck(entry.path);
      if (seen.has(entry.path) || !Number.isSafeInteger(entry.size) || entry.size < 0)
        throw new Error("Invalid file inventory.");
      seen.add(entry.path);
      const frame = JSON.parse(line());
      if (frame.path !== entry.path || frame.size !== entry.size)
        throw new Error("Invalid file frame.");
      const bytes = body.subarray(offset, offset + entry.size);
      offset += entry.size;
      if (
        bytes.length !== entry.size ||
        createHash("sha256").update(bytes).digest("hex") !== entry.sha256 ||
        line() !== ""
      )
        throw new Error("Backup file hash mismatch.");
      files.push({ ...entry, bytes });
    }
    if (JSON.parse(line()).complete !== true || offset !== body.length)
      throw new Error("Incomplete bundle.");
    return { metadata, files };
  } finally {
    owner.stop();
    await owner.done.catch(() => {});
  }
}

async function collect(root, prefix, sources) {
  const handle = await openPath(root, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    for (const name of (await readdir(`/proc/self/fd/${handle.fd}`)).sort()) {
      const path = `${prefix}/${name}`;
      pathCheck(path, true);
      const child = await openPath(join(root, name));
      let st;
      try {
        st = await child.stat();
      } finally {
        await child.close();
      }
      if (st.isDirectory()) await collect(join(root, name), path, sources);
      else if (st.isFile()) {
        pathCheck(path);
        sources.push({ path, source: join(root, name), size: st.size });
      } else throw new Error("Special backup file refused.");
      if (sources.length > 1_000_000) throw new Error("Backup file inventory budget exceeded.");
    }
  } finally {
    await handle.close();
  }
}
async function connect(connectionString) {
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 5000,
    application_name: "kb-offline-backup",
    statement_timeout: 300_000,
  });
  client.on("error", () => {});
  await client.connect();
  return client;
}
async function audit(client, runId, action, outcome, reasonCode) {
  await client.query(
    `INSERT INTO audit_event (id,"createdAt","opId",action,outcome,"actorKey","actorUserIdSnapshot",metadata)
    VALUES ($1,now(),$2,$3,$4::"AuditOutcome",'system:backup','system:backup',$5::jsonb)
    ON CONFLICT ("opId",action,outcome) DO NOTHING`,
    [
      randomUUID().replaceAll("-", "").slice(0, 24),
      runId,
      action,
      outcome,
      JSON.stringify({ requestId: runId, reasonCode }),
    ],
  );
}
async function setting(client, key, value) {
  await client.query(
    'INSERT INTO app_setting (key,value,"createdAt","updatedAt") VALUES ($1,$2,now(),now()) ON CONFLICT (key) DO UPDATE SET value=$2,"updatedAt"=now()',
    [key, value],
  );
}
export function pgEnv(connectionString) {
  const url = new URL(connectionString);
  return {
    PATH: process.env.PATH,
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGSSLMODE: url.searchParams.get("sslmode") || "prefer",
  };
}

/** REQUEST_LOCK excludes coordinators; both native flocks exclude every producer.
 * The durable request denies successor startup. Reclaim only our stage namespace,
 * through a pinned no-follow parent; completed backups have different names.
 */
async function reclaimStages(backupDir, signal) {
  const parent = await openPath(backupDir, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    const root = `/proc/self/fd/${parent.fd}`;
    for await (const entry of await opendir(root)) {
      signal?.throwIfAborted();
      if (!/^\.kb-(cutoff|backup)-(?:[A-Za-z0-9]{6}|[a-f0-9-]{36})$/.test(entry.name)) continue;
      const stage = await openPath(
        join(backupDir, entry.name),
        constants.O_RDONLY | constants.O_DIRECTORY,
      );
      await stage.close();
      const owner = entry.name.match(/^\.kb-cutoff-([a-f0-9-]{36})$/);
      if (owner) {
        const file = `backup-${owner[1]}.age`;
        let marker;
        try {
          marker = await openPath(join(backupDir, `${file}.complete`));
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          // Durable stage identity precedes promotion. Never remove a completed
          // backup, but settle a killed promotion that has no validity marker.
          await unlink(join(root, file)).catch((missing) => {
            if (missing.code !== "ENOENT") throw missing;
          });
        } finally {
          await marker?.close();
        }
      }
      await rm(join(root, entry.name), { recursive: true });
    }
    await parent.sync();
  } finally {
    await parent.close();
  }
}

/** Called ONLY by --backup native role, after both lifetime flocks are held. */
/** Refuse a missing/relative data root before any IO; derive the surfaces. */
function backupPaths(dataDir) {
  if (typeof dataDir !== "string" || !isAbsolute(dataDir))
    throw new Error("Backup requires KB_DATA_ROOT (an absolute directory).");
  return kbDataPaths(dataDir);
}

export async function snapshotOffline({
  connectionString,
  dataDir,
  backupDir,
  recipient,
  schemaDir,
  runId,
  signal,
  barrier = async () => {},
  assetConfig,
}) {
  assetConfig ??= await operatorAssetConfig();
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(runId))
    throw new Error("Invalid backup run ID.");
  const { reposDir, assetsDir } = backupPaths(dataDir);
  await assertOfflineFence(reposDir);
  const client = await connect(connectionString);
  const stage = join(backupDir, `.kb-cutoff-${runId}`);
  let stageOwned = false;
  try {
    await client.query("SELECT pg_advisory_lock($1::bigint)", [LOCK]);
    await client.query("SELECT pg_advisory_lock(1145389648::bigint)");
    await client.query("SELECT pg_advisory_lock(72707369::bigint)");
    await assertNoStorageMigration(client);
    const requested = await client.query("SELECT value FROM app_setting WHERE key=$1", [REQUEST]);
    if (!requested.rows.length) throw new Error("Durable maintenance request is required.");
    const marker = (
      await client.query("SELECT value FROM app_setting WHERE key='kb.asset-storage'")
    ).rows[0];
    const recorded = marker ? JSON.parse(marker.value) : { mode: "disk" };
    if (
      recorded.mode !== assetConfig.mode ||
      (assetConfig.mode === "s3" &&
        (recorded.version !== 1 ||
          recorded.locator !== assetConfig.locator ||
          !recorded.activeGeneration))
    )
      throw new Error("Recorded asset storage disagrees with backup configuration.");
    await reclaimStages(backupDir, signal);
    // Native ownership, not age or acknowledgement text, proves these rows dead.
    // Each committed page is safe if recovery crashes; the request stays closed.
    for (;;) {
      signal?.throwIfAborted();
      const reclaimed = await client.query(
        "DELETE FROM app_setting WHERE key IN (SELECT key FROM app_setting WHERE key LIKE 'kb.maintenance.participant.%' ORDER BY key LIMIT 1000) RETURNING key",
      );
      await barrier("reclaimed");
      if (!reclaimed.rows.length) break;
    }
    await mkdir(stage, { mode: 0o700 });
    stageOwned = true;
    const identity = await client.query(
      "SELECT value FROM app_setting WHERE key='kb.instance.identity'",
    );
    if (!identity.rows.length)
      await setting(
        client,
        "kb.instance.identity",
        JSON.stringify({ instanceId: randomUUID(), authorityEpoch: "1" }),
      );
    await audit(client, runId, "BACKUP_CUTOFF", "SUCCESS", "QUIESCED");
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const snapshot = await client.query(
      "SELECT pg_export_snapshot() AS snapshot, clock_timestamp() AS cutoff",
    );
    const unfinished = await client.query(
      "SELECT \"opId\" FROM operation_intent WHERE phase IN ('PREPARED','COMMITTING') LIMIT 1",
    );
    if (unfinished.rows.length) throw new Error("Journal recovery required before backup.");
    const heads = [];
    let last = "";
    for (;;) {
      const page = await client.query(
        'SELECT id,"headSha",state FROM knowledge_base WHERE id > $1 ORDER BY id LIMIT 100',
        [last],
      );
      heads.push(...page.rows);
      if (!page.rows.length) break;
      last = page.rows.at(-1).id;
    }
    const sources = [];
    for (const kb of heads) {
      if (!/^[a-z0-9]{24,32}$/.test(kb.id)) throw new Error("Invalid repository inventory.");
      if (!kb.headSha && kb.state === "TOMBSTONED") continue;
      if (!kb.headSha) throw new Error("Journal recovery required before repository inventory.");
      const repo = join(reposDir, `kb_${kb.id}.git`);
      await collect(repo, `repos/kb_${kb.id}.git`, sources);
      const git = boundedChild(
        "git",
        ["--git-dir", repo, "-c", "core.hooksPath=/dev/null", "rev-parse", "refs/heads/main"],
        {
          signal,
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 30_000,
          env: {
            PATH: process.env.PATH,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_NO_REPLACE_OBJECTS: "1",
          },
        },
      );
      let sha = "";
      git.child.stdout.on("data", (b) => {
        sha += b;
      });
      await git.done;
      if (sha.trim() !== kb.headSha)
        throw new Error("Repository head and PostgreSQL journal disagree.");
    }
    const inventoryPath = join(stage, "asset-inventory.jsonl");
    const remote = assetConfig.mode === "s3";
    if (!remote)
      await collect(join(assetsDir, "objects"), "assets/objects", sources).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    const captured = new Map(sources.map((entry) => [entry.path, entry.size]));
    const domain = remote ? await assetStorageDomain() : undefined;
    const verifier = remote ? domain.createOfflineAssetVerifier(assetConfig, signal) : undefined;
    let outputInventory;
    try {
      if (remote) outputInventory = await open(inventoryPath, "wx", 0o600);
      let blobCursor = "";
      for (;;) {
        signal?.throwIfAborted();
        const page = await client.query(
          "SELECT hash,size FROM asset_blob WHERE hash > $1 ORDER BY hash LIMIT 1000",
          [blobCursor],
        );
        if (!page.rows.length) break;
        for (const blob of page.rows) {
          if (remote) {
            domain.checkAssetInventoryRow(blob);
            await verifier.verify(blob);
            await outputInventory.writeFile(JSON.stringify(blob) + "\n");
          } else {
            const hex = blob.hash.slice(7);
            if (captured.get(`assets/objects/${hex.slice(0, 2)}/${hex.slice(2)}`) !== blob.size)
              throw new Error("Historic CAS blob is missing.");
          }
        }
        blobCursor = page.rows.at(-1).hash;
      }
      await outputInventory?.sync();
    } finally {
      await outputInventory?.close();
      await verifier?.close();
    }
    if (remote) sources.push({ path: "asset-inventory.jsonl", source: inventoryPath });
    await collect(join(schemaDir, "migrations"), "schema/migrations", sources);
    const schema = prismaSchemaName(connectionString);
    const migrationHistory = await captureMigrationHistory(client, {
      schema,
      migrations: readMigrationsFolder(join(schemaDir, "migrations")),
    });
    const sourceCatalog = await readApplicationCatalog(client, schema);
    const instance = JSON.parse(
      (await client.query("SELECT value FROM app_setting WHERE key='kb.instance.identity'")).rows[0]
        .value,
    );
    const dump = join(stage, "postgres.dump"),
      output = await open(dump, "wx", 0o600);
    await barrier("dump");
    try {
      const child = boundedChild(
        "pg_dump",
        [
          "-Fc",
          "--no-owner",
          "--no-privileges",
          "--exclude-schema=knowledge_base_control",
          `--snapshot=${snapshot.rows[0].snapshot}`,
        ],
        {
          signal,
          env: pgEnv(connectionString),
          stdio: ["ignore", output.fd, "ignore"],
          timeout: 3_600_000,
        },
      );
      try {
        await barrier("dump-started");
        await child.done;
        await output.sync();
      } finally {
        child.stop();
        await child.done.catch(() => {});
      }
    } finally {
      await output.close();
    }
    sources.unshift({ path: "postgres.dump", source: dump });
    await client.query("COMMIT");
    await client.query(
      "UPDATE audit_event SET revision=$2 WHERE \"opId\"=$1 AND action='BACKUP_CUTOFF'",
      [runId, snapshot.rows[0].cutoff.toISOString()],
    );
    const file = join(backupDir, `backup-${runId}.age`);
    await encryptBundle({
      file,
      stageDir: stage,
      beforeComplete: remote
        ? () => verifyAssetInventory(inventoryPath, assetConfig, signal)
        : undefined,
      metadata: {
        version: 3,
        storage: remote ? { mode: "s3", locator: assetConfig.locator } : { mode: "disk" },
        cutoff: snapshot.rows[0].cutoff.toISOString(),
        ...instance,
        heads,
        migrationHistory,
        sourceCatalog,
      },
      sources,
      recipient,
      signal,
      barrier,
    });
    return file;
  } finally {
    await client.end().catch(() => {});
    if (stageOwned) await rm(stage, { recursive: true, force: true });
  }
}

export async function coordinateBackup({
  assetEnvironment = process.env,
  connectionString,
  dataDir,
  backupDir,
  recipient,
  schemaDir = join(ROOT, "packages/db/prisma"),
  supervisor = "/usr/local/bin/kb-supervisor",
  signal,
  timeout = 300_000,
  now = monotonicMs,
  runId = randomUUID(),
  barrier = async () => {},
  connectClient = connect,
  runChild = boundedChild,
}) {
  backupPaths(dataDir);
  if (typeof backupDir !== "string" || !isAbsolute(backupDir))
    throw new Error("Backup requires an absolute BACKUP_DIR.");
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(runId))
    throw new Error("Invalid backup run ID.");
  const assetEnv = assetOperatorEnv(assetEnvironment);
  await operatorAssetConfig(assetEnv);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 300_000)
    throw new Error("Invalid maintenance drain budget.");
  if (!/^age1(?:pq1)?[a-z0-9]+$/.test(recipient ?? ""))
    throw new Error("BACKUP_AGE_RECIPIENT is required.");
  const preflight = runChild("age", ["-r", recipient], {
    signal,
    stdio: ["pipe", "ignore", "ignore"],
    timeout: 5000,
  });
  preflight.child.stdin.end();
  await preflight.done;
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  const client = await connectClient(connectionString);
  let owned = false,
    completed = false,
    cleanDrain = false,
    request;
  try {
    const lock = await client.query("SELECT pg_try_advisory_lock($1::bigint) AS held", [
      REQUEST_LOCK,
    ]);
    if (!lock.rows[0]?.held) throw new Error("Another backup owns maintenance.");
    await assertNoStorageMigration(client);
    owned = true;
    const previous = await client.query("SELECT value FROM app_setting WHERE key=$1", [REQUEST]);
    request = JSON.stringify({ runId, recovery: previous.rows.length > 0 });
    const deadline = now() + timeout;
    await setting(client, REQUEST, request); // durable intent before process teardown
    await barrier("drain");
    for (;;) {
      signal?.throwIfAborted();
      const result = await client.query("SELECT pg_try_advisory_lock($1::bigint) AS held", [LOCK]);
      if (now() >= deadline)
        throw new Error("Maintenance drain exceeded five minutes; backup aborted.");
      if (result.rows[0]?.held) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!previous.rows.length) {
      const unclean = await client.query(
        "SELECT key FROM app_setting WHERE key LIKE 'kb.maintenance.participant.%' AND value <> $1 LIMIT 1",
        [`${request}:DRAINED`],
      );
      if (unclean.rows.length)
        throw new Error("Incomplete maintenance drain; offline recovery required.");
      cleanDrain = true;
    }
    if (now() >= deadline)
      throw new Error("Maintenance drain exceeded five minutes; backup aborted.");
    await client.query("SELECT pg_advisory_unlock($1::bigint)", [LOCK]);
    // Durable request denies restarts across handoff. Never take a second flock
    // while live owners hold theirs: native role fails closed, never snapshots.
    const child = runChild(
      supervisor,
      ["--backup", "--", process.execPath, fileURLToPath(import.meta.url), "snapshot"],
      {
        signal,
        cooperative: true,
        timeout: 3_900_000,
        env: {
          ...assetEnv,
          PATH: process.env.PATH,
          DATABASE_URL: connectionString,
          KB_DATA_ROOT: dataDir,
          BACKUP_DIR: backupDir,
          BACKUP_AGE_RECIPIENT: recipient,
          KB_BACKUP_RUN_ID: runId,
          KB_BACKUP_SCHEMA_DIR: schemaDir,
          KB_BACKUP_FENCE_DEADLINE_MS: String(deadline),
        },
        stdio: "inherit",
      },
    );
    await child.done;
    const file = join(backupDir, `backup-${runId}.age`);
    await verifyEncryptedBundle(file);
    await audit(client, runId, "BACKUP_RESULT", "SUCCESS", "ENCRYPTED");
    completed = true;
    return file;
  } catch (error) {
    if (owned) await audit(client, runId, "BACKUP_RESULT", "FAILURE", "ABORTED").catch(() => {});
    throw error;
  } finally {
    // A settled snapshot child after a clean runtime drain is safe to resume
    // even when snapshot/hash/encryption failed. An interrupted drain or an
    // inherited recovery request still needs a successful offline snapshot.
    if (owned && (completed || cleanDrain)) {
      try {
        const lock = await client.query("SELECT pg_try_advisory_lock($1::bigint) AS held", [LOCK]);
        if (lock.rows[0]?.held) {
          for (;;) {
            const removed = await client.query(
              "DELETE FROM app_setting WHERE key IN (SELECT key FROM app_setting WHERE key LIKE 'kb.maintenance.participant.%' AND value=$1 ORDER BY key LIMIT 1000) RETURNING key",
              [`${request}:DRAINED`],
            );
            if (!removed.rows.length) break;
          }
          await client.query("DELETE FROM app_setting WHERE key=$1 AND value=$2", [
            REQUEST,
            request,
          ]);
        }
      } catch {} // A lost DB session cannot prove resumption; retain durable intent.
    }
    await client.end().catch(() => {});
  }
}

/** Atomic machine result, separate from human stdout and the ciphertext marker. */
export async function publishBackupResult(path, result) {
  const temp = `${path}.${randomUUID()}.part`;
  try {
    await writeFile(temp, JSON.stringify(result), { flag: "wx", mode: 0o600 });
    const fd = await openPath(temp);
    try {
      await fd.sync();
    } finally {
      await fd.close();
    }
    await rename(temp, path);
    syncDir(dirname(path));
  } finally {
    await unlink(temp).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
export async function deliverBackup({
  file,
  label = "manual",
  resultFile,
  signal,
  configured = Boolean(process.env.BACKUP_S3_BUCKET),
  connectionString,
  upload,
  heartbeat,
  createdAt = new Date().toISOString(),
}) {
  await verifyEncryptedBundle(file);
  const runId = /\/backup-([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\.age$/.exec(file)?.[1];
  if (
    !isAbsolute(file) ||
    !runId ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(createdAt) ||
    !Number.isFinite(Date.parse(createdAt)) ||
    new Date(createdAt).toISOString() !== createdAt ||
    !["manual", "pre-migrate", "pre-drop", "daily"].includes(label)
  )
    throw new Error("Invalid backup result identity.");
  const result = {
    version: 1,
    runId,
    label,
    createdAt,
    utcDay: createdAt.slice(0, 10),
    bundlePath: file,
    completion: { path: `${file}.complete`, sha256: (await digest(`${file}.complete`)).sha256 },
    upload: { configured, outcome: configured ? "failed" : "local-only" },
  };
  // Keep label/day/delivery beside the immutable pair across scheduler restarts.
  const publish = async () => {
    await publishBackupResult(`${file}.result.json`, result);
    if (resultFile && resultFile !== `${file}.result.json`)
      await publishBackupResult(resultFile, result);
  };
  // Publish the verified pair before networking so a killed upload is retryable.
  signal?.throwIfAborted();
  await publish();
  if (configured) {
    let auditClient;
    try {
      if (connectionString) auditClient = await connect(connectionString);
      upload ??= (await import("../upload-backup-to-s3.mjs")).uploadBackup;
      const remote = await upload({ file, signal });
      if (auditClient) await audit(auditClient, runId, "BACKUP_UPLOAD", "SUCCESS", "UPLOADED");
      result.upload = { ...remote, configured: true, outcome: "uploaded" };
      await publish();
      heartbeat ??= process.env.BACKUP_HEARTBEAT_URL
        ? () =>
            boundedChild(process.execPath, [join(ROOT, "scripts/backup-heartbeat.mjs")], {
              signal,
              timeout: 40_000,
            }).done
        : undefined;
      await heartbeat?.();
    } catch (error) {
      if (auditClient)
        await audit(auditClient, runId, "BACKUP_UPLOAD", "FAILURE", "UNKNOWN").catch(() => {});
      throw error;
    } finally {
      await auditClient?.end().catch(() => {});
    }
  }
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const abort = new AbortController();
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => abort.abort());
  try {
    const env = process.env;
    const input = {
      connectionString: env.DATABASE_URL,
      dataDir: env.KB_DATA_ROOT,
      backupDir: env.BACKUP_DIR,
      recipient: env.BACKUP_AGE_RECIPIENT,
      signal: abort.signal,
    };
    if (process.argv[2] === "snapshot")
      await snapshotOffline({
        ...input,
        schemaDir: env.KB_BACKUP_SCHEMA_DIR,
        runId: env.KB_BACKUP_RUN_ID,
      });
    else {
      const file = await coordinateBackup({ ...input, runId: env.KB_BACKUP_RUN_ID || undefined });
      await deliverBackup({
        file,
        label: process.argv[3] || "manual",
        resultFile: env.BACKUP_RESULT_FILE,
        connectionString: env.DATABASE_URL,
        signal: abort.signal,
      });
      const { pruneCompletedPairs } = await import("../backup/schedule.mjs");
      await pruneCompletedPairs(dirname(file));
      console.log("Backup completed.");
    }
  } catch {
    console.error(
      "FATAL: quiesced backup failed; no partial bundle is valid. Retry offline recovery before restarting if maintenance remains closed.",
    );
    process.exitCode = 1;
  }
}
