/**
 * Pure value <-> slider-position logic for `RangeField`
 * (`@knowledge-base/ui/components/range-field`): linear and log scales, snap stops,
 * clamping/step snapping, unit formatting and parsing, and validation codes.
 * No React, no DOM, no locale — every human-visible string is built by the
 * caller from these numbers.
 */

/** One display unit: `value / factor` is shown followed by `label`. */
export type RangeUnit = {
  /** How many base units one of this unit is (the base unit has factor 1). */
  factor: number;
  /** Shown after the number, e.g. `"GiB"`. May be empty for a unitless value. */
  label: string;
  /**
   * Extra spellings the parser accepts, case-insensitive (e.g. `["g", "gb"]`).
   * The full `label` and, when unambiguous, its first letter are always
   * accepted without listing them here.
   */
  aliases?: readonly string[];
};

/** Base-2 memory/disk units for a value stored in MiB. */
export const MEBIBYTE_UNITS: readonly RangeUnit[] = [
  { factor: 1, label: "MiB", aliases: ["mb"] },
  { factor: 1024, label: "GiB", aliases: ["gb"] },
  { factor: 1024 * 1024, label: "TiB", aliases: ["tb"] },
];

/** Base-2 disk units for a value stored in GiB. */
export const GIBIBYTE_UNITS: readonly RangeUnit[] = [
  { factor: 1, label: "GiB", aliases: ["gb"] },
  { factor: 1024, label: "TiB", aliases: ["tb"] },
];

export type RangeValidationCode =
  | "not-a-number"
  | "below-min"
  | "above-max"
  | "above-limit"
  | "off-step";

export type RangeConstraints = {
  min: number;
  max: number;
  /** Granularity, measured from `min`. Defaults to 1. */
  step?: number;
  /** Dynamic max (what the chosen host/pool allows). Ignored when ≥ `max`. */
  limit?: number;
};

// Absorbs float noise like 0.1 + 0.2, and 1.1 * 1024 not landing on an integer.
const EPSILON = 1e-9;

function cleanFloat(value: number): number {
  // 15 significant digits is within double precision and drops the noise in
  // the last bits, so `0.30000000000000004` becomes `0.3`.
  return Number(value.toPrecision(15));
}

export function clampToRange(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** Nearest multiple of `step` counted from `origin`. */
export function snapToStep(value: number, step: number, origin = 0): number {
  if (!(step > 0)) return value;
  return cleanFloat(origin + Math.round((value - origin) / step) * step);
}

/** Largest multiple of `step` from `origin` that is ≤ `value`. */
export function snapDownToStep(value: number, step: number, origin = 0): number {
  if (!(step > 0)) return value;
  return cleanFloat(origin + Math.floor((value - origin) / step + EPSILON) * step);
}

export function isOnStep(value: number, step: number, origin = 0): boolean {
  if (!(step > 0)) return true;
  const steps = (value - origin) / step;
  return Math.abs(steps - Math.round(steps)) < 1e-6;
}

/** Index of the stop closest to `value`; ties go to the lower stop. -1 if empty. */
export function nearestStopIndex(value: number, stops: readonly number[]): number {
  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < stops.length; index++) {
    const distance = Math.abs((stops[index] as number) - value);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  }
  return best;
}

/** The effective upper bound: `max`, lowered to `limit` when one is set. */
export function effectiveMax(max: number, limit?: number): number {
  return limit === undefined ? max : Math.min(max, limit);
}

/**
 * First constraint `value` breaks, in the order a user would fix them, or
 * `null` when it is allowed. `above-limit` is only reported when the dynamic
 * limit is what rejects it (a value above `max` is `above-max` either way).
 */
export function validateRangeValue(
  value: number,
  { min, max, step = 1, limit }: RangeConstraints,
): RangeValidationCode | null {
  if (!Number.isFinite(value)) return "not-a-number";
  if (value < min - EPSILON) return "below-min";
  if (value > max + EPSILON) return "above-max";
  if (limit !== undefined && value > limit + EPSILON) return "above-limit";
  if (!isOnStep(value, step, min)) return "off-step";
  return null;
}

// ---------------------------------------------------------------------------
// Scales
// ---------------------------------------------------------------------------

export type RangeScaleKind = "linear" | "log";

export type RangeScaleOptions = {
  min: number;
  max: number;
  step?: number;
  scale?: RangeScaleKind;
  /**
   * Snap stops: the slider moves stop-to-stop with the stops evenly spaced
   * along the track, so `[1, 2, 4, 8, 16, 32]` is a log-ish scale that only
   * lands on exact human values. Stops outside `[min, max]` or off `step` are
   * dropped and the track ends are always added (`min`, and `max` snapped
   * down to `step`). Overrides `scale`.
   */
  stops?: readonly number[];
  /** Slider resolution for `scale: "log"` without stops. Defaults to 100. */
  logResolution?: number;
};

/**
 * A mapping between values (base unit) and slider positions. The slider
 * itself only ever sees positions in `[minPosition, maxPosition]` moving by
 * `positionStep`.
 */
export type RangeScale = {
  /** `"linear"`, or `"stops"` for explicit stops and for the log scale. */
  kind: "linear" | "stops";
  minPosition: number;
  maxPosition: number;
  positionStep: number;
  /** Discrete values, one per position, when `kind === "stops"`. */
  stops: readonly number[];
  /**
   * Position for a value. A value between two stops (typed through the escape
   * hatch) maps to a fractional position between them, so the thumb sits where
   * the value actually is.
   */
  toPosition: (value: number) => number;
  /** Value for a slider position — always on a stop / on `step`, in range. */
  toValue: (position: number) => number;
  /**
   * Highest slider position whose value is ≤ `value`, or `null` when even the
   * lowest position is above it. This is how a dynamic limit becomes the
   * slider's own max.
   */
  positionAtOrBelow: (value: number) => number | null;
  /** 0–1 along the track for a value. */
  fractionOf: (value: number) => number;
};

/**
 * The highest value the track can reach: `max` snapped down to `step` from
 * `min` (`max` itself when it is on step), never below `min`.
 */
export function topOfRange(min: number, max: number, step = 1): number {
  return Math.max(min, snapDownToStep(max, step, min));
}

/**
 * Sorted, de-duplicated stops inside `[min, max]` and on `step` (counted from
 * `min`, the same rule typed values follow), with the ends added: `min`, and
 * `max` snapped down to `step` when it is off step. So `min 0, max 10, step 3`
 * with stops `[3, 6, 9]` ends at 9, not at an uncommittable 10.
 */
export function normalizeStops(
  stops: readonly number[],
  min: number,
  max: number,
  step = 1,
): number[] {
  const top = topOfRange(min, max, step);
  const allowed = stops.filter(
    (stop) =>
      Number.isFinite(stop) && stop >= min && stop <= top + EPSILON && isOnStep(stop, step, min),
  );
  const all = [min, ...allowed.map(cleanFloat), top].sort((a, b) => a - b);
  return all.filter((stop, index) => index === 0 || stop !== all[index - 1]);
}

/**
 * Geometric (log-spaced) values from `min` to `max`, snapped to `step` and
 * de-duplicated, so each slider position is a distinct value and arrow keys
 * never get stuck. A `min` ≤ 0 is handled by shifting the range so it starts
 * at `step` before taking logs. Where neighbouring positions would round to
 * the same step (the low end of 1..1024 with step 1) they collapse into one,
 * so that end gets fewer positions than a pure log curve would give it.
 */
export function buildLogStops(min: number, max: number, step = 1, resolution = 100): number[] {
  const top = topOfRange(min, max, step);
  if (!(top > min)) return [min];
  const offset = min > 0 ? 0 : (step > 0 ? step : 1) - min;
  const lo = Math.log(min + offset);
  const hi = Math.log(top + offset);
  const count = Math.max(2, Math.floor(resolution));
  const raw: number[] = [];
  for (let index = 0; index <= count; index++) {
    const value = Math.exp(lo + ((hi - lo) * index) / count) - offset;
    raw.push(clampToRange(snapToStep(value, step, min), min, top));
  }
  return normalizeStops(raw, min, max, step);
}

function createStopScale(stops: readonly number[]): RangeScale {
  const last = stops.length - 1;
  const toPosition = (value: number): number => {
    if (last <= 0) return 0;
    if (value <= (stops[0] as number)) return 0;
    if (value >= (stops[last] as number)) return last;
    for (let index = 0; index < last; index++) {
      const lo = stops[index] as number;
      const hi = stops[index + 1] as number;
      if (value >= lo && value <= hi) {
        return index + (value - lo) / (hi - lo);
      }
    }
    return last;
  };
  return {
    kind: "stops",
    minPosition: 0,
    maxPosition: Math.max(last, 0),
    positionStep: 1,
    stops,
    toPosition,
    toValue: (position) =>
      stops[clampToRange(Math.round(position), 0, Math.max(last, 0))] as number,
    positionAtOrBelow: (value) => {
      let found: number | null = null;
      for (let index = 0; index <= last; index++) {
        if ((stops[index] as number) <= value + EPSILON) found = index;
      }
      return found;
    },
    fractionOf: (value) => (last <= 0 ? 0 : toPosition(value) / last),
  };
}

function createLinearScale(min: number, max: number, step: number): RangeScale {
  // An off-step `max` is not a value the slider may produce; its end is the
  // last on-step value below it.
  const top = topOfRange(min, max, step);
  const span = top - min;
  return {
    kind: "linear",
    minPosition: min,
    maxPosition: top,
    positionStep: step,
    stops: [],
    toPosition: (value) => clampToRange(value, min, top),
    toValue: (position) => clampToRange(snapToStep(position, step, min), min, top),
    positionAtOrBelow: (value) =>
      value < min - EPSILON ? null : clampToRange(snapDownToStep(value, step, min), min, top),
    fractionOf: (value) => (span <= 0 ? 0 : (clampToRange(value, min, top) - min) / span),
  };
}

export function createRangeScale({
  min,
  max,
  step = 1,
  scale = "linear",
  stops,
  logResolution,
}: RangeScaleOptions): RangeScale {
  if (stops && stops.length > 0) return createStopScale(normalizeStops(stops, min, max, step));
  if (scale === "log") return createStopScale(buildLogStops(min, max, step, logResolution));
  return createLinearScale(min, max, step);
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

// `toFixed` accepts at most 100 digits; 20 is far beyond a double's precision.
const MAX_FRACTION_DIGITS = 20;

/** Fraction digits needed to write `value` without rounding (float noise aside). */
export function fractionDigitsOf(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const clean = cleanFloat(value);
  for (let digits = 0; digits < MAX_FRACTION_DIGITS; digits++) {
    if (Number(clean.toFixed(digits)) === clean) return digits;
  }
  return MAX_FRACTION_DIGITS;
}

/**
 * `value` rounded to `maxFractionDigits`, trailing zeros trimmed: 1.50 -> "1.5".
 * Always positional ("0.0000001", never "1e-7"), so `parseUnitValue` reads it.
 */
export function formatNumber(value: number, maxFractionDigits = 2): string {
  if (!Number.isFinite(value)) return String(value);
  const digits = clampToRange(Math.floor(maxFractionDigits), 0, MAX_FRACTION_DIGITS);
  let text = value.toFixed(digits);
  if (text.includes(".")) text = text.replace(/\.?0+$/, "");
  // Rounding a tiny negative gives "-0"; show it as "0".
  return text === "-0" ? "0" : text;
}

/** `value` written exactly: as many fraction digits as it has, never rounded. */
export function formatExactNumber(value: number): string {
  return formatNumber(value, fractionDigitsOf(value));
}

function sortedUnits(units: readonly RangeUnit[]): RangeUnit[] {
  return [...units].filter((unit) => unit.factor > 0).sort((a, b) => a.factor - b.factor);
}

export type FormatUnitOptions = {
  /** Defaults to 2. */
  maxFractionDigits?: number;
  /**
   * Never round: pick a larger unit only when it shows the value exactly
   * within `maxFractionDigits` (1100 MiB stays "1100 MiB", not "1.07 GiB"),
   * and write the number with every digit it has — in the fallback smallest
   * unit and without units too (0.125 stays "0.125"). Use for anything the
   * user can edit and commit back, so a round trip is lossless.
   */
  exact?: boolean;
};

/**
 * The unit `formatUnit` would use: the largest whose `value / factor` is ≥ 1
 * (and, with `exact`, represents the value without rounding). Falls back to
 * the smallest unit. `undefined` when `units` is empty.
 */
export function pickUnit(
  value: number,
  units: readonly RangeUnit[],
  { maxFractionDigits = 2, exact = false }: FormatUnitOptions = {},
): RangeUnit | undefined {
  const sorted = sortedUnits(units);
  for (let index = sorted.length - 1; index > 0; index--) {
    const unit = sorted[index] as RangeUnit;
    const scaled = Math.abs(value) / unit.factor;
    if (scaled < 1 - EPSILON) continue;
    if (exact) {
      const shown = Number((value / unit.factor).toFixed(maxFractionDigits));
      if (Math.abs(shown * unit.factor - value) > 1e-6) continue;
    }
    return unit;
  }
  return sorted[0];
}

/**
 * Human display of a base-unit value: `formatUnit(4096, MEBIBYTE_UNITS)` is
 * `"4 GiB"`, `1536` is `"1.5 GiB"`, `512` is `"512 MiB"`. Without units it is
 * just the trimmed number.
 */
export function formatUnit(
  value: number,
  units: readonly RangeUnit[] = [],
  options: FormatUnitOptions = {},
): string {
  const { maxFractionDigits = 2, exact = false } = options;
  const show = (amount: number) =>
    exact ? formatExactNumber(amount) : formatNumber(amount, maxFractionDigits);
  const unit = pickUnit(value, units, options);
  if (!unit) return show(value);
  const number = show(value / unit.factor);
  return unit.label ? `${number} ${unit.label}` : number;
}

export type ParseUnitResult = { ok: true; value: number } | { ok: false; code: "not-a-number" };

export type ParseUnitOptions = {
  /**
   * Factor applied to a bare number with no suffix. Defaults to the base unit
   * (the smallest factor). `RangeField` passes the unit currently on screen,
   * so clearing "4 GiB" and typing "8" means 8 GiB — which matters because a
   * `decimal` phone keyboard has no letters for a suffix.
   */
  defaultFactor?: number;
};

const NUMBER_WITH_SUFFIX = /^([+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+))\s*([a-z]*)$/i;

function unitForSuffix(suffix: string, units: readonly RangeUnit[]): RangeUnit | undefined {
  const wanted = suffix.toLowerCase();
  const byName = units.find(
    (unit) =>
      unit.label.toLowerCase() === wanted ||
      (unit.aliases ?? []).some((alias) => alias.toLowerCase() === wanted),
  );
  if (byName) return byName;
  if (wanted.length !== 1) return undefined;
  const byInitial = units.filter((unit) => unit.label.toLowerCase().startsWith(wanted));
  return byInitial.length === 1 ? byInitial[0] : undefined;
}

/**
 * Parses typed text back into the base unit: `"4"`, `"4 GiB"`, `"4096 MiB"`,
 * `"4g"`, `"1.5GiB"`, `"1,5 GiB"` (comma as a decimal separator). Thousands
 * separators are not supported. Unknown suffixes are `not-a-number`.
 */
export function parseUnitValue(
  text: string,
  units: readonly RangeUnit[] = [],
  { defaultFactor }: ParseUnitOptions = {},
): ParseUnitResult {
  const match = NUMBER_WITH_SUFFIX.exec(text.trim());
  if (!match) return { ok: false, code: "not-a-number" };
  const amount = Number((match[1] as string).replace(",", "."));
  if (!Number.isFinite(amount)) return { ok: false, code: "not-a-number" };
  const suffix = match[2] as string;
  let factor: number;
  if (suffix === "") {
    factor = defaultFactor ?? sortedUnits(units)[0]?.factor ?? 1;
  } else {
    const unit = unitForSuffix(suffix, units);
    if (!unit) return { ok: false, code: "not-a-number" };
    factor = unit.factor;
  }
  return { ok: true, value: cleanFloat(amount * factor) };
}
