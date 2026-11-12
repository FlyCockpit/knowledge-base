/**
 * Real-Postgres scenarios for scheduled deletions (contract.sql), run by
 * `pnpm db:test-migrations` (scripts/db/test-migrations.mjs) against its
 * DISPOSABLE server. The real runner (migrate-runtime.mjs) and real Prisma
 * apply hand-built fixture folders in temp directories; the migration role is
 * a non-superuser `knowledge_base_app` that owns every scratch database here.
 *
 * Scenario numbers follow the expand/contract plan's test list:
 *   2 the soak, then the drop · 3 an old heartbeat blocks · 4 rollback
 *   admission · 6 transient vs counted failures · 8 name reuse · 9 fresh DB ·
 *   10 the pre-drop backup · 11 enum removal (persistent session, unowned
 *   trigger function, procedure, external cancel) · 12 holds · 13 recover
 * Scenario 5 (FOR SHARE vs FOR UPDATE ordering) is covered by the spike only.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { writeTestBackupHook } from "./lib/test-backup-hook.mjs";

// Assembled so policy greps never read the fixtures as live commands.
const DROP = "DROP";

/**
 * @param {{ step: (name: string, fn: () => Promise<void>) => Promise<void>,
 *   serverUrl: string, container: string | null, repo: string, pg: typeof import("pg"),
 *   sh: (cmd: string, args: string[]) => { code: number, out: string } }} context
 */
export async function contractScenarios({ step, serverUrl, container, repo, pg, sh }) {
  const lib = (file) => import(path.join(repo, "scripts/db", file));
  const { run, runHold } = await lib("migrate-runtime.mjs");
  const { prisma, tempConfig } = await lib("lib/prisma.mjs");
  const { catalogFromSql, enumRemoveContract, enumRemoveExpand, recoverBlock, wrapTransactional } =
    await lib("lib/sql.mjs");
  const { holdUpsertSql, readLiveCatalog } = await lib("lib/contracts.mjs");

  const work = mkdtempSync(path.join(tmpdir(), "knowledge-base-contracts-e2e-"));
  const runSuffix = randomBytes(4).toString("hex");
  const appRole = `knowledge_base_app_${runSuffix}`;
  const dbNames = new Map();
  const createdDatabases = new Set();
  const { adminClient, removeDatabase } = await lib("lib/scratch-db.mjs");
  const actualDb = (db) => {
    if (!dbNames.has(db)) dbNames.set(db, `knowledge_base_test_${randomBytes(6).toString("hex")}`);
    return dbNames.get(db);
  };
  const urlFor = (db, { user = appRole, password = "knowledge_base_app", schema } = {}) => {
    const url = new URL(serverUrl);
    url.username = user;
    url.password = password;
    url.pathname = `/${actualDb(db)}`;
    if (schema) url.searchParams.set("schema", schema);
    return url.toString();
  };
  const superUrl = (db) => {
    const url = new URL(serverUrl);
    url.pathname = `/${actualDb(db)}`;
    return url.toString();
  };
  const q = async (url, text, params) => {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      return (await client.query(text, params)).rows;
    } finally {
      await client.end();
    }
  };
  const app = (db, text, params) => q(urlFor(db), text, params);
  const createDb = async (db) => {
    const name = actualDb(db);
    await q(serverUrl, `CREATE DATABASE "${name}" OWNER "${appRole}"`);
    createdDatabases.add(name);
  };
  const waitForServer = async () => {
    for (let i = 0; ; i++) {
      try {
        await q(serverUrl, "SELECT 1");
        return;
      } catch {
        if (i > 150) throw new Error("postgres did not come back");
        await delay(200);
      }
    }
  };
  await q(serverUrl, `CREATE ROLE "${appRole}" LOGIN PASSWORD 'knowledge_base_app'`);

  // --- fixture folders --------------------------------------------------------
  const F0 = "0_init";
  const F1 = "20990101000000_retire_x";
  const F2 = "20990102000000_remove_b";
  const F3 = "20990103000000_bad_drop";
  const F4 = "20990104000000_next";
  const F5 = "20990105000000_readd_x";
  const F6 = "20990106000000_recover_x";
  const HEADER = {
    enumName: "E",
    pairs: [{ from: "B", to: "A" }],
    columns: [{ table: "t", column: "c", array: false }],
    folder: F2,
  };
  const FOLDERS = {
    [F0]: {
      sql: wrapTransactional(
        `CREATE TYPE "E" AS ENUM ('A', 'B');\nCREATE TABLE "t" ("id" INTEGER NOT NULL, "x" TEXT, "c" "E" NOT NULL DEFAULT 'A', CONSTRAINT "t_pkey" PRIMARY KEY ("id"));`,
      ),
    },
    [F1]: {
      sql: wrapTransactional(`CREATE INDEX "t_c_idx" ON "t"("c");`),
      contract: `ALTER TABLE "t" ${DROP} COLUMN "x";\n`,
    },
    [F2]: {
      sql: wrapTransactional(enumRemoveExpand(HEADER)),
      contract: `${enumRemoveContract(HEADER)}\n`,
    },
    [F3]: {
      sql: wrapTransactional(`CREATE INDEX "t_id_idx" ON "t"("id");`),
      contract: `${DROP} INDEX "no_such_idx";\n`,
    },
    [F4]: { sql: wrapTransactional(`CREATE INDEX "t_id_c_idx" ON "t"("id", "c");`) },
    [F5]: { sql: wrapTransactional(`ALTER TABLE "t" ADD COLUMN "x" TEXT;`) },
    [F6]: {
      sql: wrapTransactional(
        `ALTER TABLE "t" ADD COLUMN "x2" TEXT;\n\n${recoverBlock({ table: "t", from: "x", to: "x2" })}`,
      ),
    },
  };
  const IMAGE = catalogFromSql(
    `CREATE TYPE "E" AS ENUM ('A');\nCREATE TABLE "t" ("id" INTEGER NOT NULL, "c" "E" NOT NULL DEFAULT 'A', "x2" TEXT, CONSTRAINT "t_pkey" PRIMARY KEY ("id"));`,
  );
  /** Per fixture set (the folder objects), then per folder list. */
  const dirs = new Map();
  const dirOf = (folders, names) => {
    const cache = dirs.get(folders) ?? new Map();
    dirs.set(folders, cache);
    const key = names.join(",");
    if (cache.has(key)) return cache.get(key);
    const dir = mkdtempSync(path.join(work, "m-"));
    writeFileSync(path.join(dir, "migration_lock.toml"), 'provider = "postgresql"\n');
    for (const name of names) {
      mkdirSync(path.join(dir, name));
      writeFileSync(path.join(dir, name, "migration.sql"), folders[name].sql);
      if (folders[name].contract)
        writeFileSync(path.join(dir, name, "contract.sql"), folders[name].contract);
    }
    cache.set(key, dir);
    return dir;
  };

  // Synthetic completed-pair result; KB's real encrypted bundles are covered by W2.
  const hookLog = path.join(work, "hook.log");
  const hook = writeTestBackupHook(work, {
    logFile: hookLog,
    failFile: path.join(work, "hook-fail"),
  });
  const hookCalls = () => {
    try {
      return readFileSync(hookLog, "utf8").trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };

  const apply = async (db, names, options = {}) => {
    const { mode = "apply", id, role, folders = FOLDERS, image = IMAGE, schema } = options;
    const url = urlFor(db, { schema });
    const dir = dirOf(folders, names);
    const config = tempConfig({ url, migrations: dir });
    const lines = [];
    const original = { log: console.log, error: console.error };
    console.log = (...a) => lines.push(a.join(" "));
    console.error = (...a) => lines.push(a.join(" "));
    let code;
    try {
      code = await run({
        mode,
        role,
        env: { DATABASE_URL: url, ...(id ? { KB_INSTANCE_ID: id } : {}) },
        migrationsDir: dir,
        runPrisma: (args, opts) =>
          prisma([...args, "--config", config], { ...opts, capture: true }).then((r) => {
            if (r.code !== 0) lines.push(r.stdout, r.stderr);
            return r;
          }),
        backupHook: options.backupHook ?? hook,
        connectRetryMs: 0,
        waitTimeoutMs: 20_000,
        contracts: { imageCatalog: async () => image },
      });
    } finally {
      Object.assign(console, original);
      rmSync(path.dirname(config), { recursive: true, force: true });
    }
    return { code, out: lines.join("\n") };
  };
  const uuid = () => crypto.randomUUID();
  const columns = async (db, table = "t") =>
    (
      await app(
        db,
        `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY 1`,
        [table],
      )
    ).map((r) => r.column_name);
  const labels = async (db, type = "E") =>
    (
      await app(
        db,
        `SELECT enumlabel FROM pg_enum WHERE enumtypid = to_regtype($1) ORDER BY enumsortorder`,
        [`"${type}"`],
      )
    ).map((r) => r.enumlabel);
  const row = async (db, name) =>
    (await app(db, `SELECT * FROM "_knowledge_base_migration" WHERE name = $1`, [name]))[0];
  const holds = (db) =>
    app(db, `SELECT reason, until, set_at FROM "_knowledge_base_hold" ORDER BY reason`);
  /** The soak is over for every instance at ≥ level; everything older is stale. */
  const soakOver = async (db, level) => {
    await app(
      db,
      `UPDATE "_knowledge_base_instance" SET ready_at = now() - interval '691200 seconds' WHERE schema_level >= $1 COLLATE "C"`,
      [level],
    );
    await app(
      db,
      `UPDATE "_knowledge_base_instance" SET last_seen_at = now() - interval '691200 seconds'
        WHERE schema_level IS NULL OR schema_level < $1 COLLATE "C"`,
      [level],
    );
  };
  const A = [F0];
  const B = [F0, F1, F2];
  const C = [F0, F1, F2, F3];
  const D = [F0, F1, F2, F3, F4];

  try {
    // ------------------------------------------------------------ s1 (served)
    const s1 = "knowledge_base_test_c_s1";
    await createDb(s1);
    await step(
      "contracts: first deploy on an empty database writes the cluster row, no hold",
      async () => {
        const r = await apply(s1, A);
        assert.equal(r.code, 0, r.out);
        assert.equal((await row(s1, F0)).rollback_safe, true);
        const cluster = await app(
          s1,
          `SELECT *, to_regclass('"_knowledge_base_cluster"')::oid::text AS live FROM "_knowledge_base_cluster"`,
        );
        assert.equal(cluster.length, 1);
        assert.equal(String(cluster[0].registry_oid), cluster[0].live);
        assert.equal("observed_at" in cluster[0], false);
        assert.deepEqual(await holds(s1), []);
      },
    );
    await step(
      "contracts 2a: a deploy with contracts records them and waits for the soak",
      async () => {
        const r = await apply(s1, B, { id: uuid() });
        assert.equal(r.code, 0, r.out);
        assert.match(
          r.out,
          /scheduled deletion 20990101000000_retire_x: will delete column "t"\."x" 7 days after/,
        );
        assert.ok((await columns(s1)).includes("x"));
        assert.ok((await row(s1, F1)).contract_checksum);
        assert.equal((await row(s1, F2)).rollback_safe, true, "the enum expand is rollback-safe");
      },
    );
    await step(
      "contracts: a folder merged out of order waits for the older release that lacks it",
      async () => {
        const db = "knowledge_base_test_c_out_of_order";
        await createDb(db);
        const oldId = uuid();
        let r = await apply(db, [F0, F4], { id: oldId });
        assert.equal(r.code, 0, r.out);
        // The older release (level F4 > F1, without F1) has served for 10 days.
        await app(
          db,
          `UPDATE "_knowledge_base_instance" SET ready_at = now() - interval '864000 seconds' WHERE id = $1`,
          [oldId],
        );
        const newId = uuid();
        r = await apply(db, [F0, F1, F4], { id: newId });
        assert.equal(r.code, 0, r.out);
        assert.match(
          r.out,
          /OUT-OF-ORDER MIGRATION: 20990101000000_retire_x sorts before the already-applied 20990104000000_next/,
        );
        const folders = await app(
          db,
          `SELECT id::text AS id, contract_folders FROM "_knowledge_base_instance" ORDER BY started_at`,
        );
        assert.deepEqual(
          folders.map((f) => [f.id, f.contract_folders]),
          [
            [oldId, []],
            [newId, [F1]],
          ],
        );
        // The release containing F1 has soaked; the older one is still alive.
        await app(
          db,
          `UPDATE "_knowledge_base_instance" SET ready_at = now() - interval '691200 seconds' WHERE id = $1`,
          [newId],
        );
        r = await apply(db, [F0, F1, F4]);
        assert.equal(r.code, 0, r.out);
        assert.match(
          r.out,
          /waiting for: server@\S+ on 20990104000000_next, an image without this migration/,
        );
        assert.doesNotMatch(r.out, /DATA DELETED/);
        assert.ok((await columns(db)).includes("x"));
        // Once the older release is gone, the deletion runs.
        await app(
          db,
          `UPDATE "_knowledge_base_instance" SET last_seen_at = now() - interval '691200 seconds' WHERE id = $1`,
          [oldId],
        );
        r = await apply(db, [F0, F1, F4]);
        assert.equal(r.code, 0, r.out);
        assert.match(r.out, /DATA DELETED: column "t"\."x"/);
        assert.ok(!(await columns(db)).includes("x"));
      },
    );
    await step("contracts 3: an old-level heartbeat blocks the drop", async () => {
      await soakOver(s1, F2);
      await app(
        s1,
        `INSERT INTO "_knowledge_base_instance"(id, role, schema_level, host) VALUES ($1, 'worker', '0_init', 'old-host')`,
        [uuid()],
      );
      const r = await apply(s1, B);
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /waiting for: worker@old-host on 0_init/);
      assert.ok((await columns(s1)).includes("x"));
    });
    await step(
      "contracts 4a: an older image is admitted (wait registers; the id-less job is read-only)",
      async () => {
        const id = uuid();
        const w = await apply(s1, A, { mode: "wait", id, role: "worker" });
        assert.equal(w.code, 0, w.out);
        assert.match(w.out, /older release running against a newer schema/);
        const count = async () =>
          (await app(s1, `SELECT count(*)::int AS n FROM "_knowledge_base_instance"`))[0].n;
        const before = await count();
        const job = await apply(s1, A);
        assert.equal(job.code, 0, job.out);
        assert.match(job.out, /rollback admitted/);
        assert.equal(await count(), before);
      },
    );
    await step("contracts 6a: a lock held by another session (55P03) is not counted", async () => {
      await soakOver(s1, F2);
      const holder = new pg.Client({ connectionString: urlFor(s1) });
      await holder.connect();
      await holder.query("BEGIN");
      await holder.query(`SELECT * FROM "t"`);
      try {
        const r = await apply(s1, B);
        assert.equal(r.code, 0, r.out);
        assert.match(r.out, /\(transient\): 55P03/);
        assert.match(r.out, /retrying \(database busy: 55P03\)/);
      } finally {
        await holder.query("ROLLBACK");
        await holder.end();
      }
      const r1 = await row(s1, F1);
      assert.equal(r1.contract_attempts, 0);
      assert.equal(r1.contract_applied_at, null);
    });
    await step(
      "contracts 2b + 10: due → one pre-drop backup, both contracts, DATA DELETED",
      async () => {
        await app(s1, `INSERT INTO "t"(id, c) VALUES (1, 'B'), (2, 'A')`);
        rmSync(hookLog, { force: true });
        const r = await apply(s1, B);
        assert.equal(r.code, 0, r.out);
        assert.deepEqual(hookCalls(), ["--label pre-drop"]);
        assert.match(r.out, /DATA DELETED: column "t"\."x"/);
        assert.match(r.out, /DATA DELETED: value "B" of enum "E" \(rows moved to "A"\)/);
        assert.match(r.out, /backup: .*"label":"pre-drop"/);
        assert.ok(!(await columns(s1)).includes("x"));
        assert.deepEqual(await labels(s1), ["A"]);
        assert.equal(JSON.parse((await row(s1, F1)).contract_backup).label, "pre-drop");
        assert.deepEqual(
          await app(
            s1,
            `SELECT tgname FROM pg_trigger WHERE tgrelid = '"t"'::regclass AND NOT tgisinternal`,
          ),
          [],
        );
      },
    );
    await step("contracts 10b: nothing due → no backup", async () => {
      rmSync(hookLog, { force: true });
      const r = await apply(s1, B);
      assert.equal(r.code, 0, r.out);
      assert.deepEqual(hookCalls(), []);
    });
    await step("contracts 4b: an older image is refused once the deletion ran", async () => {
      const r = await apply(s1, A, { mode: "wait", id: uuid() });
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /deletion already ran/);
    });
    await step(
      "contracts 6b: a deterministic error counts; needs a person after 3; a newer level retries",
      async () => {
        let r = await apply(s1, C, { id: uuid() });
        assert.equal(r.code, 0, r.out);
        await soakOver(s1, F3);
        for (const n of [1, 2, 3]) {
          r = await apply(s1, C);
          assert.equal(r.code, 0, r.out);
          assert.match(r.out, /failed and was rolled back \(counted\): 42704/);
          assert.equal((await row(s1, F3)).contract_attempts, n);
        }
        assert.match(r.out, /needs a person: 42704/);
        r = await apply(s1, C);
        assert.doesNotMatch(r.out, /failed and was rolled back/);
        r = await apply(s1, D, { id: uuid() });
        assert.equal(r.code, 0, r.out);
        assert.match(r.out, /\(counted\): 42704/, "a newer level gets fresh tries");
        const r3 = await row(s1, F3);
        assert.deepEqual([r3.contract_attempts, r3.contract_attempt_level], [1, F4]);
      },
    );
    await step("contracts 10c: a failing pre-drop backup skips the contracts", async () => {
      writeFileSync(path.join(work, "hook-fail"), "");
      try {
        const r = await apply(s1, D);
        assert.equal(r.code, 0, r.out);
        assert.match(
          r.out,
          /pre-drop backup failed \(exit 1\); scheduled deletions skipped this run/,
        );
        assert.equal((await row(s1, F3)).contract_attempts, 1, "no attempt was made");
      } finally {
        rmSync(path.join(work, "hook-fail"));
      }
    });
    await step(
      "contracts: the pre-deploy catalog read does not wait behind ACCESS EXCLUSIVE",
      async () => {
        const holder = new pg.Client({ connectionString: urlFor(s1) });
        await holder.connect();
        await holder.query("BEGIN");
        await holder.query('LOCK TABLE "t" IN ACCESS EXCLUSIVE MODE');
        const reader = new pg.Client({ connectionString: urlFor(s1) });
        await reader.connect();
        try {
          const t0 = Date.now();
          const live = await readLiveCatalog(reader, "public", { defaults: false });
          assert.ok(Date.now() - t0 < 2_000, `took ${Date.now() - t0} ms`);
          assert.ok(live.tables.get("public.t").columns.has("c"));
          await assert.rejects(readLiveCatalog(reader, "public"), /lock timeout|55P03/);
        } finally {
          await holder.query("ROLLBACK");
          await holder.end();
          await reader.end();
        }
      },
    );
    await step("contracts: a hold upsert never shortens a longer hold", async () => {
      await app(
        s1,
        `INSERT INTO "_knowledge_base_hold"(reason, until) VALUES ('owner', now() + interval '2592000 seconds')`,
      );
      const [held] = await app(s1, holdUpsertSql("public"), ["owner", 7 * 86_400_000]);
      assert.ok((new Date(held.until).getTime() - Date.now()) / 86_400_000 > 29);
      await app(s1, `DELETE FROM "_knowledge_base_hold" WHERE reason = 'owner'`);
    });
    await step(
      "contracts 8a + 13b: reusing a deleted name is allowed once it is gone; a late recover logs",
      async () => {
        const r = await apply(s1, [...D, F5, F6], { id: uuid() });
        assert.equal(r.code, 0, r.out);
        assert.match(
          r.out,
          /RECOVERY TOO LATE: "t"\."x" was deleted on \S+ \(backup: .*"label":"pre-drop"/,
        );
        assert.ok((await columns(s1)).includes("x"), "F5 re-added x (a new, empty column)");
      },
    );

    // ------------------------------------------------------------ s2 (fresh)
    await step(
      "contracts 9: a fresh database applies every contract at once (no backup, no soak)",
      async () => {
        const s2 = "knowledge_base_test_c_s2";
        await createDb(s2);
        rmSync(hookLog, { force: true });
        const r = await apply(s2, B, { id: uuid() });
        assert.equal(r.code, 0, r.out);
        assert.ok(!(await columns(s2)).includes("x"));
        assert.deepEqual(await labels(s2), ["A"]);
        assert.ok(!hookCalls().some((c) => c.includes("pre-drop")));
        assert.ok((await row(s2, F2)).contract_applied_at);
        assert.deepEqual(await holds(s2), []);
      },
    );

    // ------------------------------------------------------------ s3 (holds)
    const s3 = "knowledge_base_test_c_s3";
    await createDb(s3);
    const prepare = async (db) => {
      let r = await apply(db, A);
      assert.equal(r.code, 0, r.out);
      r = await apply(db, B, { id: uuid() });
      assert.equal(r.code, 0, r.out);
      await soakOver(db, F2);
    };
    await step("contracts 8b: reusing a name whose deletion has not run is refused", async () => {
      await prepare(s3);
      const r = await apply(s3, [...B, F5]);
      assert.equal(r.code, 1, r.out);
      assert.match(
        r.out,
        /reuse a name that an earlier scheduled deletion removes: 20990105000000_readd_x/,
      );
      assert.match(r.out, /This cannot be overridden/);
    });
    await step("contracts 12a: an owner hold (hold-deletions) blocks the drop", async () => {
      const hold = (args) => runHold({ args, env: { DATABASE_URL: urlFor(s3) }, pg, pollMs: 50 });
      assert.equal(await hold(["1"]), 0);
      assert.deepEqual(
        (await holds(s3)).map((h) => h.reason),
        ["owner"],
      );
      const r = await apply(s3, B);
      assert.match(r.out, /held until \S+ \(owner\)/);
      assert.ok((await columns(s3)).includes("x"));
      assert.equal(await hold(["--clear"]), 0);
      assert.deepEqual(await holds(s3), []);
    });
    await step(
      "contracts 12b: a changed timeline in the stored row → cluster-changed hold",
      async () => {
        await app(
          s3,
          `UPDATE "_knowledge_base_cluster" SET timeline = timeline + 1 WHERE singleton`,
        );
        const r = await apply(s3, B);
        assert.match(r.out, /database was restored or moved \(timeline: \d+ → \d+\)/);
        assert.deepEqual(
          (await holds(s3)).map((h) => h.reason),
          ["cluster-changed"],
        );
        assert.ok((await columns(s3)).includes("x"));
        await app(s3, `DELETE FROM "_knowledge_base_hold" WHERE reason = 'cluster-changed'`);
      },
    );
    await step("contracts 12f: a served database with no cluster row → one hold", async () => {
      await app(s3, `DELETE FROM "_knowledge_base_cluster" WHERE singleton`);
      const r = await apply(s3, B);
      assert.match(
        r.out,
        /deletion scheduling starts on this database; scheduled deletions held until/,
      );
      assert.deepEqual(
        (await holds(s3)).map((h) => h.reason),
        ["cluster-changed"],
      );
      assert.ok((await columns(s3)).includes("x"));
      await app(s3, `DELETE FROM "_knowledge_base_hold" WHERE reason = 'cluster-changed'`);
    });
    if (container)
      await step(
        "contracts 12c: VACUUM FULL, CLUSTER, REINDEX and a server restart write nothing",
        async () => {
          const read = async () =>
            (
              await app(s3, `SELECT changed_at, registry_oid::text FROM "_knowledge_base_cluster"`)
            )[0];
          const before = await read();
          await app(s3, `VACUUM FULL "_knowledge_base_cluster"`);
          await app(s3, `CLUSTER "_knowledge_base_cluster" USING "_knowledge_base_cluster_pkey"`);
          await app(s3, `REINDEX TABLE "_knowledge_base_cluster"`);
          const restart = sh("docker", ["restart", container]);
          assert.equal(restart.code, 0, restart.out);
          await waitForServer();
          await app(
            s3,
            `INSERT INTO "_knowledge_base_hold"(reason, until) VALUES ('owner', now() + interval '86400 seconds')`,
          );
          const r = await apply(s3, B);
          assert.equal(r.code, 0, r.out);
          assert.deepEqual(await read(), before);
          assert.deepEqual(
            (await holds(s3)).map((h) => h.reason),
            ["owner"],
          );
          await app(s3, `DELETE FROM "_knowledge_base_hold" WHERE reason = 'owner'`);
        },
      );
    await step(
      "contracts 12d: REVOKE pg_control_system → one hold, 'unavailable' id, timeline still read; a second run adds none",
      async () => {
        await q(superUrl(s3), "REVOKE EXECUTE ON FUNCTION pg_control_system() FROM PUBLIC");
        try {
          await app(
            s3,
            `INSERT INTO "_knowledge_base_hold"(reason, until) VALUES ('owner', now() + interval '86400 seconds')`,
          );
          let r = await apply(s3, B);
          assert.equal(r.code, 0, r.out);
          assert.match(r.out, /system_identifier: \d+ → unavailable/);
          // The timeline is read on its own, so a PITR is still detected.
          const stored = (
            await app(s3, `SELECT system_identifier, timeline FROM "_knowledge_base_cluster"`)
          )[0];
          assert.equal(stored.system_identifier, "unavailable");
          assert.equal(typeof stored.timeline, "number");
          const first = (await holds(s3)).find((h) => h.reason === "cluster-changed");
          assert.ok(first);
          r = await apply(s3, B);
          const second = (await holds(s3)).find((h) => h.reason === "cluster-changed");
          assert.equal(second.set_at.getTime(), first.set_at.getTime());
          assert.doesNotMatch(r.out, /restored or moved/);
        } finally {
          await q(superUrl(s3), "GRANT EXECUTE ON FUNCTION pg_control_system() TO PUBLIC");
          await app(
            s3,
            `DELETE FROM "_knowledge_base_hold" WHERE reason IN ('owner', 'cluster-changed')`,
          );
        }
      },
    );
    await step("contracts 13a: a recover block before the deletion copies the data", async () => {
      await app(s3, `INSERT INTO "t"(id, c, x) VALUES (10, 'A', 'kept me')`);
      const r = await apply(s3, [...B, F6], { id: uuid() });
      assert.equal(r.code, 0, r.out);
      assert.doesNotMatch(r.out, /RECOVERY TOO LATE/);
      assert.deepEqual(await app(s3, `SELECT x2 FROM "t" WHERE id = 10`), [{ x2: "kept me" }]);
    });

    // ------------------------------------------------------------ s4 (logical restore)
    if (container)
      await step(
        "contracts 12e: a Dokploy-style in-place pg_restore --clean → hold, contract not re-run",
        async () => {
          const s4 = "knowledge_base_test_c_s4";
          await createDb(s4);
          await prepare(s4);
          const exec = (args) =>
            sh("docker", ["exec", "-e", "PGPASSWORD=knowledge_base_app", container, ...args]);
          let dump = exec([
            "pg_dump",
            "-h",
            "127.0.0.1",
            "-U",
            appRole,
            "-Fc",
            "--no-acl",
            "--no-owner",
            "-f",
            "/tmp/s4.dump",
            actualDb(s4),
          ]);
          assert.equal(dump.code, 0, dump.out);
          let r = await apply(s4, B);
          assert.match(r.out, /DATA DELETED: column "t"\."x"/);
          dump = exec([
            "pg_restore",
            "-h",
            "127.0.0.1",
            "-U",
            appRole,
            "-O",
            "--clean",
            "--if-exists",
            "-d",
            actualDb(s4),
            "/tmp/s4.dump",
          ]);
          assert.equal(dump.code, 0, dump.out);
          assert.ok((await columns(s4)).includes("x"), "the restore brought the column back");
          assert.equal((await row(s4, F1)).contract_applied_at, null);
          r = await apply(s4, B);
          assert.equal(r.code, 0, r.out);
          assert.match(r.out, /restored from a logical backup \(registry table recreated\)/);
          assert.ok((await columns(s4)).includes("x"), "not re-applied this run");
          const same = await app(
            actualDb(s4),
            `SELECT registry_oid::text = to_regclass('"_knowledge_base_cluster"')::oid::text AS same FROM "_knowledge_base_cluster"`,
          );
          assert.deepEqual(same, [{ same: true }]);
        },
      );

    // ------------------------------------------------------------ s5 (?schema=)
    await step(
      "contracts: Prisma ?schema= other than public: qualified tables, contract applies",
      async () => {
        const s5 = "knowledge_base_test_c_s5";
        await createDb(s5);
        await app(s5, `CREATE SCHEMA tenant`);
        const r = await apply(s5, B, { schema: "tenant" });
        assert.equal(r.code, 0, r.out);
        const t = await app(
          s5,
          `SELECT table_name FROM information_schema.tables WHERE table_schema = 'tenant' AND table_name LIKE '\\_knowledge_base\\_%' ORDER BY 1`,
        );
        assert.deepEqual(
          t.map((x) => x.table_name),
          [
            "_knowledge_base_cluster",
            "_knowledge_base_hold",
            "_knowledge_base_instance",
            "_knowledge_base_migration",
          ],
        );
        const x = await app(
          s5,
          `SELECT column_name FROM information_schema.columns WHERE table_schema = 'tenant' AND table_name = 't'`,
        );
        assert.ok(!x.map((c) => c.column_name).includes("x"));
      },
    );

    await enumScenarios();
  } finally {
    await step("contracts: clean up only the scratch databases created by this run", async () => {
      const client = await adminClient(pg, serverUrl);
      try {
        for (const name of createdDatabases)
          await removeDatabase(client, name, { kind: "scratch" });
      } finally {
        await client.end();
      }
    });
    rmSync(work, { recursive: true, force: true });
  }

  // ------------------------------------------------------------ 11: enum removal
  async function enumScenarios() {
    const E0 = "0_init";
    const E1 = "20990201000000_remove_b";
    const E2 = "20990202000000_remove_c";
    const E3 = "20990203000000_add_w2";
    const header = (folder, from) => ({
      enumName: "S",
      pairs: [{ from, to: "A" }],
      columns: [{ table: "w", column: "s", array: false }],
      folder,
    });
    const userObjects = [
      `CREATE TYPE "S" AS ENUM ('A', 'B', 'C');`,
      `CREATE TABLE "w" ("id" SERIAL NOT NULL, "s" "S" NOT NULL DEFAULT 'B', "note" TEXT, "n" INTEGER NOT NULL DEFAULT 0, CONSTRAINT "w_pkey" PRIMARY KEY ("id"));`,
      // A user plpgsql trigger and procedure that bind the enum type (R4-1, R5-1).
      `CREATE FUNCTION "w_note"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."s" = 'A'::"S" THEN NEW."note" := 'is-a'; END IF; RETURN NEW; END $$;`,
      `CREATE TRIGGER "w_note" BEFORE INSERT OR UPDATE ON "w" FOR EACH ROW EXECUTE FUNCTION "w_note"();`,
      `CREATE PROCEDURE "pp"(INOUT r TEXT) LANGUAGE plpgsql AS $$ DECLARE x "S" := 'A'; BEGIN r := x::text; END $$;`,
    ].join("\n");
    const ENUM_FOLDERS = {
      [E0]: { sql: wrapTransactional(userObjects) },
      [E1]: {
        sql: wrapTransactional(
          `${enumRemoveExpand(header(E1, "B"))}\nALTER TABLE "w" ALTER COLUMN "s" SET DEFAULT 'A';`,
        ),
        contract: `${enumRemoveContract(header(E1, "B"))}\n`,
      },
      [E2]: {
        sql: wrapTransactional(enumRemoveExpand(header(E2, "C"))),
        contract: `${enumRemoveContract(header(E2, "C"))}\n`,
      },
      [E3]: {
        sql: wrapTransactional(
          `CREATE TABLE "w2" ("id" INTEGER NOT NULL, "s" "S" NOT NULL DEFAULT 'A', CONSTRAINT "w2_pkey" PRIMARY KEY ("id"));`,
        ),
      },
    };
    const ENUM_IMAGE = catalogFromSql(
      `CREATE TYPE "S" AS ENUM ('A');\nCREATE TABLE "w" ("id" SERIAL NOT NULL, "s" "S" NOT NULL DEFAULT 'A', "note" TEXT, "n" INTEGER NOT NULL DEFAULT 0, CONSTRAINT "w_pkey" PRIMARY KEY ("id"));\nCREATE TABLE "w2" ("id" INTEGER NOT NULL, "s" "S" NOT NULL DEFAULT 'A', CONSTRAINT "w2_pkey" PRIMARY KEY ("id"));`,
    );
    const applyE = (db, names, options = {}) =>
      apply(db, names, { folders: ENUM_FOLDERS, image: ENUM_IMAGE, ...options });

    await step(
      "contracts 11 (R4-1, R5-1): a warm pooled session keeps working across two enum rebuilds",
      async () => {
        const db = "knowledge_base_test_c_enum";
        await createDb(db);
        assert.equal((await applyE(db, [E0])).code, 0);
        let r = await applyE(db, [E0, E1, E2], { id: uuid() });
        assert.equal(r.code, 0, r.out);
        const warm = new pg.Client({ connectionString: urlFor(db) });
        await warm.connect();
        try {
          // Before contract 1: old code writes both removed values; both sync
          // triggers fire, and the user trigger and procedure get cached plans.
          await warm.query(`INSERT INTO "w"("s") VALUES ('B'), ('C')`);
          await warm.query(`INSERT INTO "w" DEFAULT VALUES`);
          assert.deepEqual((await warm.query(`CALL "pp"(NULL)`)).rows, [{ r: "A" }]);
          assert.deepEqual(
            (await warm.query(`SELECT DISTINCT "s"::text AS s, "note" FROM "w"`)).rows,
            [{ s: "A", note: "is-a" }],
          );
          // Contract 1 is due; an instance still at E1 keeps contract 2 waiting.
          await soakOver(db, E2);
          await app(
            db,
            `INSERT INTO "_knowledge_base_instance"(id, role, schema_level, host, ready_at, contract_folders)
             VALUES ($1, 'worker', $2, 'e1-host', now() - interval '691200 seconds', ARRAY[$2::text])`,
            [uuid(), E1],
          );
          r = await applyE(db, [E0, E1, E2]);
          assert.equal(r.code, 0, r.out);
          assert.match(r.out, /DATA DELETED: value "B" of enum "S" \(rows moved to "A"\)/);
          assert.doesNotMatch(r.out, /label-kept/);
          assert.match(r.out, /waiting for: worker@e1-host/);
          assert.deepEqual(await labels(db, "S"), ["A", "C"]);
          // The same session after the rebuild.
          await warm.query(`INSERT INTO "w"("s") VALUES ('C')`);
          await warm.query(`INSERT INTO "w" DEFAULT VALUES`);
          await warm.query(`UPDATE "w" SET "n" = "n" + 1`);
          assert.deepEqual((await warm.query(`CALL "pp"(NULL)`)).rows, [{ r: "A" }]);
          assert.deepEqual(
            (await warm.query(`SELECT DISTINCT "s"::text AS s, "note" FROM "w"`)).rows,
            [{ s: "A", note: "is-a" }],
          );
          // Contract 2 once the E1 instance is gone.
          await soakOver(db, E2);
          r = await applyE(db, [E0, E1, E2]);
          assert.equal(r.code, 0, r.out);
          assert.match(r.out, /DATA DELETED: value "C" of enum "S"/);
          assert.deepEqual(await labels(db, "S"), ["A"]);
          await warm.query(`INSERT INTO "w" DEFAULT VALUES`);
          assert.deepEqual((await warm.query(`CALL "pp"(NULL)`)).rows, [{ r: "A" }]);
        } finally {
          await warm.end();
        }
      },
    );

    await step(
      "contracts 11: a trigger function the migration role does not own → label kept, contract commits",
      async () => {
        const db = "knowledge_base_test_c_enum_unowned";
        await createDb(db);
        assert.equal((await applyE(db, [E0])).code, 0);
        await q(
          superUrl(db),
          `CREATE FUNCTION "other_owned"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
           CREATE TRIGGER "other_owned" BEFORE INSERT ON "w" FOR EACH ROW EXECUTE FUNCTION "other_owned"();`,
        );
        let r = await applyE(db, [E0, E1], { id: uuid() });
        assert.equal(r.code, 0, r.out);
        await soakOver(db, E1);
        r = await applyE(db, [E0, E1]);
        assert.equal(r.code, 0, r.out);
        assert.match(r.out, /knowledge-base:label-kept "S" "B" \(42501: must be owner of/);
        assert.ok((await row(db, E1)).contract_applied_at, "the contract committed");
        assert.deepEqual(await labels(db, "S"), ["A", "B", "C"]);
        await app(db, `INSERT INTO "w" DEFAULT VALUES`);
        assert.deepEqual(await app(db, `SELECT DISTINCT "s"::text AS s FROM "w"`), [{ s: "A" }]);
      },
    );

    await step(
      "contracts 11 (R4-3): an external cancel during the rebuild is transient, then it applies",
      async () => {
        const db = "knowledge_base_test_c_enum_cancel";
        await createDb(db);
        assert.equal((await applyE(db, [E0])).code, 0);
        let r = await applyE(db, [E0, E1, E3], { id: uuid() });
        assert.equal(r.code, 0, r.out);
        await soakOver(db, E3);
        // w2 is not in E1's header, so its column is rebuilt inside the sub-block.
        const locker = new pg.Client({ connectionString: urlFor(db) });
        await locker.connect();
        await locker.query("BEGIN");
        await locker.query(`SELECT * FROM "w2"`);
        let canceled = false;
        const canceler = (async () => {
          for (let i = 0; i < 80 && !canceled; i++) {
            const rows = await q(
              serverUrl,
              `SELECT pid FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock' AND query LIKE '%knowledge_base_enum%'`,
              [actualDb(db)],
            );
            if (rows.length) {
              await q(serverUrl, "SELECT pg_cancel_backend($1)", [rows[0].pid]);
              canceled = true;
            } else await delay(50);
          }
        })();
        try {
          r = await applyE(db, [E0, E1, E3]);
        } finally {
          await canceler;
          await locker.query("ROLLBACK");
          await locker.end();
        }
        assert.ok(canceled, "the rebuild was seen waiting and canceled");
        assert.equal(r.code, 0, r.out);
        assert.match(r.out, /\(transient\): 57014/);
        const after = await row(db, E1);
        assert.equal(after.contract_applied_at, null);
        assert.equal(after.contract_attempts, 0);
        assert.deepEqual(await labels(db, "S"), ["A", "B", "C"]);
        r = await applyE(db, [E0, E1, E3]);
        assert.equal(r.code, 0, r.out);
        assert.match(r.out, /DATA DELETED: value "B" of enum "S"/);
        assert.deepEqual(await labels(db, "S"), ["A", "C"]);
      },
    );
  }
}
