#!/usr/bin/env node
/**
 * `pnpm db:baseline [--dry-run]` — ONCE, in a new app created from the
 * template (the template's getting-started guide, right after `pnpm setup:app`):
 * fold the migration history the app inherited from the template into the
 * app's own single `0_init`, so the app's history starts clean.
 *
 * The template itself keeps per-PR migrations and squashes them at each
 * template release, see docs/schema-migrations.md § Releases
 * An app made from it has never deployed anything, so its first history is
 * regenerated from the schema instead:
 *
 *   1. Refuses unless `packages/db/prisma/template-history.json` (the
 *      template's marker) is present, the repository has no release tag of
 *      its own (tags that contain the marker came with the template: it
 *      says to delete them), the migrations and fixtures are committed and
 *      clean, and every file there is one it recognizes (it never deletes
 *      anything else). Never run it in the template repository itself.
 *   2. Only `0_init` (and its fixtures) inherited: nothing to fold; the marker
 *      is removed and `0_init` stays byte-identical.
 *   3. Otherwise `0_init` = `prisma migrate diff --from-empty --to-schema`,
 *      with the generator's transactional wrapper. Proof on scratch databases
 *      (CHECK_DATABASE_URL, else this checkout's local Postgres): every
 *      inherited migration then every contract.sql, and the new `0_init`
 *      alone, have identical schemas, the new one matches the Prisma schema,
 *      the inherited migrations create no rows (a regenerated 0_init would
 *      lose them), and the inherited fixtures (concatenated into
 *      fixtures/0_init.sql) load and pass every check. Nothing is written
 *      unless the proof passes.
 *   4. Writes migrations/ = `0_init` + migration_lock.toml, fixtures/ =
 *      0_init.sql / 0_init.check.sql, removes the marker.
 *
 * After it: `pnpm db:reset:local` (the local database applied the old
 * history), commit. Touches no database other than its scratch ones.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deployTo, fingerprint, fingerprintDiff, residue } from "./check-migrations.mjs";
import { applyAllContracts } from "./lib/contracts.mjs";
import { assertLocal, git, releaseTags } from "./lib/local.mjs";
import { withDatabase } from "./lib/local-db-name.mjs";
import { pgConnectionString, readMigrationsFolder } from "./lib/migration-state.mjs";
import {
  FIXTURES_DIR,
  loadPg,
  MIGRATIONS_DIR,
  prisma,
  ROOT,
  SCHEMA_DIR,
  tempConfig,
} from "./lib/prisma.mjs";
import { readReleases, sectionNames } from "./lib/replaces.mjs";
import { adminClient, createDatabase, removeDatabase } from "./lib/scratch-db.mjs";
import { wrapTransactional } from "./lib/sql.mjs";

export const MARKER = path.join(ROOT, "packages/db/prisma/template-history.json");

function fail(message) {
  console.error(`FATAL: ${message}`);
  process.exit(1);
}

/**
 * Inherited fixtures concatenated in apply order (pure; exported for tests).
 * `stems` are paths under fixtures/ without the suffix: `<folder>`, or
 * `<release>/<replaced folder>` for a data fixture a release squash moved.
 */
export function foldFixtures(stems, read) {
  const out = {};
  for (const suffix of [".sql", ".check.sql"]) {
    const parts = [];
    for (const stem of stems) {
      const text = read(`${stem}${suffix}`);
      if (text !== null) parts.push(`-- from ${stem}${suffix}\n${text.trimEnd()}\n`);
    }
    out[suffix] = parts.length ? parts.join("\n") : null;
  }
  return out;
}

/**
 * Every file baseline may replace, or the paths it does not recognize (pure
 * over listings; exported for tests). Migration folders hold migration.sql,
 * contract.sql and, for a release, replaces.json + replaced/<folder>/…;
 * fixtures are `<folder>.sql` / `<folder>.check.sql`, or
 * `<release>/<replaced folder>.sql`.
 * @param {{ folders: Array<{ name: string, entries: string[] }>,
 *   releases: Array<{ name: string, replaces: Array<{ name: string }> }>,
 *   sections?: Map<string, string[]>, fixtures: Array<{ name: string, inner: string[] | null }>,
 *   other: string[] }} listing
 *   entries: paths inside the folder (recursive); sections: release folder → the
 *   migrations its `-- knowledge-base:from` sections name; inner: a fixtures subdirectory's files
 * @returns {{ unknown: string[], stems: string[] }}
 */
export function inventory({ folders, releases, sections = new Map(), fixtures, other }) {
  const unknown = other
    .filter((name) => name !== "migration_lock.toml")
    .map((n) => `migrations/${n}`);
  const names = new Set(folders.map((f) => f.name));
  const stems = [];
  for (const folder of folders) {
    const release = releases.find((r) => r.name === folder.name);
    const replaced = new Set(release?.replaces.map((e) => e.name) ?? []);
    for (const entry of folder.entries) {
      const [head, sub, file, extra] = entry.split("/");
      const ok =
        (!sub && ["migration.sql", "contract.sql"].includes(head)) ||
        (!sub && release && head === "replaces.json") ||
        (release &&
          head === "replaced" &&
          replaced.has(sub) &&
          !extra &&
          ["migration.sql", "contract.sql"].includes(file));
      if (!ok) unknown.push(`migrations/${folder.name}/${entry}`);
    }
    // A release's squashed migrations, from its sections (they outlive
    // replaces.json), in apply order.
    for (const name of sections.get(folder.name) ?? []) stems.push(`${folder.name}/${name}`);
    stems.push(folder.name);
  }
  for (const fixture of fixtures) {
    if (fixture.inner) {
      const squashed = sections.get(fixture.name) ?? [];
      for (const inner of fixture.inner)
        if (!squashed.some((name) => `${name}.sql` === inner))
          unknown.push(`fixtures/${fixture.name}/${inner}`);
      continue;
    }
    const stem = fixture.name.replace(/\.check\.sql$|\.sql$/, "");
    if (!fixture.name.endsWith(".sql") || !names.has(stem))
      unknown.push(`fixtures/${fixture.name}`);
  }
  return { unknown, stems };
}

/** Paths under `dir`, recursive, relative to it. */
function walk(dir, prefix = "") {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  if (!existsSync(MARKER))
    fail(
      "packages/db/prisma/template-history.json is absent: this app's migration history was already started (or this is not an app made from the template). Nothing to do.",
    );
  // Tags that carry the template's marker came with the template (a clone);
  // a tag without it is this app's own release: never fold released history.
  const tags = releaseTags();
  const own = tags.filter(
    (tag) =>
      spawnSync("git", ["cat-file", "-e", `${tag}:packages/db/prisma/template-history.json`], {
        cwd: ROOT,
      }).status !== 0,
  );
  if (own.length)
    fail(
      `this repository has release tags of its own (${own.slice(0, 3).join(", ")}): its migrations are released and immutable. Never fold them.`,
    );
  const inherited = tags.filter((tag) => !own.includes(tag));
  const dirty = git([
    "status",
    "--porcelain",
    "--ignored",
    "--",
    "packages/db/prisma/migrations",
    "packages/db/prisma/fixtures",
  ]).trim();
  if (dirty)
    fail(
      `uncommitted, untracked or ignored files under packages/db/prisma/migrations or fixtures; commit or remove them first:\n${dirty}`,
    );
  const folders = readMigrationsFolder(MIGRATIONS_DIR);
  const fixtures = existsSync(FIXTURES_DIR) ? readdirSync(FIXTURES_DIR) : [];
  const { releases } = readReleases(MIGRATIONS_DIR);
  const listing = inventory({
    folders: folders.map((m) => ({ name: m.name, entries: walk(path.dirname(m.file)) })),
    releases,
    sections: new Map(folders.map((m) => [m.name, sectionNames(m.sql)])),
    fixtures: fixtures.map((name) => {
      const full = path.join(FIXTURES_DIR, name);
      return { name, inner: statSync(full).isDirectory() ? readdirSync(full) : null };
    }),
    other: readdirSync(MIGRATIONS_DIR).filter((n) => !folders.some((m) => m.name === n)),
  });
  if (listing.unknown.length)
    fail(
      `files this command does not recognize (it would delete them):\n  - ${listing.unknown.join("\n  - ")}\nMove or remove them first.`,
    );
  const onlyInit =
    folders.length === 1 &&
    folders[0].name === "0_init" &&
    !folders[0].contract &&
    readdirSync(path.join(MIGRATIONS_DIR, "0_init")).length === 1 &&
    fixtures.every((f) => f === "0_init.sql" || f === "0_init.check.sql");
  const tagNote = inherited.length
    ? `\nThe release tags ${inherited.join(", ")} came from the template. Delete them in this app before its first release (\`git tag -d ${inherited.join(" ")}\`), or \`pnpm db:check-release\` would compare against the template's releases.`
    : "";
  if (onlyInit) {
    console.log("The inherited history is already a single 0_init; keeping it as it is.");
    if (!dryRun) rmSync(MARKER);
    console.log(
      `${dryRun ? "--dry-run: nothing written." : "Removed the template marker. Commit."}${tagNote}`,
    );
    return;
  }

  // Generate.
  const generated = tempConfig({ url: "postgresql://unused:unused@127.0.0.1:1/unused" });
  const diff = await prisma(
    [
      "migrate",
      "diff",
      "--from-empty",
      "--to-schema",
      SCHEMA_DIR,
      "--script",
      "--config",
      generated,
    ],
    { capture: true },
  );
  rmSync(path.dirname(generated), { recursive: true, force: true });
  if (diff.code !== 0) fail(`prisma migrate diff failed:\n${diff.stderr || diff.stdout}`);
  const initSql = wrapTransactional(diff.stdout);
  const folded = foldFixtures(listing.stems, (file) => {
    const p = path.join(FIXTURES_DIR, file);
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  });

  // Prove.
  const serverUrl = process.env.CHECK_DATABASE_URL || assertLocal("db:migrate", { shadow: true });
  const pg = loadPg();
  const admin = await adminClient(pg, serverUrl);
  const suffix = randomBytes(5).toString("hex");
  const names = [`knowledge_base_check_${suffix}o`, `knowledge_base_check_${suffix}n`];
  const work = mkdtempSync(path.join(tmpdir(), "knowledge-base-baseline-"));
  const problems = [];
  try {
    for (const name of names) await createDatabase(admin, name);
    const [oldUrl, newUrl] = names.map((name) => withDatabase(serverUrl, name));
    const connect = async (url) => {
      const client = new pg.Client({ connectionString: pgConnectionString(url) });
      await client.connect();
      return client;
    };
    const oldDeploy = await deployTo(oldUrl, MIGRATIONS_DIR);
    if (oldDeploy.code !== 0)
      throw new Error(
        `the inherited migrations failed to apply:\n${oldDeploy.stdout}${oldDeploy.stderr}`,
      );
    const oldClient = await connect(oldUrl);
    let oldLines;
    try {
      await applyAllContracts(oldClient, folders, { schema: "public" });
      oldLines = await fingerprint(oldClient);
      // A regenerated 0_init has no data: refuse if the inherited migrations
      // themselves create rows (reference data, defaults).
      const tables = (
        await oldClient.query(
          `SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations' ORDER BY 1`,
        )
      ).rows.map((r) => r.tablename);
      for (const table of tables) {
        const { rows } = await oldClient.query(
          `SELECT count(*)::int AS n FROM ${oldClient.escapeIdentifier(table)}`,
        );
        if (rows[0].n)
          problems.push(
            `the inherited migrations create ${rows[0].n} row(s) in "${table}"; a 0_init regenerated from the schema would not. Stop and ask: those statements must be carried into the new 0_init by hand.`,
          );
      }
    } finally {
      await oldClient.end().catch(() => {});
    }
    const newDir = path.join(work, "migrations");
    mkdirSync(path.join(newDir, "0_init"), { recursive: true });
    writeFileSync(path.join(newDir, "0_init", "migration.sql"), initSql);
    const lock = path.join(MIGRATIONS_DIR, "migration_lock.toml");
    if (existsSync(lock)) cpSync(lock, path.join(newDir, "migration_lock.toml"));
    const newDeploy = await deployTo(newUrl, newDir);
    if (newDeploy.code !== 0)
      throw new Error(`the new 0_init failed to apply:\n${newDeploy.stdout}${newDeploy.stderr}`);
    const newClient = await connect(newUrl);
    try {
      const d = fingerprintDiff(oldLines, await fingerprint(newClient));
      for (const line of d.onlyA) problems.push(`only the inherited history has: ${line}`);
      for (const line of d.onlyB) problems.push(`only the new 0_init has: ${line}`);
      const left = await residue(newClient, newUrl, new Map());
      if (left.error || left.sql)
        problems.push(`the new 0_init does not match the Prisma schema: ${left.error ?? left.sql}`);
      if (folded[".sql"]) {
        try {
          await newClient.query(folded[".sql"]);
        } catch (error) {
          problems.push(
            `the inherited fixtures do not load on the new 0_init: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (folded[".check.sql"] && !problems.length) {
        const results = await newClient.query(folded[".check.sql"]);
        for (const r of Array.isArray(results) ? results : [results])
          if (r.command === "SELECT" && r.rowCount)
            problems.push(
              `a fixture check returned ${r.rowCount} row(s): ${JSON.stringify(r.rows.slice(0, 2))}`,
            );
      }
    } finally {
      await newClient.end().catch(() => {});
    }
  } finally {
    for (const name of names)
      await removeDatabase(admin, name, { kind: "scratch" }).catch(() => {});
    await admin.end().catch(() => {});
    rmSync(work, { recursive: true, force: true });
  }
  if (problems.length) fail(`not equivalent; nothing written:\n  - ${problems.join("\n  - ")}`);
  console.log(
    `Proved: ${folders.length} inherited migration(s) and the new 0_init give identical schemas; the fixtures load and pass.`,
  );
  if (dryRun) {
    console.log("--dry-run: nothing written.");
    return;
  }
  // Only what the inventory recognized is replaced.
  for (const m of folders) rmSync(path.dirname(m.file), { recursive: true });
  mkdirSync(path.join(MIGRATIONS_DIR, "0_init"));
  writeFileSync(path.join(MIGRATIONS_DIR, "0_init", "migration.sql"), initSql);
  for (const file of fixtures) rmSync(path.join(FIXTURES_DIR, file), { recursive: true });
  if (folded[".sql"]) writeFileSync(path.join(FIXTURES_DIR, "0_init.sql"), folded[".sql"]);
  if (folded[".check.sql"])
    writeFileSync(path.join(FIXTURES_DIR, "0_init.check.sql"), folded[".check.sql"]);
  rmSync(MARKER);
  console.log(
    "Wrote migrations/0_init (this app's own baseline) and its fixtures; removed the template marker.\n" +
      `Next: \`pnpm db:reset:local\` (your local database applied the inherited history), then commit.${tagNote}`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
}
