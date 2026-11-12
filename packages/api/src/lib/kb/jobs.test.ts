import { captureLog } from "@knowledge-base/env/log";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DurableJobCancelledError, DurableJobFenceError, durableBullmqJobId } from "./jobs.js";

/** Literal backoff expectations, deliberately not derived from the implementation. */
const LITERAL_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000];

describe("durable job helpers", () => {
  it("builds deterministic BullMQ ids from job uuid and attempt epoch", () => {
    const id = "550e8400-e29b-41d4-a716-446655440000";
    expect(durableBullmqJobId(id, 3)).toBe(`${id}_e3`);
  });

  it("names fence and cancellation errors distinctly", () => {
    expect(new DurableJobFenceError().name).toBe("DurableJobFenceError");
    expect(new DurableJobCancelledError().name).toBe("DurableJobCancelledError");
  });
});

function createMockDb() {
  const db = {
    durableJob: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      upsert: vi.fn(),
      create: vi.fn(),
    },
    durableJobProbeEffect: { create: vi.fn(), findUnique: vi.fn() },
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
    $transaction: vi.fn(async (fn: (tx: typeof db) => Promise<unknown>) => fn(db)),
  };
  return db;
}

const updateManyCalls = () =>
  vi
    .mocked(db.durableJob.updateMany)
    .mock.calls.map(([arg]) => ({ where: arg.where, data: arg.data }));

let db: ReturnType<typeof createMockDb>;

describe("durable job state transitions (fake clock)", () => {
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  const at = (offsetMs: number) => new Date(base + offsetMs);

  beforeEach(() => {
    db = createMockDb();
  });

  it.each(["complete", "fail"] as const)(
    "selects only the fields consumed by %s, including for a missing job",
    async (operation) => {
      const { completeJobAttempt, failJobAttempt } = await import("./jobs.js");
      const input = { jobId: "j1", workerId: "w1", attemptEpoch: 1, now: at(0) };
      const row = {
        state: "RUNNING",
        cancelledAt: null,
        workerOwner: "w1",
        attemptEpoch: 1,
        ...(operation === "fail" ? { attemptCount: 0 } : {}),
      };
      db.durableJob.findUnique.mockResolvedValueOnce(row).mockResolvedValueOnce(null);
      db.durableJob.updateMany.mockResolvedValue({ count: 1 });
      const run = () =>
        operation === "complete"
          ? completeJobAttempt(db as never, input)
          : failJobAttempt(db as never, { ...input, error: "boom" });

      await expect(run()).resolves.toEqual(
        operation === "complete" ? true : { state: "RETRY", attemptCount: 1 },
      );
      await expect(run()).resolves.toBe(operation === "complete" ? false : null);
      for (const [query] of db.durableJob.findUnique.mock.calls) {
        expect(query).toEqual({
          where: { id: "j1" },
          select: Object.fromEntries(Object.keys(row).map((key) => [key, true])),
        });
      }
      expect(db.durableJob.updateMany).toHaveBeenCalledTimes(1);
    },
  );

  it("persists five literal backoff deadlines then fails closed", async () => {
    const { failJobAttempt, EXPIRED_LEASE_ERROR } = await import("./jobs.js");
    const jobId = "550e8400-e29b-41d4-a716-446655440000";
    let attemptCount = 0;
    let attemptEpoch = 1;
    db.durableJob.findUnique.mockImplementation(async () => ({
      id: jobId,
      state: "RUNNING",
      workerOwner: "w1",
      attemptEpoch,
      attemptCount,
      cancelledAt: null,
    }));
    db.durableJob.updateMany.mockImplementation(
      async ({
        where,
        data,
      }: {
        where: { state?: string };
        data: {
          state?: string;
          attemptCount?: number;
          attemptEpoch?: { increment: number };
          nextRunAt?: Date;
          lastError?: string;
        };
      }) => {
        // Simulate the persisted effect of the fenced write.
        expect(where.state).toBe("RUNNING");
        if (data.attemptCount !== undefined) attemptCount = data.attemptCount;
        if (data.attemptEpoch?.increment) attemptEpoch += data.attemptEpoch.increment;
        return { count: 1 };
      },
    );

    for (let i = 1; i <= LITERAL_RETRY_DELAYS_MS.length; i++) {
      const epochBefore = attemptEpoch;
      const now = at(i * 100_000);
      const result = await failJobAttempt(db as never, {
        jobId,
        workerId: "w1",
        attemptEpoch: epochBefore,
        now,
        error: "boom",
      });
      expect(result, `retry ${i}`).toEqual({ state: "RETRY", attemptCount: i });
      const call = updateManyCalls().at(-1)!;
      expect(call.data.state).toBe("RETRY");
      expect(call.data.attemptCount).toBe(i);
      expect(call.data.attemptEpoch).toEqual({ increment: 1 });
      expect(call.data.nextRunAt, `literal delay for retry ${i}`).toEqual(
        new Date(now.getTime() + LITERAL_RETRY_DELAYS_MS[i - 1]!),
      );
      expect(attemptEpoch).toBe(epochBefore + 1);
    }

    const terminal = await failJobAttempt(db as never, {
      jobId,
      workerId: "w1",
      attemptEpoch: attemptEpoch,
      now: at(600_000),
      error: "boom",
    });
    expect(terminal).toEqual({ state: "FAILED", attemptCount: LITERAL_RETRY_DELAYS_MS.length + 1 });
    const call = updateManyCalls().at(-1)!;
    expect(call.data.state).toBe("FAILED");
    expect(call.data.attemptCount).toBe(LITERAL_RETRY_DELAYS_MS.length + 1);
    expect(call.data.nextRunAt).toBeUndefined();
    expect(call.data.lastError).toBe("boom");
    expect(EXPIRED_LEASE_ERROR).toBe("worker lease expired");
  });

  it("throws the fence when the fenced failure write matches no row", async () => {
    const { failJobAttempt } = await import("./jobs.js");
    db.durableJob.findUnique.mockResolvedValue({
      id: "j1",
      state: "RUNNING",
      workerOwner: "w1",
      attemptEpoch: 1,
      attemptCount: 0,
      cancelledAt: null,
    });
    db.durableJob.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      failJobAttempt(db as never, {
        jobId: "j1",
        workerId: "w1",
        attemptEpoch: 1,
        now: at(0),
        error: "boom",
      }),
    ).rejects.toBeInstanceOf(DurableJobFenceError);
  });

  it("rejects completion when worker or epoch does not match", async () => {
    const { completeJobAttempt } = await import("./jobs.js");
    db.durableJob.findUnique.mockResolvedValue({
      id: "j1",
      state: "RUNNING",
      workerOwner: "other",
      attemptEpoch: 2,
      cancelledAt: null,
    });
    await expect(
      completeJobAttempt(db as never, {
        jobId: "j1",
        workerId: "w1",
        attemptEpoch: 2,
        now: at(0),
      }),
    ).rejects.toBeInstanceOf(DurableJobFenceError);
  });

  it("reports a stolen completion as false rather than success", async () => {
    const { completeJobAttempt } = await import("./jobs.js");
    db.durableJob.findUnique.mockResolvedValue({
      id: "j1",
      state: "RUNNING",
      workerOwner: "w1",
      attemptEpoch: 1,
      cancelledAt: null,
    });
    db.durableJob.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      completeJobAttempt(db as never, {
        jobId: "j1",
        workerId: "w1",
        attemptEpoch: 1,
        now: at(0),
      }),
    ).resolves.toBe(false);
  });

  it("claims worker attempts from PUBLISHED with one atomic UPDATE … RETURNING", async () => {
    const { claimJobAttempt } = await import("./jobs.js");
    const claimedRow = { id: "j1", state: "RUNNING", workerOwner: "w1", attemptEpoch: 4 };
    db.$queryRaw.mockResolvedValue([claimedRow]);
    const now = at(0);
    const claimed = await claimJobAttempt(db as never, {
      jobId: "j1",
      workerId: "w1",
      now,
    });
    expect(claimed).toBe(claimedRow);
    // The claim and the returned fence are exactly one statement: no follow-up
    // unrestricted read can observe a later, replacement attempt's fence.
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
    expect(db.durableJob.updateMany).not.toHaveBeenCalled();
    expect(db.durableJob.findUnique).not.toHaveBeenCalled();
    const call = vi.mocked(db.$queryRaw).mock.calls[0]!;
    const sql = (call[0] as readonly string[]).join("$");
    expect(sql).toContain("UPDATE durable_job");
    expect(sql).toContain("SET state = 'RUNNING'");
    expect(sql).toContain(`"workerOwner" =`);
    expect(sql).toContain(`"dispatchOwner" = NULL`);
    expect(sql).toContain(`"dispatchClaimUntil" = NULL`);
    expect(sql).toContain("WHERE id =");
    expect(sql).toContain(`state = 'PUBLISHED'`);
    expect(sql).toContain(`"cancelledAt" IS NULL`);
    expect(sql).toContain(`("leaseUntil" IS NULL OR "leaseUntil" <`);
    expect(sql).toContain("RETURNING *");
    expect(call.slice(1)).toEqual([now, "w1", new Date(now.getTime() + 30_000), now, "j1", now]);
  });

  it("refuses worker claims that match no publishable row", async () => {
    const { claimJobAttempt } = await import("./jobs.js");
    db.$queryRaw.mockResolvedValue([]);
    await expect(
      claimJobAttempt(db as never, { jobId: "j1", workerId: "w1", now: at(0) }),
    ).resolves.toBeNull();
    expect(db.durableJob.updateMany).not.toHaveBeenCalled();
    expect(db.durableJob.findUnique).not.toHaveBeenCalled();
  });

  it("never acknowledges a publication over a RUNNING row", async () => {
    const { markDispatchPublished } = await import("./jobs.js");
    db.durableJob.updateMany.mockResolvedValue({ count: 1 });
    const marked = await markDispatchPublished(db as never, {
      jobId: "j1",
      owner: "d1",
      now: at(0),
    });
    expect(marked).toBe(true);
    const call = updateManyCalls()[0]!;
    expect(call.where.dispatchOwner).toBe("d1");
    expect(call.where.cancelledAt).toBeNull();
    const arms = call.where.OR as Array<Record<string, unknown>>;
    expect(arms).toHaveLength(2);
    expect(arms[0]).toEqual({ state: { in: ["PENDING", "RETRY"] } });
    expect(arms[1]).toEqual({ state: "PUBLISHED", workerOwner: null, leaseUntil: null });
    const acceptedStates = JSON.stringify([arms[0], arms[1]]);
    expect(acceptedStates).not.toContain("RUNNING");
    expect(call.data.state).toBe("PUBLISHED");
  });

  it("recovers an expired RUNNING row as a fenced retry instead of republishing it", async () => {
    const { claimDispatchBatch, EXPIRED_LEASE_ERROR } = await import("./jobs.js");
    const now = at(0);
    db.$queryRaw.mockResolvedValue([
      { id: "pending", kind: "PROBE", attemptEpoch: 1, state: "PENDING", attemptCount: 0 },
      { id: "expired", kind: "PROBE", attemptEpoch: 4, state: "RUNNING", attemptCount: 2 },
    ]);
    db.durableJob.updateMany.mockResolvedValue({ count: 1 });

    const batch = await claimDispatchBatch(db as never, { owner: "d1", now });

    expect(batch.map((row) => row.id)).toEqual(["pending"]);
    const recovery = updateManyCalls().find((call) => call.where.id === "expired")!;
    expect(recovery.where).toEqual({
      id: "expired",
      state: "RUNNING",
      leaseUntil: { lt: now },
    });
    expect(recovery.data.state).toBe("RETRY");
    expect(recovery.data.attemptCount).toBe(3);
    expect(recovery.data.attemptEpoch).toEqual({ increment: 1 });
    expect(recovery.data.nextRunAt).toEqual(new Date(now.getTime() + 4_000));
    expect(recovery.data.lastError).toBe(EXPIRED_LEASE_ERROR);
    expect(recovery.data.workerOwner).toBeNull();
    expect(recovery.data.dispatchOwner).toBeNull();
    const claim = updateManyCalls().find((call) => call.where.id !== "expired")!;
    expect(claim.where).toEqual({ id: { in: ["pending"] } });
    expect(claim.data.dispatchOwner).toBe("d1");
    expect(claim.data.dispatchClaimUntil).toEqual(new Date(now.getTime() + 30_000));
  });

  it("contains a failed lease recovery in its own savepoint; the batch still dispatches", async () => {
    const { claimDispatchBatch } = await import("./jobs.js");
    const log = captureLog();
    db.$queryRaw.mockResolvedValue([
      { id: "broken", kind: "PROBE", attemptEpoch: 2, state: "RUNNING", attemptCount: 1 },
      { id: "pending", kind: "PROBE", attemptEpoch: 1, state: "PENDING", attemptCount: 0 },
    ]);
    db.durableJob.updateMany.mockImplementation(async (arg: { where: { id: unknown } }) => {
      if (arg.where.id === "broken") throw new Error("secret detail");
      return { count: 1 };
    });

    const batch = await claimDispatchBatch(db as never, { owner: "d1", now: at(0) });

    expect(batch.map((row) => row.id)).toEqual(["pending"]);
    const statements = vi
      .mocked(db.$executeRaw)
      .mock.calls.map(([template]) => (template as readonly string[]).join("?"));
    expect(statements).toEqual([
      "SAVEPOINT dispatch_recover_lease",
      "ROLLBACK TO SAVEPOINT dispatch_recover_lease",
    ]);
    // The failed row is deferred one claim window, so it can't head every batch.
    expect(db.durableJob.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["broken"] }, state: "RUNNING" },
      data: { dispatchClaimUntil: new Date(at(0).getTime() + 30_000) },
    });
    // A fixed record: the row and a code, never the error's own text.
    log.restore();
    expect(log.records).toEqual([
      {
        level: "error",
        site: "kb.dispatch-recovery",
        message: "expired job lease recovery failed; the job stays running",
        errorClass: "Error",
        jobId: "broken",
        kind: "PROBE",
      },
    ]);
  });

  it("fails an expired RUNNING row closed once the retry budget is exhausted", async () => {
    const { claimDispatchBatch } = await import("./jobs.js");
    db.$queryRaw.mockResolvedValue([
      { id: "expired", kind: "PROBE", attemptEpoch: 9, state: "RUNNING", attemptCount: 5 },
    ]);
    db.durableJob.updateMany.mockResolvedValue({ count: 1 });

    const batch = await claimDispatchBatch(db as never, { owner: "d1", now: at(0) });

    expect(batch).toEqual([]);
    const recovery = updateManyCalls().at(-1)!;
    expect(recovery.data.state).toBe("FAILED");
    expect(recovery.data.attemptCount).toBe(6);
    expect(recovery.data.attemptEpoch).toBeUndefined();
    expect(recovery.data.nextRunAt).toBeUndefined();
  });

  it("admits dispatch only for due PENDING/RETRY rows under SKIP LOCKED", async () => {
    const { claimDispatchBatch } = await import("./jobs.js");
    db.$queryRaw.mockResolvedValue([]);
    db.durableJob.updateMany.mockResolvedValue({ count: 0 });
    await claimDispatchBatch(db as never, { owner: "d1", now: at(0) });
    const template = vi.mocked(db.$queryRaw).mock.calls[0]![0] as readonly string[];
    const sql = template.join("$");
    expect(sql).toContain(`state IN ('PENDING', 'RETRY') AND "nextRunAt" <=`);
    expect(sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(db.durableJob.updateMany).not.toHaveBeenCalled();
  });
});
