import enCommon from "@knowledge-base/locales/src/en-US/common.json";
import enKb from "@knowledge-base/locales/src/en-US/kb.json";
import enSettings from "@knowledge-base/locales/src/en-US/settings.json";
import { MutationObserver, QueryClient } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  generationView,
  ProfileStatusView,
  ProviderListView,
  type ProviderRow,
  parseProfileChoice,
  probeOutcome,
  profileChoices,
  showNoProfileChoices,
} from "@/components/kb/profile-panel";
import {
  transientSecretOptions,
  transientSecretSessionCallbacks,
} from "@/hooks/use-transient-secret-mutation";

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: "en-US",
    fallbackLng: "en-US",
    ns: ["kb", "settings", "common"],
    defaultNS: "kb",
    resources: { "en-US": { kb: enKb, settings: enSettings, common: enCommon } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
});
// Copy assertions compare locale strings, so undo React's text escaping
// (an apostrophe renders as an `&#x27;` entity).
const wrap = (node: React.ReactNode) =>
  renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>)
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&");

const P = "p".repeat(24);
const summary = (over: Partial<ProviderRow> = {}): ProviderRow => ({
  providerId: P,
  revision: 2,
  kind: "OPENAI_COMPAT",
  name: "Mine",
  model: "text-embed",
  dimensions: 8,
  contextTokens: null,
  status: "ready",
  probe: { state: "ready", reason: null, failure: null },
  ...over,
});
const probing = { state: "pending", reason: null, failure: null } as const;

const index = (over: Record<string, unknown> = {}) => ({
  activeGenerationId: null,
  desiredGenerationId: null,
  desiredEpoch: "0",
  activeState: null,
  desiredState: null,
  indexedCommitSha: null,
  headSha: "a".repeat(40),
  dimensions: null,
  fingerprint: null,
  freshness: "unavailable" as const,
  errorCode: null,
  rebuildPending: null,
  ...over,
});

describe("probe progress", () => {
  const pending = { providerId: P, revision: 2 };
  it("is probing until the exact revision is ready", () => {
    expect(probeOutcome(pending, summary({ status: "unavailable", probe: probing }))).toBe(
      "probing",
    );
    expect(probeOutcome(pending, summary({ status: "ready" }))).toBe("ready");
  });
  it("a worker failure and a timeout are terminal states, never 'probing'", () => {
    const failed = summary({
      status: "unavailable",
      probe: { state: "failed", reason: "provider_error", failure: null },
    });
    const timedOut = summary({
      status: "unavailable",
      probe: { state: "timeout", reason: "timeout", failure: null },
    });
    expect(probeOutcome(pending, failed)).toBe("failed");
    expect(probeOutcome(pending, timedOut)).toBe("timeout");
    // Also for rows this page did not start probing (e.g. after a reload).
    expect(probeOutcome(undefined, failed)).toBe("failed");
    expect(probeOutcome(undefined, timedOut)).toBe("timeout");
    expect(probeOutcome(undefined, summary({ status: "unavailable", probe: probing }))).toBe(
      "probing",
    );
    expect(probeOutcome(undefined, summary())).toBeNull();
  });
  it("a late revoke is a failure, never success", () => {
    expect(probeOutcome(pending, summary({ status: "revoked" }))).toBe("failed");
    expect(probeOutcome(pending, undefined)).toBe("failed");
  });
  it("a newer revision supersedes the tracked probe", () => {
    expect(probeOutcome(pending, summary({ revision: 3, status: "ready" }))).toBe("superseded");
  });
});

describe("profile selection", () => {
  it("offers only ready providers and binds the exact revision", () => {
    const choices = profileChoices([
      summary({ revision: 4 }),
      summary({ providerId: "s".repeat(24), kind: "SYSTEM_BUILTIN", revision: 17 }),
      summary({ providerId: "q".repeat(24), kind: "SYSTEM_BUILTIN", status: "unavailable" }),
      summary({ providerId: "r".repeat(24), kind: "SYSTEM_BUILTIN", status: "revoked" }),
    ]);
    expect(choices.map((c) => c.value)).toEqual([`${P}:4`, `${"s".repeat(24)}:17`]);
    expect(parseProfileChoice(`${P}:4`)).toEqual({ providerId: P, revision: 4 });
    expect(parseProfileChoice("garbage")).toBeNull();
    expect(parseProfileChoice(`${P}:0`)).toBeNull();
  });
});

describe("generation state", () => {
  it("never claims unavailable completed vectors are current or still serving", () => {
    const active = {
      activeGenerationId: "g".repeat(24),
      activeState: "COMPLETE",
      errorCode: "INDEX_UNAVAILABLE",
    };
    expect(generationView(index(active))).toEqual({
      phase: "unavailable",
      keepsActive: false,
      failed: false,
    });
    for (const desiredState of ["PENDING", "BUILDING", "FAILED"]) {
      expect(
        generationView(index({ ...active, desiredGenerationId: "h".repeat(24), desiredState }))
          .keepsActive,
      ).toBe(false);
    }
    const html = wrap(
      <ProfileStatusView
        profile={summary()}
        index={index({ ...active, rebuildPending: "EMBEDDING_SETTINGS_CHANGED" })}
      />,
    );
    expect(html).toContain(enKb.settings.profile.settingsChanged);
    expect(html).not.toContain(enKb.settings.profile.rebuildPending.EMBEDDING_SETTINGS_CHANGED);
  });
  it("says search is keyword-only while the active generation is lexical", () => {
    const lexical = index({
      activeGenerationId: "g".repeat(24),
      activeState: "COMPLETE",
      freshness: "current",
    });
    expect(wrap(<ProfileStatusView profile={null} index={lexical} />)).toContain(
      enKb.settings.profile.lexicalNoProfile,
    );
    expect(wrap(<ProfileStatusView profile={summary()} index={lexical} />)).toContain(
      enKb.settings.profile.lexicalFailing,
    );
    // R2-27: a reader has no chooser "below".
    const reader = wrap(<ProfileStatusView profile={null} index={lexical} canManage={false} />);
    expect(reader).toContain(enKb.settings.profile.lexicalNoProfileReader);
    expect(reader).not.toContain("below");
    const hybrid = { ...lexical, dimensions: 8, fingerprint: `sha256:${"a".repeat(64)}` };
    expect(wrap(<ProfileStatusView profile={summary()} index={hybrid} />)).not.toContain(
      'data-testid="profile-lexical"',
    );
    // A hybrid generation whose profile can no longer embed serves its FTS5 arm.
    for (const status of ["revoked", "unavailable"] as const)
      expect(
        wrap(<ProfileStatusView profile={summary({ status })} index={index(hybrid)} />),
      ).toContain(enKb.settings.profile.lexicalFailing);
  });
  it("keeps the old usable generation active while a new one builds", () => {
    const view = generationView(
      index({
        activeGenerationId: "g".repeat(24),
        activeState: "COMPLETE",
        desiredGenerationId: "h".repeat(24),
        desiredState: "BUILDING",
        freshness: "building",
      }),
    );
    expect(view).toEqual({ phase: "building", keepsActive: true, failed: false });
    const html = wrap(
      <ProfileStatusView
        profile={summary()}
        index={index({
          activeGenerationId: "g".repeat(24),
          activeState: "COMPLETE",
          desiredGenerationId: "h".repeat(24),
          desiredState: "BUILDING",
          freshness: "building",
        })}
      />,
    );
    expect(html).toContain('data-testid="profile-keeps-active"');
    expect(html).toContain('data-phase="building"');
  });
  it("reports a failed build without hiding the active generation", () => {
    expect(
      generationView(
        index({
          activeGenerationId: "g".repeat(24),
          activeState: "COMPLETE",
          desiredGenerationId: "h".repeat(24),
          desiredState: "FAILED",
          freshness: "failed",
        }),
      ),
    ).toEqual({ phase: "failed", keepsActive: true, failed: true });
    expect(generationView(index())).toEqual({ phase: "none", keepsActive: false, failed: false });
  });
});

describe("rebuild pending after built-in settings change", () => {
  it("marks a KB still serving its previous-settings index as rebuilding (settings changed)", () => {
    const html = wrap(
      <ProfileStatusView
        profile={summary()}
        index={index({
          activeGenerationId: "g".repeat(24),
          activeState: "COMPLETE",
          freshness: "current",
          rebuildPending: "EMBEDDING_SETTINGS_CHANGED",
        })}
      />,
    );
    expect(html).toContain('data-testid="profile-rebuild-pending"');
    expect(html).toContain(enKb.settings.profile.rebuildPending.EMBEDDING_SETTINGS_CHANGED);
    const model = wrap(
      <ProfileStatusView
        profile={summary()}
        index={index({ rebuildPending: "EMBEDDING_MODEL_CHANGED" })}
      />,
    );
    expect(model).toContain(enKb.settings.profile.rebuildPending.EMBEDDING_MODEL_CHANGED);
    const reloading = wrap(
      <ProfileStatusView
        profile={summary()}
        index={index({ rebuildPending: "EMBEDDING_RUNTIME_RELOADING" })}
      />,
    );
    expect(reloading).toContain(enKb.settings.profile.rebuildPending.EMBEDDING_RUNTIME_RELOADING);
    expect(wrap(<ProfileStatusView profile={summary()} index={index()} />)).not.toContain(
      'data-testid="profile-rebuild-pending"',
    );
  });
});

describe("provider list", () => {
  it("never renders an endpoint or key field and shows status per row", () => {
    const html = wrap(
      <ProviderListView
        providers={[summary(), summary({ providerId: "q".repeat(24), status: "revoked" })]}
        probes={{}}
        onProbe={() => {}}
        onRevoke={() => {}}
      />,
    );
    expect(html).toContain('data-status="ready"');
    expect(html).toContain('data-status="revoked"');
    expect(html).not.toMatch(/https?:\/\//);
    // Revoked rows offer no actions.
    expect(html.match(/data-testid="provider-revoke"/g)?.length).toBe(1);
  });
  it("shows a tracked probe's late failure", () => {
    const html = wrap(
      <ProviderListView
        providers={[summary({ status: "revoked" })]}
        probes={{ [P]: { providerId: P, revision: 2 } }}
        onProbe={() => {}}
        onRevoke={() => {}}
      />,
    );
    expect(html).toContain('data-probe="failed"');
    expect(html).not.toContain('data-probe="ready"');
  });
  it("shows failed and timed-out probes as terminal alerts with their reason", () => {
    const html = wrap(
      <ProviderListView
        providers={[
          summary({
            status: "unavailable",
            probe: { state: "failed", reason: "provider_error", failure: null },
          }),
          summary({
            providerId: "q".repeat(24),
            status: "unavailable",
            probe: { state: "timeout", reason: "timeout", failure: null },
          }),
        ]}
        probes={{ [P]: { providerId: P, revision: 2 } }}
        onProbe={() => {}}
        onRevoke={() => {}}
      />,
    );
    expect(html).toContain('data-probe="failed"');
    expect(html).toContain('data-probe="timeout"');
    expect(html).not.toContain('data-probe="probing"');
    expect(html).not.toContain("Probing…");
    expect(html).toContain("The provider rejected or failed the test request.");
    expect(html).toContain("The probe did not finish in time.");
    expect(html.match(/role="alert"/g)?.length).toBe(2);
  });
});

describe("probe failure causes", () => {
  const render = (probe: ProviderRow["probe"]) =>
    wrap(
      <ProviderListView
        providers={[summary({ status: "unavailable", probe })]}
        probes={{ [P]: { providerId: P, revision: 2 } }}
        onProbe={() => {}}
        onRevoke={() => {}}
      />,
    );
  it("shows a progress hint while the first attempt runs", () => {
    expect(render(probing)).toContain("Sending a test request");
  });
  it("names the cause of a retrying attempt and of a terminal failure", () => {
    const retrying = render({ state: "pending", reason: null, failure: { kind: "unreachable" } });
    expect(retrying).toContain("The last attempt failed: Couldn't reach the endpoint");
    expect(retrying).toContain("Retrying…");
    const status = render({
      state: "failed",
      reason: "provider_error",
      failure: { kind: "http_status", status: 401 },
    });
    expect(status).toContain("The endpoint refused the API key (HTTP 401).");
    // R2-26: a known cause replaces the generic line instead of contradicting it.
    expect(status).not.toContain("rejected or failed the test request");
    expect(render({ state: "failed", reason: "provider_error", failure: null })).toContain(
      "rejected or failed the test request",
    );
    const dims = render({
      state: "failed",
      reason: "provider_error",
      failure: { kind: "dimension_mismatch", received: 768 },
    });
    expect(dims).toContain("768-dimension vectors, but this provider is set to 8");
  });
});

describe("transient provider secrets", () => {
  it.each(["success", "rejection"])(
    "keeps pending secrets out of caches through reset and late %s",
    async (outcome) => {
      vi.useFakeTimers();
      try {
        const client = new QueryClient();
        const KEY = "sk-canary-provider-key";
        const ENDPOINT = "https://secret-canary.example.invalid/embed";
        let input: { apiKey: string; endpointUrl: string } | undefined = {
          apiKey: KEY,
          endpointUrl: ENDPOINT,
        };
        let finish!: () => void;
        let finishRefresh!: () => void;
        const settled = vi.fn(
          () =>
            new Promise<void>((resolve) => {
              finishRefresh = resolve;
            }),
        );
        const session = { current: true };
        const busy = { current: true };
        const success = vi.fn<(value: { provider: ProviderRow }) => void>();
        const failure = vi.fn<(error: Error) => void>();
        const uiSettled = vi.fn<() => void>();
        const ui: {
          current: {
            onSuccess: typeof success;
            onError: typeof failure;
            onSettled: typeof uiSettled;
          } | null;
        } = { current: { onSuccess: success, onError: failure, onSettled: uiSettled } };
        const transport = vi.fn(async (value: { apiKey: string; endpointUrl: string }) => {
          expect(value.apiKey).toBe(KEY);
          expect(value.endpointUrl).toBe(ENDPOINT);
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
          if (outcome === "rejection") throw new Error("transport interrupted");
          return { provider: summary() };
        });
        const observer = new MutationObserver(
          client,
          transientSecretOptions(
            { mutationFn: transport },
            () => {
              const value = input!;
              input = undefined;
              return value;
            },
            transientSecretSessionCallbacks(session, busy, ui, settled),
          ),
        );
        const pending = observer.mutate().catch(() => undefined);
        await vi.waitFor(() => expect(transport).toHaveBeenCalledOnce());
        expect(input).toBeUndefined();
        expect(client.getMutationCache().getAll()[0]?.state.status).toBe("pending");
        expect(client.getMutationCache().getAll()[0]?.state.variables).toBeUndefined();
        observer.reset();
        session.current = false;
        ui.current = null;
        await vi.advanceTimersByTimeAsync(1);
        const pendingDump = JSON.stringify(
          client
            .getMutationCache()
            .getAll()
            .map((m) => m.state),
        );
        expect(pendingDump).not.toContain(KEY);
        expect(pendingDump).not.toContain(ENDPOINT);
        finish();
        await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce());
        expect(busy.current).toBe(true);
        expect(success).not.toHaveBeenCalled();
        expect(failure).not.toHaveBeenCalled();
        finishRefresh();
        await pending;
        expect(busy.current).toBe(false);
        expect(ui.current).toBeNull();
        expect(uiSettled).not.toHaveBeenCalled();
        expect(settled).toHaveBeenCalledOnce();
        await vi.runAllTimersAsync();
        const dump = JSON.stringify([
          client
            .getQueryCache()
            .getAll()
            .map((q) => q.state),
          client
            .getMutationCache()
            .getAll()
            .map((m) => m.state),
        ]);
        expect(dump).not.toContain(KEY);
        expect(dump).not.toContain(ENDPOINT);
      } finally {
        vi.useRealTimers();
      }
    },
  );
});

describe("no usable provider claim (paged lists hold history)", () => {
  it("is shown only once every page is loaded", () => {
    expect(showNoProfileChoices({ choices: 0, loaded: true, hasMorePages: false })).toBe(true);
    // A first page of failed/revoked providers says nothing about page two.
    expect(showNoProfileChoices({ choices: 0, loaded: true, hasMorePages: true })).toBe(false);
    expect(showNoProfileChoices({ choices: 0, loaded: false, hasMorePages: false })).toBe(false);
    expect(showNoProfileChoices({ choices: 1, loaded: true, hasMorePages: false })).toBe(false);
  });
});
