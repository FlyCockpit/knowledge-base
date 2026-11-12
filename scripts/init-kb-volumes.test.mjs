import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  checkMigrationArtifacts,
  ensureKbDataSkeleton,
  initKbVolumes,
  isSkeletonOnly,
  KB_DATA_LAYOUT,
  kbDataPaths,
} from "./init-kb-volumes.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempRoot(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(root);
  return root;
}

describe("initKbVolumes", () => {
  it("restores owner access on existing roots while preserving other permission bits", () => {
    const root = join(tempRoot("kb-vol-permissions-"), "data");
    initKbVolumes({ KB_DATA_ROOT: root });
    const paths = [root, ...Object.values(kbDataPaths(root))];
    for (const path of paths) chmodSync(path, 0o1555);
    initKbVolumes({ KB_DATA_ROOT: root });
    for (const path of paths) {
      assert.equal(lstatSync(path).mode & 0o7777, 0o1755);
      writeFileSync(join(path, "owner-write"), "ok");
    }
  });

  it("refuses a symlinked data root without writing through it", () => {
    const root = tempRoot("kb-vol-");
    const target = join(root, "secret");
    mkdirSync(target);
    writeFileSync(join(target, "marker"), "keep");
    const data = join(root, "data");
    symlinkSync(target, data);
    assert.throws(
      () => initKbVolumes({ KB_DATA_ROOT: data, KB_RUNTIME_UID: "1000", KB_RUNTIME_GID: "1000" }),
      /symlink/,
    );
    assert.equal(readFileSync(join(target, "marker"), "utf8"), "keep");
    assert.equal(existsSync(join(target, "repos")), false);
    assert.equal(lstatSync(data).isSymbolicLink(), true);
  });

  it("creates the whole role-free skeleton, including models and index", () => {
    const root = tempRoot("kb-vol-ok-");
    const result = initKbVolumes({ KB_DATA_ROOT: root });
    assert.equal(result.root, root);
    assert.equal(result.reposDir, join(root, "repos"));
    for (const dir of [
      "repos/.private/tmp",
      "assets/.private/staging",
      "assets/.private/tmp",
      "models/.private/tmp",
      "index",
    ]) {
      const st = lstatSync(join(root, dir));
      assert.equal(st.isDirectory() && !st.isSymbolicLink(), true, dir);
    }
    for (const fence of ["server.fence", "worker.fence"]) {
      const st = lstatSync(join(root, "repos/.private", fence));
      assert.equal(st.isFile() && !st.isSymbolicLink(), true, fence);
    }
  });

  it("refuses a symlink skeleton child without writing through it", () => {
    const root = tempRoot("kb-vol-child-");
    mkdirSync(join(root, "assets"));
    const target = join(root, "secret-private");
    mkdirSync(target);
    writeFileSync(join(target, "marker"), "keep");
    symlinkSync(target, join(root, "assets/.private"));
    assert.throws(() => initKbVolumes({ KB_DATA_ROOT: root }), /symlink/);
    assert.equal(readFileSync(join(target, "marker"), "utf8"), "keep");
    assert.equal(existsSync(join(target, "staging")), false);
  });

  it("refuses a symlink parent without creating children in the target", () => {
    const root = tempRoot("kb-vol-parent-");
    const target = join(root, "secret");
    mkdirSync(target);
    writeFileSync(join(target, "marker"), "keep");
    const link = join(root, "link");
    symlinkSync(target, link);
    assert.throws(() => initKbVolumes({ KB_DATA_ROOT: join(link, "data") }), /symlink/);
    assert.equal(readFileSync(join(target, "marker"), "utf8"), "keep");
    assert.equal(existsSync(join(target, "data")), false);
    assert.equal(lstatSync(link).isSymbolicLink(), true);
  });

  it("rejects a relative data root", () => {
    assert.throws(() => initKbVolumes({ KB_DATA_ROOT: "relative/data" }), /absolute/);
    assert.equal(existsSync("relative"), false);
  });
});

describe("data layout", () => {
  it("derives every surface from one root", () => {
    assert.deepEqual(KB_DATA_LAYOUT, {
      repos: "repos",
      assets: "assets",
      models: "models",
      index: "index",
    });
    assert.deepEqual(kbDataPaths("/var/lib/knowledge-base/"), {
      reposDir: "/var/lib/knowledge-base/repos",
      assetsDir: "/var/lib/knowledge-base/assets",
      modelsDir: "/var/lib/knowledge-base/models",
      indexDir: "/var/lib/knowledge-base/index",
    });
  });

  it("treats a bare, partial or full skeleton as empty and anything else as occupied", () => {
    const root = tempRoot("kb-vol-skeleton-");
    assert.equal(isSkeletonOnly(join(root, "missing")), true);
    assert.equal(isSkeletonOnly(root), true);
    mkdirSync(join(root, "repos"));
    assert.equal(isSkeletonOnly(root), true);
    ensureKbDataSkeleton(root);
    assert.equal(ensureKbDataSkeleton(root), root);
    assert.equal(isSkeletonOnly(root), true);
    for (const stray of [
      "stray",
      "repos/kb_abc.git",
      "repos/.private/restore-x",
      "assets/objects",
      "assets/.private/staging/upload",
      "models/model.gguf",
      "index/g1.sqlite",
    ]) {
      writeFileSync(join(root, stray), "x");
      assert.equal(isSkeletonOnly(root), false, stray);
      rmSync(join(root, stray));
      assert.equal(isSkeletonOnly(root), true, stray);
    }
    // A skeleton name with the wrong type is not skeleton.
    rmSync(join(root, "index"), { recursive: true });
    writeFileSync(join(root, "index"), "x");
    assert.equal(isSkeletonOnly(root), false);
    rmSync(join(root, "index"));
    symlinkSync(join(root, "repos"), join(root, "index"));
    assert.equal(isSkeletonOnly(root), false);
  });
});

describe("image skeleton", () => {
  // The canonical copy-up RUN, identical in both runner images, each
  // preceded in its stage by the data-root ENV it relies on.
  const RUN =
    "RUN mkdir -p /var/lib/knowledge-base && KB_RUNTIME_UID=1000 KB_RUNTIME_GID=1000 node scripts/init-kb-volumes.mjs";
  for (const file of ["Dockerfile", "Dockerfile.worker"]) {
    it(`${file} carries the canonical skeleton RUN after ENV KB_DATA_ROOT`, () => {
      const logical = readFileSync(join(ROOT, file), "utf8")
        .replace(/\\\n/g, " ")
        .split("\n")
        .map((line) => line.replace(/\s+/g, " ").trim());
      const runs = logical
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => line.startsWith("RUN mkdir -p /var/lib/knowledge-base"));
      assert.equal(runs.length, 1);
      assert.equal(runs[0].line, RUN);
      const stage = logical.findLastIndex(
        (line, index) => index < runs[0].index && /^FROM /i.test(line),
      );
      const env = logical.findLastIndex(
        (line, index) =>
          index < runs[0].index &&
          /^ENV\b.*\bKB_DATA_ROOT=\/var\/lib\/knowledge-base(\s|$)/.test(line),
      );
      assert.ok(env > stage, "ENV KB_DATA_ROOT must precede the RUN in the same stage");
    });
  }
});

describe("migration artifact admission", () => {
  it("requires committed init, every migration and the guarded tooling", () => {
    const root = tempRoot("kb-artifacts-");
    const migration = join(root, "packages/db/prisma/migrations");
    mkdirSync(join(migration, "0_init"), { recursive: true });
    mkdirSync(join(migration, "20261111_next"));
    const checked = [];
    checkMigrationArtifacts(root, (path) => checked.push(path));
    for (const suffix of [
      "0_init/migration.sql",
      "20261111_next/migration.sql",
      "migration_lock.toml",
      "prisma-owner.mjs",
      "bounded-child.mjs",
      "pre-migrate.sh",
    ])
      assert.ok(
        checked.some((path) => path.endsWith(suffix)),
        suffix,
      );
    assert.throws(() => checkMigrationArtifacts(root));
    for (const path of checked) {
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, "artifact");
    }
    assert.doesNotThrow(() => checkMigrationArtifacts(root));
    rmSync(join(migration, "20261111_next/migration.sql"));
    assert.throws(() => checkMigrationArtifacts(root), /ENOENT/);
  });
});
