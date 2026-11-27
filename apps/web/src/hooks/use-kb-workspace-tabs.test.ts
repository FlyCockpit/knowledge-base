import { describe, expect, it } from "vitest";
import { retargetApplies, tabKey, type WorkspaceTab } from "@/lib/kb-workspace/tabs";
import { applyWorkspacePathEvent } from "./use-kb-workspace-tabs";

const main = { path: "old.md" };
const pinned = { path: "old.md", rev: "a".repeat(40) };
const proposal = { path: "old.md", proposal: 3 };
const dirty = { path: "old.md", mode: "edit" as const };
const event = {
  owner: "user:a",
  kbId: "kb",
  id: 2,
  kind: "rename" as const,
  from: "old.md",
  to: "new.md",
};

describe("workspace path events", () => {
  it("requires exact viewer, KB and increasing ID", () => {
    expect(retargetApplies(event, 1, "kb", "user:a")).toBe(true);
    expect(retargetApplies(event, 2, "kb", "user:a")).toBe(false);
    expect(retargetApplies(event, 1, "other", "user:a")).toBe(false);
    expect(retargetApplies(event, 1, "kb", "user:b")).toBe(false);
    expect(retargetApplies(event, 1, "kb", null)).toBe(false);
  });
  it("renames a clean main tab and retains historical views", () => {
    const result = applyWorkspacePathEvent(
      { tabs: [main, pinned, proposal], active: tabKey(main) },
      event,
    );
    expect(result).toEqual({
      tabs: [{ path: "new.md" }, pinned, proposal],
      active: tabKey({ path: "new.md" }),
    });
  });
  it("deletes only clean main tabs and retains dirty drafts", () => {
    const state = { tabs: [dirty, pinned, proposal], active: tabKey(dirty) };
    const isDirty = (tab: WorkspaceTab) => tab.mode === "edit";
    expect(
      applyWorkspacePathEvent(
        state,
        { owner: "user:a", kbId: "kb", id: 3, kind: "delete", path: "old.md" },
        isDirty,
      ),
    ).toEqual(state);
    expect(
      applyWorkspacePathEvent(
        { tabs: [main, pinned], active: tabKey(main) },
        { owner: "user:a", kbId: "kb", id: 3, kind: "delete", path: "old.md" },
      ),
    ).toEqual({ tabs: [pinned], active: null });
  });
});
