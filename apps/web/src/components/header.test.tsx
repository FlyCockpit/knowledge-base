import enNav from "@knowledge-base/locales/src/en-US/nav.json";
import { createInstance } from "i18next";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The brand is the first thing in both header rows (the app shell's `Header`
 * and the public `PublicHeader`) to give way, at every width, so a long app
 * name cannot push the controls past the trailing line. Rendered to static
 * markup (no layout, no media queries), so the widths are pinned through the
 * classes; the real widths are checked in a browser.
 */
const fixture = vi.hoisted(() => ({
  session: "anonymous" as "anonymous" | "authenticated" | "pending" | "error",
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    options,
    useParams: () => ({ lang: "en-US" }),
  }),
  // The router plugin splits route components out in Vitest too; keep the
  // importer so the test can load the real component.
  lazyRouteComponent: (importer: () => Promise<Record<string, unknown>>, name = "default") => ({
    importer,
    name,
  }),
  Outlet: () => null,
  useParams: () => ({ lang: "en-US" }),
  Link: ({
    to,
    className,
    title,
    children,
  }: {
    to: string;
    className?: string;
    title?: string;
    children: ReactNode;
  }) => (
    <a data-to={to} className={className ?? ""} title={title}>
      {children}
    </a>
  ),
}));
vi.mock("@/hooks/use-auth-session", () => ({
  useAuthSession: () => ({ state: { status: fixture.session }, actions: { retry: vi.fn() } }),
}));
vi.mock("@knowledge-base/env/web", () => ({
  env: { VITE_APP_NAME: "Northwind Regional Logistics" },
}));
// The header row's other controls: fixed-size boxes that are not under test.
vi.mock("@/components/language-switcher", () => ({ LanguageSwitcher: () => <i data-control /> }));
vi.mock("@/components/mode-toggle", () => ({ ModeToggle: () => <i data-control /> }));
vi.mock("@/components/main-nav", () => ({ MainNav: () => null }));
vi.mock("@/components/user-menu", () => ({ default: () => <i data-control /> }));

const { default: Header } = await import("@/components/header");
const { Route: PublicRoute } = await import("@/routes/$lang/_public/route");

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
  fixture.session = "anonymous";
});

const classesOf = (html: string, pattern: RegExp) =>
  (html.match(pattern)?.[1] ?? "").split(" ").filter(Boolean);

function renderNode(node: ReactNode) {
  return renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);
}

type SplitComponent = { importer: () => Promise<Record<string, unknown>>; name: string };

async function renderPublic() {
  const { component } = (PublicRoute as unknown as { options: { component: SplitComponent } })
    .options;
  const Component = (await component.importer())[component.name] as () => ReactNode;
  return renderNode(<Component />);
}

// The brand link: the same in both header rows.
const BRAND_LINK = /<a data-to="\/\$lang" class="([^"]*)" title="([^"]*)"[^>]*>(.*?)<\/a>/;

function expectBrandGivesWayFirst(html: string) {
  const [, classes = "", title = "", inner = ""] = html.match(BRAND_LINK) ?? [];
  const brand = classes.split(" ");
  // First to give way at every width: a zero basis, so it only grows into what
  // the controls leave (up to its own width), never below a 44px target. No
  // shrink factor (any factor leaks a fraction of a pixel to the controls) and
  // no breakpoint variant of these.
  expect(brand).toEqual(
    expect.arrayContaining(["basis-0", "grow", "max-w-fit", "min-w-11", "inline-flex"]),
  );
  expect(brand.filter((c) => /shrink|:(basis|grow|max-w|min-w)/.test(c))).toEqual([]);
  // The ellipsis needs a block box: `truncate` on the inline-flex link only
  // clips. The caps sit on the spans, so a long name leaves the MainNav room.
  expect(brand).not.toContain("truncate");
  const spans = [...inner.matchAll(/<span aria-hidden="true" class="([^"]*)">([^<]*)<\/span>/g)];
  expect(spans).toHaveLength(2);
  const [phone, wide] = spans;
  // Phones: the short name (a renamed deployment's short name is its name).
  expect(phone?.[1]?.split(" ").sort()).toEqual(["max-w-40", "sm:hidden", "truncate"].sort());
  expect(wide?.[1]?.split(" ").sort()).toEqual(
    ["hidden", "lg:max-w-80", "max-w-56", "sm:block", "truncate"].sort(),
  );
  expect(wide?.[2]).toBe("Northwind Regional Logistics");
  expect(title).toBe("Northwind Regional Logistics");
}

describe("header row", () => {
  it.each(["anonymous", "pending", "error", "authenticated"] as const)(
    "the brand gives way first at every width while %s",
    (session) => {
      fixture.session = session;
      expectBrandGivesWayFirst(renderNode(<Header />));
    },
  );

  it.each(["anonymous", "pending", "error"] as const)(
    "never shrinks the controls while %s (nothing in them can)",
    (session) => {
      fixture.session = session;
      const controls = classesOf(renderNode(<Header />), /<div class="(ml-auto [^"]*)">/);
      expect(controls).toEqual(expect.arrayContaining(["min-w-0", "shrink-0"]));
      expect(controls.filter((c) => c.includes(":shrink"))).toEqual([]);
    },
  );

  it("signed in, the controls group may shrink at every width (the account trigger gives way)", () => {
    fixture.session = "authenticated";
    const controls = classesOf(renderNode(<Header />), /<div class="(ml-auto [^"]*)">/);
    expect(controls).toContain("min-w-0");
    expect(controls.filter((c) => c.includes("shrink"))).toEqual([]);
  });
});

describe("public header row", () => {
  it("renders the same brand link as the app header", async () => {
    expectBrandGivesWayFirst(await renderPublic());
  });

  it("hides its nav row below sm: and never shrinks its controls", async () => {
    const html = await renderPublic();
    const nav = classesOf(html, /<nav aria-label="[^"]*" class="([^"]*)"/);
    expect(nav).toEqual(expect.arrayContaining(["hidden", "sm:block", "min-w-0", "flex-1"]));
    expect(classesOf(html, /<div class="(ml-auto [^"]*)">/)).toContain("shrink-0");
  });

  it("uses the app header's row gap (8px on phones, 16px from sm:)", async () => {
    for (const html of [await renderPublic(), renderNode(<Header />)]) {
      const row = classesOf(html, /<div class="(flex min-w-0 flex-row [^"]*)">/);
      expect(row).toEqual(expect.arrayContaining(["gap-2", "sm:gap-4", "px-4"]));
      expect(row).not.toContain("gap-4");
    }
  });

  it("gives Sign In the app header's touch metrics", async () => {
    const html = await renderPublic();
    const match = html.match(/<a data-to="\/\$lang\/login" class="([^"]*)"[^>]*>([^<]*)<\/a>/);
    expect(match?.[2]).toBe(enNav.userMenu.signIn);
    const classes = match?.[1]?.split(" ") ?? [];
    expect(classes).toEqual(expect.arrayContaining(["h-11", "px-3.5", "text-xs", "shrink-0"]));
    expect(classes).not.toContain("text-sm");
  });
});
