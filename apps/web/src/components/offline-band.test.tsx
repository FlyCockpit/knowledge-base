import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { ConnectivityNotice } from "@/lib/connectivity-notice";

const state = vi.hoisted(() => ({ notice: null as ConnectivityNotice }));
vi.mock("@/hooks/use-connectivity-notice", () => ({ useConnectivityNotice: () => state.notice }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const { OfflineBand } = await import("./offline-band");
const { PAGE_COLUMN_CLASS } = await import("./page-shell");

function render(notice: ConnectivityNotice): string {
  state.notice = notice;
  return renderToStaticMarkup(<OfflineBand />);
}

describe("OfflineBand", () => {
  it("keeps an empty polite live region mounted while online, so it announces each change once", () => {
    const html = render(null);
    expect(html).toMatch(/^<div role="status" aria-live="polite" aria-atomic="true"[^>]*><\/div>$/);
  });

  it("says you're offline inside the status region", () => {
    const html = render("offline");
    expect(html).toContain('role="status"');
    expect(html).toContain("offline.band");
    expect(html).not.toContain("offline.backOnline");
  });

  it("spans the window but keeps its message in the page column (4K)", () => {
    const html = render("offline");
    expect(html).toMatch(/^<div role="status"[^>]*><div class="border-b bg-muted/);
    for (const cls of PAGE_COLUMN_CLASS.split(" ")) expect(html).toContain(cls);
  });

  it("confirms back online", () => {
    const html = render("back-online");
    expect(html).toContain("offline.backOnline");
    expect(html).not.toContain("offline.band");
  });

  it("uses theme tokens and animates only when motion is allowed", () => {
    const html = render("offline");
    expect(html).toContain("bg-muted");
    expect(html).toContain("text-foreground");
    expect(html).not.toMatch(/(?<!motion-safe:)animate-in/);
    expect(html).not.toMatch(/\b(fixed|absolute|sticky)\b/);
  });
});
