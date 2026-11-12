#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import { manifestAtCommit } from "@knowledge-base/api/lib/kb/asset-authz";
import { withGitQuarantine } from "@knowledge-base/api/lib/kb/git-read";
import { changedLogicalPaths } from "@knowledge-base/api/lib/kb/logical-diff";
import {
  PushRefusedError,
  parsePushCommands,
  syncPushObjects,
  validatePush,
  ZERO_SHA,
} from "@knowledge-base/api/lib/kb/push-validation";
import type { SealedReferenceOccurrence } from "@knowledge-base/api/lib/kb/validate-tree";
import { errorClassOf, errorCodeOf } from "@knowledge-base/env/log-record";

/** Logical writes per hook frame (each frame well under the channel's 16 MiB). */
export const PUSH_TOUCHED_FRAME = 1024;
export const PUSH_HOOKS_PATH = resolve(import.meta.dirname, "../dist/hooks");
/** Bounded private local protocol; one outstanding read and no unbounded queued frames. */
export function pushChannel(socket: Socket) {
  const iterator = socket[Symbol.asyncIterator]();
  let pending = Buffer.alloc(0);
  return {
    send(value: unknown) {
      socket.write(`${JSON.stringify(value)}\n`);
    },
    async receive(): Promise<Record<string, unknown>> {
      for (;;) {
        const end = pending.indexOf(10);
        if (end >= 0) {
          const line = pending.subarray(0, end);
          pending = pending.subarray(end + 1);
          const value: unknown = JSON.parse(line.toString("utf8"));
          if (!value || typeof value !== "object" || Array.isArray(value))
            throw new Error("PUSH_REJECTED");
          return value as Record<string, unknown>;
        }
        const next = await iterator.next();
        if (next.done) throw new Error("PUSH_REJECTED");
        pending = Buffer.concat([pending, next.value]);
        if (pending.length > 16 * 1024 * 1024) throw new Error("PUSH_REJECTED");
      }
    },
  };
}
/**
 * A hook failure crosses the process boundary as typed, enumerated detail
 * only — the error's class name and stable code — never its message (R3-W3).
 */
export function pushHookDiagnostic(error: unknown): {
  errorClass: string;
  errorCode?: string | number;
} {
  const errorCode = errorCodeOf(error);
  return errorCode === undefined
    ? { errorClass: errorClassOf(error) }
    : { errorClass: errorClassOf(error), errorCode };
}
async function hook() {
  let commands = "";
  for await (const chunk of process.stdin) {
    commands += chunk.toString();
    if (commands.length > 65536) throw new Error("PUSH_REJECTED");
  }
  const command = parsePushCommands(commands);
  const nonce = process.env.KB_PUSH_NONCE,
    path = process.env.KB_PUSH_SOCKET;
  if (!nonce || !/^[0-9a-f]{64}$/.test(nonce) || !path) throw new Error("PUSH_REJECTED");
  const repoPath = realpathSync(process.cwd()),
    objects = join(repoPath, "objects");
  const incoming = process.env.GIT_QUARANTINE_PATH;
  if (
    incoming &&
    (dirname(realpathSync(incoming)) !== objects ||
      !basename(incoming).startsWith("tmp_objdir-incoming-"))
  )
    throw new Error("PUSH_REJECTED");
  const socket = connect({ path, allowHalfOpen: true });
  socket.setTimeout(60000, () => socket.destroy(new Error("PUSH_REJECTED")));
  const channel = pushChannel(socket);
  try {
    channel.send({ nonce, command: commands });
    const snapshot = await channel.receive();
    if (snapshot.ok !== true || typeof snapshot.mainSha !== "string")
      throw new Error("PUSH_REJECTED");
    let sealed: SealedReferenceOccurrence[] = [];
    const flushSealed = async () => {
      for (let offset = 0; offset < sealed.length; offset += 256) {
        channel.send({ sealed: sealed.slice(offset, offset + 256) });
        if ((await channel.receive()).ok !== true) throw new Error("PUSH_REJECTED");
      }
      sealed = [];
    };
    let touched: Awaited<ReturnType<typeof changedLogicalPaths>> = [];
    await withGitQuarantine(incoming ? realpathSync(incoming) : objects, objects, async () => {
      await validatePush(
        {
          repoPath,
          validateSealedReferences: (refs) => {
            sealed = [...refs];
            return null;
          },
          async loadCommitContext(sha) {
            // The range validator supplies unchanged blobs shared by eligible
            // validated parents for sealed checks, including new branches.
            await flushSealed();
            channel.send({ hashes: manifestAtCommit(repoPath, sha).map((entry) => entry.hash) });
            const reply = await channel.receive();
            if (reply.ok !== true || !Array.isArray(reply.blobs)) throw new Error("PUSH_REJECTED");
            const blobs = reply.blobs as Array<{ hash: string; size: number; mime: string }>;
            return {
              trustedBlobs: new Map(
                blobs.map((blob) => [blob.hash, { size: blob.size, mime: blob.mime }]),
              ),
              lineageHashes: new Set(blobs.map((blob) => blob.hash)),
            };
          },
        },
        command,
        snapshot.mainSha as string,
      );
      // A branch update's logical writes resolve the PR's recorded conflicts.
      if (command.refName !== "refs/heads/main" && command.oldSha !== ZERO_SHA)
        touched = await changedLogicalPaths(repoPath, command.oldSha, command.newSha, {});
    });
    await flushSealed();
    const objectFiles = incoming ? syncPushObjects(incoming, objects) : [];
    const objectBytes = objectFiles.reduce((total, file) => total + file.bytes, 0);
    // The logical writes in bounded frames (up to every document and asset
    // entry removed and added), then the proof.
    for (let offset = 0; offset < touched.length; offset += PUSH_TOUCHED_FRAME) {
      channel.send({ touched: touched.slice(offset, offset + PUSH_TOUCHED_FRAME) });
      if ((await channel.receive()).ok !== true) throw new Error("PUSH_REJECTED");
    }
    channel.send({ validated: true, objectBytes, objectFiles });
    if ((await channel.receive()).ok !== true) throw new Error("PUSH_REJECTED");
  } catch (error) {
    // Tell the server which refusal it was, so the pusher reads the reason
    // instead of a bare 503 (R3-W10). Flushed before the socket closes.
    // Any other failure crosses the process boundary as a bounded, redacted
    // diagnostic for the server log: the CGI discards this hook's stderr (R3-W3).
    const report =
      error instanceof PushRefusedError
        ? { refused: error.refusal, detail: error.detail }
        : { failed: pushHookDiagnostic(error) };
    await new Promise<void>((resolve) =>
      socket.end(`${JSON.stringify(report)}\n`, () => resolve()),
    );
    throw error;
  } finally {
    socket.destroy();
  }
}
if (["pre-receive", "git-pre-receive.mjs"].includes(basename(process.argv[1] ?? ""))) {
  try {
    await hook();
  } catch {
    // The exit status is the answer; the server reports the refusal itself.
    process.exitCode = 1;
  }
}
