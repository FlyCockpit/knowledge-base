import { describe, expect, it, vi } from "vitest";
import { lexicalNoticeFor, projectIndexStatus } from "./index-status";
import type { LockQuery } from "./lock";

const row: Parameters<typeof projectIndexStatus>[0] = {
  activeGenerationId: "a".repeat(24),
  desiredGenerationId: "b".repeat(24),
  desiredEpoch: "3",
  activeState: "COMPLETE",
  desiredState: "COMPLETE",
  indexedCommitSha: "c".repeat(40),
  headSha: "c".repeat(40),
  dimensions: 2,
  fingerprint: `sha256:${"d".repeat(64)}`,
  errorCode: null,
  activeProviderId: "e".repeat(24),
  activeVersion: 1,
  profileProviderId: "e".repeat(24),
  profileVersion: 1,
  jobState: "COMPLETE",
};
describe("index status projection", () => {
  it("reports unavailable without a usable active embedder", () => {
    expect(
      projectIndexStatus(
        {
          ...row,
          activeGenerationId: null,
          activeState: null,
          desiredGenerationId: null,
          desiredState: null,
          dimensions: null,
          fingerprint: null,
          jobState: null,
        },
        false,
      ),
    ).toMatchObject({
      freshness: "unavailable",
      errorCode: "INDEX_UNAVAILABLE",
      dimensions: null,
      fingerprint: null,
    });
    expect(projectIndexStatus(row, false).freshness).toBe("unavailable");
  });
  it("orders failed, building, stale, current and omits internal profile fields", () => {
    expect(
      projectIndexStatus(
        { ...row, desiredState: "FAILED", jobState: "RETRY", headSha: "f".repeat(40) },
        true,
      ).freshness,
    ).toBe("failed");
    expect(
      projectIndexStatus(
        { ...row, desiredState: "INDEXING", jobState: "RUNNING", headSha: "f".repeat(40) },
        true,
      ).freshness,
    ).toBe("building");
    expect(projectIndexStatus({ ...row, headSha: "f".repeat(40) }, true).freshness).toBe("stale");
    expect(
      projectIndexStatus(
        {
          ...row,
          activeGenerationId: null,
          activeState: null,
          desiredState: "PENDING",
          jobState: "PENDING",
        },
        false,
      ).freshness,
    ).toBe("building");
    expect(
      projectIndexStatus(
        {
          ...row,
          activeGenerationId: null,
          activeState: null,
          desiredState: "FAILED",
          jobState: "FAILED",
        },
        false,
      ).freshness,
    ).toBe("failed");
    expect(projectIndexStatus(row, true).freshness).toBe("current");
    expect(projectIndexStatus(row, true)).not.toHaveProperty("activeProviderId");
    expect(projectIndexStatus(row, true)).not.toHaveProperty("jobState");
  });
  it("keeps purged failed/cancelled builds failed and purged completed builds superseded on the wire", () => {
    for (const jobState of ["FAILED", "CANCELLED"]) {
      expect(projectIndexStatus({ ...row, desiredState: "PURGED", jobState }, true)).toMatchObject({
        desiredState: "FAILED",
        freshness: "failed",
        errorCode: "INDEX_BUILD_FAILED",
      });
    }
    expect(
      projectIndexStatus({ ...row, desiredState: "PURGED", jobState: "COMPLETE" }, true),
    ).toMatchObject({
      desiredState: "SUPERSEDED",
      freshness: "current",
      errorCode: null,
    });
  });
  it("marks a KB serving an index built under previous embedding settings as rebuild pending", () => {
    // Default: nothing pending.
    expect(projectIndexStatus(row, true).rebuildPending).toBeNull();
    // Settings changed: the old generation keeps serving (current/usable) but is marked.
    expect(projectIndexStatus(row, true, "EMBEDDING_SETTINGS_CHANGED")).toMatchObject({
      freshness: "current",
      errorCode: null,
      rebuildPending: "EMBEDDING_SETTINGS_CHANGED",
    });
    // Model identity changed: never query-compatible, still marked.
    expect(projectIndexStatus(row, false, "EMBEDDING_MODEL_CHANGED")).toMatchObject({
      freshness: "unavailable",
      rebuildPending: "EMBEDDING_MODEL_CHANGED",
    });
  });
});

describe("lexical-only notice", () => {
  const kbId = "k".repeat(24);
  const noticeFor = (row: Record<string, unknown> | undefined) =>
    lexicalNoticeFor(vi.fn().mockResolvedValue({ rows: row ? [row] : [] }) as LockQuery, kbId);
  it.each([
    [{ providerId: null, revoked: null, building: false }, "NO_EMBEDDING_PROFILE"],
    [{ providerId: "p".repeat(24), revoked: true, building: false }, "EMBEDDING_PROFILE_REVOKED"],
    // A healthy model's first hybrid build is queued or running: not a failure.
    [{ providerId: "p".repeat(24), revoked: false, building: true }, "SEMANTIC_INDEX_BUILDING"],
    [
      { providerId: "p".repeat(24), revoked: false, building: false },
      "EMBEDDING_PROFILE_UNAVAILABLE",
    ],
  ])("%o -> %s", async (row, detail) => {
    expect(await noticeFor(row)).toEqual({ kbId, code: "LEXICAL_ONLY", detail });
  });
});
