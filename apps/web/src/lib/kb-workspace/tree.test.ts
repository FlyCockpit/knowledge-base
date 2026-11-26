import { describe, expect, it } from "vitest";

import { ancestorsOf, buildTree, treeKeyAction, typeahead, visibleRows } from "./tree";

const PATHS = [
  "readme.md",
  "docs/b.md",
  "docs/a.md",
  "docs/guide/10.md",
  "docs/guide/2.md",
  "z.md",
];

describe("file tree", () => {
  it("puts folders first and sorts naturally", () => {
    const tree = buildTree(PATHS, ["empty/"]);
    expect(tree.map((n) => n.path)).toEqual(["docs/", "empty/", "readme.md", "z.md"]);
    const docs = tree[0]!;
    expect(docs.kind).toBe("folder");
    if (docs.kind !== "folder") return;
    expect(docs.children.map((n) => n.name)).toEqual(["guide", "a.md", "b.md"]);
    const guide = docs.children[0]!;
    if (guide.kind !== "folder") throw new Error("folder");
    expect(guide.children.map((n) => n.name)).toEqual(["2.md", "10.md"]);
  });

  it("ignores duplicate and malformed paths", () => {
    const tree = buildTree(["a.md", "a.md", "x//y.md", "", "dir/"]);
    expect(tree.map((n) => n.path)).toEqual(["a.md"]);
  });

  it("shows only the children of expanded folders, with ARIA positions", () => {
    const tree = buildTree(PATHS);
    expect(visibleRows(tree, new Set()).map((r) => r.node.path)).toEqual([
      "docs/",
      "readme.md",
      "z.md",
    ]);
    const rows = visibleRows(tree, new Set(["docs/"]));
    expect(rows.map((r) => [r.node.path, r.depth, r.posinset, r.setsize, r.parent])).toEqual([
      ["docs/", 1, 1, 3, null],
      ["docs/guide/", 2, 1, 3, "docs/"],
      ["docs/a.md", 2, 2, 3, "docs/"],
      ["docs/b.md", 2, 3, 3, "docs/"],
      ["readme.md", 1, 2, 3, null],
      ["z.md", 1, 3, 3, null],
    ]);
    expect(rows[0]!.expanded).toBe(true);
    expect(rows[1]!.expanded).toBe(false);
  });

  it("names the ancestors of a file or folder", () => {
    expect(ancestorsOf("a/b/c.md")).toEqual(["a/", "a/b/"]);
    expect(ancestorsOf("a/b/")).toEqual(["a/"]);
    expect(ancestorsOf("c.md")).toEqual([]);
  });

  it("builds and flattens 10k paths quickly", () => {
    const paths = Array.from({ length: 10_000 }, (_, i) => `f${i % 50}/g${i % 7}/doc-${i}.md`);
    const start = performance.now();
    const tree = buildTree(paths);
    const rows = visibleRows(tree, new Set(tree.map((n) => n.path)));
    expect(rows.length).toBe(50 + 50 * 7);
    // Only a super-linear regression fails this; it must hold on a loaded runner.
    expect(performance.now() - start).toBeLessThan(2000);
  });
});

describe("tree keyboard (WAI-ARIA)", () => {
  const tree = buildTree(PATHS);
  const rows = visibleRows(tree, new Set(["docs/"]));

  it("moves down and up through visible rows, stopping at the ends", () => {
    expect(treeKeyAction(rows, "docs/", "ArrowDown")).toEqual({ focus: "docs/guide/" });
    expect(treeKeyAction(rows, "docs/b.md", "ArrowDown")).toEqual({ focus: "readme.md" });
    expect(treeKeyAction(rows, "z.md", "ArrowDown")).toEqual({});
    expect(treeKeyAction(rows, "docs/", "ArrowUp")).toEqual({});
    expect(treeKeyAction(rows, "readme.md", "ArrowUp")).toEqual({ focus: "docs/b.md" });
  });

  it("Right expands a closed folder, then enters it; does nothing on a file", () => {
    expect(treeKeyAction(rows, "docs/guide/", "ArrowRight")).toEqual({ expand: "docs/guide/" });
    expect(treeKeyAction(rows, "docs/", "ArrowRight")).toEqual({ focus: "docs/guide/" });
    expect(treeKeyAction(rows, "docs/a.md", "ArrowRight")).toEqual({});
  });

  it("Left collapses an open folder, else moves to the parent", () => {
    expect(treeKeyAction(rows, "docs/", "ArrowLeft")).toEqual({ collapse: "docs/" });
    expect(treeKeyAction(rows, "docs/a.md", "ArrowLeft")).toEqual({ focus: "docs/" });
    expect(treeKeyAction(rows, "readme.md", "ArrowLeft")).toEqual({});
  });

  it("Home and End go to the first and last rows; unknown focus lands on the first", () => {
    expect(treeKeyAction(rows, "docs/a.md", "Home")).toEqual({ focus: "docs/" });
    expect(treeKeyAction(rows, "docs/a.md", "End")).toEqual({ focus: "z.md" });
    expect(treeKeyAction(rows, "gone.md", "ArrowDown")).toEqual({ focus: "docs/" });
    expect(treeKeyAction([], "x", "Home")).toEqual({});
  });

  it("type-ahead finds the next row by name, wrapping", () => {
    expect(typeahead(rows, "docs/", "r")).toBe("readme.md");
    expect(typeahead(rows, "z.md", "d")).toBe("docs/");
    expect(typeahead(rows, "docs/", "B")).toBe("docs/b.md");
    expect(typeahead(rows, "docs/", "q")).toBeNull();
    expect(typeahead(rows, "missing", "d")).toBe("docs/");
  });
});
