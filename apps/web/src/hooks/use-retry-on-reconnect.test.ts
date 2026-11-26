import { afterEach, describe, expect, it, vi } from "vitest";

const cleanups: (() => void)[] = [];
vi.mock("react", () => ({
  useEffectEvent: (fn: () => void) => fn,
  useEffect: (effect: () => (() => void) | undefined) => {
    const cleanup = effect();
    if (cleanup) cleanups.push(cleanup);
  },
}));

const { useRetryOnReconnect } = await import("./use-retry-on-reconnect");

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
});

describe("useRetryOnReconnect", () => {
  it("retries once on the online event while enabled", () => {
    const target = new EventTarget();
    vi.stubGlobal("window", target);
    const retry = vi.fn();
    useRetryOnReconnect(retry, true);
    target.dispatchEvent(new Event("online"));
    target.dispatchEvent(new Event("online"));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("does nothing while disabled, or after cleanup", () => {
    const target = new EventTarget();
    vi.stubGlobal("window", target);
    const retry = vi.fn();
    useRetryOnReconnect(retry, false);
    useRetryOnReconnect(retry, true);
    for (const cleanup of cleanups.splice(0)) cleanup();
    target.dispatchEvent(new Event("online"));
    expect(retry).not.toHaveBeenCalled();
  });
});
