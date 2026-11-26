import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isTwoFactorCodeReady,
  rejectedCodeMessageKey,
  sendCodeFailureToast,
  twoFactorChallengeFailure,
  verifyTwoFactorChallenge,
} from "./two-factor-challenge";

vi.mock("../i18n", () => ({ default: { t: (key: string) => key } }));

function client() {
  return {
    verifyTotp: vi.fn(async () => ({})),
    verifyOtp: vi.fn(async () => ({})),
    verifyBackupCode: vi.fn(async () => ({})),
  };
}

describe("two-factor challenge", () => {
  it("sends a backup code, trimmed, to the backup-code endpoint", async () => {
    const c = client();
    await verifyTwoFactorChallenge(c, "backup", "  uHCkz-bpJg6 ");
    expect(c.verifyBackupCode).toHaveBeenCalledWith({ code: "uHCkz-bpJg6" });
    expect(c.verifyTotp).not.toHaveBeenCalled();
    expect(c.verifyOtp).not.toHaveBeenCalled();
  });

  it("keeps TOTP and emailed codes on their own endpoints", async () => {
    const c = client();
    await verifyTwoFactorChallenge(c, "totp", "123456");
    await verifyTwoFactorChallenge(c, "otp", "654321");
    expect(c.verifyTotp).toHaveBeenCalledWith({ code: "123456" });
    expect(c.verifyOtp).toHaveBeenCalledWith({ code: "654321" });
    expect(c.verifyBackupCode).not.toHaveBeenCalled();
  });

  it("accepts a full backup code, not only six digits", () => {
    expect(isTwoFactorCodeReady("backup", "uHCkz-bpJg6")).toBe(true);
    expect(isTwoFactorCodeReady("backup", "   ")).toBe(false);
    expect(isTwoFactorCodeReady("totp", "uHCkz-bpJg6")).toBe(false);
    expect(isTwoFactorCodeReady("totp", "123456")).toBe(true);
    expect(isTwoFactorCodeReady("otp", "12345")).toBe(false);
  });
});

describe("two-factor challenge: a refused code", () => {
  it("puts a wrong or expired code under the field, in the mode's words", () => {
    expect(rejectedCodeMessageKey("totp", { status: 401, code: "INVALID_CODE" })).toBe(
      "auth:errors.invalidTotp",
    );
    expect(rejectedCodeMessageKey("otp", { status: 401, code: "OTP_HAS_EXPIRED" })).toBe(
      "auth:errors.invalidEmailCode",
    );
    expect(rejectedCodeMessageKey("backup", { status: 401, code: "INVALID_BACKUP_CODE" })).toBe(
      "auth:errors.invalidBackupCode",
    );
  });

  it("sends a rate limit, a lockout, a server or network failure to a toast", () => {
    for (const error of [
      { status: 429, code: "TOO_MANY_REQUESTS" },
      { status: 403, code: "ACCOUNT_TEMPORARILY_LOCKED" },
      { status: 401, code: "INVALID_TWO_FACTOR_COOKIE" },
      { status: 503 },
      new TypeError("Failed to fetch"),
    ])
      expect(rejectedCodeMessageKey("totp", error)).toBeNull();
  });
});

describe("two-factor challenge: what the page shows", () => {
  it("a code rejection goes under the field", () => {
    expect(
      twoFactorChallengeFailure("backup", { status: 401, code: "INVALID_BACKUP_CODE" }),
    ).toEqual({ codeErrorKey: "auth:errors.invalidBackupCode" });
  });

  it("a server failure toasts the server copy, never the invalid-code copy", () => {
    expect(twoFactorChallengeFailure("totp", { status: 503 })).toEqual({
      toast: "errors:serverError",
    });
  });

  it("a thrown error toasts the generic copy", () => {
    expect(twoFactorChallengeFailure("otp", new Error("boom"))).toEqual({
      toast: "errors:generic",
    });
  });
});

describe("two-factor challenge: email me a code", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("an error answer says the code could not be sent; a rate limit says to wait", () => {
    expect(sendCodeFailureToast({ status: 500 }, "answer")).toBe("auth:twoFactor.couldNotSendCode");
    expect(sendCodeFailureToast({ status: 429, code: "TOO_MANY_REQUESTS" }, "answer")).toBe(
      "errors:rateLimited",
    );
  });

  it("a rejected request names the network problem, never leaving it unhandled", () => {
    vi.stubGlobal("navigator", { onLine: false });
    expect(sendCodeFailureToast(new TypeError("Failed to fetch"), "thrown")).toBe("errors:offline");
    vi.stubGlobal("navigator", { onLine: true });
    expect(sendCodeFailureToast(new TypeError("Failed to fetch"), "thrown")).toBe(
      "errors:unreachable",
    );
  });

  it("any other thrown error falls back to the could-not-send copy", () => {
    expect(sendCodeFailureToast(new Error("boom"), "thrown")).toBe(
      "auth:twoFactor.couldNotSendCode",
    );
  });
});
