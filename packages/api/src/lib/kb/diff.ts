import { manifestAtCommitAsync } from "./asset-authz";
import {
  type GitReadOptions,
  gitReadCheckpoint,
  gitReadOptions,
  readCommitTreeShaAsync,
  walkGitTreeEntriesAsync,
} from "./git-read";
import { KB_TREE_LIMITS } from "./limits";
import type { AssetManifestEntry } from "./manifest";

type FileDelta = {
  path: string;
  status: "added" | "modified" | "deleted";
  beforeBlobSha: string | null;
  afterBlobSha: string | null;
};
type AssetDelta = {
  path: string;
  before: AssetManifestEntry | null;
  after: AssetManifestEntry | null;
};

/** One ordered stream for both delta kinds; exhaustion means the entire diff was returned. */
export async function diffAtRevisions(
  input: {
    repoPath: string;
    baseSha: string;
    headSha: string;
    limit: number;
    after?: string | null;
  } & GitReadOptions,
) {
  const options = gitReadOptions(input);
  const blobs = async (sha: string) =>
    new Map(
      (
        await walkGitTreeEntriesAsync(
          input.repoPath,
          await readCommitTreeShaAsync(input.repoPath, sha, options),
          {
            entries: 0,
            maxEntries: KB_TREE_LIMITS.maxEntries,
          },
          options,
        )
      )
        .filter((e) => e.type === "blob")
        .map((e) => [e.path, e.sha]),
    );
  const before = await blobs(input.baseSha);
  const after = await blobs(input.headSha);
  const files: FileDelta[] = [];
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(path) ?? null;
    const b = after.get(path) ?? null;
    if (a !== b)
      files.push({
        path,
        status: a === null ? "added" : b === null ? "deleted" : "modified",
        beforeBlobSha: a,
        afterBlobSha: b,
      });
  }
  const oldAssets = new Map(
    (await manifestAtCommitAsync(input.repoPath, input.baseSha, options)).map((a) => [a.path, a]),
  );
  const newAssets = new Map(
    (await manifestAtCommitAsync(input.repoPath, input.headSha, options)).map((a) => [a.path, a]),
  );
  const assets: AssetDelta[] = [];
  for (const path of new Set([...oldAssets.keys(), ...newAssets.keys()])) {
    const a = oldAssets.get(path) ?? null;
    const b = newAssets.get(path) ?? null;
    if (a?.hash !== b?.hash || a?.size !== b?.size || a?.mime !== b?.mime)
      assets.push({ path, before: a, after: b });
  }
  const entries = [
    ...files.map((file) => ({ key: `f:${file.path}`, file, asset: null })),
    ...assets.map((asset) => ({ key: `a:${asset.path}`, file: null, asset })),
  ].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  await gitReadCheckpoint(options);
  const limit = Math.max(1, Math.min(input.limit, 200));
  const page = entries.filter((e) => !input.after || e.key > input.after).slice(0, limit + 1);
  const selected = page.slice(0, limit);
  return {
    files: selected.flatMap((e) => (e.file ? [e.file] : [])),
    touchedAssets: selected.flatMap((e) => (e.asset ? [e.asset] : [])),
    nextAfter: page.length > limit ? selected.at(-1)!.key : null,
  };
}
