import { MEBIBYTE_UNITS } from "@knowledge-base/ui/lib/range-scale";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  interpretRangeInput,
  labelMidStop,
  liveTypedEntry,
  RangeField,
  type RangeFieldProps,
  rangeErrorMessage,
  rangeFieldEnglishLabels,
  stepFromBetween,
} from "./range-field";

/**
 * No DOM in this package's tests: the markup is rendered statically (no
 * layout, no events), so interaction is covered through the pure
 * `interpretRangeInput` decision plus the attributes the slider and input
 * render with. Real widths (390px / 320px) are checked in a browser.
 */

function field(value: number, errors: readonly unknown[] = []) {
  return {
    name: "memory",
    state: { value, meta: { errors } },
    handleBlur: vi.fn(),
    handleChange: vi.fn(),
  };
}

const memory = {
  label: "Memory",
  labels: rangeFieldEnglishLabels,
  min: 512,
  max: 65536,
  step: 256,
  stops: [512, 1024, 2048, 4096, 8192, 16384, 32768, 65536],
  units: MEBIBYTE_UNITS,
} satisfies Omit<RangeFieldProps, "field">;

function render(props: Partial<RangeFieldProps> & { value?: number; errors?: unknown[] } = {}) {
  const { value = 4096, errors, ...rest } = props;
  return renderToStaticMarkup(<RangeField field={field(value, errors)} {...memory} {...rest} />);
}

function attr(html: string, selector: RegExp): string | undefined {
  return selector.exec(html)?.[1];
}

/** The `<input type="text">` escape hatch (the slider's own input is `type="range"`). */
function textInput(html: string): string {
  return /<input[^>]*type="text"[^>]*>/.exec(html)?.[0] ?? "";
}

function rangeInput(html: string): string {
  return /<input[^>]*type="range"[^>]*>/.exec(html)?.[0] ?? "";
}

describe("RangeField markup", () => {
  it("labels the typed input and the slider from the same label", () => {
    const html = render();
    const input = textInput(html);
    const labelId = attr(html, /<label[^>]*id="([^"]+)"/);
    const labelFor = attr(html, /<label[^>]*for="([^"]+)"/);
    expect(labelId).toBeTruthy();
    expect(attr(input, /id="([^"]+)"/)).toBe(labelFor);
    expect(attr(input, /aria-labelledby="([^"]+)"/)?.split(" ")[0]).toBe(labelId);
    expect(html).toContain(">Exact value<");
    expect(attr(rangeInput(html), /aria-labelledby="([^"]+)"/)).toBe(labelId);
  });

  it("uses the decimal keyboard, no autofill, and shows the exact value with its unit", () => {
    const input = textInput(render({ value: 1536 }));
    expect(input).toContain('inputMode="decimal"');
    expect(input).toContain('autoComplete="off"');
    expect(input).toContain('name="memory"');
    expect(input).toContain('value="1.5 GiB"');
    expect(textInput(render({ value: 1280 + 256 * 3 }))).toContain('value="2 GiB"');
  });

  it("drives the slider in stop positions and announces the human value", () => {
    const range = rangeInput(render({ value: 4096 }));
    expect(range).toContain('aria-valuetext="4 GiB"');
    expect(range).toContain('min="0"');
    expect(range).toContain('max="7"');
    expect(range).toContain('value="3"');
  });

  it("puts a between-stops value between the stops", () => {
    expect(rangeInput(render({ value: 12288 }))).toContain('value="4.5"');
  });

  it("labels min, max and up to eight stops under the track, thinned when crowded", () => {
    const html = render();
    // Eight stops (512 MiB … 64 GiB): every other mid stop, none next to an end.
    for (const text of ["512 MiB", "2 GiB", "8 GiB", "64 GiB"]) {
      expect(html).toContain(`>${text}</span>`);
    }
    for (const text of ["1 GiB", "4 GiB", "32 GiB"]) {
      expect(html).not.toContain(`>${text}</span>`);
    }
    // Mid-track labels give way below `sm:`; the ends never do.
    expect(html).toMatch(/class="absolute top-0 hidden -translate-x-1\/2 sm:block"[^>]*>2 GiB</);
    expect(html).toMatch(/class="absolute top-0 left-0">512 MiB</);
    expect(html).toMatch(/class="absolute top-0 right-0">64 GiB</);
  });

  it("labels only the ends of a log or linear track", () => {
    const html = render({ stops: undefined, scale: "log" });
    expect(html).toContain(">512 MiB</span>");
    expect(html).toContain(">64 GiB</span>");
    expect(html).not.toContain(">1 GiB</span>");
  });

  it("lays the slider and input side by side without overflowing", () => {
    const html = render();
    expect(html).toContain('class="flex items-start gap-3"');
    expect(html).toContain('class="min-w-0 flex-1"');
    expect(textInput(html)).toMatch(/class="[^"]*w-24 shrink-0[^"]*sm:w-28/);
    expect(html).toContain("overflow-hidden");
    expect(html).not.toContain(["transition", "all"].join("-"));
  });

  it("gives the thumb a 44px hit area on touch and a grabbable control height", () => {
    const html = render();
    expect(html).toMatch(/size-5[^"]*before:-inset-3/);
    expect(html).toContain("relative flex h-11 items-center md:h-8");
  });

  it("shows the default state and a tick when the value is the default", () => {
    const html = render({ value: 2048, defaultValue: 2048, defaultLabel: "template ubuntu-24" });
    expect(html).toContain("Default (from template ubuntu-24)");
    expect(html).not.toContain("Reset to default");
    expect(html).toMatch(/data-slot="range-field-default-tick"[^>]*style="left:28.57%"/);
    const stateId = attr(html, /<span id="([^"]+-state)"/);
    expect(attr(textInput(html), /aria-describedby="([^"]+)"/)).toContain(stateId);
  });

  it("offers a reset when the value differs from the default", () => {
    const html = render({ value: 8192, defaultValue: 2048, defaultLabel: "template ubuntu-24" });
    expect(html).toContain(">Reset to default</button>");
    expect(html).not.toContain("Default (from");
    expect(html).toMatch(/<button[^>]*type="button"/);
  });

  it("disables the reset when the default itself is above the limit", () => {
    const html = render({ value: 4096, defaultValue: 32768, limit: 16384 });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Reset to default/);
  });

  it("stops the slider at the limit, hatches the rest, and explains why", () => {
    const html = render({ value: 4096, limit: 16384 });
    const range = rangeInput(html);
    expect(range).toContain('max="5"');
    // 5 of 7 positions are reachable.
    expect(html).toContain("width:71.43%");
    expect(html).toContain('data-slot="range-field-limit-region"');
    expect(html).toMatch(/data-slot="range-field-limit"[^>]*>This host allows at most 16 GiB</);
    expect(html).toMatch(/class="text-xs text-muted-foreground">This host allows/);
    expect(textInput(html)).not.toContain('aria-invalid="');
    expect(rangeInput(html)).not.toContain('aria-invalid="');
  });

  it("lets limitMessage override the limit text", () => {
    const html = render({ limit: 16384, limitMessage: "Pool gold is capped at 16 GiB" });
    expect(html).toContain("Pool gold is capped at 16 GiB");
    expect(html).not.toContain("This host allows");
  });

  it("flags a value already above the limit on both controls, without changing it", () => {
    const html = render({ value: 32768, limit: 16384 });
    expect(html).toMatch(/class="text-xs text-destructive">This host allows at most 16 GiB</);
    expect(textInput(html)).toContain('aria-invalid="true"');
    expect(textInput(html)).toContain('value="32 GiB"');
    expect(rangeInput(html)).toContain('aria-invalid="true"');
    expect(rangeInput(html)).toContain('aria-valuetext="32 GiB"');
  });

  it("ends an off-step track at the last on-step value", () => {
    const html = render({ min: 0, max: 10, step: 3, stops: [3, 6, 9], units: [], value: 3 });
    expect(rangeInput(html)).toContain('max="3"');
    expect(html).toMatch(/class="absolute top-0 right-0">9</);
    expect(html).not.toContain(">10</span>");
  });

  it("draws no limit region when the limit is at or above max", () => {
    const html = render({ limit: 1_000_000 });
    expect(html).not.toContain("range-field-limit");
    expect(html).toContain("width:100%");
  });

  it("locks the slider when even min is above the limit", () => {
    const html = render({ value: 512, limit: 256 });
    expect(rangeInput(html)).toContain("disabled");
  });

  it("wires field errors like TextField", () => {
    const html = render({ errors: ["Too much memory"], description: "Guest RAM" });
    const input = textInput(html);
    expect(input).toContain('aria-invalid="true"');
    expect(rangeInput(html)).toContain('aria-invalid="true"');
    const describedBy = attr(input, /aria-describedby="([^"]+)"/)?.split(" ") ?? [];
    const errorId = attr(html, /<div id="([^"]+-error)" role="alert"/);
    const descriptionId = attr(html, /<div id="([^"]+-description)"/);
    expect(describedBy).toContain(errorId);
    expect(describedBy).toContain(descriptionId);
    expect(html).toContain("Too much memory");
  });

  it("disables both controls", () => {
    const html = render({ disabled: true });
    expect(textInput(html)).toContain("disabled");
    expect(rangeInput(html)).toContain("disabled");
  });
});

describe("interpretRangeInput", () => {
  const context = {
    labels: rangeFieldEnglishLabels,
    format: (value: number) => `${value}`,
    min: 512,
    max: 65536,
    step: 256,
    limitText: "This host allows at most 16 GiB",
    units: MEBIBYTE_UNITS,
    limit: 16384,
  };

  it("commits valid text in any unit", () => {
    expect(interpretRangeInput("8 GiB", { ...context, currentValue: 4096 })).toEqual({
      kind: "commit",
      value: 8192,
    });
    expect(interpretRangeInput("1536 MiB", { ...context, currentValue: 4096 })).toEqual({
      kind: "commit",
      value: 1536,
    });
  });

  it("reads a bare number in the unit currently shown", () => {
    expect(interpretRangeInput("8", { ...context, currentValue: 4096 })).toEqual({
      kind: "commit",
      value: 8192,
    });
    expect(interpretRangeInput("768", { ...context, currentValue: 512 })).toEqual({
      kind: "commit",
      value: 768,
    });
  });

  it("accepts values between snap stops when on step", () => {
    expect(interpretRangeInput("12 GiB", { ...context, currentValue: 4096 })).toEqual({
      kind: "commit",
      value: 12288,
    });
  });

  it("reverts on empty text", () => {
    expect(interpretRangeInput("  ", { ...context, currentValue: 4096 })).toEqual({
      kind: "revert",
    });
  });

  it("rejects text that is not a number without committing", () => {
    const at = { ...context, currentValue: 4096 };
    expect(interpretRangeInput("lots", at)).toEqual({ kind: "error", message: "Enter a number" });
    expect(interpretRangeInput("4 PiB", at)).toEqual({ kind: "error", message: "Enter a number" });
  });

  it("commits the highest allowed value above the limit, with the limit as the reason", () => {
    const at = { ...context, currentValue: 4096 };
    expect(interpretRangeInput("32 GiB", at)).toEqual({
      kind: "commit",
      value: 16384,
      notice: "This host allows at most 16 GiB. Set to 16384.",
    });
    // Above max too: the limit is still what binds.
    expect(interpretRangeInput("128 GiB", at)).toEqual({
      kind: "commit",
      value: 16384,
      notice: "This host allows at most 16 GiB. Set to 16384.",
    });
  });

  it("commits max above max when no limit binds", () => {
    const at = { ...context, limit: undefined, currentValue: 4096 };
    expect(interpretRangeInput("128 GiB", at)).toEqual({
      kind: "commit",
      value: 65536,
      notice: "Must be at most 65536. Set to 65536.",
    });
  });

  it("snaps the highest allowed value down to step (typing 999 into 1..32)", () => {
    const vcpu = {
      ...context,
      units: [],
      min: 1,
      max: 32,
      step: 1,
      limit: undefined,
      currentValue: 4,
    };
    expect(interpretRangeInput("999", vcpu)).toEqual({
      kind: "commit",
      value: 32,
      notice: "Must be at most 32. Set to 32.",
    });
    // A limit off the step grid: 16300 MiB allows at most 16128 (512 + 61 × 256).
    expect(interpretRangeInput("32 GiB", { ...context, limit: 16300, currentValue: 4096 })).toEqual(
      expect.objectContaining({ kind: "commit", value: 16128 }),
    );
  });

  it("commits min below min", () => {
    expect(interpretRangeInput("256 MiB", { ...context, currentValue: 4096 })).toEqual({
      kind: "commit",
      value: 512,
      notice: "Must be at least 512. Set to 512.",
    });
  });

  it("commits the nearest on-step value off step, never past the limit", () => {
    const at = { ...context, currentValue: 4096 };
    expect(interpretRangeInput("1000 MiB", at)).toEqual({
      kind: "commit",
      value: 1024,
      notice: "Must be a multiple of 256. Set to 1024.",
    });
    expect(interpretRangeInput("800 MiB", at)).toEqual(
      expect.objectContaining({ kind: "commit", value: 768 }),
    );
    expect(interpretRangeInput("16300", { ...at, limit: 16300, currentValue: 512 })).toEqual(
      expect.objectContaining({ kind: "commit", value: 16128 }),
    );
  });

  it("errors when no value is allowed at all", () => {
    expect(interpretRangeInput("1 GiB", { ...context, limit: 256, currentValue: 512 })).toEqual({
      kind: "error",
      message: "This host allows at most 16 GiB",
    });
  });
});

describe("liveTypedEntry", () => {
  const entry = { forValue: 4096, text: "999", message: null };

  it("keeps a draft while the field value is the one it started from", () => {
    expect(liveTypedEntry(entry, 4096)).toBe(entry);
    expect(liveTypedEntry(null, 4096)).toBeNull();
  });

  it("drops a draft and its message once the value changes from outside (a reset)", () => {
    expect(liveTypedEntry(entry, 2048)).toBeNull();
    const notice = { forValue: 16384, text: null, message: { tone: "notice" as const, text: "x" } };
    expect(liveTypedEntry(notice, 16384)).toBe(notice);
    expect(liveTypedEntry(notice, 2048)).toBeNull();
  });
});

describe("rangeErrorMessage", () => {
  it("formats values through the given formatter", () => {
    const context = {
      labels: rangeFieldEnglishLabels,
      format: (value: number) => `${value / 1024} GiB`,
      min: 1024,
      max: 4096,
      step: 512,
      limitText: "limited",
    };
    expect(rangeErrorMessage("below-min", context)).toBe("Must be at least 1 GiB");
    expect(rangeErrorMessage("above-max", context)).toBe("Must be at most 4 GiB");
    expect(rangeErrorMessage("off-step", context)).toBe("Must be a multiple of 0.5 GiB");
    expect(rangeErrorMessage("above-limit", context)).toBe("limited");
    expect(rangeErrorMessage("not-a-number", context)).toBe("Enter a number");
  });
});

describe("rangeFieldEnglishLabels", () => {
  it("falls back to a plain default state without a source", () => {
    expect(rangeFieldEnglishLabels.defaultState(undefined)).toBe("Default");
  });

  it("explains an adjusted value without doubling punctuation", () => {
    expect(rangeFieldEnglishLabels.adjusted("32 GiB", "Must be at most 32 GiB")).toBe(
      "Must be at most 32 GiB. Set to 32 GiB.",
    );
    expect(rangeFieldEnglishLabels.adjusted("16 GiB", "Pool gold is capped at 16 GiB.")).toBe(
      "Pool gold is capped at 16 GiB. Set to 16 GiB.",
    );
  });
});

describe("labelMidStop", () => {
  it("labels every stop on short scales", () => {
    expect([1, 2, 3, 4].map((index) => labelMidStop(index, 6))).toEqual([true, true, true, true]);
  });
  it("labels every other stop on long scales, never the one next to an end", () => {
    // 512 MiB … 64 GiB: 8 ticks, ends at 0 and 7.
    expect([1, 2, 3, 4, 5, 6].map((index) => labelMidStop(index, 8))).toEqual([
      false,
      true,
      false,
      true,
      false,
      false,
    ]);
  });
});

describe("stepFromBetween", () => {
  it("moves from between two stops to the neighbour in the key's direction", () => {
    // 12 GiB between 8 GiB (position 4) and 16 GiB (position 5).
    expect(stepFromBetween(4.5, 0, 1, "ArrowRight")).toBe(5);
    expect(stepFromBetween(4.5, 0, 1, "ArrowUp")).toBe(5);
    expect(stepFromBetween(4.5, 0, 1, "ArrowLeft")).toBe(4);
    expect(stepFromBetween(4.5, 0, 1, "PageDown")).toBe(4);
  });

  it("leaves a thumb on a stop, and other keys, to Base UI", () => {
    expect(stepFromBetween(4, 0, 1, "ArrowRight")).toBeNull();
    expect(stepFromBetween(4.5, 0, 1, "Home")).toBeNull();
    expect(stepFromBetween(4.5, 0, 1, "Tab")).toBeNull();
  });
});
