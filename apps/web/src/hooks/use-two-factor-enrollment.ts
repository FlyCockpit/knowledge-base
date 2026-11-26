import { toast } from "@knowledge-base/ui/components/sileo";
import { useRef, useState } from "react";

import { authClient } from "@/lib/auth-client";
import { friendly, isCodeRejection } from "@/utils/friendly-error";

/**
 * TOTP enrollment shared by the forced-2FA takeover (`_auth.tsx`) and the
 * security settings page. Each screen keeps its own layout and copy; this owns
 * the request lifecycle (single-flight guard, loading flag, inline field
 * errors, error/success toasts, reload once enabled) and the step machine:
 *
 *   start --begin--> password --enroll--> secret --confirmSaved--> code
 *     ^---------------------- cancel (any step) ----------------------'
 *
 * The takeover shows the secret and the code input together (it verifies from
 * `secret`); settings shows them as two steps. `verify` works from either.
 *
 * A wrong password or a wrong code is said under its field (and the field
 * gets focus, text selected), never only in a toast; it clears on the next
 * edit. Any other verify failure (rate limit, lockout, server, network) is
 * not the code's fault: it is a toast and the code stays as typed, so the
 * same one can be sent again. Cancel is a way back from every step: it
 * returns to `start` and drops the typed password, the code, the errors and
 * the unconfirmed secret; a request still in flight from the cancelled
 * attempt is ignored when it answers. Requests stay one at a time even
 * across Cancel: Better-Auth's enable replaces an unverified secret, so a
 * cancelled enable that wrote last would leave the next attempt's QR code
 * and backup codes invalid. The next Continue therefore waits (loading) for
 * the cancelled request to settle before it sends its own.
 */
export type TwoFactorEnrollmentStep = "start" | "password" | "secret" | "code";

export type TwoFactorEnrollmentEvent = "begin" | "enrolled" | "saved" | "cancel";

/** The step machine above. Every event is valid from any step. */
export function nextTwoFactorStep(
  _step: TwoFactorEnrollmentStep,
  event: TwoFactorEnrollmentEvent,
): TwoFactorEnrollmentStep {
  switch (event) {
    case "begin":
      return "password";
    case "enrolled":
      return "secret";
    case "saved":
      return "code";
    case "cancel":
      return "start";
  }
}

/** Already-translated copy; each screen passes its own namespace's strings. */
export type TwoFactorEnrollmentMessages = {
  startFailed: string;
  enabled: string;
  invalidCode: string;
  /** Better-Auth's `INVALID_PASSWORD` on the confirm-password step. */
  invalidPassword: string;
};

/** The two inputs a server answer can be about. */
export type TwoFactorEnrollmentField = "password" | "code";

export type TwoFactorSecret = { totpURI: string; backupCodes: string[] };

type EnableResult = {
  data?: { method?: string; totpURI?: string; backupCodes?: string[] } | null;
  error?: unknown;
};
type VerifyResult = { error?: unknown };

export type TwoFactorEnrollmentDeps = {
  enable: (input: { password: string; method: "totp" }) => Promise<EnableResult>;
  verifyTotp: (input: { code: string }) => Promise<VerifyResult>;
  setLoading: (loading: boolean) => void;
  toastError: (message: string) => void;
  /** The server's answer about one input, shown under it. */
  fieldError: (field: TwoFactorEnrollmentField, message: string) => void;
  toastSuccess: (message: string) => void;
  logError: (tag: string, error: unknown) => void;
  reload: () => void;
};

/**
 * The request side, free of React so it is unit-testable. One runner per
 * mounted flow: `enroll` and `verify` share one in-flight guard, so a double
 * click or Enter+click never sends a second request. `cancel` ends the
 * current attempt: its answer, when it comes, changes nothing. A request
 * still in flight from a cancelled attempt holds back the next one until it
 * settles, so the server never sees two at once.
 */
export function createTwoFactorEnrollmentRunner(deps: TwoFactorEnrollmentDeps) {
  let pending = false;
  let attempt = 0;
  /** The last request sent, settled or not; null once it has settled. */
  let inflight: Promise<void> | null = null;
  /** Sends a request and remembers it until it settles, cancelled or not. */
  const send = <T>(request: Promise<T>): Promise<T> => {
    const settled = request.then(
      () => undefined,
      () => undefined,
    );
    inflight = settled;
    void settled.then(() => {
      if (inflight === settled) inflight = null;
    });
    return request;
  };
  /**
   * Waits for a cancelled attempt's request to settle; false when this
   * attempt was cancelled meanwhile, so it must not send.
   */
  const settlePrevious = async (current: () => boolean): Promise<boolean> => {
    while (inflight) await inflight;
    return current();
  };
  /** Starts an attempt; the returned check is false once it was cancelled. */
  const begin = () => {
    pending = true;
    const mine = ++attempt;
    deps.setLoading(true);
    return () => mine === attempt;
  };
  const end = (current: () => boolean) => {
    if (!current()) return;
    pending = false;
    deps.setLoading(false);
  };

  return {
    /** Drops the attempt in flight (if any) and frees the guard for a new one. */
    cancel() {
      attempt += 1;
      if (!pending) return;
      pending = false;
      deps.setLoading(false);
    },

    /** The new secret, or null when busy or the server refused. */
    async enroll(
      password: string,
      messages: TwoFactorEnrollmentMessages,
      logScope: string,
    ): Promise<TwoFactorSecret | null> {
      if (pending) return null;
      const current = begin();
      const tag = `[${logScope}.twoFactor.enable]`;
      try {
        if (!(await settlePrevious(current))) return null;
        const result = await send(deps.enable({ password, method: "totp" }));
        // Cancelled meanwhile: the screen is back at its start, keep it there.
        if (!current()) return null;
        if (result.error) {
          deps.logError(tag, result.error);
          if (errorCode(result.error) === "INVALID_PASSWORD") {
            deps.fieldError("password", messages.invalidPassword);
          } else {
            deps.toastError(messages.startFailed);
          }
          return null;
        }
        if (result.data?.method !== "totp") {
          deps.toastError(messages.startFailed);
          return null;
        }
        return {
          totpURI: result.data.totpURI || "",
          backupCodes: result.data.backupCodes || [],
        };
      } catch (error) {
        deps.logError(tag, error);
        if (current()) deps.toastError(messages.startFailed);
        return null;
      } finally {
        end(current);
      }
    },

    /** Verifies a six-digit code; reloads the app once 2FA is enabled. */
    async verify(
      code: string,
      messages: TwoFactorEnrollmentMessages,
      logScope: string,
    ): Promise<void> {
      if (pending || code.length !== 6) return;
      const current = begin();
      const tag = `[${logScope}.twoFactor.verifyTotp]`;
      try {
        if (!(await settlePrevious(current))) return;
        const result = await send(deps.verifyTotp({ code }));
        if (result.error) {
          deps.logError(tag, result.error);
          if (!current()) return;
          // Only a wrong or expired code goes under the field; a rate limit,
          // a lockout or a server failure is not the code's fault, and the
          // same code can be sent again.
          if (isCodeRejection(result.error)) deps.fieldError("code", messages.invalidCode);
          else deps.toastError(friendly(result.error));
          return;
        }
        // 2FA is on now even if the screen was cancelled meanwhile: reload
        // so the app sees the account as it is.
        deps.toastSuccess(messages.enabled);
        deps.reload();
      } catch (error) {
        deps.logError(tag, error);
        if (current()) deps.toastError(friendly(error));
      } finally {
        end(current);
      }
    },
  };
}

function errorCode(error: unknown): unknown {
  return error && typeof error === "object" && "code" in error ? error.code : undefined;
}

export function useTwoFactorEnrollment(options: {
  /** Console tag prefix, e.g. `_auth` → `[_auth.twoFactor.enable]`. */
  logScope: string;
  messages: TwoFactorEnrollmentMessages;
}) {
  const { logScope, messages } = options;
  const [step, setStep] = useState<TwoFactorEnrollmentStep>("start");
  const [password, setPassword] = useState("");
  const [verifyCode, setVerifyCode] = useState("");
  const [secret, setSecret] = useState<TwoFactorSecret>({ totpURI: "", backupCodes: [] });
  const [isLoading, setIsLoading] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  // Created once per mounted flow so the in-flight guard survives re-renders.
  const [runner] = useState(() =>
    createTwoFactorEnrollmentRunner({
      enable: (input) => authClient.twoFactor.enable(input),
      verifyTotp: (input) => authClient.twoFactor.verifyTotp(input),
      setLoading: setIsLoading,
      toastError: (message) => toast.error(message),
      fieldError: (field, message) => {
        (field === "password" ? setPasswordError : setCodeError)(message);
        const input = (field === "password" ? passwordRef : codeRef).current;
        input?.focus();
        input?.select();
      },
      toastSuccess: (message) => toast.success(message),
      logError: (tag, error) => console.error(tag, error),
      reload: () => window.location.reload(),
    }),
  );

  return {
    step,
    password,
    setPassword: (next: string) => {
      setPassword(next);
      setPasswordError(null);
    },
    passwordError,
    passwordRef,
    verifyCode,
    setVerifyCode: (next: string) => {
      setVerifyCode(next);
      setCodeError(null);
    },
    codeError,
    codeRef,
    totpURI: secret.totpURI,
    backupCodes: secret.backupCodes,
    isLoading,
    begin: () => setStep((current) => nextTwoFactorStep(current, "begin")),
    cancel: () => {
      runner.cancel();
      setStep((current) => nextTwoFactorStep(current, "cancel"));
      setPassword("");
      setVerifyCode("");
      setPasswordError(null);
      setCodeError(null);
      setSecret({ totpURI: "", backupCodes: [] });
    },
    confirmSaved: () => setStep((current) => nextTwoFactorStep(current, "saved")),
    enroll: async () => {
      const next = await runner.enroll(password, messages, logScope);
      if (next) {
        setSecret(next);
        setStep((current) => nextTwoFactorStep(current, "enrolled"));
      }
    },
    verify: () => runner.verify(verifyCode, messages, logScope),
  };
}
