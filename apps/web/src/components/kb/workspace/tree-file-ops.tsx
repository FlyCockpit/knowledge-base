import { Button } from "@knowledge-base/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@knowledge-base/ui/components/dialog";
import { toast } from "@knowledge-base/ui/components/sileo";
import { FilePlus, FolderPlus } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { FileTreeProps } from "@/components/kb/workspace/file-tree";
import { NewEntryDialog, type NewEntryKind } from "@/components/kb/workspace/new-entry-dialog";
import {
  rowActionKey,
  rowActions,
  type TreeRowAction,
  TreeRowActions,
} from "@/components/kb/workspace/tree-actions";
import { planDroppedFiles, UploadSummary } from "@/components/kb/workspace/tree-drop";
import {
  dropDraft,
  folderOf,
  movedPath,
  renamedPath,
  type UploadPlan,
} from "@/lib/kb-workspace/file-ops";
import type { WorkspaceTab } from "@/lib/kb-workspace/tabs";
import type { TreeNode } from "@/lib/kb-workspace/tree";
import type { WorkspaceFileRequest } from "@/stores/kb-workspace";

type TreeOpProps = Pick<
  FileTreeProps,
  | "renaming"
  | "onRenamingChange"
  | "onRename"
  | "onMove"
  | "onDropFiles"
  | "renderActions"
  | "onRowKey"
>;

/**
 * Start a New document draft, unless one with unsaved edits is open: that one
 * is never replaced (`refuse` says why).
 */
export function startNewDraft(
  deps: {
    newBusy: () => boolean;
    start: (tab: WorkspaceTab, request: WorkspaceFileRequest) => void;
    refuse: () => void;
  },
  request: Extract<WorkspaceFileRequest, { kind: "new" }>,
) {
  if (deps.newBusy()) deps.refuse();
  else deps.start({ path: "" }, request);
}

/**
 * The workspace tree's file operations for a viewer who may write: New file /
 * New folder, inline rename (F2), drag-to-move, Delete, and OS files dropped
 * on the tree. None of them writes by itself: each opens the file (asking
 * about unsaved work first) and hands its page a request it carries out with
 * its own editing session — kb-sharing's move sheet (one Git rename), the
 * delete confirmation with Undo and Recently deleted, or a New document draft
 * saved with ⌘S. Read-only viewers get nothing here.
 */
export function useTreeFileOps({
  canWrite,
  paths,
  start,
  newBusy,
}: {
  canWrite: boolean;
  /** The KB's document paths (the tree's). */
  paths: readonly string[];
  /** Open `tab` (asking about unsaved work first) and hand its page `request`. */
  start: (tab: WorkspaceTab, request: WorkspaceFileRequest) => void;
  /** A New document with unsaved edits is open: another can't start. */
  newBusy: () => boolean;
}): { treeProps: TreeOpProps; toolbar: ReactNode; dialogs: ReactNode } {
  const { t } = useTranslation("kb");
  const existing = useMemo(() => new Set(paths), [paths]);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [newEntry, setNewEntry] = useState<{ kind: NewEntryKind; folder: string } | null>(null);
  const [drop, setDrop] = useState<{
    files: File[];
    folder: string;
    plan: UploadPlan[];
  } | null>(null);
  const [reading, setReading] = useState(false);

  if (!canWrite) return { treeProps: {}, toolbar: null, dialogs: null };

  const createDraft = (path: string, markdown: string, images: readonly File[]) =>
    startNewDraft(
      { newBusy, start, refuse: () => toast.error(t("workspace.fileOps.newBusy")) },
      { kind: "new", path, markdown, images },
    );
  const run = (action: TreeRowAction, node: TreeNode) => {
    switch (action) {
      case "rename":
        setRenaming(node.path);
        return;
      case "delete":
        start({ path: node.path }, { kind: "delete", path: node.path });
        return;
      case "newFile":
      case "newFolder":
        setNewEntry({
          kind: action === "newFile" ? "file" : "folder",
          folder: node.kind === "folder" ? node.path : folderOf(node.path),
        });
    }
  };
  const onRowKey = (node: TreeNode, event: KeyboardEvent<HTMLDivElement>) => {
    const key = rowActionKey(event);
    const offered = rowActions(node, true);
    if (key === null || offered.length === 0) return false;
    if (key !== "menu" && !offered.includes(key)) return false;
    event.preventDefault();
    if (key === "menu") setMenuFor(node.path);
    else run(key, node);
    return true;
  };
  const draft = drop ? dropDraft(drop.plan, drop.folder) : null;
  const openDrop = async () => {
    if (!drop || !draft) return;
    const markdownFile = draft.markdown === null ? null : drop.files[draft.markdown];
    setReading(true);
    try {
      const markdown = markdownFile ? await markdownFile.text() : "";
      const images = draft.images.flatMap((index) => drop.files[index] ?? []);
      setDrop(null);
      createDraft(draft.path, markdown, images);
    } catch {
      toast.error(t("workspace.fileOps.drop.unreadable"));
    } finally {
      setReading(false);
    }
  };

  const treeProps: TreeOpProps = {
    renaming,
    onRenamingChange: setRenaming,
    onRename: (path, name) => {
      const toPath = renamedPath(path, name);
      if (toPath !== path) start({ path }, { kind: "move", path, toPath });
    },
    onMove: (path, folder) =>
      start({ path }, { kind: "move", path, toPath: movedPath(path, folder) }),
    onDropFiles: (files, folder) =>
      setDrop({ files, folder, plan: planDroppedFiles(files, folder, existing) }),
    renderActions: (node) => (
      <TreeRowActions
        node={node}
        canWrite
        onAction={run}
        open={menuFor === node.path}
        onOpenChange={(open) => setMenuFor(open ? node.path : null)}
      />
    ),
    onRowKey,
  };
  const toolbar = (
    <div className="flex items-center justify-end gap-1 border-b px-2 py-1">
      <Button
        variant="ghost"
        size="icon-touch"
        className="pointer-fine:size-8"
        aria-label={t("workspace.fileOps.newEntry.fileTitle")}
        title={t("workspace.fileOps.newEntry.fileTitle")}
        onClick={() => setNewEntry({ kind: "file", folder: "" })}
      >
        <FilePlus aria-hidden className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon-touch"
        className="pointer-fine:size-8"
        aria-label={t("workspace.fileOps.newEntry.folderTitle")}
        title={t("workspace.fileOps.newEntry.folderTitle")}
        onClick={() => setNewEntry({ kind: "folder", folder: "" })}
      >
        <FolderPlus aria-hidden className="size-4" />
      </Button>
    </div>
  );
  const dialogs = (
    <>
      <NewEntryDialog
        // A fresh form for each entry.
        key={newEntry ? `${newEntry.kind}:${newEntry.folder}` : "closed"}
        kind={newEntry?.kind ?? "file"}
        folder={newEntry?.folder ?? ""}
        open={newEntry !== null}
        onOpenChange={(open) => {
          if (!open) setNewEntry(null);
        }}
        existing={existing}
        onCreate={(path) => {
          setNewEntry(null);
          createDraft(path, "", []);
        }}
      />
      <Dialog
        open={drop !== null}
        onOpenChange={(open) => {
          if (!open && !reading) setDrop(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("workspace.fileOps.drop.summaryTitle", {
                folder: drop?.folder || t("workspace.fileOps.root"),
              })}
            </DialogTitle>
            <DialogDescription>
              {draft ? t("workspace.fileOps.drop.hint") : t("workspace.fileOps.drop.nothing")}
            </DialogDescription>
          </DialogHeader>
          {drop && <UploadSummary plan={drop.plan} />}
          <DialogFooter>
            <Button variant="outline" size="touch" disabled={reading} onClick={() => setDrop(null)}>
              {t("workspace.fileOps.drop.cancel")}
            </Button>
            {draft && (
              <Button size="touch" disabled={reading} onClick={() => void openDrop()}>
                {t("workspace.fileOps.drop.open")}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
  return { treeProps, toolbar, dialogs };
}
