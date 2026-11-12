import assert from "node:assert/strict";
import { test } from "node:test";
import { casOwnershipViolations } from "./check-cas-ownership.mjs";

const runtime = "packages/api/src/lib/kb/new-consumer.ts";
for (const source of [
  'import { casBlobPath as hidden } from "./blob-store-disk"; hidden(root, hash);',
  "fs.readFileSync(casBlobPath(root, hash));",
  "readCasBlobSync(path);",
  "openCasShardDir(root, shard, leaf);",
  'fs.openSync(join(runtime.assetsDir, "objects", shard, leaf), flags);',
  'open("/data/assets/objects/aa/bb");',
])
  test(`rejects CAS bypass: ${source}`, () => {
    assert.ok(casOwnershipViolations(runtime, source).length);
  });

test("explicit disk fixture permits path assertions, not publishing descriptor bypasses", () => {
  const fixture = "packages/api/src/lib/kb/cas.test.ts";
  assert.deepEqual(casOwnershipViolations(fixture, "readFileSync(casBlobPath(root, hash));"), []);
  assert.ok(casOwnershipViolations(fixture, "openCasShardDir(root, shard, leaf);").length);
  assert.ok(casOwnershipViolations(fixture, "readCasBlobSync(path);").length);
});

test("offline exceptions are limited to raw disk inventory, not a sync-reader escape hatch", () => {
  const path = "scripts/lib/kb-backup.mjs";
  assert.deepEqual(casOwnershipViolations(path, 'collect(join(assetsDir, "objects"));'), []);
  assert.ok(casOwnershipViolations(path, "readCasBlobSync(path);").length);
});

test("disk-only modules cannot import ambient services or the S3 SDK", () => {
  for (const module of ["@aws-sdk/client-s3", "@knowledge-base/db", "@knowledge-base/env/server"])
    assert.ok(
      casOwnershipViolations(
        "packages/api/src/lib/kb/blob-store-disk.ts",
        `import x from "${module}";`,
      ).length,
    );
});

test("dynamic imports cannot activate remote services inside disk storage", () => {
  for (const source of ['await import("@aws-sdk/client-s3");', 'require("@knowledge-base/db");'])
    assert.ok(casOwnershipViolations("packages/api/src/lib/kb/blob-store-disk.ts", source).length);
});

test("keeps Git objects, staging, ZIP artifacts, metadata, and factory injection available", () => {
  for (const source of [
    'open(join(reposDir, "objects", hash));',
    'open(procChild(tmp.fd, "push-generated"));',
    'open(join(assetsDir, ".private", "tmp", "export-id"));',
    'import { createDiskBlobStore } from "./blob-store-disk"; const blobStore = createDiskBlobStore(assetsDir);',
    'const manifest = "assets/objects/metadata-only";',
  ])
    assert.deepEqual(casOwnershipViolations(runtime, source), []);
});

test("parse errors fail closed", () => {
  assert.ok(casOwnershipViolations(runtime, "import {").length);
});
