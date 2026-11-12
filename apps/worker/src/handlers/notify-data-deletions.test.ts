import { captureLog } from "@knowledge-base/env/log";
import type { NotifyDataDeletionsJobData } from "@knowledge-base/queue";
import type { Job } from "bullmq";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  emailConfigured: true,
  list: vi.fn(),
  mark: vi.fn(),
  alert: vi.fn(),
}));
vi.mock("@knowledge-base/db/data-deletion-notices", () => ({
  listUnnotifiedDataDeletions: state.list,
  markDataDeletionNotified: state.mark,
}));
vi.mock("@knowledge-base/mailer", () => ({ isEmailConfigured: () => state.emailConfigured }));
// Real `@knowledge-base/queue` opens IORedis sockets at import; the job schema lives in
// the side-effect-free `@knowledge-base/queue/jobs`.
vi.mock("@knowledge-base/queue", async () => ({ ...(await import("@knowledge-base/queue/jobs")) }));
vi.mock("../operational-alerts.js", () => ({ sendDataDeletedAlert: state.alert }));

const { handleNotifyDataDeletionsJob } = await import("./notify-data-deletions.js");

const job = (data: unknown = { reason: "cron" }) =>
  ({ id: "job-1", data }) as unknown as Job<NotifyDataDeletionsJobData>;

const notice = (name: string) => ({
  name,
  effects: `table ${name}`,
  deletedAt: new Date("2026-11-01T10:00:00Z"),
  backup: "pre-migrate-2026-11-01",
  note: null,
});

let log: ReturnType<typeof captureLog>;
afterEach(() => log.restore());

beforeEach(() => {
  state.emailConfigured = true;
  state.list.mockReset().mockResolvedValue([]);
  state.mark.mockReset().mockResolvedValue(undefined);
  state.alert.mockReset().mockResolvedValue(undefined);
  log = captureLog();
});

describe("handleNotifyDataDeletionsJob", () => {
  it("reads nothing while email is not configured, so notices wait", async () => {
    state.emailConfigured = false;

    await expect(handleNotifyDataDeletionsJob(job())).resolves.toEqual({
      reason: "cron",
      notified: 0,
      retried: 0,
    });
    expect(state.list).not.toHaveBeenCalled();
  });

  it("is a no-op when there is nothing to report (or no runner table)", async () => {
    await expect(handleNotifyDataDeletionsJob(job())).resolves.toMatchObject({ notified: 0 });
    expect(state.alert).not.toHaveBeenCalled();
    expect(state.mark).not.toHaveBeenCalled();
  });

  it("sends one alert per deletion, marking each only after its send", async () => {
    const a = notice("20261010000000_drop_a");
    const b = notice("20261020000000_drop_b");
    state.list.mockResolvedValueOnce([a, b]);
    const order: string[] = [];
    state.alert.mockImplementation(async (n: { name: string }) => {
      order.push(`send ${n.name}`);
    });
    state.mark.mockImplementation(async (name: string) => {
      order.push(`mark ${name}`);
    });

    await expect(handleNotifyDataDeletionsJob(job())).resolves.toEqual({
      reason: "cron",
      notified: 2,
      retried: 0,
    });
    expect(order).toEqual([`send ${a.name}`, `mark ${a.name}`, `send ${b.name}`, `mark ${b.name}`]);
    expect(log.records.filter((record) => record.site === "worker.data-deletion")).toEqual([
      expect.objectContaining({ rowId: a.name }),
      expect.objectContaining({ rowId: b.name }),
    ]);
    expect(log.records.at(-1)).toMatchObject({
      site: "worker.data-deletions",
      jobId: "job-1",
      count: 2,
    });
  });

  // sendDataDeletedAlert throws when nobody was emailed (no admin, every send
  // failed, Redis down): the notice must stay unmarked so the next run retries.
  it("leaves a notice unmarked when its send fails, and still sends the rest", async () => {
    const a = notice("20261010000000_drop_a");
    const b = notice("20261020000000_drop_b");
    state.list.mockResolvedValueOnce([a, b]);
    state.alert.mockRejectedValueOnce(new Error("no admin was emailed"));

    await expect(handleNotifyDataDeletionsJob(job())).resolves.toMatchObject({
      notified: 1,
      retried: 1,
    });
    expect(log.records).toContainEqual(
      expect.objectContaining({
        site: "worker.data-deletion-send",
        rowId: a.name,
        errorClass: "Error",
      }),
    );
    expect(JSON.stringify(log.records)).not.toContain("no admin was emailed");
    expect(state.alert).toHaveBeenCalledTimes(2);
    expect(state.mark.mock.calls).toEqual([[b.name]]);
  });

  it("logs and carries on when recording a sent notice fails", async () => {
    const a = notice("20261010000000_drop_a");
    const b = notice("20261020000000_drop_b");
    state.list.mockResolvedValueOnce([a, b]);
    state.mark.mockRejectedValueOnce(new Error("db down"));

    await expect(handleNotifyDataDeletionsJob(job())).resolves.toMatchObject({ notified: 2 });

    expect(log.records).toContainEqual(
      expect.objectContaining({
        site: "worker.data-deletion-record",
        rowId: a.name,
        errorClass: "Error",
      }),
    );
    expect(JSON.stringify(log.records)).not.toContain("db down");
    expect(state.mark).toHaveBeenCalledWith(b.name);
  });

  it("rejects a payload the schema does not describe", async () => {
    await expect(handleNotifyDataDeletionsJob(job({ reason: "admin" }))).rejects.toThrow();
    expect(state.list).not.toHaveBeenCalled();
  });
});
