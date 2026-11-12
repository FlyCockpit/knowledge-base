import { afterEach, describe, expect, it } from "vitest";

import {
  __analyticsLoadedForTests,
  __resetAnalyticsForTests,
  disableAnalytics,
  loadAnalytics,
} from "./analytics";

afterEach(() => {
  __resetAnalyticsForTests();
});

describe("analytics consent lifecycle", () => {
  it("allows a withdrawn decision to disable analytics and a later grant to initialize it again", () => {
    expect(__analyticsLoadedForTests()).toBe(false);

    loadAnalytics();
    expect(__analyticsLoadedForTests()).toBe(true);

    disableAnalytics();
    expect(__analyticsLoadedForTests()).toBe(false);

    loadAnalytics();
    expect(__analyticsLoadedForTests()).toBe(true);
  });

  it("makes revocation idempotent before or after analytics loads", () => {
    disableAnalytics();
    expect(__analyticsLoadedForTests()).toBe(false);

    loadAnalytics();
    disableAnalytics();
    disableAnalytics();

    expect(__analyticsLoadedForTests()).toBe(false);
  });
});
