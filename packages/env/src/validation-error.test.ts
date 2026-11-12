import { expect, it } from "vitest";
import { captureLog, logRecord } from "./log";
import { configIssue, onEnvValidationError } from "./validation-error";

it("configuration errors expose closed detail, never arbitrary issue messages or codes", () => {
  const log = captureLog();
  try {
    const injected = {
      path: ["CredentialCanary9Zq7Kp2Xw"],
      code: "FORGED",
      message: "password=CredentialCanary9Zq7Kp2Xw",
    };
    let startup: ReturnType<typeof logRecord> | undefined;
    try {
      onEnvValidationError([injected]);
    } catch (error) {
      startup = logRecord("worker.startup", { stage: "import" }, error);
    }
    expect(startup).toMatchObject({
      setting: "UNKNOWN",
      reason: "INVALID",
      errorCode: "INVALID_ENV",
    });
    expect(JSON.stringify([startup, ...log.records])).not.toContain("CredentialCanary9Zq7Kp2Xw");
    expect(() => onEnvValidationError([configIssue("SMTP_FROM", "SMTP_FROM_MISSING")])).toThrow(
      "Invalid environment variables",
    );
    expect(log.records.at(-1)).toMatchObject({ setting: "SMTP_FROM", reason: "SMTP_FROM_MISSING" });
  } finally {
    log.restore();
  }
});
