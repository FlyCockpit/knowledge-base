import enConsent from "@knowledge-base/locales/src/en-US/consent.json";
import { createInstance } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

import { ConsentBanner } from "@/components/consent/consent-banner";

/**
 * The properties worth a regression test are legal, not cosmetic: an undecided
 * visitor is asked, and refusing is exactly as prominent as accepting (same
 * variant, same size, same classes). A future "make Accept stand out" tweak is
 * a GDPR dark pattern, and this test is what catches it.
 *
 * Rendered with `renderToStaticMarkup`, so `useSyncExternalStore` takes the
 * server snapshot — which is `null`/undecided by design. The decided case (the
 * banner returns `null`) is covered by the core tests in lib/consent.test.ts.
 */
describe("ConsentBanner", () => {
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

  const html = (): string =>
    renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <ConsentBanner />
      </I18nextProvider>,
    );

  it("asks an undecided visitor, with both choices present", () => {
    const markup = html();
    expect(markup).toContain(enConsent.banner.title);
    expect(markup).toContain(enConsent.banner.message);
    expect(markup).toContain(enConsent.banner.short);
    expect(markup).toContain(enConsent.banner.accept);
    expect(markup).toContain(enConsent.banner.reject);
  });

  // Phones get one short line over the two buttons; the title and full
  // message are for `sm` and up. Both are in the markup, so exactly one of
  // them is visible at any width.
  it("shows the short line only below sm and the full text only from sm", () => {
    const markup = html();
    expect(markup).toContain(`sm:hidden">${enConsent.banner.short}</p>`);
    expect(markup).toMatch(/<div class="hidden [^"]*sm:block[^"]*"><p[^>]*>Cookies on this site</);
  });

  it("puts the two choices side by side at every width, each a 44px target", () => {
    const markup = html();
    expect(markup).toMatch(/<div class="grid grid-cols-2 gap-2 sm:flex sm:justify-end">/);
    const classes = [...markup.matchAll(/<button[^>]*class="([^"]*)"/g)].map((match) => match[1]);
    for (const c of classes) expect(c?.split(" ")).toContain("h-11");
  });

  it("gives Reject and Accept identical visual weight", () => {
    const classes = [...html().matchAll(/<button[^>]*class="([^"]*)"/g)].map((match) => match[1]);
    expect(classes).toHaveLength(2);
    expect(classes[0]).toBe(classes[1]);
  });
});
