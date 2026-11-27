import enAdmin from "@knowledge-base/locales/src/en-US/admin.json";
import enCommon from "@knowledge-base/locales/src/en-US/common.json";
import { createInstance } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { OAuthClientsPanel } from "./oauth-clients-panel";

const state = vi.hoisted(() => ({
  error: undefined as unknown,
  onError: undefined as undefined | ((error: unknown) => void),
  refetch: vi.fn<() => Promise<{ isSuccess: boolean }>>(),
  reset: vi.fn(),
}));
vi.mock("@tanstack/react-query", () => ({
  useInfiniteQuery: () => ({
    data: {
      pages: [
        {
          items: [
            {
              id: "1",
              clientId: "sample-client",
              name: "Example",
              userId: null,
              dynamic: true,
              createdAt: new Date("2026-01-01"),
              activeGrantCount: 2,
              _count: { oauthAccessTokens: 1, oauthRefreshTokens: 2 },
            },
          ],
        },
      ],
    },
    isPending: false,
    isError: false,
    hasNextPage: false,
    refetch: state.refetch,
  }),
  useMutation: () => ({ reset: state.reset, mutate: vi.fn(), error: state.error }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@/utils/orpc", () => ({
  orpc: {
    oauthClients: {
      list: { infiniteOptions: () => ({}), key: () => [] },
      delete: {
        mutationOptions: (options: { onError: (error: unknown) => void }) => {
          state.onError = options.onError;
          return options;
        },
      },
    },
  },
}));
const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: "en-US",
    ns: ["admin", "common"],
    defaultNS: "admin",
    resources: { "en-US": { admin: enAdmin, common: enCommon } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
});
describe("OAuth clients panel", () => {
  it("hides cached clients and keeps denial when authority recheck fails", async () => {
    state.refetch.mockReset().mockResolvedValue({ isSuccess: false });
    state.reset.mockReset();
    state.error = { code: "FORBIDDEN" };
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <OAuthClientsPanel />
      </I18nextProvider>,
    );
    state.onError?.(state.error);
    await Promise.resolve();
    expect(html).not.toContain("sample-client");
    expect(html).not.toContain(enAdmin.oauthClients.empty);
    expect(state.refetch).toHaveBeenCalledOnce();
    expect(state.reset).not.toHaveBeenCalled();
    state.error = undefined;
  });
  it("recovers the list after NOT_FOUND delete when authority recheck succeeds", async () => {
    state.refetch.mockReset().mockResolvedValue({ isSuccess: true });
    state.reset.mockReset().mockImplementation(() => {
      state.error = undefined;
    });
    state.error = { code: "NOT_FOUND" };
    const deniedHtml = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <OAuthClientsPanel />
      </I18nextProvider>,
    );
    expect(deniedHtml).not.toContain("sample-client");
    expect(deniedHtml).not.toContain(enAdmin.oauthClients.empty);
    state.onError?.(state.error);
    await Promise.resolve();
    expect(state.refetch).toHaveBeenCalledOnce();
    expect(state.reset).toHaveBeenCalledOnce();
    const recoveredHtml = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <OAuthClientsPanel />
      </I18nextProvider>,
    );
    expect(recoveredHtml).toContain("sample-client");
  });
  it("renders expiry guidance and client activity", () => {
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <OAuthClientsPanel />
      </I18nextProvider>,
    );
    expect(html).toContain("30 days");
    expect(html).toContain("Example");
    expect(html).toContain("sample-client");
    expect(html).toContain("Dynamic");
    expect(html).toContain("Active grants: 2");
    expect(html).toContain("Tokens: 3");
  });
});
