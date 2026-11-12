import { createFileRoute } from "@tanstack/react-router";

import { ProvidersPanel } from "@/components/kb/profile-panel";
import { pageHead } from "@/lib/page-title";

export const Route = createFileRoute("/$lang/_app/_auth/settings/embedding-providers")({
  head: ({ match }) =>
    pageHead(
      match.context.i18n.t("settings:navProviders"),
      match.context.i18n.t("nav:items.settings"),
    ),
  component: ProvidersPanel,
});
