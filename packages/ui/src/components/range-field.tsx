"use client";

import { Field as FieldPrimitive } from "@base-ui/react/field";
import { Slider as SliderPrimitive } from "@base-ui/react/slider";
import { Button } from "@knowledge-base/ui/components/button";
import { Input } from "@knowledge-base/ui/components/input";
import { Label } from "@knowledge-base/ui/components/label";
import { FieldError, type FieldLike } from "@knowledge-base/ui/components/text-field";
import {
  clampToRange,
  createRangeScale,
  effectiveMax,
  formatUnit,
  parseUnitValue,
  pickUnit,
  type RangeScale,
  type RangeScaleKind,
  type RangeUnit,
  type RangeValidationCode,
  snapDownToStep,
  snapToStep,
  validateRangeValue,
} from "@knowledge-base/ui/lib/range-scale";
import { cn } from "@knowledge-base/ui/lib/utils";
import type * as React from "react";
import { useId, useState } from "react";

/**
 * Every user-visible string `RangeField` renders. This package is i18n-free:
 * the app passes translated labels (see `ui-labels.tsx`). Functions receive
 * values already formatted with the field's units ("16 GiB").
 */
export type RangeFieldLabels = {
  /** Accessible name suffix for the typed input, e.g. "Exact value". */
  inputLabel: string;
  /** The "Reset to default" button. */
  reset: string;
  /**
   * Shown when the value equals `defaultValue`. Receives the `defaultLabel`
   * prop (where the default comes from), or `undefined` when none was given.
   */
  defaultState: (defaultLabel: string | undefined) => string;
  /** Why the track stops early, e.g. "This host allows at most 16 GiB". */
  limit: (formattedLimit: string) => string;
  /**
   * Notice after a typed value was changed to the nearest allowed one.
   * `reason` is the rule it broke (the limit text, or an `errors` message);
   * `formattedValue` is what was set instead: "Must be at most 32 GiB. Set to
   * 32 GiB."
   */
  adjusted: (formattedValue: string, reason: string) => string;
  errors: {
    notANumber: string;
    belowMin: (formattedMin: string) => string;
    aboveMax: (formattedMax: string) => string;
    offStep: (formattedStep: string) => string;
  };
};

/** English labels — for tests and docs. Apps pass their own translations. */
export const rangeFieldEnglishLabels: RangeFieldLabels = {
  inputLabel: "Exact value",
  reset: "Reset to default",
  defaultState: (defaultLabel) => (defaultLabel ? `Default (from ${defaultLabel})` : "Default"),
  limit: (formattedLimit) => `This host allows at most ${formattedLimit}`,
  adjusted: (formattedValue, reason) =>
    `${reason.replace(/[.!]+$/, "")}. Set to ${formattedValue}.`,
  errors: {
    notANumber: "Enter a number",
    belowMin: (formattedMin) => `Must be at least ${formattedMin}`,
    aboveMax: (formattedMax) => `Must be at most ${formattedMax}`,
    offStep: (formattedStep) => `Must be a multiple of ${formattedStep}`,
  },
};

export type RangeFieldProps = {
  /** A TanStack `<form.Field>` render-prop object; the value is in the base unit. */
  field: FieldLike<number>;
  label: string;
  description?: React.ReactNode;
  /** Every visible string. Required — this package ships no translations. */
  labels: RangeFieldLabels;
  min: number;
  max: number;
  /** Granularity of accepted values, counted from `min`. Defaults to 1. */
  step?: number;
  /** Track mapping when no `stops` are given. `"log"` needs `max > min`. */
  scale?: RangeScaleKind;
  /**
   * Snap stops for the slider (evenly spaced along the track). They constrain
   * the **slider only** — the typed input accepts any value within
   * `min`/`max`/`limit` that is on `step`, so 12 GiB can be typed between the
   * 8 and 16 stops.
   */
  stops?: readonly number[];
  /**
   * Display units, base unit (factor 1) included, e.g. MiB + GiB. Omit for a
   * unitless number.
   */
  units?: readonly RangeUnit[];
  /** The value this field would have untouched; gets a tick and a reset button. */
  defaultValue?: number;
  /** Where the default comes from, e.g. "template ubuntu-24". */
  defaultLabel?: string;
  /**
   * Dynamic max — what the chosen host/pool allows. The track above it is
   * hatched and unreachable, and a typed value above it is lowered to the
   * highest allowed one (with a notice). A current value already above it
   * (the limit dropped) is flagged, not changed.
   */
  limit?: number;
  /** Overrides `labels.limit(formattedLimit)` for the limit explanation. */
  limitMessage?: string;
  disabled?: boolean;
  /** Styles the wrapper (label row, controls, messages). */
  className?: string;
  /** Classes for the typed `<Input>` (its width, say). */
  inputClassName?: string;
};

/** Stop labels under the track only up to this many stops (min/max always show). */
const MAX_LABELLED_STOPS = 8;
/** Stop tick marks on the track only up to this many stops. */
const MAX_MARKED_STOPS = 24;

/**
 * Whether the mid-track stop at `index` (of `count` ticks, ends included) gets
 * a label. Up to six ticks every stop is labelled; beyond that labels would
 * touch on a half-width column ("512 MiB1 GiB"), so every other stop is, and
 * never the one next to an end label.
 */
export function labelMidStop(index: number, count: number): boolean {
  if (count <= 6) return true;
  return index % 2 === 0 && index !== count - 2;
}

function percent(fraction: number): string {
  return `${Math.round(fraction * 10000) / 100}%`;
}

type RangeMessageContext = {
  labels: RangeFieldLabels;
  /** Formats a base-unit value for display ("16 GiB"). */
  format: (value: number) => string;
  min: number;
  max: number;
  step: number;
  /** The already-resolved limit explanation (`limitMessage` or `labels.limit`). */
  limitText: string;
};

/** The message for a validation code, with values formatted in the field's units. */
export function rangeErrorMessage(code: RangeValidationCode, context: RangeMessageContext): string {
  const { labels, format } = context;
  switch (code) {
    case "not-a-number":
      return labels.errors.notANumber;
    case "below-min":
      return labels.errors.belowMin(format(context.min));
    case "above-max":
      return labels.errors.aboveMax(format(context.max));
    case "above-limit":
      return context.limitText;
    case "off-step":
      return labels.errors.offStep(format(context.step));
  }
}

export type RangeInputOutcome =
  /** Empty text: put the current value back. */
  | { kind: "revert" }
  /** Nothing to commit: the field keeps its value, the input shows it again. */
  | { kind: "error"; message: string }
  /**
   * Commit `value`. `notice` is set when it is not what was typed but the
   * nearest allowed value (clamped to min/max/limit, or snapped to step).
   */
  | { kind: "commit"; value: number; notice?: string };

/**
 * What committing typed text does — the escape hatch's whole decision, kept
 * pure so it is testable without a DOM. The field never ends up holding a
 * value the UI rejects, and the input always shows what will be submitted:
 *
 * - empty text reverts;
 * - text that is not a number is an error (the field keeps its value);
 * - above `max` or `limit` commits the highest allowed value (the effective
 *   max snapped down to `step`), below `min` commits `min`, and off `step`
 *   commits the nearest on-step value — each with a notice saying so;
 * - anything else commits as typed.
 *
 * A bare number is read in the unit the current value is shown in. Snap stops
 * are deliberately not consulted.
 */
export function interpretRangeInput(
  text: string,
  {
    currentValue,
    units,
    limit,
    ...context
  }: RangeMessageContext & { currentValue: number; units: readonly RangeUnit[]; limit?: number },
): RangeInputOutcome {
  if (text.trim() === "") return { kind: "revert" };
  const { labels, format, min, max, step } = context;
  const shownUnit = pickUnit(currentValue, units, { exact: true });
  const parsed = parseUnitValue(text, units, { defaultFactor: shownUnit?.factor });
  if (!parsed.ok) return { kind: "error", message: labels.errors.notANumber };
  const typed = parsed.value;
  const code = validateRangeValue(typed, { min, max, step, limit });
  if (code === null) return { kind: "commit", value: typed };

  const upper = effectiveMax(max, limit);
  const highest = snapDownToStep(upper, step, min);
  // No value is allowed at all (the limit is below `min`): nothing to set.
  if (highest < min) return { kind: "error", message: rangeErrorMessage(code, context) };

  const limitBinds = limit !== undefined && limit < max;
  let value: number;
  let reason: string;
  if (typed > upper) {
    value = highest;
    reason = limitBinds ? context.limitText : labels.errors.aboveMax(format(max));
  } else if (typed < min) {
    value = min;
    reason = labels.errors.belowMin(format(min));
  } else {
    value = clampToRange(snapToStep(typed, step, min), min, highest);
    reason = labels.errors.offStep(format(step));
  }
  return { kind: "commit", value, notice: labels.adjusted(format(value), reason) };
}

type Tick = { value: number; fraction: number; edge: "start" | "end" | null };

/**
 * The typed input's state, tied to the field value it started from. When the
 * field value changes from outside (a form reset, another field), the draft
 * and its message no longer match and are dropped during render.
 */
export type TypedEntry = {
  forValue: number;
  /** Text being typed; `null` while the input mirrors the field value. */
  text: string | null;
  message: { tone: "error" | "notice"; text: string } | null;
};

/** `entry` while it still belongs to the field's current `value`, else `null`. */
/**
 * For a thumb at a fractional `position` (a typed value between two stops),
 * the position of the neighbouring stop in the direction of `key`; null when
 * the thumb is on a stop or the key does not move it (Base UI handles those).
 */
export function stepFromBetween(
  position: number,
  minPosition: number,
  positionStep: number,
  key: string,
): number | null {
  const steps = (position - minPosition) / positionStep;
  if (Math.abs(steps - Math.round(steps)) < 1e-9) return null;
  if (key === "ArrowRight" || key === "ArrowUp" || key === "PageUp")
    return minPosition + Math.ceil(steps) * positionStep;
  if (key === "ArrowLeft" || key === "ArrowDown" || key === "PageDown")
    return minPosition + Math.floor(steps) * positionStep;
  return null;
}

export function liveTypedEntry(entry: TypedEntry | null, value: number): TypedEntry | null {
  return entry !== null && Object.is(entry.forValue, value) ? entry : null;
}

function trackTicks(scale: RangeScale, min: number, max: number): Tick[] {
  const ticks: Tick[] = [{ value: min, fraction: 0, edge: "start" }];
  // Explicit and log stops share the "stops" kind; only a short list is worth
  // marking (a 100-position log scale would be a solid bar of ticks).
  if (scale.kind === "stops" && scale.stops.length <= MAX_MARKED_STOPS) {
    for (const stop of scale.stops.slice(1, -1)) {
      ticks.push({ value: stop, fraction: scale.fractionOf(stop), edge: null });
    }
  }
  if (max > min) ticks.push({ value: max, fraction: 1, edge: "end" });
  return ticks;
}

/**
 * A number field as a slider with a typed escape hatch, wired to a TanStack
 * Form `field` (value in the base unit — MiB for memory, say). Owns the
 * label/id pairing, `aria-invalid`, `aria-describedby`, and the error output,
 * like `TextField`.
 *
 * - **Slider** (Base UI): arrows move one `step` (or one stop), Page Up/Down a
 *   larger jump, Home/End the ends; `aria-valuetext` is the formatted value.
 *   With `stops` it moves stop-to-stop over an evenly spaced track; with
 *   `scale="log"` over log-spaced positions; otherwise linearly by `step`.
 * - **Typed input**: commits on blur or Enter (Escape reverts). Accepts unit
 *   suffixes ("4 GiB", "4096 MiB", "4g"); a bare number is read in the unit
 *   currently shown, since the `decimal` phone keyboard has no letters. Text
 *   that is not a number shows an inline error and the input goes back to the
 *   field value. A number outside `min`/`max`/`limit` or off `step` commits
 *   the nearest allowed value with a polite notice ("… Set to 32 GiB."), so
 *   the input always shows what will be submitted. Snap stops do **not** apply
 *   here: any on-`step` value in range is accepted, between stops included.
 * - **`limit`**: the track above it is hatched and the slider's own max is the
 *   highest position at or below it; the explanation is always shown, and
 *   turns into an error (both controls `aria-invalid`) if the current value is
 *   above it (the host changed, say). That value is not changed for the user;
 *   the form schema blocks the submit.
 * - **`defaultValue`**: a tick on the track, a "Default (from …)" state when
 *   the value equals it, otherwise a "Reset to default" button (disabled when
 *   the default itself is not allowed, e.g. above the limit).
 *
 * The caller's schema stays the source of truth for submit-time validation;
 * this component only stops the user from producing out-of-range values.
 */
export function RangeField({
  field,
  label,
  description,
  labels,
  min,
  max,
  step = 1,
  scale: scaleKind = "linear",
  stops,
  units = [],
  defaultValue,
  defaultLabel,
  limit,
  limitMessage,
  disabled = false,
  className,
  inputClassName,
}: RangeFieldProps) {
  const reactId = useId();
  const id = `${reactId}-${field.name}`;
  const labelId = `${id}-label`;
  const inputHintId = `${id}-input-label`;
  const errorId = `${id}-error`;
  const typedErrorId = `${id}-typed-error`;
  const noticeId = `${id}-notice`;
  const descriptionId = `${id}-description`;
  const stateId = `${id}-state`;
  const limitId = `${id}-limit`;

  const [entry, setEntry] = useState<TypedEntry | null>(null);

  const value = field.state.value;
  // A draft or message started from another value is stale: drop it, from
  // state too (adjusting state during render), so it cannot come back if the
  // value later returns to what it was.
  if (entry !== null && entry.forValue !== value) setEntry(null);
  const current = liveTypedEntry(entry, value);
  const draft = current?.text ?? null;
  const typedError = current?.message?.tone === "error" ? current.message.text : null;
  const notice = current?.message?.tone === "notice" ? current.message.text : null;
  const scale = createRangeScale({ min, max, step, scale: scaleKind, stops });
  const format = (v: number) => formatUnit(v, units);
  const formatExact = (v: number) => formatUnit(v, units, { exact: true });

  const constraints = { min, max, step, limit };
  const limited = limit !== undefined && limit < max;
  const limitText = limitMessage ?? labels.limit(format(effectiveMax(max, limit)));
  const messageContext = { labels, format, min, max, step, limitText };
  const valueCode = validateRangeValue(value, constraints);
  const aboveLimit = valueCode === "above-limit";

  // The slider's own max is the highest position the limit still allows, so
  // dragging, End, and Page Up all stop there.
  const allowedMaxPosition = limited
    ? (scale.positionAtOrBelow(limit) ?? scale.minPosition)
    : scale.maxPosition;
  const sliderLocked = allowedMaxPosition <= scale.minPosition;
  const fullSpan = scale.maxPosition - scale.minPosition;
  const allowedFraction =
    fullSpan > 0 ? (allowedMaxPosition - scale.minPosition) / fullSpan : sliderLocked ? 0 : 1;
  const largeStep =
    scale.kind === "stops"
      ? Math.max(1, Math.round(scale.stops.length / 5))
      : Math.max(step, Math.round(fullSpan / 10 / step) * step);

  const hasDefault = defaultValue !== undefined;
  const isDefault = hasDefault && value === defaultValue;
  const defaultAllowed = hasDefault && validateRangeValue(defaultValue, constraints) === null;

  const fieldErrorCount = field.state.meta.errors.length;
  const invalid = fieldErrorCount > 0 || typedError !== null || aboveLimit;
  const describedBy =
    [
      description ? descriptionId : null,
      isDefault ? stateId : null,
      limited ? limitId : null,
      typedError ? typedErrorId : null,
      notice ? noticeId : null,
      fieldErrorCount > 0 ? errorId : null,
    ]
      .filter(Boolean)
      .join(" ") || undefined;

  const setValue = (next: number) => {
    setEntry(null);
    if (next !== value) field.handleChange(next);
  };

  const commitDraft = () => {
    if (draft === null) return;
    const outcome = interpretRangeInput(draft, {
      ...messageContext,
      currentValue: value,
      units,
      limit,
    });
    if (outcome.kind === "error") {
      // The field keeps its value and the input shows it again; only the
      // message says what was wrong with the text.
      setEntry({ forValue: value, text: null, message: { tone: "error", text: outcome.message } });
      return;
    }
    if (outcome.kind === "commit") {
      setEntry(
        outcome.notice
          ? {
              forValue: outcome.value,
              text: null,
              message: { tone: "notice", text: outcome.notice },
            }
          : null,
      );
      if (outcome.value !== value) field.handleChange(outcome.value);
      return;
    }
    // Clearing the box and leaving is not a value; put the current one back.
    setEntry(null);
  };

  // An off-step `max` is not reachable; the track ends at the last on-step value.
  const ticks = trackTicks(scale, min, scale.toValue(scale.maxPosition));
  const labelStops = scale.kind === "stops" && scale.stops.length <= MAX_LABELLED_STOPS;

  return (
    <div className={cn("min-w-0 space-y-2", className)}>
      <div className="flex min-h-5 flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <Label id={labelId} htmlFor={id}>
          {label}
        </Label>
        {isDefault ? (
          <span id={stateId} className="text-xs text-muted-foreground">
            {labels.defaultState(defaultLabel)}
          </span>
        ) : hasDefault ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="md:-my-1"
            disabled={disabled || !defaultAllowed}
            onClick={() => setValue(defaultValue)}
          >
            {labels.reset}
          </Button>
        ) : null}
      </div>

      <div className="flex items-start gap-3">
        {/* Field.Root only carries `invalid` to the slider's own <input>
            (Base UI sets aria-invalid there from the field state). */}
        <FieldPrimitive.Root invalid={invalid} disabled={disabled} className="min-w-0 flex-1">
          <SliderPrimitive.Root
            value={scale.toPosition(value)}
            min={scale.minPosition}
            // Base UI needs max > min; a fully locked slider is disabled anyway.
            max={sliderLocked ? scale.minPosition + scale.positionStep : allowedMaxPosition}
            step={scale.positionStep}
            largeStep={largeStep}
            disabled={disabled || sliderLocked}
            onValueChange={(position) => setValue(scale.toValue(position))}
          >
            <div className="relative flex h-11 items-center md:h-8">
              <SliderPrimitive.Control
                className="flex h-full touch-none items-center select-none data-disabled:opacity-50"
                style={{ width: percent(allowedFraction) }}
              >
                <SliderPrimitive.Track className="relative h-2 w-full bg-muted">
                  <SliderPrimitive.Indicator className="h-full bg-primary" />
                  <SliderPrimitive.Thumb
                    aria-labelledby={labelId}
                    aria-describedby={describedBy}
                    aria-valuetext={format(value)}
                    onBlur={field.handleBlur}
                    onKeyDown={(event) => {
                      // A typed value between two stops sits at a fractional
                      // position; Base UI would round it first and skip the
                      // neighbouring stop. Step to that neighbour instead.
                      const target = stepFromBetween(
                        scale.toPosition(value),
                        scale.minPosition,
                        scale.positionStep,
                        event.key,
                      );
                      if (target === null) return;
                      event.preventDefault();
                      setValue(
                        scale.toValue(
                          Math.min(Math.max(target, scale.minPosition), allowedMaxPosition),
                        ),
                      );
                    }}
                    // The visible thumb is 20px; the ::before ring pads the hit
                    // area to 44px below `md:` (touch) and 28px above it.
                    className="z-10 size-5 border-2 border-primary bg-background shadow-sm transition-[box-shadow] outline-none before:absolute before:-inset-3 has-focus-visible:ring-2 has-focus-visible:ring-ring has-focus-visible:ring-offset-2 has-focus-visible:ring-offset-background data-disabled:border-muted-foreground md:before:-inset-1"
                  />
                </SliderPrimitive.Track>
              </SliderPrimitive.Control>
              {limited ? (
                <div
                  aria-hidden="true"
                  data-slot="range-field-limit-region"
                  className="h-2 flex-1 border-y border-border bg-[repeating-linear-gradient(135deg,var(--color-muted-foreground)_0_1px,transparent_1px_6px)] opacity-40"
                />
              ) : null}
              {ticks
                .filter((tick) => tick.edge === null)
                .map((tick) => (
                  <span
                    key={tick.value}
                    aria-hidden="true"
                    className="pointer-events-none absolute top-1/2 h-2 w-px -translate-x-1/2 -translate-y-1/2 bg-background"
                    style={{ left: percent(tick.fraction) }}
                  />
                ))}
              {hasDefault && defaultValue >= min && defaultValue <= max ? (
                <span
                  aria-hidden="true"
                  data-slot="range-field-default-tick"
                  className="pointer-events-none absolute top-1/2 h-4 w-0.5 -translate-x-1/2 -translate-y-1/2 bg-foreground/70"
                  style={{ left: percent(scale.fractionOf(defaultValue)) }}
                />
              ) : null}
            </div>
            <div
              aria-hidden="true"
              className="relative h-4 overflow-hidden text-xs whitespace-nowrap text-muted-foreground tabular-nums"
            >
              {ticks.map((tick, index) =>
                tick.edge === null && (!labelStops || !labelMidStop(index, ticks.length)) ? null : (
                  <span
                    key={tick.value}
                    className={cn(
                      "absolute top-0",
                      tick.edge === "start" && "left-0",
                      tick.edge === "end" && "right-0",
                      // Mid-track labels only from `sm:` — at phone widths they
                      // would collide with each other and with the end labels.
                      tick.edge === null && "hidden -translate-x-1/2 sm:block",
                    )}
                    style={tick.edge === null ? { left: percent(tick.fraction) } : undefined}
                  >
                    {format(tick.value)}
                  </span>
                ),
              )}
            </div>
          </SliderPrimitive.Root>
        </FieldPrimitive.Root>

        <span id={inputHintId} className="sr-only">
          {labels.inputLabel}
        </span>
        <Input
          id={id}
          name={field.name}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          className={cn("w-24 shrink-0 tabular-nums sm:w-28", inputClassName)}
          value={draft ?? formatExact(value)}
          onChange={(event) =>
            setEntry({ forValue: value, text: event.target.value, message: null })
          }
          onBlur={() => {
            commitDraft();
            field.handleBlur();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              // Commit instead of submitting the form with the stale value;
              // a second Enter submits once the input mirrors the field.
              if (draft !== null) {
                event.preventDefault();
                commitDraft();
              }
            } else if (event.key === "Escape" && draft !== null) {
              event.preventDefault();
              setEntry(null);
            }
          }}
          aria-labelledby={`${labelId} ${inputHintId}`}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
        />
      </div>

      {limited ? (
        <p
          id={limitId}
          data-slot="range-field-limit"
          className={cn("text-xs", aboveLimit ? "text-destructive" : "text-muted-foreground")}
        >
          {limitText}
        </p>
      ) : null}
      {typedError ? (
        <p id={typedErrorId} role="alert" className="text-sm text-destructive">
          {typedError}
        </p>
      ) : null}
      {notice ? (
        <p id={noticeId} role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      ) : null}
      {description ? (
        <div id={descriptionId} className="text-xs text-muted-foreground">
          {description}
        </div>
      ) : null}
      {/* The limit line above already says it (in red when the value is over
          the limit); a schema error with the same text is not repeated. */}
      <FieldError
        id={errorId}
        errors={
          limited
            ? field.state.meta.errors.filter(
                (error) =>
                  error !== limitText &&
                  !(
                    error &&
                    typeof error === "object" &&
                    "message" in error &&
                    error.message === limitText
                  ),
              )
            : field.state.meta.errors
        }
      />
    </div>
  );
}
