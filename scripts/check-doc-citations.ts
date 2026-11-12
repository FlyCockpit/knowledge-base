/**
 * Guards `<doc>.md § <section>` citations — in shipped code and in retained
 * product docs — against the actual section anchors in those files, and every
 * relative doc-to-doc markdown link against the files on disk.
 *
 *   pnpm docs:check-citations   — verify without writing (CI gate; non-zero exit on drift)
 *
 * Why this exists: code comments across `apps/`, `packages/`, and `scripts/`
 * point readers at a specific section of a retained product doc, e.g.
 *
 *     // see AGENTS.md § SSR-safe public chrome with optional client leaves.
 *
 * When a doc is restructured — a heading renamed, a section merged away — those
 * citations silently rot: the file still exists, so nothing errors, but the
 * "§ <section>" now names a heading that is gone. (This is exactly the drift
 * that motivated adding this check: the route-tree docs were reorganized and a
 * comment kept citing a section title that no longer existed.) This script makes
 * a stale citation a fast, CI-visible error.
 *
 * What counts as a valid citation target (a doc "anchor"):
 *   1. A Markdown heading — any `#`..`######` line.
 *   2. A bold lead-in label — a line that starts (optionally after a list
 *      marker) with `**Label.**` / `**Label:**`. Several docs use these as
 *      pseudo-subsections (e.g. `**CSP.**` in removable/consent.md), and code
 *      legitimately cites them, so they are accepted as anchors too.
 *
 * Matching is deliberately lenient about trailing text: a citation captures the
 * rest of the source line after `§`, which can run into continuing prose
 * (`… § The CI gate has the full …`). A citation passes if some anchor equals
 * the captured text or is a whole-word prefix of it — so "The CI gate has the
 * full" still resolves to the "The CI gate" heading. Both sides are normalized
 * (lowercased, backticks/asterisks removed, trailing punctuation stripped,
 * whitespace collapsed) before comparison.
 *
 * Scope: citations are read from shipped code (`apps/`, `packages/`, `scripts/`)
 * AND from retained product docs (ROOT_DOCS). Docs cite each other, and a
 * restructured file rots those references identically — so scanning only code
 * would miss drift this check exists to catch. Doc-to-doc citations are usually
 * markdown links, `[AGENTS.md § Sec](…)`, which is why the citation regex stops
 * at `]` and why a cited path is resolved relative to the citing file before
 * falling back to the repo root.
 *
 * A citation whose doc is missing is judged by its DIRECTORY:
 *
 *   - Directory gone too → warning. Leftover comments that still name a deleted
 *     library (the former `patterns/` tree) must not turn CI red; the checker
 *     does not require that directory to exist.
 *   - Directory still there, file missing → error. That is a typo or a rename
 *     of a retained doc. Warning on both was a real coverage hole: it meant a
 *     misspelled filename (`AGENTS.md` → `AGENT.md`) passed CI silently, since
 *     nothing else validates the path.
 *
 * A renamed or deleted *heading* in a retained doc that still exists is always
 * fatal. Relative links between retained docs fail the same way.
 *
 * This file itself is skipped: its docstring quotes example citations and
 * heading names to explain the rules, and scanning it would let an unrelated
 * heading rename fail CI via prose that only documents the checker.
 *
 * Relative doc links (`](./x.md)`, `](../README.md)`, `#anchor` optional)
 * are validated for FILE EXISTENCE in retained product docs (AGENTS.md,
 * README.md, sitemap.md, SECURITY.md; generated AGENTS.md mirrors inherit
 * the result). A plain "see [x](./x.md)" carries no `§`, so nothing else
 * noticed when its target was renamed or deleted. Missing targets are judged
 * by directory exactly as citations are. The `./` / `../` prefix is the whole
 * scope: absolute URLs, bare anchors, and non-`.md` targets are somebody
 * else's problem.
 *
 * NOT covered: link ANCHORS (`#some-heading`) are not resolved — the `§`
 * citation form is how this repo pins a section — and concrete
 * `apps/web/src/routes/$lang/...` file references inside
 * the pattern docs are intentionally NOT verified against disk. The docs
 * legitimately reference files that do not exist yet (step-by-step "create this
 * route" recipes) or that a teardown is about to delete (the removable/* module
 * guides), so file-existence is not a reliable drift signal there.
 *
 * Dependency-free by design (node:fs only) — no new packages, safe to run in the
 * CI `lint` job alongside `pnpm env:check` / `pnpm docker:check-copy`.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname!, "..");

// Where to scan for citations. Shipped code, plus the docs themselves — docs
// cite each other roughly 4x as often as code cites them, and a restructured
// pattern file rots those references exactly the same way.
const CODE_DIRS = ["apps", "packages", "scripts", "docs"];
const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".rs", ".md"]);
// Root-level docs that also carry citations (the walk covers directories only).
const ROOT_DOCS = [
  "AGENTS.md",
  "CLAUDE.md",
  "sitemap.md",
  "README.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  "CHANGELOG.md",
];
// Directories never worth scanning (build output, deps, generated caches).
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".turbo",
  ".next",
  ".expo",
  "target",
  ".git",
]);

// A citation: `<path>.md § <rest of line>`. Any markdown doc counts — code
// cites retained product docs (`AGENTS.md § Dangerous Commands — Never Run These`,
// `AGENTS.md § Dockerfiles — keep server and worker in sync`), and those
// headings rot exactly the same way.
// The section text stops at a newline or a `]`. The `]` bound matters now that
// docs are scanned: they cite each other as markdown links,
// `[patterns/i18n.md § URL routing](./i18n.md#url-routing)`, and without it the
// capture swallows `](./i18n.md#url-routing)` and never matches any heading.
// Start only at a path-token boundary. Retrying inside a long non-citation
// token (for example generated Prisma data) otherwise makes the scan quadratic.
const CITATION_RE = /(?<![\w./-])([\w./-]+\.md)\s*§\s*([^\n\]]+)/g;

// The OTHER, more common spelling: a markdown link whose label carries the `§`
// but not the filename, with the doc named only in the target —
// `[Dangerous commands](./AGENTS.md#dangerous-commands--never-run-these)`.
// `CITATION_RE` requires a literal `.md` before the `§`, so it cannot see these
// at all; that blind spot hid roughly 40% of the citations in this repo,
// including several in AGENTS.md. The path comes from the link target (group 3),
// which is more reliable than the label anyway.
const LINK_CITATION_RE = /\[([^\]\n]*?)§\s*([^\]\n]+)\]\(\s*([^)\s#]+\.md)(?:#[^)\s]*)?\s*\)/g;

// Relative markdown links between docs — `](./x.md)`, `](../removable/x.md)`,
// with or without a `#anchor`. A `§` citation only reaches the file-existence
// check when the author happened to name a section; a plain "see [x](./x.md)"
// link rots invisibly when the target is renamed or removed. This pass closes
// that hole for the docs (see DOC_LINK_FILE). Absolute URLs, anchors-only
// links, and non-`.md` targets are out of scope: the `./`/`../` prefix is what
// makes a link a repo-relative doc reference.
const DOC_LINK_RE = /\]\(\s*(\.{1,2}\/[^)\s#]+\.md)(?:#[^)\s]*)?\s*\)/g;

// Where relative doc links are validated: retained product docs. CLAUDE.md /
// copilot-instructions.md are generated mirrors of AGENTS.md, so checking
// AGENTS.md covers them.
const DOC_LINK_ROOT_DOCS = new Set([
  "AGENTS.md",
  "README.md",
  "sitemap.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  "CHANGELOG.md",
  "apps/cli/AGENTS.md",
  "apps/cli/README.md",
  "apps/cli/SECURITY.md",
  "apps/cli/CONTRIBUTING.md",
  "apps/cli/docs/adding-tokio.md",
  "apps/cli/docs/adding-sqlite.md",
  "docs/product.md",
  "docs/access-matrix.md",
  "docs/hosting.md",
  "docs/mcp.md",
  "docs/git.md",
  "docs/assets.md",
  "docs/embeddings.md",
  "docs/deploy.md",
  "docs/backup-restore.md",
  "docs/cli.md",
  "docs/cockpit-adapter.md",
]);

// This file's own docstring uses `AGENTS.md § …` as the worked example of
// what a citation looks like, and quotes heading names while explaining the
// matching rules. Scanning it would make renaming an unrelated heading fail
// CI via prose that merely documents the checker.
const SELF = resolve(ROOT, "scripts/check-doc-citations.ts");

/**
 * Blank out fenced blocks and inline code spans, preserving every offset (same
 * length, same newlines) so spans computed on the raw source stay valid.
 *
 * Quoted examples inside backticks — `see [AGENTS.md](./AGENTS.md)` — are
 * transcriptions, not links this doc offers the reader, so the link pass must
 * not resolve them (and must not tempt anyone to "fix" a correct quotation).
 */
function maskCode(source: string): string {
  let fenced = false;
  return source
    .split("\n")
    .map((line) => {
      if (/^\s*(?:```|~~~)/.test(line)) {
        fenced = !fenced;
        return " ".repeat(line.length);
      }
      if (fenced) return " ".repeat(line.length);
      return line.replace(/(`+)(.+?)\1/g, (match) => " ".repeat(match.length));
    })
    .join("\n");
}

/** Recursively collect code files under a directory, skipping build/vendor dirs. */
function walk(dir: string, acc: string[]): void {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      // Hidden directories hold tool state, not shipped source (.claude/,
      // .vscode/, .turbo/). Citations there are notes, not code comments.
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      walk(full, acc);
    } else if (entry.isFile()) {
      const dot = entry.name.lastIndexOf(".");
      if (dot !== -1 && CODE_EXTENSIONS.has(entry.name.slice(dot))) acc.push(full);
    }
  }
}

/**
 * Lowercase, strip markdown emphasis/code and quotes, drop trailing
 * punctuation, collapse spaces.
 *
 * Quotes are stripped everywhere, not just at the ends: a citation may wrap the
 * section name in quotes mid-string (`§ "Who email verification gates" for the
 * …`), and an interior quote would otherwise survive and break the whole-word
 * prefix test in `anchorMatches`.
 */
function normalize(text: string): string {
  return (
    text
      .replace(/[`*_"'“”‘’]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      // `|` is in the class because docs cite sections from inside table cells
      // (`… § 1 — Rate Limiting` |`), where the trailing pipe would otherwise
      // survive normalization and defeat the prefix match.
      .replace(/[\s.,;:)\]}"'*/|-]+$/g, "")
      .trim()
      .toLowerCase()
  );
}

/** Collect the set of citable anchors (headings + bold lead-in labels) for a doc. */
function collectAnchors(docPath: string): Set<string> {
  const anchors = new Set<string>();
  const text = readFileSync(docPath, "utf8");
  const headingRe = /^#{1,6}\s+(.+?)\s*$/;
  const boldLabelRe = /^\s*(?:[-*+]|\d+\.)?\s*\*\*([^*]+?)\*\*/;
  for (const rawLine of text.split("\n")) {
    const heading = headingRe.exec(rawLine);
    if (heading) {
      const a = normalize(heading[1] ?? "");
      if (a) anchors.add(a);
      continue;
    }
    const bold = boldLabelRe.exec(rawLine);
    if (bold) {
      const a = normalize(bold[1] ?? "");
      if (a) anchors.add(a);
    }
  }
  return anchors;
}

/**
 * Does `cite` resolve to some anchor? A match is an exact equality or a
 * whole-word prefix in either direction: the citation may over-capture trailing
 * prose (`"The CI gate has the full …"` → heading `"The CI gate"`), or it may
 * name only the leading part of a longer heading (`"Component-level dynamic
 * import"` → heading `"Component-level dynamic import (React.lazy)"`).
 */
function anchorMatches(cite: string, anchors: Set<string>): boolean {
  if (anchors.has(cite)) return true;
  for (const a of anchors) {
    if (cite.startsWith(`${a} `)) return true;
    if (a.startsWith(`${cite} `)) return true;
  }
  return false;
}

export interface DocCitationCheckOptions {
  root: string;
  codeDirs?: string[];
  rootDocs?: string[];
  docLinkRootDocs?: Iterable<string>;
  skipAbsolute?: Iterable<string>;
}

export interface DocCitationCheckResult {
  errors: string[];
  warnings: string[];
  citationCount: number;
  docLinkCount: number;
  filesScanned: number;
}

export function checkDocCitations(options: DocCitationCheckOptions): DocCitationCheckResult {
  const root = options.root;
  const codeDirs = options.codeDirs ?? CODE_DIRS;
  const rootDocs = options.rootDocs ?? ROOT_DOCS;
  const docLinkRootDocs = new Set(options.docLinkRootDocs ?? DOC_LINK_ROOT_DOCS);
  const skipAbsolute = new Set(options.skipAbsolute ?? [SELF]);
  const isLinkFile = (rel: string): boolean =>
    (rel.startsWith("patterns/") && rel.endsWith(".md")) || docLinkRootDocs.has(rel);

  const errors: string[] = [];
  const warnings: string[] = [];
  const anchorCache = new Map<string, Set<string> | null>();
  let citationCount = 0;
  let docLinkCount = 0;

  const codeFiles: string[] = [];
  for (const dir of codeDirs) walk(resolve(root, dir), codeFiles);
  for (const doc of rootDocs) {
    const abs = resolve(root, doc);
    if (existsSync(abs)) codeFiles.push(abs);
  }

  for (const file of codeFiles) {
    if (skipAbsolute.has(file)) continue;
    const source = readFileSync(file, "utf8");
    const where = relative(root, file).replaceAll("\\", "/");

    // Link-form citations first, recording the span each one occupies. A link
    // whose label happens to include the filename
    // (`[patterns/i18n.md § URL routing](./i18n.md#url-routing)`) matches BOTH
    // patterns, so the bare-form pass below skips anything already covered —
    // otherwise it double-counts and reports the same problem twice.
    const found: Array<{ docRel: string; cite: string }> = [];
    const linkSpans: Array<[number, number]> = [];
    for (const match of source.matchAll(LINK_CITATION_RE)) {
      linkSpans.push([match.index, match.index + match[0].length]);
      found.push({ docRel: match[3] ?? "", cite: match[2] ?? "" });
    }
    for (const match of source.matchAll(CITATION_RE)) {
      if (linkSpans.some(([start, end]) => match.index >= start && match.index < end)) continue;
      found.push({ docRel: match[1] ?? "", cite: match[2] ?? "" });
    }

    for (const raw of found) {
      citationCount++;
      const docRel = raw.docRel;
      const cite = normalize(raw.cite);

      if (cite.length === 0) {
        errors.push(`${where}: citation "${docRel} §" has no section text.`);
        continue;
      }

      // A doc citing a sibling writes a path relative to itself
      // (`server-procedures.md` from inside `patterns/`), while code cites
      // repo-relative (`patterns/server-procedures.md`). Try the citing file's own
      // directory first, then the repo root.
      const cacheKey = `${dirname(file)} ${docRel}`;
      let anchors = anchorCache.get(cacheKey);
      if (anchors === undefined) {
        anchors = null;
        for (const candidate of [resolve(dirname(file), docRel), resolve(root, docRel)]) {
          try {
            anchors = collectAnchors(candidate);
            break;
          } catch {
            // try the next candidate
          }
        }
        anchorCache.set(cacheKey, anchors);
      }

      if (anchors === null) {
        // A whole missing directory (the deleted `patterns/` library, or a
        // fixture that never had one) is not a broken retained-doc contract —
        // warn so leftover comments do not fail CI. Directory present but file
        // missing is a rename/typo of a retained doc, and fatal like a renamed
        // heading.
        const dirExists = [
          dirname(resolve(dirname(file), docRel)),
          dirname(resolve(root, docRel)),
        ].some((dir) => existsSync(dir));
        if (dirExists) {
          errors.push(
            `${where}: cited doc "${docRel}" does not exist, though its directory does — ` +
              `renamed or misspelled? (If the doc was deliberately removed, drop the citation.)`,
          );
        } else {
          warnings.push(
            `${where}: cited doc "${docRel}" does not exist on disk (citation skipped).`,
          );
        }
        continue;
      }

      if (!anchorMatches(cite, anchors)) {
        errors.push(
          `${where}: "${docRel} § ${raw.cite.trim()}" — no matching section heading in ${docRel}.`,
        );
      }
    }

    // Relative doc-to-doc links. Same missing-target judgement as a citation:
    // the whole directory gone is a deliberate teardown (warn), a missing file
    // beside a directory that still exists is a rename or a typo (error).
    if (!isLinkFile(where)) continue;
    for (const match of maskCode(source).matchAll(DOC_LINK_RE)) {
      if (linkSpans.some(([start, end]) => match.index >= start && match.index < end)) continue;
      docLinkCount++;
      const target = match[1] ?? "";
      const absolute = resolve(dirname(file), target);
      if (existsSync(absolute)) continue;
      if (existsSync(dirname(absolute))) {
        errors.push(
          `${where}: link target "${target}" does not exist, though its directory does — ` +
            `renamed or misspelled? (If the doc was deliberately removed, drop the link.)`,
        );
      } else {
        warnings.push(`${where}: link target "${target}" does not exist on disk (link skipped).`);
      }
    }
  }

  return {
    errors,
    warnings,
    citationCount,
    docLinkCount,
    filesScanned: codeFiles.length,
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
  const { errors, warnings, citationCount, docLinkCount, filesScanned } = checkDocCitations({
    root: ROOT,
  });

  if (warnings.length > 0) {
    console.warn("Doc citations pointing at missing files (not fatal):\n");
    for (const w of warnings) console.warn(`  ! ${w}`);
    console.warn("");
  }

  if (errors.length > 0) {
    console.error("Doc-citation drift detected:\n");
    for (const e of errors) console.error(`  • ${e}`);
    console.error(
      "\nEither fix the `<file>.md § <section>` citation in the code to name a real\n" +
        "heading, or restore/rename the heading in the cited doc so the two agree. For a link\n" +
        "target, point it at the file's new path, or drop the link if the doc is gone for good.",
    );
    process.exit(1);
  }

  console.log(
    `Doc citations OK — ${citationCount} \`<doc>.md § <section>\` reference(s) ` +
      `across ${filesScanned} code and doc file(s) all resolve to a real section, ` +
      `and ${docLinkCount} relative doc link(s) all resolve to a file on disk` +
      `${warnings.length > 0 ? ` (${warnings.length} skipped: target absent)` : ""}.`,
  );
}
