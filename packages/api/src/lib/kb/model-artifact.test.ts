import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { LookupAddress } from "node:dns";
import { once } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DnsLookupFn } from "./egress";
import {
  type ArtifactIdentity,
  downloadModelArtifact,
  MODEL_DOWNLOAD_ALLOWED_HOSTS,
  MODEL_MAX_REDIRECTS,
  ModelArtifactError,
  type ModelHopRequest,
  type ModelHopResponse,
  type ModelTransport,
  QWEN_ARTIFACT,
  validateModelHopUrl,
  verifyPublishedArtifact,
} from "./model-artifact";

const closeFault = vi.hoisted(() => ({
  wrap: null as ((handle: FileHandle, path: string) => void) | null,
}));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      closeFault.wrap?.(handle, String(args[0]));
      return handle;
    },
  };
});

const PUBLIC: Record<string, string> = {
  "huggingface.co": "18.160.1.1",
  "cdn-lfs.huggingface.co": "18.160.2.2",
  "cas-bridge.xethub.hf.co": "18.160.3.3",
  "us.aws.cdn.hf.co": "18.160.4.4",
};
const fixtureBytes = Buffer.from("fixture-gguf-bytes-".repeat(4096));
const expected: ArtifactIdentity = {
  fileName: QWEN_ARTIFACT.fileName,
  sizeBytes: fixtureBytes.byteLength,
  sha256: createHash("sha256").update(fixtureBytes).digest("hex"),
};

const dirs: string[] = [];
afterEach(() => {
  closeFault.wrap = null;
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "kb-model-"));
  dirs.push(dir);
  return dir;
}

function lookupFrom(table: Record<string, string | string[]>): DnsLookupFn & { calls: string[] } {
  const calls: string[] = [];
  const fn = ((hostname, _options, callback) => {
    calls.push(hostname);
    const entry = table[hostname];
    if (!entry) {
      callback(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }), []);
      return;
    }
    const list = Array.isArray(entry) ? entry : [entry];
    callback(
      null,
      list.map((address): LookupAddress => ({ address, family: address.includes(":") ? 6 : 4 })),
    );
  }) as DnsLookupFn & { calls: string[] };
  fn.calls = calls;
  return fn;
}

async function* chunks(bytes: Uint8Array, size = 8192, failAfter?: number) {
  for (let offset = 0; offset < bytes.byteLength; offset += size) {
    if (failAfter !== undefined && offset >= failAfter) throw new Error("socket reset");
    yield bytes.subarray(offset, Math.min(offset + size, bytes.byteLength));
  }
}

type Route = (req: ModelHopRequest) => ModelHopResponse;
function fakeTransport(
  routes: Record<string, Route>,
): ModelTransport & { seen: ModelHopRequest[] } {
  const seen: ModelHopRequest[] = [];
  return {
    seen,
    async request(req) {
      seen.push(req);
      const route = routes[`${req.url.hostname}${req.url.pathname}`];
      if (!route) throw new Error(`unexpected request ${req.url.href}`);
      return route(req);
    },
  };
}
const redirect =
  (location: string, status = 302): Route =>
  () => ({
    status,
    headers: { location },
    body: chunks(new Uint8Array()),
  });
const ok =
  (bytes: Uint8Array = fixtureBytes): Route =>
  () => ({
    status: 200,
    headers: { "content-length": String(bytes.byteLength) },
    body: chunks(bytes),
  });
const OFFICIAL_PATH =
  "huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/370f27d7550e0def9b39c1f16d3fbaa13aa67728/Qwen3-Embedding-0.6B-Q8_0.gguf";

async function run(
  dir: string,
  transport: ModelTransport,
  lookup: DnsLookupFn = lookupFrom(PUBLIC),
  extra: Partial<Parameters<typeof downloadModelArtifact>[0]> = {},
) {
  const progress: number[] = [];
  const result = await downloadModelArtifact({
    dir,
    epoch: 1,
    expected,
    signal: new AbortController().signal,
    onProgress: (bytes) => {
      progress.push(bytes);
    },
    deps: { transport, lookup },
    ...extra,
  });
  return { result, progress };
}

describe("binding Qwen artifact registry", () => {
  it("pins the exact artifact identity and official URL", () => {
    expect(QWEN_ARTIFACT.fileName).toBe("Qwen3-Embedding-0.6B-Q8_0.gguf");
    expect(QWEN_ARTIFACT.sizeBytes).toBe(639150592);
    expect(QWEN_ARTIFACT.sha256).toBe(
      "06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439",
    );
    expect(QWEN_ARTIFACT.url).toBe(
      "https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/370f27d7550e0def9b39c1f16d3fbaa13aa67728/Qwen3-Embedding-0.6B-Q8_0.gguf",
    );
    expect(QWEN_ARTIFACT.dimensions).toBe(1024);
    expect(QWEN_ARTIFACT.pooling).toBe("LAST");
    expect(QWEN_ARTIFACT.queryPrefix).toBe(
      "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ",
    );
    expect(Object.isFrozen(QWEN_ARTIFACT)).toBe(true);
    expect([...MODEL_DOWNLOAD_ALLOWED_HOSTS]).toEqual([
      "huggingface.co",
      "cdn-lfs.huggingface.co",
      "cas-bridge.xethub.hf.co",
      "us.aws.cdn.hf.co",
    ]);
    expect(MODEL_MAX_REDIRECTS).toBe(5);
  });

  it("shares the registry as a JSON fixture for the future Rust local model", () => {
    const json = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "fixtures/qwen-artifact.json"), "utf8"),
    );
    expect(json).toMatchObject({
      fileName: QWEN_ARTIFACT.fileName,
      sizeBytes: QWEN_ARTIFACT.sizeBytes,
      sha256: QWEN_ARTIFACT.sha256,
      url: QWEN_ARTIFACT.url,
      dimensions: 1024,
      pooling: "LAST",
      queryPrefix: QWEN_ARTIFACT.queryPrefix,
      allowedHosts: [...MODEL_DOWNLOAD_ALLOWED_HOSTS],
      maxRedirects: 5,
    });
  });

  it("never bakes a GGUF into an image", () => {
    const root = resolve(import.meta.dirname, "../../../../..");
    expect(readFileSync(join(root, ".dockerignore"), "utf8")).toMatch(/\*\.gguf/);
    for (const file of ["Dockerfile", "Dockerfile.worker"]) {
      const source = readFileSync(join(root, file), "utf8");
      expect(source).not.toMatch(/\.gguf|huggingface\.co/i);
    }
  });
});

describe("model hop URL validation", () => {
  it("accepts only HTTPS on exact allowlisted hosts with the default port", () => {
    expect(validateModelHopUrl("https://cdn-lfs.huggingface.co/x?sig=1").hostname).toBe(
      "cdn-lfs.huggingface.co",
    );
    for (const [url, code] of [
      ["http://huggingface.co/x", "MODEL_HOST_REJECTED"],
      ["https://evil.example/x", "MODEL_HOST_REJECTED"],
      ["https://huggingface.co.evil.example/x", "MODEL_HOST_REJECTED"],
      ["https://sub.huggingface.co/x", "MODEL_HOST_REJECTED"],
      ["https://huggingface.co:8443/x", "MODEL_HOST_REJECTED"],
      ["https://user:pw@huggingface.co/x", "MODEL_HOST_REJECTED"],
      ["https://10.0.0.1/x", "MODEL_HOST_REJECTED"],
      ["not a url", "MODEL_HOST_REJECTED"],
      ["https://eu.aws.cdn.hf.co/model", "MODEL_HOST_REJECTED"],
      ["https://us.aws.cdn.hf.co.evil.example/model", "MODEL_HOST_REJECTED"],
      ["http://us.aws.cdn.hf.co/model", "MODEL_HOST_REJECTED"],
    ] as const)
      expect(() => validateModelHopUrl(url)).toThrow(expect.objectContaining({ code }));
  });
});

describe("fake-transport download", { timeout: 30_000 }, () => {
  it("follows the allowed redirect chain with pinned public addresses and publishes exactly", async () => {
    const dir = tempDir();
    const transport = fakeTransport({
      [OFFICIAL_PATH]: redirect("https://cdn-lfs.huggingface.co/lfs/abc?sig=1"),
      "cdn-lfs.huggingface.co/lfs/abc": redirect("https://cas-bridge.xethub.hf.co/xet/def", 307),
      "cas-bridge.xethub.hf.co/xet/def": redirect("https://us.aws.cdn.hf.co/model/ghi"),
      "us.aws.cdn.hf.co/model/ghi": ok(),
    });
    const lookup = lookupFrom(PUBLIC);
    const { result, progress } = await run(dir, transport, lookup);
    expect(result.outcome).toBe("PUBLISHED");
    expect(readFileSync(join(dir, QWEN_ARTIFACT.fileName)).equals(fixtureBytes)).toBe(true);
    expect(transport.seen.map((req) => [req.url.hostname, req.address, req.servername])).toEqual([
      ["huggingface.co", PUBLIC["huggingface.co"], "huggingface.co"],
      ["cdn-lfs.huggingface.co", PUBLIC["cdn-lfs.huggingface.co"], "cdn-lfs.huggingface.co"],
      ["cas-bridge.xethub.hf.co", PUBLIC["cas-bridge.xethub.hf.co"], "cas-bridge.xethub.hf.co"],
      ["us.aws.cdn.hf.co", PUBLIC["us.aws.cdn.hf.co"], "us.aws.cdn.hf.co"],
    ]);
    for (const req of transport.seen) {
      expect(Object.keys(req.headers).map((key) => key.toLowerCase())).not.toContain(
        "authorization",
      );
      expect(Object.keys(req.headers).map((key) => key.toLowerCase())).not.toContain("cookie");
    }
    expect(progress.at(-1)).toBe(fixtureBytes.byteLength);
    expect(readdirSync(dir)).toEqual([QWEN_ARTIFACT.fileName]);
  });

  it("rejects a private address on the official CDN before connecting", async () => {
    const dir = tempDir();
    const transport = fakeTransport({
      [OFFICIAL_PATH]: redirect("https://us.aws.cdn.hf.co/model"),
    });
    await expect(
      run(dir, transport, lookupFrom({ ...PUBLIC, "us.aws.cdn.hf.co": "127.0.0.1" })),
    ).rejects.toMatchObject({ code: "MODEL_PRIVATE_NETWORK" });
    expect(transport.seen).toHaveLength(1);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("fails closed on an unknown redirect host without contacting it and removes temp", async () => {
    const dir = tempDir();
    const transport = fakeTransport({
      [OFFICIAL_PATH]: redirect("https://evil.example/model.gguf"),
    });
    await expect(run(dir, transport)).rejects.toMatchObject({
      code: "MODEL_HOST_REJECTED",
      retryable: false,
    });
    expect(transport.seen).toHaveLength(1);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("rejects private DNS answers before connecting", async () => {
    const dir = tempDir();
    const transport = fakeTransport({
      [OFFICIAL_PATH]: redirect("https://cdn-lfs.huggingface.co/lfs/abc"),
    });
    const lookup = lookupFrom({ ...PUBLIC, "cdn-lfs.huggingface.co": ["18.1.1.1", "10.0.0.5"] });
    await expect(run(dir, transport, lookup)).rejects.toMatchObject({
      code: "MODEL_PRIVATE_NETWORK",
    });
    expect(transport.seen.map((req) => req.url.hostname)).toEqual(["huggingface.co"]);
  });

  it("re-resolves every hop so DNS rebinding to a private address is rejected", async () => {
    const dir = tempDir();
    let resolutions = 0;
    const lookup = ((hostname, _options, callback) => {
      resolutions += 1;
      const address =
        hostname === "huggingface.co" && resolutions > 1 ? "127.0.0.1" : PUBLIC[hostname]!;
      callback(null, [{ address, family: 4 }]);
    }) as DnsLookupFn;
    const transport = fakeTransport({
      [OFFICIAL_PATH]: redirect("https://huggingface.co/again"),
    });
    await expect(run(dir, transport, lookup)).rejects.toMatchObject({
      code: "MODEL_PRIVATE_NETWORK",
    });
    expect(transport.seen).toHaveLength(1);
    expect(transport.seen[0]!.address).toBe(PUBLIC["huggingface.co"]);
  });

  it("caps redirects at five", async () => {
    const dir = tempDir();
    const routes: Record<string, Route> = {
      [OFFICIAL_PATH]: redirect("https://cdn-lfs.huggingface.co/r1"),
    };
    for (let hop = 1; hop <= 3; hop += 1)
      routes[`cdn-lfs.huggingface.co/r${hop}`] = redirect(
        `https://cdn-lfs.huggingface.co/r${hop + 1}`,
      );
    routes["cdn-lfs.huggingface.co/r4"] = redirect("https://cas-bridge.xethub.hf.co/final");
    routes["cas-bridge.xethub.hf.co/final"] = ok();
    // official->r1->r2->r3->r4->final: exactly five redirects succeed.
    await expect(run(dir, fakeTransport(routes))).resolves.toMatchObject({
      result: { outcome: "PUBLISHED" },
    });
    const dir2 = tempDir();
    routes["cdn-lfs.huggingface.co/r4"] = redirect("https://cdn-lfs.huggingface.co/r5");
    routes["cdn-lfs.huggingface.co/r5"] = redirect("https://cas-bridge.xethub.hf.co/final");
    await expect(run(dir2, fakeTransport(routes))).rejects.toMatchObject({
      code: "MODEL_REDIRECT_LIMIT",
    });
  });

  it("rejects a wrong size (declared or streamed) and removes temp", async () => {
    const dir = tempDir();
    const longer = Buffer.concat([fixtureBytes, Buffer.from("x")]);
    await expect(run(dir, fakeTransport({ [OFFICIAL_PATH]: ok(longer) }))).rejects.toMatchObject({
      code: "MODEL_SIZE_MISMATCH",
      retryable: false,
    });
    expect(readdirSync(dir)).toEqual([]);
    const lying: Route = () => ({
      status: 200,
      headers: {},
      body: chunks(longer),
    });
    await expect(run(dir, fakeTransport({ [OFFICIAL_PATH]: lying }))).rejects.toMatchObject({
      code: "MODEL_SIZE_MISMATCH",
    });
    expect(readdirSync(dir)).toEqual([]);
  });

  it("rejects a wrong hash with a fixed code and removes temp", async () => {
    const dir = tempDir();
    const tampered = Buffer.from(fixtureBytes);
    tampered[100] = tampered[100]! ^ 0xff;
    await expect(run(dir, fakeTransport({ [OFFICIAL_PATH]: ok(tampered) }))).rejects.toMatchObject({
      code: "MODEL_CHECKSUM_MISMATCH",
      retryable: false,
    });
    expect(readdirSync(dir)).toEqual([]);
  });

  it("keeps the partial temp on interruption and resumes with a validated Range", async () => {
    const dir = tempDir();
    const half = 8192 * 5;
    const interrupted: Route = () => ({
      status: 200,
      headers: { "content-length": String(fixtureBytes.byteLength) },
      body: chunks(fixtureBytes, 8192, half),
    });
    await expect(run(dir, fakeTransport({ [OFFICIAL_PATH]: interrupted }))).rejects.toMatchObject({
      code: "MODEL_DOWNLOAD_FAILED",
      retryable: true,
    });
    const partial = readdirSync(dir);
    expect(partial).toHaveLength(1);
    expect(statSync(join(dir, partial[0]!)).size).toBe(half);

    const resumed: Route = (req) => {
      expect(req.headers.range).toBe(`bytes=${half}-`);
      return {
        status: 206,
        headers: {
          "content-range": `bytes ${half}-${fixtureBytes.byteLength - 1}/${fixtureBytes.byteLength}`,
          "content-length": String(fixtureBytes.byteLength - half),
        },
        body: chunks(fixtureBytes.subarray(half)),
      };
    };
    const transport = fakeTransport({ [OFFICIAL_PATH]: resumed });
    const { result } = await run(dir, transport);
    expect(result.outcome).toBe("PUBLISHED");
    expect(readFileSync(join(dir, QWEN_ARTIFACT.fileName)).equals(fixtureBytes)).toBe(true);
    expect(readdirSync(dir)).toEqual([QWEN_ARTIFACT.fileName]);
  });

  it("restarts from zero when a resumed request gets a full 200 and rejects a bad Content-Range", async () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, `.${QWEN_ARTIFACT.fileName}.e1.partial`),
      fixtureBytes.subarray(0, 100),
    );
    await expect(run(dir, fakeTransport({ [OFFICIAL_PATH]: ok() }))).resolves.toMatchObject({
      result: { outcome: "PUBLISHED" },
    });
    const dir2 = tempDir();
    writeFileSync(
      join(dir2, `.${QWEN_ARTIFACT.fileName}.e1.partial`),
      fixtureBytes.subarray(0, 100),
    );
    const badRange: Route = () => ({
      status: 206,
      headers: {
        "content-range": `bytes 0-${fixtureBytes.byteLength - 1}/${fixtureBytes.byteLength}`,
      },
      body: chunks(fixtureBytes),
    });
    await expect(run(dir2, fakeTransport({ [OFFICIAL_PATH]: badRange }))).rejects.toMatchObject({
      code: "MODEL_DOWNLOAD_FAILED",
    });
    expect(existsSync(join(dir2, QWEN_ARTIFACT.fileName))).toBe(false);
  });

  it("sweeps other epochs' temps and never overwrites a verified published file", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, `.${QWEN_ARTIFACT.fileName}.e0.partial`), "stale");
    writeFileSync(join(dir, QWEN_ARTIFACT.fileName), fixtureBytes);
    const before = statSync(join(dir, QWEN_ARTIFACT.fileName)).ino;
    const transport = fakeTransport({});
    const { result } = await run(dir, transport);
    expect(result.outcome).toBe("ALREADY_PRESENT");
    expect(transport.seen).toHaveLength(0);
    expect(statSync(join(dir, QWEN_ARTIFACT.fileName)).ino).toBe(before);
    expect(readdirSync(dir)).toEqual([QWEN_ARTIFACT.fileName]);
  });

  it("an old attempt finishing after a newer publish cannot replace the verified file", async () => {
    const dir = tempDir();
    let publishRace: (() => void) | undefined;
    const transport = fakeTransport({ [OFFICIAL_PATH]: ok() });
    const { result } = await run(dir, transport, lookupFrom(PUBLIC), {
      beforePublish: async () => {
        // A newer epoch publishes first while this attempt is between verify and link.
        writeFileSync(join(dir, QWEN_ARTIFACT.fileName), fixtureBytes);
        publishRace = () => undefined;
        return true;
      },
    });
    expect(publishRace).toBeDefined();
    expect(result.outcome).toBe("ALREADY_PRESENT");
    expect(readdirSync(dir)).toEqual([QWEN_ARTIFACT.fileName]);
  });

  it("does not publish when the epoch is superseded before publication", async () => {
    const dir = tempDir();
    await expect(
      run(dir, fakeTransport({ [OFFICIAL_PATH]: ok() }), lookupFrom(PUBLIC), {
        beforePublish: async () => false,
      }),
    ).rejects.toMatchObject({ code: "MODEL_CANCELLED" });
    expect(readdirSync(dir)).toEqual([]);
  });

  it("replaces an unverified file at the final path only after re-downloading", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, QWEN_ARTIFACT.fileName), "corrupt");
    await expect(verifyPublishedArtifact(dir, expected)).resolves.toBe(false);
    const { result } = await run(dir, fakeTransport({ [OFFICIAL_PATH]: ok() }));
    expect(result.outcome).toBe("PUBLISHED");
    await expect(verifyPublishedArtifact(dir, expected)).resolves.toBe(true);
  });

  it("cancellation aborts the stream and removes temp", async () => {
    const dir = tempDir();
    const controller = new AbortController();
    const stalled: Route = (req) => ({
      status: 200,
      headers: {},
      body: (async function* () {
        yield fixtureBytes.subarray(0, 1024);
        await new Promise((_resolve, reject) =>
          req.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
        );
      })(),
    });
    const pending = downloadModelArtifact({
      dir,
      epoch: 1,
      expected,
      signal: controller.signal,
      onProgress: () => {
        controller.abort();
      },
      deps: { transport: fakeTransport({ [OFFICIAL_PATH]: stalled }), lookup: lookupFrom(PUBLIC) },
    });
    await expect(pending).rejects.toBeInstanceOf(ModelArtifactError);
    await expect(pending).rejects.toMatchObject({ code: "MODEL_CANCELLED" });
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("artifact durability failures", { timeout: 30_000 }, () => {
  it.each(["file-sync", "file-close", "directory-sync", "directory-close"])(
    "discards %s failure and downloads a new file on retry",
    async (fault) => {
      const dir = tempDir();
      const sample = await open(join(dir, "sample"), "wx");
      const proto = Object.getPrototypeOf(sample) as FileHandle;
      await sample.close();
      let injected = false;
      const target = (path: string) =>
        fault.startsWith("file")
          ? path.endsWith(".partial")
          : path === dir && existsSync(join(dir, expected.fileName));
      if (fault.endsWith("close")) {
        closeFault.wrap = (handle, path) => {
          const original = handle.close;
          handle.close = async () => {
            await original();
            if (!injected && target(path)) {
              injected = true;
              throw Object.assign(new Error("injected close failure"), { code: "EIO" });
            }
          };
        };
      } else {
        const sync = proto.sync;
        vi.spyOn(proto, "sync").mockImplementation(async function (this: FileHandle) {
          const path = await import("node:fs/promises").then((fs) =>
            fs.readlink(`/proc/self/fd/${this.fd}`),
          );
          if (!injected && target(path)) {
            injected = true;
            throw Object.assign(new Error("injected sync failure"), { code: "EIO" });
          }
          return sync.call(this);
        });
      }
      try {
        await expect(run(dir, fakeTransport({ [OFFICIAL_PATH]: ok() }))).rejects.toMatchObject({
          code: "MODEL_DOWNLOAD_FAILED",
          retryable: false,
        });
      } finally {
        closeFault.wrap = null;
        vi.restoreAllMocks();
      }
      expect(injected).toBe(true);
      expect(readdirSync(dir).filter((name) => name !== "sample")).toEqual([]);
      const fresh = fakeTransport({ [OFFICIAL_PATH]: ok() });
      await expect(run(dir, fresh)).resolves.toMatchObject({ result: { outcome: "PUBLISHED" } });
      expect(fresh.seen).toHaveLength(1);
      expect(fresh.seen[0]?.headers.range).toBeUndefined();
      expect(await verifyPublishedArtifact(dir, expected)).toBe(true);
    },
  );

  it.each([1, 2])(
    "keeps recovery intent when publication barrier %i and cleanup fail, then discards before a fresh retry",
    async (barrier) => {
      const dir = tempDir();
      const sample = await open(join(dir, "sample"), "wx");
      const proto = Object.getPrototypeOf(sample) as FileHandle;
      await sample.close();
      const original = proto.sync;
      let poisoned = false;
      let publicationBarriers = 0;
      const hook = vi.spyOn(proto, "sync").mockImplementation(async function (this: FileHandle) {
        const { readlink } = await import("node:fs/promises");
        const path = await readlink(`/proc/self/fd/${this.fd}`);
        if (
          path === dir &&
          (poisoned ||
            (existsSync(join(dir, expected.fileName)) && ++publicationBarriers === barrier))
        ) {
          poisoned = true;
          throw Object.assign(new Error("persistent directory I/O failure"), { code: "EIO" });
        }
        return original.call(this);
      });
      try {
        await expect(run(dir, fakeTransport({ [OFFICIAL_PATH]: ok() }))).rejects.toMatchObject({
          code: "MODEL_DOWNLOAD_FAILED",
          retryable: false,
        });
        expect(existsSync(join(dir, `.${expected.fileName}.publication`))).toBe(true);
        expect(existsSync(join(dir, expected.fileName))).toBe(false);
      } finally {
        hook.mockRestore();
      }
      const fresh = fakeTransport({ [OFFICIAL_PATH]: ok() });
      await expect(run(dir, fresh)).resolves.toMatchObject({ result: { outcome: "PUBLISHED" } });
      expect(fresh.seen).toHaveLength(1);
      expect(fresh.seen[0]?.headers.range).toBeUndefined();
      expect(existsSync(join(dir, `.${expected.fileName}.publication`))).toBe(false);
    },
  );

  it.each(["file-sync", "directory-sync", "settled-publication"])(
    "recovers a killed publisher during %s according to its durable receipt",
    { timeout: 20_000 },
    async (stage) => {
      const dir = tempDir();
      const source = `
        import { open, readlink, readFile } from 'node:fs/promises';
        import { existsSync } from 'node:fs';
        import { join } from 'node:path';
        import { downloadModelArtifact } from ${JSON.stringify(new URL("./model-artifact.ts", import.meta.url).href)};
        const dir = process.argv[1], stage = process.argv[2];
        const expected = ${JSON.stringify(expected)};
        const bytes = Buffer.from(${JSON.stringify(fixtureBytes.toString("base64"))}, 'base64');
        const sample = await open(join(dir, 'sample'), 'wx');
        const proto = Object.getPrototypeOf(sample), sync = proto.sync;
        await sample.close();
        proto.sync = async function () {
          const path = await readlink('/proc/self/fd/' + this.fd);
          const marker = join(dir, '.' + expected.fileName + '.publication');
          const target = stage === 'file-sync' ? path.endsWith('.partial') : stage === 'settled-publication'
            ? path === dir && existsSync(marker) && (await readFile(marker, 'utf8')) === 'PUBLISHED:' + expected.sha256
            : path === dir && existsSync(join(dir, expected.fileName));
          if (target) {
            process.send('barrier');
            await new Promise(() => { setInterval(() => {}, 1000); });
          }
          return sync.call(this);
        };
        await downloadModelArtifact({dir, epoch:1, expected, signal:new AbortController().signal,
          onProgress:() => {}, deps:{
            lookup:(_host,_opts,cb) => cb(null,[{address:'18.160.1.1',family:4}]),
            transport:{request:async() => ({status:200,headers:{},body:(async function*(){yield bytes;})()})}
          }});
      `;
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", source, dir, stage],
        {
          stdio: ["ignore", "ignore", "pipe", "ipc"],
        },
      );
      let stderr = "";
      child.stderr?.on("data", (data) => {
        stderr += String(data);
      });
      try {
        await Promise.race([
          once(child, "message"),
          once(child, "exit").then(() => {
            throw new Error(`publisher exited before barrier: ${stderr}`);
          }),
        ]);
        expect(existsSync(join(dir, `.${expected.fileName}.publication`))).toBe(true);
      } finally {
        const closed = once(child, "close");
        child.kill("SIGKILL");
        await closed;
      }
      const fresh = fakeTransport({ [OFFICIAL_PATH]: ok() });
      const settled = stage === "settled-publication";
      await expect(run(dir, fresh)).resolves.toMatchObject({
        result: { outcome: settled ? "ALREADY_PRESENT" : "PUBLISHED" },
      });
      expect(fresh.seen).toHaveLength(settled ? 0 : 1);
      if (!settled) expect(fresh.seen[0]?.headers.range).toBeUndefined();
      expect(existsSync(join(dir, `.${expected.fileName}.publication`))).toBe(false);
      expect(await verifyPublishedArtifact(dir, expected)).toBe(true);
    },
  );
});
