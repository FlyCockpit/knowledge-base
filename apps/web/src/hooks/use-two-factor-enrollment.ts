import { toast } from "@knowledge-base/ui/components/sileo";
import { useState } from "react";

import { authClient } from "@/lib/auth-client";

/**
 * TOTP enrollment shared by the forced-2FA takeover (`_auth.tsx`) and the
 * security settings page. Each screen keeps its own layout and copy; this owns
 * the request lifecycle (single-flight guard, loading flag, error/success
 * toasts, reload once enabled) and the step machine:
 *
 *   start --begin--> password --enroll--> secret --confirmSaved--> code
 *     ^---------------------- cancel (any step) ----------------------'
 *
 * The takeover shows the secret and the code input together (it verifies from
 * `secret`); settings shows them as two steps. `verify` works from either.
 */
export type TwoFactorEnrollmentStep = "start" | "password" | "secret" | "code";

export type TwoFactorEnrollmentEvent = "begin" | "enrolled" | "saved" | "cancel";

/** The step machine above. Every event is valid from any step (as before). */
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
};

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
  toastSuccess: (message: string) => void;
  logError: (tag: string, error: unknown) => void;
  reload: () => void;
};

/**
 * The request side, free of React so it is unit-testable. One runner per
 * mounted flow: `enroll` and `verify` share one in-flight guard, so a double
 * click or Enter+click never sends a second request.
 */
export function createTwoFactorEnrollmentRunner(deps: TwoFactorEnrollmentDeps) {
  let pending = false;

  return {
    /** The new secret, or null when busy or the server refused. */
    async enroll(
      password: string,
      messages: TwoFactorEnrollmentMessages,
      logScope: string,
    ): Promise<TwoFactorSecret | null> {
      if (pending) return null;
      pending = true;
      deps.setLoading(true);
      const tag = `[${logScope}.twoFactor.enable]`;
      try {
        const result = await deps.enable({ password, method: "totp" });
        if (result.error) {
          deps.logError(tag, result.error);
          deps.toastError(messages.startFailed);
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
        deps.toastError(messages.startFailed);
        return null;
      } finally {
        pending = false;
        deps.setLoading(false);
      }
    },

    /** Verifies a six-digit code; reloads the app once 2FA is enabled. */
    async verify(
      code: string,
      messages: TwoFactorEnrollmentMessages,
      logScope: string,
    ): Promise<void> {
      if (pending || code.length !== 6) return;
      pending = true;
      deps.setLoading(true);
      const tag = `[${logScope}.twoFactor.verifyTotp]`;
      try {
        const result = await deps.verifyTotp({ code });
        if (result.error) {
          deps.logError(tag, result.error);
          deps.toastError(messages.invalidCode);
          return;
        }
        deps.toastSuccess(messages.enabled);
        deps.reload();
      } catch (error) {
        deps.logError(tag, error);
        deps.toastError(messages.invalidCode);
      } finally {
        pending = false;
        deps.setLoading(false);
      }
    },
  };
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
  // Created once per mounted flow so the in-flight guard survives re-renders.
  const [runner] = useState(() =>
    createTwoFactorEnrollmentRunner({
      enable: (input) => authClient.twoFactor.enable(input),
      verifyTotp: (input) => authClient.twoFactor.verifyTotp(input),
      setLoading: setIsLoading,
      toastError: (message) => toast.error(message),
      toastSuccess: (message) => toast.success(message),
      logError: (tag, error) => console.error(tag, error),
      reload: () => window.location.reload(),
    }),
  );

  return {
    step,
    password,
    setPassword,
    verifyCode,
    setVerifyCode,
    totpURI: secret.totpURI,
    backupCodes: secret.backupCodes,
    isLoading,
    begin: () => setStep((current) => nextTwoFactorStep(current, "begin")),
    // Keeps the typed password, as both screens always have.
    cancel: () => setStep((current) => nextTwoFactorStep(current, "cancel")),
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
