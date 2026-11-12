/**
 * Fixture tests for leftover cleanup consumers: migration controls, retained-doc
 * citations, dotenv preload, and agent-doc generators.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { checkDocCitations } from "./check-doc-citations.ts";
import { checkLoadDotenvContract } from "./check-load-dotenv-contract.ts";
import { assertNoPendingRestore } from "./db/lib/migration-state.mjs";
import { syncAgentDocs, TARGETS } from "./sync-agent-docs.ts";

const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));

function fixture(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return dir;
}

function write(root, rel, content) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

test("pending restore control remains an independent migration admission gate", async () => {
  const sql = [];
  await assert.rejects(
    assertNoPendingRestore({
      query: async (text) => {
        sql.push(text);
        return {
          rows: text.includes("to_regclass") ? [{ restore_table: true }] : [{ state: "IMPORTING" }],
        };
      },
    }),
  );
  assert.ok(sql.every((text) => text.includes("knowledge_base_control.kb_restore")));
});

test("a fixture with a broken retained doc link fails", () => {
  const dir = fixture("kb-docs-broken-");
  try {
    write(dir, "AGENTS.md", "# Agents\n\n## Migration contract\n");
    write(dir, "README.md", `See the [missing page](./${"gone.md"}).\n`);
    write(dir, "src/note.ts", `// see ${["AGENTS.md", "Nonexistent heading"].join(" § ")}\n`);
    const result = checkDocCitations({
      root: dir,
      codeDirs: ["src"],
      rootDocs: ["AGENTS.md", "README.md"],
      docLinkRootDocs: ["AGENTS.md", "README.md"],
      skipAbsolute: [],
    });
    assert.ok(
      result.errors.some((error) => error.includes("gone.md")),
      result.errors.join("\n"),
    );
    assert.ok(
      result.errors.some((error) => error.includes("Nonexistent heading")),
      result.errors.join("\n"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a fixture without patterns/ succeeds for retained-doc citations", () => {
  const dir = fixture("kb-docs-ok-");
  try {
    write(dir, "AGENTS.md", "# Agents\n\n## Migration contract\n");
    write(dir, "src/ok.ts", `// see ${["AGENTS.md", "Migration contract"].join(" § ")}\n`);
    write(dir, "src/legacy.ts", `// see ${["patterns/forms.md", "Forms"].join(" § ")}\n`);
    const result = checkDocCitations({
      root: dir,
      codeDirs: ["src"],
      rootDocs: ["AGENTS.md"],
      docLinkRootDocs: ["AGENTS.md"],
      skipAbsolute: [],
    });
    assert.equal(existsSync(join(dir, "patterns")), false);
    assert.deepEqual(result.errors, []);
    assert.ok(result.warnings.some((warning) => warning.includes("patterns/forms.md")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("long generated tokens stay bounded without hiding adjacent citations", () => {
  const dir = fixture("kb-docs-long-token-");
  try {
    write(dir, "AGENTS.md", "# Agents\n\n## Valid heading\n");
    write(
      dir,
      "src/generated.ts",
      [
        `const embedded = "${"A".repeat(300_000)}";`,
        `// ${["AGENTS.md", "Valid heading"].join(" § ")}`,
        `// [${["See", "Valid heading"].join(" § ")}](../AGENTS.md#valid-heading)`,
        `// ${["AGENTS.md", "Missing heading"].join(" § ")}`,
      ].join("\n"),
    );
    // A separate process enforces the deadline even if a synchronous regex
    // blocks its event loop. The old unanchored scan takes minutes on this input.
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        `import { checkDocCitations } from "./scripts/check-doc-citations.ts";
         console.log(JSON.stringify(checkDocCitations({
           root: process.argv[1], codeDirs: ["src"], rootDocs: ["AGENTS.md"],
           skipAbsolute: [],
         })));`,
        dir,
      ],
      { cwd: repo, encoding: "utf8", timeout: 10_000 },
    );
    assert.equal(child.error, undefined, child.error?.message);
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.equal(result.citationCount, 3);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /Missing heading/);
    assert.deepEqual(result.warnings, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing required dotenv preload still fails", () => {
  const dir = fixture("kb-dotenv-");
  try {
    write(dir, "packages/env/package.json", JSON.stringify({ name: "@knowledge-base/env" }));
    write(dir, "scripts/doctor.ts", 'import { env } from "@knowledge-base/env/server";\n');
    const result = checkLoadDotenvContract({
      root: dir,
      envPackageName: "@knowledge-base/env",
      entrypoints: [{ file: "scripts/doctor.ts", mode: "sideEffect" }],
      validationModules: [],
      allowlist: new Map(),
      scanDirs: ["scripts"],
    });
    assert.ok(
      result.errors.some((error) => error.includes("load-dotenv")),
      result.errors.join("\n"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("root agent-doc generator is idempotent and does not recreate deleted mirrors", () => {
  const dir = fixture("kb-sync-docs-");
  try {
    write(dir, "AGENTS.md", "# knowledge-base\n");
    const silent = { log: () => {} };
    const first = syncAgentDocs(dir, silent);
    assert.deepEqual([...first.written].sort(), [".github/copilot-instructions.md", "CLAUDE.md"]);
    assert.deepEqual(TARGETS.map((target) => target.path).sort(), [
      ".github/copilot-instructions.md",
      "CLAUDE.md",
    ]);
    const claude = readFileSync(join(dir, "CLAUDE.md"), "utf8");
    const copilot = readFileSync(join(dir, ".github/copilot-instructions.md"), "utf8");
    const second = syncAgentDocs(dir, silent);
    assert.deepEqual(second.written, first.written);
    assert.equal(readFileSync(join(dir, "CLAUDE.md"), "utf8"), claude);
    assert.equal(readFileSync(join(dir, ".github/copilot-instructions.md"), "utf8"), copilot);
    const generated = ["CLAUDE.md", ".github/copilot-instructions.md"];
    assert.equal(existsSync(join(dir, `.${"cursor"}rules`)), false);
    for (const path of generated) assert.equal(existsSync(join(dir, path)), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI xtask source only mirrors CLAUDE.md and is Apache-2.0", () => {
  const sync = readFileSync(join(repo, "apps/cli/xtask/src/sync.rs"), "utf8");
  assert.match(sync, /CLAUDE\.md/);
  assert.doesNotMatch(sync, /PathBuf::from\("\.github/);
  const cargo = readFileSync(join(repo, "apps/cli/Cargo.toml"), "utf8");
  assert.match(cargo, /name = "kb"/);
  assert.match(cargo, /license = "Apache-2.0"/);
  const retiredBin = "my" + "cli";
  assert.doesNotMatch(cargo, new RegExp(`\\b${retiredBin}\\b|UNLICENSED|\\bOWNER\\b`));
  const xtaskCargo = readFileSync(join(repo, "apps/cli/xtask/Cargo.toml"), "utf8");
  assert.match(xtaskCargo, /license = "Apache-2.0"/);
  assert.doesNotMatch(xtaskCargo, /MIT OR Apache-2.0/);
});

test("nightly tooling self-tests run on the schedule even when notes/ exists", () => {
  const yaml = readFileSync(join(repo, ".github/workflows/nightly-tooling.yml"), "utf8");
  assert.match(yaml, /\n {2}schedule:\n/);
  assert.match(yaml, /cron: "30 3 \* \* \*"/);
  assert.match(yaml, /workflow_dispatch:/);
  assert.doesNotMatch(yaml, /hashFiles\(/);
  assert.doesNotMatch(yaml, /^\s+if:/m);
});

test("pnpm gate includes lint, types, tests, knip, env, policy, docs, and Docker COPY without live services", () => {
  const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
  const gate = pkg.scripts.gate;
  for (const part of [
    "check:ci",
    "check-types",
    "test",
    "knip",
    "env:check",
    "env:check-entrypoints",
    "policy:checks",
    "docs:check-citations",
    "docker:check-copy",
  ]) {
    assert.match(gate, new RegExp(part.replace(":", "\\:")));
  }
  assert.doesNotMatch(gate, /db:push|dev:services|compose|redis|postgres/i);
  assert.ok(
    Object.values(pkg.scripts).some((script) => script.includes("cleanup-consumers.test.mjs")),
  );
});

test("live dotenv and citation checkers still pass against the repo", () => {
  const dotenv = checkLoadDotenvContract({ root: repo });
  assert.deepEqual(dotenv.errors, []);
  const citations = checkDocCitations({ root: repo });
  assert.deepEqual(citations.errors, []);
});

test("offline restore and storage refuse runner contention before mutable preflight", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-test-module-mocks",
      "--input-type=module",
      "--eval",
      `
    import assert from 'node:assert/strict';
    import { mock } from 'node:test';
    const events = [];
    let denyRunner = true;
    class Client {
      on() {} async connect() {} async end() { events.push('closed'); }
      async query(sql, values) {
        events.push([sql, values]);
        if (sql.includes('pg_try_advisory_lock')) return { rows: [{ held: values[0] !== 72707370 || !denyRunner }] };
        if (sql.includes('pg_stat_activity')) return { rows: [{ active: true }] };
        return { rows: [] };
      }
    }
    mock.module('pg', { namedExports: { Client } });
    const moduleUrl = (path) => new URL(path, 'file://' + process.cwd() + '/').href;
    const noop = async () => {};
    mock.module(moduleUrl('scripts/lib/kb-backup.mjs'), { namedExports: {
      assertOfflineFence: noop, bundleVersion: noop, digest: noop, forAssetInventory: noop,
      openPath: noop, pathCheck: noop, pgEnv: () => ({}), syncDir: () => {}, verifyAssetInventory: noop,
      verifyEncryptedBundle: async () => ({ sha256: 'a'.repeat(64), size: 1 }),
    } });
    mock.module(moduleUrl('scripts/init-kb-volumes.mjs'), { namedExports: {
      ensureKbDataSkeleton: () => events.push('mutated-volume'), isSkeletonOnly: () => true,
      kbDataPaths: (root) => ({ reposDir: root + '/repos', assetsDir: root + '/assets' }),
    } });
    mock.module(moduleUrl('scripts/lib/asset-storage-domain.mjs'), { namedExports: {
      assetOperatorEnv: (env) => env, operatorAssetConfig: async () => ({ mode: 'disk' }),
      assetStorageDomain: async () => ({ offlineAssetFenceProof: () => () => {} }),
    } });
    const { restoreOffline } = await import(moduleUrl('scripts/lib/kb-restore.mjs'));
    const { migrateStorageOffline, coordinateStorageMigration } = await import(moduleUrl('scripts/lib/asset-storage-migration.mjs'));
    const attemptId = '00000000-0000-4000-8000-000000000001';
    const common = { connectionString: 'postgresql://inert:inert@inert/inert', dataDir: '/inert', attemptId };
    for (const call of [() => restoreOffline({ ...common, file: '/inert.age', identity: '/identity' }),
      () => migrateStorageOffline({ ...common, to: 's3', request: 'inert' }),
      () => coordinateStorageMigration({ ...common, to: 's3' })]) {
      events.length = 0;
      await assert.rejects(call(), /BUSY/);
      const queries = events.filter(Array.isArray);
      assert.equal(queries.length, 1);
      assert.equal(queries[0][1][0], 72707370);
      assert.ok(!events.includes('mutated-volume'));
      assert.equal(events.at(-1), 'closed');
    }
    denyRunner = false; events.length = 0;
    await assert.rejects(restoreOffline({ ...common, file: '/inert.age', identity: '/identity' }), /ACTIVE_CONNECTIONS/);
    const keys = events.filter(Array.isArray).filter(([sql]) => sql.includes('pg_try_advisory_lock')).map(([, values]) => values[0]);
    assert.deepEqual(keys, [72707370, 0x4b424d52, 0x4b424d41, 1145389648, 72707369]);
    assert.ok(!events.includes('mutated-volume'));
  `,
    ],
    { cwd: repo, encoding: "utf8", timeout: 10000 },
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);
});
