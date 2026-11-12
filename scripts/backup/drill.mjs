#!/usr/bin/env node
/** Full-bundle drill. host.sh provisions BOTH an isolated DB and data volume. */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { boundedChild } from "../lib/bounded-child.mjs";

export function parseDrillArgs(argv) {
  const [file, identity, ...rest] = argv;
  if (
    !file ||
    !identity ||
    file.startsWith("-") ||
    identity.startsWith("-") ||
    rest.length ||
    file.startsWith("s3://")
  )
    throw new Error(
      "usage: restore-drill <completed-local-bundle.age|latest> <mounted-identity-file>",
    );
  return { file, identity };
}
export function assertDrillTarget({ connectionString, dataDir }) {
  const url = new URL(connectionString);
  if (
    decodeURIComponent(url.pathname.slice(1)) !== "restore_drill" ||
    url.hostname !== "drill-db" ||
    dataDir !== "/drill-data"
  )
    throw new Error(
      "Drill requires host.sh's isolated drill-db/restore_drill and /drill-data volume.",
    );
}
export function drillVerdict({ ready, held, migrations, tables }) {
  const problems = [];
  if (!ready) problems.push("KB restore is not READY");
  if (!held) problems.push("restore deletion hold is missing or shorter than seven days");
  if (!migrations || migrations.applied < 1 || migrations.unfinished !== 0)
    problems.push("migration history is incomplete");
  for (const name of ["knowledge_base", "audit_event", "asset_blob"])
    if (!tables.has(name)) problems.push(`missing table: ${name}`);
  return { pass: !problems.length, problems };
}
export async function main(argv) {
  const { file, identity } = parseDrillArgs(argv);
  assertDrillTarget({
    connectionString: process.env.DATABASE_URL,
    dataDir: process.env.KB_DATA_ROOT,
  });
  const abort = new AbortController();
  for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(name, () => abort.abort());
  await boundedChild(
    "bash",
    [new URL("./restore.sh", import.meta.url).pathname, file, identity, randomUUID()],
    { signal: abort.signal, cooperative: true, timeout: 4_000_000 },
  ).done;
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 10000,
    statement_timeout: 30000,
  });
  client.on("error", () => {});
  try {
    await client.connect();
    const ready = (
      await client.query(
        "SELECT state='READY' AS ready FROM knowledge_base_control.kb_restore WHERE singleton",
      )
    ).rows[0]?.ready;
    // Allow execution time since READY; the committed hold itself is seven days.
    const held = (
      await client.query(
        `SELECT "until">now()+interval '601200 seconds' AS held FROM public._knowledge_base_hold WHERE reason='restore'`,
      )
    ).rows[0]?.held;
    const migrations = (
      await client.query(`SELECT count(*) FILTER(WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)::int AS applied,
      count(*) FILTER(WHERE finished_at IS NULL AND rolled_back_at IS NULL)::int AS unfinished FROM public._prisma_migrations`)
    ).rows[0];
    const tables = new Map();
    for (const name of ["knowledge_base", "audit_event", "asset_blob"]) {
      const row = (await client.query(`SELECT count(*)::text AS count FROM public."${name}"`))
        .rows[0];
      tables.set(name, row.count);
      console.log(`${name}: ${row.count} rows`);
    }
    const verdict = drillVerdict({ ready, held, migrations, tables });
    if (!verdict.pass) throw new Error(verdict.problems.join("; "));
    console.log(
      "DRILL PASSED: encrypted Postgres+Git+file-store restore, authority reset, migration history, READY and deletion hold verified.",
    );
  } finally {
    await client.end().catch(() => {});
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv.slice(2));
  } catch {
    console.error("DRILL FAILED: inspect the isolated restore; production was not a drill target.");
    process.exitCode = 1;
  }
}
