import en from "@knowledge-base/locales/src/en-US/admin.json";
import es from "@knowledge-base/locales/src/es-MX/admin.json";
import { ORPCError } from "@orpc/client";
import { describe, expect, it } from "vitest";
import { userChangeErrorKey } from "./user-change-error";

describe("user change refusal translations", () => {
  it.each([
    ["SELF_DEMOTION", "selfDemotion"],
    ["LAST_ACTIVE_ADMIN", "lastActiveAdmin"],
    ["USER_NOT_FOUND", "userNotFound"],
    ["USER_CHANGE_CONFLICT", "conflict"],
  ] as const)("translates %s in both shipped locales", (reason, key) => {
    expect(userChangeErrorKey(new ORPCError("FORBIDDEN", { data: { reason } }))).toBe(
      `admin:users.roleErrors.${key}`,
    );
    expect(en.users.roleErrors[key]).toBeTruthy();
    expect(es.users.roleErrors[key]).toBeTruthy();
    expect(en.users.roleErrors[key]).not.toBe(es.users.roleErrors[key]);
  });
  it("leaves unrelated failures to normal error handling", () => {
    expect(userChangeErrorKey(new Error("failed"))).toBeUndefined();
  });
});
