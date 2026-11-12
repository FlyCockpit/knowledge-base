import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Request and publication paths read Git only through the async, cancellable
 * readers (they run under locks with a deadline). Synchronous Git helpers are
 * allowed only in the modules that own them or run outside a request (startup
 * recovery, the pre-receive hook child), and at the call sites listed below,
 * each with its reason. A new synchronous call anywhere else fails here.
 */
const ROOT = resolve(import.meta.dirname, "../../../../..");
const SCANNED = ["packages/api/src", "apps/server/src", "apps/worker/src"];
const SYNC_HELPERS = [
  "runGit",
  "runGitBuffer",
  "readRefSha",
  "readHeadSha",
  "readCommitTreeSha",
  "walkGitTreeEntries",
  "listTreeChildren",
  "readBlobContent",
  "readObjectSizeBytes",
  "readObjectsSync",
  "listTreeBlobsSync",
  "loadTreeSnapshotSync",
  "validateGitCommit",
  "validateNewlyReachableCommits",
  "manifestAtCommit",
  "manifestBytesAtCommit",
  "writeStagedObjects",
  "validateProposedCommitTree",
  "fsyncPublishedRef",
  "readCommitBlobs",
];
const CALL = new RegExp(`(^|[^A-Za-z0-9_.$])(${SYNC_HELPERS.join("|")})\\(`);

/** Modules that define the synchronous helpers or never run on a request. */
const OWNERS = new Set([
  "packages/api/src/lib/kb/git-read.ts",
  "packages/api/src/lib/kb/git-write.ts",
  "packages/api/src/lib/kb/validate-tree.ts",
  // Pre-receive validation runs in the hook child, killed with the push scope.
  "packages/api/src/lib/kb/push-validation.ts",
  "apps/server/src/git-pre-receive.ts",
  // Startup recovery runs before the server admits requests.
  "packages/api/src/lib/kb/recovery.ts",
]);

/** Justified synchronous call sites elsewhere: file → trimmed lines. */
const ALLOWED: Record<string, string[]> = {
  "packages/api/src/lib/kb/asset-authz.ts": [
    // The synchronous manifest read exists for the pre-receive hook child.
    'const sha = manifestBlobSha(runGit(repoPath, ["ls-tree", "-z", rev, "--", MANIFEST]));',
    "return readBlobContent(repoPath, sha, { maxBytes: KB_TREE_LIMITS.maxMarkdownBytes });",
    "const parsed = parseAssetManifest(manifestBytesAtCommit(repoPath, rev));",
  ],
  "packages/api/src/lib/kb/operation-intent.ts": [
    // Reconciliation without read options: startup recovery and the
    // post-publication confirmation, which must finish after the ref moved.
    ": readHeadSha(kbBareRepoPath(reposDir, kbId));",
    "? readHeadSha(repoPath)",
    ": readRefSha(repoPath, refName);",
    "else fsyncPublishedRef({ reposDir, kbId }, refName);",
    // The journal test publication (test harness operation only).
    "baseBlobs: intent.oldRef ? readCommitBlobs(repoPath, intent.oldRef) : undefined,",
    "const validation = validateProposedCommitTree(repoPath, intent.newRef!, treeOptions);",
    "const head = readHeadSha(kbBareRepoPath(input.reposDir, input.kbId));",
  ],
  "apps/server/src/push-context.ts": [
    // Post-publication confirmation: one rev-parse that must complete after the ref moved.
    'if (intent?.phase !== "FINALIZED" || readRefSha(repo, command.refName) !== command.newSha)',
  ],
};

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== "node_modules" && name !== "fixtures" && name !== "dist")
        out.push(...sources(path));
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts"))
      out.push(path);
  }
  return out;
}

describe("synchronous Git stays off request and publication paths", () => {
  it("has no synchronous Git call outside the owners and the justified sites", () => {
    const offenders: string[] = [];
    const used = new Set<string>();
    for (const root of SCANNED)
      for (const file of sources(join(ROOT, root))) {
        const rel = relative(ROOT, file);
        if (OWNERS.has(rel)) continue;
        const lines = readFileSync(file, "utf8").split("\n");
        for (const [index, line] of lines.entries()) {
          const trimmed = line.trim();
          if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
          if (!CALL.test(line) || /\bfunction\s/.test(line)) continue;
          if (ALLOWED[rel]?.includes(trimmed)) {
            used.add(`${rel}\0${trimmed}`);
            continue;
          }
          offenders.push(`${rel}:${index + 1}: ${trimmed}`);
        }
      }
    expect(offenders).toEqual([]);
    // Every allowance is still needed (a stale one would hide a new call).
    const stale = Object.entries(ALLOWED).flatMap(([file, entries]) =>
      entries.filter((entry) => !used.has(`${file}\0${entry}`)).map((entry) => `${file}: ${entry}`),
    );
    expect(stale).toEqual([]);
  });
});
