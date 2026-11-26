import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The admin layout waits for the app settings before it draws, so the 2FA
 * nudge under its sub-nav arrives with the page instead of pushing the page
 * down after it has loaded. docs/ui.md § Route pending states
 */
const settings = vi.hoisted(() => ({ isPending: true }));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    options,
    useParams: () => ({ lang: "en-US" }),
  }),
  lazyRouteComponent: (importer: () => Promise<Record<string, unknown>>, name = "default") => ({
    importer,
    name,
  }),
  Link: ({ children }: { children: ReactNode }) => <a href="/x">{children}</a>,
  notFound: () => new Error("not found"),
  Outlet: () => <p data-outlet="">page</p>,
}));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ isPending: settings.isPending }) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@knowledge-base/ui/components/selector-row", () => ({
  SelectorRow: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/admin/two-factor-nudge", () => ({
  TwoFactorNudge: () => <div data-nudge="" />,
}));
vi.mock("@/components/route-content-skeleton", () => ({
  RouteContentSkeleton: () => <p data-route-skeleton="">skeleton</p>,
}));
vi.mock("@/lib/route-session-access", () => ({ decideAdminRouteAccess: () => ({}) }));
vi.mock("@/server/auth-session", () => ({ getRouteSession: async () => null }));
vi.mock("@/utils/orpc", () => ({
  orpc: { settings: { getAll: { queryOptions: () => ({ queryKey: ["settings"] }) } } },
}));

const { Route } = await import("@/routes/$lang/_app/admin");

type Lazy = { importer: () => Promise<Record<string, unknown>>; name: string };

async function render(): Promise<string> {
  const value = (Route as unknown as { options: { component: unknown } }).options.component;
  const Component = (
    typeof value === "function" ? value : (await (value as Lazy).importer())[(value as Lazy).name]
  ) as () => ReactNode;
  return renderToStaticMarkup(<Component />);
}

beforeEach(() => {
  settings.isPending = true;
});

describe("the admin layout", () => {
  it("shows the route skeleton (sub-nav included) while the app settings load", async () => {
    const html = await render();
    expect(html).toContain("data-route-skeleton");
    expect(html).not.toContain("data-outlet");
    expect(html).not.toContain("data-nudge");
  });

  it("draws the sub-nav, the nudge and the page together once they have loaded", async () => {
    settings.isPending = false;
    const html = await render();
    expect(html).toContain("<nav");
    expect(html).toContain("data-nudge");
    expect(html).toContain("data-outlet");
    expect(html).not.toContain("data-route-skeleton");
  });
});
