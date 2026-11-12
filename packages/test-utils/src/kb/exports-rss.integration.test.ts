import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getHeapSpaceStatistics } from "node:v8";
import { prepareExport } from "@knowledge-base/api/lib/kb/exports";
import { completeExport, readTransfer } from "@knowledge-base/api/lib/kb/transfers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  artifactPath,
  asset,
  commit,
  fixture,
  prisma,
  registerExportHooks,
  released,
  request,
  root,
  runtime,
  s3Sources,
} from "./export-fixture";

registerExportHooks({ cleanAfterEach: false });

const S3_SELF = "packages/test-utils/src/kb/exports-s3-rss.integration.test.ts";
const SELF =
  process.env.KB_TEST_ISOLATED_FILE === S3_SELF
    ? S3_SELF
    : "packages/test-utils/src/kb/exports-rss.integration.test.ts";

type Base = Awaited<ReturnType<typeof fixture>>;
type Descriptor = Awaited<ReturnType<typeof prepareExport>>;

/**
 * A streaming client: reads every frame, decodes each frame's base64 text as
 * soon as it arrives (never holding it across the next frame's request), and
 * checks the whole-artifact hash. Acknowledges completion unless told not to.
 */
async function drain(base: Base, descriptor: Descriptor, acknowledge = true) {
  const hash = createHash("sha256");
  const readFrame = (offset: number) =>
    readTransfer(runtime, base.actor, {
      kbId: base.kbId,
      transferId: descriptor.transferId,
      offset,
    }).then((frame) => ({
      bytes: Buffer.from(frame.bytesBase64, "base64"),
      nextOffset: frame.nextOffset,
      eof: frame.eof,
    }));
  let offset = 0;
  for (;;) {
    const { bytes, nextOffset, eof } = await readFrame(offset);
    expect(bytes.length).toBeLessThanOrEqual(196608);
    hash.update(bytes);
    offset = nextOffset;
    if (eof) break;
  }
  expect(`sha256:${hash.digest("hex")}`).toBe(descriptor.contentHash);
  if (acknowledge)
    await completeExport(runtime, base.actor, {
      kbId: base.kbId,
      transferId: descriptor.transferId,
    });
  return offset;
}

/**
 * This file is the exports suite's isolated-first file. `pnpm test:kb
 * exports` runs it before everything else, alone, in its own Vitest process,
 * so no earlier test's heap can skew the RSS bound, with V8's young generation
 * pinned. The bound is unchanged.
 */
describe("exports RSS bound (isolated process)", () => {
  it("runs alone, first, in its own process", () => {
    expect(process.env.KB_TEST_ISOLATED_FILE).toBe(SELF);
    expect(process.env.KB_TEST_INCLUDE).toBe(SELF);
  });
  it("pins V8's young generation for the measurement", () => {
    // scripts/test-kb.mjs passes the flag to this isolated invocation only.
    expect(process.env.NODE_OPTIONS ?? "").toMatch(/(^|\s)--max-semi-space-size=\d+(\s|$)/);
    expect(typeof globalThis.gc).toBe("function");
  });
  let base: Base;
  let pinned: Base;
  let descriptor: Descriptor;
  let baseline = 0;
  let peak = 0;
  let sample: ReturnType<typeof setInterval> | undefined;
  let remote: Awaited<ReturnType<typeof s3Sources>> | undefined;
  beforeAll(async () => {
    base = await fixture();
    const entry = await asset(base, 25 * 1024 * 1024);
    const entries = Array.from({ length: 8 }, (_, i) => ({ ...entry, path: `media/${i}.wav` }));
    pinned = await commit(base, entries);
    if (SELF === S3_SELF) remote = await s3Sources([entry]);
  });
  afterAll(async () => {
    clearInterval(sample);
    await remote?.close();
  });
  const assertMemoryBound = () => {
    peak = Math.max(peak, process.memoryUsage().rss);
    expect(peak - baseline).toBeLessThan(160 * 1024 * 1024);
  };
  it("prepares a cold 200 MiB export within the product deadline with bounded RSS", async () => {
    // No warm-up export. Fixture creation is setup; this 120s
    // deadline belongs to prepare, not to 1000 subsequent client requests.
    globalThis.gc?.();
    baseline = process.memoryUsage().rss;
    peak = baseline;
    sample = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss);
    }, 5);
    descriptor = await prepareExport(
      remote?.runtime ?? runtime,
      base.actor,
      request(pinned, "assets"),
    );
    if (remote) {
      expect(
        await prisma.assetCacheEntry.count({ where: { cacheId: remote.binding.cacheId } }),
      ).toBe(0);
      expect(remote.http.requests.map((r) => r.method)).toEqual(Array(8).fill("GET"));
    }
    expect(descriptor.size).toBeGreaterThanOrEqual(200 * 1024 * 1024);
    assertMemoryBound();
  }, 120000);
  it("reconstructs every 200 MiB frame and hash with bounded RSS", async () => {
    expect(descriptor).toBeDefined();
    expect(await drain(base, descriptor, false)).toBe(descriptor.size);
    expect(existsSync(artifactPath(descriptor.transferId))).toBe(true);
    assertMemoryBound();
  }, 120000);
  it("independently unpacks the complete export and acknowledges release with bounded RSS", async () => {
    expect(descriptor).toBeDefined();
    const unpacked = join(root, `unpack-${randomUUID()}`);
    execFileSync("python3", [
      "-c",
      "import zipfile,sys,os; z=zipfile.ZipFile(sys.argv[1]); assert len(z.infolist())==8; assert sum(x.file_size for x in z.infolist())==200*1024*1024; z.extractall(sys.argv[2]); assert all(os.path.getsize(os.path.join(sys.argv[2],x.filename))==25*1024*1024 for x in z.infolist())",
      artifactPath(descriptor.transferId),
      unpacked,
    ]);
    await completeExport(runtime, base.actor, {
      kbId: base.kbId,
      transferId: descriptor.transferId,
    });
    await released(descriptor.transferId, "DOWNLOADED");
    const newSpace = getHeapSpaceStatistics().find((s) => s.space_name === "new_space");
    process.stdout.write(
      `200 MiB ${remote ? "S3" : "disk"} export peak RSS growth: ${Math.ceil((peak - baseline) / 1024 / 1024)} MiB (new space ${Math.ceil((newSpace?.space_size ?? 0) / 1024 / 1024)} MiB)\n`,
    );
    expect(newSpace?.space_size ?? Infinity).toBeLessThanOrEqual(16 * 1024 * 1024);
    assertMemoryBound();
  }, 120000);
});
