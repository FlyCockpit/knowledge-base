import { describe, expect, it } from "vitest";

import { kbEmailDedupKey, kbEmailDesiredSchema, kbEmailLinks } from "./kb-email";

const requestId = "550e8400-e29b-41d4-a716-446655440000";
const kbId = "abcdefghijklmnopqrstuvwx";

describe("kb email desired payload", () => {
  it("carries ids, origin and locale only — never an address", () => {
    const parsed = kbEmailDesiredSchema.parse({
      template: "share_invite",
      kbId,
      requestId,
      origin: "https://kb.example.com",
      locale: "es-MX",
    });
    expect(parsed).toEqual({
      template: "share_invite",
      kbId,
      requestId,
      origin: "https://kb.example.com",
      locale: "es-MX",
    });
    expect(() => kbEmailDesiredSchema.parse({ ...parsed, email: "someone@example.com" })).toThrow();
    expect(() => kbEmailDesiredSchema.parse({ ...parsed, locale: "fr-FR" })).toThrow();
    expect(() => kbEmailDesiredSchema.parse({ ...parsed, origin: "javascript:x" })).toThrow();
  });

  it("builds the acceptance link and a sign-up link that returns to it", () => {
    expect(
      kbEmailLinks({
        template: "share_invite",
        kbId,
        requestId,
        origin: "https://kb.example.com/",
        locale: "en-US",
      }),
    ).toEqual({
      acceptUrl: `https://kb.example.com/en-US/kbs/${kbId}/settings?accept=${requestId}`,
      signupUrl: `https://kb.example.com/en-US/signup?redirectTo=${encodeURIComponent(
        `/en-US/kbs/${kbId}/settings?accept=${requestId}`,
      )}`,
    });
  });

  it("transfer offers link to the transfer acceptance with no sign-up path", () => {
    expect(
      kbEmailLinks(
        { template: "transfer_offer", kbId, requestId, origin: "https://kb.example.com" },
        "es-MX",
      ),
    ).toEqual({
      acceptUrl: `https://kb.example.com/es-MX/kbs/${kbId}/settings?transfer=${requestId}`,
      signupUrl: null,
    });
  });

  it("dedups per template, request and idempotency key", () => {
    expect(kbEmailDedupKey("share_invite", requestId, "k1")).not.toBe(
      kbEmailDedupKey("share_invite", requestId, "k2"),
    );
    expect(kbEmailDedupKey("share_invite", requestId, "k1")).not.toBe(
      kbEmailDedupKey("transfer_offer", requestId, "k1"),
    );
  });
});
