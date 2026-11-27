import enSettings from "@knowledge-base/locales/src/en-US/settings.json";
import esSettings from "@knowledge-base/locales/src/es-MX/settings.json";
import { Toaster, toast } from "@knowledge-base/ui/components/sileo";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const refs = vi.hoisted(() => ({ current: null as null | { current: unknown } }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const originalRef = actual.useRef;
  return { ...actual, useRef: (initial: unknown) => refs.current ?? originalRef(initial) };
});

/**
 * The text a screen reader derives for each toast button: its content minus
 * subtrees hidden with aria-hidden, plus any SVG <title> left in the markup.
 */
function toastNames(markup: string) {
  const buttons = markup.match(/<button[^>]*data-sileo-toast[^>]*>[\s\S]*?<\/button>/g) ?? [];
  return buttons.map((button) => {
    let visible = button;
    // Drop aria-hidden SVGs (decorative; never part of the accessible name).
    visible = visible.replace(/<svg[^>]*aria-hidden="true"[^>]*>[\s\S]*?<\/svg>/g, "");
    return visible
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  });
}

describe("Toaster accessible names", () => {
  it("has no English library labels: every decorative SVG is hidden and untitled", () => {
    toast.success(enSettings.credentials.revokeSuccess);
    toast.error(enSettings.credentials.revokeError);
    toast.info(enSettings.credentials.revokeSuccess);
    toast.warning(enSettings.credentials.revokeSuccess);
    toast.message(enSettings.credentials.revokeSuccess);
    const markup = renderToStaticMarkup(<Toaster />);
    expect(markup).toContain("data-sileo-toast");
    expect(markup).not.toContain("<title");
    expect(markup).not.toMatch(/sileo notification/i);
    for (const svg of markup.match(/<svg[^>]*>/g) ?? []) {
      expect(svg).toContain('aria-hidden="true"');
    }
    toast.clear();
  });

  it("names a toast by its localized message alone in every shipped locale", () => {
    for (const settings of [enSettings, esSettings]) {
      const message = settings.credentials.revokeSuccess;
      toast.clear();
      toast.success(message);
      const names = toastNames(renderToStaticMarkup(<Toaster />));
      expect(names.at(-1)).toBe(message);
    }
    expect(esSettings.credentials.revokeSuccess).not.toBe(enSettings.credentials.revokeSuccess);
    toast.clear();
  });
});

describe("keyboard focus on toasts", () => {
  it("sends mouse events on entering and leaving, but not between descendants or while hovered", () => {
    const previous = globalThis.MouseEvent;
    class FakeMouseEvent {
      constructor(
        public type: string,
        public options: { bubbles: boolean },
      ) {}
    }
    globalThis.MouseEvent = FakeMouseEvent as unknown as typeof MouseEvent;
    const sent: string[] = [];
    const focused = {};
    const toastA = {
      contains: (target: unknown) => target === focused,
      dispatchEvent: (event: FakeMouseEvent) => sent.push(event.type),
    };
    const toastB = { contains: () => false };
    let hovered = false;
    const container = {
      contains: (target: unknown) => target === focused,
      querySelector: () => (hovered ? toastB : null),
    };
    refs.current = { current: container };
    vi.stubGlobal("document", { activeElement: focused });
    try {
      const wrapper = Toaster({});
      const eventA = { target: { closest: () => toastA }, relatedTarget: null };
      wrapper.props.onFocusCapture(eventA);
      const stopPropagation = vi.fn();
      wrapper.props.onMouseOutCapture({
        target: { closest: () => toastB },
        relatedTarget: null,
        isTrusted: true,
        stopPropagation,
      });
      expect(stopPropagation).toHaveBeenCalledOnce();
      wrapper.props.onBlurCapture({ ...eventA, relatedTarget: focused });
      hovered = true;
      wrapper.props.onBlurCapture(eventA);
      hovered = false;
      wrapper.props.onBlurCapture(eventA);
      expect(sent).toEqual(["mouseover", "mouseout"]);
    } finally {
      refs.current = null;
      globalThis.MouseEvent = previous;
      vi.unstubAllGlobals();
    }
  });
});

describe("action toasts avoid nested interactive elements", () => {
  it("renders toast action inside description as a span instead of a nested anchor", () => {
    const onUndo = vi.fn();
    toast.success("Archived", { action: { label: "Undo", onClick: onUndo } });
    const markup = renderToStaticMarkup(<Toaster />);
    expect(markup).toContain("data-toast-action-id=");
    expect(markup).toContain("data-sileo-button");
    expect(markup).not.toMatch(/<a\b[^>]*data-sileo-button/);
    expect(markup).not.toContain("<a ");
    const buttons = markup.match(/<button[^>]*data-sileo-toast[^>]*>[\s\S]*?<\/button>/g) ?? [];
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      expect(button.slice(button.indexOf(">") + 1, -"</button>".length)).not.toMatch(
        /<(a|button)\b/,
      );
    }
    toast.clear();
  });

  it("exposes an onClick handler on Toaster wrapper", () => {
    const onUndo = vi.fn();
    vi.stubGlobal("window", {
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
      addEventListener() {},
      removeEventListener() {},
    });
    refs.current = { current: null };
    try {
      toast.success("Archived", { action: { label: "Undo", onClick: onUndo } });
      const markup = renderToStaticMarkup(<Toaster />);
      const match = markup.match(/data-toast-action-id="([^"]+)"/);
      expect(match).toBeTruthy();
      const wrapper = Toaster({});
      const stopPropagation = vi.fn();
      const preventDefault = vi.fn();
      const toastEl = {
        getAttribute: () => null,
        querySelector: () => ({ getAttribute: () => match![1] }),
      };
      wrapper.props.onClick({
        target: { closest: () => toastEl },
        preventDefault,
        stopPropagation,
      });
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(stopPropagation).toHaveBeenCalledOnce();
      expect(onUndo).toHaveBeenCalledOnce();
    } finally {
      refs.current = null;
      vi.unstubAllGlobals();
      toast.clear();
    }
  });
});
