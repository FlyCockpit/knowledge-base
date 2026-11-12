import { describe, expect, it } from "vitest";

import { guardedStorage, mergeUiPreferences } from "./ui-preferences";

const current = {
  sidebarCollapsed: false,
  toggleSidebar: () => {},
  setSidebarCollapsed: () => {},
};

describe("ui preferences", () => {
  it("restores a stored sidebar collapse", () => {
    expect(mergeUiPreferences({ sidebarCollapsed: true }, current).sidebarCollapsed).toBe(true);
  });

  it("ignores stored values that are not a boolean", () => {
    for (const stored of [null, [], "x", { sidebarCollapsed: "yes" }, { other: 1 }]) {
      expect(mergeUiPreferences(stored, current).sidebarCollapsed).toBe(false);
    }
    expect(mergeUiPreferences({ sidebarCollapsed: true }, current).toggleSidebar).toBe(
      current.toggleSidebar,
    );
  });
});

function fakeStorage(fail: { get?: boolean; set?: boolean; remove?: boolean }): Storage {
  const data = new Map<string, string>();
  const quota = () => new DOMException("full", "QuotaExceededError");
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    key: (index) => [...data.keys()][index] ?? null,
    getItem: (name) => {
      if (fail.get) throw new DOMException("blocked", "SecurityError");
      return data.get(name) ?? null;
    },
    setItem: (name, value) => {
      if (fail.set) throw quota();
      data.set(name, value);
    },
    removeItem: (name) => {
      if (fail.remove) throw new DOMException("blocked", "SecurityError");
      data.delete(name);
    },
  };
}

describe("guarded preference storage", () => {
  it("persists through working storage", () => {
    const backing = fakeStorage({});
    guardedStorage(() => backing).setItem("p", "1");
    expect(backing.getItem("p")).toBe("1");
    expect(guardedStorage(() => backing).getItem("p")).toBe("1");
  });

  it("keeps working in memory when the quota is exhausted", () => {
    const storage = guardedStorage(() => fakeStorage({ set: true }));
    expect(() => storage.setItem("p", "collapsed")).not.toThrow();
    expect(storage.getItem("p")).toBe("collapsed");
    expect(() => storage.removeItem("p")).not.toThrow();
    expect(storage.getItem("p")).toBeNull();
  });

  it("survives blocked storage on every call, including getting the storage itself", () => {
    const blocked = guardedStorage(() => fakeStorage({ get: true, set: true, remove: true }));
    expect(blocked.getItem("p")).toBeNull();
    expect(() => blocked.setItem("p", "1")).not.toThrow();
    expect(blocked.getItem("p")).toBe("1");
    expect(() => blocked.removeItem("p")).not.toThrow();
    const missing = guardedStorage(() => {
      throw new DOMException("denied", "SecurityError");
    });
    expect(() => missing.setItem("p", "1")).not.toThrow();
    expect(missing.getItem("p")).toBe("1");
  });

  it("lets the store toggle when every write fails", async () => {
    const { useUiPreferences } = await import("./ui-preferences");
    const original = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: fakeStorage({ set: true }),
    });
    try {
      const before = useUiPreferences.getState().sidebarCollapsed;
      expect(() => useUiPreferences.getState().toggleSidebar()).not.toThrow();
      expect(useUiPreferences.getState().sidebarCollapsed).toBe(!before);
    } finally {
      Object.defineProperty(globalThis, "localStorage", { configurable: true, value: original });
    }
  });
});
