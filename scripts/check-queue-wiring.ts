/**
 * Guards QUEUE_NAMES in packages/queue against the admin jobs map in
 * packages/api/src/routers/queue.ts.
 *
 *   pnpm policy:queue-wiring
 *
 * Every key in QUEUE_NAMES must appear in both `queuesByName` and
 * `queueNameSchema`. A queue that a worker consumes but the admin UI cannot
 * name is how jobs go missing from `/admin` with no type error.
 *
 * Dated allowlist: shrink it when the missing wiring lands. Do not grow it.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import process from "node:process";

const { parse } = createRequire(import.meta.url)("@babel/parser") as typeof import("@babel/parser");

const ROOT = resolve(import.meta.dirname!, "..");
const JOBS_FILE = "packages/queue/src/jobs.ts";
const QUEUE_ROUTER = "packages/api/src/routers/queue.ts";

/**
 * Gaps as of 2026-09-02. Keep this empty. Shrink only.
 */
const ALLOWLIST = new Set<string>([]);

type AstNode = {
  type: string;
  [key: string]: unknown;
};

function node(value: unknown): AstNode | undefined {
  return typeof value === "object" && value !== null && "type" in value
    ? (value as AstNode)
    : undefined;
}

function parseFile(rel: string): AstNode {
  const source = readFileSync(resolve(ROOT, rel), "utf8");
  return parse(source, {
    sourceType: "module",
    sourceFilename: rel,
    plugins: ["typescript"],
  }) as unknown as AstNode;
}

function walk(value: unknown, visit: (current: AstNode) => void, seen = new Set<unknown>()): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit, seen);
    return;
  }
  const current = node(value);
  if (!current || seen.has(current)) return;
  seen.add(current);
  visit(current);
  for (const [key, child] of Object.entries(current)) {
    if (key === "loc" || key === "range" || key === "comments") continue;
    walk(child, visit, seen);
  }
}

function identifierName(value: unknown): string | undefined {
  const current = node(value);
  return current?.type === "Identifier" ? (current.name as string) : undefined;
}

function objectKeyName(property: AstNode): string | undefined {
  if (property.type !== "ObjectProperty" && property.type !== "ObjectMethod") return undefined;
  const key = node(property.key);
  if (!key) return undefined;
  if (property.computed === true) {
    // [QUEUE_NAMES.echo] → echo
    if (key.type === "MemberExpression") {
      const objectName = identifierName(key.object);
      const propName = identifierName(key.property);
      if (objectName === "QUEUE_NAMES" && propName) return propName;
    }
    return undefined;
  }
  if (key.type === "Identifier") return key.name as string;
  if (key.type === "StringLiteral") return key.value as string;
  return undefined;
}

function queueNamesMember(value: unknown): string | undefined {
  const current = node(value);
  if (current?.type !== "MemberExpression") return undefined;
  const objectName = identifierName(current.object);
  const propName = identifierName(current.property);
  if (objectName === "QUEUE_NAMES" && propName) return propName;
  return undefined;
}

function findObjectByName(ast: AstNode, name: string): AstNode | undefined {
  let found: AstNode | undefined;
  walk(ast, (current) => {
    if (found) return;
    if (current.type !== "VariableDeclarator") return;
    if (identifierName(current.id) !== name) return;
    const init = node(current.init);
    if (init) found = init;
  });
  return found;
}

function objectKeys(init: AstNode): string[] {
  const keys: string[] = [];
  const object =
    init.type === "TSAsExpression" || init.type === "TSTypeAssertion"
      ? node(init.expression)
      : init;
  if (object?.type !== "ObjectExpression") return keys;
  for (const prop of (object.properties as unknown[]) ?? []) {
    const current = node(prop);
    if (!current) continue;
    const name = objectKeyName(current);
    if (name) keys.push(name);
  }
  return keys;
}

function enumMembers(init: AstNode): string[] {
  const names: string[] = [];
  walk(init, (current) => {
    if (current.type !== "CallExpression") return;
    const callee = node(current.callee);
    if (callee?.type !== "MemberExpression") return;
    if (identifierName(callee.object) !== "z") return;
    if (identifierName(callee.property) !== "enum") return;
    const args = (current.arguments as unknown[]) ?? [];
    const first = node(args[0]);
    if (first?.type !== "ArrayExpression") return;
    for (const element of (first.elements as unknown[]) ?? []) {
      const name = queueNamesMember(element);
      if (name) names.push(name);
    }
  });
  return names;
}

const jobsAst = parseFile(JOBS_FILE);
const queueAst = parseFile(QUEUE_ROUTER);

const queueNamesInit = findObjectByName(jobsAst, "QUEUE_NAMES");
if (!queueNamesInit) {
  console.error(`POLICY VIOLATION: could not find QUEUE_NAMES in ${JOBS_FILE}`);
  process.exit(1);
}
const declared = objectKeys(queueNamesInit);

const queuesByNameInit = findObjectByName(queueAst, "queuesByName");
if (!queuesByNameInit) {
  console.error(`POLICY VIOLATION: could not find queuesByName in ${QUEUE_ROUTER}`);
  process.exit(1);
}
const byName = new Set(objectKeys(queuesByNameInit));

const schemaInit = findObjectByName(queueAst, "queueNameSchema");
if (!schemaInit) {
  console.error(`POLICY VIOLATION: could not find queueNameSchema in ${QUEUE_ROUTER}`);
  process.exit(1);
}
const schema = new Set(enumMembers(schemaInit));

const missing: string[] = [];
const staleAllow: string[] = [];

for (const name of declared) {
  const wired = byName.has(name) && schema.has(name);
  const allowlisted = ALLOWLIST.has(name);
  if (!wired && !allowlisted) missing.push(name);
  if (wired && allowlisted) staleAllow.push(name);
}

for (const name of ALLOWLIST) {
  if (!declared.includes(name) && !staleAllow.includes(name)) {
    staleAllow.push(name);
  }
}

if (missing.length === 0 && staleAllow.length === 0) {
  console.log("queue-wiring policy passed.");
  process.exit(0);
}

if (missing.length > 0) {
  console.error(
    "POLICY VIOLATION: QUEUE_NAMES key missing from queuesByName and/or queueNameSchema:",
  );
  for (const name of missing) {
    const inMap = byName.has(name) ? "present" : "MISSING";
    const inSchema = schema.has(name) ? "present" : "MISSING";
    console.error(`  ${name}  queuesByName=${inMap}  queueNameSchema=${inSchema}`);
  }
  console.error("");
  console.error("Current dated allowlist (must shrink):");
  for (const name of ALLOWLIST) {
    console.error(`  ${name}`);
  }
  console.error("");
}

if (staleAllow.length > 0) {
  console.error(
    "POLICY VIOLATION: allowlisted queue name is now wired (or no longer declared) — remove it from ALLOWLIST:",
  );
  for (const name of staleAllow) {
    console.error(`  ${name}`);
  }
  console.error("");
}

process.exit(1);
