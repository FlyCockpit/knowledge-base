import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@knowledge-base/auth/password-policy";
import { describe, expect, it } from "vitest";

import { newPasswordSchema } from "./password-policy";

describe("newPasswordSchema", () => {
  it("accepts exactly the server's length range", () => {
    expect(PASSWORD_MIN_LENGTH).toBe(12);
    const schema = newPasswordSchema();
    expect(schema.safeParse("a".repeat(PASSWORD_MIN_LENGTH - 1)).success).toBe(false);
    expect(schema.safeParse("a".repeat(PASSWORD_MIN_LENGTH)).success).toBe(true);
    expect(schema.safeParse("a".repeat(PASSWORD_MAX_LENGTH)).success).toBe(true);
    expect(schema.safeParse("a".repeat(PASSWORD_MAX_LENGTH + 1)).success).toBe(false);
  });
});
