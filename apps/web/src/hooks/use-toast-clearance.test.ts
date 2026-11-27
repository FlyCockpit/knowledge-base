import { afterEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ cleanup: undefined as undefined | (() => void) }));
vi.mock("react", () => ({
  useEffect: (effect: () => () => void) => {
    state.cleanup = effect();
  },
}));
const { useToastClearance } = await import("./use-toast-clearance");

afterEach(() => {
  vi.unstubAllGlobals();
});

it("measures the save bar, updates when it wraps, and cleans up", () => {
  const setProperty = vi.fn();
  const removeProperty = vi.fn();
  const disconnect = vi.fn();
  let resize = () => {};
  let height = 48.2;
  vi.stubGlobal("document", { documentElement: { style: { setProperty, removeProperty } } });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect = disconnect;
    },
  );
  const element = { getBoundingClientRect: () => ({ height }) } as HTMLElement;
  useToastClearance(element);
  expect(setProperty).toHaveBeenLastCalledWith("--toast-bottom-clearance", "61px");
  height = 90;
  resize();
  expect(setProperty).toHaveBeenLastCalledWith("--toast-bottom-clearance", "102px");
  state.cleanup?.();
  expect(disconnect).toHaveBeenCalled();
  expect(removeProperty).toHaveBeenCalledWith("--toast-bottom-clearance");
});
