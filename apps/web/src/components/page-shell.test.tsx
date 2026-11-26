import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SectionTabs } from "@/components/page-shell";

describe("SectionTabs", () => {
  it("fades the scrolling strip's edges without fading its divider", () => {
    const html = renderToStaticMarkup(
      <SectionTabs
        ariaLabel="Sections"
        tabs={["Documents", "Pull requests", "Settings"].map((label) => ({
          key: label,
          label,
          render: (className, _active, children) => <a className={className}>{children}</a>,
        }))}
      />,
    );
    const [wrapper = "", scroller = ""] = html.match(/<div class="[^"]*"/g) ?? [];
    // The mask sits on the scroller, which carries the overflow data attributes.
    expect(scroller).toContain("scroll-fade-x");
    expect(scroller).toContain("overflow-x-auto");
    expect(scroller).toContain("scroll-px-6");
    // The divider is on the wrapper, outside the mask.
    expect(wrapper).toContain("border-b");
    expect(wrapper).not.toContain("scroll-fade-x");
    expect(scroller).not.toContain("border-b");
  });
});
