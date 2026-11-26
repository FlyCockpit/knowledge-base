/**
 * Recently opened knowledge bases and the sidebar's open/closed state, per
 * viewer, in this browser (localStorage). A convenience only: the sidebar
 * still names a base only when the server says the viewer can read it now
 * (`kbPins.list`'s `recent`), so a remembered id never reveals or opens
 * anything by itself. Blocked storage
 * or a full quota keep it in memory for the page's lifetime.
 */

/** Ids kept per viewer; the sidebar shows fewer. */
export const RECENT_KBS_KEPT = 10;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Reads go to localStorage itself (so another tab's write, announced by the
 * `storage` event, is seen); an in-memory copy is used only for a key whose
 * storage failed (blocked, quota), for this page's lifetime.
 */
const memory = new Map<string, string>();
const storage = {
  getItem(key: string): string | null {
    if (memory.has(key)) return memory.get(key) ?? null;
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem(key: string, value: string): void {
    try {
      window.localStorage.setItem(key, value);
      memory.delete(key);
    } catch {
      memory.set(key, value);
    }
  },
};
const recentKey = (userId: string) => `kb-recent:v1:${JSON.stringify([userId])}`;
const openKey = (userId: string) => `kb-sidebar-open:v1:${JSON.stringify([userId])}`;

/** Stored values are untrusted: keep only well-formed, distinct ids, newest first, capped. */
export function parseRecentKbs(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    const ids = value.filter((id): id is string => typeof id === "string" && ID.test(id));
    return [...new Set(ids)].slice(0, RECENT_KBS_KEPT);
  } catch {
    return [];
  }
}

export function readRecentKbs(userId: string): string[] {
  return parseRecentKbs(storage.getItem(recentKey(userId)));
}

/**
 * A tiny external store over the stored list, for `useSyncExternalStore`:
 * same-tab readers hear `recordRecentKb` at once, other tabs through the
 * `storage` event. Snapshots are cached per viewer (a stable array while the
 * stored text is unchanged).
 */
const listeners = new Set<() => void>();
const snapshots = new Map<string, { raw: string | null; ids: string[] }>();

function notifyRecentKbs(): void {
  for (const listener of listeners) listener();
}

export function subscribeRecentKbs(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key.startsWith("kb-recent:")) listener();
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

/** The viewer's recent ids, the same array until they change. */
export function recentKbsSnapshot(userId: string): string[] {
  const raw = storage.getItem(recentKey(userId));
  const cached = snapshots.get(userId);
  if (cached && cached.raw === raw) return cached.ids;
  const ids = parseRecentKbs(raw);
  snapshots.set(userId, { raw, ids });
  return ids;
}

/** The viewer opened this KB: it moves to the front. Never throws. */
export function recordRecentKb(userId: string, kbId: string): void {
  if (!ID.test(kbId)) return;
  const current = readRecentKbs(userId);
  if (current[0] === kbId) return;
  const next = [kbId, ...current.filter((id) => id !== kbId)].slice(0, RECENT_KBS_KEPT);
  storage.setItem(recentKey(userId), JSON.stringify(next));
  notifyRecentKbs();
}

/** Whether the sidebar's knowledge base list is expanded (default: yes). */
export function readSidebarKbsOpen(userId: string): boolean {
  return storage.getItem(openKey(userId)) !== "false";
}

export function writeSidebarKbsOpen(userId: string, open: boolean): void {
  storage.setItem(openKey(userId), open ? "true" : "false");
}
