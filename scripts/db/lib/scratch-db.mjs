/**
 * The ONE place the db tooling creates or removes a whole database.
 *
 * Callers:
 *   - scripts/db/reset-local.mjs  — this checkout's exact local DB, after
 *     scripts/assert-local-database.sh db:reset:local accepted it (no escape
 *     hatch for that command).
 *   - scripts/db/check-migrations.mjs / test-migrations.mjs — scratch DBs they
 *     created themselves on a disposable CI / docker Postgres.
 *
 * `removeDatabase` refuses any name that is not one of those shapes, so a typo
 * or a crafted argument cannot reach another database through this helper.
 */
import { withDatabase } from "./local-db-name.mjs";
import { pgConnectionString } from "./migration-state.mjs";

const SCRATCH_RE = /^knowledge_base_(check|test)_[a-z0-9]{6,32}(_shadow)?$/;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const LOCAL_RE = /^(knowledge_base_wt_[0-9a-f]{10}|[a-z_][a-z0-9_]{0,40})(_shadow)?$/;

/** Admin connection to the server's maintenance database. */
export async function adminClient(pg, url) {
  const client = new pg.Client({
    connectionString: pgConnectionString(withDatabase(url, "postgres")),
  });
  await client.connect();
  return client;
}

async function databaseExists(client, name) {
  const result = await client.query("SELECT 1 FROM pg_catalog.pg_database WHERE datname = $1", [
    name,
  ]);
  return result.rowCount > 0;
}

export async function createDatabase(client, name) {
  if (!LOCAL_RE.test(name) && !SCRATCH_RE.test(name))
    throw new Error(`refusing to create unexpected database name ${name}`);
  if (await databaseExists(client, name)) return false;
  await client.query(`CREATE DATABASE ${client.escapeIdentifier(name)}`);
  return true;
}

/**
 * @param {import("pg").Client} client admin connection
 * @param {string} name exact database name
 * @param {{ kind: "scratch" | "local", expected?: string }} guard
 *   scratch: must match the scratch-name shape. local: must equal `expected`
 *   (the name scripts/db/lib/local-db-name.mjs computed for this checkout).
 */
export async function removeDatabase(client, name, guard) {
  if (
    guard.kind === "scratch"
      ? !SCRATCH_RE.test(name)
      : name !== guard.expected || !LOCAL_RE.test(name)
  ) {
    throw new Error(
      `refusing to remove database ${name}: not an exact ${guard.kind} database name`,
    );
  }
  // Defense in depth behind scripts/assert-local-database.sh: judge the host
  // the driver ACTUALLY connected to (pg resolves `?host=`/`?port=` overrides
  // into client.host/port), not the URL text.
  if (guard.kind === "local" && !LOCAL_HOSTS.has(String(client.host ?? ""))) {
    throw new Error(`refusing to remove database ${name}: connection is not to localhost`);
  }
  if (!(await databaseExists(client, name))) return false;
  await client.query(`DROP DATABASE ${client.escapeIdentifier(name)} WITH (FORCE)`); // destructive:audited — guarded exact-name scratch/local removal; see the header comment.
  return true;
}
