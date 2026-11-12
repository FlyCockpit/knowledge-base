import { describe, expect, it } from "vitest";

import { renderInviteUser } from "./invite-user";

describe("renderInviteUser", () => {
  const baseArgs = {
    name: "Jane Doe",
    email: "jane@example.com",
    setPasswordUrl: "https://example.com/en-US/reset-password?token=abc&invite=1",
    expiresInHours: 72,
  };

  it("returns the en-US bundle for locale='en-US'", () => {
    const { subject, html } = renderInviteUser({ ...baseArgs, locale: "en-US" });

    expect(subject).toBe("You've been invited");
    expect(html).toContain('<html lang="en-US">');
    expect(html).toContain("You've been invited");
    expect(html).toContain("Jane Doe");
    expect(html).toContain("jane@example.com");
    expect(html).toContain("https://example.com/en-US/reset-password?token=abc&amp;invite=1");
    expect(html).toContain("Email"); // label
    expect(html).toContain("Set your password"); // CTA
    expect(html).toContain("expires in 72 hours");
    // An invitation never carries a password.
    expect(html).not.toMatch(/temporary password/i);
  });

  it("returns the Spanish bundle for locale='es-MX'", () => {
    const { subject, html } = renderInviteUser({ ...baseArgs, locale: "es-MX" });

    expect(subject).not.toBe("");
    expect(html).toContain('<html lang="es-MX">');
    // The user-supplied data passes through the body regardless of locale.
    expect(html).toContain("Jane Doe");
    expect(html).toContain("jane@example.com");
    expect(html).toContain("https://example.com/en-US/reset-password?token=abc&amp;invite=1");
    expect(html).toContain("72 horas");
    // The en-US CTA literal should not survive (would indicate fallback to
    // en-US per-key, i.e. unpopulated bundle).
    expect(html).not.toContain("Set your password");
  });

  it("falls back to en-US for an unsupported locale", () => {
    const { subject, html } = renderInviteUser({ ...baseArgs, locale: "fr-FR" });

    expect(subject).toBe("You've been invited");
    expect(html).toContain('<html lang="en-US">');
    expect(html).toContain("Set your password");
  });

  it("HTML-escapes user-provided values to defeat injection", () => {
    const { html } = renderInviteUser({
      ...baseArgs,
      name: '<script>alert("xss")</script>',
      email: 'evil"@example.com',
      locale: "en-US",
    });

    expect(html).not.toContain('<script>alert("xss")</script>');
    expect(html).toContain("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;");
    expect(html).toContain("evil&quot;@example.com");
  });

  it("escapes sign-in href attribute values", () => {
    const { html } = renderInviteUser({
      ...baseArgs,
      setPasswordUrl: "https://example.com/login?email=jane%40example.com&next=%2Fadmin",
      locale: "en-US",
    });

    expect(html).toContain(
      'href="https://example.com/login?email=jane%40example.com&amp;next=%2Fadmin"',
    );
  });

  it("rejects non-http sign-in URLs", () => {
    expect(() =>
      renderInviteUser({
        ...baseArgs,
        setPasswordUrl: "data:text/html,<script>alert(1)</script>",
        locale: "en-US",
      }),
    ).toThrow("Email link must use HTTP or HTTPS.");
  });
});
