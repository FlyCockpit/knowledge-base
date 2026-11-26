import enKb from "@knowledge-base/locales/src/en-US/kb.json";
import { createInstance } from "i18next";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

import { dropFolderFor, FileTree, rowOwnsDragEvent, TREE_DRAG_TYPE } from "./file-tree";
import { NewEntryForm, newEntryIssue, newEntryPath } from "./new-entry-dialog";
import {
  rowActionKey,
  rowActions,
  rowMenuFinalFocus,
  stopRowEvent,
  TreeRowActions,
} from "./tree-actions";
import { planDroppedFiles, UploadSummary } from "./tree-drop";

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: "en-US",
    fallbackLng: "en-US",
    ns: ["kb"],
    defaultNS: "kb",
    resources: { "en-US": { kb: enKb } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
});
const render = (node: ReactNode) =>
  renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);
const noop = () => {};

describe("row actions", () => {
  it("offers file and folder actions to writers, none to readers", () => {
    expect(rowActions({ kind: "file" }, true)).toEqual(["rename", "delete"]);
    expect(rowActions({ kind: "folder" }, true)).toEqual(["newFile", "newFolder"]);
    expect(rowActions({ kind: "file" }, false)).toEqual([]);
    expect(rowActions({ kind: "folder" }, false)).toEqual([]);
  });
  it("maps the row keys: F2 rename, Delete, Shift+F10 / ContextMenu open the menu", () => {
    const key = (key: string, shiftKey = false) =>
      rowActionKey({ key, shiftKey, ctrlKey: false, metaKey: false, altKey: false });
    expect(key("F2")).toBe("rename");
    expect(key("Delete")).toBe("delete");
    expect(key("F10", true)).toBe("menu");
    expect(key("ContextMenu")).toBe("menu");
    expect(key("F10")).toBeNull();
    expect(
      rowActionKey({ key: "F2", shiftKey: false, ctrlKey: true, metaKey: false, altKey: false }),
    ).toBeNull();
  });
  it("renders a labelled menu button for a writer, nothing for a reader", () => {
    const file = { kind: "file" as const, path: "a/x.md", name: "x.md" };
    const html = render(<TreeRowActions node={file} canWrite onAction={noop} />);
    expect(html).toContain(
      `aria-label="${i18n.t("workspace.fileOps.actions.label", { name: "x.md" })}"`,
    );
    expect(html).toContain('tabindex="-1"');
    const folder = { kind: "folder" as const, path: "a/", name: "a", children: [] };
    expect(render(<TreeRowActions node={folder} canWrite={false} onAction={noop} />)).toBe("");
  });
  it("returns focus to the tree when the menu closes, unless an action moved it on", () => {
    const tree = { tagName: "DIV" } as unknown as HTMLElement;
    // Stand-ins for DOM elements (no DOM in these tests).
    const el = (stub: object) => stub as unknown as Element;
    const button = el({ tagName: "BUTTON", closest: () => null });
    const trigger = el({
      contains: (other: unknown) => other === button,
      closest: (selector: string) => (selector === '[role="tree"]' ? tree : null),
    });
    const item = el({
      tagName: "DIV",
      closest: (selector: string) => (selector === '[role="menu"]' ? {} : null),
    });
    const body = el({ tagName: "BODY", closest: () => null });
    const renameField = el({ tagName: "INPUT", closest: () => null });
    // Escape from a menu item, or focus already back on the trigger / nowhere: the tree.
    expect(rowMenuFinalFocus(item, trigger)).toBe(tree);
    expect(rowMenuFinalFocus(button, trigger)).toBe(tree);
    expect(rowMenuFinalFocus(body, trigger)).toBe(tree);
    expect(rowMenuFinalFocus(null, trigger)).toBe(tree);
    // Rename moved focus into its field (or a dialog took it): left there.
    expect(rowMenuFinalFocus(renameField, trigger)).toBe(false);
    // No tree around (never in practice): the default.
    expect(rowMenuFinalFocus(item, null)).toBe(true);
  });
  it("keeps the menu's clicks from reaching the row behind its portal", () => {
    let stopped = 0;
    stopRowEvent({ stopPropagation: () => stopped++ });
    expect(stopped).toBe(1);
  });
});

describe("new entry", () => {
  it("builds the path of a new file or a new folder's first file", () => {
    expect(newEntryPath("file", "guides/", { folderName: "", fileName: "Setup" })).toBe(
      "guides/Setup.md",
    );
    expect(newEntryPath("folder", "", { folderName: "notes/", fileName: "first" })).toBe(
      "notes/first.md",
    );
    expect(newEntryPath("folder", "", { folderName: " ", fileName: "first" })).toBeNull();
    expect(newEntryPath("file", "", { folderName: "", fileName: "  " })).toBeNull();
  });
  it("checks the path against the server's rule and the KB's files", () => {
    const existing = new Set(["guides/setup.md"]);
    expect(newEntryIssue("file", "guides/", { folderName: "", fileName: "Setup" }, existing)).toBe(
      "exists",
    );
    expect(newEntryIssue("file", "", { folderName: "", fileName: "what?" }, existing)).toBe(
      "portable",
    );
    expect(newEntryIssue("folder", "", { folderName: ".git", fileName: "a" }, existing)).toBe(
      "reserved",
    );
    expect(newEntryIssue("file", "", { folderName: "", fileName: "" }, existing)).toBeNull();
  });
  it("renders labelled fields (autoComplete off) and a disabled Create while empty", () => {
    const html = render(
      <NewEntryForm kind="folder" folder="" existing={new Set()} onCancel={noop} onCreate={noop} />,
    );
    expect(html).toContain(i18n.t("workspace.fileOps.newEntry.folderName"));
    expect(html).toContain(i18n.t("workspace.fileOps.newEntry.firstFileName"));
    expect(html.match(/autoComplete="off"|autocomplete="off"/g)?.length).toBe(2);
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled/);
  });
});

describe("drops", () => {
  it("targets a folder row, a file's folder, or the top level", () => {
    expect(dropFolderFor({ kind: "folder", path: "a/b/" })).toBe("a/b/");
    expect(dropFolderFor({ kind: "file", path: "a/x.md" })).toBe("a/");
    expect(dropFolderFor(null)).toBe("");
  });
  it("summarizes a drop: created, images and refusals with reasons", () => {
    const plan = planDroppedFiles(
      [
        { name: "a.md", type: "text/markdown", size: 3 },
        { name: "p.png", type: "image/png", size: 3 },
        { name: "v.mp4", type: "video/mp4", size: 3 },
      ],
      "notes/",
      new Set(),
    );
    const html = render(<UploadSummary plan={plan} />);
    expect(html).toContain(i18n.t("workspace.fileOps.drop.accepted", { path: "notes/a.md" }));
    expect(html).toContain(i18n.t("workspace.fileOps.drop.image"));
    expect(html).toContain(i18n.t("workspace.fileOps.drop.refused.type"));
    expect(html.match(/data-kind="/g)?.length).toBe(3);
  });
});

describe("drag targets", () => {
  // A stand-in for a DOM node: `closest` answers whether it sits in a tree row.
  const inRow = (row: boolean) =>
    ({
      closest: (selector: string) => (row && selector === '[role="treeitem"]' ? {} : null),
    }) as unknown as EventTarget;
  it("lets a row's folder stand when its event bubbles to the tree's empty-space handler", () => {
    // Dropping on the guides/ row: the tree handler (node null) must not reset it to the top level.
    expect(rowOwnsDragEvent(inRow(true), null)).toBe(true);
    // Empty space below the rows is the top level.
    expect(rowOwnsDragEvent(inRow(false), null)).toBe(false);
    // The row's own handler always handles its event.
    expect(rowOwnsDragEvent(inRow(true), { kind: "folder" })).toBe(false);
    expect(rowOwnsDragEvent(null, null)).toBe(false);
  });
});

describe("file tree with file operations", () => {
  const paths = ["guides/alpha.md", "guides/beta.md", "readme.md"];
  it("keeps the ARIA tree and makes file rows draggable for a move", () => {
    const html = render(
      <FileTree
        paths={paths}
        activePath="guides/alpha.md"
        onOpen={noop}
        onMove={noop}
        ariaLabel="Files"
      />,
    );
    expect(html).toContain('role="tree"');
    expect(html.match(/role="treeitem"/g)?.length).toBe(4);
    // Files drag, folders don't (pointer is fine outside a browser).
    expect(html.match(/draggable="true"/g)?.length).toBe(3);
    expect(TREE_DRAG_TYPE).not.toBe("Files");
  });
  it("shows the rename field instead of the name of the row being renamed", () => {
    const html = render(
      <FileTree
        paths={paths}
        activePath="guides/alpha.md"
        onOpen={noop}
        onRename={noop}
        renaming="guides/beta.md"
        ariaLabel="Files"
      />,
    );
    expect(html).toContain('data-testid="tree-rename-input"');
    // A 44px touch target on a coarse pointer.
    expect(html).toMatch(
      /data-testid="tree-rename-input"[^>]*pointer-coarse:min-h-11|pointer-coarse:min-h-11[^>]*data-testid="tree-rename-input"/,
    );
    expect(html).toContain('value="beta.md"');
    expect(html).toContain(
      `aria-label="${i18n.t("workspace.fileOps.rename.label", { name: "beta.md" })}"`,
    );
    // Not draggable while renamed, and no rename field without onRename.
    expect(
      render(
        <FileTree
          paths={paths}
          activePath={null}
          onOpen={noop}
          renaming="readme.md"
          ariaLabel="Files"
        />,
      ),
    ).not.toContain("tree-rename-input");
  });
});
