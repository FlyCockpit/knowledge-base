import enCommon from "@knowledge-base/locales/src/en-US/common.json";
import enKb from "@knowledge-base/locales/src/en-US/kb.json";
import enSettings from "@knowledge-base/locales/src/en-US/settings.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

import { KbSettingsView } from "@/components/kb/members-panel";
import {
  ShareAcceptCard,
  ShareInvitationView,
  type ShareInvitePreview,
  sharePreviewState,
} from "@/components/kb/share-accept";
import { renderWithTestRouter } from "@/lib/router-test-utils";
import { orpc } from "@/utils/orpc";

const KB = "k".repeat(24);
const REQUEST = "11111111-1111-4111-8111-111111111111";
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

const wrap = (node: React.ReactNode, client = new QueryClient()) =>
  renderWithTestRouter(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>{node}</I18nextProvider>
    </QueryClientProvider>,
  );
const escaped = (text: string) => text.replaceAll("'", "&#x27;");
const preview: ShareInvitePreview = {
  kbId: KB,
  kbName: "Team notes",
  inviterName: "Ana",
  bits: ["read", "propose"],
};
const idle = { isPending: false, isSuccess: false, error: null };
const a = enKb.settings.accept;

describe("share invitation acceptance", () => {
  it("names who invited you to which KB, with the permissions in words", () => {
    const html = wrap(
      <ShareInvitationView
        lang="en-US"
        preview={{ status: "ready", preview }}
        accept={idle}
        onAccept={() => {}}
      />,
    );
    expect(html).toContain("Ana invited you to Team notes");
    expect(html).toContain(escaped(enSettings.credentials.picker.bits.read.description));
    expect(html).toContain(escaped(enSettings.credentials.picker.bits.propose.description));
    expect(html).not.toContain(escaped(enSettings.credentials.picker.bits.manage.description));
    expect(html).toContain('data-testid="share-accept-submit"');
    expect(html).toContain(a.shareAction);
  });

  it("answers every unusable invitation the same way, with a sign-in hint", () => {
    const gone = wrap(
      <ShareInvitationView
        lang="en-US"
        preview={{ status: "gone" }}
        accept={idle}
        onAccept={() => {}}
      />,
    );
    expect(gone).toContain(a.shareGone);
    expect(gone).toContain(escaped(a.shareGoneHint));
    expect(gone).toContain('href="/en-US/kbs"');
    expect(gone).not.toContain('data-testid="share-accept-submit"');
    // An accept that races a cancel lands on the same message.
    const raced = wrap(
      <ShareInvitationView
        lang="en-US"
        preview={{ status: "ready", preview }}
        accept={{ ...idle, error: { code: "NOT_FOUND" } }}
        onAccept={() => {}}
      />,
    );
    expect(raced).toContain(a.shareGone);
    expect(raced).not.toContain("Team notes");
  });

  it("shows a skeleton while loading and a retry when the preview fails", () => {
    const loading = wrap(
      <ShareInvitationView
        lang="en-US"
        preview={{ status: "pending" }}
        accept={idle}
        onAccept={() => {}}
      />,
    );
    expect(loading).toContain('aria-busy="true"');
    const failed = wrap(
      <ShareInvitationView
        lang="en-US"
        preview={{ status: "failed", retry: () => {} }}
        accept={idle}
        onAccept={() => {}}
      />,
    );
    expect(failed).toContain(escaped(a.previewFailed));
  });

  it("stops showing a loaded invitation once a refetch says it is gone", () => {
    const retry = () => {};
    // Cancelled (or used) after the card loaded: TanStack keeps `data`.
    expect(
      sharePreviewState({ data: preview, error: { code: "NOT_FOUND" }, isPending: false }, retry),
    ).toEqual({ status: "gone" });
    // Signed out / banned (UNAUTHORIZED) or 2FA now required (FORBIDDEN) too.
    for (const code of ["UNAUTHORIZED", "FORBIDDEN"])
      expect(
        sharePreviewState({ data: preview, error: { code }, isPending: false }, retry),
      ).toEqual({
        status: "gone",
      });
    // A transient failure keeps what was loaded.
    expect(
      sharePreviewState({ data: preview, error: new Error("offline"), isPending: false }, retry),
    ).toEqual({ status: "ready", preview });
    expect(sharePreviewState({ data: undefined, error: null, isPending: true }, retry)).toEqual({
      status: "pending",
    });
    expect(
      sharePreviewState({ data: undefined, error: new Error("offline"), isPending: false }, retry),
    ).toEqual({ status: "failed", retry });
  });

  it("reads the preview for the request id", () => {
    const client = new QueryClient();
    client.setQueryData(
      orpc.kbs.shareInvitePreview.queryKey({ input: { requestId: REQUEST } }),
      preview,
    );
    const html = wrap(
      <ShareAcceptCard lang="en-US" requestId={REQUEST} onAccepted={() => {}} />,
      client,
    );
    expect(html).toContain("Ana invited you to Team notes");
    // Cancelled or accepted meanwhile: the next visit reads it anew.
    const query = client
      .getQueryCache()
      .find({ queryKey: orpc.kbs.shareInvitePreview.queryKey({ input: { requestId: REQUEST } }) });
    expect(query?.options.gcTime).toBe(0);
  });

  it("settings opened from an invitation is the invitation card alone", () => {
    const client = new QueryClient();
    client.setQueryData(
      orpc.kbs.shareInvitePreview.queryKey({ input: { requestId: REQUEST } }),
      preview,
    );
    const html = wrap(<KbSettingsView lang="en-US" kbId={KB} accept={REQUEST} />, client);
    expect(html).toContain("Ana invited you to Team notes");
    // No settings body waiting on a KB read the invitee cannot make.
    expect(html).not.toContain('data-testid="kb-settings-unavailable"');
    expect(html).not.toContain(escaped(enKb.settings.loadFailed));
    expect(html).not.toContain('data-slot="skeleton"');
  });
});
