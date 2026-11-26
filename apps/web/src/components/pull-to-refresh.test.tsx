import type { TouchEvent } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import PullToRefresh from "./pull-to-refresh";

type ElementSnapshot = {
  style: Record<string, string>;
  contains: () => boolean;
  parentElement: null;
};

const boundary = vi.hoisted(() => ({ elements: [] as ElementSnapshot[] }));

// Exercise complete handler sequences without a browser/DOM environment.
// Refs and callbacks are inert boundaries; gesture state and refresh promises
// run through the real component rather than a copy of its implementation.
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useCallback: (callback: unknown) => callback,
  useRef: (initial: unknown) => {
    if (initial !== null) return { current: initial };
    const element: ElementSnapshot = { style: {}, contains: () => true, parentElement: null };
    boundary.elements.push(element);
    return { current: element };
  },
}));

class TouchTarget {
  scrollTop = 0;
  parentElement = null;
  closest() {
    return null;
  }
}

function touch(y: number, count = 1): TouchEvent {
  return {
    target: new TouchTarget(),
    touches: Array.from({ length: count }, () => ({ clientX: 0, clientY: y })),
  } as unknown as TouchEvent;
}

function handlers(onRefresh: () => Promise<void>) {
  return PullToRefresh({ onRefresh, children: null }).props as {
    onTouchStart: (event: TouchEvent) => void;
    onTouchMove: (event: TouchEvent) => void;
    onTouchEnd: () => Promise<void>;
    onTouchCancel: () => void;
  };
}

describe("PullToRefresh", () => {
  beforeEach(() => {
    boundary.elements.length = 0;
    vi.stubGlobal("Element", TouchTarget);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("ignores later taps, touch-end and cancellation while refresh is pending", async () => {
    const pending = Promise.withResolvers<void>();
    const refresh = vi.fn(() => pending.promise);
    const view = handlers(refresh);
    view.onTouchStart(touch(0));
    view.onTouchMove(touch(180));
    const first = view.onTouchEnd();
    const indicator = boundary.elements[1];
    const icon = boundary.elements[2];
    const progress = { ...indicator?.style };

    view.onTouchStart(touch(0));
    view.onTouchMove(touch(200));
    await view.onTouchEnd();
    view.onTouchCancel();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(indicator?.style).toEqual(progress);
    expect(icon?.style.animation).toBe("spin 0.8s linear infinite");

    pending.resolve();
    await first;
    expect(indicator?.style.opacity).toBe("0");
    expect(icon?.style.animation).toBe("none");

    // Finishing one refresh must allow the next deliberate pull.
    view.onTouchStart(touch(0));
    view.onTouchMove(touch(180));
    await view.onTouchEnd();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("cancels an active pull when a second finger joins", async () => {
    const refresh = vi.fn(async () => {});
    const view = handlers(refresh);
    view.onTouchStart(touch(0));
    view.onTouchMove(touch(180));
    view.onTouchStart(touch(180, 2));
    view.onTouchMove(touch(220, 2));
    await view.onTouchEnd();
    view.onTouchMove(touch(240));
    await view.onTouchEnd();
    expect(refresh).not.toHaveBeenCalled();
    expect(boundary.elements[1]?.style.opacity).toBe("0");
  });

  it("cancels multi-touch movement even without another touch-start event", async () => {
    const refresh = vi.fn(async () => {});
    const view = handlers(refresh);
    view.onTouchStart(touch(0));
    view.onTouchMove(touch(180, 2));
    await view.onTouchEnd();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("does not refresh a cancelled or below-threshold gesture", async () => {
    const refresh = vi.fn(async () => {});
    const view = handlers(refresh);
    view.onTouchStart(touch(0));
    view.onTouchMove(touch(180));
    view.onTouchCancel();
    await view.onTouchEnd();
    view.onTouchStart(touch(0));
    view.onTouchMove(touch(40));
    await view.onTouchEnd();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("releases the gesture when a refresh hangs past the timeout", async () => {
    vi.useFakeTimers();
    try {
      const refresh = vi
        .fn<() => Promise<void>>()
        .mockReturnValueOnce(new Promise<void>(() => {}))
        .mockResolvedValue(undefined);
      const view = handlers(refresh);
      view.onTouchStart(touch(0));
      view.onTouchMove(touch(180));
      const first = view.onTouchEnd();
      await vi.advanceTimersByTimeAsync(10_000);
      await first;
      expect(boundary.elements[1]?.style.opacity).toBe("0");
      expect(boundary.elements[2]?.style.animation).toBe("none");
      view.onTouchStart(touch(0));
      view.onTouchMove(touch(180));
      await view.onTouchEnd();
      expect(refresh).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cleans up a rejected refresh and allows another gesture", async () => {
    const refresh = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(undefined);
    const view = handlers(refresh);
    view.onTouchStart(touch(0));
    view.onTouchMove(touch(180));
    await expect(view.onTouchEnd()).rejects.toThrow("offline");
    expect(boundary.elements[1]?.style.opacity).toBe("0");
    expect(boundary.elements[2]?.style.animation).toBe("none");
    view.onTouchStart(touch(0));
    view.onTouchMove(touch(180));
    await view.onTouchEnd();
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
