import { env } from "@knowledge-base/env/web";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { PageShell } from "@/components/page-shell";
import { publicHomeHead } from "@/lib/public-home-head";

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
  return (
    <PageShell width="narrow" className="py-16 text-center">
      <h1 className="font-heading text-4xl font-semibold tracking-tight">{env.VITE_APP_NAME}</h1>
      <p className="mx-auto mt-4 max-w-md text-balance text-muted-foreground">
        {t("home.description")}
      </p>
    </PageShell>
  );
}
