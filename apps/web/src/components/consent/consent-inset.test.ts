import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CONSENT_INSET_VAR, consentInsetPx, reserveConsentInset } from "./consent-inset";

/**
 * The cookie banner is fixed to the bottom of the viewport. On a phone it
 * covered the login page's "Sign Up" link: the shells now reserve its height,
 * which the banner publishes on <html>. Node environment, so the DOM pieces the
 * ref callback touches are stubbed; the real geometry is checked in a browser.
 */
describe("consentInsetPx", () => {
  it.each([
    [318.5, "0px", 319],
    [172, "16px", 188],
    [200, "auto", 200],
    [200, "-8px", 200],
  ])("height %s, bottom %s → %spx", (height, bottom, expected) => {
    expect(consentInsetPx(height, bottom)).toBe(expected);
  });
});

describe("reserveConsentInset", () => {
  const props = new Map<string, string>();
  const listeners = new Map<string, () => void>();
  let observed: {
    callback: () => void;
    target: unknown;
    options: unknown;
    disconnected: boolean;
  } | null;
  const banner = { offsetHeight: 300, bottom: "0px" };

  beforeEach(() => {
    props.clear();
    listeners.clear();
    observed = null;
    banner.offsetHeight = 300;
    banner.bottom = "0px";
    vi.stubGlobal("document", {
      documentElement: {
        style: {
          setProperty: (name: string, value: string) => props.set(name, value),
          removeProperty: (name: string) => props.delete(name),
        },
      },
    });
    vi.stubGlobal("window", {
      addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
      removeEventListener: (type: string, fn: () => void) => {
        if (listeners.get(type) === fn) listeners.delete(type);
      },
    });
    vi.stubGlobal("getComputedStyle", () => ({ bottom: banner.bottom }));
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          observed = { callback, target: null, options: undefined, disconnected: false };
        }
        observe(target: unknown, options?: unknown) {
          if (observed) {
            observed.target = target;
            observed.options = options;
          }
        }
        disconnect() {
          if (observed) observed.disconnected = true;
        }
      },
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const mount = () => reserveConsentInset(banner as unknown as HTMLElement);

  it("publishes the banner's height while it is mounted", () => {
    mount();
    expect(props.get(CONSENT_INSET_VAR)).toBe("300px");
    expect(observed?.target).toBe(banner);
    // The border box: the banner's bottom padding (the BottomNav's room) changes
    // without its content box changing when a navigation mounts or unmounts the
    // BottomNav.
    expect(observed?.options).toEqual({ box: "border-box" });
  });

  it("follows the banner as it resizes or moves (a breakpoint, a rotation)", () => {
    mount();
    banner.offsetHeight = 180;
    observed?.callback();
    expect(props.get(CONSENT_INSET_VAR)).toBe("180px");
    banner.bottom = "16px";
    listeners.get("resize")?.();
    expect(props.get(CONSENT_INSET_VAR)).toBe("196px");
  });

  it("removes the reservation when the banner goes (a choice was made)", () => {
    const cleanup = mount();
    cleanup?.();
    expect(props.has(CONSENT_INSET_VAR)).toBe(false);
    expect(observed?.disconnected).toBe(true);
    expect(listeners.has("resize")).toBe(false);
  });

  it("does nothing for a null ref", () => {
    expect(reserveConsentInset(null)).toBeUndefined();
    expect(props.size).toBe(0);
  });
});

describe("the reservation is wired end to end (the shells: consent-clearance-shells.test.tsx)", () => {
  const src = (path: string) => readFileSync(resolve(import.meta.dirname, "../..", path), "utf8");

  it("the banner publishes it", () => {
    // The section's own ref, not a mention in a comment.
    expect(src("components/consent/consent-banner.tsx")).toMatch(
      /<section\s+ref=\{reserveConsentInset\}\s+aria-label=/,
    );
  });

  it("index.css turns it into the clearance the shells pad by", () => {
    // The shells are `h-svh` and do not shrink for the software keyboard, so
    // the whole banner height is reserved.
    expect(src("index.css").replace(/\s+/g, " ")).toContain(
      "--consent-clearance: var(--consent-inset, 0px);",
    );
  });
});
