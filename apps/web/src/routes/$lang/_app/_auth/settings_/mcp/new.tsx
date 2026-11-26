import { env } from "@knowledge-base/env/web";
import { createFileRoute } from "@tanstack/react-router";

import { PatCreatePage } from "@/components/kb/pat-create";
import { pageHead } from "@/lib/page-title";

/**
 * Create a personal access token, a page of its own (outside the settings
 * layout, so the form gets the full width): deep-linkable, and Back returns
 * to MCP access.
 */
export const Route = createFileRoute("/$lang/_app/_auth/settings_/mcp/new")({
  staticData: { pendingShape: "form" },
  head: ({ match }) =>
    pageHead(
      match.context.i18n.t("settings:credentials.createTitle"),
      match.context.i18n.t("settings:navMcp"),
    ),
  component: NewToken,
});

function NewToken() {
  const { lang } = Route.useParams();
  return <PatCreatePage lang={lang} serverUrl={env.VITE_SERVER_URL} />;
}
