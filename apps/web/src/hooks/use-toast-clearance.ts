import { useEffect } from "react";

export function useToastClearance(element: HTMLElement | null) {
  useEffect(() => {
    if (!element) return;
    const root = document.documentElement;
    const measure = () => {
      root.style.setProperty(
        "--toast-bottom-clearance",
        `${Math.ceil(element.getBoundingClientRect().height + 12)}px`,
      );
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    return () => {
      observer?.disconnect();
      root.style.removeProperty("--toast-bottom-clearance");
    };
  }, [element]);
}
