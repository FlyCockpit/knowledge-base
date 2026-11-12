import { TWO_FACTOR_ENROLLMENT_GRACE_MS } from "@knowledge-base/auth/two-factor-policy";
import { describe, expect, it } from "vitest";

import { isForcedTwoFactorEnabledForRole, twoFactorEnrollmentState } from "./two-factor-policy";

const NOW = Date.UTC(2026, 0, 10, 12, 0, 0);
const JUST_SIGNED_UP = NOW - 60_000;
const ESTABLISHED = NOW - 30 * 86_400_000;

describe("isForcedTwoFactorEnabledForRole", () => {
  it("forces admins when the setting row is absent", () => {
    expect(isForcedTwoFactorEnabledForRole({}, "admin")).toBe(true);
    expect(isForcedTwoFactorEnabledForRole(undefined, "admin")).toBe(true);
  });

  it("leaves public users unforced when the setting row is absent", () => {
    expect(isForcedTwoFactorEnabledForRole({}, "user")).toBe(false);
  });

  it("honors an explicit false for admins", () => {
    expect(isForcedTwoFactorEnabledForRole({ force2faInternalUsers: "false" }, "admin")).toBe(
      false,
    );
  });
});

describe("twoFactorEnrollmentState", () => {
  it("reports enrolled for a user with a second factor", () => {
    expect(
      twoFactorEnrollmentState(
        {},
        { role: "admin", twoFactorEnabled: true, createdAt: ESTABLISHED },
        NOW,
      ),
    ).toEqual({ status: "enrolled" });
  });

  it("reports grace, with the deadline, for a brand-new unenrolled admin", () => {
    expect(
      twoFactorEnrollmentState(
        {},
        { role: "admin", twoFactorEnabled: false, createdAt: JUST_SIGNED_UP },
        NOW,
      ),
    ).toEqual({
      status: "grace",
      deadlineMs: JUST_SIGNED_UP + TWO_FACTOR_ENROLLMENT_GRACE_MS,
    });
  });

  it("reports blocked once the grace window has closed", () => {
    expect(
      twoFactorEnrollmentState(
        {},
        { role: "admin", twoFactorEnabled: false, createdAt: ESTABLISHED },
        NOW,
      ),
    ).toEqual({ status: "blocked" });
  });

  it("reports blocked when createdAt is unreadable (fails closed)", () => {
    expect(
      twoFactorEnrollmentState(
        {},
        { role: "admin", twoFactorEnabled: false, createdAt: null },
        NOW,
      ),
    ).toEqual({ status: "blocked" });
  });

  it("reports not-required when an admin explicitly disabled internal enforcement", () => {
    expect(
      twoFactorEnrollmentState(
        { force2faInternalUsers: "false" },
        { role: "admin", twoFactorEnabled: false, createdAt: ESTABLISHED },
        NOW,
      ),
    ).toEqual({ status: "not-required" });
  });

  // The grace runs from when the requirement first applied.
  it("reports grace from the promotion time for an old account just made admin", () => {
    const promotedAt = NOW - 60_000;
    expect(
      twoFactorEnrollmentState(
        {},
        {
          role: "admin",
          twoFactorEnabled: false,
          createdAt: ESTABLISHED,
          twoFactorGraceStartedAt: promotedAt,
        },
        NOW,
      ),
    ).toEqual({ status: "grace", deadlineMs: promotedAt + TWO_FACTOR_ENROLLMENT_GRACE_MS });
  });

  it("reports grace for an established public user once public 2FA is turned on", () => {
    const enabledAt = NOW - 3_600_000;
    expect(
      twoFactorEnrollmentState(
        { force2faPublicUsers: "true" },
        {
          role: "user",
          twoFactorEnabled: false,
          createdAt: ESTABLISHED,
          twoFactorGraceStartedAt: enabledAt,
        },
        NOW,
      ),
    ).toEqual({ status: "grace", deadlineMs: enabledAt + TWO_FACTOR_ENROLLMENT_GRACE_MS });
  });

  it("leaves an established public user alone", () => {
    expect(
      twoFactorEnrollmentState(
        {},
        { role: "user", twoFactorEnabled: false, createdAt: ESTABLISHED },
        NOW,
      ),
    ).toEqual({ status: "not-required" });
  });

  it("blocks a public user only when public enforcement is explicitly on", () => {
    expect(
      twoFactorEnrollmentState(
        { force2faPublicUsers: "true" },
        { role: "user", twoFactorEnabled: false, createdAt: ESTABLISHED },
        NOW,
      ),
    ).toEqual({ status: "blocked" });
  });
});
