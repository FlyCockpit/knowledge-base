import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import type { ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";
import {
  RecipientInvitationRows,
  RecipientInvitations,
} from "@/components/kb/recipient-invitations";
import { renderWithTestRouter } from "@/lib/router-test-utils";
import { orpc } from "@/utils/orpc";

const local = createInstance();
beforeAll(async () => {
  await local.init({
    lng: "en-US",
    ns: ["kb", "common", "errors"],
    defaultNS: "kb",
    resources: {
      "en-US": {
        kb: {
          list: {
            inbox: {
              title: "Pending invitations",
              empty: "No pending invitations.",
              from: "Invited by {{name}}",
              review: "Review invitation",
              failed: "Couldn't load invitations. Try again.",
            },
          },
        },
      },
    },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
});
const invite = {
  kbId: "kb1",
  kbName: "Team notes",
  inviterName: "Ada",
  bits: ["read"] as ["read"],
  requestId: "11111111-1111-4111-8111-111111111111",
};
const html = (node: ReactNode, client = new QueryClient()) =>
  renderWithTestRouter(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={local}>{node}</I18nextProvider>
    </QueryClientProvider>,
  );

describe("recipient invitations", () => {
  it("links the named invitation to the existing localized preview before acceptance", () => {
    const out = html(<RecipientInvitationRows lang="es-MX" items={[invite]} />);
    expect(out).toContain("Team notes");
    expect(out).toContain("Invited by Ada");
    expect(out).toContain(`/es-MX/kbs/kb1/settings?accept=${invite.requestId}`);
    expect(out).toContain("min-h-[44px]");
    expect(out).not.toContain("Resend");
    expect(out).not.toContain("Cancel invitation");
  });

  it("explains an empty inbox", () => {
    expect(html(<RecipientInvitationRows lang="en-US" items={[]} />)).toContain(
      "No pending invitations.",
    );
  });

  it("renders a skeleton before the bounded first page arrives", () => {
    const out = html(<RecipientInvitations lang="en-US" />);
    expect(out).toContain('data-slot="skeleton"');
    expect(out).not.toContain("No pending invitations.");
  });

  it("keeps invitation names during a transient refetch failure", () => {
    const client = new QueryClient();
    const options = orpc.kbs.shareInbox.infiniteOptions({
      input: (_cursor: string | undefined) => ({ limit: 20 }),
      initialPageParam: undefined,
      getNextPageParam: (last) => last?.nextCursor ?? undefined,
    });
    client.setQueryData(options.queryKey, {
      pages: [{ items: [invite], nextCursor: null }],
      pageParams: [undefined],
    });
    client
      .getQueryCache()
      .find({ queryKey: options.queryKey })!
      .setState({ status: "error", error: new Error("Unavailable") });
    expect(html(<RecipientInvitations lang="en-US" />, client)).toContain("Team notes");
  });

  it("hides cached invitation names on access loss", () => {
    const client = new QueryClient();
    const options = orpc.kbs.shareInbox.infiniteOptions({
      input: (_cursor: string | undefined) => ({ limit: 20 }),
      initialPageParam: undefined,
      getNextPageParam: (last) => last?.nextCursor ?? undefined,
    });
    client.setQueryData(options.queryKey, {
      pages: [{ items: [invite], nextCursor: null }],
      pageParams: [undefined],
    });
    expect(html(<RecipientInvitations lang="en-US" />, client)).toContain("Team notes");
    client
      .getQueryCache()
      .find({ queryKey: options.queryKey })!
      .setState({
        status: "error",
        error: Object.assign(new Error("Forbidden"), { code: "FORBIDDEN" }),
      });
    expect(html(<RecipientInvitations lang="en-US" />, client)).not.toContain("Team notes");
  });
});
