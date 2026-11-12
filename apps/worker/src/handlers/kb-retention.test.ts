import type { KbRetentionJobData } from "@knowledge-base/queue/jobs";
import type { Job } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { Secret } = await vi.hoisted(() => import("@knowledge-base/env/secret"));

const { run, clean } = vi.hoisted(() => ({ run: vi.fn(), clean: vi.fn() }));
vi.mock("@knowledge-base/queue", () => ({ cleanExpiredQueuePayloads: clean }));
vi.mock("@knowledge-base/api/lib/kb/retention", () => ({ runKbRetention: run }));
vi.mock("@knowledge-base/env/shared", () => ({
  env: {
    DATABASE_URL: new Secret("postgres://runtime.invalid/kb"),
    KB_DATA_ROOT: "/var/lib/knowledge-base",
  },
}));

const { handleKbRetentionJob } = await import("./kb-retention.js");
const job = (data: unknown) => ({ id: "retention-1", data }) as unknown as Job<KbRetentionJobData>;

describe("handleKbRetentionJob", () => {
  beforeEach(() => {
    run.mockReset();
    clean.mockReset();
    clean.mockResolvedValue(0);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("runs the requested retention class against Postgres and the index directory", async () => {
    run.mockResolvedValue({ queryData: 3 });
    await expect(handleKbRetentionJob(job({ schedule: "minute" }))).resolves.toEqual({
      schedule: "minute",
      counts: { queryData: 3 },
      queuePayloads: 0,
    });
    expect(run).toHaveBeenCalledWith("minute", {
      connectionString: "postgres://runtime.invalid/kb",
      indexDir: "/var/lib/knowledge-base/index",
    });
    // Retention only ever receives the index directory, never repos or assets.
    expect(JSON.stringify(run.mock.calls)).not.toMatch(/knowledge-base\/(repos|assets)/);
  });

  it("runs the hourly class", async () => {
    run.mockResolvedValue({});
    await handleKbRetentionJob(job({ schedule: "hourly" }));
    expect(run.mock.calls[0]?.[0]).toBe("hourly");
    expect(clean).toHaveBeenCalledOnce();
  });

  it("cleans idle queues even when Postgres maintenance fails, and reports either failure", async () => {
    run.mockRejectedValueOnce(new Error("Postgres unavailable"));
    await expect(handleKbRetentionJob(job({ schedule: "hourly" }))).rejects.toThrow(
      "KB retention failed",
    );
    expect(clean).toHaveBeenCalledOnce();
    run.mockResolvedValue({});
    clean.mockRejectedValueOnce(new Error("Redis unavailable"));
    await expect(handleKbRetentionJob(job({ schedule: "hourly" }))).rejects.toThrow(
      "KB retention failed",
    );
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("rejects an unknown payload without running anything", async () => {
    await expect(handleKbRetentionJob(job({ schedule: "daily" }))).rejects.toThrow();
    await expect(handleKbRetentionJob(job({ schedule: "minute", now: 1 }))).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });
});
