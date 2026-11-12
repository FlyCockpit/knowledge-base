/**
 * Assert that every `minimumReleaseAgeExclude` carve-out is still justified.
 *
 * `minimumReleaseAge` (pnpm-workspace.yaml) is a supply-chain gate: a freshly
 * published version cannot enter the lockfile until it has survived in the wild
 * for the configured window, which is the cheapest defence there is against a
 * compromised release. `minimumReleaseAgeExclude` punches a hole in that gate
 * for one package.
 *
 * Those holes are meant to be temporary — you take one when a security fix
 * lands and the only patched version is younger than the window, i.e. exactly
 * when you are *most* exposed to a malicious publish. Once the version ages
 * past the window the exclusion is pure downside: it silently keeps that one
 * package exempt forever, and nothing in the toolchain complains. A comment
 * saying "drop this after the 26th" is not a control; nobody re-reads
 * pnpm-workspace.yaml on the 26th.
 *
 * So each entry must carry a machine-readable expiry:
 *
 *     minimumReleaseAgeExclude:
 *       # GHSA-xxxx-yyyy-zzzz: fast-uri 3.1.4 (released 2026-07-19) is the only
 *       # version that clears the advisory and is <7 days old.
 *       # drop-after: 2026-07-26
 *       - fast-uri
 *
 * The marker may also trail the entry itself (`- fast-uri # drop-after: ...`).
 *
 * This check fails when an entry has no `drop-after:` marker, when the date is
 * unparseable, when that date has passed, or when the list is written in flow
 * style (`[fast-uri]`) where this parser could not see it — turning a stale or
 * invisible carve-out into a red build instead of a permanent silent exemption.
 *
 * Removing an expired entry is normally all that is required: by definition the
 * fixed version is now older than the window, so it no longer needs the hole.
 * Re-run `pnpm install` after deleting it to confirm.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const WORKSPACE_FILE = "pnpm-workspace.yaml";
const ROOT = resolve(import.meta.dirname!, "..");
const MARKER = /drop-after:\s*(\d{4}-\d{2}-\d{2})/i;

type Entry = { name: string; dropAfter: string | null; line: number };
type ParseResult = { entries: Entry[]; fatal: string | null };

/**
 * Pull the `minimumReleaseAgeExclude` list with each item's comment. Hand-parsed
 * rather than via a YAML library because comments are the payload here, and
 * every YAML parser discards them.
 *
 * Hand-parsing means the parser must fail loudly on anything it does not
 * understand, because the failure mode is silent: a shape this function does not
 * recognize yields zero entries, and zero entries is indistinguishable from
 * "no carve-outs" — a green build over an unchecked hole in the supply-chain
 * gate. That is not hypothetical. Only block sequences are recognized:
 *
 *     minimumReleaseAgeExclude:
 *       - fast-uri
 *
 * YAML equally allows flow style, `minimumReleaseAgeExclude: [fast-uri]`, which
 * carries no place to hang a per-entry comment. This file used exactly that
 * spelling (`[]`) before the first carve-out was added, so it is the idiom a
 * maintainer is most likely to reach for. Rather than parse it, reject it.
 */
function parseExcludes(text: string): ParseResult {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^minimumReleaseAgeExclude:/.test(l));
  if (start === -1) {
    // The key is anchored at column 0 because that is where a top-level pnpm
    // setting belongs. But "I did not find the key" and "there is no key" have
    // to be told apart, or an indented (or otherwise reshaped) key produces zero
    // entries and a green build over an unchecked carve-out — the same silent
    // failure the flow-style branch below refuses to allow.
    // Strip comments from anywhere on a line, not just whole-line comments:
    // this file already uses trailing `# CVE-…` notes on `overrides:` entries,
    // so a trailing mention of the key in prose would otherwise trip the fatal
    // below with a message that does not describe what is actually wrong.
    if (/minimumReleaseAgeExclude/.test(text.replace(/#.*$/gm, ""))) {
      return {
        entries: [],
        fatal:
          `${WORKSPACE_FILE} — \`minimumReleaseAgeExclude\` appears in the file but not as a\n` +
          `    top-level key at column 0, which is the only shape this check parses. It cannot\n` +
          `    verify a carve-out it cannot see, so it fails rather than reporting "no carve-outs".\n` +
          `    Move it back to the top level:\n` +
          `        minimumReleaseAgeExclude:\n` +
          `          # drop-after: YYYY-MM-DD\n` +
          `          - package-name`,
      };
    }
    return { entries: [], fatal: null };
  }

  // Anything after the colon on the key line is an inline value: flow style, or
  // a spelling this parser does not model. `[]` is the one benign case.
  const inline = (lines[start] ?? "").replace(/^minimumReleaseAgeExclude:/, "").replace(/#.*$/, "");
  if (inline.trim() !== "" && inline.trim() !== "[]") {
    return {
      entries: [],
      fatal:
        `${WORKSPACE_FILE}:${start + 1} — \`minimumReleaseAgeExclude\` is written inline as \`${inline.trim()}\`.\n` +
        `    This check only understands block style, and it cannot verify a carve-out it cannot see —\n` +
        `    an unreadable list would otherwise pass as "no carve-outs". Rewrite it as:\n` +
        `        minimumReleaseAgeExclude:\n` +
        `          # drop-after: YYYY-MM-DD\n` +
        `          - package-name`,
    };
  }

  const entries: Entry[] = [];
  let comments: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    // A non-indented, non-comment line ends the block.
    if (/^[^\s#]/.test(line)) break;
    const comment = line.match(/^\s*#\s?(.*)$/);
    if (comment) {
      comments.push(comment[1] ?? "");
      continue;
    }
    const item = line.match(/^\s*-\s*(?:"([^"]+)"|'([^']+)'|(\S+))/);
    if (item) {
      const name = item[1] ?? item[2] ?? item[3] ?? "";
      // The marker may sit in the preceding comment block or trail the item on
      // its own line — both read naturally, so accept both rather than failing a
      // author whose marker is plainly visible right there.
      const dropAfter = (comments.join("\n").match(MARKER) ?? line.match(MARKER))?.[1] ?? null;
      entries.push({ name, dropAfter, line: i + 1 });
      comments = [];
      continue;
    }
    if (line.trim() === "") comments = [];
  }
  return { entries, fatal: null };
}

/** Today at UTC midnight, so the check is timezone-stable across CI runners. */
function todayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

const text = readFileSync(resolve(ROOT, WORKSPACE_FILE), "utf8");
const { entries, fatal } = parseExcludes(text);
if (fatal) {
  console.error(`minimumReleaseAgeExclude check FAILED:\n\n  ${fatal}\n`);
  process.exit(1);
}
const problems: string[] = [];
const today = todayUtc();

for (const entry of entries) {
  if (!entry.dropAfter) {
    problems.push(
      `${WORKSPACE_FILE}:${entry.line} — "${entry.name}" has no \`drop-after: YYYY-MM-DD\` marker in its comment.\n` +
        `    Every minimumReleaseAge carve-out needs an expiry, or it becomes a permanent hole in the gate.`,
    );
    continue;
  }
  const deadline = new Date(`${entry.dropAfter}T00:00:00Z`);
  if (Number.isNaN(deadline.getTime())) {
    problems.push(
      `${WORKSPACE_FILE}:${entry.line} — "${entry.name}" has an unparseable drop-after date "${entry.dropAfter}" (expected YYYY-MM-DD).`,
    );
    continue;
  }
  if (today > deadline) {
    const daysOver = Math.round((today.getTime() - deadline.getTime()) / 86_400_000);
    problems.push(
      `${WORKSPACE_FILE}:${entry.line} — "${entry.name}" expired ${daysOver} day(s) ago (drop-after: ${entry.dropAfter}).\n` +
        `    The version it covered is now older than minimumReleaseAge, so the exclusion is no longer buying anything.\n` +
        `    Delete the entry and its comment, then run \`pnpm install\` to confirm resolution still succeeds.`,
    );
  }
}

if (problems.length > 0) {
  console.error("minimumReleaseAgeExclude check FAILED:\n");
  for (const p of problems) console.error(`  ${p}\n`);
  process.exit(1);
}

const detail = entries.map((e) => `${e.name} (drop-after ${e.dropAfter})`).join(", ");
console.log(
  entries.length === 0
    ? "minimumReleaseAge excludes OK — no carve-outs, the supply-chain gate applies to every package."
    : `minimumReleaseAge excludes OK — ${entries.length} carve-out(s) still within their window: ${detail}.`,
);
