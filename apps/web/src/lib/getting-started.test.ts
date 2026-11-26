import { describe, expect, it, vi } from "vitest";

import {
  defaultGettingStartedExpanded,
  type FlagStorage,
  GETTING_STARTED_EXPANDED_QUERY,
  gettingStartedProgress,
  gettingStartedStorageKey,
  hideGettingStarted,
  isGettingStartedHidden,
  setGettingStartedHidden,
  subscribeGettingStartedHidden,
} from "./getting-started";

function memoryStorage(): FlagStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

describe("gettingStartedProgress", () => {
  it("counts done steps from their data-derived flags", () => {
    expect(gettingStartedProgress([{ done: true }, { done: false }, { done: false }])).toEqual({
      done: 1,
      total: 3,
      allDone: false,
    });
  });

  it("is all done (the checklist disappears) once every step is", () => {
    expect(gettingStartedProgress([{ done: true }, { done: true }]).allDone).toBe(true);
  });
});

describe("hidden flag", () => {
  it("is per user: hiding one user's checklist leaves another's", () => {
    const storage = memoryStorage();
    setGettingStartedHidden("user-a", true, storage);
    expect(isGettingStartedHidden("user-a", storage)).toBe(true);
    expect(isGettingStartedHidden("user-b", storage)).toBe(false);
    expect(storage.data.has(gettingStartedStorageKey("user-a"))).toBe(true);
    expect(gettingStartedStorageKey("user-a")).toContain("user-a");
  });

  it("Hide persists, and its Undo clears the stored flag again", () => {
    const storage = memoryStorage();
    let undo: (() => void) | undefined;
    hideGettingStarted("user-a", (offered) => (undo = offered), storage);
    expect(isGettingStartedHidden("user-a", storage)).toBe(true);
    expect(undo).toBeTypeOf("function");
    undo?.();
    expect(isGettingStartedHidden("user-a", storage)).toBe(false);
    expect(storage.data.size).toBe(0);
  });

  it("notifies subscribers on every change", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeGettingStartedHidden(listener);
    setGettingStartedHidden("user-a", true, memoryStorage());
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    setGettingStartedHidden("user-a", false, memoryStorage());
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("reads unreadable storage as 'not hidden', and still hides for this session when the write fails", () => {
    const broken: FlagStorage = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceeded");
      },
      removeItem: () => {
        throw new Error("SecurityError");
      },
    };
    expect(isGettingStartedHidden("broken-user", broken)).toBe(false);
    expect(() => setGettingStartedHidden("broken-user", true, broken)).not.toThrow();
    // Hide worked for this session: no "hidden" toast over a visible list.
    expect(isGettingStartedHidden("broken-user", broken)).toBe(true);
    // Undo works the same way.
    expect(() => setGettingStartedHidden("broken-user", false, broken)).not.toThrow();
    expect(isGettingStartedHidden("broken-user", broken)).toBe(false);
  });

  it("lets the stored flag answer again once a write succeeds", () => {
    const store = new Map<string, string>();
    const ok: FlagStorage = {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => void store.set(k, v),
      removeItem: (k) => void store.delete(k),
    };
    const failing: FlagStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceeded");
      },
      removeItem: () => {},
    };
    setGettingStartedHidden("flaky-user", true, failing);
    setGettingStartedHidden("flaky-user", true, ok);
    // Another tab clears the stored flag: this tab follows it.
    store.clear();
    expect(isGettingStartedHidden("flaky-user", ok)).toBe(false);
  });
});

describe("defaultGettingStartedExpanded", () => {
  it("is collapsed below sm (phones) and expanded from sm up", () => {
    const query = vi.fn((q: string) => ({
      matches: q === GETTING_STARTED_EXPANDED_QUERY && false,
    }));
    expect(defaultGettingStartedExpanded(query)).toBe(false);
    expect(query).toHaveBeenCalledWith("(min-width: 40rem)");
    expect(defaultGettingStartedExpanded(() => ({ matches: true }))).toBe(true);
  });

  it("is expanded when it cannot tell", () => {
    expect(defaultGettingStartedExpanded(undefined)).toBe(true);
  });
});
