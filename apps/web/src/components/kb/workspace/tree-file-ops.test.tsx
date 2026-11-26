import enKb from "@knowledge-base/locales/src/en-US/kb.json";
import { createInstance } from "i18next";
import type { KeyboardEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceTab } from "@/lib/kb-workspace/tabs";
import type { TreeNode } from "@/lib/kb-workspace/tree";
import type { WorkspaceFileRequest } from "@/stores/kb-workspace";

const toast = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("@knowledge-base/ui/components/sileo", () => ({ toast }));

import { startNewDraft, useTreeFileOps } from "./tree-file-ops";

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
beforeEach(() => toast.error.mockReset());

type Ops = ReturnType<typeof useTreeFileOps>;
const paths = ["guides/alpha.md", "guides/beta.md", "readme.md"];
const file = (path: string): TreeNode => ({
  kind: "file",
  path,
  name: path.slice(path.lastIndexOf("/") + 1),
});
const key = (k: string, shiftKey = false) => {
  const preventDefault = vi.fn();
  const event = {
    key: k,
    shiftKey,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    preventDefault,
  } as unknown as KeyboardEvent<HTMLDivElement>;
  return { event, preventDefault };
};

type Started = [WorkspaceTab, WorkspaceFileRequest][];

function Harness({
  canWrite,
  started,
  use,
}: {
  canWrite: boolean;
  started: Started;
  use: (ops: Ops, started: Started) => void;
}) {
  const ops = useTreeFileOps({
    canWrite,
    paths,
    start: (tab, request) => started.push([tab, request]),
    newBusy: () => false,
  });
  use(ops, started);
  return <>{ops.toolbar}</>;
}

/** Renders the hook once and hands its result to `use` (inside the render). */
function withOps(options: { canWrite: boolean }, use: (ops: Ops, started: Started) => void) {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <Harness canWrite={options.canWrite} started={[]} use={use} />
    </I18nextProvider>,
  );
}

describe("tree file operations", () => {
  it("offers nothing to a viewer who can't write", () => {
    const html = withOps({ canWrite: false }, (ops) => {
      expect(ops.treeProps).toEqual({});
      expect(ops.dialogs).toBeNull();
    });
    expect(html).toBe("");
  });

  it("gives a writer New file / New folder buttons with names", () => {
    const html = withOps({ canWrite: true }, () => {});
    expect(html).toContain(`aria-label="${enKb.workspace.fileOps.newEntry.fileTitle}"`);
    expect(html).toContain(`aria-label="${enKb.workspace.fileOps.newEntry.folderTitle}"`);
  });

  it("turns a rename and a drag into the document's own move, never a write", () => {
    withOps({ canWrite: true }, (ops, started) => {
      ops.treeProps.onRename?.("guides/alpha.md", "first");
      // The same name is no move.
      ops.treeProps.onRename?.("guides/beta.md", "beta.md");
      ops.treeProps.onMove?.("readme.md", "guides/");
      expect(started).toEqual([
        [
          { path: "guides/alpha.md" },
          { kind: "move", path: "guides/alpha.md", toPath: "guides/first.md" },
        ],
        [{ path: "readme.md" }, { kind: "move", path: "readme.md", toPath: "guides/readme.md" }],
      ]);
    });
  });

  it("maps Delete on a file row to the document's delete confirmation", () => {
    withOps({ canWrite: true }, (ops, started) => {
      const del = key("Delete");
      expect(ops.treeProps.onRowKey?.(file("guides/beta.md"), del.event)).toBe(true);
      expect(del.preventDefault).toHaveBeenCalled();
      expect(started).toEqual([
        [{ path: "guides/beta.md" }, { kind: "delete", path: "guides/beta.md" }],
      ]);
      // Folders have no Delete; other keys are the tree's.
      const folder: TreeNode = { kind: "folder", path: "guides/", name: "guides", children: [] };
      expect(ops.treeProps.onRowKey?.(folder, key("Delete").event)).toBe(false);
      expect(ops.treeProps.onRowKey?.(file("readme.md"), key("x").event)).toBe(false);
      expect(started).toHaveLength(1);
    });
  });

  it("starts a New document draft, but never over one with unsaved edits", () => {
    const request = { kind: "new" as const, path: "notes.md", markdown: "", images: [] };
    const start = vi.fn();
    const refuse = vi.fn();
    startNewDraft({ newBusy: () => true, start, refuse }, request);
    expect(start).not.toHaveBeenCalled();
    expect(refuse).toHaveBeenCalledOnce();
    startNewDraft({ newBusy: () => false, start, refuse }, request);
    expect(start).toHaveBeenCalledWith({ path: "" }, request);
  });
});
