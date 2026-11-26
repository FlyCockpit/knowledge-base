import { describe, expect, it } from "vitest";
import {
  buildLogStops,
  clampToRange,
  createRangeScale,
  effectiveMax,
  formatExactNumber,
  formatNumber,
  formatUnit,
  fractionDigitsOf,
  GIBIBYTE_UNITS,
  isOnStep,
  MEBIBYTE_UNITS,
  nearestStopIndex,
  normalizeStops,
  parseUnitValue,
  pickUnit,
  snapDownToStep,
  snapToStep,
  topOfRange,
  validateRangeValue,
} from "./range-scale";

describe("clampToRange / snapToStep", () => {
  it("clamps into [min, max]", () => {
    expect(clampToRange(-5, 0, 10)).toBe(0);
    expect(clampToRange(15, 0, 10)).toBe(10);
    expect(clampToRange(7, 0, 10)).toBe(7);
  });

  it("snaps to the nearest step from an origin", () => {
    expect(snapToStep(7, 5)).toBe(5);
    expect(snapToStep(8, 5)).toBe(10);
    expect(snapToStep(130, 256, 128)).toBe(128);
    expect(snapToStep(300, 256, 128)).toBe(384);
  });

  it("absorbs float noise on decimal steps", () => {
    expect(snapToStep(0.1 + 0.2, 0.1)).toBe(0.3);
    expect(snapToStep(1.25, 0.25)).toBe(1.25);
  });

  it("snaps down without crossing the value", () => {
    expect(snapDownToStep(1023, 256)).toBe(768);
    expect(snapDownToStep(1024, 256)).toBe(1024);
    expect(snapDownToStep(0.3, 0.1)).toBe(0.3);
  });

  it("leaves the value alone for a non-positive step", () => {
    expect(snapToStep(3.3, 0)).toBe(3.3);
    expect(isOnStep(3.3, 0)).toBe(true);
  });

  it("checks step membership from the origin", () => {
    expect(isOnStep(384, 256, 128)).toBe(true);
    expect(isOnStep(256, 256, 128)).toBe(false);
    expect(isOnStep(0.3, 0.1)).toBe(true);
  });
});

describe("nearestStopIndex / effectiveMax", () => {
  const stops = [1, 2, 4, 8, 16, 32];

  it("finds the closest stop, ties going low", () => {
    expect(nearestStopIndex(5, stops)).toBe(2);
    expect(nearestStopIndex(6, stops)).toBe(2);
    expect(nearestStopIndex(7, stops)).toBe(3);
    expect(nearestStopIndex(100, stops)).toBe(5);
    expect(nearestStopIndex(-1, stops)).toBe(0);
    expect(nearestStopIndex(3, [])).toBe(-1);
  });

  it("lowers max to the limit only when the limit is lower", () => {
    expect(effectiveMax(64)).toBe(64);
    expect(effectiveMax(64, 16)).toBe(16);
    expect(effectiveMax(64, 128)).toBe(64);
  });
});

describe("validateRangeValue", () => {
  const constraints = { min: 512, max: 65536, step: 256, limit: 16384 };

  it("accepts an on-step value inside the range and limit", () => {
    expect(validateRangeValue(4096, constraints)).toBeNull();
    expect(validateRangeValue(512, constraints)).toBeNull();
    expect(validateRangeValue(16384, constraints)).toBeNull();
  });

  it("reports each code", () => {
    expect(validateRangeValue(Number.NaN, constraints)).toBe("not-a-number");
    expect(validateRangeValue(Number.POSITIVE_INFINITY, constraints)).toBe("not-a-number");
    expect(validateRangeValue(256, constraints)).toBe("below-min");
    expect(validateRangeValue(70000, constraints)).toBe("above-max");
    expect(validateRangeValue(32768, constraints)).toBe("above-limit");
    expect(validateRangeValue(1000, constraints)).toBe("off-step");
  });

  it("prefers above-max over above-limit, and range over step", () => {
    expect(validateRangeValue(70001, constraints)).toBe("above-max");
    expect(validateRangeValue(100, constraints)).toBe("below-min");
  });

  it("defaults step to 1 and ignores a missing limit", () => {
    expect(validateRangeValue(3, { min: 1, max: 8 })).toBeNull();
    expect(validateRangeValue(2.5, { min: 1, max: 8 })).toBe("off-step");
  });
});

describe("linear scale", () => {
  const scale = createRangeScale({ min: 0, max: 100, step: 5 });

  it("maps value to position one-to-one", () => {
    expect(scale.kind).toBe("linear");
    expect(scale.minPosition).toBe(0);
    expect(scale.maxPosition).toBe(100);
    expect(scale.positionStep).toBe(5);
    expect(scale.toPosition(40)).toBe(40);
    expect(scale.toPosition(140)).toBe(100);
  });

  it("snaps and clamps positions into values", () => {
    expect(scale.toValue(42)).toBe(40);
    expect(scale.toValue(43)).toBe(45);
    expect(scale.toValue(120)).toBe(100);
  });

  it("finds the highest position under a limit", () => {
    expect(scale.positionAtOrBelow(42)).toBe(40);
    expect(scale.positionAtOrBelow(500)).toBe(100);
    expect(scale.positionAtOrBelow(-1)).toBeNull();
  });

  it("reports the fraction along the track", () => {
    expect(scale.fractionOf(25)).toBe(0.25);
    expect(scale.fractionOf(-10)).toBe(0);
  });

  it("ends an off-step max at the last on-step value", () => {
    const offStep = createRangeScale({ min: 0, max: 11, step: 3 });
    expect(offStep.maxPosition).toBe(9);
    // Rounding 11 to the nearest step would give 12, then a clamp to 11.
    expect(offStep.toValue(11)).toBe(9);
    expect(offStep.toValue(offStep.maxPosition)).toBe(9);
    expect(offStep.positionAtOrBelow(100)).toBe(9);
    expect(offStep.fractionOf(9)).toBe(1);
  });
});

describe("snap stops", () => {
  const scale = createRangeScale({ min: 1, max: 32, stops: [1, 2, 4, 8, 16, 32] });

  it("spaces stops evenly: one position per stop", () => {
    expect(scale.kind).toBe("stops");
    expect(scale.minPosition).toBe(0);
    expect(scale.maxPosition).toBe(5);
    expect(scale.positionStep).toBe(1);
    expect(scale.toValue(0)).toBe(1);
    expect(scale.toValue(3)).toBe(8);
    expect(scale.toValue(5)).toBe(32);
    expect(scale.fractionOf(4)).toBe(0.4);
  });

  it("rounds fractional positions to a stop and clamps out-of-range ones", () => {
    expect(scale.toValue(2.6)).toBe(8);
    expect(scale.toValue(-3)).toBe(1);
    expect(scale.toValue(9)).toBe(32);
  });

  it("puts a between-stops value at a fractional position", () => {
    expect(scale.toPosition(12)).toBe(3.5);
    expect(scale.toPosition(8)).toBe(3);
    expect(scale.toPosition(0)).toBe(0);
    expect(scale.toPosition(64)).toBe(5);
  });

  it("finds the last stop at or below a limit", () => {
    expect(scale.positionAtOrBelow(16)).toBe(4);
    expect(scale.positionAtOrBelow(20)).toBe(4);
    expect(scale.positionAtOrBelow(0.5)).toBeNull();
  });

  it("drops off-step stops and snaps an off-step max down (End stays on step)", () => {
    expect(topOfRange(0, 10, 3)).toBe(9);
    expect(topOfRange(5, 5, 3)).toBe(5);
    expect(normalizeStops([3, 6, 9], 0, 10, 3)).toEqual([0, 3, 6, 9]);
    expect(normalizeStops([1000, 1024, 2048], 512, 65536, 256)).toEqual([512, 1024, 2048, 65536]);
    const scale = createRangeScale({ min: 0, max: 10, step: 3, stops: [3, 5, 6, 9] });
    expect(scale.stops).toEqual([0, 3, 6, 9]);
    expect(scale.toValue(scale.maxPosition)).toBe(9);
    for (const stop of scale.stops)
      expect(validateRangeValue(stop, { min: 0, max: 10, step: 3 })).toBeNull();
  });

  it("adds min and max, drops out-of-range stops, sorts and de-duplicates", () => {
    expect(normalizeStops([64, 4, 2, 4, 128, 0], 1, 64)).toEqual([1, 2, 4, 64]);
    const withEnds = createRangeScale({ min: 1, max: 64, stops: [2, 8] });
    expect(withEnds.stops).toEqual([1, 2, 8, 64]);
  });

  it("override the log scale when both are given", () => {
    const both = createRangeScale({ min: 1, max: 8, scale: "log", stops: [1, 2, 4, 8] });
    expect(both.stops).toEqual([1, 2, 4, 8]);
  });

  it("copes with a single stop (min === max)", () => {
    const single = createRangeScale({ min: 4, max: 4, stops: [4] });
    expect(single.maxPosition).toBe(0);
    expect(single.toValue(0)).toBe(4);
    expect(single.fractionOf(4)).toBe(0);
  });
});

describe("log scale", () => {
  it("builds distinct, on-step, increasing values from min to max", () => {
    const stops = buildLogStops(512, 262144, 256, 100);
    expect(stops[0]).toBe(512);
    expect(stops.at(-1)).toBe(262144);
    for (let index = 1; index < stops.length; index++) {
      expect(stops[index]).toBeGreaterThan(stops[index - 1] as number);
      expect(isOnStep(stops[index] as number, 256, 512)).toBe(true);
    }
  });

  it("spends more of the track on small values than a linear scale does", () => {
    const scale = createRangeScale({ min: 64, max: 65536, scale: "log" });
    expect(scale.kind).toBe("stops");
    // 2048 is the geometric midpoint of 64..65536; linear would put it at 3%.
    expect(scale.fractionOf(2048)).toBeGreaterThan(0.48);
    expect(scale.fractionOf(2048)).toBeLessThan(0.52);
    expect(scale.toValue(scale.maxPosition)).toBe(65536);
    expect(scale.toValue(0)).toBe(64);
  });

  it("collapses positions that would round to the same step", () => {
    const stops = buildLogStops(1, 8, 1, 100);
    expect(stops).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("handles min <= 0 by shifting the range", () => {
    const stops = buildLogStops(0, 100, 1, 50);
    expect(stops[0]).toBe(0);
    expect(stops.at(-1)).toBe(100);
    expect(new Set(stops).size).toBe(stops.length);
  });

  it("keeps every position on step, the end included, when max is off step", () => {
    const stops = buildLogStops(1, 100, 7, 20);
    expect(stops[0]).toBe(1);
    expect(stops.at(-1)).toBe(99);
    for (const stop of stops)
      expect(validateRangeValue(stop, { min: 1, max: 100, step: 7 })).toBeNull();
    const scale = createRangeScale({ min: 1, max: 100, step: 7, scale: "log" });
    expect(scale.toValue(scale.maxPosition)).toBe(99);
  });

  it("returns just min for an empty range", () => {
    expect(buildLogStops(5, 5)).toEqual([5]);
  });
});

describe("formatUnit", () => {
  it("picks the largest unit that gives >= 1 and trims zeros", () => {
    expect(formatUnit(512, MEBIBYTE_UNITS)).toBe("512 MiB");
    expect(formatUnit(4096, MEBIBYTE_UNITS)).toBe("4 GiB");
    expect(formatUnit(1536, MEBIBYTE_UNITS)).toBe("1.5 GiB");
    expect(formatUnit(1024, MEBIBYTE_UNITS)).toBe("1 GiB");
    expect(formatUnit(1023, MEBIBYTE_UNITS)).toBe("1023 MiB");
    expect(formatUnit(2 * 1024 * 1024, MEBIBYTE_UNITS)).toBe("2 TiB");
    expect(formatUnit(500, GIBIBYTE_UNITS)).toBe("500 GiB");
  });

  it("rounds for display but stays exact on request", () => {
    expect(formatUnit(1100, MEBIBYTE_UNITS)).toBe("1.07 GiB");
    expect(formatUnit(1100, MEBIBYTE_UNITS, { exact: true })).toBe("1100 MiB");
    expect(formatUnit(1280, MEBIBYTE_UNITS, { exact: true })).toBe("1.25 GiB");
    expect(formatUnit(1100, MEBIBYTE_UNITS, { maxFractionDigits: 0 })).toBe("1 GiB");
  });

  it("never rounds in exact mode: fallback unit, no units, and empty labels", () => {
    expect(formatUnit(0.125, [], { exact: true })).toBe("0.125");
    expect(formatUnit(0.125, [])).toBe("0.13");
    expect(formatUnit(0.125, [{ factor: 1, label: "" }], { exact: true })).toBe("0.125");
    expect(formatUnit(0.0625, MEBIBYTE_UNITS, { exact: true })).toBe("0.0625 MiB");
    expect(formatUnit(1100.125, MEBIBYTE_UNITS, { exact: true })).toBe("1100.125 MiB");
    expect(formatUnit(1e-7, [], { exact: true })).toBe("0.0000001");
    expect(formatUnit(1100, MEBIBYTE_UNITS, { exact: true, maxFractionDigits: 0 })).toBe(
      "1100 MiB",
    );
  });

  it("counts the fraction digits a value needs", () => {
    expect(fractionDigitsOf(4)).toBe(0);
    expect(fractionDigitsOf(0.125)).toBe(3);
    expect(fractionDigitsOf(0.1 + 0.2)).toBe(1);
    expect(fractionDigitsOf(1e-7)).toBe(7);
    expect(formatExactNumber(0.1 + 0.2)).toBe("0.3");
    expect(formatExactNumber(-2.5)).toBe("-2.5");
  });

  it("falls back to the smallest unit below 1 and for zero", () => {
    expect(formatUnit(0, MEBIBYTE_UNITS)).toBe("0 MiB");
    expect(formatUnit(0.5, MEBIBYTE_UNITS)).toBe("0.5 MiB");
  });

  it("is order-independent and works without units or labels", () => {
    expect(formatUnit(2048, [...MEBIBYTE_UNITS].reverse())).toBe("2 GiB");
    expect(formatUnit(4)).toBe("4");
    expect(formatUnit(2.5, [{ factor: 1, label: "" }])).toBe("2.5");
    expect(formatUnit(8, [{ factor: 1, label: "vCPU" }])).toBe("8 vCPU");
  });

  it("picks the unit it formats with", () => {
    expect(pickUnit(4096, MEBIBYTE_UNITS)?.label).toBe("GiB");
    expect(pickUnit(1100, MEBIBYTE_UNITS, { exact: true })?.label).toBe("MiB");
    expect(pickUnit(5, [])).toBeUndefined();
  });

  it("formats plain numbers", () => {
    expect(formatNumber(1.5)).toBe("1.5");
    expect(formatNumber(2)).toBe("2");
    expect(formatNumber(1.005, 1)).toBe("1");
    expect(formatNumber(-0.001)).toBe("0");
    expect(formatNumber(1e-7, 7)).toBe("0.0000001");
    expect(formatNumber(100, 2)).toBe("100");
  });
});

describe("parseUnitValue", () => {
  it("reads a bare number in the base unit by default", () => {
    expect(parseUnitValue("4", MEBIBYTE_UNITS)).toEqual({ ok: true, value: 4 });
    expect(parseUnitValue("  512 ", MEBIBYTE_UNITS)).toEqual({ ok: true, value: 512 });
  });

  it("reads a bare number in a caller-chosen unit", () => {
    expect(parseUnitValue("4", MEBIBYTE_UNITS, { defaultFactor: 1024 })).toEqual({
      ok: true,
      value: 4096,
    });
  });

  it("accepts unit labels, initials, and aliases, any case, with or without a space", () => {
    expect(parseUnitValue("4 GiB", MEBIBYTE_UNITS)).toEqual({ ok: true, value: 4096 });
    expect(parseUnitValue("4096 MiB", MEBIBYTE_UNITS)).toEqual({ ok: true, value: 4096 });
    expect(parseUnitValue("4g", MEBIBYTE_UNITS)).toEqual({ ok: true, value: 4096 });
    expect(parseUnitValue("4G", MEBIBYTE_UNITS)).toEqual({ ok: true, value: 4096 });
    expect(parseUnitValue("1.5GiB", MEBIBYTE_UNITS)).toEqual({ ok: true, value: 1536 });
    expect(parseUnitValue("2gb", MEBIBYTE_UNITS)).toEqual({ ok: true, value: 2048 });
    expect(parseUnitValue("1 t", MEBIBYTE_UNITS)).toEqual({ ok: true, value: 1048576 });
    expect(parseUnitValue("256m", MEBIBYTE_UNITS)).toEqual({ ok: true, value: 256 });
  });

  it("accepts a comma decimal separator and leading-dot numbers", () => {
    expect(parseUnitValue("1,5 GiB", MEBIBYTE_UNITS)).toEqual({ ok: true, value: 1536 });
    expect(parseUnitValue(".5 GiB", MEBIBYTE_UNITS)).toEqual({ ok: true, value: 512 });
    expect(parseUnitValue("2.", MEBIBYTE_UNITS)).toEqual({ ok: true, value: 2 });
  });

  it("returns clean values for fractional units", () => {
    expect(parseUnitValue("1.1 GiB", MEBIBYTE_UNITS)).toEqual({ ok: true, value: 1126.4 });
  });

  it("rejects garbage, unknown units, and ambiguous initials", () => {
    const nan = { ok: false, code: "not-a-number" };
    expect(parseUnitValue("", MEBIBYTE_UNITS)).toEqual(nan);
    expect(parseUnitValue("abc", MEBIBYTE_UNITS)).toEqual(nan);
    expect(parseUnitValue("4 PiB", MEBIBYTE_UNITS)).toEqual(nan);
    expect(parseUnitValue("4 GiB extra", MEBIBYTE_UNITS)).toEqual(nan);
    expect(parseUnitValue("1.2.3", MEBIBYTE_UNITS)).toEqual(nan);
    expect(parseUnitValue("4 g", [])).toEqual(nan);
    const ambiguous = [
      { factor: 1, label: "MiB" },
      { factor: 60, label: "Minutes" },
    ];
    expect(parseUnitValue("4m", ambiguous)).toEqual(nan);
    expect(parseUnitValue("4 minutes", ambiguous)).toEqual({ ok: true, value: 240 });
  });

  it("works without units", () => {
    expect(parseUnitValue("-3.25")).toEqual({ ok: true, value: -3.25 });
  });

  it("round-trips with exact formatting", () => {
    for (const value of [512, 768, 1024, 1280, 1536, 4096, 1100, 65536, 3 * 1024 * 1024]) {
      const text = formatUnit(value, MEBIBYTE_UNITS, { exact: true });
      expect(parseUnitValue(text, MEBIBYTE_UNITS)).toEqual({ ok: true, value });
    }
    for (const value of [0.125, 0.001, 0.5, 2.375, 0.0000001]) {
      expect(parseUnitValue(formatUnit(value, [], { exact: true }))).toEqual({ ok: true, value });
    }
  });
});
