import { describe, expect, it } from "vitest";

import {
  grantAttemptSignature,
  grantBlocker,
  grantPayload,
  groupConsumers,
  manualKey,
  nextGrantAttempt,
  revokeGrantPayload,
  SEALED_DEFAULT_EXPIRY,
  SEALED_PLAINTEXT_MAX_BYTES,
  type SealedConsumer,
  type SealedGrant,
  type SealedKey,
  sealedExpiryFromChoice,
  sealedLabelIssue,
  sealedValueIssue,
  switchConsumerDraft,
  tokenEndsFirst,
  utf8ByteLength,
} from "./sealed-logic";

const NOW = new Date("2026-09-26T00:00:00Z");
const KEY = {
  recipientKeyId: "22222222-2222-4222-8222-222222222222",
  recipientPublicKey: `${"A".repeat(43)}=`,
};
const REFERENCE =
  "{{sealed:v1:knowledge_base:00000000-0000-5000-8000-000000000000:11111111-1111-4111-8111-111111111111}}";
const consumer = (over: Partial<SealedConsumer> = {}): SealedConsumer => ({
  consumerKind: "pat",
  consumerId: "33333333-3333-4333-8333-333333333333",
  name: "Deploy token",
  holder: { kind: "self" },
  expiresAt: "2027-09-26T00:00:00.000Z",
  createdAt: "2026-09-01T00:00:00.000Z",
  problems: [],
  recipientKey: { ...KEY, source: "device" },
  ...over,
});

describe("add secret bounds", () => {
  it("counts UTF-8 bytes against the 16 KiB cap", () => {
    expect(SEALED_PLAINTEXT_MAX_BYTES).toBe(16384);
    expect(utf8ByteLength("é")).toBe(2);
    expect(sealedValueIssue("")).toBe("required");
    expect(sealedValueIssue("a".repeat(16384))).toBeNull();
    expect(sealedValueIssue("é".repeat(8193))).toBe("tooLong");
  });
  it("requires a short single-line name", () => {
    expect(sealedLabelIssue("  ")).toBe("required");
    expect(sealedLabelIssue("Stripe key")).toBeNull();
    expect(sealedLabelIssue("x".repeat(121))).toBe("tooLong");
    expect(sealedLabelIssue("two\nlines")).toBe("invalid");
  });
});

describe("expiry presets", () => {
  it("defaults to the existing 30-day policy and adds whole days", () => {
    expect(SEALED_DEFAULT_EXPIRY).toBe("30");
    expect(sealedExpiryFromChoice("1", "", NOW)?.toISOString()).toBe("2026-09-27T00:00:00.000Z");
    expect(sealedExpiryFromChoice("365", "", NOW)?.toISOString()).toBe("2027-09-26T00:00:00.000Z");
  });
  it("accepts only a valid future custom date", () => {
    expect(sealedExpiryFromChoice("custom", "", NOW)).toBeNull();
    expect(sealedExpiryFromChoice("custom", "2020-01-01T00:00", NOW)).toBeNull();
    expect(sealedExpiryFromChoice("custom", "2027-02-30T10:00", NOW)).toBeNull();
    expect(sealedExpiryFromChoice("custom", "2027-01-01T10:00", NOW)).not.toBeNull();
  });
});

describe("a useless grant is refused before submit", () => {
  const expiresAt = new Date(NOW.getTime() + 86_400_000);
  it("needs a token first", () => {
    expect(grantBlocker({ consumer: null, key: KEY, expiresAt, now: NOW })).toBe("chooseToken");
  });
  it("refuses a token that cannot read sealed values on this KB", () => {
    for (const problem of [
      "missing_sealed_tool_group",
      "missing_read_scope",
      "no_read_on_kb",
      "holder_not_eligible",
    ] as const)
      expect(
        grantBlocker({
          consumer: consumer({ problems: [problem] }),
          key: KEY,
          expiresAt,
          now: NOW,
        }),
      ).toBe("tokenProblem");
  });
  it("refuses a token without a key and an end date in the past", () => {
    expect(
      grantBlocker({ consumer: consumer({ recipientKey: null }), key: null, expiresAt, now: NOW }),
    ).toBe("needKey");
    expect(grantBlocker({ consumer: consumer(), key: KEY, expiresAt: NOW, now: NOW })).toBe(
      "expiry",
    );
    expect(grantBlocker({ consumer: consumer(), key: KEY, expiresAt: null, now: NOW })).toBe(
      "expiry",
    );
    expect(grantBlocker({ consumer: consumer(), key: KEY, expiresAt, now: NOW })).toBeNull();
  });
  it("refuses approving the same token and key twice, but allows another key or token", () => {
    const chosen = consumer();
    const existing = [{ consumerId: chosen.consumerId, recipientKeyId: KEY.recipientKeyId }];
    expect(grantBlocker({ consumer: chosen, key: KEY, expiresAt, now: NOW, existing })).toBe(
      "alreadyGranted",
    );
    const otherKey = { ...KEY, recipientKeyId: "00000000-0000-4000-8000-000000000001" };
    expect(
      grantBlocker({ consumer: chosen, key: otherKey, expiresAt, now: NOW, existing }),
    ).toBeNull();
    const other = consumer({ consumerId: "00000000-0000-4000-8000-000000000002" });
    expect(grantBlocker({ consumer: other, key: KEY, expiresAt, now: NOW, existing })).toBeNull();
  });
});

describe("grant attempts", () => {
  it("an unchanged retry resends the frozen request; a change builds a new one under a new key", () => {
    const builds: boolean[] = [];
    let n = 0;
    const build = (renewKey: boolean) => {
      builds.push(renewKey);
      n += 1;
      return { expiresAt: `t${n}`, idempotencyKey: renewKey ? `k${n}` : "k0" };
    };
    const first = nextGrantAttempt(null, "A", build);
    expect(first?.payload).toEqual({ expiresAt: "t1", idempotencyKey: "k0" });
    // Retry with the same values, later: identical request, nothing rebuilt.
    expect(nextGrantAttempt(first, "A", build)).toBe(first);
    expect(builds).toEqual([false]);
    // A changed form gets a new request and a new idempotency key.
    const second = nextGrantAttempt(first, "B", build);
    expect(second?.payload).toEqual({ expiresAt: "t2", idempotencyKey: "k2" });
    expect(builds).toEqual([false, true]);
    // A refused build (useless grant) sends nothing.
    expect(nextGrantAttempt(second, "C", () => null)).toBeNull();
  });
  it("an attempt's identity follows the shown key's id and bytes, not where it was found", () => {
    const values = { consumerId: "a", keyId: "", publicKey: "", expiry: "30" };
    const manual = grantAttemptSignature(values, KEY);
    expect(grantAttemptSignature(values, { ...KEY, source: "approved" } as SealedKey)).toBe(manual);
    expect(
      grantAttemptSignature(values, {
        ...KEY,
        recipientKeyId: "00000000-0000-4000-8000-0000000000aa",
      }),
    ).not.toBe(manual);
    expect(grantAttemptSignature(values, null)).not.toBe(manual);
  });
  it("switching tokens clears a manually entered key; re-picking the same token keeps it", () => {
    const draft = { consumerId: "a", keyId: "id-a", publicKey: "pk-a", expiry: "30" };
    expect(switchConsumerDraft(draft, "a")).toBe(draft);
    expect(switchConsumerDraft(draft, "b")).toEqual({
      consumerId: "b",
      keyId: "",
      publicKey: "",
      expiry: "30",
    });
  });
});

describe("token list order", () => {
  it("groups by holder and puts tokens that would work first, keeping server order otherwise", () => {
    const a = consumer({ consumerId: "a", problems: ["no_read_on_kb"] });
    const b = consumer({ consumerId: "b" });
    const c = consumer({ consumerId: "c", holder: { kind: "member", name: "M" } });
    const d = consumer({ consumerId: "d" });
    const { own, members } = groupConsumers([a, b, c, d]);
    expect(own.map((x) => x.consumerId)).toEqual(["b", "d", "a"]);
    expect(members.map((x) => x.consumerId)).toEqual(["c"]);
  });
});

describe("grant payload", () => {
  it("auto-fills the chosen token's registered key and names exactly one record", () => {
    const chosen = consumer();
    const payload = grantPayload({
      kbId: "k".repeat(24),
      reference: REFERENCE,
      consumer: chosen,
      key: chosen.recipientKey!,
      expiresAt: new Date("2026-10-26T00:00:00.123Z"),
      idempotencyKey: "a".repeat(32),
    });
    expect(payload).toEqual({
      kbId: "k".repeat(24),
      idempotencyKey: "a".repeat(32),
      reference: REFERENCE,
      consumerKind: "pat",
      consumerId: chosen.consumerId,
      recipientKeyId: KEY.recipientKeyId,
      recipientPublicKey: KEY.recipientPublicKey,
      expiresAt: "2026-10-26T00:00:00.123Z",
    });
  });
  it("validates a manually entered key", () => {
    expect(
      manualKey(` ${KEY.recipientKeyId.toUpperCase()} `, ` ${KEY.recipientPublicKey} `),
    ).toEqual(KEY);
    expect(manualKey("*", KEY.recipientPublicKey)).toBeNull();
    expect(manualKey(KEY.recipientKeyId, "short")).toBeNull();
  });
  it("notes when the token ends before the access does", () => {
    const end = new Date("2028-01-01T00:00:00Z");
    expect(tokenEndsFirst(consumer(), end)).toBe(true);
    expect(tokenEndsFirst(consumer({ expiresAt: null }), end)).toBe(false);
    expect(tokenEndsFirst(consumer(), new Date("2027-01-01T00:00:00Z"))).toBe(false);
  });
  it("groups the owner's tokens apart from members' tokens", () => {
    const member = consumer({ consumerId: "m", holder: { kind: "member", name: "Ana" } });
    expect(groupConsumers([member, consumer()])).toEqual({ own: [consumer()], members: [member] });
  });
});

describe("inline revoke", () => {
  it("removes exactly one approval: record, token and key", () => {
    const grant: SealedGrant = {
      consumerKind: "pat",
      consumerId: "33333333-3333-4333-8333-333333333333",
      recipientKeyId: KEY.recipientKeyId,
      expiresAt: "2026-10-26T00:00:00.000Z",
      createdAt: "2026-09-26T00:00:00.000Z",
      tokenName: "Deploy token",
      holder: { kind: "self" },
      active: true,
    };
    expect(
      revokeGrantPayload({
        kbId: "k".repeat(24),
        reference: REFERENCE,
        grant,
        idempotencyKey: "b".repeat(32),
      }),
    ).toEqual({
      kbId: "k".repeat(24),
      idempotencyKey: "b".repeat(32),
      reference: REFERENCE,
      consumerKind: "pat",
      consumerId: grant.consumerId,
      recipientKeyId: KEY.recipientKeyId,
    });
  });
});
