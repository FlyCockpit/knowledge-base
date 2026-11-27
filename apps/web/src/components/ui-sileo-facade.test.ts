import { beforeEach, describe, expect, it, vi } from "vitest";

const backend = vi.hoisted(() => ({
  show: vi.fn((options: { id?: string }) => options.id ?? "sileo-default"),
  success: vi.fn((options: { id?: string }) => options.id ?? "sileo-default"),
  error: vi.fn((options: { id?: string }) => options.id ?? "sileo-default"),
  info: vi.fn((options: { id?: string }) => options.id ?? "sileo-default"),
  warning: vi.fn((options: { id?: string }) => options.id ?? "sileo-default"),
  dismiss: vi.fn(),
  clear: vi.fn(),
}));

vi.mock("sileo", () => ({ sileo: backend, Toaster: () => null }));
vi.mock("sileo/styles.css", () => ({}));

const { pillTitleBudget, titleOverflowsPill, toast } = await import(
  "@knowledge-base/ui/components/sileo"
);

describe("toast facade", () => {
  beforeEach(() => {
    for (const fn of Object.values(backend)) fn.mockClear();
  });

  it("gives every toast its own id so two toasts stack instead of merging", () => {
    // sileo defaults every toast to id "sileo-default" and replaces in place.
    const first = toast.error("That wasn't found.");
    const second = toast.error("That wasn't found.");

    expect(first).not.toBe(second);
    expect(backend.error.mock.calls.map(([options]) => options.id)).toEqual([first, second]);
  });

  it("repeats a long message in the description so the clipped pill loses nothing", () => {
    const long = "That code didn't work. Check your authenticator and try again.";

    toast.error(long);
    toast.success("Saved", { duration: 5000 });

    expect(backend.error).toHaveBeenCalledWith(
      expect.objectContaining({ title: long, description: long }),
    );
    expect(backend.success).toHaveBeenCalledWith({
      id: expect.any(String),
      title: "Saved",
      duration: 5000,
    });
  });

  it("keeps action toasts expanded without changing plain toast autopilot", () => {
    const onClick = vi.fn();
    toast.success("Deleted", { action: { label: "Undo", onClick } });
    expect(backend.success).toHaveBeenCalledWith(
      expect.objectContaining({
        autopilot: { expand: 0, collapse: 0 },
        button: { title: "Undo", onClick },
      }),
    );
    toast.success("Saved");
    expect(backend.success.mock.calls[1]?.[0]).not.toHaveProperty("autopilot");
  });

  it("decides by the measured width, not the character count", () => {
    // ~8px per glyph at a 16px root: 36 characters fit, 30 wide glyphs don't.
    const at16 = (perChar: number) => (m: string) => ({
      width: m.length * perChar,
      budget: pillTitleBudget(16),
    });
    expect(pillTitleBudget(16)).toBe(292);
    expect(titleOverflowsPill("a".repeat(36), at16(6.5))).toBe(false);
    expect(titleOverflowsPill("W".repeat(30), at16(11))).toBe(true);
    // A larger root font (browser text size) grows the title, not the pill.
    const at24 = (m: string) => ({ width: m.length * 6.5 * 1.5, budget: pillTitleBudget(24) });
    expect(titleOverflowsPill("We've emailed you a verification code", at24)).toBe(true);
  });

  it("falls back to a length rule when nothing can be measured", () => {
    expect(titleOverflowsPill("Saved", () => null)).toBe(false);
    expect(titleOverflowsPill("x".repeat(41), () => null)).toBe(true);
  });
});
