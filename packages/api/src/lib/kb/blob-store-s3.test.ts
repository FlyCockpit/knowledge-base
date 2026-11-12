import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { assetS3Locator } from "@knowledge-base/env/asset-storage-config";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockDeep } from "vitest-mock-extended";
import type { AssetCache } from "./asset-cache";
import type { AssetPublicationState } from "./asset-publication-state";
import { createAssetStorageLifecycle } from "./asset-storage-lifecycle";
import { assetS3Key, createS3BlobStore } from "./blob-store-s3";
import { minimalPng, sha256Buffer } from "./fixtures/media-bytes";

const sdk = vi.hoisted(() => ({ send: vi.fn(), destroy: vi.fn(), config: vi.fn() }));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    constructor(config: unknown) {
      sdk.config(config);
    }
    send = sdk.send;
    destroy = sdk.destroy;
  },
  HeadObjectCommand: class {
    constructor(readonly input: unknown) {}
  },
  PutObjectCommand: class {
    constructor(readonly input: unknown) {}
  },
  GetObjectCommand: class {
    constructor(readonly input: unknown) {}
  },
}));
const roots: string[] = [];
const lives: ReturnType<typeof createAssetStorageLifecycle>[] = [];
afterEach(async () => {
  await Promise.all(lives.splice(0).map((l) => l.stop()));
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  vi.clearAllMocks();
});
const bytes = minimalPng(),
  hash = sha256Buffer(bytes);
const metadata = {
  ContentLength: bytes.length,
  Metadata: { sha256: hash.slice(7), size: String(bytes.length) },
};
const missing = () => Object.assign(new Error("missing"), { $metadata: { httpStatusCode: 404 } });
function fixture() {
  const assetsDir = mkdtempSync(join(tmpdir(), "kb-s3-unit-"));
  roots.push(assetsDir);
  const lifecycle = createAssetStorageLifecycle("SERVER");
  lives.push(lifecycle);
  const config = {
    bucket: "kb-assets",
    region: "auto",
    prefix: "instance",
    forcePathStyle: true,
    credentials: { accessKeyId: "fixture-key", secretAccessKey: "fixture-secret" },
  };
  const publication: AssetPublicationState = {
    scope: "active",
    binding: { storageGeneration: "test-generation", locator: assetS3Locator(config) },
    pending: vi.fn(async () => {}),
    durable: vi.fn(async () => {}),
  };
  const cache = mockDeep<AssetCache>();
  cache.state.binding.storageGeneration = publication.binding.storageGeneration;
  cache.state.binding.limit = 26214400n;
  cache.open.mockResolvedValue(undefined);
  const fill = {
    incarnation: "fill",
    write: vi.fn(),
    complete: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    sampleDownload: vi.fn(),
  };
  cache.beginFill.mockResolvedValue(fill);
  const store = createS3BlobStore({ assetsDir, config, publication, cache, lifecycle });
  const publish = (extra: Partial<Parameters<typeof store.publishVerified>[0]> = {}) =>
    store.publishVerified({
      declaredHash: hash,
      declaredSize: bytes.length,
      declaredMime: "image/png",
      bytes,
      ...extra,
    });
  return { store, publish, publication, cache, fill, assetsDir, lifecycle };
}
describe("S3 publication", () => {
  it("validates/sniffs before any remote write and does not leave scratch", async () => {
    const f = fixture();
    await expect(f.publish({ declaredMime: "text/html" })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    expect(sdk.send).not.toHaveBeenCalled();
    expect(f.publication.pending).not.toHaveBeenCalled();
    expect(readdirSync(join(f.assetsDir, ".private", "tmp"))).toEqual([]);
  });
  it("persists PENDING before PUT, verifies confirmation before DURABLE and cache, drains pins", async () => {
    const f = fixture();
    let exists = false;
    sdk.send.mockImplementation(async (command: unknown) => {
      if (command instanceof HeadObjectCommand) {
        if (!exists) throw missing();
        return metadata;
      }
      expect(command).toBeInstanceOf(PutObjectCommand);
      expect(f.publication.pending).toHaveBeenCalled();
      expect(readdirSync(join(f.assetsDir, ".private", "tmp"))).toEqual([]);
      expect(f.publication.durable).not.toHaveBeenCalled();
      exists = true;
      return {};
    });
    f.fill.complete.mockImplementation(async () => {
      expect(f.publication.durable).toHaveBeenCalled();
    });
    await expect(f.publish()).resolves.toMatchObject({ hash, durability: { backend: "s3" } });
    expect(f.fill.close).toHaveBeenCalledOnce();
    expect(f.fill.sampleDownload).not.toHaveBeenCalled();
    expect(readdirSync(join(f.assetsDir, ".private", "tmp"))).toEqual([]);
    expect(sdk.config).toHaveBeenCalledWith(
      expect.objectContaining({
        maxAttempts: 1,
        credentials: { accessKeyId: "fixture-key", secretAccessKey: "fixture-secret" },
      }),
    );
  });
  it("conditionally creates after an ambiguous HEAD 403, then requires verification", async () => {
    const f = fixture();
    let puts = 0;
    sdk.send.mockImplementation(async (command) => {
      if (command instanceof HeadObjectCommand) {
        if (!puts)
          throw Object.assign(new Error("denied or absent"), {
            $metadata: { httpStatusCode: 403 },
          });
        return metadata;
      }
      expect(command).toBeInstanceOf(PutObjectCommand);
      expect(command.input).toMatchObject({ IfNoneMatch: "*", Body: bytes });
      puts++;
      return {};
    });
    await f.publish();
    expect(puts).toBe(1);
    expect(f.publication.durable).toHaveBeenCalledOnce();
  });
  it.each(["put denied", "verification denied", "mismatch"])(
    "fails closed after ambiguous HEAD when %s",
    async (failure) => {
      const f = fixture();
      let puts = 0;
      const denied = () =>
        Object.assign(new Error("denied"), { $metadata: { httpStatusCode: 403 } });
      sdk.send.mockImplementation(async (command) => {
        if (command instanceof PutObjectCommand) {
          puts++;
          if (failure === "put denied") throw denied();
          return {};
        }
        if (puts && failure === "mismatch") return { ...metadata, ContentLength: 1 };
        throw denied();
      });
      await expect(f.publish()).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
      expect(puts).toBe(1);
      expect(f.publication.durable).not.toHaveBeenCalled();
      expect(f.cache.beginFill).not.toHaveBeenCalled();
    },
  );
  it("replays a fresh whole immutable body only after probing a lost outcome", async () => {
    const f = fixture();
    const bodies: Buffer[] = [];
    let puts = 0;
    sdk.send.mockImplementation(async (command: HeadObjectCommand | PutObjectCommand) => {
      if (command instanceof HeadObjectCommand) {
        if (puts < 2) throw missing();
        return metadata;
      }
      const body = (command.input as { Body: Buffer }).Body;
      bodies.push(body);
      puts++;
      expect(body).toEqual(bytes);
      if (puts === 1) {
        body.fill(0);
        throw new Error("lost response");
      }
      return {};
    });
    await f.publish();
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).not.toBe(bodies[1]);
    expect(bodies[1]).toEqual(bytes);
  });
  it.each([
    { ...metadata, ContentLength: bytes.length + 1 },
    { ...metadata, Metadata: { sha256: "0".repeat(64) } },
    { ...metadata, Metadata: { size: "999" } },
  ])("fails closed on mismatched remote metadata", async (head) => {
    const f = fixture();
    sdk.send.mockResolvedValue(head);
    await expect(f.publish()).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    expect(sdk.send).toHaveBeenCalledOnce();
    expect(f.cache.beginFill).not.toHaveBeenCalled();
  });
  it("hashes complete metadata-free objects, rejecting corrupt/truncated/extra bodies", async () => {
    const f = fixture();
    for (const body of [
      Buffer.alloc(bytes.length),
      bytes.subarray(1),
      Buffer.concat([bytes, Buffer.from([0])]),
    ]) {
      sdk.send.mockImplementation(async (c) =>
        c instanceof GetObjectCommand
          ? { ContentLength: bytes.length, Body: Readable.from([body]) }
          : { ContentLength: bytes.length },
      );
      await expect(f.publish()).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    }
    sdk.send.mockImplementation(async (c) =>
      c instanceof GetObjectCommand
        ? { ContentLength: bytes.length, Body: Readable.from([bytes]) }
        : { ContentLength: bytes.length },
    );
    await f.publish();
    expect(f.publication.durable).toHaveBeenCalledOnce();
  });
  it("cancellation after confirmation prevents admission; a remote orphan remains durable", async () => {
    const f = fixture(),
      c = new AbortController();
    sdk.send.mockResolvedValue(metadata);
    vi.mocked(f.publication.durable).mockImplementation(async () => {
      c.abort();
    });
    await expect(f.publish({ signal: c.signal })).rejects.toMatchObject({
      code: "STORAGE_UNAVAILABLE",
    });
    expect(f.cache.open).not.toHaveBeenCalled();
  });
  it("joins admission failure before returning and retains remote evidence", async () => {
    const f = fixture();
    sdk.send.mockResolvedValue(metadata);
    f.fill.complete.mockRejectedValue(new Error("fsync failure"));
    await expect(f.publish()).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    expect(f.publication.durable).toHaveBeenCalledOnce();
    expect(f.fill.close).toHaveBeenCalledOnce();
  });
  it("waits for same-hash fill/pins only within the caller deadline", async () => {
    const f = fixture();
    sdk.send.mockResolvedValue(metadata);
    f.cache.beginFill.mockResolvedValue(undefined);
    await expect(f.publish({ deadlineAt: Date.now() + 50 })).rejects.toMatchObject({
      code: "STORAGE_UNAVAILABLE",
    });
    expect(f.fill.write).not.toHaveBeenCalled();
  });
  it.each([403, 503])(
    "bounds failed PUT %s attempts and never admits unconfirmed bytes",
    async (code) => {
      const f = fixture();
      let puts = 0;
      sdk.send.mockImplementation(async (command) => {
        if (command instanceof HeadObjectCommand) throw missing();
        puts++;
        throw Object.assign(new Error("failed"), { $metadata: { httpStatusCode: code } });
      });
      await expect(f.publish()).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
      expect(puts).toBe(code === 403 ? 1 : 2);
      expect(f.publication.durable).not.toHaveBeenCalled();
      expect(f.cache.open).not.toHaveBeenCalled();
    },
  );
  it("uses the same verified publisher for explicitly fenced offline copies without cache admission", async () => {
    const f = fixture();
    sdk.send.mockResolvedValue(metadata);
    const config = {
      bucket: "kb-assets",
      region: "auto",
      prefix: "instance",
      forcePathStyle: true,
      credentials: { accessKeyId: "fixture-key", secretAccessKey: "fixture-secret" },
    };
    const store = createS3BlobStore({
      assetsDir: f.assetsDir,
      config,
      publication: { ...f.publication, scope: "offline-target" },
      lifecycle: f.lifecycle,
    });
    await expect(
      store.publishVerified({
        declaredHash: hash,
        declaredSize: bytes.length,
        declaredMime: "image/png",
        bytes,
      }),
    ).resolves.toMatchObject({ durability: { backend: "s3" } });
    expect(f.publication.pending).toHaveBeenCalled();
    expect(f.publication.durable).toHaveBeenCalled();
    expect(f.cache.open).not.toHaveBeenCalled();
  });
  it("uses only canonical hash keys", () => {
    expect(assetS3Key("instance", hash)).toBe(
      `instance/objects/${hash.slice(7, 9)}/${hash.slice(9)}`,
    );
    expect(() => assetS3Key("instance", "../other")).toThrow();
  });
});

describe("S3 owned downloads", () => {
  const open = (
    f: ReturnType<typeof fixture>,
    purpose: "download" | "internal" = "download",
    deadlineAt?: number,
  ) =>
    f.store.open({
      hash,
      size: bytes.length,
      purpose,
      signal: new AbortController().signal,
      deadlineAt,
    });
  it("pins verified cache hits without any S3 call", async () => {
    const f = fixture();
    const hit = {
      verified: true,
      preflight: vi.fn(async () => {}),
      complete: vi.fn(async () => {}),
      readFrame: vi.fn(async () => bytes),
      close: vi.fn(async () => {}),
      sampleDownload: vi.fn(),
    };
    f.cache.open.mockResolvedValue(hit);
    const r = await open(f);
    await r.preflight();
    expect(await r.readFrame(0, bytes.length)).toEqual(bytes);
    await r.complete();
    r.sampleDownload?.();
    await r.close();
    expect(hit.sampleDownload).toHaveBeenCalledOnce();
    expect(hit.close).toHaveBeenCalledOnce();
    expect(sdk.send).not.toHaveBeenCalled();
  });
  it("tees before EOF, preserves FILLING samples and completes cache before integrity success", async () => {
    const f = fixture();
    const body = new Readable({ read() {} });
    sdk.send.mockImplementation(async () => {
      expect(f.cache.beginFill).toHaveBeenCalledOnce();
      return { ContentLength: bytes.length, Body: body };
    });
    const r = await open(f);
    await r.preflight();
    body.push(bytes);
    expect(await r.readFrame(0, 1)).toEqual(bytes.subarray(0, 1));
    expect(f.fill.write).toHaveBeenCalledWith(bytes.subarray(0, 1));
    expect(f.fill.complete).not.toHaveBeenCalled();
    r.sampleDownload?.();
    expect(f.fill.sampleDownload).toHaveBeenCalledOnce();
    const completion = r.complete();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.fill.complete).not.toHaveBeenCalled();
    body.push(null);
    await completion;
    expect(r.verified).toBe(true);
    expect(Buffer.concat(f.fill.write.mock.calls.map(([chunk]) => Buffer.from(chunk)))).toEqual(
      bytes,
    );
    expect(f.fill.complete).toHaveBeenCalledOnce();
    await r.close();
    expect(f.fill.close).toHaveBeenCalledOnce();
  });
  it.each(["short", "long", "hash"])("rejects a %s body without READY", async (kind) => {
    const f = fixture();
    const wrong =
      kind === "short"
        ? bytes.subarray(1)
        : kind === "long"
          ? Buffer.concat([bytes, Buffer.from([0])])
          : Buffer.alloc(bytes.length);
    sdk.send.mockResolvedValue({
      ContentLength: bytes.length,
      Body: Readable.from([wrong], { objectMode: false }),
    });
    const r = await open(f);
    await r.preflight();
    await expect(r.complete()).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    await r.close();
    expect(f.fill.complete).not.toHaveBeenCalled();
    expect(f.fill.close).toHaveBeenCalledOnce();
  });
  it("internal reads hash full tails without admission or touches", async () => {
    const f = fixture();
    sdk.send.mockResolvedValue({
      ContentLength: bytes.length,
      Body: Readable.from([bytes], { objectMode: false }),
    });
    const r = await open(f, "internal");
    await r.preflight();
    expect(await r.readFrame(2, 3)).toEqual(bytes.subarray(2, 5));
    r.sampleDownload?.();
    await r.complete();
    await r.close();
    expect(f.cache.beginFill).not.toHaveBeenCalled();
    expect(f.fill.sampleDownload).not.toHaveBeenCalled();
  });
  it("oversized downloads bypass reservations and samples", async () => {
    const f = fixture();
    f.cache.state.binding.limit = 1n;
    sdk.send.mockResolvedValue({
      ContentLength: bytes.length,
      Body: Readable.from([bytes], { objectMode: false }),
    });
    const r = await open(f);
    await r.preflight();
    await r.complete();
    r.sampleDownload?.();
    await r.close();
    expect(f.cache.beginFill).not.toHaveBeenCalled();
    expect(f.fill.sampleDownload).not.toHaveBeenCalled();
  });
  it("all-pinned capacity fails before GET within the caller deadline", async () => {
    const f = fixture();
    f.cache.beginFill.mockResolvedValue(undefined);
    await expect(open(f, "download", Date.now() + 30)).rejects.toMatchObject({
      code: "STORAGE_UNAVAILABLE",
    });
    expect(sdk.send).not.toHaveBeenCalled();
  });
  it("shutdown aborts and drains a blocked body before releasing its fill", async () => {
    const f = fixture();
    const body = new Readable({ read() {} });
    sdk.send.mockResolvedValue({ ContentLength: bytes.length, Body: body });
    const r = await open(f);
    await r.preflight();
    const reading = expect(r.readFrame(0, 1)).rejects.toMatchObject({
      code: "STORAGE_UNAVAILABLE",
    });
    await f.lifecycle.stop();
    await reading;
    expect(body.destroyed).toBe(true);
    expect(f.fill.close).toHaveBeenCalledOnce();
  });
  it.each(["cancel", "deadline"])("%s drains a stalled GET without READY", async (kind) => {
    const f = fixture();
    const body = new Readable({ read() {} });
    sdk.send.mockResolvedValue({ ContentLength: bytes.length, Body: body });
    const cancel = new AbortController();
    const r = await f.store.open({
      hash,
      size: bytes.length,
      purpose: "download",
      signal: cancel.signal,
      deadlineAt: Date.now() + 30,
    });
    await r.preflight();
    const reading = expect(r.readFrame(0, 1)).rejects.toMatchObject({
      code: "STORAGE_UNAVAILABLE",
    });
    if (kind === "cancel") cancel.abort();
    await reading;
    await r.close();
    expect(body.destroyed).toBe(true);
    expect(f.fill.complete).not.toHaveBeenCalled();
    expect(f.fill.close).toHaveBeenCalledOnce();
  });
  it.each([403, 404, 503])("remote %s remains STORAGE_UNAVAILABLE", async (code) => {
    const f = fixture();
    sdk.send.mockRejectedValue(
      Object.assign(new Error("remote"), { $metadata: { httpStatusCode: code } }),
    );
    const r = await open(f);
    await expect(r.preflight()).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    await r.close();
    expect(f.fill.close).toHaveBeenCalledOnce();
  });
});
