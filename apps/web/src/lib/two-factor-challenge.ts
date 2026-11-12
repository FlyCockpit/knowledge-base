/**
 * The sign-in 2FA challenge accepts three kinds of code. Each goes to its own
 * Better Auth endpoint: a TOTP from the authenticator app, a code emailed on
 * request, or one of the single-use backup codes shown at enrollment (the only
 * way back in for someone who lost the authenticator and has no mailbox).
 */
export type TwoFactorChallengeMode = "totp" | "otp" | "backup";

type VerifyResult = { error?: unknown };

export type TwoFactorChallengeClient = {
  verifyTotp(input: { code: string }): Promise<VerifyResult>;
  verifyOtp(input: { code: string }): Promise<VerifyResult>;
  verifyBackupCode(input: { code: string }): Promise<VerifyResult>;
};

/** Backup codes are free-form text (e.g. `uHCkz-bpJg6`); the others are 6 digits. */
export function isTwoFactorCodeReady(mode: TwoFactorChallengeMode, code: string): boolean {
  return mode === "backup" ? code.trim().length > 0 : code.length === 6;
}

export function verifyTwoFactorChallenge(
  client: TwoFactorChallengeClient,
  mode: TwoFactorChallengeMode,
  code: string,
): Promise<VerifyResult> {
  if (mode === "backup") return client.verifyBackupCode({ code: code.trim() });
  if (mode === "otp") return client.verifyOtp({ code });
  return client.verifyTotp({ code });
}
