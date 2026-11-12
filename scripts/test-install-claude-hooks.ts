import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SETTINGS_SOURCE = path.join(ROOT, "scripts/claude-hooks/settings.json");
const INSTALLER_SOURCE = path.join(ROOT, "scripts/install-claude-hooks.ts");
const CHILD_TIMEOUT_MS = 30_000;

function runInstaller(fixtureRoot: string): {
  status: number | null;
  signal: NodeJS.Signals | null;
} {
  const installer = path.join(fixtureRoot, "scripts/install-claude-hooks.ts");
  const result = spawnSync("tsx", [installer], {
    cwd: fixtureRoot,
    encoding: "utf8",
    timeout: CHILD_TIMEOUT_MS,
  });
  if (result.error) {
    throw result.error;
  }
  return { status: result.status, signal: result.signal };
}

function copyInstallerFixture(root: string) {
  mkdirSync(path.join(root, "scripts/claude-hooks"), { recursive: true });
  cpSync(SETTINGS_SOURCE, path.join(root, "scripts/claude-hooks/settings.json"));
  cpSync(INSTALLER_SOURCE, path.join(root, "scripts/install-claude-hooks.ts"));
}

let failures = 0;

function expect(label: string, condition: boolean, detail?: string) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL install-claude-hooks ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Old direct-entry guard compared URL.pathname and broke on spaced paths. */
function spacedPathDirectEntryWouldFail(installerPath: string): boolean {
  const fileUrl = pathToFileURL(installerPath);
  const pathnameCompare = path.resolve(fileUrl.pathname) === path.resolve(installerPath);
  const fileUrlPathCompare = path.resolve(fileURLToPath(fileUrl)) === path.resolve(installerPath);
  return !pathnameCompare && fileUrlPathCompare;
}

const fixtureRoot = mkdtempSync(path.join(tmpdir(), "claude hooks install "));
try {
  copyInstallerFixture(fixtureRoot);
  const installerPath = path.join(fixtureRoot, "scripts/install-claude-hooks.ts");
  const settingsPath = path.join(fixtureRoot, ".claude/settings.json");

  expect(
    "spaced fixture path breaks URL.pathname direct-entry compare",
    spacedPathDirectEntryWouldFail(installerPath),
    installerPath,
  );

  const installerModule = await import(installerPath);
  expect(
    "import exposes installClaudeHooks",
    typeof installerModule.installClaudeHooks === "function",
  );
  expect(
    "import exposes claudeHooksStatus",
    typeof installerModule.claudeHooksStatus === "function",
  );
  expect("import does not create .claude", !existsSync(path.join(fixtureRoot, ".claude")));

  const symlinkEntry = path.join(fixtureRoot, "install-claude-hooks.symlink.ts");
  symlinkSync(installerPath, symlinkEntry);
  const symlinkRun = spawnSync("tsx", [symlinkEntry], {
    cwd: fixtureRoot,
    encoding: "utf8",
    timeout: CHILD_TIMEOUT_MS,
  });
  expect(
    "symlinked direct entry exits 0",
    symlinkRun.status === 0 && symlinkRun.signal === null,
    `status=${symlinkRun.status}`,
  );
  expect("symlinked direct entry writes settings", existsSync(settingsPath), settingsPath);
  const symlinkInstalled = JSON.parse(readFileSync(settingsPath, "utf8")) as {
    hooks?: { PreToolUse?: unknown[] };
  };
  expect(
    "symlinked direct entry installs PreToolUse settings",
    (symlinkInstalled.hooks?.PreToolUse?.length ?? 0) > 0,
  );

  const first = runInstaller(fixtureRoot);
  expect(
    "fresh install exits 0",
    first.status === 0 && first.signal === null,
    `status=${first.status}`,
  );
  expect("fresh install writes settings", existsSync(settingsPath));

  const installed = JSON.parse(readFileSync(settingsPath, "utf8")) as {
    hooks?: { PreToolUse?: Array<{ hooks?: Array<{ command?: string }> }> };
    permissions?: { deny?: string[] };
  };
  const hookCommand = installed.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command ?? "";
  expect(
    "installed hook command uses project-relative shell path",
    hookCommand.includes("scripts/claude-hooks/pre-tool-use.sh"),
    hookCommand,
  );
  expect("fresh install adds deny rules", (installed.permissions?.deny?.length ?? 0) > 0);

  const second = runInstaller(fixtureRoot);
  expect("rerun exits 0", second.status === 0 && second.signal === null, `status=${second.status}`);

  mkdirSync(path.dirname(settingsPath), { recursive: true });
  const preMergeSettings = {
    custom: "keep-me",
    hooks: {
      CustomHook: [{ matcher: "Custom", hooks: [{ type: "command", command: "echo custom" }] }],
    },
    permissions: {
      deny: ["Bash(custom:*)"],
    },
  };
  writeFileSync(settingsPath, `${JSON.stringify(preMergeSettings, null, 2)}\n`);

  const third = runInstaller(fixtureRoot);
  expect(
    "merge from missing template entries exits 0",
    third.status === 0 && third.signal === null,
    `status=${third.status}`,
  );
  const afterMerge = JSON.parse(readFileSync(settingsPath, "utf8")) as {
    custom?: string;
    hooks?: { PreToolUse?: unknown[]; CustomHook?: unknown[] };
    permissions?: { deny?: string[] };
  };
  expect("merge preserves custom settings", afterMerge.custom === "keep-me");
  expect("merge preserves custom hooks", Array.isArray(afterMerge.hooks?.CustomHook));
  expect("merge adds PreToolUse hook entries", (afterMerge.hooks?.PreToolUse?.length ?? 0) > 0);
  expect(
    "merge adds template deny rules",
    (afterMerge.permissions?.deny ?? []).some((rule) => rule.startsWith("Bash(sudo:")),
  );
  expect(
    "merge preserves custom deny rules",
    (afterMerge.permissions?.deny ?? []).includes("Bash(custom:*)"),
  );

  const mergedSnapshot = readFileSync(settingsPath, "utf8");
  const denyCountAfterMerge =
    (JSON.parse(mergedSnapshot) as { permissions?: { deny?: string[] } }).permissions?.deny
      ?.length ?? 0;

  const fourth = runInstaller(fixtureRoot);
  expect(
    "post-merge rerun exits 0",
    fourth.status === 0 && fourth.signal === null,
    `status=${fourth.status}`,
  );
  const afterSecondRerun = readFileSync(settingsPath, "utf8");
  expect("post-merge rerun is idempotent", afterSecondRerun === mergedSnapshot);
  expect(
    "post-merge rerun does not duplicate deny rules",
    (JSON.parse(afterSecondRerun) as { permissions?: { deny?: string[] } }).permissions?.deny
      ?.length === denyCountAfterMerge,
  );

  const invalidBytes = "{not-json";
  writeFileSync(settingsPath, invalidBytes);
  const invalid = runInstaller(fixtureRoot);
  expect(
    "invalid JSON exits 1",
    invalid.status === 1 && invalid.signal === null,
    `status=${invalid.status}`,
  );
  expect(
    "invalid JSON preserves existing bytes",
    readFileSync(settingsPath, "utf8") === invalidBytes,
  );

  // This stays entirely inside the temporary fixture. A personal local file
  // has higher precedence, so the installer must diagnose it rather than
  // overwriting or claiming the project hook is active.
  const localSettingsPath = path.join(fixtureRoot, ".claude/settings.local.json");
  writeFileSync(localSettingsPath, `${JSON.stringify({ disableAllHooks: true }, null, 2)}\n`);
  const disabledLocal = runInstaller(fixtureRoot);
  expect(
    "higher-precedence local disable exits 1",
    disabledLocal.status === 1 && disabledLocal.signal === null,
    `status=${disabledLocal.status}`,
  );
  expect(
    "status reports higher-precedence local disable",
    installerModule.claudeHooksStatus().state === "local-hooks-disabled",
  );
  expect(
    "local disable preserves project settings bytes",
    readFileSync(settingsPath, "utf8") === invalidBytes,
  );

  writeFileSync(localSettingsPath, "{not-json");
  const invalidLocal = runInstaller(fixtureRoot);
  expect(
    "invalid higher-precedence local settings exits 1",
    invalidLocal.status === 1 && invalidLocal.signal === null,
    `status=${invalidLocal.status}`,
  );
  expect(
    "status reports invalid higher-precedence local settings",
    installerModule.claudeHooksStatus().state === "local-invalid",
  );
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`install-claude-hooks regression: ${failures} failure(s).`);
  process.exit(1);
}

console.log(
  "install-claude-hooks regression OK — spaced path, import-safe entry, install, merge, idempotence, invalid JSON, local precedence.",
);
