import { afterEach, describe, expect, it, vi } from "vitest";

import { isChunkLoadFailure, isFetchFailure, networkFailureKind } from "./network-failure";

afterEach(() => vi.unstubAllGlobals());

describe("networkFailureKind", () => {
  it("is offline for any failure without an HTTP answer while the browser is offline", () => {
    vi.stubGlobal("navigator", { onLine: false });
    expect(networkFailureKind(new TypeError("Failed to fetch"))).toBe("offline");
    expect(networkFailureKind(new Error("Route session unavailable"))).toBe("offline");
  });

  it("is never offline for a response the server sent", () => {
    vi.stubGlobal("navigator", { onLine: false });
    expect(networkFailureKind({ status: 500, code: "INTERNAL_SERVER_ERROR" })).toBeNull();
  });

  it("is unreachable for a failed fetch while online, including one wrapped in a cause", () => {
    vi.stubGlobal("navigator", { onLine: true });
    expect(networkFailureKind(new TypeError("Failed to fetch"))).toBe("unreachable");
    expect(networkFailureKind(new TypeError("Load failed"))).toBe("unreachable");
    expect(
      networkFailureKind(
        new Error("wrapped", {
          cause: new TypeError("NetworkError when attempting to fetch resource."),
        }),
      ),
    ).toBe("unreachable");
  });

  it("leaves other errors and online chunk failures (a replaced build) to the generic path", () => {
    vi.stubGlobal("navigator", { onLine: true });
    expect(networkFailureKind(new Error("boom"))).toBeNull();
    expect(
      networkFailureKind(new TypeError("Failed to fetch dynamically imported module: /a.js")),
    ).toBeNull();
  });
});

describe("classifiers", () => {
  it("tells fetch failures from chunk failures", () => {
    const chunk = new TypeError("Failed to fetch dynamically imported module: /assets/x.js");
    expect(isChunkLoadFailure(chunk)).toBe(true);
    expect(isFetchFailure(chunk)).toBe(false);
    expect(isChunkLoadFailure(new Error("Unable to preload CSS for /assets/x.css"))).toBe(true);
    expect(isFetchFailure(new TypeError("Failed to fetch"))).toBe(true);
    expect(isFetchFailure("Failed to fetch")).toBe(false);
  });
});
