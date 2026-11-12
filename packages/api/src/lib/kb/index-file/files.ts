/**
 * Index file names and removal (no SQLite): `<gen>.sqlite` finals, `<gen>.a<e>.tmp` attempt
 * temps and their `<gen>.a<e>.tmp-journal`. Shared by the build reset and retention.
 */
import { open, opendir, unlink } from "node:fs/promises";
import { join } from "node:path";

const GENERATION = "[a-z0-9]{24,32}";
const FINAL = new RegExp(`^(${GENERATION})\\.sqlite$`);
const TEMP = new RegExp(`^(${GENERATION})\\.a([1-9]\\d{0,9})\\.tmp(-journal)?$`);
/** Side files SQLite would create next to a final; a published file never has one. */
const SIDE = new RegExp(`^(${GENERATION})\\.sqlite-(journal|wal|shm)$`);

export type IndexFileName =
  | { kind: "final"; generationId: string }
  | { kind: "temp"; generationId: string; attempt: number; journal: boolean }
  | { kind: "side"; generationId: string }
  | { kind: "unknown" };

export function parseIndexFileName(name: string): IndexFileName {
  const final = FINAL.exec(name);
  if (final) return { kind: "final", generationId: final[1]! };
  const temp = TEMP.exec(name);
  if (temp)
    return {
      kind: "temp",
      generationId: temp[1]!,
      attempt: Number(temp[2]),
      journal: temp[3] !== undefined,
    };
  const side = SIDE.exec(name);
  if (side) return { kind: "side", generationId: side[1]! };
  return { kind: "unknown" };
}

/** ENOENT is success: every remover tolerates a concurrent one. */
export async function unlinkIndexFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function fsyncDirectory(dir: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(dir, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Every byte of one generation in `kbDir`: its final and every attempt's temp and `-journal`
 * (never its integrity-relevant `.sqlite-*` side files, which are only logged). Returns the
 * number of names removed; the directory itself is never removed.
 */
export async function removeGenerationFiles(kbDir: string, generationId: string): Promise<number> {
  let dir: Awaited<ReturnType<typeof opendir>>;
  try {
    dir = await opendir(kbDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  const names: string[] = [];
  for await (const entry of dir) {
    const parsed = parseIndexFileName(entry.name);
    if ((parsed.kind === "final" || parsed.kind === "temp") && parsed.generationId === generationId)
      names.push(entry.name);
  }
  for (const name of names) await unlinkIndexFile(join(kbDir, name));
  if (names.length > 0) await fsyncDirectory(kbDir);
  return names.length;
}

/**
 * The reset of attempt `attempt` reclaims only the temps (and `-journal`s) of earlier attempts of
 * its generation: every name it may remove carries a smaller attempt number, so a superseded
 * attempt whose reset runs late can never remove a successor's bytes. Finals are never removed
 * here; publish replaces a stale final inside its fenced transaction.
 */
export async function removeEarlierAttemptTemps(
  kbDir: string,
  generationId: string,
  attempt: number,
): Promise<number> {
  let dir: Awaited<ReturnType<typeof opendir>>;
  try {
    dir = await opendir(kbDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  const names: string[] = [];
  for await (const entry of dir) {
    const parsed = parseIndexFileName(entry.name);
    if (parsed.kind === "temp" && parsed.generationId === generationId && parsed.attempt < attempt)
      names.push(entry.name);
  }
  for (const name of names) await unlinkIndexFile(join(kbDir, name));
  if (names.length > 0) await fsyncDirectory(kbDir);
  return names.length;
}
