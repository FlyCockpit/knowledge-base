import { captureLog } from "@knowledge-base/env/log";
import { describe, expect, it } from "vitest";
import { authLogger } from "./auth-logger";

const CANARY = "Zq7Kp2Xw9Lm4Rt8V";

describe("Better Auth logger callback", () => {
  it("prints a fixed record, never the library's message or arguments", () => {
    const log = captureLog();
    try {
      const error = Object.assign(new Error(`reset failed for token=${CANARY}`), { code: "P2002" });
      authLogger.log("error", `Failed to reset password: ${CANARY}`, error, {
        cookie: `better-auth.session_token=${CANARY}`,
      });
      authLogger.log("warn", `rate limited https://ada:${CANARY}@x`, { headers: CANARY });
      authLogger.log("error", "Invalid password", new Error(CANARY));
      authLogger.log("info", CANARY);
      authLogger.log("debug", CANARY);
      expect(log.records).toEqual([
        {
          level: "error",
          site: "auth.library.error",
          message: "authentication library reported an error",
          errorClass: "Error",
          errorCode: "P2002",
        },
        {
          level: "warn",
          site: "auth.library",
          message: "authentication library reported a problem",
        },
        {
          level: "warn",
          site: "auth.library",
          message: "authentication library reported a problem",
          errorClass: "Error",
        },
      ]);
      expect(JSON.stringify(log.records)).not.toContain(CANARY);
    } finally {
      log.restore();
    }
  });
});
