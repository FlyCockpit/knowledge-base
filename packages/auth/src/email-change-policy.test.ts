import { describe, expect, it } from "vitest";
import { refuseEmailChange } from "./email-change-policy";

const codeOf = (fn: () => void) => {
  try {
    fn();
    return null;
  } catch (error) {
    return (error as { body?: { code?: string } }).body?.code ?? "unknown";
  }
};

describe("refuseEmailChange", () => {
  it("refuses any Better Auth user update carrying email", () => {
    for (const path of ["/update-user", "/admin/update-user", "/callback/:id", undefined]) {
      expect(codeOf(() => refuseEmailChange({ email: "new@example.com" }, { path }))).toBe(
        "EMAIL_CHANGE_UNSUPPORTED",
      );
    }
  });

  it("refuses an admin-asserted verification", () => {
    expect(
      codeOf(() => refuseEmailChange({ emailVerified: true }, { path: "/admin/update-user" })),
    ).toBe("EMAIL_VERIFICATION_BY_MAIL_ONLY");
  });

  it("lets verify-email and ordinary profile writes through", () => {
    expect(
      codeOf(() => refuseEmailChange({ emailVerified: true }, { path: "/verify-email" })),
    ).toBe(null);
    expect(codeOf(() => refuseEmailChange({ name: "Ada" }, { path: "/update-user" }))).toBe(null);
    expect(codeOf(() => refuseEmailChange({ name: "Ada" }, { path: "/admin/update-user" }))).toBe(
      null,
    );
  });
});
