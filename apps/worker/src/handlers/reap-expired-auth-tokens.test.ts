import type { ReapExpiredAuthTokensJobData } from "@knowledge-base/queue";
import type { Job } from "bullmq";
import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@knowledge-base/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});
// Real `@knowledge-base/queue` constructs BullMQ Queues at import (IORedis sockets), but
// `@knowledge-base/queue/jobs` is the side-effect-free half — so the job schema the
// handler validates with is the real one while no socket is opened.
vi.mock("@knowledge-base/queue", async () => {
  const jobs = await import("@knowledge-base/queue/jobs");
  return { ...jobs };
});

const { default: prisma } = await import("@knowledge-base/db");
const { handleReapExpiredAuthTokensJob } = await import("./reap-expired-auth-tokens.js");

type Delegate = { findMany: MockInstance; deleteMany: MockInstance };
const MODELS = [
  "session",
  "verification",
  "deviceCode",
  "deviceApproval",
  "oauthAccessToken",
  "oauthClientAssertion",
  "consentIntent",
] as const;
const db = prisma as unknown as Record<(typeof MODELS)[number], Delegate> & {
  oauthRefreshToken: Delegate;
  $queryRaw: MockInstance;
};
const DAY = 24 * 60 * 60 * 1000;
const ZERO = {
  sessions: 0,
  verifications: 0,
  deviceCodes: 0,
  deviceApprovals: 0,
  oauthAccessTokens: 0,
  oauthRefreshTokens: 0,
  clientAssertions: 0,
  consentIntents: 0,
};

const job = () =>
  ({ id: "job-1", data: { reason: "cron" } }) as unknown as Job<ReapExpiredAuthTokensJobData>;

describe("handleReapExpiredAuthTokensJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    for (const model of MODELS) db[model].findMany.mockResolvedValue([]);
    db.$queryRaw.mockResolvedValue([]);
  });

  it("applies each window and deletes by bounded id pages", async () => {
    const before = Date.now();
    db.session.findMany.mockResolvedValueOnce([{ id: "s1" }, { id: "s2" }]);
    db.session.deleteMany.mockResolvedValueOnce({ count: 2 });
    db.deviceCode.findMany.mockResolvedValueOnce([{ id: "d1" }]);
    db.deviceCode.deleteMany.mockResolvedValueOnce({ count: 1 });
    db.$queryRaw.mockResolvedValueOnce([{ id: "r1" }]);
    db.oauthRefreshToken.deleteMany.mockResolvedValueOnce({ count: 1 });

    await expect(handleReapExpiredAuthTokensJob(job())).resolves.toEqual({
      reason: "cron",
      deleted: { ...ZERO, sessions: 2, deviceCodes: 1, oauthRefreshTokens: 1 },
    });
    const where = (model: (typeof MODELS)[number]) => db[model].findMany.mock.calls[0]?.[0]?.where;
    // Sessions die at expiry.
    expect(where("session").expiresAt.lt.getTime()).toBeGreaterThanOrEqual(before);
    // Device / OAuth artifacts are kept 24h after expiry.
    for (const model of [
      "deviceCode",
      "deviceApproval",
      "oauthAccessToken",
      "oauthClientAssertion",
    ] as const)
      expect(where(model).expiresAt.lt.getTime()).toBeLessThanOrEqual(Date.now() - DAY);
    // DPoP proofs at their stored (verifier + 1s) expiry, other verifications after 24h.
    const verification = where("verification");
    expect(verification.OR[0]).toMatchObject({ identifier: { startsWith: "dpop-proof:" } });
    expect(verification.OR[0].expiresAt.lt.getTime()).toBeGreaterThanOrEqual(before);
    expect(verification.OR[1].expiresAt.lt.getTime()).toBeLessThanOrEqual(Date.now() - DAY);
    // Only abandoned consent intents; approved receipts and grants are tombstones.
    expect(where("consentIntent")).toMatchObject({ approvedAt: null, grantId: null });
    expect(db.session.findMany.mock.calls[0]?.[0]).toMatchObject({
      select: { id: true },
      orderBy: { id: "asc" },
      take: 1000,
    });
    expect(db.session.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["s1", "s2"] } } });
    expect(db.oauthRefreshToken.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["r1"] } } });
  });

  it("keeps paging a model until a short page", async () => {
    const fullPage = Array.from({ length: 1000 }, (_, i) => ({ id: `s-${i}` }));
    db.session.findMany.mockResolvedValueOnce(fullPage).mockResolvedValueOnce([{ id: "tail" }]);
    db.session.deleteMany
      .mockResolvedValueOnce({ count: 1000 })
      .mockResolvedValueOnce({ count: 1 });
    await expect(handleReapExpiredAuthTokensJob(job())).resolves.toMatchObject({
      deleted: { sessions: 1001 },
    });
    expect(db.session.findMany).toHaveBeenCalledTimes(2);
    expect(db.verification.deleteMany).not.toHaveBeenCalled();
  });

  it("reports zero across the board when nothing has expired", async () => {
    await expect(handleReapExpiredAuthTokensJob(job())).resolves.toEqual({
      reason: "cron",
      deleted: ZERO,
    });
  });

  it("rejects a payload the schema does not describe", async () => {
    const bad = {
      id: "job-2",
      data: { reason: "admin" },
    } as unknown as Job<ReapExpiredAuthTokensJobData>;
    await expect(handleReapExpiredAuthTokensJob(bad)).rejects.toThrow();
    expect(db.session.findMany).not.toHaveBeenCalled();
  });
});
