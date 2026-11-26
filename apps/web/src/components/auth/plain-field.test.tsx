import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { OneTimeCodeField, PlainField } from "./plain-field";

const inputOf = (html: string) => html.match(/<input[^>]*>/)?.[0] ?? "";

describe("PlainField", () => {
  it("without an error: no aria-invalid, nothing described, no alert", () => {
    const html = renderToStaticMarkup(
      <PlainField id="pw" label="Password" error={null} autoComplete="current-password" />,
    );
    expect(inputOf(html)).not.toContain('aria-invalid="');
    expect(inputOf(html)).not.toContain("aria-describedby");
    expect(html).not.toContain('role="alert"');
  });

  it("with an error: the message sits under the field, announced and wired to the input", () => {
    const html = renderToStaticMarkup(
      <PlainField
        id="pw"
        label="Password"
        error="That password doesn't match. Try again."
        autoComplete="current-password"
      />,
    );
    const input = inputOf(html);
    expect(input).toContain('aria-invalid="true"');
    expect(input).toContain('aria-describedby="pw-error"');
    expect(html).toMatch(
      /<div id="pw-error" role="alert"><p[^>]*>That password doesn(&#x27;|')t match\. Try again\.<\/p><\/div>/,
    );
    // Label → input pairing.
    expect(html).toContain('for="pw"');
  });
});

describe("OneTimeCodeField", () => {
  it("is a six-digit one-time-code input with the error wired in", () => {
    const html = renderToStaticMarkup(
      <OneTimeCodeField
        id="totp-code"
        label="Verification Code"
        value="123456"
        error="That code didn't work."
        onValueChange={vi.fn()}
        onComplete={vi.fn()}
      />,
    );
    const input = inputOf(html);
    expect(input).toContain('inputMode="numeric"');
    expect(input).toContain('autoComplete="one-time-code"');
    expect(input).toContain('maxLength="6"');
    expect(input).toContain('aria-invalid="true"');
    expect(input).toContain('aria-describedby="totp-code-error"');
  });
});
