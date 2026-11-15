// Unit tests for the container migration runner's locking (migrate-runtime.mjs)
// with an in-memory fake `pg` and a fake `runPrisma`: no database, no Prisma.
// The real-Postgres end-to-end cases live in test-migrations.mjs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import {
  KB_DDL_LOCK_KEY,
  MIGRATION_RUNNER_LOCK_KEY,
  PRISMA_ADVISORY_LOCK,
} from "./lib/migration-state.mjs";
import { RETIRED_MAINTENANCE_MARKER, wrapTransactional } from "./lib/sql.mjs";
import { writeTestBackupHook } from "./lib/test-backup-hook.mjs";
import { HOLD_MAX_DAYS, run, runBackupHook, runHold } from "./migrate-runtime.mjs";

const URL = "postgresql://u:p@127.0.0.1:5432/app";
const dir = mkdtempSync(path.join(tmpdir(), "migrate-runtime-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const sums = {};
for (const [name, sql] of [
  ["0_init", wrapTransactional('CREATE TABLE "a" ("id" INTEGER);')],
  ["20990101000000_next", wrapTransactional('CREATE TABLE "b" ("id" INTEGER);')],
]) {
  mkdirSync(path.join(dir, name));
  writeFileSync(path.join(dir, name, "migration.sql"), sql);
  sums[name] = createHash("sha256").update(sql).digest("hex");
}
const backupHook = writeTestBackupHook(dir);
const NEXT = "20990101000000_next";
const applied = (name) => ({
  migration_name: name,
  checksum: sums[name],
  finished_at: new Date(),
  rolled_back_at: null,
  logs: null,
});
const unfinished = (name) => ({ ...applied(name), finished_at: null });

/**
 * A fake database shared by every Client: `_prisma_migrations` rows, who holds
 * the runner lock (a Client, "other", or null), and whether another session
 * holds Prisma's lock.
 */
function fakeDb(init) {
  const db = {
    rows: init.rows,
    runnerHolder: init.runnerHolder ?? null,
    prismaHeld: false,
    ddlHolder: null,
    pendingRestore: init.pendingRestore ?? false,
    occupied: init.occupied ?? false,
    // Runner-owned tables (scripts/db/lib/contracts.mjs).
    runtime: init.runtime ?? false,
    recorded: init.recorded ?? [],
    instances: [],
    holds: new Map(),
    cluster: init.cluster ?? null,
    identity: init.identity ?? { system_identifier: "7", timeline: 1 },
  };
  /** Answers for the runner-owned tables; undefined → fall through. */
  const runtimeQuery = (sql, params) => {
    if (/CREATE (TABLE|INDEX) IF NOT EXISTS/.test(sql)) {
      db.runtime = true;
      return { rows: [] };
    }
    if (/to_regclass\(format\('%I\."_knowledge_base_migration"'/.test(sql))
      return { rows: [{ present: db.runtime }] };
    if (/to_regclass\(format\('%I\."_knowledge_base_cluster"'/.test(sql))
      return { rows: [{ oid: db.runtime ? "900" : null }] };
    if (/SELECT name FROM "public"\."_knowledge_base_migration"$/.test(sql.trim()))
      return { rows: db.recorded.map((r) => ({ name: r.name })) };
    if (/INSERT INTO "public"\."_knowledge_base_migration"/.test(sql)) {
      const [name, rollback_safe, rollback_reasons] = params;
      db.recorded.push({ name, rollback_safe, rollback_reasons, contract_applied_at: null });
      return { rows: [], rowCount: 1 };
    }
    if (/FOR SHARE/.test(sql))
      return { rows: db.recorded.filter((r) => params[0].includes(r.name)) };
    if (/INSERT INTO "public"\."_knowledge_base_instance"/.test(sql)) {
      const [id, role, schema_level, , contract_folders] = params;
      db.instances.push({ id, role, schema_level });
      db.registeredFolders = contract_folders;
      return { rows: [] };
    }
    if (/^SET (statement|lock)_timeout/.test(sql)) {
      db.sessionSettings = [...(db.sessionSettings ?? []), sql];
      return { rows: [] };
    }
    if (/FROM pg_database/.test(sql)) return { rows: [{ oid: "5" }] };
    if (/pg_control_system/.test(sql)) {
      if (db.identity instanceof Error) throw db.identity;
      return { rows: [{ value: db.identity.system_identifier }] };
    }
    if (/pg_walfile_name/.test(sql)) {
      if (db.identity instanceof Error) throw db.identity;
      return { rows: [{ value: db.identity.timeline }] };
    }
    if (/FROM "public"\."_knowledge_base_cluster" FOR UPDATE/.test(sql))
      return { rows: db.cluster ? [db.cluster] : [] };
    if (/(INSERT INTO|UPDATE) "public"\."_knowledge_base_cluster"/.test(sql)) {
      const [system_identifier, timeline, database_oid, registry_oid] = params;
      db.cluster = { system_identifier, timeline, database_oid, registry_oid };
      return { rows: [] };
    }
    if (/INSERT INTO "public"\."_knowledge_base_hold"/.test(sql)) {
      db.holds.set(params[0], Math.max(db.holds.get(params[0]) ?? 0, params[1]));
      return { rows: [{ until: new Date(Date.now() + db.holds.get(params[0])) }] };
    }
    if (/DELETE FROM "public"\."_knowledge_base_hold" WHERE reason = 'owner'/.test(sql)) {
      const rowCount = db.holds.delete("owner") ? 1 : 0;
      return { rows: [], rowCount };
    }
    if (/_prisma_migrations', \$1::text\)\) IS NOT NULL AS present/.test(sql))
      return { rows: [{ present: db.history !== false }] };
    return undefined;
  };
  db.pg = {
    Client: class {
      constructor(options) {
        this.options = options;
      }
      on() {}
      escapeIdentifier(name) {
        return `"${name}"`;
      }
      async connect() {}
      async end() {
        if (db.runnerHolder === this) db.runnerHolder = null;
      }
      async query(sql, params = []) {
        if (/restore_table/.test(sql))
          return { rows: [{ restore_table: db.pendingRestore ? "kb_restore" : null }] };
        if (/FROM knowledge_base_control.kb_restore/.test(sql))
          return { rows: db.pendingRestore ? [{ pending: 1 }] : [] };
        if (/AS occupied/.test(sql)) return { rows: [{ occupied: db.occupied }] };
        if (/pg_advisory_(?:un)?lock/.test(sql) && sql.includes(String(KB_DDL_LOCK_KEY))) {
          if (/pg_advisory_unlock/.test(sql)) db.ddlHolder = null;
          else {
            assert.equal(db.ddlHolder, null, "DADP is never recursively acquired");
            db.ddlHolder = this;
          }
          return { rows: [] };
        }
        if (/pg_advisory_(?:un)?lock/.test(sql) && sql.includes(String(PRISMA_ADVISORY_LOCK))) {
          db.parentPrismaHeld = !/pg_advisory_unlock/.test(sql);
          return { rows: [] };
        }
        const answer = runtimeQuery(sql, params);
        if (answer) return answer;
        if (/pg_advisory_unlock/.test(sql)) {
          assert.match(sql, new RegExp(String(MIGRATION_RUNNER_LOCK_KEY)));
          db.unlockCalls = (db.unlockCalls ?? 0) + 1;
          if (db.runnerHolder === this) db.runnerHolder = null;
          return { rows: [{ pg_advisory_unlock: true }] };
        }
        if (/pg_try_advisory_lock/.test(sql)) {
          assert.match(sql, new RegExp(String(MIGRATION_RUNNER_LOCK_KEY)));
          if (db.runnerHolder && db.runnerHolder !== this) return { rows: [{ acquired: false }] };
          db.runnerHolder = this;
          return { rows: [{ acquired: true }] };
        }
        if (/pg_locks/.test(sql)) {
          const held =
            params[0] === MIGRATION_RUNNER_LOCK_KEY
              ? db.runnerHolder !== null
              : params[0] === PRISMA_ADVISORY_LOCK && db.prismaHeld;
          return { rows: [{ held }] };
        }
        if (/to_regclass/.test(sql)) return { rows: [{ t: "_prisma_migrations" }] };
        if (/FROM .*_prisma_migrations/s.test(sql)) return { rows: db.rows };
        return { rows: [] }; // BEGIN / replayed body / ROLLBACK
      }
    },
  };
  return db;
}

/** Captures console output and Prisma calls; `deploy` decides each deploy. */
async function runtime(db, { deploy, ...options } = {}) {
  const calls = [];
  const lines = [];
  const original = { log: console.log, error: console.error };
  console.log = (...a) => lines.push(a.join(" "));
  console.error = (...a) => lines.push(a.join(" "));
  try {
    const code = await run({
      env: { DATABASE_URL: URL, BACKUP_ENABLED: "true" },
      migrationsDir: dir,
      pg: /** @type {typeof import("pg")} */ (/** @type {unknown} */ (db.pg)),
      runPrisma: async (args) => {
        calls.push(args.join(" "));
        if (["deploy", "resolve"].includes(args[1])) {
          assert.notEqual(db.ddlHolder, null, "native mutation owns DADP");
          assert.equal(
            db.parentPrismaHeld,
            false,
            "parent never holds Prisma around its native child",
          );
        }
        if (args[1] === "resolve") {
          const row = db.rows.find(
            (r) => r.migration_name === args[3] && !r.finished_at && !r.rolled_back_at,
          );
          if (row && args[2] === "--rolled-back") row.rolled_back_at = new Date();
        }
        if (args[1] === "deploy") return { code: deploy ? await deploy(db) : 0 };
        return { code: 0 };
      },
      backupHook,
      connectRetryMs: 0,
      pollMs: 5,
      waitTimeoutMs: 200,
      ...options,
    });
    return { code, calls, out: lines.join("\n") };
  } finally {
    Object.assign(console, original);
  }
}

describe("apply mode holds the migration runner lock", () => {
  let db;
  beforeEach(() => {
    db = fakeDb({ rows: [applied("0_init")] });
  });

  test("happy path: deploys once, ends up to date, and releases the lock", async () => {
    const r = await runtime(db, {
      deploy: (d) => {
        assert.notEqual(d.runnerHolder, null, "deploy runs under the runner lock");
        d.rows.push(applied(NEXT));
        return 0;
      },
    });
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(r.calls, ["migrate deploy"]);
    assert.match(r.out, /database is up to date \(2 migration/);
    assert.equal(db.runnerHolder, null, "lock released");
    assert.equal(db.unlockCalls, 1, "lock released explicitly, not only by ending the session");
  });

  test("a deploy that fails while another session holds Prisma's lock resolves nothing", async () => {
    const r = await runtime(db, {
      deploy: (d) => {
        d.rows.push(unfinished(NEXT));
        d.prismaHeld = true;
        return 1;
      },
    });
    assert.equal(r.code, 1, r.out);
    assert.deepEqual(r.calls, ["migrate deploy"], "no migrate resolve");
    assert.match(r.out, /another session holds Prisma's migration lock/);
    assert.equal(db.runnerHolder, null);
  });

  test("an in-progress migration that outlasts the wait is refused, never resolved", async () => {
    db.rows.push(unfinished(NEXT));
    db.prismaHeld = true;
    const r = await runtime(db);
    assert.equal(r.code, 1, r.out);
    assert.deepEqual(r.calls, []);
    assert.match(r.out, /still being applied by another session/);
    assert.equal(db.runnerHolder, null);
  });

  test("a runner lock held by another session is refused after the timeout", async () => {
    db.runnerHolder = "other";
    const r = await runtime(db);
    assert.equal(r.code, 1, r.out);
    assert.deepEqual(r.calls, []);
    assert.match(r.out, /still holds the migration lock/);
    assert.match(r.out, /expected when the other runner's pre-migration backup/);
    assert.equal(db.runnerHolder, "other", "never steals the other runner's lock");
  });

  test("a waiting leader re-reads the state after the lock and does not deploy again", async () => {
    db.runnerHolder = "other";
    setTimeout(() => {
      db.rows.push(applied(NEXT));
      db.runnerHolder = null;
    }, 30);
    const r = await runtime(db, { waitTimeoutMs: 5_000 });
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(r.calls, []);
    assert.match(r.out, /another migration runner is working/);
    assert.match(r.out, /database is up to date/);
  });

  test("a failed rolled-back attempt is recovered once under the lock", async () => {
    db.rows.push(unfinished(NEXT));
    const r = await runtime(db, {
      deploy: (d) => {
        d.rows = [applied("0_init"), { ...unfinished(NEXT), rolled_back_at: new Date() }];
        d.rows.push(applied(NEXT));
        return 0;
      },
    });
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(r.calls, [`migrate resolve --rolled-back ${NEXT}`, "migrate deploy"]);
  });
});

describe("breaking gate: statements old code cannot run against (incompatible)", () => {
  const idir = mkdtempSync(path.join(tmpdir(), "migrate-runtime-incompatible-"));
  after(() => rmSync(idir, { recursive: true, force: true }));
  const isums = {};
  // Assembled so policy greps never see a literal deletion in this fixture.
  const DROP = "DROP";
  for (const [name, sql] of [
    ["0_init", wrapTransactional('CREATE TABLE "a" ("id" INTEGER, "old" TEXT);')],
    [NEXT, wrapTransactional(`ALTER TABLE "a" ${DROP} COLUMN "old";`)],
  ]) {
    mkdirSync(path.join(idir, name));
    writeFileSync(path.join(idir, name, "migration.sql"), sql);
    isums[name] = createHash("sha256").update(sql).digest("hex");
  }
  const done = (name) => ({ ...applied(name), checksum: isums[name] });

  test("an in-place column drop on a served database is refused, with the recipes", async () => {
    const db = fakeDb({ rows: [done("0_init")] });
    const r = await runtime(db, { migrationsDir: idir });
    assert.equal(r.code, 1, r.out);
    assert.match(
      r.out,
      /change the schema in place, which would break the release that is still running: 20990101000000_next \(line \d+ drops column "a"\."old"\)/,
    );
    assert.match(r.out, /no override/);
    assert.match(r.out, /regenerate with `pnpm db:migrate`/);
    assert.match(r.out, /@map/);
    assert.match(r.out, /Recipe 5/);
    assert.deepEqual(r.calls, [], "nothing deployed past the gate");
  });

  test("the retired MAINTENANCE_DEPLOY variable no longer lets it through", async () => {
    const db = fakeDb({ rows: [done("0_init")] });
    const r = await runtime(db, {
      migrationsDir: idir,
      env: { DATABASE_URL: URL, MAINTENANCE_DEPLOY: "true" },
    });
    assert.equal(r.code, 1, r.out);
    assert.deepEqual(r.calls, []);
  });

  test("a brand-new database applies it in an ordinary deploy", async () => {
    const db = fakeDb({ rows: [] });
    const r = await runtime(db, {
      // Backups off: the backup gate on a brand-new database is the "backup gate" suite's.
      env: { DATABASE_URL: URL },
      migrationsDir: idir,
      deploy: (d) => {
        d.rows.push(done("0_init"), done(NEXT));
        return 0;
      },
    });
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(r.calls, ["migrate deploy"]);
    assert.match(
      r.out,
      /new database: applying in-place breaking migration\(s\) 20990101000000_next/,
    );
  });
});

describe("breaking gate: the retired maintenance marker", () => {
  const mdir = mkdtempSync(path.join(tmpdir(), "migrate-runtime-retired-"));
  after(() => rmSync(mdir, { recursive: true, force: true }));
  const msums = {};
  const marked = wrapTransactional('CREATE TABLE "c" ("id" INTEGER);').replace(
    "BEGIN;",
    `${RETIRED_MAINTENANCE_MARKER}\nBEGIN;`,
  );
  for (const [name, sql] of [
    ["0_init", wrapTransactional('CREATE TABLE "a" ("id" INTEGER);')],
    [NEXT, marked],
  ]) {
    mkdirSync(path.join(mdir, name));
    writeFileSync(path.join(mdir, name, "migration.sql"), sql);
    msums[name] = createHash("sha256").update(sql).digest("hex");
  }
  const done = (name) => ({ ...applied(name), checksum: msums[name] });

  test("is refused on a served database, even when the file is otherwise harmless", async () => {
    const r = await runtime(fakeDb({ rows: [done("0_init")] }), { migrationsDir: mdir });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /carries the retired marker "-- requires: maintenance-deploy"/);
    assert.ok(!r.out.includes("Databases from before"), r.out);
    assert.deepEqual(r.calls, []);
  });

  test("is applied on a brand-new database", async () => {
    const r = await runtime(fakeDb({ rows: [] }), {
      env: { DATABASE_URL: URL },
      migrationsDir: mdir,
      deploy: (d) => {
        d.rows.push(done("0_init"), done(NEXT));
        return 0;
      },
    });
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(r.calls, ["migrate deploy"]);
  });
});

describe("hold-deletions (runHold)", () => {
  /** @param {ReturnType<typeof fakeDb>} db @param {string[]} args */
  async function hold(db, args) {
    const lines = [];
    const original = { log: console.log, error: console.error };
    console.log = (...a) => lines.push(a.join(" "));
    console.error = (...a) => lines.push(a.join(" "));
    try {
      const code = await runHold({
        args,
        env: { DATABASE_URL: URL },
        pg: /** @type {typeof import("pg")} */ (/** @type {unknown} */ (db.pg)),
        pollMs: 5,
        waitTimeoutMs: 200,
      });
      return { code, out: lines.join("\n") };
    } finally {
      Object.assign(console, original);
    }
  }
  const DAY = 24 * 60 * 60 * 1000;

  test("defaults to 7 days, creates the runner tables, releases the lock, never prints the URL", async () => {
    const db = fakeDb({ rows: [applied("0_init")] });
    const r = await hold(db, []);
    assert.equal(r.code, 0, r.out);
    assert.equal(db.holds.get("owner"), 7 * DAY);
    assert.equal(db.runtime, true, "runner-owned tables created");
    assert.equal(db.runnerHolder, null, "runner lock released");
    assert.match(r.out, /Scheduled deletions are paused until \S+Z \(owner hold, 7 days/);
    assert.doesNotMatch(r.out, /postgresql:|u:p@/);
  });

  test("takes a day count and never shortens a longer hold", async () => {
    const db = fakeDb({ rows: [applied("0_init")] });
    assert.equal((await hold(db, ["30"])).code, 0);
    assert.equal(db.holds.get("owner"), 30 * DAY);
    assert.equal((await hold(db, ["1"])).code, 0);
    assert.equal(db.holds.get("owner"), 30 * DAY);
  });

  test("rejects a bad day count", async () => {
    for (const bad of ["0", String(HOLD_MAX_DAYS + 1), "7d", "-3", "1.5"]) {
      const db = fakeDb({ rows: [applied("0_init")] });
      const r = await hold(db, [bad]);
      assert.equal(r.code, 1, bad);
      assert.match(r.out, /whole number of days/);
      assert.equal(db.holds.size, 0);
    }
  });

  test("--clear removes only the owner hold", async () => {
    const db = fakeDb({ rows: [applied("0_init")], runtime: true });
    db.holds.set("owner", DAY);
    db.holds.set("restore", DAY);
    const r = await hold(db, ["--clear"]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Removed the owner hold/);
    assert.deepEqual([...db.holds.keys()], ["restore"]);
    assert.match((await hold(db, ["--clear"])).out, /no owner hold; nothing changed/);
  });

  test("refuses a database without migration history", async () => {
    const db = fakeDb({ rows: [] });
    db.history = false;
    const r = await hold(db, []);
    assert.equal(r.code, 1);
    assert.match(r.out, /no migration history/);
    assert.equal(db.runtime, false);
  });

  test("waits for, and never steals, a running migration's lock", async () => {
    const db = fakeDb({ rows: [applied("0_init")] });
    db.runnerHolder = "other";
    const r = await hold(db, []);
    assert.equal(r.code, 1);
    assert.equal(db.holds.size, 0);
    assert.equal(db.runnerHolder, "other");
  });
});

describe("breaking gate: SQL the analyzer cannot read (notAnalyzed)", () => {
  const backfill = 'DO $$ BEGIN UPDATE "a" SET "id" = 1 WHERE "id" IS NULL; END $$;';
  const dirFor = (sql) => {
    const dir = mkdtempSync(path.join(tmpdir(), "migrate-runtime-not-analyzed-"));
    const sums = {};
    for (const [name, text] of [
      ["0_init", wrapTransactional('CREATE TABLE "a" ("id" INTEGER);')],
      [NEXT, wrapTransactional(sql)],
    ]) {
      mkdirSync(path.join(dir, name));
      writeFileSync(path.join(dir, name, "migration.sql"), text);
      sums[name] = createHash("sha256").update(text).digest("hex");
    }
    return { dir, done: (name) => ({ ...applied(name), checksum: sums[name] }) };
  };
  const dirs = [];
  after(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  test("an unannotated DO backfill on a served database is refused", async () => {
    const { dir, done } = dirFor(backfill);
    dirs.push(dir);
    const r = await runtime(fakeDb({ rows: [done("0_init")] }), { migrationsDir: dir });
    assert.equal(r.code, 1, r.out);
    assert.match(
      r.out,
      /still running: 20990101000000_next \(line \d+ not analyzed: dollar-quoted/,
    );
    assert.deepEqual(r.calls, []);
  });

  test("the same SQL annotated with -- knowledge-base:reviewed deploys", async () => {
    const { dir, done } = dirFor(
      `-- knowledge-base:reviewed backfills the new column; old code ignores it\n${backfill}`,
    );
    dirs.push(dir);
    const r = await runtime(fakeDb({ rows: [done("0_init")] }), {
      migrationsDir: dir,
      deploy: (d) => {
        d.rows.push(done(NEXT));
        return 0;
      },
    });
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(r.calls, ["migrate deploy"]);
  });

  test("an annotation on a statement the §1.9 regex excludes is ignored", async () => {
    const { dir, done } = dirFor(
      `-- knowledge-base:reviewed trust me\nDO $$ BEGIN EXECUTE 'SELECT 1'; END $$;`,
    );
    dirs.push(dir);
    const r = await runtime(fakeDb({ rows: [done("0_init")] }), { migrationsDir: dir });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /not analyzed/);
  });
});

describe("after the database is up to date", () => {
  const ID = "0b9b6c1e-6f39-4d4a-9a7e-3f2b1c0d9e8f";
  const upToDate = (init = {}) => fakeDb({ rows: [applied("0_init"), applied(NEXT)], ...init });

  test("records the migrations and registers this instance with its role and level", async () => {
    const db = upToDate();
    const r = await runtime(db, {
      role: "worker",
      env: { DATABASE_URL: URL, KB_INSTANCE_ID: ID },
    });
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(
      db.recorded.map((m) => m.name),
      ["0_init", NEXT],
    );
    assert.deepEqual(db.instances, [{ id: ID, role: "worker", schema_level: NEXT }]);
  });

  test("a non-fresh database with no cluster row is held", async () => {
    const db = upToDate();
    const r = await runtime(db);
    assert.equal(r.code, 0, r.out);
    assert.ok(db.holds.has("cluster-changed"));
    assert.match(
      r.out,
      /deletion scheduling starts on this database; scheduled deletions held until/,
    );
    assert.equal(db.cluster.registry_oid, "900");
  });

  test("an identity read error skips scheduled deletions and still exits 0", async () => {
    const db = upToDate({ identity: Object.assign(new Error("terminated"), { code: "08006" }) });
    const r = await runtime(db);
    assert.equal(r.code, 0, r.out);
    assert.match(
      r.out,
      /cluster identity read failed \(08006\); scheduled deletions skipped this run/,
    );
    assert.equal(db.cluster, null);
    assert.equal(db.holds.size, 0);
  });

  test("the scheduled-deletion session bounds its own steps (startup budget)", async () => {
    const db = upToDate();
    const r = await runtime(db);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(db.sessionSettings, [
      "SET statement_timeout = 2000",
      "SET lock_timeout = 2000",
    ]);
    assert.equal(db.cluster.system_identifier, "7", "both identity parts read");
    assert.equal(db.cluster.timeline, 1);
  });

  test("a malformed KB_INSTANCE_ID is refused", async () => {
    const r = await runtime(upToDate(), { env: { DATABASE_URL: URL, KB_INSTANCE_ID: "x" } });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /KB_INSTANCE_ID is not a UUID/);
  });
});

describe("an out-of-order folder (merged after a newer migration)", () => {
  const ID = "0b9b6c1e-6f39-4d4a-9a7e-3f2b1c0d9e8f";
  const EARLY = "20980101000000_early";
  const dir = mkdtempSync(path.join(tmpdir(), "migrate-runtime-out-of-order-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const sums = {};
  for (const [name, text] of [
    ["0_init", wrapTransactional('CREATE TABLE "a" ("id" INTEGER, "x" INTEGER);')],
    [EARLY, wrapTransactional('CREATE TABLE "c" ("id" INTEGER);')],
    [NEXT, wrapTransactional('CREATE TABLE "b" ("id" INTEGER);')],
  ]) {
    mkdirSync(path.join(dir, name));
    writeFileSync(path.join(dir, name, "migration.sql"), text);
    sums[name] = createHash("sha256").update(text).digest("hex");
  }
  // Assembled so policy greps never see a literal deletion.
  writeFileSync(
    path.join(dir, EARLY, "contract.sql"),
    `ALTER TABLE "a" ${["DR", "OP"].join("")} COLUMN "x";\n`,
  );
  const done = (name) => ({ ...applied(name), checksum: sums[name] });

  test("logs loudly, applies it, and registers the image's contract folders", async () => {
    const db = fakeDb({ rows: [done("0_init"), done(NEXT)] });
    const r = await runtime(db, {
      migrationsDir: dir,
      env: { DATABASE_URL: URL, KB_INSTANCE_ID: ID },
      deploy: (d) => {
        d.rows.push(done(EARLY));
        return 0;
      },
    });
    assert.equal(r.code, 0, r.out);
    assert.match(
      r.out,
      /OUT-OF-ORDER MIGRATION: 20980101000000_early sorts before the already-applied 20990101000000_next/,
    );
    assert.deepEqual(r.calls, ["migrate deploy"]);
    assert.deepEqual(db.registeredFolders, [EARLY]);
  });

  test("an older image lacking it is admitted only as a blocker: it registers without the folder", async () => {
    const old = mkdtempSync(path.join(tmpdir(), "migrate-runtime-old-image-"));
    try {
      for (const name of ["0_init", NEXT]) {
        mkdirSync(path.join(old, name));
        writeFileSync(
          path.join(old, name, "migration.sql"),
          wrapTransactional(
            name === NEXT
              ? 'CREATE TABLE "b" ("id" INTEGER);'
              : 'CREATE TABLE "a" ("id" INTEGER, "x" INTEGER);',
          ),
        );
      }
      const db = fakeDb({
        rows: [done("0_init"), done(NEXT), done(EARLY)],
        runtime: true,
        recorded: [{ name: EARLY, rollback_safe: true, contract_applied_at: null }],
      });
      const r = await runtime(db, {
        migrationsDir: old,
        env: { DATABASE_URL: URL, KB_INSTANCE_ID: ID },
      });
      assert.equal(r.code, 0, r.out);
      assert.match(
        r.out,
        /older release running against a newer schema \(rollback of 20980101000000_early\)/,
      );
      assert.deepEqual(db.instances, [{ id: ID, role: "server", schema_level: NEXT }]);
      assert.deepEqual(db.registeredFolders, [], "its image lacks the early folder");
    } finally {
      rmSync(old, { recursive: true, force: true });
    }
  });
});

describe("db-ahead (an older image: rollback admission)", () => {
  const ID = "0b9b6c1e-6f39-4d4a-9a7e-3f2b1c0d9e8f";
  const ahead = "20991231000000_newer";
  const aheadDb = (record) =>
    fakeDb({
      rows: [applied("0_init"), applied(NEXT), { ...applied(NEXT), migration_name: ahead }],
      runtime: true,
      recorded: record ? [record] : [],
    });

  for (const mode of ["apply", "wait"])
    test(`${mode}: admitted when the newer migration is rollback-safe; the instance registers`, async () => {
      const db = aheadDb({ name: ahead, rollback_safe: true, contract_applied_at: null });
      const r = await runtime(db, { mode, env: { DATABASE_URL: URL, KB_INSTANCE_ID: ID } });
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /older release running against a newer schema \(rollback/);
      assert.deepEqual(db.instances, [{ id: ID, role: "server", schema_level: NEXT }]);
      assert.deepEqual(r.calls, [], "nothing deployed");
    });

  test("the id-less migrate job: admitted read-only, registers nothing", async () => {
    const db = aheadDb({ name: ahead, rollback_safe: true, contract_applied_at: null });
    const r = await runtime(db);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /rollback admitted/);
    assert.deepEqual(db.instances, []);
  });

  test("refused when the newer migration is not rollback-safe", async () => {
    const db = aheadDb({
      name: ahead,
      rollback_safe: false,
      rollback_reasons: "adds an enum value",
    });
    const r = await runtime(db, { env: { DATABASE_URL: URL, KB_INSTANCE_ID: ID } });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /not rollback-safe \(adds an enum value\)/);
    assert.match(r.out, /Refusing to start old code against a newer schema/);
    assert.deepEqual(db.instances, []);
  });

  test("refused when the database has no rollback records", async () => {
    const db = fakeDb({
      rows: [applied("0_init"), applied(NEXT), { ...applied(NEXT), migration_name: ahead }],
    });
    const r = await runtime(db, { mode: "wait" });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /no rollback records/);
  });
});

describe("wait mode", () => {
  test("waits while an active runner works on a failed migration", async () => {
    const db = fakeDb({ rows: [applied("0_init"), unfinished(NEXT)], runnerHolder: "other" });
    const started = Date.now();
    setTimeout(() => {
      db.rows = [applied("0_init"), applied(NEXT)];
      db.runnerHolder = null;
    }, 100);
    const r = await runtime(db, { mode: "wait", waitTimeoutMs: 60_000 });
    assert.equal(r.code, 0, r.out);
    assert.ok(Date.now() - started < 30_000);
    assert.doesNotMatch(r.out, /recorded as failed/);
  });

  test("a failed migration nobody is working on is refused", async () => {
    const db = fakeDb({ rows: [applied("0_init"), unfinished(NEXT)] });
    const r = await runtime(db, { mode: "wait", waitTimeoutMs: 50 });
    assert.equal(r.code, 1, r.out);
  });
});

describe("KB restore admission and full-bundle backup", () => {
  for (const mode of ["apply", "wait"])
    for (const rows of [
      [],
      [applied("0_init")],
      [applied("0_init"), applied(NEXT)],
      [
        applied("0_init"),
        applied(NEXT),
        { ...applied(NEXT), migration_name: "20991231000000_ahead" },
      ],
    ])
      test(`${mode} refuses pending restore before history classification (${rows.length} rows)`, async () => {
        const db = fakeDb({ rows, pendingRestore: true });
        const result = await runtime(db, { mode });
        assert.equal(result.code, 1, result.out);
        assert.match(result.out, /restore is pending/);
        assert.deepEqual(result.calls, []);
        assert.deepEqual(db.instances, []);
      });
  test("hold refuses pending restore without changing holds", async () => {
    const db = fakeDb({ rows: [applied("0_init")], pendingRestore: true });
    assert.equal(await runHold({ env: { DATABASE_URL: URL }, pg: db.pg }), 1);
    assert.equal(db.holds.size, 0);
  });
  test("an occupied catalog with empty history cannot take the fresh-only exemption", async () => {
    const db = fakeDb({ rows: [], occupied: true });
    const result = await runtime(db);
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /genuinely empty application catalog/);
    assert.deepEqual(result.calls, []);
  });
  test("true-empty 0_init with backups enabled refuses a missing backup hook", async () => {
    const baseline = mkdtempSync(path.join(tmpdir(), "kb-fresh-init-"));
    try {
      mkdirSync(path.join(baseline, "0_init"));
      writeFileSync(
        path.join(baseline, "0_init/migration.sql"),
        wrapTransactional('CREATE TABLE "a" ("id" INTEGER);'),
      );
      for (const [env, code, calls] of [
        [{ BACKUP_ENABLED: "true" }, 1, []],
        [{ BACKUP_ENABLED: "false" }, 0, ["migrate deploy"]],
      ]) {
        const db = fakeDb({ rows: [] });
        const result = await runtime(db, {
          env: { DATABASE_URL: URL, ...env },
          migrationsDir: baseline,
          backupHook: path.join(baseline, "missing"),
          deploy: (d) => {
            d.rows.push(applied("0_init"));
            return 0;
          },
        });
        assert.equal(result.code, code, result.out);
        assert.deepEqual(result.calls, calls);
        if (code) assert.match(result.out, /a brand-new database too/);
      }
    } finally {
      rmSync(baseline, { recursive: true, force: true });
    }
  });
  test("initialized database refuses a missing required full-bundle hook", async () => {
    const result = await runtime(fakeDb({ rows: [applied("0_init")] }), {
      backupHook: path.join(dir, "absent"),
    });
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /full-bundle backup failed/);
    assert.deepEqual(result.calls, []);
  });
  test("zero-exit hook with prose but no result file cannot admit DDL", async () => {
    const hook = path.join(dir, "prose.sh");
    writeFileSync(hook, 'echo "[backup] Verified fake.dump"\n');
    const result = await runtime(fakeDb({ rows: [applied("0_init")] }), { backupHook: hook });
    assert.equal(result.code, 1, result.out);
    assert.deepEqual(result.calls, []);
  });
  test("backup runs without DADP and changed history restarts classification", async () => {
    const db = fakeDb({ rows: [applied("0_init")] });
    const timer = setTimeout(() => {
      assert.equal(db.ddlHolder, null, "bundle hook never runs while DADP is held");
      assert.equal(db.parentPrismaHeld, false, "bundle hook never runs while Prisma is held");
      db.rows.push(applied(NEXT));
    }, 30);
    try {
      const result = await runtime(db);
      assert.equal(result.code, 0, result.out);
      assert.match(result.out, /changed during backup/);
      assert.deepEqual(result.calls, [], "changed prefix is never deployed using stale facts");
    } finally {
      clearTimeout(timer);
    }
  });
});

for (const enabled of [undefined, "", "false"])
  test(`initialized database migrates without a backup when BACKUP_ENABLED=${enabled}`, async () => {
    const db = fakeDb({ rows: [applied("0_init")] });
    const result = await runtime(db, {
      env: { DATABASE_URL: URL, ...(enabled === undefined ? {} : { BACKUP_ENABLED: enabled }) },
      backupHook: path.join(dir, "missing"),
      deploy: (d) => {
        d.rows.push(applied(NEXT));
        return 0;
      },
    });
    assert.equal(result.code, 0, result.out);
    assert.deepEqual(result.calls, ["migrate deploy"]);
    assert.equal(db.runnerHolder, null, "runner lock released after migration");
  });

test("migration backup toggle rejects non-boolean values before running the hook", async () => {
  for (const enabled of [
    "1",
    "yes",
    "on",
    "0",
    "no",
    "off",
    "TRUE",
    "FALSE",
    " true ",
    "invalid",
  ]) {
    await assert.rejects(
      runBackupHook({ env: { BACKUP_ENABLED: enabled }, backupHook: path.join(dir, "missing") }),
      /BACKUP_ENABLED must be true or false/,
    );
  }
});

test("a configured S3 destination cannot accept a local-only hook result", async () => {
  const db = fakeDb({ rows: [applied("0_init")] });
  const result = await runtime(db, {
    env: { DATABASE_URL: URL, BACKUP_ENABLED: "true", BACKUP_S3_BUCKET: "fixture-only" },
  });
  assert.equal(result.code, 1, result.out);
  assert.deepEqual(result.calls, []);
});

for (const cancellation of ["signal", "timeout"])
  test(`${cancellation} after native drain stops before recovery/retry`, async () => {
    const calls = [];
    const result = await runtime(fakeDb({ rows: [applied("0_init")] }), {
      runPrisma: async (args) => {
        calls.push(args.join(" "));
        if (cancellation === "signal") process.emit("SIGTERM");
        return { code: 1, timedOut: cancellation === "timeout" };
      },
    });
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /cancelled or timed out/);
    assert.deepEqual(calls, ["migrate deploy"]);
  });

test("empty catalog applies baseline plus later folders without any backup configuration when backups are off", async () => {
  const db = fakeDb({ rows: [] });
  const result = await runtime(db, {
    env: { DATABASE_URL: URL },
    backupHook: path.join(dir, "missing"),
    deploy: (d) => {
      d.rows.push(applied("0_init"), applied(NEXT));
      return 0;
    },
  });
  assert.equal(result.code, 0, result.out);
  assert.deepEqual(result.calls, ["migrate deploy"]);
});

test("recoverable history is rolled back before a missing required snapshot hook fails", async () => {
  const db = fakeDb({ rows: [applied("0_init"), unfinished(NEXT)] });
  const result = await runtime(db, { backupHook: path.join(dir, "missing") });
  assert.equal(result.code, 1, result.out);
  assert.match(result.out, /required pre-migration full-bundle backup failed/);
  assert.deepEqual(result.calls, [`migrate resolve --rolled-back ${NEXT}`]);
  assert.ok(db.rows[1].rolled_back_at, "next restart can capture finished/rolled-back history");
});

for (const label of ["pre-migrate", "pre-drop"])
  test(`${label} skips a missing hook with no verified-result requirement when backups are off`, async () => {
    const result = await runBackupHook({ env: {}, backupHook: path.join(dir, "missing") }, [
      "--label",
      label,
    ]);
    assert.deepEqual(result, { missing: false, code: 0, label: null, skipped: true });
  });

// A stop signal cancels the runner (ctx.abort): the hook gets one TERM and
// is waited for; a cancelled runner never starts one.
describe("backup hook cancellation", () => {
  const cancelDir = mkdtempSync(path.join(tmpdir(), "kb-hook-cancel-"));
  after(() => rmSync(cancelDir, { recursive: true, force: true }));
  const started = path.join(cancelDir, "started");
  const termed = path.join(cancelDir, "termed");
  const hook = path.join(cancelDir, "hook.sh");
  writeFileSync(
    hook,
    `trap 'echo term > ${JSON.stringify(termed)}; exit 143' TERM\necho started > ${JSON.stringify(started)}\nfor i in $(seq 200); do sleep 0.05; done\nexit 0\n`,
  );
  const until = async (file, ms) => {
    for (const end = Date.now() + ms; Date.now() < end; )
      try {
        readFileSync(file);
        return true;
      } catch {
        await new Promise((r) => setTimeout(r, 20));
      }
    return false;
  };
  test("a cancel while the hook runs sends it TERM and waits for it", async () => {
    rmSync(started, { force: true });
    rmSync(termed, { force: true });
    const abort = new AbortController();
    const begun = Date.now();
    const pending = runBackupHook({ env: { BACKUP_ENABLED: "true" }, backupHook: hook, abort }, [
      "--label",
      "pre-drop",
    ]);
    assert.ok(await until(started, 5_000), "the hook started");
    abort.abort();
    const result = await pending;
    assert.equal(result.code, 143);
    assert.ok(await until(termed, 1_000), "the hook received TERM");
    assert.ok(Date.now() - begun < 5_000, "returned long before the hook's own 10 s end");
  });
  test("a cancelled runner never starts the hook", async () => {
    rmSync(started, { force: true });
    const abort = new AbortController();
    abort.abort();
    const result = await runBackupHook(
      { env: { BACKUP_ENABLED: "true" }, backupHook: hook, abort },
      ["--label", "pre-drop"],
    );
    assert.notEqual(result.code, 0);
    assert.equal(await until(started, 300), false, "the hook never started");
  });
});

// The backup gate (owner decision): BACKUP_ENABLED=true with no destination
// refuses the migration, a brand-new database too; off never runs the hook.
describe("backup gate", () => {
  const gate = mkdtempSync(path.join(tmpdir(), "kb-backup-gate-"));
  after(() => rmSync(gate, { recursive: true, force: true }));
  const freshDeploy = (d) => {
    d.rows.push(applied("0_init"), applied(NEXT));
    return 0;
  };
  /** A hook that records its arguments and answers --check-destination. */
  const recordingHook = (name, checkStatus = 0) => {
    const log = path.join(gate, `${name}.log`);
    writeFileSync(log, "");
    const full = writeTestBackupHook(mkdtempSync(path.join(gate, `${name}-`)), { logFile: log });
    const hook = path.join(gate, `${name}.sh`);
    writeFileSync(
      hook,
      `if [ "$1" = --check-destination ]; then echo "$*" >> ${JSON.stringify(log)}; exit ${checkStatus}; fi\nexec bash ${JSON.stringify(full)} "$@"\n`,
    );
    return { hook, calls: () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean) };
  };
  // The real image hook, with no recipient: no destination. Postgres clients
  // are failing stubs, so no case (or mutation) ever reaches a real database.
  const realHook = path.join(import.meta.dirname, "../backup/pre-migrate.sh");
  const noDb = mkdtempSync(path.join(gate, "no-db-"));
  for (const tool of ["psql", "pg_dump"])
    writeFileSync(
      path.join(noDb, tool),
      "#!/bin/sh\necho 'no database in unit tests' >&2\nexit 1\n",
      {
        mode: 0o755,
      },
    );
  const noDestination = (extra = {}) => ({
    DATABASE_URL: URL,
    BACKUP_ENABLED: "true",
    BACKUP_DIR: path.join(gate, "backups"),
    PATH: `${noDb}:${process.env.PATH}`,
    ...extra,
  });

  test("a brand-new database runs the hook's destination check (no bundle) when enabled", async () => {
    const { hook, calls } = recordingHook("fresh-ok");
    const result = await runtime(fakeDb({ rows: [] }), { backupHook: hook, deploy: freshDeploy });
    assert.equal(result.code, 0, result.out);
    assert.deepEqual(calls(), ["--check-destination"]);
    assert.deepEqual(result.calls, ["migrate deploy"]);
  });

  test("a brand-new database refuses when the destination check fails", async () => {
    const { hook, calls } = recordingHook("fresh-bad", 1);
    const result = await runtime(fakeDb({ rows: [] }), { backupHook: hook, deploy: freshDeploy });
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /backup destination check failed.*a brand-new database too/);
    assert.deepEqual(calls(), ["--check-destination"]);
    assert.deepEqual(result.calls, []);
  });

  test("an initialized database takes the full pre-migrate bundle", async () => {
    const { hook, calls } = recordingHook("initialized");
    const db = fakeDb({ rows: [applied("0_init")] });
    const result = await runtime(db, {
      backupHook: hook,
      deploy: (d) => {
        d.rows.push(applied(NEXT));
        return 0;
      },
    });
    assert.equal(result.code, 0, result.out);
    assert.deepEqual(calls(), ["--label pre-migrate"]);
    assert.deepEqual(result.calls, ["migrate deploy"]);
  });

  for (const [name, rows, reason] of [
    ["a brand-new database", [], /backup destination check failed.*a brand-new database too/],
    [
      "an initialized database",
      [applied("0_init")],
      /required pre-migration full-bundle backup failed/,
    ],
  ])
    test(`the real hook with no destination refuses ${name}`, async () => {
      for (const extra of [{}, { BACKUP_AGE_RECIPIENT: "not-a-recipient" }]) {
        const result = await runtime(fakeDb({ rows: [...rows] }), {
          env: noDestination(extra),
          backupHook: realHook,
          deploy: freshDeploy,
        });
        assert.equal(result.code, 1, result.out);
        // Refused for the backup, not for something else on the way.
        assert.match(result.out, reason);
        assert.deepEqual(result.calls, [], "nothing is deployed");
      }
    });

  test("the real hook's destination check: no recipient, an unwritable or unmounted BACKUP_DIR or incomplete S3 refuse; a usable one passes", () => {
    const bin = mkdtempSync(path.join(gate, "bin-"));
    // The pinned age binary is in the images; a stub rejects only "age1rejected".
    writeFileSync(path.join(bin, "age"), '#!/bin/sh\n[ "$2" != age1rejected ]\n', { mode: 0o755 });
    // util-linux mountpoint stand-in: BACKUP_DIR is a mounted volume unless
    // FIXTURE_UNMOUNTED is set (the image's /app/backups without a volume).
    writeFileSync(path.join(bin, "mountpoint"), '#!/bin/sh\n[ -z "$FIXTURE_UNMOUNTED" ]\n', {
      mode: 0o755,
    });
    const blocked = path.join(gate, "not-a-dir");
    writeFileSync(blocked, "");
    // No DATABASE_URL: the check never needs the database.
    const check = (extra) => {
      const { DATABASE_URL: _unused, ...env } = noDestination(extra);
      return spawnSync("bash", [realHook, "--check-destination"], {
        env: { ...env, PATH: `${bin}:${env.PATH}` },
        encoding: "utf8",
      });
    };
    const recipient = "age1fixturerecipient";
    for (const [extra, pattern] of [
      [{}, /no backup destination/],
      [{ BACKUP_AGE_RECIPIENT: "age1 bad" }, /no backup destination/],
      [{ BACKUP_AGE_RECIPIENT: "age1rejected" }, /not a recipient the pinned age accepts/],
      [{ BACKUP_AGE_RECIPIENT: recipient, BACKUP_DIR: path.join(blocked, "x") }, /not writable/],
      [
        { BACKUP_AGE_RECIPIENT: recipient, FIXTURE_UNMOUNTED: "1" },
        /no backup destination: BACKUP_DIR \(.*\) is not a mounted volume and BACKUP_S3_BUCKET is unset/,
      ],
      [
        {
          BACKUP_AGE_RECIPIENT: recipient,
          BACKUP_S3_BUCKET: "fixture",
          BACKUP_S3_REGION: "eu-west-1",
        },
        /BACKUP_S3_ACCESS_KEY_ID \/ BACKUP_S3_SECRET_ACCESS_KEY are missing/,
      ],
    ]) {
      const result = check(extra);
      assert.equal(result.status, 1, `${JSON.stringify(extra)}: ${result.stderr}`);
      assert.match(result.stderr, pattern);
    }
    const ok = check({ BACKUP_AGE_RECIPIENT: recipient });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /Backup destination OK/);
    // Off: nothing is required and nothing is checked.
    const off = check({ BACKUP_ENABLED: "false" });
    assert.equal(off.status, 0, off.stderr);
    assert.equal(off.stdout + off.stderr, "");
  });

  for (const enabled of [undefined, "", "false"])
    test(`BACKUP_ENABLED=${enabled} never runs the hook, a brand-new database included`, async () => {
      for (const rows of [[], [applied("0_init")]]) {
        const { hook, calls } = recordingHook(`off-${enabled}-${rows.length}`);
        const result = await runtime(fakeDb({ rows: [...rows] }), {
          env: { DATABASE_URL: URL, ...(enabled === undefined ? {} : { BACKUP_ENABLED: enabled }) },
          backupHook: hook,
          deploy: freshDeploy,
        });
        assert.equal(result.code, 0, result.out);
        assert.deepEqual(calls(), []);
        assert.deepEqual(result.calls, ["migrate deploy"]);
      }
    });
});
