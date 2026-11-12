import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { findViolations } from "./check-prisma-query-cast-policy.ts";

const { parse } = createRequire(import.meta.url)("@babel/parser") as typeof import("@babel/parser");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const POLICY = path.join(ROOT, "scripts/check-prisma-query-cast-policy.ts");
const dbImport = 'import prisma from "@knowledge-base/db";\n';
const rejected = [
  `${dbImport}await prisma.post.findMany({}) as Row[]`,
  `${dbImport}(((await prisma.post.findMany({})))) as Row[]`,
  `${dbImport}(await (prisma.post.findMany({}))) as Row[]`,
  `${dbImport}(await prisma.post.findMany({}))! as Row[]`,
  `${dbImport}<Row[]>(await prisma.post.findMany({}))`,
  `${dbImport}(await prisma['post']['findMany']({})) as Row[]`,
  `${dbImport}(await prisma[\`post\`][\`findMany\`]({})) as Row[]`,
  `${dbImport}(await prisma.post.findMany?.({})) as Row[]`,
  `${dbImport}(await prisma?.post?.findMany({})) as Row[]`,
  `${dbImport}prisma.post.findMany({}) as Promise<Row[]>`,
  `${dbImport}const db = prisma satisfies object; (await db.post.findMany({})) as Row[]`,
  `${dbImport}const db = prisma; const client = db; (await client.post.findMany({})) as Row[]`,
  'import db from "@knowledge-base/db"; (await db.post.findMany({})) as Row[]',
  `${dbImport}await prisma.$transaction(async (tx) => (await tx.post.update({})) as unknown as Row)`,
  `${dbImport}for (const item of items) { const prisma = sdk; (await prisma.post.findMany({})) as Row[] } (await prisma.post.findMany({})) as Row[]`,
  `${dbImport}switch (kind) { case 'local': { const prisma = sdk; (await prisma.post.findMany({})) as Row[]; break } } (await prisma.post.findMany({})) as Row[]`,
  `${dbImport}class Example { static { const prisma = sdk; prisma.post.findMany({}) as Promise<Row[]> } } (await prisma.post.findMany({})) as Row[]`,
  `${dbImport}await prisma.$transaction((async (tx) => (await tx.post.update({})) as Row) satisfies Callback)`,
  `${dbImport}await prisma.$transaction(((async (tx) => (await tx.post.update({})) as Row) as Callback))`,
  `${dbImport}const db = prisma as PrismaClient; (await db.post.findMany({})) as Row[]`,
  `${dbImport}const rows = await prisma.post.findMany({}); rows as Row[]`,
  `${dbImport}const promise = prisma.post.findMany({}); promise as Promise<Row[]>`,
  `${dbImport}const rows = (((await prisma.post.findMany({})))); (rows!) as Row[]`,
  // Client-level Prisma operations are result sources, not only model delegates.
  `${dbImport}prisma.$transaction([]) as unknown`,
  `${dbImport}(await prisma.$transaction([prisma.post.findMany({}), prisma.post.count()])) as [Row[], number]`,
  `${dbImport}(await prisma.$transaction(async (tx) => tx.post.findMany({}))) as Row[]`,
  `${dbImport}const rows = await prisma.$transaction(async (tx) => tx.post.findMany({})); rows as Row[]`,
  `${dbImport}(await prisma.$queryRaw\`SELECT 1\`) as Row[]`,
  `${dbImport}prisma.$executeRaw\`UPDATE Post SET title = title\` as unknown`,
  `${dbImport}(await prisma.$queryRawUnsafe("SELECT 1")) as Row[]`,
  `${dbImport}(await prisma.$executeRawUnsafe("UPDATE Post SET title = title")) as number`,
  `${dbImport}const rows = await prisma.$queryRaw\`SELECT 1\`; rows as Row[]`,
  `${dbImport}const count = prisma.$executeRawUnsafe("UPDATE Post SET title = title"); count as Promise<number>`,
  `${dbImport}(await prisma.$queryRaw?.("SELECT 1")) as Row[]`,
  // Runtime-transparent TypeScript wrappers are allowed at every link in a proven chain.
  `${dbImport}(await (prisma as PrismaClient).post.findMany({})) as Row[]`,
  `${dbImport}(await (prisma.post as Delegate).findMany({})) as Row[]`,
  `${dbImport}(await (prisma.post.findMany as FindMany)({})) as Row[]`,
  `${dbImport}await (prisma.$transaction as Transaction)(async (tx) => (await tx.post.findMany({})) as Row[])`,
  `${dbImport}(await (prisma.post.findMany<Args>)({})) as Row[]`,
  `${dbImport}await (prisma.$transaction<Result>)(async (tx) => (await tx.post.findMany({})) as Row[])`,
  // Alternate syntax for the package's runtime default export has identical provenance.
  'import { default as db } from "@knowledge-base/db"; (await db.post.findMany({})) as Row[]',
  // Function-adjacent executable syntax is checked in JavaScript evaluation order.
  `${dbImport}const methods = { [(await prisma.post.findMany({})) as Row[]]() {} }`,
  `${dbImport}function example(value = prisma.post.findMany({}) as Promise<Row[]>) { return value }`,
  `${dbImport}await prisma.$transaction(async (tx, value = tx.post.findMany({}) as Promise<Row[]>) => value)`,
  `${dbImport}const { [(prisma.post.findMany({}) as Promise<Row[]>).toString()]: key } = source`,
  `${dbImport}const { nested: [value = prisma.post.findMany({}) as Promise<Row[]>], ...rest } = source`,
  `${dbImport}for (const { value = prisma.post.findMany({}) as Promise<Row[]> } of items) {}`,
  `${dbImport}for (const item of prisma.post.findMany({}) as Promise<Row[]>) {}`,
  `${dbImport}for (const prisma of prisma.post.findMany({}) as Promise<Row[]>) {}`,
  `${dbImport}try { throw source } catch ({ [(prisma.post.findMany({}) as Promise<Row[]>).toString()]: value }) {}`,
  `${dbImport}await prisma.$transaction(async (tx) => { ({ first: value = tx.post.findMany({}) as Promise<Row[]>, second: tx } = source) })`,
  `${dbImport}await prisma.$transaction(async (tx) => { for ({ first: value = tx.post.findMany({}) as Promise<Row[]>, second: tx } of items) {} })`,
  `${dbImport}await prisma.$transaction(async (tx) => { ({ value: tx } = prisma.post.findMany({}) as Promise<Row[]>) })`,
  `${dbImport}await prisma.$transaction(async (tx) => { for ({ value: tx } of prisma.post.findMany({}) as Promise<Row[]>) {} })`,
  `${dbImport}await prisma.$transaction(async (tx) => { var tx; return tx.post.findMany({}) as Promise<Row[]> })`,
  // A nested function owns its own hoisted vars and cannot erase outer provenance.
  `${dbImport}function inner() { if (flag) { var prisma = sdk } } (await prisma.post.findMany({})) as Row[]`,
];
const accepted = [
  `${dbImport}await prisma.post.findMany(args)`,
  `${dbImport}await prisma.$transaction([prisma.post.findMany({}), prisma.post.count()])`,
  `${dbImport}await prisma.$transaction(async (tx) => tx.post.findMany({}))`,
  `${dbImport}await prisma.$queryRaw\`SELECT 1\``,
  `${dbImport}await prisma.$executeRaw\`UPDATE Post SET title = title\``,
  `${dbImport}await prisma.$queryRawUnsafe("SELECT 1")`,
  `${dbImport}await prisma.$executeRawUnsafe("UPDATE Post SET title = title")`,
  "({ id: '1' }) as Row",
  "const sdk = {}; (await sdk.post.findMany({})) as Row[]",
  `${dbImport}const sdk = { $transaction() {}, $queryRaw() {}, $queryRawUnsafe() {}, $executeRaw() {}, $executeRawUnsafe() {} }; sdk.$transaction([]) as unknown; sdk.$queryRaw("SELECT 1") as Row[]; sdk.$queryRawUnsafe("SELECT 1") as Row[]; sdk.$executeRaw("UPDATE") as number; sdk.$executeRawUnsafe("UPDATE") as number`,
  `${dbImport}const sdk = { $queryRaw: () => undefined, $executeRaw: () => undefined }; sdk.$queryRaw\`SELECT 1\` as Row[]; sdk.$executeRaw\`UPDATE\` as number`,
  `${dbImport}function unrelated(prisma: any) { return (prisma.post.findMany({})) as Row[] }`,
  `${dbImport}const api = { run(prisma: any) { return prisma.post.findMany({}) as Row[] } }`,
  `${dbImport}{ const { prisma } = sdk; (await prisma.post.findMany({})) as Row[] }`,
  `${dbImport}try {} catch (prisma) { (await prisma.post.findMany({})) as Row[] }`,
  `${dbImport}const operation = 'findMany'; (await prisma.post[operation]({})) as Row[]`,
  `${dbImport}let db = prisma; db = sdk; (await db.post.findMany({})) as Row[]`,
  `${dbImport}var db = prisma; db = sdk; (await db.post.findMany({})) as Row[]`,
  `${dbImport}for (const prisma of clients) { (await prisma.post.findMany({})) as Row[] }`,
  `${dbImport}switch (kind) { case 'local': const prisma = sdk; (await prisma.post.findMany({})) as Row[] }`,
  `${dbImport}class Example { static { const prisma = sdk; prisma.post.findMany({}) as Promise<Row[]> } }`,
  `${dbImport}const db = sdk as PrismaClient; (await db.post.findMany({})) as Row[]`,
  // Result provenance is intentionally one direct immutable hop, not flow analysis.
  `${dbImport}let rows = await prisma.post.findMany({}); rows as Row[]`,
  `${dbImport}const load = () => prisma.post.findMany({}); const rows = await load(); rows as Row[]`,
  `${dbImport}const [row] = await prisma.post.findMany({}); row as Row`,
  // Assertions cannot manufacture Prisma provenance for any part of the chain.
  `${dbImport}(await (sdk as PrismaClient).post.findMany({})) as Row[]`,
  `${dbImport}(await (sdk.post as Delegate).findMany({})) as Row[]`,
  `${dbImport}(await (sdk.post.findMany as FindMany)({})) as Row[]`,
  `${dbImport}await (sdk.$transaction as Transaction)(async (tx) => (await tx.post.findMany({})) as Row[])`,
  `${dbImport}(await (sdk.post.findMany<Args>)({})) as Row[]`,
  `${dbImport}await (sdk.$transaction<Result>)(async (tx) => (await tx.post.findMany({})) as Row[])`,
  // Type-only imports are not runtime clients.
  'import type { default as db } from "@knowledge-base/db"; (await db.post.findMany({})) as Row[]',
  // Computed keys use the enclosing scope; parameters shadow throughout their parameter scope.
  `${dbImport}const methods = { [(await sdk.post.findMany({})) as Row[]]() {} }`,
  `${dbImport}function example(prisma = (prisma.post.findMany({})) as Row[]) { return prisma }`,
  `${dbImport}function example(prisma, value = prisma.post.findMany({}) as Promise<Row[]>) { return value }`,
  `${dbImport}const callback = function prisma(value = prisma.post.findMany({}) as Promise<Row[]>) { return value }`,
  // `var` shadows the import throughout the owning function, across statement scopes.
  `${dbImport}async function example() { (await prisma.post.findMany({})) as Row[]; if (flag) { var prisma = sdk } }`,
  `${dbImport}async function example() { (await prisma.post.findMany({})) as Row[]; for (;;) { var prisma = sdk } }`,
  `${dbImport}async function example() { (await prisma.post.findMany({})) as Row[]; switch (kind) { case 1: var prisma = sdk } }`,
  `${dbImport}async function example() { (await prisma.post.findMany({})) as Row[]; try {} catch { var prisma = sdk } }`,
  `${dbImport}await prisma.$transaction(async (tx) => { var tx = sdk; return tx.post.findMany({}) as Promise<Row[]> })`,
  // A named class expression owns its self-binding; it cannot inherit an import
  // with the same spelling into the class body.
  `${dbImport}const Example = class prisma { method() { return prisma.post.findMany({}) as Promise<Row[]> } };`,
  // Writes invalidate provenance. Mutable aliases remain outside this bounded analysis.
  `${dbImport}await prisma.$transaction(async (tx) => { tx = sdk; return tx.post.findMany({}) as Promise<Row[]> })`,
  `${dbImport}await prisma.$transaction(async (tx) => { ({ first: tx, second: value = tx.post.findMany({}) as Promise<Row[]> } = source) })`,
  `${dbImport}await prisma.$transaction(async (tx) => { for ({ first: tx, second: value = tx.post.findMany({}) as Promise<Row[]> } of items) {} })`,
  `${dbImport}const db = prisma; db = sdk; (await db.post.findMany({})) as Row[]`,
];

// These spellings specifically exercise Babel's TSInstantiationExpression
// wrapper. If Babel changes its AST shape (or a fixture is "simplified" into a
// different syntax), fail before the policy assertions can give false comfort.
function assertInstantiationCallee(source: string): void {
  const ast = parse(source, { sourceType: "module", plugins: ["typescript"] });
  const statement = ast.program.body[0];
  const expression = statement?.type === "ExpressionStatement" ? statement.expression : undefined;
  if (
    expression?.type !== "CallExpression" ||
    expression.callee.type !== "TSInstantiationExpression"
  )
    throw new Error(`Fixture must parse with a TSInstantiationExpression callee: ${source}`);
}

assertInstantiationCallee("(prisma.post.findMany<Args>)({})");
assertInstantiationCallee("(prisma.$transaction<Result>)(async (tx) => tx)");
assertInstantiationCallee("(sdk.post.findMany<Args>)({})");
assertInstantiationCallee("(sdk.$transaction<Result>)(async (tx) => tx)");

function invoke(source: string, name: string) {
  const directory = mkdtempSync(path.join(tmpdir(), "knowledge-base-prisma-cast-policy-"));
  const fixture = path.join(directory, `${name}.ts`);
  try {
    writeFileSync(fixture, source);
    const result = spawnSync(process.execPath, [POLICY, fixture], { cwd: ROOT, encoding: "utf8" });
    if (result.error) throw result.error;
    return result;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const [index, source] of rejected.entries()) {
  const violations = findViolations(source, `rejected-${index}.ts`);
  if (violations.length === 0)
    throw new Error(`Rejected fixture ${index} did not produce a policy diagnostic.`);
}
for (const [index, source] of accepted.entries()) {
  const violations = findViolations(source, `accepted-${index}.ts`);
  if (violations.length !== 0)
    throw new Error(`Accepted fixture ${index} produced ${violations.length} diagnostic(s).`);
}
const nestedDiagnostics = findViolations(
  `${dbImport}const rows = await prisma.post.findMany({}); (rows as unknown) as Row[]`,
  "nested-assertion.ts",
);
if (nestedDiagnostics.length !== 1)
  throw new Error(
    `Nested assertions must produce exactly one diagnostic (received ${nestedDiagnostics.length}).`,
  );

// Keep only a small CLI integration seam; the syntax matrix above stays
// in-process so adding fixtures does not add a process launch apiece.
const cliViolation = invoke(rejected[0] ?? "", "cli-violation");
if (cliViolation.status !== 1 || !cliViolation.stderr.includes("Do not assert a type"))
  throw new Error(
    `CLI policy violation did not produce the expected exit/diagnostic (status ${cliViolation.status}).\n${cliViolation.stderr}`,
  );
const malformed = invoke("const broken = <", "malformed");
if (
  malformed.status !== 2 ||
  !malformed.stderr.includes("could not parse") ||
  !malformed.stderr.includes("malformed.ts:1:")
)
  throw new Error(
    `Malformed-input fixture was not distinguished from a policy violation (status ${malformed.status}).\n${malformed.stderr}`,
  );
const missing = spawnSync(
  process.execPath,
  [POLICY, path.join(tmpdir(), "missing-policy-input.ts")],
  {
    cwd: ROOT,
    encoding: "utf8",
  },
);
if (
  missing.status !== 2 ||
  !missing.stderr.includes("could not read") ||
  missing.stderr.includes("could not parse")
)
  throw new Error(
    `Unreadable-input fixture was not distinguished from a parse failure (status ${missing.status}).\n${missing.stderr}`,
  );

const scanDirectory = mkdtempSync(path.join(tmpdir(), "knowledge-base-prisma-cast-policy-scan-"));
try {
  const git = spawnSync("git", ["init", "--quiet"], { cwd: scanDirectory, encoding: "utf8" });
  if (git.status !== 0) throw new Error(`Could not initialize scan fixture: ${git.stderr}`);
  writeFileSync(path.join(scanDirectory, "tracked.ts"), "export const okay = true;\n");
  writeFileSync(path.join(scanDirectory, "removed.ts"), "export const removed = true;\n");
  const add = spawnSync("git", ["add", "tracked.ts", "removed.ts"], {
    cwd: scanDirectory,
    encoding: "utf8",
  });
  if (add.status !== 0) throw new Error(`Could not stage scan fixture: ${add.stderr}`);
  rmSync(path.join(scanDirectory, "removed.ts"));
  for (const extension of ["ts", "tsx", "mts", "cts"])
    writeFileSync(
      path.join(scanDirectory, `untracked.${extension}`),
      `${dbImport}(await prisma.post.findMany({})) as Row[];\n`,
    );
  const scan = spawnSync(process.execPath, [POLICY, "--scan"], {
    cwd: scanDirectory,
    encoding: "utf8",
  });
  if (
    scan.status !== 1 ||
    !["ts", "tsx", "mts", "cts"].every((extension) =>
      scan.stderr.includes(`untracked.${extension}:2:`),
    ) ||
    scan.stderr.includes("removed.ts")
  )
    throw new Error(
      `Worktree scan fixture was not enforced (status ${scan.status}).\n${scan.stderr}`,
    );
} finally {
  rmSync(scanDirectory, { recursive: true, force: true });
}

console.log(
  `Prisma query-cast policy harness passed (${rejected.length} rejected, ${accepted.length} accepted, 1 cardinality check, 1 malformed input, 1 unreadable input, 1 worktree scan).`,
);
