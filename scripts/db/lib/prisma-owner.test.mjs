// No Postgres. Exercise the pinned CLI adapter's native spawn/RPC/drain contract.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const dir = mkdtempSync(path.join(tmpdir(), "knowledge-base-prisma-owner-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const guard = path.join(dir, "guard");
const root = fileURLToPath(new URL("../../../", import.meta.url));
const linux = process.platform === "linux";
if (linux)
  execFileSync("cc", [
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    path.join(root, "apps/worker/src/native/child-guard.c"),
    "-o",
    guard,
  ]);
const hash = "a".repeat(40);
for (const pkg of ["engines", "engines-version"]) {
  const target = path.join(dir, "node_modules/@prisma", pkg);
  mkdirSync(target, { recursive: true });
  writeFileSync(
    path.join(target, "index.js"),
    pkg === "engines" ? "" : `exports.enginesVersion=${JSON.stringify(hash)};`,
  );
}
const engine = path.join(dir, "schema-engine-test");
writeFileSync(
  engine,
  `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('schema-engine ${hash}'); process.exit(0); }
if (process.argv.includes('cli')) {
 console.error(JSON.stringify({timestamp:'2026-11-11T00:00:00Z',level:'INFO',fields:{message:'Starting schema engine CLI',git_hash:'${hash}'},target:'schema_engine'}));
 process.exit(0);
}
const fs=require('node:fs');
if (process.env.LATE_FILE) setTimeout(()=>fs.writeFileSync(process.env.LATE_FILE,'escaped'),500);
if (process.env.HANG) { if (process.env.READY_FILE) fs.writeFileSync(process.env.READY_FILE,'ready'); setInterval(()=>{},1000); }
else {
 console.error(JSON.stringify({timestamp:'2026-11-11T00:00:00Z',level:'INFO',fields:{message:'Starting schema engine RPC server',git_hash:'${hash}'},target:'schema_engine'}));
 if(process.env.EXTRA_DIAGNOSTIC) console.error(JSON.stringify({timestamp:'2026-11-11T00:00:00Z',level:'ERROR',fields:{message:'synthetic independent engine failure'},target:'schema_engine'}));
 require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const q=JSON.parse(line); if (q.method) console.log(JSON.stringify({jsonrpc:'2.0',id:q.id,...(process.env.RPC_FAIL ? {error:{code:1,message:'synthetic failure'}} : {result:q.method==='diff'?{exitCode:0}:{}})}));
 });
}
`,
  { mode: 0o700 },
);
const cli = path.join(dir, "cli.cjs");
writeFileSync(
  cli,
  `
const cp=require('node:child_process');
if(process.env.ESCAPE) cp.spawn('/bin/sh',['-c','exit 0']);
function target(){
const child=cp.spawn(${JSON.stringify(engine)},[],{stdio:['pipe','pipe','pipe']});
if(process.env.HANG) setInterval(()=>{},1000);
else {
 child.stdout.once('data',()=>{child.stdin.end();setTimeout(()=>child.kill(),0);});
 child.once('exit',()=>process.exit(process.env.RPC_FAIL?1:0));
 const op=process.argv[3];
 const method=process.env.BAD_RPC?'reset':op==='diff'?'diff':op==='deploy'?'applyMigrations':process.argv.includes('--applied')?'markMigrationApplied':'markMigrationRolledBack';
 child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method,params:{}})+'\\n');
}
}
if(process.env.TWO_PHASE || process.env.PRELIM_ONLY){
 const child=cp.spawn(${JSON.stringify(engine)},[],{stdio:['pipe','pipe','pipe'],env:{...process.env,...(process.env.PRELIM_FAIL?{RPC_FAIL:'1'}:{})}});
 child.stdout.once('data',()=>child.stdin.end());
 child.once('exit',()=>process.env.PRELIM_ONLY?process.exit(0):target());
 child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'diagnoseMigrationHistory',params:{}})+'\\n');
 }else if(process.env.CONNECTIVITY_PREFLIGHT || process.env.BAD_PREFLIGHT){
 const child=cp.spawn(${JSON.stringify(engine)},['--datasource','{}','cli',process.env.BAD_PREFLIGHT?'create-database':'can-connect-to-database'],{stdio:['pipe','pipe','pipe']});
 child.once('exit',()=>target());
}else target();
`,
);
function launch(args, env = {}) {
  const child = spawn(
    guard,
    [
      String(process.pid),
      process.execPath,
      path.join(root, "scripts/db/lib/prisma-owner.mjs"),
      guard,
      cli,
      "migrate",
      ...args,
    ],
    {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let drained = false;
  let stderr = "";
  child.on("message", (message) => {
    drained ||= message.schemaPrismaDrained === true;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const done = new Promise((resolve) =>
    child.on("close", (code, signal) => resolve({ code, signal, drained, stderr })),
  );
  return { child, done };
}
for (const args of [
  ["diff"],
  ["deploy"],
  ["resolve", "--applied", "0_init"],
  ["resolve", "--rolled-back", "0_init"],
])
  test(`owned ${args.join(" ")} acknowledges native drain with command-specific RPC evidence`, {
    skip: !linux,
  }, async () => {
    const result = await launch(args).done;
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.drained, true);
  });
test("a failed RPC drains but never becomes success", { skip: !linux }, async () => {
  const result = await launch(["deploy"], { RPC_FAIL: "1" }).done;
  assert.equal(result.code, 1, result.stderr);
  assert.equal(result.drained, true);
});
for (const key of ["ESCAPE", "BAD_RPC"])
  test(`${key} is refused`, { skip: !linux }, async () => {
    const result = await launch(["deploy"], { [key]: "1" }).done;
    assert.equal(result.code, 1, result.stderr);
    assert.equal(result.drained, true);
  });
async function ready(file) {
  const deadline = Date.now() + 5000;
  while (!existsSync(file) && Date.now() < deadline) await delay(10);
  assert.equal(existsSync(file), true, "native engine reached the barrier");
}
test("SIGTERM explicitly drains a hanging engine", { skip: !linux }, async () => {
  const file = path.join(dir, "term-ready");
  const owner = launch(["deploy"], { HANG: "1", READY_FILE: file });
  await ready(file);
  owner.child.kill("SIGTERM");
  const result = await owner.done;
  assert.equal(result.code, 1);
  assert.equal(result.drained, true);
});
test("SIGKILL cannot leave a late native child alive", { skip: !linux }, async () => {
  const marker = path.join(dir, "late");
  const file = path.join(dir, "kill-ready");
  const owner = launch(["deploy"], { HANG: "1", LATE_FILE: marker, READY_FILE: file });
  await ready(file);
  owner.child.kill("SIGKILL");
  const result = await owner.done;
  assert.equal(result.drained, false);
  await delay(600);
  assert.equal(existsSync(marker), false);
});

test("pinned Prisma diff uses the owned collector without a database and preserves Unicode SQL", {
  skip: !linux,
}, async () => {
  const { prisma } = await import("./prisma.mjs");
  const schema = path.join(dir, "unicode.prisma");
  writeFileSync(
    schema,
    'datasource db {\n provider = "postgresql"\n}\nmodel Probe {\n id Int @id\n @@map("資料")\n}\n',
  );
  const result = await prisma(
    ["migrate", "diff", "--from-empty", "--to-schema", schema, "--script"],
    { guardPath: guard, capture: true, timeoutMs: 20000 },
  );
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /CREATE TABLE "資料"/);
  await assert.rejects(
    prisma(["migrate", "diff", "--from-empty", "--to-schema", schema, "--script"], {
      guardPath: path.join(dir, "missing-guard"),
      capture: true,
    }),
    /acknowledge native drain/,
  );
});

test("deploy owns a diagnostic engine followed by the actual apply engine", {
  skip: !linux,
}, async () => {
  const result = await launch(["deploy"], { TWO_PHASE: "1" }).done;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.drained, true);
});
for (const env of [{ PRELIM_ONLY: "1" }, { TWO_PHASE: "1", PRELIM_FAIL: "1" }])
  test(`diagnostic engines cannot substitute for successful apply: ${Object.keys(env).join(",")}`, {
    skip: !linux,
  }, async () => {
    const result = await launch(["deploy"], env).done;
    assert.equal(result.code, 1, result.stderr);
    assert.equal(result.drained, true);
  });

test("deploy owns the pinned one-shot connectivity preflight and requires actual apply", {
  skip: !linux,
}, async () => {
  const result = await launch(["deploy"], { CONNECTIVITY_PREFLIGHT: "1" }).done;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.drained, true);
});
test("native CLI commands other than the read-only connectivity preflight are refused", {
  skip: !linux,
}, async () => {
  const result = await launch(["deploy"], { BAD_PREFLIGHT: "1" }).done;
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /refused native CLI command/);
});

test("successful RPC and owned stop cannot erase independent native error diagnostics", {
  skip: !linux,
}, async () => {
  const result = await launch(["deploy"], { TWO_PHASE: "1", EXTRA_DIAGNOSTIC: "1" }).done;
  assert.equal(result.code, 1, result.stderr);
  assert.equal(result.drained, true);
  assert.match(result.stderr, /native diagnostics rejected/);
});
