import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * The offline band sits in each shell's top row, before the one `<main>`
 * scroller, so it takes its own height and covers nothing (docs/ui.md
 * § Offline). Rendered, so a comment cannot stand in for the real markup.
 */
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    options,
    useParams: () => ({ lang: "en-US" }),
  }),
  // Vitest runs the router plugin, which splits route components out into
  // `lazyRouteComponent(importer, name)`; keep the importer so the test can
  // load the real component.
  lazyRouteComponent: (importer: () => Promise<Record<string, unknown>>, name = "default") => ({
    importer,
    name,
  }),
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
  Outlet: () => null,
  // The public shell's header reads the locale itself.
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
vi.mock("@/hooks/use-document-lang", () => ({ useDocumentLang: () => {} }));
vi.mock("@/hooks/use-user-locale-sync", () => ({ useUserLocaleSync: () => {} }));
vi.mock("@/hooks/use-reload-on-identity-change", () => ({
  useReloadOnIdentityChange: () => {},
}));
vi.mock("@/hooks/use-mobile-keyboard", () => ({ useMobileKeyboard: () => false }));

const { Route: AppRoute } = await import("@/routes/$lang/_app/route");
const { Route: PublicRoute } = await import("@/routes/$lang/_public/route");

type SplitComponent = { importer: () => Promise<Record<string, unknown>>; name: string };

async function render(route: unknown): Promise<string> {
  const { component } = (route as { options: { component: SplitComponent } }).options;
  const Component = (await component.importer())[component.name] as () => ReactNode;
  // The public header reads the session hint from the query cache.
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <Component />
    </QueryClientProvider>,
  );
}

describe("the offline band", () => {
  it.each([
    ["public", PublicRoute],
    ["app", AppRoute],
  ])("the %s shell puts it in its top row, outside the scroller", async (_name, route) => {
    const html = await render(route);
    const band = html.search(/<div role="status"[^>]*data-offline-band=""/);
    expect(band, html).toBeGreaterThan(-1);
    expect(band).toBeLessThan(html.indexOf("<main"));
    expect(html.match(/data-offline-band=/g)).toHaveLength(1);
  });
});
