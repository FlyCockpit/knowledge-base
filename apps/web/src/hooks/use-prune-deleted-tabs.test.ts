import { describe, expect, it } from "vitest";
import { tabKey } from "@/lib/kb-workspace/tabs";
import { useKbWorkspaceStore } from "@/stores/kb-workspace";
import { completedDeleteTabsToPrune, deletedTabsToPrune } from "./use-prune-deleted-tabs";

const active = { path: "gone.md" };
const next = { path: "kept.md" };
const base = {
  state: { tabs: [active, next], active: tabKey(active) },
  paths: ["kept.md"],
  current: active,
  previousCurrentKey: tabKey(active),
  isDirtyTab: () => false,
};

describe("complete tree deletion pruning", () => {
  it("preserves a direct visit to a missing recovery page", () => {
    expect(deletedTabsToPrune({ ...base, previous: null })).toEqual({
      paths: [],
      activeDeleted: null,
      next: null,
    });
  });
  it("preserves a newly navigated missing page even if the prior tree contained it", () => {
    expect(
      deletedTabsToPrune({
        ...base,
        previous: new Set(["gone.md", "kept.md"]),
        previousCurrentKey: tabKey(next),
      }).paths,
    ).toEqual([]);
  });
  it("closes a previously present active document and selects the next tab", () => {
    expect(deletedTabsToPrune({ ...base, previous: new Set(["gone.md", "kept.md"]) })).toEqual({
      paths: ["gone.md"],
      activeDeleted: active,
      next,
    });
  });
  it("prunes initially missing background main tabs, keeping dirty and historical tabs", () => {
    const dirty = { path: "dirty.md", mode: "edit" as const };
    const rev = { path: "old.md", rev: "a".repeat(40) };
    const proposal = { path: "old.md", proposal: 1 };
    const pr = { path: "old.md", pr: 1 };
    const state = { tabs: [next, active, dirty, rev, proposal, pr], active: tabKey(next) };
    expect(
      deletedTabsToPrune({
        state,
        paths: ["kept.md"],
        previous: null,
        previousCurrentKey: tabKey(next),
        current: next,
        isDirtyTab: (tab) => tab.path === dirty.path,
      }),
    ).toEqual({ paths: ["gone.md"], activeDeleted: null, next: null });
  });
  it("leaves a previously present dirty active tab open", () => {
    expect(
      deletedTabsToPrune({ ...base, previous: new Set(["gone.md"]), isDirtyTab: () => true }).paths,
    ).toEqual([]);
  });
});

describe("local deletion completion", () => {
  it("does not prune a clean tab while its editor or completion callback owns a write", () => {
    const release = useKbWorkspaceStore.getState().beginPathDelete("user:a", "kb", active.path);
    const pending = useKbWorkspaceStore.getState().pendingDelete;
    // execute may already report pending=false; the explicit attempt still owns Undo.
    expect(
      deletedTabsToPrune({
        ...base,
        previous: new Set([active.path]),
        isPendingTab: (tab) =>
          pending?.owner === "user:a" && pending.kbId === "kb" && pending.path === tab.path,
      }).paths,
    ).toEqual([]);
    release();
    expect(useKbWorkspaceStore.getState().pendingDelete).toBeNull();
    expect(deletedTabsToPrune({ ...base, previous: new Set([active.path]) }).paths).toEqual([
      active.path,
    ]);
  });
  it("uses retained presence evidence after a pending write releases without local completion", () => {
    const previous = new Set([active.path, next.path]);
    expect(deletedTabsToPrune({ ...base, previous, isPendingTab: () => true }).paths).toEqual([]);
    // A pending snapshot retains known presence; an external deletion is
    // therefore still removable after failure releases callback ownership.
    expect(deletedTabsToPrune({ ...base, previous, isPendingTab: () => false }).paths).toEqual([
      active.path,
    ]);
    // No prior evidence is invented for an intentional missing-page visit.
    expect(
      deletedTabsToPrune({ ...base, previous: new Set([next.path]), isPendingTab: () => false })
        .paths,
    ).toEqual([]);
  });
  it("selects an adjacent tab using live order and marks only own completion silent", () => {
    expect(
      completedDeleteTabsToPrune({
        state: base.state,
        current: active,
        path: active.path,
        selectNext: true,
        isDirtyTab: () => false,
      }),
    ).toEqual({ paths: [active.path], activeDeleted: active, next, completedLocally: true });
  });
  it("falls back to home with no surviving tab", () => {
    expect(
      completedDeleteTabsToPrune({
        state: { tabs: [active], active: tabKey(active) },
        current: active,
        path: active.path,
        selectNext: true,
        isDirtyTab: () => false,
      }).next,
    ).toBeNull();
  });
  it("removes a background completion without redirecting the newer visit", () => {
    expect(
      completedDeleteTabsToPrune({
        state: { ...base.state, active: tabKey(next) },
        current: next,
        path: active.path,
        selectNext: false,
        isDirtyTab: () => false,
      }),
    ).toEqual({ paths: [active.path], activeDeleted: null, next: null, completedLocally: true });
  });
  it("keeps dirty and pinned views on explicit completion", () => {
    const pinned = { ...active, rev: "a".repeat(40) };
    expect(
      completedDeleteTabsToPrune({
        state: { tabs: [active, pinned], active: tabKey(active) },
        current: active,
        path: active.path,
        selectNext: true,
        isDirtyTab: () => true,
      }).paths,
    ).toEqual([]);
  });
});
