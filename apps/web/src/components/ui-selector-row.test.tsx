import { revealFocusedItem, SelectorRow } from "@knowledge-base/ui/components/selector-row";
import type * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SelectorRow", () => {
  it("is a self-scrolling row with an edge fade and focus clearance, and no fade until measured", () => {
    const html = renderToStaticMarkup(
      <SelectorRow>
        <button type="button">One</button>
      </SelectorRow>,
    );
    expect(html).toMatch(/data-slot="selector-row"[^>]*class="[^"]*min-w-0[^"]*overflow-x-auto/);
    expect(html).toContain("scroll-fade-x");
    expect(html).toContain("scroll-px-6");
    // The fade attributes come from measuring (useScrollEdges): none on the server.
    expect(html).not.toContain("data-overflow-");
  });

  describe("revealFocusedItem", () => {
    const focus = (reduce: boolean) => {
      vi.stubGlobal("window", { matchMedia: () => ({ matches: reduce }) });
      const scrollIntoView = vi.fn();
      const row = {};
      revealFocusedItem({
        target: { scrollIntoView },
        currentTarget: row,
      } as unknown as React.FocusEvent<HTMLDivElement>);
      return scrollIntoView;
    };

    it("scrolls the focused item into view along the row", () => {
      expect(focus(false)).toHaveBeenCalledWith({
        block: "nearest",
        inline: "nearest",
        behavior: "smooth",
      });
    });

    it("jumps instead of animating under reduced motion", () => {
      expect(focus(true)).toHaveBeenCalledWith(expect.objectContaining({ behavior: "auto" }));
    });

    it("ignores focus on the row itself", () => {
      const row = { scrollIntoView: vi.fn() };
      revealFocusedItem({
        target: row,
        currentTarget: row,
      } as unknown as React.FocusEvent<HTMLDivElement>);
      expect(row.scrollIntoView).not.toHaveBeenCalled();
    });
  });
});
