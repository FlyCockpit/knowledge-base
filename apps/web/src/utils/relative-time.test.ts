import { describe, expect, it } from "vitest";

import { formatRelativeTime } from "./relative-time";

const NOW = Date.UTC(2026, 0, 10, 12, 0, 0);

describe("formatRelativeTime", () => {
  it("formats an hours-away deadline in English", () => {
    expect(formatRelativeTime(NOW + 23 * 3_600_000, "en-US", NOW)).toBe("in 23 hours");
  });

  it("formats the same deadline in the active locale", () => {
    expect(formatRelativeTime(NOW + 23 * 3_600_000, "es-MX", NOW)).toBe("dentro de 23 horas");
  });

  it("picks the largest unit the distance fills", () => {
    expect(formatRelativeTime(NOW + 2 * 86_400_000, "en-US", NOW)).toBe("in 2 days");
    expect(formatRelativeTime(NOW + 90_000, "en-US", NOW)).toBe("in 2 minutes");
  });

  it("formats a deadline that has already passed", () => {
    expect(formatRelativeTime(NOW - 3 * 3_600_000, "en-US", NOW)).toBe("3 hours ago");
  });
});
