import enCommon from "@knowledge-base/locales/src/en-US/common.json";
import enConsent from "@knowledge-base/locales/src/en-US/consent.json";
import enErrors from "@knowledge-base/locales/src/en-US/errors.json";
import enNav from "@knowledge-base/locales/src/en-US/nav.json";
import enSettings from "@knowledge-base/locales/src/en-US/settings.json";
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
import { MAIN_SCROLLER_ID } from "@/lib/main-scroller";
import { Route as apiKeysRoute } from "@/routes/$lang/_app/_auth/settings/api-keys";
import { Route as settingsRoute } from "@/routes/$lang/_app/_auth/settings/mcp";
import { Route as newApiKeyRoute } from "@/routes/$lang/_app/_auth/settings_/api-keys/new";
import { Route as newTokenRoute } from "@/routes/$lang/_app/_auth/settings_/mcp/new";
import { Route as deviceRoute } from "@/routes/$lang/device";
import { Route as consentRoute } from "@/routes/$lang/mcp-consent";
import { orpc } from "@/utils/orpc";
import "../../../packages/ui/src/styles/globals.css";

const i18n = createInstance();
await i18n.init({
  lng: "en-US",
  fallbackLng: "en-US",
  ns: ["consent", "settings", "common", "errors", "nav"],
  resources: {
    "en-US": {
      consent: enConsent,
      settings: enSettings,
      common: enCommon,
      errors: enErrors,
      nav: enNav,
    },
  },
  interpolation: { escapeValue: false },
});
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
// The app's global CSS clips the document (`body { overflow: clip }`); the
// real app shell supplies the one bounded scroller. Without one here, a
// settings page taller than the viewport (the lists grow as specs add
// fixtures) leaves its lower controls unreachable: Playwright reports them
// "outside of the viewport" and the click never lands. A plain div, not a
// second <main>: the consent route brings its own landmark.
const root = createRootRoute({
  component: () => (
    <div
      // The app's page scroller id, so pages that scroll it (the create pages
      // after a mint) find it here too.
      data-scroll-restoration-id={MAIN_SCROLLER_ID}
      style={{ position: "fixed", inset: 0, overflowY: "auto", overflowX: "clip" }}
    >
      <Outlet />
    </div>
  ),
});
// Apply the same id/path wiring as the generated tree, using the actual page components.
const consent = consentRoute.update({
  id: "/$lang/mcp-consent",
  path: "/$lang/mcp-consent",
  getParentRoute: () => root,
} as never);
const settings = settingsRoute.update({
  id: "/$lang/_app/_auth/settings/mcp",
  path: "/$lang/settings/mcp",
  getParentRoute: () => root,
} as never);
const newToken = newTokenRoute.update({
  id: "/$lang/_app/_auth/settings_/mcp/new",
  path: "/$lang/settings/mcp/new",
  getParentRoute: () => root,
} as never);
const apiKeys = apiKeysRoute.update({
  id: "/$lang/_app/_auth/settings/api-keys",
  path: "/$lang/settings/api-keys",
  getParentRoute: () => root,
} as never);
const newApiKey = newApiKeyRoute.update({
  id: "/$lang/_app/_auth/settings_/api-keys/new",
  path: "/$lang/settings/api-keys/new",
  getParentRoute: () => root,
} as never);
const exit = createRoute({
  getParentRoute: () => root,
  path: "/mcp-exit",
  component: () => <p>Fixture exit</p>,
});
const device = deviceRoute.update({
  id: "/$lang/device",
  path: "/$lang/device",
  getParentRoute: () => root,
} as never);
const router = createRouter({
  routeTree: root.addChildren([consent, settings, newToken, apiKeys, newApiKey, device, exit]),
  defaultPreload: false,
  // The app routes' head() reads the router's i18n, as in the real app.
  context: { i18n },
});
Object.assign(window, {
  __mcpRouter: router,
  __kbQueryClient: queryClient,
  __mcpGrantQueryKey: orpc.mcpGrants.listMine.key(),
});
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <I18nextProvider i18n={i18n}>
      <RouterProvider router={router} />
    </I18nextProvider>
  </QueryClientProvider>,
);
