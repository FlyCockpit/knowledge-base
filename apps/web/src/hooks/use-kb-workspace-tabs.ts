import { useEffect, useState } from "react";

import {
  activateTab,
  closeTab,
  cycleTab,
  dropTabPath,
  EMPTY_TABS,
  loadTabs,
  moveTab,
  openTab,
  renameTabPath,
  retargetApplies,
  retargetTab,
  saveTabs,
  type TabsState,
  tabKey,
  type WorkspaceTab,
} from "@/lib/kb-workspace/tabs";
import { useKbWorkspaceStore, type WorkspacePathEvent } from "@/stores/kb-workspace";

/** Apply path changes only to clean main tabs; pinned views and drafts retain their identity. */
export function applyWorkspacePathEvent(
  state: TabsState,
  event: WorkspacePathEvent,
  isDirtyTab?: (tab: WorkspaceTab) => boolean,
): TabsState {
  let active = state.active;
  const tabs: WorkspaceTab[] = [];
  const seen = new Set<string>();
  for (const tab of state.tabs) {
    const key = tabKey(tab);
    const protectedTab =
      tab.path === "" ||
      tab.rev !== undefined ||
      tab.pr !== undefined ||
      tab.proposal !== undefined ||
      isDirtyTab?.(tab);
    const single = { tabs: [tab], active: state.active === key ? key : null };
    const result = protectedTab
      ? single
      : event.kind === "rename"
        ? renameTabPath(single, event.from, event.to)
        : dropTabPath(single, event.path);
    if (state.active === key) active = result.active;
    for (const next of result.tabs) {
      const nextKey = tabKey(next);
      if (!seen.has(nextKey)) {
        seen.add(nextKey);
        tabs.push(next);
      }
    }
  }
  return { tabs, active };
}

/**
 * The open-file tabs of one viewer in one KB, kept in step with the URL:
 *
 * - the URL is the authority for what is shown: a document target in the URL
 *   is opened (or updated) and made active; no target (the KB home) leaves
 *   the strip as it is with nothing active;
 * - the strip itself (which files, their order, the last mode of each) is the
 *   viewer's, restored from localStorage after a reload and saved on change;
 * - another viewer or KB never sees this strip (the key carries both).
 *
 * `isDirtyTab` keeps unsaved tabs from being evicted when the strip is full.
 */
export function useKbWorkspaceTabs(input: {
  userId: string | null;
  kbId: string;
  current: WorkspaceTab | null;
  isDirtyTab?: (tab: WorkspaceTab) => boolean;
}) {
  const { userId, kbId, current, isDirtyTab } = input;
  const dirtyIn = (state: TabsState) => (key: string) => {
    const tab = state.tabs.find((open) => tabKey(open) === key);
    return tab !== undefined && (isDirtyTab?.(tab) ?? false);
  };
  const owner = `${userId ?? ""}\u0000${kbId}`;
  // `synced` is the URL target last applied; `undefined` = none yet, so a
  // workspace that opens on the KB home (target null) still clears a stored
  // active tab instead of keeping it.
  const [store, setStore] = useState<{
    owner: string;
    state: TabsState;
    synced: string | null | undefined;
  }>(() => ({
    owner,
    state: userId ? loadTabs(userId, kbId) : EMPTY_TABS,
    synced: undefined,
  }));
  let live = store;
  // Another viewer or KB: its own strip, read fresh.
  if (live.owner !== owner) {
    live = { owner, state: userId ? loadTabs(userId, kbId) : EMPTY_TABS, synced: undefined };
    setStore(live);
  }
  // The URL's target, once per change of it (a tab closed while shown is not reopened).
  const currentKey = current ? `${tabKey(current)}|${current.mode ?? ""}` : null;
  if (live.synced !== currentKey) {
    const state = current
      ? openTab(live.state, current, { isDirty: dirtyIn(live.state) })
      : activateTab(live.state, null);
    live = { ...live, state, synced: currentKey };
    setStore(live);
  }
  const state = live.state;
  useEffect(() => {
    if (userId) saveTabs(userId, kbId, state);
  }, [userId, kbId, state]);
  // The open document's session moved (created, renamed): its tab follows.
  // Only this KB's moves, and only those after this workspace mounted (an
  // older event belongs to another workspace or KB).
  const retarget = useKbWorkspaceStore((store) => store.retarget);
  const [applied, setApplied] = useState(() => useKbWorkspaceStore.getState().retarget?.id ?? 0);
  if (retarget && retarget.id > applied) {
    setApplied(retarget.id);
    if (retargetApplies(retarget, applied, kbId, userId ? `user:${userId}` : null))
      setStore((prev) =>
        prev.owner === owner
          ? { ...prev, state: retargetTab(prev.state, retarget.from, retarget.to) }
          : prev,
      );
  }
  const pathEvent = useKbWorkspaceStore((store) => store.pathEvent);
  const [appliedPath, setAppliedPath] = useState(
    () => useKbWorkspaceStore.getState().pathEvent?.id ?? 0,
  );
  if (pathEvent && pathEvent.id > appliedPath) {
    setAppliedPath(pathEvent.id);
    // Completed local deletes belong to the pruning lifecycle: it calculates
    // the adjacent tab before removal, after the document installed Undo.
    if (
      !(pathEvent.kind === "delete" && pathEvent.completedLocally) &&
      retargetApplies(pathEvent, appliedPath, kbId, userId ? `user:${userId}` : null)
    )
      setStore((prev) =>
        prev.owner === owner
          ? { ...prev, state: applyWorkspacePathEvent(prev.state, pathEvent, isDirtyTab) }
          : prev,
      );
  }

  const update = (next: (state: TabsState) => TabsState) =>
    setStore((prev) => (prev.owner === owner ? { ...prev, state: next(prev.state) } : prev));

  return {
    state,
    activeKey: state.active,
    /** Remove a tab; returns the tab to show instead when it was the active one. */
    close(key: string): WorkspaceTab | null {
      const result = closeTab(state, key);
      update((prev) => closeTab(prev, key).state);
      return result.next;
    },
    cycle: (delta: 1 | -1) => cycleTab(state, delta),
    /** Add a tab without showing it (Ctrl/⌘+click: open in the background). */
    openInBackground: (tab: WorkspaceTab) =>
      update((prev) => ({
        ...openTab(prev, tab, { isDirty: dirtyIn(prev) }),
        active: prev.active,
      })),
    move: (from: number, to: number) => update((prev) => moveTab(prev, from, to)),
    renamePath: (from: string, to: string) => update((prev) => renameTabPath(prev, from, to)),
    dropPath: (path: string) => update((prev) => dropTabPath(prev, path)),
    dropCleanMainPaths: (paths: readonly string[]) =>
      update((prev) =>
        paths.reduce(
          (state, path) =>
            applyWorkspacePathEvent(
              state,
              { kind: "delete", owner: null, kbId, id: 0, path },
              isDirtyTab,
            ),
          prev,
        ),
      ),
  };
}

export type KbWorkspaceTabs = ReturnType<typeof useKbWorkspaceTabs>;
