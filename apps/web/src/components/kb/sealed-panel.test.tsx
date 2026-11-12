import enCommon from "@knowledge-base/locales/src/en-US/common.json";
import enKb from "@knowledge-base/locales/src/en-US/kb.json";
import { createInstance } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

import {
  SEALED_PLAINTEXT_MAX_BYTES,
  SealedReferenceReveal,
  sealedControls,
  sealedGrantIssues,
  utf8ByteLength,
} from "@/components/kb/sealed-panel";

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

const NOW = Date.parse("2026-09-26T00:00:00Z");
const REFERENCE =
  "{{sealed:v1:knowledge_base:00000000-0000-5000-8000-000000000000:11111111-1111-4111-8111-111111111111}}";
const draft = (over: Record<string, string> = {}) => ({
  reference: REFERENCE,
  consumerKind: "pat",
  consumerId: "33333333-3333-4333-8333-333333333333",
  recipientKeyId: "22222222-2222-4222-8222-222222222222",
  recipientPublicKey: `${"A".repeat(43)}=`,
  expiresAt: "2026-10-26T00:00",
  ...over,
});

describe("sealed input bounds", () => {
  it("counts UTF-8 bytes, not characters, against the 16 KiB cap", () => {
    expect(SEALED_PLAINTEXT_MAX_BYTES).toBe(16384);
    expect(utf8ByteLength("é")).toBe(2);
    expect(utf8ByteLength("a".repeat(16384))).toBe(16384);
  });
});

describe("exact grant selection", () => {
  it("accepts one exact record and one exact recipient key", () => {
    expect(sealedGrantIssues(draft(), NOW)).toEqual([]);
  });
  it("rejects wildcards and missing selections", () => {
    expect(sealedGrantIssues(draft({ reference: "*" }), NOW)).toContain("reference");
    expect(sealedGrantIssues(draft({ reference: "" }), NOW)).toContain("reference");
    expect(sealedGrantIssues(draft({ recipientKeyId: "*" }), NOW)).toContain("recipientKeyId");
    expect(sealedGrantIssues(draft({ recipientPublicKey: "short" }), NOW)).toContain(
      "recipientPublicKey",
    );
    expect(sealedGrantIssues(draft({ consumerId: "a b" }), NOW)).toContain("consumerId");
    expect(sealedGrantIssues(draft({ consumerKind: "any" }), NOW)).toContain("consumerKind");
    expect(sealedGrantIssues(draft({ expiresAt: "2026-01-01T00:00" }), NOW)).toContain("expiresAt");
  });
  it("an OAuth client can never be chosen as a sealed consumer", () => {
    expect(
      sealedGrantIssues(
        draft({ consumerKind: "oauth", consumerId: "33333333-3333-4333-8333-333333333333" }),
        NOW,
      ),
    ).toContain("consumerKind");
  });
  it("rejects a local-store consumer on the remote control plane", () => {
    expect(sealedGrantIssues(draft({ consumerKind: "local" }), NOW)).toContain("consumerKind");
  });
  it("pat consumers must name an exact grant UUID", () => {
    expect(sealedGrantIssues(draft({ consumerKind: "pat", consumerId: "laptop" }), NOW)).toContain(
      "consumerId",
    );
    expect(
      sealedGrantIssues(
        draft({ consumerKind: "pat", consumerId: "33333333-3333-4333-8333-333333333333" }),
        NOW,
      ),
    ).toEqual([]);
  });
});

describe("sealed controls", () => {
  it("are hidden without manage", () => {
    expect(sealedControls(["read", "write"], true)).toEqual({ visible: false });
    expect(sealedControls(["read", "manage"], true)).toEqual({ visible: true });
  });
  it("sealed controls are owner-only — a non-owner manager never sees them", () => {
    expect(sealedControls(["read", "propose", "write", "review", "manage"], false)).toEqual({
      visible: false,
    });
  });
  it("reveals only the opaque reference", () => {
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <SealedReferenceReveal reference={REFERENCE} />
      </I18nextProvider>,
    );
    expect(html).toContain(REFERENCE);
    expect(html).toContain('data-testid="sealed-reference"');
  });
});
