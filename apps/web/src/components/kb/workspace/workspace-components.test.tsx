import enKb from "@knowledge-base/locales/src/en-US/kb.json";
import esKb from "@knowledge-base/locales/src/es-MX/kb.json";
import { createInstance } from "i18next";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

import { DirtyCloseActions } from "./dirty-close-dialog";
import { FileTree, revealPath, scrollIntoViewTop, windowRange } from "./file-tree";
import { highlightSegments, QuickOpenRow } from "./quick-open";
import { ResizeHandle, resizeKeyTarget } from "./resize-handle";
import { ShortcutsList } from "./shortcuts-sheet";
import { TabStrip, TabSwitcherList, tabStripTarget } from "./tab-strip";

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

describe("workspace locale block", () => {
  it("has the same keys in every shipped locale", () => {
    const keys = (value: unknown, prefix = ""): string[] =>
      typeof value === "object" && value !== null
        ? Object.entries(value).flatMap(([k, v]) => keys(v, `${prefix}${k}.`))
        : [prefix];
    expect(keys(esKb.workspace).sort()).toEqual(keys(enKb.workspace).sort());
  });
});

describe("file tree", () => {
  const paths = ["docs/a.md", "docs/guide/b.md", "readme.md"];

  it("renders an ARIA tree with the active file selected and its folders open", () => {
    const html = render(
      <FileTree
        paths={paths}
        activePath="docs/guide/b.md"
        dirtyPaths={new Set(["readme.md"])}
        onOpen={noop}
        ariaLabel="Files"
      />,
    );
    expect(html).toContain('role="tree"');
    expect(html).toContain('aria-label="Files"');
    expect(html).toMatch(
      /role="treeitem" aria-level="1" aria-posinset="1" aria-setsize="2" aria-expanded="true"[^>]*data-path="docs\/"/,
    );
    expect(html).toMatch(
      /aria-level="3"[^>]*aria-selected="true"[^>]*data-path="docs\/guide\/b.md"/,
    );
    expect(html).toMatch(/aria-selected="false" aria-label="readme.md, unsaved changes"/);
    expect(html).toContain('data-testid="tree-dirty"');
    // The tree is one tab stop and names its focused row (the active file).
    expect(html).toMatch(/tabindex="0" aria-activedescendant="[^"]+-row-2"/);
  });

  it("says so when the KB has no documents", () => {
    const html = render(<FileTree paths={[]} activePath={null} onOpen={noop} ariaLabel="Files" />);
    expect(html).toContain("No documents yet.");
    expect(html).toContain('tabindex="-1"');
  });

  it("renders only a window of a 10k-file tree", () => {
    const many = Array.from({ length: 10_000 }, (_, i) => `doc-${i}.md`);
    const html = render(
      <FileTree paths={many} activePath={null} onOpen={noop} ariaLabel="Files" />,
    );
    const rendered = html.match(/role="treeitem"/g)?.length ?? 0;
    expect(rendered).toBeGreaterThan(10);
    expect(rendered).toBeLessThan(100);
  });

  it("windows rows and keeps the focused row rendered", () => {
    expect(windowRange(0, 0, 300, 32, -1)).toEqual([]);
    const range = windowRange(1000, 3200, 320, 32, 999);
    expect(range[0]).toBe(92);
    expect(range).toContain(999);
    expect(range.length).toBeLessThan(50);
  });

  it("scrolls a row into view only when needed", () => {
    expect(scrollIntoViewTop(5, 0, 320, 32)).toBeNull();
    expect(scrollIntoViewTop(20, 0, 320, 32)).toBe(20 * 32 + 32 - 320);
    expect(scrollIntoViewTop(1, 100, 320, 32)).toBe(32);
  });

  it("opens the folders of a newly active file, keeping the rest", () => {
    const start = new Set(["x/"]);
    expect([...revealPath(start, "a/b/c.md")]).toEqual(["x/", "a/", "a/b/"]);
    expect(revealPath(start, null)).toBe(start);
    expect(revealPath(start, "top.md")).toBe(start);
  });
});

describe("tab strip", () => {
  const tabs = [
    { key: "a", label: "a.md", title: "docs/a.md", dirty: false },
    { key: "b", label: "b.md", title: "b.md", dirty: true },
  ];

  it("is a tablist with one tab stop, the active tab selected and a dirty marker", () => {
    const html = render(
      <TabStrip
        tabs={tabs}
        activeKey="b"
        onActivate={noop}
        onClose={noop}
        ariaLabel="Open files"
        panelId="panel"
      />,
    );
    expect(html).toContain('role="tablist"');
    expect(html).toMatch(
      /role="tab"[^>]*aria-selected="false" aria-controls="panel" tabindex="-1"/,
    );
    expect(html).toMatch(/role="tab"[^>]*aria-selected="true" aria-controls="panel" tabindex="0"/);
    expect(html).toContain(", unsaved changes");
    expect(html).toContain('aria-label="Close b.md"');
    expect(html.match(/data-testid="tab-dirty"/g)).toHaveLength(1);
  });

  it("renders nothing without tabs; the first tab is the stop when none is active", () => {
    expect(
      render(
        <TabStrip tabs={[]} activeKey={null} onActivate={noop} onClose={noop} ariaLabel="x" />,
      ),
    ).toBe("");
    const html = render(
      <TabStrip tabs={tabs} activeKey={null} onActivate={noop} onClose={noop} ariaLabel="x" />,
    );
    expect(html).toMatch(/data-tab-key="a"/);
    expect(html.indexOf('tabindex="0"')).toBeLessThan(html.indexOf('data-tab-key="b"'));
  });

  it("moves with arrows (wrapping), Home and End", () => {
    const keys = ["a", "b", "c"];
    expect(tabStripTarget(keys, "a", "ArrowRight")).toBe("b");
    expect(tabStripTarget(keys, "c", "ArrowRight")).toBe("a");
    expect(tabStripTarget(keys, "a", "ArrowLeft")).toBe("c");
    expect(tabStripTarget(keys, "b", "Home")).toBe("a");
    expect(tabStripTarget(keys, "b", "End")).toBe("c");
    expect(tabStripTarget(keys, "b", "x")).toBeNull();
    expect(tabStripTarget(keys, "zz", "Home")).toBeNull();
  });

  it("lists recent files with close buttons on narrow screens", () => {
    const html = render(
      <TabSwitcherList tabs={tabs} activeKey="a" onActivate={noop} onClose={noop} />,
    );
    expect(html).toContain('aria-current="page"');
    expect(html).toContain("docs/a.md");
    expect(html).toContain('aria-label="Close a.md"');
    expect(
      render(<TabSwitcherList tabs={[]} activeKey={null} onActivate={noop} onClose={noop} />),
    ).toContain("No open files yet.");
  });
});

describe("dirty close", () => {
  it("offers Save, Discard and Cancel", () => {
    const html = render(
      <DirtyCloseActions canSave saving={false} onSave={noop} onDiscard={noop} onCancel={noop} />,
    );
    expect(html).toContain(">Save<");
    expect(html).toContain(">Discard changes<");
    expect(html).toContain(">Cancel<");
    expect(html).not.toMatch(/disabled=""[^>]*data-testid="dirty-close-save"/);
  });

  it("explains a Save that cannot run; while saving only Cancel stays available", () => {
    const blocked = render(
      <DirtyCloseActions
        canSave={false}
        saving={false}
        onSave={noop}
        onDiscard={noop}
        onCancel={noop}
      />,
    );
    expect(blocked).toContain("can&#x27;t be saved right now");
    expect(blocked).toMatch(
      /disabled=""[^>]*aria-describedby="[^"]+"[^>]*data-testid="dirty-close-save"/,
    );
    const saving = render(
      <DirtyCloseActions canSave saving onSave={noop} onDiscard={noop} onCancel={noop} />,
    );
    expect(saving).toContain("Saving…");
    // Save and Discard wait; a question can always be put aside.
    expect(saving.match(/\sdisabled=""/g)).toHaveLength(2);
    expect(saving).not.toMatch(/disabled=""[^>]*data-testid="dirty-close-cancel"/);
  });
});

describe("resize handle", () => {
  it("is a focusable vertical separator with its value", () => {
    const html = render(
      <ResizeHandle
        value={288}
        min={200}
        max={640}
        defaultValue={288}
        onChange={noop}
        label="Resize"
        controls="tree"
      />,
    );
    expect(html).toMatch(
      /role="separator" aria-orientation="vertical" aria-label="Resize" aria-controls="tree" aria-valuenow="288" aria-valuemin="200" aria-valuemax="640" tabindex="0"/,
    );
  });

  it("steps with arrows (Shift for big steps) and jumps with Home/End, clamped", () => {
    expect(resizeKeyTarget("ArrowRight", false, 288, 200, 640)).toBe(304);
    expect(resizeKeyTarget("ArrowLeft", true, 288, 200, 640)).toBe(224);
    expect(resizeKeyTarget("ArrowLeft", true, 210, 200, 640)).toBe(200);
    expect(resizeKeyTarget("Home", false, 288, 200, 640)).toBe(200);
    expect(resizeKeyTarget("End", false, 288, 200, 640)).toBe(640);
    expect(resizeKeyTarget("x", false, 288, 200, 640)).toBeNull();
  });
});

describe("quick open", () => {
  it("splits text into matched and plain pieces", () => {
    expect(
      highlightSegments("readme.md", [
        [0, 1],
        [4, 6],
      ]),
    ).toEqual([
      { text: "r", match: true },
      { text: "ead", match: false },
      { text: "me", match: true },
      { text: ".md", match: false },
    ]);
    expect(highlightSegments("ab", [[5, 9]])).toEqual([{ text: "ab", match: false }]);
  });

  it("shows the file name with its matches and the folder dimmed", () => {
    const html = render(
      <QuickOpenRow
        path="docs/guide.md"
        ranges={[
          [0, 1],
          [5, 10],
        ]}
      />,
    );
    expect(html).toContain("<mark");
    expect(html.indexOf("guide")).toBeLessThan(html.indexOf("ocs/"));
    expect(html).toMatch(/text-muted-foreground"><mark[^>]*>d<\/mark><span>ocs\/<\/span>/);
  });
});

describe("shortcuts sheet", () => {
  it("lists every shortcut with this platform's keys", () => {
    const mac = render(<ShortcutsList mac />);
    expect(mac).toContain("⌘ S");
    expect(mac).toContain("Save the open document");
    expect(mac).toContain("⌥ W");
    const pc = render(<ShortcutsList mac={false} />);
    expect(pc).toContain("Ctrl S");
    expect(pc).not.toContain("⌘");
    expect(pc).toContain("Alt alternates");
  });
});
