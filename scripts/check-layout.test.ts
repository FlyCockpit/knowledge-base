import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { judgeLayout, judgeReserve, type Probe, type ReserveProbe } from "./check-layout.ts";

const good: Probe = {
  vw: 1280,
  docScroll: 0,
  header: true,
  main: { left: 0, bottom: 800, scrollable: false, scrollbar: 0 },
  footer: { bottom: 800, lastInMain: true, position: "static" },
  rules: [
    { name: "header <hr>", left: 0, right: 1280, inMain: false },
    { name: "footer border-t", left: 0, right: 1280, inMain: true },
  ],
  toast: null,
};

const toast = {
  dark: true,
  fill: "22,27,29",
  popover: "22,27,29",
  title: 16.7,
  badge: 8.5,
  button: 16.7,
};

describe("judgeLayout", () => {
  it("passes a short page whose footer ends at the scroller's bottom", () => {
    assert.deepEqual(judgeLayout("landing", good, { footer: true }), []);
    assert.deepEqual(
      judgeLayout(
        "landing",
        { ...good, footer: { bottom: 801, lastInMain: true, position: "static" } },
        { footer: true },
      ),
      [],
    );
  });

  it("reports the landing footer gap, a missing footer and a footer that is not last", () => {
    assert.match(
      judgeLayout(
        "landing",
        { ...good, footer: { bottom: 353, lastInMain: true, position: "static" } },
        { footer: true },
      ).join("\n"),
      /footer ends at 353px, the scroller at 800px \(short page\)/,
    );
    assert.match(
      judgeLayout(
        "404",
        { ...good, footer: null, header: false, main: null },
        { footer: true },
      ).join("\n"),
      /no single <main> scroller[\s\S]*no shell header[\s\S]*no public footer/,
    );
    assert.match(
      judgeLayout(
        "landing",
        { ...good, footer: { bottom: 800, lastInMain: false, position: "static" } },
        { footer: true },
      ).join("\n"),
      /not the last box/,
    );
  });

  it("reports a fixed or sticky footer, which covers the content instead of following it", () => {
    for (const position of ["fixed", "sticky", "absolute"])
      assert.match(
        judgeLayout(
          "landing",
          { ...good, footer: { bottom: 800, lastInMain: true, position } },
          { footer: true },
        ).join("\n"),
        new RegExp(`the footer is position: ${position}`),
      );
  });

  it("reports a document scroll, a reserved gutter and rules stopped short by it", () => {
    const bad = judgeLayout(
      "admin",
      {
        ...good,
        docScroll: 12,
        main: { left: 0, bottom: 800, scrollable: false, scrollbar: 15 },
        rules: [{ name: "sub-nav border-b", left: 0, right: 1265, inMain: true }],
      },
      { footer: false },
    );
    assert.equal(bad.length, 3, bad.join("\n"));
    assert.match(bad.join("\n"), /document scrolls by 12px/);
    assert.match(bad.join("\n"), /reserves a 15px scrollbar gutter on a page that does not scroll/);
    assert.match(bad.join("\n"), /sub-nav border-b spans 0…1265px, not 0…1280px/);
  });

  it("lets a rule inside a scrolling scroller meet the visible scrollbar, never one outside it", () => {
    const scrolling = { left: 0, bottom: 800, scrollable: true, scrollbar: 15 };
    assert.deepEqual(
      judgeLayout(
        "admin long",
        {
          ...good,
          main: scrolling,
          rules: [
            { name: "header <hr>", left: 0, right: 1280, inMain: false },
            { name: "sub-nav border-b", left: 0, right: 1265, inMain: true },
          ],
        },
        { footer: false },
      ),
      [],
    );
    assert.equal(
      judgeLayout(
        "admin long",
        {
          ...good,
          main: scrolling,
          rules: [{ name: "header <hr>", left: 0, right: 1265, inMain: false }],
        },
        { footer: false },
      ).length,
      1,
    );
  });

  it("measures a rule inside the scroller from the scroller's left edge (the sidebar sits left of it)", () => {
    const beside = { left: 240, bottom: 800, scrollable: false, scrollbar: 0 };
    const subNav = (left: number) => ({
      ...good,
      main: beside,
      rules: [{ name: "sub-nav border-b", left, right: 1280, inMain: true }],
    });
    assert.deepEqual(judgeLayout("admin users", subNav(240), { footer: false }), []);
    assert.match(
      judgeLayout("admin users", subNav(256), { footer: false }).join("\n"),
      /sub-nav border-b spans 256…1280px, not 240…1280px/,
    );
  });

  it("checks the toast fill against the theme's popover, its contrast and the stored theme", () => {
    assert.deepEqual(
      judgeLayout("toast dark", { ...good, toast }, { footer: false, toast: "dark" }),
      [],
    );
    const inverted = judgeLayout(
      "toast dark",
      { ...good, toast: { ...toast, fill: "242,242,242", title: 3.4, badge: 3.4, button: 3.4 } },
      { footer: false, toast: "dark" },
    );
    assert.equal(inverted.length, 4, inverted.join("\n"));
    assert.match(inverted[0] ?? "", /filled 242,242,242, not the dark theme's popover 22,27,29/);
    assert.match(
      judgeLayout("toast light", good, { footer: false, toast: "light" }).join(""),
      /no toast appeared/,
    );
    assert.match(
      judgeLayout("toast light", { ...good, toast }, { footer: false, toast: "light" }).join(""),
      /stored light theme lost to the OS/,
    );
  });
});

describe("judgeReserve", () => {
  // kb-like desktop shell: frame > row > [sidebar, main]; banner reserve 200px.
  const before = [
    { name: "<main>", bottom: 800 },
    { name: "beside <main>: aside[data-slot=sidebar]", bottom: 800 },
    { name: "div", bottom: 800 },
    { name: "div", bottom: 800 },
  ];
  const reserve: ReserveProbe = {
    vh: 800,
    inset: 200,
    before,
    after: before,
    contentEnd: 600,
    footer: null,
  };

  it("passes when only <main>'s content makes room above the banner", () => {
    assert.deepEqual(judgeReserve("home", reserve), []);
  });

  it("reports a frame or sidebar that the banner's reserve shortens (the owner's cut-off sidebar)", () => {
    const shrunk = before.map((box) => ({ ...box, bottom: box.name === "<main>" ? 800 : 600 }));
    const bad = judgeReserve("home", { ...reserve, after: shrunk });
    assert.equal(bad.length, 3);
    assert.match(bad[0] ?? "", /sidebar\] ends at 600px instead of 800px/);
  });

  it("reports content left under the banner and a frame short of the viewport", () => {
    assert.match(
      judgeReserve("landing", { ...reserve, contentEnd: 700 })[0] ?? "",
      /under a banner starting at 600px/,
    );
    const short = before.map((box) => ({ ...box, bottom: 790 }));
    assert.match(
      judgeReserve("landing", { ...reserve, before: short, after: short })[0] ?? "",
      /frame ends at 790px, not the viewport bottom \(800px\)/,
    );
    assert.deepEqual(judgeReserve("x", null), ["x: no single <main> scroller"]);
  });

  it("pins a short public page's footer to the banner's top, not anywhere above it", () => {
    assert.deepEqual(judgeReserve("landing", { ...reserve, footer: 600 }), []);
    assert.match(
      judgeReserve("landing", { ...reserve, contentEnd: 500, footer: 500 })[0] ?? "",
      /footer ends at 500px, not where the banner starts \(600px\)/,
    );
  });
});
