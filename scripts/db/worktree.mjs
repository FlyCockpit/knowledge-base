#!/usr/bin/env node
/**
 * `pnpm db:worktree` — give THIS checkout its own local databases.
 *
 * Creates `<name>` and `<name>_shadow` (names from scripts/db/lib/local-db-name.mjs:
 * `knowledge_base` in the main checkout, `knowledge_base_wt_<hash>` in a linked worktree) on
 * the local Postgres if missing, and writes this checkout's `.env`
 * DATABASE_URL to point at `<name>`. Credentials/host/port are taken from the
 * current DATABASE_URL (or .env.example's dev default). Never drops anything.
 *
 * Then run `pnpm db:migrate:apply`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ENV_PATH, resolveDatabaseUrl } from "./lib/local.mjs";
import {
  describeUrl,
  isLocalHost,
  localDatabaseNames,
  withDatabase,
} from "./lib/local-db-name.mjs";
import { loadPg, ROOT } from "./lib/prisma.mjs";
import { adminClient, createDatabase } from "./lib/scratch-db.mjs";

const DEV_DEFAULT = "postgresql://postgres:password@localhost:5432/knowledge_base";

/** Replace (or append) the live DATABASE_URL line; keep everything else byte-for-byte. */
export function withDatabaseUrl(contents, url) {
  const lines = contents.split("\n");
  let found = false;
  const next = [];
  for (const line of lines) {
    if (/^\s*(export\s+)?DATABASE_URL\s*=/.test(line)) {
      // dotenv is last-wins: collapse duplicates into the single new line.
      if (!found) next.push(`DATABASE_URL=${url}`);
      found = true;
    } else next.push(line);
  }
  if (!found) {
    if (next.length && next.at(-1) === "") next.splice(-1, 0, `DATABASE_URL=${url}`);
    else next.push(`DATABASE_URL=${url}`);
  }
  return next.join("\n");
}

async function main() {
  if (!existsSync(ENV_PATH)) {
    console.error(
      "FATAL: this checkout has no .env yet. Run `pnpm run setup` (it creates .env and calls this).",
    );
    process.exit(1);
  }
  const names = localDatabaseNames({ cwd: ROOT });
  const current = resolveDatabaseUrl() ?? DEV_DEFAULT;
  const { host, port } = describeUrl(current);
  if (!isLocalHost(host)) {
    console.error(
      `FATAL: DATABASE_URL points at host ${host}, not a local Postgres. db:worktree only provisions localhost databases.`,
    );
    process.exit(1);
  }
  const target = withDatabase(current, names.main);
  // Run the full guard BEFORE connecting: it also refuses query parameters
  // (`?host=`, `?port=`, …) that would send the connection somewhere else.
  const guard = spawnSync(
    "bash",
    [path.join(ROOT, "scripts/assert-local-database.sh"), "db:worktree", "--shadow"],
    {
      stdio: "inherit",
      env: { ...process.env, DATABASE_URL: target },
    },
  );
  if (guard.status !== 0) process.exit(guard.status ?? 1);
  const pg = loadPg();
  const admin = await adminClient(pg, target);
  try {
    for (const name of [names.main, names.shadow]) {
      const made = await createDatabase(admin, name);
      console.log(`${made ? "created " : "exists  "} ${name} (${host}:${port})`);
    }
  } finally {
    await admin.end();
  }
  const before = readFileSync(ENV_PATH, "utf8");
  const after = withDatabaseUrl(before, target);
  if (after !== before) {
    writeFileSync(ENV_PATH, after);
    console.log(`.env DATABASE_URL now points at database ${names.main}.`);
  }
  if (process.env.DATABASE_URL && process.env.DATABASE_URL !== target) {
    console.warn(
      "WARNING: DATABASE_URL is exported in your shell and overrides .env; unset it or export the new value.",
    );
  }
  console.log(
    `\nThis checkout uses ${names.worktree ? "its own worktree" : "the main"} database ${names.main}. Next: pnpm db:migrate:apply`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`FATAL: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
