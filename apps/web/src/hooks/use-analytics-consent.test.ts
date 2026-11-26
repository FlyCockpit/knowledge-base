import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The gate, called outside React: `useEffect` runs its effect at once and the
 * decision comes from a stub, so each case is one call. The switch is flipped
 * per case, so the same gate is checked off (the shipped default) and on.
 */
const state = vi.hoisted(() => ({ configured: false, analytics: true }));
const seam = vi.hoisted(() => ({ load: vi.fn(), disable: vi.fn() }));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useEffect: (effect: () => void) => {
    effect();
  },
}));
vi.mock("@/hooks/use-consent", () => ({ useConsent: () => ({ analytics: state.analytics }) }));
vi.mock("@/lib/analytics", () => ({
  get analyticsConfigured() {
    return state.configured;
  },
  loadAnalytics: seam.load,
  disableAnalytics: seam.disable,
}));

const { useAnalyticsConsent } = await import("./use-analytics-consent");

beforeEach(() => {
  seam.load.mockClear();
  seam.disable.mockClear();
});

describe("useAnalyticsConsent", () => {
  it("never loads or withdraws anything without a provider, whatever was stored", () => {
    state.configured = false;
    state.analytics = true;
    useAnalyticsConsent();
    state.analytics = false;
    useAnalyticsConsent();
    expect(seam.load).not.toHaveBeenCalled();
    expect(seam.disable).not.toHaveBeenCalled();
  });

  it("with a provider: loads after consent and withdraws on refusal", () => {
    state.configured = true;
    state.analytics = true;
    useAnalyticsConsent();
    expect(seam.load).toHaveBeenCalledTimes(1);
    state.analytics = false;
    useAnalyticsConsent();
    expect(seam.disable).toHaveBeenCalledTimes(1);
  });
});
