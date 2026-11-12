import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initKbVolumes } from "../../../../../scripts/init-kb-volumes.mjs";
import { casBlobPath, createDiskBlobStore } from "./blob-store-disk";
import { publishCasBytes } from "./cas";
import { alternatePng, minimalPng, minimalWav, sha256Buffer } from "./fixtures/media-bytes";

// The temp name must be predictable for the swap attack; pin the generator.
const pinnedUuid = vi.hoisted(() => "race-pinned-temp-name");
const pinnedTempName = `cas-${pinnedUuid}`;

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomUUID: () => pinnedUuid };
});

// Inject real filesystem writes at exact synchronous boundaries; reads, links
// and metadata all still use the real filesystem. No timing sleeps.
const fsRace = vi.hoisted(() => ({
  afterRead: undefined as (() => void) | undefined,
  beforeLink: undefined as (() => void) | undefined,
  afterLink: undefined as (() => void) | undefined,
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readSync: (...args: Parameters<typeof actual.readSync>) => {
      const read = actual.readSync(...args);
      const attack = fsRace.afterRead;
      fsRace.afterRead = undefined;
      attack?.();
      return read;
    },
    linkSync: (...args: Parameters<typeof actual.linkSync>) => {
      fsRace.beforeLink?.();
      actual.linkSync(...args);
      fsRace.afterLink?.();
    },
  };
});

// Retain real durable publication at the race boundary with the same finite
// fixture-I/O allowance as the sibling cas publication suite.
describe("cas temp-root swap race", { timeout: 180_000 }, () => {
  const roots: string[] = [];
  afterEach(() => {
    fsRace.afterRead = fsRace.beforeLink = fsRace.afterLink = undefined;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function layout(): { assets: string; root: string } {
    const root = mkdtempSync(join(tmpdir(), "kb-cas-race-"));
    roots.push(root);
    const assets = join(root, "assets");
    mkdirSync(join(root, "repos"));
    mkdirSync(join(root, "models"));
    initKbVolumes({ KB_DATA_ROOT: root });
    return { assets, root };
  }

  it.each(["afterRead", "beforeLink", "afterLink"] as const)(
    "rejects a temp rewrite at %s even when mtime is restored",
    async (phase) => {
      const { assets } = layout();
      const bytes = minimalWav();
      const replacement = Buffer.from(bytes);
      replacement[replacement.length - 1] = 0xff;
      const tempPath = join(assets, ".private", "tmp", pinnedTempName);
      // An integral timestamp can be restored exactly by the attacker. ctime
      // cannot, except that publication itself necessarily changes it on link.
      const modifiedAt = new Date("2000-01-01T00:00:00Z");
      async function* stream() {
        yield bytes;
        utimesSync(tempPath, modifiedAt, modifiedAt);
      }
      let attacked = false;
      fsRace[phase] = () => {
        writeFileSync(tempPath, replacement);
        utimesSync(tempPath, modifiedAt, modifiedAt);
        attacked = true;
      };
      let reachedDurableBytes = false;
      await expect(
        publishCasBytes({
          blobStore: createDiskBlobStore(assets),
          declaredMime: "audio/wav",
          declaredHash: sha256Buffer(bytes),
          declaredSize: bytes.length,
          bytes: stream(),
          afterDurableBytes: async () => {
            reachedDurableBytes = true;
          },
        }),
      ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
      expect(attacked).toBe(true);
      expect(reachedDurableBytes).toBe(false);
      expect(existsSync(tempPath)).toBe(false);
    },
  );

  it("publishes the verified bytes and never touches the attacker's swap target", async () => {
    const { assets, root } = layout();
    const legit = minimalPng();
    const attacker = alternatePng();
    const outside = join(root, "outside");
    mkdirSync(outside);
    // Attacker plants different valid media under the generated temp name.
    writeFileSync(join(outside, pinnedTempName), attacker);

    const tmpDir = join(assets, ".private", "tmp");
    async function* stream(): AsyncIterable<Buffer> {
      yield legit.subarray(0, 20);
      // Swap the tmp root mid-stream: move the real directory aside and
      // symlink its old location to the attacker-controlled directory.
      renameSync(tmpDir, `${tmpDir}-real`);
      symlinkSync(outside, tmpDir);
      yield legit.subarray(20);
    }

    const published = await publishCasBytes({
      blobStore: createDiskBlobStore(assets),
      declaredMime: "image/png",
      declaredHash: sha256Buffer(legit),
      declaredSize: legit.length,
      bytes: stream(),
    });

    // The published blob is exactly the streamed, verified bytes.
    expect(published.hash).toBe(sha256Buffer(legit));
    expect(published.durability.newBytes).toBe(true);
    expect(readFileSync(casBlobPath(assets, published.hash)).equals(legit)).toBe(true);

    // The attacker's planted file was neither linked nor deleted.
    const plantedPath = join(outside, pinnedTempName);
    expect(readFileSync(plantedPath).equals(attacker)).toBe(true);

    // Cleanup resolved through the pinned directory: our temp name was
    // removed from the real (renamed) directory, not from the swap target.
    expect(existsSync(join(`${tmpDir}-real`, pinnedTempName))).toBe(false);
  });
});
