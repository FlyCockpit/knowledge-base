import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import type { WorkspaceTab } from "@/lib/kb-workspace/tabs";
import { guardedStorage } from "@/stores/ui-preferences";

/**
 * The document the workspace shows registers its editor here, so the shell's
 * ⌘S and "close tab" act on the live draft without owning it. Never
 * persisted: a draft's own safety (sessionStorage) belongs to the editor.
 */
export type WorkspaceEditor = {
  /** The tab it belongs to (`tabKey`). */
  key: string;
  dirty: boolean;
  /** A save is possible now (writable, not pending, valid). */
  canSave: boolean;
  /** The viewer may open the edit view of this document (`E`). */
  canEdit: boolean;
  /** A save of this session is in flight: closing or discarding waits for it. */
  pending: boolean;
  /**
   * An image is still uploading into the draft (its placeholder is in the
   * text): no save, no hiding the editor, no discarding until it settles.
   */
  uploading: boolean;
  /**
   * Store its unsaved draft in this browser tab now; true when it really was
   * kept (so the tab can be left without asking).
   */
  keepDraft: () => boolean;
  /** Resolves true once saved (or proposed), false when the save did not go through. */
  save: () => Promise<boolean>;
  /** Back to what the document holds; also forgets the kept draft. */
  discard: () => void;
};

type EditorRegistry = {
  editor: WorkspaceEditor | null;
  register: (editor: WorkspaceEditor) => void;
  /** Only the registration of `key` is removed: a newer editor stays. */
  unregister: (key: string) => void;
  /**
   * The open document's session moved to another target (a New document's
   * first save, a rename): its tab follows. `id` tells repeated moves apart.
   */
  /**
   * The tab key of a file the page shows without an editor (not found,
   * deleted, its PR closed, unreadable): leaving it has nothing to save.
   */
  noEditor: string | null;
  setNoEditor: (key: string | null) => void;
  retarget: {
    owner: string | null;
    kbId: string;
    from: string;
    to: WorkspaceTab;
    id: number;
  } | null;
  announceRetarget: (owner: string | null, kbId: string, from: string, to: WorkspaceTab) => void;
};

export const useKbWorkspaceStore = create<EditorRegistry>()((set) => ({
  editor: null,
  register: (editor) => set({ editor }),
  unregister: (key) => set((state) => (state.editor?.key === key ? { editor: null } : state)),
  noEditor: null,
  setNoEditor: (key) => set({ noEditor: key }),
  retarget: null,
  announceRetarget: (owner, kbId, from, to) =>
    set((state) => ({ retarget: { owner, kbId, from, to, id: (state.retarget?.id ?? 0) + 1 } })),
}));

export const TREE_WIDTH_DEFAULT = 288;
export const TREE_WIDTH_MIN = 200;
export const TREE_WIDTH_MAX = 640;

export const clampTreeWidth = (width: number) =>
  Math.round(Math.min(TREE_WIDTH_MAX, Math.max(TREE_WIDTH_MIN, width)));

const SIDEBAR_VIEWS = ["files", "search", "outline", "activity"] as const;
export type WorkspaceSidebarView = (typeof SIDEBAR_VIEWS)[number];

type WorkspaceLayout = {
  treeWidth: number;
  treeOpen: boolean;
  /** Which view the left pane shows: the files, search, or the open document's outline. */
  sidebarView: WorkspaceSidebarView;
  setSidebarView: (view: WorkspaceSidebarView) => void;
  setTreeWidth: (width: number) => void;
  setTreeOpen: (open: boolean) => void;
  toggleTree: () => void;
};

/** Stored values are untrusted: anything out of range or of the wrong type falls back. */
export function mergeWorkspaceLayout(
  persisted: unknown,
  current: WorkspaceLayout,
): WorkspaceLayout {
  const stored =
    typeof persisted === "object" && persisted !== null && !Array.isArray(persisted)
      ? (persisted as Record<string, unknown>)
      : {};
  const treeWidth =
    typeof stored.treeWidth === "number" && Number.isFinite(stored.treeWidth)
      ? clampTreeWidth(stored.treeWidth)
      : current.treeWidth;
  const treeOpen = typeof stored.treeOpen === "boolean" ? stored.treeOpen : current.treeOpen;
  const sidebarView =
    SIDEBAR_VIEWS.find((view) => view === stored.sidebarView) ?? current.sidebarView;
  return { ...current, treeWidth, treeOpen, sidebarView };
}

export const useKbWorkspaceLayout = create<WorkspaceLayout>()(
  persist(
    (set) => ({
      treeWidth: TREE_WIDTH_DEFAULT,
      treeOpen: true,
      sidebarView: "files",
      setSidebarView: (view) => set({ sidebarView: view }),
      setTreeWidth: (width) => set({ treeWidth: clampTreeWidth(width) }),
      setTreeOpen: (open) => set({ treeOpen: open }),
      toggleTree: () => set((state) => ({ treeOpen: !state.treeOpen })),
    }),
    {
      name: "kb-workspace-layout",
      storage: createJSONStorage(() => guardedStorage(() => localStorage)),
      partialize: (state) => ({
        treeWidth: state.treeWidth,
        treeOpen: state.treeOpen,
        sidebarView: state.sidebarView,
      }),
      merge: mergeWorkspaceLayout,
    },
  ),
);
