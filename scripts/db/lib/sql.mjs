/**
 * PostgreSQL lexer + migration analyzer for committed Prisma Migrate SQL.
 *
 * Shared by the generator (`pnpm db:migrate`), the CI checks
 * (`pnpm db:check-migrations`), and the container migration runner
 * (`scripts/db/migrate-runtime.mjs`), so all three agree on what a statement,
 * a transaction wrapper, and a destructive change are.
 *
 * Lexical rules (standard_conforming_strings=on): '-- line' and nested
 * '/* block *\/' comments, "quoted identifiers", 'strings' (with E'' backslash
 * escapes and newline-joined fragments), and $tag$ dollar-quoted bodies.
 * Dollar-quoted bodies and U&'' / U&"" forms are lexed (so statement
 * boundaries stay correct) but the statements that hold them are reported as
 * "not analyzed" rather than silently passed.
 *
 * Plain Node, no dependencies: it runs inside the production image.
 */
import { createHash } from "node:crypto";

/** Exact marker strings. Keep in sync with docs/schema-migrations.md. */
export const TRANSACTIONAL_MARKER = "-- knowledge-base:transactional";
/**
 * Retired: there is no maintenance deploy any more. Kept only so CI and the
 * deploy runner can refuse a file that still carries it (anywhere in the
 * file). In-place breaking changes go through expand/contract instead
 * (docs/schema-changes-recipe.md).
 */
export const RETIRED_MAINTENANCE_MARKER = "-- requires: maintenance-deploy";
export const INTENTIONAL_MARKER = "-- intentional: drop and recreate";
/** Appended to every primary-key refusal: there is no in-place path. */
const PK_CHANGE_RECIPE =
  "Use a new table instead: add it, write to both and backfill, switch reads, then drop the old one via contract.sql (docs/schema-changes-recipe.md § Other changes).";
/**
 * Value the wrapper writes into this attempt's `_prisma_migrations.logs`
 * as its LAST statement inside the transaction. It is durable only if the
 * transaction committed, so after a crash it proves which side of COMMIT the
 * attempt died on: present → committed (mark applied, never re-run); absent →
 * PostgreSQL rolled the whole file back (safe to retry). Prisma writes `logs`
 * only on an observed failure, which cannot follow a successful COMMIT.
 */
export const COMMIT_SENTINEL = "knowledge-base:committed";
// Two fixed DO blocks, recognized by exact text (any edit makes the wrapper
// "broken"). The first runs BEFORE the body and records which relation is
// Prisma's history table (by OID, resolved with the connection's own
// search_path), in a transaction-local setting. The marker updates exactly
// that relation, so nothing the body does to search_path can redirect it.
// Both are no-ops where no history table exists (Prisma's shadow database and
// `migrate diff` replay migrations without one).
export const HISTORY_CAPTURE_STATEMENT = `DO $knowledge_base$ BEGIN PERFORM set_config('knowledge_base.history', coalesce(to_regclass('_prisma_migrations')::oid::text, ''), true); END $knowledge_base$;`;
export const COMMIT_MARKER_STATEMENT = `DO $knowledge_base$ DECLARE history text := current_setting('knowledge_base.history', true); BEGIN IF history <> '' THEN EXECUTE format('UPDATE %s SET "logs" = %L WHERE "id" = (SELECT "id" FROM %s WHERE "finished_at" IS NULL AND "rolled_back_at" IS NULL ORDER BY "started_at" DESC LIMIT 1)', history::oid::regclass, '${COMMIT_SENTINEL}', history::oid::regclass); END IF; END $knowledge_base$;`;
const COMMIT_MARKER_COMMENT =
  "-- knowledge-base:commit-marker (lets the runner prove this transaction committed; keep it last)";
const WRAPPER_PREAMBLE = [
  "BEGIN;",
  "SET LOCAL lock_timeout = '5s';",
  "SET LOCAL statement_timeout = '60s';",
  "-- knowledge-base:history-capture (records the history table for the commit marker; keep it here)",
  HISTORY_CAPTURE_STATEMENT,
];

class SqlLexError extends Error {}

/**
 * Split SQL into statements.
 * @param {string} sql
 * @returns {Array<{ tokens: string[], positions: number[], ends: number[], start: number,
 *   end: number, line: number, comments: string[], opaque: boolean, text: string }>}
 *   `positions`/`ends` are each token's [start, end) offsets in `sql` (a
 *   string literal's span covers all of its newline-joined fragments).
 *   `comments` are the line comments between the previous statement and this
 *   one (the "comment immediately above"); `opaque` marks dollar-quoted or
 *   Unicode-escape content the analyzer cannot see through.
 */
export function splitStatements(sql) {
  if (sql.includes("\0")) throw new SqlLexError("NUL byte in SQL");
  const out = [];
  let offset = 0;
  let tokens = [];
  let positions = [];
  let ends = [];
  let start;
  let opaque = false;
  let pendingComments = [];
  let comments = [];
  const fail = (what) => {
    const line = sql.slice(0, offset).split("\n").length;
    throw new SqlLexError(`${what} at line ${line}`);
  };
  const trivia = () => {
    const from = offset;
    while (offset < sql.length) {
      const ch = sql[offset];
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v") {
        offset++;
      } else if (sql.startsWith("--", offset)) {
        const eol = sql.slice(offset).search(/[\r\n]/);
        const endAt = eol < 0 ? sql.length : offset + eol;
        if (start === undefined) pendingComments.push(sql.slice(offset, endAt).trim());
        offset = endAt;
      } else if (sql.startsWith("/*", offset)) {
        offset += 2;
        let depth = 1;
        while (depth && offset < sql.length) {
          if (sql.startsWith("/*", offset)) {
            depth++;
            offset += 2;
          } else if (sql.startsWith("*/", offset)) {
            depth--;
            offset += 2;
          } else offset++;
        }
        if (depth) fail("Unterminated block comment");
      } else break;
    }
    return /[\r\n]/.test(sql.slice(from, offset));
  };
  const quoted = (quote, escapes) => {
    offset++;
    while (offset < sql.length) {
      const ch = sql[offset++];
      if (escapes && ch === "\\") {
        if (offset >= sql.length) break;
        offset++;
      } else if (ch === quote) {
        if (sql[offset] === quote) offset++;
        else return;
      }
    }
    fail(`Unterminated ${quote === '"' ? "quoted identifier" : "string literal"}`);
  };
  while (offset < sql.length) {
    trivia();
    if (offset >= sql.length) break;
    if (start === undefined) {
      start = offset;
      comments = pendingComments;
      pendingComments = [];
    }
    const rest = sql.slice(offset, offset + 256);
    const tokenStart = offset;
    let value;
    const dollar = /^\$([A-Za-z_\u0080-￿][\w\u0080-￿]*)?\$/.exec(rest);
    if (dollar) {
      const tag = dollar[0];
      const close = sql.indexOf(tag, offset + tag.length);
      if (close < 0) fail("Unterminated dollar-quoted string");
      offset = close + tag.length;
      value = "<dollar>";
      opaque = true;
    } else if (/^U&["']/i.test(rest)) {
      offset += 2;
      const q = sql[offset];
      quoted(q, false);
      value = q === '"' ? '"<unicode>"' : "<literal>";
      opaque = true;
    } else if (sql[offset] === '"') {
      const from = offset;
      quoted('"', false);
      value = sql.slice(from, offset);
    } else if (/^[eEbBxXnN]'/.test(rest) || sql[offset] === "'") {
      const escapes = /^[eE]'/.test(rest);
      if (sql[offset] !== "'") offset++;
      quoted("'", escapes);
      // Newline-separated string fragments are one literal in PostgreSQL.
      while (trivia() && sql[offset] === "'") quoted("'", escapes);
      value = "<literal>";
    } else if (/^\d/.test(rest)) {
      value = /^\d+(?:\.\d*)?(?:[eE][+-]?\d+)?/.exec(rest)[0];
      offset += value.length;
    } else {
      const word = /^[A-Za-z_\u0080-￿][\w$\u0080-￿]*/.exec(rest)?.[0];
      value = word || sql[offset];
      offset += value.length;
    }
    if (value === ";") {
      if (tokens.length) push();
      else start = undefined;
      continue;
    }
    tokens.push(value);
    positions.push(tokenStart);
    ends.push(offset);
  }
  if (tokens.length) push();
  return out;

  function push() {
    const end = offset;
    out.push({
      tokens,
      positions,
      ends,
      start,
      end,
      line: sql.slice(0, start).split("\n").length,
      comments,
      opaque,
      text: sql.slice(start, end),
    });
    tokens = [];
    positions = [];
    ends = [];
    start = undefined;
    opaque = false;
    comments = [];
  }
}

const kw = (value) => (value && !value.startsWith('"') ? value.toUpperCase() : "");
/** Unquote/fold an identifier token the way PostgreSQL does. */
const ident = (value) =>
  value?.startsWith('"') ? value.slice(1, -1).replaceAll('""', '"') : value?.toLowerCase();

const isIdentToken = (value) =>
  typeof value === "string" && (value.startsWith('"') || /^[A-Za-z_\u0080-￿]/.test(value));

/** Parse `[schema.]name` at `index`; returns { name, schema, next } or null. */
function qualifiedName(tokens, index) {
  if (!isIdentToken(tokens[index])) return null;
  if (tokens[index + 1] === "." && isIdentToken(tokens[index + 2])) {
    return { schema: ident(tokens[index]), name: ident(tokens[index + 2]), next: index + 3 };
  }
  return { schema: "public", name: ident(tokens[index]), next: index + 1 };
}

/** Split a token list on top-level commas (paren depth 0). */
function splitTopLevel(tokens) {
  return splitTopLevelRanges(tokens, 0, tokens.length).map(([from, to]) => tokens.slice(from, to));
}

/** Like splitTopLevel over tokens[from, to), returning [start, end) index ranges. */
function splitTopLevelRanges(tokens, from, to) {
  const ranges = [];
  let depth = 0;
  let begin = from;
  for (let index = from; index < to; index++) {
    const token = tokens[index];
    if (token === "(" || token === "[") depth++;
    if (token === ")" || token === "]") depth--;
    if (token === "," && depth === 0) {
      if (index > begin) ranges.push([begin, index]);
      begin = index + 1;
    }
  }
  if (to > begin) ranges.push([begin, to]);
  return ranges;
}

const TX_CONTROL = new Set([
  "BEGIN",
  "COMMIT",
  "END",
  "ROLLBACK",
  "ABORT",
  "START",
  "SAVEPOINT",
  "RELEASE",
]);
const NON_TRANSACTIONAL = ["CONCURRENTLY", "VACUUM"];

export function markers(sql) {
  const firstLine = sql.replace(/^﻿/, "").split(/\r?\n/, 1)[0].trim();
  return {
    transactional: firstLine === TRANSACTIONAL_MARKER,
    retiredMaintenance: sql.includes(RETIRED_MAINTENANCE_MARKER),
  };
}

/**
 * Does this file carry the generator's transaction wrapper, unmodified in
 * shape? (marker on line 1, BEGIN first, COMMIT last, no other transaction
 * control or non-transactional statement in between). This is the gate for
 * runtime auto-recovery: only then did PostgreSQL roll the whole file back.
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function checkWrapper(sql) {
  if (!markers(sql).transactional)
    return { ok: false, reason: `line 1 is not "${TRANSACTIONAL_MARKER}"` };
  let parsed;
  try {
    parsed = splitStatements(sql);
  } catch (error) {
    return { ok: false, reason: `SQL could not be lexed (${error.message})` };
  }
  if (parsed.length < 2) return { ok: false, reason: "no BEGIN/COMMIT pair" };
  const first = parsed[0];
  const last = parsed.at(-1);
  if (first.tokens.length !== 1 || kw(first.tokens[0]) !== "BEGIN") {
    return { ok: false, reason: `first statement (line ${first.line}) is not BEGIN` };
  }
  if (last.tokens.length !== 1 || kw(last.tokens[0]) !== "COMMIT") {
    return { ok: false, reason: `last statement (line ${last.line}) is not COMMIT` };
  }
  if (
    sql
      .slice(last.end)
      .replace(/--[^\n]*/g, "")
      .trim()
  ) {
    return { ok: false, reason: "content after the final COMMIT" };
  }
  const sentinel = parsed.at(-2);
  if (parsed.length < 6 || !isCommitMarker(sentinel)) {
    return {
      ok: false,
      reason: "the statement before COMMIT is not the generator's commit marker",
    };
  }
  const preamble = WRAPPER_PREAMBLE.filter((line) => !line.startsWith("--")).slice(1);
  for (const [offset, expected] of preamble.entries()) {
    const statement = parsed[offset + 1];
    if (normalizeSql(statement.text ?? "") !== normalizeSql(expected)) {
      return {
        ok: false,
        reason: `statement at line ${statement.line} is not the generator's preamble (${expected.slice(0, 40)}…)`,
      };
    }
  }
  for (const statement of parsed.slice(1 + preamble.length, -2)) {
    const words = statement.tokens.map(kw);
    if (TX_CONTROL.has(words[0]) || (words[0] === "PREPARE" && words[1] === "TRANSACTION")) {
      return { ok: false, reason: `transaction control ${words[0]} at line ${statement.line}` };
    }
    // The marker depends on the transaction-local setting the preamble wrote.
    if (
      words[0] === "RESET" ||
      /knowledge_base\.history/i.test(statement.text ?? "") ||
      (words[0] === "DISCARD" && words[1] === "ALL")
    )
      return {
        ok: false,
        reason: `line ${statement.line} resets settings the commit marker relies on`,
      };
    const bad = NON_TRANSACTIONAL.find((word) => words.includes(word));
    if (bad)
      return { ok: false, reason: `${bad} at line ${statement.line} cannot run in a transaction` };
  }
  return { ok: true };
}

const normalizeSql = (text) =>
  text
    .replace(/\s+/g, " ")
    .replace(/\s*;\s*$/, "")
    .trim();
const COMMIT_MARKER_NORMALIZED = normalizeSql(COMMIT_MARKER_STATEMENT);

/** Is this parsed statement exactly the wrapper's commit marker? */
function isCommitMarker(statement) {
  if (!statement) return false;
  return normalizeSql(statement.text ?? "") === COMMIT_MARKER_NORMALIZED;
}

const CAPTURE_NORMALIZED = normalizeSql(HISTORY_CAPTURE_STATEMENT);
/** The wrapper's own statements (history capture, commit marker). */
function isWrapperStatement(statement) {
  return isCommitMarker(statement) || normalizeSql(statement?.text ?? "") === CAPTURE_NORMALIZED;
}

/** Body without the wrapper statements (BEGIN / COMMIT), comments kept. */
export function unwrapBody(sql) {
  const parsed = splitStatements(sql);
  const first = parsed[0];
  const last = parsed.at(-1);
  return sql.slice(first.end, last.start);
}

/**
 * Track table → columns from CREATE TABLE / ALTER TABLE across migration
 * files, for the "similar table" rename heuristic. Best effort, lexical.
 * @param {string[]} sqlFiles in apply order
 * @returns {Map<string, Set<string>>} key "schema.table"
 */
export function tableColumns(sqlFiles) {
  const tables = new Map();
  for (const sql of sqlFiles) {
    let parsed;
    try {
      parsed = splitStatements(sql);
    } catch {
      continue;
    }
    for (const { tokens } of parsed) applyToTables(tables, tokens);
  }
  return tables;
}

function applyToTables(tables, tokens) {
  const words = tokens.map(kw);
  if (words[0] === "CREATE" && words[1] === "TABLE") {
    let index = 2;
    if (words[2] === "IF" && words[3] === "NOT" && words[4] === "EXISTS") index = 5;
    const name = qualifiedName(tokens, index);
    if (!name || tokens[name.next] !== "(") return;
    // A no-op `IF NOT EXISTS` on a table that already exists changes nothing.
    if (index === 5 && tables.has(`${name.schema}.${name.name}`)) return;
    const body = tokens.slice(name.next + 1, tokens.lastIndexOf(")"));
    const columns = new Set();
    for (const part of splitTopLevel(body)) {
      const head = kw(part[0]);
      if (["CONSTRAINT", "PRIMARY", "UNIQUE", "FOREIGN", "CHECK", "EXCLUDE", "LIKE"].includes(head))
        continue;
      if (isIdentToken(part[0])) columns.add(ident(part[0]));
    }
    tables.set(`${name.schema}.${name.name}`, columns);
    return;
  }
  if (words[0] === "DROP" && words[1] === "TABLE") {
    for (const target of dropTargets(tokens, 2)) tables.delete(target);
    return;
  }
  if (words[0] === "ALTER" && words[1] === "TABLE") {
    const parsed = alterTable(tokens);
    if (!parsed) return;
    const key = parsed.table;
    for (const action of parsed.actions) {
      const columns = tables.get(key);
      if (action.kind === "rename-table") {
        if (columns) {
          tables.delete(key);
          tables.set(`${parsed.schema}.${action.to}`, columns);
        }
      } else if (!columns) {
      } else if (action.kind === "add-column") columns.add(action.column);
      else if (action.kind === "drop-column") columns.delete(action.column);
      else if (action.kind === "rename-column") {
        columns.delete(action.column);
        columns.add(action.to);
      }
    }
  }
}

function dropTargets(tokens, index) {
  const words = tokens.map(kw);
  if (words[index] === "IF" && words[index + 1] === "EXISTS") index += 2;
  const targets = [];
  for (const part of splitTopLevel(tokens.slice(index))) {
    const name = qualifiedName(part, 0);
    if (name) targets.push(`${name.schema}.${name.name}`);
  }
  return targets;
}

/** Parse ALTER TABLE [IF EXISTS] [ONLY] name action[, action...]. */
function alterTable(tokens) {
  const words = tokens.map(kw);
  let index = 2;
  if (words[index] === "IF" && words[index + 1] === "EXISTS") index += 2;
  if (words[index] === "ONLY") index++;
  const name = qualifiedName(tokens, index);
  if (!name) return null;
  const actions = [];
  for (const [from, to] of splitTopLevelRanges(tokens, name.next, tokens.length)) {
    const part = tokens.slice(from, to);
    const w = part.map(kw);
    let i = 0;
    /** Token span [from, to) of this action inside the statement (per-action split). */
    const action = { kind: "other", words: w, from, to, nameFrom: index, nameTo: name.next };
    if (w[0] === "ADD") {
      i = w[1] === "COLUMN" ? 2 : 1;
      if (w[i] === "IF" && w[i + 1] === "NOT" && w[i + 2] === "EXISTS") i += 3;
      if (w[1] === "CONSTRAINT") {
        action.kind = "add-constraint";
        action.constraint = ident(part[2]);
        action.bodyFrom = from + 3;
      } else if (
        ["PRIMARY", "UNIQUE", "FOREIGN", "CHECK", "EXCLUDE", "CONSTRAINT"].includes(w[i])
      ) {
        action.kind = "add-constraint";
        action.bodyFrom = from + i;
      } else if (isIdentToken(part[i])) {
        action.kind = "add-column";
        action.column = ident(part[i]);
        action.type = part.slice(i + 1).join(" ");
        action.defFrom = from + i + 1;
      }
    } else if (w[0] === "DROP") {
      if (w[1] === "CONSTRAINT") {
        i = w[2] === "IF" && w[3] === "EXISTS" ? 4 : 2;
        action.kind = "drop-constraint";
        action.constraint = ident(part[i]);
      } else {
        i = w[1] === "COLUMN" ? 2 : 1;
        if (w[i] === "IF" && w[i + 1] === "EXISTS") i += 2;
        action.kind = "drop-column";
        action.column = ident(part[i]);
      }
    } else if (w[0] === "ALTER") {
      i = w[1] === "COLUMN" ? 2 : 1;
      action.column = ident(part[i]);
      const tail = w.slice(i + 1);
      if (tail[0] === "TYPE" || (tail[0] === "SET" && tail[1] === "DATA" && tail[2] === "TYPE")) {
        action.kind = "alter-type";
        action.type = part.slice(i + 2 + (tail[0] === "SET" ? 2 : 0)).join(" ");
        action.typeFrom = from + i + 2 + (tail[0] === "SET" ? 2 : 0);
      } else if (
        (tail[0] === "SET" || tail[0] === "DROP") &&
        (tail[1] === "DEFAULT" || (tail[1] === "NOT" && tail[2] === "NULL"))
      ) {
        action.kind = "alter-column";
        action.change = `${tail[0].toLowerCase()}-${tail[1] === "DEFAULT" ? "default" : "not-null"}`;
        if (action.change === "set-default") action.exprFrom = from + i + 3;
      } else action.kind = "other";
    } else if (w[0] === "RENAME") {
      if (w[1] === "TO") {
        action.kind = "rename-table";
        action.to = ident(part[2]);
      } else if (w[1] === "CONSTRAINT") {
        action.kind = "rename-constraint";
      } else {
        i = w[1] === "COLUMN" ? 2 : 1;
        action.kind = "rename-column";
        action.column = ident(part[i]);
        action.to = ident(part[i + 2]);
      }
    }
    actions.push(action);
  }
  return { table: `${name.schema}.${name.name}`, schema: name.schema, name: name.name, actions };
}

const display = (key) => {
  const [schema, ...rest] = key.split(".");
  const name = rest.join(".");
  return schema === "public" ? `"${name}"` : `"${schema}"."${name}"`;
};

/**
 * Analyze one migration file.
 * @param {string} sql
 * @param {{ knownTables?: Map<string, Set<string>>, folder?: string,
 *   typeOf?: (table: string, column: string) => ({ type?: NormalizedType, newInRun?: boolean } | undefined) }} [options]
 *   knownTables: columns of tables as they exist BEFORE this migration (for
 *   the similar-table check). folder: this migration's folder name (needed to
 *   verify generated templates, whose object names hash it). typeOf: the
 *   column's type before this migration (§1.6 fold, `typeOfFromCatalog`); an
 *   allowlisted widening or an alter of a column created earlier in the same
 *   run (`newInRun`) is then not `incompatible`.
 */
export function analyzeMigration(sql, options = {}) {
  const result = {
    markers: markers(sql),
    statements: 0,
    /** @type {Array<{ line: number, kind: string, table?: string, column?: string, message: string }>} */
    destructive: [],
    /** Statements old code cannot tolerate (rename / drop / type change). */
    incompatible: [],
    /** Probable accidental renames (check 5). */
    renames: [],
    /**
     * `reviewed` is the `-- knowledge-base:reviewed <reason>` attestation directly
     * above the statement, or null when absent or ignored (§1.9 regex,
     * template entries, lex errors); `reviewIgnored` marks an annotation that
     * was present but ignored.
     * @type {Array<{ line: number, reason: string, reviewed: string | null, reviewIgnored?: boolean, template?: boolean }>}
     */
    notAnalyzed: [],
    /** Recognized generated templates of a known version. */
    templates:
      /** @type {Array<{ kind: string, version: string, line: number, header: object }>} */ ([]),
    concurrently: false,
    lexError: /** @type {string | null} */ (null),
  };
  let parsed;
  try {
    parsed = splitStatements(sql);
  } catch (error) {
    result.lexError = error.message;
    result.notAnalyzed.push({ line: 1, reason: `whole file: ${error.message}`, reviewed: null });
    return result;
  }
  const recognized = recognizeTemplates(sql, parsed, { folder: options.folder, file: "migration" });
  result.templates = recognized.templates;
  const notAnalyzed = (statement, reason, extra = {}) => {
    const entry = { line: statement.line, reason, ...reviewedAnnotation(statement), ...extra };
    if (extra.template) {
      entry.reviewIgnored = entry.reviewIgnored || entry.reviewed !== null;
      entry.reviewed = null;
    }
    result.notAnalyzed.push(entry);
  };
  const known = options.knownTables ?? new Map();
  const createdTables = new Set();
  const createdColumns = new Set();
  const droppedConstraints = [];
  const addedConstraints = new Set();
  const droppedColumns = [];
  const addedColumns = [];
  const droppedTables = [];
  const created = [];
  const createdTypes = new Set();
  for (const [index, statement] of parsed.entries()) {
    const { tokens, line, comments } = statement;
    const words = tokens.map(kw);
    const intentional = comments.includes(INTENTIONAL_MARKER);
    result.statements++;
    if (words.includes("CONCURRENTLY")) result.concurrently = true;
    if (isWrapperStatement(statement)) continue;
    // Generated templates of a known version, verified byte for byte.
    if (recognized.covered.has(index)) continue;
    const templateProblem = recognized.problems.get(index);
    if (templateProblem) {
      notAnalyzed(statement, templateProblem, { template: true });
      continue;
    }
    if (statement.opaque || tokens.includes("\\")) {
      notAnalyzed(statement, "dollar-quoted, Unicode-escaped, or psql meta content");
      continue;
    }
    const head = words.slice(0, 2).join(" ");
    if (["DO", "EXECUTE", "CALL", "COPY"].includes(words[0])) {
      notAnalyzed(statement, `${words[0]} statement`);
      continue;
    }
    if (head === "CREATE TABLE") {
      let index = 2;
      if (words[2] === "IF" && words[3] === "NOT" && words[4] === "EXISTS") index = 5;
      const name = qualifiedName(tokens, index);
      // `IF NOT EXISTS` on a table that already exists is a no-op: it must not
      // make later renames/drops of that table look like they touch a new one.
      const tableKey = name ? `${name.schema}.${name.name}` : "";
      const existsNow = known.has(tableKey) && !droppedTables.some((drop) => drop.key === tableKey);
      if (name && !(index === 5 && existsNow)) {
        const key = `${name.schema}.${name.name}`;
        createdTables.add(key);
        const before = new Map();
        applyToTables(before, tokens);
        created.push({ key, columns: before.get(key) ?? new Set(), line, intentional });
      }
    } else if (words[0] === "DROP" && words[1] === "TABLE") {
      for (const key of dropTargets(tokens, 2)) {
        result.destructive.push({
          line,
          kind: "drop-table",
          table: key,
          message: `Deletes the table ${display(key)} and every row in it.`,
        });
        if (!createdTables.has(key))
          result.incompatible.push({ line, what: `drops table ${display(key)}` });
        droppedTables.push({ key, line, intentional });
      }
    } else if (head === "ALTER TABLE") {
      const parsedAlter = alterTable(tokens);
      if (!parsedAlter) {
        notAnalyzed(statement, "unrecognized ALTER TABLE target");
        continue;
      }
      const table = parsedAlter.table;
      for (const action of parsedAlter.actions) {
        const columnKey = `${table}.${action.column}`;
        const existing = !createdTables.has(table) && !createdColumns.has(columnKey);
        if (action.kind === "add-column") {
          // `ADD COLUMN IF NOT EXISTS` on a column that already exists is a
          // no-op; the column stays "existing" for the rename/drop checks.
          if (!known.get(table)?.has(action.column)) createdColumns.add(columnKey);
          addedColumns.push({ table, column: action.column, line, intentional });
        } else if (action.kind === "drop-column") {
          result.destructive.push({
            line,
            kind: "drop-column",
            table,
            column: action.column,
            message: `Deletes the column "${action.column}" from table ${display(table)}; the data in it is lost.`,
          });
          if (existing)
            result.incompatible.push({
              line,
              what: `drops column ${display(table)}."${action.column}"`,
            });
          droppedColumns.push({ table, column: action.column, line, intentional });
        } else if (action.kind === "alter-type") {
          result.destructive.push({
            line,
            kind: "alter-type",
            table,
            column: action.column,
            message: `Changes the type of column "${action.column}" in table ${display(table)} to ${action.type || "a new type"}. Existing values are converted; a value that cannot be converted makes the migration fail, and narrowing can lose precision or enum values.`,
          });
          if (existing && !toleratedTypeChange(options.typeOf, table, action, tokens))
            result.incompatible.push({
              line,
              what: `changes the type of ${display(table)}."${action.column}"`,
            });
        } else if (action.kind === "rename-column") {
          if (existing)
            result.incompatible.push({
              line,
              what: `renames ${display(table)}."${action.column}" to "${action.to}"`,
            });
        } else if (action.kind === "rename-table") {
          if (!createdTables.has(table))
            result.incompatible.push({
              line,
              what: `renames table ${display(table)} to "${action.to}"`,
            });
        } else if (action.kind === "drop-constraint") {
          droppedConstraints.push({ table, constraint: action.constraint, line });
        } else if (action.kind === "add-constraint" && action.constraint) {
          addedConstraints.add(`${table}:${action.constraint}`);
        } else if (action.kind === "other") {
          notAnalyzed(
            statement,
            `ALTER TABLE action not recognized by the analyzer (${action.words.slice(0, 3).join(" ")})`,
          );
        }
      }
    } else if (words[0] === "TRUNCATE") {
      result.destructive.push({
        line,
        kind: "truncate",
        message: "Deletes every row of the listed table(s) (TRUNCATE).",
      });
    } else if (words[0] === "DELETE" && !words.includes("WHERE")) {
      result.destructive.push({
        line,
        kind: "delete-all",
        message: "Deletes every row of a table (DELETE without WHERE).",
      });
    } else if (words[0] === "DROP" && (words[1] === "SCHEMA" || words[1] === "DATABASE")) {
      result.destructive.push({
        line,
        kind: "drop-schema",
        message: `${head} deletes everything inside it.`,
      });
    } else if (head === "CREATE TYPE") {
      const name = qualifiedName(tokens, 2);
      if (name) createdTypes.add(`${name.schema}.${name.name}`);
    } else if (head === "ALTER TYPE") {
      const name = qualifiedName(tokens, 2);
      const rest = name ? words.slice(name.next) : [];
      const key = name ? `${name.schema}.${name.name}` : "";
      if (rest[0] === "ADD" && rest[1] === "VALUE") {
        // Additive: old code never sees the new value until new code writes it.
      } else if (rest[0] === "RENAME" && name) {
        // Queries cast to the enum type by name and write its values by
        // label, so renaming either breaks the running (old) code.
        if (!createdTypes.has(key))
          result.incompatible.push({
            line,
            what:
              rest[1] === "VALUE"
                ? `renames a value of enum ${display(key)}`
                : `renames type ${display(key)}`,
          });
      } else {
        notAnalyzed(
          statement,
          `ALTER TYPE form not recognized by the analyzer (${words.slice(0, 5).join(" ")})`,
        );
      }
    } else if (
      words[0] === "DROP" &&
      ["INDEX", "TYPE", "SEQUENCE"].includes(words[1]) &&
      words.includes("CASCADE")
    ) {
      result.destructive.push({
        line,
        kind: "drop-cascade",
        message: `${head} … CASCADE also drops everything that depends on it (column defaults, constraints, or whole columns).`,
      });
      result.incompatible.push({ line, what: `${head.toLowerCase()} with CASCADE` });
      notAnalyzed(statement, `${head} … CASCADE: dependent objects are not analyzed`);
    } else if (!isRecognizedSafe(words)) {
      notAnalyzed(
        statement,
        `statement not recognized by the analyzer (${words.slice(0, 3).join(" ")})`,
      );
    }
  }
  for (const drop of droppedConstraints) {
    if (drop.constraint && addedConstraints.has(`${drop.table}:${drop.constraint}`)) continue;
    result.destructive.push({
      line: drop.line,
      kind: "drop-constraint",
      table: drop.table,
      message: `Removes the constraint "${drop.constraint ?? "?"}" from table ${display(drop.table)} without re-adding it.`,
    });
  }
  // Check 5: a drop and an add on the same table in one migration.
  for (const drop of droppedColumns) {
    const add = addedColumns.find((candidate) => candidate.table === drop.table);
    if (!add || drop.intentional || add.intentional) continue;
    result.renames.push({
      line: drop.line,
      message: `Column "${drop.column}" is dropped and "${add.column}" is added on table ${display(drop.table)} in the same migration. This looks like a rename: keep the old column name in the database with @map (docs/schema-changes-recipe.md); a RENAME COLUMN breaks the release that is still running. If you really mean to drop and recreate, put "${INTENTIONAL_MARKER}" on the line above the statement.`,
    });
  }
  for (const drop of droppedTables) {
    if (drop.intentional) continue;
    const before = known.get(drop.key);
    const recreated = created.find((make) => make.key === drop.key && make.line > drop.line);
    if (recreated && !recreated.intentional) {
      result.renames.push({
        line: drop.line,
        message: `Table ${display(drop.key)} is dropped and created again under the same name in the same migration, so every existing row is lost. If you only meant to change columns, use ALTER TABLE. If you really mean to drop and recreate, put "${INTENTIONAL_MARKER}" on the line above the statement.`,
      });
      continue;
    }
    for (const make of created) {
      if (make.intentional || make.key === drop.key) continue;
      if (before && !similar(before, make.columns)) continue;
      result.renames.push({
        line: drop.line,
        message: `Table ${display(drop.key)} is dropped and table ${display(make.key)} is created with ${before ? "similar columns" : "unknown similarity"} in the same migration. This looks like a rename: keep the old table name in the database with @@map (docs/schema-changes-recipe.md); a RENAME TO breaks the release that is still running. If you really mean to drop and recreate, put "${INTENTIONAL_MARKER}" on the line above the statement.`,
      });
      break;
    }
  }
  return result;
}

/**
 * Statements the analyzer understands and that cannot break old code or lose
 * data by themselves. Everything else is reported as "not analyzed" so a
 * person reviews it; nothing falls through silently.
 */
function isRecognizedSafe(words) {
  const [a, b, c] = words;
  if (["BEGIN", "COMMIT", "SET", "SELECT", "INSERT", "UPDATE"].includes(a)) return true;
  if (a === "DELETE" || a === "TRUNCATE") return true; // reported as destructive above
  if (a === "COMMENT" && b === "ON") return true;
  if (a === "CREATE") {
    if (["INDEX", "SCHEMA", "EXTENSION", "SEQUENCE", "TYPE"].includes(b)) return true;
    if (b === "UNIQUE" && c === "INDEX") return true;
  }
  // Without CASCADE these fail if anything still depends on the object; with
  // CASCADE they silently drop dependents (column defaults, whole columns).
  if (a === "DROP" && ["INDEX", "TYPE", "SEQUENCE"].includes(b) && !words.includes("CASCADE"))
    return true;
  if (a === "ALTER" && (b === "SEQUENCE" || (b === "INDEX" && words.includes("RENAME"))))
    return true;
  return false;
}

/**
 * What a migration (or a `contract.sql`) does to existing data, for CI check
 * 4's survival comparison and the runner's `contract_effects`. Keys are
 * "schema.table" / "schema.table.column" / "schema.name".
 * @param {string} sql
 * @param {{ folder?: string }} [options] folder: needed to recognize the
 *   generated enum templates (their object names hash it).
 */
export function summarizeEffects(sql, options = {}) {
  const effects = {
    tableRenames: new Map(),
    columnRenames: new Map(),
    droppedTables: new Set(),
    droppedColumns: new Set(),
    droppedTypes: new Set(),
    droppedIndexes: new Set(),
    droppedConstraints: new Set(),
    /** @type {Array<{ enum: string, removed: string[], mapped: string[] }>} */
    enumValuesRemoved: [],
    typeChanged: new Set(),
    updatedColumns: new Set(),
    rowsRemoved: new Set(),
    opaque: false,
  };
  let parsed;
  try {
    parsed = splitStatements(sql);
  } catch {
    effects.opaque = true;
    return effects;
  }
  const recognized = recognizeTemplates(sql, parsed, { folder: options.folder, file: "any" });
  for (const template of recognized.templates) {
    if (template.kind === "recover")
      effects.updatedColumns.add(`public.${template.header.table}.${template.header.to}`);
    if (template.kind !== "enum-remove") continue;
    const header = /** @type {EnumRemoveHeader} */ (template.header);
    const enumKey = `public.${header.enumName}`;
    if (template.file === "contract")
      effects.enumValuesRemoved.push({
        enum: enumKey,
        removed: header.pairs.map((pair) => pair.from),
        mapped: header.pairs.map((pair) => pair.to),
      });
    // Both the expand UPDATEs and the contract's catch-up remap rewrite these.
    for (const column of header.columns)
      effects.updatedColumns.add(`public.${column.table}.${column.column}`);
  }
  for (const [index, statement] of parsed.entries()) {
    const { tokens } = statement;
    const words = tokens.map(kw);
    if (isWrapperStatement(statement)) continue;
    if (recognized.covered.has(index) && (statement.opaque || words[0] === "DO")) continue;
    if (statement.opaque || ["DO", "EXECUTE", "CALL", "COPY"].includes(words[0]))
      effects.opaque = true;
    if (words[0] === "ALTER" && words[1] === "TABLE") {
      const parsedAlter = alterTable(tokens);
      if (!parsedAlter) continue;
      const table = parsedAlter.table;
      for (const action of parsedAlter.actions) {
        if (action.kind === "rename-table")
          effects.tableRenames.set(table, `${parsedAlter.schema}.${action.to}`);
        else if (action.kind === "rename-column")
          effects.columnRenames.set(`${table}.${action.column}`, action.to);
        else if (action.kind === "drop-column")
          effects.droppedColumns.add(`${table}.${action.column}`);
        else if (action.kind === "drop-constraint")
          effects.droppedConstraints.add(`${table}.${action.constraint}`);
        else if (action.kind === "alter-type") effects.typeChanged.add(`${table}.${action.column}`);
      }
    } else if (words[0] === "DROP" && words[1] === "TABLE") {
      for (const key of dropTargets(tokens, 2)) effects.droppedTables.add(key);
    } else if (words[0] === "DROP" && words[1] === "TYPE") {
      for (const key of dropTargets(tokens, 2)) effects.droppedTypes.add(key);
    } else if (words[0] === "DROP" && words[1] === "INDEX") {
      for (const key of dropTargets(tokens, words[2] === "CONCURRENTLY" ? 3 : 2))
        effects.droppedIndexes.add(key);
    } else if (words[0] === "TRUNCATE") {
      let index = 1;
      if (words[1] === "TABLE") index = 2;
      if (words[index] === "ONLY") index++;
      for (const key of dropTargets(tokens, index)) effects.rowsRemoved.add(key);
    } else if (words[0] === "DELETE" && words[1] === "FROM") {
      const name = qualifiedName(tokens, words[2] === "ONLY" ? 3 : 2);
      if (name) effects.rowsRemoved.add(`${name.schema}.${name.name}`);
    } else if (words[0] === "UPDATE") {
      const name = qualifiedName(tokens, words[1] === "ONLY" ? 2 : 1);
      const set = words.indexOf("SET");
      if (!name || set < 0) continue;
      const stop = words.findIndex(
        (word, i) => i > set && ["WHERE", "FROM", "RETURNING"].includes(word),
      );
      for (const part of splitTopLevel(tokens.slice(set + 1, stop < 0 ? undefined : stop))) {
        if (part[0] === "(") {
          for (const token of part.slice(1, part.indexOf(")"))) {
            if (isIdentToken(token))
              effects.updatedColumns.add(`${name.schema}.${name.name}.${ident(token)}`);
          }
        } else if (isIdentToken(part[0]))
          effects.updatedColumns.add(`${name.schema}.${name.name}.${ident(part[0])}`);
      }
    }
  }
  return effects;
}

function similar(a, b) {
  if (!a.size || !b.size) return false;
  let shared = 0;
  for (const column of a) if (b.has(column)) shared++;
  return shared / (a.size + b.size - shared) >= 0.5;
}

/**
 * Remove the bare BEGIN; / COMMIT; statements Prisma emits around an enum
 * rebuild, so the generator's own wrapper stays the only transaction. Every
 * other byte (comments included) is preserved.
 */
export function stripBareTransactionControl(sql) {
  const spans = splitStatements(sql).filter(
    ({ tokens }) => tokens.length === 1 && ["BEGIN", "COMMIT"].includes(kw(tokens[0])),
  );
  let next = sql;
  for (const span of spans.reverse()) {
    let end = span.end;
    while (next[end] === "\n" || next[end] === "\r") end++;
    next = next.slice(0, span.start) + next.slice(end);
  }
  return next;
}

/** Wrap a generated body in the transactional template. */
export function wrapTransactional(body) {
  return `${[TRANSACTIONAL_MARKER, ...WRAPPER_PREAMBLE].join("\n")}\n\n${body.trim()}\n\n${COMMIT_MARKER_COMMENT}\n${COMMIT_MARKER_STATEMENT}\nCOMMIT;\n`;
}

// ===========================================================================
// Expand / contract (docs/schema-migrations.md § Expand and contract).
//
// Pure functions shared by the generator, CI and the runner: the versioned
// templates (`TEMPLATES`), their exact-text recognizers, the static catalog
// fold (`catalogFromSql`), the Prisma enum-rebuild recognizer and its
// classifier, the split of a schema diff into migration.sql (expand) and
// contract.sql (contract), and the contract / rollback / name-reuse rules.
// ===========================================================================

/** Optional per-folder file the runner applies after the soak. Prisma never reads it. */
export const CONTRACT_FILE = "contract.sql";
/** `-- knowledge-base:reviewed <reason>` directly above one migration.sql statement (§1.9). */
export const REVIEWED_MARKER = "-- knowledge-base:reviewed";
/**
 * A reviewed annotation is ignored when the statement text (dollar bodies
 * included) matches this. `\bTYPE\b` catches every column type-change
 * spelling (`ALTER [COLUMN] x TYPE`, `SET DATA TYPE`); it over-matches
 * CREATE TYPE and ADD VALUE, which is fail-safe.
 */
const REVIEWED_IGNORE =
  /\b(DROP|RENAME|TRUNCATE|EXECUTE|DISABLE|POLICY|RULE|REVOKE|SECURITY|TYPE)\b|knowledge_base_/i;
/** The template version generators write. Recognizers dispatch on the header token. */
export const LATEST_TEMPLATE_VERSION = "v1";
/** An enum rebuild keeps the label instead when an affected table is larger (64 MB). */
export const ENUM_REBUILD_MAX_BYTES = 67_108_864;

const ENUM_REMOVE_PREFIX = "-- knowledge-base:enum-remove";
const ENUM_REMOVE_END = "-- end knowledge-base:enum-remove";
const RECOVER_PREFIX = "-- knowledge-base:recover";
const RECOVER_END = "-- end knowledge-base:recover";
const RELAX_PREFIX = "-- knowledge-base:relax";

/**
 * @typedef {{ base: string, length?: number, precision?: number, scale?: number, array: boolean }} NormalizedType
 * @typedef {{ table: string, column: string, array: boolean }} EnumColumnRef
 * @typedef {{ kind?: "enum-remove", version?: string, enumName: string,
 *   pairs: Array<{ from: string, to: string }>, columns: EnumColumnRef[], folder?: string }} EnumRemoveHeader
 * @typedef {{ kind?: "recover", version?: string, table: string, from: string, to: string }} RecoverHeader
 * @typedef {{ table: string, column: string, sentinel?: string | null }} RelaxSpec
 */

const quoteIdent = (name) => `"${String(name).replaceAll('"', '""')}"`;
const sqlLiteral = (value) => `'${String(value).replaceAll("'", "''")}'`;

/** Names end up inside dollar-quoted bodies and one-line headers. */
function assertTemplateName(value) {
  if (/[$\0\r\n]/.test(String(value)))
    throw new Error(
      `unsupported character in ${JSON.stringify(value)}: a generated template cannot carry "$" or a line break`,
    );
}

/** First 8 hex chars of sha256("<folder>|<key>"): template object names, unique per folder. */
function templateHash(folder, key) {
  return createHash("sha256").update(`${folder}|${key}`).digest("hex").slice(0, 8);
}

/** Name of the enum-remove sync function and trigger for one table. */
export function syncTriggerName(folder, table) {
  return `knowledge_base_sync_${templateHash(folder, table)}`;
}

/** Header line shared by the enum-remove expand block and contract `DO`. */
export function formatEnumRemoveHeader(header) {
  const pairs = header.pairs
    .map(({ from, to }) => `${quoteIdent(from)}->${quoteIdent(to)}`)
    .join(", ");
  const columns = header.columns
    .map((c) => `${quoteIdent(c.table)}.${quoteIdent(c.column)}${c.array ? "[]" : ""}`)
    .join(", ");
  return `${ENUM_REMOVE_PREFIX} ${header.version ?? LATEST_TEMPLATE_VERSION} ${quoteIdent(header.enumName)} ${pairs} columns${columns ? ` ${columns}` : ""}`;
}

function headerTokens(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === " " || ch === "\t") {
      i++;
    } else if (ch === '"') {
      let j = i + 1;
      let value = "";
      for (;;) {
        if (j >= text.length) return null;
        if (text[j] === '"') {
          if (text[j + 1] !== '"') break;
          value += '"';
          j += 2;
        } else value += text[j++];
      }
      out.push({ ident: value });
      i = j + 1;
    } else if (text.startsWith("->", i) || text.startsWith("[]", i)) {
      out.push(text.slice(i, i + 2));
      i += 2;
    } else if (ch === "," || ch === ".") {
      out.push(ch);
      i++;
    } else {
      const word = /^[A-Za-z0-9_]+/.exec(text.slice(i))?.[0];
      if (!word) return null;
      out.push(word);
      i += word.length;
    }
  }
  return out;
}

/**
 * Parse a `-- knowledge-base:enum-remove|recover|relax <vN> …` header comment.
 * Returns null for any other comment; `malformed: true` when the shape is
 * wrong; `version: null` when the version token is missing.
 */
export function parseTemplateHeader(line) {
  const text = String(line).trim();
  const kinds = [
    ["enum-remove", ENUM_REMOVE_PREFIX],
    ["recover", RECOVER_PREFIX],
    ["relax", RELAX_PREFIX],
  ];
  const match = kinds.find(([, prefix]) => text === prefix || text.startsWith(`${prefix} `));
  if (!match) return null;
  const [kind, prefix] = match;
  const tokens = headerTokens(text.slice(prefix.length));
  const version = typeof tokens?.[0] === "string" && /^v\d+$/.test(tokens[0]) ? tokens[0] : null;
  const malformed = { kind, version, malformed: true };
  if (!tokens || !version) return malformed;
  let i = 1;
  const id = () => {
    const token = tokens[i];
    if (token && typeof token === "object") {
      i++;
      return token.ident;
    }
    return undefined;
  };
  const expect = (symbol) => {
    if (tokens[i] !== symbol) return false;
    i++;
    return true;
  };
  if (kind === "enum-remove") {
    const enumName = id();
    if (enumName === undefined) return malformed;
    const pairs = [];
    do {
      const from = id();
      if (from === undefined || !expect("->")) return malformed;
      const to = id();
      if (to === undefined) return malformed;
      pairs.push({ from, to });
    } while (expect(","));
    if (!expect("columns")) return malformed;
    const columns = [];
    if (i < tokens.length) {
      do {
        const table = id();
        if (table === undefined || !expect(".")) return malformed;
        const column = id();
        if (column === undefined) return malformed;
        columns.push({ table, column, array: expect("[]") });
      } while (expect(","));
    }
    if (i !== tokens.length) return malformed;
    return { kind, version, enumName, pairs, columns };
  }
  const table = id();
  if (table === undefined || !expect(".")) return malformed;
  const column = id();
  if (column === undefined) return malformed;
  if (kind === "relax") return i === tokens.length ? { kind, version, table, column } : malformed;
  if (!expect("->")) return malformed;
  const to = id();
  if (to === undefined || i !== tokens.length) return malformed;
  return { kind, version, table, from: column, to };
}

const uniqueTables = (columns) => [...new Set(columns.map((c) => c.table))];

function checkEnumHeader(header) {
  if (!header.folder) throw new Error("enum-remove templates need the migration folder name");
  for (const name of [
    header.enumName,
    ...header.pairs.flatMap((p) => [p.from, p.to]),
    ...header.columns.flatMap((c) => [c.table, c.column]),
  ])
    assertTemplateName(name);
}

/**
 * v1 expand block (§1.5.1). The sync body is jsonb-only: no expression in it
 * is typed by the enum, so a cached plan survives the contract's rebuild.
 * @param {EnumRemoveHeader} header
 */
function enumRemoveExpandV1(header) {
  checkEnumHeader(header);
  const lines = [formatEnumRemoveHeader({ ...header, version: "v1" })];
  for (const table of uniqueTables(header.columns)) {
    const name = quoteIdent(syncTriggerName(header.folder, table));
    lines.push(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $knowledge_base$`);
    lines.push("DECLARE r jsonb := to_jsonb(NEW); p jsonb := '{}';");
    lines.push("BEGIN");
    for (const column of header.columns.filter((c) => c.table === table)) {
      const c = sqlLiteral(column.column);
      if (!column.array) {
        for (const { from, to } of header.pairs)
          lines.push(
            `  IF r->>${c} = ${sqlLiteral(from)} THEN p := p || jsonb_build_object(${c}, ${sqlLiteral(to)}); END IF;`,
          );
        continue;
      }
      const contains = header.pairs
        .map(({ from }) => `r->${c} @> ${sqlLiteral(JSON.stringify([from]))}`)
        .join(" OR ");
      const cases = header.pairs
        .map(
          ({ from, to }) =>
            `WHEN ${sqlLiteral(JSON.stringify(from))} THEN ${sqlLiteral(JSON.stringify(to))}::jsonb`,
        )
        .join(" ");
      lines.push(`  IF jsonb_typeof(r->${c}) = 'array' AND (${contains}) THEN`);
      lines.push(
        `    p := p || jsonb_build_object(${c}, (SELECT jsonb_agg(CASE e ${cases} ELSE e END ORDER BY o)`,
      );
      lines.push(
        `                                          FROM jsonb_array_elements(r->${c}) WITH ORDINALITY x(e, o)));`,
      );
      lines.push("  END IF;");
    }
    lines.push("  IF p <> '{}' THEN NEW := jsonb_populate_record(NEW, p); END IF;");
    lines.push("  RETURN NEW;");
    lines.push("END $knowledge_base$;");
    lines.push(
      `CREATE TRIGGER ${name} BEFORE INSERT OR UPDATE ON ${quoteIdent(table)} FOR EACH ROW EXECUTE FUNCTION ${name}();`,
    );
    for (const column of header.columns.filter((c) => c.table === table)) {
      const col = quoteIdent(column.column);
      for (const { from, to } of header.pairs)
        lines.push(
          column.array
            ? `UPDATE ${quoteIdent(table)} SET ${col} = array_replace(${col}, ${sqlLiteral(from)}, ${sqlLiteral(to)}) WHERE ${sqlLiteral(from)} = ANY(${col});`
            : `UPDATE ${quoteIdent(table)} SET ${col} = ${sqlLiteral(to)} WHERE ${col} = ${sqlLiteral(from)};`,
        );
    }
  }
  lines.push(ENUM_REMOVE_END);
  return lines.join("\n");
}

// Fixed body of the v1 contract `DO` (§1.5.2). NEVER edit it: a released
// template is immutable (migrations that use it are). Add a v2 instead and
// keep this one. The test in sql.test.mjs pins it byte for byte.
//
// Order: resolve E; drop this folder's sync objects; size guard; catch-up
// remap (its own label-kept sub-block: e.g. a unique E column where both
// labels exist); then the rebuild sub-block. The `FOR f …` loop at its end
// invalidates other sessions' cached plpgsql plans that may bind the old type
// oid: a no-op `ALTER ROUTINE <sig> SECURITY <same>` works for functions and
// procedures alike (the per-kind ALTER fails 42809 on a procedure, and the
// cost attribute is invalid there). Any failure inside a sub-block rolls back
// only that sub-block and keeps the label (`knowledge-base:label-kept` notice); a lock
// timeout, deadlock or external cancel re-raises (transient).
const ENUM_CONTRACT_BODY_V1 = `  typ oid;
  arr oid;
  ns oid;
  ns_name text;
  affected oid[];
  rel oid;
  col record;
  f record;
  i int;
  lbl text;
  labels text[];
  alter_parts text[];
  restore_parts text[];
  restores text[] := '{}';
  ddl text;
BEGIN
  typ := to_regtype(quote_ident(enum_name));
  IF typ IS NULL THEN
    RAISE NOTICE 'knowledge-base: enum "%" not found', replace(enum_name, '"', '""');
    RETURN;
  END IF;
  SELECT t.typarray, t.typnamespace, n.nspname INTO arr, ns, ns_name
    FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.oid = typ;
  FOR i IN 1 .. coalesce(array_length(sync_names, 1), 0) LOOP
    IF to_regclass(quote_ident(sync_tables[i])) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', sync_names[i], sync_tables[i]);
    END IF;
    EXECUTE format('DROP FUNCTION IF EXISTS %I()', sync_names[i]);
  END LOOP;
  SELECT coalesce(array_agg(DISTINCT a.attrelid), '{}') INTO affected
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
   WHERE a.atttypid IN (typ, arr) AND a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r', 'p');
  IF EXISTS (SELECT 1 FROM unnest(affected) AS u(r) WHERE pg_total_relation_size(u.r) > max_bytes) THEN
    FOREACH lbl IN ARRAY removed LOOP
      RAISE NOTICE 'knowledge-base:label-kept "%" "%" (table larger than 64 MB)', replace(enum_name, '"', '""'), replace(lbl, '"', '""');
    END LOOP;
    RETURN;
  END IF;
  BEGIN
    FOR col IN SELECT a.attrelid::regclass AS rel, a.attname, a.atttypid = arr AS is_array
                 FROM pg_attribute a
                WHERE a.attrelid = ANY (affected) AND a.atttypid IN (typ, arr) AND a.attnum > 0 AND NOT a.attisdropped
                ORDER BY a.attrelid, a.attnum LOOP
      FOR i IN 1 .. array_length(removed, 1) LOOP
        IF col.is_array THEN
          EXECUTE format('UPDATE %s SET %I = array_replace(%I::text[], %L, %L)::%s WHERE %L = ANY (%I::text[])',
                         col.rel, col.attname, col.attname, removed[i], mapped[i], format_type(arr, NULL), removed[i], col.attname);
        ELSE
          EXECUTE format('UPDATE %s SET %I = %L WHERE %I::text = %L', col.rel, col.attname, mapped[i], col.attname, removed[i]);
        END IF;
      END LOOP;
    END LOOP;
  EXCEPTION
    WHEN lock_not_available OR deadlock_detected OR query_canceled THEN
      RAISE;
    WHEN OTHERS THEN
      FOREACH lbl IN ARRAY removed LOOP
        RAISE NOTICE 'knowledge-base:label-kept "%" "%" (%: %)', replace(enum_name, '"', '""'), replace(lbl, '"', '""'), SQLSTATE, SQLERRM;
      END LOOP;
      RETURN;
  END;
  BEGIN
    SELECT array_agg(e.enumlabel::text ORDER BY e.enumsortorder) INTO labels FROM pg_enum e WHERE e.enumtypid = typ;
    IF labels && removed THEN
      EXECUTE format('CREATE TYPE %I.%I AS ENUM (%s)', ns_name, new_name,
                     (SELECT coalesce(string_agg(quote_literal(u.l), ', ' ORDER BY u.o), '')
                        FROM unnest(labels) WITH ORDINALITY AS u(l, o) WHERE u.l <> ALL (removed)));
      FOREACH rel IN ARRAY affected LOOP
        alter_parts := '{}';
        restore_parts := '{}';
        FOR col IN SELECT a.attname, a.atttypid = arr AS is_array, pg_get_expr(d.adbin, d.adrelid) AS def
                     FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                    WHERE a.attrelid = rel AND a.atttypid IN (typ, arr) AND a.attnum > 0 AND NOT a.attisdropped
                    ORDER BY a.attnum LOOP
          IF col.def IS NOT NULL THEN
            alter_parts := alter_parts || format('ALTER COLUMN %I DROP DEFAULT', col.attname);
            restore_parts := restore_parts || format('ALTER COLUMN %I SET DEFAULT %s', col.attname, col.def);
          END IF;
          alter_parts := alter_parts || format('ALTER COLUMN %I TYPE %I.%I%s USING %I::text::%I.%I%s',
                                               col.attname, ns_name, new_name, CASE WHEN col.is_array THEN '[]' ELSE '' END,
                                               col.attname, ns_name, new_name, CASE WHEN col.is_array THEN '[]' ELSE '' END);
        END LOOP;
        EXECUTE format('ALTER TABLE %s %s', rel::regclass, array_to_string(alter_parts, ', '));
        IF cardinality(restore_parts) > 0 THEN
          restores := restores || format('ALTER TABLE %s %s', rel::regclass, array_to_string(restore_parts, ', '));
        END IF;
      END LOOP;
      EXECUTE format('ALTER TYPE %I.%I RENAME TO %I', ns_name, enum_name, old_name);
      EXECUTE format('ALTER TYPE %I.%I RENAME TO %I', ns_name, new_name, enum_name);
      EXECUTE format('DROP TYPE %I.%I', ns_name, old_name);
      FOREACH ddl IN ARRAY restores LOOP
        EXECUTE ddl;
      END LOOP;
    END IF;
    FOR f IN SELECT p.oid::regprocedure AS sig, p.prosecdef FROM pg_proc p
               JOIN pg_language l ON l.oid = p.prolang AND l.lanname = 'plpgsql'
              WHERE (p.pronamespace = ns AND NOT EXISTS (SELECT 1 FROM pg_depend d
                       WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'))
                 OR p.oid IN (SELECT tgfoid FROM pg_trigger WHERE tgrelid = ANY (affected) AND NOT tgisinternal)
    LOOP
      EXECUTE format('ALTER ROUTINE %s %s', f.sig,
                     CASE WHEN f.prosecdef THEN 'SECURITY DEFINER' ELSE 'SECURITY INVOKER' END);
    END LOOP;
  EXCEPTION
    WHEN lock_not_available OR deadlock_detected THEN
      RAISE;
    WHEN query_canceled THEN
      IF current_setting('statement_timeout') IN ('0', '')
         OR clock_timestamp() - statement_timestamp()
            < current_setting('statement_timeout')::interval - interval '1 second' THEN
        RAISE;
      END IF;
      FOREACH lbl IN ARRAY removed LOOP
        RAISE NOTICE 'knowledge-base:label-kept "%" "%" (timed out)', replace(enum_name, '"', '""'), replace(lbl, '"', '""');
      END LOOP;
    WHEN OTHERS THEN
      FOREACH lbl IN ARRAY removed LOOP
        RAISE NOTICE 'knowledge-base:label-kept "%" "%" (%: %)', replace(enum_name, '"', '""'), replace(lbl, '"', '""'), SQLSTATE, SQLERRM;
      END LOOP;
  END;
END $knowledge_base_enum$;`;

/**
 * v1 contract `DO` (§1.5.2), header line first. Always the first statement
 * of contract.sql. Only the DECLARE parameters vary.
 * @param {EnumRemoveHeader} header
 */
function enumRemoveContractV1(header) {
  checkEnumHeader(header);
  const textArray = (values) =>
    values.length ? `ARRAY[${values.map(sqlLiteral).join(", ")}]::text[]` : "'{}'::text[]";
  const tables = uniqueTables(header.columns);
  const hash = templateHash(header.folder, header.enumName);
  return [
    formatEnumRemoveHeader({ ...header, version: "v1" }),
    "DO $knowledge_base_enum$",
    "DECLARE",
    `  enum_name text := ${sqlLiteral(header.enumName)};`,
    `  removed text[] := ${textArray(header.pairs.map((p) => p.from))};`,
    `  mapped text[] := ${textArray(header.pairs.map((p) => p.to))};`,
    `  sync_tables text[] := ${textArray(tables)};`,
    `  sync_names text[] := ${textArray(tables.map((t) => syncTriggerName(header.folder, t)))};`,
    `  new_name text := 'knowledge_base_enum_new_${hash}';`,
    `  old_name text := 'knowledge_base_enum_old_${hash}';`,
    `  max_bytes bigint := ${ENUM_REBUILD_MAX_BYTES};`,
    ENUM_CONTRACT_BODY_V1,
  ].join("\n");
}

/**
 * v1 recover block (§1.8): copy a retired column into its replacement while
 * the retired column still exists.
 * @param {RecoverHeader} header
 */
function recoverBlockV1({ table, from, to }) {
  for (const name of [table, from, to]) assertTemplateName(name);
  const target = `${quoteIdent(table)}.${quoteIdent(from)}`;
  return [
    `${RECOVER_PREFIX} v1 ${target} -> ${quoteIdent(to)}`,
    "DO $knowledge_base_recover$ BEGIN",
    "  IF EXISTS (SELECT 1 FROM information_schema.columns",
    `             WHERE table_schema = current_schema() AND table_name = ${sqlLiteral(table)} AND column_name = ${sqlLiteral(from)}) THEN`,
    `    UPDATE ${quoteIdent(table)} SET ${quoteIdent(to)} = ${quoteIdent(from)} WHERE ${quoteIdent(to)} IS NULL AND ${quoteIdent(from)} IS NOT NULL;`,
    "  ELSE",
    `    RAISE WARNING ${sqlLiteral(`knowledge-base:recover ${target} was already deleted`.replaceAll("%", "%%"))};`,
    "  END IF;",
    "END $knowledge_base_recover$;",
    RECOVER_END,
  ].join("\n");
}

/**
 * v1 relax statement (§1.4.1) for a retired NOT NULL column: a sentinel
 * default (NOT NULL kept) or, with `sentinel` null, DROP NOT NULL.
 * @param {RelaxSpec} spec
 */
function relaxV1({ table, column, sentinel = null }) {
  const action = sentinel === null ? "DROP NOT NULL" : `SET DEFAULT ${sentinel}`;
  return `${RELAX_PREFIX} v1 ${quoteIdent(table)}.${quoteIdent(column)}\nALTER TABLE ${quoteIdent(table)} ALTER COLUMN ${quoteIdent(column)} ${action};`;
}

/**
 * Every released template version. Generators always write
 * LATEST_TEMPLATE_VERSION; recognizers dispatch on the header's token, so a
 * migration generated with v1 stays recognized after a v2 exists. Any change
 * to a template's text MUST add a new version and keep every earlier one.
 */
export const TEMPLATES = Object.freeze({
  v1: Object.freeze({
    enumRemoveExpand: enumRemoveExpandV1,
    enumRemoveContract: enumRemoveContractV1,
    recoverBlock: recoverBlockV1,
    relax: relaxV1,
  }),
});

/** @param {EnumRemoveHeader} header */
export function enumRemoveExpand(header) {
  return TEMPLATES[LATEST_TEMPLATE_VERSION].enumRemoveExpand(header);
}
/** @param {EnumRemoveHeader} header */
export function enumRemoveContract(header) {
  return TEMPLATES[LATEST_TEMPLATE_VERSION].enumRemoveContract(header);
}
/** @param {RecoverHeader} header */
export function recoverBlock(header) {
  return TEMPLATES[LATEST_TEMPLATE_VERSION].recoverBlock(header);
}
/** @param {RelaxSpec} spec */
export function relax(spec) {
  return TEMPLATES[LATEST_TEMPLATE_VERSION].relax(spec);
}

/**
 * Find the generated templates in a file and verify each byte for byte.
 * `covered`: statement indexes inside a verified template; `relaxed`: verified
 * relax statements (ordinary ALTERs, analyzed as usual); `problems`: statement
 * index → why a template header there is not accepted (unknown version,
 * malformed, edited). `file` picks which enum-remove text is expected.
 * @param {string} sql
 * @param {ReturnType<typeof splitStatements>} parsed
 * @param {{ folder?: string, file: "migration" | "contract" | "any" }} options
 */
function recognizeTemplates(sql, parsed, { folder, file }) {
  const covered = new Set();
  const relaxed = new Set();
  const problems = new Map();
  const templates = [];
  for (const [index, statement] of parsed.entries()) {
    for (const comment of statement.comments) {
      const header = parseTemplateHeader(comment);
      if (!header) continue;
      const set = header.version ? TEMPLATES[header.version] : undefined;
      if (header.malformed) {
        problems.set(index, `malformed knowledge-base:${header.kind} template header`);
        continue;
      }
      if (!set) {
        problems.set(index, `template ${header.version} not known to this image (${header.kind})`);
        continue;
      }
      if (header.kind === "relax") {
        const prefix = `ALTER TABLE ${quoteIdent(header.table)} ALTER COLUMN ${quoteIdent(header.column)} `;
        const text = statement.text ?? "";
        const action = text.startsWith(prefix) ? text.slice(prefix.length) : "";
        if (
          action === "DROP NOT NULL;" ||
          /^SET DEFAULT (?:'(?:[^']|'')*'|0|false);$/.test(action)
        ) {
          relaxed.add(index);
          templates.push({ kind: "relax", version: header.version, line: statement.line, header });
        } else
          problems.set(
            index,
            `knowledge-base:relax ${header.version} marker above a statement that is not the generated relax`,
          );
        continue;
      }
      if (header.kind === "enum-remove" && !folder) {
        problems.set(index, "cannot verify the enum-remove template without its folder name");
        continue;
      }
      const at = sql.lastIndexOf(comment, statement.start);
      const candidates = [];
      if (header.kind === "recover") candidates.push(["migration", set.recoverBlock(header)]);
      else {
        const full = { ...header, folder };
        try {
          if (file !== "contract") candidates.push(["migration", set.enumRemoveExpand(full)]);
          if (file !== "migration") candidates.push(["contract", set.enumRemoveContract(full)]);
        } catch (error) {
          problems.set(index, `${header.kind} template cannot be regenerated (${error.message})`);
          continue;
        }
      }
      const hit = candidates.find(([, text]) => at >= 0 && sql.startsWith(text, at));
      if (!hit) {
        problems.set(
          index,
          `knowledge-base:${header.kind} ${header.version} block does not match the generated text (edited by hand?); regenerate it with \`pnpm db:migrate\``,
        );
        continue;
      }
      const end = at + hit[1].length;
      for (const [other, candidate] of parsed.entries())
        if (candidate.start >= at && candidate.end <= end) covered.add(other);
      templates.push({
        kind: header.kind,
        version: header.version,
        line: statement.line,
        file: hit[0],
        index,
        header: header.kind === "enum-remove" ? { ...header, folder } : header,
      });
    }
  }
  return { covered, relaxed, problems, templates };
}

/** `-- knowledge-base:reviewed <reason>` above this statement, honoured unless §1.9 ignores it. */
function reviewedAnnotation(statement) {
  const comment = statement.comments.findLast(
    (line) => line === REVIEWED_MARKER || line.startsWith(`${REVIEWED_MARKER} `),
  );
  if (comment === undefined) return { reviewed: null };
  const reason = comment.slice(REVIEWED_MARKER.length).trim();
  if (!reason || REVIEWED_IGNORE.test(statement.text ?? ""))
    return { reviewed: null, reviewIgnored: true };
  return { reviewed: reason };
}

// --- types ------------------------------------------------------------------

const TYPE_ALIASES = new Map([
  ["character varying", "varchar"],
  ["varchar", "varchar"],
  ["character", "bpchar"],
  ["char", "bpchar"],
  ["bpchar", "bpchar"],
  ["text", "text"],
  ["integer", "int4"],
  ["int", "int4"],
  ["int4", "int4"],
  ["serial", "int4"],
  ["smallint", "int2"],
  ["int2", "int2"],
  ["bigint", "int8"],
  ["int8", "int8"],
  ["bigserial", "int8"],
  ["decimal", "numeric"],
  ["numeric", "numeric"],
  ["real", "float4"],
  ["float4", "float4"],
  ["double precision", "float8"],
  ["float8", "float8"],
  ["boolean", "bool"],
  ["bool", "bool"],
  ["timestamp", "timestamp"],
  // Type spelling for catalog normalization, not a SQL conversion.
  [["timestamp", "without", "time", "zone"].join(" "), "timestamp"],
  ["timestamp with time zone", "timestamptz"],
  ["timestamptz", "timestamptz"],
  ["time", "time"],
  ["time without time zone", "time"],
  ["time with time zone", "timetz"],
  ["timetz", "timetz"],
  ["date", "date"],
  ["json", "json"],
  ["jsonb", "jsonb"],
  ["bytea", "bytea"],
  ["uuid", "uuid"],
]);
const DATETIME_BASES = new Set(["timestamp", "timestamptz", "time", "timetz"]);

function shapeType(base, mods, array) {
  /** @type {NormalizedType} */
  const out = { base, array };
  if (base === "varchar" || base === "bpchar") {
    if (mods[0] !== undefined) out.length = mods[0];
  } else if (base === "numeric") {
    if (mods[0] !== undefined) {
      out.precision = mods[0];
      out.scale = mods[1] ?? 0;
    }
  } else if (DATETIME_BASES.has(base)) out.precision = mods[0] ?? 6;
  return out;
}

/** Parse SQL type text; keeps the schema qualifier (normalizeType drops it). */
function parseTypeText(text) {
  const tokens = [];
  const re = /"((?:[^"]|"")*)"|([A-Za-z_][\w$]*)|(\d+)|(\S)/g;
  for (const m of String(text).matchAll(re)) {
    if (m[1] !== undefined) tokens.push({ v: m[1].replaceAll('""', '"'), quoted: true });
    else if (m[2] !== undefined) tokens.push({ v: m[2], word: true });
    else if (m[3] !== undefined) tokens.push({ v: m[3], number: true });
    else tokens.push({ v: m[4] });
  }
  let array = false;
  for (;;) {
    const last = tokens.at(-1);
    if (last && !last.quoted && last.v === "]") {
      const open = tokens.findLastIndex((t) => !t.quoted && t.v === "[");
      if (open < 0) break;
      tokens.length = open;
      array = true;
    } else if (last?.word && last.v.toUpperCase() === "ARRAY") {
      tokens.pop();
      array = true;
    } else break;
  }
  const mods = [];
  const open = tokens.findIndex((t) => !t.quoted && t.v === "(");
  if (open >= 0) {
    const close = tokens.findIndex((t, i) => i > open && !t.quoted && t.v === ")");
    for (const t of tokens.slice(open + 1, close < 0 ? undefined : close))
      if (t.number) mods.push(Number(t.v));
    tokens.splice(open, (close < 0 ? tokens.length : close + 1) - open);
  }
  let schema;
  if (tokens.length >= 3 && tokens[1].v === "." && !tokens[1].quoted) {
    schema = tokens[0].quoted ? tokens[0].v : tokens[0].v.toLowerCase();
    tokens.splice(0, 2);
  }
  const quoted = tokens.length === 1 && tokens[0].quoted;
  const name = quoted ? tokens[0].v : tokens.map((t) => t.v.toLowerCase()).join(" ");
  const base = quoted ? name : (TYPE_ALIASES.get(name) ?? name);
  if (!quoted && (name === "char" || name === "character") && mods[0] === undefined) mods.push(1);
  return { schema, ...shapeType(base, mods, array) };
}

/**
 * The one type normaliser (R4-8) for SQL text (`VARCHAR(50)`,
 * `character varying(50)`, `numeric(10,2)`, `"E"[]`) and
 * information_schema.columns rows. Schema qualifiers are dropped.
 * @param {string | { data_type?: string, character_maximum_length?: number | null,
 *   numeric_precision?: number | null, numeric_scale?: number | null,
 *   datetime_precision?: number | null, udt_name: string }} input
 * @returns {NormalizedType}
 */
export function normalizeType(input) {
  if (typeof input === "string") {
    const { schema: _schema, ...type } = parseTypeText(input);
    return type;
  }
  const udt = String(input.udt_name ?? "");
  const array = input.data_type === "ARRAY" || (udt.startsWith("_") && !input.data_type);
  const element = array && udt.startsWith("_") ? udt.slice(1) : udt;
  const base = TYPE_ALIASES.get(element) ?? element;
  const num = (value) => (value === null || value === undefined ? undefined : Number(value));
  const mods =
    base === "numeric"
      ? [num(input.numeric_precision), num(input.numeric_scale)]
      : DATETIME_BASES.has(base)
        ? [num(input.datetime_precision)]
        : [num(input.character_maximum_length)];
  return shapeType(base, mods[0] === undefined ? [] : mods, array);
}

/**
 * Allowlisted in-place widenings that PostgreSQL 18 applies without a
 * rewrite (Step 0 l): varchar(n)→varchar(m≥n), varchar(n)→text,
 * numeric(p,s)→numeric(p'≥p,s). Never with USING, never for arrays.
 * @param {NormalizedType | undefined} from
 * @param {NormalizedType | undefined} to
 * @param {{ using?: boolean, array?: boolean }} [options]
 */
export function isWidening(from, to, { using = false, array = false } = {}) {
  if (using || array || !from || !to || from.array || to.array) return false;
  if (from.base === "varchar" && from.length !== undefined) {
    if (to.base === "text") return true;
    if (to.base === "varchar" && to.length !== undefined && to.length >= from.length) return true;
  }
  return (
    from.base === "numeric" &&
    to.base === "numeric" &&
    from.precision !== undefined &&
    to.precision !== undefined &&
    (from.scale ?? 0) === (to.scale ?? 0) &&
    to.precision >= from.precision
  );
}

/** Type and USING presence of an `ALTER COLUMN … TYPE <type> [COLLATE …] [USING …]` tail. */
function typeClause(tokens) {
  const stop = tokens.findIndex((token) => ["USING", "COLLATE"].includes(kw(token)));
  return {
    type: (stop < 0 ? tokens : tokens.slice(0, stop)).join(" "),
    using: tokens.some((token) => kw(token) === "USING"),
  };
}

function toleratedTypeChange(typeOf, table, action, tokens) {
  if (!typeOf || action.typeFrom === undefined) return false;
  const before = typeOf(table, action.column);
  if (!before) return false;
  if (before.newInRun) return true;
  const { type, using } = typeClause(tokens.slice(action.typeFrom, action.to));
  return isWidening(before.type, normalizeType(type), { using });
}

// --- static catalog -------------------------------------------------------

/** Decode a lexed string literal's raw text ('…', E'…', newline-joined fragments). */
function decodeLiteral(raw) {
  let i = 0;
  let escapes = false;
  if (/^[eE]'/.test(raw)) {
    escapes = true;
    i = 1;
  } else if (/^[bBxXnN]'/.test(raw)) i = 1;
  let out = "";
  while (i < raw.length) {
    if (raw[i] !== "'") {
      i++;
      continue;
    }
    i++;
    while (i < raw.length) {
      const ch = raw[i];
      if (escapes && ch === "\\") {
        const next = raw[i + 1] ?? "";
        out += { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" }[next] ?? next;
        i += 2;
      } else if (ch === "'") {
        if (raw[i + 1] === "'") {
          out += "'";
          i += 2;
        } else {
          i++;
          break;
        }
      } else {
        out += ch;
        i++;
      }
    }
  }
  return out;
}

const rawText = (sql, statement, from, to) =>
  to > from ? sql.slice(statement.positions[from], statement.ends[to - 1]) : "";

function matchingParen(tokens, open) {
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    if (tokens[i] === "(") depth++;
    if (tokens[i] === ")" && --depth === 0) return i;
  }
  return tokens.length;
}

/** Identifiers in a parenthesized list starting at `open`. */
function parenIdents(tokens, open) {
  if (tokens[open] !== "(") return [];
  const close = matchingParen(tokens, open);
  return splitTopLevelRanges(tokens, open + 1, close)
    .map(([from]) => tokens[from])
    .filter(isIdentToken)
    .map(ident);
}

export function emptyCatalog() {
  return {
    /** @type {Map<string, { schema: string, name: string, columns: Map<string, any> }>} */
    tables: new Map(),
    /** @type {Map<string, { schema: string, name: string, labels: string[] }>} */
    enums: new Map(),
    /** @type {Map<string, { name: string, table: string, columns: string[], unique: boolean, constraint?: boolean }>} */
    indexes: new Map(),
    /** @type {Map<string, { name: string, table: string, kind: string, columns: string[], references?: string, onDelete?: string }>} */
    constraints: new Map(),
    /** @type {Array<{ line: number, text: string }>} */
    unparsed: [],
  };
}

function cloneCatalog(catalog) {
  const copy = emptyCatalog();
  for (const [key, table] of catalog.tables)
    copy.tables.set(key, {
      ...table,
      columns: new Map([...table.columns].map(([name, column]) => [name, { ...column }])),
    });
  for (const [key, value] of catalog.enums)
    copy.enums.set(key, { ...value, labels: [...value.labels] });
  for (const [key, value] of catalog.indexes)
    copy.indexes.set(key, { ...value, columns: [...value.columns] });
  for (const [key, value] of catalog.constraints)
    copy.constraints.set(key, { ...value, columns: [...value.columns] });
  copy.unparsed = [...catalog.unparsed];
  return copy;
}

function resolveEnumKey(catalog, name) {
  if (catalog.enums.has(name)) return name;
  return `public.${name}`;
}

const COLUMN_STOP = new Set([
  "NOT",
  "NULL",
  "DEFAULT",
  "CONSTRAINT",
  "PRIMARY",
  "UNIQUE",
  "REFERENCES",
  "CHECK",
  "COLLATE",
  "GENERATED",
]);
const isStop = (token) =>
  isIdentToken(token) && !token.startsWith('"') && COLUMN_STOP.has(kw(token));

/** Parse `<type> [constraints…]` of a column definition in tokens[from, to). */
function parseColumnDef(sql, statement, from, to) {
  const { tokens } = statement;
  let i = from;
  while (i < to && !isStop(tokens[i])) i = tokens[i] === "(" ? matchingParen(tokens, i) + 1 : i + 1;
  const def = {
    typeText: rawText(sql, statement, from, Math.min(i, to)),
    notNull: false,
    default: /** @type {string | null} */ (null),
    generated: false,
    inline: /** @type {Array<{ kind: string, references?: string, onDelete?: string }>} */ ([]),
  };
  while (i < to) {
    const word = kw(tokens[i]);
    if (word === "NOT" && kw(tokens[i + 1]) === "NULL") {
      def.notNull = true;
      i += 2;
    } else if (word === "DEFAULT") {
      let j = i + 2;
      while (
        j < to &&
        !(isStop(tokens[j]) && (kw(tokens[j]) !== "NOT" || kw(tokens[j + 1]) === "NULL"))
      )
        j = tokens[j] === "(" ? matchingParen(tokens, j) + 1 : j + 1;
      def.default = rawText(sql, statement, i + 1, Math.min(j, to));
      i = j;
    } else if (word === "PRIMARY") {
      def.inline.push({ kind: "primary" });
      def.notNull = true;
      i += 2;
    } else if (word === "UNIQUE") {
      def.inline.push({ kind: "unique" });
      i++;
    } else if (word === "REFERENCES") {
      const target = qualifiedName(tokens, i + 1);
      const ref = { kind: "foreign", references: target ? `${target.schema}.${target.name}` : "" };
      i = target ? target.next : i + 1;
      while (i < to && !isStop(tokens[i])) {
        if (kw(tokens[i]) === "ON" && kw(tokens[i + 1]) === "DELETE") {
          ref.onDelete = referentialAction(tokens, i + 2);
          i += 2;
        } else i = tokens[i] === "(" ? matchingParen(tokens, i) + 1 : i + 1;
      }
      def.inline.push(ref);
    } else if (word === "CHECK") {
      def.inline.push({ kind: "check" });
      i = matchingParen(tokens, i + 1) + 1;
    } else if (word === "GENERATED") {
      def.generated = true;
      i = to;
    } else if (word === "CONSTRAINT" || word === "COLLATE") i += 2;
    else i++;
  }
  return def;
}

function referentialAction(tokens, i) {
  const a = kw(tokens[i]);
  const b = kw(tokens[i + 1]);
  if (a === "NO" || (a === "SET" && (b === "NULL" || b === "DEFAULT"))) return `${a} ${b}`;
  return a;
}

function columnEntry(catalog, tableSchema, name, def, inRun) {
  const parsedType = parseTypeText(def.typeText);
  const enumKey = `${parsedType.schema ?? tableSchema}.${parsedType.base}`;
  const { schema: _schema, ...type } = parsedType;
  const column = {
    name,
    typeText: def.typeText,
    type,
    enum: catalog.enums.has(enumKey) ? enumKey : null,
    notNull: def.notNull,
    default: def.default,
    generated: def.generated,
  };
  if (inRun) column.newInRun = true;
  return column;
}

function addColumnTo(catalog, sql, statement, tableKey, name, from, to, inRun) {
  const table = catalog.tables.get(tableKey);
  if (!table) return false;
  const def = parseColumnDef(sql, statement, from, to);
  table.columns.set(name, columnEntry(catalog, table.schema, name, def, inRun));
  for (const inline of def.inline) {
    if (inline.kind === "primary")
      setConstraint(catalog, tableKey, `${table.name}_pkey`, { kind: "primary", columns: [name] });
    else if (inline.kind === "unique")
      setConstraint(catalog, tableKey, `${table.name}_${name}_key`, {
        kind: "unique",
        columns: [name],
      });
    else if (inline.kind === "foreign")
      setConstraint(catalog, tableKey, `${table.name}_${name}_fkey`, {
        kind: "foreign",
        columns: [name],
        references: inline.references,
        onDelete: inline.onDelete ?? "NO ACTION",
      });
    else if (inline.kind === "check")
      setConstraint(catalog, tableKey, `${table.name}_${name}_check`, {
        kind: "check",
        columns: [name],
      });
  }
  return true;
}

function setConstraint(catalog, tableKey, name, details) {
  const table = catalog.tables.get(tableKey);
  catalog.constraints.set(`${tableKey}:${name}`, { name, table: tableKey, ...details });
  if (details.kind === "primary" || details.kind === "unique") {
    catalog.indexes.set(`${table?.schema ?? "public"}.${name}`, {
      name,
      table: tableKey,
      columns: details.columns,
      unique: true,
      constraint: true,
    });
    if (details.kind === "primary")
      for (const column of details.columns) {
        const entry = table?.columns.get(column);
        if (entry) entry.notNull = true;
      }
  }
}

/** Parse a table constraint body at tokens[from, to) (after any CONSTRAINT name). */
function addTableConstraint(catalog, statement, tableKey, name, from, to) {
  const { tokens } = statement;
  const table = catalog.tables.get(tableKey);
  if (!table) return false;
  const head = kw(tokens[from]);
  if (head === "PRIMARY") {
    const columns = parenIdents(tokens, from + 2);
    setConstraint(catalog, tableKey, name ?? `${table.name}_pkey`, { kind: "primary", columns });
  } else if (head === "UNIQUE") {
    const open = tokens.indexOf("(", from);
    const columns = open >= 0 && open < to ? parenIdents(tokens, open) : [];
    setConstraint(catalog, tableKey, name ?? `${table.name}_${columns.join("_")}_key`, {
      kind: "unique",
      columns,
    });
  } else if (head === "CHECK") {
    const close = matchingParen(tokens, from + 1);
    const columns = [];
    for (let i = from + 2; i < close; i++)
      if (isIdentToken(tokens[i]) && tokens[i + 1] !== "(" && table.columns.has(ident(tokens[i])))
        columns.push(ident(tokens[i]));
    setConstraint(catalog, tableKey, name ?? `${table.name}_check`, { kind: "check", columns });
  } else if (head === "FOREIGN") {
    const columns = parenIdents(tokens, from + 2);
    const refAt = tokens.findIndex((t, i) => i > from && i < to && kw(t) === "REFERENCES");
    const target = refAt >= 0 ? qualifiedName(tokens, refAt + 1) : null;
    let onDelete = "NO ACTION";
    for (let i = refAt; i >= 0 && i < to; i++)
      if (kw(tokens[i]) === "ON" && kw(tokens[i + 1]) === "DELETE")
        onDelete = referentialAction(tokens, i + 2);
    setConstraint(catalog, tableKey, name ?? `${table.name}_${columns.join("_")}_fkey`, {
      kind: "foreign",
      columns,
      references: target ? `${target.schema}.${target.name}` : "",
      onDelete,
    });
  } else {
    setConstraint(catalog, tableKey, name ?? `${table.name}_constraint`, {
      kind: head === "EXCLUDE" ? "exclude" : "other",
      columns: [],
    });
  }
  return true;
}

function dropColumnFrom(catalog, tableKey, column) {
  catalog.tables.get(tableKey)?.columns.delete(column);
  for (const [key, constraint] of catalog.constraints)
    if (constraint.table === tableKey && constraint.columns.includes(column))
      catalog.constraints.delete(key);
  for (const [key, index] of catalog.indexes)
    if (index.table === tableKey && index.columns.includes(column)) catalog.indexes.delete(key);
}

function parseCreateEnum(sql, statement) {
  const { tokens } = statement;
  const words = tokens.map(kw);
  if (words[0] !== "CREATE" || words[1] !== "TYPE") return null;
  const name = qualifiedName(tokens, 2);
  if (!name || words[name.next] !== "AS" || words[name.next + 1] !== "ENUM") return null;
  const open = name.next + 2;
  if (tokens[open] !== "(") return null;
  const close = matchingParen(tokens, open);
  const labels = [];
  for (let i = open + 1; i < close; i++)
    if (tokens[i] === "<literal>") labels.push(decodeLiteral(rawText(sql, statement, i, i + 1)));
  return { schema: name.schema, name: name.name, labels };
}

function foldStatement(catalog, sql, statement, inRun) {
  const { tokens } = statement;
  const words = tokens.map(kw);
  const unparsed = () => catalog.unparsed.push({ line: statement.line, text: statement.text });
  if (isWrapperStatement(statement)) return;
  if (
    ["BEGIN", "COMMIT", "SET", "SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"].includes(
      words[0],
    ) ||
    (words[0] === "COMMENT" && words[1] === "ON") ||
    (words[0] === "CREATE" && (words[1] === "SCHEMA" || words[1] === "EXTENSION"))
  )
    return;
  if (words[0] === "CREATE" && words[1] === "TABLE") {
    const index = words[2] === "IF" && words[3] === "NOT" && words[4] === "EXISTS" ? 5 : 2;
    const name = qualifiedName(tokens, index);
    if (!name || tokens[name.next] !== "(") return unparsed();
    const key = `${name.schema}.${name.name}`;
    if (index === 5 && catalog.tables.has(key)) return;
    catalog.tables.set(key, { schema: name.schema, name: name.name, columns: new Map() });
    for (const [from, to] of splitTopLevelRanges(
      tokens,
      name.next + 1,
      matchingParen(tokens, name.next),
    )) {
      const head = kw(tokens[from]);
      if (head === "CONSTRAINT")
        addTableConstraint(catalog, statement, key, ident(tokens[from + 1]), from + 2, to);
      else if (["PRIMARY", "UNIQUE", "FOREIGN", "CHECK", "EXCLUDE"].includes(head))
        addTableConstraint(catalog, statement, key, null, from, to);
      else if (head === "LIKE") unparsed();
      else if (isIdentToken(tokens[from]))
        addColumnTo(catalog, sql, statement, key, ident(tokens[from]), from + 1, to, inRun);
    }
    return;
  }
  if (words[0] === "DROP" && words[1] === "TABLE") {
    for (const key of dropTargets(tokens, 2)) {
      catalog.tables.delete(key);
      for (const [k, c] of catalog.constraints) if (c.table === key) catalog.constraints.delete(k);
      for (const [k, i] of catalog.indexes) if (i.table === key) catalog.indexes.delete(k);
    }
    return;
  }
  if (words[0] === "ALTER" && words[1] === "TABLE") {
    const parsedAlter = alterTable(tokens);
    if (!parsedAlter || !catalog.tables.has(parsedAlter.table)) return unparsed();
    const key = parsedAlter.table;
    let bad = false;
    for (const action of parsedAlter.actions) {
      const table = catalog.tables.get(key);
      const column = table?.columns.get(action.column);
      if (action.kind === "add-column") {
        if (!table?.columns.has(action.column))
          addColumnTo(
            catalog,
            sql,
            statement,
            key,
            action.column,
            action.defFrom,
            action.to,
            inRun,
          );
      } else if (action.kind === "drop-column") dropColumnFrom(catalog, key, action.column);
      else if (action.kind === "alter-type" && column) {
        const tail = tokens.slice(action.typeFrom, action.to);
        const stop = tail.findIndex((t) => ["USING", "COLLATE"].includes(kw(t)));
        const typeText = rawText(
          sql,
          statement,
          action.typeFrom,
          stop < 0 ? action.to : action.typeFrom + stop,
        );
        Object.assign(
          column,
          columnEntry(catalog, table.schema, column.name, { ...column, typeText }, false),
          column.newInRun ? { newInRun: true } : {},
        );
      } else if (action.kind === "alter-column" && column) {
        if (action.change === "set-default")
          column.default = rawText(sql, statement, action.exprFrom, action.to);
        else if (action.change === "drop-default") column.default = null;
        else column.notNull = action.change === "set-not-null";
      } else if (action.kind === "add-constraint")
        addTableConstraint(
          catalog,
          statement,
          key,
          action.constraint ?? null,
          action.bodyFrom,
          action.to,
        );
      else if (action.kind === "drop-constraint") {
        catalog.constraints.delete(`${key}:${action.constraint}`);
        catalog.indexes.delete(`${table?.schema}.${action.constraint}`);
      } else if (action.kind === "rename-column" && column) {
        table.columns.delete(action.column);
        table.columns.set(action.to, { ...column, name: action.to });
        for (const c of catalog.constraints.values())
          if (c.table === key)
            c.columns = c.columns.map((n) => (n === action.column ? action.to : n));
        for (const i of catalog.indexes.values())
          if (i.table === key)
            i.columns = i.columns.map((n) => (n === action.column ? action.to : n));
      } else if (action.kind === "rename-table" && table) {
        const next = `${parsedAlter.schema}.${action.to}`;
        catalog.tables.delete(key);
        catalog.tables.set(next, { ...table, name: action.to });
        for (const c of catalog.constraints.values()) {
          if (c.table === key) c.table = next;
          if (c.references === key) c.references = next;
        }
        for (const i of catalog.indexes.values()) if (i.table === key) i.table = next;
        return;
      } else bad = true;
    }
    if (bad) unparsed();
    return;
  }
  if (
    words[0] === "CREATE" &&
    (words[1] === "INDEX" || (words[1] === "UNIQUE" && words[2] === "INDEX"))
  ) {
    const unique = words[1] === "UNIQUE";
    let i = unique ? 3 : 2;
    if (words[i] === "CONCURRENTLY") i++;
    const ifNotExists = words[i] === "IF" && words[i + 1] === "NOT" && words[i + 2] === "EXISTS";
    if (ifNotExists) i += 3;
    let indexName = null;
    if (words[i] !== "ON") {
      indexName = qualifiedName(tokens, i);
      if (!indexName) return unparsed();
      i = indexName.next;
    }
    if (words[i] !== "ON") return unparsed();
    i++;
    if (words[i] === "ONLY") i++;
    const target = qualifiedName(tokens, i);
    if (!target) return unparsed();
    i = target.next;
    if (words[i] === "USING") i += 2;
    if (tokens[i] !== "(") return unparsed();
    const columns = splitTopLevelRanges(tokens, i + 1, matchingParen(tokens, i)).map(([from]) =>
      isIdentToken(tokens[from]) && tokens[from + 1] !== "(" ? ident(tokens[from]) : "(expression)",
    );
    const tableKey = `${target.schema}.${target.name}`;
    const name = indexName?.name ?? `${target.name}_${columns.join("_")}_idx`;
    const key = `${target.schema}.${name}`;
    if (ifNotExists && catalog.indexes.has(key)) return;
    catalog.indexes.set(key, { name, table: tableKey, columns, unique });
    return;
  }
  if (words[0] === "DROP" && words[1] === "INDEX") {
    for (const key of dropTargets(tokens, words[2] === "CONCURRENTLY" ? 3 : 2))
      catalog.indexes.delete(key);
    return;
  }
  if (words[0] === "CREATE" && words[1] === "TYPE") {
    const created = parseCreateEnum(sql, statement);
    if (!created) return unparsed();
    catalog.enums.set(`${created.schema}.${created.name}`, created);
    return;
  }
  if (words[0] === "ALTER" && words[1] === "TYPE") {
    const name = qualifiedName(tokens, 2);
    const key = name ? `${name.schema}.${name.name}` : "";
    const entry = catalog.enums.get(key);
    if (!name || !entry) return unparsed();
    const rest = words.slice(name.next);
    const at = name.next;
    if (rest[0] === "ADD" && rest[1] === "VALUE") {
      let i = at + 2;
      const ifNotExists = rest[2] === "IF";
      if (ifNotExists) i += 3;
      const label = decodeLiteral(rawText(sql, statement, i, i + 1));
      if (entry.labels.includes(label)) return;
      const anchor = words[i + 1];
      const other = anchor ? decodeLiteral(rawText(sql, statement, i + 2, i + 3)) : null;
      const position = other === null ? -1 : entry.labels.indexOf(other);
      if (position < 0) entry.labels.push(label);
      else entry.labels.splice(anchor === "BEFORE" ? position : position + 1, 0, label);
    } else if (rest[0] === "RENAME" && rest[1] === "TO") {
      const to = ident(tokens[at + 2]);
      const next = `${name.schema}.${to}`;
      catalog.enums.delete(key);
      catalog.enums.set(next, { ...entry, name: to });
      for (const table of catalog.tables.values())
        for (const column of table.columns.values())
          if (column.enum === key) {
            column.enum = next;
            column.type = { ...column.type, base: to };
            column.typeText = `${quoteIdent(to)}${column.type.array ? "[]" : ""}`;
          }
    } else if (rest[0] === "RENAME" && rest[1] === "VALUE") {
      const from = decodeLiteral(rawText(sql, statement, at + 2, at + 3));
      const to = decodeLiteral(rawText(sql, statement, at + 4, at + 5));
      entry.labels = entry.labels.map((label) => (label === from ? to : label));
    } else unparsed();
    return;
  }
  if (words[0] === "DROP" && words[1] === "TYPE") {
    for (const key of dropTargets(tokens, 2)) catalog.enums.delete(key);
    return;
  }
  unparsed();
}

/**
 * Fold SQL (one file or files in apply order) onto an optional starting
 * catalog: tables and columns (normalized type, NOT NULL, default), PK /
 * unique / CHECK / FK constraints, indexes, enum labels. Columns created by
 * this fold get `newInRun` when a starting catalog is given (§1.6). Anything
 * it cannot model lands in `catalog.unparsed`.
 * @param {string | string[]} input
 * @param {ReturnType<typeof emptyCatalog>} [start]
 */
export function catalogFromSql(input, start) {
  const catalog = start ? cloneCatalog(start) : emptyCatalog();
  for (const sql of Array.isArray(input) ? input : [input]) {
    let parsed;
    try {
      parsed = splitStatements(sql);
    } catch (error) {
      catalog.unparsed.push({ line: 1, text: `whole file: ${error.message}` });
      continue;
    }
    for (const statement of parsed) foldStatement(catalog, sql, statement, Boolean(start));
  }
  return catalog;
}

/**
 * Every column of type E or E[] in the catalog, table order then column order.
 * @returns {Array<{ table: string, tableName: string, column: string, array: boolean, default: string | null }>}
 */
export function enumColumns(catalog, enumName) {
  const key = resolveEnumKey(catalog, enumName);
  const out = [];
  for (const [tableKey, table] of catalog.tables)
    for (const column of table.columns.values())
      if (column.enum === key)
        out.push({
          table: tableKey,
          tableName: table.name,
          column: column.name,
          array: column.type.array,
          default: column.default,
        });
  return out;
}

/** `typeOf` for analyzeMigration, backed by a catalog fold. */
export function typeOfFromCatalog(catalog) {
  return (table, column) => {
    const entry = catalog.tables.get(table)?.columns.get(column);
    return entry ? { type: entry.type, newInRun: Boolean(entry.newInRun) } : undefined;
  };
}

// --- enum defaults ----------------------------------------------------------

function parseArrayLiteral(text) {
  const inner = text.trim().replace(/^\{/, "").replace(/\}$/, "");
  if (!inner) return [];
  const out = [];
  let i = 0;
  while (i < inner.length) {
    let value = "";
    if (inner[i] === '"') {
      i++;
      while (i < inner.length && inner[i] !== '"') {
        if (inner[i] === "\\") i++;
        value += inner[i++];
      }
      i++;
    } else {
      while (i < inner.length && inner[i] !== ",") value += inner[i++];
      value = value.trim();
    }
    out.push(value);
    while (i < inner.length && inner[i] !== ",") i++;
    i++;
  }
  return out;
}

/**
 * The labels an enum default names: `'A'`, `'A'::"E"`, `ARRAY['A','B']::"E"[]`,
 * `ARRAY['A'::"E"]` (pg_get_expr), `'{A,B}'::"E"[]`. Null when the
 * expression is not a plain literal form.
 * @returns {{ array: boolean, labels: string[] } | null}
 */
function enumDefaultValue(expr) {
  if (expr === null || expr === undefined) return null;
  let statement;
  try {
    [statement] = splitStatements(String(expr));
  } catch {
    return null;
  }
  if (!statement || statement.tokens.includes("(")) return null;
  const literals = [];
  for (const [i, token] of statement.tokens.entries())
    if (token === "<literal>")
      literals.push(decodeLiteral(rawText(String(expr), statement, i, i + 1)));
  const words = statement.tokens.map(kw);
  const array = words.includes("ARRAY") || statement.tokens.includes("[");
  if (literals.length === 1 && array && !words.includes("ARRAY") && literals[0].startsWith("{"))
    return { array: true, labels: parseArrayLiteral(literals[0]) };
  if (!literals.length && words[0] !== "NULL") return null;
  return { array, labels: literals };
}

/**
 * Which of `removed` an enum default expression names (generator header
 * rules, runner 7c-5).
 * @param {string | null} exprText
 * @param {string[]} removed
 */
export function enumDefaultNamesRemoved(exprText, removed) {
  if (exprText === null || exprText === undefined) return [];
  const value = enumDefaultValue(exprText);
  let labels = value?.labels;
  if (!labels) {
    labels = [];
    try {
      for (const statement of splitStatements(String(exprText)))
        for (const [i, token] of statement.tokens.entries())
          if (token === "<literal>")
            labels.push(decodeLiteral(rawText(String(exprText), statement, i, i + 1)));
    } catch {
      return [...removed];
    }
  }
  return removed.filter((label) => labels.includes(label));
}

function sameDefault(a, b) {
  if ((a ?? null) === null || (b ?? null) === null) return (a ?? null) === (b ?? null);
  const left = enumDefaultValue(a);
  const right = enumDefaultValue(b);
  if (left && right)
    return left.array === right.array && left.labels.join("\0") === right.labels.join("\0");
  return normalizeSql(a) === normalizeSql(b);
}

// --- Prisma's enum rebuild (Step 0 b) --------------------------------------

/** A one-action `ALTER TABLE`, or null. */
function singleAlter(statement) {
  const words = statement?.tokens.map(kw) ?? [];
  if (words[0] !== "ALTER" || words[1] !== "TABLE") return null;
  const parsed = alterTable(statement.tokens);
  if (parsed?.actions.length !== 1) return null;
  return { table: parsed.table, action: parsed.actions[0] };
}

function alterTypeRename(statement) {
  const words = statement?.tokens.map(kw) ?? [];
  if (words[0] !== "ALTER" || words[1] !== "TYPE") return null;
  const name = qualifiedName(statement.tokens, 2);
  if (!name || words[name.next] !== "RENAME" || words[name.next + 1] !== "TO") return null;
  if (statement.tokens.length !== name.next + 3) return null;
  return { key: `${name.schema}.${name.name}`, to: ident(statement.tokens[name.next + 2]) };
}

const isBare = (statement, word) =>
  statement?.tokens.length === 1 && kw(statement.tokens[0]) === word;

function findEnumRebuildsIn(sql, parsed) {
  const blocks = [];
  for (let k = 0; k < parsed.length; k++) {
    const created = parseCreateEnum(sql, parsed[k]);
    if (!created?.name.endsWith("_new")) continue;
    const base = created.name.slice(0, -4);
    const enumKey = `${created.schema}.${base}`;
    const newKey = `${created.schema}.${created.name}`;
    const dropDefaults = [];
    const columns = [];
    const setDefaults = [];
    let j = k + 1;
    for (; j < parsed.length; j++) {
      const one = singleAlter(parsed[j]);
      if (one?.action.change !== "drop-default") break;
      dropDefaults.push({ table: one.table, column: one.action.column });
    }
    for (; j < parsed.length; j++) {
      const one = singleAlter(parsed[j]);
      if (one?.action.kind !== "alter-type") break;
      const clause = typeClause(parsed[j].tokens.slice(one.action.typeFrom, one.action.to));
      const type = parseTypeText(clause.type);
      if (`${type.schema ?? created.schema}.${type.base}` !== newKey || !clause.using) break;
      columns.push({ table: one.table, column: one.action.column, array: type.array });
    }
    const first = alterTypeRename(parsed[j]);
    if (first?.key !== enumKey || first.to !== `${base}_old`) continue;
    const second = alterTypeRename(parsed[j + 1]);
    if (second?.key !== newKey || second.to !== base) continue;
    const dropped = parsed[j + 2];
    const droppedWords = dropped?.tokens.map(kw) ?? [];
    if (
      droppedWords[0] !== "DROP" ||
      droppedWords[1] !== "TYPE" ||
      dropTargets(dropped.tokens, 2).join() !== `${created.schema}.${base}_old`
    )
      continue;
    j += 3;
    const opened = k > 0 && isBare(parsed[k - 1], "BEGIN");
    for (; j < parsed.length; j++) {
      const one = singleAlter(parsed[j]);
      if (one?.action.change !== "set-default") break;
      if (!opened && !columns.some((c) => c.table === one.table && c.column === one.action.column))
        break;
      setDefaults.push({
        table: one.table,
        column: one.action.column,
        expr: rawText(sql, parsed[j], one.action.exprFrom, one.action.to),
        text: parsed[j].text,
      });
    }
    if (opened && !isBare(parsed[j], "COMMIT")) continue;
    const start = opened ? k - 1 : k;
    const end = opened ? j : j - 1;
    blocks.push({
      enum: { key: enumKey, schema: created.schema, name: base },
      newLabels: created.labels,
      columns,
      dropDefaults,
      setDefaults,
      start,
      end,
      from: parsed[start].start,
      to: parsed[end].end,
    });
    k = end;
  }
  return blocks;
}

/**
 * Recognize Prisma 7.10's enum value-removal rebuild in a diff (verified text,
 * Step 0 b): optional `BEGIN;`, `CREATE TYPE "E_new" AS ENUM (…)`, one
 * `ALTER COLUMN … DROP DEFAULT` per defaulted column (schema-qualified table),
 * one `ALTER COLUMN … TYPE "E_new"[[]] USING (…)` per column, the two
 * renames, `DROP TYPE "<schema>"."E_old"`, then one `SET DEFAULT` per
 * defaulted column (Prisma writes the TARGET default), and `COMMIT;`.
 * Adding labels in the same diff is folded into the same rebuild (no ADD VALUE).
 * @param {string} sql
 */
export function findEnumRebuilds(sql) {
  return findEnumRebuildsIn(sql, splitStatements(sql));
}

/**
 * Classify one recognized rebuild block against the "from" catalog (§1.3,
 * R4-2). `kept-only`: every label it removes may legitimately linger, and the
 * block is otherwise exactly the catalog (label order, column set, defaults);
 * `mixed`: it removes some allowed and some new labels (`newRemoved` = the
 * new ones); `new` otherwise (`newRemoved` = everything it removes).
 * @param {ReturnType<typeof findEnumRebuilds>[number]} block
 * @param {ReturnType<typeof emptyCatalog>} catalog
 * @param {Iterable<string>} allowedKept
 * @returns {{ kind: "kept-only" | "mixed" | "new", removed: string[], newRemoved: string[], added: string[] }}
 */
export function classifyEnumRebuild(block, catalog, allowedKept) {
  const key = resolveEnumKey(catalog, block.enum.key);
  const labels = catalog.enums.get(key)?.labels ?? [];
  const removed = labels.filter((label) => !block.newLabels.includes(label));
  const added = block.newLabels.filter((label) => !labels.includes(label));
  const allowed = new Set(allowedKept);
  const fresh = removed.filter((label) => !allowed.has(label));
  const columnKey = (c) => `${c.table}\0${c.column}\0${c.array ? "[]" : ""}`;
  const blockColumns = new Set(block.columns.map(columnKey));
  const catalogColumns = enumColumns(catalog, key);
  const sameColumns =
    blockColumns.size === block.columns.length &&
    blockColumns.size === catalogColumns.length &&
    catalogColumns.every((c) => blockColumns.has(columnKey(c)));
  const kept = labels.filter((label) => !removed.includes(label));
  const sameOrder =
    kept.length === block.newLabels.length &&
    kept.every((label, i) => block.newLabels[i] === label);
  const defaultsUnchanged = block.setDefaults.every((set) => {
    const column = catalog.tables.get(set.table)?.columns.get(set.column);
    return column !== undefined && sameDefault(column.default, set.expr);
  });
  if (
    removed.length &&
    !fresh.length &&
    !added.length &&
    sameOrder &&
    sameColumns &&
    defaultsUnchanged
  )
    return { kind: "kept-only", removed, newRemoved: [], added };
  if (fresh.length && fresh.length < removed.length)
    return { kind: "mixed", removed, newRemoved: fresh, added };
  return { kind: "new", removed, newRemoved: removed, added };
}

/** The C4-3 note for a kept label filtered out of a diff. */
export function keptLabelNote(enumName, label) {
  return `${enumName}.${label} is kept unused in databases where something used the column when its deletion ran; it is harmless and is never offered to the app.`;
}

/**
 * Refusal for one diff that removes values from more than one enum (R5-6,
 * R6-5): the first enum by name stays; the values of the others go back.
 * @param {Array<{ enumName: string, removed: string[] }>} removals
 */
export function multiEnumRefusal(removals) {
  const sorted = [...removals].sort((a, b) =>
    a.enumName < b.enumName ? -1 : a.enumName > b.enumName ? 1 : 0,
  );
  const names = sorted.map((r) => r.enumName);
  const putBack = sorted
    .slice(1)
    .flatMap((r) => r.removed.map((label) => `${r.enumName}.${label}`));
  return `This change removes values from more than one enum (${names.join(", ")}). One migration may remove values from one enum only. Keep the ${names[0]} change and put these values back in the schema: ${putBack.join(", ")}. Run \`pnpm db:migrate\`, then remove them again and run \`pnpm db:migrate\` once more${sorted.length > 2 ? " (repeat until each migration removes values from one enum)" : ""}. All of these migrations can ship in one PR.`;
}

// --- relax (§1.4.1) ---------------------------------------------------------

function sentinelFor(column, catalog, removedLabels) {
  if (column.type.array) return "'{}'";
  if (column.enum) {
    const labels = catalog.enums.get(column.enum)?.labels ?? [];
    const removed = removedLabels.get(column.enum) ?? [];
    const first = labels.find((label) => !removed.includes(label));
    return first === undefined ? null : sqlLiteral(first);
  }
  switch (column.type.base) {
    case "text":
    case "varchar":
    case "bpchar":
      return "''";
    case "int2":
    case "int4":
    case "int8":
    case "numeric":
    case "float4":
    case "float8":
      return "0";
    case "bool":
      return "false";
    case "timestamp":
    case "timestamptz":
    case "date":
      return "'1970-01-01'";
    case "time":
    case "timetz":
      return "'00:00'";
    case "json":
    case "jsonb":
      return "'{}'";
    case "bytea":
      return "'\\x'";
    case "uuid":
      return "'00000000-0000-0000-0000-000000000000'";
    default:
      return null;
  }
}

function constraintRoles(catalog, tableKey, column) {
  const roles = new Set();
  for (const c of catalog.constraints.values())
    if (c.table === tableKey && c.columns.includes(column)) roles.add(c.kind);
  for (const index of catalog.indexes.values())
    if (index.table === tableKey && index.unique && index.columns.includes(column))
      roles.add("unique");
  return roles;
}

/**
 * What old code needs so it can keep inserting after `tableKey.column` stops
 * existing in the new release's schema (§1.4.1). Null when nothing is needed
 * (nullable or defaulted); `{ refuse }` for a primary-key column; otherwise
 * `{ text }`, the marked relax statement for migration.sql.
 * @param {ReturnType<typeof emptyCatalog>} catalog
 * @param {string} tableKey "schema.table"
 * @param {string} column
 * @param {{ removedLabels?: Map<string, string[]> }} [options] labels this
 *   migration removes, per enum key (never used as a sentinel).
 */
export function relaxFor(catalog, tableKey, column, { removedLabels = new Map() } = {}) {
  const table = catalog.tables.get(tableKey);
  const entry = table?.columns.get(column);
  const tableName = table?.name ?? tableKey.split(".").slice(1).join(".");
  if (!entry) return { text: relax({ table: tableName, column, sentinel: null }) };
  const roles = constraintRoles(catalog, tableKey, column);
  if (roles.has("primary"))
    return {
      refuse: `${quoteIdent(tableName)}.${quoteIdent(column)} is part of the primary key; removing it in place is unsupported. ${PK_CHANGE_RECIPE}`,
    };
  if (!entry.notNull || entry.default !== null) return null;
  const sentinel =
    roles.has("foreign") || roles.has("check") || roles.has("unique")
      ? null
      : sentinelFor(entry, catalog, removedLabels);
  return { text: relax({ table: tableName, column, sentinel }) };
}

// --- split (§1.4) -----------------------------------------------------------

/**
 * Split a Prisma diff (from migrations + contracts to the schema) into
 * migration.sql (expand) and contract.sql (contract) statements (§1.4). Pure:
 * the generator writes the files.
 * @param {string} sql the diff (Prisma's `--script` output, kept-only blocks still in)
 * @param {ReturnType<typeof emptyCatalog>} catalog static pre-change catalog
 * @param {{ folder?: string, remap?: Record<string, string> | Map<string, string>,
 *   allowedKept?: Record<string, string[]> | Map<string, string[]>,
 *   recover?: Array<{ table: string, from: string, to: string }>,
 *   retiredColumns?: Map<string, NormalizedType | string> }} [flags]
 *   remap: "E.OLD" → NEW; allowedKept: enum name → labels an existing
 *   contract.sql header removes; retiredColumns: "schema.table.column"
 *   retired by an existing contract → its type (for --recover).
 */
export function splitForContract(sql, catalog, flags = {}) {
  const out = {
    /** @type {string[]} */ migration: [],
    /** @type {string[]} */ contract: [],
    /** @type {string[]} */ refusals: [],
    /** @type {string[]} */ warnings: [],
    /** @type {string[]} */ notes: [],
    /** @type {EnumRemoveHeader | null} */ enumRemoval: null,
  };
  let parsed;
  try {
    parsed = splitStatements(sql);
  } catch (error) {
    out.refusals.push(`the schema diff could not be read (${error.message})`);
    return out;
  }
  const lookup = (source, key) =>
    source instanceof Map ? source.get(key) : source ? source[key] : undefined;
  const blocks = findEnumRebuildsIn(sql, parsed);
  const blockAt = new Map(blocks.map((block) => [block.start, block]));
  const inBlock = new Set(
    blocks.flatMap((b) => Array.from({ length: b.end - b.start + 1 }, (_, i) => b.start + i)),
  );

  const retiredTables = new Set();
  const retiredColumns = new Set();
  const addedColumns = new Map();
  const enumSetDefaults = [];
  for (const [index, statement] of parsed.entries()) {
    if (inBlock.has(index)) continue;
    const words = statement.tokens.map(kw);
    if (words[0] === "DROP" && words[1] === "TABLE")
      for (const key of dropTargets(statement.tokens, 2)) retiredTables.add(key);
    if (words[0] !== "ALTER" || words[1] !== "TABLE") continue;
    const parsedAlter = alterTable(statement.tokens);
    for (const action of parsedAlter?.actions ?? []) {
      const key = `${parsedAlter.table}.${action.column}`;
      if (action.kind === "drop-column") retiredColumns.add(key);
      else if (action.kind === "add-column")
        addedColumns.set(key, parseColumnDef(sql, statement, action.defFrom, action.to));
      else if (action.change === "set-default")
        enumSetDefaults.push({
          table: parsedAlter.table,
          column: action.column,
          expr: rawText(sql, statement, action.exprFrom, action.to),
        });
    }
  }

  // Enum removals (§1.3, §1.5).
  const removals = [];
  for (const block of blocks) {
    const allowed = lookup(flags.allowedKept, block.enum.name) ?? [];
    const verdict = classifyEnumRebuild(block, catalog, allowed);
    if (verdict.kind === "kept-only") {
      for (const label of verdict.removed) out.notes.push(keptLabelNote(block.enum.name, label));
      continue;
    }
    removals.push({ block, verdict });
  }
  const removedLabels = new Map(removals.map((r) => [r.block.enum.key, r.verdict.removed]));
  const blockTexts = new Map();
  let contractTemplate = null;
  if (removals.length > 1)
    out.refusals.push(
      multiEnumRefusal(
        removals.map((r) => ({ enumName: r.block.enum.name, removed: r.verdict.newRemoved })),
      ),
    );
  else if (removals.length === 1) {
    const { block, verdict } = removals[0];
    const name = block.enum.name;
    const baseLabels = catalog.enums.get(resolveEnumKey(catalog, block.enum.key))?.labels ?? [];
    const before = out.refusals.length;
    if (verdict.added.length)
      out.refusals.push(
        `This change adds ${verdict.added.map((l) => `${name}.${l}`).join(", ")} and removes ${verdict.removed.map((l) => `${name}.${l}`).join(", ")} in the same migration. Add the new value in an earlier PR, then remove the old one.`,
      );
    const pairs = [];
    for (const label of verdict.newRemoved) {
      const to = lookup(flags.remap, `${name}.${label}`);
      if (to === undefined)
        out.refusals.push(
          `${name}.${label} is removed, so existing rows need another value. Ask the user which value existing rows become, then pass --remap '${name}.${label}=<VALUE>'.`,
        );
      else if (!baseLabels.includes(to) || verdict.removed.includes(to))
        out.refusals.push(
          `--remap '${name}.${label}=${to}': ${to} must be a value ${name} already has and keeps.`,
        );
      else pairs.push({ from: label, to });
    }
    const columns = enumColumns(catalog, block.enum.key);
    const sets = [...block.setDefaults, ...enumSetDefaults];
    for (const set of sets) {
      const named = enumDefaultNamesRemoved(set.expr, verdict.removed);
      if (named.length && columns.some((c) => c.table === set.table && c.column === set.column))
        out.refusals.push(
          `The new default of ${display(set.table)}."${set.column}" names the removed value ${named.join(", ")}.`,
        );
    }
    for (const column of columns)
      if (
        enumDefaultNamesRemoved(column.default, verdict.removed).length &&
        !sets.some((s) => s.table === column.table && s.column === column.column)
      )
        out.refusals.push(
          `${display(column.table)}."${column.column}" defaults to a removed value; give it a new default in the schema.`,
        );
    if (!flags.folder) out.refusals.push("internal: the migration folder name is required");
    if (out.refusals.length === before) {
      const header = {
        version: LATEST_TEMPLATE_VERSION,
        enumName: name,
        pairs,
        columns: columns.map((c) => ({ table: c.tableName, column: c.column, array: c.array })),
        folder: flags.folder,
      };
      blockTexts.set(block.start, [
        enumRemoveExpand(header),
        ...block.setDefaults.map((s) => s.text),
      ]);
      contractTemplate = enumRemoveContract(header);
      out.enumRemoval = header;
      // The expand UPDATE moves rows from each removed value to its target in
      // place; on a unique or primary-key column a row holding the target
      // with the same other key values makes it fail with 23505 at deploy.
      for (const column of columns) {
        const roles = constraintRoles(catalog, column.table, column.column);
        if (!roles.has("primary") && !roles.has("unique")) continue;
        out.warnings.push(
          `${display(column.table)}."${column.column}" is ${roles.has("primary") ? "part of the primary key" : "unique"}. If a row holding ${pairs.map((p) => `"${p.from}"`).join(" or ")} and a row holding ${[...new Set(pairs.map((p) => `"${p.to}"`))].join(" or ")} would collide once moved, this migration fails at deploy (nothing is applied). Merge or delete those rows in an earlier migration first.`,
        );
      }
    }
  }

  const contract = [];
  const lead = new Map();
  const emit = (target, statement, text) => {
    const seen = lead.get(statement) ?? new Set();
    const comments = seen.has(target) ? [] : statement.comments;
    seen.add(target);
    lead.set(statement, seen);
    (target === "contract" ? contract : out.migration).push([...comments, text].join("\n"));
  };
  for (let index = 0; index < parsed.length; index++) {
    const statement = parsed[index];
    const block = blockAt.get(index);
    if (block) {
      out.migration.push(...(blockTexts.get(index) ?? []));
      index = block.end;
      continue;
    }
    if (isBare(statement, "BEGIN") || isBare(statement, "COMMIT")) continue;
    const { tokens } = statement;
    const words = tokens.map(kw);
    if (words[0] === "DROP" && (words[1] === "TABLE" || words[1] === "TYPE")) {
      emit("contract", statement, statement.text);
    } else if (words[0] === "DROP" && words[1] === "INDEX") {
      const keys = dropTargets(tokens, words[2] === "CONCURRENTLY" ? 3 : 2);
      const indexes = keys.map((key) => catalog.indexes.get(key));
      const retired = indexes.some(
        (i) =>
          i &&
          (retiredTables.has(i.table) ||
            i.columns.some((c) => retiredColumns.has(`${i.table}.${c}`))),
      );
      if (retired) emit("contract", statement, statement.text);
      else {
        emit("migration", statement, statement.text);
        for (const i of indexes)
          if (i?.unique) out.warnings.push(uniqueDropWarning(i.table, i.columns, i.name));
      }
    } else if (words[0] === "ALTER" && words[1] === "TYPE") {
      const rest = words.slice(qualifiedName(tokens, 2)?.next ?? 2);
      if (rest[0] === "RENAME")
        out.refusals.push(
          `${statement.text} renames an enum${rest[1] === "VALUE" ? " value" : ""}. Keep the database name with @map / @@map instead.`,
        );
      else emit("migration", statement, statement.text);
    } else if (words[0] === "ALTER" && words[1] === "TABLE") {
      const parsedAlter = alterTable(tokens);
      if (!parsedAlter) {
        emit("migration", statement, statement.text);
        continue;
      }
      const prefix = rawText(sql, statement, 0, parsedAlter.actions[0]?.nameTo ?? 0);
      const single = parsedAlter.actions.length === 1;
      const table = parsedAlter.table;
      const routeAction = (action) => {
        const columnKey = `${table}.${action.column}`;
        if (action.kind === "drop-column") {
          const roles = constraintRoles(catalog, table, action.column);
          if (roles.has("primary") && !retiredTables.has(table)) {
            out.refusals.push(
              `${display(table)}."${action.column}" is part of the primary key; removing it in place is unsupported. ${PK_CHANGE_RECIPE}`,
            );
            return null;
          }
          const relaxed = relaxFor(catalog, table, action.column, { removedLabels });
          if (relaxed?.refuse) out.refusals.push(relaxed.refuse);
          else if (relaxed) {
            out.migration.push(relaxed.text);
            if (relaxed.text.endsWith("DROP NOT NULL;"))
              out.warnings.push(
                `Column "${action.column}" of ${display(table)} has no safe placeholder (it is a foreign key, unique, checked, or of an unsupported type), so it loses NOT NULL until its deletion runs. Older code may fail on the NULLs the new release writes, so this migration is recorded as not rollback-safe.`,
              );
          }
          const added = [...addedColumns.keys()].find((key) => key.startsWith(`${table}.`));
          if (added && !statement.comments.includes(INTENTIONAL_MARKER))
            out.warnings.push(
              `Column "${action.column}" is dropped and "${added.slice(table.length + 1)}" is added on table ${display(table)}: this looks like a rename. Keep the old column name with @map instead (CI fails this unless "${INTENTIONAL_MARKER}" is on the line above the statement).`,
            );
          return "contract";
        }
        if (action.kind === "drop-constraint") {
          const constraint = catalog.constraints.get(`${table}:${action.constraint}`);
          const tableRetired = retiredTables.has(table);
          const columnRetired = constraint?.columns.some((c) =>
            retiredColumns.has(`${table}.${c}`),
          );
          if (constraint?.kind === "primary") {
            if (tableRetired) return "contract";
            out.refusals.push(
              `${statement.text} drops or changes the primary key of ${display(table)}; that is unsupported in place. ${PK_CHANGE_RECIPE}`,
            );
            return null;
          }
          if (constraint?.kind === "foreign") {
            const onDelete = constraint.onDelete ?? "NO ACTION";
            if (tableRetired)
              return ["CASCADE", "SET NULL", "SET DEFAULT"].includes(onDelete)
                ? "contract"
                : "migration";
            if (columnRetired) return onDelete === "SET NULL" ? "contract" : "migration";
            return "migration";
          }
          if (tableRetired || columnRetired) return "contract";
          if (constraint?.kind === "unique")
            out.warnings.push(uniqueDropWarning(table, constraint.columns, constraint.name));
          return "migration";
        }
        if (action.kind === "rename-table") {
          out.refusals.push(
            `${display(table)} is renamed to "${action.to}". Keep the database name with @@map instead.`,
          );
          return null;
        }
        if (action.kind === "rename-column" && !addedColumns.has(columnKey))
          out.warnings.push(
            `${display(table)}."${action.column}" is renamed: the running release breaks. Keep the database name with @map instead (docs/schema-changes-recipe.md, Recipe 3).`,
          );
        if (action.kind === "alter-type" && catalog.tables.get(table)?.columns.has(action.column)) {
          const before = catalog.tables.get(table).columns.get(action.column);
          const { type, using } = typeClause(tokens.slice(action.typeFrom, action.to));
          if (!before.newInRun && !isWidening(before.type, normalizeType(type), { using }))
            out.warnings.push(
              `${display(table)}."${action.column}" changes type in place: the running release breaks. Use the two-PR recipe (docs/schema-changes-recipe.md, Recipe 5).`,
            );
        }
        return "migration";
      };
      for (const action of parsedAlter.actions) {
        const text = single
          ? statement.text
          : `${prefix} ${rawText(sql, statement, action.from, action.to)};`;
        const route = routeAction(action);
        if (route) emit(route, statement, text);
      }
    } else emit("migration", statement, statement.text);
  }

  for (const spec of flags.recover ?? []) {
    const tableKey = spec.table.includes(".") ? spec.table : `public.${spec.table}`;
    const added = addedColumns.get(`${tableKey}.${spec.to}`);
    const retired = flags.retiredColumns?.get(`${tableKey}.${spec.from}`);
    const tableName = tableKey.split(".").slice(1).join(".");
    if (!added)
      out.refusals.push(
        `--recover: "${spec.to}" must be a new column added on ${display(tableKey)} in this change.`,
      );
    else if (retired === undefined)
      out.refusals.push(
        `--recover: ${display(tableKey)}."${spec.from}" is not retired by an existing contract.sql.`,
      );
    else {
      const from = typeof retired === "string" ? normalizeType(retired) : retired;
      const to = normalizeType(added.typeText);
      if (JSON.stringify(from) !== JSON.stringify(to))
        out.refusals.push(
          `--recover: "${spec.to}" (${added.typeText}) must have the same type as ${display(tableKey)}."${spec.from}".`,
        );
      else out.migration.push(recoverBlock({ table: tableName, from: spec.from, to: spec.to }));
    }
  }
  out.contract = contractTemplate ? [contractTemplate, ...contract] : contract;
  return out;
}

function uniqueDropWarning(table, columns, name) {
  return `Dropping the unique index "${name}" on ${display(table)} (${columns.map((c) => `"${c}"`).join(", ")}) keeps the column, and the previous release can no longer roll back to this database. If any code upserts or connectOrCreate's by this field, remove those calls in an earlier PR (docs/schema-changes-recipe.md, Recipe 5).`;
}

// --- contract analysis (runner 7c-2, CI check 5) ----------------------------

/**
 * Everything wrong with a contract.sql. Allowed: plain drops of tables,
 * columns, indexes, constraints and types (no CASCADE), and the recognized
 * enum `DO` template of a known version, which must come first (at most one).
 * @param {string} sql
 * @param {{ folder?: string }} [options]
 * @returns {{ findings: Array<{ line: number, message: string }>, template: EnumRemoveHeader | null,
 *   drops: Array<{ kind: string, target: string }> }}
 */
export function analyzeContract(sql, options = {}) {
  const result = { findings: [], template: null, drops: [] };
  let parsed;
  try {
    parsed = splitStatements(sql);
  } catch (error) {
    result.findings.push({
      line: 1,
      message: `contract.sql could not be lexed (${error.message})`,
    });
    return result;
  }
  const recognized = recognizeTemplates(sql, parsed, { folder: options.folder, file: "contract" });
  const reject = (statement, message) => result.findings.push({ line: statement.line, message });
  for (const [index, statement] of parsed.entries()) {
    if (
      statement.comments.some((c) => c === REVIEWED_MARKER || c.startsWith(`${REVIEWED_MARKER} `))
    )
      reject(statement, `"${REVIEWED_MARKER}" is not allowed in ${CONTRACT_FILE}`);
    const problem = recognized.problems.get(index);
    if (problem) {
      reject(
        statement,
        /^template v\d+ not known/.test(problem)
          ? `${problem.replace(/ \(.*\)$/, "")}: deploy a newer image`
          : problem,
      );
      continue;
    }
    if (recognized.covered.has(index)) {
      const template = recognized.templates.find((t) => t.index === index);
      if (template?.file !== "contract" || template.kind !== "enum-remove")
        reject(
          statement,
          `the ${template?.kind ?? "template"} block does not belong in ${CONTRACT_FILE}`,
        );
      else if (result.template)
        reject(statement, `more than one enum-remove block in ${CONTRACT_FILE}`);
      else if (index !== 0)
        reject(statement, `the enum-remove block must be the first statement of ${CONTRACT_FILE}`);
      else result.template = /** @type {EnumRemoveHeader} */ (template.header);
      continue;
    }
    const words = statement.tokens.map(kw);
    const what = words.slice(0, 3).join(" ");
    if (statement.opaque || words.includes("CASCADE") || words.includes("CONCURRENTLY")) {
      reject(statement, `statement not allowed in ${CONTRACT_FILE} (${what})`);
      continue;
    }
    if (words[0] === "DROP" && ["TABLE", "INDEX", "TYPE"].includes(words[1])) {
      for (const target of dropTargets(statement.tokens, 2))
        result.drops.push({ kind: words[1].toLowerCase(), target });
      continue;
    }
    if (words[0] === "ALTER" && words[1] === "TABLE") {
      const parsedAlter = alterTable(statement.tokens);
      const actions = parsedAlter?.actions ?? [];
      if (
        actions.length &&
        actions.every((a) => a.kind === "drop-column" || a.kind === "drop-constraint")
      ) {
        for (const action of actions)
          result.drops.push(
            action.kind === "drop-column"
              ? { kind: "column", target: `${parsedAlter.table}.${action.column}` }
              : { kind: "constraint", target: `${parsedAlter.table}.${action.constraint}` },
          );
        continue;
      }
    }
    reject(statement, `statement not allowed in ${CONTRACT_FILE} (${what})`);
  }
  return result;
}

// --- rollback safety (§1.13) ------------------------------------------------

const WRAPPER_SET_LOCALS = new Set(
  WRAPPER_PREAMBLE.filter((line) => line.startsWith("SET LOCAL")).map(normalizeSql),
);

/**
 * May an older release run against the database after this migration
 * (§1.13)? A positive allowlist: anything else is unsafe, with a reason.
 * @param {string} sql migration.sql
 * @param {{ priorTables?: Set<string> | Map<string, unknown>, catalog?: ReturnType<typeof emptyCatalog>, folder?: string }} [options]
 *   priorTables: tables that existed before (default: every table this file
 *   does not create); catalog: the pre-migration catalog, to classify dropped
 *   constraints and indexes (without it, Prisma's `_fkey` / `_key` names).
 * @returns {{ safe: boolean, reasons: string[] }}
 */
export function rollbackSafety(sql, options = {}) {
  const reasons = [];
  let parsed;
  try {
    parsed = splitStatements(sql);
  } catch (error) {
    return { safe: false, reasons: [`the file could not be lexed (${error.message})`] };
  }
  const recognized = recognizeTemplates(sql, parsed, { folder: options.folder, file: "migration" });
  const createdTables = new Set();
  const createdColumns = new Map();
  const prior = (table) =>
    options.priorTables ? options.priorTables.has(table) : !createdTables.has(table);
  const at = (statement, why) => reasons.push(`line ${statement.line}: ${why}`);
  const uniqueOn = (statement, table, columns, what) => {
    if (createdTables.has(table)) return;
    for (const column of columns) {
      const created = createdColumns.get(`${table}.${column}`);
      if (!created) return at(statement, `${what} on existing columns of ${display(table)}`);
      if (created.default !== null && kw(created.default.trim()) !== "NULL")
        return at(
          statement,
          `${what} on new column ${display(table)}."${column}" with a non-NULL default (older code inserts duplicates)`,
        );
    }
  };
  for (const [index, statement] of parsed.entries()) {
    const { tokens } = statement;
    const words = tokens.map(kw);
    if (isWrapperStatement(statement) || recognized.covered.has(index)) continue;
    if (isBare(statement, "BEGIN") || isBare(statement, "COMMIT")) continue;
    if (WRAPPER_SET_LOCALS.has(normalizeSql(statement.text ?? ""))) continue;
    if (recognized.problems.has(index)) {
      at(statement, recognized.problems.get(index));
      continue;
    }
    if (statement.opaque || ["DO", "EXECUTE", "CALL", "COPY"].includes(words[0])) {
      at(statement, "not analyzed (hand-reviewed SQL is never rollback-safe)");
      continue;
    }
    if (words[0] === "CREATE" && words[1] === "TABLE") {
      const name = qualifiedName(tokens, words[2] === "IF" ? 5 : 2);
      if (name) createdTables.add(`${name.schema}.${name.name}`);
    } else if (words[0] === "CREATE" && words[1] === "TYPE") {
      // A new type: older code never sees it.
    } else if (words[0] === "CREATE" && words[1] === "INDEX") {
      // Non-unique: invisible to older code.
    } else if (words[0] === "CREATE" && words[1] === "UNIQUE" && words[2] === "INDEX") {
      const index_ = parseIndexStatement(sql, statement);
      if (!index_) at(statement, "unrecognized CREATE UNIQUE INDEX");
      else uniqueOn(statement, index_.table, index_.columns, "a unique index");
    } else if (words[0] === "ALTER" && words[1] === "TABLE") {
      const parsedAlter = alterTable(tokens);
      if (!parsedAlter) {
        at(statement, "unrecognized ALTER TABLE");
        continue;
      }
      const table = parsedAlter.table;
      for (const action of parsedAlter.actions) {
        if (action.kind === "add-column") {
          const def = parseColumnDef(sql, statement, action.defFrom, action.to);
          createdColumns.set(`${table}.${action.column}`, def);
          if (def.notNull && def.default === null && !createdTables.has(table))
            at(
              statement,
              `adds NOT NULL column ${display(table)}."${action.column}" without a default`,
            );
        } else if (action.kind === "add-constraint") {
          const head = kw(tokens[action.bodyFrom]);
          if (head === "FOREIGN") {
            const refAt = tokens.findIndex(
              (t, i) => i > action.bodyFrom && i < action.to && kw(t) === "REFERENCES",
            );
            const target = refAt >= 0 ? qualifiedName(tokens, refAt + 1) : null;
            let onDelete = "NO ACTION";
            for (let i = refAt; i >= 0 && i < action.to; i++)
              if (kw(tokens[i]) === "ON" && kw(tokens[i + 1]) === "DELETE")
                onDelete = referentialAction(tokens, i + 2);
            const targetKey = target ? `${target.schema}.${target.name}` : "";
            if (["NO ACTION", "RESTRICT"].includes(onDelete) && (!target || prior(targetKey)))
              at(
                statement,
                `a new ${onDelete} foreign key referencing ${display(targetKey)} (older code's deletes can fail)`,
              );
          } else if (head === "UNIQUE") {
            const open = tokens.indexOf("(", action.bodyFrom);
            uniqueOn(statement, table, parenIdents(tokens, open), "a unique constraint");
          } else if (!createdTables.has(table))
            at(statement, `adds a ${head.toLowerCase()} constraint to ${display(table)}`);
        } else if (action.kind === "drop-constraint") {
          const known = options.catalog?.constraints.get(`${table}:${action.constraint}`);
          const foreign = known ? known.kind === "foreign" : /_fkey$/.test(action.constraint ?? "");
          if (!foreign)
            at(statement, `drops constraint "${action.constraint}" of ${display(table)}`);
        } else if (action.kind === "alter-column") {
          if (action.change === "set-default") continue;
          if (action.change === "drop-not-null" && recognized.relaxed.has(index)) {
            // A relax with no placeholder: rows the new release inserts carry
            // NULL, which older code reading the column as required (a Prisma
            // required field or relation) fails on after a rollback.
            at(
              statement,
              `relaxes ${display(table)}."${action.column}" with DROP NOT NULL (no placeholder default; older code reading it as required fails on the NULLs the new release writes)`,
            );
            continue;
          }
          at(
            statement,
            `${action.change.toUpperCase().replaceAll("-", " ")} on ${display(table)}."${action.column}"`,
          );
        } else if (action.kind === "alter-type") {
          at(statement, `changes the type of ${display(table)}."${action.column}"`);
        } else {
          at(statement, `${action.words.slice(0, 2).join(" ")} on ${display(table)}`);
        }
      }
    } else if (words[0] === "ALTER" && words[1] === "TYPE") {
      at(
        statement,
        words.includes("ADD") ? "adds an enum value (older code cannot read it)" : "alters a type",
      );
    } else if ((words[0] === "UPDATE" || words[0] === "DELETE") && words.includes("WHERE")) {
      // Data change with a WHERE: the rows stay readable by older code.
    } else if (words[0] === "DROP" && words[1] === "INDEX") {
      for (const key of dropTargets(tokens, words[2] === "CONCURRENTLY" ? 3 : 2)) {
        const known = options.catalog?.indexes.get(key);
        if (!known) at(statement, `drops index ${display(key)} (unknown index)`);
        else if (known.unique) at(statement, `drops the unique index ${display(key)}`);
      }
    } else {
      at(statement, `not on the rollback-safe list (${words.slice(0, 3).join(" ")})`);
    }
  }
  return { safe: reasons.length === 0, reasons };
}

/** The table and plain columns of a CREATE [UNIQUE] INDEX statement. */
function parseIndexStatement(sql, statement) {
  const scratch = emptyCatalog();
  foldStatement(scratch, sql, statement, false);
  return [...scratch.indexes.values()][0] ?? null;
}

// --- name reuse (§1.7) ------------------------------------------------------

const TEMPLATE_OBJECT = /^knowledge_base_(sync|enum_new|enum_old)_[0-9a-f]{8}$/;

function createdKeys(sql) {
  const keys = [];
  let parsed;
  try {
    parsed = splitStatements(sql);
  } catch {
    return keys;
  }
  for (const statement of parsed) {
    const { tokens, line } = statement;
    const words = tokens.map(kw);
    const add = (key) => {
      if (!TEMPLATE_OBJECT.test(key.split(/[:.]/).at(-1) ?? "")) keys.push({ key, line });
    };
    if (words[0] === "CREATE" && words[1] === "TABLE") {
      const scratch = emptyCatalog();
      foldStatement(scratch, sql, statement, false);
      for (const [tableKey, table] of scratch.tables) {
        add(`table:${tableKey}`);
        for (const column of table.columns.keys()) add(`column:${tableKey}.${column}`);
      }
      for (const constraint of scratch.constraints.values())
        add(`constraint:${constraint.table}.${constraint.name}`);
    } else if (words[0] === "ALTER" && words[1] === "TABLE") {
      const parsedAlter = alterTable(tokens);
      for (const action of parsedAlter?.actions ?? []) {
        if (action.kind === "add-column") add(`column:${parsedAlter.table}.${action.column}`);
        else if (action.kind === "add-constraint" && action.constraint)
          add(`constraint:${parsedAlter.table}.${action.constraint}`);
        else if (action.kind === "rename-column") add(`column:${parsedAlter.table}.${action.to}`);
        else if (action.kind === "rename-table") add(`table:${parsedAlter.schema}.${action.to}`);
      }
    } else if (
      words[0] === "CREATE" &&
      (words[1] === "INDEX" || (words[1] === "UNIQUE" && words[2] === "INDEX"))
    ) {
      const index = parseIndexStatement(sql, statement);
      if (index) add(`index:${index.table.split(".")[0]}.${index.name}`);
    } else if (words[0] === "CREATE" && words[1] === "TYPE") {
      const created = parseCreateEnum(sql, statement);
      if (created) {
        add(`type:${created.schema}.${created.name}`);
        for (const label of created.labels) add(`label:${created.schema}.${created.name}:${label}`);
      }
    } else if (words[0] === "ALTER" && words[1] === "TYPE") {
      const name = qualifiedName(tokens, 2);
      if (name && words[name.next] === "ADD" && words[name.next + 1] === "VALUE") {
        const at = name.next + (words[name.next + 2] === "IF" ? 5 : 2);
        add(
          `label:${name.schema}.${name.name}:${decodeLiteral(rawText(sql, statement, at, at + 1))}`,
        );
      } else if (name && words[name.next] === "RENAME" && words[name.next + 1] === "TO")
        add(`type:${name.schema}.${ident(tokens[name.next + 2])}`);
    }
  }
  return keys;
}

function droppedKeys(sql, folder) {
  const keys = [];
  let parsed;
  try {
    parsed = splitStatements(sql);
  } catch {
    return keys;
  }
  // The header names the removed labels, whether or not the block verifies.
  for (const statement of parsed)
    for (const comment of statement.comments) {
      const header = parseTemplateHeader(comment);
      if (header?.kind === "enum-remove" && !header.malformed)
        for (const { from } of header.pairs) keys.push(`label:public.${header.enumName}:${from}`);
    }
  const analysis = analyzeContract(sql, { folder });
  for (const drop of analysis.drops) {
    if (drop.kind === "constraint") keys.push(`constraint:${drop.target}`);
    else keys.push(`${drop.kind}:${drop.target}`);
  }
  return [...new Set(keys)];
}

/**
 * CREATE / ADD statements that reuse a name an EARLIER folder's contract.sql
 * drops or removes (§1.7). Keys: `table:<schema.t>`, `column:<schema.t>.<c>`,
 * `type:<schema.E>`, `label:<schema.E>:<L>`, `index:<schema.name>`,
 * `constraint:<schema.t>.<name>`. Template sync/rebuild names are excluded.
 * @param {Array<{ name: string, sql: string, contract?: { sql: string } | null }>} folders in order
 * @returns {Array<{ key: string, folder: string, line: number, droppedBy: string }>}
 */
export function findNameReuse(folders) {
  const dropped = new Map();
  const matches = [];
  for (const folder of folders) {
    for (const { key, line } of createdKeys(folder.sql)) {
      const by = dropped.get(key);
      if (by !== undefined) matches.push({ key, folder: folder.name, line, droppedBy: by });
    }
    if (folder.contract)
      for (const key of droppedKeys(folder.contract.sql, folder.name))
        if (!dropped.has(key)) dropped.set(key, folder.name);
  }
  return matches;
}
