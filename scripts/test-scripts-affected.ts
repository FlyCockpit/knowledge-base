/**
 * `pnpm test:scripts:affected`, in `pnpm verify:fast`: runs the root script
 * suites (`db:test-unit`, `backup:test-unit`, `deploy:test-unit`) without the
 * slow test files whose inputs nothing on this branch or in the work tree
 * changed. `pnpm verify`, `pnpm gate` and CI (pr-checks.yml) always run all
 * three suites whole.
 *
 * Every file of the three suites runs, except the SLOW ones below, which run
 * only when a path that selects them changed. Together they were most of the
 * suites' time (host 40 s, entrypoint 25 s, bounded-child 22 s; the other
 * ~400 tests take ~5 s and always run).
 *
 * Fails open: every path is classified by RULES, and a path no rule names, a
 * shared input (root package.json, the lockfile, the Node version, the
 * TypeScript config tsx reads, this selector) or an unknown base branch runs
 * every slow file. Only paths a rule proves the slow files never read skip
 * them. If a suite's package.json command no longer has the shape this file
 * expands, that suite runs as its own script, whole.
 *
 * The inputs were taken from the files themselves (every repo file they
 * open, stat, list or execute, recorded with `strace -f -e trace=%file`), not
 * from reading the code, plus one platform branch a Linux trace cannot see
 * (scripts/backup/linux-only.mjs runs host.test.mjs in the Dockerfile's first
 * FROM image off Linux). When a slow file starts reading something new, add
 * it to its rule. The test (`scripts/test-scripts-affected.test.ts`, in
 * `pnpm test:setup`) fails while any tracked or untracked file is
 * unclassified or a slow file's own inputs would not select it; test:setup
 * runs in `pnpm verify` and `pnpm verify:fast`, the only caller of this file.
 */

import { spawnSync } from "node:child_process";
import { existsSync, globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

export const SUITES = ["db", "backup", "deploy"] as const;
export type Suite = (typeof SUITES)[number];

/** The package.json script each suite runs. */
export const SUITE_SCRIPTS: Record<Suite, string> = {
  db: "db:test-unit",
  backup: "backup:test-unit",
  deploy: "deploy:test-unit",
};

/** The slow test files, run only when something they read changed. */
export const SLOW = [
  "scripts/backup/host.test.mjs",
  "scripts/docker-entrypoint.test.mjs",
  "scripts/lib/bounded-child.test.mjs",
] as const;
export type Slow = (typeof SLOW)[number];

/**
 * A rule matches a path exactly, or by prefix when it ends in "/".
 * First match wins, so the narrower rules come first.
 */
interface Rule {
  paths: readonly string[];
  slow: readonly Slow[] | "all";
}

const OWN_SELECTOR = ["scripts/test-scripts-affected.ts", "scripts/test-scripts-affected.test.ts"];

export const RULES: readonly Rule[] = [
  // Shared inputs: dependencies, the Node version, the TypeScript config tsx
  // reads for every file, this selector.
  {
    paths: [
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "patches/",
      ".nvmrc",
      ".npmrc",
      "tsconfig.json",
      // tsx resolves tsconfig.json's extends through this package (its
      // package.json exports and tsconfig.base.json).
      "packages/config/",
      ...OWN_SELECTOR,
    ],
    slow: "all",
  },
  // What each slow file reads. Off Linux, host.test.mjs runs inside the
  // Dockerfile's first FROM image (scripts/backup/linux-only.mjs).
  {
    paths: [
      "scripts/backup/host.sh",
      "scripts/backup/host.test.mjs",
      "scripts/backup/linux-only.mjs",
      "Dockerfile",
    ],
    slow: ["scripts/backup/host.test.mjs"],
  },
  {
    paths: ["scripts/docker-entrypoint.sh", "scripts/docker-entrypoint.test.mjs"],
    slow: ["scripts/docker-entrypoint.test.mjs"],
  },
  {
    paths: [
      "scripts/lib/bounded-child.mjs",
      "scripts/lib/bounded-child.test.mjs",
      "scripts/lib/owned-child.sh",
      // Read for a source assertion only; it sources backup-env.sh.
      "scripts/backup.sh",
      "scripts/lib/backup-env.sh",
    ],
    slow: ["scripts/lib/bounded-child.test.mjs"],
  },
  // Never read by the slow files. Files under scripts/ (outside scripts/db/
  // and the hook and fixture folders) are named one by one, so a new script
  // is unclassified (runs everything) until it is added.
  {
    paths: [
      "apps/",
      "packages/",
      "docs/",
      ".github/",
      "scripts/db/",
      "scripts/claude-hooks/",
      "scripts/fixtures/",
      "scripts/backup/drill.mjs",
      "scripts/backup/drill.test.mjs",
      "scripts/backup/pre-migrate.sh",
      "scripts/backup/pre-migrate.test.mjs",
      "scripts/backup/restore.sh",
      "scripts/backup/schedule.mjs",
      "scripts/backup/schedule.test.mjs",
      "scripts/backup/test-backup-restore.mjs",
      "scripts/access-matrix-pre-notes-baseline.json",
      "scripts/assert-local-database.sh",
      "scripts/backup-heartbeat.mjs",
      "scripts/bench-index-cold-diagnosis.mjs",
      "scripts/bench-index-quantization.mjs",
      "scripts/bench-index-quantization.test.mjs",
      "scripts/build-commit.mjs",
      "scripts/build-commit.test.mjs",
      "scripts/build-embedding-runtime.d.mts",
      "scripts/build-embedding-runtime.mjs",
      "scripts/build-embedding-runtime.test.mjs",
      "scripts/check-access-matrix.ts",
      "scripts/check-agent-rules.ts",
      "scripts/check-agents-size.ts",
      "scripts/check-cas-ownership.mjs",
      "scripts/check-cas-ownership.test.mjs",
      "scripts/check-destructive-operations.mjs",
      "scripts/check-doc-citations.ts",
      "scripts/check-docker-copy.ts",
      "scripts/check-load-dotenv-contract.ts",
      "scripts/check-prisma-query-cast-policy.ts",
      "scripts/check-queue-wiring.ts",
      "scripts/check-release-age-excludes.ts",
      "scripts/check-security-patches.mjs",
      "scripts/check-security-patches.test.mjs",
      "scripts/check-template-secret-patterns.mjs",
      "scripts/check-test-colocation.ts",
      "scripts/check-timestamp-policy.ts",
      "scripts/cleanup-consumers.test.mjs",
      "scripts/compose.sh",
      "scripts/deploy-check.mjs",
      "scripts/deploy-check.test.mjs",
      "scripts/dev-docker-down.sh",
      "scripts/dev-docker-logs.sh",
      "scripts/dev-docker.sh",
      "scripts/dev-docker.test.mjs",
      "scripts/dev-tunnel.sh",
      "scripts/doctor.ts",
      "scripts/filter-trufflehog-results.mjs",
      "scripts/find-free-port.sh",
      "scripts/generate-builtin-fixtures.ts",
      "scripts/generate-dokploy-config.test.ts",
      "scripts/generate-dokploy-config.ts",
      "scripts/generate-kb-protocol.test.ts",
      "scripts/generate-kb-protocol.ts",
      "scripts/generate-secrets.ts",
      "scripts/image-smoke-flows.mjs",
      "scripts/image-smoke-resolve.mjs",
      "scripts/image-smoke-resolve.test.mjs",
      "scripts/image-smoke.sh",
      "scripts/init-kb-volumes.d.mts",
      "scripts/init-kb-volumes.mjs",
      "scripts/init-kb-volumes.test.mjs",
      "scripts/install-claude-hooks.ts",
      "scripts/kb-supervised-vitest-setup.ts",
      "scripts/lib/admin-email-env.test.ts",
      "scripts/lib/admin-email-env.ts",
      "scripts/lib/age-pin.d.mts",
      "scripts/lib/age-pin.mjs",
      "scripts/lib/age-pin.test.mjs",
      "scripts/lib/agent-rules-allowlist.json",
      "scripts/lib/asset-storage-control.mjs",
      "scripts/lib/asset-storage-control.test.mjs",
      "scripts/lib/asset-storage-domain.mjs",
      "scripts/lib/asset-storage-migration.mjs",
      "scripts/lib/backup-identity.mjs",
      "scripts/lib/backup-s3-env.d.mts",
      "scripts/lib/backup-s3-env.mjs",
      "scripts/lib/dev-docker-runtime.sh",
      "scripts/lib/dev-toolchain-check.sh",
      "scripts/lib/dockerfile-pnpm.ts",
      "scripts/lib/env-manifest.ts",
      "scripts/lib/env-schema.ts",
      "scripts/lib/kb-backup.d.mts",
      "scripts/lib/kb-backup.mjs",
      "scripts/lib/kb-backup.test.mjs",
      "scripts/lib/kb-restore.d.mts",
      "scripts/lib/kb-restore.mjs",
      "scripts/lib/kb-restore.test.mjs",
      "scripts/lib/protocol-only-bundle.d.mts",
      "scripts/lib/protocol-only-bundle.mjs",
      "scripts/lib/protocol-only-bundle.test.mjs",
      "scripts/lib/session-timezone.mjs",
      "scripts/lib/smtp-env.test.ts",
      "scripts/lib/smtp-env.ts",
      "scripts/lib/validate-kb-master-key.mjs",
      "scripts/lib/zod-json-schema.ts",
      "scripts/lint-output-ownership.test.mjs",
      "scripts/policy-checks.sh",
      "scripts/restore-archive.mjs",
      "scripts/restore-archive.test.mjs",
      "scripts/setup.ts",
      "scripts/sqlite-native.mjs",
      "scripts/sqlite-native.test.mjs",
      "scripts/sync-agent-docs.ts",
      "scripts/sync-cli-vendor-inventory.mjs",
      "scripts/sync-cli-vendor-inventory.test.mjs",
      "scripts/sync-env-example.ts",
      "scripts/sync-markdown-entities.mjs",
      "scripts/test-backup-writer.mjs",
      "scripts/test-dokploy-deployment.mjs",
      "scripts/test-install-claude-hooks.ts",
      "scripts/test-io-guard.ts",
      "scripts/test-kb-build-docker.test.mjs",
      "scripts/test-kb.mjs",
      "scripts/test-kb.test.mjs",
      "scripts/test-prisma-query-cast-policy.ts",
      "scripts/test-qwen-image.mjs",
      "scripts/test-runtime-operations.mjs",
      "scripts/test-runtime-operations.test.mjs",
      "scripts/theme-apply.ts",
      "scripts/theme-reskin.ts",
      "scripts/translate-locale-bundles.ts",
      "scripts/trufflehog-pr-scan.sh",
      "scripts/upload-backup-to-s3.mjs",
      "scripts/verify-dokploy-deployment.mjs",
      "scripts/vitest-test-io-guard-fixture.config.ts",
      ".dockerignore",
      ".editorconfig",
      ".env.docker.defaults",
      ".env.example",
      ".gitattributes",
      ".gitignore",
      ".oxlintrc.json",
      "AGENTS.md",
      "CHANGELOG.md",
      "CLAUDE.md",
      "CODE_OF_CONDUCT.md",
      "CONTRIBUTING.md",
      "Dockerfile.dev",
      "Dockerfile.worker",
      "LICENSE",
      "NOTICE",
      "README.md",
      "SECURITY.md",
      "THIRD-PARTY-LICENSES.md",
      "biome.json",
      "docker-compose.agent.yml",
      "docker-compose.dev.yml",
      "docker-compose.image-smoke.yml",
      "docker-compose.kb-test.yml",
      "doctor.config.jsonc",
      "knip.jsonc",
      "lefthook.yml",
      "portless.json",
      "sitemap.md",
      "tsconfig.scripts.json",
      "turbo.json",
      "vitest.config.ts",
      "vitest.kb.config.ts",
    ],
    slow: [],
  },
];

function matches(rulePath: string, path: string): boolean {
  return rulePath.endsWith("/") ? path.startsWith(rulePath) : path === rulePath;
}

/** The rule for `path`, or undefined when no rule names it (runs everything). */
export function ruleFor(path: string): Rule | undefined {
  return RULES.find((rule) => rule.paths.some((rulePath) => matches(rulePath, path)));
}

/** Each slow file to run, with the first path that selects it. */
export function selectSlow(changed: readonly string[] | undefined): Map<Slow, string> {
  const selected = new Map<Slow, string>();
  const all = (reason: string) => new Map(SLOW.map((file) => [file, reason]));
  if (changed === undefined) return all("the base branch was not found");
  for (const path of changed) {
    const rule = ruleFor(path);
    if (rule === undefined) {
      return all(`${path} changed, and no rule in scripts/test-scripts-affected.ts names it`);
    }
    if (rule.slow === "all") return all(`${path} changed (a shared input)`);
    for (const file of rule.slow) if (!selected.has(file)) selected.set(file, `${path} changed`);
  }
  return selected;
}

/** A suite command as `node <flags> --test <files>`, or undefined for any other shape. */
export interface SuiteCommand {
  flags: string[];
  files: string[];
}

/**
 * Expands `node [--import tsx] --test <file|'glob'>...` against the work
 * tree. Anything else (another runner, flags after --test, a chained
 * command, a file or pattern that matches nothing) is undefined, and the
 * caller runs the script itself.
 */
export function expandSuite(command: string, root: string = ROOT): SuiteCommand | undefined {
  const arg = String.raw`(?:'[\w./*@-]+'|[\w.][\w./*@-]*)`;
  const match = new RegExp(`^node((?: --import tsx)?) --test (${arg}(?: ${arg})*)$`).exec(command);
  if (!match) return undefined;
  const flags = match[1] ? ["--import", "tsx"] : [];
  const files: string[] = [];
  for (const word of (match[2] ?? "").split(" ")) {
    const pattern = word.replace(/^'(.*)'$/, "$1");
    const found = pattern.includes("*")
      ? globSync(pattern, { cwd: root }).sort()
      : existsSync(join(root, pattern))
        ? [pattern]
        : [];
    if (found.length === 0) return undefined;
    for (const file of found) if (!files.includes(file)) files.push(file);
  }
  return { flags, files };
}

/** Compared in order; the first that resolves is the base. */
export const BASE_REFS = ["origin/main", "main"] as const;

type Git = (args: readonly string[]) => string | undefined;

const runGit: Git = (args) => {
  const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  return result.status === 0 ? result.stdout : undefined;
};

/**
 * Files changed since the merge base with the default branch: commits, staged
 * and unstaged edits, and untracked files; a rename lists both of its paths.
 * undefined when unknown.
 */
export function changedFiles(git: Git = runGit): string[] | undefined {
  let base: string | undefined;
  for (const ref of BASE_REFS) {
    base = git(["merge-base", "HEAD", ref])?.trim();
    if (base) break;
  }
  if (!base) return undefined;
  // -z: paths verbatim (no core.quotePath quoting of non-ASCII names).
  const diff = git(["diff", "-z", "--name-only", "--no-renames", base]);
  const untracked = git(["ls-files", "-z", "--others", "--exclude-standard"]);
  if (diff === undefined || untracked === undefined) return undefined;
  return [...diff.split("\0"), ...untracked.split("\0")].filter(Boolean);
}

// Node without import.meta.main would run this CLI as a silent no-op that
// exits 0, so refuse instead (use the Node version in .nvmrc).
if (typeof import.meta.main !== "boolean") {
  process.stderr.write("test-scripts-affected: Node 26 (.nvmrc) is required\n");
  process.exit(1);
}
if (import.meta.main) {
  try {
    parseArgs({ args: process.argv.slice(2), strict: true, options: {} });
  } catch (error) {
    process.stderr.write(
      `test-scripts-affected: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
  const { scripts } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const selected = selectSlow(changedFiles());
  for (const file of SLOW) {
    const reason = selected.get(file);
    process.stdout.write(
      reason === undefined
        ? `${file} skipped: nothing it reads changed (CI, \`pnpm verify\` and \`pnpm gate\` run it).\n`
        : `${file} runs: ${reason}.\n`,
    );
  }
  for (const suite of SUITES) {
    const script = SUITE_SCRIPTS[suite];
    const command = expandSuite(scripts[script] ?? "");
    let run: ReturnType<typeof spawnSync>;
    if (command === undefined) {
      process.stdout.write(`${script}: unexpected command shape, running it whole.\n`);
      run = spawnSync("pnpm", ["run", script], { cwd: ROOT, stdio: "inherit" });
    } else {
      const skipped = (file: string) =>
        (SLOW as readonly string[]).includes(file) && !selected.has(file as Slow);
      const files = command.files.filter((file) => !skipped(file));
      process.stdout.write(`${script}: ${files.length} of ${command.files.length} files.\n`);
      run = spawnSync("node", [...command.flags, "--test", ...files], {
        cwd: ROOT,
        stdio: "inherit",
      });
    }
    if (run.status !== 0) process.exit(run.status ?? 1);
  }
}
