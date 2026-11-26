import i18n from "@/i18n";
import { friendly, isCodeRejection, isRateLimit } from "@/utils/friendly-error";

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

const REJECTED_CODE_MESSAGE = {
  totp: "auth:errors.invalidTotp",
  otp: "auth:errors.invalidEmailCode",
  backup: "auth:errors.invalidBackupCode",
} as const;

/**
 * Where a refused verification is said. A wrong or expired code goes under the
 * code field: the returned key is that mode's copy. Anything else (rate limit,
 * lockout, an expired 2FA session, server or network trouble) is not the
 * code's fault: null, and the caller toasts `friendly(error)` and keeps the
 * code as typed so the same one can be sent again.
 */
export function rejectedCodeMessageKey(
  mode: TwoFactorChallengeMode,
  error: unknown,
): (typeof REJECTED_CODE_MESSAGE)[TwoFactorChallengeMode] | null {
  return isCodeRejection(error) ? REJECTED_CODE_MESSAGE[mode] : null;
}

/**
 * What the page does with a refused verification (an error answer or a
 * thrown one): the code field's message key, or a toast. The toast is
 * `friendly()` with its own generic fallback, never the "code didn't work"
 * copy, because the code was not what failed.
 */
export function twoFactorChallengeFailure(
  mode: TwoFactorChallengeMode,
  error: unknown,
): { codeErrorKey: (typeof REJECTED_CODE_MESSAGE)[TwoFactorChallengeMode] } | { toast: string } {
  const codeErrorKey = rejectedCodeMessageKey(mode, error);
  return codeErrorKey ? { codeErrorKey } : { toast: friendly(error) };
}

/**
 * The toast for a failed "email me a code" request. An error answer is the
 * "couldn't send a code" copy (a rate limit says when to try again). A
 * rejected request (server unreachable, offline) goes through `friendly()`,
 * which names the network problem, with that copy as the fallback.
 */
export function sendCodeFailureToast(error: unknown, how: "answer" | "thrown"): string {
  const couldNotSend = i18n.t("auth:twoFactor.couldNotSendCode");
  if (how === "thrown") return friendly(error, couldNotSend);
  return isRateLimit(error) ? friendly(error) : couldNotSend;
}
