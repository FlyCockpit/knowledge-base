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
 *
 * Local removal also requires the disposable-database mark: a database comment
 * (`LOCAL_DB_MARK`) that only this tooling writes, on databases it created
 * itself (`createDatabase`, called by `pnpm db:worktree`, db:migrate's shadow
 * DB, the scratch checks) or that the dev compose stack's init script created
 * (`scripts/db/dev-postgres-init/10-mark-local.sh`). A name and a localhost URL
 * are not proof the database is local: an SSH tunnel to production on
 * localhost:5432/knowledge_base has both, but never the mark. A real local
 * database from before the mark existed is adopted by a person at a terminal
 * with `pnpm db:worktree --adopt`.
 */
import { withDatabase } from "./local-db-name.mjs";
import { pgConnectionString } from "./migration-state.mjs";

const SCRATCH_RE = /^knowledge_base_(check|test)_[a-z0-9]{6,32}(_shadow)?$/;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const LOCAL_RE = /^(knowledge_base_wt_[0-9a-f]{10}|[a-z_][a-z0-9_]{0,40})(_shadow)?$/;

/** The comment that marks a database this tooling created as disposable. */
export const LOCAL_DB_MARK = "knowledge-base:disposable-local-database v1";

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

/** Does `name` carry the disposable-database mark? (false when it does not exist) */
export async function isMarkedLocal(client, name) {
  const result = await client.query(
    "SELECT pg_catalog.shobj_description(oid, 'pg_database') AS mark FROM pg_catalog.pg_database WHERE datname = $1",
    [name],
  );
  return result.rows?.[0]?.mark === LOCAL_DB_MARK;
}

/** Write the mark on a database. Only for databases this tooling just created, or a person's explicit adoption. */
export async function markLocal(client, name) {
  if (!LOCAL_RE.test(name) && !SCRATCH_RE.test(name))
    throw new Error(`refusing to mark unexpected database name ${name}`);
  await client.query(
    `COMMENT ON DATABASE ${client.escapeIdentifier(name)} IS ${client.escapeLiteral(LOCAL_DB_MARK)}`,
  );
}

/** Create `name` and mark it disposable. An existing database is left as it is (never marked). */
export async function createDatabase(client, name) {
  if (!LOCAL_RE.test(name) && !SCRATCH_RE.test(name))
    throw new Error(`refusing to create unexpected database name ${name}`);
  if (await databaseExists(client, name)) return false;
  await client.query(`CREATE DATABASE ${client.escapeIdentifier(name)}`);
  await markLocal(client, name);
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
  if (guard.kind === "local" && !(await isMarkedLocal(client, name))) {
    throw new Error(
      `refusing to remove database ${name}: it does not carry the disposable-local-database mark ` +
        "(only databases `pnpm db:worktree` or the dev compose stack created have it)",
    );
  }
  await client.query(`DROP DATABASE ${client.escapeIdentifier(name)} WITH (FORCE)`); // destructive:audited — guarded exact-name scratch/local removal; see the header comment.
  return true;
}
