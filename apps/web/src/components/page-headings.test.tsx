import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import enErrors from "@knowledge-base/locales/src/en-US/errors.json";
import { createInstance } from "i18next";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * One real h1 per page, never a `role="heading"` stand-in:
 * - the 404's title in whichever shell renders it: the public shell (an
 *   unknown URL, signed in or not: `$lang`'s notFoundComponent) and the app
 *   shell (a not-found boundary inside it). The shells' own chrome (header,
 *   sidebar, nav, banners, footer) is rendered for real and brings no heading;
 * - Settings: the layout's "Settings" title. Its pages title their sections
 *   with card titles, and its unknown-page 404 is nested (an h2).
 * Route files cannot hold tests, so the routes are rendered from here.
 */
const fixture = vi.hoisted(() => ({
  session: "anonymous" as "anonymous" | "authenticated",
  outlet: "not-found" as "not-found" | "marker",
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    options,
    useParams: () => ({ lang: "en-US" }),
  }),
  lazyRouteComponent: (importer: () => Promise<Record<string, unknown>>, name = "default") => ({
    importer,
    name,
  }),
  Link: ({ children, className }: { children: ReactNode; className?: string }) => (
    <a className={className}>{children}</a>
  ),
  Outlet: () => <TestOutlet />,
  redirect: () => undefined,
  useParams: () => ({ lang: "en-US" }),
  useNavigate: () => vi.fn(),
  useRouter: () => ({ navigate: vi.fn(), state: { location: { pathname: "/en-US/nope" } } }),
  useRouterState: () => undefined,
  useMatch: () => undefined,
  useMatches: () => [],
  useLocation: () => ({ pathname: "/en-US/nope", search: {}, hash: "" }),
}));
vi.mock("@tanstack/react-query", () => ({
  queryOptions: (options: unknown) => options,
  useQuery: () => ({ data: undefined, isPending: false, isError: false, refetch: vi.fn() }),
  useMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useIsMutating: () => 0,
}));
vi.mock("@tanstack/react-query-devtools", () => ({ ReactQueryDevtools: () => null }));
vi.mock("@tanstack/react-router-devtools", () => ({ TanStackRouterDevtools: () => null }));
vi.mock("@knowledge-base/env/web", () => ({ env: { VITE_APP_NAME: "Northwind" } }));
vi.mock("@/utils/orpc", () => {
  // Any `orpc.<router>.<procedure>` path, with the option builders the shells use.
  const leaf = {
    queryOptions: () => ({}),
    mutationOptions: () => ({}),
    infiniteOptions: () => ({}),
    queryKey: () => [],
    key: () => [],
    call: async () => ({}),
  };
  const node = (): unknown =>
    new Proxy(leaf, {
      get: (target, key) => (key in target ? target[key as keyof typeof target] : node()),
    });
  return { orpc: node() };
});
vi.mock("@/lib/auth-client", () => ({ authClient: {} }));
vi.mock("@/server/auth-session", () => ({
  getRouteSession: vi.fn(),
  getSessionCookieHint: vi.fn(async () => false),
}));
vi.mock("@/hooks/use-auth-session", () => ({
  getAuthActorKey: () => null,
  useAuthSession: () =>
    fixture.session === "anonymous"
      ? { state: { status: "anonymous" }, actions: { retry: vi.fn() }, meta: {} }
      : {
          state: {
            status: "authenticated",
            session: { user: { id: "u1", name: "Ada", role: "user", emailVerified: true } },
          },
          actions: { retry: vi.fn() },
          meta: { isDegraded: false },
        },
}));
vi.mock("@/hooks/use-document-lang", () => ({ useDocumentLang: () => {} }));
vi.mock("@/hooks/use-user-locale-sync", () => ({ useUserLocaleSync: () => {} }));
vi.mock("@/i18n", () => ({ default: {}, loadLocaleInto: async () => {} }));

const { default: NotFoundState } = await import("@/components/not-found-state");
function TestOutlet() {
  return fixture.outlet === "not-found" ? <NotFoundState /> : <section data-outlet="" />;
}
const { PublicNotFoundPage } = await import("@/components/public-shell");
const { Route: AppRoute } = await import("@/routes/$lang/_app/route");
const { Route: SettingsRoute } = await import("@/routes/$lang/_app/_auth/settings");

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: "en-US",
    resources: { "en-US": { errors: enErrors } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
});

function h1s(html: string): string[] {
  expect(html).not.toContain('role="heading"');
  return [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/g)].map(([, inner = ""]) => inner);
}

function render(node: ReactNode) {
  return renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);
}

type Split = { importer: () => Promise<Record<string, unknown>>; name: string };
type RouteOptions = {
  options: { component: (() => ReactNode) | Split; notFoundComponent: (() => ReactNode) | Split };
};
/** A route component, behind the router plugin's code split when it has one. */
async function routeComponent(
  route: unknown,
  key: "component" | "notFoundComponent" = "component",
): Promise<() => ReactNode> {
  const component = (route as RouteOptions).options[key];
  if (typeof component === "function") return component;
  return (await component.importer())[component.name] as () => ReactNode;
}

const AppLayout = await routeComponent(AppRoute);
const SettingsLayout = await routeComponent(SettingsRoute);
const SettingsNotFound = await routeComponent(SettingsRoute, "notFoundComponent");

describe.each(["anonymous", "authenticated"] as const)("404, %s", (session) => {
  it("has exactly one h1 inside the public shell", () => {
    fixture.session = session;
    fixture.outlet = "not-found";
    expect(h1s(render(<PublicNotFoundPage />))).toEqual([enErrors.pageNotFound.title]);
  });

  it("has exactly one h1 inside the app shell", () => {
    fixture.session = session;
    fixture.outlet = "not-found";
    expect(h1s(render(<AppLayout />))).toEqual([enErrors.pageNotFound.title]);
  });
});

const SETTINGS_DIR = path.resolve(import.meta.dirname, "../routes/$lang/_app/_auth/settings");

describe("settings headings", () => {
  it("the layout renders exactly one h1, above the page", () => {
    fixture.outlet = "marker";
    const html = render(<SettingsLayout />);
    expect(html.match(/<h1\b[^>]*>[^<]*<\/h1>/g)).toHaveLength(1);
    expect(html.indexOf("<h1")).toBeLessThan(html.indexOf("data-outlet"));
  });

  it("an unknown settings page keeps the layout's h1 the only one", () => {
    const html = render(<SettingsNotFound />);
    expect(h1s(html)).toEqual([]);
    expect(html).toContain(`>${enErrors.pageNotFound.title}</h2>`);
  });

  const pages = readdirSync(SETTINGS_DIR).filter(
    (file) => file.endsWith(".tsx") && !file.includes(".test."),
  );

  it.each(pages)("%s adds no level-1 heading of its own", (file) => {
    const source = readFileSync(path.join(SETTINGS_DIR, file), "utf8");
    expect(source).not.toMatch(/<h1\b/);
    expect(source).not.toMatch(/<PageHeader\b/);
    expect(source).not.toMatch(/role="heading"/);
  });

  it("finds the settings pages", () => {
    expect(pages).toEqual(expect.arrayContaining(["index.tsx", "security.tsx", "mcp.tsx"]));
  });
});
