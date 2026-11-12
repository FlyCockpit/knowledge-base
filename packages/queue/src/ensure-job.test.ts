import { describe, expect, it, vi } from "vitest";

import { ensureRunnableJob } from "./ensure-job.js";

function retainedJob(state: string) {
  return {
    getState: vi.fn().mockResolvedValue(state),
    retry: vi.fn().mockResolvedValue(undefined),
    updateData: vi.fn().mockResolvedValue(undefined),
  };
}

function changingJob(...states: string[]) {
  return {
    getState: vi.fn().mockImplementation(() => Promise.resolve(states.shift() ?? "unknown")),
    retry: vi.fn().mockResolvedValue(undefined),
    updateData: vi.fn().mockResolvedValue(undefined),
  };
}

describe("ensureRunnableJob", () => {
  it.each(["active", "waiting", "delayed", "prioritized", "waiting-children"])(
    "deduplicates a live %s job",
    async (state) => {
      const job = retainedJob(state);
      const queue = { getJob: vi.fn().mockResolvedValue(job), add: vi.fn() };

      await expect(ensureRunnableJob(queue as never, "work", { id: "1" }, "work-1")).resolves.toBe(
        job,
      );
      expect(job.retry).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
    },
  );

  it.each(["completed", "failed"])("requeues a retained %s job", async (state) => {
    const job = retainedJob(state);
    const queue = { getJob: vi.fn().mockResolvedValue(job), add: vi.fn() };

    await ensureRunnableJob(queue as never, "work", { id: "1" }, "work-1");

    expect(job.retry).toHaveBeenCalledWith(state);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it.each(["completed", "failed"])("requeues an initially added %s job", async (state) => {
    const added = retainedJob(state);
    const queue = {
      getJob: vi.fn().mockResolvedValue(null),
      add: vi.fn().mockResolvedValue(added),
    };

    await expect(ensureRunnableJob(queue as never, "work", { id: "1" }, "work-1")).resolves.toBe(
      added,
    );
    expect(added.retry).toHaveBeenCalledWith(state);
  });

  // The audit-trail bug: `retry()` re-runs the payload the FIRST publisher
  // wrote. A deduplicated job (`seed` has a constant jobId) therefore reported
  // whoever ran it first, forever, unless the retained job is re-stamped.
  it.each(["completed", "failed"])(
    "re-stamps a retained %s job with the new payload before retrying it",
    async (state) => {
      const job = retainedJob(state);
      const queue = { getJob: vi.fn().mockResolvedValue(job), add: vi.fn() };
      const order: string[] = [];
      job.updateData.mockImplementation(async () => {
        order.push("updateData");
      });
      job.retry.mockImplementation(async () => {
        order.push("retry");
      });

      await ensureRunnableJob(queue as never, "seed", { requestedBy: "second-admin" }, "seed");

      expect(job.updateData).toHaveBeenCalledWith({ requestedBy: "second-admin" });
      expect(order).toEqual(["updateData", "retry"]);
    },
  );

  it("leaves a live job's payload alone (dedupe means the work is already on its way)", async () => {
    const job = retainedJob("waiting");
    const queue = { getJob: vi.fn().mockResolvedValue(job), add: vi.fn() };

    await ensureRunnableJob(queue as never, "seed", { requestedBy: "second-admin" }, "seed");

    expect(job.updateData).not.toHaveBeenCalled();
  });

  it("reclassifies instead of retrying when the re-stamp fails", async () => {
    const stale = retainedJob("failed");
    stale.updateData.mockRejectedValue(new Error("missing key"));
    const live = retainedJob("waiting");
    const queue = {
      getJob: vi.fn().mockResolvedValueOnce(stale).mockResolvedValueOnce(live),
      add: vi.fn(),
    };

    await expect(ensureRunnableJob(queue as never, "work", { id: "1" }, "work-1")).resolves.toBe(
      live,
    );
    expect(stale.retry).not.toHaveBeenCalled();
  });

  it("fails visibly without mutating a job in BullMQ's ambiguous unknown state", async () => {
    const job = retainedJob("unknown");
    const queue = { getJob: vi.fn().mockResolvedValue(job), add: vi.fn() };

    await expect(ensureRunnableJob(queue as never, "work", { id: "1" }, "work-1")).rejects.toThrow(
      "Could not prove deterministic job work-1 runnable (state=unknown)",
    );
    expect(job.retry).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("re-adds when retention removes a terminal job during retry", async () => {
    const job = retainedJob("failed");
    job.retry.mockRejectedValue(new Error("missing key"));
    const added = retainedJob("waiting");
    const queue = {
      getJob: vi.fn().mockResolvedValueOnce(job).mockResolvedValueOnce(null),
      add: vi.fn().mockResolvedValue(added),
    };

    await expect(ensureRunnableJob(queue as never, "work", { id: "1" }, "work-1")).resolves.toBe(
      added,
    );
    expect(queue.add).toHaveBeenCalledWith("work", { id: "1" }, { jobId: "work-1" });
  });

  it("classifies a terminal job returned by an add after a retention race", async () => {
    const removed = retainedJob("failed");
    removed.retry.mockRejectedValue(new Error("missing key"));
    const added = retainedJob("completed");
    const queue = {
      getJob: vi.fn().mockResolvedValueOnce(removed).mockResolvedValueOnce(null),
      add: vi.fn().mockResolvedValue(added),
    };

    await expect(ensureRunnableJob(queue as never, "work", { id: "1" }, "work-1")).resolves.toBe(
      added,
    );
    expect(added.retry).toHaveBeenCalledWith("completed");
  });

  it("classifies a terminal job returned by the final retention-race add", async () => {
    const removed = retainedJob("failed");
    removed.retry.mockRejectedValue(new Error("missing key"));
    const added = retainedJob("failed");
    const queue = {
      // The previous implementation exhausted its three retry attempts, then
      // returned this add result without checking whether BullMQ deduplicated
      // it against another retained terminal job.
      getJob: vi
        .fn()
        .mockResolvedValueOnce(removed)
        .mockResolvedValueOnce(removed)
        .mockResolvedValueOnce(removed)
        .mockResolvedValueOnce(null),
      add: vi.fn().mockResolvedValue(added),
    };

    await expect(ensureRunnableJob(queue as never, "work", { id: "1" }, "work-1")).resolves.toBe(
      added,
    );
    expect(removed.retry).toHaveBeenCalledTimes(3);
    expect(added.retry).toHaveBeenCalledWith("failed");
  });

  it("reclassifies after another publisher retries a terminal job first", async () => {
    const stale = retainedJob("failed");
    stale.retry.mockRejectedValue(new Error("job is not in the failed state"));
    const live = retainedJob("waiting");
    const queue = {
      getJob: vi.fn().mockResolvedValueOnce(stale).mockResolvedValueOnce(live),
      add: vi.fn(),
    };

    await expect(ensureRunnableJob(queue as never, "work", { id: "1" }, "work-1")).resolves.toBe(
      live,
    );
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("re-reads an ambiguous removed handle before adding its replacement", async () => {
    const removed = changingJob("unknown");
    const added = retainedJob("waiting");
    const queue = {
      getJob: vi.fn().mockResolvedValueOnce(removed).mockResolvedValueOnce(null),
      add: vi.fn().mockResolvedValue(added),
    };

    await expect(ensureRunnableJob(queue as never, "work", { id: "1" }, "work-1")).resolves.toBe(
      added,
    );
  });
});
