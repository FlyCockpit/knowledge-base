import enAuth from "@knowledge-base/locales/src/en-US/auth.json";
import { createInstance } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { TwoFactorPasswordConfirm } from "./two-factor-password-confirm";

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: "en-US",
    resources: { "en-US": { auth: enAuth } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
});

function render(ssoEnabled: boolean, error: string | null = null) {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <TwoFactorPasswordConfirm
        id="2fa-password"
        prompt="Enter your password to begin setup."
        ssoEnabled={ssoEnabled}
        password=""
        error={error}
        onPasswordChange={vi.fn()}
        onSubmit={vi.fn()}
      />
    </I18nextProvider>,
  );
}

describe("TwoFactorPasswordConfirm", () => {
  it("hides the SSO passwordless hint when SSO is off", () => {
    expect(render(false)).not.toContain("SSO");
  });

  it("shows the SSO passwordless hint when SSO is on", () => {
    expect(render(true)).toContain(enAuth.twoFactor.passwordlessPrompt);
  });

  it("shows a wrong password under the field", () => {
    const html = render(false, enAuth.errors.invalidPassword);
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-describedby="2fa-password-error"');
    expect(html).toContain('role="alert"');
  });
});
