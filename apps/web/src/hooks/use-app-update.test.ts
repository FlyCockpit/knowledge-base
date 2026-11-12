import { afterEach, describe, expect, it, vi } from "vitest";
import { useAppUpdate } from "./use-app-update";

const fixture = vi.hoisted(() => ({
  register: vi.fn<(options: { immediate: boolean; onNeedReload: () => void }) => void>(),
  cleanup: undefined as (() => void) | undefined,
}));
vi.mock("virtual:pwa-register", () => ({ registerSW: fixture.register }));
vi.mock("./use-mount-effect", () => ({
  useMountEffect: (effect: () => (() => void) | undefined) => {
    fixture.cleanup = effect();
  },
}));
afterEach(() => {
  fixture.cleanup?.();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("registers silently and never reloads when the service worker activates", () => {
  vi.useFakeTimers();
  const reload = vi.fn();
  vi.stubGlobal("window", { setTimeout, clearTimeout, location: { reload } });
  useAppUpdate();
  vi.runAllTimers();
  expect(fixture.register).toHaveBeenCalledOnce();
  const options = fixture.register.mock.calls[0]![0];
  expect(options.immediate).toBe(true);
  options.onNeedReload();
  expect(reload).not.toHaveBeenCalled();
});

describe("registration cleanup", () => {
  it("cancels deferred registration on unmount", () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    useAppUpdate();
    fixture.cleanup?.();
    vi.runAllTimers();
    expect(fixture.register).not.toHaveBeenCalled();
  });
});
