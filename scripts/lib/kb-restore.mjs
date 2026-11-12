/** Offline restore. The control row is durable intent, never a lock substitute. */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, rm, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import {
  captureMigrationHistory,
  finalizeRestoreState,
  validateMigrationHistory,
} from "../db/lib/contracts.mjs";
import {
  prismaSchemaName,
  readApplicationCatalog,
  readMigrationsFolder,
} from "../db/lib/migration-state.mjs";
import { ensureKbDataSkeleton, isSkeletonOnly, kbDataPaths } from "../init-kb-volumes.mjs";
import { applyArchive, prepareArchive } from "../restore-archive.mjs";
import { assertNoStorageMigration } from "./asset-storage-control.mjs";
import { assetStorageDomain, operatorAssetConfig } from "./asset-storage-domain.mjs";
import { boundedChild } from "./bounded-child.mjs";
import {
  assertOfflineFence,
  bundleVersion,
  digest,
  forAssetInventory,
  openPath,
  pathCheck,
  pgEnv,
  syncDir,
  verifyAssetInventory,
  verifyEncryptedBundle,
} from "./kb-backup.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const TABLE = "knowledge_base_control.kb_restore";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
let domain;
async function restoreDomain() {
  if (domain) return domain;
  try {
    domain = await import(join(ROOT, "restore-crypto.mjs"));
  } catch (error) {
    if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
    // Development uses the existing source modules via the pinned TS loader;
    // the offline image bundles these exact modules during its build.
    const require = createRequire(join(ROOT, "package.json"));
    const { tsImport } = await import(require.resolve("tsx/esm/api"));
    const modules = await Promise.all(
      ["envelope", "manifest", "fingerprint"].map((name) =>
        tsImport(join(ROOT, `packages/api/src/lib/kb/${name}.ts`), import.meta.url),
      ),
    );
    domain = Object.assign(
      {},
      ...modules,
      await import(
        createRequire(join(ROOT, "packages/auth/package.json")).resolve("better-auth/crypto")
      ),
    );
  }
  return domain;
}
function fail(code, cause) {
  const error = new Error(code, { cause });
  error.code = code;
  throw error;
}
async function directory(path) {
  const fd = await openPath(path, constants.O_RDONLY | constants.O_DIRECTORY);
  await fd.close();
}
async function parents(root, relative) {
  let parent = await openPath(root, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    for (const name of relative.split("/").slice(0, -1)) {
      const path = `/proc/self/fd/${parent.fd}/${name}`;
      await mkdir(path, { mode: 0o700 }).catch((error) => {
        if (error.code !== "EEXIST") throw error;
      });
      const next = await open(
        path,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      await parent.sync();
      await parent.close();
      parent = next;
    }
    return parent;
  } catch (error) {
    await parent.close();
    throw error;
  }
}
function metadataCheck(metadata, inventory) {
  if (
    metadata?.version !== 3 ||
    !UUID.test(metadata.instanceId) ||
    !/^[1-9][0-9]{0,30}$/.test(metadata.authorityEpoch) ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(metadata.cutoff) ||
    !Array.isArray(metadata.heads) ||
    metadata.heads.length > 100000
  )
    fail("INVALID_RESTORE_METADATA");
  const paths = new Set();
  for (const entry of inventory) {
    pathCheck(entry.path);
    if (
      paths.has(entry.path) ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      !/^[a-f0-9]{64}$/.test(entry.sha256)
    )
      fail("INVALID_RESTORE_INVENTORY");
    paths.add(entry.path);
  }
  for (const path of paths)
    for (const prefix of path
      .split("/")
      .slice(0, -1)
      .map((_, i) =>
        path
          .split("/")
          .slice(0, i + 1)
          .join("/"),
      ))
      if (paths.has(prefix)) fail("INVALID_RESTORE_INVENTORY");
  const ids = new Set();
  for (const kb of metadata.heads) {
    if (
      !/^[a-z0-9]{24,32}$/.test(kb.id) ||
      ids.has(kb.id) ||
      !["ACTIVE", "TOMBSTONED"].includes(kb.state) ||
      (kb.headSha !== null && !/^[a-f0-9]{40}$/.test(kb.headSha))
    )
      fail("INVALID_RESTORE_METADATA");
    ids.add(kb.id);
    if (kb.headSha && !paths.has(`repos/kb_${kb.id}.git/HEAD`))
      fail("Incomplete restore inventory");
  }
  if (
    !paths.has("postgres.dump") ||
    !paths.has("schema/migrations/migration_lock.toml") ||
    !paths.has("schema/migrations/0_init/migration.sql")
  )
    fail("Incomplete restore inventory");
  for (const path of paths)
    if (path.startsWith("repos/") && !ids.has(path.split("/")[1].slice(3, -4)))
      fail("INVALID_RESTORE_INVENTORY");
}

/** SQL surface used by validation, key checks, cache reconciliation and authority
 * reset below. Retiring unrelated application fields/labels must not strand
 * backups. Keep this list and the projection regression tests beside the SQL.
 */
export const RESTORE_SURFACE = {
  columns: {
    app_setting: "key value createdAt updatedAt",
    audit_event: "id createdAt opId action outcome actorKey actorUserIdSnapshot metadata",
    asset_blob: "hash size mime",
    asset_retained_object: "storageGeneration locator hash size state",
    asset_cache_pin: "id incarnation ownerEpoch",
    asset_cache_entry:
      "cacheId hash incarnation size state fillOwner tempName device inode mtimeNs ctimeNs tempDirectory finalDirectory finalAlias cleanupAttempt cleanupOwner quotaReservations lastFetchSequence",
    asset_cache_owner: "epoch cacheId role retired",
    asset_cache_state:
      "id storageGeneration configuration effectiveLimit chargedBytes fetchSequence",
    knowledge_base:
      "id headSha state profileProviderId profileVersion activeGenerationId desiredEpoch indexQuantization",
    operation_intent: "kbId refName phase newRef finishedAt",
    cas_publication: "state",
    branch_owner: "kbId refName",
    kb_asset_lineage: "kbId hash",
    provider_revision:
      "providerId version endpointUrl model dimensions fingerprint ownerSnapshot aadVersion keyVersion ciphertext jobId",
    embedding_provider: "id kind ownerId revokedAt",
    sealed_record: "namespace recordId version ciphertext",
    share_invitation: "requestId inviterUserId emailCiphertext",
    two_factor: "id secret backupCodes",
    mcp_grant: "revokedAt revokeReason",
    mcp_personal_token: "revokedAt",
    oauth_refresh_token: "id revoked rotationReplayResponse rotationReplayExpiresAt",
    oauth_access_token: "id revoked",
    device_approval: "id decision consumedAt",
    session: "id",
    verification: "id",
    device_code: "id",
    jwks: "id",
    oauth_consent: "id",
    oauth_client_assertion: "id",
    generation_lease: "requestId",
    kb_model_volume_lease: "id",
    account: "id accessToken refreshToken idToken",
    kb_remote: "kbId state remoteVersion activeKeyId pendingKeyId",
    kb_deploy_key_version: "id ciphertext state destroyedAt",
    kb_mirror_attempt: "state resultCode finishedAt",
    staged_upload: "state reservedByOpId",
    export_artifact: "state reclaimedAt",
    query_embedding_request: "id state queryCiphertext resultCiphertext",
    index_generation:
      "id kbId epoch commitSha providerId providerVersion fingerprint dimensions documentCount chunkCount jobId state quotaReservationIds",
    durable_job:
      "id updatedAt dedupKey kind desired state cancelledAt attemptEpoch dispatchOwner dispatchClaimUntil workerOwner leaseUntil",
    kb_local_model:
      "id modelId state epoch probeEpoch probeOwner probeLeaseUntil probeMode runtimeIdentity quotaReservationIds bytesDownloaded readyAt jobId",
    kb_qwen_reembed_lease: "id kbId generationId",
    quota_account: "id reserved",
    quota_reservation: "accountId amount outcome releasedAt heldForPublication",
  },
  enums: {
    AssetRetainedStatus: "DURABLE",
    AssetCacheStatus: "FILLING READY INVALID EVICTING",
    AssetStorageRole: "SERVER WORKER",
    KnowledgeBaseState: "ACTIVE TOMBSTONED",
    OperationIntentPhase: "PREPARED COMMITTING FINALIZED",
    CasPublicationState: "PENDING",
    EmbeddingProviderKind: "OPENAI_COMPAT",
    KbRemoteState: "DISCONNECTED",
    DeployKeyState: "DESTROYED",
    MirrorAttemptState: "QUEUED RESERVED CANCELLED",
    StagedUploadState: "WRITING READY ABORTED",
    ExportArtifactState: "WRITING READY ABORTED",
    QueryEmbeddingState: "CANCELLED",
    IndexGenerationState: "SUPERSEDED PURGED FAILED",
    DurableJobState: "PENDING COMPLETE FAILED CANCELLED",
    DurableJobKind: "DOWNLOAD_MODEL INDEX_KB",
    LocalModelState: "DISABLED DOWNLOADING",
    QuotaReservationOutcome: "RESERVED RELEASED",
    AuditOutcome: "SUCCESS FAILURE",
  },
};

/** Match the typed restore surface, including omitted INSERT defaults. */
export function validateRestoreCompatibility(metadata, archived, image) {
  const unsupported = () => fail("RESTORE_UNSUPPORTED_PREFIX_USE_COMPATIBLE_IMAGE");
  validateMigrationHistory(metadata.migrationHistory, archived);
  if (
    metadata.migrationHistory.schema !== "public" ||
    !metadata.migrationHistory.applied.length ||
    !Array.isArray(metadata.sourceCatalog)
  )
    unsupported();
  if (
    archived.some(
      (m, i) =>
        m.name !== image[i]?.name ||
        m.checksum !== image[i]?.checksum ||
        (m.contract?.checksum ?? null) !== (image[i]?.contract?.checksum ?? null),
    )
  )
    unsupported();
  const baseline = image.find((m) => m.name === "0_init");
  if (!baseline || metadata.migrationHistory.applied[0]?.name !== "0_init") unsupported();
  const catalog = new Map();
  for (const row of metadata.sourceCatalog) {
    if (
      !row ||
      typeof row.kind !== "string" ||
      typeof row.identity !== "string" ||
      typeof row.definition !== "string" ||
      catalog.has(`${row.kind}:${row.identity}`)
    )
      unsupported();
    catalog.set(`${row.kind}:${row.identity}`, row.definition);
  }
  const normalizeType = (type) =>
    type
      .replaceAll('"', "")
      .replace(/^public\./, "")
      .toLowerCase()
      .replace(/timestamp(\(\d+\))? with time zone/g, "timestamptz$1")
      .replace(/ without time zone/g, "");
  const expected = new Set();
  const insertTables = new Set([
    "app_setting",
    "audit_event",
    "durable_job",
    "index_generation",
    "asset_retained_object",
  ]);
  const required = new Set(
    Object.entries(RESTORE_SURFACE.columns).flatMap(([table, columns]) =>
      columns.split(" ").map((column) => `${table}.${column}`),
    ),
  );
  for (const table of baseline.sql.matchAll(/CREATE TABLE "([^"\n]+)" \(([\s\S]*?)\n\);/g)) {
    for (const column of table[2].matchAll(/^ {4}"([^"\n]+)" ([^\n]+)$/gm)) {
      const identity = `${table[1]}.${column[1]}`;
      if (!required.has(identity)) continue;
      expected.add(identity);
      const type = column[2].split(/ NOT NULL| DEFAULT|,$/)[0];
      const actual = catalog.get(`column:${identity}`);
      if (!actual) unsupported();
      let definition;
      try {
        definition = JSON.parse(actual);
      } catch {
        unsupported();
      }
      if (
        !Array.isArray(definition) ||
        normalizeType(definition[0]) !== normalizeType(type) ||
        (column[2].includes(" DEFAULT ") && definition[1] && definition[4] === null) ||
        (!column[2].includes(" NOT NULL") &&
          definition[1] &&
          !definition[2] &&
          !definition[3] &&
          definition[4] === null)
      )
        unsupported();
    }
  }
  if (expected.size !== required.size) unsupported();
  for (const [type, labels] of Object.entries(RESTORE_SURFACE.enums)) {
    const actual = catalog.get(`enum:${type}`)?.split(",");
    if (!actual || labels.split(" ").some((label) => !actual.includes(label))) unsupported();
  }
  for (const row of metadata.sourceCatalog.filter((r) => r.kind === "column")) {
    if (!expected.has(row.identity) && insertTables.has(row.identity.split(".")[0])) {
      const [, required, identity, generated, fallback] = JSON.parse(row.definition);
      if (required && !identity && !generated && fallback === null) unsupported();
    }
  }
}

/** pg_dump deliberately omits ownership/ACLs. Compare all application
 * definitions while allowing the destination owner's existing privileges.
 */
export function comparableRestoreCatalog(rows) {
  return rows
    .filter((r) => r.kind !== "schema")
    .map((r) =>
      r.kind === "relation"
        ? {
            ...r,
            definition: JSON.stringify([
              JSON.parse(r.definition)[0],
              null,
              JSON.parse(r.definition)[2],
            ]),
          }
        : r,
    );
}

/** Bounded frames, streaming files, no tar/extraction library or body buffers. */
export async function extractBundle(file, identity, stage, { maxBytes = 2 ** 40, signal } = {}) {
  await directory(stage);
  await verifyEncryptedBundle(file);
  const key = await openPath(identity);
  await key.close();
  const owner = boundedChild("age", ["-d", "-i", identity, file], {
    signal,
    timeout: 3600000,
    stdio: ["ignore", "pipe", "ignore"],
  });
  void owner.done.catch(() => {});
  const iterator = owner.child.stdout[Symbol.asyncIterator]();
  let buffer = Buffer.alloc(0),
    total = 0;
  const more = async () => {
    signal?.throwIfAborted();
    const next = await iterator.next();
    if (next.done) fail("INCOMPLETE_RESTORE_BUNDLE");
    total += next.value.length;
    if (total > maxBytes) fail("RESTORE_BYTE_BUDGET");
    buffer = Buffer.concat([buffer, next.value]);
  };
  const line = async (max = 16 * 1024 * 1024) => {
    while (!buffer.includes(10)) {
      if (buffer.length > max) fail("RESTORE_HEADER_BUDGET");
      await more();
    }
    const end = buffer.indexOf(10);
    if (end > max) fail("RESTORE_HEADER_BUDGET");
    const text = buffer.subarray(0, end).toString("utf8");
    buffer = buffer.subarray(end + 1);
    return text;
  };
  try {
    const magic = await line(32);
    if (["kb/backup/1", "kb/backup/2"].includes(magic))
      fail("RESTORE_PRERELEASE_FORMAT_UNSUPPORTED");
    if (magic !== "kb/backup/3") fail("INVALID_RESTORE_BUNDLE");
    const { metadata, inventory } = JSON.parse(await line());
    if (!Array.isArray(inventory) || inventory.length > 1000000) fail("INVALID_RESTORE_INVENTORY");
    metadataCheck(metadata, inventory);
    if (
      magic !==
      `kb/backup/${await bundleVersion(
        metadata,
        inventory.map((e) => e.path),
      )}`
    )
      fail("INVALID_RESTORE_BUNDLE");
    for (const entry of inventory) {
      const frame = JSON.parse(await line(1024));
      if (frame.path !== entry.path || frame.size !== entry.size) fail("INVALID_RESTORE_FRAME");
      const parent = await parents(stage, entry.path),
        name = entry.path.split("/").at(-1);
      const temp = `/proc/self/fd/${parent.fd}/.${name}.part`;
      const output = await open(
        temp,
        constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
        0o600,
      );
      const hash = createHash("sha256");
      let remaining = entry.size;
      try {
        while (remaining) {
          if (!buffer.length) await more();
          const bytes = buffer.subarray(0, Math.min(remaining, buffer.length));
          hash.update(bytes);
          await output.writeFile(bytes);
          remaining -= bytes.length;
          buffer = buffer.subarray(bytes.length);
        }
        if (hash.digest("hex") !== entry.sha256 || (await line(0)) !== "")
          fail("RESTORE_HASH_MISMATCH");
        if (
          entry.path.startsWith("assets/") &&
          entry.path.slice(15).replace("/", "") !== entry.sha256
        )
          fail("RESTORE_CAS_MISMATCH");
        await output.sync();
        const target = `/proc/self/fd/${parent.fd}/${name}`;
        try {
          await link(temp, target);
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
          const actual = await digest(join(stage, entry.path));
          if (actual.sha256 !== entry.sha256 || actual.size !== entry.size)
            fail("RESTORE_STAGE_CONFLICT");
        }
        await unlink(temp);
        await parent.sync();
      } finally {
        await output.close();
        await parent.close();
      }
    }
    if (JSON.parse(await line(64)).complete !== true || buffer.length)
      fail("INCOMPLETE_RESTORE_BUNDLE");
    if (!(await iterator.next()).done) fail("RESTORE_TRAILING_BYTES");
    await owner.done;
    if (metadata.storage?.mode === "s3")
      await forAssetInventory(join(stage, "asset-inventory.jsonl"), async () => {});
    return { metadata, inventory };
  } finally {
    owner.stop();
    await owner.done.catch(() => {});
  }
}

/** Compare both streams, including extra/missing catalog rows, in bounded pages. */
async function checkCatalogInventory(client, path, target) {
  let page = [],
    cursor = "",
    offset = 0;
  const next = async () => {
    if (offset === page.length) {
      const query = target
        ? 'SELECT hash,size,state::text AS state FROM asset_retained_object WHERE "storageGeneration"=$2::uuid AND locator=$3 AND hash>$1 ORDER BY hash LIMIT 1000'
        : "SELECT hash,size FROM asset_blob WHERE hash>$1 ORDER BY hash LIMIT 1000";
      page = (
        await client.query(query, target ? [cursor, target.generation, target.locator] : [cursor])
      ).rows;
      offset = 0;
    }
    const row = page[offset++];
    if (row) cursor = row.hash;
    return row;
  };
  await forAssetInventory(path, async (expected) => {
    const row = await next();
    if (
      !row ||
      row.hash !== expected.hash ||
      row.size !== expected.size ||
      (target && row.state !== "DURABLE")
    )
      fail("RESTORE_ASSET_INVENTORY_MISMATCH");
  });
  if (await next()) fail("RESTORE_ASSET_INVENTORY_MISMATCH");
}

/** Both native fences prove every imported cache owner dead. No cache bytes are
 * archived/promoted; source retention generations deliberately remain untouched. */
async function reconcileAssetStorage(
  client,
  stage,
  target,
  signal,
  { assetsDir, reposDir, connectionString },
) {
  if (target.mode === "s3") {
    const domain = await assetStorageDomain();
    await domain.drainOfflineAssetCache({
      assetsDir,
      connectionString,
      assertOfflineFences: domain.offlineAssetFenceProof(reposDir),
      discardReady: true,
      signal,
    });
  }
  for (const [table, key] of [
    ["asset_cache_pin", "id"],
    ["asset_cache_entry", "incarnation"],
    ["asset_cache_owner", "epoch"],
    ["asset_cache_state", "id"],
  ]) {
    for (;;) {
      signal?.throwIfAborted();
      const result = await client.query(
        `DELETE FROM ${table} WHERE "${key}" IN (SELECT "${key}" FROM ${table} ORDER BY "${key}" LIMIT 1000) RETURNING "${key}"`,
      );
      if (!result.rows.length) break;
    }
  }
  if (target.mode === "s3") {
    const path = join(stage, "asset-inventory.jsonl");
    let batch = [];
    const flush = async () => {
      if (!batch.length) return;
      signal?.throwIfAborted();
      await client.query(
        `INSERT INTO asset_retained_object ("storageGeneration",locator,hash,size,state)
         SELECT $1::uuid,$2,hash,size,'DURABLE'::"AssetRetainedStatus"
         FROM unnest($3::text[],$4::integer[]) AS refs(hash,size)
         ON CONFLICT ("storageGeneration",locator,hash) DO NOTHING`,
        [target.generation, target.locator, batch.map((r) => r.hash), batch.map((r) => r.size)],
      );
      batch = [];
    };
    await forAssetInventory(path, async (row) => {
      batch.push(row);
      if (batch.length === 1000) await flush();
    });
    await flush();
    await checkCatalogInventory(client, path, target);
  }
}

async function git(repo, args, signal, raw = false) {
  const owner = boundedChild(
    "git",
    ["--git-dir", repo, "-c", "core.hooksPath=/dev/null", ...args],
    {
      signal,
      timeout: 60000,
      stdio: ["ignore", "pipe", "ignore"],
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
    },
  );
  let output = "";
  owner.child.stdout.on("data", (bytes) => {
    output += bytes;
    if (output.length > 64 * 1024 * 1024) owner.stop();
  });
  await owner.done;
  return raw ? output : output.trim();
}
async function validateStore(client, stage, metadata, inventory, signal) {
  const { parseAssetManifest, validateManifestDocument, embeddingFingerprint } =
    await restoreDomain();
  const heads = (
    await client.query('SELECT id,"headSha",state FROM knowledge_base ORDER BY id LIMIT 100001')
  ).rows;
  if (
    JSON.stringify(heads) !==
    JSON.stringify([...metadata.heads].sort((a, b) => a.id.localeCompare(b.id)))
  )
    fail("RESTORE_HEAD_INVENTORY_MISMATCH");
  const pending = await client.query(
    "SELECT 1 FROM operation_intent WHERE phase IN ('PREPARED','COMMITTING') UNION ALL SELECT 1 FROM cas_publication WHERE state='PENDING' LIMIT 1",
  );
  // backup65 only publishes after the complete startup journal sweep. A bundle
  // with an unfinished delta is not a quiesced cutoff and cannot be adopted.
  if (pending.rows.length) fail("RESTORE_JOURNAL_RECOVERY_REQUIRED");
  const files = new Map(inventory.map((entry) => [entry.path, entry]));
  if (
    inventory.some((entry) =>
      /\/(objects\/info\/(alternates|http-alternates)|info\/grafts|shallow)$/.test(entry.path),
    )
  )
    fail("RESTORE_EXTERNAL_OBJECTS");
  if (metadata.storage?.mode === "s3")
    await checkCatalogInventory(client, join(stage, "asset-inventory.jsonl"));
  else {
    let cursor = "";
    for (;;) {
      const page = (
        await client.query(
          "SELECT hash,size FROM asset_blob WHERE hash>$1 ORDER BY hash LIMIT 1000",
          [cursor],
        )
      ).rows;
      if (!page.length) break;
      for (const blob of page) {
        const hex = blob.hash.slice(7);
        if (files.get(`assets/objects/${hex.slice(0, 2)}/${hex.slice(2)}`)?.size !== blob.size)
          fail("RESTORE_HISTORIC_ASSET_MISSING");
      }
      cursor = page.at(-1).hash;
    }
  }
  for (const kb of heads) {
    if (!kb.headSha) {
      if (kb.state !== "TOMBSTONED") fail("RESTORE_JOURNAL_INVALID");
      continue;
    }
    const repo = join(stage, `repos/kb_${kb.id}.git`);
    if (
      (await git(repo, ["symbolic-ref", "HEAD"], signal)) !== "refs/heads/main" ||
      (await git(repo, ["rev-parse", "refs/heads/main"], signal)) !== kb.headSha
    )
      fail("RESTORE_UNEXPLAINED_REF");
    await git(repo, ["fsck", "--full", "--strict", "--no-reflogs"], signal);
    const expected = new Map([["refs/heads/main", kb.headSha]]);
    const branches = (
      await client.query(
        'SELECT "refName" FROM branch_owner WHERE "kbId"=$1 ORDER BY "refName" LIMIT 4097',
        [kb.id],
      )
    ).rows;
    if (branches.length > 4096) fail("RESTORE_REF_BUDGET");
    for (const branch of branches) {
      const row = (
        await client.query(
          'SELECT "newRef" FROM operation_intent WHERE "kbId"=$1 AND "refName"=$2 AND phase=\'FINALIZED\' AND "newRef" IS NOT NULL ORDER BY "finishedAt" DESC LIMIT 1',
          [kb.id, branch.refName],
        )
      ).rows[0];
      if (!row) fail("RESTORE_JOURNAL_INVALID");
      expected.set(branch.refName, row.newRef);
    }
    const refs = (await git(repo, ["for-each-ref", "--format=%(refname) %(objectname)"], signal))
      .split("\n")
      .filter(Boolean);
    if (
      refs.length !== expected.size ||
      refs.some((ref) => {
        const [name, sha] = ref.split(" ");
        return expected.get(name) !== sha;
      })
    )
      fail("RESTORE_UNEXPLAINED_REF");
    const commits = (await git(repo, ["rev-list", "--all"], signal)).split("\n");
    for (const sha of commits) {
      const tree = await git(repo, ["ls-tree", "-r", sha], signal);
      if (tree.split("\n").some((line) => /^(120000|160000) /.test(line)))
        fail("RESTORE_GIT_SYMLINK");
      const bytes = Buffer.from(
        await git(repo, ["show", `${sha}:.assets/manifest.json`], signal, true),
      );
      const manifest = parseAssetManifest(bytes);
      if ("code" in manifest) fail("RESTORE_LINEAGE_INVALID");
      const trustedBlobs = new Map();
      for (const entry of manifest.entries) {
        const allowed = (
          await client.query(
            'SELECT b.size,b.mime FROM kb_asset_lineage l JOIN asset_blob b ON b.hash=l.hash WHERE l."kbId"=$1 AND l.hash=$2',
            [kb.id, entry.hash],
          )
        ).rows[0];
        if (!allowed || allowed.size !== entry.size || allowed.mime !== entry.mime)
          fail("RESTORE_LINEAGE_INVALID");
        trustedBlobs.set(entry.hash, allowed);
      }
      if (
        validateManifestDocument(bytes, {
          trustedBlobs,
          lineageHashes: new Set(trustedBlobs.keys()),
          treePaths: new Map(),
        })
      )
        fail("RESTORE_LINEAGE_INVALID");
    }
  }
  let profileCursor = "";
  for (;;) {
    const profiles = (
      await client.query(
        `SELECT k.id,r."endpointUrl",r.model,r.dimensions,r.fingerprint,p.kind,p."ownerId" FROM knowledge_base k JOIN provider_revision r ON r."providerId"=k."profileProviderId" AND r.version=k."profileVersion" JOIN embedding_provider p ON p.id=r."providerId" WHERE k.id>$1 AND k.state='ACTIVE' ORDER BY k.id LIMIT 100`,
        [profileCursor],
      )
    ).rows;
    if (!profiles.length) break;
    for (const profile of profiles)
      if (
        profile.kind === "OPENAI_COMPAT" &&
        (!profile.ownerId ||
          profile.dimensions < 1 ||
          profile.dimensions > 4096 ||
          embeddingFingerprint(profile) !== profile.fingerprint)
      )
        fail("RESTORE_PROFILE_INVALID");
    profileCursor = profiles.at(-1).id;
  }
}
async function verifyKeys(client, masterKey, authSecret) {
  const { decryptKbSecretBytes, symmetricDecrypt } = await restoreDomain();
  const key = masterKey ? Buffer.from(masterKey, "base64") : null;
  try {
    let cursor = "";
    for (;;) {
      const page = (
        await client.query(
          `SELECT * FROM (
            SELECT 'p:'||"providerId"||':'||version AS cursor,"providerId" AS object,"ownerSnapshot" AS owner,version::text AS revision,"aadVersion","keyVersion",'provider-secret' AS purpose,ciphertext FROM provider_revision WHERE ciphertext IS NOT NULL
            UNION ALL SELECT 's:'||namespace||':'||"recordId","recordId"::text,namespace::text,version::text,1,1,'sealed-literal',ciphertext FROM sealed_record WHERE ciphertext IS NOT NULL
            UNION ALL SELECT 'i:'||"requestId","requestId","inviterUserId",'1',1,1,'share-email',"emailCiphertext" FROM share_invitation
          ) secrets WHERE cursor>$1 ORDER BY cursor LIMIT 100`,
          [cursor],
        )
      ).rows;
      if (!page.length) break;
      for (const row of page) {
        if (key?.length !== 32 || key.toString("base64") !== masterKey || row.keyVersion !== 1)
          fail("RESTORE_MASTER_KEY_REQUIRED");
        try {
          decryptKbSecretBytes(
            JSON.parse(row.ciphertext),
            {
              aadVersion: row.aadVersion,
              purpose: row.purpose,
              userId: row.owner,
              objectId: row.object,
              revision: row.revision,
            },
            key,
          ).fill(0);
        } catch {
          fail("RESTORE_MASTER_KEY_MISMATCH");
        }
      }
      cursor = page.at(-1).cursor;
    }
  } finally {
    key?.fill(0);
  }
  let cursor = "";
  for (;;) {
    const page = (
      await client.query(
        'SELECT id,secret,"backupCodes" FROM two_factor WHERE id>$1 ORDER BY id LIMIT 100',
        [cursor],
      )
    ).rows;
    if (!page.length) break;
    if (!authSecret) fail("RESTORE_AUTH_SECRET_REQUIRED");
    for (const row of page) {
      try {
        await symmetricDecrypt({ key: authSecret, data: row.secret });
        const codes = JSON.parse(
          await symmetricDecrypt({ key: authSecret, data: row.backupCodes }),
        );
        if (!Array.isArray(codes) || codes.some((code) => typeof code !== "string"))
          fail("RESTORE_AUTH_SECRET_MISMATCH");
      } catch {
        fail("RESTORE_AUTH_SECRET_MISMATCH");
      }
    }
    cursor = page.at(-1).id;
  }
}
async function setting(client, key, value) {
  await client.query(
    'INSERT INTO app_setting(key,value,"createdAt","updatedAt") VALUES($1,$2,now(),now()) ON CONFLICT(key) DO UPDATE SET value=$2,"updatedAt"=now()',
    [key, JSON.stringify(value)],
  );
}
async function resetAuthority(client, metadata, attemptId) {
  const epoch = String(BigInt(metadata.authorityEpoch) + 1n);
  await client.query("BEGIN");
  try {
    await client.query(
      'UPDATE mcp_grant SET "revokedAt"=now(),"revokeReason"=\'RESTORE\' WHERE "revokedAt" IS NULL',
    );
    await client.query('UPDATE mcp_personal_token SET "revokedAt"=now() WHERE "revokedAt" IS NULL');
    await client.query(
      'UPDATE oauth_refresh_token SET revoked=COALESCE(revoked,now()),"rotationReplayResponse"=NULL,"rotationReplayExpiresAt"=NULL WHERE id IS NOT NULL',
    );
    await client.query(
      "UPDATE oauth_access_token SET revoked=COALESCE(revoked,now()) WHERE id IS NOT NULL",
    );
    await client.query(
      'UPDATE device_approval SET decision=\'denied\',"consumedAt"=COALESCE("consumedAt",now()) WHERE id IS NOT NULL',
    );
    for (const table of [
      "session",
      "verification",
      "device_code",
      "jwks",
      "oauth_consent",
      "oauth_client_assertion",
      "generation_lease",
      "kb_model_volume_lease",
    ])
      await client.query(
        `DELETE FROM ${table} WHERE id IS NOT NULL`.replace(
          "generation_lease WHERE id",
          'generation_lease WHERE "requestId"',
        ),
      );
    await client.query(
      'UPDATE account SET "accessToken"=NULL,"refreshToken"=NULL,"idToken"=NULL WHERE id IS NOT NULL',
    );
    await client.query(
      'UPDATE kb_remote SET state=\'DISCONNECTED\',"remoteVersion"="remoteVersion"+1,"activeKeyId"=NULL,"pendingKeyId"=NULL WHERE "kbId" IS NOT NULL',
    );
    await client.query(
      'UPDATE kb_deploy_key_version SET ciphertext=NULL,state=\'DESTROYED\',"destroyedAt"=COALESCE("destroyedAt",now()) WHERE id IS NOT NULL',
    );
    await client.query(
      "UPDATE kb_mirror_attempt SET state='CANCELLED',\"resultCode\"='RESTORE',\"finishedAt\"=now() WHERE state IN ('QUEUED','RESERVED')",
    );
    await client.query(
      "UPDATE staged_upload SET state='ABORTED',\"reservedByOpId\"=NULL WHERE state IN ('WRITING','READY')",
    );
    await client.query(
      "UPDATE export_artifact SET state='ABORTED',\"reclaimedAt\"=now() WHERE state IN ('WRITING','READY')",
    );
    await client.query(
      'UPDATE query_embedding_request SET state=\'CANCELLED\',"queryCiphertext"=NULL,"resultCiphertext"=NULL WHERE id IS NOT NULL',
    );
    // Restored generations never keep build reservations (guards I1/I2); the ledger itself is
    // released in bulk below.
    await client.query(
      'UPDATE index_generation SET "quotaReservationIds"=\'{}\' WHERE cardinality("quotaReservationIds") > 0',
    );
    await client.query(
      'UPDATE durable_job SET state=\'CANCELLED\',"cancelledAt"=now(),"attemptEpoch"="attemptEpoch"+1,"dispatchOwner"=NULL,"dispatchClaimUntil"=NULL,"workerOwner"=NULL,"leaseUntil"=NULL WHERE state NOT IN (\'COMPLETE\',\'FAILED\',\'CANCELLED\')',
    );
    await client.query(
      'UPDATE knowledge_base SET "activeGenerationId"=NULL,"desiredEpoch"="desiredEpoch"+1 WHERE id IS NOT NULL',
    );
    await client.query(
      "UPDATE index_generation SET state='SUPERSEDED' WHERE state NOT IN ('SUPERSEDED','PURGED','FAILED')",
    );
    const models = (
      await client.query(
        `UPDATE kb_local_model SET state=CASE WHEN state='DISABLED' THEN 'DISABLED'::"LocalModelState" ELSE 'DOWNLOADING'::"LocalModelState" END,epoch=epoch+1,"probeEpoch"="probeEpoch"+1,"probeOwner"=NULL,"probeLeaseUntil"=NULL,"probeMode"=NULL,"runtimeIdentity"=NULL,"quotaReservationIds"='{}',"bytesDownloaded"=0,"readyAt"=NULL,"jobId"=NULL WHERE id IS NOT NULL RETURNING id,"modelId",state,epoch`,
      )
    ).rows;
    for (const model of models) {
      if (model.state === "DISABLED") continue;
      const job = randomUUID();
      await client.query(
        `INSERT INTO durable_job(id,"updatedAt","dedupKey",kind,desired,state) VALUES($1,now(),$2,'DOWNLOAD_MODEL',$3::jsonb,'PENDING')`,
        [
          job,
          `model-download:${model.id}:${model.epoch}`,
          JSON.stringify({ modelId: model.modelId, epoch: model.epoch }),
        ],
      );
      await client.query('UPDATE kb_local_model SET "jobId"=$2 WHERE id=$1', [model.id, job]);
    }
    await client.query(
      'UPDATE kb_qwen_reembed_lease SET "kbId"=NULL,"generationId"=NULL WHERE id IS NOT NULL',
    );
    await client.query(
      "UPDATE quota_account a SET reserved=reserved-COALESCE((SELECT sum(amount) FROM quota_reservation r WHERE r.\"accountId\"=a.id AND outcome='RESERVED'),0) WHERE id IS NOT NULL",
    );
    await client.query(
      "UPDATE quota_reservation SET outcome='RELEASED',\"releasedAt\"=now(),\"heldForPublication\"=false WHERE outcome='RESERVED'",
    );
    const kbs = (
      await client.query(
        `SELECT k.id,k."headSha",k."desiredEpoch"::text AS epoch,lower(k."indexQuantization"::text) AS quantization,r."providerId",r.version,r.dimensions,r.fingerprint,p."ownerId",p.kind FROM knowledge_base k JOIN provider_revision r ON r."providerId"=k."profileProviderId" AND r.version=k."profileVersion" JOIN embedding_provider p ON p.id=r."providerId" JOIN durable_job j ON j.id=r."jobId" WHERE k.state='ACTIVE' AND p."revokedAt" IS NULL AND p.kind='OPENAI_COMPAT' AND r.ciphertext IS NOT NULL AND j.state='COMPLETE' ORDER BY k.id LIMIT 100001`,
      )
    ).rows;
    if (kbs.length > 100000) fail("RESTORE_PROFILE_BUDGET");
    for (const kb of kbs) {
      const generationId = `g${randomUUID().replaceAll("-", "").slice(0, 23)}`,
        jobId = randomUUID();
      const desired = {
        generationId,
        kbId: kb.id,
        epoch: kb.epoch,
        commitSha: kb.headSha,
        providerId: kb.providerId,
        revision: kb.version,
        ownerId: kb.ownerId,
        dimensions: kb.dimensions,
        fingerprint: kb.fingerprint,
        quantization: kb.quantization,
      };
      await client.query(
        "INSERT INTO durable_job(id,\"updatedAt\",\"dedupKey\",kind,desired,state) VALUES($1,now(),$2,'INDEX_KB',$3::jsonb,'PENDING')",
        [jobId, `index:${kb.id}:${kb.epoch}`, JSON.stringify(desired)],
      );
      await client.query(
        'INSERT INTO index_generation(id,"kbId",epoch,"commitSha","providerId","providerVersion",fingerprint,dimensions,"documentCount","chunkCount","jobId") VALUES($1,$2,$3,$4,$5,$6,$7,$8,0,0,$9)',
        [
          generationId,
          kb.id,
          kb.epoch,
          kb.headSha,
          kb.providerId,
          kb.version,
          kb.fingerprint,
          kb.dimensions,
          jobId,
        ],
      );
    }
    await setting(client, "kb.instance.identity", {
      instanceId: metadata.instanceId,
      authorityEpoch: epoch,
    });
    await setting(client, "kb.maintenance.request", { restore: attemptId });
    await client.query(`UPDATE ${TABLE} SET state='RESET',epoch=$1 WHERE singleton`, [epoch]);
    await client.query("COMMIT");
    return epoch;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}
async function promote(stage, inventory, reposDir, assetsDir, signal) {
  for (const entry of inventory.filter((entry) => /^(repos|assets)\//.test(entry.path))) {
    signal?.throwIfAborted();
    const [surface, ...parts] = entry.path.split("/");
    const root = surface === "repos" ? reposDir : assetsDir,
      parent = await parents(root, parts.join("/"));
    const target = `/proc/self/fd/${parent.fd}/${parts.at(-1)}`,
      temp = `${target}.restore-part`;
    try {
      let present;
      try {
        present = await digest(join(root, ...parts));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (present) {
        if (present.sha256 !== entry.sha256 || present.size !== entry.size)
          fail("RESTORE_PROMOTION_CONFLICT");
        // Crash between hard-link publication and unlink leaves this attempt's
        // temporary name. Its target is verified; remove only the owned name.
        await unlink(temp).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
        await parent.sync();
        continue;
      }
      const source = await openPath(join(stage, entry.path)),
        output = await open(
          temp,
          constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
          0o600,
        );
      try {
        for await (const bytes of source.createReadStream({ autoClose: false })) {
          signal?.throwIfAborted();
          await output.writeFile(bytes);
        }
        await output.sync();
      } finally {
        await source.close();
        await output.close();
      }
      await link(temp, target);
      await unlink(temp);
      await parent.sync();
    } finally {
      await parent.close();
    }
  }
}

async function verifyPromotion(inventory, reposDir, assetsDir, signal) {
  for (const entry of inventory.filter((entry) => /^(repos|assets)\//.test(entry.path))) {
    signal?.throwIfAborted();
    const [surface, ...parts] = entry.path.split("/");
    const actual = await digest(join(surface === "repos" ? reposDir : assetsDir, ...parts));
    if (actual.size !== entry.size || actual.sha256 !== entry.sha256)
      fail("RESTORE_PROMOTION_CONFLICT");
  }
}

/** Called under --restore native role; all PG clients/children drain before it exits.
 * Lock order: native fences -> runner -> request -> maintenance -> DADP -> Prisma.
 * No app participates: a nonblocking acquisition refuses an active deployment.
 */
export async function restoreOffline({
  file,
  identity,
  attemptId,
  connectionString,
  dataDir,
  masterKey,
  authSecret,
  assetSourceRemap = false,
  signal,
  barrier = async () => {},
}) {
  if (prismaSchemaName(connectionString) !== "public") fail("RESTORE_UNSUPPORTED_TARGET_SCHEMA");
  // Whole-volume contract: one existing, node-writable data root that is empty
  // or skeleton-only. Refuse a missing/relative root before any IO.
  if (typeof dataDir !== "string" || !isAbsolute(dataDir)) fail("RESTORE_DATA_ROOT_REQUIRED");
  const { reposDir, assetsDir } = kbDataPaths(dataDir);
  await assertOfflineFence(reposDir);
  if (!UUID.test(attemptId)) fail("INVALID_RESTORE_ATTEMPT");
  const source = await verifyEncryptedBundle(file);
  const client = new Client({
    connectionString,
    application_name: "kb-offline-restore",
    connectionTimeoutMillis: 5000,
    statement_timeout: 120000,
  });
  // Keep lock ownership until every archive/Git child has drained on cancellation.
  client.on("error", () => {});
  let step = "FENCE";
  const stage = join(reposDir, `.private/restore-${attemptId}`);
  try {
    signal?.throwIfAborted();
    await client.connect();
    for (const lock of [72707370, 0x4b424d52, 0x4b424d41, 1145389648, 72707369])
      if (
        !(await client.query("SELECT pg_try_advisory_lock($1::bigint) AS held", [lock])).rows[0]
          ?.held
      )
        fail("RESTORE_MAINTENANCE_BUSY");
    if (
      (
        await client.query(
          "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() LIMIT 1",
        )
      ).rows.length
    )
      fail("RESTORE_ACTIVE_CONNECTIONS");
    ensureKbDataSkeleton(dataDir);
    await assertNoStorageMigration(client);
    await client.query(
      `CREATE SCHEMA IF NOT EXISTS knowledge_base_control; CREATE TABLE IF NOT EXISTS ${TABLE}(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),attempt_id uuid NOT NULL,source_hash text NOT NULL,state text NOT NULL,epoch text,inventory jsonb); GRANT USAGE ON SCHEMA knowledge_base_control TO PUBLIC; GRANT SELECT ON ${TABLE} TO PUBLIC;`,
    );
    await client.query(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS asset_target jsonb`);
    let attempt = (await client.query(`SELECT * FROM ${TABLE} WHERE singleton`)).rows[0];
    if (attempt && (attempt.attempt_id !== attemptId || attempt.source_hash !== source.sha256))
      fail("RESTORE_ATTEMPT_CONFLICT");
    if (!attempt) {
      const occupied = (
        await client.query(
          "SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' UNION ALL SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' UNION ALL SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' UNION ALL SELECT 1 FROM pg_namespace WHERE nspname NOT IN ('public','information_schema','knowledge_base_control') AND nspname !~ '^pg_' UNION ALL SELECT 1 FROM pg_extension WHERE extname<>'plpgsql' LIMIT 1",
        )
      ).rows;
      if (occupied.length || !isSkeletonOnly(dataDir)) fail("RESTORE_EMPTY_TARGET_REQUIRED");
      await client.query(
        `INSERT INTO ${TABLE}(attempt_id,source_hash,state) VALUES($1,$2,'STAGING')`,
        [attemptId, source.sha256],
      );
      attempt = { state: "STAGING" };
    }
    if (attempt.state === "READY") {
      // Re-entry must close durable admission BEFORE checking that the mounted
      // volumes still contain the promoted inventory. A failed check cannot
      // leave READY admitting a missing/replaced volume.
      await client.query(`UPDATE ${TABLE} SET state='PROMOTING' WHERE singleton`);
      attempt.state = "PROMOTING";
      if (!Array.isArray(attempt.inventory)) fail("RESTORE_INVENTORY_MISSING");
      await verifyPromotion(attempt.inventory, reposDir, assetsDir, signal);
    }
    await mkdir(stage, { mode: 0o700 }).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
    syncDir(dirname(stage));
    step = "EXTRACT";
    const assetConfig = await operatorAssetConfig();
    const { metadata, inventory } = await extractBundle(file, identity, stage, { signal });
    const mode = metadata.storage?.mode === "s3" ? "s3" : "disk";
    if (mode !== assetConfig.mode || (assetSourceRemap && mode !== "s3"))
      fail("RESTORE_ASSET_MODE_MISMATCH");
    if (mode === "s3" && metadata.storage.locator !== assetConfig.locator && !assetSourceRemap)
      fail("RESTORE_ASSET_REMAP_REQUIRED");
    const binding = {
      mode,
      locator: mode === "s3" ? assetConfig.locator : null,
      sourceLocator: metadata.storage?.locator ?? null,
      inventoryDigest: inventory.find((e) => e.path === "asset-inventory.jsonl")?.sha256 ?? null,
      remap: assetSourceRemap,
    };
    if (attempt.asset_target) {
      const { generation: _, ...prior } = attempt.asset_target;
      if (
        Object.keys(binding).some((key) => prior[key] !== binding[key]) ||
        Object.keys(prior).length !== Object.keys(binding).length
      )
        fail("RESTORE_ASSET_TARGET_CONFLICT");
    } else {
      if (attempt.state !== "STAGING") fail("RESTORE_ASSET_TARGET_MISSING");
      attempt.asset_target = { ...binding, generation: randomUUID() };
      await client.query(`UPDATE ${TABLE} SET asset_target=$1::jsonb WHERE singleton`, [
        JSON.stringify(attempt.asset_target),
      ]);
    }
    const target = attempt.asset_target;
    if (mode === "s3")
      await verifyAssetInventory(join(stage, "asset-inventory.jsonl"), assetConfig, signal);

    await client.query(`UPDATE ${TABLE} SET inventory=$1::jsonb WHERE singleton`, [
      JSON.stringify(inventory),
    ]);
    const archived = readMigrationsFolder(join(stage, "schema/migrations"));
    validateRestoreCompatibility(
      metadata,
      archived,
      readMigrationsFolder(join(ROOT, "packages/db/prisma/migrations")),
    );
    step = "IMPORT";
    if (attempt.state === "STAGING") {
      await prepareArchive(join(stage, "postgres.dump"), join(stage, "restore.sql"), {
        env: pgEnv(connectionString),
        signal,
      });
      await client.query(`UPDATE ${TABLE} SET state='IMPORTING' WHERE singleton`);
      attempt.state = "IMPORTING";
    }
    if (attempt.state === "IMPORTING") {
      if (!(await client.query("SELECT to_regclass('public.user') AS present")).rows[0]?.present)
        await applyArchive(join(stage, "restore.sql"), { env: pgEnv(connectionString), signal });
      await client.query(`UPDATE ${TABLE} SET state='IMPORTED' WHERE singleton`);
      attempt.state = "IMPORTED";
      await barrier("imported");
    }
    step = "SCHEMA";
    const restoredHistory = await captureMigrationHistory(client, {
      schema: metadata.migrationHistory.schema,
      migrations: archived,
    });
    if (JSON.stringify(restoredHistory) !== JSON.stringify(metadata.migrationHistory))
      fail("RESTORE_MIGRATION_HISTORY_MISMATCH");
    if (
      JSON.stringify(
        comparableRestoreCatalog(
          await readApplicationCatalog(client, metadata.migrationHistory.schema),
        ),
      ) !== JSON.stringify(comparableRestoreCatalog(metadata.sourceCatalog))
    )
      fail("RESTORE_SOURCE_CATALOG_MISMATCH");
    step = "JOURNAL";
    const sourceIdentity = JSON.parse(
      (await client.query("SELECT value FROM app_setting WHERE key='kb.instance.identity'")).rows[0]
        ?.value ?? "null",
    );
    const expectedEpoch =
      attempt.state === "IMPORTED"
        ? metadata.authorityEpoch
        : String(BigInt(metadata.authorityEpoch) + 1n);
    if (
      sourceIdentity?.instanceId !== metadata.instanceId ||
      sourceIdentity.authorityEpoch !== expectedEpoch
    )
      fail("RESTORE_IDENTITY_MISMATCH");
    if (attempt.state === "IMPORTED") {
      const recorded = JSON.parse(
        (await client.query("SELECT value FROM app_setting WHERE key='kb.asset-storage'")).rows[0]
          ?.value ?? "null",
      );
      if (
        (recorded?.mode ?? "disk") !== mode ||
        (mode === "s3" &&
          (recorded?.version !== 1 || recorded.locator !== metadata.storage.locator))
      )
        fail("RESTORE_ASSET_SOURCE_MISMATCH");
    }
    await validateStore(client, stage, metadata, inventory, signal);
    step = "KEYS";
    await verifyKeys(client, masterKey, authSecret);
    step = "RESET";
    if (attempt.state === "IMPORTED") {
      attempt.epoch = await resetAuthority(client, metadata, attemptId);
      attempt.state = "RESET";
      await barrier("reset");
    }
    await reconcileAssetStorage(client, stage, target, signal, {
      assetsDir,
      reposDir,
      connectionString,
    });
    await barrier("asset-reconciled");
    await client.query(`UPDATE ${TABLE} SET state='PROMOTING' WHERE singleton`);
    await barrier("promoting");
    step = "PROMOTION";
    await promote(stage, inventory, reposDir, assetsDir, signal);
    await barrier("promoted");
    await verifyPromotion(inventory, reposDir, assetsDir, signal);
    if (mode === "s3") {
      await checkCatalogInventory(client, join(stage, "asset-inventory.jsonl"));
      await verifyAssetInventory(join(stage, "asset-inventory.jsonl"), assetConfig, signal);
      await checkCatalogInventory(client, join(stage, "asset-inventory.jsonl"), target);
    }
    signal?.throwIfAborted();
    await barrier("asset-ready");
    await client.query("BEGIN");
    try {
      await finalizeRestoreState(client, { schema: prismaSchemaName(connectionString) });
      await client.query(
        "DELETE FROM app_setting WHERE key='kb.maintenance.request' OR key LIKE 'kb.maintenance.participant.%'",
      );
      await setting(client, "kb.asset-storage", {
        version: 1,
        mode,
        activeGeneration: target.generation,
        ...(mode === "s3" ? { locator: target.locator } : {}),
      });
      await client.query(`UPDATE ${TABLE} SET state='READY' WHERE singleton`);
      await client.query(
        `INSERT INTO audit_event(id,"opId",action,outcome,"actorKey","actorUserIdSnapshot",revision,metadata) VALUES($1,$2,'RESTORE_RESULT','SUCCESS','system:restore','system:restore',$3,$4::jsonb) ON CONFLICT("opId",action,outcome) DO NOTHING`,
        [
          randomUUID().replaceAll("-", "").slice(0, 24),
          attemptId,
          metadata.cutoff,
          JSON.stringify({
            requestId: attemptId,
            reasonCode: "AUTHORITY_RESET",
            epoch: attempt.epoch,
            assetTarget: { ...binding, generation: target.generation },
          }),
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    }
    await rm(stage, { recursive: true });
    syncDir(dirname(stage));
    return { epoch: attempt.epoch };
  } catch (error) {
    if (error.code?.startsWith("RESTORE_") || error.code?.startsWith("INVALID_RESTORE"))
      throw error;
    fail(
      `RESTORE_FAILED_${step}${/^[0-9A-Z]{5}$/.test(error.code ?? "") ? `_${error.code}` : ""}`,
      error,
    );
  } finally {
    await client.end().catch(() => {});
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  for (const name of ["SIGTERM", "SIGINT", "SIGHUP"]) process.once(name, () => controller.abort());
  try {
    const [file, identity, attemptId, ...flags] = process.argv.slice(2);
    if (flags.length > 1 || flags.some((flag) => flag !== "--asset-source-remap"))
      fail("RESTORE_INVALID_ARGUMENTS");
    await restoreOffline({
      file,
      identity,
      attemptId,
      connectionString: process.env.DATABASE_URL,
      dataDir: process.env.KB_DATA_ROOT,
      masterKey: process.env.KB_MASTER_KEY,
      authSecret: process.env.BETTER_AUTH_SECRET,
      assetSourceRemap: flags.includes("--asset-source-remap"),
      signal: controller.signal,
    });
    console.log("Restore complete. Use a fresh login; restored credentials are revoked.");
  } catch (error) {
    console.error(
      `FATAL: ${error.code?.startsWith("RESTORE_") ? error.code : "RESTORE_FAILED"}; keep staging for diagnosis and retry the same attempt offline.`,
    );
    process.exitCode = 1;
  }
}
