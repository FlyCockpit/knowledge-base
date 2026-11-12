import { describe, expect, it } from "vitest";
import { ConnectionConfigError, initializeConnection } from "./connection-config";
import { captureLog, logStartupFailure } from "./log";

describe("driver configuration startup failures", () => {
  it.each(["DATABASE_URL", "REDIS_URL"] as const)(
    "%s has closed detail without driver text",
    (setting) => {
      const log = captureLog();
      try {
        expect(initializeConnection(setting, () => 7)).toBe(7);
        let thrown: unknown;
        try {
          initializeConnection(setting, () => {
            throw new Error("password=CredentialCanary");
          });
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(ConnectionConfigError);
        logStartupFailure("worker", thrown, "import");
        expect(log.records[0]).toMatchObject({
          setting,
          reason: "DRIVER_REJECTED",
          stage: setting === "DATABASE_URL" ? "postgres" : "redis",
        });
        expect(JSON.stringify(log.records)).not.toContain("CredentialCanary");
      } finally {
        log.restore();
      }
    },
  );
});
