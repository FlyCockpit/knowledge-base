import { useEffect } from "react";

import { tabKey, type WorkspaceTab } from "@/lib/kb-workspace/tabs";
import { useKbWorkspaceStore } from "@/stores/kb-workspace";

/**
 * The page shows this file without an editor (not found, deleted, its PR
 * closed, unreadable): the workspace's close question then offers only
 * Discard / Cancel for a draft it kept. `tab` null: an editor (or nothing).
 */
export function useWorkspaceNoEditor(tab: WorkspaceTab | null): void {
  const setNoEditor = useKbWorkspaceStore((state) => state.setNoEditor);
  const key = tab ? tabKey(tab) : null;
  useEffect(() => {
    if (key === null) return;
    setNoEditor(key);
    return () => {
      if (useKbWorkspaceStore.getState().noEditor === key) setNoEditor(null);
    };
  }, [setNoEditor, key]);
}
