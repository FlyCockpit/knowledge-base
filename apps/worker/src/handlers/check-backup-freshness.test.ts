import { captureLog } from "@knowledge-base/env/log";
import type { CheckBackupFreshnessJobData } from "@knowledge-base/queue";
import type { Job } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { Secret } = await vi.hoisted(() => import("@knowledge-base/env/secret"));

const { mockEnv } = vi.hoisted(() => ({
  mockEnv: {
    BACKUP_ENABLED: true,
    BACKUP_S3_BUCKET: "backups",
    BACKUP_S3_PREFIX: "database",
    BACKUP_S3_REGION: "auto",
    BACKUP_S3_ENDPOINT: "https://backup.example.com",
    BACKUP_MONITOR_S3_ACCESS_KEY_ID: new Secret("test-key"),
    BACKUP_MONITOR_S3_SECRET_ACCESS_KEY: new Secret("test-secret"),
    BACKUP_MAX_AGE_HOURS: 36,
    DATABASE_URL: new Secret("postgresql://test:test@localhost:5432/test"),
  },
}));

vi.mock("@knowledge-base/env/shared", () => ({
  env: mockEnv,
}));

const s3Send = vi.fn();
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    send = s3Send;
  },
  ListObjectsV2Command: class {},
}));

const checkBackupFreshness = vi.fn();
const writeBackupFreshness = vi.fn();
vi.mock("@knowledge-base/api/lib/backup-freshness", async () => {
  const actual = await import("@knowledge-base/api/lib/backup-freshness");
  return {
    backupFreshnessNeedsAttention: actual.backupFreshnessNeedsAttention,
    checkBackupFreshness,
    writeBackupFreshness,
  };
});

// Real `@knowledge-base/queue` opens IORedis sockets at import; `@knowledge-base/queue/jobs`
// is the side-effect-free half, so the job schema is real and Redis is a stub.
const redisConnection = { set: vi.fn(), get: vi.fn() };
vi.mock("@knowledge-base/queue", async () => {
  const jobs = await import("@knowledge-base/queue/jobs");
  return { ...jobs, redisConnection };
});

const sendOperationalAlert = vi.fn();
vi.mock("../operational-alerts.js", () => ({
  sendOperationalAlert,
  escapeHtml: (value: string) => value,
}));

const { handleCheckBackupFreshnessJob } = await import("./check-backup-freshness.js");

const job = () =>
  ({ id: "job-1", data: { reason: "cron" } }) as unknown as Job<CheckBackupFreshnessJobData>;

const fresh = {
  state: "fresh" as const,
  checkedAt: "2026-09-08T12:00:00.000Z",
  latestKey: "database/backup-a.dump",
  latestAt: "2026-09-08T03:00:00.000Z",
  ageHours: 9,
  maxAgeHours: 36,
};

describe("handleCheckBackupFreshnessJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockEnv.BACKUP_ENABLED = true;
  });

  it("skips queued work when logical backups are disabled", async () => {
    mockEnv.BACKUP_ENABLED = false;

    await expect(handleCheckBackupFreshnessJob(job())).resolves.toBeNull();

    expect(checkBackupFreshness).not.toHaveBeenCalled();
    expect(writeBackupFreshness).not.toHaveBeenCalled();
    expect(sendOperationalAlert).not.toHaveBeenCalled();
  });

  it("records a fresh verdict and stays quiet", async () => {
    checkBackupFreshness.mockResolvedValue(fresh);

    await expect(handleCheckBackupFreshnessJob(job())).resolves.toEqual(fresh);

    expect(writeBackupFreshness).toHaveBeenCalledWith(redisConnection, fresh);
    expect(sendOperationalAlert).not.toHaveBeenCalled();
  });

  it("alerts admins when the backup config itself is unusable", async () => {
    // No dump will ever land in this state, so it has to alert like a stale
    // backup rather than passing silently as "backups are off".
    const misconfigured = {
      state: "misconfigured" as const,
      checkedAt: fresh.checkedAt,
      maxAgeHours: 36,
      reason: "BACKUP_S3_REGION must be a real AWS region.",
    };
    checkBackupFreshness.mockResolvedValue(misconfigured);

    await expect(handleCheckBackupFreshnessJob(job())).resolves.toEqual(misconfigured);

    expect(writeBackupFreshness).toHaveBeenCalledWith(redisConnection, misconfigured);
    expect(sendOperationalAlert).toHaveBeenCalledTimes(1);
    expect(sendOperationalAlert.mock.calls[0]?.[0]?.html).toContain(
      "BACKUP_S3_REGION must be a real AWS region.",
    );
  });

  it("alerts admins on a stale verdict with a daily cooldown", async () => {
    const stale = { ...fresh, state: "stale" as const, ageHours: 60 };
    checkBackupFreshness.mockResolvedValue(stale);

    await handleCheckBackupFreshnessJob(job());

    expect(writeBackupFreshness).toHaveBeenCalledWith(redisConnection, stale);
    expect(sendOperationalAlert).toHaveBeenCalledTimes(1);
    const alert = sendOperationalAlert.mock.calls[0]?.[0];
    expect(alert).toMatchObject({
      source: "check-backup-freshness",
      message: "stale",
      cooldownSeconds: 24 * 60 * 60,
    });
    expect(alert.html).toContain("database/backup-a.dump");
    expect(alert.html).toContain("backups");
  });

  it("treats an empty bucket and a listing error as attention states", async () => {
    checkBackupFreshness.mockResolvedValueOnce({
      state: "empty",
      checkedAt: fresh.checkedAt,
      maxAgeHours: 36,
    });
    await handleCheckBackupFreshnessJob(job());

    checkBackupFreshness.mockResolvedValueOnce({
      state: "error",
      checkedAt: fresh.checkedAt,
      maxAgeHours: 36,
      message: "listing failed (AccessDenied)",
    });
    await handleCheckBackupFreshnessJob(job());

    expect(sendOperationalAlert).toHaveBeenCalledTimes(2);
    expect(sendOperationalAlert.mock.calls[1]?.[0]?.html).toContain("AccessDenied");
  });

  it.each(["AccessDenied", "CanaryToken123"])(
    "keeps upstream credentials out of the verdict, Redis, logs and alert email (%s)",
    async (name) => {
      const log = captureLog();
      try {
        const real = await vi.importActual<
          typeof import("@knowledge-base/api/lib/backup-freshness")
        >("@knowledge-base/api/lib/backup-freshness");
        const canary = "CanaryToken123";
        s3Send.mockRejectedValueOnce(
          Object.assign(new Error(`https://key:${canary}@backup.example.com`), { name }),
        );
        checkBackupFreshness.mockImplementationOnce(() => real.checkBackupFreshness());
        writeBackupFreshness.mockImplementationOnce(real.writeBackupFreshness);
        const status = await handleCheckBackupFreshnessJob(job());
        const message =
          name === "AccessDenied"
            ? "listing failed (AccessDenied)"
            : "listing failed (LISTING_FAILED)";
        expect(status).toMatchObject({ state: "error", message });
        expect(redisConnection.set).toHaveBeenCalledOnce();
        expect(sendOperationalAlert.mock.lastCall?.[0].html).toContain(message);
        expect(
          JSON.stringify({
            status,
            redis: redisConnection.set.mock.calls,
            logs: log.records,
            email: sendOperationalAlert.mock.calls,
          }),
        ).not.toContain(canary);
      } finally {
        log.restore();
      }
    },
  );

  it("still records the verdict before alerting, so the dashboard never lags the email", async () => {
    const stale = { ...fresh, state: "stale" as const };
    checkBackupFreshness.mockResolvedValue(stale);
    const order: string[] = [];
    writeBackupFreshness.mockImplementation(async () => {
      order.push("write");
    });
    sendOperationalAlert.mockImplementation(async () => {
      order.push("alert");
    });

    await handleCheckBackupFreshnessJob(job());

    expect(order).toEqual(["write", "alert"]);
  });
});
