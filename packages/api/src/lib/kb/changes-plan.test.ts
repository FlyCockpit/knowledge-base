import { describe, expect, it } from "vitest";
import { danglingAssetLinks } from "./changes-plan";

const files = (entries: Record<string, string>) =>
  new Map(Object.entries(entries).map(([path, text]) => [path, Buffer.from(text, "utf8")]));

describe("L-22 asset removal warnings", () => {
  it("lists the documents that still link to a removed asset", () => {
    expect(
      danglingAssetLinks(
        files({
          "notes/a.md": "![a](../img/a.png)",
          "b.md": "[see](img/a.png) and `img/a.png` in code",
          "c.md": "unrelated",
          ".assets/manifest.json": "{}",
        }),
        ["img/a.png", "img/unused.png"],
      ),
    ).toEqual([
      { code: "ASSET_STILL_REFERENCED", path: "img/a.png", referencedBy: ["b.md", "notes/a.md"] },
    ]);
  });
  it("is empty without removals or remaining references", () => {
    expect(danglingAssetLinks(files({ "a.md": "![a](a.png)" }), [])).toEqual([]);
    expect(danglingAssetLinks(files({ "a.md": "no links" }), ["a.png"])).toEqual([]);
  });
});
