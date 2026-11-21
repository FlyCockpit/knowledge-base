import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  changedFiles,
  expandSuite,
  ruleFor,
  SLOW,
  SUITE_SCRIPTS,
  SUITES,
  selectSlow,
} from "./test-scripts-affected.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const { scripts } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};
const selected = (changed: readonly string[] | undefined) => [...selectSlow(changed).keys()].sort();

function tracked(): string[] {
  // Untracked (non-ignored) files too: a new file is checked before its commit.
  const result = spawnSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.split("\0").filter(Boolean);
}

describe("the mapping", () => {
  test("verify:fast selects the slow files; verify, gate and CI run the three suites whole", () => {
    assert.equal(scripts["test:scripts:affected"], "node scripts/test-scripts-affected.ts");
    assert.match(scripts["verify:fast"] ?? "", / && pnpm test:scripts:affected(?: && |$)/);
    // This mapping test runs wherever the selector does (and in verify).
    assert.match(scripts["test:setup"] ?? "", / scripts\/test-scripts-affected\.test\.ts(?: |$)/);
    for (const tier of ["verify", "verify:fast"])
      assert.match(scripts[tier] ?? "", /&& pnpm test:setup &&/, tier);
    for (const suite of SUITES) {
      const step = `pnpm ${SUITE_SCRIPTS[suite]}`;
      assert.ok(!(scripts["verify:fast"] ?? "").includes(step), `verify:fast still runs ${step}`);
      for (const gate of ["verify", "gate"])
        assert.match(scripts[gate] ?? "", new RegExp(`&& ${step}(?: &&|$)`), `${gate}: ${step}`);
    }
    const ci = readFileSync(join(ROOT, ".github/workflows/pr-checks.yml"), "utf8");
    for (const suite of SUITES) assert.ok(ci.includes(`pnpm ${SUITE_SCRIPTS[suite]}`), suite);
  });

  test("every suite command expands, and every slow file is in exactly one suite", () => {
    const files = new Map<string, string>();
    for (const suite of SUITES) {
      const command = expandSuite(scripts[SUITE_SCRIPTS[suite]] ?? "");
      assert.ok(command, `${SUITE_SCRIPTS[suite]} no longer expands; it would run whole`);
      assert.ok(command.files.length > 0, suite);
      for (const file of command.files) {
        assert.ok(!files.has(file), `${file} is in ${files.get(file)} and ${suite}`);
        files.set(file, suite);
      }
    }
    for (const file of SLOW) assert.ok(files.has(file), `${file} is in no suite`);
    // The expansion matches what the suite commands' own globs see (on disk:
    // an unstaged rename leaves the old name in the index only).
    const all = tracked().filter((path) => existsSync(join(ROOT, path)));
    for (const [glob, dir] of [
      ["scripts/db/*.test.mjs", "scripts/db/"],
      ["scripts/db/lib/*.test.mjs", "scripts/db/lib/"],
      ["scripts/backup/*.test.mjs", "scripts/backup/"],
    ] as const) {
      const expected = all.filter(
        (path) =>
          path.startsWith(dir) &&
          !path.slice(dir.length).includes("/") &&
          path.endsWith(".test.mjs"),
      );
      assert.ok(expected.length > 0, glob);
      for (const path of expected) assert.ok(files.has(path), `${path} (${glob})`);
    }
  });

  test("every tracked or untracked file is classified by a rule", () => {
    const unclassified = tracked().filter((path) => ruleFor(path) === undefined);
    assert.deepEqual(
      unclassified,
      [],
      "classify these in scripts/test-scripts-affected.ts RULES (do the slow files read them?)",
    );
  });

  test("every slow file selects itself", () => {
    for (const file of SLOW) assert.ok(selectSlow([file]).has(file), file);
  });

  test("every repo file a slow file references, or a module or shell script it reaches, selects it", () => {
    // A static backstop for the traced inputs: relative imports, new URL()
    // and join(root, "…") literals in the test and the modules it imports, and
    // source/. lines in the shell scripts they reach. A path that resolves
    // outside the work tree (the entrypoint's /app/… paths) is not an input.
    const exists = (path: string) =>
      statSync(join(ROOT, path), { throwIfNoEntry: false })?.isFile() === true;
    const references = (file: string): string[] => {
      const text = readFileSync(join(ROOT, file), "utf8");
      const dir = file.split("/").slice(0, -1).join("/");
      const fromFile = (rel: string) => join(dir, rel);
      const found: string[] = [];
      if (file.endsWith(".sh")) {
        for (const [, path = ""] of text.matchAll(
          /^\s*(?:source|\.)\s+"?(?:\$ROOT|\$\{ROOT\})\/([\w./-]+)"?/gm,
        ))
          found.push(path);
        for (const [, path = ""] of text.matchAll(
          /^\s*(?:source|\.)\s+"?\$(?:\(dirname "\$0"\)|\{BASH_SOURCE%\/\*\})\/([\w./-]+)"?/gm,
        ))
          found.push(fromFile(path));
      } else {
        for (const [, path = ""] of text.matchAll(
          /(?:\bfrom\s+|\bimport\(\s*|new URL\(\s*)"(\.{1,2}\/[^"]+)"/g,
        ))
          found.push(fromFile(path));
        for (const [, path = ""] of text.matchAll(/\bjoin\(\s*(?:ROOT|root|repo)\s*,\s*"([^"]+)"/g))
          found.push(path);
      }
      return found.filter(exists);
    };
    for (const slow of SLOW) {
      const seen = new Set<string>();
      const queue: string[] = [slow];
      while (queue.length > 0) {
        const file = queue.shift() ?? "";
        if (seen.has(file)) continue;
        seen.add(file);
        assert.ok(selectSlow([file]).has(slow), `${file} (reached from ${slow}) must select it`);
        queue.push(...references(file));
      }
      assert.ok(seen.size > 1, `${slow}: no references found; the scan is broken`);
    }
  });

  test("the inputs the slow files were traced reading select them", () => {
    for (const [path, slow] of [
      ["scripts/backup/host.sh", ["scripts/backup/host.test.mjs"]],
      ["scripts/backup/linux-only.mjs", ["scripts/backup/host.test.mjs"]],
      // Off Linux, host.test.mjs runs in its first FROM image.
      ["Dockerfile", ["scripts/backup/host.test.mjs"]],
      ["scripts/docker-entrypoint.sh", ["scripts/docker-entrypoint.test.mjs"]],
      ["scripts/lib/bounded-child.mjs", ["scripts/lib/bounded-child.test.mjs"]],
      ["scripts/lib/owned-child.sh", ["scripts/lib/bounded-child.test.mjs"]],
      ["scripts/backup.sh", ["scripts/lib/bounded-child.test.mjs"]],
    ] as const) {
      assert.deepEqual(selected([path]), [...slow].sort(), path);
    }
  });
});

describe("selection", () => {
  test("fails open: shared inputs, unclassified paths and an unknown base run everything", () => {
    const all = [...SLOW].sort();
    for (const path of [
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "patches/braces@3.0.3.patch",
      ".nvmrc",
      "tsconfig.json",
      "packages/config/tsconfig.base.json",
      "packages/config/package.json",
      "scripts/test-scripts-affected.ts",
      "scripts/new-tool.mjs",
      "scripts/lib/new-helper.sh",
      "scripts/backup/new.sh",
      "new-root-file.json",
    ]) {
      assert.deepEqual(selected(["apps/web/src/a.tsx", path]), all, path);
    }
    assert.deepEqual(selected(undefined), all);
    assert.match(
      selectSlow(["scripts/new-tool.mjs"]).get("scripts/backup/host.test.mjs") ?? "",
      /no rule .* names it/,
    );
  });

  test("app code, docs and other tooling skip the slow files", () => {
    for (const path of [
      "apps/web/src/routes/index.tsx",
      "apps/server/src/index.ts",
      "apps/cli/crates/kb-local/src/uploads.rs",
      "packages/api/src/lib/kb/cas.ts",
      "packages/db/prisma/schema/schema.prisma",
      "docs/backup-restore.md",
      ".github/workflows/pr-checks.yml",
      "scripts/db/migrate.mjs",
      "scripts/backup/restore.sh",
      "scripts/lib/kb-backup.mjs",
      "scripts/check-doc-citations.ts",
      "Dockerfile.worker",
    ]) {
      assert.deepEqual(selected([path]), [], path);
    }
    assert.deepEqual(selected([]), []);
  });

  test("each slow file is selected by its own paths only, with the first reason", () => {
    const picks = selectSlow([
      "apps/web/a.ts",
      "scripts/backup/host.sh",
      "scripts/backup/host.test.mjs",
    ]);
    assert.deepEqual(
      [...picks],
      [["scripts/backup/host.test.mjs", "scripts/backup/host.sh changed"]],
    );
  });

  test("expandSuite refuses command shapes it cannot reproduce", () => {
    const root = mkdtempSync(join(tmpdir(), "scripts-affected-expand-"));
    try {
      mkdirSync(join(root, "s"));
      writeFileSync(join(root, "s/a.test.mjs"), "");
      writeFileSync(join(root, "s/b.test.mjs"), "");
      assert.deepEqual(expandSuite("node --test 's/*.test.mjs' s/a.test.mjs", root), {
        flags: [],
        files: ["s/a.test.mjs", "s/b.test.mjs"],
      });
      assert.deepEqual(expandSuite("node --import tsx --test s/*.test.mjs", root), {
        flags: ["--import", "tsx"],
        files: ["s/a.test.mjs", "s/b.test.mjs"],
      });
      for (const command of [
        "node --test --test-concurrency=1 s/a.test.mjs",
        "node --test 's/*.spec.mjs'",
        "vitest run s/a.test.mjs",
        "node --test s/a.test.mjs && node other.mjs",
        "",
      ]) {
        assert.equal(expandSuite(command, root), undefined, command);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("changedFiles", () => {
  test("commits, edits, untracked files, and both sides of a rename since the merge base", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "scripts-affected-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    // A git hook (or any caller) may export GIT_DIR, GIT_INDEX_FILE and the
    // like; inherited, they would point this scratch repo's writes at the
    // caller's repository. Drop every GIT_* variable.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
    );
    const git = (...args: string[]) => {
      // No hooks either: a global core.hooksPath must not judge this repo.
      const config = ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];
      const result = spawnSync("git", [...config, ...args], {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...env,
          GIT_CEILING_DIRECTORIES: tmpdir(),
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@example.com",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@example.com",
        },
      });
      return result.status === 0 ? result.stdout : undefined;
    };
    git("init", "-q", "-b", "main");
    mkdirSync(join(dir, "scripts/backup"), { recursive: true });
    mkdirSync(join(dir, "apps/web"), { recursive: true });
    writeFileSync(join(dir, "scripts/backup/host.sh"), "host body that stays the same\n");
    writeFileSync(join(dir, "apps/web/a.ts"), "1");
    writeFileSync(join(dir, "README.md"), "1");
    git("add", ".");
    git("commit", "-q", "-m", "base");
    git("checkout", "-q", "-b", "feature");
    writeFileSync(join(dir, "apps/web/a.ts"), "2");
    git("mv", "scripts/backup/host.sh", "apps/web/host.sh");
    git("commit", "-q", "-am", "edit");
    writeFileSync(join(dir, "README.md"), "2");
    writeFileSync(join(dir, "new.ts"), "1");
    // Non-ASCII names come back verbatim, not quoted by core.quotePath.
    mkdirSync(join(dir, "docs"));
    writeFileSync(join(dir, "docs/café.md"), "1");
    const run = (args: readonly string[]) => git(...args);
    assert.deepEqual(changedFiles(run)?.sort(), [
      "README.md",
      "apps/web/a.ts",
      "apps/web/host.sh",
      "docs/café.md",
      "new.ts",
      "scripts/backup/host.sh",
    ]);
    // No base branch at all: unknown, so everything runs.
    git("branch", "-q", "-m", "main", "trunk");
    assert.equal(changedFiles(run), undefined);
  });
});
