import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetConsentCache,
  CONSENT_STORAGE_KEY,
  CONSENT_VERSION,
  clearConsent,
  readConsent,
  readServerConsent,
  subscribeConsent,
  writeConsent,
} from "./consent";

/**
 * The consent core runs in the browser but the suite runs in node, so these
 * tests install a minimal `window` with the two surfaces the module touches:
 * `localStorage` and the `storage` event. Throwing variants cover Safari
 * private mode and "block all site data", where a consent banner that throws
 * would take the whole app down.
 */
type FakeStorage = {
  store: Map<string, string>;
  throwOnGet: boolean;
  throwOnSet: boolean;
};

let storage: FakeStorage;
let storageListeners: Set<(event: StorageEvent) => void>;

function installWindow(): void {
  storage = { store: new Map(), throwOnGet: false, throwOnSet: false };
  storageListeners = new Set();
  vi.stubGlobal("window", {
    localStorage: {
      getItem(key: string): string | null {
        if (storage.throwOnGet) throw new Error("storage blocked");
        return storage.store.get(key) ?? null;
      },
      setItem(key: string, value: string): void {
        if (storage.throwOnSet) throw new Error("storage blocked");
        storage.store.set(key, value);
      },
      removeItem(key: string): void {
        storage.store.delete(key);
      },
    },
    addEventListener(type: string, listener: (event: StorageEvent) => void): void {
      if (type === "storage") storageListeners.add(listener);
    },
    removeEventListener(type: string, listener: (event: StorageEvent) => void): void {
      if (type === "storage") storageListeners.delete(listener);
    },
  });
}

/** Simulate another tab writing consent. */
function emitStorageEvent(key: string | null): void {
  for (const listener of [...storageListeners]) {
    listener({ key } as StorageEvent);
  }
}

beforeEach(() => {
  installWindow();
  __resetConsentCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetConsentCache();
});

describe("readConsent", () => {
  it("is undecided when nothing is stored", () => {
    expect(readConsent()).toBeNull();
  });

  it("reads back a written decision from storage", () => {
    writeConsent(true);
    __resetConsentCache();
    expect(readConsent()).toEqual({ analytics: true, decidedAt: expect.any(Number) });
  });

  it("treats a decision from an older version as undecided", () => {
    storage.store.set(
      CONSENT_STORAGE_KEY,
      JSON.stringify({ v: CONSENT_VERSION - 1, analytics: true, decidedAt: 1 }),
    );
    expect(readConsent()).toBeNull();
  });

  it("treats malformed JSON as undecided", () => {
    storage.store.set(CONSENT_STORAGE_KEY, "{not json");
    expect(readConsent()).toBeNull();
  });

  it("treats a wrong-shaped payload as undecided", () => {
    storage.store.set(
      CONSENT_STORAGE_KEY,
      JSON.stringify({ v: CONSENT_VERSION, analytics: "yes", decidedAt: 1 }),
    );
    expect(readConsent()).toBeNull();
  });

  it("returns undecided instead of throwing when storage is blocked", () => {
    storage.throwOnGet = true;
    expect(readConsent()).toBeNull();
  });

  it("is undecided on the server", () => {
    vi.unstubAllGlobals();
    __resetConsentCache();
    expect(readConsent()).toBeNull();
    expect(readServerConsent()).toBeNull();
  });

  it("returns a stable snapshot reference between reads", () => {
    writeConsent(false);
    expect(readConsent()).toBe(readConsent());
  });
});

describe("writeConsent", () => {
  it("records a rejection as an explicit decision", () => {
    writeConsent(false);
    expect(readConsent()).toEqual({ analytics: false, decidedAt: expect.any(Number) });
  });

  it("keeps the decision for this page view when storage is unwritable", () => {
    storage.throwOnSet = true;
    expect(writeConsent(true)).toEqual({ analytics: true, decidedAt: expect.any(Number) });
    expect(readConsent()?.analytics).toBe(true);
    expect(storage.store.size).toBe(0);
  });
});

describe("clearConsent", () => {
  it("removes the decision so the banner reappears", () => {
    writeConsent(true);
    clearConsent();
    expect(readConsent()).toBeNull();
    expect(storage.store.has(CONSENT_STORAGE_KEY)).toBe(false);
  });
});

describe("subscribeConsent", () => {
  it("notifies subscribers on write and stops after unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeConsent(listener);
    writeConsent(true);
    clearConsent();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    writeConsent(false);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("picks up a decision made in another tab", () => {
    const listener = vi.fn();
    subscribeConsent(listener);
    storage.store.set(
      CONSENT_STORAGE_KEY,
      JSON.stringify({ v: CONSENT_VERSION, analytics: true, decidedAt: 1 }),
    );
    emitStorageEvent(CONSENT_STORAGE_KEY);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(readConsent()).toEqual({ analytics: true, decidedAt: 1 });
  });

  it("ignores storage events for unrelated keys", () => {
    const listener = vi.fn();
    subscribeConsent(listener);
    emitStorageEvent("vite-ui-theme");
    expect(listener).not.toHaveBeenCalled();
  });
});
