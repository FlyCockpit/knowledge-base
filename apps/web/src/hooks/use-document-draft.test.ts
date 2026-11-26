import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  observeDocumentIdentity,
  replaceDocument,
  resetDocumentIdentityForTests,
} from "@/lib/document-identity";

import {
  clearDraft,
  DraftKeeper,
  draftKey,
  forgetKbDrafts,
  guardDraftUnload,
  readDraft,
  storableDraft,
  writeDraft,
} from "./use-document-draft";

/** A Storage like the browser's sessionStorage, in memory. */
function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, String(value)),
  };
}

const BASE = "a".repeat(40);
const target = (over: Partial<Parameters<typeof draftKey>[0]> = {}) =>
  draftKey({ userId: "user:u1", kbId: "kb1", path: "notes/a.md", proposal: null, ...over });

let storage: Storage;
beforeEach(() => {
  storage = memoryStorage();
  vi.stubGlobal("window", { sessionStorage: storage });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("stored drafts", () => {
  it("keys a draft by person, KB, target and path", () => {
    const keys = new Set([
      target(),
      target({ userId: "user:u2" }),
      target({ kbId: "kb2" }),
      target({ path: "" }),
      target({ proposal: 3 }),
    ]);
    expect(keys.size).toBe(5);
  });

  it("keeps PR-mode drafts apart, with the PR head they were written against", () => {
    const resolving = target({ proposal: 4, resolving: true });
    expect(resolving).not.toBe(target({ proposal: 4 }));
    const head = "b".repeat(40);
    writeDraft(resolving, { markdown: "x", base: BASE, proposalHead: head, savedAt: 1 });
    expect(readDraft(resolving)?.proposalHead).toBe(head);
    writeDraft(resolving, { markdown: "x", base: BASE, proposalHead: "nope", savedAt: 1 });
    expect(readDraft(resolving)).toBeNull();
    // Losing the KB drops them too.
    writeDraft(resolving, { markdown: "x", base: BASE, savedAt: 1 });
    forgetKbDrafts("kb1");
    expect(readDraft(resolving)).toBeNull();
  });

  it("round-trips a draft and refuses anything malformed", () => {
    writeDraft(target(), { markdown: "draft", base: BASE, savedAt: 1, path: "x.md" });
    expect(readDraft(target())).toEqual({
      markdown: "draft",
      base: BASE,
      savedAt: 1,
      path: "x.md",
    });
    storage.setItem(
      target({ path: "b.md" }),
      JSON.stringify({ markdown: "x", base: "HEAD", savedAt: 1 }),
    );
    expect(readDraft(target({ path: "b.md" }))).toBeNull();
    storage.setItem(target({ path: "c.md" }), "{not json");
    expect(readDraft(target({ path: "c.md" }))).toBeNull();
    clearDraft(target());
    expect(readDraft(target())).toBeNull();
  });

  it("keeps nothing over the size bound or when the quota is full", () => {
    writeDraft(target(), { markdown: "x".repeat(2 * 1024 * 1024 + 1), base: BASE, savedAt: 1 });
    expect(storage.length).toBe(0);
    storage.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    expect(() => writeDraft(target(), { markdown: "x", base: BASE, savedAt: 1 })).not.toThrow();
    expect(readDraft(target())).toBeNull();
  });

  it("forgets every draft of a KB whose access is gone, and only those", () => {
    writeDraft(target(), { markdown: "a", base: BASE, savedAt: 1 });
    writeDraft(target({ path: "" }), { markdown: "b", base: BASE, savedAt: 1 });
    writeDraft(target({ kbId: "kb2" }), { markdown: "c", base: BASE, savedAt: 1 });
    storage.setItem("unrelated", "kept");
    forgetKbDrafts("kb1");
    expect(readDraft(target())).toBeNull();
    expect(readDraft(target({ path: "" }))).toBeNull();
    expect(readDraft(target({ kbId: "kb2" }))?.markdown).toBe("c");
    expect(storage.getItem("unrelated")).toBe("kept");
  });

  it("works without storage (disabled by privacy settings)", () => {
    vi.stubGlobal("window", {
      get sessionStorage(): Storage {
        throw new Error("SecurityError");
      },
    });
    expect(() => writeDraft(target(), { markdown: "a", base: BASE, savedAt: 1 })).not.toThrow();
    expect(readDraft(target())).toBeNull();
  });
});

describe("storableDraft", () => {
  const block = "\n\n![Uploading a.png](kb-upload:1)\n\n![Uploading b.png](kb-upload:2)\n\n";
  it("puts the replaced selection back where the placeholder block still stands", () => {
    expect(storableDraft(`A${block}B`, { inserted: block, selected: "sel" })).toBe("AselB");
  });
  it("drops placeholders it can't map, keeping finished images and all typing", () => {
    // The first image landed (its link replaced its token): the rest is dropped.
    const partly = "A\n\n![a](../.assets/a.png)\n\n![Uploading b.png](kb-upload:2)\n\nB";
    expect(storableDraft(partly, { inserted: block, selected: "sel" })).toBe(
      "A\n\n![a](../.assets/a.png)\n\nB",
    );
    // No pending insertion known (e.g. a stale token): just removed.
    expect(storableDraft("x ![Uploading](kb-upload:9) y", null)).toBe("x  y");
    expect(storableDraft("plain", null)).toBe("plain");
  });
});

describe("DraftKeeper", () => {
  const state = (over: Partial<Parameters<DraftKeeper["update"]>[0]> = {}) => ({
    key: target(),
    dirty: true,
    pending: false,
    markdown: "draft",
    base: BASE,
    ...over,
  });

  it("stores an unsaved draft after a pause in typing, and at once on flush", () => {
    vi.useFakeTimers();
    const keeper = new DraftKeeper(400);
    keeper.update(state({ markdown: "d" }));
    keeper.update(state({ markdown: "dr" }));
    vi.advanceTimersByTime(399);
    expect(readDraft(target())).toBeNull();
    vi.advanceTimersByTime(1);
    expect(readDraft(target())?.markdown).toBe("dr");
    keeper.update(state({ markdown: "draft!" }));
    keeper.flush();
    expect(readDraft(target())?.markdown).toBe("draft!");
    expect(keeper.guard).toBe(true);
  });

  it("keeps the uploads a draft links with it, so its next save publishes them", () => {
    const image = (path: string) => ({
      path,
      uploadId: `up-${path}`,
      // The form `runImageStage` gives a staged upload's hash.
      hash: `sha256:${"f".repeat(64)}`,
      size: 12,
      mime: "image/png" as const,
      objectUrl: "blob:x",
      sentWith: "save-1",
    });
    const keeper = new DraftKeeper(400);
    keeper.update(
      state({
        markdown: "![a](../.assets/a.png)",
        images: [image("../.assets/a.png"), image("../.assets/unlinked.png")],
      }),
    );
    keeper.flush();
    // Only what the draft links, without local preview URLs or record ids.
    expect(readDraft(target())?.images).toEqual([
      {
        path: "../.assets/a.png",
        uploadId: "up-../.assets/a.png",
        hash: `sha256:${"f".repeat(64)}`,
        size: 12,
        mime: "image/png",
      },
    ]);
    // A malformed image entry makes the whole stored draft unusable.
    writeDraft(target(), {
      markdown: "x",
      base: BASE,
      savedAt: 1,
      images: [{ path: "a.png", uploadId: "u", hash: "f".repeat(64), size: 1, mime: "image/png" }],
    });
    expect(readDraft(target())).toBeNull();
  });

  it("keeps typing done during an upload, with the selection the placeholder replaced", () => {
    const keeper = new DraftKeeper(0);
    const inserted = "\n\n![Uploading a.png](kb-upload:1)\n\n";
    const pendingUpload = { inserted, selected: "selected text" };
    // The insertion replaced "selected text"; then more is typed before and after it.
    keeper.update(
      state({ markdown: `Intro typed later${inserted}Outro typed later`, pendingUpload }),
    );
    keeper.flush();
    expect(readDraft(target())?.markdown).toBe("Intro typed laterselected textOutro typed later");
    expect(keeper.guard).toBe(true);
    // Once staged, the link is the draft's own text again.
    keeper.update(
      state({ markdown: "Intro\n\n![a](../.assets/a.png)\n\nOutro", pendingUpload: null }),
    );
    keeper.flush();
    expect(readDraft(target())?.markdown).toBe("Intro\n\n![a](../.assets/a.png)\n\nOutro");
  });

  it("removes the entry once the draft is saved or discarded", () => {
    const keeper = new DraftKeeper(0);
    keeper.update(state());
    keeper.flush();
    expect(readDraft(target())).not.toBeNull();
    keeper.update(state({ dirty: false }));
    expect(readDraft(target())).toBeNull();
    keeper.flush();
    expect(readDraft(target())).toBeNull();
    expect(keeper.guard).toBe(false);
  });

  it("moves a new draft's entry to its path when its create moves the target", () => {
    const keeper = new DraftKeeper(0);
    const fresh = target({ path: "" });
    keeper.update(state({ key: fresh, path: "notes/new.md" }));
    keeper.flush();
    expect(readDraft(fresh)?.path).toBe("notes/new.md");
    keeper.update(state({ key: target({ path: "notes/new.md" }), dirty: false }));
    expect(readDraft(fresh)).toBeNull();
  });

  it("keeps nothing for a read-only view, and guards a save in flight", () => {
    const keeper = new DraftKeeper(0);
    keeper.update(state({ key: null }));
    keeper.flush();
    expect(storage.length).toBe(0);
    keeper.update(state({ key: null, dirty: false, pending: true }));
    expect(keeper.guard).toBe(true);
  });
});

describe("guardDraftUnload", () => {
  beforeEach(() => resetDocumentIdentityForTests(() => undefined));

  it("keeps the draft and asks to confirm leaving", () => {
    const keeper = { flush: vi.fn() };
    const event = { preventDefault: vi.fn() };
    guardDraftUnload(keeper, event);
    expect(keeper.flush).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });

  it("keeps the draft but never holds back the load that replaces the document", () => {
    // Another account was confirmed: the page is hidden and its cache sealed
    // before the reload, so a "Stay" would strand a blank page.
    vi.stubGlobal("window", { sessionStorage: storage, location: { reload: vi.fn() } });
    observeDocumentIdentity("a");
    expect(observeDocumentIdentity("b")).toBe(true);
    replaceDocument();
    const keeper = { flush: vi.fn() };
    const event = { preventDefault: vi.fn() };
    guardDraftUnload(keeper, event);
    expect(keeper.flush).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});
