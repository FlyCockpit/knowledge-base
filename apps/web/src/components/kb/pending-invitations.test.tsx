import enCommon from "@knowledge-base/locales/src/en-US/common.json";
import enKb from "@knowledge-base/locales/src/en-US/kb.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  type PendingInvitation,
  PendingInvitationRowsView,
  PendingInvitations,
  pendingInvitationLabel,
} from "@/components/kb/pending-invitations";
import { viewerScopedKey } from "@/hooks/use-viewer-scope";
import { orpc } from "@/utils/orpc";

const VIEWER = "viewer-1";
vi.mock("@/hooks/use-auth-session", () => ({
  useAuthSession: () => ({
    state: { status: "authenticated", session: { user: { id: VIEWER } } },
  }),
}));

const KB = "k".repeat(24);
const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: "en-US",
    fallbackLng: "en-US",
    ns: ["kb", "common"],
    defaultNS: "kb",
    resources: { "en-US": { kb: enKb, common: enCommon } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
});

const wrap = (node: React.ReactNode) =>
  renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);
const p = enKb.settings.members.pendingInvites;

const mine: PendingInvitation = {
  invitationId: "inv-mine",
  email: "ada@example.test",
  inviterName: "Grace",
  invitedByYou: true,
  bits: ["read", "propose", "write"],
  sentAt: "2026-03-04T10:00:00.000Z",
  requestId: "11111111-1111-4111-8111-111111111111",
};
// Sent by another manager, viewed by a manager who is not the owner.
const theirs: PendingInvitation = {
  invitationId: "inv-theirs",
  email: null,
  inviterName: "Ana",
  invitedByYou: false,
  bits: ["read"],
  sentAt: "2026-03-05T10:00:00.000Z",
  requestId: null,
};
const acceptHref = (requestId: string) =>
  `https://kb.example/en-US/kbs/${KB}/settings?accept=${requestId}`;

describe("pending invitations", () => {
  it("shows the address and copyable link only when the server sent them", () => {
    const html = wrap(
      <PendingInvitationRowsView
        invitations={[mine, theirs]}
        acceptHref={acceptHref}
        onResend={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(html).toContain("ada@example.test");
    expect(html).toContain("Sent Mar 4, 2026 by you");
    expect(html).toContain("Read, Propose, Write");
    expect(html).toContain(acceptHref(mine.requestId!));
    // Not the viewer's to see: who sent it, no address and no link.
    expect(html).toContain("Invitation sent by Ana");
    expect(html).toContain("Sent Mar 5, 2026");
    const rows = html.split('data-testid="pending-invitation"').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[1]).not.toContain('data-testid="pending-invitation-link"');
    expect(rows[1]).not.toContain("accept=");
    // Every row offers resend and cancel, named for their row.
    expect(html).toContain('aria-label="Resend invitation: ada@example.test"');
    expect(html).toContain('aria-label="Cancel invitation: Invitation sent by Ana"');
  });

  it("names the owner-visible sender of someone else's invitation", () => {
    const t = (key: string, options: Record<string, string>) => i18n.t(key, options);
    expect(pendingInvitationLabel({ ...theirs, email: "bo@example.test" }, t)).toBe(
      "bo@example.test",
    );
    const html = wrap(
      <PendingInvitationRowsView
        invitations={[{ ...theirs, email: "bo@example.test", requestId: mine.requestId }]}
        acceptHref={acceptHref}
        onResend={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(html).toContain("Sent Mar 5, 2026 by Ana");
  });

  it("reports a resend on its row, and explains a sender who can no longer manage", () => {
    const render = (resend: Parameters<typeof PendingInvitationRowsView>[0]["resend"]) =>
      wrap(
        <PendingInvitationRowsView
          invitations={[mine, theirs]}
          acceptHref={acceptHref}
          resend={resend}
          onResend={() => {}}
          onCancel={() => {}}
        />,
      );
    const sending = render({ invitationId: "inv-mine", status: "pending" });
    expect(sending).toContain(p.resending);
    expect(sending).toMatch(/<button[^>]*disabled=""[^>]*data-testid="pending-invitation-resend"/);
    const sent = render({ invitationId: "inv-theirs", status: "sent" });
    expect(sent.split('data-testid="pending-invitation"')[2]).toContain(p.resent);
    const conflict = render({
      invitationId: "inv-mine",
      status: "failed",
      error: { code: "CONFLICT" },
    });
    expect(conflict).toContain(p.senderGone.replaceAll("'", "&#x27;"));
    const other = render({ invitationId: "inv-mine", status: "failed", error: { code: "x" } });
    expect(other).toContain(enKb.settings.errors.retry.replaceAll("'", "&#x27;"));
  });

  it("offers no resend without SMTP (the copyable link is the delivery)", () => {
    const html = wrap(
      <PendingInvitationRowsView
        invitations={[mine]}
        acceptHref={acceptHref}
        canResend={false}
        onResend={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(html).not.toContain('data-testid="pending-invitation-resend"');
    expect(html).toContain('data-testid="pending-invitation-cancel"');
    expect(html).toContain('data-testid="pending-invitation-link"');
  });

  it("says when nothing is pending", () => {
    const html = wrap(
      <PendingInvitationRowsView
        invitations={[]}
        acceptHref={acceptHref}
        onResend={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(html).toContain(p.empty);
  });

  it("lists the KB's pending page under its heading", () => {
    const client = new QueryClient();
    client.setQueryData(
      viewerScopedKey(
        orpc.kbs.sharePendingList.infiniteKey({
          input: (cursor: string | null) => ({ kbId: KB, limit: 20, cursor }),
          initialPageParam: null,
        }),
        VIEWER,
      ),
      { pages: [{ items: [mine], nextCursor: null }], pageParams: [null] },
    );
    const html = wrap(
      <QueryClientProvider client={client}>
        <PendingInvitations kbId={KB} acceptHref={acceptHref} onDenied={() => {}} />
      </QueryClientProvider>,
    );
    expect(html).toContain(p.title);
    expect(html).toContain("ada@example.test");
    // Cancelling is a plain confirmation: nothing to type.
    expect(html).not.toContain("Type ");
  });
});
