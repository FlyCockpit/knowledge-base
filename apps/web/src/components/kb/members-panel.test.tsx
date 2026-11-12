import enCommon from "@knowledge-base/locales/src/en-US/common.json";
import enKb from "@knowledge-base/locales/src/en-US/kb.json";
import { QueryClient } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

import {
  describeControlError,
  InviteResult,
  inviteAcceptHref,
  isAcceptRequestGone,
  kbSettingsTabs,
  MemberRowsView,
  memberControls,
  memberLabel,
  refreshAfterAcceptance,
  refreshAfterMemberEdit,
  shareableUrl,
  transferAcceptHref,
} from "@/components/kb/members-panel";

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

describe("neutral share invitation feedback", () => {
  it("renders identical feedback for a known and an unknown address (request id aside)", () => {
    // The server answers {accepted:true, requestId} for both; the view never sees the address.
    const known = wrap(
      <InviteResult href={inviteAcceptHref("en-US", KB, "11111111-1111-4111-8111-111111111111")} />,
    );
    const unknown = wrap(
      <InviteResult href={inviteAcceptHref("en-US", KB, "22222222-2222-4222-8222-222222222222")} />,
    );
    const mask = (html: string) => html.replace(/[0-9a-f-]{36}/g, "<id>");
    expect(mask(known)).toBe(mask(unknown));
    expect(known).not.toMatch(/no account|not found|unknown|exists/i);
  });

  it("says an email invitation was queued and keeps the copyable link as a fallback", () => {
    const html = wrap(
      <InviteResult href={inviteAcceptHref("en-US", KB, "11111111-1111-4111-8111-111111111111")} />,
    );
    expect(html).toContain(enKb.settings.members.inviteResult);
    expect(enKb.settings.members.inviteResult).toMatch(/email/i);
    expect(html).toContain(enKb.settings.members.inviteLink);
    expect(html).toContain(`/en-US/kbs/${KB}/settings?accept=11111111-1111-4111-8111-111111111111`);
    expect(enKb.settings.members.transferRequested).toMatch(/email/i);
  });

  it("builds acceptance links on the KB settings page", () => {
    expect(inviteAcceptHref("en-US", KB, "r1")).toBe(`/en-US/kbs/${KB}/settings?accept=r1`);
    expect(transferAcceptHref("es-MX", KB, "r2")).toBe(`/es-MX/kbs/${KB}/settings?transfer=r2`);
  });

  it("copies acceptance links as absolute URLs on this origin", () => {
    expect(shareableUrl(inviteAcceptHref("en-US", KB, "r1"), "https://kb.example")).toBe(
      `https://kb.example/en-US/kbs/${KB}/settings?accept=r1`,
    );
    // Without an origin (server render) the path is kept as is.
    expect(shareableUrl("/en-US/x", "")).toBe("/en-US/x");
  });
});

describe("member controls", () => {
  it("hides every member action without manage", () => {
    expect(memberControls(["read", "propose", "write", "review"], true)).toEqual({
      canManage: false,
      canTransfer: false,
      canSetSealed: false,
    });
    expect(memberControls(["read", "manage"], true)).toEqual({
      canManage: true,
      canTransfer: true,
      canSetSealed: true,
    });
  });

  it("transfer is owner-only; a non-owner manager keeps invite/revoke only", () => {
    expect(memberControls(["read", "manage"], false)).toEqual({
      canManage: true,
      canTransfer: false,
      canSetSealed: false,
    });
    const members = [
      {
        shareId: "s1",
        userId: "user-one",
        name: "",
        invitedEmail: null,
        bits: ["read"],
        includeSealedValues: false,
        createdAt: "2026-01-01T00:00:00Z",
      },
    ];
    const manager = wrap(
      <MemberRowsView
        members={members}
        canManage
        canTransfer={false}
        onRevoke={() => {}}
        onTransfer={() => {}}
      />,
    );
    expect(manager).toContain('data-testid="member-revoke"');
    expect(manager).not.toContain('data-testid="member-transfer"');
  });

  it("lists accepted members by display name, with edit and revoke for managers and transfer for the owner", () => {
    const members = [
      {
        shareId: "s1",
        userId: "user-one",
        name: "Ada Lovelace",
        invitedEmail: "ada@example.test",
        bits: ["read"],
        includeSealedValues: false,
        createdAt: "2026-01-01T00:00:00Z",
      },
    ];
    const managed = wrap(
      <MemberRowsView
        members={members}
        canManage
        canTransfer
        onEdit={() => {}}
        onRevoke={() => {}}
        onTransfer={() => {}}
      />,
    );
    expect(managed).toContain("Ada Lovelace");
    expect(managed).toContain('aria-label="Edit permissions for Ada Lovelace"');
    // R2-19: repeated row actions name their member.
    expect(managed).toContain('aria-label="Revoke Ada Lovelace"');
    expect(managed).toContain('aria-label="Transfer ownership to Ada Lovelace"');
    expect(managed).not.toContain("(you)");
    // R2-22: the caller's own row is marked.
    expect(
      wrap(
        <MemberRowsView
          members={members}
          selfUserId="user-one"
          canManage
          onRevoke={() => {}}
          onTransfer={() => {}}
        />,
      ),
    ).toContain("(you)");
    expect(managed).toContain("Invited as ada@example.test");
    // People, not raw ids.
    expect(managed).not.toContain("User user-one");
    expect(managed).toContain('data-testid="member-revoke"');
    expect(managed).toContain('data-testid="member-transfer"');
    const readOnly = wrap(
      <MemberRowsView
        members={members}
        canManage={false}
        onRevoke={() => {}}
        onTransfer={() => {}}
      />,
    );
    expect(readOnly).not.toContain('data-testid="member-revoke"');
    expect(readOnly).not.toContain('data-testid="member-edit"');
    expect(readOnly).not.toContain('data-testid="member-transfer"');
  });
});

describe("memberLabel", () => {
  it("falls back to the id only when the member has no display name", () => {
    const t = (_key: string, options: { id: string }) => `User ${options.id}`;
    expect(memberLabel({ name: " Grace ", userId: "u1" }, t)).toBe("Grace");
    expect(memberLabel({ name: "  ", userId: "u1" }, t)).toBe("User u1");
  });
});

describe("include sealed values toggle", () => {
  const members = [
    {
      shareId: "s1",
      userId: "user-one",
      name: "",
      invitedEmail: null,
      bits: ["read", "manage"],
      includeSealedValues: false,
      createdAt: "2026-01-01T00:00:00Z",
    },
    {
      shareId: "s2",
      userId: "user-two",
      name: "",
      invitedEmail: null,
      bits: ["read"],
      includeSealedValues: true,
      createdAt: "2026-01-01T00:00:00Z",
    },
  ];
  it("shows the owner one labelled toggle per member reflecting the stored value", () => {
    const owner = wrap(
      <MemberRowsView
        members={members}
        canManage
        canTransfer
        canSetSealed
        onRevoke={() => {}}
        onTransfer={() => {}}
        onSetSealed={() => {}}
      />,
    );
    const toggles = owner.match(/data-testid="member-sealed-toggle"[^>]*>/g) ?? [];
    expect(toggles).toHaveLength(2);
    expect(toggles[0]).not.toContain("checked");
    expect(toggles[1]).toContain("checked");
    expect(owner).toContain(enKb.settings.members.includeSealedValues);
  });
  it("shows only the in-flight row at its requested value, disabled, and the stored value otherwise", () => {
    const render = (sealedPending: boolean) =>
      (
        wrap(
          <MemberRowsView
            members={members}
            canManage
            canTransfer
            canSetSealed
            sealedPending={sealedPending}
            sealedRequest={{ userId: "user-one", includeSealedValues: true }}
            onRevoke={() => {}}
            onTransfer={() => {}}
            onSetSealed={() => {}}
          />,
        ).match(/data-testid="member-sealed-toggle"[^>]*>/g) ?? []
      ).map((tag) => tag.replace(/aria-busy="[a-z]+"/, ""));
    const pending = render(true);
    expect(pending[0]).toMatch(/checked=""/);
    expect(pending[0]).toMatch(/disabled=""/);
    expect(pending[1]).toMatch(/checked=""/);
    // Settled (success refetched or refused): the listed server value wins.
    const settled = render(false);
    expect(settled[0]).not.toMatch(/checked=""/);
    expect(settled[1]).toMatch(/checked=""/);
  });
  it("never shows the toggle to a non-owner manager or a reader", () => {
    for (const canManage of [true, false]) {
      const html = wrap(
        <MemberRowsView
          members={members}
          canManage={canManage}
          canSetSealed={false}
          onRevoke={() => {}}
          onTransfer={() => {}}
          onSetSealed={() => {}}
        />,
      );
      expect(html).not.toContain('data-testid="member-sealed-toggle"');
    }
  });
});

describe("server denial handling", () => {
  it("maps oRPC codes to localized control states", () => {
    expect(describeControlError({ code: "FORBIDDEN" })).toBe("denied");
    expect(describeControlError({ code: "NOT_FOUND" })).toBe("denied");
    expect(describeControlError({ code: "CONFLICT" })).toBe("conflict");
    expect(describeControlError({ code: "BAD_REQUEST" })).toBe("invalid");
    expect(describeControlError({ code: "TOO_MANY_REQUESTS" })).toBe("retry");
    expect(describeControlError(new TypeError("network"))).toBe("retry");
  });

  it("an accepted membership change drops this KB's cached content and controls, not other KBs', and re-reads its kbs.get in place", async () => {
    const client = new QueryClient();
    const other = "o".repeat(24);
    client.setQueryData([["kbs", "get"], { input: { kbId: KB }, type: "query" }], { kb: {} });
    client.setQueryData([["kbs", "shareList"], { input: { kbId: KB }, type: "infinite" }], {});
    client.setQueryData([["kbIndex", "profile"], { input: { kbId: KB }, type: "query" }], {});
    client.setQueryData([["documents", "get"], { input: { kbId: KB }, type: "query" }], {});
    client.setQueryData([["kbs", "get"], { input: { kbId: other }, type: "query" }], { kb: {} });
    client.setQueryData([["embeddingProviders", "listMine"], { type: "infinite" }], {});
    await refreshAfterAcceptance(client, KB);
    const left = client
      .getQueryCache()
      .getAll()
      .map((q) => JSON.stringify(q.queryKey));
    // R2-11: kbs.get stays (invalidated) so the mounted header and tabs refetch.
    expect(left.filter((k) => k.includes(KB))).toEqual([
      JSON.stringify([["kbs", "get"], { input: { kbId: KB }, type: "query" }]),
    ]);
    expect(
      client.getQueryState([["kbs", "get"], { input: { kbId: KB }, type: "query" }])?.isInvalidated,
    ).toBe(true);
    expect(left.some((k) => k.includes(other))).toBe(true);
    expect(left.some((k) => k.includes("listMine"))).toBe(true);
  });

  it("re-reads the KB's live bits after a member edit, so a manager who drops their own manage loses the controls", async () => {
    const client = new QueryClient();
    const other = "o".repeat(24);
    const get = [["kbs", "get"], { input: { kbId: KB }, type: "query" }];
    const otherGet = [["kbs", "get"], { input: { kbId: other }, type: "query" }];
    const list = [["kbs", "list"], { input: { limit: 20 }, type: "infinite" }];
    const members = [["kbs", "shareList"], { input: { kbId: KB }, type: "infinite" }];
    for (const key of [get, otherGet, list, members]) client.setQueryData(key, {});
    await refreshAfterMemberEdit(client, KB);
    expect(client.getQueryState(get)?.isInvalidated).toBe(true);
    expect(client.getQueryState(list)?.isInvalidated).toBe(true);
    expect(client.getQueryState(members)?.isInvalidated).toBe(true);
    expect(client.getQueryState(otherGet)?.isInvalidated).toBe(false);
  });
});

describe("KB settings tabs", () => {
  it("offers each tab only to the bits that can use it", () => {
    expect(kbSettingsTabs({ capabilities: ["read", "manage"], isOwner: true })).toEqual([
      "members",
      "search",
      "sealed",
      "mirror",
    ]);
    // A non-owner manager: no sealed values.
    expect(kbSettingsTabs({ capabilities: ["read", "manage"], isOwner: false })).toEqual([
      "members",
      "search",
      "mirror",
    ]);
    // A reader sees the index status only.
    expect(kbSettingsTabs({ capabilities: ["read", "write"], isOwner: false })).toEqual(["search"]);
  });
});

describe("acceptance of a request that no longer exists (R2-21)", () => {
  it("treats NOT_FOUND as used or replaced, not as a permissions error", () => {
    expect(isAcceptRequestGone({ code: "NOT_FOUND" })).toBe(true);
    expect(isAcceptRequestGone({ data: { code: "NOT_FOUND" } })).toBe(true);
    // Wrong recipient is a real permissions problem and keeps the denied copy.
    expect(isAcceptRequestGone({ code: "FORBIDDEN" })).toBe(false);
    expect(describeControlError({ code: "FORBIDDEN" })).toBe("denied");
    expect(isAcceptRequestGone(null)).toBe(false);
    expect(enKb.settings.accept.shareGone).toMatch(/already used or replaced/);
  });
});
