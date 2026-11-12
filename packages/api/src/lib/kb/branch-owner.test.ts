import { describe, expect, it } from "vitest";

import { proposalBranchLabel, proposalRefName } from "./branch-owner";

describe("branch-owner", () => {
  it("formats proposal refs", () => {
    expect(proposalRefName(3)).toBe("refs/heads/pr/3");
    expect(proposalBranchLabel("refs/heads/pr/3")).toBe("pr/3");
  });
});
