import { describe, expect, it, vi } from "vitest";
import { createAssetCacheTouch, createAssetStorageLifecycle } from "./asset-storage-lifecycle";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("asset byte ownership and advisory recency", () => {
  it("closes admission on parent cancellation and joins in-flight startup before acknowledging stop", async () => {
    const parent = new AbortController();
    const life = createAssetStorageLifecycle("WORKER", parent.signal);
    const entered = deferred();
    const drained = deferred();
    const starting = life.track(async () => {
      entered.resolve();
      await drained.promise;
      life.signal.throwIfAborted();
    });
    const rejected = expect(starting).rejects.toThrow("Parent stopped");
    await entered.promise;
    parent.abort(new Error("Parent stopped"));
    expect(life.signal.aborted).toBe(true);
    expect(() => life.track(async () => {})).toThrow("Parent stopped");
    let stopped = false;
    const stopping = life.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    drained.resolve();
    await rejected;
    await stopping;
  });
  it("refuses startup with an already-cancelled parent", async () => {
    const life = createAssetStorageLifecycle("SERVER", AbortSignal.abort(new Error("Cancelled")));
    expect(() => life.track(async () => {})).toThrow("Cancelled");
    await life.stop();
  });
  it("samples at most one outstanding query and stops accepting on close", async () => {
    const life = createAssetStorageLifecycle("SERVER");
    const pending = deferred();
    const query = vi.fn(() => pending.promise);
    const touch = createAssetCacheTouch(life, query);
    touch.sample();
    touch.sample();
    touch.sample();
    await Promise.resolve();
    expect(query).toHaveBeenCalledTimes(1);
    touch.stop();
    pending.resolve();
    await life.stop();
    touch.sample();
    expect(query).toHaveBeenCalledTimes(1);
  });
  it("closes byte ownership while recency remains unresolved", async () => {
    const life = createAssetStorageLifecycle("SERVER");
    const pending = deferred();
    const released = deferred();
    life.own(async () => released.resolve());
    const touch = createAssetCacheTouch(life, () => pending.promise);
    touch.sample();
    const stop = life.stop();
    await released.promise; // Pin release is not behind touch completion.
    pending.resolve();
    await stop;
  });
  it("swallows synchronous and asynchronous helper failures", async () => {
    const life = createAssetStorageLifecycle("SERVER");
    const touch = createAssetCacheTouch(life, () => {
      throw new Error("SQL failed");
    });
    expect(() => touch.sample()).not.toThrow();
    await Promise.resolve();
    await life.stop();
  });
  it("drops samples that have not started when a reader closes", async () => {
    const life = createAssetStorageLifecycle("SERVER");
    const query = vi.fn(async () => {});
    const touch = createAssetCacheTouch(life, query);
    touch.sample();
    touch.stop();
    await life.stop();
    expect(query).not.toHaveBeenCalled();
  });
  it("withholds shutdown acknowledgement after an uncertain cleanup close", async () => {
    const life = createAssetStorageLifecycle("SERVER");
    life.failOwnership();
    await expect(life.stop()).rejects.toThrow("ownership did not drain");
  });
  it("does not acknowledge a failed byte close", async () => {
    const life = createAssetStorageLifecycle("WORKER");
    life.own(async () => {
      throw new Error("close failed");
    });
    await expect(life.stop()).rejects.toThrow("ownership did not drain");
  });
  it("has one immutable role epoch, with no expiration/reclamation on attachment", async () => {
    const a = createAssetStorageLifecycle("SERVER");
    const b = createAssetStorageLifecycle("WORKER");
    expect(a.epoch).not.toBe(b.epoch);
    expect(a.role).toBe("SERVER");
    const recover = vi.fn(async () => {});
    a.registerRecovery(recover);
    expect(recover).not.toHaveBeenCalled();
    await a.recover();
    expect(recover).toHaveBeenCalledTimes(1);
    await a.stop();
    await b.stop();
  });
});
