import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  KB_DATA_LAYOUT as SCRIPT_LAYOUT,
  kbDataPaths as scriptKbDataPaths,
} from "../../../scripts/init-kb-volumes.mjs";
import {
  assertLocalFilesystem,
  assertLocalKbDataRoot,
  assertPathInside,
  filesystemTypeFor,
  GIT_HTTP_BACKEND_PATH,
  KB_DATA_LAYOUT,
  kbDataPaths,
  parseMountinfo,
  privateDir,
  stagingRoot,
} from "./topology.js";

const EXT4_MOUNTINFO = `22 1 8:1 / / rw,relatime - ext4 /dev/sda1 rw
36 22 0:21 / /tmp rw,nosuid,nodev - tmpfs tmpfs rw
`;

const NFS_MOUNTINFO = `22 1 8:1 / / rw - ext4 /dev/sda1 rw
40 22 0:47 / /var/lib/knowledge-base rw - nfs4 10.0.0.5:/export rw
`;

describe("kb topology", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("parses mountinfo and rejects network filesystems", () => {
    const mounts = parseMountinfo(EXT4_MOUNTINFO);
    expect(filesystemTypeFor("/var/lib/knowledge-base/repos", mounts)).toBe("ext4");
    expect(
      assertLocalFilesystem("/var/lib/knowledge-base/repos", { mountinfo: EXT4_MOUNTINFO }),
    ).toBe("ext4");
    expect(() =>
      assertLocalFilesystem("/var/lib/knowledge-base/repos", {
        mountinfo: NFS_MOUNTINFO,
        label: "KB_DATA_ROOT",
      }),
    ).toThrow(/network filesystem nfs4/);
    expect(() =>
      assertLocalKbDataRoot("/var/lib/knowledge-base", { mountinfo: NFS_MOUNTINFO }),
    ).toThrow(/KB_DATA_ROOT is on network filesystem nfs4/);
  });

  it("derives one layout identical to the dependency-free init script", () => {
    expect(KB_DATA_LAYOUT).toEqual(SCRIPT_LAYOUT);
    for (const root of ["/var/lib/knowledge-base", "/srv/kb-data/", "/tmp/a/../b"]) {
      expect(kbDataPaths(root)).toEqual(scriptKbDataPaths(root));
    }
    expect(kbDataPaths("/var/lib/knowledge-base")).toEqual({
      reposDir: "/var/lib/knowledge-base/repos",
      assetsDir: "/var/lib/knowledge-base/assets",
      modelsDir: "/var/lib/knowledge-base/models",
      indexDir: "/var/lib/knowledge-base/index",
    });
  });

  it("keeps staging under the assets volume and rejects escapes", () => {
    expect(stagingRoot("/var/lib/knowledge-base/assets")).toBe(
      "/var/lib/knowledge-base/assets/.private/staging",
    );
    expect(() => privateDir("/var/lib/knowledge-base/assets", "..")).toThrow(/plain directory/);
    expect(
      assertPathInside(
        "/var/lib/knowledge-base/assets",
        "/var/lib/knowledge-base/assets/.private/tmp",
      ),
    ).toBe("/var/lib/knowledge-base/assets/.private/tmp");
    expect(() =>
      assertPathInside("/var/lib/knowledge-base/assets", "/var/lib/knowledge-base/repos/x"),
    ).toThrow(/escapes volume root/);
  });

  it("refuses a symlink data root without following it", () => {
    const root = mkdtempSync(join(tmpdir(), "kb-topo-"));
    dirs.push(root);
    const target = join(root, "secret");
    const data = join(root, "data");
    mkdirSync(target);
    writeFileSync(join(target, "marker"), "keep");
    symlinkSync(target, data);
    expect(() => assertLocalKbDataRoot(data, { mountinfo: EXT4_MOUNTINFO })).toThrow(
      /must not be a symlink/,
    );
  });

  it("refuses a symlink parent without following it onto another tree", () => {
    const root = mkdtempSync(join(tmpdir(), "kb-topo-parent-"));
    dirs.push(root);
    const target = join(root, "secret");
    mkdirSync(target);
    writeFileSync(join(target, "marker"), "keep");
    const link = join(root, "link");
    symlinkSync(target, link);
    expect(() => assertLocalKbDataRoot(join(link, "data"), { mountinfo: EXT4_MOUNTINFO })).toThrow(
      /must not be a symlink/,
    );
    expect(readFileSync(join(target, "marker"), "utf8")).toBe("keep");
    expect(existsSync(join(target, "data"))).toBe(false);
  });

  it("pins git-http-backend to the Debian git-core path", () => {
    expect(GIT_HTTP_BACKEND_PATH).toBe("/usr/lib/git-core/git-http-backend");
  });
});
