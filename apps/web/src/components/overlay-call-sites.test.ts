import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A Dialog's popup is capped at the viewport and does not scroll: its inner
 * body does (`data-slot="dialog-body"`), between the sticky header and the
 * sticky action bar. A Sheet works the same way: `SheetBody` is the one
 * scroller, between `SheetHeader` and a pinned `SheetFooter`. A call site
 * that puts a scroller on the popup itself (`className="… overflow-y-auto"`)
 * scrolls the header and the actions away again. Scrolling classes for the
 * content go on `bodyClassName` / `SheetBody`; a form too long to fit becomes
 * a page or a wide sheet. docs/ui.md § Form surfaces
 */
const ROOT = join(import.meta.dirname, "..");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith(".tsx") && !entry.name.includes(".test.") ? [path] : [];
  });
}

describe("DialogContent and SheetContent call sites", () => {
  it("never make the popup itself the scroller", () => {
    const offenders: string[] = [];
    for (const file of sources(ROOT)) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/<(?:Dialog|Sheet)Content\b[^>]*?\sclassName="([^"]*)"/g)) {
        if (/\boverflow-(y-)?(auto|scroll)\b/.test(match[1] ?? ""))
          offenders.push(`${relative(ROOT, file)}: ${match[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
