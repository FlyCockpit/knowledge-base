/** Actual KB routes and production RPC client with the app's five-minute cache. */
import enCommon from "@knowledge-base/locales/src/en-US/common.json";
import enKb from "@knowledge-base/locales/src/en-US/kb.json";
import { Toaster } from "@knowledge-base/ui/components/sileo";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { createInstance } from "i18next";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import z from "zod";
import { clearKbPrivateQueries, parseApplyResult, recheckKbAccess } from "@/hooks/use-kb-editor";
import { authClient } from "@/lib/auth-client";
import { Route as KbRoute } from "@/routes/$lang/_app/_auth/kbs/$kbId";
import { Route as DocumentRoute } from "@/routes/$lang/_app/_auth/kbs/$kbId/documents";
import { Route as PrDetailRoute } from "@/routes/$lang/_app/_auth/kbs/$kbId/prs/$number";
import { Route as PrListRoute } from "@/routes/$lang/_app/_auth/kbs/$kbId/prs/index";
import { Route as IndexRoute } from "@/routes/$lang/_app/_auth/kbs/index";
import { orpc } from "@/utils/orpc";

const kbAttachmentSchema = z.object({
  id: z.string(),
  name: z.string(),
  headSha: z.string(),
  metadataVersion: z.number(),
});
const documentSchema = z.object({ markdown: z.string(), commitSha: z.string() });

const params = new URLSearchParams(window.location.search);
window.history.replaceState(
  null,
  "",
  params.get("start") ??
    (window.location.pathname.startsWith("/en-US/kbs")
      ? window.location.pathname + window.location.search
      : "/en-US/kbs"),
);
const i18n = createInstance();
await i18n.init({
  lng: "en-US",
  fallbackLng: "en-US",
  ns: ["kb", "common"],
  defaultNS: "kb",
  resources: { "en-US": { kb: enKb, common: enCommon } },
  interpolation: { escapeValue: false },
});
const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5 * 60_000, retry: false } },
});
const root = createRootRoute({ component: Outlet });
const lang = createRoute({ getParentRoute: () => root, path: "$lang", component: Outlet });
const app = createRoute({ getParentRoute: () => lang, id: "_app", component: Outlet });
const auth = createRoute({ getParentRoute: () => app, id: "_auth", component: Outlet });
const index = IndexRoute.update({
  ...{ getParentRoute: () => auth, path: "kbs/" },
  component: IndexRoute.options.component,
});
const kb = KbRoute.update({
  ...{ getParentRoute: () => auth, path: "kbs/$kbId" },
  component: KbRoute.options.component,
});
const doc = DocumentRoute.update({
  ...{ getParentRoute: () => kb, path: "documents" },
  component: DocumentRoute.options.component,
});
const prList = PrListRoute.update({
  ...{ getParentRoute: () => kb, path: "prs/" },
  component: PrListRoute.options.component,
});
const prDetail = PrDetailRoute.update({
  ...{ getParentRoute: () => kb, path: "prs/$number" },
  component: PrDetailRoute.options.component,
});
const router = createRouter({
  routeTree: root.addChildren([
    lang.addChildren([
      app.addChildren([auth.addChildren([index, kb.addChildren([doc, prList, prDetail])])]),
    ]),
  ]),
  // The app's router context: the KB layout's loader primes `kbs.get` with it.
  context: { queryClient, orpc, i18n },
});

const harness = {
  queryClient,
  authClient,
  orpc,
  router,
  recheckKbAccess,
  clearKbPrivateQueries,
  documentSchema,
  kbAttachmentSchema,
  parseApplyResult,
};
declare global {
  interface Window {
    __r38: typeof harness;
  }
}
window.__r38 = harness;

createRoot(window.document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <I18nextProvider i18n={i18n}>
      <RouterProvider router={router} />
      <Toaster />
    </I18nextProvider>
  </QueryClientProvider>,
);
