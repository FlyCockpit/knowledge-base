import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  opendir,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  assertGitReadActive,
  type GitReadOptions,
  gitReadCheckpoint,
  runGitAsync,
} from "./git-read";

// Mirror kb-local git_write::plan_rollup (fix/r4-minors). No reachability GC:
// aborted objects, historical assets and unpublished commits are all retained.
export const GIT_ROLLUP = {
  packs: 8,
  looseSample: 27,
  maxBytes: 32 << 20,
  frozenBytes: 16 << 20,
  // Larger loose files remain in place, like frozen packs. Both measurement
  // and selection exclude them: maintenance must never be due for kept data.
  maxLooseBytes: 16 << 20,
  maxLoose: 20_000,
  maxObjects: 200_000,
  frozenObjects: 100_000,
  maxPackEntries: 4096,
  budgetMs: 2000,
} as const;
type Pack = { hash: string; bytes: number; objects?: number };
// A count-dense pack freezes at half the object cap just like a byte-dense
// pack. The larger normalized resource determines the geometric progression.
const weight = (p: Pack) =>
  Math.max(p.bytes, ((p.objects ?? 0) * GIT_ROLLUP.maxBytes) / GIT_ROLLUP.maxObjects);
type Loose = { hash: string; bytes: number };
export type RollupPressure = { packs: Pack[]; looseSample: number; level: number; due: boolean };
const SHA = /^[0-9a-f]{40}$/;
const FAN = /^[0-9a-f]{38}$/;

/** Factor-two geometric split, including the pack above a broken progression. */
export function planGitRollup(
  packs: readonly Pack[],
  looseBytes: number,
  maxBytes: number,
  looseObjects = 0,
): number {
  const small = packs.filter(
    (p) => p.bytes < GIT_ROLLUP.frozenBytes && (p.objects ?? 0) < GIT_ROLLUP.frozenObjects,
  );
  let split = Math.max(0, small.length - 1);
  while (split > 0 && weight(small[split]!) >= weight(small[split - 1]!) * 2) split--;
  let total = looseBytes + small.slice(0, split).reduce((n, p) => n + weight(p), 0);
  while (split < small.length && weight(small[split]!) < total * 2)
    total += weight(small[split++]!);
  let bytes = looseBytes,
    objects = looseObjects,
    roll = 0;
  while (
    roll < split &&
    bytes + small[roll]!.bytes <= maxBytes &&
    objects + (small[roll]!.objects ?? 0) <= GIT_ROLLUP.maxObjects
  ) {
    bytes += small[roll]!.bytes;
    objects += small[roll++]!.objects ?? 0;
  }
  return roll;
}

async function regular(path: string, directory = false) {
  const st = await lstat(path);
  if (directory ? !st.isDirectory() : !st.isFile()) throw new Error("Unexpected rollup file type");
  return st;
}
async function sync(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}
async function readRegular(path: string, max: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await file.stat();
    if (!st.isFile() || st.size > max) throw new Error("Rollup file exceeds bound");
    return await file.readFile();
  } finally {
    await file.close();
  }
}
async function looseIn(
  objects: string,
  fan: string,
  max: number,
  budget: number,
  options: GitReadOptions,
): Promise<Loose[]> {
  const dir = join(objects, fan);
  try {
    await regular(dir, true);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const found: Loose[] = [];
  let bytes = 0,
    visited = 0;
  const entries = await opendir(dir);
  for await (const entry of entries) {
    // Check skipped names and files too; a directory full of retained objects
    // must remain cancellable. Scan exhaustion keeps the work already found.
    if (visited++ >= GIT_ROLLUP.maxObjects) break;
    if (visited % 128 === 1) await gitReadCheckpoint(options);
    if (found.length >= max) break;
    if (!FAN.test(entry.name)) continue;
    const st = await regular(join(dir, entry.name));
    if (st.size > GIT_ROLLUP.maxLooseBytes || bytes + st.size > budget) continue;
    bytes += st.size;
    found.push({ hash: fan + entry.name, bytes: st.size });
  }
  return found;
}
export async function measureGitRollup(
  repo: string,
  options: GitReadOptions,
): Promise<RollupPressure> {
  await regular(repo, true);
  const objects = join(repo, "objects"),
    packDir = join(objects, "pack");
  await regular(objects, true);
  await regular(packDir, true);
  const packs: Pack[] = [];
  let visited = 0;
  for await (const entry of await opendir(packDir)) {
    if (++visited > GIT_ROLLUP.maxPackEntries) break;
    await gitReadCheckpoint(options);
    const match = /^pack-([0-9a-f]{40})\.idx$/.exec(entry.name);
    if (!match) continue;
    await regular(join(packDir, entry.name));
    const st = await regular(join(packDir, `pack-${match[1]}.pack`));
    // Keep-marked receive packs are owned by their writer, never maintenance.
    let keep = false;
    try {
      await lstat(join(packDir, `pack-${match[1]}.keep`));
      keep = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (!keep && st.size < GIT_ROLLUP.frozenBytes) {
      const file = await open(join(packDir, entry.name), constants.O_RDONLY | constants.O_NOFOLLOW);
      let objects: number;
      try {
        const header = Buffer.alloc(1032);
        const { bytesRead } = await file.read(header, 0, header.length, 0);
        if (
          bytesRead !== header.length ||
          header.readUInt32BE(0) !== 0xff744f63 ||
          header.readUInt32BE(4) !== 2
        )
          throw new Error("Invalid rollup index");
        objects = header.readUInt32BE(1028);
      } finally {
        await file.close();
      }
      if (objects < GIT_ROLLUP.frozenObjects)
        packs.push({ hash: match[1]!, bytes: st.size, objects });
    }
  }
  packs.sort((a, b) => weight(a) - weight(b) || a.hash.localeCompare(b.hash));
  const looseSample = (
    await looseIn(objects, "17", GIT_ROLLUP.maxLoose, Number.MAX_SAFE_INTEGER, options)
  ).length;
  return {
    packs,
    looseSample,
    level: packs.length + looseSample,
    due:
      looseSample >= GIT_ROLLUP.looseSample ||
      (packs.length >= GIT_ROLLUP.packs && planGitRollup(packs, 0, GIT_ROLLUP.maxBytes) >= 2),
  };
}

/** Read bounded v2 SHA-1 indexes and validate their own checksum and sorted IDs. */
async function indexNames(path: string): Promise<string[]> {
  const bytes = await readRegular(path, 1032 + GIT_ROLLUP.maxObjects * 36 + 40);
  const count = bytes.length >= 1032 ? bytes.readUInt32BE(1028) : 0;
  if (
    bytes.length < 1072 ||
    bytes.readUInt32BE(0) !== 0xff744f63 ||
    bytes.readUInt32BE(4) !== 2 ||
    count > GIT_ROLLUP.maxObjects ||
    bytes.length < 1032 + count * 28 + 40 ||
    !createHash("sha1").update(bytes.subarray(0, -20)).digest().equals(bytes.subarray(-20))
  )
    throw new Error("Invalid rollup index");
  const names = Array.from({ length: count }, (_, i) =>
    bytes.subarray(1032 + i * 20, 1052 + i * 20).toString("hex"),
  );
  if (names.some((n, i) => i > 0 && n <= names[i - 1]!)) throw new Error("Unsorted rollup index");
  return names;
}
type Intent = { hash: string; packs: string[]; loose: string[]; names: string[] };
function parseIntent(bytes: Buffer): Intent {
  const value: Intent = JSON.parse(bytes.toString("utf8"));
  if (
    !SHA.test(value.hash) ||
    ![value.packs, value.loose, value.names].every(
      (a) =>
        Array.isArray(a) &&
        a.length <= GIT_ROLLUP.maxObjects &&
        a.every((n) => typeof n === "string" && SHA.test(n)),
    )
  )
    throw new Error("Invalid rollup intent");
  return value;
}
async function installFile(source: string, target: string) {
  try {
    await link(source, target);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const a = await readRegular(source, GIT_ROLLUP.maxBytes * 2),
      b = await readRegular(target, GIT_ROLLUP.maxBytes * 2);
    if (!a.equals(b)) throw new Error("Rollup installation disagrees");
  }
  await sync(target);
}
async function remove(path: string, options: GitReadOptions) {
  try {
    await regular(path);
    assertGitReadActive(options);
    await unlink(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

/** Must run under the existing per-KB operation lease. Children only read the
 * canonical store; pack output and index writes are confined to disposable
 * scratch. Canonical installation/retirement happens in-process while held.
 * Intent survives a crash, including index-first retirement of an old pack. */
async function finishRollup(
  repo: string,
  scratch: string,
  intent: Intent,
  options: GitReadOptions,
) {
  const packDir = join(repo, "objects", "pack");
  await runGitAsync(
    repo,
    ["index-pack", "--verify", "--strict", join(scratch, "roll.pack")],
    options,
  );
  const kept = new Set(await indexNames(join(scratch, "roll.idx")));
  if (intent.names.some((n) => !kept.has(n))) throw new Error("Rollup lost an object");
  // pack-objects supplies this hash; index-pack verifies data against its trailer.
  const data = await readRegular(join(scratch, "roll.pack"), GIT_ROLLUP.maxBytes * 2);
  if (data.subarray(-20).toString("hex") !== intent.hash)
    throw new Error("Rollup pack hash disagrees");
  await installFile(join(scratch, "roll.pack"), join(packDir, `pack-${intent.hash}.pack`));
  await sync(packDir); // Durable data before the index makes it discoverable.
  await installFile(join(scratch, "roll.idx"), join(packDir, `pack-${intent.hash}.idx`));
  await sync(packDir);
  assertGitReadActive(options);
  for (const old of intent.packs) {
    if (old === intent.hash) continue;
    for (const ext of ["idx", "pack", "rev", "bitmap"])
      await remove(join(packDir, `pack-${old}.${ext}`), options);
    await gitReadCheckpoint(options);
  }
  for (const name of intent.loose) {
    if (!kept.has(name)) throw new Error("Rollup lost a loose object");
    await remove(join(repo, "objects", name.slice(0, 2), name.slice(2)), options);
  }
  // Persist retirements before discarding the recovery record.
  await sync(packDir);
  for (const fan of new Set(intent.loose.map((n) => n.slice(0, 2))))
    await sync(join(repo, "objects", fan));
}

async function discardFinished(repo: string, scratch: string) {
  const done = join(repo, "objects", "kb-rollup-done");
  await rename(scratch, done);
  await sync(join(repo, "objects"));
  await drainFinished(done);
}

// Keep the empty done directory as a durable completion receipt until the
// worker settles SQL. Disposal or SQL failure cannot turn success into a fold
// failure, even after every bulky scratch file has been removed.
async function drainFinished(done: string) {
  let entries = 0;
  for await (const entry of await opendir(done)) {
    if (++entries > 16) throw new Error("Rollup scratch exceeds bound");
    await regular(join(done, entry.name));
    await unlink(join(done, entry.name));
  }
  await sync(done);
}
export async function acknowledgeGitRollup(repo: string) {
  try {
    await rmdir(join(repo, "objects", "kb-rollup-done"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  await sync(join(repo, "objects"));
}

export type GitRollupState = "none" | "unprepared" | "prepared" | "installed" | "done";
export async function gitRollupState(repo: string): Promise<GitRollupState> {
  for (const name of ["kb-rollup-done", "kb-rollup"]) {
    const scratch = join(repo, "objects", name);
    try {
      await regular(scratch, true);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw e;
    }
    if (name === "kb-rollup-done") return "done";
    let intent: Intent;
    try {
      intent = parseIntent(await readRegular(join(scratch, "intent.json"), 12 << 20));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return "unprepared";
      throw e;
    }
    try {
      await regular(join(repo, "objects", "pack", `pack-${intent.hash}.idx`));
      return "installed";
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    return "prepared";
  }
  return "none";
}

export async function recoverGitRollup(repo: string, options: GitReadOptions): Promise<boolean> {
  const scratch = join(repo, "objects", "kb-rollup");
  const done = join(repo, "objects", "kb-rollup-done");
  let completed = false;
  try {
    await regular(done, true);
    await drainFinished(done);
    completed = true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  try {
    await regular(scratch, true);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return completed;
    throw e;
  }
  let intent: Intent;
  try {
    intent = parseIntent(await readRegular(join(scratch, "intent.json"), 12 << 20));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    await rm(scratch, { recursive: true });
    return false;
  }
  await finishRollup(repo, scratch, intent, options);
  await discardFinished(repo, scratch);
  return true;
}

export async function rollupGitObjects(
  repo: string,
  pressure: RollupPressure,
  options: GitReadOptions,
  maxBytes: number = GIT_ROLLUP.maxBytes,
): Promise<boolean> {
  const objects = join(repo, "objects"),
    scratch = join(objects, "kb-rollup"),
    packDir = join(objects, "pack");
  const loose: Loose[] = [];
  let bytes = 0;
  // Enumerate existing fanouts once; 256 sequential ENOENT probes alone can
  // spend a Node worker's whole budget on a small, fully packed repository.
  const fans: string[] = [];
  let entries = 0;
  for await (const entry of await opendir(objects)) {
    if (++entries > GIT_ROLLUP.maxPackEntries) throw new Error("Object directory exceeds bound");
    if (entries % 128 === 1) await gitReadCheckpoint(options);
    if (/^[0-9a-f]{2}$/.test(entry.name)) fans.push(entry.name);
  }
  for (const fan of fans.sort()) {
    if (loose.length >= GIT_ROLLUP.maxLoose) break;
    const more = await looseIn(
      objects,
      fan,
      GIT_ROLLUP.maxLoose - loose.length,
      maxBytes / 2 - bytes,
      options,
    );
    loose.push(...more);
    bytes += more.reduce((n, p) => n + p.bytes, 0);
    await gitReadCheckpoint(options);
  }
  const packs = pressure.packs.slice(
    0,
    planGitRollup(pressure.packs, bytes, maxBytes, loose.length),
  );
  if (packs.length < 2 && loose.length === 0) return false;
  const names = new Set(loose.map((p) => p.hash));
  for (const pack of packs) {
    for (const name of await indexNames(join(packDir, `pack-${pack.hash}.idx`))) names.add(name);
    if (names.size > GIT_ROLLUP.maxObjects) throw new Error("Rollup object count exceeds bound");
    await gitReadCheckpoint(options);
  }
  await mkdir(scratch, { mode: 0o700 });
  let prepared = false;
  try {
    // --stdout does not modify the repository or traverse refs. Explicit IDs keep
    // every input, reachable or not. Output overflow kills and joins the child.
    const { stdout } = await runGitAsync(
      repo,
      ["pack-objects", "--stdout", "--delta-base-offset", "--threads=1", "--window=0"],
      {
        ...options,
        input: `${[...names].join("\n")}\n`,
        encoding: "buffer",
        maxBuffer: GIT_ROLLUP.maxBytes * 2,
      },
    );
    const data = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
    const hash = data.subarray(-20).toString("hex");
    if (!SHA.test(hash)) throw new Error("Invalid pack output");
    await writeFile(join(scratch, "roll.pack"), data, { flag: "wx", mode: 0o600 });
    await runGitAsync(
      repo,
      [
        "index-pack",
        "--strict",
        "--index-version=2",
        "-o",
        join(scratch, "roll.idx"),
        join(scratch, "roll.pack"),
      ],
      options,
    );
    const intent: Intent = {
      hash,
      packs: packs.map((p) => p.hash),
      loose: loose.map((p) => p.hash),
      names: [...names],
    };
    await sync(join(scratch, "roll.pack"));
    await sync(join(scratch, "roll.idx"));
    await writeFile(join(scratch, "intent.tmp"), JSON.stringify(intent), {
      flag: "wx",
      mode: 0o600,
    });
    await sync(join(scratch, "intent.tmp"));
    await rename(join(scratch, "intent.tmp"), join(scratch, "intent.json"));
    await sync(scratch);
    await sync(objects);
    prepared = true;
    await finishRollup(repo, scratch, intent, options);
    await discardFinished(repo, scratch);
    return true;
  } finally {
    // Once prepared, only successful verified retirement may discard intent.
    if (!prepared) await rm(scratch, { recursive: true, force: true });
  }
}
