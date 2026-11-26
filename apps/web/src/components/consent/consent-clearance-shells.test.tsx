import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * While the cookie banner shows, every shell ends `<main>` (or its scroll
 * content) where the banner starts: it pads its bottom by
 * `--consent-clearance` (index.css, from the `--consent-inset` the banner
 * publishes). Rendered, so a comment or a stray string cannot stand in for the
 * real class; the geometry itself is checked in a browser.
 */
const keyboard = vi.hoisted(() => ({ open: false }));

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
  ConsentPreferencesButton: () => null,
}));
vi.mock("@/hooks/use-document-lang", () => ({ useDocumentLang: () => {} }));
vi.mock("@/hooks/use-user-locale-sync", () => ({ useUserLocaleSync: () => {} }));
vi.mock("@/hooks/use-mobile-keyboard", () => ({ useMobileKeyboard: () => keyboard.open }));

const { Route: AppRoute } = await import("@/routes/$lang/_app/route");
const { Route: PublicRoute } = await import("@/routes/$lang/_public/route");

type SplitComponent = { importer: () => Promise<Record<string, unknown>>; name: string };

async function render(route: unknown): Promise<string> {
  const { component } = (route as { options: { component: SplitComponent } }).options;
  const Component = (await component.importer())[component.name] as () => ReactNode;
  return renderToStaticMarkup(<Component />);
}

/** The frame: the grid that holds header, main and nav. */
async function frame(route: unknown): Promise<{ classes: string[]; style: string }> {
  const match = (await render(route)).match(/<div class="(grid [^"]*)"(?: style="([^"]*)")?/);
  return { classes: (match?.[1] ?? "").split(" "), style: match?.[2] ?? "" };
}

beforeEach(() => {
  keyboard.open = false;
});

describe("the shells reserve the cookie banner's height", () => {
  it("public shell: by the banner's clearance at every width, never below the safe area", async () => {
    const { classes, style } = await frame(PublicRoute);
    expect(classes).toContain("grid");
    // Inline, because the frame's safe-area padding is inline too and an
    // inline padding-bottom would override a class.
    expect(style).toContain(
      "padding-bottom:max(var(--safe-area-bottom), var(--consent-clearance))",
    );
  });

  it("app shell, no keyboard: the larger of the BottomNav's and the banner's; from md: the banner's", async () => {
    const { classes } = await frame(AppRoute);
    expect(classes).toContain(
      "pb-[max(calc(3.5rem_+_var(--safe-area-bottom)),var(--consent-clearance))]",
    );
    expect(classes).toContain("md:pb-(--consent-clearance)");
    expect(classes).not.toContain("md:pb-0");
  });

  it("app shell, software keyboard up: the banner's alone", async () => {
    keyboard.open = true;
    const { classes } = await frame(AppRoute);
    expect(classes).toContain("pb-(--consent-clearance)");
    expect(classes.filter((c) => c.includes("3.5rem"))).toEqual([]);
  });

  // The standalone device/OAuth pages are their own shells: <main> is the
  // scroller, so its bottom padding is the end of the scroll content.
  it.each(["device", "mcp-consent", "mcp-login"])(
    "standalone %s page: by the same clearance",
    (page) => {
      const source = readFileSync(
        resolve(import.meta.dirname, "../../routes/$lang", `${page}.tsx`),
        "utf8",
      );
      expect(source).toContain("pb-[max(var(--safe-area-bottom),var(--consent-clearance))]");
      expect(source).not.toContain("pb-[var(--safe-area-bottom)]");
    },
  );
});
