/**
 * Reads the env keys declared under `packages/env/src/vars/**.ts`.
 *
 * Those modules exist to make this cheap and exact: they hold nothing but the
 * Zod declaration objects, with no import side effects, so this scan is a plain
 * `import` + `Object.keys()`. The modules that actually call `createEnv`
 * (`packages/env/src/{shared,server,web}.ts`) run validation that throws
 * when nothing is set — which is exactly the situation in CI, and the reason
 * this scan must not import them. Dotenv loading lives in entrypoints only
 * (`load-dotenv` / `root-env`).
 *
 * Every file in `vars/` is enumerated rather than named in a list here, so a new
 * declaration module is picked up the moment it is added. What that cannot see
 * is a variable declared INLINE in a `createEnv` call, bypassing `vars/`
 * entirely — `assertNoInlineDeclarations` below is the guard for that.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

interface SchemaScan {
  /** key → repo-relative file that declares it */
  keys: Map<string, string>;
  /**
   * Problems that make the scan UNTRUSTWORTHY rather than merely empty.
   * Callers must treat a non-empty list as fatal: a degraded scan silently
   * under-reports keys, which is exactly the failure the scan exists to catch.
   */
  errors: string[];
}

/** Env keys are SCREAMING_SNAKE by convention. */
const KEY_RE = /^[A-Z][A-Z0-9_]*$/;

/** Modules that call `createEnv`. Their declarations must live in `vars/`. */
const CREATE_ENV_MODULES = ["shared.ts", "server.ts", "web.ts"];

/** Looks like a Zod schema? Enough to tell a declaration object from a helper. */
function isZodSchema(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { parse?: unknown }).parse === "function" &&
    typeof (value as { safeParse?: unknown }).safeParse === "function"
  );
}

/**
 * A declaration object: a non-empty plain object whose values are all Zod
 * schemas. Anything else a `vars/` module exports (the `strictBooleanFlag`
 * helper, a type) is ignored.
 */
function isVarRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length > 0 && entries.every(([, v]) => isZodSchema(v));
}

/**
 * Fails when a `createEnv` module declares a variable inline instead of in
 * `vars/`. Such a key is invisible to the import-based scan above, so it would
 * need no manifest entry, never reach `.env.example`, never be prompted by
 * `generate:secrets`, and never be zeroed before validation — the exact silent
 * hole this whole check exists to close.
 *
 * Comments and string literals are stripped first, so prose or an error message
 * mentioning a key can't trip it. An explicit `runtimeEnv: { … }` map is
 * stripped too: an explicit `runtimeEnv` map *references* a variable rather
 * than declaring one.
 *
 * The remaining match is deliberately loose — an object key in ANY position,
 * not just at the start of a line, because
 * `server: { ...sharedVars, SNEAKY: z.string() }` is a one-line hole. The cost
 * of a false positive is a clear message telling you to move the declaration
 * into `vars/`, which is where it belongs anyway.
 */
function assertNoInlineDeclarations(srcDir: string, errors: string[]): void {
  for (const name of CREATE_ENV_MODULES) {
    const path = join(srcDir, name);
    let source: string;
    try {
      source = readFileSync(path, "utf-8");
    } catch {
      continue; // a removed feature module may have deleted it
    }
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/(["'`])(?:\\.|(?!\1)[\s\S])*\1/g, '""')
      // `runtimeEnv: { … }` — a flat map of names to values, not declarations.
      // Non-nested on purpose: a `{` inside would mean it is no longer the
      // simple key → `process.env.KEY` shape this exemption is for.
      .replace(/runtimeEnv\s*:\s*\{[^{}]*\}/g, "runtimeEnv: {}");
    // A key in object-literal position: at a line start, or straight after the
    // `{` / `,` that separates object properties.
    const match = /(?:^|[{,])\s*([A-Z][A-Z0-9_]{2,})\s*:\s*[a-zA-Z_$]/m.exec(stripped);
    if (match) {
      errors.push(
        `packages/env/src/${name}: \`${match[1]}\` looks like an env variable declared inline in ` +
          `the createEnv({…}) call.\n    Move it into packages/env/src/vars/ — a key declared here ` +
          `is invisible to \`pnpm env:check\`, \`pnpm env:sync\`, and \`pnpm generate:secrets\`.`,
      );
    }
  }
}

/** Every `.ts` under `dir`, excluding declaration and test files. */
function varModules(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .filter((e) => !e.name.endsWith(".d.ts") && !e.name.endsWith(".test.ts"))
    .map((e) => e.name)
    .sort();
}

/**
 * Imports every module under `packages/env/src/vars/` and collects the keys of
 * each exported declaration object.
 */
export async function scanSchemaKeys(root: string): Promise<SchemaScan> {
  const srcDir = resolve(root, "packages/env/src");
  const varsDir = join(srcDir, "vars");
  const keys = new Map<string, string>();
  const errors: string[] = [];

  let modules: string[];
  try {
    modules = varModules(varsDir);
  } catch {
    return {
      keys,
      errors: [
        "packages/env/src/vars/ could not be read. Every env variable is declared there; " +
          "without it this check would pass vacuously.",
      ],
    };
  }

  for (const name of modules) {
    const rel = `packages/env/src/vars/${name}`;
    let module: Record<string, unknown>;
    try {
      module = (await import(pathToFileURL(join(varsDir, name)).href)) as Record<string, unknown>;
    } catch (error) {
      errors.push(
        `${rel}: could not be imported — ${error instanceof Error ? error.message : String(error)}.\n` +
          `    Modules in vars/ must be side-effect free (declarations only).`,
      );
      continue;
    }

    let found = 0;
    for (const value of Object.values(module)) {
      if (!isVarRecord(value)) continue;
      for (const key of Object.keys(value)) {
        if (!KEY_RE.test(key)) {
          errors.push(
            `${rel}: \`${key}\` is not a valid environment variable name (SCREAMING_SNAKE_CASE).`,
          );
          continue;
        }
        found++;
        const previous = keys.get(key);
        if (previous) {
          errors.push(
            `${rel}: \`${key}\` is also declared in ${previous}.\n` +
              "    An environment variable may belong to exactly one declaration surface; " +
              "move it to exactly one of shared, server, or web (never more than one).",
          );
          continue;
        }
        keys.set(key, rel);
      }
    }

    // A declaration module that exports no declarations is either a mistake or
    // a file that does not belong here; either way, staying quiet about it lets
    // its keys go unchecked.
    if (found === 0) {
      errors.push(
        `${rel}: exports no environment-variable declarations (an object of Zod schemas).\n` +
          `    Every module in vars/ must export one, or it does not belong in that directory.`,
      );
    }
  }

  assertNoInlineDeclarations(srcDir, errors);

  if (keys.size === 0 && errors.length === 0) {
    errors.push(
      "packages/env/src/vars/ declared zero environment variables, so every check downstream " +
        "would pass vacuously.",
    );
  }

  return { keys, errors };
}
