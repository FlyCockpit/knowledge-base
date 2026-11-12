import { createHash } from "node:crypto";
import { mkdir, open, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";
import { readCommitBlobsAsync, runGitAsync } from "../git-read";
import { initialMainTreeFiles, writeStagedObjectsAsync } from "../git-write";
import { stageCommitWithTreeFiles, type TreeFileInput } from "../staged-tree";

const file = (path: string, body: string): TreeFileInput => ({
  segments: path.split("/"),
  content: Buffer.from(body),
});

/**
 * A KB tree near the entry, file and depth limits whose subtrees are all
 * DISTINCT objects (each directory holds its own content), so no read can be
 * shared between paths: 4,032 directories and 3,879 files (7,912 entries with
 * the root), one chain at the depth limit.
 */
export function nearLimitDistinctFiles(description = "Near-limit fixture"): TreeFileInput[] {
  const docs: TreeFileInput[] = [];
  for (let g = 0; g < 125; g += 1)
    for (let d = 0; d < 31; d += 1) docs.push(file(`g${g}/d${d}/n.md`, `# g${g} d${d}\n`));
  docs.push(file(`${Array.from({ length: 31 }, (_, n) => `c${n}`).join("/")}/deep.md`, "deep\n"));
  return [...initialMainTreeFiles(description), ...docs];
}

/** Seed verified, durable objects without moving refs or fsyncing thousands of loose inodes. */
export async function writeFixtureCommit(
  repo: string,
  parentSha: string,
  files: readonly TreeFileInput[],
  message = "near-limit fixture",
  { loose = false }: { loose?: boolean } = {},
): Promise<string> {
  const staged = stageCommitWithTreeFiles({ parentSha, message, files: [...files] });
  if (loose) {
    // Publication deadline tests retain the loose-object layout they exercise.
    const durable = new Set<string>();
    await readCommitBlobsAsync(repo, parentSha, {}, durable);
    await writeStagedObjectsAsync(repo, staged.objects, [], {}, durable);
    return staged.commitSha;
  }
  // Reader/planner fixtures need the same real objects, independent of their
  // physical layout. One pack gives Git a bounded verification and sync unit.
  const header = Buffer.alloc(12);
  header.write("PACK");
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(staged.objects.size, 8);
  const parts = [header];
  for (const object of staged.objects.values()) {
    const type = { commit: 1, tree: 2, blob: 3 }[object.type];
    let size = object.body.length;
    const entry = [(type << 4) | (size & 15)];
    size = Math.floor(size / 16);
    if (size) entry[0]! |= 128;
    while (size) {
      const byte = size & 127;
      size = Math.floor(size / 128);
      entry.push(byte | (size ? 128 : 0));
    }
    parts.push(Buffer.from(entry), deflateSync(object.body));
  }
  const contents = Buffer.concat(parts);
  const checksum = createHash("sha1").update(contents).digest();
  const hash = checksum.toString("hex");
  const packDir = join(repo, "objects", "pack");
  const packPath = join(packDir, `pack-${hash}.pack`);
  await mkdir(packDir, { recursive: true });
  await writeFile(packPath, Buffer.concat([contents, checksum]));
  const { stdout } = await runGitAsync(repo, ["index-pack", "--strict", packPath]);
  if (stdout.toString().trim() !== hash) throw new Error("Git did not verify the fixture pack");
  // Finish seed durability before action timing, contents before directory entries.
  for (const path of [
    join(packDir, `pack-${hash}.pack`),
    join(packDir, `pack-${hash}.idx`),
    packDir,
    join(repo, "objects"),
    repo,
    dirname(repo),
  ]) {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  return staged.commitSha;
}

/**
 * A KB at the byte, file and entry limits whose every document both sides
 * edit cleanly (main its first line, the proposal its last): 4,093 documents
 * of 16,000 bytes (~62.5 MiB), each in its own directory (8,191 entries).
 */
export function nearLimitByteFiles(side: "base" | "main" | "proposal"): TreeFileInput[] {
  const docs: TreeFileInput[] = [];
  for (let i = 0; i < 4093; i += 1) {
    const lines = Array.from({ length: 200 }, (_, j) =>
      `line ${String(j).padStart(3, "0")} of ${String(i).padStart(4, "0")} `.padEnd(79, "."),
    );
    lines[0] = `# d${i}${side === "main" ? " main" : ""}`.padEnd(79, ".");
    if (side === "proposal") lines[199] = `last line of ${i} by the proposal`.padEnd(79, ".");
    const body = `${lines.join("\n")}\n`;
    docs.push(file(`d${String(i).padStart(4, "0")}/doc.md`, body));
  }
  return [...initialMainTreeFiles("Near-limit bytes"), ...docs];
}
