/**
 * Open-file tabs of the KB workspace: a pure state machine plus its
 * per-viewer localStorage copy. The URL stays the authority for which file
 * is shown; this only remembers which files are open and which was last
 * active, so a reload restores the strip.
 */

/** One open file: a document target as the document route names it. */
export type WorkspaceTab = {
  /** "" is the New document draft. */
  path: string;
  proposal?: number;
  rev?: string;
  pr?: number;
  /** The tab was last shown with its edit view open. */
  mode?: "edit";
};

export type TabsState = { tabs: WorkspaceTab[]; active: string | null };

/** Never mutated: every transition returns a new state. */
export const EMPTY_TABS: TabsState = { tabs: [], active: null };

/** Opening beyond this evicts the oldest tab that is neither active nor dirty. */
export const MAX_TABS = 20;

const SHA = /^[0-9a-f]{40}$/;
const PATH_MAX = 512;

/** A tab's identity: its path and the version it shows (main, a pinned revision, a proposal or PR mode). */
export function tabKey(tab: Pick<WorkspaceTab, "path" | "proposal" | "rev" | "pr">): string {
  return JSON.stringify([tab.path, tab.proposal ?? null, tab.rev ?? null, tab.pr ?? null]);
}

const keyOf = (tab: WorkspaceTab) => tabKey(tab);

/**
 * Open a tab (or update the open one's mode) and make it active. A full
 * strip evicts its oldest tab that is neither active nor dirty; with none
 * evictable the strip grows past the cap rather than lose unsaved work.
 */
export function openTab(
  state: TabsState,
  tab: WorkspaceTab,
  opts: { isDirty?: (key: string) => boolean } = {},
): TabsState {
  const key = keyOf(tab);
  const at = state.tabs.findIndex((open) => keyOf(open) === key);
  if (at >= 0) {
    const current = state.tabs[at]!;
    const tabs =
      current.mode === tab.mode
        ? state.tabs
        : state.tabs.map((open, index) => (index === at ? normalize(tab) : open));
    return tabs === state.tabs && state.active === key ? state : { tabs, active: key };
  }
  let tabs = [...state.tabs, normalize(tab)];
  while (tabs.length > MAX_TABS) {
    const victim = tabs.findIndex((open) => {
      const k = keyOf(open);
      return k !== key && k !== state.active && !opts.isDirty?.(k);
    });
    if (victim < 0) break;
    tabs = tabs.filter((_, index) => index !== victim);
  }
  return { tabs, active: key };
}

function normalize(tab: WorkspaceTab): WorkspaceTab {
  const out: WorkspaceTab = { path: tab.path };
  if (tab.proposal !== undefined) out.proposal = tab.proposal;
  if (tab.rev !== undefined) out.rev = tab.rev;
  if (tab.pr !== undefined) out.pr = tab.pr;
  if (tab.mode === "edit") out.mode = "edit";
  return out;
}

/** Mark a tab active (null: no file shown, e.g. the KB home). Unknown keys clear it. */
export function activateTab(state: TabsState, key: string | null): TabsState {
  const next = key !== null && state.tabs.some((tab) => keyOf(tab) === key) ? key : null;
  return next === state.active ? state : { ...state, active: next };
}

/**
 * Close a tab. `next` is the neighbour to show when the closed tab was the
 * active one (the tab to its right, else to its left), null when it was not
 * active or nothing is left.
 */
export function closeTab(
  state: TabsState,
  key: string,
): { state: TabsState; next: WorkspaceTab | null } {
  const at = state.tabs.findIndex((tab) => keyOf(tab) === key);
  if (at < 0) return { state, next: null };
  const tabs = state.tabs.filter((_, index) => index !== at);
  if (state.active !== key) return { state: { tabs, active: state.active }, next: null };
  const next = tabs[at] ?? tabs[at - 1] ?? null;
  return { state: { tabs, active: next ? keyOf(next) : null }, next };
}

/** The tab `delta` places from the active one, wrapping; the first/last when none is active. */
export function cycleTab(state: TabsState, delta: 1 | -1): WorkspaceTab | null {
  const count = state.tabs.length;
  if (count === 0) return null;
  const at = state.tabs.findIndex((tab) => keyOf(tab) === state.active);
  if (at < 0) return state.tabs[delta === 1 ? 0 : count - 1]!;
  if (count === 1) return null;
  return state.tabs[(at + delta + count) % count]!;
}

export function moveTab(state: TabsState, from: number, to: number): TabsState {
  const count = state.tabs.length;
  if (from === to || from < 0 || from >= count || to < 0 || to >= count) return state;
  const tabs = [...state.tabs];
  const [moved] = tabs.splice(from, 1);
  tabs.splice(to, 0, moved!);
  return { ...state, tabs };
}

/** A document (or a folder: `from` ending in "/") moved: its tabs follow it, active one included. */
export function renameTabPath(state: TabsState, from: string, to: string): TabsState {
  const folder = from.endsWith("/");
  const moved = (path: string) =>
    folder
      ? path.startsWith(from)
        ? to + path.slice(from.length)
        : null
      : path === from
        ? to
        : null;
  let active = state.active;
  let changed = false;
  const tabs: WorkspaceTab[] = [];
  const seen = new Set<string>();
  for (const tab of state.tabs) {
    const target = moved(tab.path);
    const next = target === null ? tab : { ...tab, path: target };
    if (target !== null) {
      changed = true;
      if (state.active === keyOf(tab)) active = keyOf(next);
    }
    const key = keyOf(next);
    if (seen.has(key)) continue;
    seen.add(key);
    tabs.push(next);
  }
  return changed ? { tabs, active } : state;
}

/**
 * One tab now shows another target: a New document's first save gave it a
 * path, or a rename/move moved it. The tab keeps its place (and stays active
 * if it was); a tab already open on the new target merges into it.
 */
export function retargetTab(state: TabsState, fromKey: string, to: WorkspaceTab): TabsState {
  const at = state.tabs.findIndex((tab) => keyOf(tab) === fromKey);
  if (at < 0) return state;
  const next = normalize({ ...to, mode: to.mode ?? state.tabs[at]!.mode });
  const toKey = keyOf(next);
  const tabs = state.tabs
    .map((tab, index) => (index === at ? next : tab))
    .filter((tab, index) => index === at || keyOf(tab) !== toKey);
  const active = state.active === fromKey ? toKey : state.active;
  return { tabs, active };
}

/**
 * Whether a session-move event (`retargetTab`) belongs to this workspace: it
 * must name this viewer and KB and be newer than the last one seen (events
 * from before the workspace mounted belong to another workspace).
 */
export function retargetApplies(
  event: { owner: string | null; kbId: string; id: number } | null,
  lastSeen: number,
  kbId: string,
  owner: string | null,
): boolean {
  return (
    event !== null &&
    event.id > lastSeen &&
    event.kbId === kbId &&
    owner !== null &&
    event.owner === owner
  );
}

/** A document was deleted: close its tabs (every version of it). */
export function dropTabPath(state: TabsState, path: string): TabsState {
  const tabs = state.tabs.filter((tab) => tab.path !== path);
  if (tabs.length === state.tabs.length) return state;
  const active = tabs.some((tab) => keyOf(tab) === state.active) ? state.active : null;
  return { tabs, active };
}

const positiveInt = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;

/** Stored tabs are untrusted (older builds, hand edits, other tabs): anything invalid is dropped. */
export function parseStoredTabs(raw: unknown): TabsState {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return EMPTY_TABS;
  const value = raw as { tabs?: unknown; active?: unknown };
  if (!Array.isArray(value.tabs)) return EMPTY_TABS;
  const tabs: WorkspaceTab[] = [];
  const seen = new Set<string>();
  for (const entry of value.tabs.slice(0, MAX_TABS * 4)) {
    if (tabs.length >= MAX_TABS) break;
    if (typeof entry !== "object" || entry === null) continue;
    const item = entry as Record<string, unknown>;
    if (typeof item.path !== "string" || item.path.length > PATH_MAX) continue;
    if (item.rev !== undefined && (typeof item.rev !== "string" || !SHA.test(item.rev))) continue;
    if (item.proposal !== undefined && positiveInt(item.proposal) === undefined) continue;
    if (item.pr !== undefined && positiveInt(item.pr) === undefined) continue;
    // PR mode always names a path; a pinned revision and a proposal exclude each other.
    if (item.pr !== undefined && item.path === "") continue;
    if (item.rev !== undefined && item.proposal !== undefined) continue;
    const tab = normalize({
      path: item.path,
      proposal: positiveInt(item.proposal),
      rev: typeof item.rev === "string" ? item.rev : undefined,
      pr: positiveInt(item.pr),
      mode: item.mode === "edit" ? "edit" : undefined,
    });
    const key = keyOf(tab);
    if (seen.has(key)) continue;
    seen.add(key);
    tabs.push(tab);
  }
  const active = typeof value.active === "string" && seen.has(value.active) ? value.active : null;
  return tabs.length === 0 ? EMPTY_TABS : { tabs, active };
}

const TABS_PREFIX = "kb-workspace:v1:tabs:";

export function tabsStorageKey(userId: string, kbId: string): string {
  return `${TABS_PREFIX}${JSON.stringify([userId, kbId])}`;
}

function local(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** This viewer's open tabs of the KB; blocked storage or a bad copy gives an empty strip. */
export function loadTabs(userId: string, kbId: string): TabsState {
  try {
    const raw = local()?.getItem(tabsStorageKey(userId, kbId));
    return raw ? parseStoredTabs(JSON.parse(raw)) : EMPTY_TABS;
  } catch {
    return EMPTY_TABS;
  }
}

export function saveTabs(userId: string, kbId: string, state: TabsState): void {
  try {
    const store = local();
    if (!store) return;
    const key = tabsStorageKey(userId, kbId);
    if (state.tabs.length === 0) store.removeItem(key);
    else store.setItem(key, JSON.stringify({ tabs: state.tabs, active: state.active }));
  } catch {
    // Quota or blocked storage: the strip just isn't remembered.
  }
}

/** Access to the KB is gone (or it was deleted): forget every viewer's tabs of it in this browser; they name its files. */
export function forgetKbTabs(kbId: string): void {
  try {
    const store = local();
    if (!store) return;
    const doomed: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (!key?.startsWith(TABS_PREFIX)) continue;
      try {
        const [, kb] = JSON.parse(key.slice(TABS_PREFIX.length)) as unknown[];
        if (kb === kbId) doomed.push(key);
      } catch {
        doomed.push(key);
      }
    }
    for (const key of doomed) store.removeItem(key);
  } catch {
    // Nothing stored.
  }
}
