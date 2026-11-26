import { Button } from "@knowledge-base/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@knowledge-base/ui/components/dropdown-menu";
import { FilePlus, FolderPlus, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { type KeyboardEvent, useRef } from "react";
import { useTranslation } from "react-i18next";

import type { TreeNode } from "@/lib/kb-workspace/tree";

export type TreeRowAction = "rename" | "delete" | "newFile" | "newFolder";

/**
 * Pure: which actions a row offers. Files: rename, delete. Folders: new
 * file / new folder inside (folders are not renamed or deleted as a whole:
 * that is one commit per document). Read-only viewers get none (an open
 * file's link and agent reference are in the workspace header).
 */
export function rowActions(node: Pick<TreeNode, "kind">, canWrite: boolean): TreeRowAction[] {
  if (node.kind === "folder") return canWrite ? ["newFile", "newFolder"] : [];
  return canWrite ? ["rename", "delete"] : [];
}

/**
 * Pure: the action a key on the focused row starts, for the tree's
 * `onRowKey` (rows are not tab stops, so every menu action has a key):
 * F2 renames, Delete deletes, Shift+F10 / the ContextMenu key opens the menu.
 */
export function rowActionKey(
  event: Pick<KeyboardEvent, "key" | "shiftKey" | "ctrlKey" | "metaKey" | "altKey">,
): TreeRowAction | "menu" | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  if (event.key === "F2" && !event.shiftKey) return "rename";
  if (event.key === "Delete" && !event.shiftKey) return "delete";
  if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) return "menu";
  return null;
}

/**
 * Pure: where focus goes when a row's menu closes. Back to the tree (the
 * trigger is no tab stop and the tree ignores its descendants' keys), unless
 * the chosen action already moved focus on: the rename field, a dialog.
 */
export function rowMenuFinalFocus(
  active: Element | null,
  trigger: Element | null,
): HTMLElement | false | true {
  const moved =
    active !== null &&
    active.tagName !== "BODY" &&
    !trigger?.contains(active) &&
    active.closest('[role="menu"]') === null;
  if (moved) return false;
  return trigger?.closest<HTMLElement>('[role="tree"]') ?? true;
}

/** Menu events stay in the menu (see TreeRowActions). */
export const stopRowEvent = (event: { stopPropagation: () => void }) => event.stopPropagation();

const ICONS = {
  rename: Pencil,
  delete: Trash2,
  newFile: FilePlus,
  newFolder: FolderPlus,
} as const;

/**
 * A tree row's overflow menu. The shell runs every file action through the
 * open document's editing session; this only names the action. `open` /
 * `onOpenChange` let the keyboard (Shift+F10) open it.
 */
export function TreeRowActions({
  node,
  canWrite,
  onAction,
  open,
  onOpenChange,
}: {
  node: TreeNode;
  canWrite: boolean;
  onAction: (action: TreeRowAction, node: TreeNode) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const { t } = useTranslation("kb");
  const trigger = useRef<HTMLButtonElement>(null);
  const actions = rowActions(node, canWrite);
  if (actions.length === 0) return null;
  const label = t("workspace.fileOps.actions.label", { name: node.name });
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger
        render={
          <Button
            ref={trigger}
            variant="ghost"
            size="icon"
            // The tree is the tab stop; the menu button is for pointers (keys use onRowKey).
            tabIndex={-1}
            className="size-7 pointer-coarse:size-11"
            aria-label={label}
            title={label}
            onClick={(event) => event.stopPropagation()}
          />
        }
      >
        <MoreHorizontal aria-hidden className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-52"
        // The menu renders in a portal, but React events still bubble to the
        // row behind it: choosing an action must not also open or toggle the
        // row (keys are fine: the tree acts only on its own keydown target).
        onClick={stopRowEvent}
        onMouseDown={stopRowEvent}
        finalFocus={() => rowMenuFinalFocus(document.activeElement, trigger.current)}
      >
        {actions.map((action) => {
          const Icon = ICONS[action];
          return [
            action === "delete" ? <DropdownMenuSeparator key="separator" /> : null,
            <DropdownMenuItem
              key={action}
              variant={action === "delete" ? "destructive" : "default"}
              className="min-h-11 pointer-fine:min-h-8"
              onClick={() => onAction(action, node)}
            >
              <Icon aria-hidden />
              {t(`workspace.fileOps.actions.${action}`)}
            </DropdownMenuItem>,
          ];
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
