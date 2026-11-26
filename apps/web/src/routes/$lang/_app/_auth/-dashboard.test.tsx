import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentType, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
// @ts-expect-error — TanStack exposes the private route component through this Vite split module.
import { component as Component } from "./dashboard?tsr-split=component";

type ListPage = { items: Array<{ id: string; embeddingGeneration: unknown }>; nextCursor: null };
const fixture = vi.hoisted(() => ({
  owned: undefined as ListPage | undefined,
  shared: undefined as ListPage | undefined,
  tokens: undefined as { personalTokens: number; childTokens: number } | undefined,
  createOpen: [] as boolean[],
}));

vi.mock("@tanstack/react-router", () => ({
  lazyRouteComponent: () => () => null,
  createFileRoute: () => (options: { component: ComponentType }) => ({
    options,
    useRouteContext: () => ({ session: { user: { name: "Ada" } } }),
    useParams: () => ({ lang: "en-US" }),
  }),
  useNavigate: () => () => undefined,
  Link: ({
    to,
    params,
    children,
    ...rest
  }: {
    to: string;
    params: { lang: string };
    children: ReactNode;
    className?: string;
  }) => (
    <a href={to.replace("$lang", params.lang)} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("react-i18next", async (original) => ({
  ...(await original<typeof import("react-i18next")>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@tanstack/react-query", async (original) => ({
  ...(await original<typeof import("@tanstack/react-query")>()),
  useQuery: (options: { queryKey: unknown[] }) => {
    const key = JSON.stringify(options.queryKey);
    const data = key.includes("countActiveMine")
      ? fixture.tokens
      : key.includes('"owned"')
        ? fixture.owned
        : fixture.shared;
    return { data, isPending: data === undefined, isError: false, refetch: vi.fn() };
  },
}));
vi.mock("@/components/pull-to-refresh", () => ({
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/kb/kb-list", () => ({
  KB_GRID_CLASS: "grid-cols-1",
  createdKbDestination: () => "open",
  KbList: () => <ul data-testid="kb-list" />,
  KbCreateDialog: ({ open }: { open: boolean }) => {
    fixture.createOpen.push(open);
    return <div data-testid="kb-create-dialog" />;
  },
}));
vi.mock("@/lib/credential-counts", () => ({
  activeTokenCount: (counts: { personalTokens: number }) => counts.personalTokens,
}));

function render() {
  const client = new QueryClient();
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <Component />
      </QueryClientProvider>,
    );
  } finally {
    client.clear();
  }
}

const page = (count: number, searchable = 0): ListPage => ({
  items: Array.from({ length: count }, (_, index) => ({
    id: `kb${index}`,
    embeddingGeneration: index < searchable ? { id: "g" } : null,
  })),
  nextCursor: null,
});

afterEach(() => {
  fixture.owned = undefined;
  fixture.shared = undefined;
  fixture.tokens = undefined;
  fixture.createOpen = [];
});

it("gives a brand-new user a way to create a KB and connect a client, and no zero stats", () => {
  fixture.owned = page(0);
  fixture.shared = page(0);
  fixture.tokens = { personalTokens: 0, childTokens: 0 };
  const out = render();
  expect(out).toContain("dashboard:emptyTitle");
  expect(out).toContain('data-testid="dashboard-create-kb"');
  expect(out).toContain("dashboard:createKb");
  expect(out).toMatch(
    /data-testid="dashboard-connect-client"[^>]*href="\/en-US\/settings\/mcp"|href="\/en-US\/settings\/mcp"[^>]*data-testid="dashboard-connect-client"/,
  );
  // The existing create dialog is reused (closed until asked).
  expect(fixture.createOpen).toEqual([false]);
  expect(out).not.toContain('data-testid="dashboard-kpis"');
  expect(out).not.toContain("dashboard:kpi.searchableHint");
});

it("keeps every stat tile as a skeleton while loading", () => {
  const out = render();
  expect(out.match(/<dt/g)).toHaveLength(4);
  expect(out).toContain('data-slot="skeleton"');
  expect(out).not.toContain('data-testid="dashboard-create-kb"');
});

it("shows only the stats that count something", () => {
  fixture.owned = page(2, 1);
  fixture.shared = page(0);
  fixture.tokens = { personalTokens: 3, childTokens: 0 };
  const out = render();
  expect(out).toContain("dashboard:kpi.owned");
  expect(out).not.toContain("dashboard:kpi.shared");
  expect(out).toContain("dashboard:kpi.searchable");
  expect(out).toContain("dashboard:kpi.tokens");
  expect(out).toContain('data-testid="kb-list"');
  expect(out).not.toContain("dashboard:emptyTitle");
  fixture.owned = page(2, 0);
  fixture.tokens = { personalTokens: 0, childTokens: 0 };
  const none = render();
  expect(none).not.toContain("dashboard:kpi.searchable");
  expect(none).not.toContain("dashboard:kpi.tokens");
});
