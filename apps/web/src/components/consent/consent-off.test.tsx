import enConsent from "@knowledge-base/locales/src/en-US/consent.json";
import { createInstance } from "i18next";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

import { ConsentBanner } from "@/components/consent/consent-banner";
import { ConsentPreferencesButton } from "@/components/consent/consent-preferences-button";
import { ConsentPreferencesSection } from "@/components/consent/consent-preferences-section";
import { PublicFooter } from "@/components/public-footer";
import { analyticsConfigured } from "@/lib/analytics";

/**
 * The shipped default: no analytics provider, so no consent UI anywhere. There
 * is nothing to consent to (strictly necessary cookies need none), so no
 * banner, no Cookie preferences in the public footer or in Settings, and,
 * with no banner mounted, nothing publishes `--consent-inset`, so the shells
 * reserve no space (their classes: consent-clearance-shells.test.tsx). The
 * switch-on behaviour is pinned by the other consent tests, which mock
 * `analyticsConfigured` to true. An app that sets a provider skips this file's
 * assertions (the default is what they check).
 */
describe.runIf(!analyticsConfigured)("with no analytics provider (the default)", () => {
  const i18n = createInstance();

  beforeAll(async () => {
    await i18n.init({
      lng: "en-US",
      fallbackLng: "en-US",
      ns: ["consent"],
      defaultNS: "consent",
      resources: { "en-US": { consent: enConsent } },
      interpolation: { escapeValue: false },
      react: { useSuspense: false },
    });
  });

  const render = (node: ReactNode): string =>
    renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);

  it("renders no banner, so nothing reserves its height", () => {
    // Undecided (the server snapshot) is exactly when a banner would show.
    expect(render(<ConsentBanner />)).toBe("");
  });

  it("offers no Cookie preferences, in the public footer or in Settings", () => {
    expect(render(<ConsentPreferencesButton />)).toBe("");
    expect(render(<ConsentPreferencesSection />)).toBe("");
    const footer = render(<PublicFooter />);
    expect(footer).toMatch(/^<footer\b[^>]*\bdata-public-footer/);
    expect(footer).not.toContain("<button");
    expect(footer).not.toContain(enConsent.preferences.open);
  });
});
