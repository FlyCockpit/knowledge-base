import { describe, expect, it } from "vitest";
import { withVerificationCallback } from "./verification-callback.js";

const BASE = "https://app.example.com/api/auth/verify-email?token=abc.def.ghi&callbackURL=%2F";

function callbackOf(url: string): string | null {
  return new URL(url).searchParams.get("callbackURL");
}

describe("withVerificationCallback", () => {
  it("points the callback at the locale-prefixed verify-email page", () => {
    expect(callbackOf(withVerificationCallback(BASE, "es-MX"))).toBe("/es-MX/verify-email?ok=1");
  });

  it("marks the destination with ok=1 so a bare visit can't read as success", () => {
    // The page treats absence of `ok` as "we know nothing about your state".
    // Better-Auth appends its failure code with `&` when the callbackURL
    // already carries a query string, so a failed hop arrives as
    // `?ok=1&error=<CODE>` and `error` is what the page keys off.
    const callback = callbackOf(withVerificationCallback(BASE, "en-US"));
    expect(callback).toBe("/en-US/verify-email?ok=1");
  });

  it("preserves the token", () => {
    const url = new URL(withVerificationCallback(BASE, "en-US"));
    expect(url.searchParams.get("token")).toBe("abc.def.ghi");
    expect(url.pathname).toBe("/api/auth/verify-email");
  });

  it("falls back to the default locale for unsupported or missing values", () => {
    for (const locale of ["fr-FR", "", undefined, null, 42, "../../evil"]) {
      expect(callbackOf(withVerificationCallback(BASE, locale))).toBe("/en-US/verify-email?ok=1");
    }
  });

  it("replaces Better-Auth's default `/` callbackURL rather than appending a second one", () => {
    const url = new URL(withVerificationCallback(BASE, "en-US"));
    expect(url.searchParams.getAll("callbackURL")).toEqual(["/en-US/verify-email?ok=1"]);
  });

  it("leaves a caller-supplied callbackURL alone", () => {
    // Better-Auth routes the change-email confirmation chain through this same
    // hook, re-encoding the pending destination into a second-hop token URL.
    // Clobbering it would strand that flow on the signup confirmation page.
    const url = new URL(
      withVerificationCallback(
        "https://app.example.com/api/auth/verify-email?token=t&callbackURL=%2Fen-US%2Fsettings",
        "en-US",
      ),
    );
    expect(url.searchParams.getAll("callbackURL")).toEqual(["/en-US/settings"]);
  });

  it("returns the input unchanged when it isn't a parseable URL", () => {
    expect(withVerificationCallback("not a url", "en-US")).toBe("not a url");
  });
});

describe("withVerificationCallback — split-origin deploys", () => {
  // Better-Auth resolves a relative callbackURL against the API host. When the
  // web app lives somewhere else (CORS_ORIGIN set), a relative path lands the
  // user on api.example.com — wrong cookie scope, wrong canonical, and a route
  // the API server doesn't serve.
  const API = "https://api.example.com/api/auth/verify-email?token=t&callbackURL=%2F";

  it("emits an absolute callback on the app origin when one is supplied", () => {
    expect(callbackOf(withVerificationCallback(API, "es-MX", "https://app.example.com"))).toBe(
      "https://app.example.com/es-MX/verify-email?ok=1",
    );
  });

  it("stays relative when no separate app origin is given (same-origin deploy)", () => {
    expect(callbackOf(withVerificationCallback(API, "es-MX"))).toBe("/es-MX/verify-email?ok=1");
  });

  it("resolves a preserved RELATIVE callback against the app origin", () => {
    // Better-Auth would otherwise resolve this against the API host, landing the
    // user on api.example.com/en-US/settings — wrong cookie scope, and a route
    // the API server doesn't serve.
    const url = withVerificationCallback(
      `https://api.example.com/api/auth/verify-email?token=t&callbackURL=${encodeURIComponent("/en-US/settings")}`,
      "en-US",
      "https://app.example.com",
    );
    expect(callbackOf(url)).toBe("https://app.example.com/en-US/settings");
  });

  it("leaves a preserved relative callback alone on a same-origin deploy", () => {
    const url = withVerificationCallback(
      `https://app.example.com/api/auth/verify-email?token=t&callbackURL=${encodeURIComponent("/en-US/settings")}`,
      "en-US",
    );
    expect(callbackOf(url)).toBe("/en-US/settings");
  });

  it("keeps a caller-supplied callback that targets the app origin", () => {
    const url = withVerificationCallback(
      `https://api.example.com/api/auth/verify-email?token=t&callbackURL=${encodeURIComponent("https://app.example.com/en-US/settings")}`,
      "en-US",
      "https://app.example.com",
    );
    expect(callbackOf(url)).toBe("https://app.example.com/en-US/settings");
  });
});

describe("withVerificationCallback — open-redirect guard", () => {
  // `callbackURL` is attacker-reachable via anonymous
  // POST /api/auth/send-verification-email. Better-Auth runs its own originCheck,
  // but this function must not depend on that: a wildcard added to
  // trustedOrigins, or an upstream regression, would otherwise turn a
  // verification email into an open redirect.
  const BASE_URL = "https://app.example.com/api/auth/verify-email?token=t";

  function withCallback(callback: string, appOrigin?: string): string | null {
    return callbackOf(
      withVerificationCallback(
        `${BASE_URL}&callbackURL=${encodeURIComponent(callback)}`,
        "en-US",
        appOrigin,
      ),
    );
  }

  it.each([
    "https://evil.com",
    "http://evil.com/phish",
    "//evil.com",
    "/\\evil.com",
    "/%2fevil.com",
    "/%5cevil.com",
    "javascript:alert(1)",
    "/en-US/settings#@evil.com",
  ])("discards the hostile callback %s", (hostile) => {
    expect(withCallback(hostile)).toBe("/en-US/verify-email?ok=1");
  });

  it("discards a foreign origin even when an app origin is configured", () => {
    expect(withCallback("https://evil.com/en-US/settings", "https://app.example.com")).toBe(
      "https://app.example.com/en-US/verify-email?ok=1",
    );
  });

  it("still preserves legitimate same-origin relative paths", () => {
    expect(withCallback("/en-US/settings")).toBe("/en-US/settings");
    expect(withCallback("/es-MX/settings/security?tab=2fa")).toBe(
      "/es-MX/settings/security?tab=2fa",
    );
  });
});
