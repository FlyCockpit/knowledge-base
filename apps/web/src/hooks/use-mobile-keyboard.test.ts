import { describe, expect, it } from "vitest";

import { MOBILE_BREAKPOINT_PX } from "./use-media-query";
import {
  getMobileKeyboardDecision,
  isEditableFocusSnapshot,
  isEditableFocusTarget,
  isKeyboardSummoningInputType,
  keyboardInsetPx,
  MOBILE_KEYBOARD_DISMISS_GROWTH_PX,
  MOBILE_KEYBOARD_HEIGHT_RATIO,
  visualViewportGrewPastDismissThreshold,
} from "./use-mobile-keyboard";

const mobileFocused = {
  viewportWidth: 390,
  visualViewportHeight: 700,
  visualViewportScale: 1,
  baselineHeight: 700,
  editableFocused: true,
  virtualKeyboardOpened: null,
  geometryChanged: false,
} as const;

describe("getMobileKeyboardDecision", () => {
  it("never treats desktop widths as a software keyboard", () => {
    expect(
      getMobileKeyboardDecision({
        ...mobileFocused,
        viewportWidth: MOBILE_BREAKPOINT_PX,
        visualViewportHeight: 400,
      }),
    ).toEqual({ nextBaselineUnproven: false, isKeyboardOpen: false, nextBaselineHeight: 400 });
  });

  it("never treats widths above the mobile breakpoint as a software keyboard", () => {
    expect(
      getMobileKeyboardDecision({
        ...mobileFocused,
        viewportWidth: 1280,
        visualViewportHeight: 500,
        baselineHeight: 900,
      }),
    ).toEqual({ nextBaselineUnproven: false, isKeyboardOpen: false, nextBaselineHeight: 500 });
  });

  it("recaptures the baseline on mobile when no editable is focused", () => {
    expect(
      getMobileKeyboardDecision({
        ...mobileFocused,
        editableFocused: false,
        visualViewportHeight: 640,
      }),
    ).toEqual({ nextBaselineUnproven: false, isKeyboardOpen: false, nextBaselineHeight: 640 });
  });

  it("does not hide chrome when an editable is focused without a height drop", () => {
    expect(getMobileKeyboardDecision(mobileFocused)).toEqual({
      nextBaselineUnproven: false,
      isKeyboardOpen: false,
      nextBaselineHeight: 700,
    });
  });

  it("treats a focused mobile field plus a height drop as a software keyboard", () => {
    const droppedHeight = mobileFocused.baselineHeight * MOBILE_KEYBOARD_HEIGHT_RATIO - 1;
    expect(
      getMobileKeyboardDecision({
        ...mobileFocused,
        visualViewportHeight: droppedHeight,
      }),
    ).toEqual({ nextBaselineUnproven: false, isKeyboardOpen: true, nextBaselineHeight: 700 });
  });

  it("does not treat a height drop as a keyboard when nothing is focused", () => {
    expect(
      getMobileKeyboardDecision({
        ...mobileFocused,
        editableFocused: false,
        visualViewportHeight: 400,
      }),
    ).toEqual({ nextBaselineUnproven: false, isKeyboardOpen: false, nextBaselineHeight: 400 });
  });

  it("does not recapture a pinch-zoomed height on blur", () => {
    expect(
      getMobileKeyboardDecision({
        ...mobileFocused,
        editableFocused: false,
        visualViewportScale: 1.25,
        visualViewportHeight: 400,
      }),
    ).toEqual({
      nextBaselineUnproven: false,
      isKeyboardOpen: false,
      nextBaselineHeight: 700,
    });
  });

  it("does not recapture a pinch-zoomed height when VirtualKeyboard reports closed", () => {
    expect(
      getMobileKeyboardDecision({
        ...mobileFocused,
        visualViewportScale: 1.25,
        visualViewportHeight: 400,
        virtualKeyboardOpened: false,
      }),
    ).toEqual({
      nextBaselineUnproven: false,
      isKeyboardOpen: false,
      nextBaselineHeight: 700,
    });
  });

  it("does not hide chrome while pinch-zoomed even if height dropped", () => {
    expect(
      getMobileKeyboardDecision({
        ...mobileFocused,
        visualViewportScale: 1.25,
        visualViewportHeight: 400,
      }),
    ).toEqual({ nextBaselineUnproven: false, isKeyboardOpen: false, nextBaselineHeight: 700 });
  });

  it("treats an explicit VirtualKeyboard signal as open on a focused mobile field", () => {
    expect(
      getMobileKeyboardDecision({
        ...mobileFocused,
        virtualKeyboardOpened: true,
      }),
    ).toEqual({ nextBaselineUnproven: false, isKeyboardOpen: true, nextBaselineHeight: 700 });
  });

  it("ignores VirtualKeyboard when the viewport is desktop or pinch-zoomed", () => {
    expect(
      getMobileKeyboardDecision({
        ...mobileFocused,
        viewportWidth: MOBILE_BREAKPOINT_PX,
        virtualKeyboardOpened: true,
        visualViewportHeight: 400,
      }),
    ).toEqual({ nextBaselineUnproven: false, isKeyboardOpen: false, nextBaselineHeight: 400 });
    expect(
      getMobileKeyboardDecision({
        ...mobileFocused,
        visualViewportScale: 2,
        virtualKeyboardOpened: true,
        visualViewportHeight: 400,
      }),
    ).toEqual({ nextBaselineUnproven: false, isKeyboardOpen: false, nextBaselineHeight: 700 });
  });

  it("recaptures the baseline when width or orientation layout changes", () => {
    expect(
      getMobileKeyboardDecision({
        ...mobileFocused,
        geometryChanged: true,
        visualViewportHeight: 620,
      }),
    ).toEqual({ nextBaselineUnproven: false, isKeyboardOpen: false, nextBaselineHeight: 620 });
  });

  it("keeps the previous baseline when VirtualKeyboard is already open during a geometry change", () => {
    expect(
      getMobileKeyboardDecision({
        ...mobileFocused,
        geometryChanged: true,
        visualViewportHeight: 620,
        virtualKeyboardOpened: true,
      }),
    ).toEqual({ nextBaselineUnproven: false, isKeyboardOpen: true, nextBaselineHeight: 700 });
  });

  it("recaptures on rotate while focused when the keyboard was not already open", () => {
    const droppedHeight = mobileFocused.baselineHeight * MOBILE_KEYBOARD_HEIGHT_RATIO - 1;
    expect(
      getMobileKeyboardDecision({
        ...mobileFocused,
        geometryChanged: true,
        previouslyKeyboardOpen: false,
        visualViewportHeight: droppedHeight,
      }),
    ).toEqual({
      nextBaselineUnproven: false,
      isKeyboardOpen: false,
      nextBaselineHeight: droppedHeight,
    });
  });

  it("closes without adopting a shrunken height when no orientation baseline is known", () => {
    const droppedHeight = mobileFocused.baselineHeight * MOBILE_KEYBOARD_HEIGHT_RATIO - 1;
    expect(
      getMobileKeyboardDecision({
        ...mobileFocused,
        geometryChanged: true,
        previouslyKeyboardOpen: true,
        visualViewportHeight: droppedHeight,
      }),
    ).toEqual({
      nextBaselineUnproven: true,
      isKeyboardOpen: false,
      nextBaselineHeight: 700,
    });
  });

  it("compares against a stored orientation baseline after rotate instead of the previous portrait one", () => {
    const landscapeBaseline = 390;
    const landscapeKeyboardHeight = 220;
    expect(landscapeKeyboardHeight).toBeLessThan(landscapeBaseline * MOBILE_KEYBOARD_HEIGHT_RATIO);
    expect(
      getMobileKeyboardDecision({
        ...mobileFocused,
        baselineHeight: 844,
        previousVisualViewportHeight: 500,
        visualViewportHeight: landscapeKeyboardHeight,
        previouslyKeyboardOpen: true,
        geometryChanged: true,
        layoutChanged: true,
        orientationBaselineHeight: landscapeBaseline,
      }),
    ).toEqual({
      nextBaselineUnproven: false,
      isKeyboardOpen: true,
      nextBaselineHeight: landscapeBaseline,
    });
  });

  it("detects an initially open keyboard from a larger layout viewport", () => {
    expect(
      getMobileKeyboardDecision({
        ...mobileFocused,
        baselineHeight: 0,
        visualViewportHeight: 500,
        layoutViewportHeight: 844,
      }),
    ).toEqual({ nextBaselineUnproven: false, isKeyboardOpen: true, nextBaselineHeight: 844 });
  });

  it("keeps an equal initial focused viewport unproven without VirtualKeyboard", () => {
    expect(
      getMobileKeyboardDecision({
        ...mobileFocused,
        baselineHeight: 0,
        visualViewportHeight: 500,
        layoutViewportHeight: 500,
      }),
    ).toEqual({ nextBaselineUnproven: true, isKeyboardOpen: false, nextBaselineHeight: 500 });
  });

  it("recaptures an uncertain initial baseline after blur", () => {
    const initial = getMobileKeyboardDecision({
      ...mobileFocused,
      baselineHeight: 0,
      visualViewportHeight: 500,
      layoutViewportHeight: 500,
    });

    expect(
      getMobileKeyboardDecision({
        ...mobileFocused,
        baselineHeight: initial.nextBaselineHeight,
        editableFocused: false,
        previouslyBaselineUnproven: initial.nextBaselineUnproven,
        previousVisualViewportHeight: 500,
        visualViewportHeight: 700,
        layoutViewportHeight: 700,
      }),
    ).toEqual({ nextBaselineUnproven: false, isKeyboardOpen: false, nextBaselineHeight: 700 });
  });

  it("trusts an initially open VirtualKeyboard even when viewport heights match", () => {
    expect(
      getMobileKeyboardDecision({
        ...mobileFocused,
        baselineHeight: 0,
        visualViewportHeight: 500,
        layoutViewportHeight: 500,
        virtualKeyboardOpened: true,
      }),
    ).toEqual({ nextBaselineUnproven: false, isKeyboardOpen: true, nextBaselineHeight: 500 });
  });

  it("keeps the unfocused baseline while focused so a later drop can be detected", () => {
    const decision = getMobileKeyboardDecision({
      ...mobileFocused,
      baselineHeight: 844,
      visualViewportHeight: 844,
    });

    expect(decision).toEqual({
      nextBaselineUnproven: false,
      isKeyboardOpen: false,
      nextBaselineHeight: 844,
    });
    expect(
      getMobileKeyboardDecision({
        ...mobileFocused,
        baselineHeight: decision.nextBaselineHeight,
        visualViewportHeight: 500,
      }),
    ).toEqual({ nextBaselineUnproven: false, isKeyboardOpen: true, nextBaselineHeight: 844 });
  });

  it("recaptures and closes when height grows after rotate while still below the old baseline", () => {
    const portraitBaseline = 844;
    const landscapeKeyboardHeight = 220;
    const landscapeFullHeight = 390;
    expect(landscapeFullHeight).toBeLessThan(portraitBaseline * MOBILE_KEYBOARD_HEIGHT_RATIO);
    expect(landscapeFullHeight - landscapeKeyboardHeight).toBeGreaterThanOrEqual(
      MOBILE_KEYBOARD_DISMISS_GROWTH_PX,
    );

    expect(
      getMobileKeyboardDecision({
        ...mobileFocused,
        baselineHeight: portraitBaseline,
        previousVisualViewportHeight: landscapeKeyboardHeight,
        visualViewportHeight: landscapeFullHeight,
        previouslyKeyboardOpen: true,
        geometryChanged: false,
      }),
    ).toEqual({
      nextBaselineUnproven: false,
      isKeyboardOpen: false,
      nextBaselineHeight: landscapeFullHeight,
    });
  });

  it("stays open and keeps the old baseline when height stays shrunken or shrinks further", () => {
    const portraitBaseline = 844;
    const landscapeKeyboardHeight = 250;
    const stillShrunkenHeight = 220;

    expect(
      getMobileKeyboardDecision({
        ...mobileFocused,
        baselineHeight: portraitBaseline,
        previousVisualViewportHeight: landscapeKeyboardHeight,
        visualViewportHeight: landscapeKeyboardHeight,
        previouslyKeyboardOpen: true,
        geometryChanged: false,
      }),
    ).toEqual({
      nextBaselineUnproven: false,
      isKeyboardOpen: true,
      nextBaselineHeight: portraitBaseline,
    });
    expect(
      getMobileKeyboardDecision({
        ...mobileFocused,
        baselineHeight: portraitBaseline,
        previousVisualViewportHeight: landscapeKeyboardHeight,
        visualViewportHeight: stillShrunkenHeight,
        previouslyKeyboardOpen: true,
        geometryChanged: false,
      }),
    ).toEqual({
      nextBaselineUnproven: false,
      isKeyboardOpen: true,
      nextBaselineHeight: portraitBaseline,
    });
  });

  it("closes after a no-VirtualKeyboard rotate-and-dismiss when the new height matches a stored orientation baseline", () => {
    const portraitBaseline = 844;
    const landscapeFullHeight = 390;

    const rotated = getMobileKeyboardDecision({
      ...mobileFocused,
      baselineHeight: portraitBaseline,
      previousVisualViewportHeight: 500,
      visualViewportHeight: landscapeFullHeight,
      previouslyKeyboardOpen: true,
      geometryChanged: true,
      layoutChanged: true,
      orientationBaselineHeight: landscapeFullHeight,
    });
    expect(rotated).toEqual({
      nextBaselineUnproven: false,
      isKeyboardOpen: false,
      nextBaselineHeight: landscapeFullHeight,
    });

    expect(
      getMobileKeyboardDecision({
        ...mobileFocused,
        baselineHeight: rotated.nextBaselineHeight,
        previousVisualViewportHeight: landscapeFullHeight,
        visualViewportHeight: landscapeFullHeight,
        previouslyKeyboardOpen: rotated.isKeyboardOpen,
        geometryChanged: false,
        layoutChanged: false,
        orientationBaselineHeight: landscapeFullHeight,
      }),
    ).toEqual({
      nextBaselineUnproven: false,
      isKeyboardOpen: false,
      nextBaselineHeight: landscapeFullHeight,
    });
  });

  it("keeps an unproven baseline after rotate into an unseen orientation, then recaptures on dismiss-sized growth", () => {
    const portraitBaseline = 844;
    const landscapeKeyboardHeight = 220;
    const landscapeFullHeight = 390;

    const rotated = getMobileKeyboardDecision({
      ...mobileFocused,
      baselineHeight: portraitBaseline,
      previousVisualViewportHeight: 500,
      visualViewportHeight: landscapeKeyboardHeight,
      previouslyKeyboardOpen: true,
      geometryChanged: true,
      layoutChanged: true,
    });
    expect(rotated).toEqual({
      nextBaselineUnproven: true,
      isKeyboardOpen: false,
      nextBaselineHeight: portraitBaseline,
    });

    const stillUnproven = getMobileKeyboardDecision({
      ...mobileFocused,
      baselineHeight: rotated.nextBaselineHeight,
      previousVisualViewportHeight: landscapeKeyboardHeight,
      visualViewportHeight: landscapeKeyboardHeight,
      previouslyKeyboardOpen: rotated.isKeyboardOpen,
      previouslyBaselineUnproven: rotated.nextBaselineUnproven,
      geometryChanged: false,
    });
    expect(stillUnproven).toEqual({
      nextBaselineUnproven: true,
      isKeyboardOpen: false,
      nextBaselineHeight: portraitBaseline,
    });

    const dismissed = getMobileKeyboardDecision({
      ...mobileFocused,
      baselineHeight: stillUnproven.nextBaselineHeight,
      previousVisualViewportHeight: landscapeKeyboardHeight,
      visualViewportHeight: landscapeFullHeight,
      previouslyKeyboardOpen: stillUnproven.isKeyboardOpen,
      previouslyBaselineUnproven: stillUnproven.nextBaselineUnproven,
      geometryChanged: false,
    });
    expect(dismissed).toEqual({
      nextBaselineUnproven: false,
      isKeyboardOpen: false,
      nextBaselineHeight: landscapeFullHeight,
    });

    expect(
      getMobileKeyboardDecision({
        ...mobileFocused,
        baselineHeight: dismissed.nextBaselineHeight,
        previousVisualViewportHeight: landscapeFullHeight,
        visualViewportHeight: landscapeKeyboardHeight,
        previouslyKeyboardOpen: dismissed.isKeyboardOpen,
        previouslyBaselineUnproven: dismissed.nextBaselineUnproven,
        geometryChanged: false,
        orientationBaselineHeight: landscapeFullHeight,
      }),
    ).toEqual({
      nextBaselineUnproven: false,
      isKeyboardOpen: true,
      nextBaselineHeight: landscapeFullHeight,
    });
  });

  it("accumulates dismiss-sized growth across multiple unproven frames", () => {
    const portraitBaseline = 844;
    const midHeight = 300;
    const landscapeFullHeight = 390;

    const unproven = getMobileKeyboardDecision({
      ...mobileFocused,
      baselineHeight: portraitBaseline,
      previousVisualViewportHeight: 500,
      visualViewportHeight: 220,
      previouslyKeyboardOpen: true,
      geometryChanged: true,
      layoutChanged: true,
    });
    expect(unproven.nextBaselineUnproven).toBe(true);

    const mid = getMobileKeyboardDecision({
      ...mobileFocused,
      baselineHeight: unproven.nextBaselineHeight,
      previousVisualViewportHeight: 220,
      visualViewportHeight: midHeight,
      previouslyKeyboardOpen: false,
      previouslyBaselineUnproven: true,
      minUnprovenVisualViewportHeight: 220,
      geometryChanged: false,
    });
    expect(mid).toEqual({
      nextBaselineUnproven: true,
      isKeyboardOpen: false,
      nextBaselineHeight: portraitBaseline,
    });

    expect(
      getMobileKeyboardDecision({
        ...mobileFocused,
        baselineHeight: mid.nextBaselineHeight,
        previousVisualViewportHeight: midHeight,
        visualViewportHeight: landscapeFullHeight,
        previouslyKeyboardOpen: false,
        previouslyBaselineUnproven: true,
        minUnprovenVisualViewportHeight: 220,
        geometryChanged: false,
      }),
    ).toEqual({
      nextBaselineUnproven: false,
      isKeyboardOpen: false,
      nextBaselineHeight: landscapeFullHeight,
    });
  });

  it("clears unproven when rotating back to an orientation with a stored baseline", () => {
    const portraitBaseline = 844;
    const portraitKeyboardHeight = 500;

    const unseenLandscape = getMobileKeyboardDecision({
      ...mobileFocused,
      baselineHeight: portraitBaseline,
      previousVisualViewportHeight: portraitKeyboardHeight,
      visualViewportHeight: 220,
      previouslyKeyboardOpen: true,
      geometryChanged: true,
      layoutChanged: true,
    });
    expect(unseenLandscape.nextBaselineUnproven).toBe(true);

    expect(
      getMobileKeyboardDecision({
        ...mobileFocused,
        baselineHeight: unseenLandscape.nextBaselineHeight,
        previousVisualViewportHeight: 220,
        visualViewportHeight: portraitKeyboardHeight,
        previouslyKeyboardOpen: false,
        previouslyBaselineUnproven: true,
        geometryChanged: true,
        layoutChanged: true,
        orientationBaselineHeight: portraitBaseline,
      }),
    ).toEqual({
      nextBaselineUnproven: false,
      isKeyboardOpen: true,
      nextBaselineHeight: portraitBaseline,
    });
  });

  it("does not adopt a shrunken height on a follow-up layout event while unproven", () => {
    const portraitBaseline = 844;
    const landscapeKeyboardHeight = 220;

    const rotated = getMobileKeyboardDecision({
      ...mobileFocused,
      baselineHeight: portraitBaseline,
      previousVisualViewportHeight: 500,
      visualViewportHeight: landscapeKeyboardHeight,
      previouslyKeyboardOpen: true,
      geometryChanged: true,
      layoutChanged: true,
    });
    expect(rotated.nextBaselineUnproven).toBe(true);

    expect(
      getMobileKeyboardDecision({
        ...mobileFocused,
        baselineHeight: rotated.nextBaselineHeight,
        previousVisualViewportHeight: landscapeKeyboardHeight,
        visualViewportHeight: landscapeKeyboardHeight,
        previouslyKeyboardOpen: false,
        previouslyBaselineUnproven: true,
        geometryChanged: true,
        layoutChanged: true,
      }),
    ).toEqual({
      nextBaselineUnproven: true,
      isKeyboardOpen: false,
      nextBaselineHeight: portraitBaseline,
    });
  });

  it("does not treat sub-threshold growth as a dismiss", () => {
    const portraitBaseline = 844;
    const previousHeight = 220;
    const jitterHeight = previousHeight + MOBILE_KEYBOARD_DISMISS_GROWTH_PX - 1;

    expect(
      getMobileKeyboardDecision({
        ...mobileFocused,
        baselineHeight: portraitBaseline,
        previousVisualViewportHeight: previousHeight,
        visualViewportHeight: jitterHeight,
        previouslyKeyboardOpen: true,
        geometryChanged: false,
      }),
    ).toEqual({
      nextBaselineUnproven: false,
      isKeyboardOpen: true,
      nextBaselineHeight: portraitBaseline,
    });
  });

  it("does not recapture on URL-bar chrome growth while the keyboard is still open", () => {
    const portraitBaseline = 844;
    const keyboardHeight = 500;
    const chromeGrownHeight = keyboardHeight + 80;

    expect(80).toBeLessThan(MOBILE_KEYBOARD_DISMISS_GROWTH_PX);
    expect(chromeGrownHeight).toBeLessThan(portraitBaseline * MOBILE_KEYBOARD_HEIGHT_RATIO);
    expect(
      getMobileKeyboardDecision({
        ...mobileFocused,
        baselineHeight: portraitBaseline,
        previousVisualViewportHeight: keyboardHeight,
        visualViewportHeight: chromeGrownHeight,
        previouslyKeyboardOpen: true,
        geometryChanged: false,
      }),
    ).toEqual({
      nextBaselineUnproven: false,
      isKeyboardOpen: true,
      nextBaselineHeight: portraitBaseline,
    });
  });

  it("lets VirtualKeyboard true win as open even when height grew after rotate", () => {
    expect(
      getMobileKeyboardDecision({
        ...mobileFocused,
        baselineHeight: 844,
        previousVisualViewportHeight: 220,
        visualViewportHeight: 390,
        previouslyKeyboardOpen: true,
        geometryChanged: false,
        virtualKeyboardOpened: true,
      }),
    ).toEqual({ nextBaselineUnproven: false, isKeyboardOpen: true, nextBaselineHeight: 844 });
  });

  it("recaptures and closes on VirtualKeyboard false plus height growth", () => {
    expect(
      getMobileKeyboardDecision({
        ...mobileFocused,
        baselineHeight: 844,
        previousVisualViewportHeight: 220,
        visualViewportHeight: 390,
        previouslyKeyboardOpen: true,
        geometryChanged: false,
        virtualKeyboardOpened: false,
      }),
    ).toEqual({ nextBaselineUnproven: false, isKeyboardOpen: false, nextBaselineHeight: 390 });
  });

  it("treats VirtualKeyboard false as closed without requiring dismiss growth", () => {
    expect(
      getMobileKeyboardDecision({
        ...mobileFocused,
        baselineHeight: 844,
        previousVisualViewportHeight: 220,
        visualViewportHeight: 250,
        previouslyKeyboardOpen: true,
        geometryChanged: false,
        virtualKeyboardOpened: false,
      }),
    ).toEqual({ nextBaselineUnproven: false, isKeyboardOpen: false, nextBaselineHeight: 250 });
  });

  it("closes on VirtualKeyboard false during a rotate even if the new height is still below the old baseline", () => {
    expect(
      getMobileKeyboardDecision({
        ...mobileFocused,
        baselineHeight: 844,
        previousVisualViewportHeight: 500,
        visualViewportHeight: 390,
        previouslyKeyboardOpen: true,
        geometryChanged: true,
        layoutChanged: true,
        virtualKeyboardOpened: false,
      }),
    ).toEqual({ nextBaselineUnproven: false, isKeyboardOpen: false, nextBaselineHeight: 390 });
  });

  it("keeps the unzoomed baseline through pinch and reopens against it on unpinch", () => {
    const open = getMobileKeyboardDecision({
      ...mobileFocused,
      visualViewportHeight: 500,
    });
    expect(open).toEqual({
      nextBaselineUnproven: false,
      isKeyboardOpen: true,
      nextBaselineHeight: 700,
    });

    const pinched = getMobileKeyboardDecision({
      ...mobileFocused,
      baselineHeight: open.nextBaselineHeight,
      visualViewportScale: 1.25,
      visualViewportHeight: 400,
      previouslyKeyboardOpen: open.isKeyboardOpen,
      geometryChanged: true,
      layoutChanged: false,
    });
    expect(pinched).toEqual({
      nextBaselineUnproven: false,
      isKeyboardOpen: false,
      nextBaselineHeight: 700,
    });

    const unpinched = getMobileKeyboardDecision({
      ...mobileFocused,
      baselineHeight: pinched.nextBaselineHeight,
      visualViewportScale: 1,
      visualViewportHeight: 500,
      previouslyKeyboardOpen: pinched.isKeyboardOpen,
      previousVisualViewportHeight: 400,
      geometryChanged: true,
      layoutChanged: false,
    });
    expect(unpinched).toEqual({
      nextBaselineUnproven: false,
      isKeyboardOpen: true,
      nextBaselineHeight: 700,
    });
  });
});

describe("visualViewportGrewPastDismissThreshold", () => {
  it("requires growth of at least MOBILE_KEYBOARD_DISMISS_GROWTH_PX", () => {
    expect(
      visualViewportGrewPastDismissThreshold(220, 220 + MOBILE_KEYBOARD_DISMISS_GROWTH_PX),
    ).toBe(true);
    expect(
      visualViewportGrewPastDismissThreshold(220, 220 + MOBILE_KEYBOARD_DISMISS_GROWTH_PX - 1),
    ).toBe(false);
    expect(visualViewportGrewPastDismissThreshold(0, 400)).toBe(false);
  });

  it("does not treat URL-bar chrome growth as a dismiss", () => {
    expect(visualViewportGrewPastDismissThreshold(500, 580)).toBe(false);
  });

  it("treats software-keyboard sized growth as a dismiss", () => {
    expect(visualViewportGrewPastDismissThreshold(500, 700)).toBe(true);
  });
});

describe("isKeyboardSummoningInputType", () => {
  it("treats empty and text-like types as keyboard-summoning", () => {
    expect(isKeyboardSummoningInputType("")).toBe(true);
    expect(isKeyboardSummoningInputType("text")).toBe(true);
    expect(isKeyboardSummoningInputType("TEXT")).toBe(true);
    expect(isKeyboardSummoningInputType("search")).toBe(true);
    expect(isKeyboardSummoningInputType("email")).toBe(true);
    expect(isKeyboardSummoningInputType("tel")).toBe(true);
    expect(isKeyboardSummoningInputType("url")).toBe(true);
    expect(isKeyboardSummoningInputType("password")).toBe(true);
    expect(isKeyboardSummoningInputType("number")).toBe(true);
  });

  it("excludes non-text input types that do not open a software keyboard", () => {
    for (const type of [
      "button",
      "submit",
      "reset",
      "checkbox",
      "radio",
      "file",
      "hidden",
      "image",
      "range",
      "color",
      "date",
      "time",
      "datetime-local",
      "month",
      "week",
    ]) {
      expect(isKeyboardSummoningInputType(type)).toBe(false);
    }
  });
});

describe("isEditableFocusSnapshot", () => {
  it("treats textarea, contenteditable, and role=textbox as editable", () => {
    expect(isEditableFocusSnapshot({ tagName: "textarea" })).toBe(true);
    expect(isEditableFocusSnapshot({ tagName: "div", isContentEditable: true })).toBe(true);
    expect(isEditableFocusSnapshot({ tagName: "div", role: "textbox" })).toBe(true);
  });

  it("treats text-like inputs as editable and ignores non-text inputs", () => {
    expect(isEditableFocusSnapshot({ tagName: "input" })).toBe(true);
    expect(isEditableFocusSnapshot({ tagName: "input", inputType: "email" })).toBe(true);
    expect(isEditableFocusSnapshot({ tagName: "input", inputType: "checkbox" })).toBe(false);
    expect(isEditableFocusSnapshot({ tagName: "input", inputType: "file" })).toBe(false);
    expect(isEditableFocusSnapshot({ tagName: "button" })).toBe(false);
  });

  it("does not treat disabled controls as editable", () => {
    expect(isEditableFocusSnapshot({ tagName: "input", inputType: "text", disabled: true })).toBe(
      false,
    );
    expect(isEditableFocusSnapshot({ tagName: "textarea", disabled: true })).toBe(false);
    expect(isEditableFocusSnapshot({ tagName: "div", role: "textbox", disabled: true })).toBe(
      false,
    );
  });

  it("does not treat inputmode=none as keyboard-summoning", () => {
    expect(
      isEditableFocusSnapshot({ tagName: "input", inputType: "text", inputMode: "none" }),
    ).toBe(false);
    expect(isEditableFocusSnapshot({ tagName: "textarea", inputMode: "NONE" })).toBe(false);
  });

  it("does not treat read-only controls as keyboard-summoning", () => {
    expect(isEditableFocusSnapshot({ tagName: "input", inputType: "text", readOnly: true })).toBe(
      false,
    );
    expect(isEditableFocusSnapshot({ tagName: "textarea", readOnly: true })).toBe(false);
    expect(isEditableFocusSnapshot({ tagName: "div", role: "textbox", readOnly: true })).toBe(
      false,
    );
  });
});

describe("isEditableFocusTarget", () => {
  it("rejects null and non-element targets", () => {
    expect(isEditableFocusTarget(null)).toBe(false);
  });
});

describe("keyboardInsetPx", () => {
  it("subtracts visible viewport height and pan offset from layout height", () => {
    expect(keyboardInsetPx(800, 500, 20)).toBe(280);
    expect(keyboardInsetPx(500, 500, 0)).toBe(0);
  });
  it("does not mistake zoom/pan for keyboard coverage", () => {
    expect(keyboardInsetPx(800, 400, 100, 2)).toBe(0);
    expect(keyboardInsetPx(800, 250, 100, 2)).toBe(300);
  });
  it("rounds geometry and clamps coverage to the layout viewport", () => {
    expect(keyboardInsetPx(800, 499.6, 0)).toBe(300);
    expect(keyboardInsetPx(800, 900, 0)).toBe(0);
    expect(keyboardInsetPx(800, 0, -50)).toBe(800);
  });
});
