import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import {
  classify,
  MIGRATION_RUNNER_LOCK_KEY,
  PRISMA_ADVISORY_LOCK,
  pgConnectionString,
  prismaSchemaName,
  readMigrationState,
  readMigrationsFolder,
  safeError,
} from "./migration-state.mjs";

const base = {
  local: [],
  applied: [],
  pending: [],
  ahead: [],
  failed: [],
  checksumMismatch: [],
  inProgress: false,
  error: null,
};
const m = (name, checksum = `sum-${name}`) => ({ name, file: "", sql: "", checksum });
const row = (name, { finished = true, rolledBack = false, checksum = `sum-${name}` } = {}) => ({
  migration_name: name,
  checksum,
  finished_at: finished ? new Date() : null,
  rolled_back_at: rolledBack ? new Date() : null,
  logs: null,
});

describe("classify", () => {
  test("up-to-date", () => {
    assert.equal(classify(base, [m("0_init")], [row("0_init")], false).state, "up-to-date");
  });
  test("pending lists unapplied folders", () => {
    const result = classify(base, [m("0_init"), m("2_x")], [row("0_init")], false);
    assert.equal(result.state, "pending");
    assert.deepEqual(result.pending, ["2_x"]);
  });
  test("db-ahead when the database has a migration the folder lacks", () => {
    const result = classify(base, [m("0_init")], [row("0_init"), row("2_x")], false);
    assert.equal(result.state, "db-ahead");
    assert.deepEqual(result.ahead, ["2_x"]);
  });
  test("failed beats pending; a rolled-back row is history; in-progress follows the lock", () => {
    const rows = [row("0_init"), row("2_x", { finished: false })];
    const failed = classify(base, [m("0_init"), m("2_x"), m("3_y")], rows, true);
    assert.equal(failed.state, "failed");
    assert.equal(failed.inProgress, true);
    assert.deepEqual(
      failed.failed.map((f) => f.name),
      ["2_x"],
    );
    const recovered = classify(
      base,
      [m("0_init"), m("2_x")],
      [row("0_init"), row("2_x", { finished: false, rolledBack: true }), row("2_x")],
      false,
    );
    assert.equal(recovered.state, "up-to-date");
  });
  test("a failed migration missing from the folder is db-ahead", () => {
    assert.equal(
      classify(base, [m("0_init")], [row("0_init"), row("9_z", { finished: false })], false).state,
      "db-ahead",
    );
  });
  test("checksum mismatch is reported without changing the state", () => {
    const result = classify(
      base,
      [m("0_init", "new")],
      [row("0_init", { checksum: "old" })],
      false,
    );
    assert.equal(result.state, "up-to-date");
    assert.deepEqual(result.checksumMismatch, ["0_init"]);
  });
});

test("readMigrationsFolder sorts like Prisma and hashes bytes", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mig-"));
  try {
    for (const name of ["20260101000000_b", "0_init", "20250101000000_a"]) {
      mkdirSync(path.join(dir, name));
      writeFileSync(path.join(dir, name, "migration.sql"), `-- ${name}\n`);
    }
    mkdirSync(path.join(dir, "not_a_migration"));
    const list = readMigrationsFolder(dir);
    assert.deepEqual(
      list.map((x) => x.name),
      ["0_init", "20250101000000_a", "20260101000000_b"],
    );
    assert.match(list[0].checksum, /^[0-9a-f]{64}$/);
    assert.equal(list[0].contract, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readMigrationsFolder reads a folder's optional contract.sql with its own checksum", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mig-contract-"));
  try {
    mkdirSync(path.join(dir, "1_x"));
    writeFileSync(path.join(dir, "1_x", "migration.sql"), "SELECT 1;\n");
    writeFileSync(path.join(dir, "1_x", "contract.sql"), 'ALTER TABLE "t" DROP COLUMN "x";\n');
    // A folder with only a contract.sql is not a migration (Prisma needs migration.sql).
    mkdirSync(path.join(dir, "2_orphan"));
    writeFileSync(path.join(dir, "2_orphan", "contract.sql"), "SELECT 1;\n");
    const list = readMigrationsFolder(dir);
    assert.deepEqual(
      list.map((x) => x.name),
      ["1_x"],
    );
    assert.equal(list[0].contract?.sql, 'ALTER TABLE "t" DROP COLUMN "x";\n');
    assert.match(list[0].contract?.checksum ?? "", /^[0-9a-f]{64}$/);
    assert.notEqual(list[0].contract?.checksum, list[0].checksum);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("URL helpers keep Prisma's schema param out of pg and never leak URLs", () => {
  assert.equal(prismaSchemaName("postgresql://u:p@h/db?schema=app"), "app");
  assert.equal(prismaSchemaName("postgresql://u:p@h/db"), "public");
  assert.doesNotMatch(
    pgConnectionString("postgresql://u:p@h/db?schema=app&sslmode=require"),
    /schema=/,
  );
  assert.doesNotMatch(
    safeError(new Error("connect to postgresql://u:secret@h/db failed")),
    /secret/,
  );
});

test("readMigrationState reports the runner lock and Prisma's lock separately", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mig-state-"));
  try {
    mkdirSync(path.join(dir, "0_init"));
    writeFileSync(path.join(dir, "0_init", "migration.sql"), "SELECT 1;\n");
    const [{ checksum }] = readMigrationsFolder(dir);
    const held = new Set();
    const pg = {
      Client: class {
        async connect() {}
        async end() {}
        escapeIdentifier(name) {
          return `"${name}"`;
        }
        async query(sql, params = []) {
          if (/pg_locks/.test(sql)) return { rows: [{ held: held.has(params[0]) }] };
          if (/to_regclass/.test(sql)) return { rows: [{ t: "_prisma_migrations" }] };
          return {
            rows: [
              {
                migration_name: "0_init",
                checksum,
                finished_at: null,
                rolled_back_at: null,
                logs: null,
              },
            ],
          };
        }
      },
    };
    const read = () =>
      readMigrationState({
        databaseUrl: `postgresql://${["u", "p"].join(":")}@h/db`,
        migrationsDir: dir,
        pg: /** @type {typeof import("pg")} */ (/** @type {unknown} */ (pg)),
      });
    let state = await read();
    assert.equal(state.state, "failed");
    assert.deepEqual([state.inProgress, state.runnerActive], [false, false]);
    held.add(MIGRATION_RUNNER_LOCK_KEY);
    state = await read();
    assert.deepEqual([state.inProgress, state.runnerActive], [false, true]);
    held.add(PRISMA_ADVISORY_LOCK);
    state = await read();
    assert.deepEqual([state.inProgress, state.runnerActive], [true, true]);
    assert.equal(MIGRATION_RUNNER_LOCK_KEY, PRISMA_ADVISORY_LOCK + 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
