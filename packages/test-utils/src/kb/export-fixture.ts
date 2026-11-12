/**
 * Shared real Git/CAS/SQL fixture for the export integration files. Importing
 * it creates a fresh database for the importing test file (one per process).
 * `exports-rss.integration.test.ts` runs first in its own process, so
 * no earlier test's heap can skew its RSS bound.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assetCacheBinding, createAssetCache } from "@knowledge-base/api/lib/kb/asset-cache";
import { createAssetPublicationState } from "@knowledge-base/api/lib/kb/asset-publication-state";
import { createAssetStorageLifecycle } from "@knowledge-base/api/lib/kb/asset-storage-lifecycle";
import { createAssetCacheTransactions } from "@knowledge-base/api/lib/kb/asset-storage-state";
import { runLockedOperation } from "@knowledge-base/api/lib/kb/authority-lock";
import { casBlobPath, createDiskBlobStore } from "@knowledge-base/api/lib/kb/blob-store-disk";
import { assetS3Key, createS3BlobStore } from "@knowledge-base/api/lib/kb/blob-store-s3";
import { createCursorSigner } from "@knowledge-base/api/lib/kb/cursor";
import { reclaimExports } from "@knowledge-base/api/lib/kb/exports";
import { kbBareRepoPath } from "@knowledge-base/api/lib/kb/git-read";
import { writeInitialMainCommit, writeStagedObjects } from "@knowledge-base/api/lib/kb/git-write";
import { createMemoryRatePort } from "@knowledge-base/api/lib/kb/limits";
import {
  type AssetManifestEntry,
  canonicalManifestBytes,
} from "@knowledge-base/api/lib/kb/manifest";
import { KB_MANAGED_GITIGNORE } from "@knowledge-base/api/lib/kb/paths";
import { setKbRecoveryComplete } from "@knowledge-base/api/lib/kb/recovery";
import type { KbRuntimeConfig } from "@knowledge-base/api/lib/kb/runtime";
import { readTransfer } from "@knowledge-base/api/lib/kb/transfers";
import { assetS3Locator } from "@knowledge-base/env/asset-storage-config";
import { afterAll, afterEach, expect } from "vitest";
import { openKbPostgresClusterFromEnv } from "./index";
import { createAssetS3Fixture } from "./s3-fixture";

const {
  stageCommitWithTreeFiles,
}: {
  stageCommitWithTreeFiles(input: {
    parentSha: string;
    message: string;
    files: { segments: string[]; content: Buffer }[];
  }): { commitSha: string; objects: Parameters<typeof writeStagedObjects>[1] };
} = await import(
  pathToFileURL(resolve(import.meta.dirname, "../../../api/src/lib/kb/staged-tree.ts")).href
);
const cluster = await openKbPostgresClusterFromEnv();
export const db = await cluster.createDatabase();
db.applyPrismaSchema();
export const prisma = db.createPrismaClient("runtime");
export const root = mkdtempSync(join(tmpdir(), "kb-export-integration-"));
const reposDir = join(root, "repos");
export const assetsDir = join(root, "assets");
mkdirSync(reposDir);
mkdirSync(assetsDir);
export const runtime: KbRuntimeConfig = {
  prisma,
  reposDir,
  assetsDir,
  blobStore: createDiskBlobStore(assetsDir),
  connectionString: db.urls.runtime,
  canonicalOrigin: "https://kb.example.invalid",
  cursorSigner: createCursorSigner(randomBytes(32)),
  ratePort: createMemoryRatePort(),
  diskMeter: { freeBytes: async () => 1n << 40n },
  coordinator: {
    run: (options) =>
      runLockedOperation({
        connectionString: db.urls.runtime,
        opId: options.opId,
        kind: "authority",
        run: (lease) =>
          options.run({
            lease,
            signal: lease.scope.signal,
            issueWriteCapability() {
              throw new Error("read fixture");
            },
          }),
      }),
  },
};
setKbRecoveryComplete(true);
export async function user(): Promise<{ id: string }> {
  return prisma.user.create({
    data: { name: "Export fixture", email: `${randomUUID()}@example.invalid`, emailVerified: true },
    select: { id: true },
  });
}
type ExportBase = Awaited<ReturnType<typeof fixture>>;
export async function fixture() {
  const owner = await user();
  const row = await prisma.knowledgeBase.create({
    data: {
      ownerId: owner.id,
      name: "Export",
      slug: `export-${randomUUID().slice(0, 8)}`,
      description: "Export integration fixture",
      state: "CREATING",
    },
  });
  const rev = await writeInitialMainCommit(
    {
      reposDir,
      kbId: row.id,
      executor: {
        exec: ({ cwd, argv, env }) => {
          execFileSync(argv[0]!, argv.slice(1), { cwd, env, stdio: "ignore" });
        },
      },
    },
    { message: "fixture", description: row.description },
  );
  await prisma.knowledgeBase.update({
    where: { id: row.id },
    data: { state: "ACTIVE", headSha: rev },
  });
  return {
    kbId: row.id,
    rev,
    actor: { principal: { kind: "browser" as const, userId: owner.id } },
  };
}
export async function commit(
  base: ExportBase,
  entries: AssetManifestEntry[],
  markdown = "# Pinned\n",
  publish = true,
) {
  const staged = stageCommitWithTreeFiles({
    parentSha: base.rev,
    message: randomUUID(),
    files: [
      { segments: ["index.md"], content: Buffer.from(markdown) },
      { segments: [".gitignore"], content: Buffer.from(KB_MANAGED_GITIGNORE) },
      {
        segments: [".assets", "manifest.json"],
        content: canonicalManifestBytes({ version: 1, entries }),
      },
    ],
  });
  const repo = kbBareRepoPath(reposDir, base.kbId);
  writeStagedObjects(repo, staged.objects);
  if (publish) {
    writeFileSync(join(repo, "refs/heads/main"), `${staged.commitSha}\n`);
    await prisma.knowledgeBase.update({
      where: { id: base.kbId },
      data: { headSha: staged.commitSha },
    });
  }
  return { ...base, rev: staged.commitSha };
}
export async function asset(base: ExportBase, size = 400000) {
  // Generated trusted catalog fixture: production publication/sniffing is covered by the CAS suite.
  const chunk = Buffer.alloc(64 * 1024, 0x31);
  const hash = createHash("sha256");
  for (let at = 0; at < size; at += chunk.length)
    hash.update(chunk.subarray(0, Math.min(chunk.length, size - at)));
  const digest = `sha256:${hash.digest("hex")}`;
  const path = casBlobPath(assetsDir, digest);
  mkdirSync(dirname(path), { recursive: true });
  const file = await open(path, "w");
  try {
    for (let at = 0; at < size; at += chunk.length)
      await file.write(chunk.subarray(0, Math.min(chunk.length, size - at)));
  } finally {
    await file.close();
  }
  await prisma.assetBlob.upsert({
    where: { hash: digest },
    create: { hash: digest, size, mime: "audio/wav" },
    update: {},
  });
  await prisma.kbAssetLineage.create({
    data: {
      kbId: base.kbId,
      hash: digest,
      source: "UPLOAD",
      actorKey: `user:${base.actor.principal.userId}`,
      actorUserIdSnapshot: base.actor.principal.userId,
    },
  });
  return { path: "media/data.wav", hash: digest, size, mime: "audio/wav" };
}
export const request = (base: ExportBase, kind: "whole" | "assets" = "whole") => ({
  kbId: base.kbId,
  kind,
  idempotencyKey: randomUUID(),
});
export const artifactPath = (id: string) => join(assetsDir, ".private/tmp", `export-${id}`);
export async function frames(base: ExportBase, id: string) {
  const chunks: Buffer[] = [];
  let offset = 0;
  for (;;) {
    const frame = await readTransfer(runtime, base.actor, {
      kbId: base.kbId,
      transferId: id,
      offset,
    });
    chunks.push(Buffer.from(frame.bytesBase64, "base64"));
    offset = frame.nextOffset;
    if (frame.eof) return Buffer.concat(chunks);
  }
}
/** The artifact is gone and its slot and quota are released, in the given terminal state. */
export async function released(id: string, state: "ABORTED" | "DOWNLOADED") {
  const row = await prisma.exportArtifact.findUniqueOrThrow({ where: { id } });
  expect(row.state).toBe(state);
  expect(row.reclaimedAt).not.toBeNull();
  expect(existsSync(artifactPath(id))).toBe(false);
  const reserved = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
    `SELECT count(*) FROM "quota_reservation" WHERE "opId"=$1 AND outcome='RESERVED'`,
    id,
  );
  expect(Number(reserved[0]!.count)).toBe(0);
}
export const clean = (id: string) => released(id, "ABORTED");
export function registerExportHooks(
  options: { cleanAfterEach?: boolean; drainWork?: () => Promise<void> } = {},
) {
  const cleanupTimeout = options.drainWork ? 180_000 : 60_000;
  afterEach(async () => {
    if (options.drainWork) await options.drainWork();
    // The isolated RSS measurement spans preparation, client reads and ZIP
    // verification. Keep its one artifact until those phases finish; the
    // file-scoped database/root cleanup below still runs on any failure.
    if (options.cleanAfterEach === false) return;
    await prisma.exportArtifact.updateMany({
      where: { reclaimedAt: null },
      data: { expiresAt: new Date(0) },
    });
    await reclaimExports(runtime);
  }, cleanupTimeout);
  afterAll(async () => {
    if (options.drainWork) await options.drainWork();
    await prisma.$disconnect();
    await db.close();
    await cluster.close();
    rmSync(root, { recursive: true, force: true });
  }, cleanupTimeout);
}

/** Shared remote source for ZIP, isolated RSS and real Rust CLI fixtures. */
export async function s3Sources(entries: AssetManifestEntry[]) {
  const http = await createAssetS3Fixture();
  const lifecycle = createAssetStorageLifecycle("SERVER");
  try {
    const config = {
      endpoint: http.endpoint,
      bucket: "assets",
      region: "auto",
      prefix: "export",
      forcePathStyle: true,
      credentials: { accessKeyId: "fixture-key", secretAccessKey: "fixture-secret" },
    };
    const cacheDir = join(root, randomUUID());
    mkdirSync(cacheDir);
    const binding = await assetCacheBinding({
      assetsDir: cacheDir,
      storageGeneration: randomUUID(),
      configuration: assetS3Locator(config),
      limit: 26214400n,
    });
    const transactions = createAssetCacheTransactions(db.urls.runtime);
    const cache = createAssetCache({
      assetsDir: cacheDir,
      binding,
      transactions,
      lifecycle,
      meter: runtime.diskMeter,
    });
    await cache.initializeEmpty(() => {});
    await cache.registerOwner(() => {}, Date.now() + 15000);
    const store = createS3BlobStore({
      assetsDir: cacheDir,
      config,
      cache,
      lifecycle,
      publication: createAssetPublicationState({
        binding: { storageGeneration: binding.storageGeneration, locator: assetS3Locator(config) },
        transactions,
      }),
    });
    for (const entry of entries)
      http.objects.set(`/assets/${assetS3Key(config.prefix, entry.hash)}`, {
        bytes: readFileSync(casBlobPath(assetsDir, entry.hash)),
        metadata: {},
      });
    return {
      runtime: { ...runtime, blobStore: store },
      http,
      cache,
      binding,
      close: async () => {
        await lifecycle.stop();
        await http.close();
      },
    };
  } catch (error) {
    await lifecycle.stop();
    await http.close();
    throw error;
  }
}
