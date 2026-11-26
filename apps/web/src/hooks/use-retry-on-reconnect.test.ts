import { beforeEach, describe, expect, it, vi } from "vitest";

// One component instance: a persistent ref, and effects that run when their
// dependencies change, as React does after each commit.
const instance = vi.hoisted(() => ({
  ref: undefined as { current: unknown } | undefined,
  deps: undefined as unknown[] | undefined,
}));
vi.mock("react", () => ({
  useEffectEvent: (fn: () => void) => fn,
  useRef: (initial: unknown) => {
    instance.ref ??= { current: initial };
    return instance.ref;
  },
  useEffect: (effect: () => void, deps: unknown[]) => {
    if (instance.deps && deps.every((d, i) => Object.is(d, instance.deps?.[i]))) return;
    instance.deps = deps;
    effect();
  },
}));

const { useRetryOnReconnect } = await import("./use-retry-on-reconnect");

beforeEach(() => {
  instance.ref = undefined;
  instance.deps = undefined;
});

describe("useRetryOnReconnect", () => {
  it("retries once when the status turns from offline to online", () => {
    const retry = vi.fn();
    useRetryOnReconnect(retry, true);
    expect(retry).not.toHaveBeenCalled();
    useRetryOnReconnect(retry, false);
    useRetryOnReconnect(retry, false);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("does not retry when it mounts online (an unreachable server, not a reconnect)", () => {
    const retry = vi.fn();
    useRetryOnReconnect(retry, false);
    useRetryOnReconnect(retry, false);
    expect(retry).not.toHaveBeenCalled();
  });

  it("retries again on each later reconnect", () => {
    const retry = vi.fn();
    useRetryOnReconnect(retry, false);
    useRetryOnReconnect(retry, true);
    useRetryOnReconnect(retry, false);
    useRetryOnReconnect(retry, true);
    useRetryOnReconnect(retry, false);
    expect(retry).toHaveBeenCalledTimes(2);
  });

  it("needs no online event: the status change alone triggers it", () => {
    const add = vi.fn();
    vi.stubGlobal("window", { addEventListener: add, removeEventListener: vi.fn() });
    const retry = vi.fn();
    useRetryOnReconnect(retry, true);
    useRetryOnReconnect(retry, false);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(add).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
