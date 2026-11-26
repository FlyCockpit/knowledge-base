import type { Ref } from "react";
import { useTranslation } from "react-i18next";

import { PlainField } from "@/components/auth/plain-field";

/**
 * The "confirm your password to start 2FA setup" step body, shared by the
 * required-2FA screen (`_auth.tsx`) and Settings → Security. The call sites
 * own the buttons (their layouts differ).
 *
 * The passwordless hint ("signed in with SSO and have no password? leave it
 * empty") only makes sense when SSO is on (`appConfig.ssoEnabled`); without
 * SSO every account has a password, and the hint would only confuse.
 */
export function TwoFactorPasswordConfirm({
  id,
  prompt,
  ssoEnabled,
  password,
  error,
  inputRef,
  onPasswordChange,
  onSubmit,
}: {
  id: string;
  prompt: string;
  ssoEnabled: boolean;
  password: string;
  /** Wrong password, said under the field; null when there is none. */
  error: string | null;
  inputRef?: Ref<HTMLInputElement>;
  onPasswordChange: (password: string) => void;
  onSubmit: () => void;
}) {
  const { t } = useTranslation("auth");
  return (
    <>
      <p className="text-sm text-muted-foreground">{prompt}</p>
      {ssoEnabled && (
        <p className="text-sm text-muted-foreground">{t("twoFactor.passwordlessPrompt")}</p>
      )}
      <PlainField
        id={id}
        label={t("fields.password")}
        error={error}
        inputRef={inputRef}
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => onPasswordChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSubmit();
        }}
      />
    </>
  );
}
