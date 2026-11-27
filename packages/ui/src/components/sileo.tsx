import { useRef } from "react";
import { Toaster as SileoToaster, sileo } from "sileo";
import "sileo/styles.css";

interface ToasterProps {
  position?:
    | "top-left"
    | "top-center"
    | "top-right"
    | "bottom-left"
    | "bottom-center"
    | "bottom-right";
}

// No `theme`: sileo's themes invert the page (a light pill on a dark app).
// The toast takes the app's popover tokens from globals.css instead, so it
// follows `.dark` like every other surface, with no JS theme state.
const Toaster = ({ position = "bottom-center", ...props }: ToasterProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={containerRef}
      style={{ display: "contents" }}
      onFocusCapture={(event) => {
        const toast = (event.target as Element).closest("[data-sileo-toast]");
        if (toast && !containerRef.current?.contains(event.relatedTarget as Node | null)) {
          toast.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        }
      }}
      onBlurCapture={(event) => {
        const toast = (event.target as Element).closest("[data-sileo-toast]");
        if (
          toast &&
          !containerRef.current?.contains(event.relatedTarget as Node | null) &&
          !containerRef.current?.querySelector("[data-sileo-toast]:hover")
        ) {
          toast.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
        }
      }}
      onMouseOutCapture={(event) => {
        const toast = (event.target as Element).closest("[data-sileo-toast]");
        if (
          event.isTrusted &&
          toast &&
          containerRef.current?.contains(document.activeElement) &&
          !toast.contains(event.relatedTarget as Node | null)
        )
          event.stopPropagation();
      }}
    >
      <SileoToaster position={position} {...props} />
    </div>
  );
};

type ToastOptions = {
  duration?: number;
  action?: {
    label: string;
    onClick: () => void;
  };
};

// sileo keys toasts by `id` and defaults every one to "sileo-default", so a
// second toast replaces (morphs into) the first: two messages merge into one
// blob and the first is lost. Each toast gets its own id, so they stack.
let toastCount = 0;
const nextToastId = () => `toast-${++toastCount}`;

// The pill is one line inside sileo's fixed 350px SVG (`--sileo-width`).
// globals.css caps the title row and ends a longer title with an ellipsis, so
// a title that does not fit also goes in the description, which sileo expands
// under the pill. Whether it fits depends on the glyphs and the root font size
// (the app scales up on large screens), not on a character count, so measure
// it at the title's font. Where nothing can be measured (SSR, tests without
// canvas) a length rule stands in.
const SILEO_WIDTH_PX = 350;
const PILL_MAX_CHARS = 40;

/** Room for the title: the pill minus sileo's 10px padding, the 24px badge,
 *  the header's 0.5rem padding on each side and the 0.5rem gap (all at `rootPx`). */
export function pillTitleBudget(rootPx: number): number {
  return SILEO_WIDTH_PX - 10 - 24 - rootPx * 1.5;
}

type TitleMeasure = (message: string) => { width: number; budget: number } | null;

let measureContext: CanvasRenderingContext2D | null | undefined;
const measureTitle: TitleMeasure = (message) => {
  if (typeof document === "undefined") return null;
  if (measureContext === undefined) {
    try {
      measureContext = document.createElement("canvas").getContext("2d");
    } catch {
      measureContext = null;
    }
  }
  if (!measureContext) return null;
  const rootPx = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const family = getComputedStyle(document.body).fontFamily || "sans-serif";
  // sileo's title: 0.825rem, weight 500.
  measureContext.font = `500 ${0.825 * rootPx}px ${family}`;
  return { width: measureContext.measureText(message).width, budget: pillTitleBudget(rootPx) };
};

/** True when the message would be cut off in the pill. A 5% margin covers
 *  sub-pixel and font-loading differences. Exported for the tests. */
export function titleOverflowsPill(message: string, measure: TitleMeasure = measureTitle): boolean {
  const measured = measure(message);
  if (!measured) return message.length > PILL_MAX_CHARS;
  return measured.width > measured.budget * 0.95;
}

function createToastMethod(method: "success" | "error" | "info" | "warning" | "show") {
  return (message: string, options?: ToastOptions) => {
    return sileo[method]({
      id: nextToastId(),
      title: message,
      ...(titleOverflowsPill(message) ? { description: message } : {}),
      ...(options?.duration != null ? { duration: options.duration } : {}),
      ...(options?.action
        ? {
            autopilot: { expand: 0, collapse: 0 },
            button: { title: options.action.label, onClick: options.action.onClick },
          }
        : {}),
    } as Parameters<typeof sileo.show>[0]);
  };
}

const toast = {
  /** Neutral, polite notice — no success/error severity styling. */
  message: createToastMethod("show"),
  success: createToastMethod("success"),
  error: createToastMethod("error"),
  info: createToastMethod("info"),
  warning: createToastMethod("warning"),
  dismiss: sileo.dismiss,
  clear: sileo.clear,
};

export { Toaster, toast };
