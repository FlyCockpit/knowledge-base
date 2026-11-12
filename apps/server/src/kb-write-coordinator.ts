import { randomUUID } from "node:crypto";
import {
  type AuthorityBarrier,
  runLockedOperation,
} from "@knowledge-base/api/lib/kb/authority-lock";
import {
  CHANGES_APPLY_OPERATION,
  type ChangesApplyRequest,
  type ChangesPublicationInput,
  createChangesPublication,
} from "@knowledge-base/api/lib/kb/changes";
import { GitCommandError, type GitMutatingExecutor } from "@knowledge-base/api/lib/kb/git-write";
import {
  type HeldLockLease,
  KbLockError,
  MUTATION_DEADLINE_MS,
  MutationScope,
  sealKbOperationGate,
} from "@knowledge-base/api/lib/kb/lock";
import {
  canonicalRequestHash,
  createJournalTestPublication,
  type JournalTestPublicationInput,
} from "@knowledge-base/api/lib/kb/operation-intent";
import { kbRecoveryGateOpen } from "@knowledge-base/api/lib/kb/recovery";
import {
  assertGitWriteCapability,
  type GitWriteCapability,
} from "@knowledge-base/api/lib/kb/write-capability";
import {
  assertProcessFence,
  closeAdmission,
  drainMutatingChild,
  type MutatingSpawnRequest,
  ProcessFenceError,
  type SupervisedExit,
  spawnMutatingChild,
  waitMutatingChild,
} from "./kb-process.js";
import { issueGitWriteCapability } from "./kb-write-capability.js";

export type WriteCoordinatorDeps = {
  connectionString: string;
  assertFence?: () => void;
  spawn?: typeof spawnMutatingChild;
  wait?: typeof waitMutatingChild;
  drain?: typeof drainMutatingChild;
  closeAdmission?: () => Promise<void>;
  now?: () => number;
  mutationDeadlineMs?: number;
  lockWaitMs?: number;
};

export type WriteOperationContext = {
  lease: HeldLockLease;
  signal: AbortSignal;
  issueWriteCapability(kbId: string): GitWriteCapability;
  spawnMutatingChild(
    req: Omit<MutatingSpawnRequest, "opId"> & { capability: GitWriteCapability },
  ): Promise<{ pid: number }>;
  waitChild(pid: number): Promise<SupervisedExit>;
};

type ChildSlot = {
  opId: string;
  pid: number;
  reaped?: SupervisedExit;
  inFlight?: Promise<SupervisedExit>;
  drainSent?: boolean;
};

type InFlight = {
  opId: string;
  kbIds: string[];
  children: ChildSlot[];
  pendingSpawns: Set<Promise<{ pid: number }>>;
  spawning: number;
  spawnWaiters: Array<() => void>;
  admissionClosed: boolean;
  scope: MutationScope;
  drainInFlight?: Promise<void>;
  drainFailed?: unknown;
};

export type KbWriteCoordinator = {
  run<T>(options: {
    opId: string;
    kind: "authority" | "git-write";
    kbIds?: readonly string[];
    barrier?: AuthorityBarrier;
    run: (ctx: WriteOperationContext) => Promise<T>;
  }): Promise<T>;
  closeWriteAdmission(): void;
  shutdown(): Promise<void>;
  get admissionClosed(): boolean;
};

function drainFailedError(opId: string): KbLockError {
  return new KbLockError("CONNECTION_LOST", "failed to confirm child drain", opId);
}

/**
 * The only production GitMutatingExecutor: every mutating Git command runs as
 * a coordinator-supervised child under a coordinator-issued capability, so it
 * is fence-checked, cancellation-observable, and drained before the operation
 * fence is released. Nonzero exits surface as GitCommandError. Must be called
 * inside the coordinator run callback (locks held, authority lock released),
 * after the COMMITTING reservation has been persisted.
 */
export function gitMutatingExecutor(ctx: WriteOperationContext, kbId: string): GitMutatingExecutor {
  const capability = ctx.issueWriteCapability(kbId);
  return {
    async exec({ cwd, argv, env }) {
      if (argv.length < 1 || argv.some((arg) => arg.includes("\0"))) {
        throw new Error("refusing git argv");
      }
      const childEnv: Record<string, string> = {};
      for (const [key, value] of Object.entries(env)) {
        if (value !== undefined) childEnv[key] = value;
      }
      const { pid } = await ctx.spawnMutatingChild({
        argv: [...argv],
        cwd,
        env: childEnv,
        capability,
      });
      const exit = await ctx.waitChild(pid);
      if (exit.status !== 0) {
        throw new GitCommandError(String(argv[1] ?? argv[0]), exit.status);
      }
    },
  };
}

/** Journal reservations run in the authority barrier; Git CAS runs after its commit. */
export function runJournalTestPublish(
  coordinator: KbWriteCoordinator,
  input: JournalTestPublicationInput,
): Promise<Record<string, unknown>> {
  const publication = createJournalTestPublication(input);
  return coordinator.run({
    opId: randomUUID(),
    kind: "git-write",
    kbIds: [input.kbId],
    barrier: publication.barrier,
    run: (ctx) => publication.publish(ctx.lease, gitMutatingExecutor(ctx, input.kbId)),
  });
}

export function runChangesApply(
  coordinator: KbWriteCoordinator,
  input: Omit<ChangesPublicationInput, "operation" | "requestHash"> & {
    request: ChangesApplyRequest;
  },
): Promise<Record<string, unknown>> {
  const publication = createChangesPublication({
    ...input,
    operation: CHANGES_APPLY_OPERATION,
    requestHash: canonicalRequestHash(input.request),
  });
  return coordinator.run({
    opId: randomUUID(),
    kind: "git-write",
    kbIds: [input.kbId],
    barrier: publication.barrier,
    run: (ctx) => publication.publish(ctx.lease, gitMutatingExecutor(ctx, input.kbId)),
  });
}

export function createKbWriteCoordinator(deps: WriteCoordinatorDeps): KbWriteCoordinator {
  const spawn = deps.spawn ?? spawnMutatingChild;
  const wait = deps.wait ?? waitMutatingChild;
  const drain = deps.drain ?? drainMutatingChild;
  const close = deps.closeAdmission ?? closeAdmission;
  const assertFence = deps.assertFence ?? assertProcessFence;
  assertFence();
  const deadlineMs = deps.mutationDeadlineMs ?? MUTATION_DEADLINE_MS;
  const inflight = new Map<string, InFlight>();
  const operations = new Set<Promise<unknown>>();
  let admissionClosed = false;
  let unconfirmedDrain: unknown;

  function failClosed(op: InFlight, error: unknown): void {
    op.drainFailed ??= error;
    unconfirmedDrain ??= error;
    admissionClosed = true;
    for (const other of inflight.values()) {
      other.scope.cancel(
        new KbLockError("ADMISSION_CLOSED", "write admission is closed", other.opId),
      );
    }
    for (const kbId of op.kbIds) sealKbOperationGate(kbId);
  }

  function notifySpawn(op: InFlight): void {
    const waiters = op.spawnWaiters.splice(0);
    for (const waiter of waiters) waiter();
  }

  function waitForSpawnProgress(op: InFlight): Promise<void> {
    if (op.pendingSpawns.size > 0 || unreaped(op).length > 0 || op.spawning === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      op.spawnWaiters.push(resolve);
    });
  }

  function unreaped(op: InFlight): ChildSlot[] {
    return op.children.filter((slot) => !slot.reaped);
  }

  function reap(slot: ChildSlot, signalDrain: boolean): Promise<SupervisedExit> {
    if (slot.reaped) return Promise.resolve(slot.reaped);
    if (slot.inFlight) {
      if (signalDrain && !slot.drainSent) {
        slot.drainSent = true;
        const draining = drain(slot.opId, slot.pid).then(
          (exit) => {
            slot.reaped = exit;
            return exit;
          },
          (error: unknown) => {
            if (slot.reaped) return slot.reaped;
            throw error;
          },
        );
        slot.inFlight = Promise.race([
          slot.inFlight.then((exit) => {
            slot.reaped = exit;
            return exit;
          }),
          draining,
        ]);
      }
      return slot.inFlight;
    }
    slot.drainSent = signalDrain;
    slot.inFlight = (signalDrain ? drain : wait)(slot.opId, slot.pid).then((exit) => {
      slot.reaped = exit;
      return exit;
    });
    return slot.inFlight;
  }

  async function drainChildren(op: InFlight): Promise<void> {
    if (op.drainFailed) {
      failClosed(op, op.drainFailed);
      throw op.drainFailed;
    }
    if (op.drainInFlight) return op.drainInFlight;
    const running = (async () => {
      try {
        while (true) {
          if (op.drainFailed) throw op.drainFailed;
          const pending = [...op.pendingSpawns];
          if (pending.length > 0) {
            await Promise.allSettled(pending);
            continue;
          }
          const live = unreaped(op);
          if (live.length > 0) {
            const results = await Promise.allSettled(live.map((slot) => reap(slot, true)));
            const failed = results.find((result) => result.status === "rejected");
            if (failed && failed.status === "rejected") {
              throw drainFailedError(op.opId);
            }
            continue;
          }
          if (op.spawning > 0) {
            await waitForSpawnProgress(op);
            continue;
          }
          if (op.pendingSpawns.size === 0 && unreaped(op).length === 0 && op.spawning === 0) {
            return;
          }
        }
      } catch (error) {
        failClosed(op, error);
        throw error;
      }
    })();
    op.drainInFlight = running;
    try {
      await running;
    } finally {
      if (op.drainInFlight === running) op.drainInFlight = undefined;
    }
  }

  return {
    get admissionClosed() {
      return admissionClosed;
    },
    closeWriteAdmission() {
      admissionClosed = true;
      for (const op of inflight.values()) op.scope.requestShutdown();
    },
    async shutdown() {
      admissionClosed = true;
      for (const op of inflight.values()) op.scope.requestShutdown();
      await Promise.allSettled([...operations]);
      await close();
      if (unconfirmedDrain) {
        throw unconfirmedDrain instanceof Error ? unconfirmedDrain : drainFailedError("shutdown");
      }
    },
    async run<T>(options: {
      opId: string;
      kind: "authority" | "git-write";
      kbIds?: readonly string[];
      barrier?: AuthorityBarrier;
      run: (ctx: WriteOperationContext) => Promise<T>;
    }): Promise<T> {
      if (admissionClosed) {
        throw new KbLockError("ADMISSION_CLOSED", "write admission is closed", options.opId);
      }
      if (options.kind === "git-write" && !kbRecoveryGateOpen()) {
        throw new KbLockError(
          "ADMISSION_CLOSED",
          "journal recovery has not completed",
          options.opId,
        );
      }
      if (inflight.has(options.opId)) {
        throw new KbLockError("LOCK_ORDER", "duplicate in-flight operation id", options.opId);
      }
      const op: InFlight = {
        opId: options.opId,
        kbIds: [...(options.kbIds ?? [])],
        children: [],
        pendingSpawns: new Set(),
        spawning: 0,
        spawnWaiters: [],
        admissionClosed: false,
        scope: new MutationScope(options.opId, deps.now, (deps.now ?? Date.now)() + deadlineMs),
      };
      inflight.set(options.opId, op);
      const kind = options.kind === "git-write" ? "kb-write" : "authority";
      // Start draining at cancellation, so a callback waiting for its child can
      // finish. The operation still joins that callback before releasing locks.
      const onCancel = () => {
        void drainChildren(op).catch(() => undefined);
      };
      op.scope.signal.addEventListener("abort", onCancel);

      const finished = (async () => {
        try {
          return await runLockedOperation({
            connectionString: deps.connectionString,
            opId: options.opId,
            kbIds: options.kbIds,
            kind,
            barrier: options.barrier && {
              ...options.barrier,
              async prepare(lease) {
                // Preparation can reconcile an earlier writer's abandoned ref
                // lock. The KB gate has joined its drain before this callback.
                assertFence();
                await options.barrier?.prepare?.(lease);
              },
            },
            scope: op.scope,
            now: deps.now,
            lockWaitMs: deps.lockWaitMs,
            mutationDeadlineAt: op.scope.deadlineAt,
            cleanup: async () => {
              await drainChildren(op);
            },
            run: async (lease) => {
              const onConnectionLost = () => {
                op.scope.cancel(
                  new KbLockError(
                    "CONNECTION_LOST",
                    "pinned Postgres session was lost",
                    options.opId,
                  ),
                );
              };
              lease.lost.addEventListener("abort", onConnectionLost);
              if (lease.connectionLost) onConnectionLost();

              const ctx: WriteOperationContext = {
                lease,
                signal: op.scope.signal,
                issueWriteCapability(kbId) {
                  if (op.admissionClosed) {
                    throw new KbLockError(
                      "ADMISSION_CLOSED",
                      "operation admission is closed",
                      options.opId,
                    );
                  }
                  op.scope.assertActive();
                  lease.assertOpen();
                  if (lease.holdingAuthority()) {
                    throw new KbLockError(
                      "AUTHORITY_HELD",
                      "Cannot issue a Git write capability while holding the authority lock",
                      options.opId,
                    );
                  }
                  assertFence();
                  return issueGitWriteCapability(lease, kbId);
                },
                async spawnMutatingChild(req) {
                  op.spawning += 1;
                  let spawnPromise: Promise<{ pid: number }> | undefined;
                  try {
                    if (op.admissionClosed || op.scope.signal.aborted) {
                      throw new KbLockError(
                        "ADMISSION_CLOSED",
                        "write admission is closed",
                        options.opId,
                      );
                    }
                    op.scope.assertActive();
                    lease.assertOpen();
                    lease.assertCanReceiveNetworkBody("spawn a mutating child");
                    const capability = assertGitWriteCapability(req.capability);
                    lease.assertHeldKb(capability.kbId);
                    assertFence();
                    // Record an ambiguous failure before removing the pending
                    // spawn. The supervisor may have forked without delivering
                    // its PID, so neither empty tracking sets nor channel loss
                    // can authorize a successor or a successful shutdown.
                    spawnPromise = (async () => {
                      try {
                        return await spawn({
                          opId: options.opId,
                          argv: req.argv,
                          cwd: req.cwd,
                          env: req.env,
                        });
                      } catch (error) {
                        if (
                          !(error instanceof ProcessFenceError) ||
                          error.spawnOutcome !== "not-started"
                        ) {
                          failClosed(op, drainFailedError(options.opId));
                        }
                        throw error;
                      }
                    })();
                    op.pendingSpawns.add(spawnPromise);
                    notifySpawn(op);
                    const child = await spawnPromise;
                    op.pendingSpawns.delete(spawnPromise);
                    spawnPromise = undefined;
                    const slot: ChildSlot = { opId: options.opId, pid: child.pid };
                    op.children.push(slot);
                    notifySpawn(op);
                    if (op.scope.signal.aborted) {
                      try {
                        await reap(slot, true);
                      } catch {
                        failClosed(op, drainFailedError(options.opId));
                        throw drainFailedError(options.opId);
                      }
                      throw new KbLockError(
                        "ADMISSION_CLOSED",
                        "write admission is closed",
                        options.opId,
                      );
                    }
                    return child;
                  } finally {
                    if (spawnPromise) op.pendingSpawns.delete(spawnPromise);
                    op.spawning -= 1;
                    notifySpawn(op);
                  }
                },
                waitChild(pid) {
                  const slot = op.children.find((child) => child.pid === pid);
                  if (!slot) {
                    throw new KbLockError("NOT_HELD", `no supervised child ${pid}`, options.opId);
                  }
                  return reap(slot, false);
                },
              };

              try {
                op.scope.assertActive();
                const result = await options.run(ctx);
                op.scope.assertActive();
                return result;
              } catch (error) {
                op.scope.cancel(error);
                throw error;
              } finally {
                // Close synchronously at callback settlement, before any drain
                // yields. Already dispatched spawns remain tracked and joined.
                op.admissionClosed = true;
                lease.lost.removeEventListener("abort", onConnectionLost);
                await drainChildren(op);
              }
            },
          });
        } catch (error) {
          if (op.drainFailed) throw op.drainFailed;
          if (op.scope.signal.aborted) throw op.scope.signal.reason;
          throw error;
        } finally {
          await drainChildren(op).catch((error) => {
            if (!op.drainFailed) op.drainFailed = error;
          });
          inflight.delete(options.opId);
        }
      })();

      operations.add(finished);
      try {
        return await finished;
      } finally {
        op.scope.signal.removeEventListener("abort", onCancel);
        op.scope.dispose();
        operations.delete(finished);
      }
    },
  };
}

let instance: KbWriteCoordinator | undefined;

export function startKbWriteCoordinator(deps: WriteCoordinatorDeps): KbWriteCoordinator {
  if (instance) throw new Error("KB write coordinator already started");
  instance = createKbWriteCoordinator(deps);
  return instance;
}

export function getKbWriteCoordinator(): KbWriteCoordinator {
  if (!instance) throw new Error("KB write coordinator is not started");
  return instance;
}

export async function shutdownKbWriteCoordinator(): Promise<void> {
  if (!instance) return;
  const current = instance;
  instance = undefined;
  await current.shutdown();
}

export function closeKbWriteAdmission(): void {
  instance?.closeWriteAdmission();
}
