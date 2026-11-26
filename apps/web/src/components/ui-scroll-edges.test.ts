import {
  edgeAttributes,
  observeScrollEdges,
  scrollEdges,
} from "@knowledge-base/ui/hooks/use-scroll-edges";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("scrollEdges", () => {
  it("shows no fade when the content fits (within a 1px tolerance)", () => {
    expect(scrollEdges({ scrollLeft: 0, scrollWidth: 300, clientWidth: 300 })).toEqual({
      start: false,
      end: false,
    });
    expect(scrollEdges({ scrollLeft: 0, scrollWidth: 300.6, clientWidth: 300 })).toEqual({
      start: false,
      end: false,
    });
  });

  it("fades only the end before scrolling, both mid-way, only the start at the end", () => {
    const metrics = { scrollWidth: 500, clientWidth: 300 };
    expect(scrollEdges({ ...metrics, scrollLeft: 0 })).toEqual({ start: false, end: true });
    expect(scrollEdges({ ...metrics, scrollLeft: 100 })).toEqual({ start: true, end: true });
    expect(scrollEdges({ ...metrics, scrollLeft: 200 })).toEqual({ start: true, end: false });
    expect(scrollEdges({ ...metrics, scrollLeft: 199.5 })).toEqual({ start: true, end: false });
  });

  it("reads RTL scrollers, whose scrollLeft runs negative", () => {
    expect(scrollEdges({ scrollLeft: -200, scrollWidth: 500, clientWidth: 300 })).toEqual({
      start: true,
      end: false,
    });
  });
});

describe("observeScrollEdges", () => {
  function fakeScroller() {
    const listeners = new Map<string, () => void>();
    return {
      scrollLeft: 0,
      scrollWidth: 300,
      clientWidth: 300,
      firstElementChild: { id: "track" } as unknown as Element,
      addEventListener: vi.fn((type: string, fn: () => void) => listeners.set(type, fn)),
      removeEventListener: vi.fn((type: string) => listeners.delete(type)),
      fire: (type: string) => listeners.get(type)?.(),
      listeners,
    };
  }

  it("re-measures on scroll and on resize of the row or its track, reporting only changes", () => {
    const resize: { callback?: () => void; observed: unknown[]; disconnect: () => void } = {
      observed: [],
      disconnect: vi.fn(),
    };
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          resize.callback = callback;
        }
        observe(target: unknown) {
          resize.observed.push(target);
        }
        disconnect() {
          resize.disconnect();
        }
      },
    );
    const el = fakeScroller();
    const onChange = vi.fn();

    const stop = observeScrollEdges(el as never, onChange);
    expect(onChange).toHaveBeenLastCalledWith({ start: false, end: false });
    expect(resize.observed).toEqual([el, el.firstElementChild]);

    // The viewport narrows: the track now overflows.
    el.clientWidth = 200;
    resize.callback?.();
    expect(onChange).toHaveBeenLastCalledWith({ start: false, end: true });

    el.scrollLeft = 50;
    el.fire("scroll");
    expect(onChange).toHaveBeenLastCalledWith({ start: true, end: true });

    // Same edges again: no extra render.
    el.scrollLeft = 60;
    el.fire("scroll");
    expect(onChange).toHaveBeenCalledTimes(3);

    el.scrollLeft = 100;
    el.fire("scroll");
    expect(onChange).toHaveBeenLastCalledWith({ start: true, end: false });

    stop();
    expect(el.listeners.size).toBe(0);
    expect(resize.disconnect).toHaveBeenCalled();
  });

  it("still tracks scrolling where ResizeObserver is missing", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const el = fakeScroller();
    el.scrollWidth = 600;
    const onChange = vi.fn();
    observeScrollEdges(el as never, onChange);
    expect(onChange).toHaveBeenLastCalledWith({ start: false, end: true });
  });
});

describe("edgeAttributes", () => {
  it("sets each data attribute only while that edge has more content", () => {
    expect(edgeAttributes({ start: false, end: true })).toEqual({
      "data-overflow-start": undefined,
      "data-overflow-end": "",
    });
  });
});

describe("scroll-fade-x stylesheet", () => {
  it("masks only while an edge overflows and fades just that edge", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync(
      new URL("../../../../packages/ui/src/styles/globals.css", import.meta.url),
      "utf8",
    );
    expect(css).toMatch(
      /\.scroll-fade-x:is\(\[data-overflow-start\], \[data-overflow-end\]\) \{\s*mask-image: linear-gradient\(/,
    );
    expect(css).toMatch(
      /\.scroll-fade-x\[data-overflow-start\] \{\s*--scroll-fade-start: 1\.5rem;/,
    );
    expect(css).toMatch(/\.scroll-fade-x\[data-overflow-end\] \{\s*--scroll-fade-end: 1\.5rem;/);
  });
});
