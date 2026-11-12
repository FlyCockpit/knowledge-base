import { useEffect, useRef, useState } from "react";

import { MOBILE_BREAKPOINT_PX } from "./use-media-query";

/** Keyboard is open only when visual viewport height falls below this share of the baseline. */
export const MOBILE_KEYBOARD_HEIGHT_RATIO = 0.8;

/**
 * Visual viewport must grow by at least this many px vs the last evaluated
 * height to count as a keyboard dismiss. Mobile browser chrome (URL bar
 * hide/show) commonly changes visualViewport by ~50–80px while the keyboard
 * is still open; real software-keyboard dismiss jumps are typically 200px+.
 * Stay above chrome-sized growth and below keyboard-sized growth.
 */
export const MOBILE_KEYBOARD_DISMISS_GROWTH_PX = 160;

const PINCH_ZOOM_SCALE_EPSILON = 0.01;

/**
 * CSS variable on <html>: how much of the bottom of the viewport the software keyboard covers
 * (0px while it is closed). Viewport-bound content can subtract it when it must stay above the keyboard.
 */
export const KEYBOARD_INSET_VAR = "--keyboard-inset";

/**
 * The height the software keyboard covers: the part of the layout viewport below the visual
 * viewport, from current geometry only. It is not the open/closed decision that hides the
 * BottomNav (that one is deliberately conservative: mobile widths, an editable focus): a keyboard
 * still covers the page after a rotation past the mobile breakpoint or while focus moves. A
 * browser that shrinks the layout viewport for the keyboard leaves nothing covered (0).
 */
export function keyboardInsetPx(
  layoutViewportHeight: number,
  visualViewportHeight: number,
  visualViewportOffsetTop: number,
  visualViewportScale = 1,
): number {
  // Pinch-zoomed, the visual viewport is a magnified part of the page: its height times the
  // scale is the screen height it fills, so the rest of the layout height is what the keyboard
  // covers. Deliberately the keyboard's height, not the part of the layout below the zoomed view:
  // the page keeps its unzoomed layout while zoomed (fitting it to a panned, magnified view would
  // resize content on every pan), so where the view is panned does not count.
  const covered = isPinchZoomed(visualViewportScale)
    ? layoutViewportHeight - visualViewportHeight * visualViewportScale
    : layoutViewportHeight - visualViewportHeight - visualViewportOffsetTop;
  return Math.min(layoutViewportHeight, Math.max(0, Math.round(covered)));
}

/** Input types that typically summon a software keyboard on mobile. */
const KEYBOARD_INPUT_TYPES = new Set([
  "",
  "text",
  "search",
  "email",
  "tel",
  "url",
  "password",
  "number",
]);

export type EditableFocusSnapshot = {
  tagName: string;
  inputType?: string | null;
  inputMode?: string | null;
  disabled?: boolean;
  readOnly?: boolean;
  isContentEditable?: boolean;
  role?: string | null;
};

type VirtualKeyboardLike = {
  boundingRect: { readonly height: number };
  addEventListener(type: "geometrychange", listener: () => void): void;
  removeEventListener(type: "geometrychange", listener: () => void): void;
};

export type MobileKeyboardSnapshot = {
  viewportWidth: number;
  visualViewportHeight: number;
  /** Layout viewport height used to seed a missing baseline on focused mount. */
  layoutViewportHeight?: number;
  visualViewportScale: number;
  baselineHeight: number;
  editableFocused: boolean;
  /** True when the VirtualKeyboard API reports a visible keyboard. `null` if unavailable. */
  virtualKeyboardOpened?: boolean | null;
  /**
   * Width or orientation changed since the previous evaluation.
   * Defaults to `geometryChanged` when omitted (tests can set either).
   * Scale-only pinch/unpinch is not a layout change.
   */
  layoutChanged?: boolean;
  /** Width, scale, or orientation changed since the previous evaluation. */
  geometryChanged?: boolean;
  /** Previous decision: keyboard was already known to be open. */
  previouslyKeyboardOpen?: boolean;
  /** Last evaluated visual viewport height (before this snapshot). */
  previousVisualViewportHeight?: number;
  /**
   * Last known full visual-viewport height for the current orientation.
   * `0` / omitted means this orientation has not been seen with the keyboard
   * closed. Used so a rotate can compare against landscape's own baseline
   * instead of the previous portrait one.
   */
  orientationBaselineHeight?: number;
  /**
   * Previous decision used a conservative close without a trustworthy
   * full-height sample for this orientation. Height drops must not reopen
   * chrome until a proven close recaptures.
   */
  previouslyBaselineUnproven?: boolean;
  /**
   * Minimum visual-viewport height observed while the baseline has been
   * unproven. Used so a multi-frame keyboard dismiss can accumulate past
   * MOBILE_KEYBOARD_DISMISS_GROWTH_PX.
   */
  minUnprovenVisualViewportHeight?: number;
};

export type MobileKeyboardDecision = {
  isKeyboardOpen: boolean;
  nextBaselineHeight: number;
  nextBaselineUnproven: boolean;
};

function isPinchZoomed(scale: number): boolean {
  return Math.abs(scale - 1) > PINCH_ZOOM_SCALE_EPSILON;
}

function isMobileViewport(viewportWidth: number): boolean {
  return viewportWidth < MOBILE_BREAKPOINT_PX;
}

function heightDroppedVersus(baselineHeight: number, visualViewportHeight: number): boolean {
  return baselineHeight > 0 && visualViewportHeight < baselineHeight * MOBILE_KEYBOARD_HEIGHT_RATIO;
}

/** True when height grew vs the last visual viewport by a dismiss, not jitter. */
export function visualViewportGrewPastDismissThreshold(
  previousVisualViewportHeight: number,
  visualViewportHeight: number,
): boolean {
  return (
    previousVisualViewportHeight > 0 &&
    visualViewportHeight - previousVisualViewportHeight >= MOBILE_KEYBOARD_DISMISS_GROWTH_PX
  );
}

/**
 * Conservative software-keyboard decision for chrome visibility.
 * Recapture the height baseline when the keyboard cannot be open. Layout
 * (width/orientation) changes recapture unless the keyboard was already
 * known to be open or VirtualKeyboard currently reports open. Scale-only
 * pinch/unpinch keeps the unzoomed baseline. A height drop vs the old
 * baseline is not proof the keyboard is open during a layout change
 * (landscape height is often a >20% drop from portrait). After that, if
 * the keyboard was already open, geometry is stable, VirtualKeyboard is
 * not reporting open, and visual viewport grew by
 * MOBILE_KEYBOARD_DISMISS_GROWTH_PX, recapture and close (dismiss without
 * blur after rotate). When VirtualKeyboard is available and reports closed
 * (`false`), that signal is authoritative: close and recapture.
 *
 * Without VirtualKeyboard, a rotate can coalesce with a dismiss. If this
 * orientation has a stored full-height baseline, compare against that.
 * If it does not, close chrome but keep the previous baseline unproven —
 * do not adopt the maybe-shrunken height. A later proven close (blur,
 * VirtualKeyboard false, or dismiss-sized growth) recaptures. Prefer
 * showing chrome over hiding BottomNav after a dismiss the heuristic
 * cannot prove.
 */
export function getMobileKeyboardDecision(input: MobileKeyboardSnapshot): MobileKeyboardDecision {
  const mobile = isMobileViewport(input.viewportWidth);
  const pinchZoomed = isPinchZoomed(input.visualViewportScale);
  const baselineMissing = input.baselineHeight <= 0;
  const layoutChanged = input.layoutChanged ?? input.geometryChanged === true;
  const virtualKeyboardClosed = input.virtualKeyboardOpened === false;
  const orientationBaseline = input.orientationBaselineHeight ?? 0;
  const initialBaselineHeight =
    mobile && input.editableFocused && !pinchZoomed && !virtualKeyboardClosed
      ? Math.max(input.visualViewportHeight, input.layoutViewportHeight ?? 0)
      : input.visualViewportHeight;
  const initialBaselineUnproven =
    baselineMissing &&
    mobile &&
    input.editableFocused &&
    !pinchZoomed &&
    input.virtualKeyboardOpened == null &&
    !heightDroppedVersus(initialBaselineHeight, input.visualViewportHeight);
  const heightGrewPastDismiss = visualViewportGrewPastDismissThreshold(
    input.previousVisualViewportHeight ?? 0,
    input.visualViewportHeight,
  );
  const dismissedAfterRotate =
    input.previouslyKeyboardOpen === true &&
    input.geometryChanged !== true &&
    input.virtualKeyboardOpened !== true &&
    heightGrewPastDismiss;
  const recoveredWhileUnproven =
    input.previouslyBaselineUnproven === true &&
    input.geometryChanged !== true &&
    input.virtualKeyboardOpened !== true &&
    visualViewportGrewPastDismissThreshold(
      input.minUnprovenVisualViewportHeight ?? input.previousVisualViewportHeight ?? 0,
      input.visualViewportHeight,
    );
  const unknownOrientationWhileOpen =
    layoutChanged &&
    input.previouslyKeyboardOpen === true &&
    input.virtualKeyboardOpened !== true &&
    orientationBaseline <= 0;
  const shouldRecaptureBaseline =
    baselineMissing ||
    (!pinchZoomed &&
      (!mobile ||
        !input.editableFocused ||
        virtualKeyboardClosed ||
        (layoutChanged &&
          input.previouslyBaselineUnproven !== true &&
          input.virtualKeyboardOpened !== true &&
          input.previouslyKeyboardOpen !== true) ||
        dismissedAfterRotate ||
        recoveredWhileUnproven));
  const nextBaselineHeight = shouldRecaptureBaseline
    ? baselineMissing
      ? initialBaselineHeight
      : input.visualViewportHeight
    : layoutChanged && orientationBaseline > 0
      ? orientationBaseline
      : input.baselineHeight;
  const nextBaselineUnproven =
    initialBaselineUnproven ||
    (!shouldRecaptureBaseline &&
      !(layoutChanged && orientationBaseline > 0) &&
      (unknownOrientationWhileOpen || input.previouslyBaselineUnproven === true));
  const heightDropped = heightDroppedVersus(nextBaselineHeight, input.visualViewportHeight);
  const isKeyboardOpen =
    mobile &&
    !pinchZoomed &&
    input.editableFocused &&
    !nextBaselineUnproven &&
    (input.virtualKeyboardOpened === true ||
      (input.virtualKeyboardOpened !== false && heightDropped));

  return { isKeyboardOpen, nextBaselineHeight, nextBaselineUnproven };
}

export function isKeyboardSummoningInputType(type: string): boolean {
  return KEYBOARD_INPUT_TYPES.has(type.trim().toLowerCase());
}

export function isEditableFocusSnapshot(input: EditableFocusSnapshot): boolean {
  if (input.disabled || input.readOnly) return false;
  if ((input.inputMode ?? "").trim().toLowerCase() === "none") return false;
  const tag = input.tagName.toUpperCase();
  if (tag === "TEXTAREA") return true;
  if (tag === "INPUT") return isKeyboardSummoningInputType(input.inputType ?? "");
  if (input.isContentEditable) return true;
  return input.role === "textbox";
}

export function isEditableFocusTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) return false;
  const formControl =
    target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ? target : null;
  return isEditableFocusSnapshot({
    tagName: target.tagName,
    inputType: target instanceof HTMLInputElement ? target.type : null,
    inputMode: target.getAttribute("inputmode"),
    disabled: Boolean(formControl?.disabled) || target.getAttribute("aria-disabled") === "true",
    readOnly: Boolean(formControl?.readOnly) || target.getAttribute("aria-readonly") === "true",
    isContentEditable: target.isContentEditable,
    role: target.getAttribute("role"),
  });
}

function getVirtualKeyboard(): VirtualKeyboardLike | null {
  if (typeof navigator === "undefined") return null;
  const candidate = (navigator as Navigator & { virtualKeyboard?: VirtualKeyboardLike })
    .virtualKeyboard;
  return candidate ?? null;
}

function readOrientationKey(): string {
  const screenOrientation = window.screen.orientation?.type;
  if (screenOrientation) return screenOrientation;
  return String(window.orientation ?? window.innerWidth > window.innerHeight);
}

export function useMobileKeyboard(): boolean {
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const baselineHeightRef = useRef(0);
  const keyboardOpenRef = useRef(false);
  const previousVisualViewportHeightRef = useRef(0);
  const orientationBaselinesRef = useRef<Record<string, number>>({});
  const baselineUnprovenRef = useRef(false);
  const minUnprovenHeightRef = useRef(0);
  const geometryRef = useRef({ width: 0, scale: 1, orientation: "" });
  const focusOutFrameRef = useRef<number | null>(null);

  useEffect(() => {
    const readGeometry = () => {
      const visualViewport = window.visualViewport;
      return {
        width: window.innerWidth,
        height: visualViewport?.height ?? window.innerHeight,
        layoutHeight: window.innerHeight,
        scale: visualViewport?.scale ?? 1,
        orientation: readOrientationKey(),
      };
    };

    const evaluate = () => {
      const geometry = readGeometry();
      const previous = geometryRef.current;
      const layoutChanged =
        previous.width !== 0 &&
        (previous.width !== geometry.width || previous.orientation !== geometry.orientation);
      const geometryChanged =
        layoutChanged || (previous.width !== 0 && previous.scale !== geometry.scale);
      const virtualKeyboard = getVirtualKeyboard();
      const decision = getMobileKeyboardDecision({
        viewportWidth: geometry.width,
        visualViewportHeight: geometry.height,
        layoutViewportHeight: geometry.layoutHeight,
        visualViewportScale: geometry.scale,
        baselineHeight: baselineHeightRef.current,
        editableFocused: isEditableFocusTarget(document.activeElement),
        virtualKeyboardOpened: virtualKeyboard ? virtualKeyboard.boundingRect.height > 0 : null,
        layoutChanged,
        geometryChanged,
        previouslyKeyboardOpen: keyboardOpenRef.current,
        previousVisualViewportHeight: previousVisualViewportHeightRef.current,
        orientationBaselineHeight: orientationBaselinesRef.current[geometry.orientation] ?? 0,
        previouslyBaselineUnproven: baselineUnprovenRef.current,
        minUnprovenVisualViewportHeight: minUnprovenHeightRef.current,
      });

      if (
        decision.nextBaselineHeight === geometry.height &&
        !decision.isKeyboardOpen &&
        !decision.nextBaselineUnproven
      ) {
        orientationBaselinesRef.current[geometry.orientation] = geometry.height;
      }
      baselineHeightRef.current = decision.nextBaselineHeight;
      baselineUnprovenRef.current = decision.nextBaselineUnproven;
      minUnprovenHeightRef.current = decision.nextBaselineUnproven
        ? minUnprovenHeightRef.current > 0
          ? Math.min(minUnprovenHeightRef.current, geometry.height)
          : geometry.height
        : 0;
      keyboardOpenRef.current = decision.isKeyboardOpen;
      previousVisualViewportHeightRef.current = geometry.height;
      geometryRef.current = {
        width: geometry.width,
        scale: geometry.scale,
        orientation: geometry.orientation,
      };
      const inset = keyboardInsetPx(
        window.innerHeight,
        geometry.height,
        window.visualViewport?.offsetTop ?? 0,
        geometry.scale,
      );
      document.documentElement.style.setProperty(KEYBOARD_INSET_VAR, `${inset}px`);
      setKeyboardOpen(decision.isKeyboardOpen);
    };

    const onFocusOut = (event: FocusEvent) => {
      // Do not evaluate from relatedTarget: during focusout Chromium can
      // still report document.activeElement as body. If the next control
      // is editable, let focusin handle it. Otherwise wait a frame so
      // tabbing does not recapture a keyboard-shrunk baseline.
      if (isEditableFocusTarget(event.relatedTarget)) {
        return;
      }
      if (focusOutFrameRef.current !== null) {
        cancelAnimationFrame(focusOutFrameRef.current);
      }
      focusOutFrameRef.current = requestAnimationFrame(() => {
        focusOutFrameRef.current = null;
        evaluate();
      });
    };

    evaluate();

    const visualViewport = window.visualViewport;
    visualViewport?.addEventListener("resize", evaluate);
    visualViewport?.addEventListener("scroll", evaluate);
    window.addEventListener("resize", evaluate);
    window.addEventListener("orientationchange", evaluate);
    document.addEventListener("focusin", evaluate);
    document.addEventListener("focusout", onFocusOut);
    const virtualKeyboard = getVirtualKeyboard();
    virtualKeyboard?.addEventListener("geometrychange", evaluate);

    return () => {
      if (focusOutFrameRef.current !== null) {
        cancelAnimationFrame(focusOutFrameRef.current);
        focusOutFrameRef.current = null;
      }
      visualViewport?.removeEventListener("resize", evaluate);
      visualViewport?.removeEventListener("scroll", evaluate);
      document.documentElement.style.removeProperty(KEYBOARD_INSET_VAR);
      window.removeEventListener("resize", evaluate);
      window.removeEventListener("orientationchange", evaluate);
      document.removeEventListener("focusin", evaluate);
      document.removeEventListener("focusout", onFocusOut);
      virtualKeyboard?.removeEventListener("geometrychange", evaluate);
    };
  }, []);

  return keyboardOpen;
}
