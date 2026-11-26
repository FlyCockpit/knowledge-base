import { describe, expect, it } from "vitest";

import { signupMode } from "./signup-mode";

describe("signupMode", () => {
  it.each([
    [{ signupEnabled: true }, "open"],
    [{ signupEnabled: false, adminBootstrapSignupEnabled: true }, "bootstrap"],
    [{ signupEnabled: false, adminBootstrapSignupEnabled: false }, "closed"],
    [{}, "closed"],
    [{ forceSso: true, signupEnabled: true }, "sso"],
    [{ forceSso: true, adminBootstrapSignupEnabled: true }, "sso"],
  ] as const)("%o is %s", (config, mode) => {
    expect(signupMode(config)).toBe(mode);
  });
});
