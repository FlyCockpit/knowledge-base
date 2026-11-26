import { cn } from "@knowledge-base/ui/lib/utils";
import { ChevronRight, FileText, Folder, FolderOpen } from "lucide-react";
import {
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { useTreeFileDrop } from "@/components/kb/workspace/tree-drop";
import { useMediaQuery } from "@/hooks/use-media-query";
import { dataTransferHasFiles } from "@/lib/file-drop-registry";
import { canDrop, folderOf } from "@/lib/kb-workspace/file-ops";
import {
  ancestorsOf,
  buildTree,
  isTreeKey,
  type TreeNode,
  type TreeRow,
  treeKeyAction,
  typeahead,
  visibleRows,
} from "@/lib/kb-workspace/tree";

/** Rows rendered above and below the visible window. */
const OVERSCAN = 8;
/** Row heights: compact for a mouse, 44px touch targets on a coarse pointer. */
const ROW_FINE = 32;
const ROW_COARSE = 44;
/** Type-ahead keeps collecting letters typed within this long of each other. */
const TYPEAHEAD_MS = 600;

export type FileTreeProps = {
  /** Every document path of the KB (files only; folders come from them). */
  paths: readonly string[];
  /** Folders without a file yet (made in the UI), ending in "/". */
  extraFolders?: readonly string[];
  /** The file shown now: selected, and its folders are opened for it. */
  activePath: string | null;
  dirtyPaths?: ReadonlySet<string>;
  /** Small trailing markers per path (e.g. "changed by an agent"). */
  badges?: ReadonlyMap<string, ReactNode>;
  /** `keyboard`: opened with Enter, so focus stays in the tree for more browsing. */
  onOpen: (path: string, opts: { newTab?: boolean; keyboard?: boolean }) => void;
  /**
   * Pointer actions of a row (an overflow menu). Every action must also be
   * reachable from the keyboard through `onRowKey` (F2, Delete, …): the
   * rows themselves are not tab stops.
   */
  renderActions?: (node: TreeNode) => ReactNode;
  /** A key on the focused row the tree does not use itself; return true when handled. */
  onRowKey?: (node: TreeNode, event: KeyboardEvent<HTMLDivElement>) => boolean;
  ariaLabel: string;
  className?: string;
  /**
   * Inline rename of a file row (F2, or the shell's menu via `renaming`).
   * Enter commits with the typed name, Escape or leaving the field cancels.
   */
  onRename?: (path: string, newName: string) => void;
  /** The row being renamed (controlled); omitted: the tree keeps it itself. */
  renaming?: string | null;
  onRenamingChange?: (path: string | null) => void;
  /** Drag a file row onto a folder row (or empty space: the top level) to move it. */
  onMove?: (path: string, targetFolder: string) => void;
  /** OS files dropped on a folder row, a file row (its folder) or empty space (the top level). */
  onDropFiles?: (files: File[], folder: string) => void;
};

/** In-page drags of a tree row carry its path under this type (never "Files"). */
export const TREE_DRAG_TYPE = "application/x-kb-tree-path";

/**
 * Pure: a drag event the tree's own (empty-space) handler sees that a row
 * already handled — events bubble from the row, and the row's folder stands.
 */
export function rowOwnsDragEvent(target: EventTarget | null, node: object | null): boolean {
  if (node !== null || target === null || !("closest" in target)) return false;
  return (target as Element).closest('[role="treeitem"]') !== null;
}

/** Pure: the folder a drag over `node` (null: empty space) targets. */
export function dropFolderFor(node: Pick<TreeNode, "kind" | "path"> | null): string {
  if (!node) return "";
  return node.kind === "folder" ? node.path : folderOf(node.path);
}

/** Pure: the expanded set after the active file changed, so it is visible. */
export function revealPath(
  expanded: ReadonlySet<string>,
  path: string | null,
): ReadonlySet<string> {
  if (!path) return expanded;
  const missing = ancestorsOf(path).filter((folder) => !expanded.has(folder));
  if (missing.length === 0) return expanded;
  return new Set([...expanded, ...missing]);
}

/** Pure: which row indices to render for a scroll window (plus the focused row, always). */
export function windowRange(
  count: number,
  scrollTop: number,
  height: number,
  rowHeight: number,
  focusIndex: number,
): number[] {
  if (count === 0) return [];
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN);
  // Before the scroller is measured, render one screenful.
  const visible = Math.ceil((height > 0 ? height : 800) / rowHeight);
  const last = Math.min(count - 1, first + visible + OVERSCAN * 2);
  const out: number[] = [];
  for (let i = first; i <= last; i++) out.push(i);
  if (focusIndex >= 0 && (focusIndex < first || focusIndex > last)) out.push(focusIndex);
  return out;
}

/** Pure: the scrollTop that brings row `index` fully into view, or null if it already is. */
export function scrollIntoViewTop(
  index: number,
  scrollTop: number,
  height: number,
  rowHeight: number,
): number | null {
  const top = index * rowHeight;
  if (top < scrollTop) return top;
  if (top + rowHeight > scrollTop + height) return top + rowHeight - height;
  return null;
}

/**
 * The workspace file tree: a WAI-ARIA tree with one tab stop (focus stays on
 * the tree, `aria-activedescendant` names the focused row) and windowed rows,
 * so a KB with thousands of documents renders only what is on screen.
 */
export function FileTree({
  paths,
  extraFolders,
  activePath,
  dirtyPaths,
  badges,
  onOpen,
  renderActions,
  onRowKey,
  ariaLabel,
  className,
  onRename,
  renaming: renamingProp,
  onRenamingChange,
  onMove,
  onDropFiles,
}: FileTreeProps) {
  const { t } = useTranslation("kb");
  const baseId = useId();
  const coarse = useMediaQuery("(pointer: coarse)");
  const rowHeight = coarse ? ROW_COARSE : ROW_FINE;
  const roots = useMemo(() => buildTree(paths, extraFolders), [paths, extraFolders]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() =>
    revealPath(new Set(), activePath),
  );
  // Open the active file's folders whenever another file becomes active.
  const [revealed, setRevealed] = useState(activePath);
  let shownExpanded = expanded;
  if (revealed !== activePath) {
    shownExpanded = revealPath(expanded, activePath);
    setRevealed(activePath);
    if (shownExpanded !== expanded) setExpanded(shownExpanded);
  }
  const rows = useMemo(() => visibleRows(roots, shownExpanded), [roots, shownExpanded]);
  const [focusPath, setFocusPath] = useState<string | null>(null);
  const indexOf = (path: string | null) =>
    path === null ? -1 : rows.findIndex((row) => row.node.path === path);
  const focusIndex = (() => {
    const own = indexOf(focusPath);
    if (own >= 0) return own;
    const active = indexOf(activePath);
    return active >= 0 ? active : rows.length > 0 ? 0 : -1;
  })();
  const focused = focusIndex >= 0 ? rows[focusIndex]! : null;

  const scroller = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(0);
  // React 19 ref callbacks clean up after themselves: the observer lives with the node.
  // OS file drops go through the app's drop dispatcher; in-page moves are plain DnD.
  const fileDrop = useTreeFileDrop(onDropFiles);
  const setDropElement = fileDrop.setElement;
  const measure = useCallback(
    (node: HTMLDivElement | null) => {
      scroller.current = node;
      setDropElement(node);
      if (!node || typeof ResizeObserver === "undefined") return;
      const observer = new ResizeObserver(([entry]) => {
        if (entry) setHeight(entry.contentRect.height);
      });
      observer.observe(node);
      return () => observer.disconnect();
    },
    [setDropElement],
  );
  const typed = useRef({ text: "", at: 0 });
  const [ownRenaming, setOwnRenaming] = useState<string | null>(null);
  const renaming = renamingProp === undefined ? ownRenaming : renamingProp;
  const setRenaming = (path: string | null) => {
    if (renamingProp === undefined) setOwnRenaming(path);
    onRenamingChange?.(path);
    if (path === null) scroller.current?.focus({ preventScroll: true });
    else setFocusPath(path);
  };
  const dragging = useRef<string | null>(null);
  const [moveTarget, setMoveTarget] = useState<string | null>(null);
  const dropHighlight = moveTarget ?? fileDrop.dropFolder;
  const fineDrag = !coarse && onMove !== undefined;
  const handledByRow = (event: DragEvent<HTMLElement>, node: TreeNode | null) =>
    rowOwnsDragEvent(event.target, node);
  const onDragOverTarget = (event: DragEvent<HTMLElement>, node: TreeNode | null) => {
    if (handledByRow(event, node)) return;
    const folder = dropFolderFor(node);
    if (dataTransferHasFiles(event.dataTransfer)) {
      if (onDropFiles) fileDrop.hover(folder);
      return;
    }
    const source = dragging.current;
    if (!source || !event.dataTransfer.types.includes(TREE_DRAG_TYPE)) return;
    if (!canDrop({ kind: "file", path: source }, folder)) {
      setMoveTarget(null);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    setMoveTarget(folder);
  };
  const onDropTarget = (event: DragEvent<HTMLElement>, node: TreeNode | null) => {
    // OS files belong to the drop dispatcher (FileDropGuard), never to this handler.
    if (dataTransferHasFiles(event.dataTransfer) || handledByRow(event, node)) return;
    const source = dragging.current;
    const folder = dropFolderFor(node);
    dragging.current = null;
    setMoveTarget(null);
    if (!source || !onMove || !canDrop({ kind: "file", path: source }, folder)) return;
    event.preventDefault();
    event.stopPropagation();
    onMove(source, folder);
  };

  const moveFocus = (path: string) => {
    setFocusPath(path);
    const index = indexOf(path);
    const node = scroller.current;
    if (index < 0 || !node) return;
    const top = scrollIntoViewTop(index, node.scrollTop, node.clientHeight, rowHeight);
    if (top !== null) node.scrollTop = top;
  };
  const toggle = (path: string, open?: boolean) =>
    setExpanded((current) => {
      const isOpen = current.has(path);
      if (open === isOpen) return current;
      const next = new Set(current);
      if (isOpen) next.delete(path);
      else next.add(path);
      return next;
    });

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!focused) return;
    if (event.target !== event.currentTarget) return;
    if (isTreeKey(event.key) && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      const action = treeKeyAction(rows, focused.node.path, event.key);
      if (action.expand) toggle(action.expand, true);
      if (action.collapse) toggle(action.collapse, false);
      if (action.focus) moveFocus(action.focus);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (focused.node.kind === "folder") toggle(focused.node.path);
      else onOpen(focused.node.path, { newTab: event.ctrlKey || event.metaKey, keyboard: true });
      return;
    }
    if (
      event.key === "F2" &&
      onRename &&
      focused.node.kind === "file" &&
      !event.shiftKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      event.preventDefault();
      setRenaming(focused.node.path);
      return;
    }
    if (onRowKey?.(focused.node, event)) {
      event.preventDefault();
      return;
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const now = event.timeStamp || Date.now();
      const text =
        now - typed.current.at < TYPEAHEAD_MS ? typed.current.text + event.key : event.key;
      typed.current = { text, at: now };
      // A repeated single letter cycles through the rows starting with it.
      const query = /^(.)\1+$/.test(text) ? text[0]! : text;
      const match = typeahead(rows, focused.node.path, query);
      if (match) {
        event.preventDefault();
        moveFocus(match);
      }
    }
  };

  const onRowClick = (row: TreeRow, event: MouseEvent) => {
    setFocusPath(row.node.path);
    if (row.node.kind === "folder") toggle(row.node.path);
    else onOpen(row.node.path, { newTab: event.ctrlKey || event.metaKey });
  };
  const onRowAuxClick = (row: TreeRow, event: MouseEvent) => {
    if (event.button !== 1 || row.node.kind !== "file") return;
    event.preventDefault();
    onOpen(row.node.path, { newTab: true });
  };

  const rowId = (index: number) => `${baseId}-row-${index}`;
  const indices = windowRange(rows.length, scrollTop, height, rowHeight, focusIndex);
  // The row being renamed stays rendered while it scrolls out of the window.
  const renamingIndex = renaming ? indexOf(renaming) : -1;
  if (renamingIndex >= 0 && !indices.includes(renamingIndex)) indices.push(renamingIndex);

  return (
    <div
      ref={measure}
      role="tree"
      aria-label={ariaLabel}
      tabIndex={rows.length > 0 ? 0 : -1}
      aria-activedescendant={focusIndex >= 0 ? rowId(focusIndex) : undefined}
      onKeyDown={onKeyDown}
      // Tabbing in shows the focused row, wherever the tree is scrolled (a
      // pointer's focus doesn't: the clicked row is the one that matters).
      onFocus={(event) => {
        if (
          event.target === event.currentTarget &&
          event.currentTarget.matches(":focus-visible") &&
          focused
        )
          moveFocus(focused.node.path);
      }}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      onDragOver={(event) => onDragOverTarget(event, null)}
      onDrop={(event) => onDropTarget(event, null)}
      onDragLeave={(event) => {
        // Left the tree itself (not just moved between rows).
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setMoveTarget(null);
        fileDrop.hover(null);
      }}
      data-drop-target={dropHighlight === "" ? "" : undefined}
      data-testid="kb-file-tree"
      className={cn(
        "group/tree relative min-h-0 overflow-y-auto overflow-x-clip outline-none",
        dropHighlight === "" && "bg-primary/5 ring-2 ring-inset ring-primary/40",
        className,
      )}
    >
      {rows.length === 0 ? (
        <p className="p-3 text-sm text-muted-foreground">{t("workspace.tree.empty")}</p>
      ) : (
        <div className="relative" style={{ height: rows.length * rowHeight }}>
          {indices.map((index) => {
            const row = rows[index]!;
            const { node } = row;
            const isFolder = node.kind === "folder";
            const active = node.path === activePath;
            const dirty = !isFolder && dirtyPaths?.has(node.path);
            const badge = badges?.get(node.path);
            const isRenaming = !isFolder && renaming === node.path && onRename !== undefined;
            const isDropTarget = isFolder && dropHighlight === node.path;
            const draggableRow = fineDrag && !isFolder && !isRenaming;
            return (
              <div
                key={node.path}
                id={rowId(index)}
                role="treeitem"
                aria-level={row.depth}
                aria-posinset={row.posinset}
                aria-setsize={row.setsize}
                aria-expanded={isFolder ? row.expanded : undefined}
                aria-selected={isFolder ? undefined : active}
                aria-label={dirty ? `${node.name}, ${t("workspace.tree.unsaved")}` : undefined}
                data-path={node.path}
                data-focused={index === focusIndex || undefined}
                title={node.path}
                data-drop-target={isDropTarget || undefined}
                draggable={draggableRow ? true : undefined}
                onDragStart={
                  fineDrag && !isFolder
                    ? (event) => {
                        dragging.current = node.path;
                        event.dataTransfer.setData(TREE_DRAG_TYPE, node.path);
                        event.dataTransfer.effectAllowed = "move";
                      }
                    : undefined
                }
                onDragEnd={() => {
                  dragging.current = null;
                  setMoveTarget(null);
                }}
                onDragOver={(event) => onDragOverTarget(event, node)}
                onDrop={(event) => onDropTarget(event, node)}
                onClick={(event) => !isRenaming && onRowClick(row, event)}
                onAuxClick={(event) => onRowAuxClick(row, event)}
                // Keep focus on the tree itself (one tab stop); the row only becomes the active descendant.
                onMouseDown={(event) => {
                  if (!(event.target as Element).closest("button,input")) {
                    // A draggable row keeps the browser's mousedown: preventing
                    // it would stop a drag-to-move from ever starting.
                    if (!draggableRow) event.preventDefault();
                    scroller.current?.focus({ preventScroll: true });
                  }
                }}
                className={cn(
                  "group/row absolute inset-x-0 flex cursor-pointer items-center gap-1.5 pr-1 text-sm select-none",
                  "hover:bg-muted/60",
                  active && "bg-muted font-medium",
                  isDropTarget && "bg-primary/10 ring-2 ring-inset ring-primary/50",
                  index === focusIndex &&
                    "group-focus-visible/tree:outline-2 group-focus-visible/tree:-outline-offset-2 group-focus-visible/tree:outline-ring",
                )}
                style={{
                  top: index * rowHeight,
                  height: rowHeight,
                  paddingLeft: 8 + (row.depth - 1) * 14,
                }}
              >
                {isFolder ? (
                  <ChevronRight
                    aria-hidden
                    className={cn(
                      "size-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
                      row.expanded && "rotate-90",
                    )}
                  />
                ) : (
                  <span aria-hidden className="w-3.5 shrink-0" />
                )}
                {isFolder ? (
                  row.expanded ? (
                    <FolderOpen aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <Folder aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                  )
                ) : (
                  <FileText aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                )}
                {isRenaming ? (
                  <RenameInput
                    name={node.name}
                    label={t("workspace.fileOps.rename.label", { name: node.name })}
                    onCommit={(next) => {
                      setRenaming(null);
                      if (next !== "" && next !== node.name) onRename(node.path, next);
                    }}
                    onCancel={() => setRenaming(null)}
                  />
                ) : (
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate",
                      !isFolder && "font-mono text-[0.8125rem]",
                    )}
                  >
                    {node.name}
                  </span>
                )}
                {dirty && (
                  <span
                    aria-hidden
                    data-testid="tree-dirty"
                    className="size-2 shrink-0 rounded-full bg-primary"
                  />
                )}
                {badge && <span className="shrink-0">{badge}</span>}
                {renderActions && (
                  <span className="shrink-0 opacity-0 group-hover/row:opacity-100 group-data-[focused]/row:opacity-100 pointer-coarse:opacity-100">
                    {renderActions(node)}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * The inline rename field. Enter commits (the trimmed name), Escape and
 * leaving the field cancel. Its keys never reach the tree's own handler.
 */
function RenameInput({
  name,
  label,
  onCommit,
  onCancel,
}: {
  name: string;
  label: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(name);
  const done = useRef(false);
  // Select the name without ".md" on first focus, like a desktop file manager.
  const select = useCallback(
    (node: HTMLInputElement | null) => {
      if (!node) return;
      node.focus({ preventScroll: true });
      const stem = name.toLowerCase().endsWith(".md") ? name.length - 3 : name.length;
      node.setSelectionRange(0, stem);
    },
    [name],
  );
  return (
    <input
      ref={select}
      value={value}
      aria-label={label}
      autoComplete="off"
      inputMode="text"
      spellCheck={false}
      data-testid="tree-rename-input"
      className="min-w-0 flex-1 rounded border bg-background px-1 font-mono text-base outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11 sm:text-[0.8125rem]"
      onChange={(event) => setValue(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          done.current = true;
          onCommit(value.trim());
        } else if (event.key === "Escape") {
          event.preventDefault();
          done.current = true;
          onCancel();
        }
      }}
      onBlur={() => {
        if (!done.current) onCancel();
      }}
    />
  );
}
