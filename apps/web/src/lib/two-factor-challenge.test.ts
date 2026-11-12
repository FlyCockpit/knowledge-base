import { describe, expect, it, vi } from "vitest";

import { isTwoFactorCodeReady, verifyTwoFactorChallenge } from "./two-factor-challenge";

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
