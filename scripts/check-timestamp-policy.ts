/**
 * Timestamp-instant gate.
 *
 *   pnpm policy:timestamps              (self-test, then scan)
 *   node scripts/check-timestamp-policy.ts --self-test
 *
 * Every stored time is an instant. A `timestamp` without time zone makes the
 * raw `pg` driver read and write it in the Node process TZ and makes SQL
 * comparisons against `now()` depend on the session TimeZone, so a server
 * outside UTC silently shifts grace windows, bans and TTLs. This gate fails on:
 *
 * 1. a Prisma `DateTime` field without `@db.Timestamptz(...)`;
 * 2. a `timestamp` column type without time zone (or `localtimestamp`) in the
 *    committed migration SQL (`packages/db/prisma/migrations/**.sql`) or in an inline
 *    `CREATE TABLE ( … )` in source (the runner/control DDL
 *    lives in `scripts/db/lib/contracts.mjs` and `scripts/restore-archive.mjs`);
 * 3. a session-TimeZone-dependent construct in raw SQL source outside tests:
 *    a `::timestamp` / `CAST(… AS timestamp)` cast, `AT TIME ZONE`,
 *    `timestamp without time zone`, `localtimestamp`, a `SET [LOCAL] TIME ZONE`
 *    or `set_config('TimeZone', …)` that would mask one; a `::date` /
 *    `CAST(… AS date)` cast, `current_date`/`current_time`, `date_trunc(…)`,
 *    a date-formatting `to_char(…)`, a `make_interval(…)` or a variable-length
 *    (`day`/`week`/`month`/`quarter`/`year`) interval, which all resolve
 *    through the session TimeZone; an offset-less date/time string literal
 *    (not an instant) or an `ADD COLUMN … timestamp` / `SET DATA TYPE timestamp`
 *    that would reintroduce a naive column;
 * 4. a `new PrismaPg(` outside `packages/db/src/prisma-adapter.ts`, the only
 *    place that pins the Prisma session TimeZone to UTC (the adapter assumes it).
 *
 * The pinned sessions can also be replaced at runtime by an `options` query
 * parameter in `DATABASE_URL` (node-pg merges the parsed connection string over
 * the config object). Both pinning runtimes call `assertNoSessionOptionOverride`
 * before connecting: the Prisma factory owns the TypeScript guard and the migration runner
 * uses its mirror in `scripts/lib/session-timezone.mjs`. These guards also reject
 * literal C0 controls that URL parsing removes before reading query keys. They are
 * startup assertions, not a source scan.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import process from "node:process";

const ROOT = resolve(import.meta.dirname!, "..");
const SCHEMA_DIR = "packages/db/prisma/schema";
const SQL_DIR = "packages/db/prisma/migrations";
const ADAPTER_FACTORY = "packages/db/src/prisma-adapter.ts";
const SOURCE_ROOTS = ["packages", "apps", "scripts"];
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "dev-dist",
  "generated",
  ".turbo",
  "coverage",
  "target",
  ".git",
]);
const SELF = "scripts/check-timestamp-policy.ts";

export type Violation = { file: string; line: number; rule: string; text: string };

function lines(text: string): string[] {
  return text.split(/\r?\n/);
}

const PRISMA_NEXT_FIELD = /\s[A-Za-z_]\w*\s+[A-Za-z]/;

/** Rule 1: every Prisma `DateTime` field carries `@db.Timestamptz(...)`. */
export function checkPrismaSchema(file: string, text: string): Violation[] {
  const out: Violation[] = [];
  lines(text).forEach((raw, index) => {
    const code = raw.replace(/\/\/.*$/, "");
    // A field's type and its attributes share a line; `prisma format` also
    // permits a single-line model body. Scan each `DateTime` field up to the
    // start of the next field so one field's `@db.Timestamptz` cannot excuse
    // the next field's absence of one.
    for (const match of code.matchAll(/\b[A-Za-z_]\w*\s+DateTime(\?|\[\])?/g)) {
      const rest = code.slice(match.index + match[0].length);
      const next = PRISMA_NEXT_FIELD.exec(rest);
      const segment = next ? rest.slice(0, next.index) : rest;
      if (/@db\.Timestamptz\(\s*\d*\s*\)/.test(segment)) continue;
      out.push({
        file,
        line: index + 1,
        rule: "Prisma DateTime without @db.Timestamptz(3)",
        text: raw.trim(),
      });
    }
  });
  return out;
}

function stripSqlComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/--[^\n]*/g, "");
}

const SQL_NAIVE_TIMESTAMP =
  /\btimestamp\b(?:\s*\(\s*\d+\s*\))?(?!\s*(?:\(\s*\d+\s*\)\s*)?(?:tz\b|with\s+time\s+zone\b))|\btimestamp\s+without\s+time\s+zone\b|\blocaltimestamp\b/i;

/**
 * Bodies of inline `CREATE TABLE ( … )` statements in source, so the SQL-owned
 * runner/control catalog is scanned by the same column rule as the SQL files.
 */
function createTableBodies(text: string): Array<{ body: string; index: number }> {
  const bodies: Array<{ body: string; index: number }> = [];
  for (const match of text.matchAll(/\bCREATE\s+TABLE\b[^(]*\(/gi)) {
    const start = (match.index ?? 0) + match[0].length;
    let depth = 1;
    let index = start;
    while (index < text.length && depth > 0) {
      const char = text[index];
      if (char === "(") depth += 1;
      else if (char === ")") depth -= 1;
      index += 1;
    }
    bodies.push({ body: text.slice(start, depth === 0 ? index - 1 : text.length), index: start });
  }
  return bodies;
}

/** Rule 2: no `timestamp` column type without time zone in the SQL catalog. */
export function checkMigrationSql(file: string, text: string): Violation[] {
  const out: Violation[] = [];
  lines(stripSqlComments(text)).forEach((code, index) => {
    // Quoted strings may legitimately mention the word; types never live there.
    const bare = code.replace(/'(?:[^']|'')*'/g, "''");
    if (SQL_NAIVE_TIMESTAMP.test(bare)) {
      out.push({
        file,
        line: index + 1,
        rule: "timestamp without time zone in SQL catalog",
        text: code.trim(),
      });
    }
  });
  return out;
}

/** Rule 2b: no naive `timestamp` column in an inline `CREATE TABLE` in source. */
export function checkInlineDdl(file: string, text: string): Violation[] {
  const out: Violation[] = [];
  for (const { body, index } of createTableBodies(text)) {
    const bare = stripSqlComments(body)
      .replace(/\/\/[^\n]*/g, "")
      .replace(/'(?:[^']|'')*'/g, "''");
    if (!SQL_NAIVE_TIMESTAMP.test(bare)) continue;
    out.push({
      file,
      line: text.slice(0, index).split(/\r?\n/).length,
      rule: "timestamp without time zone in an inline CREATE TABLE",
      text: bare.replace(/\s+/g, " ").trim().slice(0, 160),
    });
  }
  return out;
}

const SOURCE_SESSION_DEPENDENT =
  /::\s*timestamp\b(?!tz)|\bAS\s+timestamp\b(?!tz)|\bAT\s+TIME\s+ZONE\b|\btimestamp\s+without\s+time\s+zone\b|\blocaltimestamp\b|\bSET\s+(?:LOCAL\s+|SESSION\s+)?(?:TIME\s+ZONE|TimeZone)\b|\bset_config\s*\(\s*'TimeZone'/i;

/**
 * Constructs that resolve a time through the session `TimeZone` without naming
 * `timestamp`: a `::date`/`AS date` cast, `current_date`/`current_time`,
 * `date_trunc(…)` and a date-formatting `to_char(…)` truncate or render in the
 * session zone, and a variable-length interval (`day` … `year`) adds calendar
 * days that a DST transition makes non-constant.
 */
const SOURCE_SESSION_ZONE_FUNCTION =
  /::\s*date\b|\bcurrent_date\b|\bcurrent_time\b|\bdate_trunc\s*\(|\bto_char\s*\([^)\n]*'[^']*(?:YYYY|YY|HH24|HH12|HH|Mon|Month|Day|IW|Q)[^']*'|\bmake_interval\s*\(|\binterval\s*'[^']*\b(?:day|week|month|quarter|year)s?\b/i;

/**
 * The SQL `AS date` cast, requiring a lowercase `date` so TypeScript's `as Date`
 * is not flagged. `::date` needs no such care (`::` is not TS syntax) and is in
 * the pattern above.
 */
const SOURCE_SQL_AS_DATE_CAST = /\b[Aa][Ss]\s+date\b/;

/** An offset-less date+time literal is a wall clock in SQL and in `Date.parse`. */
const SOURCE_NAIVE_DATETIME_LITERAL = /'\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?'/;

/**
 * A date-only literal is an instant in JS (`Date.parse` reads it as UTC) but a
 * wall clock in SQL, where it resolves through the session `TimeZone`. Only the
 * SQL reading is a defect, so this is checked inside SQL fragments.
 */
const SOURCE_NAIVE_DATE_LITERAL = /'\d{4}-\d{2}-\d{2}'/;
const SQL_STATEMENT =
  /\b(?:SELECT|INSERT|UPDATE|DELETE|WHERE|VALUES|FROM|JOIN|AND|OR|SET|ON\s+CONFLICT)\b/i;

/**
 * String and template-literal bodies that contain a SQL statement keyword —
 * the regions where an offset-less literal is read by PostgreSQL. Scanning the
 * literal body (not the source line) keeps a multi-line SQL template in scope
 * and keeps a JS `new Date("2025-01-01")` out of it.
 */
function sqlFragments(text: string): Array<{ body: string; index: number }> {
  const out: Array<{ body: string; index: number }> = [];
  for (const match of text.matchAll(/`(?:[^`\\]|\\.)*`|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g)) {
    const body = match[0].slice(1, -1);
    if (SQL_STATEMENT.test(body)) out.push({ body, index: match.index ?? 0 });
  }
  return out;
}

/** A `timestamp` column reintroduced by DDL in source, not just by the schema. */
const SOURCE_NAIVE_COLUMN =
  /\bADD\s+(?:COLUMN\s+)?[A-Za-z_]\w*\s+timestamp\b(?!\s*(?:\(\s*\d+\s*\)\s*)?(?:tz\b|with\s+time\s+zone\b))|\bSET\s+DATA\s+TYPE\s+timestamp\b(?!\s*(?:\(\s*\d+\s*\)\s*)?(?:tz\b|with\s+time\s+zone\b))/i;

/** Rule 3: raw SQL in source never converts through the session TimeZone. */
export function checkSource(file: string, text: string): Violation[] {
  const out: Violation[] = [];
  lines(text).forEach((raw, index) => {
    const rules: string[] = [];
    if (SOURCE_SESSION_DEPENDENT.test(raw))
      rules.push(
        "session-TimeZone-dependent SQL (::timestamp, CAST … AS timestamp, AT TIME ZONE, localtimestamp, SET TIME ZONE, set_config TimeZone)",
      );
    if (SOURCE_SESSION_ZONE_FUNCTION.test(raw) || SOURCE_SQL_AS_DATE_CAST.test(raw))
      rules.push(
        "session-TimeZone-dependent time expression (::date, AS date, current_date/current_time, date_trunc, to_char, variable-length interval)",
      );
    if (SOURCE_NAIVE_DATETIME_LITERAL.test(raw))
      rules.push("offset-less date/time string literal (not an instant)");
    if (SOURCE_NAIVE_COLUMN.test(raw))
      rules.push("timestamp without time zone column added in source DDL");
    if (rules.length === 0) return;
    out.push({
      file,
      line: index + 1,
      rule: rules.join("; "),
      text: raw.trim(),
    });
  });
  // A date-only literal is instant-correct in JS and session-dependent in SQL,
  // so it is flagged only when it sits inside a SQL string/template fragment.
  for (const { body, index } of sqlFragments(text)) {
    if (!SOURCE_NAIVE_DATE_LITERAL.test(body)) continue;
    out.push({
      file,
      line: text.slice(0, index).split(/\r?\n/).length,
      rule: "offset-less date literal in SQL (resolves in the session TimeZone)",
      text: body.replace(/\s+/g, " ").trim().slice(0, 160),
    });
  }
  return out;
}

/** Rule 4: only the adapter factory constructs `PrismaPg`. */
export function checkPrismaAdapter(file: string, text: string): Violation[] {
  if (file === ADAPTER_FACTORY) return [];
  const out: Violation[] = [];
  lines(text).forEach((raw, index) => {
    if (/\bnew\s+PrismaPg\s*\(/.test(raw)) {
      out.push({
        file,
        line: index + 1,
        rule: `new PrismaPg outside ${ADAPTER_FACTORY} (use createPrismaPgAdapter)`,
        text: raw.trim(),
      });
    }
  });
  return out;
}

function isTestFile(file: string): boolean {
  return /\.test\.(ts|tsx|mjs|js)$/.test(file) || /(^|\/)(fixtures|__tests__)\//.test(file);
}

function walk(dir: string, accept: (rel: string) => boolean, files: string[] = []): string[] {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, accept, files);
    else if (entry.isFile()) {
      const rel = relative(ROOT, path).split(sep).join("/");
      if (accept(rel)) files.push(rel);
    }
  }
  return files;
}

export function scan(): Violation[] {
  const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");
  const violations: Violation[] = [];
  const schemaFiles = walk(resolve(ROOT, SCHEMA_DIR), (rel) => rel.endsWith(".prisma"));
  if (schemaFiles.length === 0) throw new Error(`No Prisma schema files under ${SCHEMA_DIR}`);
  for (const file of schemaFiles) violations.push(...checkPrismaSchema(file, read(file)));
  const sqlFiles = walk(resolve(ROOT, SQL_DIR), (rel) => rel.endsWith(".sql"));
  if (sqlFiles.length === 0) throw new Error(`No migration SQL files under ${SQL_DIR}`);
  for (const file of sqlFiles) violations.push(...checkMigrationSql(file, read(file)));
  const sourceFiles = SOURCE_ROOTS.flatMap((root) =>
    walk(
      resolve(ROOT, root),
      (rel) => /\.(ts|tsx|mjs|js|cjs)$/.test(rel) && !rel.endsWith(".d.ts"),
    ),
  );
  for (const file of sourceFiles) {
    if (file === SELF) continue;
    const text = read(file);
    violations.push(...checkPrismaAdapter(file, text));
    if (isTestFile(file)) continue;
    violations.push(...checkSource(file, text));
    violations.push(...checkInlineDdl(file, text));
  }
  return violations;
}

export function selfTest(): void {
  const cases: Array<[string, Violation[], number]> = [
    ["prisma naive", checkPrismaSchema("a.prisma", "  createdAt DateTime @default(now())"), 1],
    ["prisma optional naive", checkPrismaSchema("a.prisma", "  at DateTime? // note"), 1],
    [
      "prisma explicit timestamp",
      checkPrismaSchema("a.prisma", "  at DateTime @db.Timestamp(3)"),
      1,
    ],
    [
      "prisma commented tz does not count",
      checkPrismaSchema("a.prisma", "  at DateTime // @db.Timestamptz(3)"),
      1,
    ],
    [
      "prisma tz",
      checkPrismaSchema("a.prisma", "  at DateTime? @default(now()) @db.Timestamptz(3)"),
      0,
    ],
    ["prisma other type", checkPrismaSchema("a.prisma", "  name String // DateTime"), 0],
    [
      "prisma single-line model, naive field",
      checkPrismaSchema("a.prisma", "model X { createdAt DateTime name String }"),
      1,
    ],
    [
      "prisma single-line model, both timestamped",
      checkPrismaSchema(
        "a.prisma",
        "model X { createdAt DateTime @db.Timestamptz(3) at DateTime? @db.Timestamptz(3) }",
      ),
      0,
    ],
    ["sql naive column", checkMigrationSql("a.sql", "  at timestamp NOT NULL,"), 1],
    ["sql naive precision", checkMigrationSql("a.sql", "  at TIMESTAMP(3),"), 1],
    ["sql without tz", checkMigrationSql("a.sql", "  at timestamp without time zone,"), 1],
    ["sql localtimestamp", checkMigrationSql("a.sql", "  DEFAULT localtimestamp"), 1],
    ["sql timestamptz", checkMigrationSql("a.sql", "  at timestamptz(3) NOT NULL,"), 0],
    ["sql with tz", checkMigrationSql("a.sql", "  at timestamp(3) with time zone,"), 0],
    ["sql clock_timestamp", checkMigrationSql("a.sql", "  AND x > clock_timestamp()"), 0],
    ["sql comment", checkMigrationSql("a.sql", "-- a timestamp column\n/* timestamp */"), 0],
    ["source cast", checkSource("a.ts", "`SELECT $1::timestamp`"), 1],
    ["source cast function", checkSource("a.ts", "`SELECT CAST($1 AS timestamp)`"), 1],
    ["source cast function tz", checkSource("a.ts", "`SELECT CAST($1 AS timestamptz)`"), 0],
    ["source at time zone", checkSource("a.ts", "`SELECT x AT TIME ZONE 'UTC'`"), 1],
    ["source timestamptz cast", checkSource("a.ts", "`SELECT $1::timestamptz`"), 0],
    ["source set local time zone", checkSource("a.ts", `q("SET LOCAL TIME ZONE 'UTC'")`), 1],
    ["source set timezone", checkSource("a.ts", `q("SET TimeZone TO 'UTC'")`), 1],
    [
      "source set_config timezone",
      checkSource("a.ts", `q("SELECT set_config('TimeZone','UTC',true)")`),
      1,
    ],
    [
      "source set_config other",
      checkSource("a.ts", `q("SELECT set_config('search_path','public',true)")`),
      0,
    ],
    ["adapter elsewhere", checkPrismaAdapter("x.ts", "const a = new PrismaPg({})"), 1],
    ["adapter factory", checkPrismaAdapter(ADAPTER_FACTORY, "return new PrismaPg({})"), 0],
    [
      "inline ddl naive column",
      checkInlineDdl(
        "a.mjs",
        "const ddl = `\nCREATE TABLE IF NOT EXISTS t (\n  at timestamp NOT NULL\n);`;",
      ),
      1,
    ],
    [
      "inline ddl timestamptz column",
      checkInlineDdl(
        "a.mjs",
        "const ddl = `\nCREATE TABLE IF NOT EXISTS t (\n  at timestamptz NOT NULL\n);`;",
      ),
      0,
    ],
    [
      "inline ddl without time zone",
      checkInlineDdl("a.mjs", "q(`CREATE TABLE t (at timestamp without time zone);`)"),
      1,
    ],
    [
      "inline ddl localtimestamp default",
      checkInlineDdl("a.mjs", "q(`CREATE TABLE t (at timestamp(3) DEFAULT localtimestamp);`)"),
      1,
    ],
    [
      "inline ddl comment mention",
      checkInlineDdl(
        "a.mjs",
        "q(`CREATE TABLE t (\n  -- a timestamp column\n  at timestamptz\n);`)",
      ),
      0,
    ],
    ["inline ddl no create", checkInlineDdl("a.mjs", "// a timestamp column\nconst x = 1;"), 0],
    ["source cast date", checkSource("a.ts", "`SELECT $1::date`"), 1],
    ["source cast date function", checkSource("a.ts", "`SELECT CAST($1 AS date)`"), 1],
    [
      "source typescript as Date is not a sql cast",
      checkSource("a.ts", "const at = value as Date;"),
      0,
    ],
    ["source date_trunc", checkSource("a.ts", "`SELECT date_trunc('day', x)`"), 1],
    ["source to_char", checkSource("a.ts", "`SELECT to_char(x, 'YYYY-MM-DD')`"), 1],
    ["source current_date", checkSource("a.ts", "`SELECT current_date`"), 1],
    ["source current_time", checkSource("a.ts", "`SELECT current_time`"), 1],
    ["source day interval", checkSource("a.ts", "`WHERE x > now() - interval '30 days'`"), 1],
    [
      "source make_interval",
      checkSource("a.ts", "`WHERE x > now() - make_interval(days => 30)`"),
      1,
    ],
    ["source hour interval", checkSource("a.ts", "`WHERE x > now() - interval '1 hour'`"), 0],
    [
      "source millisecond interval",
      checkSource("a.ts", "`now() + ($1 * interval '1 millisecond')`"),
      0,
    ],
    ["source naive datetime literal", checkSource("a.ts", "`WHERE x > '2026-01-01 12:00:00'`"), 1],
    ["source naive date literal in sql", checkSource("a.ts", "`WHERE x > '2026-01-01'`"), 1],
    [
      "source naive date literal in multiline sql",
      checkSource("a.ts", "q(`SELECT 1\n  FROM t\n  WHERE x > '2026-01-01'`)"),
      1,
    ],
    [
      "source naive date literal in js",
      checkSource("a.ts", `const at = new Date("2026-01-01");`),
      0,
    ],
    [
      "source date literal in a plain string",
      checkSource("a.ts", `const label = "2026-01-01";`),
      0,
    ],
    ["source zulu literal", checkSource("a.ts", "`WHERE x > '2026-01-01T12:00:00Z'`"), 0],
    ["source offset literal", checkSource("a.ts", "`WHERE x > '2026-01-01 12:00:00+00'`"), 0],
    ["source add naive column", checkSource("a.ts", "`ALTER TABLE t ADD COLUMN at timestamp`"), 1],
    ["source add tz column", checkSource("a.ts", "`ALTER TABLE t ADD COLUMN at timestamptz`"), 0],
    ["source to_char name", checkSource("a.ts", "`SELECT to_char($1)`"), 0],
  ];
  const failed = cases.filter(([, got, want]) => got.length !== want);
  for (const [name, got, want] of failed) {
    console.error(`self-test FAILED: ${name}: expected ${want} violation(s), got ${got.length}`);
  }
  if (failed.length > 0) process.exit(1);
  console.log(`timestamp-policy self-test: ${cases.length} cases passed`);
}

function main(argv: string[]): void {
  selfTest();
  if (argv.includes("--self-test")) return;
  const violations = scan();
  if (violations.length === 0) {
    console.log("timestamp-policy: every stored time is timestamptz; no session-TZ SQL.");
    return;
  }
  for (const v of violations) console.error(`${v.file}:${v.line}: ${v.rule}\n    ${v.text}`);
  console.error(
    `POLICY VIOLATION: ${violations.length} timestamp-policy finding(s). Use @db.Timestamptz(3) / timestamptz and instant-safe SQL.`,
  );
  process.exit(1);
}

main(process.argv.slice(2));
