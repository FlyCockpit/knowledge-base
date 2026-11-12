import { logEvent, logInternalError } from "@knowledge-base/env/log";

// Better-Auth emits "user input failed validation" cases (wrong password, unknown
// email, unverified email, etc.) at level=error. Those are normal end-user mistakes,
// not server faults — downgrade them to warn so production error dashboards stay
// signal-y. Anything we don't recognize keeps its original level.
const USER_INPUT_ERROR_PATTERN =
  /invalid (password|email|credentials|token|otp|two[- ]?factor)|user not found|email not verified|password is incorrect|account not found|failed to verify|already exists|too many (requests|attempts)/i;

/**
 * Better Auth's logger callback (R3-W3). The library passes free text and the
 * original exceptions (which can carry tokens, cookies or SQL); we print a
 * fixed record only: its level and, for an error argument, its class and code.
 */
export const authLogger = {
  log(level: string, message: string, ...args: unknown[]): void {
    const effective = level === "error" && USER_INPUT_ERROR_PATTERN.test(message) ? "warn" : level;
    if (effective !== "error" && effective !== "warn") return;
    const site = effective === "error" ? "auth.library.error" : "auth.library";
    const error = args.find((arg) => arg instanceof Error);
    if (error) logInternalError(site, error);
    else logEvent(site);
  },
};
