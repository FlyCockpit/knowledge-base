/**
 * Install the project's Claude Code safety hooks into `.claude/settings.json`.
 *
 *   pnpm claude:hooks:install      (also runs as part of `pnpm run setup`)
 *
 * `.claude/` is personal and gitignored, so the template cannot ship the file
 * directly. The hook RULES are tracked in `scripts/claude-hooks/` and referenced
 * by path from the settings file, so `git pull` updates the rules without a
 * reinstall; this script only has to put the small settings file in place.
 *
 * Idempotent, and it MERGES: an existing `.claude/settings.json` keeps every key
 * the developer put there, and only the missing PreToolUse hook entries and
 * `permissions.deny` prefixes are added. The one hard failure is a settings file
 * that is not valid JSON — the script will not guess at what the developer meant.
 * `pnpm doctor` reports when the installed file has drifted from the template.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(import.meta.dirname!, "..");
const SOURCE = resolve(ROOT, "scripts/claude-hooks/settings.json");
const TARGET_DIR = resolve(ROOT, ".claude");
const TARGET = resolve(TARGET_DIR, "settings.json");
const LOCAL_TARGET = resolve(TARGET_DIR, "settings.local.json");
const HOOK_MARKER = "scripts/claude-hooks/pre-tool-use.sh";

type HookCommand = { type?: string; command?: string };
type HookEntry = { matcher?: string; hooks?: HookCommand[] };
type Settings = {
  hooks?: Record<string, HookEntry[]>;
  permissions?: Record<string, unknown> & { deny?: string[] };
} & Record<string, unknown>;

function log(msg: string) {
  console.log(`[claude-hooks] ${msg}`);
}

function readTemplate(): Settings {
  return JSON.parse(readFileSync(SOURCE, "utf8")) as Settings;
}

function entryReferencesHook(entry: HookEntry): boolean {
  return (entry.hooks ?? []).some((hook) => (hook.command ?? "").includes(HOOK_MARKER));
}

/**
 * Merge the template's PreToolUse entries and deny prefixes into `settings`,
 * mutating it in place. Returns what was added, so both the installer and
 * `pnpm doctor` can describe the drift in the same words.
 */
function mergeInto(settings: Settings, template: Settings): { hooks: string[]; deny: string[] } {
  const addedHooks: string[] = [];
  const addedDeny: string[] = [];

  const templateHooks = template.hooks?.PreToolUse ?? [];
  if (templateHooks.length > 0) {
    settings.hooks ??= {};
    settings.hooks.PreToolUse ??= [];
    const existing = settings.hooks.PreToolUse;
    for (const entry of templateHooks) {
      const already = existing.some(
        (candidate) => candidate.matcher === entry.matcher && entryReferencesHook(candidate),
      );
      if (already) continue;
      existing.push(entry);
      addedHooks.push(entry.matcher ?? "(no matcher)");
    }
  }

  const templateDeny = template.permissions?.deny ?? [];
  if (templateDeny.length > 0) {
    settings.permissions ??= {};
    settings.permissions.deny ??= [];
    const existing = settings.permissions.deny;
    for (const rule of templateDeny) {
      if (existing.includes(rule)) continue;
      existing.push(rule);
      addedDeny.push(rule);
    }
  }

  return { hooks: addedHooks, deny: addedDeny };
}

type ClaudeHooksStatus =
  | { state: "ok" }
  | { state: "missing" }
  | { state: "invalid"; detail: string }
  | { state: "local-invalid"; detail: string }
  | { state: "local-hooks-disabled" }
  | { state: "stale"; missingHooks: string[]; missingDeny: string[] };

type LocalSettingsStatus =
  | { state: "absent" }
  | { state: "ok" }
  | { state: "invalid"; detail: string }
  | { state: "hooks-disabled" };

/**
 * Claude Code gives the personal local settings file higher precedence than
 * the installed project settings. We never edit that personal file, but a
 * malformed file or `disableAllHooks` means the project hook cannot be relied
 * on and must be diagnosed before installer success is reported.
 */
function localSettingsStatus(): LocalSettingsStatus {
  if (!existsSync(LOCAL_TARGET)) return { state: "absent" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(LOCAL_TARGET, "utf8"));
  } catch (error) {
    return { state: "invalid", detail: error instanceof Error ? error.message : String(error) };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { state: "invalid", detail: "top-level JSON value must be an object" };
  }
  if ((parsed as Record<string, unknown>).disableAllHooks === true) {
    return { state: "hooks-disabled" };
  }
  return { state: "ok" };
}

/** Read-only inspection of `.claude/settings.json`, for `pnpm doctor`. */
export function claudeHooksStatus(): ClaudeHooksStatus {
  const local = localSettingsStatus();
  if (local.state === "invalid") return { state: "local-invalid", detail: local.detail };
  if (local.state === "hooks-disabled") return { state: "local-hooks-disabled" };
  if (!existsSync(TARGET)) return { state: "missing" };
  let parsed: Settings;
  try {
    parsed = JSON.parse(readFileSync(TARGET, "utf8")) as Settings;
  } catch (error) {
    return { state: "invalid", detail: error instanceof Error ? error.message : String(error) };
  }
  const added = mergeInto(parsed, readTemplate());
  if (added.hooks.length === 0 && added.deny.length === 0) return { state: "ok" };
  return { state: "stale", missingHooks: added.hooks, missingDeny: added.deny };
}

export function installClaudeHooks():
  | "installed"
  | "present"
  | "merged"
  | "invalid"
  | "local-invalid"
  | "local-hooks-disabled" {
  const local = localSettingsStatus();
  if (local.state === "invalid") {
    log(
      `.claude/settings.local.json is not valid JSON (${local.detail}). Fix that personal higher-precedence file, then re-run this command.`,
    );
    return "local-invalid";
  }
  if (local.state === "hooks-disabled") {
    log(
      ".claude/settings.local.json sets disableAllHooks: true and takes precedence over the project safety hook. Remove that override yourself, then re-run this command.",
    );
    return "local-hooks-disabled";
  }
  const source = readFileSync(SOURCE, "utf8");
  if (!existsSync(TARGET)) {
    mkdirSync(TARGET_DIR, { recursive: true });
    writeFileSync(TARGET, source);
    log(`wrote .claude/settings.json — Claude Code will ask you to trust these hooks; say yes.`);
    return "installed";
  }

  let existing: Settings;
  try {
    existing = JSON.parse(readFileSync(TARGET, "utf8")) as Settings;
  } catch (error) {
    log(
      `.claude/settings.json is not valid JSON (${error instanceof Error ? error.message : String(error)}).`,
    );
    log(`Fix the JSON, or delete the file and re-run this command to reinstall from ${SOURCE}.`);
    return "invalid";
  }

  const added = mergeInto(existing, JSON.parse(source) as Settings);
  if (added.hooks.length === 0 && added.deny.length === 0) {
    log(".claude/settings.json already has the safety hook and deny rules — nothing to do.");
    return "present";
  }

  writeFileSync(TARGET, `${JSON.stringify(existing, null, 2)}\n`);
  if (added.hooks.length > 0) {
    log(`added PreToolUse hook entries for: ${added.hooks.join(", ")}`);
  }
  if (added.deny.length > 0) {
    log(`added ${added.deny.length} deny rule(s): ${added.deny.join(", ")}`);
  }
  log("merged into your existing .claude/settings.json — your other settings were left alone.");
  return "merged";
}

const isDirectRun =
  process.argv[1] !== undefined &&
  (() => {
    try {
      return (
        realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))
      );
    } catch {
      return false;
    }
  })();
if (isDirectRun) {
  const outcome = installClaudeHooks();
  process.exit(
    outcome === "invalid" || outcome === "local-invalid" || outcome === "local-hooks-disabled"
      ? 1
      : 0,
  );
}
