import enNav from "@knowledge-base/locales/src/en-US/nav.json";
import { createInstance } from "i18next";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The header's account control in the ws-model-proxy shape: signed out, Sign
 * up (open sign-up or the first-admin bootstrap) and Sign in, 44px icons below
 * `sm:`; signed in, a 44px User icon below `md:` and the name from `md:`.
 * Static markup, so the breakpoints are pinned through the classes.
 */
const fixture = vi.hoisted(() => ({
  status: "anonymous" as "anonymous" | "authenticated" | "pending" | "error",
  config: undefined as Record<string, unknown> | undefined,
}));

vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ lang: "en-US" }),
  Link: ({
    to,
    className,
    children,
    "aria-label": label,
  }: {
    to: string;
    className?: string;
    children: ReactNode;
    "aria-label"?: string;
  }) => (
    <a data-to={to} className={className ?? ""} aria-label={label}>
      {children}
    </a>
  ),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: fixture.config, isPending: fixture.config === undefined }),
}));
vi.mock("@/utils/orpc", () => ({ orpc: { appConfig: { queryOptions: () => ({}) } } }));
vi.mock("@/hooks/use-auth-session", () => ({
  useAuthSession: () => ({
    state:
      fixture.status === "authenticated"
        ? {
            status: "authenticated",
            session: { user: { id: "u1", name: "Ada Lovelace", email: "ada@example.com" } },
          }
        : { status: fixture.status },
  }),
}));

const { default: UserMenu } = await import("./user-menu");

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: "en-US",
    resources: { "en-US": { nav: enNav } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
});
beforeEach(() => {
  fixture.status = "anonymous";
  fixture.config = undefined;
});

const render = () =>
  renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <UserMenu />
    </I18nextProvider>,
  );

const link = (html: string, to: string) =>
  html.match(new RegExp(`<a data-to="${to.replace("$", "\\$")}"[^>]*>[\\s\\S]*?</a>`))?.[0];

describe("account control, signed out", () => {
  it("Sign in is a 44px icon below sm: and its text from sm:, named either way", () => {
    fixture.config = { signupEnabled: false, adminBootstrapSignupEnabled: false };
    const signIn = link(render(), "/$lang/login") ?? "";
    expect(signIn).toContain(`aria-label="${enNav.userMenu.signIn}"`);
    expect(signIn).toMatch(/class="[^"]*\bw-11 px-0 sm:w-auto sm:px-3\.5\b/);
    expect(signIn).toMatch(/<svg[^>]*class="[^"]*sm:hidden/);
    expect(signIn).toContain(`<span class="hidden sm:inline">${enNav.userMenu.signIn}</span>`);
  });

  it("offers Sign up while sign-up is open, and while the first admin can still sign up", () => {
    for (const config of [
      { signupEnabled: true, adminBootstrapSignupEnabled: false },
      { signupEnabled: false, adminBootstrapSignupEnabled: true },
    ]) {
      fixture.config = config;
      const signUp = link(render(), "/$lang/signup") ?? "";
      expect(signUp).toContain(`aria-label="${enNav.userMenu.signUp}"`);
      expect(signUp).toMatch(/class="[^"]*\bw-11 px-0 sm:w-auto/);
    }
  });

  it("no Sign up under forced SSO, even while sign-up is open or the first admin can sign up", () => {
    for (const config of [
      { forceSso: true, signupEnabled: true, adminBootstrapSignupEnabled: false },
      { forceSso: true, signupEnabled: false, adminBootstrapSignupEnabled: true },
    ]) {
      fixture.config = config;
      const html = render();
      expect(link(html, "/$lang/signup")).toBeUndefined();
      expect(link(html, "/$lang/login")).toBeDefined();
    }
  });

  it("no Sign up once bootstrap is complete and sign-up is closed, nor before appConfig answers", () => {
    fixture.config = { signupEnabled: false, adminBootstrapSignupEnabled: false };
    expect(link(render(), "/$lang/signup")).toBeUndefined();
    fixture.config = undefined;
    expect(link(render(), "/$lang/signup")).toBeUndefined();
  });
});

describe("account control, signed in", () => {
  it("is a 44px User icon below md: and the name from md:, named by the name", () => {
    fixture.status = "authenticated";
    const html = render();
    expect(html).toContain('aria-label="Ada Lovelace, account menu"');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toMatch(/class="[^"]*\bw-11 px-0! md:w-auto md:min-w-11 md:max-w-48 md:shrink/);
    expect(html).toMatch(/<svg[^>]*class="[^"]*md:hidden/);
    expect(html).toContain('class="hidden truncate md:block">Ada Lovelace<');
  });

  it("is a skeleton while the session is first checked, or failing with no known identity", () => {
    for (const status of ["pending", "error"] as const) {
      fixture.status = status;
      const html = render();
      expect(html).toMatch(/data-slot="skeleton"/);
      expect(html).not.toContain("data-to=");
    }
  });
});
