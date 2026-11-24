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
 * Each database it creates gets the disposable-local-database mark
 * (scripts/db/lib/scratch-db.mjs), which `pnpm db:reset:local` requires. It
 * never marks a database that already existed: that could be anything a
 * localhost URL reaches, including an SSH tunnel to production.
 *
 * `pnpm db:worktree --adopt` marks this checkout's EXISTING databases (for one
 * created before the mark existed). It is for a person at a terminal: it needs
 * an interactive TTY and the database name typed back. Agents hand it to the user.
 *
 * Then run `pnpm db:migrate:apply`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { ENV_PATH, resolveDatabaseUrl } from "./lib/local.mjs";
import {
  describeUrl,
  isLocalHost,
  localDatabaseNames,
  withDatabase,
} from "./lib/local-db-name.mjs";
import { loadPg, ROOT } from "./lib/prisma.mjs";
import { adminClient, createDatabase, isMarkedLocal, markLocal } from "./lib/scratch-db.mjs";

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

/**
 * --adopt marks exactly what db:reset:local will accept, and reset never
 * honours EXPECTED_DB: a different name here would mark a database reset still
 * refuses (or one that is not this checkout's at all). Returns the refusal, or null.
 * @param {{ cwd: string, env: Record<string, string | undefined>,
 *   gitRead?: (cwd: string, args: string[]) => string }} options
 */
export function adoptRefusal({ cwd, env, gitRead }) {
  const named = localDatabaseNames({ cwd, env, gitRead }).main;
  if (named === localDatabaseNames({ cwd, env: {}, gitRead }).main) return null;
  return "FATAL: --adopt refuses EXPECTED_DB: it marks only this checkout's default local database, the one `pnpm db:reset:local` resets. Unset EXPECTED_DB.";
}

/** --adopt: a person confirms, at a terminal, that this checkout's existing databases are disposable. */
async function adopt(admin, names, { host, port }) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(
      "FATAL: --adopt needs a person at an interactive terminal (it marks a database as safe to drop).\n" +
        "Agents: hand `pnpm db:worktree --adopt` to the user.",
    );
    return 1;
  }
  console.log(
    `This marks ${names.main} (and ${names.shadow}) on ${host}:${port} as this checkout's disposable local\n` +
      "databases, so `pnpm db:reset:local` may drop them. Do this only if that server is a Postgres on\n" +
      "this machine (for example `pnpm dev:services`), never an SSH tunnel or port-forward to another server.",
  );
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const typed = (await rl.question(`Type ${names.main} to confirm: `)).trim();
  rl.close();
  if (typed !== names.main) {
    console.error("Not confirmed; nothing was marked.");
    return 1;
  }
  for (const name of [names.main, names.shadow]) {
    const exists =
      (await admin.query("SELECT 1 FROM pg_catalog.pg_database WHERE datname = $1", [name]))
        .rowCount > 0;
    if (!exists) continue;
    if (await isMarkedLocal(admin, name)) console.log(`already marked ${name}`);
    else {
      await markLocal(admin, name);
      console.log(`marked ${name}`);
    }
  }
  return 0;
}

async function main() {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => arg !== "--adopt");
  if (unknown.length) {
    console.error(
      `FATAL: unknown argument(s): ${unknown.join(" ")}. Usage: pnpm db:worktree [--adopt]`,
    );
    process.exit(2);
  }
  const adopting = args.includes("--adopt");
  // --adopt only marks; it never writes .env, so it works without one.
  if (!adopting && !existsSync(ENV_PATH)) {
    console.error(
      "FATAL: this checkout has no .env yet. Run `pnpm setup:app` (it creates .env and calls this).",
    );
    process.exit(1);
  }
  const names = localDatabaseNames({ cwd: ROOT });
  const refusal = adopting ? adoptRefusal({ cwd: ROOT, env: process.env }) : null;
  if (refusal) {
    console.error(refusal);
    process.exit(1);
  }
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
    if (adopting) {
      process.exitCode = await adopt(admin, names, { host, port });
      return;
    }
    for (const name of [names.main, names.shadow]) {
      const made = await createDatabase(admin, name);
      const marked = made || (await isMarkedLocal(admin, name));
      console.log(
        `${made ? "created " : "exists  "} ${name} (${host}:${port})${marked ? "" : " — not marked disposable; `pnpm db:reset:local` refuses it until a person runs `pnpm db:worktree --adopt`"}`,
      );
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
