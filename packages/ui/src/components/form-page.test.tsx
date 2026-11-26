import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AdvancedSection, FormActionBar, FormPage, FormSection } from "./form-page";

describe("FormPage", () => {
  const html = renderToStaticMarkup(
    <FormPage
      title="New sandbox"
      description="Pick a template and where it runs."
      back={<button type="button">Back</button>}
      actions={
        <>
          <button type="button">Cancel</button>
          <button type="submit">Create</button>
        </>
      }
      noValidate
    >
      <FormSection title="Basics">
        <input aria-label="Name" />
      </FormSection>
      <AdvancedSection title="Size" summary="2 vCPU · 4 GiB">
        <input aria-label="Memory" />
      </AdvancedSection>
    </FormPage>,
  );

  it("is one form with a page title, the sections, then the action bar", () => {
    expect(html.startsWith("<form")).toBe(true);
    expect(html).toContain('noValidate=""');
    expect(html).toMatch(/<h1[^>]*>New sandbox<\/h1>/);
    const order = ["Back", "New sandbox", "Basics", "Size", "Cancel", "Create"].map((text) =>
      html.indexOf(text),
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(html.match(/data-slot="form-action-bar"/g)).toHaveLength(1);
  });

  it("pins the title row below the layout's sticky chrome", () => {
    const header = html.match(/<header data-slot="form-page-header"[^>]*>/)?.[0] ?? "";
    expect(header).toContain("sticky");
    expect(header).toContain("top-[var(--page-sticky-top,0px)]");
  });

  it("gives sections one column on phones and two from lg", () => {
    expect(html).toMatch(/<h2[^>]*>Basics<\/h2>/);
    expect(html).toContain("grid grid-cols-1 gap-4 lg:grid-cols-2");
  });

  it("keeps advanced fields mounted but collapsed, with a summary of their values", () => {
    expect(html).toMatch(/<details data-slot="advanced-section"[^>]*>/);
    expect(html).not.toMatch(/<details[^>]* open/);
    expect(html).toContain("2 vCPU · 4 GiB");
    expect(html).toContain('aria-label="Memory"');
  });

  it("opens an advanced section on request", () => {
    const open = renderToStaticMarkup(
      <AdvancedSection title="Network" defaultOpen>
        <input />
      </AdvancedSection>,
    );
    expect(open).toMatch(/<details[^>]* open=""/);
  });
});

describe("FormActionBar", () => {
  it("sticks to the bottom of the scroller at the sticky-chrome layer", () => {
    const bar = renderToStaticMarkup(<FormActionBar>x</FormActionBar>);
    expect(bar).toContain("sticky");
    expect(bar).toContain("bottom-0");
    expect(bar).toContain("z-30");
  });
});
