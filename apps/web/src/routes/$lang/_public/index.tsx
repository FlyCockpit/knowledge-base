import { env } from "@knowledge-base/env/web";
import { buttonVariants } from "@knowledge-base/ui/components/button";
import { cn } from "@knowledge-base/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { PageShell } from "@/components/page-shell";
import { APP_HOME } from "@/lib/app-home";
import { publicHomeHead } from "@/lib/public-home-head";
import { ensureSessionHint } from "@/lib/session-hint";
import { signupMode } from "@/lib/signup-mode";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_public/")({
  // A signed-in visitor (including the installed PWA, which opens at `/`)
  // goes straight to the signed-in home instead of a page that offers "Sign
  // in". The check looks only at whether the session cookie exists, so
  // anonymous renders stay static and cacheable; the home route's `_auth`
  // gate does the real check. docs/ui.md § The signed-in home.
  beforeLoad: async ({ params, context }) => {
    // The `_public` layout's beforeLoad already put the hint in the query
    // cache, so this is a cache read, not a second server call. A failed hint
    // reads as signed out (lib/session-hint.ts): the landing page shows rather
    // than an error screen, and the home route's own guard is unaffected.
    const signedIn = await ensureSessionHint(context.queryClient);
    if (signedIn) {
      throw redirect({ to: APP_HOME, params: { lang: params.lang }, replace: true });
    }
  },
  // Translated canonical/hreflang/og metadata — public copy only.
  head: ({ match, params }) =>
    publicHomeHead({
      origin: match.context.canonicalOrigin,
      lang: params.lang,
      appName: env.VITE_APP_NAME,
      description: match.context.i18n.t("common:home.description"),
    }),
  component: HomePage,
});

// Static landing copy: the product name (VITE_APP_NAME, default
// "KnowledgeBase") and the `home.*` strings in
// packages/locales/src/<locale>/common.json.
function HomePage() {
  const { t } = useTranslation("common");
  const { lang } = Route.useParams();
  // The footer belongs to the public shell (components/public-footer.tsx),
  // not to this page.
  return (
    <PageShell width="narrow" className="py-16 text-center">
      <h1 className="font-heading text-4xl font-semibold tracking-tight">{env.VITE_APP_NAME}</h1>
      <p className="mx-auto mt-4 max-w-md text-balance text-muted-foreground">
        {t("home.description")}
      </p>
      <LandingActions lang={lang} />
    </PageShell>
  );
}

/**
 * The way in, following the server's sign-up mode (lib/signup-mode.ts,
 * docs/ui.md § Sign-up modes).
 *
 * - `open`: Create account (primary) + Sign in.
 * - `bootstrap`: no administrator exists yet (`appConfig` turns the flag off
 *   once one does), so the visitor is almost certainly the operator: "Set up
 *   this server" is the primary button and Sign in the secondary one (the
 *   template's layout, so every app reads the same).
 * - `closed`: Sign in (primary) + the invite-only line, so a visitor without
 *   an account knows to ask for an invitation.
 * - `sso`: Sign in alone.
 *
 * The mode comes from a client query, not the SSR render: `useQuery` does not
 * fetch on the server, so every anonymous render (and the cached HTML) has the
 * neutral Sign in, and the mode-specific buttons appear once `appConfig`
 * answers. The row keeps one button height in every state, so the swap does not
 * move the page.
 */
function LandingActions({ lang }: { lang: string }) {
  const { t } = useTranslation("common");
  const { data: config } = useQuery(orpc.appConfig.queryOptions());
  const mode = config ? signupMode(config) : null;

  const signIn = (primary: boolean) => (
    <Link
      to="/$lang/login"
      params={{ lang }}
      search={{ redirectTo: undefined }}
      className={cn(buttonVariants({ variant: primary ? "default" : "outline" }), "min-h-11")}
    >
      {t("home.signIn")}
    </Link>
  );
  const signUp = (label: string) => (
    <Link
      to="/$lang/signup"
      params={{ lang }}
      search={{ redirectTo: undefined }}
      className={cn(buttonVariants({ variant: "default" }), "min-h-11 whitespace-normal")}
    >
      {label}
    </Link>
  );

  return (
    <div className="mt-8 space-y-3">
      <div className="flex flex-wrap items-center justify-center gap-3">
        {mode === "open" && signUp(t("home.createAccount"))}
        {mode === "bootstrap" && signUp(t("home.setUp"))}
        {signIn(mode !== "open" && mode !== "bootstrap")}
      </div>
      {mode === "closed" && <p className="text-sm text-muted-foreground">{t("home.inviteOnly")}</p>}
    </div>
  );
}
