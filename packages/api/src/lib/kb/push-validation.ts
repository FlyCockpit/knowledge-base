import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, openSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { procChild } from "./cas-fd";
import { runGit } from "./git-read";
import { KB_TREE_LIMITS } from "./limits";
import { normalizeKbPath } from "./paths";
import { KB_MAX_LOGICAL_CHANGES } from "./tree-budget";

export { KB_MAX_LOGICAL_CHANGES };

import { type TreeValidationOptions, validateNewlyReachableCommits } from "./validate-tree";

export const ZERO_SHA = "0".repeat(40);
export type PushCommand = { oldSha: string; newSha: string; refName: string };
const invalid = () => new PushRefusedError("INVALID_REQUEST");

/**
 * Refusals the pusher can act on. They reach Git as `! [remote rejected] <ref>
 * (<reason>)` through the receive-pack report, never as an HTTP 503 (R3-W10).
 * Each names only the pusher's own push; anything else stays a generic failure.
 */
export const PUSH_REFUSALS = {
  MULTIPLE_REFS: "Push one branch at a time; multiple ref updates are refused.",
  INVALID_NAMESPACE: "Only branches under refs/heads/ may be pushed; tags are refused.",
  DELETE_REF: "Branch deletion by push is refused; close the pull request instead.",
  RESERVED_REF:
    "The pr/ namespace is reserved for automatic pull requests; use another branch name.",
  INVALID_REF: "The branch name or update is invalid; use a valid new branch name.",
  INVALID_REQUEST: "The push request or pack is invalid or exceeds the knowledge base's limits.",
  NON_FAST_FORWARD:
    "Non-fast-forward updates are refused: fetch, merge or rebase onto the branch, and push again.",
  UNRELATED_HISTORY: "A new branch must share history with main: branch from main and push again.",
  STALE_REF: "The branch changed on the server during the push: fetch and push again.",
  BRANCH_TAKEN:
    "This branch name is already used in this knowledge base: push to a new branch name.",
  BRANCH_NOT_YOURS: "This branch belongs to someone else: push to a new branch name.",
  BRANCH_CLOSED: "This branch's pull request is closed or merged: push to a new branch name.",
  INVALID_CONTENT:
    "A pushed commit does not pass this knowledge base's checks (Markdown, paths, sizes, assets).",
} as const;
export type PushRefusalCode = keyof typeof PUSH_REFUSALS;
export function isPushRefusalCode(value: unknown): value is PushRefusalCode {
  return typeof value === "string" && Object.hasOwn(PUSH_REFUSALS, value);
}
export class PushRefusedError extends Error {
  override name = "PushRefusedError";
  readonly code = "PUSH_REFUSED";
  readonly detail?: { code: string; path?: string };
  constructor(
    readonly refusal: PushRefusalCode,
    readonly refs: readonly string[] = [],
    detail?: unknown,
  ) {
    const value = detail && typeof detail === "object" ? (detail as Record<string, unknown>) : {};
    const code =
      refusal === "INVALID_CONTENT" &&
      typeof value.code === "string" &&
      /^TREE_[A-Z_]{1,40}$/.test(value.code)
        ? value.code
        : undefined;
    const path =
      code && typeof value.path === "string" && normalizeKbPath(value.path).ok
        ? value.path
        : undefined;
    super(
      PUSH_REFUSALS[refusal] +
        (code ? ` ${code}${path ? ` at ${JSON.stringify(path)}` : ""}.` : ""),
    );
    if (code) this.detail = { code, ...(path ? { path } : {}) };
  }
}

/** Exit 1 is git's "no" (not an ancestor / no merge base); anything else is a failure. */
function gitAnswer(repoPath: string, args: readonly string[]): string | false {
  try {
    return runGit(repoPath, args);
  } catch (error) {
    if ((error as { status?: unknown }).status === 1) return false;
    throw error;
  }
}
export type PushObjectFile = { path: string; bytes: number };
const OBJECT_FILE = /^(?:[0-9a-f]{2}\/[0-9a-f]{38}|pack\/pack-[0-9a-f]{40}\.(?:pack|idx|rev))$/;

// Receive-pack removes this temporary lock after migration; it is not history.
const QUARANTINE_KEEP = /^pack\/pack-[0-9a-f]{40}\.keep$/;

export function parsePushObjectFiles(value: unknown): PushObjectFile[] {
  if (!Array.isArray(value) || value.length > KB_TREE_LIMITS.maxObjects + 8) throw invalid();
  const paths = new Set<string>();
  let bytes = 0;
  return value.map((file) => {
    if (
      !file ||
      typeof file.path !== "string" ||
      !OBJECT_FILE.test(file.path) ||
      paths.has(file.path) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0
    )
      throw invalid();
    paths.add(file.path);
    bytes += file.bytes;
    if (bytes > 150 * 1024 * 1024) throw invalid();
    return { path: file.path, bytes: file.bytes };
  });
}

function objectFileSize(objectsFd: number, path: string): number | null {
  const [dir, name] = path.split("/");
  let dirFd: number | undefined, fileFd: number | undefined;
  try {
    dirFd = openSync(
      procChild(objectsFd, dir!),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    fileFd = openSync(
      procChild(dirFd, name!),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = fstatSync(fileFd);
    if (!stat.isFile()) throw invalid();
    return stat.size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  } finally {
    if (fileFd !== undefined) closeSync(fileFd);
    if (dirFd !== undefined) closeSync(dirFd);
  }
}

/** Image-owned hook inventories and fsyncs every quarantine file before reservation.
 * Only new canonical paths are charged; persist their identities before migration. */
export function syncPushObjects(incoming: string, objects: string): PushObjectFile[] {
  const canonicalFd = openSync(
    objects,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  const files: PushObjectFile[] = [];
  let count = 0,
    bytes = 0;
  function walk(fd: number, prefix: string) {
    for (const entry of readdirSync(`/proc/self/fd/${fd}`, { withFileTypes: true })) {
      const path = `${prefix}${entry.name}`;
      if (entry.isDirectory() && !prefix && /^(?:[0-9a-f]{2}|pack|info)$/.test(entry.name)) {
        const child = openSync(
          procChild(fd, entry.name),
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        try {
          walk(child, `${path}/`);
        } finally {
          closeSync(child);
        }
      } else {
        if (
          !entry.isFile() ||
          !(OBJECT_FILE.test(path) || QUARANTINE_KEEP.test(path)) ||
          ++count > KB_TREE_LIMITS.maxObjects + 8
        )
          throw invalid();
        const child = openSync(
          procChild(fd, entry.name),
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          const stat = fstatSync(child);
          bytes += stat.size;
          if (!stat.isFile() || bytes > 150 * 1024 * 1024) throw invalid();
          fsyncSync(child);
          if (OBJECT_FILE.test(path) && objectFileSize(canonicalFd, path) === null)
            files.push({ path, bytes: stat.size });
        } finally {
          closeSync(child);
        }
      }
    }
    fsyncSync(fd);
  }
  try {
    const incomingFd = openSync(
      incoming,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      walk(incomingFd, "");
    } finally {
      closeSync(incomingFd);
    }
    return files;
  } finally {
    closeSync(canonicalFd);
  }
}

/** After confirmed child drain, account even partial migration into canonical storage.
 * A missing tip alone cannot prove that all incoming loose/pack files disappeared. */
export function retainedPushObjectBytes(
  repoPath: string,
  files: readonly PushObjectFile[],
): number {
  const objectsFd = openSync(
    join(repoPath, "objects"),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    let bytes = 0;
    for (const file of parsePushObjectFiles(files)) {
      const size = objectFileSize(objectsFd, file.path);
      if (size === null) continue;
      if (size !== file.bytes) throw invalid();
      bytes += size;
    }
    return bytes;
  } finally {
    closeSync(objectsFd);
  }
}
export function parsePushCommands(text: string): PushCommand {
  const lines = text.replace(/\n$/, "").split("\n");
  // Parse safe command identities before applying policy, so every ref in a
  // refused multi-ref push can receive its own receive-pack report. This is a
  // bounded wire identity, not the product branch-name admission alphabet.
  const parsed = lines.map((line) => {
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (refs\/[^ \p{Cc}]{1,1024})$/u.exec(line);
    if (!match) throw new PushRefusedError("INVALID_REF");
    return { oldSha: match[1]!, newSha: match[2]!, refName: match[3]! };
  });
  const refs = parsed.map((command) => command.refName);
  const refuse = (code: PushRefusalCode): never => {
    throw new PushRefusedError(code, refs);
  };
  if (parsed.length !== 1) refuse("MULTIPLE_REFS");
  const command = parsed[0]!;
  const { oldSha, newSha, refName } = command;
  if (!refName.startsWith("refs/heads/")) refuse("INVALID_NAMESPACE");
  if (newSha === ZERO_SHA) refuse("DELETE_REF");
  if (refName === "refs/heads/pr" || refName.startsWith("refs/heads/pr/")) refuse("RESERVED_REF");
  if (
    !/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9_./-]{0,190}$/.test(refName) ||
    newSha === oldSha ||
    refName.includes("..") ||
    refName.includes("//") ||
    refName.endsWith("/") ||
    refName
      .split("/")
      .some((part) => part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock")) ||
    (refName === "refs/heads/main" && oldSha === ZERO_SHA)
  )
    refuse("INVALID_REF");
  return command;
}

/** Count/charge before native Git decompresses. Delta result lengths count expanded
 * objects, including unreachable pack objects. Thin bases never exempt the result. */
export function inspectPushRequest(bytes: Buffer): PushCommand {
  let offset = 0;
  const commands: string[] = [];
  for (;;) {
    const hex = bytes.subarray(offset, offset + 4).toString("ascii");
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw invalid();
    const size = Number.parseInt(hex, 16);
    offset += 4;
    if (!size) break;
    if (size < 5 || offset + size - 4 > bytes.length || commands.length >= 128) throw invalid();
    commands.push(
      bytes
        .subarray(offset, offset + size - 4)
        .toString("utf8")
        .split("\0")[0]!
        .replace(/\n$/, ""),
    );
    offset += size - 4;
  }
  const command = parsePushCommands(commands.join("\n"));
  if (offset === bytes.length) return command; // A ref may point to already-known objects.
  const pack = bytes.subarray(offset);
  if (
    pack.length < 32 ||
    pack.toString("ascii", 0, 4) !== "PACK" ||
    ![2, 3].includes(pack.readUInt32BE(4))
  )
    throw invalid();
  const count = pack.readUInt32BE(8);
  if (count > KB_TREE_LIMITS.maxObjects) throw invalid();
  offset = 12;
  let total = 0;
  const byte = () => {
    if (offset >= pack.length - 20) throw invalid();
    return pack[offset++]!;
  };
  for (let i = 0; i < count; i++) {
    let b = byte(),
      size = b & 15,
      shift = 4;
    const type = (b >> 4) & 7;
    while (b & 128) {
      b = byte();
      size += (b & 127) * 2 ** shift;
      shift += 7;
      if (shift > 53) throw invalid();
    }
    if (![1, 2, 3, 4, 6, 7].includes(type) || size > KB_TREE_LIMITS.maxUncompressedObjectBytes)
      throw invalid();
    if (type === 6) {
      let n = 0;
      do {
        b = byte();
        if (++n > 10) throw invalid();
      } while (b & 128);
    }
    if (type === 7) offset += 20;
    const remaining = KB_TREE_LIMITS.maxUncompressedObjectBytes - total;
    if (type < 6 && size > remaining) throw invalid();
    const inflated = inflateSync(pack.subarray(offset, -20), {
      maxOutputLength: Math.max(1, Math.min(remaining, KB_TREE_LIMITS.maxUncompressedObjectBytes)),
      info: true,
    }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    offset += inflated.engine.bytesWritten;
    if (inflated.buffer.length !== size) throw invalid();
    if (type >= 6) {
      let cursor = 0;
      const integer = () => {
        let value = 0,
          power = 0,
          digit: number;
        do {
          if (cursor >= inflated.buffer.length || power > 49) throw invalid();
          digit = inflated.buffer[cursor++]!;
          value += (digit & 127) * 2 ** power;
          power += 7;
        } while (digit & 128);
        return value;
      };
      integer();
      size = integer();
    }
    total += size;
    if (total > KB_TREE_LIMITS.maxUncompressedObjectBytes) throw invalid();
  }
  if (
    offset !== pack.length - 20 ||
    !createHash("sha1").update(pack.subarray(0, -20)).digest().equals(pack.subarray(-20))
  )
    throw invalid();
  return command;
}
export async function validatePush(
  options: TreeValidationOptions,
  command: PushCommand,
  mainSha: string,
) {
  let base: string;
  if (command.oldSha === ZERO_SHA) {
    // A new branch shares history with this KB's pinned main, never unrelated
    // history. It may start from an older main (merges or marks conflicts
    // against the current one): only commits main never had are validated.
    const shared = gitAnswer(options.repoPath, ["merge-base", mainSha, command.newSha]);
    if (shared === false) throw new PushRefusedError("UNRELATED_HISTORY");
    base = shared;
  } else {
    const fastForward = gitAnswer(options.repoPath, [
      "merge-base",
      "--is-ancestor",
      command.oldSha,
      command.newSha,
    ]);
    if (fastForward === false) throw new PushRefusedError("NON_FAST_FORWARD");
    base = command.oldSha;
  }
  const result = await validateNewlyReachableCommits(options, {
    oldSha: base,
    newSha: command.newSha,
  });
  if (!result.ok) throw new PushRefusedError("INVALID_CONTENT", [], result);
  return result;
}

/**
 * A branch update's logical writes, as the pre-receive hook reports them
 * bounded, typed and normalized, or the push is refused.
 */
export function parsePushTouched(value: unknown): { kind: "document" | "asset"; path: string }[] {
  if (!Array.isArray(value) || value.length > KB_MAX_LOGICAL_CHANGES) throw invalid();
  return value.map((item: unknown) => {
    const { kind, path } = (item ?? {}) as { kind?: unknown; path?: unknown };
    if (
      (kind !== "document" && kind !== "asset") ||
      typeof path !== "string" ||
      !normalizeKbPath(path).ok ||
      Object.keys(item as object).length !== 2
    )
      throw invalid();
    return { kind, path };
  });
}
