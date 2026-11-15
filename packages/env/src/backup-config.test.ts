import { describe, expect, it } from "vitest";
import {
  BACKUP_WARNINGS,
  backupCommonConfigWarnings,
  backupMonitorConfigWarnings,
  backupWarningCode,
} from "./backup-config";
import { sharedVars } from "./vars/shared";

describe("migration and full-bundle configuration", () => {
  it("validates optional per-start instance identity without exposing it", () => {
    expect(sharedVars.KB_INSTANCE_ID.safeParse(undefined).success).toBe(true);
    expect(
      sharedVars.KB_INSTANCE_ID.safeParse("00000000-0000-4000-8000-000000000001").success,
    ).toBe(true);
    expect(sharedVars.KB_INSTANCE_ID.safeParse("inherited-name").success).toBe(false);
  });
  it("has no obsolete schema-wait configuration", () => {
    expect(Object.keys(sharedVars)).not.toContain("WAIT_FOR_SCHEMA");
    expect(Object.keys(sharedVars)).not.toContain("SCHEMA_WAIT_TIMEOUT_SECONDS");
  });
  it("distinguishes valid local bundles from missing off-site monitoring", () => {
    const warnings = backupCommonConfigWarnings({ BACKUP_ENABLED: true });
    expect(warnings).toEqual([BACKUP_WARNINGS.BUCKET_MISSING]);
    expect(warnings[0]).toContain("Local encrypted full bundles remain valid");
    expect(backupWarningCode(warnings[0] ?? "")).toBe("BUCKET_MISSING");
    expect(backupCommonConfigWarnings({ BACKUP_ENABLED: false })).toEqual([]);
  });
  it("defaults backups off and ignores leftover bucket settings while off", () => {
    expect(sharedVars.BACKUP_ENABLED.parse(undefined)).toBe(false);
    const config = { BACKUP_ENABLED: false, BACKUP_S3_BUCKET: "fixture", BACKUP_S3_REGION: "auto" };
    expect(backupCommonConfigWarnings(config)).toEqual([]);
    expect(backupMonitorConfigWarnings(config)).toEqual([]);
  });
  it("continues to require independent monitor credentials", () => {
    expect(
      backupMonitorConfigWarnings({
        BACKUP_ENABLED: true,
        BACKUP_S3_BUCKET: "fixture",
        BACKUP_S3_ACCESS_KEY_ID: "writer",
        BACKUP_MONITOR_S3_ACCESS_KEY_ID: "writer",
        BACKUP_MONITOR_S3_SECRET_ACCESS_KEY: "fixture",
      }),
    ).toContain(BACKUP_WARNINGS.MONITOR_KEY_SHARED);
    expect(
      backupMonitorConfigWarnings({ BACKUP_ENABLED: true, BACKUP_S3_BUCKET: "fixture" }),
    ).toContain(BACKUP_WARNINGS.MONITOR_KEY_MISSING);
  });
});
