import { describe, expect, it } from "vitest";

import { searchOfTab, tabDraftKey, tabOfSearch } from "@/components/kb/kb-workspace";
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
