import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CommandDialog } from "./command";

describe("CommandDialog", () => {
  it("renders nothing into the page while closed", () => {
    // The screen-reader title lives inside the popup. Rendered beside it, the
    // sticky, padded header outranked sr-only and took 48 px of page width.
    const html = renderToStaticMarkup(
      <CommandDialog open={false} title="Go to file" description="Search the files">
        <div>panel</div>
      </CommandDialog>,
    );
    expect(html).not.toContain("Go to file");
    expect(html).not.toContain("dialog-header");
  });
});
