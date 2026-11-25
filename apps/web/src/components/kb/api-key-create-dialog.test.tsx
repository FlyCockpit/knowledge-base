import enSettings from "@knowledge-base/locales/src/en-US/settings.json";
import { MutationObserver, QueryClient } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  API_KEY_LIST_QUERY_ROOT,
  type ApiKeyDraft,
  ApiKeyDraftPicker,
  apiKeyDraftIssues,
  emptyApiKeyDraft,
  toApiKeyMintInput,
} from "@/components/kb/api-key-create-dialog";
import { withPatSecretHygiene } from "@/components/kb/credential-list";
import { SecretReveal } from "@/components/secret-reveal";
import type { LiveKbOption } from "@/hooks/use-mcp-consent";

const SECRET = `kbk_${"0".repeat(16)}_${"S".repeat(43)}`;
const live: LiveKbOption[] = [
  {
    kbId: "a".repeat(24),
    name: "Engineering",
    bits: ["read", "propose", "write", "review", "manage"],
  },
  { kbId: "b".repeat(24), name: "Shared notes", bits: ["read"] },
];
const draft = (patch: Partial<ApiKeyDraft>): ApiKeyDraft => ({ ...emptyApiKeyDraft(), ...patch });
const expiresAt = new Date("2099-01-01T00:00:00Z");

describe("API key create validation", () => {
  it("preselects nothing: reach and a permission must be chosen", () => {
    expect(apiKeyDraftIssues(emptyApiKeyDraft(), live)).toEqual(["reachRequired", "bitsRequired"]);
    expect(apiKeyDraftIssues(draft({ reach: "all", bits: ["read"] }), live)).toEqual([]);
  });

  it("delete needs manage in the ceiling", () => {
    expect(
      apiKeyDraftIssues(draft({ reach: "all", bits: ["write"], allowDelete: true }), live),
    ).toEqual(["deleteNeedsManage"]);
    expect(
      apiKeyDraftIssues(draft({ reach: "all", bits: ["manage"], allowDelete: true }), live),
    ).toEqual([]);
  });

  it("chosen reach needs at least one live KB that holds every ceiling bit", () => {
    expect(apiKeyDraftIssues(draft({ reach: "selected", bits: ["read"] }), live)).toEqual([
      "kbRequired",
    ]);
    // A KB id that is not (or no longer) live does not count.
    expect(
      apiKeyDraftIssues(
        draft({ reach: "selected", bits: ["read"], kbIds: ["c".repeat(24)] }),
        live,
      ),
    ).toEqual(["kbRequired"]);
    expect(
      apiKeyDraftIssues(
        draft({ reach: "selected", bits: ["propose"], kbIds: ["b".repeat(24)] }),
        live,
      ),
    ).toEqual(["kbLacksBits"]);
    expect(
      apiKeyDraftIssues(
        draft({ reach: "selected", bits: ["propose"], kbIds: ["a".repeat(24)] }),
        live,
      ),
    ).toEqual([]);
  });

  it("created reach needs create, and writing children need a write mode", () => {
    expect(apiKeyDraftIssues(draft({ reach: "created", bits: ["read"] }), live)).toEqual([
      "createdNeedsCreate",
    ]);
    const minting = draft({ reach: "all", bits: ["read"], allowMintChildren: true });
    expect(apiKeyDraftIssues({ ...minting, childToolGroups: [] }, live)).toEqual([
      "toolGroupRequired",
    ]);
    expect(apiKeyDraftIssues({ ...minting, childWrites: true }, live)).toEqual([
      "writeModeRequired",
    ]);
  });

  it("builds the exact mint input: expanded bits, kbIds only for chosen reach, child ceilings only when minting", () => {
    expect(
      toApiKeyMintInput(
        "  CI bot ",
        draft({ reach: "selected", bits: ["propose"], kbIds: ["a".repeat(24), "c".repeat(24)] }),
        live,
        expiresAt,
      ),
    ).toEqual({
      name: "CI bot",
      reach: "selected",
      kbIds: ["a".repeat(24)],
      bits: ["read", "propose"],
      allowCreate: false,
      allowDelete: false,
      allowMintChildren: false,
      expiresAt,
    });
    expect(
      toApiKeyMintInput(
        "PM",
        draft({
          reach: "created",
          bits: ["manage"],
          allowCreate: true,
          allowDelete: true,
          allowMintChildren: true,
          childToolGroups: ["edit", "read"],
          childWrites: true,
          childAuthoringMode: "edit",
        }),
        live,
        expiresAt,
      ),
    ).toEqual({
      name: "PM",
      reach: "created",
      bits: ["read", "propose", "write", "review", "manage"],
      allowCreate: true,
      allowDelete: true,
      allowMintChildren: true,
      childToolGroups: ["read", "edit"],
      childAuthoringMode: "edit",
      expiresAt,
    });
    // A write mode left over from unticking "may change content" is not sent.
    expect(
      toApiKeyMintInput(
        "RO",
        draft({
          reach: "all",
          bits: ["read"],
          allowMintChildren: true,
          childWrites: false,
          childAuthoringMode: "both",
        }),
        live,
        expiresAt,
      ).childAuthoringMode,
    ).toBeNull();
  });
});

describe("ApiKeyDraftPicker", () => {
  const i18n = createInstance();
  beforeAll(async () => {
    await i18n.init({
      lng: "en-US",
      fallbackLng: "en-US",
      ns: ["settings"],
      defaultNS: "settings",
      resources: { "en-US": { settings: enSettings } },
      interpolation: { escapeValue: false },
      react: { useSuspense: false },
    });
  });
  const html = (value: ApiKeyDraft) =>
    renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <ApiKeyDraftPicker
          draft={value}
          onChange={() => undefined}
          live={live}
          disabled={false}
          kbsError={false}
          kbsPending={false}
          onRetryKbs={() => undefined}
        />
      </I18nextProvider>,
    );

  it("explains that delete needs manage until manage is in the ceiling", () => {
    expect(html(draft({ reach: "all", bits: ["write"] }))).toContain(
      enSettings.apiKeys.allowDelete.needsManage,
    );
    expect(html(draft({ reach: "all", bits: ["manage"] }))).not.toContain(
      enSettings.apiKeys.allowDelete.needsManage,
    );
  });

  it("lists KBs only for chosen reach and says which ones lack a ceiling bit", () => {
    expect(html(draft({ reach: "all", bits: ["read"] }))).not.toContain("Shared notes");
    const markup = html(draft({ reach: "selected", bits: ["propose"] }));
    expect(markup).toContain("Engineering");
    expect(markup).toContain("hold Propose here.");
  });

  it("shows the minted-token ceilings only when minting is on, never offering sealed values", () => {
    expect(html(draft({ reach: "all", bits: ["read"] }))).not.toContain(
      enSettings.apiKeys.childHint,
    );
    const markup = html(draft({ reach: "all", bits: ["read"], allowMintChildren: true }));
    expect(markup).toContain(enSettings.apiKeys.childHint);
    expect(markup).not.toContain(enSettings.credentials.picker.groups.sealed.label);
  });
});

describe("API key secret hygiene", () => {
  it("shows the secret once: never in the query cache, gone from the mutation cache on close", async () => {
    vi.useFakeTimers();
    try {
      const queryClient = new QueryClient();
      const invalidate = vi.spyOn(queryClient, "invalidateQueries");
      const observer = new MutationObserver(
        queryClient,
        withPatSecretHygiene(
          queryClient,
          { mutationFn: async () => ({ key: { id: "k1" }, secret: SECRET }) },
          API_KEY_LIST_QUERY_ROOT,
        ),
      );
      const minted = await observer.mutate(undefined);
      expect(minted.secret).toBe(SECRET);
      expect(invalidate).toHaveBeenCalledWith({ queryKey: [...API_KEY_LIST_QUERY_ROOT] });
      expect(
        JSON.stringify(
          queryClient
            .getQueryCache()
            .getAll()
            .map((q) => q.state.data),
        ),
      ).not.toContain(SECRET);
      observer.reset();
      await vi.runAllTimersAsync();
      expect(
        JSON.stringify(
          queryClient
            .getMutationCache()
            .getAll()
            .map((m) => m.state.data),
        ),
      ).not.toContain(SECRET);
      expect(observer.getCurrentResult().data).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reveals the minted secret with a copy control and the shown-once warning", () => {
    const markup = renderToStaticMarkup(
      <SecretReveal
        value={SECRET}
        title={enSettings.apiKeys.secretOnce}
        copyLabel={enSettings.apiKeys.copySecret}
      />,
    );
    expect(markup).toContain(SECRET);
    expect(markup).toContain("Copy this API key now.");
    expect(markup).toContain(enSettings.apiKeys.copySecret);
  });
});
