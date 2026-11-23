import { randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { openKbPostgresClusterFromEnv } from "./postgres.js";

const { readMigrationState } = (await import(
  new URL("../../../../scripts/db/lib/migration-state.mjs", import.meta.url).href
)) as {
  readMigrationState(input: {
    databaseUrl: string;
    migrationsDir: string;
    pg: { Client: typeof Client };
  }): Promise<{ state: string; checksumMismatch: string[] }>;
};
const { finalizeRestoreState } = (await import(
  new URL("../../../../scripts/db/lib/contracts.mjs", import.meta.url).href
)) as {
  finalizeRestoreState(client: Client, input: { schema: string }): Promise<Date>;
};
const root = resolve(import.meta.dirname, "../../../..");
const migrationsDir = resolve(root, "packages/db/prisma/migrations");
const fixturesDir = resolve(root, "packages/db/prisma/fixtures");
/** Every committed migration folder, in apply order. */
const migrationFolders = readdirSync(migrationsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
/** A migrations dir holding only the first `count` committed folders. */
function migrationPrefix(count: number): { dir: string; remove(): void } {
  const dir = mkdtempSync(join(tmpdir(), "kb-migrations-"));
  for (const name of migrationFolders.slice(0, count))
    cpSync(join(migrationsDir, name), join(dir, name), { recursive: true });
  cpSync(join(migrationsDir, "migration_lock.toml"), join(dir, "migration_lock.toml"));
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}
const fixture = (name: string) => readFileSync(join(fixturesDir, name), "utf8");
/** pg returns one result for each statement in a multi-statement query. */
const resultRows = (result: unknown) =>
  ((Array.isArray(result) ? result : [result]) as { rows?: unknown[] }[]).flatMap(
    (r) => r.rows ?? [],
  );
const cluster = await openKbPostgresClusterFromEnv();
afterAll(() => cluster.close());

async function state(databaseUrl: string) {
  return readMigrationState({ databaseUrl, migrationsDir, pg: { Client } });
}

describe("committed migration lifecycle", () => {
  it("applies the committed history, then re-enters without changing rows or registering a runtime", async () => {
    const db = await cluster.createDatabase();
    try {
      db.applyPrismaSchema();
      expect((await state(db.urls.applier)).state).toBe("up-to-date");
      const initial = await db.query(
        "applier",
        `SELECT migration_name, checksum, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY migration_name`,
      );
      expect(initial.rows.map((row) => row.migration_name)).toEqual(migrationFolders);
      expect(migrationFolders[0]).toBe("0_init");
      for (const row of initial.rows) {
        expect(row).toMatchObject({ rolled_back_at: null });
        expect(row.finished_at).not.toBeNull();
      }
      await db.query(
        "applier",
        `INSERT INTO app_setting(key,value,"createdAt","updatedAt") VALUES('fixture.sentinel','retained',now(),now())`,
      );
      db.applyPrismaSchema();
      expect(
        (await db.query("runtime", "SELECT value FROM app_setting WHERE key='fixture.sentinel'"))
          .rows,
      ).toEqual([{ value: "retained" }]);
      expect(
        (await db.query("applier", "SELECT id FROM _knowledge_base_instance LIMIT 1")).rows,
      ).toEqual([]);
    } finally {
      await db.close();
    }
  }, 180_000);

  it("migrates a populated 0_init database: SQL protections and the write-mode CHECK hold", async () => {
    const db = await cluster.createDatabase();
    const atInit = migrationPrefix(1);
    try {
      // Stop at 0_init and load its committed data fixture there, the way
      // db:check-migrations replays it, then apply any later migrations over
      // that data.
      db.applyPrismaSchema({ migrationsDir: atInit.dir });
      expect(
        (await db.query("applier", "SELECT migration_name FROM _prisma_migrations")).rows,
      ).toEqual([{ migration_name: "0_init" }]);
      await db.query("applier", fixture("0_init.sql"));
      // The committed assertion fixtures exercise every SQL-owned check,
      // partial index, FK and authority/generation trigger.
      expect(resultRows(await db.query("applier", fixture("0_init.check.sql")))).toEqual([]);
      db.applyPrismaSchema();
      expect((await state(db.urls.applier)).state).toBe("up-to-date");
      expect(
        (
          await db.query("applier", "SELECT migration_name FROM _prisma_migrations ORDER BY 1")
        ).rows.map((row) => row.migration_name),
      ).toEqual(migrationFolders);
      // Every fixture assertion file holds after the later migrations (their
      // own checks included).
      for (const file of readdirSync(fixturesDir)
        .filter((name) => name.endsWith(".check.sql"))
        .sort())
        expect(resultRows(await db.query("applier", fixture(file))), file).toEqual([]);
      // Write grants, live and revoked, PAT and OAuth, keep their mode (BOTH);
      // the read grant stays without one.
      expect(
        (
          await db.query(
            "applier",
            `SELECT id::text AS id, "authoringMode"::text AS mode, "revokedAt" IS NOT NULL AS revoked
               FROM mcp_grant WHERE id::text LIKE '00000000-0000-4000-8000-0000000000a_' ORDER BY id`,
          )
        ).rows,
      ).toEqual([
        { id: "00000000-0000-4000-8000-0000000000a1", mode: "BOTH", revoked: false },
        { id: "00000000-0000-4000-8000-0000000000a2", mode: "BOTH", revoked: true },
        { id: "00000000-0000-4000-8000-0000000000a3", mode: null, revoked: false },
        { id: "00000000-0000-4000-8000-0000000000a4", mode: "BOTH", revoked: false },
      ]);
      // Approved consent selections are left exactly as written; a selection
      // without an `authoringMode` refreshes through its grant's mode.
      const consent = await db.query(
        "applier",
        `SELECT id, selection::jsonb AS selection FROM consent_intent WHERE id IN ('fx_consent_write','fx_consent_read') ORDER BY id`,
      );
      expect(consent.rows).toEqual([
        {
          id: "fx_consent_read",
          selection: {
            scopes: ["mcp:read"],
            toolGroups: ["read"],
            acl: [],
            allowCreate: false,
            createdKbBits: [],
          },
        },
        {
          id: "fx_consent_write",
          selection: {
            scopes: ["mcp:read", "mcp:write"],
            toolGroups: ["read", "edit"],
            acl: [],
            allowCreate: false,
            createdKbBits: [],
          },
        },
      ]);
      // The CHECK holds for new rows too: a write grant needs a mode, a read
      // grant may not carry one.
      const insert = (scopes: string, mode: string) =>
        db.query(
          "applier",
          `INSERT INTO mcp_grant (id,"actorUserIdSnapshot","userId",kind,"clientId","referenceId",scopes,"toolGroups","createdKbBits","authoringMode")
           VALUES (gen_random_uuid(),'fx_owner','fx_owner','PAT','kb-pat',$1,$2::text[],ARRAY['read'],ARRAY[]::text[],$3::"McpAuthoringMode")`,
          [randomUUID(), scopes, mode === "" ? null : mode],
        );
      await expect(insert("{mcp:read,mcp:write}", "")).rejects.toMatchObject({ code: "23514" });
      await expect(insert("{mcp:read}", "EDIT")).rejects.toMatchObject({ code: "23514" });
      await expect(insert("{mcp:write}", "DREAM")).resolves.toBeDefined();
      await expect(insert("{mcp:read}", "")).resolves.toBeDefined();
      // Re-entering the migrated database changes nothing.
      const before = await db.query(
        "applier",
        `SELECT id::text, "authoringMode"::text FROM mcp_grant ORDER BY id`,
      );
      db.applyPrismaSchema();
      expect(
        (
          await db.query(
            "applier",
            `SELECT id::text, "authoringMode"::text FROM mcp_grant ORDER BY id`,
          )
        ).rows,
      ).toEqual(before.rows);
    } finally {
      atInit.remove();
      await db.close();
    }
  }, 300_000);

  it("refuses history checksum drift and an untracked nonempty schema", async () => {
    const db = await cluster.createDatabase();
    const occupied = await cluster.createDatabase();
    try {
      db.applyPrismaSchema();
      await db.query(
        "applier",
        "UPDATE _prisma_migrations SET checksum=$1 WHERE migration_name='0_init'",
        ["0".repeat(64)],
      );
      expect((await state(db.urls.applier)).checksumMismatch).toContain("0_init");
      await occupied.query("applier", "CREATE TABLE unknown_application_data(id text PRIMARY KEY)");
      await occupied.query("applier", "INSERT INTO unknown_application_data VALUES('retained')");
      expect((await state(occupied.urls.applier)).state).toBe("no-history-nonempty");
      expect(() => occupied.applyPrismaSchema()).toThrow();
      expect(
        (await occupied.query("applier", "SELECT id FROM unknown_application_data")).rows,
      ).toEqual([{ id: "retained" }]);
    } finally {
      await db.close();
      await occupied.close();
    }
  }, 180_000);

  it("pending restore blocks admission despite matching migrations; final hold preserves longer owner holds and invalidates imported instances atomically", async () => {
    const db = await cluster.createDatabase();
    let client: Client | undefined;
    try {
      db.applyPrismaSchema();
      await db.query("applier", "CREATE SCHEMA knowledge_base_control");
      await db.query(
        "applier",
        "CREATE TABLE knowledge_base_control.kb_restore(state text NOT NULL)",
      );
      await db.query("applier", "INSERT INTO knowledge_base_control.kb_restore VALUES('IMPORTED')");
      expect((await state(db.urls.applier)).state).toBe("restore-pending");
      expect(() => db.applyPrismaSchema()).toThrow();
      const id = randomUUID();
      await db.query(
        "applier",
        `INSERT INTO _knowledge_base_instance(id, role, schema_level) VALUES($1,'server','0_init')`,
        [id],
      );
      await db.query(
        "applier",
        `INSERT INTO _knowledge_base_hold(reason,until) VALUES('restore', now()+interval '30 days'),('owner', now()+interval '40 days')`,
      );
      const before = await db.query(
        "applier",
        "SELECT reason,until FROM _knowledge_base_hold ORDER BY reason",
      );
      client = new Client({ connectionString: db.urls.applier });
      await client.connect();
      await client.query("BEGIN");
      await finalizeRestoreState(client, { schema: "public" });
      await client.query(
        "UPDATE knowledge_base_control.kb_restore SET state='READY' WHERE state='IMPORTED'",
      );
      await client.query("ROLLBACK");
      expect((await state(db.urls.applier)).state).toBe("restore-pending");
      expect(
        (await db.query("applier", "SELECT id FROM _knowledge_base_instance LIMIT 1")).rows,
      ).toHaveLength(1);
      await client.query("BEGIN");
      await finalizeRestoreState(client, { schema: "public" });
      await client.query(
        "UPDATE knowledge_base_control.kb_restore SET state='READY' WHERE state='IMPORTED'",
      );
      await client.query("COMMIT");
      expect(
        (await db.query("applier", "SELECT id FROM _knowledge_base_instance LIMIT 1")).rows,
      ).toEqual([]);
      expect(
        (await db.query("applier", "SELECT reason,until FROM _knowledge_base_hold ORDER BY reason"))
          .rows,
      ).toEqual(before.rows);
      expect((await state(db.urls.applier)).state).toBe("up-to-date");
    } finally {
      await client?.end();
      await db.close();
    }
  }, 180_000);
});
