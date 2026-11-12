import enSettings from "@knowledge-base/locales/src/en-US/settings.json";
import { MutationObserver, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  CredentialList,
  editTargetFromGrant,
  editTargetFromToken,
  type GrantRow,
  isPatMintRejection,
  PAT_LIST_QUERY_ROOT,
  PatSecretReveal,
  patExpiresAtFromChoice,
  remainingParts,
  type TokenRow,
  withPatSecretHygiene,
} from "@/components/kb/credential-list";

const SECRET = `kbp_${"0".repeat(16)}_${"S".repeat(43)}`;
const tokens: TokenRow[] = [
  {
    id: "tok1",
    name: "Laptop CLI",
    lookupPrefix: "0123456789abcdef",
    scopes: ["mcp:read"],
    toolGroups: ["read"],
    allowCreate: false,
    createdKbBits: [],
    grantId: "00000000-0000-4000-8000-000000000001",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    expiresAt: new Date("2099-04-01T00:00:00Z"),
    revokedAt: null,
    widenedAt: new Date("2026-03-01T00:00:00Z"),
    elevations: [
      {
        id: "00000000-0000-4000-8000-0000000000e1",
        expiresAt: "2099-04-01T01:00:00.000Z",
        remainingSeconds: 5400,
        toolGroups: ["kb_admin"],
        allowCreate: true,
        createdKbBits: ["read"],
        acl: [{ kbId: "b".repeat(24), bits: ["read"] }],
        kbCount: 1,
      },
    ],
  },
  {
    id: "tok2",
    name: "Old token",
    lookupPrefix: "fedcba9876543210",
    scopes: ["mcp:write"],
    toolGroups: ["read", "edit", "pull_requests"],
    allowCreate: false,
    createdKbBits: [],
    grantId: "00000000-0000-4000-8000-000000000002",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    expiresAt: new Date("2026-04-01T00:00:00Z"),
    revokedAt: new Date("2026-02-01T00:00:00Z"),
    widenedAt: null,
    elevations: [
      {
        id: "00000000-0000-4000-8000-0000000000e2",
        expiresAt: "2099-04-01T01:00:00.000Z",
        remainingSeconds: 60,
        toolGroups: ["edit"],
        allowCreate: false,
        createdKbBits: [],
        acl: [],
        kbCount: 0,
      },
    ],
  },
  {
    id: "tok3",
    name: "Forever",
    lookupPrefix: "aaaaaaaaaaaaaaaa",
    scopes: ["mcp:read"],
    toolGroups: ["read"],
    allowCreate: false,
    createdKbBits: [],
    grantId: "00000000-0000-4000-8000-000000000005",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    expiresAt: null,
    revokedAt: null,
    widenedAt: null,
    elevations: [],
  },
];
const grants: GrantRow[] = [
  {
    id: "00000000-0000-4000-8000-000000000003",
    kind: "OAUTH",
    clientId: "client-xyz",
    clientName: "e2e OAuth agent",
    scopes: ["mcp:read"],
    toolGroups: ["read", "edit", "sealed"],
    allowCreate: false,
    createdKbBits: [],
    createdAt: new Date("2026-01-01T00:00:00Z"),
    revokedAt: null,
    widenedAt: null,
    elevations: [],
    aclSnapshot: "first-inspection",
    aclNextCursor: null,
    acl: [{ kbId: "a".repeat(24), bits: ["read", "review"], name: "Engineering Notes" }],
  },
  {
    id: "00000000-0000-4000-8000-000000000004",
    kind: "OAUTH",
    clientId: "client-empty",
    clientName: null,
    scopes: ["mcp:read"],
    toolGroups: ["read"],
    allowCreate: false,
    createdKbBits: [],
    createdAt: new Date("2026-01-01T00:00:00Z"),
    revokedAt: null,
    widenedAt: null,
    elevations: [],
    aclSnapshot: "first-inspection",
    aclNextCursor: null,
    acl: [],
  },
];

describe("CredentialList", () => {
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

  function html() {
    return renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <I18nextProvider i18n={i18n}>
          <CredentialList
            lang="en-US"
            tokens={tokens}
            grants={grants}
            onCreate={() => undefined}
            onEditToken={() => undefined}
            onEditGrant={() => undefined}
            onRevokeToken={() => undefined}
            onRevokeGrant={() => undefined}
          />
        </I18nextProvider>
      </QueryClientProvider>,
    );
  }

  it("lists own tokens by name and prefix, never a secret", () => {
    const markup = html();
    expect(markup).toContain("Laptop CLI");
    expect(markup).toContain("0123456789abcdef");
    expect(markup).not.toContain("kbp_");
  });

  it("offers revoke only for live credentials", () => {
    const markup = html();
    const revokes = markup.match(new RegExp(`>${enSettings.credentials.revoke}<`, "g")) ?? [];
    // two live PATs + two live grants
    expect(revokes.length).toBe(4);
    expect(markup).toContain(enSettings.credentials.revoked);
  });

  it("offers Edit access only for live, unexpired credentials and marks widened ones", () => {
    const markup = html();
    const edits = markup.match(new RegExp(`>${enSettings.credentials.editAccess}<`, "g")) ?? [];
    // two live unexpired PATs + two live grants
    expect(edits.length).toBe(4);
    expect(markup).toContain("Access widened on");
    expect(markup.match(/Access widened on/g)).toHaveLength(1);
  });

  it("maps token and app rows to the Edit access Sheet's target", () => {
    expect(editTargetFromToken(tokens[2]!)).toEqual({
      grantId: tokens[2]!.grantId,
      kind: "PAT",
      name: "Forever",
      scopes: ["mcp:read"],
      toolGroups: ["read"],
      allowCreate: false,
      createdKbBits: [],
      neverExpires: true,
      activeElevations: 0,
    });
    expect(editTargetFromToken(tokens[0]!).activeElevations).toBe(1);
    expect(editTargetFromGrant(grants[0]!)).toMatchObject({
      grantId: grants[0]!.id,
      kind: "OAUTH",
      name: "e2e OAuth agent",
      neverExpires: false,
    });
  });

  it("lists temporary access with its remaining time and End now, only on live credentials", () => {
    const markup = html();
    expect(markup).toContain(enSettings.credentials.temporary.title);
    const ends =
      markup.match(new RegExp(`>${enSettings.credentials.temporary.endNow}<`, "g")) ?? [];
    // tok1's elevation; the revoked tok2 shows none.
    expect(ends).toHaveLength(1);
    expect(markup).toContain("Ends in 1 hour");
    expect(markup).toContain("Knowledge base admin tools");
    expect(markup).toContain("1 knowledge base");
  });

  it("shows remaining time in its largest whole unit, never below one minute", () => {
    expect(remainingParts(7 * 86_400)).toEqual({ unit: "days", count: 7 });
    expect(remainingParts(86_399)).toEqual({ unit: "hours", count: 23 });
    expect(remainingParts(3600)).toEqual({ unit: "hours", count: 1 });
    expect(remainingParts(61)).toEqual({ unit: "minutes", count: 2 });
    expect(remainingParts(0)).toEqual({ unit: "minutes", count: 1 });
  });

  it("names connected apps and their KBs, keeping the client id visible", () => {
    const markup = html();
    expect(markup).toContain("e2e OAuth agent");
    expect(markup).toContain("Engineering Notes");
    expect(markup).not.toContain("a".repeat(24));
    // Without a registered name the client id is the title.
    expect(markup).toContain("client-empty");
  });

  it("shows each grant's stored ACL and an explicit empty ACL", () => {
    const markup = html();
    expect(markup).toContain("client-xyz");
    expect(markup).toContain(enSettings.credentials.picker.bits.review.label);
    expect(markup).toContain(enSettings.credentials.grantNoKbs);
  });

  it("always offers minting (MCP is always on)", () => {
    expect(html()).toContain(enSettings.credentials.create);
    expect(html()).not.toContain("mcpDisabled");
  });

  it("labels a no-expiry token as never expiring", () => {
    expect(html()).toContain(enSettings.credentials.neverExpires);
  });

  it("reveals the one-time secret with a copy control and a warning", () => {
    const markup = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <PatSecretReveal secret={SECRET} />
      </I18nextProvider>,
    );
    expect(markup).toContain(SECRET);
    expect(markup).toContain(enSettings.credentials.secretOnce);
    expect(markup).toContain('data-slot="copy-field"');
  });
});

describe("PAT expiry choices", () => {
  const now = new Date(2026, 0, 10, 12, 0, 0);
  const DAY = 86_400_000;
  it("maps presets to now+days and No expiry to an explicit null", () => {
    expect(patExpiresAtFromChoice("30", "", now)).toEqual({
      ok: true,
      expiresAt: new Date(now.getTime() + 30 * DAY),
    });
    expect(patExpiresAtFromChoice("90", "", now)).toEqual({
      ok: true,
      expiresAt: new Date(now.getTime() + 90 * DAY),
    });
    expect(patExpiresAtFromChoice("365", "", now)).toEqual({
      ok: true,
      expiresAt: new Date(now.getTime() + 365 * DAY),
    });
    expect(patExpiresAtFromChoice("none", "", now)).toEqual({ ok: true, expiresAt: null });
  });
  it("accepts a custom date from tomorrow up to the 365 day cap and rejects the rest", () => {
    expect(patExpiresAtFromChoice("custom", "2026-01-11", now)).toEqual({
      ok: true,
      expiresAt: new Date(2026, 0, 11),
    });
    const last = new Date(now.getTime() + 365 * DAY);
    const iso = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    expect(patExpiresAtFromChoice("custom", iso(last), now).ok).toBe(true);
    expect(patExpiresAtFromChoice("custom", iso(new Date(last.getTime() + DAY)), now).ok).toBe(
      false,
    );
    expect(patExpiresAtFromChoice("custom", "2026-01-10", now).ok).toBe(false);
    expect(patExpiresAtFromChoice("custom", "", now).ok).toBe(false);
    expect(patExpiresAtFromChoice("custom", "not-a-date", now).ok).toBe(false);
  });
});

describe("PAT secret hygiene", () => {
  it("keeps the raw secret out of the query cache and drops it from the mutation cache on close", async () => {
    vi.useFakeTimers();
    try {
      const queryClient = new QueryClient();
      queryClient.setQueryData([...PAT_LIST_QUERY_ROOT, "page"], { items: tokens });
      const invalidate = vi.spyOn(queryClient, "invalidateQueries");
      const observer = new MutationObserver(
        queryClient,
        withPatSecretHygiene(queryClient, {
          mutationFn: async () => ({
            token: {
              id: "tok3",
              name: "New",
              expiresAt: new Date(),
              lookupPrefix: "0000000000000000",
            },
            secret: SECRET,
          }),
        }),
      );
      const minted = await observer.mutate(undefined);
      expect(minted.secret).toBe(SECRET);
      expect(invalidate).toHaveBeenCalledWith({ queryKey: [...PAT_LIST_QUERY_ROOT] });
      // Nothing in the query cache ever carries the secret.
      expect(
        JSON.stringify(
          queryClient
            .getQueryCache()
            .getAll()
            .map((q) => q.state.data),
        ),
      ).not.toContain(SECRET);
      // Closing the dialog resets the observer; the mutation is garbage-collected at once.
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
});

describe("PAT outcome uncertainty", () => {
  it("domain refusal permits correction, while internal or transport loss does not claim zero effects", () => {
    for (const code of [
      "BAD_REQUEST",
      "UNAUTHORIZED",
      "FORBIDDEN",
      "NOT_FOUND",
      "CONFLICT",
      "TOO_MANY_REQUESTS",
    ])
      expect(isPatMintRejection({ code })).toBe(true);
    expect(isPatMintRejection(new TypeError("Failed to fetch"))).toBe(false);
    expect(isPatMintRejection({ code: "INTERNAL_SERVER_ERROR" })).toBe(false);
  });

  it("refreshes the list after an uncertain mint without writing or replaying a secret", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData([...PAT_LIST_QUERY_ROOT, "page"], { items: [] });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const mint = vi.fn(async () => {
      throw new TypeError("reply lost");
    });
    const observer = new MutationObserver(
      queryClient,
      withPatSecretHygiene(queryClient, { mutationFn: mint }),
    );
    await expect(observer.mutate(undefined)).rejects.toThrow("reply lost");
    expect(mint).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: [...PAT_LIST_QUERY_ROOT] });
    expect(observer.getCurrentResult().data).toBeUndefined();
    observer.reset();
    queryClient.clear();
  });
});
