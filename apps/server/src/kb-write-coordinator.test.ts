import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@knowledge-base/api/lib/kb/recovery", () => ({
  kbRecoveryGateOpen: () => true,
}));

import { ProcessFenceError } from "./kb-process.js";
import { gitMutatingExecutor, type WriteOperationContext } from "./kb-write-coordinator.js";

const fake = vi.hoisted(() => {
  const gates = new Map<string, Promise<void>>();
  const issued = new WeakSet<object>();
  type Lease = {
    opId: string;
    backendPid: number;
    lost: AbortSignal;
    connectionLost: boolean;
    holdingAuthority: () => boolean;
    heldKbIds: () => string[];
    assertHeldKb: (kbId: string) => void;
    assertOpen: () => void;
    assertCanReceiveNetworkBody: () => void;
    releaseAuthority: () => Promise<void>;
    close: () => Promise<void>;
    markLost: () => void;
  };
  function makeLease(): Lease {
    const abort = new AbortController();
    const lease: Lease = {
      opId: "op_coord",
      backendPid: 42,
      lost: abort.signal,
      connectionLost: false,
      holdingAuthority: () => false,
      heldKbIds: () => ["kb1"],
      assertHeldKb: (kbId: string) => {
        if (kbId !== "kb1") throw new Error(`not held ${kbId}`);
      },
      assertOpen: () => {
        if (lease.connectionLost || abort.signal.aborted) {
          throw new Error("pinned Postgres session was lost");
        }
      },
      assertCanReceiveNetworkBody: () => undefined,
      releaseAuthority: async () => undefined,
      close: async () => undefined,
      markLost: () => {
        lease.connectionLost = true;
        if (!abort.signal.aborted) abort.abort();
      },
    };
    return lease;
  }
  return {
    issued,
    makeLease,
    enqueue(key: string, fn: () => Promise<unknown>) {
      const prev = gates.get(key) ?? Promise.resolve();
      const run = prev.then(fn, fn);
      gates.set(
        key,
        run.then(
          () => undefined,
          () => undefined,
        ),
      );
      return run;
    },
    reset() {
      gates.clear();
    },
    spawn: vi.fn(async (_req: unknown) => ({ pid: 4242 })),
    drain: vi.fn(async (_opId: string, _pid: number) => ({
      opId: "op_coord",
      pid: 4242,
      status: 0,
    })),
    wait: vi.fn(async (_opId: string, _pid: number) => ({
      opId: "op_coord",
      pid: 4242,
      status: 0,
    })),
    closeAdmission: vi.fn(async () => undefined),
    assertFence: vi.fn(() => undefined),
  };
});

vi.mock("@knowledge-base/api/lib/kb/authority-lock", async () => {
  const { KbLockError } = await import("@knowledge-base/api/lib/kb/lock");
  return {
    runLockedOperation: async (options: {
      opId: string;
      kbIds?: readonly string[];
      scope: import("@knowledge-base/api/lib/kb/lock").MutationScope;
      barrier?: {
        reauthorize(context: { signal: AbortSignal }): Promise<void>;
        reservePublication(context: { signal: AbortSignal }): Promise<void>;
      };
      cleanup?: (lease: unknown) => Promise<void>;
      run: (lease: unknown) => Promise<unknown>;
    }) => {
      const key = options.kbIds?.[0] ?? options.opId;
      return fake.enqueue(key, async () => {
        const lease = fake.makeLease();
        try {
          if (options.scope.signal.aborted) {
            throw new KbLockError("ADMISSION_CLOSED", "write admission is closed", options.opId);
          }
          let reserved = false;
          if (options.barrier) {
            await options.barrier.reauthorize({ signal: options.scope.signal });
            if (options.scope.signal.aborted) {
              throw new KbLockError("ADMISSION_CLOSED", "write admission is closed", options.opId);
            }
            await options.barrier.reservePublication({ signal: options.scope.signal });
            options.scope.beginReservationCommit();
            options.scope.finishReservationCommit(true);
            reserved = true;
          }
          if (options.scope.signal.aborted && !reserved) {
            throw new KbLockError("ADMISSION_CLOSED", "write admission is closed", options.opId);
          }
          return await options.run(lease);
        } finally {
          if (options.cleanup) await options.cleanup(lease);
        }
      });
    },
  };
});

vi.mock("./kb-write-capability.js", () => ({
  issueGitWriteCapability(
    lease: {
      opId: string;
      holdingAuthority: () => boolean;
      assertHeldKb: (id: string) => void;
      assertOpen: () => void;
    },
    kbId: string,
  ) {
    lease.assertOpen();
    lease.assertHeldKb(kbId);
    if (lease.holdingAuthority()) {
      throw new Error("Cannot issue a Git write capability while holding the authority lock");
    }
    const cap = { opId: lease.opId, kbId };
    fake.issued.add(cap);
    return cap;
  },
}));

vi.mock("@knowledge-base/api/lib/kb/write-capability", () => ({
  assertGitWriteCapability(value: object) {
    if (!fake.issued.has(value)) {
      throw new Error(
        "Git write capability is missing or was not issued by the server coordinator",
      );
    }
    return value;
  },
  isGitWriteCapability(value: object) {
    return fake.issued.has(value);
  },
}));

vi.mock("./kb-process.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./kb-process.js")>()),
  assertProcessFence: () => fake.assertFence(),
  closeAdmission: () => fake.closeAdmission(),
  spawnMutatingChild: (req: unknown) => fake.spawn(req),
  waitMutatingChild: (opId: string, pid: number) => fake.wait(opId, pid),
  drainMutatingChild: (opId: string, pid: number) => fake.drain(opId, pid),
}));

const {
  createKbWriteCoordinator,
  getKbWriteCoordinator,
  startKbWriteCoordinator,
  shutdownKbWriteCoordinator,
} = await import("./kb-write-coordinator.js");

afterEach(async () => {
  fake.spawn.mockReset();
  fake.spawn.mockImplementation(async () => ({ pid: 4242 }));
  fake.drain.mockReset();
  fake.drain.mockImplementation(async (_opId: string, pid: number) => ({
    opId: "op_coord",
    pid,
    status: 0,
  }));
  fake.wait.mockReset();
  fake.wait.mockImplementation(async (_opId: string, pid: number) => ({
    opId: "op_coord",
    pid,
    status: 0,
  }));
  fake.closeAdmission.mockClear();
  fake.assertFence.mockClear();
  fake.reset();
  await shutdownKbWriteCoordinator().catch(() => undefined);
});

function coordinator(overrides?: { mutationDeadlineMs?: number; lockWaitMs?: number }) {
  return createKbWriteCoordinator({
    connectionString: "postgresql://kb_runtime_x:x@127.0.0.1:5432/kb_test_x",
    assertFence: () => fake.assertFence(),
    spawn: fake.spawn,
    wait: fake.wait,
    drain: fake.drain,
    closeAdmission: fake.closeAdmission,
    ...overrides,
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("kb write coordinator", () => {
  it("keeps admission open after a definitive pre-dispatch spawn rejection", async () => {
    const coord = coordinator();
    fake.spawn.mockRejectedValueOnce(
      new ProcessFenceError("not_started", "invalid argv", "not-started"),
    );
    await expect(
      coord.run({
        opId: "not_started",
        kind: "git-write",
        kbIds: ["kb1"],
        async run(ctx) {
          await ctx.spawnMutatingChild({
            argv: [],
            cwd: "/tmp",
            capability: ctx.issueWriteCapability("kb1"),
          });
        },
      }),
    ).rejects.toMatchObject({ spawnOutcome: "not-started" });
    expect(coord.admissionClosed).toBe(false);
    await expect(
      coord.run({
        opId: "next_not_started",
        kind: "git-write",
        kbIds: ["kb1"],
        run: async () => "ok",
      }),
    ).resolves.toBe("ok");
    await coord.shutdown();
  });

  it("issues a write capability only after the fence check and never from a forged token", async () => {
    const coord = coordinator();
    await coord.run({
      opId: "op_coord",
      kind: "git-write",
      kbIds: ["kb1"],
      async run(ctx: WriteOperationContext) {
        const forged = { opId: "op_coord", kbId: "kb1" };
        await expect(
          ctx.spawnMutatingChild({ argv: ["/bin/true"], cwd: "/tmp", capability: forged as never }),
        ).rejects.toThrow(/not issued/);
        const cap = ctx.issueWriteCapability("kb1");
        expect(fake.assertFence).toHaveBeenCalled();
        await ctx.spawnMutatingChild({ argv: ["/bin/true"], cwd: "/tmp", capability: cap });
        expect(fake.spawn).toHaveBeenCalledOnce();
        return "ok";
      },
    });
  });

  it("refuses a Git-write capability while the authority lock is held", async () => {
    const coord = coordinator();
    await coord.run({
      opId: "op_coord",
      kind: "git-write",
      kbIds: ["kb1"],
      async run(ctx) {
        ctx.lease.holdingAuthority = () => true;
        expect(() => ctx.issueWriteCapability("kb1")).toThrow(/authority lock/);
        return "ok";
      },
    });
  });

  it("runs mutating git through supervised children and surfaces nonzero exits", async () => {
    const coord = coordinator();
    await coord.run({
      opId: "op_coord",
      kind: "git-write",
      kbIds: ["kb1"],
      async run(ctx) {
        const executor = gitMutatingExecutor(ctx, "kb1");
        await executor.exec({
          cwd: "/srv/kb",
          argv: ["git", "--git-dir", "/srv/kb/kb_x.git", "update-ref", "refs/heads/main"],
          env: { PATH: "/usr/bin:/bin", MAYBE_UNDEFINED: undefined },
        });
        const req = fake.spawn.mock.calls.at(-1)![0] as {
          argv: string[];
          cwd: string;
          env: Record<string, string>;
        };
        expect(req.argv).toEqual([
          "git",
          "--git-dir",
          "/srv/kb/kb_x.git",
          "update-ref",
          "refs/heads/main",
        ]);
        expect(req.cwd).toBe("/srv/kb");
        expect(req.env.PATH).toBe("/usr/bin:/bin");
        expect("MAYBE_UNDEFINED" in req.env).toBe(false);
        expect(fake.wait).toHaveBeenCalledWith("op_coord", 4242);
        fake.spawn.mockResolvedValueOnce({ pid: 5151 });
        fake.wait.mockResolvedValueOnce({ opId: "op_coord", pid: 5151, status: 128 });
        await expect(
          executor.exec({ cwd: "/srv/kb", argv: ["git", "config", "gc.auto", "0"], env: {} }),
        ).rejects.toThrow(/git config exited with status 128/);
        return "ok";
      },
    });
  });

  it("rejects new operations after shutdown and drains existing children", async () => {
    const coord = coordinator();
    let spawned: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
      spawned = resolve;
    });
    const running = coord.run({
      opId: "op_coord",
      kind: "git-write",
      kbIds: ["kb1"],
      async run(ctx) {
        const cap = ctx.issueWriteCapability("kb1");
        await ctx.spawnMutatingChild({ argv: ["/bin/sleep"], cwd: "/tmp", capability: cap });
        spawned();
        await waitForAbort(ctx.signal);
      },
    });
    await ready;
    await coord.shutdown();
    expect(fake.drain).toHaveBeenCalled();
    expect(fake.closeAdmission).toHaveBeenCalledOnce();
    await expect(running).rejects.toThrow();
    await expect(
      coord.run({
        opId: "op_next",
        kind: "git-write",
        kbIds: ["kb1"],
        async run() {
          return "no";
        },
      }),
    ).rejects.toMatchObject({ code: "ADMISSION_CLOSED" });
  });

  it("holds the knowledge-base gate until child drain finishes before a successor runs", async () => {
    const coord = coordinator();
    let releaseDrain: () => void = () => undefined;
    fake.drain.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseDrain = () => resolve({ opId: "op_a", pid: 4242, status: 0 });
        }),
    );
    let firstReady: () => void = () => undefined;
    const firstHeld = new Promise<void>((resolve) => {
      firstReady = resolve;
    });
    const first = coord.run({
      opId: "op_a",
      kind: "git-write",
      kbIds: ["kb1"],
      async run(ctx) {
        const cap = ctx.issueWriteCapability("kb1");
        await ctx.spawnMutatingChild({ argv: ["/bin/true"], cwd: "/tmp", capability: cap });
        firstReady();
        ctx.lease.markLost();
        await waitForAbort(ctx.signal);
      },
    });
    await firstHeld;
    let secondStarted = false;
    const second = coord.run({
      opId: "op_b",
      kind: "git-write",
      kbIds: ["kb1"],
      async run() {
        secondStarted = true;
        return "second";
      },
    });
    await delay(30);
    expect(secondStarted).toBe(false);
    releaseDrain();
    await expect(first).rejects.toMatchObject({ code: "CONNECTION_LOST" });
    await expect(second).resolves.toBe("second");
    expect(secondStarted).toBe(true);
  });

  it("drains a child whose spawn acknowledgement arrives after cancellation", async () => {
    const coord = coordinator();
    let releaseSpawn: (value: { pid: number }) => void = () => undefined;
    fake.spawn.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseSpawn = resolve;
        }),
    );
    const running = coord.run({
      opId: "op_late",
      kind: "git-write",
      kbIds: ["kb1"],
      async run(ctx) {
        const cap = ctx.issueWriteCapability("kb1");
        const spawned = ctx.spawnMutatingChild({
          argv: ["/bin/true"],
          cwd: "/tmp",
          capability: cap,
        });
        ctx.lease.markLost();
        await spawned;
      },
    });
    await delay(20);
    expect(fake.drain).not.toHaveBeenCalled();
    releaseSpawn({ pid: 99 });
    await expect(running).rejects.toThrow();
    expect(fake.drain).toHaveBeenCalledWith("op_late", 99);
  });

  it("aborts a stalled callback with DEADLINE_EXCEEDED and drains children", async () => {
    const coord = coordinator({ mutationDeadlineMs: 30 });
    const running = coord.run({
      opId: "op_deadline",
      kind: "git-write",
      kbIds: ["kb1"],
      async run(ctx) {
        const cap = ctx.issueWriteCapability("kb1");
        await ctx.spawnMutatingChild({ argv: ["/bin/true"], cwd: "/tmp", capability: cap });
        await waitForAbort(ctx.signal);
      },
    });
    await expect(running).rejects.toMatchObject({ code: "DEADLINE_EXCEEDED" });
    expect(fake.drain).toHaveBeenCalled();
  });

  it("returns success when work settles before the deadline timer", async () => {
    const coord = coordinator({ mutationDeadlineMs: 50 });
    await expect(
      coord.run({
        opId: "op_fast",
        kind: "git-write",
        kbIds: ["kb1"],
        async run() {
          return "ok";
        },
      }),
    ).resolves.toBe("ok");
  });

  it("fails closed when child drain cannot be confirmed", async () => {
    const coord = coordinator();
    fake.drain.mockRejectedValue(new Error("supervisor drain failed"));
    await expect(
      coord.run({
        opId: "op_drain_fail",
        kind: "git-write",
        kbIds: ["kb1"],
        async run(ctx) {
          const cap = ctx.issueWriteCapability("kb1");
          await ctx.spawnMutatingChild({ argv: ["/bin/true"], cwd: "/tmp", capability: cap });
          return "ok";
        },
      }),
    ).rejects.toMatchObject({ code: "CONNECTION_LOST" });
  });

  it("does not admit a same-KB successor when drain cannot be confirmed", async () => {
    const coord = coordinator();
    let releaseDrain: (error: Error) => void = () => undefined;
    fake.drain.mockImplementation(
      () =>
        new Promise((_, reject) => {
          releaseDrain = (error) => reject(error);
        }),
    );
    let firstReady: () => void = () => undefined;
    const firstHeld = new Promise<void>((resolve) => {
      firstReady = resolve;
    });
    const first = coord.run({
      opId: "op_drain_hold",
      kind: "git-write",
      kbIds: ["kb_drain_hold"],
      async run(ctx) {
        const cap = ctx.issueWriteCapability("kb1");
        await ctx.spawnMutatingChild({ argv: ["/bin/true"], cwd: "/tmp", capability: cap });
        firstReady();
        ctx.lease.markLost();
        await waitForAbort(ctx.signal);
      },
    });
    await firstHeld;
    await delay(30);
    expect(fake.drain).toHaveBeenCalled();
    let secondStarted = false;
    const second = coord.run({
      opId: "op_drain_succ",
      kind: "git-write",
      kbIds: ["kb_drain_hold"],
      async run() {
        secondStarted = true;
        return "second";
      },
    });
    await delay(20);
    expect(secondStarted).toBe(false);
    releaseDrain(new Error("supervisor drain failed"));
    await expect(first).rejects.toMatchObject({ code: "CONNECTION_LOST" });
    await expect(second).rejects.toMatchObject({ code: "ADMISSION_CLOSED" });
    expect(secondStarted).toBe(false);
    expect(coord.admissionClosed).toBe(true);
    await expect(coord.shutdown()).rejects.toMatchObject({ code: "CONNECTION_LOST" });
  });

  it("drains a late spawn acknowledgement whose drain completes on a timer", async () => {
    const coord = coordinator();
    let releaseSpawn: (value: { pid: number }) => void = () => undefined;
    fake.spawn.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseSpawn = resolve;
        }),
    );
    let releaseDrain: () => void = () => undefined;
    fake.drain.mockImplementation(
      (_opId, pid) =>
        new Promise((resolve) => {
          releaseDrain = () => resolve({ opId: "op_late_io", pid, status: 0 });
        }),
    );
    const running = coord.run({
      opId: "op_late_io",
      kind: "git-write",
      kbIds: ["kb1"],
      async run(ctx) {
        const cap = ctx.issueWriteCapability("kb1");
        const spawned = ctx.spawnMutatingChild({
          argv: ["/bin/true"],
          cwd: "/tmp",
          capability: cap,
        });
        ctx.lease.markLost();
        await spawned;
      },
    });
    await delay(20);
    expect(fake.drain).not.toHaveBeenCalled();
    releaseSpawn({ pid: 99 });
    await delay(20);
    expect(fake.drain).toHaveBeenCalledWith("op_late_io", 99);
    let timerFired = false;
    const timer = delay(40).then(() => {
      timerFired = true;
    });
    await Promise.race([timer, running.catch(() => undefined)]);
    expect(timerFired).toBe(true);
    releaseDrain();
    await expect(running).rejects.toThrow();
  });

  it("reaps a child spawned after an earlier drain returned", async () => {
    const coord = coordinator();
    await coord.run({
      opId: "op_respawn",
      kind: "git-write",
      kbIds: ["kb1"],
      async run(ctx) {
        const cap = ctx.issueWriteCapability("kb1");
        queueMicrotask(() => {
          void ctx.spawnMutatingChild({
            argv: ["/bin/true"],
            cwd: "/tmp",
            capability: cap,
          });
        });
        return "ok";
      },
    });
    expect(fake.drain).toHaveBeenCalledWith("op_respawn", 4242);
  });

  it("does not drain a child that waitChild already reaped", async () => {
    const coord = coordinator();
    const receipts = new Map<string, { opId: string; pid: number; status: number }>();
    const take = (opId: string, pid: number) => {
      const key = `${opId}:${pid}`;
      const done = receipts.get(key);
      if (!done) throw new Error("operation not found");
      receipts.delete(key);
      return done;
    };
    fake.spawn.mockImplementation(async () => {
      receipts.set("op_wait_ok:7", { opId: "op_wait_ok", pid: 7, status: 0 });
      return { pid: 7 };
    });
    fake.wait.mockImplementation(async (opId, pid) => take(opId, pid));
    fake.drain.mockImplementation(async (opId, pid) => take(opId, pid));
    await expect(
      coord.run({
        opId: "op_wait_ok",
        kind: "git-write",
        kbIds: ["kb1"],
        async run(ctx) {
          const cap = ctx.issueWriteCapability("kb1");
          const child = await ctx.spawnMutatingChild({
            argv: ["/bin/true"],
            cwd: "/tmp",
            capability: cap,
          });
          const exit = await ctx.waitChild(child.pid);
          expect(exit.status).toBe(0);
          return "ok";
        },
      }),
    ).resolves.toBe("ok");
    expect(fake.drain).not.toHaveBeenCalled();
  });

  it("shares one completion between concurrent waitChild and drain", async () => {
    const coord = coordinator();
    let waitStarted: () => void = () => undefined;
    const waiting = new Promise<void>((resolve) => {
      waitStarted = resolve;
    });
    let finishWait: (value: { opId: string; pid: number; status: number }) => void = () =>
      undefined;
    fake.spawn.mockImplementation(async () => ({ pid: 11 }));
    fake.wait.mockImplementation(
      () =>
        new Promise((resolve) => {
          waitStarted();
          finishWait = resolve;
        }),
    );
    fake.drain.mockImplementation(async (opId, pid) => {
      const exit = { opId, pid, status: 0 };
      finishWait(exit);
      return exit;
    });
    await expect(
      coord.run({
        opId: "op_concur",
        kind: "git-write",
        kbIds: ["kb1"],
        async run(ctx) {
          const cap = ctx.issueWriteCapability("kb1");
          const child = await ctx.spawnMutatingChild({
            argv: ["/bin/sleep"],
            cwd: "/tmp",
            capability: cap,
          });
          void ctx.waitChild(child.pid);
          await waiting;
          return "ok";
        },
      }),
    ).resolves.toBe("ok");
    expect(fake.wait).toHaveBeenCalledWith("op_concur", 11);
    expect(fake.drain).toHaveBeenCalledWith("op_concur", 11);
  });

  it("exposes a process singleton for future publishers", async () => {
    const started = startKbWriteCoordinator({
      connectionString: "postgresql://kb_runtime_x:x@127.0.0.1:5432/kb_test_x",
      assertFence: () => fake.assertFence(),
      spawn: fake.spawn,
      wait: fake.wait,
      drain: fake.drain,
      closeAdmission: fake.closeAdmission,
    });
    expect(getKbWriteCoordinator()).toBe(started);
    await shutdownKbWriteCoordinator();
    expect(() => getKbWriteCoordinator()).toThrow(/not started/);
  });
});

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}
