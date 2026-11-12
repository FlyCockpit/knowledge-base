/**
 * Guards the "validation vs loading" split in `packages/env`.
 *
 *   pnpm env:check-entrypoints   — verify (CI gate; non-zero exit on drift)
 *
 * Why this exists: `@knowledge-base/env/{shared,server,web}` validate
 * `process.env` and nothing else. They are imported by `@knowledge-base/auth` and
 * `@knowledge-base/db`, which the web SSR graph pulls in, so a single `import "dotenv"`
 * in one of them leaves `dotenv` as a Vite SSR runtime external — which is not
 * resolvable from `apps/web/dist/server/assets/` and takes production down. The
 * fix was to move all loading into `@knowledge-base/env/load-dotenv` (side effect) and
 * `@knowledge-base/env/root-env` (`loadRootDotenv()`), imported only from process
 * entrypoints.
 *
 * That arrangement is invisible to typecheck, lint, and tests: every violation
 * of it still compiles and still passes locally, because locally a stray
 * `dotenv` always resolves. It only fails in a built container. So the rules are
 * asserted here instead.
 *
 * The invariants it enforces:
 *
 *   1. Every entrypoint in ENTRYPOINTS loads the root `.env`, in its declared
 *      mode. `sideEffect` entries must do it as their FIRST import — an import
 *      that drifts below `@knowledge-base/db` means validation runs before the file is
 *      read, which surfaces as a confusing "required env var" crash rather than
 *      as a missing import.
 *   2. No validation module imports `dotenv`, `./load-dotenv`, or `./root-env`.
 *      This is the rule whose violation broke production.
 *   3. Nothing outside DIRECT_DOTENV_ALLOWLIST imports `dotenv` directly. This
 *      is the straggler catcher: a new script that hand-rolls
 *      `dotenv.config({ path: "../../.env" })` gets its own root-resolution
 *      logic, which then rots independently of the shared one.
 *   4. ENTRYPOINTS in this file is the source of truth for first-party
 *      process entrypoints that must load the root `.env`.
 *
 * What it cannot tell you: whether a NEW process entrypoint was added and left
 * out of ENTRYPOINTS entirely. Nothing on disk distinguishes "a process
 * entrypoint" from "a module", so that judgment stays manual — but rule 3 means
 * the common way of getting it wrong (hand-rolling dotenv) is still caught.
 *
 * Dependency-free by design (node:fs only) — no new packages, safe to run in the
 * CI `lint` job alongside `pnpm env:check`.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname!, "..");

type Mode = "wrapper" | "sideEffect" | "call";

export interface Entrypoint {
  /** Repo-relative path. */
  file: string;
  mode: Mode;
}

/**
 * Process entrypoints that must load the repo-root `.env` before any
 * `packages/env` validation runs.
 *
 * `wrapper` — for BUNDLED entries. `import "<env>/load-dotenv";` and then a
 * dynamic `import()` of the real entry, with NO other static import. Required
 * because source order alone does not survive bundling: rolldown inlines the
 * tiny loader into the entry body while hoisting `@knowledge-base/env/shared` into a
 * statically imported chunk, and ESM evaluates static imports before the
 * importer's body — so validation ran first and the `.env` was ignored. The
 * "no other static import" rule is the whole guarantee; a single added static
 * import silently reintroduces the bug while still looking correct.
 * `sideEffect` — `import "<env>/load-dotenv";` as the first import. Correct for
 * anything run unbundled (`tsx`), which is why the bundled apps declare BOTH
 * their bootstrap and their index.
 * `call` — `loadRootDotenv()`. For files that need to know WHICH keys the root
 * `.env` supplied; `apps/web/vite.config.ts` is the only one today. Note this is
 * NOT the mode for `packages/db/prisma.config.ts` — that file imports `dotenv`
 * directly (see the allowlist below) because it is loaded during `pnpm install`,
 * before workspace source exists in the Docker context.
 *
 * Only the path and the mode live here.
 */
export const ENTRYPOINTS: Entrypoint[] = [
  // Output supervisors need .env topology before starting the native fence.
  // They import no application graph or validation modules.
  { file: "apps/server/src/output.ts", mode: "sideEffect" },
  { file: "apps/worker/src/output.ts", mode: "sideEffect" },
  { file: "apps/server/src/bootstrap.ts", mode: "wrapper" },
  { file: "apps/worker/src/bootstrap.ts", mode: "wrapper" },
  { file: "apps/server/src/index.ts", mode: "sideEffect" },
  { file: "apps/worker/src/index.ts", mode: "sideEffect" },
  { file: "scripts/doctor.ts", mode: "sideEffect" },
  { file: "scripts/translate-locale-bundles.ts", mode: "sideEffect" },
  { file: "packages/db/prisma/seed.cli.ts", mode: "sideEffect" },
  { file: "apps/web/vite.config.ts", mode: "call" },
  // packages/db/prisma.config.ts is NOT here on purpose — see the
  // DIRECT_DOTENV_ALLOWLIST entry below for why it must stay self-contained.
];

/** Validation modules: pure `process.env` readers, never loaders. */
export const VALIDATION_MODULES = [
  "packages/env/src/shared.ts",
  "packages/env/src/server.ts",
  "packages/env/src/web.ts",
];

/**
 * The only files allowed to import `dotenv` directly. Everything else goes
 * through `<env>/load-dotenv` or `<env>/root-env`.
 */
export const DIRECT_DOTENV_ALLOWLIST = new Map([
  ["packages/env/src/root-env.ts", "the single implementation of root-.env loading"],
  [
    "scripts/generate-secrets.ts",
    "`parse` only — round-trips the generated block, never loads a file",
  ],
  [
    "packages/db/prisma.config.ts",
    "loaded by `prisma generate` during `pnpm install --frozen-lockfile`, which both " +
      "Dockerfiles run BEFORE `COPY . .` — no workspace source exists yet, so importing " +
      "@knowledge-base/env/root-env there fails the image build. Must stay self-contained.",
  ],
]);

/** Where to look for stray `dotenv` imports. */
const SCAN_DIRS = ["apps", "packages", "scripts"];
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "dev-dist",
  "build",
  ".turbo",
  "generated",
  "target", // apps/cli — Rust, outside the pnpm graph
]);
const SCAN_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"];

function read(root: string, file: string): string {
  return readFileSync(resolve(root, file), "utf-8");
}

/**
 * Does `source` import `specifier`, in any of the spellings that actually reach
 * a module?
 *
 * Deliberately covers every form, because the ones a naive `from "dotenv"`
 * pattern misses are the *most idiomatic*: `import "dotenv/config"` is the
 * canonical way to load dotenv as a side effect, and it has no `from` clause
 * and a subpath. Matching only `from "dotenv"` would let the exact bug that
 * broke production back in, in its most common spelling, while printing OK.
 *
 * Subpaths count (`dotenv/config` is dotenv), so the specifier is matched with
 * an optional `/...` tail.
 */
function importsModule(source: string, specifier: string): boolean {
  const spec = specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const target = `["']${spec}(?:/[^"']*)?["']`;
  return [
    new RegExp(`\\bfrom\\s*${target}`), //            import x from "…" / export … from "…"
    new RegExp(`\\bimport\\s*${target}`), //          import "…"  (bare side effect)
    new RegExp(`\\bimport\\s*\\(\\s*${target}`), //   await import("…")
    new RegExp(`\\brequire\\s*\\(\\s*${target}`), //  require("…")
  ].some((re) => re.test(source));
}

/**
 * Blank out comments so the import matchers below see code only.
 *
 * Not cosmetic: without this, a comment that *names* the thing being banned
 * ("never write `import \"dotenv\"` here") reads as the violation it warns
 * about — which is the same "never match against raw text" hazard
 * scripts/lib/env-schema.ts documents, and it fired twice while this script was
 * being written. Comments are replaced with spaces rather than removed so any
 * future line/column reporting stays accurate.
 *
 * Character-level state machine over strings, template literals, and both
 * comment forms. It does not model regex literals: a `/` is only treated as a
 * comment opener when the next character is `/` or `*`, so a regex like
 * `/@knowledge-base\/.*​/` passes through untouched, but a regex whose body literally
 * contains `/*` would confuse it. No such regex exists here, and the failure
 * would be loud (a swallowed rest-of-file) rather than silent.
 */
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  const n = source.length;

  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === "/" && next === "/") {
      while (i < n && source[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }

    if (ch === "/" && next === "*") {
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        out += source[i] === "\n" ? "\n" : " ";
        i++;
      }
      out += i < n ? "  " : "";
      i += 2;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      out += ch;
      i++;
      while (i < n) {
        if (source[i] === "\\") {
          out += source[i] + (source[i + 1] ?? "");
          i += 2;
          continue;
        }
        out += source[i];
        if (source[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

/**
 * The first import statement in a file, with comments, the shebang, and string
 * directives ("use client") skipped.
 *
 * Line-based rather than a real parse: this only has to find the first import,
 * and the alternative — matching `import ...` anywhere with a regex — is the
 * failure class scripts/lib/env-schema.ts documents at length (a mention inside
 * a comment or a string reads as the real thing). Tracking block comments and
 * skipping directives covers every shape these entrypoints actually use.
 */
function firstImportLine(source: string): string | null {
  let inBlockComment = false;
  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (inBlockComment) {
      const end = line.indexOf("*/");
      if (end === -1) continue;
      inBlockComment = false;
      const rest = line.slice(end + 2).trim();
      if (rest === "") continue;
      if (rest.startsWith("import")) return rest;
      if (rest.startsWith("/*")) {
        inBlockComment = !rest.includes("*/");
        continue;
      }
      return rest;
    }
    if (line === "") continue;
    if (line.startsWith("#!")) continue;
    if (line.startsWith("//")) continue;
    if (/^["']use [a-z]+["'];?$/.test(line)) continue;
    if (line.startsWith("/*")) {
      inBlockComment = !line.includes("*/");
      continue;
    }
    return line;
  }
  return null;
}

export interface LoadDotenvCheckOptions {
  root: string;
  envPackageName?: string;
  entrypoints?: Entrypoint[];
  validationModules?: string[];
  allowlist?: Map<string, string>;
  scanDirs?: string[];
}

export interface LoadDotenvCheckResult {
  errors: string[];
  scanned: number;
  entrypointCount: number;
  validationCount: number;
  allowlistSize: number;
}

export function checkLoadDotenvContract(options: LoadDotenvCheckOptions): LoadDotenvCheckResult {
  const root = options.root;
  const entrypoints = options.entrypoints ?? ENTRYPOINTS;
  const validationModules = options.validationModules ?? VALIDATION_MODULES;
  const allowlist = options.allowlist ?? DIRECT_DOTENV_ALLOWLIST;
  const scanDirs = options.scanDirs ?? SCAN_DIRS;
  const envPkg =
    options.envPackageName ??
    (
      JSON.parse(readFileSync(resolve(root, "packages/env/package.json"), "utf-8")) as {
        name: string;
      }
    ).name;
  const errors: string[] = [];

  // ---------------------------------------------------------------------------
  // 1. Every declared entrypoint loads the root .env, in its declared mode.
  // ---------------------------------------------------------------------------

  for (const entry of entrypoints) {
    if (!existsSync(resolve(root, entry.file))) {
      errors.push(
        `${entry.file}: declared in ENTRYPOINTS but not on disk. ` +
          `Remove it from ENTRYPOINTS if the entrypoint is gone.`,
      );
      continue;
    }

    // Comments are blanked first so a file that merely *documents* the rule is not
    // read as breaking it.
    const source = stripComments(read(root, entry.file));

    if (entry.mode === "wrapper") {
      const expected = `import "${envPkg}/load-dotenv";`;
      const staticImports = [...source.matchAll(/^\s*import\s.*$/gm)].map((m) => m[0].trim());
      const extra = staticImports.filter((line) => line !== expected);

      if (!staticImports.includes(expected)) {
        errors.push(`${entry.file}: bundled entry must contain \`${expected}\`.`);
      }
      if (extra.length > 0) {
        errors.push(
          `${entry.file}: a bundled entry may have NO static import other than \`${expected}\`, ` +
            `but found ${extra.map((l) => `\`${l}\``).join(", ")}. Static imports are hoisted and ` +
            `evaluated before this module's body, so env validation would run before the .env is ` +
            `read — the exact bug this wrapper exists to prevent. Use a dynamic import() instead.`,
        );
      }
      if (!/\bimport\s*\(/.test(source)) {
        errors.push(
          `${entry.file}: bundled entry must hand off with a dynamic \`import()\` — ` +
            `that deferral is what keeps the rest of the graph from evaluating too early.`,
        );
      }

      // The wrapper only helps if the bundler actually points at it.
      const appDir = entry.file.replace(/\/src\/bootstrap\.ts$/, "");
      const tsdownConfig = `${appDir}/tsdown.config.ts`;
      if (existsSync(resolve(root, tsdownConfig))) {
        if (!read(root, tsdownConfig).includes("./src/bootstrap.ts")) {
          errors.push(
            `${tsdownConfig}: must build \`./src/bootstrap.ts\` as its entry, not src/index.ts — ` +
              `otherwise ${entry.file} is dead code and the built bundle validates before loading.`,
          );
        }
      } else {
        errors.push(`${tsdownConfig}: expected a tsdown config next to a wrapper entry.`);
      }
      continue;
    }

    if (entry.mode === "sideEffect") {
      const expected = `import "${envPkg}/load-dotenv";`;
      if (!source.includes(`"${envPkg}/load-dotenv"`)) {
        errors.push(`${entry.file}: must start with \`${expected}\` — no such import found.`);
        continue;
      }
      const first = firstImportLine(source);
      if (first !== expected) {
        errors.push(
          `${entry.file}: \`${expected}\` must be the FIRST import, but the first statement is ` +
            `\`${first ?? "(none)"}\`. Any import above it runs env validation before the .env file is read.`,
        );
      }
      continue;
    }

    // mode === "call"
    const importsHelper = new RegExp(
      `import\\s*\\{[^}]*\\bloadRootDotenv\\b[^}]*\\}\\s*from\\s*["']${envPkg}/root-env["']`,
    ).test(source);
    if (!importsHelper) {
      errors.push(
        `${entry.file}: must import { loadRootDotenv } from "${envPkg}/root-env" (mode: call).`,
      );
    }
    if (!/\bloadRootDotenv\s*\(/.test(source)) {
      errors.push(`${entry.file}: imports loadRootDotenv but never calls it.`);
    }
  }

  // ---------------------------------------------------------------------------
  // 2. Validation modules stay pure.
  // ---------------------------------------------------------------------------

  for (const file of validationModules) {
    if (!existsSync(resolve(root, file))) continue;
    const source = stripComments(read(root, file));
    for (const forbidden of ["dotenv", "./load-dotenv", "./root-env", `${envPkg}/root-env`]) {
      if (importsModule(source, forbidden)) {
        errors.push(
          `${file}: validation modules must not import "${forbidden}". ` +
            `They run inside the web SSR graph and the production server bundle; ` +
            `a dotenv import there breaks the container. Load from a process entrypoint instead.`,
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 3. No stray direct dotenv imports.
  // ---------------------------------------------------------------------------

  function* walk(dir: string): Generator<string> {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
      const full = join(dir, name);
      let isDir: boolean;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        yield* walk(full);
      } else if (SCAN_EXTS.some((ext) => name.endsWith(ext))) {
        yield full;
      }
    }
  }

  /**
   * This file states the pattern it searches for, so scanning it matches the
   * matcher rather than a real import. Skipping it is not an exemption — this
   * script has no imports to exempt; it is the same "never match against raw
   * text" hazard scripts/lib/env-schema.ts documents, in its smallest form.
   */
  const self = relative(root, import.meta.filename!)
    .split("\\")
    .join("/");

  let scanned = 0;
  for (const dir of scanDirs) {
    for (const full of walk(resolve(root, dir))) {
      scanned++;
      const rel = relative(root, full).split("\\").join("/");
      if (rel === self) continue;
      if (allowlist.has(rel)) continue;
      if (importsModule(stripComments(readFileSync(full, "utf-8")), "dotenv")) {
        errors.push(
          `${rel}: imports "dotenv" directly. Use \`import "${envPkg}/load-dotenv";\` ` +
            `(process entrypoints) or \`loadRootDotenv()\` from "${envPkg}/root-env". ` +
            `If this use is genuinely special, add it to DIRECT_DOTENV_ALLOWLIST with a reason.`,
        );
      }
    }
  }

  return {
    errors,
    scanned,
    entrypointCount: entrypoints.length,
    validationCount: validationModules.filter((f) => existsSync(resolve(root, f))).length,
    allowlistSize: allowlist.size,
  };
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(resolve(entry)).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const { errors, scanned, entrypointCount, validationCount, allowlistSize } =
    checkLoadDotenvContract({ root: ROOT });

  if (errors.length > 0) {
    console.error("Env load/validate contract violations:\n");
    for (const e of errors) console.error(`  • ${e}`);
    // Print the existing carve-outs alongside the failure: the most common reason
    // to be reading this output is "may my file import dotenv too?", and the
    // answer is only defensible next to the reasons the current three have.
    console.error("\nFiles allowed to import dotenv directly, and why:");
    for (const [file, reason] of DIRECT_DOTENV_ALLOWLIST) {
      console.error(`  • ${file} — ${reason}`);
    }
    process.exit(1);
  }

  console.log(
    `Env load/validate contract OK — ${entrypointCount} entrypoints load the root .env, ` +
      `${validationCount} validation modules are dotenv-free, ` +
      `and ${scanned} scanned files import dotenv only from ${allowlistSize} allowlisted places.`,
  );
}
