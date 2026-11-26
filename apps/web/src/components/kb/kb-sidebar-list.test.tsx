import enErrors from "@knowledge-base/locales/src/en-US/errors.json";
import enKb from "@knowledge-base/locales/src/en-US/kb.json";
import enNav from "@knowledge-base/locales/src/en-US/nav.json";
import { createInstance } from "i18next";
import type { ReactElement } from "react";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

import { kbSectionKey } from "@/components/app-sidebar";
import { announcementFor, KbSidebarListView } from "@/components/kb/kb-sidebar-list";
import { dropPin, movePin, type PinnedKb } from "@/hooks/use-kb-pins";
import { renderWithTestRouter } from "@/lib/router-test-utils";

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: "en-US",
    resources: { "en-US": { nav: enNav, kb: enKb, errors: enErrors } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
});
const html = (node: ReactElement) =>
  renderWithTestRouter(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);
const kb = (id: string): PinnedKb => ({ kbId: id, name: `Base ${id}`, slug: id });
const noop = () => {};

describe("pin order helpers", () => {
  const items = ["a", "b", "c"].map(kb);
  it("moves a pin one place, clamped at the ends", () => {
    expect(movePin(items, "b", -1).map((i) => i.kbId)).toEqual(["b", "a", "c"]);
    expect(movePin(items, "c", 1).map((i) => i.kbId)).toEqual(["a", "b", "c"]);
    expect(movePin(items, "x", 1).map((i) => i.kbId)).toEqual(["a", "b", "c"]);
  });
  it("drops a pin on another's place", () => {
    expect(dropPin(items, "a", "c").map((i) => i.kbId)).toEqual(["b", "c", "a"]);
    expect(dropPin(items, "c", "a").map((i) => i.kbId)).toEqual(["c", "a", "b"]);
  });
});

describe("sidebar knowledge base list", () => {
  it("shows pins first, then recent bases, View all, and marks the current base", () => {
    const out = html(
      <KbSidebarListView
        lang="en-US"
        pinned={[kb("p1"), kb("p2")]}
        recent={[kb("r1")]}
        currentKbId="p2"
        announcement=""
        onPin={noop}
        onUnpin={noop}
        onMove={noop}
        onDrop={noop}
      />,
    );
    expect(out.indexOf("Base p1")).toBeLessThan(out.indexOf("Base p2"));
    expect(out.indexOf("Base p2")).toBeLessThan(out.indexOf("Base r1"));
    expect(out).toContain(enNav.sidebar.kbs.viewAll);
    expect(out.match(/aria-current="page"/g)).toHaveLength(1);
    expect(out).toMatch(/aria-current="page"[^>]*>[\s\S]*?Base p2/);
    // Pinned rows can be dragged and moved by keyboard; recent ones cannot.
    expect(out.match(/draggable="true"/g)).toHaveLength(2);
    expect(out.match(/aria-keyshortcuts="Alt\+ArrowUp Alt\+ArrowDown"/g)).toHaveLength(2);
    expect(out.match(/aria-pressed="true"/g)).toHaveLength(2);
    expect(out.match(/aria-pressed="false"/g)).toHaveLength(1);
    expect(out).toContain('role="status"');
  });

  it("stays a bounded scroller with many bases", () => {
    const many = Array.from({ length: 50 }, (_, i) => kb(`k${i}`));
    const out = html(
      <KbSidebarListView
        lang="en-US"
        pinned={many}
        recent={[]}
        currentKbId={null}
        announcement=""
        onPin={noop}
        onUnpin={noop}
        onMove={noop}
        onDrop={noop}
      />,
    );
    expect(out.match(/data-kb-row="pinned"/g)).toHaveLength(50);
    expect(out).toMatch(/data-testid="sidebar-kb-list"/);
    expect(out).toMatch(/class="max-h-\[min\(24rem,45svh\)\][^"]*overflow-x-clip overflow-y-auto/);
  });

  it("says what to do with nothing pinned or recent", () => {
    const out = html(
      <KbSidebarListView
        lang="en-US"
        pinned={[]}
        recent={[]}
        currentKbId={null}
        announcement=""
        onPin={noop}
        onUnpin={noop}
        onMove={noop}
        onDrop={noop}
      />,
    );
    expect(out).toContain(enNav.sidebar.kbs.empty);
  });

  it("shows a skeleton, not the empty hint, while the pins are being read", () => {
    const out = html(
      <KbSidebarListView
        lang="en-US"
        pinned={[]}
        recent={[]}
        currentKbId={null}
        announcement=""
        state="pending"
        onPin={noop}
        onUnpin={noop}
        onMove={noop}
        onDrop={noop}
      />,
    );
    expect(out).toContain('data-testid="kb-sidebar-pins-loading"');
    expect(out).not.toContain(enNav.sidebar.kbs.empty);
  });

  it("says it is offline, not an endless skeleton, while the first read waits for the network", () => {
    const out = html(
      <KbSidebarListView
        lang="en-US"
        pinned={[]}
        recent={[]}
        currentKbId={null}
        announcement=""
        state="offline"
        onPin={noop}
        onUnpin={noop}
        onMove={noop}
        onDrop={noop}
      />,
    );
    expect(out).toContain(enErrors.offlineContent.replace("'", "&#x27;"));
    expect(out).not.toContain('data-testid="kb-sidebar-pins-loading"');
    expect(out).not.toContain(enNav.sidebar.kbs.empty);
  });

  it("keeps loaded rows and offers a retry when a read fails", () => {
    const out = html(
      <KbSidebarListView
        lang="en-US"
        pinned={[kb("a")]}
        recent={[]}
        currentKbId={null}
        announcement=""
        state="error"
        onRetry={noop}
        onPin={noop}
        onUnpin={noop}
        onMove={noop}
        onDrop={noop}
      />,
    );
    expect(out).toContain("Base a");
    expect(out).toContain(enNav.sidebar.kbs.loadFailed.replace("'", "&#x27;"));
    expect(out).not.toContain(enNav.sidebar.kbs.empty);
  });

  it("waits while a pin change is in flight: no pin toggles, no dragging", () => {
    const out = html(
      <KbSidebarListView
        lang="en-US"
        pinned={[kb("p1")]}
        recent={[kb("r1")]}
        currentKbId={null}
        announcement=""
        busy
        onPin={noop}
        onUnpin={noop}
        onMove={noop}
        onDrop={noop}
      />,
    );
    expect(out).not.toContain('draggable="true"');
    expect(
      out.match(/aria-pressed="(true|false)"[^>]*disabled=""|disabled=""[^>]*aria-pressed/g),
    ).toHaveLength(2);
  });
});

describe("pin in flight", () => {
  it("shows a recent base's toggle pressed while its pin request is in flight", () => {
    const out = html(
      <KbSidebarListView
        lang="en-US"
        pinned={[]}
        recent={[kb("r1"), kb("r2")]}
        currentKbId={null}
        announcement=""
        busy
        pinning="r1"
        onPin={noop}
        onUnpin={noop}
        onMove={noop}
        onDrop={noop}
      />,
    );
    const toggle = (id: string) =>
      out.match(new RegExp(`<button[^>]*aria-label="Pin Base ${id}"[^>]*>`))?.[0] ?? "";
    expect(toggle("r1")).toContain('aria-pressed="true"');
    expect(toggle("r2")).toContain('aria-pressed="false"');
  });
});

describe("reorder announcement", () => {
  const kb = (id: string): PinnedKb => ({ kbId: id, name: `Base ${id}`, slug: id });
  it("lasts only while its KB is a readable pin", () => {
    const said = { kbId: "s", text: "Base s moved to position 1 of 2" };
    expect(announcementFor(said, [kb("s"), kb("a")])).toBe(said.text);
    // Access to s lost (or unpinned): its name is no longer spoken.
    expect(announcementFor(said, [kb("a")])).toBe("");
    expect(announcementFor(null, [kb("a")])).toBe("");
  });
  it("belongs to one viewer: another account gets a fresh section", () => {
    expect(kbSectionKey("kbs", "alice")).not.toBe(kbSectionKey("kbs", "bob"));
  });
});
