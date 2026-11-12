import { describe, expect, it } from "vitest";

import { isActivePrStatus, mergeabilityKey, toPrSummary } from "./proposals";

describe("proposals", () => {
  it("detects active statuses", () => {
    expect(isActivePrStatus("OPEN")).toBe(true);
    expect(isActivePrStatus("CONFLICT")).toBe(true);
    expect(isActivePrStatus("CLOSED")).toBe(false);
  });

  it("keys merge validation by every mutable policy and proposal input", () => {
    const snapshot = { mainHead: "a".repeat(40), policyGeneration: "3" };
    const pr = { headSha: "b".repeat(40), version: 2 };
    const key = mergeabilityKey(snapshot, pr);
    // Shared spelling with the local store's cache-key regression.
    expect(key).toBe(`v1:${"a".repeat(40)}:3:"":${"b".repeat(40)}:2`);
    for (const other of [
      mergeabilityKey({ ...snapshot, mainHead: "c".repeat(40) }, pr),
      mergeabilityKey({ ...snapshot, policyGeneration: "4" }, pr),
      mergeabilityKey(snapshot, { ...pr, headSha: "c".repeat(40) }),
      mergeabilityKey(snapshot, { ...pr, version: 3 }),
      mergeabilityKey(snapshot, pr, "https://other.invalid"),
    ])
      expect(other).not.toBe(key);
    expect(key).toBe(`${mergeabilityKey(snapshot)}:${pr.headSha}:${pr.version}`);
  });

  it("maps rows to protocol summaries", () => {
    const summary = toPrSummary({
      kbId: "kb",
      number: 2,
      title: "t",
      sourceBranch: "refs/heads/pr/2",
      targetBranch: "main",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      targetSha: "c".repeat(40),
      status: "OPEN",
      authorActorKey: "user:u",
      version: 1,
      mergeCommitSha: null,
      isAutoPr: true,
      dreamMetadata: null,
    });
    expect(summary.sourceBranch).toBe("pr/2");
    expect(summary.targetBranch).toBe("main");
  });
});
