import { describe, expect, it } from "vitest";

import {
  mergeWorkspaceLayout,
  TREE_WIDTH_DEFAULT,
  TREE_WIDTH_MAX,
  TREE_WIDTH_MIN,
  useKbWorkspaceStore,
} from "./kb-workspace";

const current = {
  treeWidth: TREE_WIDTH_DEFAULT,
  treeOpen: true,
  setTreeWidth: () => {},
  setTreeOpen: () => {},
  toggleTree: () => {},
  sidebarView: "files" as const,
  setSidebarView: () => {},
};

describe("workspace layout", () => {
  it("restores stored values, clamped", () => {
    expect(mergeWorkspaceLayout({ treeWidth: 400, treeOpen: false }, current)).toMatchObject({
      treeWidth: 400,
      treeOpen: false,
    });
    expect(mergeWorkspaceLayout({ treeWidth: 9999 }, current).treeWidth).toBe(TREE_WIDTH_MAX);
    expect(mergeWorkspaceLayout({ treeWidth: 1 }, current).treeWidth).toBe(TREE_WIDTH_MIN);
  });

  it("ignores invalid stored values", () => {
    for (const stored of [
      null,
      [],
      "x",
      { treeWidth: "wide", treeOpen: "yes" },
      { treeWidth: Number.NaN },
    ]) {
      expect(mergeWorkspaceLayout(stored, current)).toMatchObject({
        treeWidth: TREE_WIDTH_DEFAULT,
        treeOpen: true,
      });
    }
  });
});

describe("active editor registry", () => {
  it("announces scoped path operations with increasing IDs", () => {
    const store = useKbWorkspaceStore.getState();
    store.announcePathRenamed("user:a", "kb", "old.md", "new.md");
    const first = useKbWorkspaceStore.getState().pathEvent!;
    expect(first).toMatchObject({
      owner: "user:a",
      kbId: "kb",
      kind: "rename",
      from: "old.md",
      to: "new.md",
    });
    store.announcePathDeleted("user:b", "other", "gone.md");
    expect(useKbWorkspaceStore.getState().pathEvent).toMatchObject({
      owner: "user:b",
      kbId: "other",
      kind: "delete",
      path: "gone.md",
      id: first.id + 1,
    });
  });
  const editor = (key: string) => ({
    key,
    dirty: false,
    canSave: true,
    canEdit: true,
    pending: false,
    uploading: false,
    keepDraft: () => true,
    save: async () => true,
    discard: () => {},
  });

  it("keeps a newer registration when an older editor unregisters", () => {
    const store = useKbWorkspaceStore;
    store.getState().register(editor("a"));
    store.getState().register(editor("b"));
    store.getState().unregister("a");
    expect(store.getState().editor?.key).toBe("b");
    store.getState().unregister("b");
    expect(store.getState().editor).toBeNull();
  });
});

describe("sidebar view", () => {
  it("restores a known view and ignores anything else", () => {
    expect(mergeWorkspaceLayout({ sidebarView: "search" }, current).sidebarView).toBe("search");
    expect(mergeWorkspaceLayout({ sidebarView: "terminal" }, current).sidebarView).toBe(
      current.sidebarView,
    );
    expect(mergeWorkspaceLayout({ sidebarView: 3 }, current).sidebarView).toBe(current.sidebarView);
  });
});

describe("local delete attempt ownership", () => {
  it("releases a failed/retired attempt without clearing a newer owner/KB attempt", () => {
    const old = useKbWorkspaceStore.getState().beginPathDelete("user:a", "kb", "a.md");
    const newer = useKbWorkspaceStore.getState().beginPathDelete("user:b", "other", "a.md");
    old();
    expect(useKbWorkspaceStore.getState().pendingDelete).toEqual({
      owner: "user:b",
      kbId: "other",
      path: "a.md",
    });
    newer();
    expect(useKbWorkspaceStore.getState().pendingDelete).toBeNull();
  });
  it("marks an explicit completion for the pruning lifecycle after Undo", () => {
    useKbWorkspaceStore
      .getState()
      .announcePathDeleted("user:a", "kb", "a.md", { completedLocally: true, selectNext: true });
    expect(useKbWorkspaceStore.getState().pathEvent).toMatchObject({
      owner: "user:a",
      kbId: "kb",
      path: "a.md",
      completedLocally: true,
      selectNext: true,
    });
  });
});
