import { useEffect, useRef } from "react";
import {
  closeTab,
  retargetApplies,
  type TabsState,
  tabKey,
  type WorkspaceTab,
} from "@/lib/kb-workspace/tabs";
import { useKbWorkspaceStore } from "@/stores/kb-workspace";

export type DeletedTabsPrune = {
  paths: string[];
  activeDeleted: WorkspaceTab | null;
  next: WorkspaceTab | null;
  completedLocally?: true;
};

/** Calculate removals from a complete snapshot; direct visits to missing pages stay open. */
export function deletedTabsToPrune(input: {
  state: TabsState;
  paths: readonly string[];
  previous: ReadonlySet<string> | null;
  previousCurrentKey: string | null;
  current: WorkspaceTab | null;
  isDirtyTab: (tab: WorkspaceTab) => boolean;
  isPendingTab?: (tab: WorkspaceTab) => boolean;
}): DeletedTabsPrune {
  const present = new Set(input.paths);
  const currentKey = input.current ? tabKey(input.current) : null;
  let state = input.state;
  let activeDeleted: WorkspaceTab | null = null;
  const paths: string[] = [];
  for (const tab of input.state.tabs) {
    const key = tabKey(tab);
    if (
      !tab.path ||
      tab.rev !== undefined ||
      tab.pr !== undefined ||
      tab.proposal !== undefined ||
      input.isDirtyTab(tab) ||
      input.isPendingTab?.(tab) ||
      present.has(tab.path)
    )
      continue;
    if (key === currentKey && (!input.previous?.has(tab.path) || input.previousCurrentKey !== key))
      continue;
    if (key === currentKey) activeDeleted = tab;
    paths.push(tab.path);
    state = closeTab(state, key).state;
  }
  return {
    paths,
    activeDeleted,
    next: activeDeleted ? (state.tabs.find((tab) => tabKey(tab) === state.active) ?? null) : null,
  };
}

/** Explicit completion uses live tab order, even before the refreshed tree arrives. */
export function completedDeleteTabsToPrune(input: {
  state: TabsState;
  current: WorkspaceTab | null;
  path: string;
  selectNext: boolean;
  isDirtyTab: (tab: WorkspaceTab) => boolean;
}): DeletedTabsPrune {
  const current = input.selectNext ? input.current : null;
  return {
    ...deletedTabsToPrune({
      state: input.state,
      paths: input.state.tabs.flatMap((tab) => (tab.path === input.path ? [] : [tab.path])),
      previous: new Set(input.state.tabs.map((tab) => tab.path)),
      previousCurrentKey: current ? tabKey(current) : null,
      current,
      isDirtyTab: input.isDirtyTab,
    }),
    completedLocally: true,
  };
}

/** Only pass successful, complete tree snapshots; null means loading, error, or truncated. */
export function usePruneDeletedTabs(input: {
  owner: string | null;
  kbId: string;
  paths: readonly string[] | null;
  state: TabsState;
  current: WorkspaceTab | null;
  isDirtyTab: (tab: WorkspaceTab) => boolean;
  isPendingTab?: (tab: WorkspaceTab) => boolean;
  onPrune: (result: DeletedTabsPrune) => void;
}): void {
  const { owner, kbId, paths, state, current, isDirtyTab, isPendingTab, onPrune } = input;
  const pathEvent = useKbWorkspaceStore((store) => store.pathEvent);
  const appliedEvent = useRef(pathEvent?.id ?? 0);
  const snapshots = useRef<{
    scope: string;
    paths: ReadonlySet<string> | null;
    currentKey: string | null;
    pending: Set<string>;
  }>({ scope: "", paths: null, currentKey: null, pending: new Set() });
  useEffect(() => {
    const scope = JSON.stringify([owner, kbId]);
    if (snapshots.current.scope !== scope)
      snapshots.current = { scope, paths: null, currentKey: null, pending: new Set() };
    const snapshot = snapshots.current;
    if (!owner) return;
    if (pathEvent && pathEvent.id > appliedEvent.current) {
      const applies = retargetApplies(pathEvent, appliedEvent.current, kbId, owner);
      appliedEvent.current = pathEvent.id;
      if (applies && pathEvent.kind === "delete" && pathEvent.completedLocally) {
        const result = completedDeleteTabsToPrune({
          state,
          current,
          path: pathEvent.path,
          selectNext: pathEvent.selectNext === true,
          isDirtyTab,
        });
        for (const path of result.paths) snapshot.pending.add(path);
        if (result.paths.length) onPrune(result);
        return;
      }
    }
    if (paths === null) return;
    const previousCurrentKey = snapshot.currentKey;
    snapshot.currentKey = current ? tabKey(current) : null;
    const result = deletedTabsToPrune({
      state,
      paths,
      previous: snapshot.paths,
      previousCurrentKey,
      current,
      isDirtyTab,
      isPendingTab,
    });
    const present = new Set(paths);
    // A pending local write keeps the last known presence until its callback
    // owns completion, or a failure releases it back to external pruning.
    for (const tab of state.tabs)
      if (isPendingTab?.(tab) && snapshot.paths?.has(tab.path)) present.add(tab.path);
    snapshot.paths = present;
    const fresh = result.paths.filter((path) => !snapshot.pending.has(path));
    for (const path of fresh) snapshot.pending.add(path);
    for (const path of snapshot.pending)
      if (!state.tabs.some((tab) => tab.path === path)) snapshot.pending.delete(path);
    if (fresh.length) onPrune({ ...result, paths: fresh });
  }, [owner, kbId, paths, state, current, isDirtyTab, isPendingTab, onPrune, pathEvent]);
}
