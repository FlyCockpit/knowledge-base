/**
 * Word-budget gate for the always-loaded agent instruction file.
 *
 *   pnpm policy:agents-size
 *
 * AGENTS.md is self-contained (no patterns/). Keep it under the word budget.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

const ROOT = resolve(import.meta.dirname!, "..");
const BUDGET = 4500;

const file = resolve(ROOT, "AGENTS.md");
const text = readFileSync(file, "utf8");
const words = text.split(/\s+/).filter(Boolean).length;

console.log(`AGENTS.md: ${words} words (budget ${BUDGET})`);

if (words > BUDGET) {
  console.error(
    `POLICY VIOLATION: AGENTS.md is ${words} words (budget ${BUDGET}). Trim AGENTS.md; it is self-contained and must stay under the budget.`,
  );
  process.exit(1);
}

process.exit(0);
