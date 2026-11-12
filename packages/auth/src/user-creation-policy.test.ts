import { describe, expect, it } from "vitest";

import {
  getAllowedUserCreationMode,
  getUserCreationBlockReason,
  runWithAllowedUserCreation,
  SIGNUP_DISABLED_MESSAGE,
} from "./user-creation-policy";

describe("user creation policy context", () => {
  it("is unset by default", () => {
    expect(getAllowedUserCreationMode()).toBeUndefined();
  });

  it("preserves the creation mode across async work", async () => {
    await runWithAllowedUserCreation("admin-bootstrap", async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(getAllowedUserCreationMode()).toBe("admin-bootstrap");
    });
    expect(getAllowedUserCreationMode()).toBeUndefined();
  });
});

describe("signup-disabled decision", () => {
  it("blocks only when signup is disabled and no creation mode is set", () => {
    expect(getUserCreationBlockReason({ signupEnabled: false })).toBe(SIGNUP_DISABLED_MESSAGE);
    expect(getUserCreationBlockReason({ signupEnabled: true })).toBeNull();
  });

  it("allows every creation mode through when signup is disabled (bootstrap + invite)", () => {
    for (const mode of ["admin-bootstrap", "admin-invite"] as const) {
      runWithAllowedUserCreation(mode, () => {
        expect(getUserCreationBlockReason({ signupEnabled: false })).toBeNull();
      });
    }
  });

  it("keeps the stable message the admin-invite error translation matches on", () => {
    expect(SIGNUP_DISABLED_MESSAGE).toMatch(/sign-?up.*disabled/i);
  });
});
