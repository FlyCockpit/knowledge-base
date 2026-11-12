import enCommon from "@knowledge-base/locales/src/en-US/common.json";
import enConsent from "@knowledge-base/locales/src/en-US/consent.json";
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
import { Route as settingsRoute } from "@/routes/$lang/_app/_auth/settings/mcp";
import { Route as deviceRoute } from "@/routes/$lang/device";
import { Route as consentRoute } from "@/routes/$lang/mcp-consent";
import { orpc } from "@/utils/orpc";
import "../../../packages/ui/src/styles/globals.css";

const i18n = createInstance();
await i18n.init({
  lng: "en-US",
  fallbackLng: "en-US",
  ns: ["consent", "settings", "common"],
  resources: { "en-US": { consent: enConsent, settings: enSettings, common: enCommon } },
  interpolation: { escapeValue: false },
});
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const root = createRootRoute({ component: Outlet });
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
  routeTree: root.addChildren([consent, settings, device, exit]),
  defaultPreload: false,
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
