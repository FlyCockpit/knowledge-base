import { describe, expect, it, vi } from "vitest";

import {
  type AnalyticsProvider,
  analyticsConfigured,
  analyticsProvider,
  createAnalyticsSeam,
  disableAnalytics,
  loadAnalytics,
} from "./analytics";

function fakeProvider() {
  return { load: vi.fn(), disable: vi.fn() } satisfies AnalyticsProvider;
}

describe("the analytics switch", () => {
  it("is the provider itself: configured exactly when a provider is set", () => {
    expect(analyticsConfigured).toBe(analyticsProvider !== null);
    expect(createAnalyticsSeam(null).configured).toBe(false);
    expect(createAnalyticsSeam(fakeProvider()).configured).toBe(true);
  });

  it("with no provider, loading and withdrawing do nothing", () => {
    const seam = createAnalyticsSeam(null);
    seam.load();
    expect(seam.loaded()).toBe(false);
    seam.disable();
    expect(seam.loaded()).toBe(false);
    if (!analyticsConfigured) {
      // The shipped seam: nothing to call, nothing to throw.
      expect(() => {
        loadAnalytics();
        disableAnalytics();
      }).not.toThrow();
    }
  });

  // The guard for an app that turns analytics on: a provider whose setup or
  // revocation is an empty stub would show a banner for nothing, or keep
  // collecting after a withdrawal. Skipped while the app ships none.
  it.runIf(analyticsProvider !== null)(
    "a configured provider implements both setup and revocation",
    () => {
      for (const part of ["load", "disable"] as const) {
        const body = String(analyticsProvider?.[part])
          .replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")
          .replace(/^[^{]*\{/, "")
          .replace(/\}\s*$/, "");
        expect(body.trim(), `analyticsProvider.${part} is empty`).not.toBe("");
      }
    },
  );
});

describe("analytics consent lifecycle (a provider configured)", () => {
  it("allows a withdrawn decision to disable analytics and a later grant to initialize it again", () => {
    const provider = fakeProvider();
    const seam = createAnalyticsSeam(provider);
    expect(seam.loaded()).toBe(false);

    seam.load();
    expect(seam.loaded()).toBe(true);
    seam.load();
    expect(provider.load).toHaveBeenCalledTimes(1);

    seam.disable();
    expect(seam.loaded()).toBe(false);
    expect(provider.disable).toHaveBeenCalledTimes(1);

    seam.load();
    expect(seam.loaded()).toBe(true);
    expect(provider.load).toHaveBeenCalledTimes(2);
  });

  it("makes revocation idempotent before or after analytics loads", () => {
    const provider = fakeProvider();
    const seam = createAnalyticsSeam(provider);
    seam.disable();
    expect(seam.loaded()).toBe(false);
    expect(provider.disable).not.toHaveBeenCalled();

    seam.load();
    seam.disable();
    seam.disable();

    expect(seam.loaded()).toBe(false);
    expect(provider.disable).toHaveBeenCalledTimes(1);
  });
});
