import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { RateLimiterRes } from "rate-limiter-flexible";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assetValidationContext } from "./asset-authz";
import {
  ASSET_FRAME_BYTES,
  assetByteRange,
  assetStreamWorkPoints,
  authorizedAssetStream,
  authorizedFrameStream,
  KB_ASSET_HTTP_WORK_BUDGET,
} from "./authorized-stream";
import { casBlobPath, createDiskBlobStore } from "./blob-store-disk";
import { authorizeDocumentRead } from "./documents-read";
import { sha256Buffer } from "./fixtures/media-bytes";
import { CAS_BLOB_MAX_BYTES } from "./limits";
import { canonicalManifestBytes } from "./manifest";
import { KbAdmissionError } from "./principal";

const gitFixture = vi.hoisted(() => ({
  manifest: "",
  calls: 0,
  reachable: true,
  missingRevision: false,
  pending: undefined as (() => void) | undefined,
  killSignal: "",
}));
vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => {
    gitFixture.calls++;
    const argv = args[1];
    const callback = args.at(-1);
    if (!Array.isArray(argv) || typeof callback !== "function")
      throw new Error("Invalid Git fixture call");
    const child = Object.assign(new EventEmitter(), {
      kill(killSignal: string) {
        gitFixture.killSignal = killSignal;
        callback(new Error("Git killed"), Buffer.alloc(0), "");
        child.emit("close");
        return true;
      },
    });
    if (gitFixture.pending) {
      gitFixture.pending();
      return child;
    }
    const output =
      argv[0] === "cat-file"
        ? gitFixture.manifest
        : argv[0] === "for-each-ref"
          ? gitFixture.reachable
            ? "a".repeat(40)
            : ""
          : "";
    if (argv[0] === "for-each-ref" && gitFixture.missingRevision) {
      const sha = String(argv.find((arg) => String(arg).startsWith("--contains="))).slice(
        "--contains=".length,
      );
      callback(
        Object.assign(new Error("unknown revision"), { code: 129 }),
        Buffer.alloc(0),
        `error: no such commit ${sha}\n`,
      );
    } else callback(null, Buffer.from(output), "");
    queueMicrotask(() => child.emit("close"));
    return child;
  },
}));
vi.mock("./asset-authz", () => ({ assetValidationContext: vi.fn() }));
vi.mock("@knowledge-base/db", async () => ({
  default: (await import("vitest-mock-extended")).mockDeep(),
}));
vi.mock("@knowledge-base/queue", () => ({}));
vi.mock("./documents-read", async (original) => ({
  ...(await original<typeof import("./documents-read")>()),
  authorizeDocumentRead: vi.fn(),
}));

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), "kb-stream-"));
  vi.mocked(authorizeDocumentRead).mockResolvedValue();
  gitFixture.calls = 0;
  gitFixture.reachable = true;
  gitFixture.missingRevision = false;
  gitFixture.pending = undefined;
});
afterEach(async () => {
  vi.useRealTimers();
  // Linux CAS: verify descriptor cleanup after every success/failure/cancel case.
  await vi.waitFor(() => {
    const owned = fs.readdirSync("/proc/self/fd").filter((fd) => {
      try {
        return fs.readlinkSync(`/proc/self/fd/${fd}`).startsWith(root);
      } catch {
        return false;
      }
    });
    expect(owned).toEqual([]);
  });
  vi.restoreAllMocks();
  vi.resetAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});
function fixture(size = ASSET_FRAME_BYTES * 3) {
  const bytes = Buffer.alloc(size, 0x61);
  const hash = sha256Buffer(bytes);
  const path = casBlobPath(root, hash);
  fs.mkdirSync(dirname(path), { recursive: true });
  fs.writeFileSync(path, bytes);
  gitFixture.manifest = canonicalManifestBytes({
    version: 1,
    entries: [{ path: "a.wav", hash, size, mime: "audio/wav" }],
  }).toString("utf8");
  vi.mocked(assetValidationContext).mockResolvedValue({
    trustedBlobs: new Map([[hash, { size, mime: "audio/wav" }]]),
    lineageHashes: new Set([hash]),
  });
  const abort = new AbortController();
  const input = {
    principal: { kind: "browser" as const, userId: "owner" },
    kbId: "a".repeat(24),
    operation: "read" as const,
    store: { loadKb: vi.fn(), loadShare: vi.fn(), loadIdentity: vi.fn() },
    query: vi.fn(),
    reposDir: root,
    blobStore: createDiskBlobStore(root),
    purpose: "download" as const,
    rev: "a".repeat(40),
    hash,
    range: null as string | null,
    signal: abort.signal,
  };
  return { input, bytes, path, abort };
}

describe("single byte range", () => {
  it("weights work points from verification and delivery frames", () => {
    const size = 25 * 1024 * 1024;
    const frames = Math.ceil(size / ASSET_FRAME_BYTES);
    expect(assetStreamWorkPoints(size, 0, 0)).toBe(frames);
    expect(assetStreamWorkPoints(size, 0, size - 1)).toBe(frames);
    expect(assetStreamWorkPoints(size, 0, size - 1, true)).toBe(frames);
    expect(assetStreamWorkPoints(size, size - 1, size - 1)).toBe(frames);
    expect(
      assetStreamWorkPoints(CAS_BLOB_MAX_BYTES, 0, CAS_BLOB_MAX_BYTES - 1),
    ).toBeLessThanOrEqual(KB_ASSET_HTTP_WORK_BUDGET);
  });
  it.each([
    "",
    "bytes=-",
    "bytes=-0",
    "bytes=100-",
    "bytes=9-8",
    "bytes=0-1,3-4",
    "bytes=9007199254740992-",
    "bytes=0-9007199254740992",
    "bytes=-9007199254740992",
    "bytes=1e2-",
    "items=0-1",
    `bytes=${"0".repeat(100)}-1`,
  ])("rejects %s", (header) => {
    expect(() => assetByteRange(header, 100)).toThrow("Range not satisfiable");
  });
});

describe("authorized stream ownership", () => {
  it("rejects unreachable revisions before manifest or CAS access", async () => {
    const { input } = fixture();
    gitFixture.reachable = false;
    await expect(authorizedAssetStream(input)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(gitFixture.calls).toBe(1);
    expect(assetValidationContext).not.toHaveBeenCalled();
  });

  it("classifies a missing revision as NOT_FOUND through the shared Git runner", async () => {
    const { input } = fixture();
    gitFixture.missingRevision = true;
    await expect(authorizedAssetStream(input)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(gitFixture.calls).toBe(1);
    expect(assetValidationContext).not.toHaveBeenCalled();
  });

  it("aborts pending Git preparation at the deadline and launches no later command", async () => {
    vi.useFakeTimers();
    const { input } = fixture();
    const entered = Promise.withResolvers<void>();
    gitFixture.pending = entered.resolve;
    const opening = authorizedAssetStream({ ...input, deadlineMs: 10 });
    const outcome = expect(opening).rejects.toMatchObject({ name: "TimeoutError" });
    await entered.promise;
    await vi.advanceTimersByTimeAsync(10);
    await outcome;
    expect(gitFixture.killSignal).toBe("SIGKILL");
    expect(gitFixture.calls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("rethrows work-budget limiter rejections", async () => {
    const { input } = fixture();
    const limited = new RateLimiterRes(0, 45_000);
    await expect(
      authorizedAssetStream({
        ...input,
        chargeWork: () => Promise.reject(limited),
      }),
    ).rejects.toBe(limited);
  });
  it("rejects a noncanonical committed manifest", async () => {
    const { input, hash } = fixture();
    gitFixture.manifest = `${JSON.stringify({
      version: 1,
      entries: [
        { path: "z.wav", hash, size: ASSET_FRAME_BYTES * 3, mime: "audio/wav" },
        { path: "a.wav", hash, size: ASSET_FRAME_BYTES * 3, mime: "audio/wav" },
      ],
    })}\n`;
    await expect(authorizedAssetStream(input)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it.each([null, "bytes=0-2"])(
    "withholds the final requested frame until store completion (%s)",
    async (range) => {
      const { input } = fixture();
      const open = input.blobStore.open.bind(input.blobStore);
      const complete = vi.fn().mockRejectedValue(new Error("incomplete storage body"));
      const close = vi.fn();
      vi.spyOn(input.blobStore, "open").mockImplementation(async (options) => {
        expect(options.purpose).toBe("download");
        const reader = await open(options);
        close.mockImplementation(() => reader.close());
        return { ...reader, complete, close };
      });
      const { body } = await authorizedAssetStream({ ...input, range });
      const reader = body!.getReader();
      let delivered = 0;
      await expect(
        (async () => {
          for (;;) {
            const frame = await reader.read();
            if (frame.done) return;
            delivered += frame.value.length;
          }
        })(),
      ).rejects.toThrow("incomplete storage body");
      expect(delivered).toBe(range ? 0 : ASSET_FRAME_BYTES * 2);
      expect(complete).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
    },
  );

  it.each(["download", "internal", "head"])(
    "samples only enqueued download frames (%s)",
    async (kind) => {
      const { input } = fixture();
      const open = input.blobStore.open.bind(input.blobStore);
      const sample = vi.fn(() => {
        throw new Error("advisory failure");
      });
      vi.spyOn(input.blobStore, "open").mockImplementation(async (options) => {
        expect(options.purpose).toBe(kind === "download" ? "download" : "internal");
        return { ...(await open(options)), sampleDownload: sample };
      });
      const result = await authorizedAssetStream({
        ...input,
        head: kind === "head",
        purpose: kind === "internal" ? "internal" : "download",
      });
      await new Response(result.body).arrayBuffer();
      expect(sample).toHaveBeenCalledTimes(kind === "download" ? 3 : 0);
    },
  );
  it("does not sample frames denied by the final authority check", async () => {
    const { input } = fixture();
    const open = input.blobStore.open.bind(input.blobStore);
    const sample = vi.fn();
    vi.spyOn(input.blobStore, "open").mockImplementation(async (options) => {
      const reader = await open(options);
      return {
        ...reader,
        sampleDownload: sample,
        readFrame: async (offset, length) => {
          const frame = await reader.readFrame(offset, length);
          vi.mocked(authorizeDocumentRead).mockRejectedValue(
            new KbAdmissionError("NOT_FOUND", "Not found"),
          );
          return frame;
        },
      };
    });
    const { body } = await authorizedAssetStream(input);
    await expect(body!.getReader().read()).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(sample).not.toHaveBeenCalled();
  });

  it("does not sample a failed synchronous enqueue", async () => {
    const { input } = fixture();
    const open = input.blobStore.open.bind(input.blobStore);
    const sample = vi.fn();
    vi.spyOn(input.blobStore, "open").mockImplementation(async (options) => ({
      ...(await open(options)),
      sampleDownload: sample,
    }));
    const { body } = await authorizedAssetStream(input);
    vi.spyOn(ReadableStreamDefaultController.prototype, "enqueue").mockImplementationOnce(() => {
      throw new Error("enqueue failed");
    });
    await expect(body!.getReader().read()).rejects.toThrow("enqueue failed");
    expect(sample).not.toHaveBeenCalled();
  });

  it("requires storage completion before a successful HEAD", async () => {
    const { input } = fixture();
    const open = input.blobStore.open.bind(input.blobStore);
    vi.spyOn(input.blobStore, "open").mockImplementation(async (options) => {
      const reader = await open(options);
      return {
        ...reader,
        complete: async () => {
          throw new Error("incomplete HEAD");
        },
      };
    });
    await expect(authorizedAssetStream({ ...input, head: true })).rejects.toMatchObject({
      code: "STORAGE_UNAVAILABLE",
    });
  });

  it("reauthorizes after the final storage completion await", async () => {
    const { input } = fixture();
    const open = input.blobStore.open.bind(input.blobStore);
    vi.spyOn(input.blobStore, "open").mockImplementation(async (options) => {
      const reader = await open(options);
      return {
        ...reader,
        complete: async () => {
          await reader.complete();
          vi.mocked(authorizeDocumentRead).mockRejectedValue(
            new KbAdmissionError("NOT_FOUND", "Not found"),
          );
        },
      };
    });
    const { body } = await authorizedAssetStream({
      ...input,
      range: "bytes=0-2",
      purpose: "internal",
    });
    await expect(body!.getReader().read()).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(vi.mocked(input.blobStore.open).mock.calls[0]![0].purpose).toBe("internal");
  });

  it("returns exact bytes with no speculative pulls and bounded allocations for 25 MiB", async () => {
    const { input, bytes } = fixture(25 * 1024 * 1024);
    const allocate = vi.spyOn(Buffer, "alloc");
    const result = await authorizedAssetStream(input);
    const calls = vi.mocked(authorizeDocumentRead).mock.calls.length;
    const reader = result.body!.getReader();
    await setImmediate();
    expect(authorizeDocumentRead).toHaveBeenCalledTimes(calls);
    let offset = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      expect(value.byteLength).toBeLessThanOrEqual(ASSET_FRAME_BYTES);
      expect(Buffer.from(value).equals(bytes.subarray(offset, offset + value.length))).toBe(true);
      offset += value.length;
    }
    expect(offset).toBe(bytes.length);
    expect(Math.max(...allocate.mock.calls.map(([size]) => size))).toBe(ASSET_FRAME_BYTES);
  });
  it("pauses after one frame; revocation prevents the next frame", async () => {
    const { input } = fixture();
    const { body } = await authorizedAssetStream(input);
    const reader = body!.getReader();
    expect((await reader.read()).value).toHaveLength(ASSET_FRAME_BYTES);
    const barrier = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    let revoked = false;
    let checks = 0;
    vi.mocked(authorizeDocumentRead).mockImplementation(async () => {
      if (++checks === 1) return; // allow the file read, pause the final authority check
      entered.resolve();
      await barrier.promise;
      if (revoked) throw new KbAdmissionError("NOT_FOUND", "Not found");
    });
    const next = reader.read();
    const rejected = expect(next).rejects.toMatchObject({ code: "NOT_FOUND" });
    await entered.promise;
    revoked = true;
    barrier.resolve();
    await rejected;
  });
  it.each(["disconnect", "cancel", "deadline"])("fences late authority after %s", async (kind) => {
    vi.useFakeTimers();
    const { input, abort } = fixture();
    const { body } = await authorizedAssetStream({ ...input, deadlineMs: 10 });
    const reader = body!.getReader();
    const barrier = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    vi.mocked(authorizeDocumentRead).mockImplementation(async () => {
      entered.resolve();
      await barrier.promise;
    });
    const next = reader.read();
    const outcome =
      kind === "cancel"
        ? expect(next).resolves.toMatchObject({ done: true })
        : expect(next).rejects.toBeInstanceOf(DOMException);
    await entered.promise;
    if (kind === "disconnect") abort.abort();
    else if (kind === "cancel") await reader.cancel();
    else await vi.advanceTimersByTimeAsync(10);
    await outcome;
    barrier.resolve();
    await setImmediate();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("deadline closes an idle stream, and re-entry owns a fresh stream", async () => {
    vi.useFakeTimers();
    const { input } = fixture();
    const first = await authorizedAssetStream({ ...input, deadlineMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    await expect(first.body!.getReader().read()).rejects.toMatchObject({ name: "TimeoutError" });
    const second = await authorizedAssetStream({ ...input, range: "bytes=3-7" });
    expect(await new Response(second.body).text()).toBe("aaaaa");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("aborts before preparation, during preparation, and during shutdown", async () => {
    const { input, abort } = fixture();
    abort.abort();
    await expect(authorizedAssetStream(input)).rejects.toMatchObject({ name: "AbortError" });
    expect(gitFixture.calls).toBe(0);
    const fresh = fixture();
    const pending = Promise.withResolvers<void>();
    vi.mocked(authorizeDocumentRead).mockReturnValueOnce(pending.promise);
    const opening = authorizedAssetStream(fresh.input);
    fresh.abort.abort();
    await expect(opening).rejects.toMatchObject({ name: "AbortError" });
    pending.reject(new Error("late failure"));
    const next = fixture();
    let shutdown = false;
    const stream = await authorizedAssetStream({ ...next.input, isShuttingDown: () => shutdown });
    shutdown = true;
    await expect(stream.body!.getReader().read()).rejects.toMatchObject({ name: "AbortError" });
  });
  it.each(["rewrite", "truncate", "missing", "symlink"])(
    "refuses %s before any body",
    async (kind) => {
      const { input, path } = fixture();
      if (kind === "rewrite") fs.writeFileSync(path, Buffer.alloc(ASSET_FRAME_BYTES * 3, 0x62));
      else if (kind === "truncate") fs.writeFileSync(path, "a");
      else {
        fs.rmSync(path);
        if (kind === "symlink") fs.symlinkSync("/dev/zero", path);
      }
      await expect(authorizedAssetStream(input)).rejects.toMatchObject({
        code: "STORAGE_UNAVAILABLE",
      });
    },
  );
  it("rejects modification after preflight and unsafe MIME even in a catalog response", async () => {
    const { input, path } = fixture();
    const result = await authorizedAssetStream(input);
    fs.writeFileSync(path, Buffer.alloc(ASSET_FRAME_BYTES * 3, 0x62));
    await expect(result.body!.getReader().read()).rejects.toMatchObject({
      code: "STORAGE_UNAVAILABLE",
    });
    for (const mime of ["image/svg+xml", "text/html", "application/octet-stream"]) {
      vi.mocked(assetValidationContext).mockResolvedValue({
        trustedBlobs: new Map([[input.hash, { size: ASSET_FRAME_BYTES * 3, mime }]]),
        lineageHashes: new Set([input.hash]),
      });
      gitFixture.manifest = canonicalManifestBytes({
        version: 1,
        entries: [{ path: "x.bin", hash: input.hash, size: ASSET_FRAME_BYTES * 3, mime }],
      }).toString("utf8");
      await expect(authorizedAssetStream(input)).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
  });
  it("HEAD verifies without creating a body", async () => {
    const { input } = fixture();
    expect((await authorizedAssetStream({ ...input, head: true })).body).toBeNull();
  });
});

describe("artifact frame termination", () => {
  afterEach(() => vi.useRealTimers());
  it.each(["signal", "deadline", "shutdown", "cancel"])(
    "%s joins the pending read and discard before terminal settlement",
    async (kind) => {
      vi.useFakeTimers();
      const abort = new AbortController();
      const read = Promise.withResolvers<void>();
      const discarded = Promise.withResolvers<void>();
      const discard = vi.fn(() => discarded.promise);
      const stream = authorizedFrameStream({
        signal: abort.signal,
        read: async (_offset, deliver) => {
          await read.promise;
          deliver({ bytesBase64: "YQ==", nextOffset: 1, eof: false });
        },
        discard,
      });
      const reader = stream.body.getReader();
      let observed = false;
      const reading = reader.read().then(
        () => {
          observed = true;
        },
        () => {
          observed = true;
        },
      );
      let stopping: Promise<void> | undefined;
      if (kind === "signal") abort.abort();
      else if (kind === "deadline") await vi.advanceTimersByTimeAsync(120_000);
      else if (kind === "shutdown") stopping = stream.stop();
      else stopping = reader.cancel();
      await Promise.resolve();
      expect(discard).not.toHaveBeenCalled();
      if (kind !== "cancel") expect(observed).toBe(false);
      let stopped = false;
      void stopping?.then(() => {
        stopped = true;
      });
      read.resolve();
      await vi.waitFor(() => expect(discard).toHaveBeenCalledOnce());
      if (kind !== "cancel") expect(observed).toBe(false);
      expect(stopped).toBe(false);
      discarded.resolve();
      await Promise.all([reading, stopping, stream.done]);
      expect(observed).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it("zero-prefetch EOF completes normally and later abort/shutdown preserve grace", async () => {
    const abort = new AbortController();
    const discard = vi.fn(async () => {});
    const read = vi.fn(
      async (
        _offset,
        deliver: (frame: { bytesBase64: string; nextOffset: number; eof: boolean }) => void,
      ) => {
        deliver({ bytesBase64: "YQ==", nextOffset: 1, eof: true });
      },
    );
    const stream = authorizedFrameStream({ signal: abort.signal, read, discard });
    expect(read).not.toHaveBeenCalled();
    expect(await new Response(stream.body).text()).toBe("a");
    await stream.done;
    abort.abort();
    await stream.stop();
    expect(discard).not.toHaveBeenCalled();
  });
});
