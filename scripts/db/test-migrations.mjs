#!/usr/bin/env node
/**
 * `pnpm db:test-migrations` — end-to-end test of the migration tooling
 * against a DISPOSABLE Postgres (a throwaway `postgres:18` docker container,
 * or `--server-url <superuser url>` for one you already run, e.g. CI).
 *
 * It copies the db tooling + packages/db into a temp git repo (so nothing in
 * this checkout is written) and exercises:
 *   - db:worktree + db:migrate:apply on a fresh database
 *   - generate (Prisma drop+add) → migration.sql + contract.sql, check 5 fails
 *     (looks like a rename)
 *   - hand-edit to RENAME COLUMN → check 5 fails, with or without the retired
 *     maintenance marker; local apply keeps data
 *   - expand and contract: a field removal (relax + contract), enum value
 *     removals (--remap, a view that keeps a label, the next diff empty),
 *     db:reset:local applying contracts; then the runner scenarios in
 *     scripts/db/test-contracts.mjs (soak, holds, admission, failures,
 *     warm sessions across enum rebuilds)
 *   - schema-only change, reordered folder, edited applied migration → checks 1/2/3 fail
 *   - runtime: a transactional migration that hits a lock timeout auto-recovers
 *     once; a deterministic failure leaves no partial change and stops
 *   - runtime: an attempt killed after COMMIT is recorded applied (never
 *     re-run); one killed before COMMIT is retried; edited applied files refused
 *   - runtime: in-place breaking changes (and the retired marker) refused on a
 *     served database, nothing applied; a fresh database applies them;
 *     db-ahead refusal, no-history refusal, wait mode
 *   - runtime: two concurrent leaders serialize on the runner lock (one
 *     deploy, both exit 0); a migration another session is still applying
 *     (Prisma's lock held) is refused and left untouched
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { withDatabase } from "./lib/local-db-name.mjs";
import { readMigrationsFolder } from "./lib/migration-state.mjs";
import { loadPg, ROOT } from "./lib/prisma.mjs";
import { wrapTransactional } from "./lib/sql.mjs";
import { writeTestBackupHook } from "./lib/test-backup-hook.mjs";
import { contractScenarios } from "./test-contracts.mjs";
import { kbLockScenarios } from "./test-kb-locks.mjs";

const pg = loadPg();
const results = [];
async function step(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`ok   ${name} (${Date.now() - started} ms)`);
  } catch (error) {
    results.push({ name, ok: false });
    console.log(`FAIL ${name}\n     ${error instanceof Error ? error.stack : String(error)}`);
  }
}

function sh(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 26, ...options });
  return { code: result.status ?? 1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/** A TCP port that is free on 127.0.0.1 right now. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
      server.close(() => resolve(port));
    });
  });
}

async function startPostgres() {
  const name = `knowledge-base-test-migrations-${randomBytes(4).toString("hex")}`;
  const run = sh("docker", [
    "run",
    "-d",
    "--rm",
    "--name",
    name,
    "-e",
    "POSTGRES_PASSWORD=postgres",
    "-p",
    // A fixed host port (picked free just now): a random one would change
    // when the contract scenarios restart the container.
    `127.0.0.1:${await freePort()}:5432`,
    "postgres:18",
  ]);
  if (run.code !== 0) throw new Error(`docker run failed: ${run.out}`);
  const port = sh("docker", ["port", name, "5432/tcp"]).out.trim().split("\n")[0].split(":").at(-1);
  const url = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
  for (let i = 0; i < 60; i++) {
    const client = new pg.Client({ connectionString: url });
    try {
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      // postgres:18 restarts once after initdb; make sure we are past it.
      await delay(1500);
      const again = new pg.Client({ connectionString: url });
      await again.connect();
      await again.end();
      // -v: a force-removed --rm container keeps its anonymous PGDATA volume.
      return { url, port, container: name, stop: () => sh("docker", ["rm", "-f", "-v", name]) };
    } catch {
      await client.end().catch(() => {});
      await delay(1000);
    }
  }
  sh("docker", ["rm", "-f", "-v", name]);
  throw new Error("disposable Postgres did not become ready");
}

function makeRepo() {
  const repo = mkdtempSync(path.join(tmpdir(), "knowledge-base-migrations-e2e-"));
  for (const rel of [
    "scripts/db",
    "scripts/lib/bounded-child.mjs",
    "scripts/assert-local-database.sh",
    "packages/db/prisma/schema",
    "packages/db/prisma/migrations",
    "packages/db/prisma/fixtures",
    "packages/db/prisma.config.ts",
    "packages/db/package.json",
    "package.json",
  ]) {
    cpSync(path.join(ROOT, rel), path.join(repo, rel), {
      recursive: true,
      filter: (src) => !/\.test\.mjs$/.test(src),
    });
  }
  symlinkSync(path.join(ROOT, "node_modules"), path.join(repo, "node_modules"));
  symlinkSync(
    path.join(ROOT, "packages/db/node_modules"),
    path.join(repo, "packages/db/node_modules"),
  );
  // Generic generator scenarios use an isolated synthetic Project model; it
  // is never part of KB's committed baseline or application schema.
  writeFileSync(
    path.join(repo, "packages/db/prisma/schema/projects.prisma"),
    `model Project {
  id        String @id @default(cuid(2))
  createdAt DateTime @default(now()) @db.Timestamptz(3)
  updatedAt DateTime @default(now()) @updatedAt @db.Timestamptz(3)
  ownerId   String
  name      String
  notes     String?
  @@index([ownerId, createdAt(sort: Desc)])
  @@map("project")
}
`,
  );
  const baseline = path.join(repo, "packages/db/prisma/migrations/0_init/migration.sql");
  writeFileSync(
    baseline,
    readFileSync(baseline, "utf8").replace(
      "-- knowledge-base:commit-marker",
      `CREATE TABLE "project" (id TEXT PRIMARY KEY,"createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"ownerId" TEXT NOT NULL,name TEXT NOT NULL,notes TEXT);
CREATE INDEX "project_ownerId_createdAt_idx" ON "project" ("ownerId","createdAt" DESC);
-- knowledge-base:commit-marker`,
    ),
  );
  const fixture = path.join(repo, "packages/db/prisma/fixtures/0_init.sql");
  writeFileSync(
    fixture,
    readFileSync(fixture, "utf8") +
      `
INSERT INTO project (id,"updatedAt","ownerId",name,notes) VALUES ('fx_project_1',now(),'fx_owner','duplicate',NULL),('fx_project_2',now(),'fx_owner','duplicate',''),('fx_project_3',now(),'fx_reader','other','Multi-line fixture');
`,
  );
  const guard = path.join(repo, "fixture-child-guard");
  const built = sh("cc", [
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    path.join(ROOT, "apps/worker/src/native/child-guard.c"),
    "-o",
    guard,
  ]);
  if (built.code !== 0) throw new Error("Cannot compile migration test child guard.");
  const prismaFile = path.join(repo, "scripts/db/lib/prisma.mjs");
  writeFileSync(
    prismaFile,
    readFileSync(prismaFile, "utf8").replace(
      '"/usr/local/bin/kb-child-guard"',
      JSON.stringify(guard),
    ),
  );
  writeFileSync(
    path.join(repo, ".gitignore"),
    "node_modules\n.env\npackages/db/prisma/generated\n",
  );
  const g = (...args) => {
    const r = sh(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args],
      { cwd: repo },
    );
    if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.out}`);
    return r.out;
  };
  g("init", "-q", "-b", "main");
  g("add", "-A");
  g("commit", "-q", "-m", "base");
  return { repo, git: g };
}

async function main() {
  const args = process.argv.slice(2);
  const serverIndex = args.indexOf("--server-url");
  const server =
    serverIndex >= 0
      ? {
          url: args[serverIndex + 1],
          port: new URL(args[serverIndex + 1]).port || "5432",
          container: null,
          stop: () => {},
        }
      : await startPostgres();
  const { repo, git } = makeRepo();
  const migrations = path.join(repo, "packages/db/prisma/migrations");
  const schemaFile = path.join(repo, "packages/db/prisma/schema/projects.prisma");
  const runSuffix = randomBytes(6).toString("hex");
  const scratchNames = new Set();
  const { adminClient, createDatabase, removeDatabase } = await import(
    path.join(repo, "scripts/db/lib/scratch-db.mjs")
  );
  const localName = `knowledge_base_test_${runSuffix}`;
  const env = {
    ...process.env,
    EXPECTED_PORT: server.port,
    EXPECTED_DB: localName,
    CHECKPOINT_DISABLE: "1",
  };
  delete env.DATABASE_URL;
  const localUrl = withDatabase(server.url, localName);
  const node = (script, scriptArgs = [], extraEnv = {}) =>
    sh(process.execPath, [path.join(repo, "scripts/db", script), ...scriptArgs], {
      cwd: repo,
      env: { ...env, ...extraEnv },
    });
  const query = async (url, sql, params) => {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      return await client.query(sql, params);
    } finally {
      await client.end();
    }
  };
  const admin = (sql) => query(server.url, sql);
  const check = () =>
    node("check-migrations.mjs", ["--base", "main"], { CHECK_DATABASE_URL: server.url });
  const { run } = await import(path.join(repo, "scripts/db/migrate-runtime.mjs"));
  const { prisma: fixturePrisma } = await import(path.join(repo, "scripts/db/lib/prisma.mjs"));
  const fixtureHook = writeTestBackupHook(repo);
  const runtime = async (dbUrl, options = {}) => {
    const lines = [];
    const original = { log: console.log, error: console.error };
    console.log = (...a) => lines.push(a.join(" "));
    console.error = (...a) => lines.push(a.join(" "));
    try {
      const code = await run({
        connectRetryMs: 0,
        pollMs: 200,
        backupHook: fixtureHook,
        runPrisma: async (args, opts) => {
          await options.beforePrisma?.(args);
          const result = await fixturePrisma(args, opts);
          await options.afterPrisma?.(args, result);
          return result;
        },
        ...options,
        env: { DATABASE_URL: dbUrl, ...(options.env ?? {}) },
      });
      return { code, out: lines.join("\n") };
    } finally {
      Object.assign(console, original);
    }
  };
  const freshDb = async (_name) => {
    const uniqueName = `knowledge_base_test_${randomBytes(6).toString("hex")}`;
    const client = await adminClient(pg, server.url);
    try {
      assert.equal(await createDatabase(client, uniqueName), true, "scratch name must be new");
      scratchNames.add(uniqueName);
      return withDatabase(server.url, uniqueName);
    } finally {
      await client.end();
    }
  };
  const newMigration = (folder, sql) => {
    mkdirSync(path.join(migrations, folder), { recursive: true });
    writeFileSync(path.join(migrations, folder, "migration.sql"), sql);
  };
  /** Runs `fn` with only `0_init` in the image's migrations folder: an earlier release. */
  const asOfInit = async (fn) => {
    const parked = mkdtempSync(path.join(tmpdir(), "parked-migrations-"));
    const later = readdirSync(migrations, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== "0_init")
      .map((e) => e.name);
    for (const name of later) renameSync(path.join(migrations, name), path.join(parked, name));
    try {
      return await fn();
    } finally {
      for (const name of later) renameSync(path.join(parked, name), path.join(migrations, name));
      rmSync(parked, { recursive: true, force: true });
    }
  };
  let renameFolder = "";

  try {
    await step("db:worktree creates this checkout's databases and writes .env", async () => {
      for (const name of [localName, `${localName}_shadow`]) {
        const existing = await query(server.url, "SELECT 1 FROM pg_database WHERE datname=$1", [
          name,
        ]);
        assert.equal(existing.rowCount, 0, "worktree fixture names must be new");
        scratchNames.add(name);
      }
      writeFileSync(path.join(repo, ".env"), `# e2e\nDATABASE_URL=${localUrl}\n`);
      const r = node("worktree.mjs");
      assert.equal(r.code, 0, r.out);
      const dbs = (await admin("SELECT datname FROM pg_database")).rows.map((x) => x.datname);
      assert.ok(dbs.includes(localName) && dbs.includes(`${localName}_shadow`), dbs.join(","));
    });

    await step("db:migrate:apply deploys 0_init and generates the client", async () => {
      // The fixture is written against the schema right after 0_init; load it
      // there, then apply every later migration on top of the data.
      await asOfInit(async () => {
        const r = node("apply.mjs");
        assert.equal(r.code, 0, r.out);
        await query(
          localUrl,
          readFileSync(path.join(repo, "packages/db/prisma/fixtures/0_init.sql"), "utf8"),
        );
      });
      const rest = node("apply.mjs");
      assert.equal(rest.code, 0, rest.out);
    });

    await step("guard refuses a database that is not this checkout's", async () => {
      const r = node("apply.mjs", [], { DATABASE_URL: withDatabase(server.url, "other") });
      assert.equal(r.code, 1);
      assert.match(r.out, /Refusing db:migrate:apply/);
    });

    await step("db:worktree refuses a ?host= override before connecting", async () => {
      const r = node("worktree.mjs", [], {
        DATABASE_URL: `${localUrl}?host=remote.invalid`,
      });
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /can redirect the connection/);
      assert.doesNotMatch(r.out, /created |exists /);
    });

    await step("db:migrate with no schema change generates nothing", async () => {
      const r = node("migrate.mjs", ["noop"]);
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /No schema changes/);
    });

    await step(
      "generate a field rename: split into migration.sql + contract.sql, no marker, rename warning",
      async () => {
        writeFileSync(
          schemaFile,
          readFileSync(schemaFile, "utf8").replace(
            /^(\s+)notes(\s+)String\?/m,
            "$1description$2String?",
          ),
        );
        const r = node("migrate.mjs", ["rename_project_notes"]);
        assert.equal(r.code, 0, r.out);
        assert.match(r.out, /looks like a rename/);
        assert.match(r.out, /Deleted about 7 days after this deploys/);
        renameFolder = /migrations\/(\d{14}_rename_project_notes)\//.exec(r.out)?.[1] ?? "";
        assert.ok(renameFolder, r.out);
        const sql = readFileSync(path.join(migrations, renameFolder, "migration.sql"), "utf8");
        assert.match(sql, /^-- knowledge-base:transactional\nBEGIN;/);
        assert.doesNotMatch(sql, /maintenance-deploy|DROP COLUMN/);
        assert.match(sql, /ADD COLUMN\s+"description" TEXT/);
        const contract = readFileSync(path.join(migrations, renameFolder, "contract.sql"), "utf8");
        assert.equal(contract, `-- AlterTable\nALTER TABLE "project" ${"DROP"} COLUMN "notes";\n`);
      },
    );

    await step("check-migrations fails check 5 on the generated drop+add", async () => {
      const r = check();
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /5\. Safe for the running release \| FAIL/);
      assert.match(r.out, /looks like a rename/);
      assert.match(r.out, /once no older release is running: column "project"\."notes"/);
      assert.match(r.out, /1\. Consistency \| PASS/);
      assert.match(r.out, /4\. Applies with data \| PASS/);
    });

    await step(
      "hand-edited RENAME COLUMN fails check 5, and the retired maintenance marker does not help",
      async () => {
        rmSync(path.join(migrations, renameFolder, "contract.sql"));
        const file = path.join(migrations, renameFolder, "migration.sql");
        const sql = readFileSync(file, "utf8").replace(
          /ALTER TABLE "project" ADD COLUMN\s+"description" TEXT;/,
          'ALTER TABLE "project" RENAME COLUMN "notes" TO "description";',
        );
        assert.match(sql, /RENAME COLUMN/);
        writeFileSync(file, sql);
        const refused = check();
        assert.equal(refused.code, 1, refused.out);
        assert.match(
          refused.out,
          /renames "project"\."notes" to "description", and the release that is still running breaks/,
        );
        writeFileSync(
          file,
          sql.replace(
            /^-- knowledge-base:transactional\n/,
            "-- knowledge-base:transactional\n-- requires: maintenance-deploy\n",
          ),
        );
        const r = check();
        assert.equal(r.code, 1, r.out);
        assert.match(r.out, /5\. Safe for the running release \| FAIL/);
        assert.match(r.out, /`-- requires: maintenance-deploy` is retired/);
        assert.match(r.out, /renames "project"\."notes" to "description"/);
        assert.match(r.out, /4\. Applies with data \| PASS/);
        // Kept unmarked: the harness commits this in-place rename as the
        // "base" so the runtime scenarios below have one to refuse.
        writeFileSync(file, sql);
      },
    );

    await step("db:migrate:apply applies the rename locally without losing data", async () => {
      const r = node("apply.mjs");
      assert.equal(r.code, 0, r.out);
      const row = await query(
        localUrl,
        `SELECT "description" FROM "project" WHERE id = 'fx_project_3'`,
      );
      assert.match(row.rows[0].description, /Multi-line/);
    });

    await step("a schema-only change without SQL fails check 1", async () => {
      const original = readFileSync(schemaFile, "utf8");
      writeFileSync(
        schemaFile,
        original.replace(
          /^(\s+)description(\s+)String\?/m,
          "$1description$2String?\n$1archived Boolean @default(false)",
        ),
      );
      const r = check();
      writeFileSync(schemaFile, original);
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /1\. Consistency \| FAIL/);
      assert.match(r.out, /archived/);
    });

    await step("a migration that only works on an empty table fails check 4", async () => {
      // The fixture has duplicate project names; an empty CI database would not.
      const folder = "20991231000000_unique_names";
      newMigration(
        folder,
        wrapTransactional('CREATE UNIQUE INDEX "project_name_key" ON "project"("name");'),
      );
      const r = check();
      rmSync(path.join(migrations, folder), { recursive: true, force: true });
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /4\. Applies with data \| FAIL/);
      assert.match(r.out, /on top of fixture data failed/);
    });

    await step(
      "a folder that sorts before the base fails check 2; editing 0_init fails check 3",
      async () => {
        newMigration("00000000000001_early", wrapTransactional("SELECT 1;"));
        const init = path.join(migrations, "0_init/migration.sql");
        const original = readFileSync(init, "utf8");
        writeFileSync(init, `${original}-- edited\n`);
        const r = check();
        writeFileSync(init, original);
        rmSync(path.join(migrations, "00000000000001_early"), { recursive: true, force: true });
        assert.equal(r.code, 1, r.out);
        assert.match(r.out, /2\. Ordering \| FAIL/);
        assert.match(r.out, /3\. Immutability \| FAIL/);
      },
    );

    git("add", "-A");
    git("commit", "-q", "-m", "rename");

    await step("runtime: up-to-date database is a no-op", async () => {
      const r = await runtime(localUrl);
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /up to date/);
    });

    await step(
      "runtime: an in-place breaking migration is refused on a served database, applied on a fresh one",
      async () => {
        // A brand-new database has no running release to break: its whole
        // history applies in one ordinary deploy, including the harness's
        // in-place rename. KB ships no migration carrying the retired marker.
        const fresh = await freshDb("knowledge_base_test_breaking_fresh");
        const first = await runtime(fresh);
        assert.equal(first.code, 0, first.out);
        assert.match(first.out, /new database: applying in-place breaking migration/);
        assert.match(first.out, /renames "project"\."notes" to "description"/);

        // A database an earlier release already runs against is refused
        // outright: there is no override, and nothing is applied.
        const db = await freshDb("knowledge_base_test_breaking");
        const initial = await asOfInit(() => runtime(db));
        assert.equal(initial.code, 0, initial.out);
        const snapshot = async () => ({
          applied: (await query(db, "SELECT count(*)::int AS n FROM _prisma_migrations")).rows[0].n,
          columns: (
            await query(
              db,
              "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'project' ORDER BY column_name",
            )
          ).rows.map((row) => row.column_name),
        });
        const before = await snapshot();
        assert.equal(before.applied, 1);
        assert.ok(before.columns.includes("notes"));
        for (const env of [{}, { MAINTENANCE_DEPLOY: "true" }]) {
          const refused = await runtime(db, { env });
          assert.equal(refused.code, 1, refused.out);
          assert.match(refused.out, /would break the release that is still running/);
          assert.match(refused.out, /renames "project"\."notes" to "description"/);
          assert.match(refused.out, /There is no override|there is no override/);
          assert.match(refused.out, /pnpm db:migrate/);
          assert.match(refused.out, /@map/);
          assert.match(refused.out, /Recipe 5/);
          assert.doesNotMatch(refused.out, /prisma migrate deploy…/);
          assert.deepEqual(await snapshot(), before, "the database is untouched");
        }
      },
    );

    await step(
      "runtime: transactional migration that hits a lock timeout auto-recovers once",
      async () => {
        const db = await freshDb("knowledge_base_test_recover");
        const first = await runtime(db);
        assert.equal(first.code, 0, first.out);
        newMigration(
          "20991231000001_lock_sensitive",
          wrapTransactional(
            'CREATE TABLE "made_by_retry" ("id" INTEGER);\nALTER TABLE "project" ADD COLUMN "archived" BOOLEAN NOT NULL DEFAULT false;',
          ),
        );
        const holder = new pg.Client({ connectionString: db });
        await holder.connect();
        await holder.query("BEGIN");
        let firstAttempt = true;
        let holding = false;
        let r;
        try {
          r = await runtime(db, {
            beforePrisma: async (args) => {
              if (args[1] !== "deploy" || !firstAttempt) return;
              // Capture/backup may inspect table definitions. Install the lock
              // at native deployment, and keep it through the first failure.
              firstAttempt = false;
              await holder.query('LOCK TABLE "project" IN ACCESS EXCLUSIVE MODE');
              holding = true;
            },
            afterPrisma: async (args, result) => {
              if (args[1] !== "deploy" || !holding) return;
              assert.notEqual(result.code, 0, "the first native deploy must hit its lock timeout");
              await holder.query("COMMIT");
              await holder.end();
              holding = false;
            },
          });
        } finally {
          await holder.end().catch(() => {});
          rmSync(path.join(migrations, "20991231000001_lock_sensitive"), {
            recursive: true,
            force: true,
          });
        }
        assert.equal(r.code, 0, r.out);
        assert.match(r.out, /AUTO-RECOVERY: migration 20991231000001_lock_sensitive failed/);
        assert.match(r.out, /lock timeout|transient/);
        const rows = await query(
          db,
          `SELECT finished_at IS NOT NULL AS done, rolled_back_at IS NOT NULL AS rb FROM _prisma_migrations WHERE migration_name = '20991231000001_lock_sensitive' ORDER BY started_at`,
        );
        assert.deepEqual(rows.rows, [
          { done: false, rb: true },
          { done: true, rb: false },
        ]);
      },
    );

    await step(
      "runtime: a failing statement leaves no partial change and stops after one retry",
      async () => {
        const db = await freshDb("knowledge_base_test_fail");
        assert.equal((await runtime(db)).code, 0);
        newMigration(
          "20991231000002_always_fails",
          wrapTransactional('CREATE TABLE "partial" ("id" INTEGER);\nSELECT 1 / 0;'),
        );
        const r = await runtime(db);
        assert.equal(r.code, 1, r.out);
        assert.match(r.out, /division by zero/);
        assert.match(r.out, /failed again after one automatic retry/);
        const partial = await query(db, `SELECT to_regclass('public.partial') AS t`);
        assert.equal(partial.rows[0].t, null, "no partial table");
        // Followers refuse a failed migration rather than start.
        const waiting = await runtime(db, { mode: "wait", waitTimeoutMs: 1_000 });
        assert.equal(waiting.code, 1, waiting.out);
        // A non-transactional failure is never auto-recovered.
        writeFileSync(
          path.join(migrations, "20991231000002_always_fails/migration.sql"),
          'CREATE TABLE "partial" ("id" INTEGER);\nSELECT 1 / 0;\n',
        );
        const manual = await runtime(db);
        assert.equal(manual.code, 1);
        assert.match(manual.out, /not marked "-- knowledge-base:transactional"/);
        rmSync(path.join(migrations, "20991231000002_always_fails"), {
          recursive: true,
          force: true,
        });
      },
    );

    // Reproduce exactly what Prisma leaves behind when the process dies
    // mid-migration: its `_prisma_migrations` row (started, never finished),
    // plus the file run on the same connection either through COMMIT
    // ("after") or cut off before it ("before" → PostgreSQL rolls back).
    const interruptedAttempt = async (db, name, sql, { committed }) => {
      const client = new pg.Client({ connectionString: db });
      await client.connect();
      try {
        const checksum = createHash("sha256").update(sql).digest("hex");
        await client.query(
          `INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at, applied_steps_count)
           VALUES (gen_random_uuid()::text, $1, $2, now(), 0)`,
          [checksum, name],
        );
        await client.query(committed ? sql : sql.slice(0, sql.lastIndexOf("COMMIT;")));
      } finally {
        await client.end(); // an open transaction is rolled back here
      }
    };

    await step(
      "runtime: an attempt killed after COMMIT is recorded applied and never re-run",
      async () => {
        const db = await freshDb("knowledge_base_test_killed_after");
        assert.equal((await runtime(db)).code, 0);
        const name = "20991231000003_backfill_once";
        const sql = wrapTransactional(
          'CREATE TABLE IF NOT EXISTS "counter" ("n" INTEGER);\nINSERT INTO "counter" VALUES (1);',
        );
        newMigration(name, sql);
        await interruptedAttempt(db, name, sql, { committed: true });
        const r = await runtime(db);
        rmSync(path.join(migrations, name), { recursive: true, force: true });
        assert.equal(r.code, 0, r.out);
        assert.match(r.out, /interrupted AFTER its transaction committed/);
        assert.doesNotMatch(r.out, /AUTO-RECOVERY/);
        const rows = await query(db, 'SELECT count(*)::int AS n FROM "counter"');
        assert.equal(rows.rows[0].n, 1, "the data change ran exactly once");
      },
    );

    await step(
      "runtime: the commit marker still works when the body moves search_path away",
      async () => {
        const db = await freshDb("knowledge_base_test_killed_path");
        assert.equal((await runtime(db)).code, 0);
        const name = "20991231000006_backfill_other_path";
        const sql = wrapTransactional(
          'SET LOCAL SCHEMA \'pg_catalog\';\nCREATE TABLE IF NOT EXISTS public."path_counter" ("n" INTEGER);\nINSERT INTO public."path_counter" VALUES (1);',
        );
        newMigration(name, sql);
        await interruptedAttempt(db, name, sql, { committed: true });
        const r = await runtime(db);
        rmSync(path.join(migrations, name), { recursive: true, force: true });
        assert.equal(r.code, 0, r.out);
        assert.match(r.out, /interrupted AFTER its transaction committed/);
        const rows = await query(db, 'SELECT count(*)::int AS n FROM public."path_counter"');
        assert.equal(rows.rows[0].n, 1);
      },
    );

    await step(
      "runtime: an attempt killed before COMMIT is proven rolled back and retried once",
      async () => {
        const db = await freshDb("knowledge_base_test_killed_before");
        assert.equal((await runtime(db)).code, 0);
        const name = "20991231000004_backfill_retry";
        const sql = wrapTransactional(
          'CREATE TABLE IF NOT EXISTS "counter" ("n" INTEGER);\nINSERT INTO "counter" VALUES (1);',
        );
        newMigration(name, sql);
        await interruptedAttempt(db, name, sql, { committed: false });
        const r = await runtime(db);
        rmSync(path.join(migrations, name), { recursive: true, force: true });
        assert.equal(r.code, 0, r.out);
        assert.match(r.out, /AUTO-RECOVERY: migration 20991231000004_backfill_retry failed/);
        const rows = await query(db, 'SELECT count(*)::int AS n FROM "counter"');
        assert.equal(rows.rows[0].n, 1);
      },
    );

    await step(
      "runtime: an applied migration edited afterwards is refused (apply and wait)",
      async () => {
        const db = await freshDb("knowledge_base_test_checksum");
        assert.equal((await runtime(db)).code, 0);
        const edited = mkdtempSync(path.join(tmpdir(), "edited-image-"));
        cpSync(migrations, edited, { recursive: true });
        const file = path.join(edited, "0_init/migration.sql");
        writeFileSync(file, `${readFileSync(file, "utf8")}-- edited after it was applied\n`);
        const r = await runtime(db, { migrationsDir: edited });
        assert.equal(r.code, 1, r.out);
        assert.match(r.out, /changed after they were applied: 0_init/);
        const w = await runtime(db, { migrationsDir: edited, mode: "wait" });
        assert.equal(w.code, 1, w.out);
        rmSync(edited, { recursive: true, force: true });
      },
    );

    await step("runtime: database ahead of the image is refused (apply and wait)", async () => {
      const db = await freshDb("knowledge_base_test_ahead");
      assert.equal((await runtime(db)).code, 0);
      const older = mkdtempSync(path.join(tmpdir(), "older-image-"));
      cpSync(path.join(migrations, "0_init"), path.join(older, "0_init"), { recursive: true });
      const r = await runtime(db, { migrationsDir: older });
      assert.equal(r.code, 1);
      // Every later migration is listed (sorted); the harness's rename is one.
      assert.match(r.out, /does not contain: (?:\d{14}_\w+, )*\d{14}_rename_project_notes\b/);
      const w = await runtime(db, { migrationsDir: older, mode: "wait" });
      assert.equal(w.code, 1);
      rmSync(older, { recursive: true, force: true });
    });

    await step("runtime: two concurrent leaders both exit 0 and only one deploys", async () => {
      const db = await freshDb("knowledge_base_test_concurrent");
      const initialized = await runtime(db);
      assert.equal(initialized.code, 0, initialized.out);
      const concurrentFolder = "20991231000007_concurrent";
      newMigration(
        concurrentFolder,
        wrapTransactional('CREATE TABLE "concurrent_once" ("id" INTEGER);'),
      );
      // A slow backup keeps the first leader inside its locked section
      // while the second one polls the runner lock.
      const hook = path.join(repo, "slow-backup-hook.sh");
      writeFileSync(hook, `sleep 2\nbash ${JSON.stringify(fixtureHook)} "$@"\n`);
      const lines = [];
      const original = { log: console.log, error: console.error };
      console.log = (...a) => lines.push(a.join(" "));
      console.error = (...a) => lines.push(a.join(" "));
      let codes;
      try {
        const leader = () =>
          run({
            connectRetryMs: 0,
            pollMs: 200,
            waitTimeoutMs: 60_000,
            backupHook: hook,
            env: { DATABASE_URL: db, PATH: process.env.PATH },
          });
        codes = await Promise.all([leader(), leader()]);
      } finally {
        Object.assign(console, original);
        rmSync(hook, { force: true });
      }
      const out = lines.join("\n");
      assert.deepEqual(codes, [0, 0], out);
      assert.equal(out.match(/prisma migrate deploy…/g)?.length, 1, out);
      assert.equal(out.match(/running the pre-migration full-bundle backup hook/g)?.length, 1, out);
      assert.match(out, /another migration runner is working on this database/);
      const rows = await query(
        db,
        "SELECT count(*)::int AS n, count(*) FILTER (WHERE finished_at IS NULL)::int AS open FROM _prisma_migrations",
      );
      assert.deepEqual(rows.rows[0], { n: readMigrationsFolder(migrations).length, open: 0 });
      const lock = await query(
        db,
        "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND objid IN (72707369, 72707370)",
      );
      assert.equal(lock.rows[0].n, 0, "both locks released");
    });

    rmSync(path.join(migrations, "20991231000007_concurrent"), { recursive: true, force: true });
    await step(
      "runtime: a migration another session is still applying is refused and left as is",
      async () => {
        const db = await freshDb("knowledge_base_test_inflight");
        assert.equal((await runtime(db)).code, 0);
        const name = "20991231000007_in_flight";
        const sql = wrapTransactional('CREATE TABLE "in_flight" ("id" INTEGER);');
        newMigration(name, sql);
        await interruptedAttempt(db, name, sql, { committed: false });
        const holder = new pg.Client({ connectionString: db });
        await holder.connect();
        let r;
        try {
          await holder.query("SELECT pg_advisory_lock(72707369)");
          r = await runtime(db, { waitTimeoutMs: 1_500 });
        } finally {
          await holder.end();
          rmSync(path.join(migrations, name), { recursive: true, force: true });
        }
        assert.equal(r.code, 1, r.out);
        assert.match(r.out, /still being applied by another session/);
        assert.doesNotMatch(r.out, /AUTO-RECOVERY/);
        const rows = await query(
          db,
          "SELECT finished_at IS NULL AS open, rolled_back_at IS NULL AS not_rolled_back FROM _prisma_migrations WHERE migration_name = $1",
          [name],
        );
        assert.deepEqual(rows.rows, [{ open: true, not_rolled_back: true }]);
      },
    );

    await step(
      "runtime: non-empty database without history is refused with the pointer",
      async () => {
        const db = await freshDb("knowledge_base_test_nohistory");
        await query(db, 'CREATE TABLE "legacy" ("id" INTEGER)');
        const r = await runtime(db);
        assert.equal(r.code, 1);
        assert.match(r.out, /no Prisma migration history/);
        assert.match(r.out, /A database with tables but no migration history/);
      },
    );

    await step("runtime: unreachable database fails; wait mode times out on pending", async () => {
      const r = await runtime("postgresql://postgres:postgres@127.0.0.1:1/none");
      assert.equal(r.code, 1);
      assert.match(r.out, /cannot reach the database/);
      const db = await freshDb("knowledge_base_test_wait");
      const w = await runtime(db, { mode: "wait", waitTimeoutMs: 800 });
      assert.equal(w.code, 1);
      assert.match(w.out, /timed out/);
    });

    await step(
      "db:migrate:apply marks a locally interrupted-after-COMMIT migration applied, not re-run",
      async () => {
        const name = "20991231000005_local_backfill_once";
        const sql = wrapTransactional(
          'CREATE TABLE IF NOT EXISTS "local_counter" ("n" INTEGER);\nINSERT INTO "local_counter" VALUES (1);',
        );
        newMigration(name, sql);
        await interruptedAttempt(localUrl, name, sql, { committed: true });
        const r = node("apply.mjs");
        assert.equal(r.code, 0, r.out);
        assert.match(r.out, /interrupted after it committed; marking it applied/);
        const rows = await query(localUrl, 'SELECT count(*)::int AS n FROM "local_counter"');
        assert.equal(rows.rows[0].n, 1);
      },
    );

    // --- expand and contract: the generator and CI on real Postgres --------
    git("add", "-A");
    git("commit", "-q", "-m", "runtime fixtures");
    const editSchema = (fn) => writeFileSync(schemaFile, fn(readFileSync(schemaFile, "utf8")));
    const generated = (out, name) => {
      const folder = new RegExp(`migrations/(\\d{14}_${name})/`).exec(out)?.[1];
      assert.ok(folder, out);
      const read = (file) => {
        try {
          return readFileSync(path.join(migrations, folder, file), "utf8");
        } catch {
          return null;
        }
      };
      return { folder, sql: read("migration.sql"), contract: read("contract.sql") };
    };
    const merge = (message) => {
      git("add", "-A");
      git("commit", "-q", "-m", message);
    };

    await step(
      "expand/contract 1: removing a NOT NULL field relaxes it now and deletes it later; CI passes",
      async () => {
        editSchema((s) => s.replace(/^\s+name\s+String\n/m, "\n"));
        const r = node("migrate.mjs", ["drop_project_name"]);
        assert.equal(r.code, 0, r.out);
        const out = generated(r.out, "drop_project_name");
        assert.match(
          out.sql,
          /-- knowledge-base:relax v1 "project"\."name"\nALTER TABLE "project" ALTER COLUMN "name" SET DEFAULT '';/,
        );
        assert.match(out.contract, /ALTER TABLE "project" DROP COLUMN "name";/);
        const c = check();
        assert.equal(c.code, 0, c.out);
        assert.match(
          c.out,
          /Deleted about 7 days after this deploys, once no older release is running: [^\n]*column "project"\."name"/,
        );
        const a = node("apply.mjs");
        assert.equal(a.code, 0, a.out);
        assert.match(
          a.out,
          /1 scheduled deletion\(s\) are not applied locally; `pnpm db:reset:local` applies them/,
        );
        merge("drop project name");
      },
    );

    await step("expand/contract: adding an enum field is expand-only", async () => {
      editSchema((s) => {
        const next = s
          .replace(/^( +)@@index/m, "$1kind      ProjectKind @default(A)\n\n$1@@index")
          .concat("\nenum ProjectKind {\n  A\n  B\n  C\n}\n");
        assert.match(next, /kind {6}ProjectKind/);
        return next;
      });
      const r = node("migrate.mjs", ["add_project_kind"]);
      assert.equal(r.code, 0, r.out);
      const out = generated(r.out, "add_project_kind");
      assert.match(out.sql, /ADD COLUMN\s+"kind" "ProjectKind" NOT NULL DEFAULT 'A'/);
      assert.equal(out.contract, null);
      assert.equal(check().code, 0);
      merge("add project kind");
    });

    await step(
      "expand/contract 11: an enum value removal needs --remap; contract.sql starts with the enum block",
      async () => {
        editSchema((s) => s.replace("  A\n  B\n  C\n}", "  A\n  B\n}"));
        const refused = node("migrate.mjs", ["drop_kind_c"]);
        assert.equal(refused.code, 1, refused.out);
        assert.match(refused.out, /Nothing was written/);
        assert.match(refused.out, /pass --remap 'ProjectKind\.C=<VALUE>'/);
        assert.equal(
          readdirSync(migrations).some((name) => name.endsWith("_drop_kind_c")),
          false,
        );
        const r = node("migrate.mjs", ["drop_kind_c", "--remap", "ProjectKind.C=A"]);
        assert.equal(r.code, 0, r.out);
        const out = generated(r.out, "drop_kind_c");
        assert.match(
          out.sql,
          /-- knowledge-base:enum-remove v1 "ProjectKind" "C"->"A" columns "project"\."kind"/,
        );
        assert.ok(
          out.contract.startsWith('-- knowledge-base:enum-remove v1 "ProjectKind" "C"->"A"'),
        );
        const c = check();
        assert.equal(c.code, 0, c.out);
        assert.match(c.out, /value "C" of enum "ProjectKind" \(rows moved to "A"\)/);
        assert.match(
          c.out,
          /something else in the database uses the column \(a view, policy, trigger or function\)/,
        );
        merge("drop kind C");
      },
    );

    await step(
      "expand/contract 11 (R4-2): a view added after a merged removal → CI passes, the next diff is empty",
      async () => {
        const r = node("migrate.mjs", ["project_kind_view", "--empty"]);
        assert.equal(r.code, 0, r.out);
        const { folder } = generated(r.out, "project_kind_view");
        writeFileSync(
          path.join(migrations, folder, "migration.sql"),
          wrapTransactional(
            '-- knowledge-base:reviewed a read-only view; the running release never reads it\nCREATE VIEW "project_kind_v" AS SELECT "id", "kind"::text AS "kind" FROM "project";',
          ),
        );
        const c = check();
        assert.equal(c.code, 0, c.out);
        assert.match(c.out, /Reviewed by hand \(line \d+\): a read-only view/);
        const noop = node("migrate.mjs", ["noop"]);
        assert.equal(noop.code, 0, noop.out);
        assert.match(noop.out, /No schema changes/);
        assert.match(
          noop.out,
          /ProjectKind\.C is kept unused in databases where something used the column/,
        );
        merge("project kind view");
      },
    );

    await step(
      "expand/contract 11: a removal after the view keeps the label; --remap asked only for the new one",
      async () => {
        editSchema((s) => s.replace("  A\n  B\n}", "  A\n}"));
        const refused = node("migrate.mjs", ["drop_kind_b"]);
        assert.equal(refused.code, 1, refused.out);
        assert.match(refused.out, /--remap 'ProjectKind\.B=<VALUE>'/);
        assert.doesNotMatch(refused.out, /ProjectKind\.C=/);
        const r = node("migrate.mjs", ["drop_kind_b", "--remap", "ProjectKind.B=A"]);
        assert.equal(r.code, 0, r.out);
        const out = generated(r.out, "drop_kind_b");
        assert.match(out.contract, /^-- knowledge-base:enum-remove v1 "ProjectKind" "B"->"A"/);
        const c = check();
        assert.equal(c.code, 0, c.out);
        assert.match(c.out, /so ProjectKind\.B was kept/);
        const noop = node("migrate.mjs", ["noop"]);
        assert.equal(noop.code, 0, noop.out);
        assert.match(noop.out, /No schema changes/);
      },
    );

    await step(
      "db:reset:local applies every scheduled deletion (contract.sql) locally",
      async () => {
        const r = node("reset-local.mjs");
        assert.match(r.out, /Applied \d+ scheduled deletion\(s\) \(contract\.sql\)\./);
        // The repo copy has no seed script; everything before the seed must have run.
        if (r.code !== 0) assert.match(r.out, /seed/i, r.out);
        const columns = await query(
          localUrl,
          `SELECT column_name FROM information_schema.columns WHERE table_name = 'project'`,
        );
        assert.ok(!columns.rows.some((c) => c.column_name === "name"), "name was deleted");
      },
    );

    await kbLockScenarios({ step, serverUrl: server.url, repo, pg, sh });
    await contractScenarios({
      step,
      serverUrl: server.url,
      container: server.container,
      repo,
      pg,
      sh,
    });
  } finally {
    await step("harness: clean up only the scratch databases created by this run", async () => {
      const client = await adminClient(pg, server.url);
      try {
        for (const name of scratchNames) await removeDatabase(client, name, { kind: "scratch" });
      } finally {
        await client.end();
      }
    });
    server.stop();
    rmSync(repo, { recursive: true, force: true });
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exitCode = failed.length ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
