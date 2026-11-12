import { describe, expect, it, vi } from "vitest";

vi.mock("@knowledge-base/db", () => ({ default: {} }));

const { RETENTION, RETENTION_CLASSES, retentionClassesFor } = await import("./retention");
const { GENERATION_LEASE_MS, QUERY_DEADLINE_MS, QUERY_SCRUB_MS } = await import(
  "./query-embedding"
);
const { STRUCTURED_GENERATION_RETENTION_MS } = await import("./structured-search");

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("retention windows", () => {
  it("pins every exact TTL", () => {
    expect(RETENTION).toEqual({
      queryScrubMs: 5 * MINUTE,
      queryJanitorIntervalMs: 30_000,
      queryCleanupLeadMs: 2 * MINUTE,
      uploadTtlMs: HOUR,
      exportTtlMs: 15 * MINUTE,
      bullCompletedAgeSeconds: 24 * 3600,
      bullFailedAgeSeconds: 7 * 24 * 3600,
      supersededGenerationMs: 7 * DAY,
      failedBuildMs: DAY,
      operationBodyMs: 30 * DAY,
      auditMs: 90 * DAY,
      deviceArtifactGraceMs: DAY,
      oauthArtifactGraceMs: DAY,
      refreshFamilyGraceMs: DAY,
      dpopVerifierGraceMs: 1000,
    });
  });
  it("applies the BullMQ payload ages to every queue's defaults", async () => {
    const { BULL_PAYLOAD_RETENTION } = await import("../../../../queue/src/jobs");
    expect(BULL_PAYLOAD_RETENTION).toEqual({
      completedAgeSeconds: RETENTION.bullCompletedAgeSeconds,
      failedAgeSeconds: RETENTION.bullFailedAgeSeconds,
    });
  });
  it("keeps the query deadline tied to the request scrub and beyond every lease/request limit", () => {
    expect(RETENTION.queryScrubMs).toBe(QUERY_SCRUB_MS);
    expect(RETENTION.queryScrubMs).toBeGreaterThan(GENERATION_LEASE_MS);
    expect(RETENTION.queryScrubMs).toBeGreaterThan(QUERY_DEADLINE_MS);
    // A superseded generation outlives every signed cursor that may still pin it.
    expect(RETENTION.supersededGenerationMs).toBeGreaterThan(STRUCTURED_GENERATION_RETENTION_MS);
    // Cleanup starts after the legitimate request/lease windows and before the hard deadline.
    expect(RETENTION.queryScrubMs - RETENTION.queryCleanupLeadMs).toBeGreaterThan(
      GENERATION_LEASE_MS,
    );
    expect(RETENTION.queryCleanupLeadMs).toBeGreaterThan(RETENTION.queryJanitorIntervalMs * 2);
    expect(RETENTION.queryJanitorIntervalMs).toBeLessThan(RETENTION.queryScrubMs / 2);
  });
});

describe("retention schedule", () => {
  it("runs query scrub and staging expiry every minute, not only hourly", () => {
    expect(retentionClassesFor("minute")).toEqual(["queryData", "stagedUploads"]);
  });
  it("hourly also covers generations, receipts and audit (and repeats the minute classes)", () => {
    expect(retentionClassesFor("hourly")).toEqual([
      "queryData",
      "stagedUploads",
      "generations",
      "operationReceipts",
      "auditEvents",
    ]);
  });
  it("only the generations class touches the filesystem (index files on the data volume)", () => {
    const touching = Object.entries(RETENTION_CLASSES)
      .filter(([, cls]) => cls.touchesFilesystem)
      .map(([name]) => name);
    expect(touching).toEqual(["generations"]);
  });
});

describe("shared cost limits fail closed", () => {
  it("rejects costly admission as STORAGE_UNAVAILABLE during a Redis outage", async () => {
    const { chargeRate, createRedisRatePort } = await import("./limits");
    // An ioredis client whose connection ended: the same shape oRPC, MCP, Git and job
    // producers see, because they all share this one port implementation.
    const port = createRedisRatePort({ status: "end", defineCommand() {} });
    for (const kind of ["create", "query", "rebuild", "probe", "mutation", "upload"] as const)
      await expect(chargeRate(port, { kind, key: "user:kb" })).rejects.toMatchObject({
        code: "STORAGE_UNAVAILABLE",
      });
  });
});
