import {
  CHECK_BACKUP_FRESHNESS_CRON_PATTERN,
  CHECK_BACKUP_FRESHNESS_JOB_SCHEDULER_ID,
} from "@knowledge-base/queue/jobs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockEnv } = vi.hoisted(() => ({
  mockEnv: {
    BACKUP_ENABLED: true,
  },
}));

vi.mock("@knowledge-base/env/shared", () => ({
  env: mockEnv,
}));

// The scheduler needs only constants from the side-effect-free jobs module.
// Keep its `@knowledge-base/queue` import mocked: the production barrel constructs
// BullMQ queues (and IORedis clients) at module load.
vi.mock("@knowledge-base/queue", async () => {
  const jobs = await import("@knowledge-base/queue/jobs");
  return { ...jobs };
});

// Fail before any socket can be created if a future edit removes the queue
// boundary mock above. This factory is never reached by the intended graph.
vi.mock("ioredis", () => {
  throw new Error("backup-freshness scheduler tests must mock @knowledge-base/queue");
});

const { syncBackupFreshnessScheduler } = await import("./backup-freshness-scheduler.js");

describe("syncBackupFreshnessScheduler", () => {
  const upsertJobScheduler = vi.fn(async () => undefined);
  const removeJobScheduler = vi.fn(async () => undefined);
  const queue = { upsertJobScheduler, removeJobScheduler };

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.BACKUP_ENABLED = true;
  });

  it("upserts the stable scheduler id when backups are enabled", async () => {
    await expect(syncBackupFreshnessScheduler(queue)).resolves.toBe("upserted");
    expect(upsertJobScheduler).toHaveBeenCalledWith(
      CHECK_BACKUP_FRESHNESS_JOB_SCHEDULER_ID,
      { pattern: CHECK_BACKUP_FRESHNESS_CRON_PATTERN },
      { name: "check-backup-freshness", data: { reason: "cron" } },
    );
    expect(removeJobScheduler).not.toHaveBeenCalled();
  });

  it("removes the stable scheduler id when backups are disabled", async () => {
    mockEnv.BACKUP_ENABLED = false;

    await expect(syncBackupFreshnessScheduler(queue)).resolves.toBe("removed");
    expect(removeJobScheduler).toHaveBeenCalledWith(CHECK_BACKUP_FRESHNESS_JOB_SCHEDULER_ID);
    expect(upsertJobScheduler).not.toHaveBeenCalled();
  });
});
