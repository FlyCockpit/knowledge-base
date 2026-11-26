import { cn } from "@knowledge-base/ui/lib/utils";
import { type KeyboardEvent, type PointerEvent, useRef } from "react";

/** Pure: the size a separator key asks for, or null for other keys. */
export function resizeKeyTarget(
  key: string,
  shift: boolean,
  value: number,
  min: number,
  max: number,
): number | null {
  const step = shift ? 64 : 16;
  const clamp = (n: number) => Math.min(max, Math.max(min, n));
  switch (key) {
    case "ArrowLeft":
      return clamp(value - step);
    case "ArrowRight":
      return clamp(value + step);
    case "Home":
      return min;
    case "End":
      return max;
    default:
      return null;
  }
}

/**
 * A vertical splitter between two panels (WAI-ARIA window splitter): drag
 * it, use Left/Right (Shift for bigger steps), Home/End, or double-click to
 * reset. It reports sizes; the owner stores and clamps them.
 */
export function ResizeHandle({
  value,
  min,
  max,
  defaultValue,
  onChange,
  label,
  controls,
  className,
}: {
  /** The size of the panel before the handle, in px. */
  value: number;
  min: number;
  max: number;
  defaultValue: number;
  onChange: (value: number) => void;
  label: string;
  /** The id of the panel it resizes. */
  controls?: string;
  className?: string;
}) {
  const drag = useRef<{ x: number; start: number; id: number } | null>(null);
  const clamp = (n: number) => Math.round(Math.min(max, Math.max(min, n)));

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, start: value, id: event.pointerId };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.id !== event.pointerId) return;
    onChange(clamp(current.start + event.clientX - current.x));
  };
  const end = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = resizeKeyTarget(event.key, event.shiftKey, value, min, max);
    if (next === null) return;
    event.preventDefault();
    onChange(next);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-controls={controls}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onChange(clamp(defaultValue))}
      data-testid="kb-resize-handle"
      className={cn(
        "group/handle relative w-1.5 shrink-0 cursor-col-resize touch-none outline-none select-none",
        // A 44px hit area on coarse pointers (wide tablets), the line stays thin.
        "after:absolute after:inset-y-0 after:-left-2 after:-right-2 pointer-coarse:after:-left-5 pointer-coarse:after:-right-5",
        "before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-border",
        "hover:before:w-0.5 hover:before:bg-primary/60 focus-visible:before:w-0.5 focus-visible:before:bg-ring",
        className,
      )}
    />
  );
}
