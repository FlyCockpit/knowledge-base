import { createFileRoute } from "@tanstack/react-router";

import {
  KB_SETTINGS_TABS,
  type KbSettingsTab,
  KbSettingsView,
} from "@/components/kb/members-panel";
import { cachedKbName, pageHead } from "@/lib/page-title";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const requestId = (value: unknown) =>
  typeof value === "string" && UUID.test(value) ? value : undefined;

type SettingsSearch = { accept?: string; transfer?: string; tab?: KbSettingsTab };

export const Route = createFileRoute("/$lang/_app/_auth/kbs/$kbId/settings")({
  validateSearch: (search: Record<string, unknown>): SettingsSearch => ({
    accept: requestId(search.accept),
    transfer: requestId(search.transfer),
    tab: KB_SETTINGS_TABS.find((tab) => tab === search.tab),
  }),
  head: ({ match, params }) =>
    pageHead(
      match.context.i18n.t("kb:detail.settings"),
      cachedKbName(match.context.queryClient, params.kbId),
    ),
  // `accept` / `transfer` carry a recipient's pending request id from the link
  // the inviter or owner shared; the server decides whether it is theirs.
  // `tab` only picks a settings tab; the live bits decide which ones exist.
  component: KbSettingsRoute,
});

function KbSettingsRoute() {
  const { lang, kbId } = Route.useParams();
  const { accept, transfer, tab } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <KbSettingsView
      key={kbId}
      lang={lang}
      kbId={kbId}
      accept={accept}
      transfer={transfer}
      tab={tab}
      onTabChange={(next) =>
        navigate({ search: (prev) => ({ ...prev, tab: next }), replace: true, resetScroll: false })
      }
    />
  );
}
