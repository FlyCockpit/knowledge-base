import { hkdfSync } from "node:crypto";
import { removeUserAccount } from "@knowledge-base/api/lib/kb/account-removal";
import type { AssetStorageLifecycle } from "@knowledge-base/api/lib/kb/asset-storage-lifecycle";
import { parseAssetStorageMarker } from "@knowledge-base/api/lib/kb/asset-storage-mode";
import { createRuntimeAssetStore } from "@knowledge-base/api/lib/kb/asset-storage-runtime";
import { createCursorSigner } from "@knowledge-base/api/lib/kb/cursor";
import { requireKbMasterKey } from "@knowledge-base/api/lib/kb/envelope";
import {
  configureIndexReader,
  createIndexReaderPool,
  type IndexReaderPool,
} from "@knowledge-base/api/lib/kb/index-file/pool";
import { createRedisRatePort } from "@knowledge-base/api/lib/kb/limits";
import { statfsDiskMeter } from "@knowledge-base/api/lib/kb/quota";
import {
  configureKbRuntime,
  getKbRuntime,
  type KbRuntimeConfig,
} from "@knowledge-base/api/lib/kb/runtime";
import {
  registerAccountRemovalExecutor,
  runWithAllowedAccountDeletion,
} from "@knowledge-base/auth/account-deletion-policy";
import prisma from "@knowledge-base/db";
import { env } from "@knowledge-base/env/server";
import { kbDataPaths } from "@knowledge-base/env/topology";
import { redisConnection } from "@knowledge-base/queue";

import { assertProcessFence } from "./kb-process.js";

import {
  getKbWriteCoordinator,
  gitMutatingExecutor,
  type WriteOperationContext,
} from "./kb-write-coordinator.js";

/**
 * Creates and registers the index reader pool (§1.6). The thread entry is the flat
 * `dist/kb-index-reader.mjs` next to the bundled server, or the `.ts` source under tsx.
 * `lifecycle.ts` starts it (startup fails if a thread's probe fails) and stops it after drain.
 */
export function configureServerIndexReader(): IndexReaderPool {
  const source = import.meta.url.endsWith(".ts");
  const pool = createIndexReaderPool({
    entry: source
      ? new URL("./kb-index-reader.ts", import.meta.url)
      : new URL("./kb-index-reader.mjs", import.meta.url),
    execArgv: source ? ["--import", "tsx"] : [],
    indexDir: kbDataPaths(env.KB_DATA_ROOT).indexDir,
  });
  configureIndexReader(pool);
  return pool;
}

function deriveCursorHmacKey(master: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), "kb/cursor/v1", 32));
}

export async function configureServerKbRuntime(assetStorage: AssetStorageLifecycle): Promise<void> {
  const canonicalOrigin = new URL(env.BETTER_AUTH_URL).origin;
  const cursorSigner = createCursorSigner(
    deriveCursorHmacKey(requireKbMasterKey(env.KB_MASTER_KEY?.reveal())),
  );
  const { reposDir, assetsDir } = kbDataPaths(env.KB_DATA_ROOT);
  const record = await prisma.appSetting.findUnique({
    where: { key: "kb.asset-storage" },
    select: { value: true },
  });
  if (!record) throw new Error("Missing asset storage authority");
  const blobStore = await createRuntimeAssetStore({
    env,
    assetsDir,
    connectionString: env.DATABASE_URL.reveal(),
    marker: parseAssetStorageMarker(record.value),
    lifecycle: assetStorage,
    assertRoleFence: assertProcessFence,
  });
  const config: KbRuntimeConfig = {
    prisma,
    assetStorage,
    connectionString: env.DATABASE_URL.reveal(),
    reposDir,
    assetsDir,
    blobStore,
    canonicalOrigin,
    cursorSigner,
    // Hourly create budget on the shared Redis limiter, failure-closed: the
    // in-memory port never expires its counters and is fixtures-only.
    ratePort: createRedisRatePort(redisConnection),
    diskMeter: statfsDiskMeter(reposDir),
    coordinator: {
      run: (options) => getKbWriteCoordinator().run(options),
    },
    createGitExecutor: (ctx, kbId) => gitMutatingExecutor(ctx as WriteOperationContext, kbId),
  };
  configureKbRuntime(config);
  registerAccountRemovalExecutor(async (userId) => {
    await runWithAllowedAccountDeletion("ordinary", () =>
      removeUserAccount(getKbRuntime(), userId, { actingUserId: userId }),
    );
  });
}
