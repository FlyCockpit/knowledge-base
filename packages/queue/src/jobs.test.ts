import { describe, expect, it } from "vitest";
import {
  NOTIFY_DATA_DELETIONS_CRON_PATTERN,
  NOTIFY_DATA_DELETIONS_JOB_SCHEDULER_ID,
  notifyDataDeletionsJobSchema,
  QUEUE_NAMES,
} from "./jobs.js";

describe("data deletion notice jobs", () => {
  it("accepts only the cron payload", () => {
    expect(notifyDataDeletionsJobSchema.parse({ reason: "cron" })).toEqual({ reason: "cron" });
    for (const data of [{}, { reason: "manual" }, { reason: "cron", migration: "untrusted" }])
      expect(notifyDataDeletionsJobSchema.safeParse(data).success).toBe(false);
  });
  it("uses one stable queue and fifteen-minute schedule", () => {
    expect(QUEUE_NAMES.notifyDataDeletions).toBe(NOTIFY_DATA_DELETIONS_JOB_SCHEDULER_ID);
    expect(NOTIFY_DATA_DELETIONS_CRON_PATTERN).toBe("*/15 * * * *");
  });
});
