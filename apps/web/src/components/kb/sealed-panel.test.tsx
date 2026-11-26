import enCommon from "@knowledge-base/locales/src/en-US/common.json";
import enKb from "@knowledge-base/locales/src/en-US/kb.json";
import esKb from "@knowledge-base/locales/src/es-MX/kb.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import type { ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";
import {
  SealedConsumerList,
  SealedKeyFound,
  SealedKeySteps,
  SealedNoConsumers,
} from "@/components/kb/sealed/sealed-grant-dialog";
import type { SealedConsumer, SealedValue } from "@/components/kb/sealed/sealed-logic";
import {
  SealedEmptyState,
  SealedPanel,
  SealedReferenceReveal,
  SealedValueList,
  sealedControls,
} from "@/components/kb/sealed-panel";
import { renderWithTestRouter } from "@/lib/router-test-utils";

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
const render = (node: ReactNode) =>
  renderWithTestRouter(
    <QueryClientProvider client={new QueryClient()}>
      <I18nextProvider i18n={i18n}>{node}</I18nextProvider>
    </QueryClientProvider>,
  );

const NOW = new Date("2026-09-26T00:00:00Z");
const KB_ID = "k".repeat(24);
const REFERENCE =
  "{{sealed:v1:knowledge_base:00000000-0000-5000-8000-000000000000:11111111-1111-4111-8111-111111111111}}";
const KEY_ID = "22222222-2222-4222-8222-222222222222";
const value = (over: Partial<SealedValue> = {}): SealedValue => ({
  recordId: "11111111-1111-4111-8111-111111111111",
  reference: REFERENCE,
  label: "Stripe key",
  createdAt: "2026-09-01T12:00:00.000Z",
  grants: [
    {
      consumerKind: "pat",
      consumerId: "33333333-3333-4333-8333-333333333333",
      recipientKeyId: KEY_ID,
      expiresAt: "2026-10-26T00:00:00.000Z",
      createdAt: "2026-09-26T00:00:00.000Z",
      tokenName: "Deploy token",
      holder: { kind: "self" },
      active: true,
    },
    {
      consumerKind: "pat",
      consumerId: "44444444-4444-4444-8444-444444444444",
      recipientKeyId: KEY_ID,
      expiresAt: "2026-09-01T00:00:00.000Z",
      createdAt: "2026-08-26T00:00:00.000Z",
      tokenName: "Ana laptop",
      holder: { kind: "member", name: "Ana" },
      active: false,
    },
  ],
  moreGrants: 2,
  ...over,
});
const consumer = (over: Partial<SealedConsumer> = {}): SealedConsumer => ({
  consumerKind: "pat",
  consumerId: "33333333-3333-4333-8333-333333333333",
  name: "Deploy token",
  holder: { kind: "self" },
  expiresAt: "2027-09-26T00:00:00.000Z",
  createdAt: "2026-09-01T00:00:00.000Z",
  problems: [],
  recipientKey: {
    recipientKeyId: KEY_ID,
    recipientPublicKey: `${"A".repeat(43)}=`,
    source: "device",
  },
  ...over,
});
const noop = () => {};
const list = (values: SealedValue[], usage: Parameters<typeof SealedValueList>[0]["usage"]) =>
  render(
    <SealedValueList
      values={values}
      usage={usage}
      usageState={{ status: "ready" }}
      kbId={KB_ID}
      lang="en-US"
      now={NOW}
      onGiveAccess={noop}
      onRevokeGrant={noop}
      onDelete={noop}
    />,
  );

describe("sealed values list", () => {
  it("shows each value's name, date, reference, documents and tokens", () => {
    const html = list(
      [value()],
      [{ recordId: value().recordId, paths: ["ops/payments.md"], more: true }],
    );
    expect(html).toContain("Stripe key");
    expect(html).toContain("Added Sep 1, 2026");
    expect(html).toContain(REFERENCE);
    expect(html).toContain(`/en-US/kbs/${KB_ID}/documents?path=ops%2Fpayments.md`);
    expect(html).toContain("…and more documents");
    expect(html).toContain("Deploy token");
    expect(html).toContain("You");
    expect(html).toContain("Ana");
    expect(html).toContain('data-testid="sealed-grant-inactive"');
    expect(html).toContain("and 2 more");
    expect(html.match(/data-testid="sealed-grant-revoke"/g)).toHaveLength(2);
    expect(html).toContain('data-testid="sealed-give-access"');
    expect(html).toContain('data-testid="sealed-delete"');
  });
  it("says what to do next when a value is unused and nobody can read it", () => {
    const html = list(
      [value({ label: null, grants: [], moreGrants: 0 })],
      [{ recordId: value().recordId, paths: [], more: false }],
    );
    expect(html).toContain("Unnamed value");
    expect(html).toContain("Not used in any document yet");
    expect(html).toContain("No token can read it yet");
  });
  it("an unfinished document scan says it couldn't check, never that the value is unused", () => {
    const html = render(
      <SealedValueList
        values={[value()]}
        usage={[{ recordId: value().recordId, paths: [], more: false }]}
        usageState={{ status: "error", onRetry: noop }}
        kbId={KB_ID}
        lang="en-US"
        now={NOW}
        onGiveAccess={noop}
        onRevokeGrant={noop}
        onDelete={noop}
      />,
    );
    expect(html).toContain("Couldn&#x27;t check which documents use this value.");
    expect(html).not.toContain("Not used in any document yet");
  });
  it("never renders a secret field in the list", () => {
    const html = list([value()], []);
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("plaintext");
  });
  it("explains sealed values with an example when there are none", () => {
    const html = render(<SealedEmptyState onAdd={noop} />);
    expect(html).toContain("keep secrets such as API keys out of your documents");
    expect(html).toContain("{{sealed:v1:…}}");
    expect(html).toContain('data-testid="sealed-add"');
  });
});

describe("give access", () => {
  it("lists own tokens and members' tokens; a token that cannot work is disabled with what to do", () => {
    const html = render(
      <SealedConsumerList
        consumers={[
          consumer(),
          consumer({
            consumerId: "55555555-5555-4555-8555-555555555555",
            name: "Read-only token",
            problems: ["missing_sealed_tool_group"],
          }),
          consumer({
            consumerId: "66666666-6666-4666-8666-666666666666",
            name: "Ana laptop",
            holder: { kind: "member", name: "Ana" },
            problems: ["no_read_on_kb"],
          }),
        ]}
        selectedId=""
        onSelect={noop}
        lang="en-US"
        name="sealed-consumer"
      />,
    );
    expect(html).toContain("Your tokens");
    expect(html).toContain("Members&#x27;");
    expect(html).toContain("Ana&#x27;s token");
    expect(html.match(/data-blocked="true"/g)).toHaveLength(2);
    expect(html.match(/disabled=""/g)).toHaveLength(2);
    expect(html).toContain("turn on Sealed values");
    expect(html).toContain("add Read access here");
    expect(html).toContain("/en-US/settings/mcp");
  });
  it("fills in the registered key: nothing to type", () => {
    const html = render(<SealedKeyFound consumer={consumer()} />);
    expect(html).toContain("Decryption key found");
    expect(html).toContain("Key 22222222…");
    expect(html).toContain("signed in with the CLI");
    expect(html).not.toContain("<input");
  });
  it("shows step-by-step key registration for a token without a key", () => {
    const html = render(<SealedKeySteps />);
    expect(html).toContain("kb login --recipient-key-file /path/to/recipient.json");
    expect(html).toContain("private_key");
    expect(render(<SealedNoConsumers lang="en-US" />)).toContain("/en-US/settings/mcp");
  });
});

describe("permission gating", () => {
  it("sealed controls are owner-only — a non-owner manager never sees them", () => {
    expect(sealedControls(["read", "write"], true)).toEqual({ visible: false });
    expect(sealedControls(["read", "manage"], true)).toEqual({ visible: true });
    expect(sealedControls(["read", "propose", "write", "review", "manage"], false)).toEqual({
      visible: false,
    });
    const kb = {
      id: KB_ID,
      capabilities: ["read", "manage"],
      sealedNamespace: "n",
      isOwner: false,
    };
    expect(render(<SealedPanel kb={kb} />)).toBe("");
    const owner = render(<SealedPanel kb={{ ...kb, isOwner: true }} />);
    expect(owner).toContain('data-testid="sealed-panel"');
    // The first page is loading: a skeleton, never an empty state or a form.
    expect(owner).toContain('aria-busy="true"');
    expect(owner).not.toContain("<textarea");
  });
  it("reveals only the opaque reference after saving", () => {
    const html = render(<SealedReferenceReveal reference={REFERENCE} />);
    expect(html).toContain(REFERENCE);
    expect(html).toContain('data-testid="sealed-reference"');
  });
});

describe("locales", () => {
  it("es-MX has every sealed string", () => {
    const keys = (node: unknown, prefix = ""): string[] =>
      typeof node === "object" && node !== null
        ? Object.entries(node).flatMap(([k, v]) => keys(v, `${prefix}${k}.`))
        : [prefix];
    const plural = (k: string) => k.replace(/_(one|other|few|many)\.$/, ".");
    const en = new Set(keys(enKb.settings.sealed).map(plural));
    const es = new Set(keys(esKb.settings.sealed).map(plural));
    expect([...es].sort()).toEqual([...en].sort());
  });
});
