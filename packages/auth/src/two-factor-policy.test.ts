import { describe, expect, it } from "vitest";

import {
  FORCE_2FA_DEFAULTS,
  forcedTwoFactorSettingKeyForRole,
  isForcedTwoFactorActivation,
  isForcedTwoFactorEnabled,
  isTwoFactorRequirementSatisfied,
  isWithinTwoFactorEnrollmentGrace,
  TWO_FACTOR_ALLOW_PASSWORDLESS_ENROLLMENT,
  TWO_FACTOR_ENROLLMENT_GRACE_MS,
  twoFactorEnrollmentGraceEndsAt,
  twoFactorGraceStartedAt,
} from "./two-factor-policy";

const NOW = Date.UTC(2026, 0, 10, 12, 0, 0);

describe("forced-2FA defaults", () => {
  it("requires 2FA for internal users when the setting row is absent", () => {
    expect(isForcedTwoFactorEnabled("force2faInternalUsers", undefined)).toBe(true);
    expect(isForcedTwoFactorEnabled("force2faInternalUsers", null)).toBe(true);
  });

  it("leaves public users unforced when the setting row is absent", () => {
    expect(isForcedTwoFactorEnabled("force2faPublicUsers", undefined)).toBe(false);
  });

  it("lets an explicit false turn internal enforcement off", () => {
    expect(isForcedTwoFactorEnabled("force2faInternalUsers", "false")).toBe(false);
  });

  it("treats any non-true stored value as off", () => {
    expect(isForcedTwoFactorEnabled("force2faInternalUsers", "yes")).toBe(false);
    expect(isForcedTwoFactorEnabled("force2faPublicUsers", "true")).toBe(true);
  });

  it("pins the shipped defaults so a silent weakening shows up as a failing test", () => {
    expect(FORCE_2FA_DEFAULTS).toEqual({
      force2faInternalUsers: true,
      force2faPublicUsers: false,
    });
  });

  it("routes admins to the internal key and everyone else to the public key", () => {
    expect(forcedTwoFactorSettingKeyForRole("admin")).toBe("force2faInternalUsers");
    expect(forcedTwoFactorSettingKeyForRole("editor,admin")).toBe("force2faInternalUsers");
    expect(forcedTwoFactorSettingKeyForRole("user")).toBe("force2faPublicUsers");
    expect(forcedTwoFactorSettingKeyForRole(undefined)).toBe("force2faPublicUsers");
  });
});

describe("enrollment grace window", () => {
  it("allows SSO-only accounts to enroll without inventing a password", () => {
    expect(TWO_FACTOR_ALLOW_PASSWORDLESS_ENROLLMENT).toBe(true);
  });

  it("runs for 24 hours from account creation", () => {
    expect(TWO_FACTOR_ENROLLMENT_GRACE_MS).toBe(24 * 60 * 60 * 1000);
    expect(twoFactorEnrollmentGraceEndsAt(new Date(NOW))).toBe(
      NOW + TWO_FACTOR_ENROLLMENT_GRACE_MS,
    );
  });

  it("accepts a Date, an ISO string, or epoch milliseconds", () => {
    const expected = NOW + TWO_FACTOR_ENROLLMENT_GRACE_MS;
    expect(twoFactorEnrollmentGraceEndsAt(new Date(NOW).toISOString())).toBe(expected);
    expect(twoFactorEnrollmentGraceEndsAt(NOW)).toBe(expected);
  });

  it("has no grace for a missing or unreadable createdAt (fails closed)", () => {
    expect(twoFactorEnrollmentGraceEndsAt(null)).toBeNull();
    expect(twoFactorEnrollmentGraceEndsAt(undefined)).toBeNull();
    expect(twoFactorEnrollmentGraceEndsAt("not a date")).toBeNull();
    expect(isWithinTwoFactorEnrollmentGrace(null, NOW)).toBe(false);
  });

  it("ends exactly at the boundary", () => {
    const createdAt = NOW - TWO_FACTOR_ENROLLMENT_GRACE_MS;
    expect(isWithinTwoFactorEnrollmentGrace(createdAt, NOW - 1)).toBe(true);
    expect(isWithinTwoFactorEnrollmentGrace(createdAt, NOW)).toBe(false);
  });
});

describe("isTwoFactorRequirementSatisfied", () => {
  const justSignedUp = { createdAt: new Date(NOW - 60_000), twoFactorEnabled: false };
  const established = { createdAt: new Date(NOW - 30 * 86_400_000), twoFactorEnabled: false };

  it("allows an unenrolled user inside the grace window", () => {
    expect(isTwoFactorRequirementSatisfied(justSignedUp, true, NOW)).toBe(true);
  });

  it("rejects an unenrolled user past the grace window", () => {
    expect(isTwoFactorRequirementSatisfied(established, true, NOW)).toBe(false);
  });

  it("allows an enrolled user regardless of the window", () => {
    expect(
      isTwoFactorRequirementSatisfied({ ...established, twoFactorEnabled: true }, true, NOW),
    ).toBe(true);
  });

  it("allows an unenrolled user when the policy does not apply to them", () => {
    expect(isTwoFactorRequirementSatisfied(established, false, NOW)).toBe(true);
  });

  // The grace runs from when the requirement first applied to the user.
  it("measures the grace from a recorded promotion/policy start, not createdAt", () => {
    const promotedJustNow = { ...established, twoFactorGraceStartedAt: new Date(NOW - 60_000) };
    expect(isTwoFactorRequirementSatisfied(promotedJustNow, true, NOW)).toBe(true);
    expect(
      isTwoFactorRequirementSatisfied(
        promotedJustNow,
        true,
        NOW - 60_000 + TWO_FACTOR_ENROLLMENT_GRACE_MS,
      ),
    ).toBe(false);
    // Cookie-cache sessions carry dates as ISO strings.
    expect(
      isTwoFactorRequirementSatisfied(
        { ...established, twoFactorGraceStartedAt: new Date(NOW - 60_000).toISOString() },
        true,
        NOW,
      ),
    ).toBe(true);
  });

  it("falls back to createdAt when no start is recorded, so the grace still ends", () => {
    expect(twoFactorGraceStartedAt({ ...established, twoFactorGraceStartedAt: null })).toBe(
      established.createdAt,
    );
    expect(
      isTwoFactorRequirementSatisfied({ ...established, twoFactorGraceStartedAt: null }, true, NOW),
    ).toBe(false);
  });

  it("fails closed on a recorded but unreadable start", () => {
    expect(
      isTwoFactorRequirementSatisfied(
        { ...justSignedUp, twoFactorGraceStartedAt: "not a date" },
        true,
        NOW,
      ),
    ).toBe(false);
  });
});

describe("isForcedTwoFactorActivation", () => {
  it("fires only on an effective off -> on transition, defaults included", () => {
    expect(isForcedTwoFactorActivation("force2faPublicUsers", undefined, "true")).toBe(true);
    expect(isForcedTwoFactorActivation("force2faPublicUsers", "false", "true")).toBe(true);
    expect(isForcedTwoFactorActivation("force2faPublicUsers", "true", "true")).toBe(false);
    expect(isForcedTwoFactorActivation("force2faPublicUsers", undefined, "false")).toBe(false);
    // Internal defaults to forced: an explicit "true" over an absent row is no transition.
    expect(isForcedTwoFactorActivation("force2faInternalUsers", undefined, "true")).toBe(false);
    expect(isForcedTwoFactorActivation("force2faInternalUsers", "false", "true")).toBe(true);
  });
});
