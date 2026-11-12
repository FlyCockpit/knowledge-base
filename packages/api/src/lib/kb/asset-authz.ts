import type { PrismaClient } from "@knowledge-base/db/client";
import { authorizeDocumentRead, isCommitReachable } from "./documents-read";
import { KbDomainError } from "./errors";
import {
  assertGitReadActive,
  type GitReadOptions,
  gitReadOptions,
  kbBareRepoPath,
  readBlobContent,
  readBlobContentAsync,
  runGit,
  runGitAsync,
} from "./git-read";
import { KB_TREE_LIMITS } from "./limits";
import type { LockQuery } from "./lock";
import { type AssetManifestEntry, parseAssetManifest, validateManifestDocument } from "./manifest";
import type { AuthorizeInput } from "./permissions";
import type { TreeValidationOptions } from "./validate-tree";

/** Query only this bounded manifest inventory, never the global catalog. */
export async function assetValidationContext(query: LockQuery, kbId: string, hashes: string[]) {
  const rows =
    hashes.length === 0
      ? []
      : (
          await query<AssetManifestEntry>(
            `SELECT b.hash, b.size, b.mime FROM "asset_blob" b
       JOIN "kb_asset_lineage" l ON l.hash = b.hash
      WHERE l."kbId" = $1 AND b.hash = ANY($2::text[])`,
            [kbId, hashes],
          )
        ).rows;
  return {
    trustedBlobs: new Map(
      rows.map((row) => [row.hash, { size: Number(row.size), mime: row.mime }]),
    ),
    lineageHashes: new Set(rows.map((row) => row.hash)),
  } satisfies Omit<TreeValidationOptions, "repoPath">;
}

const MANIFEST = ".assets/manifest.json";
/** The manifest's blob id from a path-limited `ls-tree`; it must be a regular file. */
function manifestBlobSha(listing: string): string {
  const match = /^100644 blob ([a-f0-9]{40})\t\.assets\/manifest\.json$/.exec(
    listing.split("\0")[0] ?? "",
  );
  if (!match) throw new KbDomainError("STORAGE_UNAVAILABLE", "Asset manifest unavailable");
  return match[1]!;
}

/** The manifest blob at a commit, read directly by path (never a whole-tree walk). */
export function manifestBytesAtCommit(repoPath: string, rev: string): Buffer {
  if (!/^[a-f0-9]{40}$/.test(rev)) throw new Error("invalid commit sha");
  const sha = manifestBlobSha(runGit(repoPath, ["ls-tree", "-z", rev, "--", MANIFEST]));
  return readBlobContent(repoPath, sha, { maxBytes: KB_TREE_LIMITS.maxMarkdownBytes });
}

export function manifestAtCommit(repoPath: string, rev: string): AssetManifestEntry[] {
  const parsed = parseAssetManifest(manifestBytesAtCommit(repoPath, rev));
  if ("code" in parsed)
    throw new KbDomainError("STORAGE_UNAVAILABLE", "Asset manifest unavailable");
  return parsed.entries;
}

/** `manifestBytesAtCommit` for request and publication paths: cancellable, deadline-bound. */
async function manifestBytesAtCommitAsync(
  repoPath: string,
  rev: string,
  options: GitReadOptions,
): Promise<Buffer> {
  if (!/^[a-f0-9]{40}$/.test(rev)) throw new Error("invalid commit sha");
  // Read directly by path: one lookup, never a whole-tree walk.
  const { stdout } = await runGitAsync(repoPath, ["ls-tree", "-z", rev, "--", MANIFEST], options);
  const bytes = await readBlobContentAsync(
    repoPath,
    manifestBlobSha(stdout.toString()),
    { maxBytes: KB_TREE_LIMITS.maxMarkdownBytes },
    options,
  );
  assertGitReadActive(options);
  return bytes;
}

export async function manifestAtCommitAsync(
  repoPath: string,
  rev: string,
  options: GitReadOptions,
): Promise<AssetManifestEntry[]> {
  const parsed = parseAssetManifest(await manifestBytesAtCommitAsync(repoPath, rev, options));
  assertGitReadActive(options);
  if ("code" in parsed)
    throw new KbDomainError("STORAGE_UNAVAILABLE", "Asset manifest unavailable");
  return parsed.entries;
}

export async function authorizedAssetsAtRevision(
  input: AuthorizeInput & {
    query: LockQuery;
    reposDir: string;
    rev: string;
  } & GitReadOptions,
): Promise<AssetManifestEntry[]> {
  const options = gitReadOptions(input);
  await authorizeDocumentRead(input);
  const repo = kbBareRepoPath(input.reposDir, input.kbId);
  if (!(await isCommitReachable(repo, input.rev, options)))
    throw new KbDomainError("NOT_FOUND", "Asset not found");
  const manifestBytes = await manifestBytesAtCommitAsync(repo, input.rev, options);
  const parsed = parseAssetManifest(manifestBytes);
  if ("code" in parsed) throw new KbDomainError("NOT_FOUND", "Asset not found");
  const context = await assetValidationContext(
    input.query,
    input.kbId,
    parsed.entries.map((entry) => entry.hash),
  );
  // Publication already validates tree disjointness; reads verify immutable
  // membership plus current retained lineage and exact catalog metadata.
  const issue = validateManifestDocument(manifestBytes, {
    ...context,
    treePaths: new Map(),
  });
  if (issue) throw new KbDomainError("NOT_FOUND", "Asset not found");
  await authorizeDocumentRead(input);
  assertGitReadActive(options);
  return parsed.entries;
}

export async function authorizeAssetImport(
  input: AuthorizeInput & {
    query: LockQuery;
    reposDir: string;
    rev: string;
    hash: string;
  } & GitReadOptions,
): Promise<AssetManifestEntry> {
  const entries = await authorizedAssetsAtRevision({ ...input, operation: "read" });
  const entry = entries.find((entry) => entry.hash === input.hash);
  if (!entry) throw new KbDomainError("NOT_FOUND", "Asset not found");
  return entry;
}

export function prismaAssetQuery(prisma: Pick<PrismaClient, "$queryRawUnsafe">): LockQuery {
  return async <Row>(sql: string, values?: unknown[]) => {
    const rows = await prisma.$queryRawUnsafe<Row[]>(sql, ...(values ?? []));
    return { rows, rowCount: rows.length };
  };
}
