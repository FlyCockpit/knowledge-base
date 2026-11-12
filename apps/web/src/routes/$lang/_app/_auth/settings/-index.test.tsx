import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
// @ts-expect-error — TanStack exposes the private route component through this Vite split module.
import { component as Component } from "./index?tsr-split=component";

const fixture = vi.hoisted(() => ({
  preferences: {
    data: undefined as { operationalAlerts: boolean } | undefined,
    isPending: false,
    isError: true,
    refetch: () => undefined,
  },
}));
vi.mock("@tanstack/react-router", () => ({
  lazyRouteComponent: () => () => null,
  createFileRoute: () => (options: { component: ComponentType }) => ({
    options,
    useRouteContext: () => ({
      session: { user: { name: "Test Admin", email: "admin@example.test", role: "admin" } },
    }),
  }),
}));
vi.mock("react-i18next", async (original) => ({
  ...(await original<typeof import("react-i18next")>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@tanstack/react-query", async (original) => ({
  ...(await original<typeof import("@tanstack/react-query")>()),
  useQuery: () => fixture.preferences,
}));
vi.mock("@/components/consent/consent-preferences-button", () => ({
  ConsentPreferencesButton: () => null,
}));
function render() {
  const client = new QueryClient();
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <Component />
      </QueryClientProvider>,
    );
  } finally {
    client.clear();
  }
}
afterEach(() => {
  fixture.preferences = {
    data: undefined,
    isPending: false,
    isError: true,
    refetch: () => undefined,
  };
});
it("renders retry instead of a guessed editable notification preference on first failure", () => {
  const out = render();
  expect(out).toContain("actions.tryAgain");
  expect(out).not.toContain('id="operational-alerts"');
});
it("keeps a known preference plus retry on background failure", () => {
  fixture.preferences.data = { operationalAlerts: false };
  const out = render();
  expect(out).toContain('id="operational-alerts"');
  expect(out).toContain('aria-checked="false"');
  expect(out).toContain("actions.tryAgain");
});
it("renders a matching skeleton while preferences are pending", () => {
  fixture.preferences.isPending = true;
  const out = render();
  expect(out).toContain('data-slot="skeleton"');
  expect(out).not.toContain('id="operational-alerts"');
});
