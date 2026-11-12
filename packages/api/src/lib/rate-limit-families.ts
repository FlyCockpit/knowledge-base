import { env } from "@knowledge-base/env/server";

// ---------------------------------------------------------------------------
// Named rate-limit budgets — the three-family collapse.
// ---------------------------------------------------------------------------
// One POINTS/DURATION/BLOCK_DURATION knob per limiter would be a tuning
// surface for someone who has read this file, and an unsortable wall for
// everyone else — and per-surface knobs invite the one mistake
// AGENTS.md § Rate limiting — one bucket per surface exists to prevent: squeezing one budget to "be
// safe" and locking out a shared office, instead of SPLITTING the surface
// that needs its own bucket.
//
// Instead there are three named budgets, two knobs each: AUTH, RPC, EMAIL.
// Semantics: a budget describes its family's REFERENCE
// member; every other member keeps its ratio to that reference, so setting a
// budget re-tunes the whole family coherently.
//
//   • POINTS multiplies every member's points by (provided / reference).
//   • WINDOW_SECONDS multiplies every member's window AND block duration by
//     (provided / reference window) — the window:block ratio is part of each
//     member's design and moves as a unit.
//
// What deliberately does NOT become env-tunable: the burst/sustained pairing
// (a member's ratio to its reference), the key each bucket is keyed on, and
// fail-open vs fail-closed. Those are security design, not capacity planning.
// The signin-failure triple stays code-only for the same reason (see its doc
// comment in apps/server/src/rate-limit.ts).
//
// With every budget left at its default the multipliers are exactly 1 and
// every limiter runs at its shipped reference numbers.
// ---------------------------------------------------------------------------

/** A member's designed budget, expressed against its family reference. */
export interface MemberDefaults {
  points: number;
  windowSeconds: number;
  /** Extra block past the window (0/omitted = suppression ends with the window). */
  blockSeconds?: number;
}

/** A member's effective numbers after the family multipliers are applied. */
export interface ScaledMember {
  points: number;
  durationSeconds: number;
  blockSeconds: number;
}

function assertFinitePositive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(
      `[rate-limit] ${label} must be a positive number, got ${value}. ` +
        "This is wired from the RATE_LIMIT_* env schema, which enforces it — " +
        "a NaN here almost certainly means a test mocked @knowledge-base/env/server " +
        "without the budget keys.",
    );
  }
}

/**
 * Build one family's scaler from its reference defaults and the budget env
 * pair. Pure arithmetic — the env wiring happens once per family below.
 */
export function scaleFamily(
  reference: { points: number; windowSeconds: number },
  budget: { points: number; windowSeconds: number },
): (defaults: MemberDefaults) => ScaledMember {
  assertFinitePositive(reference.points, "family reference points");
  assertFinitePositive(reference.windowSeconds, "family reference window");
  assertFinitePositive(budget.windowSeconds, "family budget window");
  // Points may be 0 for exactly one family (EMAIL), where 0 is the documented
  // "disable every recipient cap" switch the limiters already understand.
  // Any positive budget floors every positive member at 1 point, so a small
  // budget (e.g. AUTH=1) slows a family down instead of rounding a child to
  // 0 points and blocking that surface entirely.
  if (!Number.isFinite(budget.points) || budget.points < 0) {
    throw new TypeError(`[rate-limit] family budget points must be >= 0, got ${budget.points}.`);
  }
  const pointsScale = budget.points / reference.points;
  const windowScale = budget.windowSeconds / reference.windowSeconds;

  return (defaults: MemberDefaults): ScaledMember => {
    const blockSeconds = defaults.blockSeconds ?? 0;
    return {
      points:
        defaults.points <= 0 || budget.points === 0
          ? 0
          : Math.max(1, Math.round(defaults.points * pointsScale)),
      durationSeconds: Math.max(1, Math.round(defaults.windowSeconds * windowScale)),
      blockSeconds: blockSeconds > 0 ? Math.max(1, Math.round(blockSeconds * windowScale)) : 0,
    };
  };
}

/**
 * Wire one family: env is read on the FIRST member resolution, not at import.
 * That preserves the laziness profile the old per-surface knobs had —
 * `createProcedureBudget` builds its limiter on first consume, so a test that
 * imports the router graph without ever hitting a family budget must not need
 * the budget keys in its env mock.
 */
function lazyFamily(
  reference: { points: number; windowSeconds: number },
  readBudget: () => { points: number; windowSeconds: number },
): (defaults: MemberDefaults) => ScaledMember {
  let scale: ((defaults: MemberDefaults) => ScaledMember) | undefined;
  return (defaults: MemberDefaults): ScaledMember => {
    scale ??= scaleFamily(reference, readBudget());
    return scale(defaults);
  };
}

/**
 * AUTH family — every fail-closed `/api/auth/*` HTTP limiter. Reference is
 * the general auth surface (30/60 s); credential (10/60 s), credential-burst
 * (3/10 s), signup (10/h) and 2FA-OTP (3/15 min) scale against it.
 */
export const authRateFamily = lazyFamily({ points: 30, windowSeconds: 60 }, () => ({
  points: env.RATE_LIMIT_AUTH_POINTS,
  windowSeconds: env.RATE_LIMIT_AUTH_WINDOW_SECONDS,
}));

/**
 * RPC family — ordinary request volume. Reference is `/rpc/*` (100/60 s);
 * `/ready` (60) and the SSR catch-all (300) scale with it.
 */
export const rpcRateFamily = lazyFamily({ points: 100, windowSeconds: 60 }, () => ({
  points: env.RATE_LIMIT_RPC_POINTS,
  windowSeconds: env.RATE_LIMIT_RPC_WINDOW_SECONDS,
}));

/**
 * EMAIL family — the per-RECIPIENT mail caps (the control rotating IPs cannot
 * defeat). Reference is the resend/reset bucket (3 per hour); the signup (6)
 * and sign-in (10) recipient buckets scale with it. `RATE_LIMIT_EMAIL_POINTS=0`
 * disables all three. The 0-second block is code-fixed: a block on a
 * caller-supplied key is an unauthenticated lockout lever.
 */
export const emailRateFamily = lazyFamily({ points: 3, windowSeconds: 3600 }, () => ({
  points: env.RATE_LIMIT_EMAIL_POINTS,
  windowSeconds: env.RATE_LIMIT_EMAIL_WINDOW_SECONDS,
}));
