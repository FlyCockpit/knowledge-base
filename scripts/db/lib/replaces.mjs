/**
 * Release migrations: one migration per release, with a manifest of the
 * per-PR migrations it replaces (docs/schema-migrations.md § Releases).
 *
 * At release, `pnpm db:release-squash` concatenates every migration added
 * since the last release tag into ONE folder, `<timestamp>_release_<name>`:
 *
 *   migration.sql   the replaced bodies in order, one transaction, each
 *                   section headed `-- knowledge-base:from <replaced folder>`
 *   contract.sql    the replaced contract.sql files in order, same headers
 *   replaces.json   { format: 1, release, replaces: [{ name, checksum,
 *                   contractChecksum }] } (sha256 of the replaced files)
 *   replaced/<name>/migration.sql (+ contract.sql)   byte-exact copies
 *
 * A database that applied none of the replaced migrations (a fresh one, or a
 * self-hoster on the last release) applies the release migration normally.
 * A test deployment that tracked the default branch applied some or all of
 * them; before `prisma migrate deploy`, the runner (and `db:migrate:apply`)
 * reconcile it here, in ONE transaction: apply the missing ones from
 * `replaced/` in order, record the release migration as applied, and remove
 * the replaced rows. A checksum mismatch, a replaced migration recorded as
 * failed, or an applied migration that is neither in the image nor replaced
 * is refused. `replaced/` and `replaces.json` are removed one release later.
 *
 * Contracts: the release's contract.sql is the replaced contracts in order.
 * If all of them already ran, the release's contract is recorded as applied;
 * if some ran, their sections are recorded in
 * `_knowledge_base_migration.contract_done_parts` and only the rest runs later
 * (`remainingContract`).
 *
 * Plain Node, no dependencies: it runs inside the production image.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describeEffects, rollbackSafetyOf } from "./contracts.mjs";
import {
  CONTRACT_FILE,
  checkWrapper,
  HISTORY_CAPTURE_STATEMENT,
  parseTemplateHeader,
  splitStatements,
  summarizeEffects,
} from "./sql.mjs";

export const REPLACES_FILE = "replaces.json";
export const REPLACED_DIR = "replaced";
/** Section header in a release's migration.sql / contract.sql. */
export const FROM_MARKER = "-- knowledge-base:from";
export const MANIFEST_FORMAT = 1;
/** Prisma's migrate advisory lock key (migration-state.mjs PRISMA_ADVISORY_LOCK). */
const PRISMA_LOCK = 72707369;
const NAME_RE = /^(0_init|\d{14}_[a-z0-9_]{1,80})$/;
const RECONCILE_LOCK_TIMEOUT = "5s";
const RECONCILE_STATEMENT_TIMEOUT = "60s";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const quoteIdent = (name) => `"${String(name).replaceAll('"', '""')}"`;

/**
 * @typedef {{ name: string, checksum: string, contractChecksum: string | null,
 *   sql: string | null, contract: string | null }} ReplacedEntry
 * @typedef {{ name: string, checksum: string, contract: { sql: string, checksum: string } | null,
 *   tag: string | null, replaces: ReplacedEntry[] }} Release
 */

/**
 * Every release manifest in a migrations folder, with its replaced copies
 * verified against the manifest. `problems` are integrity failures (a
 * tampered or missing copy, a malformed manifest); the runner refuses to
 * start on any of them.
 * @param {string} dir migrations folder
 * @returns {{ releases: Release[], problems: string[] }}
 */
export function readReleases(dir) {
  const releases = [];
  const problems = [];
  if (!existsSync(dir)) return { releases, problems };
  const folders = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(path.join(dir, e.name, "migration.sql")))
    .map((e) => e.name)
    .sort();
  const top = new Set(folders);
  const seen = new Map();
  for (const name of folders) {
    const folder = path.join(dir, name);
    const manifestFile = path.join(folder, REPLACES_FILE);
    const copiesDir = path.join(folder, REPLACED_DIR);
    if (!existsSync(manifestFile)) {
      if (existsSync(copiesDir))
        problems.push(`${name}: has ${REPLACED_DIR}/ but no ${REPLACES_FILE}`);
      continue;
    }
    const parsed = parseManifest(readFileSync(manifestFile, "utf8"), name);
    if (parsed.problem) {
      problems.push(`${name}/${REPLACES_FILE}: ${parsed.problem}`);
      continue;
    }
    const migrationBytes = readFileSync(path.join(folder, "migration.sql"));
    const contractFile = path.join(folder, CONTRACT_FILE);
    const contractBytes = existsSync(contractFile) ? readFileSync(contractFile) : null;
    const replaces = [];
    const listed = new Set(parsed.replaces.map((e) => e.name));
    for (const entry of parsed.replaces) {
      if (top.has(entry.name))
        problems.push(
          `${name}: replaced migration ${entry.name} is still a migration folder of its own`,
        );
      if (seen.has(entry.name))
        problems.push(`${entry.name} is replaced by both ${seen.get(entry.name)} and ${name}`);
      seen.set(entry.name, name);
      const sqlFile = path.join(copiesDir, entry.name, "migration.sql");
      const contractCopy = path.join(copiesDir, entry.name, CONTRACT_FILE);
      let sql = null;
      let contract = null;
      if (!existsSync(sqlFile))
        problems.push(`${name}: ${REPLACED_DIR}/${entry.name}/migration.sql is missing`);
      else {
        const bytes = readFileSync(sqlFile);
        if (sha256(bytes) !== entry.checksum)
          problems.push(
            `${name}: ${REPLACED_DIR}/${entry.name}/migration.sql does not match the checksum in ${REPLACES_FILE} (edited or tampered with)`,
          );
        else sql = bytes.toString("utf8");
      }
      if (entry.contractChecksum) {
        if (!existsSync(contractCopy))
          problems.push(`${name}: ${REPLACED_DIR}/${entry.name}/${CONTRACT_FILE} is missing`);
        else {
          const bytes = readFileSync(contractCopy);
          if (sha256(bytes) !== entry.contractChecksum)
            problems.push(
              `${name}: ${REPLACED_DIR}/${entry.name}/${CONTRACT_FILE} does not match the checksum in ${REPLACES_FILE} (edited or tampered with)`,
            );
          else contract = bytes.toString("utf8");
        }
      } else if (existsSync(contractCopy))
        problems.push(
          `${name}: ${REPLACED_DIR}/${entry.name}/${CONTRACT_FILE} is not listed in ${REPLACES_FILE}`,
        );
      replaces.push({ ...entry, sql, contract });
    }
    if (existsSync(copiesDir))
      for (const extra of readdirSync(copiesDir))
        if (!listed.has(extra))
          problems.push(`${name}: ${REPLACED_DIR}/${extra} is not listed in ${REPLACES_FILE}`);
    releases.push({
      name,
      tag: parsed.tag,
      checksum: sha256(migrationBytes),
      contract: contractBytes
        ? { sql: contractBytes.toString("utf8"), checksum: sha256(contractBytes) }
        : null,
      replaces,
    });
  }
  return { releases, problems };
}

/**
 * The replaced migrations a migrations folder still ships (readReleases,
 * every copy verified against its replaces.json), flat and in release then
 * folder order, for backup snapshots and offline restore. Throws on any
 * integrity problem: a bundle or restore never describes a history from
 * manifests that do not match their copies.
 * @param {string} dir migrations folder
 * @returns {Array<{ name: string, release: string, checksum: string, contractChecksum: string | null }>}
 */
export function readReplacedMigrations(dir) {
  const { releases, problems } = readReleases(dir);
  if (problems.length)
    throw new Error(`Release migration manifests are invalid: ${problems.join("; ")}`);
  return releases.flatMap((release) =>
    release.replaces.map((entry) => ({
      name: entry.name,
      release: release.name,
      checksum: entry.checksum,
      contractChecksum: entry.contractChecksum,
    })),
  );
}

/**
 * @param {string} text
 * @param {string} folder the release folder the manifest sits in
 * @returns {{ problem?: string, tag: string | null,
 *   replaces: Array<{ name: string, checksum: string, contractChecksum: string | null }> }}
 */
export function parseManifest(text, folder) {
  let json;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return { problem: `not valid JSON (${error.message})`, replaces: [], tag: null };
  }
  if (!json || typeof json !== "object")
    return { problem: "not a JSON object", replaces: [], tag: null };
  if (json.format !== MANIFEST_FORMAT)
    return { problem: `unknown format ${JSON.stringify(json.format)}`, replaces: [], tag: null };
  if (json.release !== folder)
    return {
      problem: `names release ${JSON.stringify(json.release)}, but it is in folder ${folder}`,
      replaces: [],
      tag: null,
    };
  if (!Array.isArray(json.replaces) || !json.replaces.length)
    return { problem: '"replaces" must be a non-empty array', replaces: [], tag: null };
  const out = [];
  const names = new Set();
  for (const entry of json.replaces) {
    const hex = (v) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
    if (
      !entry ||
      typeof entry.name !== "string" ||
      !NAME_RE.test(entry.name) ||
      !hex(entry.checksum) ||
      !(entry.contractChecksum === null || hex(entry.contractChecksum))
    )
      return { problem: `malformed entry ${JSON.stringify(entry)}`, replaces: [], tag: null };
    if (names.has(entry.name))
      return { problem: `${entry.name} is listed twice`, replaces: [], tag: null };
    if (entry.name >= folder)
      return {
        problem: `${entry.name} does not sort before the release folder (the release must apply after what it replaces)`,
        replaces: [],
      };
    names.add(entry.name);
    out.push({
      name: entry.name,
      checksum: entry.checksum,
      contractChecksum: entry.contractChecksum,
    });
  }
  const sorted = [...out].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (sorted.some((e, i) => e.name !== out[i].name))
    return { problem: '"replaces" must be in folder order', replaces: [], tag: null };
  return { replaces: out, tag: typeof json.tag === "string" ? json.tag : null };
}

/** The `_prisma_migrations` columns planReconcile reads. */
export const READ_HISTORY_SQL = (schema) =>
  `SELECT migration_name, checksum, finished_at, rolled_back_at FROM ${quoteIdent(schema)}."_prisma_migrations"`;

/** Every replaced migration name → its release. */
function replacedNames(releases) {
  const map = new Map();
  for (const release of releases) for (const e of release.replaces) map.set(e.name, release.name);
  return map;
}

/**
 * Does this database state involve replaced migrations (so the runner must
 * reconcile before it classifies the database as ahead of the image)?
 * @param {{ ahead: string[] }} state readMigrationState result
 */
export function needsReconcile(state, releases) {
  const replaced = replacedNames(releases);
  return (state.ahead ?? []).some((name) => replaced.has(name));
}

/**
 * Pure plan over `_prisma_migrations` rows.
 * @param {{ rows: Array<{ migration_name: string, checksum: string | null,
 *   finished_at: unknown, rolled_back_at: unknown }>, releases: Release[], localNames: string[] }} input
 * @returns {{ steps: Array<{ release: Release, missing: ReplacedEntry[], present: string[] }>, refusals: string[] }}
 */
export function planReconcile({ rows, releases, localNames }) {
  const applied = new Map();
  const failed = new Set();
  for (const row of rows) {
    if (row.rolled_back_at) continue;
    if (row.finished_at) applied.set(row.migration_name, row);
    else failed.add(row.migration_name);
  }
  for (const name of applied.keys()) failed.delete(name);
  const steps = [];
  const refusals = [];
  for (const release of releases) {
    const names = release.replaces.map((e) => e.name);
    const present = names.filter((n) => applied.has(n));
    const failing = names.filter((n) => failed.has(n));
    if (!present.length && !failing.length) continue;
    if (failing.length) {
      refusals.push(
        `replaced migration(s) ${failing.join(", ")} of ${release.name} are recorded as failed in this database. ` +
          "Resolve them first with the image that still contains them as migrations (docs/schema-migrations.md § Recovery runbook).",
      );
      continue;
    }
    if (applied.has(release.name) || failed.has(release.name)) {
      refusals.push(
        `the database records both ${release.name} and the migrations it replaces (${present.join(", ")}). ` +
          "That only happens when something other than the runner edited the migration history. A person decides: docs/schema-migrations.md § Recovery runbook.",
      );
      continue;
    }
    const mismatch = release.replaces.filter(
      (e) => applied.has(e.name) && applied.get(e.name).checksum !== e.checksum,
    );
    if (mismatch.length) {
      refusals.push(
        `replaced migration(s) ${mismatch.map((e) => e.name).join(", ")} were applied with different contents than ` +
          `${release.name}/${REPLACES_FILE} records (checksum mismatch). The release migration would not describe ` +
          "this database. Restore the original migration files, or rebuild this test database.",
      );
      continue;
    }
    const missing = release.replaces.filter((e) => !applied.has(e.name));
    const noCopy = missing.filter((e) => e.sql === null);
    if (noCopy.length) {
      refusals.push(
        `${release.name}: cannot apply the missing replaced migration(s) ${noCopy.map((e) => e.name).join(", ")}: ` +
          `their ${REPLACED_DIR}/ copy is missing or does not match ${REPLACES_FILE}.`,
      );
      continue;
    }
    const unwrapped = missing.filter((e) => !checkWrapper(e.sql).ok);
    if (unwrapped.length) {
      refusals.push(
        `${release.name}: the missing replaced migration(s) ${unwrapped.map((e) => e.name).join(", ")} are not ` +
          "transactional, so they cannot be applied inside the reconciliation transaction. Deploy the image of the " +
          "commit that added them first, then this one.",
      );
      continue;
    }
    steps.push({ release, missing, present });
  }
  if (steps.length || refusals.length) {
    const known = new Set([...localNames, ...replacedNames(releases).keys()]);
    const unknown = [...applied.keys(), ...failed].filter((n) => !known.has(n));
    if (unknown.length)
      refusals.push(
        `the database has applied migration(s) that are neither in this image nor replaced by one of its releases: ` +
          `${[...new Set(unknown)].join(", ")}. Refusing to reconcile a history this image does not describe. ` +
          "If they belong to an older release whose replaced/ copies were removed since, deploy that release's image first; " +
          "otherwise this is a different branch's database (docs/schema-migrations.md § Releases).",
      );
  }
  return { steps, refusals };
}

/**
 * The body of a wrapped (`-- knowledge-base:transactional`) migration: the
 * statements between the history-capture block and the commit marker,
 * comments kept, wrapper removed.
 * @param {string} sql
 */
export function wrappedBody(sql) {
  const wrapper = checkWrapper(sql);
  if (!wrapper.ok) throw new Error(`not a generated transactional migration (${wrapper.reason})`);
  const parsed = splitStatements(sql);
  const norm = (t) =>
    String(t ?? "")
      .replace(/\s+/g, " ")
      .replace(/\s*;\s*$/, "")
      .trim();
  const capture = norm(HISTORY_CAPTURE_STATEMENT);
  const at = parsed.findIndex((s) => norm(s.text) === capture);
  if (at < 0) throw new Error("the history-capture block is missing");
  const marker = parsed.at(-2);
  let body = sql.slice(parsed[at].end, marker.start);
  // The comment lines that head the commit marker belong to the wrapper.
  body = body.replace(/\n?-- knowledge-base:commit-marker[^\n]*\n?\s*$/, "\n");
  return `${body.replace(/^\s*\n/, "").trimEnd()}\n`;
}

/**
 * Split a release migration.sql / contract.sql into `-- knowledge-base:from`
 * sections. Text before the first header is `preamble`.
 * @param {string} sql
 * @returns {{ preamble: string, sections: Array<{ name: string, text: string }> }}
 */
export function splitSections(sql) {
  const lines = sql.split("\n");
  const sections = [];
  const preamble = [];
  let current = null;
  for (const line of lines) {
    const match = /^-- knowledge-base:from (\S+)\s*$/.exec(line);
    if (match) {
      current = { name: match[1], lines: [line] };
      sections.push(current);
    } else if (current) current.lines.push(line);
    else preamble.push(line);
  }
  return {
    preamble: preamble.join("\n"),
    sections: sections.map((s) => ({ name: s.name, text: s.lines.join("\n") })),
  };
}

/**
 * The replaced migrations a release folder's migration.sql names in its
 * `-- knowledge-base:from` sections (immutable, so this outlives replaces.json);
 * [] for any other migration.
 * @param {string} sql
 */
export function sectionNames(sql) {
  try {
    return splitSections(wrappedBody(sql)).sections.map((s) => s.name);
  } catch {
    return [];
  }
}

/**
 * The migration with the sections of its contract.sql that already ran
 * (`contract_done_parts`) removed. The checksum stays the whole file's.
 * @template {{ contract: { sql: string, checksum: string } | null }} M
 * @param {M} migration
 * @param {{ contract_done_parts?: string[] | null } | undefined} row
 * @returns {M}
 */
export function remainingContract(migration, row) {
  const done = row?.contract_done_parts;
  if (!migration.contract || !Array.isArray(done) || !done.length) return migration;
  const { preamble, sections } = splitSections(migration.contract.sql);
  const kept = sections.filter((s) => !done.includes(s.name)).map((s) => s.text);
  const sql = [preamble, ...kept].filter((t) => t.trim()).join("\n");
  return { ...migration, contract: { ...migration.contract, sql: sql ? `${sql}\n` : "" } };
}

/** Template headers whose generated text depends on the folder name (cannot be squashed). */
export function folderBoundTemplates(sql) {
  return sql
    .split("\n")
    .map((line, i) => ({ line: i + 1, header: parseTemplateHeader(line) }))
    .filter(({ header }) => header?.kind === "enum-remove");
}

/**
 * Apply one reconciliation step in ONE transaction: the missing replaced
 * migrations (bodies, in folder order), the release recorded as applied,
 * the replaced rows removed, and the contract state carried over. Takes
 * Prisma's migrate lock for the transaction (a concurrent
 * `prisma migrate deploy` cannot interleave), then locks and re-reads the
 * WHOLE history and plans again from it: anything that changed since the
 * step was planned (a row another session added, finished or failed in the
 * meantime) aborts before any SQL runs.
 * @param {import("pg").Client} client
 * @param {{ schema: string, step: { release: Release, missing: ReplacedEntry[], present: string[] },
 *   releases: Release[], localNames: string[], log?: (message: string) => void }} options
 * @returns {Promise<{ applied: string[], contracts: "none" | "all" | "some" }>}
 */
export async function applyReconcile(
  client,
  { schema, step, releases, localNames, migrations, log = () => {} },
) {
  const s = quoteIdent(schema);
  const { release, missing } = step;
  const replaced = release.replaces.map((e) => e.name);
  await client.query("BEGIN");
  try {
    await client.query(`SET LOCAL lock_timeout = '${RECONCILE_LOCK_TIMEOUT}'`);
    await client.query(`SET LOCAL statement_timeout = '${RECONCILE_STATEMENT_TIMEOUT}'`);
    const lock = await client.query("SELECT pg_try_advisory_xact_lock($1) AS ok", [PRISMA_LOCK]);
    if (!lock.rows[0]?.ok)
      throw new Error(
        "another session holds Prisma's migration lock (a `prisma migrate deploy` is running); nothing was changed",
      );
    const rows = (await client.query(`${READ_HISTORY_SQL(schema)} FOR UPDATE`)).rows;
    const again = planReconcile({ rows, releases, localNames });
    if (again.refusals.length) throw new Error(again.refusals.join(" "));
    const same = again.steps.find((x) => x.release.name === release.name);
    const names = (list) => JSON.stringify([...list].sort());
    if (
      !same ||
      names(same.present) !== names(step.present) ||
      names(same.missing.map((e) => e.name)) !== names(missing.map((e) => e.name))
    )
      throw new Error("the migration history changed while reconciling; nothing was changed");
    await client.query(`SET LOCAL search_path TO ${s}`);
    for (const entry of missing) {
      log(
        `applying ${entry.name} from ${release.name}/${REPLACED_DIR}/ (it was never applied here)`,
      );
      try {
        await client.query(wrappedBody(entry.sql));
      } catch (error) {
        throw new Error(
          `${entry.name} (from ${release.name}/${REPLACED_DIR}/) failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    await client.query(
      `INSERT INTO ${s}."_prisma_migrations"
         (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
       VALUES ($1, $2, now(), $3, NULL, NULL, now(), 1)`,
      [randomUUID(), release.checksum, release.name],
    );
    await client.query(
      `DELETE FROM ${s}."_prisma_migrations" WHERE migration_name = ANY($1::text[])`,
      [replaced],
    );
    const contracts = await carryContractState(client, schema, release, step.present, migrations);
    await client.query("COMMIT");
    return { applied: missing.map((e) => e.name), contracts };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

/**
 * Move the replaced migrations' `_knowledge_base_migration` rows onto the release.
 * Inside applyReconcile's transaction. A replaced contract counts as done
 * only if the database recorded the same contract.sql the manifest lists
 * (anything else is refused). Once any part ran, the release is not
 * rollback-safe: the data an older release needs is (partly) gone, and an
 * older runner that knows nothing of `contract_done_parts` must refuse too.
 * @returns {Promise<"none" | "all" | "some">} which replaced contracts already ran
 */
async function carryContractState(client, schema, release, present, migrations) {
  const s = quoteIdent(schema);
  const exists = await client.query(
    "SELECT to_regclass(format('%I.\"_knowledge_base_migration\"', $1::text)) AS t",
    [schema],
  );
  if (!exists.rows[0].t) return "none";
  const replaced = release.replaces.map((e) => e.name);
  const { rows } = await client.query(
    `SELECT name, rollback_safe, rollback_reasons, contract_checksum, contract_applied_at, contract_backup
       FROM ${s}."_knowledge_base_migration" WHERE name = ANY($1::text[]) FOR UPDATE`,
    [replaced],
  );
  const byName = new Map(rows.map((r) => [r.name, r]));
  const ran = release.replaces.filter((e) => byName.get(e.name)?.contract_applied_at);
  // Every recorded contract, pending ones too (null-aware, as validateContract
  // compares): a pending deletion must not change by being reconciled onto
  // the release, and one that ran must be the one the release describes.
  const wrong = release.replaces.filter(
    (e) => byName.has(e.name) && byName.get(e.name).contract_checksum !== e.contractChecksum,
  );
  if (wrong.length)
    throw new Error(
      `the scheduled deletion (contract.sql) recorded here for ${wrong.map((e) => e.name).join(", ")} is not the one ` +
        `${release.name}/${REPLACES_FILE} records (checksum mismatch): this database scheduled or ran a deletion the release ` +
        "does not describe. Rebuild this test database, or ask a person (docs/schema-migrations.md § Recovery runbook)",
    );
  const withContract = release.replaces.filter((e) => e.contractChecksum);
  const done = ran;
  let outcome = "none";
  if (release.contract) {
    // The row is written here, in the reconcile transaction, even when no
    // part ran yet: a snapshot (the full-bundle backup before the next
    // migration) refuses an applied migration with a contract.sql that has
    // no row, and recordApplied only runs after a whole deploy (and never
    // rewrites a row). Rollback safety is the union of what the replaced rows
    // recorded and recordApplied's own analysis of the release, so a missing
    // migration that reconcile just applied counts exactly as it would on a
    // normal deploy.
    const reasons = release.replaces
      .map((e) => {
        const row = byName.get(e.name);
        if (!row) return present.includes(e.name) ? `${e.name}: no rollback record` : null;
        return row.rollback_safe
          ? null
          : `${e.name}: ${row.rollback_reasons ?? "not rollback-safe"}`;
      })
      .filter(Boolean);
    const effects = describeEffects(
      summarizeEffects(release.contract.sql, { folder: release.name }),
    );
    if (!done.length) {
      if (!migrations)
        throw new Error(
          `recording ${release.name} needs the image's migrations for its rollback analysis; nothing was changed`,
        );
      const safety = rollbackSafetyOf(migrations, release.name);
      if (!safety.safe)
        reasons.push(
          safety.reasons.length ? safety.reasons.join("; ") : `${release.name}: not rollback-safe`,
        );
      await client.query(
        `INSERT INTO ${s}."_knowledge_base_migration"
           (name, rollback_safe, rollback_reasons, contract_checksum, contract_effects, contract_note)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (name) DO NOTHING`,
        [
          release.name,
          reasons.length === 0,
          reasons.length ? reasons.join("; ") : null,
          release.contract.checksum,
          effects,
          `reconciled from ${replaced.join(", ")}`,
        ],
      );
    } else {
      outcome = done.length === withContract.length ? "all" : "some";
      await client.query(
        `ALTER TABLE ${s}."_knowledge_base_migration" ADD COLUMN IF NOT EXISTS contract_done_parts text[]`,
      );
      reasons.push(
        `the scheduled deletions of ${done.map((e) => e.name).join(", ")} already ran, so the data an older release needs is gone`,
      );
      const appliedAt = done
        .map((e) => byName.get(e.name).contract_applied_at)
        .sort((a, b) => new Date(a).getTime() - new Date(b).getTime())
        .at(-1);
      const backups = [
        ...new Set(done.map((e) => byName.get(e.name).contract_backup).filter(Boolean)),
      ];
      await client.query(
        `INSERT INTO ${s}."_knowledge_base_migration"
           (name, rollback_safe, rollback_reasons, contract_checksum, contract_effects,
            contract_applied_at, contract_backup, contract_done_parts, contract_note)
         VALUES ($1, false, $2, $3, $4, $5, $6, $7::text[], $8)
         ON CONFLICT (name) DO NOTHING`,
        [
          release.name,
          reasons.join("; "),
          release.contract.checksum,
          effects,
          outcome === "all" ? appliedAt : null,
          backups.length ? backups.join(", ") : null,
          done.map((e) => e.name),
          `reconciled from ${replaced.join(", ")}`,
        ],
      );
    }
  }
  await client.query(`DELETE FROM ${s}."_knowledge_base_migration" WHERE name = ANY($1::text[])`, [
    replaced,
  ]);
  return outcome;
}
