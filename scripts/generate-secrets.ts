/**
 * Builds a ready-to-paste production environment block.
 *
 *   pnpm generate:secrets                  # print to stdout
 *   pnpm generate:secrets --out .env.prod  # write to a file (must be gitignored)
 *   pnpm generate:secrets --target vps    # skip the deploy-target question
 *   pnpm generate:secrets --all            # also emit the tuning knobs, commented
 *
 * What it does, in order:
 *   1. Asks which platform you're deploying to, so it can skip the variables
 *      that platform injects for you.
 *   2. Generates every value that is just entropy — BETTER_AUTH_SECRET, the
 *      VAPID keypair.
 *   3. Offers to reuse credentials already present in your shell environment
 *      for the groups that hold them (SMTP, object storage, translation), so
 *      standing up another prototype against the same provider is one keypress.
 *   4. Prompts for the rest — pick-lists for enums, yes/no for booleans, masked
 *      input for secrets.
 *   5. Leaves everything with a documented default alone.
 *   6. Validates against the real Zod env schemas in a child process, and
 *      round-trips the rendered block through dotenv, before printing anything.
 *
 * Every variable it knows about comes from `scripts/lib/env-manifest.ts`. If you
 * add an env var without adding it there, `pnpm env:check` fails in CI.
 */

import { spawnSync } from "node:child_process";
import { createECDH, randomBytes } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { confirm, input, password, select } from "@inquirer/prompts";
import { parse as parseDotenv } from "dotenv";
import {
  DEPLOY_TARGETS,
  ENV_VARS,
  type EnvVar,
  groupsForFile,
  varsInGroup,
} from "./lib/env-manifest.js";
import { scanSchemaKeys } from "./lib/env-schema.js";

const ROOT = resolve(import.meta.dirname!, "..");

// Everything the script says goes to stderr, so `pnpm generate:secrets > .env`
// captures only the env block itself. Inquirer is told the same (see PROMPT_IO).
function say(msg = "") {
  process.stderr.write(`${msg}\n`);
}

function fail(msg: string): never {
  say(`\n[generate:secrets] ERROR: ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Prompting
//
// Interactive runs use Inquirer (arrow-key pick-lists, masked passwords).
// Inquirer needs a real terminal — with piped stdin it reaches for /dev/tty,
// which is wrong for scripted runs — so non-TTY input falls back to a plain
// line reader. Exactly one of the two ever touches stdin.
// ---------------------------------------------------------------------------

const INTERACTIVE = Boolean(process.stdin.isTTY);
const PROMPT_IO = { output: process.stderr } as const;

/** Plain line reader. Only constructed when stdin is NOT a TTY. */
const lineQueue: string[] = [];
let lineWaiter: ((line: string) => void) | null = null;
let stdinEnded = false;

if (!INTERACTIVE) {
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (lineWaiter) {
      const resolveLine = lineWaiter;
      lineWaiter = null;
      resolveLine(line);
    } else {
      lineQueue.push(line);
    }
  });
  rl.on("close", () => {
    stdinEnded = true;
    if (lineWaiter) fail("input ended before every question was answered.");
  });
}

async function readLine(prompt: string): Promise<string> {
  process.stderr.write(prompt);
  const queued = lineQueue.shift();
  if (queued !== undefined) return queued;
  if (stdinEnded) fail("input ended before every question was answered.");
  return new Promise<string>((resolveLine) => {
    lineWaiter = resolveLine;
  });
}

interface TextOptions {
  message: string;
  hint?: string;
  default?: string;
  secret?: boolean;
  /** Return an error string to reject, or null to accept. */
  validate?: (value: string) => string | null;
}

async function askText(opts: TextOptions): Promise<string> {
  if (INTERACTIVE) {
    const validate = (value: string) => {
      const error = opts.validate?.(value.trim());
      return error ?? true;
    };
    const answer = opts.secret
      ? await password({ message: opts.message, mask: true, validate }, PROMPT_IO)
      : await input({ message: opts.message, default: opts.default, validate }, PROMPT_IO);
    // Secrets are handed back verbatim: a pasted credential with a meaningful
    // trailing character must not be silently altered.
    return opts.secret ? answer : answer.trim();
  }

  if (opts.hint) say(`    ${opts.hint}`);
  for (;;) {
    const raw = await readLine(`  ${opts.message}: `);
    const answer = opts.secret ? raw.replace(/\r$/, "") : raw.trim();
    const candidate = answer === "" && opts.default ? opts.default : answer;
    const error = opts.validate?.(candidate.trim());
    if (error) {
      say(`    ↑ ${error}`);
      continue;
    }
    return candidate;
  }
}

async function askSelect(opts: {
  message: string;
  choices: Array<{ value: string; label?: string; description?: string }>;
  default?: string;
}): Promise<string> {
  if (INTERACTIVE) {
    return select(
      {
        message: opts.message,
        default: opts.default,
        choices: opts.choices.map((c) => ({
          value: c.value,
          name: c.label ?? c.value,
          description: c.description,
        })),
      },
      PROMPT_IO,
    );
  }

  const values = opts.choices.map((c) => c.value);
  say(`    options: ${values.join(" | ")}`);
  for (;;) {
    const raw = (await readLine(`  ${opts.message}: `)).trim();
    if (raw === "" && opts.default) return opts.default;
    // Accept the value itself or a 1-based index, so scripted runs can use either.
    if (values.includes(raw)) return raw;
    const index = Number(raw);
    if (Number.isInteger(index) && index >= 1 && index <= values.length) {
      return values[index - 1]!;
    }
    say(`    ↑ pick one of: ${values.join(", ")}`);
  }
}

async function askConfirm(message: string, fallback: boolean): Promise<boolean> {
  if (INTERACTIVE) return confirm({ message, default: fallback }, PROMPT_IO);

  const suffix = fallback ? "[Y/n]" : "[y/N]";
  for (;;) {
    const answer = (await readLine(`${message} ${suffix} `)).trim().toLowerCase();
    if (answer === "") return fallback;
    if (["y", "yes"].includes(answer)) return true;
    if (["n", "no"].includes(answer)) return false;
  }
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const INCLUDE_TUNING = argv.includes("--all");

function flagValue(name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("-")) {
    fail(`${name} requires a value (got ${v === undefined ? "nothing" : `"${v}"`}).`);
  }
  return v;
}

const outPath = flagValue("--out");
const targetFlag = flagValue("--target");

/**
 * Validate the --out path BEFORE any prompting.
 *
 * Every one of these checks is cheap and pure, and running them at the end
 * meant a typo'd path threw away the whole session — a freshly generated
 * BETTER_AUTH_SECRET, a VAPID keypair, and every hand-typed credential — with
 * nothing on stdout to recover them from.
 */
function resolveOutPath(target: string): string {
  const resolved = isAbsolute(target) ? target : resolve(process.cwd(), target);

  // Resolve the PARENT through symlinks before deciding "inside the repo":
  // `git check-ignore` answers about the lexical path, while the write follows
  // links. Without this, `.env.symlink -> patterns/notes.md` passes the ignore
  // check (`.env*` is ignored) and drops live credentials into a committable file.
  let parentReal: string;
  try {
    parentReal = realpathSync(dirname(resolved));
  } catch {
    fail(`the directory for ${target} does not exist.`);
  }
  const finalPath = resolve(parentReal, basename(resolved));

  let existing: ReturnType<typeof lstatSync> | null = null;
  try {
    existing = lstatSync(finalPath);
  } catch {
    existing = null;
  }
  if (existing?.isSymbolicLink()) {
    fail(
      `${target} is a symlink. Refusing to write credentials through it — the ` +
        "gitignore check applies to the link, but the bytes land on its target.",
    );
  }
  if (existing) {
    fail(`${target} already exists. Move or delete it first — refusing to overwrite.`);
  }

  // A file full of production credentials must not be committable. Inside the
  // repo, `.gitignore` is the thing that guarantees that — so check it, rather
  // than trusting the filename.
  if (!relative(ROOT, finalPath).startsWith("..")) {
    const ignored = spawnSync("git", ["check-ignore", "-q", finalPath], { cwd: ROOT });
    // `git` missing or unrunnable is not "the path is committable" — say which
    // one it is, or the reader chases a gitignore rule that was never the
    // problem. Either way we refuse: unverified is not safe here.
    if (ignored.error) {
      fail(
        `could not run \`git check-ignore\` (${ignored.error.message}), so it is unknown\n` +
          `  whether ${relative(ROOT, finalPath)} is committable. Refusing to write production\n` +
          "  credentials to an unverified path inside the repo. Write outside the repo instead.",
      );
    }
    if (ignored.status !== 0) {
      fail(
        `${relative(ROOT, finalPath)} is inside the repo and is NOT gitignored.\n` +
          "  Refusing to write production credentials to a committable path. Use a\n" +
          "  `.env*` filename (all of which are gitignored), or a path outside the repo.",
      );
    }
  }

  return finalPath;
}

// Checked up front; the final `wx` write still guards against a file appearing
// in the meantime.
const finalPath = outPath ? resolveOutPath(outPath) : null;

// ---------------------------------------------------------------------------
// Generators + dotenv encoding
// ---------------------------------------------------------------------------

/** 64 hex chars — comfortably past the 32-char BETTER_AUTH_SECRET minimum. */
function secret32(): string {
  return randomBytes(32).toString("hex");
}

/** Canonical base64 of 32 random bytes (KB_MASTER_KEY). */
function secret32b64(): string {
  return randomBytes(32).toString("base64");
}

/**
 * Encode a value for a dotenv assignment.
 *
 * This mirrors what dotenv's parser ACTUALLY does, which is less than you'd
 * assume: it strips one layer of surrounding quotes and, for double-quoted
 * values only, expands `\n` and `\r`. It never unescapes `\\` or `\"`. So the
 * intuitive "wrap in double quotes and backslash-escape" is wrong — it round
 * trips to different bytes, silently corrupting any credential containing a
 * backslash or a quote.
 *
 * Single quotes are therefore the preferred wrapper (fully literal), with
 * backticks as the fallback when the value itself contains a single quote.
 */
function encodeEnvValue(value: string): string {
  if (value === "") return "";
  if (/^[A-Za-z0-9_./:@%+,=-]+$/.test(value)) return value;
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes("`")) return `\`${value}\``;
  if (!value.includes('"') && !value.includes("\\")) return `"${value}"`;
  fail(
    "a value contains a single quote, a backtick, and either a double quote or a " +
      "backslash, so it cannot be written unambiguously into a .env file.\n" +
      "  Set this one by hand in your platform's secrets UI.",
  );
}

function envAssignment(key: string, value: string): string {
  return `${key}=${encodeEnvValue(value)}`;
}

let vapidCache: { publicKey: string; privateKey: string } | null = null;

/**
 * Generate a VAPID keypair with node:crypto rather than shelling out to
 * `pnpm -F @knowledge-base/api exec web-push`.
 *
 * VAPID keys are just a P-256 keypair in the encoding the Web Push spec (RFC
 * 8292) mandates: the public key is the 65-byte uncompressed EC point, the
 * private key the 32-byte scalar, both base64url. `web-push` does exactly this
 * and nothing more, so the subprocess bought a dependency on the workspace
 * being installed AND on the package still being named `@knowledge-base/api` — which
 * the template's own rebrand step renames, after which this died at the VAPID
 * prompt with "run `pnpm install` first", a message pointing nowhere near the
 * real cause.
 */
function vapidPair(): { publicKey: string; privateKey: string } {
  if (vapidCache) return vapidCache;
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  // getPrivateKey() strips leading zero bytes, so left-pad to the fixed 32-byte
  // width the spec requires — a short key is silently rejected by push services.
  const priv = ecdh.getPrivateKey();
  const padded = Buffer.alloc(32);
  priv.copy(padded, 32 - priv.length);
  vapidCache = {
    publicKey: ecdh.getPublicKey().toString("base64url"),
    privateKey: padded.toString("base64url"),
  };
  return vapidCache;
}

function generate(v: EnvVar): string {
  switch (v.generator) {
    case "secret32":
      return secret32();
    case "secret32b64":
      return secret32b64();
    case "vapid-public":
      return vapidPair().publicKey;
    case "vapid-private":
      return vapidPair().privateKey;
    default:
      fail(`${v.key} has source "generate" but no generator in the manifest.`);
  }
}

/**
 * Preview of a value read out of the ambient environment, shown BEFORE the
 * operator has agreed to reuse anything.
 *
 * Masking is not limited to `secret: true`. `SMTP_USER` is an IAM access key ID
 * on SES and the account credential on Mailgun/Postmark; an R2 `S3_ENDPOINT`
 * embeds the account ID. Anything offered for reuse is a credential or names
 * the account behind one, so short values are hidden outright and longer ones
 * reveal only enough of a prefix to be recognisable.
 */
function preview(v: EnvVar, value: string): string {
  const identifying = v.secret || REUSE_SENSITIVE.has(v.key);
  if (!identifying) return value;
  if (value.length <= 8) return `${"•".repeat(8)} (${value.length} chars)`;
  return `${value.slice(0, 3)}${"•".repeat(Math.min(12, value.length - 3))} (${value.length} chars)`;
}

/**
 * Reuse-offer values that are not marked `secret` (they are not passwords) but
 * still identify the account behind the credential, so they are masked in the
 * pre-confirmation listing.
 */
const REUSE_SENSITIVE = new Set(["SMTP_USER", "S3_ENDPOINT", "S3_ACCESS_KEY_ID"]);

/** Character classes only — safe to paste into a bug report. */
function describeShape(value: string): string {
  const classes: string[] = [];
  if (/[a-z]/.test(value)) classes.push("lowercase");
  if (/[A-Z]/.test(value)) classes.push("uppercase");
  if (/[0-9]/.test(value)) classes.push("digits");
  if (/[\r]/.test(value)) classes.push("CR");
  if (/[\n]/.test(value)) classes.push("LF");
  if (/[\t]/.test(value)) classes.push("tab");
  if (/^\s|\s$/.test(value)) classes.push("leading/trailing whitespace");
  for (const [label, ch] of [
    ["single-quote", "'"],
    ["double-quote", '"'],
    ["backtick", "`"],
    ["backslash", "\\"],
    ["dollar", "$"],
    ["hash", "#"],
  ] as const) {
    if (value.includes(ch)) classes.push(label);
  }
  return `${value.length} chars; contains ${classes.length ? classes.join(", ") : "no notable characters"}`;
}

/**
 * Mirrors the refinements in `packages/env/src/url.ts` so the operator hears
 * about a malformed origin at the prompt rather than after answering every
 * other question. The schema remains the authority — this is an early echo of
 * it, not a replacement.
 */
function formatError(v: EnvVar, value: string): string | null {
  if (!v.format || value === "") return null;

  if (v.format === "origin") {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return "must be a valid URL, e.g. https://app.example.com";
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "must use http or https";
    }
    if (url.username || url.password) return "must not include credentials";
    if (url.pathname !== "/" || url.search || url.hash) {
      return "must be an origin only — no path, query, or hash";
    }
    return null;
  }

  return /^(mailto:|https:)/.test(value)
    ? null
    : "must be a mailto: or https: URL (push services use it to reach you)";
}

function rejectNewlines(value: string): string | null {
  return /[\r\n]/.test(value) ? "value cannot contain a line break" : null;
}

// ---------------------------------------------------------------------------
// Collect
// ---------------------------------------------------------------------------

const values = new Map<string, string>();
/** Keys the platform supplies, reported in the header. */
const injected: string[] = [];
/** Keys the operator chose to leave out, reported in the header. */
const omitted: string[] = [];

say("");
say("  Production environment generator");
say("  ────────────────────────────────");
say("  Generates what it can, asks for what it can't. Ctrl-C to bail.");
say("");

// --- deploy target ---
let target = DEPLOY_TARGETS.find((t) => t.id === targetFlag);
if (targetFlag && !target) {
  fail(`unknown --target "${targetFlag}". Valid: ${DEPLOY_TARGETS.map((t) => t.id).join(", ")}`);
}

if (!target) {
  const picked = await askSelect({
    message: "Where are you deploying?",
    default: "vps",
    choices: DEPLOY_TARGETS.map((t) => ({
      value: t.id,
      label: t.label,
      description: t.note,
    })),
  });
  target = DEPLOY_TARGETS.find((t) => t.id === picked)!;
}

const platformInjects = new Set<string>(target.injects);

say("");
say(`  → ${target.label}. ${target.note}`);
say(`    Reference: ${target.doc}`);

// --- groups ---
for (const group of groupsForFile("root")) {
  const vars = varsInGroup(group.id);
  if (vars.length === 0) continue;

  // Tuning groups are pure defaults — never prompted, only emitted with --all.
  if (group.tuning) continue;

  if (!group.always) {
    // An earlier answer can make an "optional" group mandatory. Force it on
    // here and say why, rather than letting the contradiction surface in the
    // final validation pass after every question has been answered.
    const forced =
      group.requiredWhen && values.get(group.requiredWhen.key) === group.requiredWhen.equals
        ? group.requiredWhen
        : null;

    if (forced) {
      say("");
      say(`  ${group.title} — required, because ${forced.because}.`);
    } else {
      say("");
      const enabled = await askConfirm(`  ${group.prompt}`, group.default ?? false);
      if (!enabled) continue;
    }
  }

  say("");
  say(`  ${group.title}`);

  // Offer to reuse credentials already exported in this shell. The point is
  // pointing several prototype apps at one SMTP/S3/LLM account without digging
  // the keys out again. Only values actually present are offered, and secrets
  // are previewed, never printed.
  //
  // `reusable: false` excludes the vars that identify one specific app rather
  // than the shared account behind it (S3_BUCKET, SMTP_FROM) — reuse is
  // all-or-nothing per group, so without this, accepting the SMTP offer would
  // also inherit the previous app's From: address.
  const reusable = group.reuseFromEnv
    ? vars.filter(
        (v) =>
          v.source === "prompt" &&
          v.reusable !== false &&
          !platformInjects.has(v.key) &&
          (process.env[v.key] ?? "") !== "",
      )
    : [];

  let reuse = false;
  if (reusable.length > 0) {
    say("");
    say("  Found these in your current shell environment:");
    for (const v of reusable) say(`    ${v.key}=${preview(v, process.env[v.key]!)}`);
    // Defaults to NO on purpose. These are real credentials read out of the
    // ambient environment, and the block they would land in gets printed to
    // stdout — so opting IN must be a deliberate keypress, never what happens
    // when someone hits enter or pipes an ambiguous answer.
    reuse = await askConfirm("  Reuse them?", false);
    say("");
  }

  for (const v of vars) {
    if (platformInjects.has(v.key)) {
      injected.push(v.key);
      continue;
    }

    if (reuse && reusable.includes(v)) {
      // Ambient values are not typed at a prompt, so they never met
      // rejectNewlines/formatError. Without this an inherited CR sails through
      // Zod validation and only blows up in the dotenv round trip at the very
      // end, blaming the tool instead of the value.
      const ambient = process.env[v.key]!;
      const problem = rejectNewlines(ambient) ?? formatError(v, ambient);
      if (problem) {
        say(`  ${v.key}: ignoring the environment value (${problem}) — asking instead.`);
      } else {
        values.set(v.key, ambient);
        continue;
      }
    }

    if (v.source === "generate") {
      values.set(v.key, generate(v));
      say(`  ${v.key}: generated`);
      continue;
    }

    if (v.source === "enable") {
      // A feature flag that must flip on with its group.
      values.set(v.key, "true");
      say(`  ${v.key}: true`);
      continue;
    }

    if (v.source === "confirm") {
      const yes = await askConfirm(`  ${v.prompt ?? v.key}`, v.confirmDefault ?? false);
      if (yes) values.set(v.key, "true");
      say(`  ${v.key}: ${yes}`);
      continue;
    }

    if (v.source === "prompt") {
      const answer = v.choices
        ? await askSelect({
            message: v.prompt ?? v.key,
            choices: v.choices,
            default: v.default,
          })
        : await askText({
            message: v.prompt ?? v.key,
            hint: v.hint,
            default: v.default,
            secret: v.secret,
            validate: (value) => {
              const newline = rejectNewlines(value);
              if (newline) return newline;
              if (value === "" && v.required && !v.omittable) return "required";
              return formatError(v, value);
            },
          });

      if (answer) values.set(v.key, answer);
      else if (v.required && v.omittable) omitted.push(v.key);
    }

    // `default` / `manual` — the documented default stands. Emitted commented
    // out under --all; otherwise left out entirely.
  }
}

// NODE_ENV is the one default we always override: this block is for a deployed
// environment, and several env guards only harden when it is "production".
values.set("NODE_ENV", "production");

// ---------------------------------------------------------------------------
// Validate against the real Zod schemas before we hand anything over
// ---------------------------------------------------------------------------

say("");
say("  Validating against packages/env schemas…");

/**
 * Runs the server env module in a child process with exactly the values we
 * collected. Every other key is forced to the empty string:
 * `emptyStringAsUndefined` turns that back into "unset", and dotenv won't
 * overwrite an already-present key — so the repo's own `.env` can't leak in and
 * make a missing variable look present.
 *
 * The zeroing list is the union of the manifest AND a fresh scan of the
 * schemas: zeroing only manifest keys would let a schema key that nobody added
 * to the manifest be satisfied by the repo's `.env`, producing a green run for
 * an env block that crashes on the platform.
 */
async function validate(): Promise<{ ok: boolean; output: string }> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };

  const scan = await scanSchemaKeys(ROOT);
  if (scan.errors.length > 0) {
    // A degraded scan under-reports keys, and every key it misses is one this
    // function fails to zero — which lets the repo's own .env satisfy it in the
    // child and turns a broken block green. Refuse rather than half-check.
    fail(
      "cannot validate: the env schemas could not be read completely.\n  " +
        scan.errors.join("\n  ") +
        "\n  Fix the schema so `pnpm env:check` can parse it, then re-run.",
    );
  }
  const zeroKeys = new Set<string>(scan.keys.keys());
  for (const v of ENV_VARS) {
    if ((v.file ?? "root") === "root") zeroKeys.add(v.key);
  }

  for (const key of zeroKeys) {
    // Platform-injected and deliberately-omitted vars are absent from the block
    // on purpose, but the schema still requires them — stand in the example
    // value so validation exercises everything else rather than stopping at a
    // variable that arrives at runtime.
    const manifestVar = ENV_VARS.find((v) => v.key === key);
    const stub =
      platformInjects.has(key) || omitted.includes(key) ? (manifestVar?.example ?? "") : "";
    childEnv[key] = values.get(key) ?? stub;
  }

  // Read the package name rather than hardcoding `@knowledge-base/env`: the rebrand
  // renames every `@knowledge-base/*` workspace package, and a literal here would
  // survive as a broken import that only shows up when someone runs this
  // script against a renamed repo. Same reasoning as the VAPID subprocess
  // removal documented above.
  const envPkgName = (
    JSON.parse(readFileSync(resolve(ROOT, "packages/env/package.json"), "utf-8")) as {
      name: string;
    }
  ).name;

  const result = spawnSync(
    "pnpm",
    ["exec", "tsx", "-e", `import('${envPkgName}/server').then(() => {})`],
    { cwd: ROOT, env: childEnv, encoding: "utf-8" },
  );

  // Drop stack frames and the code-frame gutter — t3-env's own message names
  // the offending variables, and that is the only part worth showing.
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`
    .split("\n")
    .filter((l) => !/^\s*(at\s|\^|\||Node\.js v)/.test(l))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { ok: result.status === 0, output };
}

const validation = await validate();
if (!validation.ok) {
  say("");
  say("  ✗ The generated environment does not pass validation:");
  say("");
  say(
    validation.output
      .split("\n")
      .map((l) => `    ${l}`)
      .join("\n"),
  );
  say("");
  say("  Nothing was written. Re-run and correct the values above.");
  process.exit(1);
}
say("  ✓ valid");

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

const lines: string[] = [
  "# Generated by `pnpm generate:secrets`.",
  `# Deploy target: ${target.label} (${target.doc})`,
  "#",
  "# This file contains live credentials. Do not commit it. Paste these into",
  "# your platform's environment/secrets UI, then delete the local copy.",
];

if (injected.length > 0) {
  lines.push("#", `# Omitted because ${target.label} injects them: ${injected.join(", ")}`);
}
if (omitted.length > 0) {
  lines.push("#", `# Omitted at your request — set these on the platform: ${omitted.join(", ")}`);
}
lines.push(
  "#",
  "# Variables with a documented default are omitted entirely — the defaults are",
  "# the recommended production values.",
);
if (INCLUDE_TUNING) {
  lines.push(
    "#",
    "# --all: the commented lines below show each remaining variable with its",
    "# DEFAULT value. A blank one has no default — it is off unless you set it.",
  );
}

for (const group of groupsForFile("root")) {
  const vars = varsInGroup(group.id);
  const set = vars.filter((v) => values.has(v.key));
  const commented = INCLUDE_TUNING
    ? vars.filter((v) => !values.has(v.key) && !platformInjects.has(v.key))
    : [];

  if (set.length === 0 && commented.length === 0) continue;

  lines.push("", `# --- ${group.title}`);
  for (const v of set) lines.push(envAssignment(v.key, values.get(v.key)!));
  // Only the documented default goes here — never `example`, which holds
  // local-dev placeholders like SMTP_HOST=localhost that would silently
  // black-hole mail if uncommented in production.
  for (const v of commented) lines.push(`# ${v.key}=${v.default ?? ""}`);
}

const output = `${lines.join("\n")}\n`;

// ---------------------------------------------------------------------------
// Round-trip the rendered block through dotenv
//
// The Zod validation above sees the values as we collected them, NOT as they
// are written — so a quoting bug would sail straight past it and only surface
// as a mystery auth failure in production. Parse what we are about to hand over
// and prove it decodes back to exactly what we collected.
// ---------------------------------------------------------------------------

const roundTripped = parseDotenv(output);
for (const [key, value] of values) {
  if (roundTripped[key] !== value) {
    // Deliberately does NOT print the value or its encoding: this message is
    // an invitation to file a bug report, and the old wording pasted the secret
    // into terminal scrollback and CI logs while asking the reader not to share
    // it. Describe the shape instead.
    fail(
      `internal encoding error: ${key} does not survive a dotenv round trip.\n` +
        `  value shape: ${describeShape(value)}\n` +
        `  Please report the shape line above — not the value itself.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

function postamble() {
  say("");
  say("  Next:");
  say("    1. Add these to your platform's environment/secrets store.");
  say(
    "    2. The server applies migrations at startup; workers wait. Configure full-bundle backups.",
  );
  say("       (docs/schema-migrations.md; pnpm dokploy:config emits the deploy checklist)");
  say("    3. Review AGENTS.md § Agent Safety Rules before taking real traffic.");
  say("");
}

if (!outPath) {
  say("");
  say("  ────────────────────────────────────────────────────────────────");
  say("");
  process.stdout.write(output);
  say("");
  say("  ↑ Live credentials. Paste into your platform's secrets UI.");
  postamble();
  process.exit(0);
}

if (!finalPath) fail("internal: --out was given but no path was resolved.");

try {
  // The path was validated before prompting; `wx` closes the gap between then
  // and now (including a dangling symlink appearing in the meantime).
  writeFileSync(finalPath, output, { mode: 0o600, flag: "wx" });
} catch (error) {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EEXIST") {
    fail(`${outPath} appeared while you were answering. Refusing to overwrite it.`);
  }
  throw error;
}

say("");
say(`  ✓ wrote ${outPath} (mode 0600)`);
postamble();
