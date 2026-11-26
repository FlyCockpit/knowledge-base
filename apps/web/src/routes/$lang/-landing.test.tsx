import enCommon from "@knowledge-base/locales/src/en-US/common.json";
import { createInstance } from "i18next";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The public landing page (`/$lang/`): its way in per sign-up mode
 * (lib/signup-mode.ts), its forward of a visitor with a session cookie to the
 * signed-in home, and the `/$lang/dashboard` redirect to that home. Route files
 * cannot hold tests (the generator would treat them as routes), so the `-`
 * prefix keeps this one out of the route tree. docs/ui.md § The signed-in home.
 */
const fixture = vi.hoisted(() => ({
  config: undefined as Record<string, unknown> | undefined,
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    options,
    useParams: () => ({ lang: "en-US" }),
  }),
  // The router plugin splits route components out in Vitest too.
  lazyRouteComponent: (importer: () => Promise<Record<string, unknown>>, name = "default") => ({
    importer,
    name,
  }),
  redirect: (options: unknown) => ({ redirect: options }),
  Link: ({ to, className, children }: { to: string; className?: string; children: ReactNode }) => (
    <a data-to={to} className={className ?? ""}>
      {children}
    </a>
  ),
}));
vi.mock("@tanstack/react-query", () => ({
  queryOptions: (options: unknown) => options,
  useQuery: () => ({ data: fixture.config, isPending: fixture.config === undefined }),
}));
vi.mock("@/utils/orpc", () => ({ orpc: { appConfig: { queryOptions: () => ({}) } } }));
vi.mock("@knowledge-base/env/web", () => ({ env: { VITE_APP_NAME: "Northwind" } }));
vi.mock("@/server/auth-session", () => ({ getSessionCookieHint: vi.fn(async () => false) }));

const { Route: LandingRoute } = await import("@/routes/$lang/_public/index");
const { Route: DashboardRedirectRoute } = await import("@/routes/$lang/dashboard");

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: "en-US",
    resources: { "en-US": { common: enCommon } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
});
beforeEach(() => {
  fixture.config = undefined;
});

const OPEN = { signupEnabled: true, adminBootstrapSignupEnabled: false };
// `adminBootstrapSignupEnabled` is true only until bootstrap completes (the
// first admin exists; `isBootstrapComplete`), then the server reports CLOSED.
const BOOTSTRAP = { signupEnabled: false, adminBootstrapSignupEnabled: true };
const CLOSED = { signupEnabled: false, adminBootstrapSignupEnabled: false };
const FORCE_SSO = { signupEnabled: true, forceSso: true };

type SplitComponent = { importer: () => Promise<Record<string, unknown>>; name: string };

async function render(): Promise<string> {
  const split = (LandingRoute as unknown as { options: { component: SplitComponent } }).options
    .component;
  const Component = (await split.importer())[split.name] as () => ReactNode;
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <Component />
    </I18nextProvider>,
  );
}

/** A string as React writes it into HTML text (apostrophes escaped). */
const html = (text: string) => text.replace(/'/g, "&#x27;");

/** Visible text of each `<a>` the page renders, with its target and whether it is filled. */
function links(html: string) {
  return [...html.matchAll(/<a data-to="([^"]*)" class="([^"]*)">(.*?)<\/a>/g)].map(
    ([, to = "", className = "", inner = ""]) => ({
      to,
      text: inner.replace(/<[^>]*>/g, ""),
      primary: className.split(" ").includes("bg-primary"),
    }),
  );
}

describe("landing page", () => {
  it("says what this is in one line under the name", async () => {
    const page = await render();
    expect(page).toContain(">Northwind<");
    expect(page).toContain(html(enCommon.home.description));
  });

  it("before appConfig answers (and in the SSR HTML): a neutral Sign in only", async () => {
    expect(links(await render())).toEqual([
      { to: "/$lang/login", text: enCommon.home.signIn, primary: true },
    ]);
  });

  it("open: Create account (primary), then Sign in", async () => {
    fixture.config = OPEN;
    expect(links(await render())).toEqual([
      { to: "/$lang/signup", text: enCommon.home.createAccount, primary: true },
      { to: "/$lang/login", text: enCommon.home.signIn, primary: false },
    ]);
  });

  it("bootstrap open: Set up this server (primary), then Sign in; no invite-only line", async () => {
    fixture.config = BOOTSTRAP;
    const page = await render();
    expect(links(page)).toEqual([
      { to: "/$lang/signup", text: enCommon.home.setUp, primary: true },
      { to: "/$lang/login", text: enCommon.home.signIn, primary: false },
    ]);
    expect(page).not.toContain(html(enCommon.home.inviteOnly));
  });

  it("bootstrap complete (closed): Sign in (primary) with the invite-only line, no set-up", async () => {
    fixture.config = CLOSED;
    const page = await render();
    expect(links(page)).toEqual([
      { to: "/$lang/login", text: enCommon.home.signIn, primary: true },
    ]);
    expect(page).toContain(html(enCommon.home.inviteOnly));
    expect(page).not.toContain(html(enCommon.home.setUp));
  });

  it("forced SSO: Sign in only", async () => {
    fixture.config = FORCE_SSO;
    const page = await render();
    expect(links(page)).toEqual([
      { to: "/$lang/login", text: enCommon.home.signIn, primary: true },
    ]);
    expect(page).not.toContain(html(enCommon.home.inviteOnly));
  });

  // The `_public` layout seeded the hint; the landing reads the same query
  // (`fetchQuery`: fresh cache or a new answer) instead of calling the server
  // function again.
  const landingBeforeLoad = (
    LandingRoute as unknown as { options: { beforeLoad: (ctx: unknown) => Promise<void> } }
  ).options.beforeLoad;
  const cachedHint = (value: boolean) => {
    const fetchQuery = vi.fn(async () => value);
    return {
      fetchQuery,
      ctx: { params: { lang: "es-MX" }, context: { queryClient: { fetchQuery } } },
    };
  };

  it("forwards a visitor with a session cookie to the knowledge bases list, from the shared query", async () => {
    const { getSessionCookieHint } = await import("@/server/auth-session");
    vi.mocked(getSessionCookieHint).mockClear();
    const { fetchQuery, ctx } = cachedHint(true);
    await expect(landingBeforeLoad(ctx)).rejects.toEqual({
      redirect: { to: "/$lang/kbs", params: { lang: "es-MX" }, replace: true },
    });
    expect(fetchQuery).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ["session-cookie-hint"], networkMode: "always" }),
    );
    // Read through the cache: no direct server-function call from the route.
    expect(getSessionCookieHint).not.toHaveBeenCalled();
  });

  it("shows the landing page when the hint says signed out", async () => {
    await expect(landingBeforeLoad(cachedHint(false).ctx)).resolves.toBeUndefined();
  });
});

describe("/dashboard", () => {
  it("is only a redirect to the signed-in home, keeping the locale", () => {
    const { beforeLoad, component } = (
      DashboardRedirectRoute as unknown as {
        options: { beforeLoad: (ctx: unknown) => void; component?: unknown };
      }
    ).options;
    expect(component).toBeUndefined();
    let thrown: unknown;
    try {
      beforeLoad({ params: { lang: "es-MX" } });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toEqual({
      redirect: { to: "/$lang/kbs", params: { lang: "es-MX" }, replace: true },
    });
  });
});
