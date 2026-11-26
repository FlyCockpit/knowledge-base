import { cn } from "@knowledge-base/ui/lib/utils";
import { ChevronRight, FileText, Folder, FolderOpen } from "lucide-react";
import {
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

import { useMediaQuery } from "@/hooks/use-media-query";
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
};

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
  const measure = useCallback((node: HTMLDivElement | null) => {
    scroller.current = node;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setHeight(entry.contentRect.height);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const typed = useRef({ text: "", at: 0 });

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
      data-testid="kb-file-tree"
      className={cn(
        "group/tree relative min-h-0 overflow-y-auto overflow-x-clip outline-none",
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
                onClick={(event) => onRowClick(row, event)}
                onAuxClick={(event) => onRowAuxClick(row, event)}
                // Keep focus on the tree itself (one tab stop); the row only becomes the active descendant.
                onMouseDown={(event) => {
                  if (!(event.target as Element).closest("button")) {
                    event.preventDefault();
                    scroller.current?.focus({ preventScroll: true });
                  }
                }}
                className={cn(
                  "group/row absolute inset-x-0 flex cursor-pointer items-center gap-1.5 pr-1 text-sm select-none",
                  "hover:bg-muted/60",
                  active && "bg-muted font-medium",
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
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate",
                    !isFolder && "font-mono text-[0.8125rem]",
                  )}
                >
                  {node.name}
                </span>
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
