import type { Client } from "pg";
import { describe, expect, it } from "vitest";
import { mockDeep } from "vitest-mock-extended";

import {
  assertLockOrder,
  canonicalLockSequence,
  enqueueKbOperation,
  HeldLockLease,
  isKbOperationGateSealed,
  isRolledBackTransactionError,
  KbLockError,
  kbLockObjid,
  LOCK_WAIT_MS,
  MUTATION_DEADLINE_MS,
  MutationScope,
  requireOperationLease,
  sealKbOperationGate,
} from "./lock";

describe("lock order", () => {
  it("accepts authority then sorted knowledge-base ids", () => {
    expect(() =>
      assertLockOrder([
        { kind: "authority" },
        { kind: "kb", kbId: "a" },
        { kind: "kb", kbId: "b" },
      ]),
    ).not.toThrow();
    expect(canonicalLockSequence({ authority: true, kbIds: ["b", "a", "b"] })).toEqual([
      { kind: "authority" },
      { kind: "kb", kbId: "a" },
      { kind: "kb", kbId: "b" },
    ]);
  });

  it("fails a reverse authority/kb sequence before any lock is taken", () => {
    expect(() => assertLockOrder([{ kind: "kb", kbId: "a" }, { kind: "authority" }])).toThrow(
      KbLockError,
    );
    try {
      assertLockOrder([{ kind: "kb", kbId: "a" }, { kind: "authority" }]);
    } catch (error) {
      expect(error).toMatchObject({ code: "LOCK_ORDER" });
    }
  });

  it("fails unsorted and duplicate knowledge-base ids", () => {
    expect(() =>
      assertLockOrder([
        { kind: "kb", kbId: "z" },
        { kind: "kb", kbId: "a" },
      ]),
    ).toThrow(/sorted/);
    expect(() =>
      assertLockOrder([
        { kind: "kb", kbId: "a" },
        { kind: "kb", kbId: "a" },
      ]),
    ).toThrow(/duplicate/);
    expect(() => assertLockOrder([])).toThrow(/empty/);
  });

  it("rejects incremental sequences that invert the global order", () => {
    expect(() => assertLockOrder([{ kind: "kb", kbId: "z" }, { kind: "authority" }])).toThrow(
      /authority lock must be acquired before/,
    );
    expect(() =>
      assertLockOrder([
        { kind: "kb", kbId: "z" },
        { kind: "kb", kbId: "a" },
      ]),
    ).toThrow(/sorted/);
    expect(() =>
      assertLockOrder([{ kind: "authority" }, { kind: "kb", kbId: "a" }, { kind: "authority" }]),
    ).toThrow(/more than once/);
    expect(() =>
      assertLockOrder([
        { kind: "authority" },
        { kind: "kb", kbId: "a" },
        { kind: "kb", kbId: "b" },
      ]),
    ).not.toThrow();
  });

  it("hashes knowledge-base ids to a stable non-zero int4", () => {
    expect(kbLockObjid("kb_alpha")).toBe(kbLockObjid("kb_alpha"));
    expect(kbLockObjid("kb_alpha")).not.toBe(kbLockObjid("kb_beta"));
    expect(kbLockObjid("kb_alpha")).not.toBe(0);
  });
});

describe("operation context", () => {
  it("requires a parent lease instead of acquiring another lock", () => {
    expect(() => requireOperationLease()).toThrow(/parent's operation context/);
  });

  it("exports the documented wait and mutation bounds", () => {
    expect(LOCK_WAIT_MS).toBe(5_000);
    expect(MUTATION_DEADLINE_MS).toBe(30_000);
  });
});

describe("in-process acquisition gate", () => {
  it("times out a waiter without running its callback or releasing the predecessor", async () => {
    let firstDone = false;
    let releaseFirst: () => void = () => undefined;
    const firstHold = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = enqueueKbOperation("kb_gate_timeout", async () => {
      await firstHold;
      firstDone = true;
    });
    let secondRan = false;
    const second = enqueueKbOperation(
      "kb_gate_timeout",
      async () => {
        secondRan = true;
      },
      { deadlineAt: Date.now() + 40, now: Date.now, opId: "op_gate_wait" },
    );
    await expect(second).rejects.toMatchObject({ code: "LOCK_TIMEOUT" });
    expect(secondRan).toBe(false);
    expect(firstDone).toBe(false);
    releaseFirst();
    await first;
    expect(firstDone).toBe(true);
  });

  it("clears the acquisition timer once the callback is admitted", async () => {
    let callbackFinished = false;
    const result = await enqueueKbOperation(
      "kb_gate_admitted",
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 80));
        callbackFinished = true;
        return "ran";
      },
      { deadlineAt: Date.now() + 40, now: Date.now, opId: "op_gate_admitted" },
    );
    expect(result).toBe("ran");
    expect(callbackFinished).toBe(true);
  });

  it("does not abort an admitted callback when the wait signal fires later", async () => {
    const abort = new AbortController();
    let callbackFinished = false;
    let started: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const running = enqueueKbOperation(
      "kb_gate_signal",
      async () => {
        started();
        await new Promise((resolve) => setTimeout(resolve, 40));
        callbackFinished = true;
        return "ran";
      },
      {
        deadlineAt: Date.now() + 5_000,
        now: Date.now,
        signal: abort.signal,
        opId: "op_gate_signal",
      },
    );
    await entered;
    abort.abort();
    await expect(running).resolves.toBe("ran");
    expect(callbackFinished).toBe(true);
  });

  it("never admits a successor after the knowledge-base gate is sealed", async () => {
    sealKbOperationGate("kb_gate_sealed");
    expect(isKbOperationGateSealed("kb_gate_sealed")).toBe(true);
    let ran = false;
    await expect(
      enqueueKbOperation("kb_gate_sealed", async () => {
        ran = true;
      }),
    ).rejects.toMatchObject({ code: "ADMISSION_CLOSED" });
    expect(ran).toBe(false);
  });
});

describe("mutation lifetime", () => {
  it("joins an in-flight reservation COMMIT on shutdown and permits committed reconciliation", () => {
    const scope = new MutationScope("commit");
    try {
      scope.beginReservationCommit();
      scope.requestShutdown();
      expect(scope.signal.aborted).toBe(false);
      scope.finishReservationCommit(true);
      scope.assertActive();
      expect(scope.signal.aborted).toBe(false);
    } finally {
      scope.dispose();
    }
  });

  it("cancels on shutdown if the in-flight reservation COMMIT failed", () => {
    const scope = new MutationScope("failed_commit");
    try {
      scope.beginReservationCommit();
      scope.requestShutdown();
      scope.finishReservationCommit(false);
      expect(scope.signal.reason).toMatchObject({ code: "ADMISSION_CLOSED" });
    } finally {
      scope.dispose();
    }
  });

  it("never starts a reservation COMMIT after cancellation or accepts success past the absolute deadline", () => {
    let now = 100;
    const scope = new MutationScope("deadline", () => now, 200);
    try {
      now = 200;
      expect(() => scope.beginReservationCommit()).toThrow(/deadline exceeded/);
      expect(() => scope.assertActive()).toThrow(/deadline exceeded/);
      expect(scope.signal.reason).toMatchObject({ code: "DEADLINE_EXCEEDED" });
    } finally {
      scope.dispose();
    }
  });
});

describe("transaction rollback evidence", () => {
  async function failedTransaction(
    failure: "callback" | "timeout-setting" | "cancel-before-commit" | "commit",
    error: Error,
    rollbackFails = false,
    loseLease = false,
  ) {
    const client = mockDeep<Client>();
    const scope = new MutationScope("rollback-evidence");
    const lease = new HeldLockLease({
      client,
      scope,
      opId: scope.opId,
      backendPid: 1,
      abort: new AbortController(),
    });
    let callbackDone = false;
    const commands: string[] = [];
    client.query.mockImplementation(async (statement) => {
      const sql = typeof statement === "string" ? statement : statement.text;
      commands.push(sql);
      if (sql === "ROLLBACK" && rollbackFails) throw new Error("rollback failed");
      if (callbackDone && sql.startsWith("SET statement_timeout") && failure === "timeout-setting")
        throw error;
      if (sql === "COMMIT" && failure === "commit") {
        if (loseLease) lease.markLost();
        throw error;
      }
      return { rows: [], rowCount: 0 };
    });
    try {
      const result = await lease
        .transaction(async () => {
          callbackDone = true;
          if (failure === "callback") throw error;
          if (failure === "cancel-before-commit") scope.cancel(error);
        })
        .catch((caught: unknown) => caught);
      return { error: result, commands: [...commands], lost: lease.connectionLost };
    } finally {
      await lease.close();
      scope.dispose();
    }
  }

  it.each(["callback", "timeout-setting", "cancel-before-commit"] as const)(
    "confirms rollback for a %s failure before COMMIT is sent, preserving the error",
    async (failure) => {
      const error = new Error(failure);
      const result = await failedTransaction(failure, error);
      expect(result.error).toBe(error);
      expect(result.commands).not.toContain("COMMIT");
      expect(result.commands.at(-1)).toBe("ROLLBACK");
      expect(isRolledBackTransactionError(result.error)).toBe(true);
    },
  );

  it("confirms a server-rejected COMMIT only after successful rollback", async () => {
    const error = Object.assign(new Error("serialization failure"), { code: "40001" });
    const result = await failedTransaction("commit", error);
    expect(result.error).toBe(error);
    expect(result.commands.slice(-2)).toEqual(["COMMIT", "ROLLBACK"]);
    expect(result.lost).toBe(false);
    expect(isRolledBackTransactionError(result.error)).toBe(true);
  });

  it.each([
    { error: new Error("client failure after dispatch"), rollbackFails: false, loseLease: false },
    {
      error: Object.assign(new Error("connection lost"), { code: "ECONNRESET" }),
      rollbackFails: false,
      loseLease: false,
    },
    {
      error: Object.assign(new Error("server failure"), { code: "40001" }),
      rollbackFails: true,
      loseLease: false,
    },
    {
      error: Object.assign(new Error("server failure"), { code: "40001" }),
      rollbackFails: false,
      loseLease: true,
    },
  ])(
    "does not confirm an uncertain or lost-session COMMIT: %o",
    async ({ error, rollbackFails, loseLease }) => {
      const result = await failedTransaction("commit", error, rollbackFails, loseLease);
      expect(result.commands).toContain("ROLLBACK");
      expect(isRolledBackTransactionError(result.error)).toBe(false);
    },
  );

  it("does not confirm a pre-COMMIT failure when rollback fails", async () => {
    const result = await failedTransaction("callback", new Error("callback"), true);
    expect(result.lost).toBe(true);
    expect(isRolledBackTransactionError(result.error)).toBe(false);
  });
});
