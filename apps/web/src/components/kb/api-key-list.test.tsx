import enSettings from "@knowledge-base/locales/src/en-US/settings.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

import {
  ApiKeyList,
  type ApiKeyRow,
  ChildTokenList,
  type ChildTokenRow,
} from "@/components/kb/api-key-list";

const key = (patch: Partial<ApiKeyRow>): ApiKeyRow => ({
  id: "0".repeat(24),
  name: "Project bot",
  lookupPrefix: "0123456789abcdef",
  grantId: "00000000-0000-4000-8000-000000000001",
  reach: "created",
  bits: ["read", "propose"],
  allowCreate: true,
  allowDelete: false,
  allowMintChildren: true,
  childToolGroups: ["read"],
  childAuthoringMode: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  expiresAt: new Date("2099-01-01T00:00:00Z"),
  lastUsedAt: null,
  revokedAt: null,
  liveChildren: 3,
  kbCount: 2,
  ...patch,
});
const child = (patch: Partial<ChildTokenRow>): ChildTokenRow => ({
  id: "tok1",
  name: "Agent token",
  lookupPrefix: "fedcba9876543210",
  grantId: "00000000-0000-4000-8000-000000000002",
  apiKeyId: "0".repeat(24),
  kbId: "a".repeat(24),
  bits: ["read", "propose"],
  scopes: ["mcp:read", "mcp:write"],
  toolGroups: ["read", "edit", "pull_requests"],
  authoringMode: "edit",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  expiresAt: new Date("2099-01-01T00:00:00Z"),
  revokedAt: null,
  ...patch,
});

describe("ApiKeyList", () => {
  const i18n = createInstance();
  beforeAll(async () => {
    await i18n.init({
      lng: "en-US",
      fallbackLng: "en-US",
      ns: ["settings", "common"],
      defaultNS: "settings",
      resources: { "en-US": { settings: enSettings } },
      interpolation: { escapeValue: false },
      react: { useSuspense: false },
    });
  });
  const render = (node: ReactNode) =>
    renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <I18nextProvider i18n={i18n}>{node}</I18nextProvider>
      </QueryClientProvider>,
    );
  const list = (keys: ApiKeyRow[]) =>
    render(
      <ApiKeyList
        lang="en-US"
        keys={keys}
        onCreate={() => undefined}
        onDetails={() => undefined}
        onRevoke={() => undefined}
      />,
    );

  it("lists a key by name and prefix with its reach, permissions, capabilities and tokens", () => {
    const markup = list([key({})]);
    expect(markup).toContain("Project bot");
    expect(markup).toContain("kbk_0123456789abcdef");
    expect(markup).toContain("Reach: 2 knowledge bases it created");
    expect(markup).toContain("Permissions: Read, Propose");
    expect(markup).toContain("May: create knowledge bases, mint MCP tokens");
    expect(markup).toContain("Tokens are read-only");
    expect(markup).toContain("3 active tokens");
    expect(markup).toContain("Never used");
    expect(markup).toContain(">Active<");
  });

  it("offers revoke only for unrevoked keys and marks expired and revoked ones", () => {
    const markup = list([
      key({ id: "1".repeat(24), name: "Live" }),
      key({ id: "2".repeat(24), name: "Gone", revokedAt: new Date("2026-02-01T00:00:00Z") }),
      key({ id: "3".repeat(24), name: "Old", expiresAt: new Date("2026-02-01T00:00:00Z") }),
    ]);
    expect(markup).toContain('aria-label="Revoke Live"');
    expect(markup).not.toContain('aria-label="Revoke Gone"');
    expect(markup).toContain('aria-label="Revoke Old"');
    expect(markup).toContain(">Revoked<");
    expect(markup).toContain(">Expired<");
    expect(markup).toContain('aria-label="Details for Gone"');
  });

  it("shows the empty state and a create action", () => {
    const markup = list([]);
    expect(markup).toContain(enSettings.apiKeys.noKeys);
    expect(markup).toContain(enSettings.apiKeys.create);
  });

  it("lists child tokens with the KB name when known, else its id, and revoke only while unrevoked", () => {
    const markup = render(
      <ChildTokenList
        lang="en-US"
        rows={[
          child({}),
          child({
            id: "tok2",
            name: "Revoked token",
            kbId: "b".repeat(24),
            revokedAt: new Date("2026-02-01T00:00:00Z"),
          }),
        ]}
        kbName={(kbId) => (kbId === "a".repeat(24) ? "Engineering" : undefined)}
        onRevoke={() => undefined}
      />,
    );
    expect(markup).toContain("Engineering: Read, Propose");
    expect(markup).toContain("b".repeat(24));
    expect(markup).toContain("Write mode: Direct edits only");
    expect(markup).toContain('aria-label="Revoke Agent token"');
    expect(markup).not.toContain('aria-label="Revoke Revoked token"');
  });

  it("says how many tokens a key revoke also revokes", () => {
    expect(i18n.t("apiKeys.revokeDescription", { name: "Project bot", count: 3 })).toBe(
      '"Project bot" stops working immediately, and so do all 3 active MCP tokens it minted. This can\'t be undone.',
    );
  });
});
