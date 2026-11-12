import { createFileRoute, redirect } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { AuthScreen } from "@/components/auth/auth-screen";
import { useMobileKeyboard } from "@/hooks/use-mobile-keyboard";
import { MAIN_SCROLLER_ID } from "@/lib/main-scroller";
import { pageHead } from "@/lib/page-title";
import { decideProtectedRouteAccess } from "@/lib/route-session-access";
import { getRouteSession } from "@/server/auth-session";

/**
 * Better Auth `loginPage` for the MCP OAuth provider. It owns no credentials
 * UI: a signed-in visitor continues to the consent page, anyone else goes to
 * the ordinary sign-in page with the consent URL as its same-locale
 * `redirectTo`. Both hops carry the RAW query string (document navigation),
 * because router search parsing collapses repeated signed `ba_param` keys.
 * Nothing here grants authority; consent revalidates the signed query.
 */
export const Route = createFileRoute("/$lang/mcp-login")({
  validateSearch: (search: Record<string, unknown>) => search,
  ssr: false,
  beforeLoad: async ({ params }) => {
    const consent = `/${params.lang}/mcp-consent${window.location.search}`;
    const decision = decideProtectedRouteAccess(await getRouteSession());
    if (decision.kind === "error") throw new Error("Route session unavailable");
    if (decision.kind === "allow") throw redirect({ href: consent, reloadDocument: true });
    throw redirect({
      href: `/${params.lang}/login?redirectTo=${encodeURIComponent(consent)}`,
      reloadDocument: true,
    });
  },
  head: ({ match }) => pageHead(match.context.i18n.t("nav:titles.signIn")),
  component: McpLoginRedirect,
});

function McpLoginRedirect() {
  useMobileKeyboard();
  const { t } = useTranslation("consent");
  // A bare route (outside the app shell), so it supplies its own landmark.
  return (
    <main
      data-scroll-restoration-id={MAIN_SCROLLER_ID}
      className="relative h-svh min-w-0 overflow-y-auto overflow-x-clip overscroll-contain pt-[var(--safe-area-top)] pr-[var(--safe-area-right)] pb-[var(--safe-area-bottom)] pl-[var(--safe-area-left)] [scrollbar-gutter:stable]"
    >
      <AuthScreen>
        <p role="status" className="text-sm text-muted-foreground">
          {t("mcp.signingIn")}
        </p>
      </AuthScreen>
    </main>
  );
}
