import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * The shell rules, rendered, so a comment or a stray string cannot stand in
 * for the real markup. The geometry itself (footer bottom = scroller bottom,
 * full-bleed rules reach the viewport edge) is measured in a browser by
 * `pnpm check:layout`. Rules: docs/ui.md § Shell rules
 */
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({ options }),
  // Vitest runs the router plugin, which splits route components out into
  // `lazyRouteComponent(importer, name)`; keep the importer so the test can
  // load the real component.
  lazyRouteComponent: (importer: () => Promise<Record<string, unknown>>, name = "default") => ({
    importer,
    name,
  }),
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
  Outlet: () => <p>outlet</p>,
  redirect: () => undefined,
  useParams: () => ({ lang: "en-US" }),
}));
vi.mock("@tanstack/react-query-devtools", () => ({ ReactQueryDevtools: () => null }));
vi.mock("@tanstack/react-router-devtools", () => ({ TanStackRouterDevtools: () => null }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@knowledge-base/env/web", () => ({ env: { VITE_APP_NAME: "Northwind" } }));
vi.mock("@/components/admin-setup-banner", () => ({ AdminSetupBanner: () => null }));
vi.mock("@/components/app-sidebar", () => ({ AppSidebar: () => null }));
vi.mock("@/components/bottom-nav", () => ({ default: () => null }));
vi.mock("@/components/header", () => ({ default: () => null }));
vi.mock("@/components/language-switcher", () => ({ LanguageSwitcher: () => null }));
vi.mock("@/components/mode-toggle", () => ({ ModeToggle: () => null }));
vi.mock("@/components/consent/consent-preferences-button", () => ({
  ConsentPreferencesButton: () => <button type="button">preferences</button>,
}));
vi.mock("@/hooks/use-document-lang", () => ({ useDocumentLang: () => {} }));
vi.mock("@/hooks/use-user-locale-sync", () => ({ useUserLocaleSync: () => {} }));
vi.mock("@/hooks/use-mobile-keyboard", () => ({ useMobileKeyboard: () => false }));
vi.mock("@/i18n", () => ({ loadLocaleInto: async () => {} }));

const { PublicNotFoundPage, PublicShell } = await import("@/components/public-shell");
const { Route: AppRoute } = await import("@/routes/$lang/_app/route");
const { Route: PublicRoute } = await import("@/routes/$lang/_public/route");
const { Route: LangRoute } = await import("@/routes/$lang");

type SplitComponent = { importer: () => Promise<Record<string, unknown>>; name: string };

/** A route option the router plugin split out (`component`, `notFoundComponent`), loaded. */
async function load(route: unknown, option: string): Promise<unknown> {
  const split = (route as { options: Record<string, SplitComponent> }).options[option];
  if (!split) throw new Error(`the route has no ${option}`);
  return (await split.importer())[split.name];
}

async function render(route: unknown): Promise<string> {
  const Component = (await load(route, "component")) as () => ReactNode;
  return renderToStaticMarkup(<Component />);
}

function mainTag(html: string): string {
  const tags = html.match(/<main\b[^>]*>/g) ?? [];
  expect(tags, "exactly one <main> per shell").toHaveLength(1);
  return tags[0] ?? "";
}

// The scroller holds one column, at least as tall as the scroller: the page
// (growing) and then the footer, last.
const COLUMN =
  /<main\b[^>]*><div class="flex min-h-full min-w-0 flex-col"><div class="flex min-w-0 flex-1 flex-col">([\s\S]*)<\/div><footer\b[^>]*>[\s\S]*?<\/footer><\/div><\/main>/;

describe("public shell", () => {
  it("puts the footer after the page in a min-h-full column inside the one scroller", () => {
    const html = renderToStaticMarkup(
      <PublicShell>
        <p>page</p>
      </PublicShell>,
    );
    const match = html.match(COLUMN);
    expect(match, html).not.toBeNull();
    expect(match?.[1]).toBe("<p>page</p>");
    expect(html.match(/<footer\b/g)).toHaveLength(1);
    // check:layout finds the shell's footer by this marker, not by the first <footer> in <main>.
    expect(html).toMatch(/<footer\b[^>]*\bdata-public-footer=/);
    expect(html).toContain("<header");
  });

  it("the _public layout renders its routes through the shell", async () => {
    expect((await render(PublicRoute)).match(COLUMN)?.[1]).toBe("<p>outlet</p>");
  });

  it("the 404 for an unknown URL renders inside the public shell", async () => {
    expect(await load(LangRoute, "notFoundComponent")).toBe(PublicNotFoundPage);
    const html = renderToStaticMarkup(<PublicNotFoundPage />);
    expect(html).toContain("<header");
    expect(html.match(COLUMN)?.[1]).toContain("pageNotFound.title");
  });

  it("the public footer carries Cookie preferences, so every public page offers it", async () => {
    const footer = (await render(PublicRoute)).match(/<footer\b[^>]*>([\s\S]*?)<\/footer>/)?.[1];
    expect(footer).toContain("preferences");
  });
});

describe("full-bleed rules inside the scroller", () => {
  it.each([
    ["public", PublicRoute],
    ["app", AppRoute],
  ])("the %s shell's scroller reserves no scrollbar gutter", async (_name, route) => {
    const tag = mainTag(await render(route));
    expect(tag).toContain("overflow-y-auto");
    expect(tag).not.toContain("scrollbar-gutter");
  });

  it("the app shell has no footer (BottomNav on phones, Cookie preferences in Settings)", async () => {
    expect(await render(AppRoute)).not.toContain("<footer");
  });
});
