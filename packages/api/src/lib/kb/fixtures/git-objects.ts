import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { hardenedGitEnv } from "../git-read";
import { type StagedCommit, stageCommitWithTreeFiles } from "../staged-tree";

/** Write a real loose blob, optionally choosing its fanout via a nonce suffix. */
export function writeGitFixtureLooseBlob(repo: string, body: Buffer, fan?: string) {
  if (fan && !/^[0-9a-f]{2}$/.test(fan)) throw new Error("Invalid fixture fanout");
  const nonce = Buffer.alloc(fan ? 8 : 0);
  const header = Buffer.from(`blob ${body.length + nonce.length}\0`);
  const base = createHash("sha1").update(header).update(body);
  let objectSha: string;
  for (let serial = 0; ; serial++) {
    if (fan) nonce.writeBigUInt64BE(BigInt(serial));
    objectSha = base.copy().update(nonce).digest("hex");
    if (!fan || objectSha.startsWith(fan)) break;
  }
  const dir = join(repo, "objects", objectSha.slice(0, 2));
  mkdirSync(dir, { recursive: true });
  const payload = Buffer.concat([body, nonce]);
  writeFileSync(join(dir, objectSha.slice(2)), deflateSync(Buffer.concat([header, payload])));
  return { objectSha, body: payload };
}

/** Seed reader/planner inputs in a caller-owned private test repository. */
export function writeGitFixtureCommit(
  repo: string,
  input:
    | Parameters<typeof stageCommitWithTreeFiles>[0]
    | Pick<StagedCommit, "objects" | "commitSha">,
): string {
  const initialParent = "parentSha" in input && input.parentSha === "0".repeat(40);
  const staged = "objects" in input ? input : stageCommitWithTreeFiles(input);
  let commitSha = staged.commitSha;
  for (const object of staged.objects.values()) {
    // The fixture's zero-parent sentinel means an initial commit. A dangling
    // zero parent would make native ancestry reads reject the entire history.
    const initial = object.type === "commit" && initialParent;
    const body = initial
      ? Buffer.from(object.body.toString("utf8").replace(`\nparent ${"0".repeat(40)}\n`, "\n"))
      : object.body;
    const expectedSha = initial
      ? createHash("sha1").update(`commit ${body.length}\0`).update(body).digest("hex")
      : object.sha;
    const sha = execFileSync("git", ["hash-object", "-w", "--stdin", "-t", object.type], {
      cwd: repo,
      env: hardenedGitEnv(),
      input: body,
      encoding: "utf8",
    }).trim();
    if (sha !== expectedSha) throw new Error("Git fixture object does not match staged SHA");
    if (initial) commitSha = sha;
  }
  return commitSha;
}

/** Seed one valid, indexed, unreachable blob pack without spawning one Git
 * process per object. Git itself verifies/consumes these fixtures in rollup tests. */
export function writeGitFixtureBlobPack(
  repo: string,
  body: Buffer | Buffer[],
): { hash: string; objectSha: string; objectShas: string[] } {
  const bodies = Array.isArray(body) ? body : [body];
  const entries: Buffer[] = [];
  const objects: { sha: Buffer; offset: number; crc: number }[] = [];
  let offset = 12;
  for (const bytes of bodies) {
    const sha = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest();
    const header = [0x30 | (bytes.length & 15)];
    for (let size = bytes.length >>> 4; size > 0; size >>>= 7) {
      header[header.length - 1] = header[header.length - 1]! | 0x80;
      header.push(size & 127);
    }
    const entry = Buffer.concat([Buffer.from(header), deflateSync(bytes)]);
    entries.push(entry);
    objects.push({ sha, offset, crc: crc32(entry) });
    offset += entry.length;
  }
  const header = Buffer.from("5041434b0000000200000000", "hex");
  header.writeUInt32BE(objects.length, 8);
  const data = Buffer.concat([header, ...entries]);
  const packHash = createHash("sha1").update(data).digest();
  objects.sort((a, b) => Buffer.compare(a.sha, b.sha));
  const index = Buffer.alloc(1032 + objects.length * 28 + 20);
  index.writeUInt32BE(0xff744f63, 0);
  index.writeUInt32BE(2, 4);
  let n = 0;
  for (let fan = 0; fan < 256; fan++) {
    while (n < objects.length && objects[n]!.sha[0]! <= fan) n++;
    index.writeUInt32BE(n, 8 + fan * 4);
  }
  for (const [i, object] of objects.entries()) {
    object.sha.copy(index, 1032 + i * 20);
    index.writeUInt32BE(object.crc, 1032 + objects.length * 20 + i * 4);
    index.writeUInt32BE(object.offset, 1032 + objects.length * 24 + i * 4);
  }
  packHash.copy(index, 1032 + objects.length * 28);
  const hash = packHash.toString("hex"),
    dir = join(repo, "objects", "pack");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `pack-${hash}.pack`), Buffer.concat([data, packHash]));
  writeFileSync(
    join(dir, `pack-${hash}.idx`),
    Buffer.concat([index, createHash("sha1").update(index).digest()]),
  );
  const objectShas = objects.map((o) => o.sha.toString("hex"));
  return { hash, objectSha: objectShas[0]!, objectShas };
}
