import { createAssetCache } from "@knowledge-base/api/lib/kb/asset-cache";
import { createAssetStorageLifecycle } from "@knowledge-base/api/lib/kb/asset-storage-lifecycle";
import {
  type AssetCacheBinding,
  createAssetCacheTransactions,
} from "@knowledge-base/api/lib/kb/asset-storage-state";

// Disposable integration child. Its parent owns the directory and waits for exit
// before supplying a replacement role-fence proof. No production fence is forged.
type Start = {
  connectionString: string;
  assetsDir: string;
  binding: AssetCacheBinding;
  role: "SERVER" | "WORKER";
  action: "partial" | "fill" | "pin" | "cleanup";
  hash: string;
  size: number;
  stopAt?: string;
};
const command = await new Promise<Start>((resolve) => process.once("message", resolve));
command.binding.limit = BigInt(command.binding.limit);
const lifecycle = createAssetStorageLifecycle(command.role);
const send = (phase: string) => process.send?.({ phase, epoch: lifecycle.epoch });
const hold = () => new Promise<void>((resolve) => process.once("message", () => resolve()));
const cache = createAssetCache({
  ...command,
  lifecycle,
  transactions: createAssetCacheTransactions(command.connectionString),
  meter: { freeBytes: async () => 100n * 1024n * 1024n * 1024n },
  barrier: async (name) => {
    if (name === command.stopAt) {
      send(name);
      await hold();
    }
  },
});
try {
  await cache.registerOwner(() => {}, Date.now() + 10000);
  if (command.action === "pin") {
    const reader = await cache.open(
      command.hash,
      command.size,
      Date.now() + 60000,
      new AbortController().signal,
    );
    if (!reader) throw new Error("Missing fixture entry");
    await reader.preflight();
    send("pinned");
    await hold();
    await reader.close();
  } else if (command.action === "cleanup") {
    await cache.repair(Date.now() + 60000, command.hash, true);
  } else {
    const fill = await cache.beginFill(command.hash, command.size, Date.now() + 60000);
    if (!fill) {
      send("busy");
      await hold();
    } else {
      const bytes = Buffer.alloc(command.size, 7);
      for (let offset = 0; offset < bytes.length; offset += 256 * 1024)
        fill.write(bytes.subarray(offset, offset + 256 * 1024));
      if (command.action === "partial") {
        send("written");
        await hold();
      } else await fill.complete();
      await fill.close();
    }
  }
  await lifecycle.stop();
  send("done");
  process.disconnect?.();
} catch (error) {
  process.send?.({
    phase: "error",
    message: error instanceof Error ? error.message : "child failed",
  });
  process.exitCode = 1;
  process.disconnect?.();
}
