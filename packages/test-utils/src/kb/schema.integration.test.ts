import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
const cluster = await openKbPostgresClusterFromEnv();
afterAll(() => cluster.close());

async function state(databaseUrl: string) {
  return readMigrationState({ databaseUrl, migrationsDir, pg: { Client } });
}

describe("committed migration lifecycle", () => {
  it("applies 0_init including SQL protections, then re-enters without changing rows or registering a runtime", async () => {
    const db = await cluster.createDatabase();
    try {
      db.applyPrismaSchema();
      expect((await state(db.urls.applier)).state).toBe("up-to-date");
      const initial = await db.query(
        "applier",
        `SELECT migration_name, checksum, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY migration_name`,
      );
      expect(initial.rows).toHaveLength(1);
      expect(initial.rows[0]).toMatchObject({ migration_name: "0_init", rolled_back_at: null });
      expect(initial.rows[0]!.finished_at).not.toBeNull();
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
      // The committed data/assertion fixtures exercise every former SQL-owned
      // check, partial index, FK and authority/generation trigger.
      await db.query(
        "applier",
        readFileSync(resolve(root, "packages/db/prisma/fixtures/0_init.sql"), "utf8"),
      );
      const checks = await db.query(
        "applier",
        readFileSync(resolve(root, "packages/db/prisma/fixtures/0_init.check.sql"), "utf8"),
      );
      // pg returns one result for each statement in a multi-statement query.
      const results = Array.isArray(checks) ? checks : [checks];
      expect(results.flatMap((result) => result.rows)).toEqual([]);
    } finally {
      await db.close();
    }
  }, 180_000);

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
