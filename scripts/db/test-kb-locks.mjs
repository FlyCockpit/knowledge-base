/** Real-Postgres KB admission and native crash barriers; called by test-migrations. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { writeTestBackupHook } from "./lib/test-backup-hook.mjs";

export async function kbLockScenarios({ step, serverUrl, repo, pg, sh }) {
  const lib = (file) => import(path.join(repo, "scripts/db/lib", file));
  const { adminClient, createDatabase, removeDatabase } = await lib("scratch-db.mjs");
  const { withDatabase } = await lib("local-db-name.mjs");
  const { KB_DDL_LOCK_KEY, PRISMA_ADVISORY_LOCK, MIGRATION_RUNNER_LOCK_KEY } =
    await lib("migration-state.mjs");
  const { tempConfig } = await lib("prisma.mjs");
  const { wrapTransactional } = await lib("sql.mjs");
  const work = mkdtempSync(path.join(tmpdir(), "knowledge-base-lock-barriers-"));
  const admin = await adminClient(pg, serverUrl);
  const names = [];
  const clients = [];
  const children = [];
  const hook = writeTestBackupHook(work);
  const guard = path.join(repo, "fixture-child-guard");
  const cliRequire = createRequire(
    realpathSync(path.join(repo, "packages/db/node_modules/prisma/build/index.js")),
  );
  const engineDir = path.resolve(path.dirname(cliRequire.resolve("@prisma/engines")), "..");
  const engineName = readdirSync(engineDir).find(
    (name) =>
      name.startsWith("schema-engine-") && !name.endsWith(".sha256") && !name.endsWith(".gz"),
  );
  assert.ok(engineName, "pinned schema engine exists");
  const engine = path.join(engineDir, engineName);
  const wrapper = path.join(work, "schema-engine-barrier");
  const cFile = path.join(work, "barrier.c");
  // The wrapper execs in place, so the guard's PDEATHSIG covers the delay AND
  // the eventual real engine. No shell, extra fork or recursive advisory lock.
  writeFileSync(
    cFile,
    `#include <stdio.h>\n#include <stdlib.h>\n#include <string.h>\n#include <unistd.h>\n#include <time.h>\nint main(int argc,char **argv){
 const char *real=getenv("KB_TEST_REAL_ENGINE"); if(!real)return 64;
 int probe=0; for(int i=1;i<argc;i++)if(!strcmp(argv[i],"--version"))probe=1;
 const char *barrier=getenv("KB_TEST_ENGINE_BARRIER");
 if(!probe && barrier){FILE *f=fopen(barrier,"w");if(!f)return 70;fprintf(f,"%ld",(long)getpid());fclose(f);
 const char *release=getenv("KB_TEST_ENGINE_RELEASE");struct timespec wait={0,10000000};while(access(release,F_OK)!=0)nanosleep(&wait,NULL);}
 argv[0]=(char*)real;execv(real,argv);return 127;}
`,
  );
  const compile = sh("cc", ["-O2", "-Wall", "-Wextra", "-Werror", cFile, "-o", wrapper]);
  assert.equal(compile.code, 0, compile.out);
  async function until(predicate, message) {
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      if (await predicate()) return;
      await delay(20);
    }
    assert.fail(message);
  }
  async function database() {
    const name = `knowledge_base_test_${randomBytes(6).toString("hex")}`;
    await createDatabase(admin, name);
    names.push(name);
    const url = withDatabase(serverUrl, name);
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    clients.push(client);
    return { name, url, client };
  }
  function folders(body) {
    const dir = path.join(work, randomBytes(6).toString("hex"));
    mkdirSync(path.join(dir, "0_init"), { recursive: true });
    writeFileSync(path.join(dir, "migration_lock.toml"), 'provider = "postgresql"\n');
    writeFileSync(path.join(dir, "0_init/migration.sql"), wrapTransactional(body));
    return dir;
  }
  function launch(url, migrations, { mode = "apply", barrier, release, timeoutMs } = {}) {
    const config = tempConfig({ url, migrations });
    const file = path.join(work, `${randomBytes(6).toString("hex")}.mjs`);
    writeFileSync(
      file,
      `import {run} from ${JSON.stringify(path.join(repo, "scripts/db/migrate-runtime.mjs"))};
import {prisma} from ${JSON.stringify(path.join(repo, "scripts/db/lib/prisma.mjs"))};
process.exitCode=await run({mode:${JSON.stringify(mode)},contracts:false,migrationsDir:${JSON.stringify(migrations)},backupHook:${JSON.stringify(hook)},env:process.env,runPrisma:(args,options)=>prisma([...args,"--config",${JSON.stringify(config)}],{...options,guardPath:${JSON.stringify(guard)},capture:true,timeoutMs:${JSON.stringify(timeoutMs)}})});`,
    );
    const child = spawn(guard, [String(process.pid), process.execPath, file], {
      env: {
        ...process.env,
        DATABASE_URL: url,
        PRISMA_SCHEMA_ENGINE_BINARY: wrapper,
        KB_TEST_REAL_ENGINE: engine,
        ...(barrier ? { KB_TEST_ENGINE_BARRIER: barrier, KB_TEST_ENGINE_RELEASE: release } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const done = new Promise((resolve) => child.on("close", (code) => resolve({ code, output })));
    return { child, done };
  }
  const locks = async (client, key) =>
    (
      await client.query(
        "SELECT count(*)::int n FROM pg_locks WHERE locktype='advisory' AND classid=0 AND objid=$1 AND objsubid=1 AND granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())",
        [key],
      )
    ).rows[0].n;
  try {
    await step(
      "KB: pending restore rejects apply, wait and hold before fresh admission",
      async () => {
        const { url, client } = await database();
        await client.query(
          "CREATE SCHEMA knowledge_base_control; CREATE TABLE knowledge_base_control.kb_restore(singleton boolean PRIMARY KEY DEFAULT true, attempt_id uuid, source_hash text, state text); INSERT INTO knowledge_base_control.kb_restore(state) VALUES('STAGING')",
        );
        const dir = folders("CREATE TABLE kb_lock_probe(id int PRIMARY KEY);");
        for (const mode of ["apply", "wait"]) {
          const result = await launch(url, dir, { mode }).done;
          assert.equal(result.code, 1, result.output);
          assert.match(result.output, /restore is pending/);
        }
        const { runHold } = await import(path.join(repo, "scripts/db/migrate-runtime.mjs"));
        assert.equal(await runHold({ env: { DATABASE_URL: url }, pg }), 1);
      },
    );
    await step(
      "KB: startup between restore preflight and durable intent cannot use stale fresh facts",
      async () => {
        const { url, client } = await database();
        await client.query(`SELECT pg_advisory_lock(${MIGRATION_RUNNER_LOCK_KEY})`);
        const owner = launch(url, folders("CREATE TABLE kb_lock_probe(id int PRIMARY KEY);"));
        await until(
          async () =>
            (
              await client.query(
                "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND application_name='knowledge-base-migrate-runner'",
              )
            ).rows.length > 0,
          "runner never reached restore's early lock",
        );
        await client.query(
          "CREATE SCHEMA knowledge_base_control; CREATE TABLE knowledge_base_control.kb_restore(singleton boolean PRIMARY KEY DEFAULT true,state text); INSERT INTO knowledge_base_control.kb_restore(state) VALUES('STAGING')",
        );
        await client.query(`SELECT pg_advisory_unlock(${MIGRATION_RUNNER_LOCK_KEY})`);
        const result = await owner.done;
        assert.equal(result.code, 1, result.output);
        assert.match(result.output, /restore is pending/);
        assert.equal(
          (await client.query("SELECT to_regclass('kb_lock_probe') AS t")).rows[0].t,
          null,
        );
      },
    );
    await step(
      "KB: catalog proof accepts empty history but refuses unexpected functions/types",
      async () => {
        const { client } = await database();
        const { isManagedSchemaEmpty } = await lib("migration-state.mjs");
        await client.query(`SELECT pg_advisory_lock(${KB_DDL_LOCK_KEY})`);
        await client.query(`SELECT pg_advisory_lock(${PRISMA_ADVISORY_LOCK})`);
        await client.query(
          "CREATE TABLE _prisma_migrations(id text PRIMARY KEY,checksum text,migration_name text,finished_at timestamptz,rolled_back_at timestamptz,logs text,started_at timestamptz DEFAULT now(),applied_steps_count int DEFAULT 0)",
        );
        assert.equal(await isManagedSchemaEmpty(client, "public"), true);
        await client.query(
          "CREATE FUNCTION unexpected_application_function() RETURNS int LANGUAGE sql AS 'SELECT 1'",
        );
        assert.equal(await isManagedSchemaEmpty(client, "public"), false);
        await client.query(`SELECT pg_advisory_unlock(${PRISMA_ADVISORY_LOCK})`);
        await client.query(`SELECT pg_advisory_unlock(${KB_DDL_LOCK_KEY})`);
      },
    );
    await step("KB: catalog capture handles PostgreSQL name and internal char fields", async () => {
      const { client } = await database();
      const { readApplicationCatalog } = await lib("migration-state.mjs");
      await client.query(`CREATE TYPE probe_kind AS ENUM ('ACTIVE','RETIRED');
        CREATE TABLE probe_catalog(id int PRIMARY KEY, kind probe_kind, note text DEFAULT 'value');
        CREATE FUNCTION probe_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
        CREATE TRIGGER probe_trigger BEFORE INSERT ON probe_catalog FOR EACH ROW EXECUTE FUNCTION probe_trigger();`);
      const rows = await readApplicationCatalog(client, "public");
      for (const kind of [
        "column",
        "constraint",
        "index",
        "trigger",
        "function",
        "enum",
        "relation",
        "schema",
      ])
        assert.ok(
          rows.some((row) => row.kind === kind),
          kind,
        );
      assert.match(rows.find((r) => r.kind === "trigger").definition, /:O$/);
      assert.deepEqual(JSON.parse(rows.find((r) => r.kind === "enum").definition), [
        "ACTIVE",
        "RETIRED",
      ]);
    });
    await step(
      "KB: successful and failed/rolled-back native migrations leave consistent history",
      async () => {
        const good = await database();
        const success = await launch(
          good.url,
          folders("CREATE TABLE kb_lock_probe(id int PRIMARY KEY);"),
        ).done;
        assert.equal(success.code, 0, success.output);
        assert.equal(
          (
            await good.client.query(
              "SELECT count(*)::int n FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL",
            )
          ).rows[0].n,
          1,
        );
        const bad = await database();
        const failure = await launch(
          bad.url,
          folders("CREATE TABLE kb_lock_probe(id int PRIMARY KEY); SELECT 1/0;"),
        ).done;
        assert.equal(failure.code, 1, failure.output);
        assert.equal(
          (await bad.client.query("SELECT to_regclass('kb_lock_probe') AS t")).rows[0].t,
          null,
        );
        assert.equal(await locks(bad.client, PRISMA_ADVISORY_LOCK), 0);
        assert.equal(await locks(bad.client, KB_DDL_LOCK_KEY), 0);
      },
    );
    for (const timing of ["before-prisma", "after-prisma"])
      for (const signal of timing === "before-prisma"
        ? ["SIGTERM", "SIGKILL", "timeout", "orphan-cli"]
        : ["SIGTERM", "SIGKILL", "timeout"])
        await step(
          `KB: ${signal} at ${timing} barrier drains/rolls back before snapshot exclusion`,
          async () => {
            const { url, client } = await database();
            const key = 90427351;
            const barrier = path.join(work, `${randomBytes(6).toString("hex")}.ready`);
            const release = `${barrier}.release`;
            const body = `CREATE TABLE kb_lock_probe(id int PRIMARY KEY);${timing === "after-prisma" ? `SELECT pg_advisory_xact_lock(${key});` : ""}`;
            if (timing === "after-prisma") await client.query(`SELECT pg_advisory_lock(${key})`);
            const owner = launch(
              url,
              folders(body),
              timing === "before-prisma"
                ? { barrier, release, ...(signal === "timeout" ? { timeoutMs: 5000 } : {}) }
                : signal === "timeout"
                  ? { timeoutMs: 5000 }
                  : {},
            );
            if (timing === "before-prisma")
              await until(
                () => existsSync(barrier),
                "native process did not reach pre-lock barrier",
              );
            else
              await until(
                async () =>
                  (await locks(client, PRISMA_ADVISORY_LOCK)) === 1 &&
                  (
                    await client.query(
                      "SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=$1 AND NOT granted",
                      [key],
                    )
                  ).rows.length > 0,
                "engine did not reach DDL barrier with its Prisma key",
              );
            assert.equal(await locks(client, MIGRATION_RUNNER_LOCK_KEY), 1);
            assert.equal(await locks(client, KB_DDL_LOCK_KEY), 1);
            if (signal === "orphan-cli") {
              const nativePid = readFileSync(barrier, "utf8");
              const status = readFileSync(`/proc/${nativePid}/status`, "utf8");
              const cliPid = Number(/^PPid:\s+(\d+)/m.exec(status)?.[1]);
              assert.ok(cliPid > 1, "native client's CLI owner is known");
              process.kill(cliPid, "SIGKILL");
            } else if (signal !== "timeout") owner.child.kill(signal);
            const ended = await owner.done;
            assert.notEqual(
              ended.code,
              0,
              "cancellation/deadline cannot recover and start another mutation",
            );
            if (timing === "before-prisma") {
              const pid = readFileSync(barrier, "utf8");
              await until(
                () =>
                  !existsSync(`/proc/${pid}/status`) ||
                  /^State:\s+Z/m.test(readFileSync(`/proc/${pid}/status`, "utf8")),
                "orphan native wrapper survived its runner",
              );
            }
            // Keep the DDL barrier held until backend exclusion proves rollback.
            // A disconnected backend may still be processing its buffered SQL;
            // releasing the barrier first would let that transaction commit.
            // Snapshot/offline order. Acquiring both keys proves any backend has
            // finished/rolled back; a parent-only DADP check would be insufficient.
            await client.query("SET statement_timeout='15s'");
            await client.query(`SELECT pg_advisory_lock(${KB_DDL_LOCK_KEY})`);
            await client.query(`SELECT pg_advisory_lock(${PRISMA_ADVISORY_LOCK})`);
            writeFileSync(release, "release");
            if (timing === "after-prisma") await client.query(`SELECT pg_advisory_unlock(${key})`);
            assert.equal(
              (await client.query("SELECT to_regclass('kb_lock_probe') AS t")).rows[0].t,
              null,
            );
            await client.query(`SELECT pg_advisory_unlock(${PRISMA_ADVISORY_LOCK})`);
            await client.query(`SELECT pg_advisory_unlock(${KB_DDL_LOCK_KEY})`);
          },
        );
  } finally {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    for (const client of clients) await client.end().catch(() => {});
    for (const name of names) await removeDatabase(admin, name, { kind: "scratch" });
    await admin.end();
    rmSync(work, { recursive: true, force: true });
  }
}
