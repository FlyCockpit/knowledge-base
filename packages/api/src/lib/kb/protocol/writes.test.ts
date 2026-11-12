import { describe, expect, it } from "vitest";
import { changesApplyRequestSchema, kbWriteToolSchemas } from "./writes";

describe("write title PostgreSQL text validation", () => {
  const shared = {
    kbId: "a".repeat(24),
    title: "Valid title",
    idempotencyKey: "idempotency-test-key",
  };
  it.each([
    {
      tool: "knowledge_changes_apply",
      schema: kbWriteToolSchemas.knowledge_changes_apply.input,
      valid: {
        ...shared,
        mode: "edit",
        baseRevision: "a".repeat(40),
        changes: [{ op: "delete", path: "a.md" }],
      },
    },
    {
      tool: "knowledge_pull_requests_create",
      schema: kbWriteToolSchemas.knowledge_pull_requests_create.input,
      valid: {
        ...shared,
        headBranch: "feature/fixture",
        expectedHeadSha: "a".repeat(40),
        expectedTargetSha: "b".repeat(40),
      },
    },
  ])("rejects a NUL title in $tool at the validation boundary", ({ schema, valid }) => {
    expect(schema.safeParse(valid).success).toBe(true);
    expect(schema.safeParse({ ...valid, title: "bad\0title" })).toMatchObject({
      success: false,
      error: { issues: expect.arrayContaining([expect.objectContaining({ path: ["title"] })]) },
    });
  });

  it("rejects a NUL title for an internal edit request", () => {
    expect(
      changesApplyRequestSchema.safeParse({
        mode: "edit",
        baseRevision: "a".repeat(40),
        title: "bad\0title",
        changes: [{ op: "delete", path: "a.md" }],
        sourceSessionIds: [],
      }),
    ).toMatchObject({ success: false });
  });
});
