import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  claimReloadSlot,
  recoverFromStaleChunk,
  STALE_BUILD_RELOAD_COOLDOWN_MS,
  STALE_BUILD_RELOAD_KEY,
  type StaleBuildRecoveryEnv,
} from "./stale-build-recovery";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    data,
  };
}

const idle = {
  latestLocation: { href: "/en-US/overview", publicHref: "/en-US/overview" },
  state: { isLoading: false, resolvedLocation: { href: "/en-US/overview" } },
};
const navigating = {
  latestLocation: { href: "/en-US/nodes?tab=all", publicHref: "/en-US/nodes?tab=all" },
  state: { isLoading: true, resolvedLocation: { href: "/en-US/overview" } },
};

function env(overrides: Partial<StaleBuildRecoveryEnv> = {}) {
  const storage = memoryStorage();
  return {
    storageData: storage.data,
    router: navigating,
    storage,
    now: 1_000_000,
    activatedNavigationHref: navigating.latestLocation.publicHref,
    assign: vi.fn(),
    reload: vi.fn(),
    ...overrides,
  };
}

describe("recoverFromStaleChunk", () => {
  it("navigates fully to the page the router was going to", () => {
    const e = env();
    expect(recoverFromStaleChunk(e)).toBe(true);
    expect(e.assign).toHaveBeenCalledWith("/en-US/nodes?tab=all");
    expect(e.reload).not.toHaveBeenCalled();
    expect(e.storageData.get(STALE_BUILD_RELOAD_KEY)).toBe("1000000");
  });

  it("preserves an unsaved draft when unrelated input accompanies a background import failure", () => {
    const e = env({ router: idle });
    expect(recoverFromStaleChunk(e)).toBe(false);
    expect(e.reload).not.toHaveBeenCalled();
    expect(e.assign).not.toHaveBeenCalled();
  });

  it("ignores a failed hover/intent preload so hovering a link never reloads", () => {
    const e = env({ router: idle, activatedNavigationHref: undefined });
    expect(recoverFromStaleChunk(e)).toBe(false);
    expect(e.reload).not.toHaveBeenCalled();
    expect(e.assign).not.toHaveBeenCalled();
    expect(e.storageData.has(STALE_BUILD_RELOAD_KEY)).toBe(false);
  });

  it("refuses programmatic navigation and an activation belonging to another target", () => {
    for (const activatedNavigationHref of [undefined, "/en-US/other"]) {
      const e = env({ activatedNavigationHref });
      expect(recoverFromStaleChunk(e)).toBe(false);
      expect(e.assign).not.toHaveBeenCalled();
    }
  });
  it("does not turn a hash-only change into a full document navigation", () => {
    const router = {
      ...navigating,
      state: { isLoading: true, resolvedLocation: { href: "/en-US/nodes?tab=all#old" } },
    };
    const e = env({ router });
    expect(recoverFromStaleChunk(e)).toBe(false);
    expect(e.assign).not.toHaveBeenCalled();
  });
  it("does nothing again within the cooldown, so it cannot loop", () => {
    const storage = memoryStorage({ [STALE_BUILD_RELOAD_KEY]: "1000000" });
    const e = env({ storage, now: 1_000_000 + STALE_BUILD_RELOAD_COOLDOWN_MS - 1 });
    expect(recoverFromStaleChunk(e)).toBe(false);
    expect(e.assign).not.toHaveBeenCalled();
  });

  it("recovers again once the cooldown has passed", () => {
    const storage = memoryStorage({ [STALE_BUILD_RELOAD_KEY]: "1000000" });
    const e = env({ storage, now: 1_000_000 + STALE_BUILD_RELOAD_COOLDOWN_MS });
    expect(recoverFromStaleChunk(e)).toBe(true);
  });
});

describe("claimReloadSlot", () => {
  it("refuses when storage is unavailable or throws", () => {
    expect(claimReloadSlot(undefined, 1)).toBe(false);
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {},
    };
    expect(claimReloadSlot(throwing, 1)).toBe(false);
  });

  it("ignores a garbage or future timestamp", () => {
    expect(claimReloadSlot(memoryStorage({ [STALE_BUILD_RELOAD_KEY]: "nope" }), 5)).toBe(true);
    expect(claimReloadSlot(memoryStorage({ [STALE_BUILD_RELOAD_KEY]: "9999" }), 5)).toBe(true);
  });
});

// Exercise activation timing through the hook, including editor input that
// arrives after a background navigation/preload has already begun.
const hook = vi.hoisted(() => ({
  router: undefined as unknown,
  callbacks: new Map<string, (event: { toLocation: { publicHref: string } }) => void>(),
  cleanup: undefined as (() => void) | undefined,
}));
vi.mock("@tanstack/react-router", () => ({ useRouter: () => hook.router }));
vi.mock("@/hooks/use-mount-effect", () => ({
  useMountEffect: (effect: () => () => void) => {
    hook.cleanup = effect();
  },
}));
const { useStaleBuildRecovery } = await import("../hooks/use-stale-build-recovery");
afterEach(() => {
  hook.cleanup?.();
  hook.cleanup = undefined;
  hook.callbacks.clear();
  vi.unstubAllGlobals();
});
function RecoveryHarness() {
  useStaleBuildRecovery();
  return null;
}
function recoveryHook() {
  const assign = vi.fn();
  const win = Object.assign(new EventTarget(), {
    sessionStorage: memoryStorage(),
    location: { assign },
  });
  const router = {
    ...navigating,
    state: { ...navigating.state },
    subscribe: (
      name: string,
      callback: (event: { toLocation: { publicHref: string } }) => void,
    ) => {
      hook.callbacks.set(name, callback);
      return () => hook.callbacks.delete(name);
    },
  };
  hook.router = router;
  vi.stubGlobal("window", win);
  renderToStaticMarkup(createElement(RecoveryHarness));
  const navigation = () =>
    hook.callbacks.get("onBeforeNavigate")?.({ toLocation: navigating.latestLocation });
  const failure = () => {
    const event = new Event("vite:preloadError", { cancelable: true });
    win.dispatchEvent(event);
    return event;
  };
  return { win, router, navigation, failure, assign };
}
describe("stale recovery activation ownership", () => {
  it("does not authorize an already pending import with a later editor click", () => {
    const h = recoveryHook();
    h.navigation();
    h.win.dispatchEvent(new Event("pointerdown"));
    expect(h.failure().defaultPrevented).toBe(false);
    expect(h.assign).not.toHaveBeenCalled();
  });
  it("leaves the error UI in control when there is no pending navigation", () => {
    const h = recoveryHook();
    h.router.state.isLoading = false;
    h.win.dispatchEvent(new Event("pointerdown"));
    expect(h.failure().defaultPrevented).toBe(false);
    expect(h.assign).not.toHaveBeenCalled();
  });
  it("recovers a pending navigation started by activation and coalesces its chunk errors", () => {
    const h = recoveryHook();
    h.win.dispatchEvent(new Event("pointerdown"));
    h.navigation();
    expect(h.failure().defaultPrevented).toBe(true);
    expect(h.failure().defaultPrevented).toBe(true);
    expect(h.assign).toHaveBeenCalledExactlyOnceWith(navigating.latestLocation.publicHref);
  });
});
