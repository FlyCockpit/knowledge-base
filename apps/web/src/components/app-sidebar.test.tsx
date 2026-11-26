import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The sidebar is part of the app shell's first frame (`_app`'s pending
 * component): on a signed-in page it keeps its place while the session
 * loads, so the content does not narrow when it arrives.
 */
const state = vi.hoisted(() => ({
  status: "pending" as "pending" | "authenticated" | "unauthenticated",
  routeIds: [] as string[],
  collapsed: false,
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/x">{children}</a>,
  useParams: () => ({ lang: "en-US" }),
  useRouterState: ({ select }: { select: (s: unknown) => unknown }) =>
    select({ matches: state.routeIds.map((routeId) => ({ routeId })) }),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/hooks/use-auth-session", () => ({
  useAuthSession: () => ({
    state:
      state.status === "authenticated"
        ? { status: "authenticated", session: { user: { role: "user" } } }
        : { status: state.status },
  }),
}));
vi.mock("@/stores/ui-preferences", () => ({
  useUiPreferences: (select: (prefs: unknown) => unknown) =>
    select({ sidebarCollapsed: state.collapsed, toggleSidebar: () => {} }),
}));

const { AppSidebar } = await import("./app-sidebar");
const html = () => renderToStaticMarkup(<AppSidebar />);

beforeEach(() => {
  state.status = "pending";
  state.routeIds = ["__root__", "/$lang", "/$lang/_app", "/$lang/_app/_auth"];
  state.collapsed = false;
});

describe("AppSidebar", () => {
  it("keeps its place on a signed-in page while the session loads", () => {
    const out = html();
    expect(out).toMatch(
      /<aside aria-hidden="true" data-app-nav="sidebar"[^>]*class="[^"]*\bw-60\b/,
    );
    expect(out).toContain('data-slot="skeleton"');
    expect(out).not.toContain("<a ");
  });

  it("keeps the collapsed rail's width", () => {
    state.collapsed = true;
    expect(html()).toMatch(/<aside [^>]*class="[^"]*\bw-16\b/);
  });

  it("keeps its place on admin pages too", () => {
    state.routeIds = ["__root__", "/$lang", "/$lang/_app", "/$lang/_app/admin"];
    expect(html()).toContain('data-app-nav="sidebar"');
  });

  it("has no place on the sign-in pages", () => {
    state.routeIds = ["__root__", "/$lang", "/$lang/_app", "/$lang/_app/login"];
    expect(html()).toBe("");
    state.status = "unauthenticated";
    state.routeIds = ["__root__", "/$lang", "/$lang/_app", "/$lang/_app/_auth"];
    expect(html()).toBe("");
  });

  it("shows the links once signed in", () => {
    state.status = "authenticated";
    const out = html();
    expect(out).toContain("<a ");
    expect(out).not.toContain('data-slot="skeleton"');
  });
});
