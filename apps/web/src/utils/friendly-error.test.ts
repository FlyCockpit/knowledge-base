import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../i18n", () => ({ default: { t: (key: string) => key } }));

const { friendly, isCodeRejection, isCredentialRejection } = await import("./friendly-error");

afterEach(() => vi.unstubAllGlobals());

describe("friendly: network failures say what to do", () => {
  it("maps a failed request while offline to the offline copy, over any fallback", () => {
    vi.stubGlobal("navigator", { onLine: false });
    expect(friendly(new TypeError("Failed to fetch"), "Couldn't save.")).toBe("errors:offline");
  });

  it("maps a failed fetch while online to the unreachable copy", () => {
    vi.stubGlobal("navigator", { onLine: true });
    expect(friendly(new TypeError("Failed to fetch"))).toBe("errors:unreachable");
  });

  it("keeps mapping server answers by code, offline or not", () => {
    vi.stubGlobal("navigator", { onLine: false });
    expect(friendly({ status: 409, code: "CONFLICT" })).toBe("errors:conflict");
  });
});

describe("isCredentialRejection: only a wrong email or password is a field error", () => {
  it("is true for Better-Auth's wrong-credentials answer", () => {
    expect(isCredentialRejection({ status: 401, code: "INVALID_EMAIL_OR_PASSWORD" })).toBe(true);
  });

  it("is false for any other 401, such as a session that failed after correct credentials", () => {
    expect(isCredentialRejection({ status: 401, code: "FAILED_TO_CREATE_SESSION" })).toBe(false);
    expect(isCredentialRejection({ status: 401 })).toBe(false);
  });

  it("is false for server errors, rate limits and network failures", () => {
    expect(isCredentialRejection({ status: 500, code: "INTERNAL_SERVER_ERROR" })).toBe(false);
    expect(isCredentialRejection({ status: 502 })).toBe(false);
    expect(isCredentialRejection({ status: 429, code: "TOO_MANY_REQUESTS" })).toBe(false);
    expect(isCredentialRejection(new TypeError("Failed to fetch"))).toBe(false);
    expect(isCredentialRejection(undefined)).toBe(false);
  });
});

describe("friendly without a fallback: the toast for a failure that is not the user's input", () => {
  it("never says the code or the credentials were wrong", () => {
    // The 2FA verify paths and the sign-in toast call friendly(err) with no
    // fallback for anything that is not a code or credential rejection.
    expect(friendly({ status: 503 })).toBe("errors:serverError");
    expect(friendly({ status: 401, code: "FAILED_TO_CREATE_SESSION" })).toBe("errors:sessionEnded");
    expect(friendly(new Error("boom"))).toBe("errors:generic");
  });
});

describe("isCodeRejection: only a wrong or expired code is a code-field error", () => {
  it("is true for Better-Auth's code rejections", () => {
    expect(isCodeRejection({ status: 401, code: "INVALID_CODE" })).toBe(true);
    expect(isCodeRejection({ status: 401, code: "INVALID_BACKUP_CODE" })).toBe(true);
    expect(isCodeRejection({ status: 401, code: "OTP_HAS_EXPIRED" })).toBe(true);
  });

  it("is false for rate limits, lockouts, an expired 2FA session and failures", () => {
    expect(isCodeRejection({ status: 429, code: "TOO_MANY_REQUESTS" })).toBe(false);
    expect(isCodeRejection({ status: 403, code: "ACCOUNT_TEMPORARILY_LOCKED" })).toBe(false);
    expect(isCodeRejection({ status: 401, code: "INVALID_TWO_FACTOR_COOKIE" })).toBe(false);
    expect(isCodeRejection({ status: 503 })).toBe(false);
    expect(isCodeRejection(new TypeError("Failed to fetch"))).toBe(false);
  });
});

describe("friendly: account ownership conflict", () => {
  it("uses the stable wire reason without exposing the server message", () => {
    expect(
      friendly({
        code: "CONFLICT",
        data: { reason: "owns_knowledge_bases" },
        message: "raw private detail",
      }),
    ).toBe("errors:ownsKnowledgeBases");
    expect(friendly({ status: 409, data: { reason: "owns_knowledge_bases" } })).toBe(
      "errors:ownsKnowledgeBases",
    );
  });

  it("keeps unrelated conflicts generic and ignores ownership text in messages", () => {
    for (const data of [undefined, null, "owns_knowledge_bases", { reason: "other" }]) {
      expect(friendly({ code: "CONFLICT", data, message: "owns_knowledge_bases" })).toBe(
        "errors:conflict",
      );
    }
    expect(friendly({ code: "BAD_REQUEST", data: { reason: "owns_knowledge_bases" } })).toBe(
      "errors:badRequest",
    );
  });
});
