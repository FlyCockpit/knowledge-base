import { randomBytes, randomUUID } from "node:crypto";
import { chmod, type FileHandle, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sameActorPerson } from "@knowledge-base/api/lib/kb/actors";
import { assetValidationContext } from "@knowledge-base/api/lib/kb/asset-authz";
import {
  assertAuthorityReservation,
  runLockedOperation,
} from "@knowledge-base/api/lib/kb/authority-lock";
import { loadBranchOwner } from "@knowledge-base/api/lib/kb/branch-owner";
import { kbBareRepoPath, readRefSha, readRefShaAsync } from "@knowledge-base/api/lib/kb/git-read";
import { chargeKbMutation, type RatePort } from "@knowledge-base/api/lib/kb/limits";
import { MutationScope, sealKbOperationGate } from "@knowledge-base/api/lib/kb/lock";
import {
  canonicalRequestHash,
  findOperationIntent,
  type PublicationBarrier,
  reconcileKbIntents,
  reservePublicationIntent,
} from "@knowledge-base/api/lib/kb/operation-intent";
import { authorize, type LiveAuthorityStore } from "@knowledge-base/api/lib/kb/permissions";
import {
  actorKeyFor,
  type CredentialVerifier,
  type Principal,
} from "@knowledge-base/api/lib/kb/principal";
import {
  isPushRefusalCode,
  KB_MAX_LOGICAL_CHANGES,
  type PushCommand,
  type PushObjectFile,
  PushRefusedError,
  parsePushCommands,
  parsePushObjectFiles,
  parsePushTouched,
  ZERO_SHA,
} from "@knowledge-base/api/lib/kb/push-validation";
import { assertDiskFloor, reserveQuota, statfsDiskMeter } from "@knowledge-base/api/lib/kb/quota";
import { assertKbRecoveryComplete } from "@knowledge-base/api/lib/kb/recovery";
import { loadSealedTreeValidator } from "@knowledge-base/api/lib/kb/sealed-reference";
import type { SealedReferenceOccurrence } from "@knowledge-base/api/lib/kb/validate-tree";
import type { LogDetail } from "@knowledge-base/env/log";
import { runGitCgi } from "./git-cgi";
import { PUSH_TOUCHED_FRAME, pushChannel } from "./git-pre-receive";
import { assertProcessFence, closeAdmission } from "./kb-process";

export async function openPushContext(input: {
  signal: AbortSignal;
  expiresAt?: number;
  run(request: Record<string, unknown>, channel: ReturnType<typeof pushChannel>): Promise<object>;
}) {
  // sun_path includes the terminator: keep below the smallest Unix limit
  // (104 bytes on macOS). mkdtemp keeps the fallback owner-only as well.
  const temporaryRoot = tmpdir();
  const socketRoot =
    Buffer.byteLength(join(temporaryRoot, "kb-push-XXXXXX", "hook")) < 104 ? temporaryRoot : "/tmp";
  const dir = await mkdtemp(join(socketRoot, "kb-push-")),
    path = join(dir, "hook");
  const nonce = randomBytes(32).toString("hex"),
    expires = input.expiresAt ?? Date.now() + 60000;
  const sockets = new Set<Socket>();
  let used = false;
  const completion = Promise.withResolvers<void>();
  void completion.promise.catch(() => {});
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    socket.setTimeout(60000, () => socket.destroy());
    void (async () => {
      const channel = pushChannel(socket);
      let admitted = false;
      try {
        const request = await channel.receive();
        if (
          used ||
          input.signal.aborted ||
          Date.now() >= expires ||
          request.nonce !== nonce ||
          Object.keys(request).some((key) => !["nonce", "command"].includes(key))
        )
          throw new Error("PUSH_REJECTED");
        used = true;
        admitted = true;
        socket.end(`${JSON.stringify(await input.run(request, channel))}\n`);
        completion.resolve();
      } catch (error) {
        socket.end('{"ok":false}\n');
        if (admitted) completion.reject(error);
      }
    })();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, resolve);
    });
    await chmod(path, 0o600);
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  const cancel = () => {
    for (const socket of sockets) socket.destroy();
    completion.reject(new Error("PUSH_REJECTED"));
  };
  input.signal.addEventListener("abort", cancel, { once: true });
  if (input.signal.aborted) cancel();
  return {
    path,
    nonce,
    done: completion.promise,
    async close() {
      input.signal.removeEventListener("abort", cancel);
      cancel();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}
/** The pre-receive hook failed unexpectedly; carries only its typed detail. */
class PushHookError extends Error implements LogDetail {
  readonly code = "PUSH_HOOK_FAILED";
  readonly hookErrorClass: unknown;
  readonly hookErrorCode: unknown;
  constructor(detail: Record<string, unknown>) {
    super("Push hook failed");
    this.hookErrorClass = detail.errorClass;
    this.hookErrorCode = detail.errorCode;
  }
  logDetail(): Record<string, string | number> {
    const out: Record<string, string | number> = {};
    // the logger validates both again: only identifier-like values print.
    if (typeof this.hookErrorClass === "string") out.hookErrorClass = this.hookErrorClass;
    if (typeof this.hookErrorCode === "string" || typeof this.hookErrorCode === "number")
      out.hookErrorCode = this.hookErrorCode;
    return out;
  }
}
export type PushOptions = {
  connectionString: string;
  canonicalOrigin: string;
  ratePort: RatePort;
  barrier?: PublicationBarrier & { afterBufferedReply?(): Promise<void> };
};
/** Backend can only fill quarantine until its image hook obtains this reservation.
 * The same lock owner survives validation, hook reply, child drain and DB finalize. */
export async function receivePush(
  input: PushOptions & {
    reposDir: string;
    kbId: string;
    principal: Principal;
    verifier: CredentialVerifier;
    store: LiveAuthorityStore;
    signal: AbortSignal;
    env: Record<string, string>;
    command: PushCommand;
    file: FileHandle;
    opId?: string;
  },
): Promise<Response> {
  assertProcessFence();
  assertKbRecoveryComplete();
  await chargeKbMutation(input.ratePort, actorKeyFor(input.principal), input.kbId);
  await assertDiskFloor(statfsDiskMeter(input.reposDir), 128n * 1024n * 1024n);
  const opId = input.opId ?? randomUUID(),
    scope = new MutationScope(opId, Date.now, Date.now() + 60000);
  const cancel = () => scope.requestShutdown();
  input.signal.addEventListener("abort", cancel, { once: true });
  if (input.signal.aborted) cancel();
  const actorKey = actorKeyFor(input.principal),
    repo = kbBareRepoPath(input.reposDir, input.kbId);
  const command = input.command,
    backendAbort = new AbortController();
  let context: Awaited<ReturnType<typeof openPushContext>> | undefined;
  let backend: Promise<Response> | undefined, channel: ReturnType<typeof pushChannel> | undefined;
  let newBranch = false,
    objectBytes = 0,
    drainUnconfirmed = false;
  let objectFiles: PushObjectFile[] = [];
  let touched: ReturnType<typeof parsePushTouched> = [];
  const arrived = Promise.withResolvers<ReturnType<typeof pushChannel>>();
  const released = Promise.withResolvers<void>();
  const lookup = { actorKey, kbId: input.kbId, operation: "GIT_PUSH", idempotencyKey: opId };
  // Every Git read on this path is bound to the push's scope (cancellation, deadline).
  const scopeReads = () => ({ signal: scope.signal, deadlineAt: scope.deadlineAt });
  const delta = () => ({
    kind: "git_push" as const,
    headSha: command.newSha,
    refName: command.refName,
    newBranch,
    objectFiles,
    touched,
    quotaReservationIds: [] as string[],
  });
  try {
    return await runLockedOperation({
      connectionString: input.connectionString,
      opId,
      kbIds: [input.kbId],
      kind: "kb-write",
      scope,
      cleanup: async () => {
        backendAbort.abort();
        await backend?.catch(() => {});
        released.resolve();
        await context?.close();
      },
      barrier: {
        async prepare(lease) {
          const auth = await authorize({
            ...input,
            query: lease.query,
            operation: command.refName === "refs/heads/main" ? "write" : "propose",
          });
          if (
            auth.state !== "ACTIVE" ||
            (await lease.transaction((query) =>
              reconcileKbIntents(query, input.reposDir, input.kbId, scopeReads()),
            )) !== "ok"
          )
            throw new Error("PUSH_REJECTED");
          if (
            ((await readRefShaAsync(repo, command.refName, scopeReads())) ?? ZERO_SHA) !==
            command.oldSha
          )
            throw new PushRefusedError("STALE_REF");
          if (command.refName !== "refs/heads/main") {
            const owner = await loadBranchOwner(lease.query, input.kbId, command.refName);
            newBranch = command.oldSha === ZERO_SHA;
            // The person owns the branch, whichever of their credentials
            // pushed it; this credential's live propose authority was checked above.
            if (newBranch) {
              if (owner !== null) throw new PushRefusedError("BRANCH_TAKEN");
            } else if (
              owner === null ||
              owner.purpose !== "USER" ||
              !(await sameActorPerson(
                lease.query,
                actorKey,
                input.principal.userId,
                owner.ownerActorKey,
              ))
            )
              throw new PushRefusedError("BRANCH_NOT_YOURS");
            const closed = await lease.query(
              `SELECT 1 FROM pull_request WHERE "kbId"=$1 AND "sourceBranch"=$2 AND status IN ('CLOSED','MERGED') LIMIT 1`,
              [input.kbId, command.refName],
            );
            if (closed.rows.length) throw new PushRefusedError("BRANCH_CLOSED");
          }
          // Durable identity/ref intent precedes quarantine object work. The complete
          // validated quota delta replaces this draft before COMMITTING.
          await lease.transaction((query) =>
            reservePublicationIntent(query, {
              ...lookup,
              opId,
              actorUserIdSnapshot: input.principal.userId,
              actorUserId: input.principal.userId,
              requestHash: canonicalRequestHash(command),
              refName: command.refName,
              oldRef: command.oldSha,
              newRef: command.newSha,
              preparedDelta: delta(),
            }),
          );
          context = await openPushContext({
            signal: scope.signal,
            expiresAt: scope.deadlineAt,
            run: async (request, peer) => {
              lease.assertHeldKb(input.kbId);
              if (
                typeof request.command !== "string" ||
                canonicalRequestHash(parsePushCommands(request.command)) !==
                  canonicalRequestHash(command)
              )
                throw new Error("PUSH_REJECTED");
              arrived.resolve(peer);
              await released.promise;
              return { ok: true };
            },
          });
          // Network upload has ended. Only the bounded local spool feeds this
          // supervised backend while authority is held; it cannot publish yet.
          backend = runGitCgi({
            env: { ...input.env, KB_PUSH_NONCE: context.nonce, KB_PUSH_SOCKET: context.path },
            signal: AbortSignal.any([scope.signal, backendAbort.signal]),
            reauthorize: async () => {},
            file: input.file,
            onDone: async () => {},
            buffered: true,
            onUnconfirmedDrain: () => {
              drainUnconfirmed = true;
              sealKbOperationGate(input.kbId);
              void closeAdmission().catch(() => {});
            },
          });
          void backend.catch(() => {});
          channel = await Promise.race([
            arrived.promise,
            context.done.then(() => {
              throw new Error("PUSH_REJECTED");
            }),
            backend.then(() => {
              throw new Error("PUSH_REJECTED");
            }),
          ]);
          const checkSealed = await loadSealedTreeValidator(
            lease.query,
            input.kbId,
            input.canonicalOrigin,
          );
          channel.send({
            ok: true,
            mainSha: await readRefShaAsync(repo, "refs/heads/main", scopeReads()),
          });
          for (;;) {
            const proof = await channel.receive();
            if (
              Array.isArray(proof.hashes) &&
              proof.hashes.length <= 8192 &&
              proof.hashes.every(
                (hash) => typeof hash === "string" && /^sha256:[0-9a-f]{64}$/.test(hash),
              )
            ) {
              const context = await assetValidationContext(
                lease.query,
                input.kbId,
                proof.hashes as string[],
              );
              channel.send({
                ok: true,
                blobs: [...context.trustedBlobs].map(([hash, blob]) => ({ hash, ...blob })),
              });
            } else if (Array.isArray(proof.touched) && proof.touched.length <= PUSH_TOUCHED_FRAME) {
              // The branch update's logical writes, accumulated within their bound.
              touched = [...touched, ...parsePushTouched(proof.touched)];
              if (touched.length > KB_MAX_LOGICAL_CHANGES) throw new Error("PUSH_REJECTED");
              channel.send({ ok: true });
            } else if (proof.failed && typeof proof.failed === "object") {
              // The hook's own unexpected failure: a server error (503), logged by
              // git-http with the hook's typed detail (class name, code).
              throw new PushHookError(proof.failed as Record<string, unknown>);
            } else if (isPushRefusalCode(proof.refused)) {
              // The image hook's own validation refused the push (validatePush).
              throw new PushRefusedError(proof.refused, [], proof.detail);
            } else if (Array.isArray(proof.sealed) && proof.sealed.length <= 256) {
              if (checkSealed?.(proof.sealed as SealedReferenceOccurrence[]))
                throw new Error("PUSH_REJECTED");
              channel.send({ ok: true });
            } else {
              if (
                proof.validated !== true ||
                typeof proof.objectBytes !== "number" ||
                !Number.isSafeInteger(proof.objectBytes) ||
                proof.objectBytes < 0 ||
                proof.objectBytes > 150 * 1024 * 1024
              )
                throw new Error("PUSH_REJECTED");
              objectBytes = proof.objectBytes;
              objectFiles = parsePushObjectFiles(proof.objectFiles);
              if (objectFiles.reduce((sum, file) => sum + file.bytes, 0) !== objectBytes)
                throw new Error("PUSH_REJECTED");
              break;
            }
          }
        },
        async reauthorize({ query }) {
          const auth = await authorize({
            ...input,
            query,
            operation: command.refName === "refs/heads/main" ? "write" : "propose",
          });
          if (auth.state !== "ACTIVE") throw new Error("PUSH_REJECTED");
        },
        async reservePublication(reservation) {
          assertAuthorityReservation(reservation, input.kbId);
          const quota = await reserveQuota(
            { transactionQuery: reservation.query },
            {
              opId,
              expiresAt: new Date(scope.deadlineAt),
              heldForPublication: true,
              charges: [
                ...(objectBytes
                  ? [
                      {
                        dimension: "KB_HISTORY_BYTES" as const,
                        subjectId: input.kbId,
                        amount: BigInt(objectBytes),
                      },
                    ]
                  : []),
                ...(newBranch
                  ? [{ dimension: "KB_BRANCH" as const, subjectId: input.kbId, amount: 1n }]
                  : []),
              ],
              // reserveQuota requires the owning volume; the quarantined objects are
              // the new physical bytes this push adds to the repository volume.
              disks: [
                {
                  path: input.reposDir,
                  bytes: BigInt(objectBytes),
                  meter: statfsDiskMeter(input.reposDir),
                },
              ],
            },
          );
          const updated = await reservation.query(
            `UPDATE operation_intent SET phase='COMMITTING', "preparedDelta"=$2::jsonb, "updatedAt"=now() WHERE "opId"=$1 AND phase='PREPARED'`,
            [opId, JSON.stringify({ ...delta(), quotaReservationIds: quota.reservationIds })],
          );
          if (updated.rowCount !== 1) throw new Error("PUSH_REJECTED");
        },
      },
      async run(lease) {
        await input.barrier?.afterCommitting?.();
        channel!.send({ ok: true });
        let response: Response | undefined;
        try {
          response = await backend;
        } catch {
          /* Actual ref owns the result; reconcile after confirmed child drain. */
        }
        if (drainUnconfirmed) throw new Error("PUSH_REJECTED");
        await input.barrier?.afterRefUpdate?.();
        await lease.transaction((query) => reconcileKbIntents(query, input.reposDir, input.kbId));
        const intent = await findOperationIntent(lease.query, lookup);
        if (intent?.phase !== "FINALIZED" || readRefSha(repo, command.refName) !== command.newSha)
          throw new Error("PUSH_REJECTED");
        await input.barrier?.afterDbFinalize?.();
        if (!response) throw new Error("PUSH_REJECTED");
        await input.barrier?.afterBufferedReply?.();
        input.signal.throwIfAborted();
        return response;
      },
    });
  } finally {
    input.signal.removeEventListener("abort", cancel);
    scope.dispose();
  }
}
