/**
 * Guards the hand-enumerated `COPY <app-or-package>/package.json` lists in the
 * two Dockerfiles against the actual set of workspace members on disk.
 *
 *   pnpm docker:check-copy   — verify without writing (CI gate; non-zero exit on drift)
 *
 * Why this exists: `Dockerfile` and `Dockerfile.worker` copy each workspace
 * member's `package.json` individually BEFORE `pnpm install --frozen-lockfile`
 * (so workspace symlinks + the lockfile's importers resolve) and BEFORE
 * `COPY . .`. Add a new `packages/*` or `apps/*` workspace member and forget to
 * add its COPY line and the install step fails inside `docker build` — a failure
 * that never shows up in `pnpm build`, tests, or typecheck. This script makes
 * that omission a fast, CI-visible error instead.
 *
 * The invariants it enforces (see AGENTS.md § Dockerfiles — keep server and
 * worker in sync):
 *
 *   1. Each `builder` stage installs the whole workspace (`pnpm install
 *      --frozen-lockfile`, no filter), so it MUST list every on-disk workspace
 *      member except the intentional exclusions below — and both Dockerfiles'
 *      builder lists must therefore be identical.
 *   2. Each `prod-deps` stage installs a filtered subset (`--filter=web...` /
 *      `--filter=worker...`), so its list must be a NON-EMPTY SUBSET of the same
 *      file's builder list — never referencing a member the builder omits or one
 *      that no longer exists on disk. Non-empty because a subset check alone is
 *      satisfied by the empty set: deleting every COPY line would otherwise read
 *      as "in sync".
 *   3. Within a stage, every COPY line must appear BEFORE that stage's
 *      `pnpm install`. This is the ordering the whole scheme depends on, so it
 *      is checked rather than assumed — a COPY that drifts below the install
 *      breaks `docker build` and passes every other check in CI.
 *
 * What it still cannot tell you: whether `prod-deps` is missing a member the
 * image needs at RUNTIME. Which members belong there is a judgment call per
 * image (see AGENTS.md), so adding that line when you add a workspace member
 * remains a manual step.
 *
 * Intentional exclusions (allowlisted, never expected in a COPY list):
 *   - apps/cli          — excluded from the Docker build context via .dockerignore
 *                         (the Rust CLI never ships in the container images).
 *
 * The runner stages are deliberately NOT checked for workspace members: they
 * copy only the minimal set of manifests a running image needs, not the install
 * closure. They ARE checked for runtime SCRIPTS (see the bottom of this file):
 * every sibling script a shipped shell script shells out to must be COPY'd into
 * the same image — for both runtime images.
 * Both app images' HEALTHCHECK `--start-period` is also checked against the
 * migration startup gate (runner steps + full-bundle budget),
 * because Docker only exempts failed probes during the start-period window.
 *
 * Node builtins only — no new packages, safe to run in the
 * CI `lint` job alongside `pnpm env:check`.
 */

import { deepStrictEqual, ok } from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { readNodeBaseImage } from "../packages/test-utils/src/kb/node-image.mjs";
import {
  COREPACK_VERSION,
  canonicalPnpmRun,
  PNPM_PIN,
  pnpmToolchainErrors,
} from "./lib/dockerfile-pnpm.js";

const ROOT = resolve(import.meta.dirname!, "..");

// Workspace members that legitimately have no pre-install COPY line.
const ALLOWLIST = new Set(["apps/cli"]);

// Stages whose COPY lists we verify. The runner stages are intentionally left
// out (they copy only what a running image needs, not the install closure).
const BUILDER = "builder";
const PROD_DEPS = "prod-deps";

const DOCKERFILES = ["Dockerfile", "Dockerfile.worker"];

// Two full-bundle hooks (pre-migrate and pre-drop) can each drain maintenance
// for 300s and run the fenced snapshot for 3900s. Keep 120s ordinary DDL/boot
// headroom as well. This is a deployment budget, not a DDL timeout/kill switch.
const APPLY_BUDGET_SLACK = 120;
const FULL_BUNDLE_BUDGET_SECONDS = fullBundleBudgetSeconds(
  readFileSync(resolve(ROOT, "scripts/lib/kb-backup.mjs"), "utf8"),
);

/** Maintenance drain plus the longest fenced snapshot and heartbeat, twice. */
function fullBundleBudgetSeconds(text: string): number {
  const timeouts = [...text.matchAll(/\btimeout\s*:\s*([\d_]+)/g)].map((match) =>
    Number(match[1]!.replaceAll("_", "")),
  );
  const drain = text.match(/\btimeout\s*=\s*([\d_]+)/)?.[1];
  if (!timeouts.length || !drain) throw new Error("Cannot parse full-bundle startup budget.");
  return 2 * (Math.max(...timeouts) / 1000 + Number(drain.replaceAll("_", "")) / 1000 + 40);
}
const BUDGET_SOURCES = ["scripts/db/migrate-runtime.mjs", "scripts/db/lib/contracts.mjs"];

/** Discover on-disk workspace members: `apps/*` / `packages/*` with a package.json. */
function discoverMembers(): Set<string> {
  const members = new Set<string>();
  for (const group of ["apps", "packages"]) {
    let entries: string[];
    try {
      entries = readdirSync(resolve(ROOT, group), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      continue;
    }
    for (const name of entries) {
      const id = `${group}/${name}`;
      try {
        readFileSync(resolve(ROOT, group, name, "package.json"));
        members.add(id);
      } catch {
        // no package.json → not a workspace member (e.g. an assets-only dir)
      }
    }
  }
  return members;
}

/**
 * Yield Dockerfile *logical* lines: physical lines with trailing-backslash
 * continuations folded into one, reported at the line number the instruction
 * starts on. Without this, any multi-line `RUN`/`COPY` reads as several
 * unrelated fragments — see `installRe` for why that matters.
 */
function* logicalLines(text: string): Generator<{ line: string; lineNo: number }> {
  const physical = text.split("\n");
  let buffer = "";
  let startLine = 0;

  for (let i = 0; i < physical.length; i++) {
    const raw = (physical[i] ?? "").trim();
    // A `\` continues the instruction onto the next physical line.
    const continues = raw.endsWith("\\");
    const piece = continues ? raw.slice(0, -1).trim() : raw;

    if (buffer === "") startLine = i + 1;
    buffer = buffer === "" ? piece : `${buffer} ${piece}`;

    if (continues) continue;
    yield { line: buffer, lineNo: startLine };
    buffer = "";
  }
  // A file ending on a dangling continuation still yields what it accumulated.
  if (buffer !== "") yield { line: buffer, lineNo: startLine };
}

/** Exclude only the exact, build-only toolchain install from the runtime-deps guard. */
function toolingRuntimeInstructions(text: string, packageManager: string): string {
  const canonical = PNPM_PIN.test(packageManager) ? canonicalPnpmRun(packageManager) : "";
  let builder = false;
  const kept: string[] = [];
  for (const { line } of logicalLines(text)) {
    if (/^#/.test(line)) continue;
    if (/^FROM\s/i.test(line)) builder = /\sAS\s+(builder|build-base)$/i.test(line);
    if (builder && line === canonical) continue;
    kept.push(line);
  }
  return kept.join("\n");
}

/**
 * Split a Dockerfile into stages keyed by their `AS <name>` label and collect
 * the `COPY <group>/<name>/package.json <group>/<name>/` members in each.
 */
function parseStages(dockerfile: string): Map<string, Set<string>> {
  const text = readFileSync(resolve(ROOT, dockerfile), "utf8");
  const stages = new Map<string, Set<string>>();
  let current: Set<string> | null = null;

  // `FROM --platform=… <image> AS <stage>`: the flags between FROM and the
  // image are optional, and `AS` is case-insensitive in Dockerfile syntax.
  const stageRe = /^FROM\s+(?:--\S+\s+)*\S+\s+AS\s+(\S+)/i;
  const copyRe =
    /^COPY\s+((?:apps|packages)\/[^/]+)\/package\.json\s+((?:apps|packages)\/[^/]+)\//i;
  // The whole point of the hand-enumerated COPY lines is that they land before
  // the install, so the lockfile's importers and workspace symlinks resolve
  // against real package.json files. A COPY that drifts below this breaks
  // `docker build` at install time and nothing else in CI would catch it.
  //
  // Matched against JOINED logical lines (see below), not physical ones. The
  // install is single-line today, but the standard BuildKit cache-mount form
  // splits it:
  //
  //     RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
  //         pnpm install --frozen-lockfile
  //
  // A physical-line match would silently stop finding the install there, and
  // invariant 3 would check nothing while still reporting "in sync" — the exact
  // vacuous pass the other two invariants guard against.
  const installRe = /^RUN\s[\s\S]*pnpm\s+install/i;

  let currentStage = "";
  let installSeenAt = -1;

  for (const { line, lineNo } of logicalLines(text)) {
    const stageMatch = stageRe.exec(line);
    if (stageMatch) {
      current = new Set<string>();
      currentStage = stageMatch[1] ?? "";
      installSeenAt = -1;
      stages.set(currentStage, current);
      continue;
    }
    if (!current) continue;
    if (installRe.test(line)) {
      installSeenAt = lineNo;
      continue;
    }
    const copyMatch = copyRe.exec(line);
    if (copyMatch) {
      if (installSeenAt !== -1) {
        errors.push(
          `${dockerfile} (${currentStage}): COPY line for "${copyMatch[1]}" on line ${lineNo} ` +
            `comes AFTER \`pnpm install\` on line ${installSeenAt}. It must precede the install, ` +
            `or the install resolves against a missing package.json and \`docker build\` fails.`,
        );
      }
      // Both sides of the COPY must reference the same member; a mismatch is a
      // typo worth surfacing (e.g. a bad copy/paste of the destination path).
      if (copyMatch[1] !== copyMatch[2]) {
        errors.push(
          `${dockerfile}: COPY line mismatch — source "${copyMatch[1]}" but destination "${copyMatch[2]}".`,
        );
      }
      current.add(copyMatch[1] ?? "");
    }
  }
  return stages;
}

/** Require the actual source-to-destination mapping in the final runner stage. */
function runtimeScriptCopies(text: string): Set<string> {
  const copied = new Set<string>();
  let runner = false;
  for (const { line } of logicalLines(text)) {
    if (/^FROM\s/i.test(line)) {
      runner = /\sAS\s+runner$/i.test(line);
      continue;
    }
    if (!runner || !/^COPY\s/i.test(line)) continue;
    const body = line.replace(/^COPY\s+/i, "").replace(/^(?:--\S+\s+)*/, "");
    const parts: string[] = body.startsWith("[") ? JSON.parse(body) : body.split(/\s+/);
    const destination = parts.pop();
    if (!destination) continue;
    for (const source of parts) {
      const script = source.replace(/^\/app\//, "").replace(/^\.\//, "");
      if (
        /^scripts\/(?:db|backup)\/$/.test(script) &&
        resolve("/app", destination) === `/app/${script.slice(0, -1)}`
      ) {
        const walk = (dir: string) => {
          for (const entry of readdirSync(resolve(ROOT, dir), { withFileTypes: true })) {
            const rel = `${dir}/${entry.name}`;
            if (entry.isDirectory()) walk(rel);
            else if (/\.(mjs|sh|ts)$/.test(rel)) copied.add(rel);
          }
        };
        if (existsSync(resolve(ROOT, script))) walk(script.slice(0, -1));
        continue;
      }
      if (!/^scripts\/.+\.(?:mjs|sh|ts)$/.test(script)) continue;
      const target = resolve(
        "/app",
        destination,
        parts.length > 1 || destination.endsWith("/") ? basename(source) : "",
      );
      const expected =
        script === "scripts/docker-entrypoint.sh"
          ? "/usr/local/bin/docker-entrypoint.sh"
          : `/app/${script}`;
      if (target === expected) copied.add(script);
    }
  }
  return copied;
}

/** Inventory shell siblings, Node root-relative helpers, and local ESM imports. */
function runtimeScriptReferences(script: string, text: string): Set<string> {
  const references = new Set<string>();
  for (const match of text.matchAll(
    /(?:\$\(dirname "\$0"\)|\$ROOT\/scripts|\/app\/scripts)\/([A-Za-z0-9._/-]+\.(?:mjs|sh|ts))/g,
  )) {
    references.add(`scripts/${match[1]}`);
  }
  for (const match of text.matchAll(/["'](scripts\/[A-Za-z0-9._/-]+\.(?:mjs|sh|ts))["']/g)) {
    references.add(match[1]!);
  }
  for (const match of text.matchAll(
    /(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.[^"']+\.(?:mjs|sh|ts))["']/g,
  )) {
    references.add(relative(ROOT, resolve(ROOT, dirname(script), match[1]!)));
  }
  return references;
}

/**
 * HEALTHCHECK `--start-period=<N>s` in seconds, or null when the directive (or
 * the flag) is absent. Reads logical lines so the standard two-line
 * `HEALTHCHECK … \ CMD …` form parses as one instruction.
 */
function healthcheckStartPeriod(text: string): number | null {
  for (const { line } of logicalLines(text)) {
    if (!/^HEALTHCHECK\s/i.test(line)) continue;
    const seconds = line.match(/--start-period=(\d+)s/i)?.[1];
    return seconds ? Number(seconds) : null;
  }
  return null;
}

/** `export const <NAME> = <number>;` from the runner's source. */
function exportedNumber(text: string, name: string): number | null {
  const value = text.match(new RegExp(`export const ${name}\\s*=\\s*([\\d_]+)`))?.[1];
  return value ? Number(value.replaceAll("_", "")) : null;
}

/** `export const <NAME> = <ms>;` from the runner's source, in seconds. */
function exportedSeconds(text: string, name: string): number | null {
  const ms = exportedNumber(text, name);
  return ms === null ? null : ms / 1000;
}

/** The startup budget: every timed step of a start, in order, in seconds. */
type StartupBudget = { parts: Array<{ label: string; seconds: number }> };

/** Millisecond constants, each one timed step (label = the constant's name). */
const BUDGET_STEPS = [
  "WAIT_TIMEOUT_MS",
  "PREDEPLOY_CATALOG_TIMEOUT_MS",
  "CONTRACT_RUN_BUDGET_MS",
  "CONTRACT_PREAMBLE_TIMEOUT_MS",
  "IMAGE_SCHEMA_TIMEOUT_MS",
  "CONTRACTS_CATALOG_TIMEOUT_MS",
  "REGISTER_TIMEOUT_MS",
];

/** Parse the budget from the concatenated BUDGET_SOURCES; null when any part is missing. */
function startupBudget(text: string): StartupBudget | null {
  const parts: StartupBudget["parts"] = [
    { label: "two full bundles", seconds: FULL_BUNDLE_BUDGET_SECONDS },
  ];
  for (const name of BUDGET_STEPS) {
    const seconds = exportedSeconds(text, name);
    if (seconds === null) return null;
    parts.push({ label: name, seconds });
    if (name === "WAIT_TIMEOUT_MS")
      parts.push({ label: "apply budget", seconds: APPLY_BUDGET_SLACK });
  }
  const steps = exportedNumber(text, "RUNTIME_STEPS");
  const stepSeconds = exportedSeconds(text, "RUNTIME_STEP_TIMEOUT_MS");
  if (steps === null || stepSeconds === null) return null;
  parts.push({
    label: `RUNTIME_STEPS ${steps} × RUNTIME_STEP_TIMEOUT_MS`,
    seconds: steps * stepSeconds,
  });
  return { parts };
}

function healthcheckStartPeriodErrors(
  dockerfile: string,
  text: string,
  budget: StartupBudget,
): string[] {
  const actual = healthcheckStartPeriod(text);
  const required = budget.parts.reduce((sum, part) => sum + part.seconds, 0);
  if (actual !== null && actual > required) return [];
  return [
    `${dockerfile}: HEALTHCHECK start-period must exceed ${required}s (runner steps, two full bundles and DDL/boot headroom); got ${actual ?? "missing"}.`,
  ];
}

/** The shell hands off to the output owner. That owner launches the native
 * fence supervisor immediately above the application (proved by kb-process's
 * real-process tests); launching native directly here bypasses output ownership.
 */
function serviceOutputEntrypointErrors(
  service: "server" | "worker",
  dockerfile: string,
  entrypoint: string,
  bundleConfig: string,
): string[] {
  const problems: string[] = [];
  const shell = entrypoint
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  const execs = shell.filter((line) => /^exec\s/.test(line));
  if (
    execs.filter((line) => line === 'exec "$@"').length !== 1 ||
    shell.at(-1) !== 'exec "$@"' ||
    execs.some((line) => line.includes("kb-supervisor"))
  )
    problems.push(
      'scripts/docker-entrypoint.sh must hand off with exec "$@" to the output supervisor.',
    );
  let runner = false;
  const commands: string[][] = [];
  for (const { line } of logicalLines(dockerfile)) {
    if (/^FROM\s/i.test(line)) runner = /\sAS\s+runner$/i.test(line);
    if (!runner || !/^CMD\s/i.test(line)) continue;
    try {
      commands.push(JSON.parse(line.replace(/^CMD\s+/i, "")));
    } catch {
      problems.push(`${service} image must use a JSON CMD for the output supervisor.`);
    }
  }
  const expected = ["node", `apps/${service}/dist/index.mjs`, "--fenced"];
  if (commands.length !== 1 || JSON.stringify(commands[0]) !== JSON.stringify(expected))
    problems.push(`${service} image CMD must start its output supervisor with --fenced.`);
  const config = bundleConfig
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  if (!/\bindex:\s*["']\.\/src\/output\.ts["']/.test(config))
    problems.push(`${service} must bundle src/output.ts as its index entry.`);
  return problems;
}

if (process.argv.includes("--self-test")) {
  for (const service of ["server", "worker"] as const) {
    const dockerfile = `FROM base AS runner\nCMD ["node", "apps/${service}/dist/index.mjs", "--fenced"]\n`;
    const entrypoint = '#!/bin/sh\n# native is launched by the output supervisor\nexec "$@"\n';
    const config = 'entry: { index: "./src/output.ts", service: "./src/bootstrap.ts" }';
    const check = (image = dockerfile, shell = entrypoint, bundle = config) =>
      serviceOutputEntrypointErrors(service, image, shell, bundle);
    deepStrictEqual(check(), []);
    for (const image of [
      dockerfile.replace(', "--fenced"', ""),
      dockerfile.replace("dist/index.mjs", "dist/service.mjs"),
      dockerfile.replace('["node",', '["/usr/local/bin/kb-supervisor", "--", "node",'),
      dockerfile.replace(" AS runner", " AS builder"),
    ])
      ok(check(image).length > 0, image);
    for (const shell of [
      entrypoint.replace('exec "$@"', 'exec /usr/local/bin/kb-supervisor -- "$@"'),
      entrypoint.replace('exec "$@"', '"$@"'),
      `${entrypoint}echo finished\n`,
      `exec /usr/local/bin/kb-supervisor -- node service.mjs\n${entrypoint}`,
    ])
      ok(check(dockerfile, shell).length > 0, shell);
    ok(
      check(dockerfile, entrypoint, config.replace("src/output.ts", "src/bootstrap.ts")).length > 0,
    );
  }
  {
    // Lint fixtures. The lint is a convenience guard; misses it accepts must be
    // caught by the runtime preflight (scripts/dev-docker.test.mjs proves that
    // for an absolute-path chmod of the toolchain).
    const hash = "a".repeat(128);
    const pm = `pnpm@1.2.3+sha512.${hash}`;
    const canonical = canonicalPnpmRun(pm);
    const errs = (text: string, spec = pm) => pnpmToolchainErrors("Dockerfile.dev", text, spec);
    const good = `FROM node AS b
ENV PNPM_HOME=/pnpm
ENV COREPACK_HOME=/opt/corepack
# comments may mention corepack
${canonical}
RUN mkdir -p "$PNPM_HOME/store" "$HOME" \\
  && chmod -R a+rwX /app "$PNPM_HOME/store" "$HOME"
`;
    deepStrictEqual(errs(good), []);
    const toolingBuilder = `FROM node AS builder\n${canonical}\n`;
    ok(!/\bnpm\s+install\b/.test(toolingRuntimeInstructions(toolingBuilder, pm)));
    for (const bad of [
      `${toolingBuilder}RUN npm install prisma`,
      toolingBuilder.replace("AS builder", "AS runner"),
      toolingBuilder.replace(`corepack@${COREPACK_VERSION}`, "corepack@latest"),
      toolingBuilder.replace(`corepack@${COREPACK_VERSION}`, `corepack@${COREPACK_VERSION} prisma`),
      `${toolingBuilder}FROM node\n${canonical}`,
      `${toolingBuilder.trimEnd()} && npm install prisma`,
    ])
      ok(/\bnpm\s+install\b/.test(toolingRuntimeInstructions(bad, pm)), bad);
    // A missing or invalid packageManager must not exempt any install.
    ok(/\bnpm\s+install\b/.test(toolingRuntimeInstructions(toolingBuilder, "")));
    // Corepack must be installed first from an exact pin, in the same RUN.
    const installCorepack = `npm install --global --no-fund --no-audit corepack@${COREPACK_VERSION}`;
    for (const bad of [
      canonical.replace(`${installCorepack} && `, ""),
      canonical.replace(`corepack@${COREPACK_VERSION}`, "corepack@latest"),
      canonical.replace(`corepack@${COREPACK_VERSION}`, "corepack@0.0.0"),
      canonical.replace(`${installCorepack} && `, "") + ` && ${installCorepack}`,
      canonical.replace(`${installCorepack} && `, `${installCorepack}\nRUN `),
    ])
      ok(errs(good.replace(canonical, bad)).length >= 1, bad);
    // Failure masked, warm-up commented out, reordered, split, or a second prepare.
    for (const bad of [
      `${canonical} || true`,
      canonical.replace(" && test", " # && test"),
      canonical.replace(/^RUN (.*) && (corepack prepare .*)$/, "RUN $2 && $1"),
      canonical.replace(" && corepack prepare", " \\\n  && corepack prepare"),
      `${canonical}\nRUN corepack prepare ${pm} --activate`,
    ])
      ok(errs(good.replace(canonical, bad)).length >= 1, bad);
    // A canonical line that is only heredoc text, or only in an unused stage.
    ok(errs(good.replace(canonical, `RUN cat <<EOF\n${canonical}\nEOF`)).length >= 1);
    ok(
      errs(`FROM node AS unused\n${canonical}\n${good.replace(canonical, "RUN true")}`).length >= 1,
    );
    // Permission changes of the toolchain, its ancestors or a relative path.
    for (const extra of [
      'RUN chmod -R a+rwX "$PNPM_HOME" "$COREPACK_HOME"',
      'RUN /bin/chmod -R a+rwX "$PNPM_HOME"',
      "RUN chmod -R a+rwX /opt",
      "RUN chmod -R a+rwX /usr/local/lib/node_modules/corepack",
      "RUN chown -R 1000:1000 /usr/local/lib/node_modules/corepack/dist",
      'COPY --chmod=777 tool "/usr/local/lib/node_modules/corepack/dist"',
      "WORKDIR /pnpm\nRUN chmod -R a+rwX .",
      'RUN chmod a+w "$COREPACK_HOME/v1/pnpm/1.2.3/pnpm-native"',
      "RUN chown -R 1000:1000 /opt/corepack/v1/pnpm/1.2.3/dist",
      ["RUN chmod a+w ", '"$', '{PNPM_HOME}/pnpm"'].join(""),
      "COPY --chown=0:1000 tool /opt/corepack/v1/pnpm/1.2.3/pnpm-native",
      'ADD --chmod=775 tool "$PNPM_HOME/pnpm"',
      'COPY --chown=1000 ["tool", "/opt/"]',
      "WORKDIR /pnpm\nCOPY --chmod=777 tool .",
    ])
      ok(errs(`${good}${extra}\n`).length >= 1, extra);
    // Missing, malformed and truncated hashes: in packageManager and in the Dockerfile.
    for (const bad of [
      "pnpm@1.2.3",
      `pnpm@1.2.3+sha512.${hash.slice(1)}`,
      `pnpm@1.2.3+sha512.${"g".repeat(128)}`,
      `pnpm@1.2.3+sha256.${"a".repeat(64)}`,
      `pnpm@1.2.3+sha512.${hash}x`,
    ]) {
      deepStrictEqual(errs(good.replaceAll(pm, bad), bad).length, 1, bad);
      ok(errs(good.replaceAll(pm, bad)).length >= 2, bad);
    }
  }
  deepStrictEqual(
    [
      ...runtimeScriptCopies(`FROM base AS builder
COPY scripts/builder.mjs ./scripts/
FROM base AS runner
# COPY scripts/comment.mjs ./scripts/
RUN echo scripts/mentioned.mjs
COPY scripts/wrong.mjs /wrong/
COPY scripts/renamed.mjs ./scripts/other.mjs
COPY --chown=node:node scripts/db/migrate-runtime.mjs ./scripts/db/
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY scripts/db/lib/migration-state.mjs ./scripts/db/lib/
COPY scripts/lib/backup-env.sh ./scripts/lib/
COPY ["scripts/json.mjs", "./scripts/"]
`),
    ].sort(),
    [
      "scripts/db/lib/migration-state.mjs",
      "scripts/db/migrate-runtime.mjs",
      "scripts/docker-entrypoint.sh",
      "scripts/json.mjs",
      "scripts/lib/backup-env.sh",
    ],
  );
  deepStrictEqual(
    [
      ...runtimeScriptReferences(
        "scripts/db/migrate-runtime.mjs",
        `import { classifyDiff } from "./lib/migration-state.mjs";
run("bash", [resolve(root, "scripts/backup/pre-migrate.sh")]);
node "$ROOT/scripts/backup/schedule.mjs"
`,
      ),
    ].sort(),
    [
      "scripts/backup/pre-migrate.sh",
      "scripts/backup/schedule.mjs",
      "scripts/db/lib/migration-state.mjs",
    ],
  );
  const fixture = `FROM base AS runner
HEALTHCHECK --start-period=10800s CMD node probe.mjs
`;
  const source = BUDGET_SOURCES.map((file) => readFileSync(resolve(ROOT, file), "utf8")).join("\n");
  const budget = startupBudget(source);
  ok(budget);
  deepStrictEqual(healthcheckStartPeriodErrors("Dockerfile", fixture, budget), []);
  ok(healthcheckStartPeriodErrors("Dockerfile", fixture.replace("10800s", "480s"), budget).length);
  for (const name of [...BUDGET_STEPS, "RUNTIME_STEPS", "RUNTIME_STEP_TIMEOUT_MS"]) {
    deepStrictEqual(
      startupBudget(source.replace(new RegExp(`export const ${name} = [\\d_]+;`), "")),
      null,
    );
  }
  const nested = runtimeScriptCopies("FROM base AS runner\nCOPY scripts/db/ ./scripts/db/\n");
  ok(nested.has("scripts/db/lib/prisma-owner.mjs"));
  ok(
    !runtimeScriptCopies("FROM base AS runner\nCOPY scripts/db/ ./wrong/\n").has(
      "scripts/db/lib/prisma-owner.mjs",
    ),
  );
  console.log("Docker runtime COPY regression checks passed.");
  process.exit(0);
}

const errors: string[] = [];

const members = discoverMembers();
const expectedBuilder = new Set([...members].filter((m) => !ALLOWLIST.has(m)).sort());

const builderLists = new Map<string, Set<string>>();

for (const dockerfile of DOCKERFILES) {
  const stages = parseStages(dockerfile);

  const builder = stages.get(BUILDER);
  if (!builder) {
    errors.push(
      `${dockerfile}: no \`${BUILDER}\` stage found (expected a \`FROM … AS ${BUILDER}\`).`,
    );
  } else {
    builderLists.set(dockerfile, builder);
    // Invariant 1: builder must list every on-disk member minus the allowlist.
    const missing = [...expectedBuilder].filter((m) => !builder.has(m));
    const extra = [...builder].filter((m) => !members.has(m) || ALLOWLIST.has(m));
    for (const m of missing) {
      errors.push(
        `${dockerfile} (${BUILDER}): missing COPY line for "${m}". Add:\n    COPY ${m}/package.json ${m}/`,
      );
    }
    for (const m of extra) {
      const why = ALLOWLIST.has(m)
        ? "it is an intentional exclusion (allowlisted)"
        : "no such workspace member exists on disk (stale line?)";
      errors.push(`${dockerfile} (${BUILDER}): unexpected COPY line for "${m}" — ${why}.`);
    }
  }

  const prodDeps = stages.get(PROD_DEPS);
  if (!prodDeps) {
    errors.push(
      `${dockerfile}: no \`${PROD_DEPS}\` stage found (expected a \`FROM … AS ${PROD_DEPS}\`).`,
    );
  } else if (builder) {
    // Invariant 2: prod-deps must be a non-empty subset of this file's builder
    // list. Subset-checking alone passes vacuously on an empty set, so wiping
    // every COPY line would read as "in sync" — assert it kept some.
    if (prodDeps.size === 0) {
      errors.push(
        `${dockerfile} (${PROD_DEPS}): no workspace COPY lines found. This stage must copy the ` +
          `package.json of every member the image needs at runtime; an empty list passes the ` +
          `subset check vacuously but fails \`docker build\`.`,
      );
    }
    const notInBuilder = [...prodDeps].filter((m) => !builder.has(m));
    for (const m of notInBuilder) {
      const why = members.has(m)
        ? `it is absent from the ${BUILDER} stage (the two lists drifted)`
        : "no such workspace member exists on disk (stale line?)";
      errors.push(`${dockerfile} (${PROD_DEPS}): COPY line for "${m}" — ${why}.`);
    }
  }
}

// Invariant 1 (corollary): both builder lists resolve to the same expected set,
// so they must be identical. Report any divergence explicitly for clarity.
if (builderLists.size === DOCKERFILES.length) {
  const [a, b] = DOCKERFILES as [string, string];
  const setA = builderLists.get(a)!;
  const setB = builderLists.get(b)!;
  const onlyA = [...setA].filter((m) => !setB.has(m));
  const onlyB = [...setB].filter((m) => !setA.has(m));
  for (const m of onlyA) {
    errors.push(`${BUILDER} stages diverged: "${m}" is in ${a} but not ${b}.`);
  }
  for (const m of onlyB) {
    errors.push(`${BUILDER} stages diverged: "${m}" is in ${b} but not ${a}.`);
  }
}

const packageJson = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
  packageManager?: string;
};
const pnpmPin = PNPM_PIN.exec(packageJson.packageManager ?? "")?.[1];
if (!pnpmPin) errors.push("package.json packageManager must be pnpm@x.y.z+sha512.<128 hex>.");
if (pnpmPin && packageJson.packageManager) {
  for (const dockerfile of [...DOCKERFILES, "Dockerfile.dev"]) {
    const path = resolve(ROOT, dockerfile);
    if (!existsSync(path)) {
      continue;
    }
    const text = readFileSync(path, "utf8");
    errors.push(...pnpmToolchainErrors(dockerfile, text, packageJson.packageManager));
    if (dockerfile !== "Dockerfile.dev" && !/tini/.test(text)) {
      errors.push(`${dockerfile} does not install or use tini as PID 1.`);
    }
  }
}

const dockerignore = existsSync(resolve(ROOT, ".dockerignore"))
  ? readFileSync(resolve(ROOT, ".dockerignore"), "utf8")
  : "";
for (const required of ["backups"]) {
  if (
    !dockerignore
      .split("\n")
      .some((line) => line.trim() === required || line.trim() === `${required}/`)
  ) {
    errors.push(
      `.dockerignore must exclude ${required}/ so local dumps never enter the build context.`,
    );
  }
}

for (const file of DOCKERFILES) {
  const text = readFileSync(resolve(ROOT, file), "utf8");
  const instructions = toolingRuntimeInstructions(text, packageJson.packageManager ?? "");
  if (!/pnpm[\s\S]*?\bdeploy\b/.test(instructions) || /\bnpm\s+install\b/.test(instructions))
    errors.push(
      `${file}: runtime tooling must use the lockfile-pinned pnpm deploy closure; floating npm install is forbidden.`,
    );
  for (const required of [
    "COPY LICENSE NOTICE THIRD-PARTY-LICENSES.md /app/",
    "COPY scripts/lib/age-pin.mjs /tmp/age-pin.mjs",
    "node /tmp/age-pin.mjs --install /opt/age",
    "COPY --from=age-tooling /opt/age/age /opt/age/age-keygen /usr/local/bin/",
    "COPY --chown=node:node --from=builder /app/schema-runtime/node_modules ./schema-runtime/node_modules",
    "COPY --from=builder /app/packages/db/prisma ./packages/db/prisma",
    "COPY apps/worker/src/native/child-guard.c ./",
    "COPY --from=native /src/kb-child-guard /usr/local/bin/kb-child-guard",
  ])
    if (!text.includes(required))
      errors.push(`${file}: missing pinned runtime artifact: ${required}`);
  for (const name of ["prisma", "pg", "dotenv", "@aws-sdk/client-s3"])
    if (!text.includes(`/app/schema-runtime/node_modules/${name} /app/node_modules/${name}`))
      errors.push(`${file}: ${name} must resolve from the deployed tooling closure at the root.`);
}

// --- Postgres client major: both runtime Dockerfiles must agree ---
//
// `pg_dump` can dump a server OLDER than itself but never a NEWER one, so if a
// Dockerfile's `ARG PG_MAJOR` falls behind the database server's major, every
// backup fails at 3am with a message nobody reads. Both runtime images pin the
// client from the PGDG apt repo. Drift between any of them is the bug, so
// require one identical major everywhere.
const PG_MAJOR_SOURCES = DOCKERFILES;
const pgMajors = new Map<string, string>();

for (const dockerfile of PG_MAJOR_SOURCES) {
  const path = resolve(ROOT, dockerfile);
  if (!existsSync(path)) continue;
  const major = readFileSync(path, "utf8").match(/^ARG\s+PG_MAJOR=(\d+)/m)?.[1];
  if (!major) {
    errors.push(
      `${dockerfile}: no \`ARG PG_MAJOR=<major>\` found. The postgresql-client major must be ` +
        `pinned (PGDG), not inherited from Debian's default repo.`,
    );
    continue;
  }
  pgMajors.set(dockerfile, major);
}

const pgMajor = [...new Set(pgMajors.values())][0];
if (new Set(pgMajors.values()).size > 1) {
  const listed = [...pgMajors].map(([source, major]) => `${source} → ${major}`).join(", ");
  errors.push(
    `Postgres major drift: ${listed}. The client shipped in the images must be the same major as ` +
      `(or newer than) the server, and this repo keeps them identical — set the same value in ` +
      `\`ARG PG_MAJOR\` in ${PG_MAJOR_SOURCES.join(", ")}.`,
  );
}

// The runner's timed steps plus both encrypted full-bundle hooks determine
// health grace; worker wait expiration is retried by the restart policy.
const runnerBudget = startupBudget(
  BUDGET_SOURCES.map((file) => readFileSync(resolve(ROOT, file), "utf8")).join("\n"),
);
if (!runnerBudget) errors.push("Cannot parse every migration runner startup budget constant.");
else
  for (const dockerfile of DOCKERFILES)
    errors.push(
      ...healthcheckStartPeriodErrors(
        dockerfile,
        readFileSync(resolve(ROOT, dockerfile), "utf8"),
        runnerBudget,
      ),
    );

// Traverse the actual entrypoint-reachable nested import graph per image.
const RUNTIME_SCRIPT_ROOTS = Object.fromEntries(
  DOCKERFILES.map((file) => [
    file,
    [
      "scripts/docker-entrypoint.sh",
      "scripts/db/migrate-runtime.mjs",
      "scripts/backup.sh",
      "scripts/backup/pre-migrate.sh",
      "scripts/backup/schedule.mjs",
      "scripts/backup/restore.sh",
      "scripts/backup/drill.mjs",
      "scripts/lib/asset-storage-migration.mjs",
    ],
  ]),
);
for (const [dockerfile, roots] of Object.entries(RUNTIME_SCRIPT_ROOTS)) {
  const dockerfilePath = resolve(ROOT, dockerfile);
  if (!existsSync(dockerfilePath)) continue;
  const referencedScripts = new Set<string>(roots);
  for (const rel of referencedScripts) {
    const path = resolve(ROOT, rel);
    if (!existsSync(path)) continue;
    for (const dependency of runtimeScriptReferences(rel, readFileSync(path, "utf8"))) {
      referencedScripts.add(dependency);
    }
  }
  const copiedScripts = runtimeScriptCopies(readFileSync(dockerfilePath, "utf8"));
  for (const script of [...referencedScripts].sort()) {
    if (!existsSync(resolve(ROOT, script))) {
      errors.push(`${script} is referenced from a runtime script but does not exist in the repo.`);
      continue;
    }
    if (!copiedScripts.has(script)) {
      errors.push(
        `${dockerfile} does not COPY ${script}, but a shipped runtime script invokes it — add it to the runner-stage COPY list.`,
      );
    }
  }
}

// Worker: the forked Qwen child's parent-death guard is compiled in the image
// (never a host binary) and the parent bundle must never reference the addon.
const workerDockerfileText = readFileSync(resolve(ROOT, "Dockerfile.worker"), "utf8");
if (!/^FROM node:26-trixie-slim@sha256:[a-f0-9]{64} AS native$/m.test(workerDockerfileText)) {
  errors.push(
    "Dockerfile.worker must have an explicit `FROM <pinned node base> AS native` guard stage.",
  );
}
if (
  !/COPY apps\/worker\/src\/native\/child-guard\.c \.\//.test(workerDockerfileText) ||
  !/COPY --from=native \/src\/kb-child-guard \/usr\/local\/bin\/kb-child-guard/.test(
    workerDockerfileText,
  )
) {
  errors.push(
    "Dockerfile.worker must compile apps/worker/src/native/child-guard.c in the native stage and COPY it to /usr/local/bin/kb-child-guard.",
  );
}
if (!existsSync(resolve(ROOT, "apps/worker/src/native/child-guard.c"))) {
  errors.push("apps/worker/src/native/child-guard.c is missing.");
}
if (!/test -f apps\/worker\/dist\/qwen-child\.mjs/.test(workerDockerfileText)) {
  errors.push("Dockerfile.worker builder must verify apps/worker/dist/qwen-child.mjs exists.");
}

const serverDockerfile = readFileSync(resolve(ROOT, "Dockerfile"), "utf8");
if (!/^FROM node:26-trixie-slim@sha256:[a-f0-9]{64} AS native$/m.test(serverDockerfile)) {
  errors.push(
    "Dockerfile must have an explicit `FROM <pinned node base> AS native` supervisor build stage.",
  );
}

// One Node base for every image: Debian 13 trixie, digest-pinned, read
// from Dockerfile's base stage. Every stage that starts from a registry image
// must use exactly that reference, so git/glibc/OpenSSL never differ between
// the server, worker and dev images (R3-W1: a bookworm image
// shipped a git too old for the merge code).
{
  let base: string | undefined;
  try {
    base = readNodeBaseImage(ROOT);
  } catch (error) {
    errors.push((error as Error).message);
  }
  if (base) {
    for (const file of ["Dockerfile", "Dockerfile.worker", "Dockerfile.dev"]) {
      const text = readFileSync(resolve(ROOT, file), "utf8");
      const stages = [...text.matchAll(/^FROM\s+(\S+)(?:\s+AS\s+(\S+))?\s*$/gim)];
      const names = new Set(stages.flatMap((m) => (m[2] ? [m[2].toLowerCase()] : [])));
      for (const [, image] of stages) {
        if (image && !names.has(image.toLowerCase()) && image !== base)
          errors.push(`${file}: \`FROM ${image}\` must be the pinned Node base \`${base}\`.`);
      }
    }
  }
}
if (
  !/COPY --from=native \/src\/kb-supervisor \/usr\/local\/bin\/kb-supervisor/.test(serverDockerfile)
) {
  errors.push(
    "Dockerfile runner must COPY kb-supervisor from the native stage to /usr/local/bin/kb-supervisor.",
  );
}
if (!existsSync(resolve(ROOT, "apps/server/native/kb-supervisor.c"))) {
  errors.push("apps/server/native/kb-supervisor.c is missing.");
}
if (!/rm -f kb-supervisor && make -j2/.test(serverDockerfile)) {
  errors.push(
    "Dockerfile native stage must delete a host-built kb-supervisor before compiling so image libc is used.",
  );
}
if (!dockerignore.split("\n").some((line) => line.trim() === "apps/server/native/kb-supervisor")) {
  errors.push(
    ".dockerignore must exclude apps/server/native/kb-supervisor so a host-linked binary cannot enter the native stage.",
  );
}
const makefile = existsSync(resolve(ROOT, "apps/server/native/Makefile"))
  ? readFileSync(resolve(ROOT, "apps/server/native/Makefile"), "utf8")
  : "";
if (!/-Werror/.test(makefile)) {
  errors.push("apps/server/native/Makefile must compile with -Werror.");
}
const entrypoint = readFileSync(resolve(ROOT, "scripts/docker-entrypoint.sh"), "utf8");
// Packaged entrypoints must have explicit runner-stage source/destination
// copies. A whole dist COPY alone cannot prove an individual build output exists.
for (const [file, artifacts] of Object.entries({
  Dockerfile: [
    ["/app/apps/server/dist/git-pre-receive.mjs", "./apps/server/dist/git-pre-receive.mjs"],
  ],
  "Dockerfile.worker": [
    ["/src/kb-supervisor", "/usr/local/bin/kb-supervisor"],
    ["/app/apps/worker/dist/qwen-child.mjs", "./apps/worker/dist/qwen-child.mjs"],
    ["/app/apps/worker/dist/ssh-wrapper.mjs", "./apps/worker/dist/ssh-wrapper.mjs"],
  ],
})) {
  const instructions =
    readFileSync(resolve(ROOT, file), "utf8").split(/^FROM .+ AS runner$/im)[1] ?? "";
  for (const [source, destination] of artifacts) {
    if (
      ![...logicalLines(instructions)].some(
        ({ line }) =>
          /^COPY\s+--from=\S+\s/.test(line) &&
          line.split(/\s+/).slice(-2).join(" ") === `${source} ${destination}`,
      )
    )
      errors.push(`${file}: missing explicit runner COPY for ${source}.`);
  }
}
if (!entrypoint.includes('--check-runtime "$kb_volume_role"'))
  errors.push("Runtime entrypoint must check packaged artifacts and filesystem modes.");
for (const service of ["server", "worker"] as const)
  errors.push(
    ...serviceOutputEntrypointErrors(
      service,
      service === "server" ? serverDockerfile : workerDockerfileText,
      entrypoint,
      readFileSync(resolve(ROOT, `apps/${service}/tsdown.config.ts`), "utf8"),
    ),
  );

if (errors.length > 0) {
  console.error("Dockerfile COPY-list drift detected:\n");
  for (const e of errors) console.error(`  • ${e}`);
  console.error(
    "\nEdit the COPY lists in the builder/prod-deps stages of both Dockerfiles to match the workspace,",
  );
  console.error(
    "or update the ALLOWLIST in scripts/check-docker-copy.ts if an exclusion is genuinely intentional.",
  );
  process.exit(1);
}

// Report only the allowlist entries that still exist on disk. Naming a
// directory that was deleted would read as "this check still expects it back".
//
// Tested against the filesystem, not `members`: apps/cli is a cargo workspace
// with no package.json, so it is deliberately never a discovered member even
// though it is very much present.
const excluded = [...ALLOWLIST].filter((member) => existsSync(resolve(ROOT, member))).sort();

console.log(
  `Dockerfile COPY lists are in sync with ${members.size} workspace members` +
    (excluded.length > 0
      ? ` (${excluded.length} intentionally excluded: ${excluded.join(", ")})`
      : "") +
    (pgMajor ? `; Postgres major ${pgMajor} across images.` : "."),
);
