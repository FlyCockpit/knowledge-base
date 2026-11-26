import { describe, expect, it, vi } from "vitest";

import { FIRST_INVALID_SELECTOR, focusFirstInvalidField } from "./focus-first-invalid";

function fakeControl() {
  return { focus: vi.fn(), scrollIntoView: vi.fn() };
}

describe("focusFirstInvalidField", () => {
  it("focuses and reveals the first invalid control, after React commits", () => {
    const control = fakeControl();
    const root = { querySelector: vi.fn(() => control) };
    const frames: Array<() => void> = [];
    focusFirstInvalidField(root as never, (callback) => frames.push(callback));

    // Nothing happens synchronously: the aria-invalid attributes are not in
    // the DOM yet when onSubmitInvalid runs.
    expect(root.querySelector).not.toHaveBeenCalled();
    frames[0]?.();
    expect(root.querySelector).toHaveBeenCalledWith(FIRST_INVALID_SELECTOR);
    expect(control.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(control.scrollIntoView).toHaveBeenCalledWith({ block: "center", inline: "nearest" });
  });

  it("does nothing without a root or an invalid control", () => {
    const schedule = vi.fn((callback: () => void) => callback());
    expect(focusFirstInvalidField(null, schedule)).toBeUndefined();
    expect(schedule).not.toHaveBeenCalled();
    focusFirstInvalidField({ querySelector: () => null } as never, schedule);
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  it("opens every closed section around the control before focusing it", () => {
    const outer = { open: false, parentElement: null };
    const inner = {
      open: false,
      parentElement: { closest: (selector: string) => (selector === "details" ? outer : null) },
    };
    const order: string[] = [];
    const control = {
      closest: (selector: string) => (selector === "details" ? inner : null),
      focus: vi.fn(() => order.push(`focus:${inner.open && outer.open}`)),
      scrollIntoView: vi.fn(),
    };
    focusFirstInvalidField({ querySelector: () => control } as never, (callback) => callback());
    expect(inner.open).toBe(true);
    expect(outer.open).toBe(true);
    expect(order).toEqual(["focus:true"]);
  });

  it("skips disabled controls", () => {
    // `:disabled` also covers controls inside a disabled fieldset.
    expect(FIRST_INVALID_SELECTOR).toContain(":not(:disabled)");
  });
});
