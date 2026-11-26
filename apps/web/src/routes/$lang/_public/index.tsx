import { env } from "@knowledge-base/env/web";
import { buttonVariants } from "@knowledge-base/ui/components/button";
import { cn } from "@knowledge-base/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { PageShell } from "@/components/page-shell";
import { publicHomeHead } from "@/lib/public-home-head";
import { signupMode } from "@/lib/signup-mode";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_public/")({
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
// "KnowledgeBase") and `home.description` in packages/locales/src/<locale>/common.json.
function HomePage() {
  const { t } = useTranslation("common");
  // The footer (with "Cookie preferences") belongs to the public shell
  // (components/public-footer.tsx), not to this page.
  const { lang } = Route.useParams();
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
 * The way in, following the server's sign-up mode (docs/ui.md § Sign-up
 * modes).
 *
 * Create account + Sign in while sign-up is open. While only the administrator
 * bootstrap is open (no admin yet), Sign in stays the main action, with the
 * invite-only line and a small "Setting up this server?" link: most visitors
 * of a new server are not its administrator (the template's layout, kept so
 * every app reads the same). Sign in with the invite-only line when sign-up is
 * closed; Sign in alone when it is SSO-only.
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
  const signUp = (label: string, variant: "default" | "link") => (
    <Link
      to="/$lang/signup"
      params={{ lang }}
      search={{ redirectTo: undefined }}
      className={cn(buttonVariants({ variant }), "min-h-11 whitespace-normal")}
    >
      {label}
    </Link>
  );

  return (
    <div className="mt-8 space-y-3">
      <div className="flex flex-wrap items-center justify-center gap-3">
        {mode === "open" && signUp(t("home.createAccount"), "default")}
        {signIn(mode !== "open")}
      </div>
      {(mode === "closed" || mode === "bootstrap") && (
        <p className="text-sm text-muted-foreground">{t("home.inviteOnly")}</p>
      )}
      {mode === "bootstrap" && signUp(t("home.setupHint"), "link")}
    </div>
  );
}
