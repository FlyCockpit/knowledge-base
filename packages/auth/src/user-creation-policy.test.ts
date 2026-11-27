import { describe, expect, it } from "vitest";

import {
  getAllowedUserCreationMode,
  getGrantedUserLocale,
  getUserCreationBlockReason,
  refuseUngrantedAdminCreateUser,
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

describe("granted locale", () => {
  it("carries the server-chosen locale only inside its grant", async () => {
    expect(getGrantedUserLocale()).toBeUndefined();
    await runWithAllowedUserCreation(
      "admin-invite",
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(getGrantedUserLocale()).toBe("es-MX");
        expect(getAllowedUserCreationMode()).toBe("admin-invite");
      },
      { locale: "es-MX" },
    );
    await runWithAllowedUserCreation("admin-bootstrap", () => {
      expect(getGrantedUserLocale()).toBeUndefined();
    });
    expect(getGrantedUserLocale()).toBeUndefined();
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

describe("refuseUngrantedAdminCreateUser", () => {
  const codeOf = (fn: () => void) => {
    try {
      fn();
      return null;
    } catch (error) {
      return (error as { body?: { code?: string } }).body?.code ?? "unknown";
    }
  };
  const admin = { path: "/admin/create-user" };

  it("refuses /admin/create-user without the admin-invite grant (an HTTP call)", async () => {
    expect(codeOf(() => refuseUngrantedAdminCreateUser(admin))).toBe(
      "ADMIN_CREATE_USER_UNSUPPORTED",
    );
    await runWithAllowedUserCreation("admin-bootstrap", () => {
      expect(codeOf(() => refuseUngrantedAdminCreateUser(admin))).toBe(
        "ADMIN_CREATE_USER_UNSUPPORTED",
      );
    });
  });

  it("lets users.invite (the grant) and every other path through", async () => {
    await runWithAllowedUserCreation("admin-invite", () => {
      expect(codeOf(() => refuseUngrantedAdminCreateUser(admin))).toBe(null);
    });
    expect(codeOf(() => refuseUngrantedAdminCreateUser({ path: "/sign-up/email" }))).toBe(null);
    expect(codeOf(() => refuseUngrantedAdminCreateUser(null))).toBe(null);
  });
});
