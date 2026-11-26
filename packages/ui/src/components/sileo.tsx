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
const Toaster = ({ position = "bottom-center", ...props }: ToasterProps) => (
  <SileoToaster position={position} {...props} />
);

type ToastOptions = {
  duration?: number;
  action?: {
    label: string;
    onClick: () => void;
  };
};

function createToastMethod(method: "success" | "error" | "info" | "warning" | "show") {
  return (message: string, options?: ToastOptions) => {
    return sileo[method]({
      title: message,
      ...(options?.duration != null ? { duration: options.duration } : {}),
      ...(options?.action
        ? { button: { title: options.action.label, onClick: options.action.onClick } }
        : {}),
    });
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
