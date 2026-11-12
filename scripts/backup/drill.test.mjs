import assert from "node:assert/strict";
import { test } from "node:test";
import { assertDrillTarget, drillVerdict, parseDrillArgs } from "./drill.mjs";

test("drill accepts only a local full bundle and mounted identity", () => {
  assert.deepEqual(parseDrillArgs(["latest", "/identity"]), {
    file: "latest",
    identity: "/identity",
  });
  for (const args of [
    [],
    ["latest"],
    ["latest", "/identity", "--replace"],
    ["s3://bucket/key", "/identity"],
    ["--help", "/identity"],
  ])
    assert.throws(() => parseDrillArgs(args));
});
test("drill rejects live database, live root and nonisolated network names", () => {
  const base = {
    connectionString: "postgresql://inert:inert@drill-db/restore_drill",
    dataDir: "/drill-data",
  };
  assert.doesNotThrow(() => assertDrillTarget(base));
  for (const patch of [
    { dataDir: "/var/lib/knowledge-base" },
    { connectionString: "postgresql://inert:inert@prod/restore_drill" },
    { connectionString: "postgresql://inert:inert@drill-db/production" },
  ])
    assert.throws(() => assertDrillTarget({ ...base, ...patch }));
});
test("drill requires full KB tables, READY, migration history and deletion hold", () => {
  const base = {
    ready: true,
    held: true,
    migrations: { applied: 1, unfinished: 0 },
    tables: new Map(["knowledge_base", "audit_event", "asset_blob"].map((t) => [t, 0])),
  };
  assert.equal(drillVerdict(base).pass, true);
  for (const patch of [
    { ready: false },
    { held: false },
    { migrations: null },
    { migrations: { applied: 1, unfinished: 1 } },
    { tables: new Map() },
  ])
    assert.equal(drillVerdict({ ...base, ...patch }).pass, false);
});
