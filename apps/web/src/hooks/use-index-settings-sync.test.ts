import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { orpc } from "@/utils/orpc";
import { indexBuildSignature, syncIndexSettingsOnBuildChange } from "./use-index-settings-sync";

const KB = "a".repeat(24);
const index = (over: Record<string, unknown> = {}) =>
  ({
    activeGenerationId: "g".repeat(24),
    desiredGenerationId: "h".repeat(24),
    desiredEpoch: "2",
    activeState: "COMPLETE",
    desiredState: "RUNNING",
    indexedCommitSha: null,
    headSha: "1".repeat(40),
    dimensions: 8,
    fingerprint: null,
    freshness: "building",
    errorCode: null,
    rebuildPending: null,
    ...over,
  }) as unknown as Parameters<typeof indexBuildSignature>[0];

describe("index settings build sync", () => {
  it("changes signature when a build settles or fails, not on unrelated fields", () => {
    const running = indexBuildSignature(index());
    expect(indexBuildSignature(index({ indexedCommitSha: "2".repeat(40) }))).toBe(running);
    expect(indexBuildSignature(index({ desiredState: "FAILED", freshness: "failed" }))).not.toBe(
      running,
    );
    expect(indexBuildSignature(index({ desiredState: "COMPLETE", freshness: "current" }))).not.toBe(
      running,
    );
    expect(indexBuildSignature(null)).toBeNull();
  });

  it("invalidates the KB's settings only on a known-to-known change", () => {
    const queryClient = new QueryClient();
    const key = orpc.kbIndex.settings.queryKey({ input: { kbId: KB } });
    queryClient.setQueryData(key, {
      quantization: "binary_int8_rescore",
      limit: null,
      effectiveLimit: 400_000,
      maxLimit: 400_000,
      caps: { int8: 200_000, binary_int8_rescore: 400_000 },
      defaultLimit: 400_000,
      activeChunkCount: 1,
      canConfigureLimit: true,
      buildFailure: null,
    });
    const running = indexBuildSignature(index());
    const failed = indexBuildSignature(index({ desiredState: "FAILED", freshness: "failed" }));
    expect(syncIndexSettingsOnBuildChange(queryClient, KB, null, running)).toBe(false);
    expect(syncIndexSettingsOnBuildChange(queryClient, KB, running, running)).toBe(false);
    expect(queryClient.getQueryState(key)?.isInvalidated).toBe(false);
    expect(syncIndexSettingsOnBuildChange(queryClient, KB, running, failed)).toBe(true);
    expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
  });
});
