/**
 * The workspace file tree as data: built from the KB's document paths,
 * flattened to the rows a virtualised list renders, and the WAI-ARIA tree
 * keyboard model (https://www.w3.org/WAI/ARIA/apg/patterns/treeview/) as
 * pure functions over those rows.
 */

export type TreeNode =
  | { kind: "folder"; path: string; name: string; children: TreeNode[] }
  | { kind: "file"; path: string; name: string };

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function compareNodes(a: TreeNode, b: TreeNode): number {
  if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
  return collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

/**
 * Folders (paths ending in "/") come from the files' directories plus
 * `extraFolders` (folders made in the UI that hold no file yet). Folders sort
 * before files, each in natural order ("2" before "10").
 */
export function buildTree(
  paths: readonly string[],
  extraFolders: readonly string[] = [],
): TreeNode[] {
  type Folder = Extract<TreeNode, { kind: "folder" }> & { index: Map<string, TreeNode> };
  const root: Folder = { kind: "folder", path: "", name: "", children: [], index: new Map() };
  const folderAt = (dirs: string[]): Folder => {
    let current = root;
    let prefix = "";
    for (const dir of dirs) {
      prefix += `${dir}/`;
      let next = current.index.get(`d:${dir}`) as Folder | undefined;
      if (!next) {
        next = { kind: "folder", path: prefix, name: dir, children: [], index: new Map() };
        current.index.set(`d:${dir}`, next);
        current.children.push(next);
      }
      current = next;
    }
    return current;
  };
  for (const folder of extraFolders) {
    const parts = folder.split("/").filter(Boolean);
    if (parts.length > 0) folderAt(parts);
  }
  for (const path of paths) {
    const parts = path.split("/");
    const name = parts.pop();
    if (!name || parts.some((part) => part === "")) continue;
    const parent = folderAt(parts);
    if (parent.index.has(`f:${name}`)) continue;
    const file: TreeNode = { kind: "file", path, name };
    parent.index.set(`f:${name}`, file);
    parent.children.push(file);
  }
  const finish = (folder: Folder): TreeNode[] => {
    folder.children.sort(compareNodes);
    return folder.children.map((child) => {
      if (child.kind === "file") return child;
      const sub = child as Folder;
      return { kind: "folder", path: sub.path, name: sub.name, children: finish(sub) };
    });
  };
  return finish(root);
}

export type TreeRow = {
  node: TreeNode;
  /** 1-based, as `aria-level`. */
  depth: number;
  expanded: boolean;
  /** 1-based position among its siblings (`aria-posinset`) and their count (`aria-setsize`). */
  posinset: number;
  setsize: number;
  /** The parent folder's path, null at the top level. */
  parent: string | null;
};

/** The rows on screen: every node whose ancestors are all expanded, in display order. */
export function visibleRows(roots: readonly TreeNode[], expanded: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (nodes: readonly TreeNode[], depth: number, parent: string | null) => {
    nodes.forEach((node, index) => {
      const open = node.kind === "folder" && expanded.has(node.path);
      rows.push({
        node,
        depth,
        expanded: open,
        posinset: index + 1,
        setsize: nodes.length,
        parent,
      });
      if (open)
        walk((node as Extract<TreeNode, { kind: "folder" }>).children, depth + 1, node.path);
    });
  };
  walk(roots, 1, null);
  return rows;
}

/** The folders containing a path, outermost first: "a/b/c.md" -> ["a/", "a/b/"]. */
export function ancestorsOf(path: string): string[] {
  const parts = path.split("/");
  // A folder path ("a/b/") is its own last part's parent; drop the empty tail.
  if (path.endsWith("/")) parts.pop();
  parts.pop();
  const out: string[] = [];
  let prefix = "";
  for (const part of parts) {
    if (!part) break;
    prefix += `${part}/`;
    out.push(prefix);
  }
  return out;
}

export type TreeKey = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "Home" | "End";

export function isTreeKey(key: string): key is TreeKey {
  return (
    key === "ArrowUp" ||
    key === "ArrowDown" ||
    key === "ArrowLeft" ||
    key === "ArrowRight" ||
    key === "Home" ||
    key === "End"
  );
}

/**
 * What one navigation key does from the focused row:
 * Down/Up move to the next/previous visible row; Right expands a closed
 * folder or moves into an open one's first child; Left collapses an open
 * folder or moves to the parent; Home/End go to the first/last row.
 */
export function treeKeyAction(
  rows: readonly TreeRow[],
  focus: string,
  key: TreeKey,
): { focus?: string; expand?: string; collapse?: string } {
  if (rows.length === 0) return {};
  const at = rows.findIndex((row) => row.node.path === focus);
  if (at < 0) return { focus: rows[0]!.node.path };
  const row = rows[at]!;
  switch (key) {
    case "ArrowDown":
      return at + 1 < rows.length ? { focus: rows[at + 1]!.node.path } : {};
    case "ArrowUp":
      return at > 0 ? { focus: rows[at - 1]!.node.path } : {};
    case "Home":
      return { focus: rows[0]!.node.path };
    case "End":
      return { focus: rows[rows.length - 1]!.node.path };
    case "ArrowRight":
      if (row.node.kind !== "folder") return {};
      if (!row.expanded) return { expand: row.node.path };
      return row.node.children.length > 0 && rows[at + 1] ? { focus: rows[at + 1]!.node.path } : {};
    case "ArrowLeft":
      if (row.node.kind === "folder" && row.expanded) return { collapse: row.node.path };
      return row.parent !== null ? { focus: row.parent } : {};
  }
}

/**
 * Type-ahead: the next visible row after the focused one whose name starts
 * with `text` (case-insensitive), wrapping; null when none does.
 */
export function typeahead(rows: readonly TreeRow[], focus: string, text: string): string | null {
  const needle = text.toLocaleLowerCase();
  if (!needle || rows.length === 0) return null;
  const at = rows.findIndex((row) => row.node.path === focus);
  for (let step = 1; step <= rows.length; step++) {
    const row = rows[(at + step) % rows.length]!;
    if (row.node.name.toLocaleLowerCase().startsWith(needle)) return row.node.path;
  }
  return null;
}
