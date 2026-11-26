import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@knowledge-base/auth/password-policy";
import z from "zod";

export { PASSWORD_MIN_LENGTH };

/**
 * The Zod rule for every new-password field (signup, reset/invite/setup,
 * change password). It reads the same constants Better-Auth enforces, and the
 * field shows the rule up front with `t("auth:fields.passwordRule", { min:
 * PASSWORD_MIN_LENGTH })` as its `description`, so the user never learns it
 * from an error. Messages come from the locale error map (`@/i18n/zod`).
 */
export function newPasswordSchema() {
  return z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH);
}
