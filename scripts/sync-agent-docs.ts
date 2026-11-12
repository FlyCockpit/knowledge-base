/**
 * Reads AGENTS.md and writes byte-identical mirror copies to each target.
 * Run: `pnpm sync:agent-docs`
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname!, "..");

// ---------------------------------------------------------------------------
// Config — add new targets here
// ---------------------------------------------------------------------------

export interface Target {
  /** Path relative to the repo root */
  path: string;
  /** Banner prepended before AGENTS.md content */
  banner: string;
}

const HTML_BANNER =
  "<!-- GENERATED FROM AGENTS.md — DO NOT EDIT. Run `pnpm sync:agent-docs` after editing AGENTS.md. -->";

export const TARGETS: Target[] = [
  { path: "CLAUDE.md", banner: HTML_BANNER },
  { path: ".github/copilot-instructions.md", banner: HTML_BANNER },
];

export function syncAgentDocs(
  root: string,
  { log = console.log }: { log?: (message: string) => void } = {},
): { written: string[] } {
  const source = readFileSync(resolve(root, "AGENTS.md"), "utf-8");
  const written: string[] = [];

  for (const target of TARGETS) {
    const abs = resolve(root, target.path);
    mkdirSync(dirname(abs), { recursive: true });
    const content = `${target.banner}\n\n${source}`;
    writeFileSync(abs, content, "utf-8");
    written.push(target.path);
    log(`✓ ${target.path}`);
  }

  return { written };
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
  syncAgentDocs(ROOT);
}
