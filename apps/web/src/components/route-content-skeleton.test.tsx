import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The route skeleton has the loading page's shape, inside whatever layout is
 * already on screen. docs/ui.md § Route pending states
 */
const router = vi.hoisted(() => ({
  routeId: "/$lang/_app",
  matches: [] as { routeId: string; staticData?: Record<string, unknown>; search?: unknown }[],
}));

vi.mock("@tanstack/react-router", () => ({
  useMatch: ({ select }: { select: (match: { routeId: string }) => unknown }) =>
    select({ routeId: router.routeId }),
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
    select({ matches: router.matches }),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const { RouteContentSkeleton } = await import("./route-content-skeleton");
const { KB_GRID_CLASS } = await import("@/lib/kb-grid");
const { kbPendingFrame } = await import("@/lib/pending-layout");
const html = () => renderToStaticMarkup(<RouteContentSkeleton />);

const APP = { routeId: "/$lang/_app" };
const AUTH = { routeId: "/$lang/_app/_auth" };
const ADMIN = { routeId: "/$lang/_app/admin", staticData: { pendingFrame: "admin" } };
const SETTINGS = {
  routeId: "/$lang/_app/_auth/settings",
  staticData: { pendingFrame: "settings" },
};

beforeEach(() => {
  router.routeId = APP.routeId;
});

describe("RouteContentSkeleton", () => {
  const KB_LAYOUT = {
    routeId: "/$lang/_app/_auth/kbs/$kbId",
    staticData: { pendingFrame: kbPendingFrame, pendingShape: "detail" },
  };

  it("draws a KB document inside the workspace (tree, toolbar, full-width pane)", () => {
    router.matches = [
      APP,
      AUTH,
      KB_LAYOUT,
      {
        routeId: "/$lang/_app/_auth/kbs/$kbId/documents",
        staticData: { pendingShape: "document", pendingWidth: "full" },
      },
    ];
    const out = html();
    expect(out).toContain('data-pending-frame="workspace"');
    expect(out).toContain('data-route-skeleton="document"');
    // The tree pane from 1024px at its default width, and the document's own
    // loading state at the long-read measure, with no page column around it.
    expect(out).toContain("lg:flex");
    expect(out).toContain("width:288px");
    // The sidebar's view selector (Files / Search / Outline / Activity) sits
    // above the files, and the breadcrumbs reserve their 44px row.
    expect(out).toContain("inline-flex w-max flex-row items-center gap-1 rounded-md border p-1");
    expect(out).toContain("-mt-2 flex min-h-11 items-center");
    expect(out).toContain("max-w-[72ch]");
    expect(out).not.toContain("max-w-6xl");
    expect(out).not.toContain("container mx-auto");
  });

  it("keeps the KB home's centred column inside the workspace pane", () => {
    router.matches = [APP, AUTH, KB_LAYOUT];
    const out = html();
    expect(out).toContain('data-pending-frame="workspace"');
    expect(out).toContain("mx-auto max-w-6xl");
  });

  it("draws a KB's settings in its page column, not the workspace", () => {
    router.matches = [
      APP,
      AUTH,
      KB_LAYOUT,
      { routeId: "/$lang/_app/_auth/kbs/$kbId/settings", staticData: { pendingShape: "form" } },
    ];
    const out = html();
    expect(out).not.toContain("data-pending-frame");
    expect(out).toContain("container mx-auto");
  });

  it("draws the admin overview as a status card and section cards, not KPI tiles", () => {
    router.matches = [
      APP,
      ADMIN,
      {
        routeId: "/$lang/_app/admin/",
        staticData: { pendingShape: "overview", pendingWidth: "wide" },
      },
    ];
    const out = html();
    expect(out).toContain('data-route-skeleton="overview"');
    expect(out).toContain("lg:grid-cols-3");
    expect(out).not.toContain("lg:grid-cols-4");
    expect(out).toContain("max-w-7xl");
  });

  it("draws the knowledge bases page as a grid of KB cards, not a list", () => {
    router.matches = [
      APP,
      AUTH,
      { routeId: "/$lang/_app/_auth/kbs/", staticData: { pendingShape: "cards" } },
    ];
    const out = html();
    expect(out).toContain('data-route-skeleton="cards"');
    expect(out).toContain(KB_GRID_CLASS);
    // "Owned" and "Shared with me", each with its own grid.
    expect(out.split(KB_GRID_CLASS).length - 1).toBe(2);
    expect(out).not.toContain("divide-y");
  });

  it("draws the sign-in pages' centred card without a page container", () => {
    router.matches = [APP, { routeId: "/$lang/_app/login", staticData: { pendingShape: "auth" } }];
    const out = html();
    expect(out).toContain('data-route-skeleton="auth"');
    expect(out).toContain("min-h-[80vh]");
    expect(out).not.toContain("container");
  });

  it("adds no page container inside a settings layout that is already on screen", () => {
    router.routeId = "/$lang/_app/_auth/settings/security";
    router.matches = [
      APP,
      AUTH,
      SETTINGS,
      { routeId: router.routeId, staticData: { pendingShape: "form" } },
    ];
    const out = html();
    expect(out).toContain('data-route-skeleton="form"');
    expect(out).not.toContain("container");
  });

  it("draws the settings frame when the whole settings section is loading", () => {
    router.matches = [
      APP,
      AUTH,
      SETTINGS,
      { routeId: "/$lang/_app/_auth/settings/security", staticData: { pendingShape: "form" } },
    ];
    const out = html();
    expect(out).toContain("container mx-auto max-w-4xl");
    expect(out).toContain("md:w-48");
  });
});
