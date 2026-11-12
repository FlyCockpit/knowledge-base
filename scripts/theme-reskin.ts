/**
 * theme:reskin — the sanctioned way to run a FULL `shadcn apply --preset`.
 *
 * `pnpm theme:apply` swaps colors and fonts and is safe to run at will. This
 * script is the other thing: it regenerates every component in
 * `packages/ui/src/components`, which throws away this template's
 * customizations (the `touch`/`icon-touch` 44px sizes, `overscroll-contain`
 * on overlays) and any edits the app has made since. That is
 * destructive and only partly reversible, so it behaves like the repo's other
 * destructive commands: it refuses on a dirty tree, it will not run until the
 * user has been shown what it destroys and agreed, and it runs the recovery
 * checklist afterward instead of trusting a green type-check.
 *
 * Usage:
 *   pnpm theme:reskin <preset-code>            # dry run: prints the blast radius, exits 2
 *   pnpm theme:reskin <preset-code> --confirm  # applies, then runs the gate + checklist
 *
 * An agent must run the dry run first and stop to ask the user before adding
 * `--confirm`. Never run the bare `shadcn apply --preset` this wraps — see
 * AGENTS.md § Styling.
 */

import { execFileSync, execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname!, "..");
const COMPONENTS_DIR = resolve(ROOT, "packages/ui/src/components");
const ORPHAN_UTILS = resolve(ROOT, "apps/web/src/lib/utils.ts");

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith("-"));
const positionals = args.filter((a) => !a.startsWith("-"));
const unknownFlags = flags.filter((f) => f !== "--confirm");
const confirm = flags.includes("--confirm");
const preset = positionals[0];

function usage(): never {
  console.error(
    "Usage: pnpm theme:reskin <preset-code> [--confirm]\n" +
      'Get a code from the shadcn theme editor → "Copy Preset" (e.g. b2CPjyJD0).\n' +
      "For a color/font change use `pnpm theme:apply <code>` instead — it is safe and repeatable.",
  );
  process.exit(1);
}

if (!preset || positionals.length > 1 || unknownFlags.length > 0) {
  if (unknownFlags.length > 0) console.error(`Unknown flag(s): ${unknownFlags.join(" ")}`);
  if (positionals.length > 1)
    console.error(`Expected one preset code, got: ${positionals.join(" ")}`);
  usage();
}
if (!/^[A-Za-z0-9]+$/.test(preset)) {
  console.error(`Refusing: "${preset}" does not look like a shadcn preset code.`);
  process.exit(1);
}

const uiPackageJson = JSON.parse(
  readFileSync(resolve(ROOT, "packages/ui/package.json"), "utf-8"),
) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
const shadcnVersion =
  uiPackageJson.dependencies?.shadcn?.replace(/^[~^]/, "") ??
  uiPackageJson.devDependencies?.shadcn?.replace(/^[~^]/, "");
if (!shadcnVersion) {
  console.error("Refusing: packages/ui/package.json must pin the shadcn CLI version.");
  process.exit(1);
}

// -- 1. Clean tree, so recovery is `git restore -- <paths>` and nothing else.
//       Git must be the repo at ROOT, not a parent this checkout happens to sit
//       inside (a zip download inside another repo would otherwise report clean).
let dirty = "";
try {
  const top = execSync("git rev-parse --show-toplevel", { cwd: ROOT, encoding: "utf-8" }).trim();
  if (resolve(top) !== ROOT) {
    console.error(
      `Refusing: ${ROOT} is not the root of a git repository (git reports ${top}).\n` +
        'A re-skin is only recoverable from git history. Run `git init && git add -A && git commit -m "before re-skin"` here first.',
    );
    process.exit(1);
  }
  dirty = execSync("git status --porcelain", { cwd: ROOT, encoding: "utf-8" }).trim();
} catch {
  console.error(
    "Refusing: this directory is not a git repository, so a re-skin could not be undone.\n" +
      'Run `git init && git add -A && git commit -m "before re-skin"` here first.',
  );
  process.exit(1);
}
if (dirty) {
  console.error(
    "Refusing: the working tree has uncommitted changes. A re-skin rewrites\n" +
      "packages/ui/src/components wholesale; commit or stash first so the\n" +
      "before-state is recoverable with a path-scoped `git restore`.\n\n" +
      dirty,
  );
  process.exit(1);
}

// -- 2. Blast radius: every component file the CLI may regenerate, plus the
//       customizations we know it strips. This is what the user must agree to.
const componentFiles = existsSync(COMPONENTS_DIR)
  ? readdirSync(COMPONENTS_DIR)
      .filter((f) => f.endsWith(".tsx"))
      .sort()
  : [];

const rule = "─".repeat(64);
console.log(`\n${rule}`);
console.log(`Re-skin to shadcn preset ${preset}`);
console.log(rule);
console.log(
  `\nThis regenerates ${componentFiles.length} file(s) under packages/ui/src/components:`,
);
console.log(`  ${componentFiles.join(", ")}`);
console.log("\nKnown customizations a full apply removes (you will re-add them by hand):");
console.log("  • `touch` / `icon-touch` (44px) size variants on Button → check-types FAILS");
console.log("  • `overscroll-contain` on Dialog/Sheet/Drawer content → silent, passes type-check");
console.log("  • `data-[size=touch]:h-11` touch sizing on Select → silent");
console.log("  • components.json `style` in BOTH apps/web and packages/ui is flipped");
console.log("  • an orphan apps/web/src/lib/utils.ts is created (this script deletes it)");
console.log(
  "\nColors and fonts are NOT the reason to run this — `pnpm theme:apply` does those safely.",
);

if (!confirm) {
  console.log(`\n${rule}`);
  console.log("DRY RUN — nothing was changed.");
  console.log(
    "If you are an agent: STOP here and show the user the list above. Re-run with\n" +
      "`--confirm` only after they have agreed to a re-skin (not a theme change).",
  );
  process.exit(2);
}

// -- 3. Apply everything. This is the one sanctioned bare `--preset` apply.
console.log(
  `\n▶ Applying shadcn preset ${preset} (FULL apply: style + components + font + colors)…`,
);
try {
  execFileSync(
    "pnpm",
    ["dlx", `shadcn@${shadcnVersion}`, "apply", "--preset", preset, "-c", "apps/web", "-y"],
    { cwd: ROOT, stdio: "inherit" },
  );
} catch {
  console.error(
    "\n✗ shadcn apply failed. Recover with:\n" +
      "  git restore -- packages/ui apps/web/components.json pnpm-lock.yaml && pnpm install --frozen-lockfile",
  );
  process.exit(1);
}

// The CLI writes apps/web/src/lib/utils.ts on every full apply. Delete it only
// when the apply created it: the tree was clean before, so a tracked file at
// that path is the app's own and must survive.
if (existsSync(ORPHAN_UTILS)) {
  let tracked = false;
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", ORPHAN_UTILS], {
      cwd: ROOT,
      stdio: "ignore",
    });
    tracked = true;
  } catch {
    tracked = false;
  }
  if (tracked) {
    console.log(
      "! apps/web/src/lib/utils.ts is tracked, so it is yours — left in place. Check `git diff -- apps/web/src/lib/utils.ts`; the CLI may have overwritten it.",
    );
  } else {
    rmSync(ORPHAN_UTILS);
    console.log(
      "✓ Removed orphan apps/web/src/lib/utils.ts (this repo aliases @knowledge-base/ui/lib/utils).",
    );
  }
}

console.log("▶ Syncing dependencies…");
let installGreen = true;
try {
  execSync("pnpm install", { cwd: ROOT, stdio: "inherit" });
} catch {
  installGreen = false;
  console.error(
    "\n✗ pnpm install failed (usually a dependency the preset added). The apply itself is done.\n" +
      "  Either fix the lockfile and re-run `pnpm install`, or undo everything with:\n" +
      "  git restore -- packages/ui apps/web/components.json pnpm-lock.yaml && pnpm install --frozen-lockfile",
  );
}

// -- 4. Gate + the silent-rule checklist. A green gate is not enough.
console.log("▶ Type-checking…");
let typesGreen = true;
try {
  execSync("pnpm check-types", { cwd: ROOT, stdio: "inherit" });
} catch {
  typesGreen = false;
}

type Check = { label: string; file: string; pattern: RegExp };
const checks: Check[] = [
  { label: "`touch` size variant on Button", file: "button.tsx", pattern: /\btouch:/ },
  { label: "`icon-touch` size variant on Button", file: "button.tsx", pattern: /"icon-touch":/ },
  { label: "`overscroll-contain` on Dialog", file: "dialog.tsx", pattern: /overscroll-contain/ },
  { label: "`overscroll-contain` on Sheet", file: "sheet.tsx", pattern: /overscroll-contain/ },
  { label: "`overscroll-contain` on Drawer", file: "drawer.tsx", pattern: /overscroll-contain/ },
  { label: "touch sizing on Select", file: "select.tsx", pattern: /data-\[size=touch\]:h-11/ },
];
const missing: string[] = [];
for (const check of checks) {
  const path = resolve(COMPONENTS_DIR, check.file);
  if (!existsSync(path)) continue;
  if (!check.pattern.test(readFileSync(path, "utf-8"))) missing.push(check.label);
}

console.log(`\n${rule}`);
console.log(
  typesGreen ? "✓ check-types passed." : "✗ check-types FAILED (expected after a re-skin).",
);
if (missing.length > 0) {
  console.log("\nCustomizations the apply removed — restore each one:");
  for (const m of missing) console.log(`  ✗ ${m}`);
} else {
  console.log(`✓ The ${checks.length} customizations this script can grep for are present.`);
}
console.log(
  "This checklist is a subset. Typography scale and app-specific edits\n" +
    "are not detectable here — walk the full list in the pattern doc's step 4.",
);
console.log("\nNext: run the verify-fix loop:");
console.log("  git diff HEAD -- packages/ui/src/components   # `-` lines are what to restore");
console.log("  pnpm check-types && pnpm --filter web build && pnpm lint");

process.exit(installGreen && typesGreen && missing.length === 0 ? 0 : 1);
