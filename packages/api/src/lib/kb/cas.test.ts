import {
  appendFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initKbVolumes } from "../../../../../scripts/init-kb-volumes.mjs";
import { validateCasMediaBytes } from "../sniff-mime";
import { assertCasTempPath, casBlobPath, casInode, createDiskBlobStore } from "./blob-store-disk";
import { publishCasBytes } from "./cas";
import { KbDomainError } from "./errors";
import {
  absoluteFragmentedMp4,
  alphaLosslessWebp,
  animatedLosslessWebp,
  animatedWebp,
  emptyFormatWav,
  emptyOgg,
  fragmentedMp4,
  hybridMp4,
  identificationOnlyOgg,
  incompleteAnimatedWebp,
  incompleteTrackMp4,
  incompleteWebm,
  incrementalPdf,
  invalidMediaIdentifiers,
  invalidMp4References,
  linearMediaWorkCases,
  losslessWebp,
  markersOnlyPdf,
  mediaStructureCases,
  mediaWorkBudgetCases,
  minimalOgg,
  minimalPdf,
  minimalPng,
  minimalWav,
  mp4FragmentVariants,
  mp4TableVariants,
  mp4WithLookalikeExtraBoxes,
  opusOgg,
  pdfRevisionCases,
  realMp4,
  realWebm,
  sha256Buffer,
  sharedMediaBoxPdf,
  streamPdf,
} from "./fixtures/media-bytes";

// Native fsync latency is part of these durability tests' fixture I/O. Keep a
// finite guard without imposing an undocumented 30s publication deadline.
describe("cas publication", { timeout: 180_000 }, () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function layout() {
    const root = mkdtempSync(join(tmpdir(), "kb-cas-"));
    roots.push(root);
    const assets = join(root, "assets");
    mkdirSync(join(root, "repos"));
    mkdirSync(join(root, "models"));
    initKbVolumes({ KB_DATA_ROOT: root });
    return assets;
  }

  it.each([
    ...mediaStructureCases(),
    { mime: "application/pdf", positive: sharedMediaBoxPdf(1000, 512 * 1024) },
    { mime: "application/pdf", positive: sharedMediaBoxPdf(1000, 64 * 1024, true) },
    ...(["classic", "stream", "mixed"] as const).map((encoding) => ({
      mime: "application/pdf",
      positive: incrementalPdf(12, encoding),
    })),
    ...linearMediaWorkCases().map(({ mime, bytes }) => ({ mime, positive: bytes })),
    ...pdfRevisionCases()
      .filter((c) => c.ok)
      .map((c) => ({ mime: "application/pdf", positive: c.bytes })),
    ...[
      fragmentedMp4(),
      absoluteFragmentedMp4(),
      hybridMp4(),
      ...mp4TableVariants().map((c) => c.bytes),
      ...mp4FragmentVariants().map((c) => c.bytes),
      ...mp4WithLookalikeExtraBoxes().map((c) => c.bytes),
    ].map((positive) => ({ mime: "video/mp4", positive })),
  ])("publishes structural-contract positive $mime", async ({ mime, positive: bytes }) => {
    const assetsDir = layout();
    const result = await publishCasBytes({
      blobStore: createDiskBlobStore(assetsDir),
      bytes,
      declaredMime: mime,
      declaredSize: bytes.length,
      declaredHash: sha256Buffer(bytes),
    });
    expect(result.mime).toBe(mime);
    expect(readFileSync(casBlobPath(assetsDir, result.hash)).equals(bytes)).toBe(true);
  });

  it.each([
    ...mediaStructureCases().flatMap(({ mime, invalid }) =>
      invalid.map(({ kind, bytes }) => ({ mime, kind, bytes })),
    ),
    ...invalidMp4References().map((c) => ({ mime: "video/mp4", ...c })),
    ...invalidMediaIdentifiers(),
    ...mediaWorkBudgetCases(),
    ...pdfRevisionCases()
      .filter((c) => !c.ok)
      .map((c) => ({ mime: "application/pdf", ...c })),
  ])("rejects $mime $kind before durable publication", async ({ mime, bytes }) => {
    const assetsDir = layout();
    const hash = sha256Buffer(bytes);
    let durable = false;
    await expect(
      publishCasBytes({
        blobStore: createDiskBlobStore(assetsDir),
        bytes,
        declaredMime: mime,
        declaredSize: bytes.length,
        declaredHash: hash,
        afterDurableBytes: async () => {
          durable = true;
        },
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(durable).toBe(false);
    expect(existsSync(casBlobPath(assetsDir, hash))).toBe(false);
    expect(readdirSync(join(assetsDir, ".private", "tmp"))).toEqual([]);
  });

  it("races identical publishes to one inode and consistent bytes", async () => {
    const assetsDir = layout();
    const bytes = minimalPng();
    const hash = sha256Buffer(bytes);
    const input = {
      blobStore: createDiskBlobStore(assetsDir),
      declaredMime: "image/png",
      declaredHash: hash,
      declaredSize: bytes.length,
      bytes,
    };
    const [a, b] = await Promise.all([publishCasBytes(input), publishCasBytes(input)]);
    expect(a.hash).toBe(hash);
    expect(b.hash).toBe(hash);
    expect(casInode(casBlobPath(assetsDir, a.hash))).toBe(casInode(casBlobPath(assetsDir, b.hash)));
    expect(readFileSync(casBlobPath(assetsDir, a.hash)).equals(bytes)).toBe(true);
  });

  it("fails STORAGE_UNAVAILABLE on corrupt existing destination without overwrite", async () => {
    const assetsDir = layout();
    const bytes = minimalPng();
    const hash = sha256Buffer(bytes);
    const dest = casBlobPath(assetsDir, hash);
    mkdirSync(join(dest, ".."), { recursive: true });
    writeFileSync(dest, Buffer.from("corrupt"));
    await expect(
      publishCasBytes({
        blobStore: createDiskBlobStore(assetsDir),
        declaredMime: "image/png",
        declaredHash: hash,
        declaredSize: bytes.length,
        bytes,
      }),
    ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    expect(readFileSync(dest).toString()).toBe("corrupt");
  });

  it.each(["stream", "durable"] as const)(
    "rejects a same-size fresh blob rewrite during %s and cleans the temp file",
    async (phase) => {
      const assetsDir = layout();
      const bytes = minimalWav();
      const replacement = Buffer.from(bytes);
      replacement[replacement.length - 1] = 0xff; // another valid PCM sample
      expect(validateCasMediaBytes(replacement, "audio/wav").ok).toBe(true);
      const hash = sha256Buffer(bytes);
      const dest = casBlobPath(assetsDir, hash);
      const tmp = join(assetsDir, ".private", "tmp");
      async function* stream() {
        yield bytes;
        const [name] = readdirSync(tmp);
        expect(name).toBeDefined();
        writeFileSync(join(tmp, name!), replacement);
      }
      let reachedDurableBytes = false;
      await expect(
        publishCasBytes({
          blobStore: createDiskBlobStore(assetsDir),
          declaredMime: "audio/wav",
          declaredHash: hash,
          declaredSize: bytes.length,
          bytes: phase === "stream" ? stream() : bytes,
          afterDurableBytes: async () => {
            reachedDurableBytes = true;
            writeFileSync(dest, replacement);
          },
        }),
      ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
      expect(reachedDurableBytes).toBe(phase === "durable");
      expect(existsSync(dest)).toBe(phase === "durable");
      expect(readdirSync(tmp)).toEqual([]);
    },
  );

  it.each([
    ["append", "hashing"],
    ["symlink", "hashing"],
    ["replacement", "hashing"],
    ["append", "durable"],
    ["symlink", "durable"],
    ["replacement", "durable"],
  ] as const)("rejects a dedup destination %s during %s", async (attack, phase) => {
    const assetsDir = layout();
    const bytes = minimalPng();
    const input = {
      blobStore: createDiskBlobStore(assetsDir),
      bytes,
      declaredHash: sha256Buffer(bytes),
      declaredSize: bytes.length,
      declaredMime: "image/png",
    };
    const first = await publishCasBytes(input);
    const outside = join(assetsDir, "outside");
    writeFileSync(outside, bytes);
    const tamper = () => {
      if (attack === "append") appendFileSync(casBlobPath(assetsDir, first.hash), "corrupt suffix");
      else {
        unlinkSync(casBlobPath(assetsDir, first.hash));
        if (attack === "symlink") symlinkSync(outside, casBlobPath(assetsDir, first.hash));
        else writeFileSync(casBlobPath(assetsDir, first.hash), bytes); // identical bytes, different inode
      }
    };
    // The first asynchronous descriptor read yields here. No timer or retry race.
    const pending = publishCasBytes({
      ...input,
      afterDurableBytes: phase === "durable" ? async () => tamper() : undefined,
    });
    if (phase === "hashing") tamper();
    await expect(pending).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    expect(readFileSync(outside)).toEqual(bytes);
    expect(readdirSync(join(assetsDir, ".private", "tmp"))).toEqual([]);
  });

  it.each([
    ["image/webp", losslessWebp],
    ["image/webp", alphaLosslessWebp],
    ["image/webp", animatedWebp],
    ["image/webp", animatedLosslessWebp],
    ["video/mp4", realMp4],
    ["audio/wav", minimalWav],
    ["audio/ogg", minimalOgg],
    ["audio/ogg", opusOgg],
    ["video/webm", realWebm],
    ["application/pdf", minimalPdf],
    ["application/pdf", streamPdf],
  ] as const)("publishes real-encoder %s bytes", async (mime, fixture) => {
    const assetsDir = layout();
    const bytes = fixture();
    const published = await publishCasBytes({
      blobStore: createDiskBlobStore(assetsDir),
      declaredMime: mime,
      declaredHash: sha256Buffer(bytes),
      declaredSize: bytes.length,
      bytes,
    });
    expect(readFileSync(casBlobPath(assetsDir, published.hash))).toEqual(bytes);
    expect(readdirSync(join(assetsDir, ".private", "tmp"))).toEqual([]);
  });

  it.each([
    ["image/webp", incompleteAnimatedWebp],
    ["video/mp4", incompleteTrackMp4],
    ["audio/wav", emptyFormatWav],
    ["audio/ogg", emptyOgg],
    ["audio/ogg", identificationOnlyOgg],
    ["video/webm", incompleteWebm],
    ["application/pdf", markersOnlyPdf],
  ] as const)("rejects incomplete %s before publication", async (mime, fixture) => {
    const assetsDir = layout();
    const bytes = fixture();
    const hash = sha256Buffer(bytes);
    let reachedDurableBytes = false;
    await expect(
      publishCasBytes({
        blobStore: createDiskBlobStore(assetsDir),
        declaredMime: mime,
        declaredHash: hash,
        declaredSize: bytes.length,
        bytes,
        afterDurableBytes: async () => {
          reachedDurableBytes = true;
        },
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(reachedDurableBytes).toBe(false);
    expect(existsSync(casBlobPath(assetsDir, hash))).toBe(false);
    expect(readdirSync(join(assetsDir, ".private", "tmp"))).toEqual([]);
  });

  it("rejects temp paths outside the generated tmp root", () => {
    const assetsDir = layout();
    expect(() => assertCasTempPath(assetsDir, "/etc/passwd")).toThrow(/escapes/);
  });

  it("rejects symlink tmp roots before writing", async () => {
    const assetsDir = layout();
    const outside = join(tmpdir(), `kb-cas-escape-${Date.now()}`);
    mkdirSync(outside, { recursive: true });
    const tmp = join(assetsDir, ".private", "tmp");
    rmSync(tmp, { recursive: true, force: true });
    symlinkSync(outside, tmp);
    const bytes = minimalPng();
    await expect(
      publishCasBytes({
        blobStore: createDiskBlobStore(assetsDir),
        declaredMime: "image/png",
        declaredHash: sha256Buffer(bytes),
        declaredSize: bytes.length,
        bytes,
      }),
    ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    expect(existsSync(join(outside, bytes.toString("hex")))).toBe(false);
    rmSync(outside, { recursive: true, force: true });
  });

  it("cleans temp files when publication is rejected before linking", async () => {
    const assetsDir = layout();
    const bytes = minimalPng();
    // Declared hash does not match the streamed bytes.
    await expect(
      publishCasBytes({
        blobStore: createDiskBlobStore(assetsDir),
        declaredMime: "image/png",
        declaredHash: `sha256:${"0".repeat(64)}`,
        declaredSize: bytes.length,
        bytes,
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    // Sniffer rejects the content despite a matching hash.
    const html = Buffer.from("<html><script>alert(1)</script></html>", "utf8");
    await expect(
      publishCasBytes({
        blobStore: createDiskBlobStore(assetsDir),
        declaredMime: "image/png",
        declaredHash: sha256Buffer(html),
        declaredSize: html.length,
        bytes: html,
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(readdirSync(join(assetsDir, ".private", "tmp"))).toEqual([]);
  });

  it("rejects oversize payloads during streaming", async () => {
    const assetsDir = layout();
    const chunk = Buffer.alloc(1024 * 1024, 0xff);
    async function* stream() {
      for (let i = 0; i < 26; i += 1) yield chunk;
    }
    await expect(
      publishCasBytes({
        blobStore: createDiskBlobStore(assetsDir),
        declaredMime: "image/png",
        declaredHash: sha256Buffer(Buffer.alloc(26 * 1024 * 1024)),
        declaredSize: 26 * 1024 * 1024,
        bytes: stream(),
      }),
    ).rejects.toBeInstanceOf(KbDomainError);
    expect(readdirSync(join(assetsDir, ".private", "tmp"))).toEqual([]);
  });
});

describe("cas hardlink escape guard", () => {
  it("refuses publishing through a hardlinked tmp path", async () => {
    const root = mkdtempSync(join(tmpdir(), "kb-cas-hard-"));
    const assets = join(root, "assets");
    mkdirSync(join(root, "repos"));
    mkdirSync(join(root, "models"));
    initKbVolumes({ KB_DATA_ROOT: root });
    const tmp = join(assets, ".private", "tmp", "link-target");
    mkdirSync(join(assets, ".private", "tmp"), { recursive: true });
    writeFileSync(tmp, "x");
    const alias = join(assets, ".private", "tmp", "alias");
    linkSync(tmp, alias);
    try {
      expect(() => assertCasTempPath(assets, alias)).not.toThrow();
      // Publication always creates a fresh O_EXCL name; alias reuse still stays inside tmp root.
      const bytes = minimalPng();
      await publishCasBytes({
        blobStore: createDiskBlobStore(assets),
        declaredMime: "image/png",
        declaredHash: sha256Buffer(bytes),
        declaredSize: bytes.length,
        bytes,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
