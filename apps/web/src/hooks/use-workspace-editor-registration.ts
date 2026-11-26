import { useEffect, useRef } from "react";

import { tabKey, type WorkspaceTab } from "@/lib/kb-workspace/tabs";
import { useKbWorkspaceStore, type WorkspaceEditor } from "@/stores/kb-workspace";

/**
 * Registers the open document's editor with the workspace (⌘S, "close tab",
 * phone Back and `E`) while it is mounted. The registration always calls the
 * latest `save`/`discard`, so a closure of an earlier render never runs.
 * When the session's own target moves (a New document's first save, a
 * rename) its tab is retargeted. `tab` null: nothing registers.
 */
export function useWorkspaceEditorRegistration(
  input: Omit<WorkspaceEditor, "key" | "save" | "discard" | "keepDraft"> & {
    kbId: string;
    /** Whose session this is (the draft owner): a move is that viewer's only. */
    owner: string | null;
    tab: WorkspaceTab | null;
    save: () => Promise<boolean>;
    discard: () => void;
    keepDraft: () => boolean;
  },
): void {
  const latest = useRef(input);
  latest.current = input;
  const register = useKbWorkspaceStore((state) => state.register);
  const unregister = useKbWorkspaceStore((state) => state.unregister);
  const announceRetarget = useKbWorkspaceStore((state) => state.announceRetarget);
  const { kbId, owner, tab, dirty, canSave, canEdit, pending, uploading } = input;
  const key = tab ? tabKey(tab) : null;
  const previous = useRef(key);
  useEffect(() => {
    const from = previous.current;
    previous.current = key;
    if (from !== null && key !== null && from !== key && latest.current.tab)
      announceRetarget(owner, kbId, from, latest.current.tab);
  }, [announceRetarget, owner, kbId, key]);
  useEffect(() => {
    if (key === null) return;
    register({
      key,
      dirty,
      canSave,
      canEdit,
      pending,
      uploading,
      keepDraft: () => latest.current.keepDraft(),
      save: () => latest.current.save(),
      discard: () => latest.current.discard(),
    });
  }, [register, key, dirty, canSave, canEdit, pending, uploading]);
  useEffect(() => {
    if (key === null) return;
    return () => unregister(key);
  }, [unregister, key]);
}
