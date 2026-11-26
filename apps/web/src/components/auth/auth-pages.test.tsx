import enAuth from "@knowledge-base/locales/src/en-US/auth.json";
import enCommon from "@knowledge-base/locales/src/en-US/common.json";
import enDashboard from "@knowledge-base/locales/src/en-US/dashboard.json";
import enNav from "@knowledge-base/locales/src/en-US/nav.json";
import { createInstance } from "i18next";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The sign-up-mode states of the three pages a visitor without an account
 * lands on (sign-in, `/signup`, the landing page), plus the dashboard greeting.
 * Route files cannot hold tests (the route generator would treat them as
 * routes), so the routes are rendered from here, like
 * components/header.test.tsx does. docs/ui.md § Sign-up modes.
 */
const fixture = vi.hoisted(() => ({
  config: undefined as Record<string, unknown> | undefined,
  routeContext: {} as Record<string, unknown>,
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    options,
    useParams: () => ({ lang: "en-US" }),
    useSearch: () => ({}),
    useRouteContext: () => fixture.routeContext,
  }),
  // Vitest runs the router plugin, which splits route components out into
  // `lazyRouteComponent(importer, name)`; keep the importer so the test can
  // load the real component.
  lazyRouteComponent: (importer: () => Promise<Record<string, unknown>>, name = "default") => ({
    importer,
    name,
  }),
  redirect: (options: unknown) => ({ redirect: options }),
  useNavigate: () => vi.fn(),
  Link: ({ to, className, children }: { to: string; className?: string; children: ReactNode }) => (
    <a data-to={to} className={className ?? ""}>
      {children}
    </a>
  ),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: fixture.config,
    isPending: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useMutation: () => ({ mutateAsync: vi.fn() }),
  useQueryClient: () => ({}),
}));
vi.mock("@/components/pull-to-refresh", () => ({
  default: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/utils/orpc", () => ({
  orpc: {
    appConfig: { queryOptions: () => ({}) },
    kbs: { list: { queryOptions: () => ({}) } },
    mcpGrants: { countActiveMine: { queryOptions: () => ({}) } },
    setup: { claimFirstAdmin: { mutationOptions: () => ({}) } },
  },
}));
vi.mock("@/hooks/use-auth-session", () => ({
  useAuthSession: () => ({ state: { status: "anonymous" }, actions: { retry: vi.fn() } }),
}));
vi.mock("@knowledge-base/env/web", () => ({ env: { VITE_APP_NAME: "Northwind" } }));
vi.mock("@/lib/auth-client", () => ({ authClient: {} }));
vi.mock("@/server/auth-session", () => ({
  getRouteSession: vi.fn(async () => ({ status: "ok", session: null })),
  getSessionCookieHint: vi.fn(async () => false),
}));

const { Route: LoginRoute } = await import("@/routes/$lang/_app/login");
const { Route: SignupRoute } = await import("@/routes/$lang/_app/signup");
const { Route: LandingRoute } = await import("@/routes/$lang/_public/index");
const { Route: DashboardRoute } = await import("@/routes/$lang/_app/_auth/dashboard");

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: "en-US",
    resources: {
      "en-US": { auth: enAuth, common: enCommon, nav: enNav, dashboard: enDashboard },
    },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
});
beforeEach(() => {
  fixture.config = undefined;
  fixture.routeContext = {};
});

const OPEN = { signupEnabled: true, adminBootstrapSignupEnabled: false };
const BOOTSTRAP = { signupEnabled: false, adminBootstrapSignupEnabled: true };
const CLOSED = { signupEnabled: false, adminBootstrapSignupEnabled: false };
const FORCE_SSO = {
  signupEnabled: true,
  forceSso: true,
  ssoEnabled: true,
  ssoProviderName: "Okta",
};

type SplitComponent = { importer: () => Promise<Record<string, unknown>>; name: string };
type Route = { options: { component: SplitComponent } };

async function render(route: unknown) {
  const { component } = (route as Route).options;
  const Component = (await component.importer())[component.name] as () => ReactNode;
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <Component />
    </I18nextProvider>,
  );
}

/** Visible text of each `<a>` the page renders, keyed by its target. */
function links(html: string) {
  return [...html.matchAll(/<a data-to="([^"]*)" class="[^"]*">(.*?)<\/a>/g)].map(
    ([, to = "", inner = ""]) => ({ to, text: inner.replace(/<[^>]*>/g, "") }),
  );
}

const signupLinks = (html: string) => links(html).filter((l) => l.to === "/$lang/signup");
const loginLinks = (html: string) => links(html).filter((l) => l.to === "/$lang/login");

describe("sign-in page", () => {
  it("is titled Sign In, not Welcome Back", async () => {
    fixture.config = OPEN;
    const html = await render(LoginRoute);
    expect(html).toContain(`>${enAuth.login.signinTitle}<`);
    expect(enAuth.login.signinTitle).toBe("Sign In");
  });

  it("open: links to sign-up", async () => {
    fixture.config = OPEN;
    expect(signupLinks(await render(LoginRoute)).map((l) => l.text)).toEqual([
      enAuth.login.signupHint,
    ]);
  });

  it("bootstrap: the sign-up link says it sets up the server", async () => {
    fixture.config = BOOTSTRAP;
    expect(signupLinks(await render(LoginRoute)).map((l) => l.text)).toEqual([
      enAuth.signupMode.setupHint,
    ]);
  });

  it("closed: no sign-up link, and the invite-only note instead", async () => {
    fixture.config = CLOSED;
    const html = await render(LoginRoute);
    expect(signupLinks(html)).toEqual([]);
    expect(html).toContain(enAuth.signupMode.inviteOnly);
  });

  it("forceSso: keeps the SSO-only state with no sign-up link or invite note", async () => {
    fixture.config = FORCE_SSO;
    const html = await render(LoginRoute);
    expect(html).toContain(enAuth.login.ssoOnlyDescription.replace("{{provider}}", "Okta"));
    expect(signupLinks(html)).toEqual([]);
    expect(html).not.toContain(enAuth.signupMode.inviteOnly);
    expect(html).not.toContain('type="password"');
  });
});

describe("/signup", () => {
  it("open: the create-account form shows the password rule up front", async () => {
    fixture.config = OPEN;
    const html = await render(SignupRoute);
    expect(html).toContain(`>${enAuth.login.createAccount}<`);
    const rule = enAuth.fields.passwordRule.replace("{{min}}", "12");
    // The rule is the field's description, wired to the input before any error.
    const descriptionId = html.match(/<div id="([^"]*-password-description)"[^>]*>([^<]*)<\/div>/);
    expect(descriptionId?.[2]).toBe(rule);
    const input = html.match(/<input[^>]*name="password"[^>]*>/)?.[0] ?? "";
    expect(input).toContain(`aria-describedby="${descriptionId?.[1]}"`);
    expect(input).not.toContain(`aria-invalid="`);
  });

  it("bootstrap: says it sets up the server and tells everyone else it is invite-only", async () => {
    fixture.config = BOOTSTRAP;
    const html = await render(SignupRoute);
    expect(html).toContain(`>${enAuth.signupMode.setupTitle}<`);
    expect(html).toContain(enAuth.signupMode.setupDescription);
    expect(html).toContain(enAuth.signupMode.setupOthers);
    expect(html).not.toContain(`>${enAuth.login.createAccount}<`);
    expect(html).toContain('name="password"');
  });

  it("closed: explains invite-only with a Sign In button instead of a form", async () => {
    fixture.config = CLOSED;
    const html = await render(SignupRoute);
    expect(html).toContain(`>${enAuth.signupMode.closedTitle}<`);
    expect(html).toContain(enAuth.signupMode.closedDescription);
    expect(loginLinks(html).map((l) => l.text)).toEqual([enAuth.login.signIn]);
    expect(html).not.toContain("<input");
  });

  it("closed no longer bounces to sign-in in beforeLoad; forceSso still does", async () => {
    const beforeLoad = (
      SignupRoute as unknown as {
        options: { beforeLoad: (ctx: unknown) => Promise<void> };
      }
    ).options.beforeLoad;
    const ctx = (config: Record<string, unknown>) => ({
      context: { queryClient: { ensureQueryData: async () => config } },
      params: { lang: "en-US" },
      search: {},
    });
    await expect(beforeLoad(ctx(CLOSED))).resolves.toBeUndefined();
    await expect(beforeLoad(ctx(FORCE_SSO))).rejects.toMatchObject({
      redirect: { to: "/$lang/login" },
    });
  });

  it("forceSso: keeps the SSO-required state", async () => {
    fixture.config = FORCE_SSO;
    const html = await render(SignupRoute);
    expect(html).toContain(`>${enAuth.login.ssoRequiredTitle}<`);
    expect(html).not.toContain("<input");
  });
});

describe("landing page", () => {
  it("before appConfig answers (and in the SSR/cached HTML): a neutral Sign in only", async () => {
    fixture.config = undefined;
    const html = await render(LandingRoute);
    expect(loginLinks(html).map((l) => l.text)).toEqual([enCommon.home.signIn]);
    expect(signupLinks(html)).toEqual([]);
    expect(html).not.toContain(enCommon.home.inviteOnly);
  });

  it("open: Create account and Sign in", async () => {
    fixture.config = OPEN;
    const html = await render(LandingRoute);
    expect(signupLinks(html).map((l) => l.text)).toEqual([enCommon.home.createAccount]);
    expect(loginLinks(html)).toHaveLength(1);
  });

  it("bootstrap: Sign in first, the invite-only line and a small set-up link", async () => {
    fixture.config = BOOTSTRAP;
    const html = await render(LandingRoute);
    expect(signupLinks(html).map((l) => l.text)).toEqual([enCommon.home.setupHint]);
    expect(loginLinks(html)).toHaveLength(1);
    expect(html).toContain(enCommon.home.inviteOnly);
  });

  it("closed: Sign in with the invite-only line", async () => {
    fixture.config = CLOSED;
    const html = await render(LandingRoute);
    expect(signupLinks(html)).toEqual([]);
    expect(loginLinks(html)).toHaveLength(1);
    expect(html).toContain(enCommon.home.inviteOnly);
  });

  it("forceSso: Sign in only", async () => {
    fixture.config = FORCE_SSO;
    const html = await render(LandingRoute);
    expect(signupLinks(html)).toEqual([]);
    expect(loginLinks(html)).toHaveLength(1);
    expect(html).not.toContain(enCommon.home.inviteOnly);
  });
});

describe("dashboard greeting", () => {
  it('greets with "Welcome, {name}", never "Welcome back"', async () => {
    fixture.routeContext = { session: { user: { name: "Ada" } } };
    const html = await render(DashboardRoute);
    expect(html).toContain("Welcome, Ada");
    expect(html).not.toMatch(/welcome back/i);
  });
});
