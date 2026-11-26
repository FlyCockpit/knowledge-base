import { describe, expect, it } from "vitest";

import {
  fileOpQuestion,
  leaveAsks,
  searchOfTab,
  tabDraftKey,
  tabOfSearch,
} from "@/components/kb/kb-workspace";
import { draftKey } from "@/hooks/use-document-draft";
import { tabKey } from "@/lib/kb-workspace/tabs";

const SHA = "a".repeat(40);

describe("workspace URL state", () => {
  it("names no tab on the KB home, nor for a URL that names no file", () => {
    expect(tabOfSearch(null)).toBeNull();
    // Only an explicit `mode=new` is the New document draft.
    expect(tabOfSearch({})).toBeNull();
    expect(tabOfSearch({ mode: "edit" })).toBeNull();
  });

  it("maps each kind of document URL to its tab and back", () => {
    const cases = [
      [{ path: "a/b.md" }, { path: "a/b.md" }],
      [
        { path: "a/b.md", mode: "edit" as const },
        { path: "a/b.md", mode: "edit" },
      ],
      [
        { path: "a/b.md", rev: SHA },
        { path: "a/b.md", rev: SHA },
      ],
      [
        { path: "a/b.md", proposal: 7 },
        { path: "a/b.md", proposal: 7 },
      ],
      [
        { path: "a/b.md", proposal: 7, mode: "edit" as const },
        { path: "a/b.md", proposal: 7, mode: "edit" },
      ],
      [
        { path: "a/b.md", pr: 3, mode: "edit" as const },
        { path: "a/b.md", pr: 3, mode: "edit" },
      ],
      [{ mode: "new" as const }, { path: "" }],
    ] as const;
    for (const [search, tab] of cases) {
      expect(tabOfSearch(search)).toEqual(tab);
      // A tab reopens exactly the URL it came from.
      expect(searchOfTab(tabOfSearch(search)!)).toEqual(search);
    }
  });

  it("keeps a file's versions apart and its modes together", () => {
    const main = tabKey(tabOfSearch({ path: "x.md" })!);
    expect(tabKey(tabOfSearch({ path: "x.md", mode: "edit" })!)).toBe(main);
    expect(tabKey(tabOfSearch({ path: "x.md", rev: SHA })!)).not.toBe(main);
    expect(tabKey(tabOfSearch({ path: "x.md", proposal: 2 })!)).not.toBe(main);
    expect(tabKey(tabOfSearch({ path: "x.md", pr: 2, mode: "edit" })!)).not.toBe(main);
  });

  it("opens a PR-mode tab in PR mode, which needs the edit view", () => {
    expect(searchOfTab({ path: "x.md", pr: 4 })).toEqual({ path: "x.md", pr: 4, mode: "edit" });
  });
});

describe("tabDraftKey (where a tab's unsaved draft is kept)", () => {
  const owner = "user:u1";
  it("uses the session's own key for main, a proposal and PR mode", () => {
    expect(tabDraftKey(owner, "kb1", { path: "a.md" })).toBe(
      draftKey({ userId: owner, kbId: "kb1", path: "a.md", proposal: null }),
    );
    expect(tabDraftKey(owner, "kb1", { path: "a.md", proposal: 3 })).toBe(
      draftKey({ userId: owner, kbId: "kb1", path: "a.md", proposal: 3 }),
    );
    // PR mode keeps its drafts apart (resolving a conflict), never under the proposal's key.
    expect(tabDraftKey(owner, "kb1", { path: "a.md", pr: 3 })).toBe(
      draftKey({ userId: owner, kbId: "kb1", path: "a.md", proposal: 3, resolving: true }),
    );
    expect(tabDraftKey(owner, "kb1", { path: "", mode: "edit" })).toBe(
      draftKey({ userId: owner, kbId: "kb1", path: "", proposal: null }),
    );
  });
  it("keeps none for a pinned version or without a viewer", () => {
    expect(tabDraftKey(owner, "kb1", { path: "a.md", rev: SHA })).toBeNull();
    expect(tabDraftKey(null, "kb1", { path: "a.md" })).toBeNull();
  });
});

describe("fileOpQuestion", () => {
  const clean = { key: "a", dirty: false, uploading: false };
  const dirty = { key: "a", dirty: true, uploading: false };
  it("asks about the open editor's unsaved edits or upload first", () => {
    expect(fileOpQuestion({ live: dirty, target: null, kind: "delete", settled: [] })).toBe("a");
    expect(
      fileOpQuestion({
        live: { ...clean, uploading: true },
        target: { key: "b", hasDraft: true },
        kind: "move",
        settled: [],
      }),
    ).toBe("a");
  });
  it("then about the target file's kept draft, never for a New document", () => {
    const target = { key: "b", hasDraft: true };
    expect(fileOpQuestion({ live: clean, target, kind: "delete", settled: [] })).toBe("b");
    expect(fileOpQuestion({ live: clean, target, kind: "new", settled: [] })).toBeNull();
    expect(
      fileOpQuestion({
        live: clean,
        target: { key: "b", hasDraft: false },
        kind: "move",
        settled: [],
      }),
    ).toBeNull();
    // The open file is the target: its live state is what counts.
    expect(
      fileOpQuestion({
        live: clean,
        target: { key: "a", hasDraft: true },
        kind: "move",
        settled: [],
      }),
    ).toBeNull();
  });
  it("never asks about an answered file again (a Discard that can't turn the session clean)", () => {
    const target = { key: "b", hasDraft: true };
    expect(fileOpQuestion({ live: dirty, target, kind: "delete", settled: ["a"] })).toBe("b");
    expect(fileOpQuestion({ live: dirty, target, kind: "delete", settled: ["a", "b"] })).toBeNull();
    expect(fileOpQuestion({ live: dirty, target: null, kind: "new", settled: ["a"] })).toBeNull();
  });
});

describe("leaveAsks", () => {
  const editor = (over: { dirty?: boolean; uploading?: boolean; kept?: boolean }) => ({
    key: "a",
    dirty: over.dirty ?? false,
    uploading: over.uploading ?? false,
    keepDraft: () => over.kept ?? false,
  });
  it("asks for unsaved edits it can't keep, and always waits for an upload", () => {
    expect(leaveAsks(null)).toBe(false);
    expect(leaveAsks(editor({}))).toBe(false);
    expect(leaveAsks(editor({ dirty: true }))).toBe(true);
    expect(leaveAsks(editor({ dirty: true, kept: true }))).toBe(false);
    expect(leaveAsks(editor({ uploading: true, kept: true }), ["a"])).toBe(true);
  });
  it("doesn't ask again about a file answered in the same operation (Discard A, then Save B)", () => {
    expect(leaveAsks(editor({ dirty: true }), ["a"])).toBe(false);
    expect(leaveAsks(editor({ dirty: true }), ["b"])).toBe(true);
  });
});
