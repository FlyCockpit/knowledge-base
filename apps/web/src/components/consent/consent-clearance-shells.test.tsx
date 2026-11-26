import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * While a cookie banner shows (only in an app with analytics), every page
 * scroller's content ends where the banner starts: `<main>` pads its bottom by
 * `--consent-clearance` (index.css, from the `--consent-inset` the banner
 * publishes), minus what its frame already reserves. Rendered, so a comment or
 * a stray string cannot stand in for the real class; the geometry itself is
 * checked in a browser (`pnpm check:layout`'s banner-reserve probe).
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
// The public header reads the session-cookie hint (lib/session-hint.ts).
vi.mock("@tanstack/react-query", () => ({
  queryOptions: (options: unknown) => options,
  useQuery: () => ({ data: undefined }),
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

/** The frame (the grid that holds header, main and nav) and the scroller, `<main>`. */
async function shell(
  route: unknown,
): Promise<{ classes: string[]; style: string; main: string[] }> {
  const html = await render(route);
  const match = html.match(/<div class="(grid [^"]*)"(?: style="([^"]*)")?/);
  const main = html.match(/<main\b[^>]*\bclass="([^"]*)"/)?.[1] ?? "";
  return { classes: (match?.[1] ?? "").split(" "), style: match?.[2] ?? "", main: main.split(" ") };
}

beforeEach(() => {
  keyboard.open = false;
});

// While a cookie banner shows (only in an app with analytics), the frames are
// never padded for it, so the header and the sidebar always reach the bottom
// of the viewport (the owner saw the signed-in home's sidebar end ~150px short).
// <main> pads the part of the banner's clearance its frame does not reserve.
describe("the shell frames span the viewport; only <main> reserves the banner", () => {
  it("public shell: the frame pads the safe area only; <main> the rest of the banner", async () => {
    const { classes, style, main } = await shell(PublicRoute);
    expect(classes).toContain("grid");
    expect(style).toContain("padding-bottom:var(--safe-area-bottom)");
    expect(style).not.toContain("consent");
    expect(main).toContain(
      "pb-[max(0px,calc(var(--consent-clearance)_-_var(--safe-area-bottom)))]",
    );
  });

  it("app shell, no keyboard: the frame reserves the BottomNav only; <main> the rest of the banner", async () => {
    const { classes, main } = await shell(AppRoute);
    expect(classes).toContain("pb-[calc(3.5rem_+_var(--safe-area-bottom))]");
    expect(classes).toContain("md:pb-0");
    expect(classes.filter((c) => c.includes("consent"))).toEqual([]);
    expect(main).toContain(
      "pb-[max(0px,calc(var(--consent-clearance)_-_3.5rem_-_var(--safe-area-bottom)))]",
    );
    expect(main).toContain("md:pb-(--consent-clearance)");
  });

  it("app shell, software keyboard up: no frame padding; <main> the banner's whole clearance", async () => {
    keyboard.open = true;
    const { classes, main } = await shell(AppRoute);
    expect(classes.filter((c) => /^(md:)?pb-/.test(c))).toEqual([]);
    expect(main).toContain("pb-(--consent-clearance)");
    expect(main.filter((c) => c.includes("3.5rem"))).toEqual([]);
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
