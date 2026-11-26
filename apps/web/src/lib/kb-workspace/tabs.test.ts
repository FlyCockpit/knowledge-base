import { afterEach, describe, expect, it, vi } from "vitest";

import {
  activateTab,
  closeTab,
  cycleTab,
  dropTabPath,
  EMPTY_TABS,
  forgetKbTabs,
  loadTabs,
  MAX_TABS,
  moveTab,
  openTab,
  parseStoredTabs,
  renameTabPath,
  retargetApplies,
  retargetTab,
  saveTabs,
  type TabsState,
  tabKey,
  tabsStorageKey,
} from "./tabs";

const SHA = "a".repeat(40);
const open = (...paths: string[]): TabsState =>
  paths.reduce((state, path) => openTab(state, { path }), EMPTY_TABS);
const k = (path: string) => tabKey({ path });

describe("workspace tabs", () => {
  it("opens, activates and updates an already open tab instead of duplicating it", () => {
    let state = open("a.md", "b.md");
    expect(state.tabs.map((t) => t.path)).toEqual(["a.md", "b.md"]);
    expect(state.active).toBe(k("b.md"));
    state = openTab(state, { path: "a.md", mode: "edit" });
    expect(state.tabs).toEqual([{ path: "a.md", mode: "edit" }, { path: "b.md" }]);
    expect(state.active).toBe(k("a.md"));
    expect(openTab(state, { path: "a.md", mode: "edit" })).toBe(state);
  });

  it("keys a tab by path and version, not by mode", () => {
    expect(tabKey({ path: "a.md" })).not.toBe(tabKey({ path: "a.md", rev: SHA }));
    expect(tabKey({ path: "a.md", proposal: 3 })).not.toBe(tabKey({ path: "a.md", pr: 3 }));
    const state = openTab(openTab(EMPTY_TABS, { path: "a.md" }), { path: "a.md", proposal: 3 });
    expect(state.tabs).toHaveLength(2);
  });

  it("activates only open tabs; null shows no file", () => {
    const state = open("a.md", "b.md");
    expect(activateTab(state, k("a.md")).active).toBe(k("a.md"));
    expect(activateTab(state, null).active).toBeNull();
    expect(activateTab(state, k("zz.md")).active).toBeNull();
    expect(activateTab(state, state.active)).toBe(state);
  });

  it("closing the active tab shows its right neighbour, else its left one", () => {
    const state = activateTab(open("a.md", "b.md", "c.md"), k("b.md"));
    const middle = closeTab(state, k("b.md"));
    expect(middle.next?.path).toBe("c.md");
    expect(middle.state.active).toBe(k("c.md"));
    const last = closeTab(open("a.md", "b.md", "c.md"), k("c.md"));
    expect(last.next?.path).toBe("b.md");
    const only = closeTab(open("a.md"), k("a.md"));
    expect(only).toEqual({ state: { tabs: [], active: null }, next: null });
  });

  it("closing an inactive tab keeps the active one and shows nothing new", () => {
    const result = closeTab(open("a.md", "b.md"), k("a.md"));
    expect(result.next).toBeNull();
    expect(result.state).toEqual({ tabs: [{ path: "b.md" }], active: k("b.md") });
    const unknown = open("a.md");
    expect(closeTab(unknown, k("x.md")).state).toBe(unknown);
  });

  it("cycles both ways and wraps", () => {
    const state = activateTab(open("a.md", "b.md", "c.md"), k("c.md"));
    expect(cycleTab(state, 1)?.path).toBe("a.md");
    expect(cycleTab(state, -1)?.path).toBe("b.md");
    const none = activateTab(state, null);
    expect(cycleTab(none, 1)?.path).toBe("a.md");
    expect(cycleTab(none, -1)?.path).toBe("c.md");
    expect(cycleTab(open("a.md"), 1)).toBeNull();
    expect(cycleTab(EMPTY_TABS, 1)).toBeNull();
  });

  it("moves tabs, ignoring out-of-range moves", () => {
    const state = open("a.md", "b.md", "c.md");
    expect(moveTab(state, 0, 2).tabs.map((t) => t.path)).toEqual(["b.md", "c.md", "a.md"]);
    expect(moveTab(state, 0, 9)).toBe(state);
  });

  it("follows a renamed document or folder, active tab included, without duplicates", () => {
    const state = activateTab(open("docs/a.md", "docs/b.md", "x.md"), k("docs/a.md"));
    const renamed = renameTabPath(state, "docs/a.md", "guide/a.md");
    expect(renamed.tabs.map((t) => t.path)).toEqual(["guide/a.md", "docs/b.md", "x.md"]);
    expect(renamed.active).toBe(k("guide/a.md"));
    const folder = renameTabPath(state, "docs/", "guide/");
    expect(folder.tabs.map((t) => t.path)).toEqual(["guide/a.md", "guide/b.md", "x.md"]);
    expect(renameTabPath(state, "nope.md", "y.md")).toBe(state);
    const collide = renameTabPath(open("a.md", "b.md"), "a.md", "b.md");
    expect(collide.tabs.map((t) => t.path)).toEqual(["b.md"]);
  });

  it("drops every tab of a deleted document", () => {
    const state = openTab(openTab(EMPTY_TABS, { path: "a.md", rev: SHA }), { path: "a.md" });
    const dropped = dropTabPath(openTab(state, { path: "b.md" }), "a.md");
    expect(dropped.tabs).toEqual([{ path: "b.md" }]);
    expect(dropTabPath(state, "a.md")).toEqual({ tabs: [], active: null });
  });

  it("evicts the oldest tab that is neither active nor dirty past MAX_TABS", () => {
    let state = EMPTY_TABS;
    for (let i = 0; i < MAX_TABS; i++) state = openTab(state, { path: `${i}.md` });
    state = activateTab(state, k("0.md"));
    const dirty = new Set([k("1.md")]);
    const next = openTab(state, { path: "new.md" }, { isDirty: (key) => dirty.has(key) });
    expect(next.tabs).toHaveLength(MAX_TABS);
    const paths = next.tabs.map((t) => t.path);
    expect(paths).toContain("0.md");
    expect(paths).toContain("1.md");
    expect(paths).not.toContain("2.md");
    expect(next.active).toBe(k("new.md"));
  });

  it("grows past the cap rather than evict unsaved work", () => {
    let state = EMPTY_TABS;
    for (let i = 0; i < MAX_TABS; i++) state = openTab(state, { path: `${i}.md` });
    const next = openTab(state, { path: "new.md" }, { isDirty: () => true });
    expect(next.tabs).toHaveLength(MAX_TABS + 1);
  });
});

describe("restoring tabs after a reload", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("drops garbage and keeps the valid entries", () => {
    for (const raw of [null, 1, "x", [], { tabs: "x" }, { tabs: [] }]) {
      expect(parseStoredTabs(raw)).toBe(EMPTY_TABS);
    }
    const parsed = parseStoredTabs({
      tabs: [
        { path: "a.md", mode: "edit", extra: 1 },
        { path: "a.md" },
        { path: "b.md", rev: "nothex" },
        { path: "c.md", rev: SHA },
        { path: "d.md", proposal: 0 },
        { path: "e.md", proposal: 4 },
        { path: "", pr: 2 },
        { path: "f.md", rev: SHA, proposal: 2 },
        { path: "x".repeat(600) },
        { path: 7 },
        null,
        { path: "", mode: "bogus" },
      ],
      active: tabKey({ path: "c.md", rev: SHA }),
    });
    expect(parsed.tabs).toEqual([
      { path: "a.md", mode: "edit" },
      { path: "c.md", rev: SHA },
      { path: "e.md", proposal: 4 },
      { path: "" },
    ]);
    expect(parsed.active).toBe(tabKey({ path: "c.md", rev: SHA }));
    expect(parseStoredTabs({ tabs: [{ path: "a.md" }], active: "nope" }).active).toBeNull();
  });

  it("caps an oversized stored strip", () => {
    const tabs = Array.from({ length: 500 }, (_, i) => ({ path: `${i}.md` }));
    expect(parseStoredTabs({ tabs }).tabs).toHaveLength(MAX_TABS);
  });

  it("round-trips through localStorage per viewer and KB", () => {
    const data = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => data.get(key) ?? null,
        setItem: (key: string, value: string) => void data.set(key, value),
        removeItem: (key: string) => void data.delete(key),
      },
    });
    const state = open("a.md", "b.md");
    saveTabs("u1", "kb1", state);
    expect(loadTabs("u1", "kb1")).toEqual(state);
    expect(loadTabs("u2", "kb1")).toBe(EMPTY_TABS);
    expect(loadTabs("u1", "kb2")).toBe(EMPTY_TABS);
    saveTabs("u1", "kb1", EMPTY_TABS);
    expect(data.has(tabsStorageKey("u1", "kb1"))).toBe(false);
    data.set(tabsStorageKey("u1", "kb1"), "{not json");
    expect(loadTabs("u1", "kb1")).toBe(EMPTY_TABS);
  });

  it("falls back to an empty strip when storage throws", () => {
    const boom = () => {
      throw new DOMException("blocked", "SecurityError");
    };
    vi.stubGlobal("window", { localStorage: { getItem: boom, setItem: boom, removeItem: boom } });
    expect(loadTabs("u1", "kb1")).toBe(EMPTY_TABS);
    expect(() => saveTabs("u1", "kb1", open("a.md"))).not.toThrow();
    vi.stubGlobal("window", {
      get localStorage() {
        return boom();
      },
    });
    expect(loadTabs("u1", "kb1")).toBe(EMPTY_TABS);
  });
});

describe("retargetTab", () => {
  it("gives a New document tab its path in place, keeping it active", () => {
    let state = openTab(EMPTY_TABS, { path: "a.md" });
    state = openTab(state, { path: "" });
    state = openTab(state, { path: "b.md" });
    state = activateTab(state, tabKey({ path: "" }));
    const next = retargetTab(state, tabKey({ path: "" }), { path: "notes/new.md", mode: "edit" });
    expect(next.tabs.map((tab) => tab.path)).toEqual(["a.md", "notes/new.md", "b.md"]);
    expect(next.active).toBe(tabKey({ path: "notes/new.md" }));
  });
  it("merges into a tab already open on the new target", () => {
    let state = openTab(EMPTY_TABS, { path: "old.md" });
    state = openTab(state, { path: "new.md" });
    state = activateTab(state, tabKey({ path: "old.md" }));
    const next = retargetTab(state, tabKey({ path: "old.md" }), { path: "new.md" });
    expect(next.tabs.map((tab) => tab.path)).toEqual(["new.md"]);
    expect(next.active).toBe(tabKey({ path: "new.md" }));
  });
  it("leaves the strip alone for a tab it doesn't have", () => {
    const state = openTab(EMPTY_TABS, { path: "a.md" });
    expect(retargetTab(state, tabKey({ path: "zzz.md" }), { path: "b.md" })).toBe(state);
  });
});

describe("forgetKbTabs (access to the KB is gone)", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("drops every viewer's tabs of that KB, and only of it", () => {
    const data = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        get length() {
          return data.size;
        },
        key: (i: number) => [...data.keys()][i] ?? null,
        getItem: (k: string) => data.get(k) ?? null,
        setItem: (k: string, v: string) => void data.set(k, v),
        removeItem: (k: string) => void data.delete(k),
      },
    });
    const state = openTab(EMPTY_TABS, { path: "secret/plan.md" });
    saveTabs("u1", "kb1", state);
    saveTabs("u2", "kb1", state);
    saveTabs("u1", "kb2", state);
    data.set("unrelated", "1");
    forgetKbTabs("kb1");
    expect(loadTabs("u1", "kb1")).toBe(EMPTY_TABS);
    expect(loadTabs("u2", "kb1")).toBe(EMPTY_TABS);
    expect(loadTabs("u1", "kb2")).toEqual(state);
    expect(data.get("unrelated")).toBe("1");
  });
});

describe("retargetApplies (a session moved: whose tab follows)", () => {
  const event = (over: Partial<{ owner: string | null; kbId: string; id: number }> = {}) => ({
    owner: "user:u1",
    kbId: "kb1",
    id: 5,
    ...over,
  });
  it("applies only this viewer's and KB's events, and only those after the workspace mounted", () => {
    expect(retargetApplies(event(), 4, "kb1", "user:u1")).toBe(true);
    // Another KB's move (a file created in KB A, then KB B opened) never renames B's tabs.
    expect(retargetApplies(event({ kbId: "kbA" }), 4, "kbB", "user:u1")).toBe(false);
    // Another viewer's session in this KB (a sign-in switch) never renames this viewer's tabs.
    expect(retargetApplies(event({ owner: "user:u2" }), 4, "kb1", "user:u1")).toBe(false);
    expect(retargetApplies(event(), 4, "kb1", null)).toBe(false);
    // An event left over from before this workspace mounted.
    expect(retargetApplies(event({ id: 4 }), 4, "kb1", "user:u1")).toBe(false);
    expect(retargetApplies(null, 0, "kb1", "user:u1")).toBe(false);
  });
});
