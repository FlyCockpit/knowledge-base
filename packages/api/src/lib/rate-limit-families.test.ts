import { describe, expect, it, vi } from "vitest";

// The families are wired from `@knowledge-base/env/server` at module load; this suite
// exercises the pure `scaleFamily` math, so the env module is stubbed with the
// schema defaults (every multiplier exactly 1).
vi.mock("@knowledge-base/env/server", () => ({
  env: {
    RATE_LIMIT_AUTH_POINTS: 30,
    RATE_LIMIT_AUTH_WINDOW_SECONDS: 60,
    RATE_LIMIT_RPC_POINTS: 100,
    RATE_LIMIT_RPC_WINDOW_SECONDS: 60,
    RATE_LIMIT_EMAIL_POINTS: 3,
    RATE_LIMIT_EMAIL_WINDOW_SECONDS: 3600,
  },
}));

const { scaleFamily } = await import("./rate-limit-families");

describe("scaleFamily", () => {
  it("returns each member's designed numbers untouched at the reference budget", () => {
    const family = scaleFamily(
      { points: 30, windowSeconds: 60 },
      { points: 30, windowSeconds: 60 },
    );
    expect(family({ points: 10, windowSeconds: 60, blockSeconds: 300 })).toEqual({
      points: 10,
      durationSeconds: 60,
      blockSeconds: 300,
    });
    expect(family({ points: 3, windowSeconds: 900 })).toEqual({
      points: 3,
      durationSeconds: 900,
      blockSeconds: 0,
    });
  });

  it("scales every member's POINTS by provided/reference, keeping windows fixed", () => {
    // Doubling the AUTH reference points doubles every auth-family member.
    const family = scaleFamily(
      { points: 30, windowSeconds: 60 },
      { points: 60, windowSeconds: 60 },
    );
    expect(family({ points: 30, windowSeconds: 60, blockSeconds: 300 }).points).toBe(60);
    expect(family({ points: 10, windowSeconds: 60, blockSeconds: 300 }).points).toBe(20);
    expect(family({ points: 3, windowSeconds: 10 }).points).toBe(6);
    expect(family({ points: 120, windowSeconds: 60 }).points).toBe(240);
    // Points-only override: durations and blocks are untouched.
    expect(family({ points: 10, windowSeconds: 60, blockSeconds: 300 })).toMatchObject({
      durationSeconds: 60,
      blockSeconds: 300,
    });
  });

  it("scales windows AND block durations by the window multiplier, keeping points fixed", () => {
    const family = scaleFamily(
      { points: 30, windowSeconds: 60 },
      { points: 30, windowSeconds: 120 },
    );
    expect(family({ points: 10, windowSeconds: 60, blockSeconds: 300 })).toEqual({
      points: 10,
      durationSeconds: 120,
      blockSeconds: 600,
    });
    // Signup's hour window becomes two hours under a 2x window multiplier.
    expect(family({ points: 10, windowSeconds: 3600, blockSeconds: 900 })).toEqual({
      points: 10,
      durationSeconds: 7200,
      blockSeconds: 1800,
    });
  });

  it("rounds fractional members and never emits a 0-second window", () => {
    const family = scaleFamily(
      { points: 30, windowSeconds: 60 },
      { points: 15, windowSeconds: 30 },
    );
    // 3 × 0.5 = 1.5 → 2 (round-half-up), 10 × 0.5 = 5.
    expect(family({ points: 3, windowSeconds: 10 }).points).toBe(2);
    expect(family({ points: 10, windowSeconds: 60, blockSeconds: 300 }).points).toBe(5);
    // 10 s × 0.5 = 5 s, 60 s × 0.5 = 30 s — no sub-second floor trips here…
    expect(family({ points: 10, windowSeconds: 10 }).durationSeconds).toBe(5);
    // …but even an extreme 1/60th multiplier keeps a 1-second minimum window.
    const tiny = scaleFamily({ points: 30, windowSeconds: 60 }, { points: 30, windowSeconds: 1 });
    expect(tiny({ points: 10, windowSeconds: 10 }).durationSeconds).toBe(1);
    expect(tiny({ points: 10, windowSeconds: 10, blockSeconds: 300 }).blockSeconds).toBe(5);
  });

  it("treats 0 budget points as the documented family disable switch", () => {
    const family = scaleFamily(
      { points: 3, windowSeconds: 3600 },
      { points: 0, windowSeconds: 3600 },
    );
    // Every member lands at 0 points — the limiters' existing `points <= 0`
    // short-circuit then skips the Redis round-trip entirely.
    expect(family({ points: 3, windowSeconds: 3600 }).points).toBe(0);
    expect(family({ points: 6, windowSeconds: 3600 }).points).toBe(0);
    expect(family({ points: 10, windowSeconds: 3600 }).points).toBe(0);
  });

  it("refuses malformed budgets loudly instead of poisoning limiters with NaN", () => {
    expect(() =>
      scaleFamily({ points: 30, windowSeconds: 60 }, { points: Number.NaN, windowSeconds: 60 }),
    ).toThrow(TypeError);
    expect(() =>
      scaleFamily({ points: 30, windowSeconds: 60 }, { points: 30, windowSeconds: 0 }),
    ).toThrow(TypeError);
    // A stale test mock that omits the budget keys surfaces as undefined.
    expect(() =>
      scaleFamily(
        { points: 30, windowSeconds: 60 },
        { points: undefined as unknown as number, windowSeconds: 60 },
      ),
    ).toThrow(TypeError);
  });
});
