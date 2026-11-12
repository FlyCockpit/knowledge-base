import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

interface UiPreferencesState {
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
}

/**
 * Web storage that never throws: blocked storage (private mode, disabled site
 * data) and a full quota fall back to an in-memory copy, so preferences still
 * work for this page's lifetime. zustand only guards the `getStorage()` call,
 * not each read or write.
 */
export function guardedStorage(getStorage: () => Storage): StateStorage {
  const memory = new Map<string, string>();
  const storage = () => {
    try {
      return getStorage();
    } catch {
      return null;
    }
  };
  return {
    getItem: (name) => {
      if (memory.has(name)) return memory.get(name) ?? null;
      try {
        return storage()?.getItem(name) ?? null;
      } catch {
        return null;
      }
    },
    setItem: (name, value) => {
      memory.set(name, value);
      try {
        storage()?.setItem(name, value);
      } catch {
        // Kept in memory only (e.g. QuotaExceededError).
      }
    },
    removeItem: (name) => {
      memory.delete(name);
      try {
        storage()?.removeItem(name);
      } catch {
        // Nothing persisted to remove.
      }
    },
  };
}

/** Stored values are untrusted (older builds, hand edits): anything but a boolean falls back. */
export function mergeUiPreferences(
  persisted: unknown,
  current: UiPreferencesState,
): UiPreferencesState {
  const stored =
    typeof persisted === "object" && persisted !== null && !Array.isArray(persisted)
      ? (persisted as Record<string, unknown>)
      : {};
  const sidebarCollapsed =
    typeof stored.sidebarCollapsed === "boolean"
      ? stored.sidebarCollapsed
      : current.sidebarCollapsed;
  return { ...current, sidebarCollapsed };
}

export const useUiPreferences = create<UiPreferencesState>()(
  persist(
    (set) => ({
      sidebarCollapsed: false,
      toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
    }),
    {
      name: "ui-preferences",
      // Reads and writes can throw (blocked storage, full quota); the guard
      // keeps the preference in memory then, so collapsing still works.
      storage: createJSONStorage(() => guardedStorage(() => localStorage)),
      merge: mergeUiPreferences,
    },
  ),
);
