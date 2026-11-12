#!/usr/bin/env node
/**
 * `pnpm db:reset:local` — drop and recreate THIS checkout's own local
 * database (exact name from scripts/db/lib/local-db-name.mjs), then
 * `prisma migrate deploy`, every scheduled deletion (`contract.sql`, applied
 * at once and untracked: nothing has ever served from this database),
 * `prisma generate`, and the seed.
 *
 * Explicit only: no other script calls this. The guard
 * (scripts/assert-local-database.sh db:reset:local) accepts only the exact
 * per-checkout name on localhost and refuses every escape-hatch override.
 */
import { fileURLToPath } from "node:url";
import { applyAllContracts } from "./lib/contracts.mjs";
import { assertLocal } from "./lib/local.mjs";
import { describeUrl, localDatabaseNames } from "./lib/local-db-name.mjs";
import {
  pgConnectionString,
  prismaSchemaName,
  readMigrationsFolder,
} from "./lib/migration-state.mjs";
import { loadPg, MIGRATIONS_DIR, prisma, ROOT } from "./lib/prisma.mjs";
import { adminClient, createDatabase, removeDatabase } from "./lib/scratch-db.mjs";

async function main() {
  const url = assertLocal("db:reset:local");
  const expected = localDatabaseNames({ cwd: ROOT }).main;
  const { database } = describeUrl(url);
  if (database !== expected) {
    console.error(
      `FATAL: refusing to reset ${database}; this checkout's local database is ${expected}.`,
    );
    process.exit(1);
  }
  const pg = loadPg();
  const admin = await adminClient(pg, url);
  try {
    await removeDatabase(admin, database, { kind: "local", expected });
    await createDatabase(admin, database);
    console.log(`Recreated local database ${database}.`);
  } finally {
    await admin.end();
  }
  const env = { DATABASE_URL: url };
  const deployed = await prisma(["migrate", "deploy"], { env });
  if (deployed.code !== 0) process.exit(deployed.code);
  // A database nothing has ever served from: every scheduled deletion
  // (contract.sql) applies at once, untracked, like on a fresh production DB.
  const client = new pg.Client({ connectionString: pgConnectionString(url) });
  await client.connect();
  try {
    const done = await applyAllContracts(client, readMigrationsFolder(MIGRATIONS_DIR), {
      schema: prismaSchemaName(url),
    });
    if (done.length) console.log(`Applied ${done.length} scheduled deletion(s) (contract.sql).`);
  } finally {
    await client.end().catch(() => {});
  }
  for (const args of [["generate"], ["db", "seed"]]) {
    const result = await prisma(args, { env });
    if (result.code !== 0) process.exit(result.code);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`FATAL: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
