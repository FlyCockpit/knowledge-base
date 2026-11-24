/**
 * Keeps package.json script names, and the docs that name them, clear of pnpm
 * built-in commands.
 *
 *   pnpm policy:script-names               (runs --self-test first)
 *
 * `pnpm <name>` runs a pnpm built-in when one has that name, even if a
 * package.json script does too: `pnpm doctor` ran pnpm's install diagnostics
 * and never the repo's doctor, silently. So this fails when:
 *
 * 1. a workspace package.json (any tracked one) defines a script whose name is
 *    a built-in or a built-in alias, unless that built-in runs the same-named
 *    script itself (DEFERS_TO_SCRIPT);
 * 2. a tracked text file tells people to run `pnpm <name>` or
 *    `pnpm run <name>` where <name> is such a built-in and the workspace has a
 *    script family `<name>:*` (e.g. `doctor:app`), the classic truncated or
 *    stale reference. A line that means the built-in itself carries
 *    `pnpm-builtin:audited`.
 *
 * The built-in list, and which options take a value, are read from the pinned
 * pnpm's own `--help`, so an upgrade that adds a command is caught the next
 * time this runs.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

const ROOT = resolve(import.meta.dirname!, "..");
const SELF = "scripts/check-pnpm-script-names.ts";
const MARKER = "pnpm-builtin:audited";
/**
 * A line that is only a comment: `#` or `//` to the end of the line, or a
 * block/HTML comment line with no code after its close.
 */
const COMMENT_LINE = /^\s*(#|\/\/)|^\s*(\/\*|\*)(?!.*\*\/\s*\S)|^\s*<!--(?!.*-->\s*\S)/;

/**
 * Built-ins that run the package's same-named script (or yield to it), per
 * `pnpm --help`: a script with one of these names is the intended use.
 */
const DEFERS_TO_SCRIPT = new Set(["test", "start", "stop", "restart", "tasks", "clean", "purge"]);

/** Always treated as built-ins, even if `--help` stops listing them. */
const KNOWN_BUILTINS = ["doctor", "setup", "pm", "run", "exec", "dlx", "install", "add"];

/** Parses the `Commands:` block of `pnpm --help`: names plus their aliases. */
export function parseBuiltins(help: string): Set<string> {
  const names = new Set<string>();
  const block = help.split(/^Commands:\s*$/m)[1]?.split(/^\S.*:\s*$/m)[0] ?? "";
  for (const line of block.split("\n")) {
    const match = /^ {2}([a-z][\w-]*)\s{2,}(.*)$/.exec(line);
    if (!match) continue;
    names.add(match[1]!);
    const aliases = /\[alias(?:es)?: ([^\]]+)\]/.exec(match[2]!);
    for (const alias of aliases?.[1]?.split(",") ?? []) names.add(alias.trim());
  }
  return names;
}

/** Built-ins that win over a same-named script. */
export function shadowingBuiltins(builtins: Iterable<string>): Set<string> {
  const out = new Set<string>([...builtins, ...KNOWN_BUILTINS]);
  for (const name of DEFERS_TO_SCRIPT) out.delete(name);
  return out;
}

export interface Violation {
  file: string;
  line?: number;
  message: string;
}

export function checkScripts(
  manifests: ReadonlyArray<{ file: string; scripts: Record<string, string> }>,
  shadowing: ReadonlySet<string>,
): Violation[] {
  const out: Violation[] = [];
  for (const { file, scripts } of manifests) {
    for (const name of Object.keys(scripts)) {
      if (shadowing.has(name)) {
        out.push({
          file,
          message: `script "${name}" is a pnpm built-in: \`pnpm ${name}\` never runs it. Rename it (e.g. "${name}:app").`,
        });
      }
    }
  }
  return out;
}

/** Built-ins that are also the family prefix of a workspace script (`doctor` for `doctor:app`). */
export function familyNames(scriptNames: Iterable<string>, shadowing: ReadonlySet<string>) {
  const out = new Set<string>();
  for (const name of scriptNames) {
    const prefix = name.split(":")[0]!;
    if (prefix !== name && shadowing.has(prefix)) out.add(prefix);
  }
  return out;
}

/** Value-taking options assumed even if `--help` stops listing them. */
const KNOWN_VALUE_OPTIONS = ["-F", "--filter", "-C", "--dir"];

/**
 * Options that take a separate value, from the `Options:` blocks of
 * `pnpm --help` / `pnpm run --help` (`-F, --filter <FILTER>`, plus any
 * `[alias: --x]` of one). `--color[=<COLOR>]` takes a value only inline. Every
 * other option is a bare flag; pnpm rejects options it does not know.
 */
export function parseValueOptions(help: string): Set<string> {
  const out = new Set(KNOWN_VALUE_OPTIONS);
  let takesValue = false;
  for (const line of help.split("\n")) {
    const option = /^ {2,}(?:(-\w), )?(--[\w-]+)( <[^>]+>)?/.exec(line);
    if (option) {
      takesValue = Boolean(option[3]);
      if (takesValue) for (const name of [option[1], option[2]]) if (name) out.add(name);
      continue;
    }
    const alias = /\[alias(?:es)?: ([^\]]+)\]/.exec(line);
    if (alias && takesValue) for (const name of alias[1]!.split(",")) out.add(name.trim());
  }
  return out;
}

interface Token {
  text: string;
  line: number;
  /** Offset of the word's first character in the text. */
  at: number;
}

/**
 * Splits text into shell-ish words across lines. Brackets, braces, parens,
 * commas, backticks, `*`, `<`, `>` and `;|&` delimit words (the last three
 * also stand as words, so they end a command), and a lone `\` (a line
 * continuation) is dropped, while `\ ` (an escaped space) stays inside its word
 * (`-C /tmp/my\ app`). With `quotes`, a word that opens with `"` or `'`
 * runs to the closing quote on that line (`-C "/tmp/my app"`, argv elements),
 * and a quote mark that does not close on its line (one end of a multi-line
 * string) is skipped, so no word ever holds a quote mark; without, quote marks
 * are delimiters too, which reads a command inside a quoted string
 * (`echo "run pnpm setup:app"`).
 */
export function tokenize(text: string, quotes: boolean): Token[] {
  const tokens: Token[] = [];
  const delimiter = quotes ? /[\s[\](){},`*<>;|&]/ : /[\s[\](){},`*<>;|&"']/;
  let line = 1;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "\n") line++;
    if (/[;|&]/.test(ch)) tokens.push({ text: ch, line, at: i });
    if (delimiter.test(ch)) {
      i++;
      continue;
    }
    if (quotes && (ch === '"' || ch === "'")) {
      const close = text.indexOf(ch, i + 1);
      const eol = text.indexOf("\n", i + 1);
      if (close !== -1 && (eol === -1 || close < eol)) {
        tokens.push({ text: text.slice(i + 1, close), line, at: i + 1 });
        i = close + 1;
        continue;
      }
      i++;
      continue;
    }
    let j = i;
    while (j < text.length && !delimiter.test(text[j]!) && !(quotes && /["']/.test(text[j]!))) {
      j += text[j] === "\\" && /[ \t]/.test(text[j + 1] ?? "") ? 2 : 1;
    }
    const word = text.slice(i, j);
    if (word !== "\\") tokens.push({ text: word, line, at: i });
    i = j;
  }
  return tokens;
}

/** The command word of `pnpm [options] [run [options]] <command>` starting at tokens[at] (`pnpm`). */
function commandOf(tokens: Token[], at: number, valueOptions: ReadonlySet<string>) {
  let sawRun = false;
  let optionsDone = false;
  for (let j = at + 1; j < tokens.length; j++) {
    const word = tokens[j]!.text;
    if (!optionsDone && word === "--") {
      optionsDone = true;
    } else if (!optionsDone && word.startsWith("-") && word.length > 1) {
      if (!word.includes("=") && valueOptions.has(word)) j++;
    } else if (!sawRun && (word === "run" || word === "run-script")) {
      sawRun = true;
      optionsDone = false;
    } else {
      return tokens[j];
    }
  }
  return undefined;
}

/**
 * Finds `pnpm … <family>` invocations, including ones that span lines and
 * argv arrays (`spawn("pnpm", ["-C", dir, "run", "setup"])`). The violation's
 * line is the command word's; a marker on it, on the `pnpm` line, or on a
 * comment line just above the `pnpm` line (where a continued shell line cannot
 * carry a trailing comment, as in a Dockerfile RUN) exempts it. The quote-blind
 * pass only reads `pnpm` words the quote-aware pass did not already parse
 * (those inside a quoted word: `echo "run pnpm setup"`).
 */
export function checkText(
  file: string,
  text: string,
  families: ReadonlySet<string>,
  valueOptions: ReadonlySet<string>,
): Violation[] {
  if (families.size === 0 || !text.includes("pnpm")) return [];
  const out: Violation[] = [];
  const lines = text.split("\n");
  const seen = new Set<string>();
  const parsed = new Set<number>();
  for (const quotes of [true, false]) {
    const tokens = tokenize(text, quotes);
    tokens.forEach((token, at) => {
      if (token.text !== "pnpm" && !token.text.endsWith("/pnpm")) return;
      if (!quotes && parsed.has(token.at)) return;
      const command = commandOf(tokens, at, valueOptions);
      if (quotes) parsed.add(token.at);
      const name = command?.text.replace(/[.!?]+$/, "");
      if (!command || !name || !families.has(name)) return;
      const key = `${command.line}:${name}`;
      if (seen.has(key)) return;
      seen.add(key);
      if (
        lines[token.line - 1]!.includes(MARKER) ||
        lines[command.line - 1]!.includes(MARKER) ||
        (COMMENT_LINE.test(lines[token.line - 2] ?? "") && lines[token.line - 2]!.includes(MARKER))
      ) {
        return;
      }
      const shown = tokens
        .slice(at, tokens.indexOf(command) + 1)
        .map((t) => (/\s/.test(t.text) ? JSON.stringify(t.text) : t.text))
        .join(" ");
      out.push({
        file,
        line: command.line,
        message: `\`${shown}\` names no repo script ("${name}" is a pnpm built-in; the scripts are ${name}:*). Name the full script, or mark a deliberate built-in mention with ${MARKER}.`,
      });
    });
  }
  return out;
}

function trackedFiles(): string[] {
  const result = spawnSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ls-files failed: ${result.stderr}`);
  return result.stdout.split("\0").filter(Boolean);
}

function pnpmHelp(...command: string[]): string {
  const result = spawnSync("pnpm", [...command, "--help"], { cwd: ROOT, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `\`pnpm ${[...command, "--help"].join(" ")}\` failed (${result.status}): ${result.stderr || result.error}`,
    );
  }
  return result.stdout;
}

function selfTest() {
  const assert = (ok: unknown, what: string) => {
    if (!ok) throw new Error(`self-test: ${what}`);
  };
  const help = [
    "Usage: pnpm [OPTIONS] <COMMAND>",
    "",
    "Commands:",
    "  install         Install packages [alias: i]",
    "  doctor          Run diagnostics",
    "  test            Runs a package's test script [aliases: t, tst]",
    "  setup           Sets up pnpm",
    "",
    "Options:",
    "  -v, --version",
    "          Print the pnpm version",
    "      --env-file <PATH>",
    "  -C, --dir <DIR>",
    "      --npmrc-auth-file <NPMRC_AUTH_FILE>",
    "          [alias: --userconfig]",
    "      --ignore-workspace",
    "          Run standalone [alias: --standalone]",
    "      --color[=<COLOR>]",
    "  -F, --filter <FILTER>",
    "  -w, --workspace-root",
    "      --workspace-concurrency <workspace_concurrency>",
  ].join("\n");
  const builtins = parseBuiltins(help);
  assert(
    ["install", "i", "doctor", "test", "t", "tst", "setup"].every((n) => builtins.has(n)),
    "parses names and aliases",
  );
  assert(!builtins.has("-v,"), "stops at Options");
  const valueOptions = parseValueOptions(help);
  assert(
    ["--env-file", "-C", "--dir", "--userconfig", "-F", "--workspace-concurrency"].every((o) =>
      valueOptions.has(o),
    ),
    "parses value options and their aliases",
  );
  assert(
    !["-v", "--version", "--color", "--ignore-workspace", "--standalone", "-w"].some((o) =>
      valueOptions.has(o),
    ),
    "bare flags take no value",
  );
  const shadowing = shadowingBuiltins(builtins);
  assert(!shadowing.has("test") && shadowing.has("t"), "test defers; its alias t does not");
  const scripts = checkScripts(
    [{ file: "package.json", scripts: { doctor: "x", "doctor:app": "x", test: "x", dev: "x" } }],
    shadowing,
  );
  assert(scripts.length === 1 && scripts[0]!.message.includes('"doctor"'), "flags only doctor");
  const families = familyNames(["doctor:app", "setup:app", "test:setup", "dev"], shadowing);
  assert(
    families.has("doctor") && families.has("setup") && !families.has("test") && families.size === 2,
    "families",
  );
  const p = "pnpm";
  const flagged = [
    `run \`${p} doctor\`.`,
    `${p} run doctor`,
    `${p} doctor # hint`,
    `${p} -w run setup`,
    `${p} --filter web doctor`,
    `${p} -F=web --silent run --if-present setup`,
    `spawnSync("${p}", ["doctor"])`,
    `spawn('${p}', ['--filter', 'web', 'run', 'setup'], opts)`,
    `${p} doctor; ${p} run doctor`,
    `${p} --env-file .env doctor`,
    `${p} --workspace-concurrency 2 run setup`,
    `${p} --silent setup foo`,
    `spawnSync(\n  "${p}",\n  [\n    "--filter",\n    "web",\n    "doctor",\n  ],\n)`,
    `${p}\n  run setup`,
    `${p} -C "/tmp/my app" doctor`,
    `spawnSync("${p}", ["-C", "/tmp/my app", "run", "doctor"])`,
    `echo "then run ${p} setup."`,
    `${p} --userconfig ./npmrc -- setup`,
    `/usr/local/bin/${p} --color=always doctor`,
    `# ${MARKER}\n\nRUN ${p} --filter web \\\n  doctor --prod`,
    `${p} --filter web deploy /out # ${MARKER}\n${p} doctor`,
    `${p} -C /tmp/my\\ app doctor`,
    `run: "${p} install &&\n    ${p} doctor"`,
    `run: "${p} install &&\n    ${p} -C '/tmp/my app' doctor"`,
    `/* ${MARKER} */ spawnSync("${p}", ["deploy", "/out"]);\nspawnSync("${p}", ["doctor"]);`,
    `<!-- ${MARKER} --> x\n${p} doctor`,
  ];
  for (const line of flagged) {
    assert(checkText("f", line, families, valueOptions).length === 1, line);
  }
  const clean = [
    `${p} doctor:app`,
    `${p} doctor-x`,
    `${p} install`,
    `${p} doctor ${MARKER}`,
    `${p} -w run doctor:app`,
    `spawnSync("${p}", ["run", "setup:app"])`,
    `${p}'s doctor`,
    "doctor",
    `${p} --filter web build\nsetup`,
    `spawnSync("${p}", [\n  "run",\n  "setup:app",\n])`,
    `${p} run\n  doctor # ${MARKER}`,
    `# ${MARKER}: ${p}\n  setup`,
    `# ${MARKER}\nRUN ${p} --filter web \\\n  doctor --prod`,
    `${p} --silent exec env --version`,
    `${p} --filter web exec doctor`,
    `${p} --filter setup build`,
    `${p} -C "/tmp/doctor" build`,
    `${p} -C "/tmp/my doctor" build`,
    `${p} -C /tmp/my\\ doctor build`,
    `/* ${MARKER} */\n${p} doctor`,
    `run: "${p} install &&\n    ${p} -C '/tmp/my doctor' build"`,
    `// ${MARKER}\nspawnSync("${p}", ["doctor"]);`,
    `<!-- ${MARKER} -->\n${p} doctor`,
    `${p} --color always`,
    `"${p} is fast", 'setup'`,
  ];
  for (const line of clean) {
    assert(checkText("f", line, families, valueOptions).length === 0, line);
  }
  console.log("check-pnpm-script-names self-test: ok");
}

function main() {
  if (process.argv.includes("--self-test")) selfTest();
  const builtins = parseBuiltins(pnpmHelp());
  if (builtins.size < 40) {
    throw new Error(
      `parsed only ${builtins.size} commands from \`pnpm --help\`; the format changed`,
    );
  }
  const shadowing = shadowingBuiltins(builtins);
  const valueOptions = parseValueOptions(`${pnpmHelp()}\n${pnpmHelp("run")}`);
  if (valueOptions.size <= KNOWN_VALUE_OPTIONS.length) {
    throw new Error("parsed no value-taking options from `pnpm --help`; the format changed");
  }
  const files = trackedFiles();
  const manifests = files
    .filter((f) => f === "package.json" || f.endsWith("/package.json"))
    .map((file) => ({
      file,
      scripts: (JSON.parse(readFileSync(resolve(ROOT, file), "utf8")).scripts ?? {}) as Record<
        string,
        string
      >,
    }));
  const violations = checkScripts(manifests, shadowing);
  const families = familyNames(
    manifests.flatMap((m) => Object.keys(m.scripts)),
    shadowing,
  );
  for (const file of files) {
    if (file === SELF || file === "pnpm-lock.yaml") continue;
    let text: string;
    try {
      text = readFileSync(resolve(ROOT, file), "utf8");
    } catch {
      continue; // deleted in the work tree
    }
    if (text.includes("\0")) continue; // binary
    violations.push(...checkText(file, text, families, valueOptions));
  }
  for (const v of violations) {
    console.error(`POLICY VIOLATION: ${v.file}${v.line ? `:${v.line}` : ""}: ${v.message}`);
  }
  if (violations.length > 0) process.exit(1);
  console.log(
    `pnpm script names: ${manifests.length} manifests clear of ${shadowing.size} pnpm built-ins`,
  );
}

main();
