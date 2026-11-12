/**
 * Browser-suite harness for KB settings: mounts the production settings
 * panels, which call the fixture's REAL oRPC routers through `/rpc` with the
 * app's own `orpc` client. The query client is exposed so the spec can prove
 * secrets never reach a cache.
 */
import enAdmin from "@knowledge-base/locales/src/en-US/admin.json";
import enCommon from "@knowledge-base/locales/src/en-US/common.json";
import enKb from "@knowledge-base/locales/src/en-US/kb.json";
import enSettings from "@knowledge-base/locales/src/en-US/settings.json";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { createInstance } from "i18next";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { KbManageActions } from "@/components/kb/kb-list";
import { KB_SETTINGS_TABS, KbSettingsView } from "@/components/kb/members-panel";
import { ModelAdminPanel } from "@/components/kb/model-admin-panel";
import { ProvidersPanel } from "@/components/kb/profile-panel";
import { orpc } from "@/utils/orpc";

const i18n = createInstance();
await i18n.init({
  lng: "en-US",
  fallbackLng: "en-US",
  ns: ["kb", "settings", "common", "admin"],
  defaultNS: "kb",
  resources: { "en-US": { admin: enAdmin, kb: enKb, settings: enSettings, common: enCommon } },
  interpolation: { escapeValue: false },
});

const queryClient = new QueryClient();

/** The KB header's manage actions (edit / owner-only delete), fed by the real `kbs.get`. */
function KbHeaderActions({ kbId }: { kbId: string }) {
  const { data } = useQuery(orpc.kbs.get.queryOptions({ input: { kbId }, retry: false }));
  if (!data) return null;
  return (
    <div data-testid="kb-header-actions">
      <KbManageActions kb={data.kb} onEdit={() => {}} onDelete={() => {}} />
    </div>
  );
}
(window as unknown as { __kbQueryClient: QueryClient }).__kbQueryClient = queryClient;

// Use the production router's default retention across search changes so
// warm SPA transitions exercise the panels' identity boundaries.
const root = createRootRoute();
const settings = createRoute({
  getParentRoute: () => root,
  path: "/kb-settings",
  validateSearch: (search: Record<string, unknown>) => ({
    view: typeof search.view === "string" ? search.view : "kb",
    kbId: typeof search.kbId === "string" ? search.kbId : "",
    accept: typeof search.accept === "string" ? search.accept : undefined,
    transfer: typeof search.transfer === "string" ? search.transfer : undefined,
    tab: KB_SETTINGS_TABS.find((tab) => tab === search.tab),
  }),
  component: SettingsHarness,
});
const router = createRouter({ routeTree: root.addChildren([settings]) });
(
  window as unknown as {
    __kbNavigate: (search: {
      view?: string;
      kbId?: string;
      accept?: string;
      transfer?: string;
      tab?: string;
    }) => Promise<void>;
  }
).__kbNavigate = (search) =>
  router.navigate({
    // Moving to another KB keeps the open settings tab unless the spec names one.
    href: `/kb-settings?${new URLSearchParams({ view: "kb", kbId: "", ...currentTab(), ...search })}`,
  });

function currentTab(): { tab?: string } {
  const tab = new URLSearchParams(window.location.search).get("tab");
  return tab ? { tab } : {};
}

function SettingsHarness() {
  const { view, kbId, accept, transfer, tab } = settings.useSearch();
  return (
    <main>
      {view === "model" ? (
        <ModelAdminPanel />
      ) : view === "providers" ? (
        <ProvidersPanel />
      ) : (
        <>
          <KbHeaderActions kbId={kbId} />
          <KbSettingsView
            lang="en-US"
            kbId={kbId}
            accept={accept}
            transfer={transfer}
            tab={tab}
            onTabChange={(next) => {
              const search: Record<string, string | undefined> = {
                view,
                kbId,
                accept,
                transfer,
                tab: next,
              };
              const entries = Object.entries(search).filter(
                (entry): entry is [string, string] => typeof entry[1] === "string",
              );
              void router.navigate({
                href: `/kb-settings?${new URLSearchParams(entries)}`,
                replace: true,
              });
            }}
          />
        </>
      )}
    </main>
  );
}

createRoot(window.document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <I18nextProvider i18n={i18n}>
      <RouterProvider router={router} />
    </I18nextProvider>
  </QueryClientProvider>,
);
