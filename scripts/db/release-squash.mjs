#!/usr/bin/env node
/**
 * `pnpm db:release-squash <last-tag> <release-name> [--dry-run]` — in the
 * version-bump PR, squash every migration added since <last-tag> into ONE
 * release migration (docs/schema-migrations.md § Releases).
 *
 *   1. The migrations added since <last-tag> (`git diff <last-tag>`): must be
 *      additions only. A folder that is in the tag and changed (or was
 *      deleted) is refused: released migrations are immutable.
 *   2. Their SQL is CONCATENATED in folder order (never regenerated from a
 *      schema diff, which turns renames into drop + add and loses backfills)
 *      into `<timestamp>_release_<name>/migration.sql`, one transaction, each
 *      section headed `-- knowledge-base:from <folder>`; their contract.sql files
 *      likewise into the release's contract.sql.
 *   3. `replaces.json` (names + sha256 of every replaced file) and a
 *      byte-exact `replaced/<folder>/` copy, so databases that already applied
 *      some of them (test deploys from the default branch) are reconciled by
 *      the deploy runner instead of re-running SQL.
 *   4. The per-PR folders are deleted. Their data fixtures move to
 *      fixtures/<release>/<folder>.sql for good: CI loads each right after
 *      its migration (or, once the release is in the base, right after its
 *      `-- knowledge-base:from` section, replaying the release section by section),
 *      so the rows keep being written in the order they were on the default
 *      branch. Their checks are concatenated into fixtures/<release>.check.sql.
 *   5. The previous release's `replaced/` and `replaces.json` (folders that
 *      are in <last-tag>) are removed: every test deploy has passed it by now.
 *
 * Refused (release without a squash this time instead; that is always valid):
 * a migration without the generator's transactional wrapper (it cannot join
 * the release's single transaction), and an enum-remove block (its object
 * names hash the folder name).
 *
 * Refuses uncommitted, untracked or ignored files under migrations/ and
 * fixtures/, and any file it would delete without recognizing it.
 * Writes files only; touches no database. Then run
 * `pnpm db:check-release <last-tag>` (Guards A and B).
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { git, migrationFoldersAt } from "./lib/local.mjs";
import { readMigrationsFolder } from "./lib/migration-state.mjs";
import { FIXTURES_DIR, MIGRATIONS_DIR, ROOT } from "./lib/prisma.mjs";
import {
  FROM_MARKER,
  folderBoundTemplates,
  MANIFEST_FORMAT,
  REPLACED_DIR,
  REPLACES_FILE,
  readReleases,
  wrappedBody,
} from "./lib/replaces.mjs";
import { CONTRACT_FILE, checkWrapper, wrapTransactional } from "./lib/sql.mjs";
import { nextPrefix } from "./migrate.mjs";

const MIGRATIONS_REL = "packages/db/prisma/migrations";
const FIXTURES_REL = "packages/db/prisma/fixtures";
const USAGE = "usage: pnpm db:release-squash <last-tag> <release-name> [--dry-run]";

/** `1.2.0` → `1_2_0`; the folder is `<timestamp>_release_<slug>`. */
export function releaseSlug(name) {
  const slug = String(name)
    .toLowerCase()
    .replace(/^v(?=\d)/, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!slug || slug.length > 50)
    throw new Error(`release name "${name}" gives no usable folder name`);
  return slug;
}

/**
 * Pure: what the release folder holds (exported for tests).
 * @param {{ release: string, tag: string,
 *   migrations: Array<{ name: string, sql: string, checksum: string,
 *     contract: { sql: string, checksum: string } | null }> }} input folder order
 * @returns {{ problems: string[], migrationSql?: string, contractSql?: string | null, manifest?: object }}
 */
export function buildRelease({ release, tag, migrations }) {
  const problems = [];
  for (const m of migrations) {
    const wrapper = checkWrapper(m.sql);
    if (!wrapper.ok)
      problems.push(
        `${m.name}/migration.sql has no intact transactional wrapper (${wrapper.reason}); it cannot join the release's single transaction.`,
      );
    for (const file of [m.sql, m.contract?.sql ?? ""])
      for (const { line } of folderBoundTemplates(file))
        problems.push(
          `${m.name} line ${line}: an enum-remove block names objects after its folder, so it cannot move into a release folder.`,
        );
  }
  if (problems.length) return { problems };
  const head = `-- Release migration: ${migrations.length} migration(s) added since ${tag}, concatenated in order by \`pnpm db:release-squash\` Never edit; ${REPLACES_FILE} lists what it replaces (docs/schema-migrations.md § Releases).`;
  const sections = migrations.map((m) => `${FROM_MARKER} ${m.name}\n${wrappedBody(m.sql)}`);
  const migrationSql = wrapTransactional(`${head}\n\n${sections.join("\n")}`);
  const withContract = migrations.filter((m) => m.contract);
  const contractSql = withContract.length
    ? `-- Release contract: the scheduled deletions of the migrations ${release} replaces, in order.\n\n${withContract
        .map((m) => `${FROM_MARKER} ${m.name}\n${m.contract.sql.trimEnd()}\n`)
        .join("\n")}`
    : null;
  const manifest = {
    format: MANIFEST_FORMAT,
    release,
    tag,
    replaces: migrations.map((m) => ({
      name: m.name,
      checksum: m.checksum,
      contractChecksum: m.contract?.checksum ?? null,
    })),
  };
  return { problems, migrationSql, contractSql, manifest };
}

function fail(message) {
  console.error(`FATAL: ${message}`);
  process.exit(1);
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const [tag, name] = args.filter((a) => !a.startsWith("--"));
  if (!tag || !name) {
    console.error(USAGE);
    process.exit(2);
  }
  try {
    git(["rev-parse", "--verify", "--quiet", `${tag}^{commit}`]);
  } catch {
    fail(`${tag} is not a commit or tag in this repository.`);
  }
  const dirty = git([
    "status",
    "--porcelain",
    "--ignored",
    "--",
    MIGRATIONS_REL,
    FIXTURES_REL,
  ]).trim();
  if (dirty)
    fail(
      `uncommitted, untracked or ignored files under ${MIGRATIONS_REL} or ${FIXTURES_REL}; commit or remove them first so the squash is one reviewable diff and deletes nothing unseen:\n${dirty}`,
    );

  // 1. Additions only since the tag.
  const tagFolders = new Set(migrationFoldersAt(tag));
  const changed = git(["diff", "--name-status", "--no-renames", tag, "--", MIGRATIONS_REL])
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"))
    .filter(([status, file]) => {
      const folder = file.slice(MIGRATIONS_REL.length + 1).split("/")[0];
      return status !== "A" && tagFolders.has(folder);
    });
  if (changed.length)
    fail(
      `migration files that are in ${tag} changed since: ${changed.map(([s, f]) => `${s} ${f}`).join(", ")}. ` +
        "Released migrations are immutable; restore them and put the change in a new migration.",
    );
  const head = readMigrationsFolder(MIGRATIONS_DIR);
  const added = head.filter((m) => !tagFolders.has(m.name));
  if (!added.length) fail(`no migrations were added since ${tag}; nothing to squash.`);
  const { releases, problems: manifestProblems } = readReleases(MIGRATIONS_DIR);
  if (manifestProblems.length)
    fail(`release manifests are not intact: ${manifestProblems.join("; ")}`);
  const alreadyRelease = added.filter((m) => releases.some((r) => r.name === m.name));
  if (alreadyRelease.length)
    fail(
      `${alreadyRelease.map((m) => m.name).join(", ")} is already a release migration (added since ${tag}).`,
    );

  // Everything this command deletes must be something it recognizes.
  const strays = [];
  for (const m of added)
    for (const entry of readdirSync(path.dirname(m.file)))
      if (entry !== "migration.sql" && entry !== CONTRACT_FILE) strays.push(`${m.name}/${entry}`);
  for (const r of releases.filter((x) => tagFolders.has(x.name)))
    for (const e of r.replaces) {
      const copy = path.join(MIGRATIONS_DIR, r.name, REPLACED_DIR, e.name);
      if (existsSync(copy))
        for (const entry of readdirSync(copy))
          if (entry !== "migration.sql" && entry !== CONTRACT_FILE)
            strays.push(`${r.name}/${REPLACED_DIR}/${e.name}/${entry}`);
    }
  if (strays.length)
    fail(
      `files this command does not recognize (it would delete them):\n  - ${strays.join("\n  - ")}\nMove or remove them first.`,
    );

  // 2–3. Build the release folder.
  const folder = `${nextPrefix(head.map((m) => m.name))}_release_${releaseSlug(name)}`;
  const built = buildRelease({ release: folder, tag, migrations: added });
  if (built.problems.length)
    fail(
      `cannot squash:\n  - ${built.problems.join("\n  - ")}\nRelease without a squash this time (the per-PR migrations ship as they are, which is always valid), or ask the owner.`,
    );
  const previous = releases.filter((r) => tagFolders.has(r.name));
  const fixtures = existsSync(FIXTURES_DIR) ? readdirSync(FIXTURES_DIR) : [];
  console.log(`Release ${folder} replaces ${added.length} migration(s) added since ${tag}:`);
  for (const m of added) console.log(`  - ${m.name}${m.contract ? " (+ contract.sql)" : ""}`);
  if (previous.length)
    console.log(
      `Removes the ${REPLACED_DIR}/ copies and ${REPLACES_FILE} of ${previous.map((r) => r.name).join(", ")} (released in ${tag}).`,
    );
  if (dryRun) {
    console.log("\n--dry-run: nothing written.");
    return;
  }

  const dir = path.join(MIGRATIONS_DIR, folder);
  mkdirSync(dir);
  writeFileSync(path.join(dir, "migration.sql"), built.migrationSql);
  if (built.contractSql) writeFileSync(path.join(dir, CONTRACT_FILE), built.contractSql);
  writeFileSync(path.join(dir, REPLACES_FILE), `${JSON.stringify(built.manifest, null, 2)}\n`);
  for (const m of added) {
    const copy = path.join(dir, REPLACED_DIR, m.name);
    mkdirSync(copy, { recursive: true });
    copyFileSync(m.file, path.join(copy, "migration.sql"));
    if (m.contract)
      copyFileSync(path.join(path.dirname(m.file), CONTRACT_FILE), path.join(copy, CONTRACT_FILE));
  }
  // 4. Fixtures keep their provenance: a data fixture moves to
  // fixtures/<release>/<folder>.sql (CI loads it right after that migration
  // when it simulates a database that applied the migrations one by one);
  // the checks run after everything, so they are concatenated.
  const checks = [];
  for (const m of added) {
    const data = path.join(FIXTURES_DIR, `${m.name}.sql`);
    if (existsSync(data)) {
      mkdirSync(path.join(FIXTURES_DIR, folder), { recursive: true });
      renameSync(data, path.join(FIXTURES_DIR, folder, `${m.name}.sql`));
    }
    const check = path.join(FIXTURES_DIR, `${m.name}.check.sql`);
    if (!existsSync(check)) continue;
    checks.push(`-- from ${m.name}.check.sql\n${readFileSync(check, "utf8").trimEnd()}\n`);
    rmSync(check);
  }
  if (checks.length)
    writeFileSync(path.join(FIXTURES_DIR, `${folder}.check.sql`), checks.join("\n"));
  for (const m of added) rmSync(path.dirname(m.file), { recursive: true });
  // 5. One release later: the previous release's copies go.
  for (const r of previous) {
    rmSync(path.join(MIGRATIONS_DIR, r.name, REPLACED_DIR), { recursive: true, force: true });
    rmSync(path.join(MIGRATIONS_DIR, r.name, REPLACES_FILE), { force: true });
  }
  const after = readReleases(MIGRATIONS_DIR);
  if (after.problems.length)
    fail(`the written release does not verify: ${after.problems.join("; ")}`);
  console.log(
    `\nWrote ${path.relative(ROOT, dir)}/ (migration.sql${built.contractSql ? ", contract.sql" : ""}, ${REPLACES_FILE}, ${REPLACED_DIR}/).` +
      `${fixtures.length ? " Fixtures moved with their migrations." : ""}\n` +
      `Next: review the diff, then \`pnpm db:check-release ${tag}\` (Guards A and B), \`pnpm db:migrate:apply\`, commit.`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
