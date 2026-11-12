/** Storage authority is independent of credentials, process epochs and cache residency. */
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, open, opendir } from "node:fs/promises";
import { assetS3Locator, normalizeAssetS3Location } from "@knowledge-base/env/asset-storage-config";
import type { LockQuery } from "./lock";

export type AssetStorageSelection = { mode: "disk" } | { mode: "s3"; locator: string };
export type AssetStorageMarker = AssetStorageSelection & { version: 1; activeGeneration: string };
export const ASSET_STORAGE_KEY = "kb.asset-storage";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const invalid = () => new Error("Asset storage mode/location requires offline migration.");

export function assetStorageSelection(env: {
  KB_ASSET_S3_ENABLED?: boolean;
  KB_ASSET_S3_BUCKET?: string;
  KB_ASSET_S3_ENDPOINT?: string;
  KB_ASSET_S3_REGION?: string;
  KB_ASSET_S3_PREFIX?: string;
  KB_ASSET_S3_FORCE_PATH_STYLE?: string;
}): AssetStorageSelection {
  if (!env.KB_ASSET_S3_ENABLED) return { mode: "disk" };
  const pathStyle = env.KB_ASSET_S3_FORCE_PATH_STYLE ?? "false";
  if (!["true", "false"].includes(pathStyle)) throw invalid();
  return {
    mode: "s3",
    locator: assetS3Locator(
      normalizeAssetS3Location({
        bucket: env.KB_ASSET_S3_BUCKET ?? "",
        endpoint: env.KB_ASSET_S3_ENDPOINT || undefined,
        region: env.KB_ASSET_S3_REGION ?? "",
        prefix: env.KB_ASSET_S3_PREFIX ?? "",
        forcePathStyle: pathStyle === "true",
      }),
    ),
  };
}
export function parseAssetStorageMarker(value: string): AssetStorageMarker {
  const r = JSON.parse(value) as AssetStorageMarker;
  if (r?.version !== 1 || !uuid.test(r.activeGeneration)) throw invalid();
  if (r.mode === "disk" && Object.keys(r).sort().join(",") === "activeGeneration,mode,version")
    return r;
  if (
    r.mode !== "s3" ||
    Object.keys(r).sort().join(",") !== "activeGeneration,locator,mode,version"
  )
    throw invalid();
  const l = JSON.parse(r.locator);
  if (assetS3Locator({ ...l, endpoint: l.endpoint ?? undefined }) !== r.locator) throw invalid();
  return r;
}
export function sameAssetStorage(a: AssetStorageSelection, b: AssetStorageSelection) {
  return a.mode === b.mode && (a.mode === "disk" || (b.mode === "s3" && a.locator === b.locator));
}
export function currentAssetObligation(source: AssetStorageMarker) {
  if (source.mode !== "s3") throw invalid();
  return { generation: source.activeGeneration, locator: source.locator };
}
export async function assertNoAssetMigration(query: LockQuery) {
  const control = await query<{ present: string | null }>(
    "SELECT to_regclass('knowledge_base_control.asset_storage_migration') AS present",
  );
  if (
    control.rows[0]?.present &&
    (
      await query(
        "SELECT 1 FROM knowledge_base_control.asset_storage_migration WHERE state<>'READY' LIMIT 1",
      )
    ).rows.length
  )
    throw new Error("Pending asset storage migration requires offline recovery.");
}

/** No inventory allocation: even a malformed entry establishes non-emptiness. */
async function hasDiskObjects(assetsDir: string): Promise<boolean> {
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  const assets = await open(assetsDir, flags);
  try {
    let objects: FileHandle;
    try {
      objects = await open(`/proc/self/fd/${assets.fd}/objects`, flags);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw e;
    }
    try {
      const shards = await opendir(`/proc/self/fd/${objects.fd}`);
      for await (const shard of shards) {
        if (!/^[a-f0-9]{2}$/.test(shard.name) || !shard.isDirectory()) return true;
        const dir = await open(`/proc/self/fd/${objects.fd}/${shard.name}`, flags);
        try {
          const leaves = await opendir(`/proc/self/fd/${dir.fd}`);
          try {
            if (await leaves.read()) return true;
          } finally {
            await leaves.close();
          }
        } finally {
          await dir.close();
        }
      }
      return false;
    } finally {
      await objects.close();
    }
  } finally {
    await assets.close();
  }
}

/** Called with the shared maintenance permit, before ANY startup recovery.
 * Only the fenced server can establish initial authority; workers wait for it.
 */
export async function admitAssetStorage(input: {
  query: LockQuery;
  selection: AssetStorageSelection;
  assetsDir: string;
  role: "SERVER" | "WORKER";
  assertServerFence(): void;
  deadlineAt?: number;
  signal?: AbortSignal;
}): Promise<AssetStorageMarker> {
  const q = input.query;
  if (input.role === "WORKER") {
    const deadline = input.deadlineAt ?? Date.now() + 30000;
    // The worker never makes an unfenced empty-volume observation. Let the
    // native-fenced server establish authority before any worker effects.
    while (
      !(await q("SELECT key FROM app_setting WHERE key=$1", [ASSET_STORAGE_KEY])).rows.length &&
      Date.now() < deadline
    ) {
      input.signal?.throwIfAborted();
      await assertNoAssetMigration(q);
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))),
      );
    }
  }
  input.signal?.throwIfAborted();
  await q("BEGIN");
  try {
    await q("SELECT pg_advisory_xact_lock($1::bigint)", [0x4b424153]);
    await assertNoAssetMigration(q);
    const result = await q<{ value: string }>(
      "SELECT value FROM app_setting WHERE key=$1 FOR UPDATE",
      [ASSET_STORAGE_KEY],
    );
    let marker: AssetStorageMarker;
    if (result.rows[0]) marker = parseAssetStorageMarker(result.rows[0].value);
    else {
      if (input.role !== "SERVER")
        throw new Error("Asset storage initialization requires the fenced server.");
      input.assertServerFence();
      const catalog = await q("SELECT hash FROM asset_blob LIMIT 1");
      const retained = catalog.rows.length > 0 || (await hasDiskObjects(input.assetsDir));
      marker = {
        version: 1,
        activeGeneration: randomUUID(),
        ...(retained ? { mode: "disk" as const } : input.selection),
      };
      // Never persist an inferred S3 marker for retained disk bytes.
      if (!sameAssetStorage(marker, input.selection)) throw invalid();
      await q(
        'INSERT INTO app_setting (key,value,"createdAt","updatedAt") VALUES ($1,$2,now(),now())',
        [ASSET_STORAGE_KEY, JSON.stringify(marker)],
      );
      input.assertServerFence();
    }
    if (!sameAssetStorage(marker, input.selection)) throw invalid();
    input.signal?.throwIfAborted();
    await q("COMMIT");
    return marker;
  } catch (error) {
    await q("ROLLBACK").catch(() => {});
    throw error;
  }
}
