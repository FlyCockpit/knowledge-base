import { env } from "@knowledge-base/env/web";
import { createFileRoute } from "@tanstack/react-router";

import { ApiKeyCreatePage } from "@/components/kb/api-key-create";
import { pageHead } from "@/lib/page-title";

/**
 * Create API key, a page of its own (outside the settings layout, so the
 * form gets the full width): deep-linkable, and Back returns to the list.
 */
export const Route = createFileRoute("/$lang/_app/_auth/settings_/api-keys/new")({
  staticData: { pendingShape: "form" },
  head: ({ match }) =>
    pageHead(
      match.context.i18n.t("settings:apiKeys.createTitle"),
      match.context.i18n.t("settings:navApiKeys"),
    ),
  component: NewApiKey,
});

function NewApiKey() {
  const { lang } = Route.useParams();
  return <ApiKeyCreatePage lang={lang} serverUrl={env.VITE_SERVER_URL} />;
}
