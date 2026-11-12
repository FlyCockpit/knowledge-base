/**
 * Regenerates the `.env.example` files from `scripts/lib/env-manifest.ts`, and
 * verifies that the manifest still covers every key declared in the Zod env
 * schemas.
 *
 *   pnpm env:sync    — rewrite the .env.example files
 *   pnpm env:check   — verify without writing (CI gate; non-zero exit on drift)
 *
 * What it catches: a schema key nobody added to the manifest, a manifest entry naming a
 * key or group that doesn't exist, a variable declared inline in a createEnv
 * call instead of in packages/env/src/vars/, a stale generated .env.example,
 * and a root .env.example whose documented-key count blew the presentation
 * budget (70).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import {
  ENV_GROUPS,
  ENV_VARS,
  type EnvFile,
  type EnvVar,
  groupsForFile,
  varsInGroup,
} from "./lib/env-manifest.js";
import { scanSchemaKeys } from "./lib/env-schema.js";

const ROOT = resolve(import.meta.dirname!, "..");
const CHECK = process.argv.includes("--check");

// ---------------------------------------------------------------------------
// Where each file lives, and its header prose
// ---------------------------------------------------------------------------

interface FileSpec {
  file: EnvFile;
  path: string;
  header: string[];
}

const GENERATED_BANNER = [
  "GENERATED FROM scripts/lib/env-manifest.ts — DO NOT EDIT BY HAND.",
  "Add or change a variable in that manifest, then run `pnpm env:sync`.",
];

const FILES: FileSpec[] = [
  {
    file: "root",
    path: ".env.example",
    header: [
      ...GENERATED_BANNER,
      "",
      "This is the single canonical .env location — loaded by every package.",
      "Copy to .env and fill in real values: cp .env.example .env",
      "Do NOT create per-app .env files (e.g. apps/server/.env).",
      "",
      "For a PRODUCTION environment, don't fill this in by hand — run",
      "`pnpm generate:secrets`. It generates the random values, prompts only for",
      "what it can't know, skips whatever your deploy platform injects, and",
      "validates the result before printing it.",
      "",
      "Server vs worker: the env package is split. The BullMQ worker validates",
      "only the worker-safe (shared) surface — DATABASE_URL, REDIS_URL,",
      "NODE_ENV, KB_ASSET_* location/cache settings, SMTP, and the translation",
      "keys. The server-only vars (BETTER_AUTH_*, CORS_ORIGIN, SSO_*,",
      "SIGNUP_ENABLED, VAPID_*, ADMIN_EMAIL, RATE_LIMIT_*, IMAGE_*,",
      "ASSET_UPLOAD_MAX_BYTES, SSR_CACHE_TTL_SECONDS) are NOT required by a",
      "worker-only deployment. For local dev you set everything in one file",
      "regardless; the split only matters when server and worker run on",
      "separate hosts. Sections are tagged [shared] or [server-only].",
      "",
      "Structure: core/required vars first, then optional feature blocks",
      "(shipped commented out — uncommenting a block is what turns the feature",
      "on), then one clearly-marked Advanced tuning section of one-off knobs,",
      "each commented with its working default. The FULL variable catalog —",
      "including one-shot restore/runtime knobs that must stay unset on",
      "normal services — lives in scripts/lib/env-manifest.ts.",
      "",
      "NOTE: There is no auth-bypass mode. To exercise the real signup →",
      "email-verification → 2FA flow locally, use `pnpm dev:docker` — it ships",
      "an in-stack mailpit SMTP sink that captures verification email offline",
      "with zero credentials.",
    ],
  },
  {
    file: "web",
    path: "apps/web/.env.example",
    header: [...GENERATED_BANNER],
  },
];

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function commentBlock(lines: string[]): string[] {
  return lines.map((line) => (line ? `# ${line}` : "#"));
}

function renderVar(v: EnvVar, groupIsOptional: boolean): string[] {
  const out: string[] = [];

  // `comment` is the var's prose block. `hint` is the one-liner the interactive
  // generator prints under its prompt — without this fallback that guidance
  // ("required when TRANSLATION_PROVIDER=openrouter", "auto for R2") existed
  // only inside `generate:secrets` and silently vanished from .env.example.
  if (v.comment) out.push(...commentBlock(v.comment));
  else if (v.hint) out.push(...commentBlock([v.hint]));

  if (v.choices) {
    out.push(...commentBlock([`Allowed: ${v.choices.map((c) => c.value).join(" | ")}`]));
  }

  // `generate` vars are emitted live but empty — the value is per-environment
  // and must never be committed, so an empty assignment is the honest form.
  // Inside an optional group they stay commented like everything else, so that
  // uncommenting the block is what turns the feature on.
  if (v.source === "generate") {
    out.push(groupIsOptional ? `# ${v.key}=` : `${v.key}=`);
    return out;
  }

  // `enable` flips to true when its optional group is turned on in
  // generate:secrets. In .env.example show the on-value so uncommenting the
  // block is enough.
  if (v.source === "enable") {
    out.push(groupIsOptional ? `# ${v.key}=true` : `${v.key}=true`);
    return out;
  }

  const value = v.example ?? v.default ?? "";
  const live = v.exampleSet && !groupIsOptional;
  out.push(live ? `${v.key}=${value}` : `# ${v.key}=${value}`);
  return out;
}

function renderSection(
  title: string,
  comment: string[] | undefined,
  optional: boolean,
  vars: EnvVar[],
  sub = false,
): string[] {
  // Sub-sections (a group's advanced knobs inside the trailing Advanced
  // tuning block) get a distinct marker so they cannot be mistaken for the
  // top-level feature sections above — "Auth" appearing twice with identical
  // ruled headings is exactly that trap.
  const heading = sub
    ? `# === ${title} ===`
    : `# --- ${title} ${"-".repeat(Math.max(3, 70 - title.length))}`;
  const out: string[] = ["", heading];
  if (comment) out.push(...commentBlock(comment));
  if (optional) out.push("#", "# Disabled by default — uncomment to enable.");

  // Blank line before a var only when it carries its own comment block, so
  // runs of related bare assignments (the SMTP_* block, say) stay contiguous.
  vars.forEach((v, i) => {
    if (i === 0 || v.comment) out.push("");
    out.push(...renderVar(v, optional));
  });
  return out;
}

const ADVANCED_INTRO = [
  "One-off tuning knobs, grouped by feature. Every value has a working",
  "default shown on its line — uncomment and change ONLY the one you need.",
  "Rate-limit budgets rescale their whole limiter family coherently",
  "(multiplier = provided / reference); tighter is not safer — see",
  "AGENTS.md § Rate limiting — one bucket per surface.",
  "Deeper one-shot knobs (restore confirmations, runtime identities) are",
  "deliberately absent from this file;",
  "the full catalog lives in scripts/lib/env-manifest.ts.",
];

function renderFile(spec: FileSpec): string {
  const rule = "=".repeat(77);
  const out: string[] = [`# ${rule}`, ...commentBlock(spec.header), `# ${rule}`];

  // `advanced` vars are pulled out of their feature section and collected into
  // ONE trailing section, so a nontechnical operator reads the decisions first
  // and the knobs last. `hidden` vars stay in the manifest (and in
  // generate:secrets) but never reach this file at all.
  const advanced: Array<{ group: (typeof ENV_GROUPS)[number]; vars: EnvVar[] }> = [];

  for (const group of groupsForFile(spec.file)) {
    const visible = varsInGroup(group.id).filter((v) => !v.hidden);
    if (visible.length === 0) continue;

    const inPlace = visible.filter((v) => !v.advanced);
    const deferred = visible.filter((v) => v.advanced);
    if (deferred.length > 0) advanced.push({ group, vars: deferred });
    if (inPlace.length === 0) continue;

    out.push(...renderSection(group.title, group.comment, Boolean(group.prompt), inPlace));
  }

  if (advanced.length > 0) {
    out.push(...renderSection("Advanced tuning", ADVANCED_INTRO, false, []));
    for (const { group, vars } of advanced) {
      // Sub-heading keeps the feature context; the group's own comment is
      // dropped here unless the whole group is tuning-only, where it carries
      // the "how scaling works" prose rather than an enable instruction.
      const comment = group.tuning ? group.comment : undefined;
      out.push(...renderSection(group.title, comment, false, vars, true));
    }
  }

  return `${out.join("\n")}\n`;
}

/**
 * Lines that assign a key, commented or not — the "documented keys" count the
 * ≤70 budget is measured against. Prose comments never match: an assignment
 * line is `KEY=` optionally under a single leading `#`.
 */
function countDocumentedKeys(content: string): number {
  return content.split("\n").filter((l) => /^# ?[A-Z][A-Z0-9_]*=|^[A-Z][A-Z0-9_]*=/.test(l)).length;
}

/** Ceiling on documented keys in the root .env.example — the collapse budget. */
const ROOT_EXAMPLE_KEY_BUDGET = 70;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const problems: string[] = [];

// 0. The scan itself must be trustworthy. A vars/ module that won't import, or
//    a key declared inline in a createEnv call, means keys exist that this scan
//    cannot see — report that instead of quietly checking a subset.
const scan = await scanSchemaKeys(ROOT);
problems.push(...scan.errors);

// 1. Coverage: schema → manifest.
const declared = scan.keys;
const known = new Set(ENV_VARS.map((v) => v.key));
for (const [key, source] of declared) {
  if (!known.has(key)) {
    problems.push(
      `${key} is declared in ${source} but missing from scripts/lib/env-manifest.ts.\n` +
        `    Add an entry to ENV_VARS so \`pnpm generate:secrets\` knows about it, ` +
        `then run \`pnpm env:sync\`.`,
    );
  }
}

// 2. Coverage: manifest → schema (catches typos and stale entries).
for (const v of ENV_VARS) {
  if (v.inSchema === false) continue;
  if (!declared.has(v.key)) {
    problems.push(
      `${v.key} is in scripts/lib/env-manifest.ts but is not declared in any ` +
        `packages/env/src/vars/*.ts declaration object.\n` +
        `    Either add it to a schema, remove the manifest entry, or mark it ` +
        `\`inSchema: false\` if it is read outside the schemas (e.g. by a shell script).`,
    );
  }
}

// 3. Duplicate keys.
const seen = new Set<string>();
for (const v of ENV_VARS) {
  if (seen.has(v.key)) problems.push(`${v.key} appears more than once in ENV_VARS.`);
  seen.add(v.key);
}

// 4. Every var belongs to a group that exists, and to the same file as that
//    group. Neither is cosmetic: rendering and prompting both walk
//    groups → vars, so a var whose `group` is a typo is silently invisible in
//    the .env.example AND never prompted for, while the key-set checks above
//    still pass. A `file` mismatch renders a var into one .env.example while
//    the generator treats it as belonging to another.
const groupsById = new Map(ENV_GROUPS.map((g) => [g.id, g]));
for (const v of ENV_VARS) {
  const group = groupsById.get(v.group);
  if (!group) {
    problems.push(
      `${v.key} is in group "${v.group}", which does not exist in ENV_GROUPS.\n` +
        `    It would be dropped from every .env.example and never prompted for. ` +
        `Fix the group name or add the group.`,
    );
    continue;
  }
  const varFile = v.file ?? "root";
  const groupFile = group.file ?? "root";
  if (varFile !== groupFile) {
    problems.push(
      `${v.key} declares file "${varFile}" but its group "${group.id}" renders into ` +
        `"${groupFile}".\n    Move the var to a group in the same file, or drop its \`file\`.`,
    );
  }
}

// 5. `hidden` / `advanced` presentation flags are coherent. Both only move a
//    var around in `.env.example` — a var that is prompted for, generated, or
//    flips a feature on must stay visible in its own section, and a var can't
//    be both relocated to Advanced tuning and dropped from the file at once.
for (const v of ENV_VARS) {
  if (v.hidden && v.advanced) {
    problems.push(`${v.key} is marked both hidden and advanced — pick one presentation.`);
  }
  if ((v.hidden || v.advanced) && v.source !== "default" && v.source !== "manual") {
    problems.push(
      `${v.key} is marked ${v.hidden ? "hidden" : "advanced"} but has source "${v.source}". ` +
        `Only default/manual vars (documented tuning knobs) may move out of their section — ` +
        `prompted, generated, and enable vars must stay visible where they are.`,
    );
  }
}

// 6. The generated files match the manifest.
//
//    A missing target file is skipped rather than fatal. Removing a feature
//    module is a documented teardown — ripping out
//    a client can remove its generated example; removing the web app
//    is possible too. Reading unconditionally here would abort `env:check`
//    *and* `env:sync` with a raw ENOENT stack trace, leaving the developer
//    unable to regenerate the files that do remain.
const stale: string[] = [];
for (const spec of FILES) {
  const path = resolve(ROOT, spec.path);
  if (!existsSync(path)) {
    console.log(`[env] skipping ${spec.path} — not present (feature module removed?)`);
    continue;
  }
  const next = renderFile(spec);
  // The root file is the surface a nontechnical operator reads; the documented
  // keys it carries are budgeted. New vars go in the manifest as usual, but a
  // count over budget means the presentation choices (hidden / advanced /
  // commented) need revisiting — not that the budget silently grows.
  if (spec.file === "root" && countDocumentedKeys(next) > ROOT_EXAMPLE_KEY_BUDGET) {
    problems.push(
      `.env.example documents ${countDocumentedKeys(next)} keys (budget: ${ROOT_EXAMPLE_KEY_BUDGET}). ` +
        `Mark one-off knobs hidden, or fold per-surface knobs into a shared budget ` +
        `(see the rate-limit families for the pattern), instead of growing the file.`,
    );
  }
  const current = readFileSync(path, "utf-8");
  if (current === next) continue;

  if (CHECK) {
    stale.push(relative(ROOT, path));
  } else {
    writeFileSync(path, next);
    console.log(`[env] wrote ${spec.path}`);
  }
}

// The agent defaults carry a generated, empty asset block. Compose additionally
// overrides these with explicit AGENT_ opt-ins, so host .env cannot select a bucket.
const dockerDefaultsPath = resolve(ROOT, ".env.docker.defaults");
if (existsSync(dockerDefaultsPath)) {
  const marker = "# --- Generated asset defaults (pnpm env:sync) ---";
  const current = readFileSync(dockerDefaultsPath, "utf-8");
  const prefix = current
    .split(marker)[0]!
    .trimEnd()
    .replace(
      /(# │ For production see:[^\n]*\n)[\s\S]*?(?=# └)/,
      "$1" +
        "# │   docs/deploy.md  — required envs, secrets custody, schema readiness     │\n" +
        "# │   docs/hosting.md — hosting model, backups and key retention             │\n",
    );
  const block = ENV_VARS.filter((v) => v.group === "assets").map(
    (v) =>
      `${v.key}=${v.key === "KB_ASSET_S3_ENABLED" || v.key === "KB_ASSET_S3_FORCE_PATH_STYLE" ? "false" : ""}`,
  );
  const next = `${prefix}\n\n${marker}\n${block.join("\n")}\n`;
  if (next !== current) {
    if (CHECK) stale.push(".env.docker.defaults");
    else {
      writeFileSync(dockerDefaultsPath, next);
      console.log("[env] wrote .env.docker.defaults");
    }
  }
}

if (stale.length > 0) {
  problems.push(
    `${stale.join(", ")} ${stale.length === 1 ? "is" : "are"} out of date.\n` +
      `    Run \`pnpm env:sync\` and commit the result.`,
  );
}

if (problems.length > 0) {
  console.error("\n[env] environment manifest check failed:\n");
  for (const p of problems) console.error(`  ✗ ${p}\n`);
  process.exit(1);
}

console.log(
  CHECK
    ? `[env] OK — manifest covers ${declared.size} schema keys and the .env.example files are current.`
    : `[env] OK — ${declared.size} schema keys covered.`,
);
