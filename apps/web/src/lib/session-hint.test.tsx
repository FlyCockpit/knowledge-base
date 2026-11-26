import enNav from "@knowledge-base/locales/src/en-US/nav.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The public pages' session-cookie hint as one shared query: seeded by the
 * `_public` layout during SSR, read by the landing redirect and the public
 * header. Uses the real React Query, so "seeded" means what SSR does: the
 * data is in the request's QueryClient before the header renders.
 */
const hint = vi.hoisted(() => ({ getSessionCookieHint: vi.fn(async () => false) }));
vi.mock("@/server/auth-session", () => hint);
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({ options }),
  // The router plugin splits route components out in Vitest too.
  lazyRouteComponent: (importer: () => Promise<Record<string, unknown>>, name = "default") => ({
    importer,
    name,
  }),
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a data-to={to}>{children}</a>,
  Outlet: () => null,
  useParams: () => ({ lang: "en-US" }),
}));
vi.mock("@knowledge-base/env/web", () => ({ env: { VITE_APP_NAME: "Northwind" } }));
vi.mock("@/components/language-switcher", () => ({ LanguageSwitcher: () => null }));
vi.mock("@/components/mode-toggle", () => ({ ModeToggle: () => null }));
vi.mock("@/components/public-footer", () => ({ PublicFooter: () => <footer /> }));
vi.mock("@/hooks/use-mobile-keyboard", () => ({ useMobileKeyboard: () => false }));

const { ensureSessionHint, sessionHintQueryOptions, setSessionHint, SESSION_HINT_QUERY_KEY } =
  await import("./session-hint");
const { PublicShell } = await import("@/components/public-shell");
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
  hint.getSessionCookieHint.mockReset();
  hint.getSessionCookieHint.mockResolvedValue(false);
});

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

function renderHeader(queryClient: QueryClient) {
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <PublicShell>
          <p>page</p>
        </PublicShell>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

/** The header action's target and its visible (not reserved) label. */
function headerAction(html: string) {
  const match = html.match(/<a data-to="(\/\$lang\/(?:login|kbs))">([\s\S]*?)<\/a>/);
  const visible = (match?.[2] ?? "")
    .replace(/<span aria-hidden="true"[^>]*>[^<]*<\/span>/g, "")
    .replace(/<[^>]*>/g, "");
  return { to: match?.[1], visible };
}

describe("session hint query", () => {
  it("asks the server once, then reads the cache (layout seed + landing redirect)", async () => {
    hint.getSessionCookieHint.mockResolvedValue(true);
    const queryClient = newClient();
    expect(await ensureSessionHint(queryClient)).toBe(true);
    expect(await ensureSessionHint(queryClient)).toBe(true);
    expect(hint.getSessionCookieHint).toHaveBeenCalledTimes(1);
    expect(sessionHintQueryOptions().queryKey).toEqual(SESSION_HINT_QUERY_KEY);
  });

  it("never decides on a stale answer: it waits for a fresh one", async () => {
    const queryClient = newClient();
    // Signed out a while ago (older than the staleTime) ...
    queryClient.setQueryData(SESSION_HINT_QUERY_KEY, false, { updatedAt: Date.now() - 120_000 });
    // ... and signed in since, in another tab.
    hint.getSessionCookieHint.mockResolvedValue(true);
    expect(await ensureSessionHint(queryClient)).toBe(true);
    expect(hint.getSessionCookieHint).toHaveBeenCalledTimes(1);
  });

  it("does not pause while the browser reports offline (it fails fast to signed out)", async () => {
    const { onlineManager } = await import("@tanstack/react-query");
    onlineManager.setOnline(false);
    try {
      expect(sessionHintQueryOptions().networkMode).toBe("always");
      hint.getSessionCookieHint.mockRejectedValue(new TypeError("Failed to fetch"));
      await expect(ensureSessionHint(newClient())).resolves.toBe(false);
    } finally {
      onlineManager.setOnline(true);
    }
  });

  it("reads a failed hint as signed out instead of throwing", async () => {
    hint.getSessionCookieHint.mockRejectedValue(new Error("offline"));
    await expect(ensureSessionHint(newClient())).resolves.toBe(false);
  });

  it("follows what the app's session gate learned", async () => {
    const queryClient = newClient();
    setSessionHint(queryClient, true);
    expect(await ensureSessionHint(queryClient)).toBe(true);
    expect(hint.getSessionCookieHint).not.toHaveBeenCalled();
  });

  it("is seeded by the _public layout's beforeLoad", async () => {
    hint.getSessionCookieHint.mockResolvedValue(true);
    const queryClient = newClient();
    const { beforeLoad } = (
      PublicRoute as unknown as {
        options: { beforeLoad: (ctx: { context: { queryClient: QueryClient } }) => Promise<void> };
      }
    ).options;
    await beforeLoad({ context: { queryClient } });
    expect(queryClient.getQueryData(SESSION_HINT_QUERY_KEY)).toBe(true);
  });
});

describe("public header, rendered on the server", () => {
  it("with a seeded 'signed in' hint: Open app to the signed-in home", () => {
    const queryClient = newClient();
    setSessionHint(queryClient, true);
    expect(headerAction(renderHeader(queryClient))).toEqual({
      to: "/$lang/kbs",
      visible: enNav.userMenu.openApp,
    });
  });

  it("with a seeded 'signed out' hint: Sign In", () => {
    const queryClient = newClient();
    setSessionHint(queryClient, false);
    expect(headerAction(renderHeader(queryClient))).toEqual({
      to: "/$lang/login",
      visible: enNav.userMenu.signIn,
    });
  });

  // The 404 has no `_public` route to seed it: the server renders the
  // anonymous header (identical for everyone) and the client asks afterwards.
  it("without a seed (the 404): Sign In, and no server call during the render", () => {
    expect(headerAction(renderHeader(newClient()))).toEqual({
      to: "/$lang/login",
      visible: enNav.userMenu.signIn,
    });
    expect(hint.getSessionCookieHint).not.toHaveBeenCalled();
  });
});
