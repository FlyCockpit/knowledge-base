import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { assertNoStorageMigration, assertStorageConfiguration } from "./asset-storage-control.mjs";

test("pending control closes admission independently of imported migration history", async () => {
  for (const state of ["INVENTORY", "COPYING", "CONVERTING", "VERIFYING"]) {
    const client = {
      query: async (sql) => ({
        rows: sql.includes("to_regclass") ? [{ present: "control" }] : [{ state }],
      }),
    };
    await assert.rejects(assertNoStorageMigration(client), /Pending asset storage/);
  }
  await assertNoStorageMigration({ query: async () => ({ rows: [] }) });
});
test("schema mode checking needs no S3 secret or availability probe", async () => {
  const marker = {
    version: 1,
    mode: "disk",
    activeGeneration: "00000000-0000-4000-8000-000000000001",
  };
  const client = {
    query: async (sql) => ({
      rows: sql.includes("to_regclass")
        ? [{ present: "settings" }]
        : [{ value: JSON.stringify(marker) }],
    }),
  };
  await assertStorageConfiguration(client, {});
  await assert.rejects(
    assertStorageConfiguration(client, {
      KB_ASSET_S3_ENABLED: "true",
      KB_ASSET_S3_BUCKET: "assets",
      KB_ASSET_S3_REGION: "us-east-1",
    }),
    /offline migration/,
  );
});

test("the image entrypoint preserves every offline operator argument and strips runtime credentials", () => {
  const dir = mkdtempSync(join(tmpdir(), "s3-entrypoint-"));
  try {
    const output = join(dir, "arguments.json");
    writeFileSync(
      join(dir, "node"),
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify({args:process.argv.slice(2), writerPresent:Object.hasOwn(process.env, 'KB_ASSET_S3_SECRET_ACCESS_KEY'), instancePresent:Object.hasOwn(process.env, 'KB_INSTANCE_ID')}));\n`,
      { mode: 0o700 },
    );
    const args = [
      "asset-storage",
      "migrate",
      "--to",
      "s3",
      "--attempt",
      "00000000-0000-4000-8000-000000000006",
      "--dry-run",
    ];
    const result = spawnSync("sh", [resolve("scripts/docker-entrypoint.sh"), ...args], {
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        MIGRATE_ON_START: "true",
        KB_ASSET_S3_SECRET_ACCESS_KEY: "fixture",
        KB_INSTANCE_ID: "inherited",
      },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), {
      args: ["/app/scripts/lib/asset-storage-migration.mjs", ...args.slice(1)],
      writerPresent: false,
      instancePresent: false,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("one-shot storage status bypasses runtime migration admission", () => {
  const source = readFileSync(resolve("scripts/docker-entrypoint.sh"), "utf8");
  assert.ok(source.indexOf("  asset-storage)") < source.indexOf("# --- 1."));
});
