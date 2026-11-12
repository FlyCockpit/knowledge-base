import { describe, expect, it } from "vitest";

import { renderResetPassword } from "./reset-password";

describe("renderResetPassword", () => {
  it("returns en-US subject + en-US strings + lang='en-US' for the default locale", () => {
    const { subject, html } = renderResetPassword({
      url: "https://example.com/reset?token=abc",
      locale: "en-US",
    });

    expect(subject).toBe("Reset your password");
    expect(html).toContain('<html lang="en-US">');
    expect(html).toContain("Reset your password");
    expect(html).toContain("Click the button below to choose a new password.");
    expect(html).toContain("https://example.com/reset?token=abc");
  });

  it("returns the Spanish bundle + lang='es-MX' for the es-MX locale", () => {
    const { subject, html } = renderResetPassword({
      url: "https://example.com/reset?token=abc",
      locale: "es-MX",
    });

    // The assertion is on the *shape* of the response, not the exact
    // translation, so the test doesn't break if the Spanish copy is reworded.
    expect(subject).not.toBe("");
    expect(html).toContain('<html lang="es-MX">');
    // Some marker we can confidently expect: the URL we passed in survives.
    expect(html).toContain("https://example.com/reset?token=abc");
    // None of the en-US literals leak into the Spanish render (they would
    // indicate per-key fallback to en-US, i.e. an unpopulated bundle).
    expect(html).not.toContain("Click the button below to choose a new password.");
  });

  it("falls back to en-US when an unsupported locale is passed", () => {
    const { subject, html } = renderResetPassword({
      url: "https://example.com/reset?token=abc",
      locale: "fr-FR",
    });

    expect(subject).toBe("Reset your password");
    expect(html).toContain('<html lang="en-US">');
    expect(html).toContain("Click the button below to choose a new password.");
  });

  it("escapes href attribute values", () => {
    const { html } = renderResetPassword({
      url: "https://example.com/reset?token=abc&next=https%3A%2F%2Fapp.example%2F",
      locale: "en-US",
    });

    expect(html).toContain(
      'href="https://example.com/reset?token=abc&amp;next=https%3A%2F%2Fapp.example%2F"',
    );
  });

  it("rejects non-http reset URLs", () => {
    expect(() =>
      renderResetPassword({
        url: "javascript:alert(1)",
        locale: "en-US",
      }),
    ).toThrow("Email link must use HTTP or HTTPS.");
  });
});
