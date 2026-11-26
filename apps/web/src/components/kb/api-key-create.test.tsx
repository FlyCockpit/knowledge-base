import enSettings from "@knowledge-base/locales/src/en-US/settings.json";
import { MutationObserver, QueryClient } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  API_KEY_DEFAULT_EXPIRY,
  API_KEY_LIST_QUERY_ROOT,
  type ApiKeyDraft,
  ApiKeyDraftPicker,
  apiKeyDraftIssues,
  apiKeyDraftSummary,
  bitPresetFor,
  defaultApiKeyDraft,
  toApiKeyMintInput,
} from "@/components/kb/api-key-create";
import {
  ACTIVE_COUNTS_QUERY_KEY,
  patExpiresAtFromChoice,
  withPatSecretHygiene,
} from "@/components/kb/credential-list";
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
const draft = (patch: Partial<ApiKeyDraft>): ApiKeyDraft => ({ ...defaultApiKeyDraft(), ...patch });
const expiresAt = new Date("2099-01-01T00:00:00Z");
/** Text as React writes it into static markup. */
const markupText = (text: string) => text.replaceAll("'", "&#x27;").replaceAll('"', "&quot;");

describe("API key create validation", () => {
  it("starts on Read for chosen knowledge bases, with none chosen and no capability", () => {
    expect(defaultApiKeyDraft()).toMatchObject({
      reach: "selected",
      kbIds: [],
      bits: ["read"],
      allowCreate: false,
      allowDelete: false,
      allowMintChildren: false,
      childAuthoringMode: null,
    });
    // The one thing left to decide is which knowledge bases.
    expect(apiKeyDraftIssues(defaultApiKeyDraft(), live)).toEqual(["kbRequired"]);
    expect(apiKeyDraftIssues(draft({ kbIds: ["a".repeat(24)] }), live)).toEqual([]);
    // A cleared reach or permission set is still refused.
    expect(apiKeyDraftIssues(draft({ reach: null, bits: [] }), live)).toEqual([
      "reachRequired",
      "bitsRequired",
    ]);
  });

  it("names a permission preset for each implied set, and Custom for the rest", () => {
    expect(bitPresetFor(["read"])).toBe("read");
    expect(bitPresetFor(["propose"])).toBe("propose");
    expect(bitPresetFor(["read", "propose"])).toBe("propose");
    expect(bitPresetFor(["write"])).toBe("write");
    expect(bitPresetFor(["manage"])).toBe("manage");
    expect(bitPresetFor(["review"])).toBe("custom");
    expect(bitPresetFor(["write", "review"])).toBe("custom");
    expect(bitPresetFor([])).toBe("custom");
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

  it("created reach needs create, and children whose tools write need a write mode", () => {
    expect(apiKeyDraftIssues(draft({ reach: "created", bits: ["read"] }), live)).toEqual([
      "createdNeedsCreate",
    ]);
    const minting = draft({ reach: "all", bits: ["read"], allowMintChildren: true });
    expect(apiKeyDraftIssues({ ...minting, childToolGroups: [] }, live)).toEqual([
      "toolGroupRequired",
    ]);
    // The write access of minted tokens follows from their tools: Propose edits writes.
    expect(
      apiKeyDraftIssues({ ...minting, childToolGroups: ["read", "edit", "pull_requests"] }, live),
    ).toEqual(["writeModeRequired"]);
    expect(apiKeyDraftIssues({ ...minting, childToolGroups: ["read", "export"] }, live)).toEqual(
      [],
    );
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
    // A write mode left over from a writing preset is not sent once the tools only read.
    expect(
      toApiKeyMintInput(
        "RO",
        draft({
          reach: "all",
          bits: ["read"],
          allowMintChildren: true,
          childToolGroups: ["read"],
          childAuthoringMode: "both",
        }),
        live,
        expiresAt,
      ).childAuthoringMode,
    ).toBeNull();
  });

  it("defaults to a year, and never expires sends an explicit null expiry", () => {
    const now = new Date("2026-11-25T12:00:00Z");
    expect(API_KEY_DEFAULT_EXPIRY).toBe("365");
    expect(patExpiresAtFromChoice(API_KEY_DEFAULT_EXPIRY, "", now)).toEqual({
      ok: true,
      expiresAt: new Date("2027-11-25T12:00:00Z"),
    });
    const never = patExpiresAtFromChoice("none", "", now);
    if (!never.ok) throw new Error("never expires is a valid choice");
    const input = toApiKeyMintInput(
      "Forever",
      draft({ reach: "all", bits: ["read"] }),
      live,
      never.expiresAt,
    );
    expect(input).toHaveProperty("expiresAt", null);
    // A custom date beyond a year is refused before any mint.
    expect(patExpiresAtFromChoice("custom", "2028-01-01", now)).toEqual({ ok: false });
  });

  it("sends sealed, child KB creation and tokens-end-with-key only when chosen", () => {
    const minting = draft({ reach: "all", bits: ["manage"], allowMintChildren: true });
    const plain = toApiKeyMintInput("Plain", minting, live, expiresAt);
    expect(plain.childToolGroups).toEqual(["read"]);
    expect(plain).not.toHaveProperty("childAllowCreate");
    expect(plain).not.toHaveProperty("childrenEndWithKey");
    expect(
      toApiKeyMintInput(
        "All options",
        {
          ...minting,
          childToolGroups: ["sealed", "kb_admin", "read"],
          childAuthoringMode: "both",
          childAllowCreate: true,
          childrenEndWithKey: true,
        },
        live,
        expiresAt,
      ),
    ).toMatchObject({
      childToolGroups: ["read", "kb_admin", "sealed"],
      childAuthoringMode: "both",
      childAllowCreate: true,
      childrenEndWithKey: true,
    });
    // Without minting none of the token options is sent.
    const notMinting = toApiKeyMintInput(
      "No mint",
      { ...minting, allowMintChildren: false, childAllowCreate: true, childrenEndWithKey: true },
      live,
      expiresAt,
    );
    expect(notMinting).not.toHaveProperty("childAllowCreate");
    expect(notMinting).not.toHaveProperty("childrenEndWithKey");
    expect(notMinting).not.toHaveProperty("childToolGroups");
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

  it("previews the KBs the key creates as part of what a minted token can reach", () => {
    // A custom group set opens Advanced, where the preview lives.
    const markup = html(
      draft({
        reach: "created",
        bits: ["read"],
        allowCreate: true,
        allowMintChildren: true,
        childToolGroups: ["read", "export"],
      }),
    );
    expect(markup).toContain(enSettings.apiKeys.previewCreatedKbs);
    expect(markup).not.toContain(enSettings.credentials.picker.previewNoKbs);
  });

  it("shows the minted-token ceilings only when minting is on, with both new opt-ins off", () => {
    expect(html(draft({ reach: "all", bits: ["read"] }))).not.toContain(
      enSettings.apiKeys.childHint,
    );
    const markup = html(draft({ reach: "all", bits: ["read"], allowMintChildren: true }));
    expect(markup).toContain(enSettings.apiKeys.childHint);
    // The quick path: what the tokens do, then whether they end with the key.
    expect(markup).toContain(enSettings.apiKeys.childPurposeLegend);
    expect(markup).toContain(enSettings.apiKeys.childrenEndWithKey.label);
    // Token KB creation, sealed values and single groups wait under a closed Advanced
    // section that names the current tools while closed.
    expect(markup).toContain(enSettings.apiKeys.childAdvanced);
    expect(markup).toMatch(/<details data-slot="advanced-section"(?![^>]*open)/);
    expect(markup).toContain("Token tools: Read");
    // A Read preset writes nothing, so no write mode is asked for.
    expect(markup).not.toContain(enSettings.credentials.writeMode.legend);
    expect(markup).toContain(markupText(enSettings.apiKeys.childrenEndWithKey.off));
    expect(markup).not.toContain(markupText(enSettings.apiKeys.childrenEndWithKey.on));
    expect(markup).not.toContain(markupText(enSettings.apiKeys.childSealedWarning));
  });

  it("asks for a write mode once the minted tokens' preset writes", () => {
    const markup = html(
      draft({
        reach: "all",
        bits: ["write"],
        allowMintChildren: true,
        childToolGroups: ["read", "edit", "pull_requests"],
      }),
    );
    expect(markup).toContain(enSettings.credentials.writeMode.legend);
    expect(markup).toMatch(/<details data-slot="advanced-section"(?![^>]*open)/);
  });

  it("offers sealed values to minted tokens with the per-token approval warning once chosen", () => {
    // A custom group set opens Advanced, where every PAT group is offered.
    const markup = html(
      draft({
        reach: "all",
        bits: ["read"],
        allowMintChildren: true,
        childToolGroups: ["read", "sealed"],
        childrenEndWithKey: true,
      }),
    );
    expect(markup).toContain(enSettings.credentials.picker.groups.sealed.label);
    expect(markup).toContain(enSettings.apiKeys.childAllowCreate.label);
    expect(markup).toContain(markupText(enSettings.apiKeys.childSealedWarning));
    expect(markup).toContain(markupText(enSettings.apiKeys.childrenEndWithKey.on));
  });
});

describe("API key page sections", () => {
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
  const html = (value: ApiKeyDraft, issues = apiKeyDraftIssues(value, live)) =>
    renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <ApiKeyDraftPicker
          draft={value}
          onChange={() => undefined}
          live={live}
          issues={issues}
          disabled={false}
          kbsError={false}
          kbsPending={false}
          onRetryKbs={() => undefined}
        />
      </I18nextProvider>,
    );

  it("shows Read checked, and the single permissions only under Custom", () => {
    const markup = html(defaultApiKeyDraft(), []);
    expect(markup).toMatch(/<input(?=[^>]*value="read")(?=[^>]*checked="")[^>]*>/);
    expect(markup).toContain(enSettings.apiKeys.bitPresets.read);
    expect(markup).not.toContain(enSettings.credentials.picker.bits.review.description);
    const custom = html(draft({ bits: ["review"] }), []);
    expect(custom).toMatch(/<input(?=[^>]*value="custom")(?=[^>]*checked="")[^>]*>/);
    expect(custom).toContain(enSettings.credentials.picker.bits.review.description);
  });

  it("puts each problem right under the part of the page it is about", () => {
    const markup = html(defaultApiKeyDraft());
    const issue = enSettings.apiKeys.issues.kbRequired;
    expect(markup).toContain(`data-form-issue="true" tabindex="-1" role="alert"`);
    expect(markup).toContain(issue);
    // Under the knowledge-base list, before the capabilities section.
    expect(markup.indexOf(issue)).toBeGreaterThan(markup.indexOf("Shared notes"));
    expect(markup.indexOf(issue)).toBeLessThan(
      markup.indexOf(enSettings.apiKeys.capabilitiesLegend),
    );
    // Nothing shows before Create was pressed (the page passes no issues then).
    expect(html(defaultApiKeyDraft(), [])).not.toContain("data-form-issue");
  });

  it("says what Create will make in one line", () => {
    const t = i18n.getFixedT("en-US", "settings");
    expect(
      apiKeyDraftSummary(
        t,
        draft({ kbIds: ["a".repeat(24)], allowMintChildren: true }),
        "Expires in 365 days",
      ),
    ).toBe(
      "Reach: 1 chosen knowledge base · Permissions: Read · May: mint MCP tokens · Expires in 365 days",
    );
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
      // The password-reset review and the home's checklist count what is live.
      expect(invalidate).toHaveBeenCalledWith({ queryKey: [...ACTIVE_COUNTS_QUERY_KEY] });
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
