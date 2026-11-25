import enSettings from "@knowledge-base/locales/src/en-US/settings.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ApiKeyList,
  ApiKeyRevokeChildren,
  ApiKeyRevokeDialog,
  type ApiKeyRow,
  apiKeyRevokeToast,
  ChildTokenList,
  type ChildTokenRow,
} from "@/components/kb/api-key-list";

type ConfirmProps = {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmToken: string;
  children?: ReactNode;
  onConfirm: (typed: string) => void;
};
const confirms = vi.hoisted(() => ({ calls: [] as unknown[] }));
// The real AlertDialog renders through a portal (nothing in static markup):
// render its description and extra content inline and record its props.
vi.mock("@/components/confirm-delete-dialog", () => ({
  ConfirmDeleteDialog: (props: ConfirmProps) => {
    confirms.calls.push(props);
    return props.open ? (
      <div data-confirm={props.title}>
        <p>{props.description}</p>
        {props.children}
      </div>
    ) : null;
  },
}));
const lastConfirm = () => confirms.calls.at(-1) as ConfirmProps;
beforeEach(() => {
  confirms.calls = [];
});

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
  childAllowCreate: false,
  childrenEndWithKey: false,
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
  allowCreate: false,
  createdKbBits: [],
  kbCount: 1,
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
    expect(markup).toContain(enSettings.apiKeys.childrenEndWithKeySummary.off);
    expect(markup).not.toContain(enSettings.apiKeys.childAllowCreateSummary);
  });

  it("shows never expires, tokens ending with the key and token KB creation", () => {
    const markup = list([
      key({ expiresAt: null, childrenEndWithKey: true, childAllowCreate: true }),
    ]);
    expect(markup).toContain(enSettings.credentials.neverExpires);
    expect(markup).not.toContain("Expires ");
    expect(markup).toContain(enSettings.apiKeys.childrenEndWithKeySummary.on);
    expect(markup).toContain(enSettings.apiKeys.childAllowCreateSummary);
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
    expect(markup).not.toContain(enSettings.apiKeys.childCanCreate);
  });

  it("says when a child token can create knowledge bases", () => {
    const markup = render(
      <ChildTokenList
        lang="en-US"
        rows={[child({ allowCreate: true, expiresAt: null })]}
        kbName={() => "Engineering"}
        onRevoke={() => undefined}
      />,
    );
    expect(markup).toContain(enSettings.apiKeys.childCanCreate);
    expect(markup).toContain(enSettings.credentials.neverExpires);
  });

  it("says how many knowledge bases a creating child reaches beyond its minted one", () => {
    const html = (kbCount: number) =>
      render(
        <ChildTokenList
          lang="en-US"
          rows={[child({ allowCreate: true, createdKbBits: ["read"], kbCount })]}
          kbName={() => "Engineering"}
          onRevoke={() => undefined}
        />,
      );
    expect(html(3)).toContain("Also reaches 2 knowledge bases it created.");
    expect(html(1)).not.toContain("Also reaches");
  });

  const revokeDialog = (apiKey: ApiKeyRow | null, choice: boolean | null, onConfirm = vi.fn()) =>
    render(
      <ApiKeyRevokeDialog
        apiKey={apiKey}
        choice={choice}
        onChoiceChange={() => undefined}
        onOpenChange={() => undefined}
        isPending={false}
        onConfirm={onConfirm}
      />,
    );

  it("pre-selects revoking a key's tokens from its setting and sends the choice", () => {
    const ending = vi.fn();
    const markup = revokeDialog(key({ childrenEndWithKey: true }), null, ending);
    expect(markup).toContain("Also revoke its 3 tokens");
    expect(markup).toMatch(/aria-checked="true"[^>]*aria-labelledby="[^"]*-revoke-children-label"/);
    expect(markup).toContain("and so do all 3 active MCP tokens it minted");
    lastConfirm().onConfirm("Project bot");
    expect(ending).toHaveBeenCalledWith({ id: "0".repeat(24), revokeChildren: true });

    const independent = vi.fn();
    const kept = revokeDialog(key({ childrenEndWithKey: false }), null, independent);
    expect(kept).toMatch(/aria-checked="false"[^>]*aria-labelledby="[^"]*-revoke-children-label"/);
    expect(kept).toContain("Its 3 active MCP tokens keep working.");
    lastConfirm().onConfirm("Project bot");
    expect(independent).toHaveBeenCalledWith({ id: "0".repeat(24), revokeChildren: false });

    // The user's change wins over the key's setting.
    const changed = vi.fn();
    revokeDialog(key({ childrenEndWithKey: true }), false, changed);
    lastConfirm().onConfirm("Project bot");
    expect(changed).toHaveBeenCalledWith({ id: "0".repeat(24), revokeChildren: false });
  });

  it("hides the tokens checkbox only for a key that has no tokens and cannot mint any", () => {
    const markup = revokeDialog(key({ liveChildren: 0, allowMintChildren: false }), null);
    expect(markup).not.toContain("Also revoke");
    expect(markup).toContain("It has no active MCP tokens.");
    expect(revokeDialog(null, null)).toBe("");
  });

  it("still offers revoking tokens for a mint-capable key whose count is 0 (it may mint meanwhile)", () => {
    const onConfirm = vi.fn();
    const markup = revokeDialog(
      key({ liveChildren: 0, allowMintChildren: true, childrenEndWithKey: true }),
      null,
      onConfirm,
    );
    expect(markup).toContain(enSettings.apiKeys.revokeAlsoAnyChildren);
    expect(markup).toContain("checked");
  });

  it("words the revoke toast after what was revoked and what was chosen", () => {
    const t = i18n.getFixedT("en-US", "settings");
    expect(apiKeyRevokeToast(t, { children: 3 }, { liveChildren: 3, revokeChildren: true })).toBe(
      "API key revoked, with 3 tokens.",
    );
    expect(apiKeyRevokeToast(t, { children: 0 }, { liveChildren: 3, revokeChildren: false })).toBe(
      enSettings.apiKeys.revokeSuccessKeptTokens,
    );
    expect(apiKeyRevokeToast(t, { children: 0 }, { liveChildren: 0, revokeChildren: false })).toBe(
      enSettings.apiKeys.revokeSuccessNoTokens,
    );
  });

  it("offers revoke all tokens only while the key has active tokens, sending its id", () => {
    const onConfirm = vi.fn();
    const revokeAll = (apiKey: ApiKeyRow, open: boolean) =>
      render(
        <ApiKeyRevokeChildren
          apiKey={apiKey}
          open={open}
          onOpenChange={() => undefined}
          isPending={false}
          onConfirm={onConfirm}
        />,
      );
    expect(revokeAll(key({ liveChildren: 0 }), false)).toBe("");
    // A revoked key's surviving tokens can be revoked all at once too.
    const markup = revokeAll(key({ revokedAt: new Date("2026-02-01T00:00:00Z") }), true);
    expect(markup).toContain(enSettings.apiKeys.revokeChildren);
    expect(markup).toContain("All 3 active MCP tokens minted by");
    expect(lastConfirm()).toMatchObject({ confirmToken: "Project bot" });
    lastConfirm().onConfirm("Project bot");
    expect(onConfirm).toHaveBeenCalledWith({ apiKeyId: "0".repeat(24) });
  });

  it("says how many tokens a key revoke also revokes", () => {
    expect(i18n.t("apiKeys.revokeDescription", { name: "Project bot", count: 3 })).toBe(
      '"Project bot" stops working immediately, and so do all 3 active MCP tokens it minted. This can\'t be undone.',
    );
  });
});
