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
  /** The public header's session-cookie hint (lib/session-hint.ts). */
  hint: undefined as boolean | undefined,
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
    "aria-label": ariaLabel,
  }: {
    to: string;
    className?: string;
    title?: string;
    children: ReactNode;
    "aria-label"?: string;
  }) => (
    <a data-to={to} className={className ?? ""} title={title} aria-label={ariaLabel}>
      {children}
    </a>
  ),
}));
vi.mock("@tanstack/react-query", () => ({
  queryOptions: (options: unknown) => options,
  useQuery: () => ({ data: fixture.hint }),
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
  fixture.hint = undefined;
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

// The brand link: the same in both header rows (the landing page, or the
// signed-in home in the app header for a signed-in user).
const BRAND_LINK =
  /<a data-to="(\/\$lang(?:\/kbs)?)" class="([^"]*)" title="([^"]*)"[^>]*>(.*?)<\/a>/;

function expectBrandGivesWayFirst(html: string, to = "/$lang") {
  const [, target, classes = "", title = "", inner = ""] = html.match(BRAND_LINK) ?? [];
  expect(target).toBe(to);
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
  expectLogoFirst(inner);
}

/**
 * The logo slot (lib/app-logo.ts): the link's first child, its 32px box
 * declared, 32w/64w/128w sources for a 48px-at-most slot, and the app name as
 * its `alt` — the link's only accessible name (the visible names are
 * `aria-hidden` and the link has no `aria-label`), so it is announced once.
 */
function expectLogoFirst(inner: string) {
  const img = inner.match(/^<img ([^>]*)\/?>/)?.[1] ?? "";
  expect(img).toContain('src="/pwa-32x32.png"');
  expect(img).toContain('srcSet="/pwa-32x32.png 32w, /pwa-64x64.png 64w, /pwa-128x128.png 128w"');
  expect(img).toContain('sizes="48px"');
  expect(img).toContain('width="32"');
  expect(img).toContain('height="32"');
  expect(img).toContain('alt="Northwind Regional Logistics"');
  expect(img).toMatch(/class="size-8 shrink-0"/);
  expect(inner.replace(/^<img [^>]*>/, "")).not.toMatch(/<img|alt=/);
}

describe("header row", () => {
  it.each(["anonymous", "pending", "error"] as const)(
    "the brand gives way first at every width while %s, and links to the landing page",
    (session) => {
      fixture.session = session;
      expectBrandGivesWayFirst(renderNode(<Header />));
    },
  );

  it("signed in, the brand goes to the signed-in home (the knowledge bases list)", () => {
    fixture.session = "authenticated";
    expectBrandGivesWayFirst(renderNode(<Header />), "/$lang/kbs");
  });

  it("names the brand link once: no aria-label over the logo's alt", () => {
    const html = renderNode(<Header />);
    const link = html.match(BRAND_LINK)?.[0] ?? "";
    expect(link).not.toContain("aria-label=");
    expect(link.match(/alt="/g)).toHaveLength(1);
  });

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

  it("signed out: Sign In with the app header's touch metrics, an icon below sm", async () => {
    const html = await renderPublic();
    const match = html.match(/<a data-to="\/\$lang\/login" class="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
    expect(match?.[0]).toContain(`aria-label="${enNav.userMenu.signIn}"`);
    const classes = match?.[1]?.split(" ") ?? [];
    expect(classes).toEqual(
      expect.arrayContaining(["h-11", "text-xs", "shrink-0", "w-11", "px-0", "sm:w-auto"]),
    );
    expect(classes).toContain("sm:px-3.5");
    expect(classes).not.toContain("text-sm");
    expect(html).not.toContain('data-to="/$lang/kbs"');
  });

  it("with a session cookie: Open app to the signed-in home instead of Sign In", async () => {
    fixture.hint = true;
    const html = await renderPublic();
    expect(html).not.toContain('data-to="/$lang/login"');
    const match = html.match(/<a data-to="\/\$lang\/kbs" class="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
    expect(match?.[0]).toContain(`aria-label="${enNav.userMenu.openApp}"`);
    // The brand in the public header still goes to the landing page, which
    // forwards a signed-in visitor home.
    expectBrandGivesWayFirst(html);
  });

  it("reserves the wider label, so the swap moves nothing", async () => {
    const labels = (html: string) => {
      const inner =
        html.match(/<a data-to="\/\$lang\/(?:login|kbs)"[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? "";
      const reserved = inner.match(/<span aria-hidden="true" class="invisible[^"]*">([^<]*)</)?.[1];
      const shown = inner.match(/<span class="col-start-1 row-start-1">([^<]*)</)?.[1];
      return { reserved, shown };
    };
    const signIn = labels(await renderPublic());
    fixture.hint = true;
    const openApp = labels(await renderPublic());
    expect(signIn).toEqual({ shown: enNav.userMenu.signIn, reserved: enNav.userMenu.openApp });
    expect(openApp).toEqual({ shown: enNav.userMenu.openApp, reserved: enNav.userMenu.signIn });
  });
});
