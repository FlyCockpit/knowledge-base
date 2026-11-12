import { captureLog } from "@knowledge-base/env/log";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const redisEval = vi.fn();
const redisOptions = {};
const connectionOptions = vi.fn();
const sendEmail = vi.fn();
const isEmailConfigured = vi.fn(() => true);

vi.mock("@knowledge-base/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});
// Importing the real `@knowledge-base/queue` opens IORedis sockets at import time.
vi.mock("@knowledge-base/queue", () => ({
  createRedisConnection: (options: unknown) => {
    connectionOptions(options);
    return { eval: redisEval, options: redisOptions, disconnect: () => {} };
  },
}));
vi.mock("@knowledge-base/mailer", () => ({
  isEmailConfigured: () => isEmailConfigured(),
  sendEmail: (args: unknown) => sendEmail(args),
  renderDataDeletion: (args: { locale: string }) => ({
    subject: `deleted:${args.locale}`,
    html: "<p>deleted</p>",
  }),
}));

const { default: prisma } = await import("@knowledge-base/db");
const { sendOperationalAlert, sendDataDeletedAlert, sendOperationalFailureAlert } = await import(
  "./operational-alerts.js"
);

const configuredConnection = connectionOptions.mock.calls[0]?.[0];
const db = prisma as unknown as { user: { findMany: ReturnType<typeof vi.fn> } };

const alert = {
  source: "worker",
  message: "boom",
  subject: "[worker] background job failed",
  html: "<p>boom</p>",
};

describe("sendOperationalAlert", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisEval.mockReset().mockResolvedValue(1);
    sendEmail.mockReset().mockResolvedValue(undefined);
    isEmailConfigured.mockReturnValue(true);
    vi.spyOn(console, "error").mockImplementation(() => {});
    db.user.findMany.mockResolvedValue([{ id: "u1", email: "admin@example.com", role: "admin" }]);
  });

  it("emails admins when it wins the cooldown slot", async () => {
    redisEval.mockResolvedValue(1);

    await sendOperationalAlert(alert);

    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "admin@example.com", subject: alert.subject }),
    );
  });

  it("sends one counted alert per kind/code cooldown rather than per durable job", async () => {
    const slots = new Set<string>();
    redisEval.mockImplementation(async (script: string, _numKeys: number, key: string) => {
      if (script.includes("'NX'")) {
        if (slots.has(key)) return 0;
        slots.add(key);
      }
      return 1;
    });
    for (const jobId of ["job-a", "job-b"])
      await sendOperationalFailureAlert({
        queue: "query-embedding",
        jobId,
        identity: "QUERY_EMBEDDING:PROVIDER_DOWN",
        message: "Durable jobs failed (PROVIDER_DOWN)",
        count: 25,
      });
    expect(sendEmail).toHaveBeenCalledOnce();
    expect(sendEmail.mock.calls[0]![0].html).toContain("Failures in this batch</dt><dd>25</dd>");
    await sendOperationalFailureAlert({
      queue: "query-embedding",
      jobId: "job-c",
      identity: "QUERY_EMBEDDING:INVALID_INPUT",
      message: "Durable jobs failed (INVALID_INPUT)",
      count: 2,
    });
    expect(sendEmail).toHaveBeenCalledTimes(2);
  });

  it("stays quiet while the cooldown is held", async () => {
    redisEval.mockResolvedValue(null);

    await sendOperationalAlert(alert);

    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("logs only failure counts and class while still attempting every recipient", async () => {
    redisEval.mockResolvedValue(1);
    db.user.findMany.mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => ({
        id: `u${i}`,
        email: `admin${i}@example.com`,
        role: "admin",
      })),
    );
    sendEmail
      .mockRejectedValueOnce(new TypeError("SMTP rejected admin0@example.com"))
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("SMTP rejected admin2@example.com"))
      .mockResolvedValue(undefined);
    const log = captureLog();
    try {
      await sendOperationalAlert(alert);
    } finally {
      log.restore();
    }

    expect(sendEmail).toHaveBeenCalledTimes(10);
    expect(redisEval).toHaveBeenCalledTimes(2);
    expect(log.records).toEqual([
      {
        level: "error",
        site: "worker.alert-send",
        message: "operational alert could not be sent",
        errorClass: "TypeError",
        queue: "worker",
        failures: 2,
        count: 8,
      },
    ]);
    expect(JSON.stringify(log.records)).not.toContain("@example.com");
  });

  it("does not log send failures when all deliveries succeed", async () => {
    redisEval.mockResolvedValue(1);
    sendEmail.mockResolvedValue(undefined);
    const log = captureLog();
    try {
      await sendOperationalAlert(alert);
    } finally {
      log.restore();
    }
    expect(log.records).toEqual([]);
  });

  // Redis is what turns a failure repeating every minute into ONE email an
  // hour. If it is unreachable, sending anyway would mail every admin every
  // minute for the length of the outage — so skip instead.
  it("skips the alert when Redis errors instead of mailing every admin", async () => {
    redisEval.mockRejectedValue(new Error("ECONNREFUSED"));

    await sendOperationalAlert(alert);

    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("skips the alert when the Redis reservation never settles", async () => {
    vi.useFakeTimers();
    redisEval.mockReturnValue(new Promise(() => {}));

    const pending = sendOperationalAlert(alert);
    await vi.advanceTimersByTimeAsync(5_000);
    await pending;

    expect(sendEmail).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe("delivery-based cooldowns", () => {
  const notice = {
    name: "20261111000000_drop_a",
    effects: "a.x",
    deletedAt: new Date(),
    backup: null,
    note: null,
  };
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-11T00:00:00Z"));
    vi.clearAllMocks();
    redisEval.mockReset().mockResolvedValue(1);
    isEmailConfigured.mockReturnValue(true);
    sendEmail.mockReset().mockResolvedValue(undefined);
    db.user.findMany.mockResolvedValue([
      { id: "u1", email: "admin@example.com", role: "admin", locale: "es-MX" },
    ]);
  });
  afterEach(() => vi.useRealTimers());

  function settlement() {
    return redisEval.mock.calls[1]!;
  }
  it("uses relative TTLs without comparing the Redis and worker clocks", async () => {
    expect(await sendOperationalAlert({ ...alert, cooldownSeconds: 86400 })).toBe(1);
    const reserve = redisEval.mock.calls[0]!;
    expect(reserve[4]).toBe(150000);
    expect(reserve[0]).not.toContain("TIME");
    expect(reserve[0]).toContain("'PX'");
    expect(settlement().slice(1)).toEqual([1, reserve[2], reserve[3], "sent", 86400000]);
    expect(settlement()[0]).toContain("ARGV[2] ~= 'sent' and current ~= ARGV[1]");
    expect(settlement()[0]).not.toContain("TIME");
  });
  it("uses ten-minute backoff on total SMTP failure and leaves a deletion unmarked", async () => {
    sendEmail.mockRejectedValue(new Error("SMTP down"));
    await expect(sendDataDeletedAlert(notice)).rejects.toThrow("No data-deletion");
    expect(settlement().slice(-2)).toEqual(["failed", 600000]);
  });
  it("records successful partial delivery and renders the recipient locale", async () => {
    await sendDataDeletedAlert(notice);
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ subject: "deleted:es-MX" }));
    expect(db.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: { id: true, email: true, role: true, locale: true },
        take: 50,
      }),
    );
  });
  it.each(["disabled", "cooldown", "no admins", "Redis down"])(
    "retries deletion notices after %s",
    async (reason) => {
      if (reason === "disabled") isEmailConfigured.mockReturnValue(false);
      if (reason === "cooldown") redisEval.mockResolvedValue(0);
      if (reason === "no admins") db.user.findMany.mockResolvedValue([]);
      if (reason === "Redis down") redisEval.mockRejectedValue(new Error("offline"));
      await expect(sendDataDeletedAlert(notice)).rejects.toThrow("No data-deletion");
      expect(sendEmail).not.toHaveBeenCalled();
      if (reason === "no admins") expect(settlement().slice(-2)).toEqual(["failed", 600000]);
    },
  );
  it("settles failed recipient lookup with a bounded backoff", async () => {
    db.user.findMany.mockRejectedValue(new Error("database down"));
    await expect(sendOperationalAlert(alert)).rejects.toThrow("database down");
    expect(settlement().slice(-2)).toEqual(["failed", 600000]);
  });
  it("rejects a late reservation response before the outer timeout elapses", async () => {
    const delayed = Promise.withResolvers<number>();
    redisEval.mockReturnValueOnce(delayed.promise);
    const sending = sendOperationalAlert(alert);
    await vi.advanceTimersByTimeAsync(1600);
    delayed.resolve(1);
    expect(await sending).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(redisEval).toHaveBeenCalledOnce();
  });
  it("does not send if a timed-out reservation resolves later", async () => {
    const delayed = Promise.withResolvers<number>();
    redisEval.mockReturnValueOnce(delayed.promise);
    const sending = sendOperationalAlert(alert);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await sending).toBe(0);
    await vi.advanceTimersByTimeAsync(120000);
    delayed.resolve(1);
    await Promise.resolve();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(redisEval).toHaveBeenCalledOnce();
  });
  it("counts partial delivery as sent even when another recipient fails", async () => {
    db.user.findMany.mockResolvedValue([
      { id: "a", email: "a@example.com", role: "admin", locale: "en-US" },
      { id: "b", email: "b@example.com", role: "admin", locale: "es-MX" },
    ]);
    sendEmail.mockRejectedValueOnce(new Error("SMTP failure"));
    await expect(sendOperationalAlert(alert)).resolves.toBe(1);
    expect(settlement().slice(-2)).toEqual(["sent", 3600000]);
  });
  it.each([120001, 150001])(
    "commits sent cooldown after a delivery settles at %i ms",
    async (elapsed) => {
      db.user.findMany.mockResolvedValue([
        { id: "a", email: "a@example.com", role: "admin" },
        { id: "b", email: "b@example.com", role: "admin" },
      ]);
      const slow = Promise.withResolvers<void>();
      sendEmail.mockResolvedValueOnce(undefined).mockReturnValueOnce(slow.promise);
      const pending = sendOperationalAlert(alert);
      await vi.advanceTimersByTimeAsync(elapsed);
      slow.reject(new Error("SMTP timeout"));
      expect(await pending).toBe(1);
      expect(settlement().slice(-2)).toEqual(["sent", 3600000]);
      // Success is allowed to settle even if Redis has already expired the token;
      // a failed sender may only settle its own reservation.
      expect(settlement()[0]).toContain("ARGV[2] ~= 'sent' and current ~= ARGV[1]");
    },
  );
  it("refuses to start an SMTP effect after the reservation deadline", async () => {
    let authorize: ((send: (signal: AbortSignal) => Promise<void>) => Promise<void>) | undefined;
    sendEmail.mockImplementationOnce(async (args: { authorizeSend: typeof authorize }) => {
      authorize = args.authorizeSend;
    });
    await sendOperationalAlert(alert);
    await vi.advanceTimersByTimeAsync(120000);
    const send = vi.fn();
    await expect(authorize!(send)).rejects.toThrow("reservation expired");
    expect(send).not.toHaveBeenCalled();
  });
  it("keys deletion cooldowns by the exact migration identity", async () => {
    await sendDataDeletedAlert(notice);
    await sendDataDeletedAlert({ ...notice, name: "20261112000000_drop_a" });
    expect(redisEval.mock.calls[0]![2]).not.toBe(redisEval.mock.calls[2]![2]);
  });
  it("discards disconnected commands and bounds retries on its dedicated connection", () => {
    expect(configuredConnection).toEqual({ maxRetriesPerRequest: 1, commandTimeout: 1500 });
    expect(redisOptions).toMatchObject({
      enableOfflineQueue: false,
      autoResendUnfulfilledCommands: false,
    });
  });
});
