import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseEvalOutput } from "./browser-check-lib.ts";
import {
  judgeLayout,
  judgeReserve,
  LOADING_MARKER,
  type Probe,
  type ReserveProbe,
  SETTLED,
} from "./check-layout.ts";

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

describe("parseEvalOutput", () => {
  it("parses a JSON-encoded page result once more and keeps other values", () => {
    assert.deepEqual(parseEvalOutput(JSON.stringify(JSON.stringify({ a: 1 }))), { a: 1 });
    assert.equal(parseEvalOutput(JSON.stringify(JSON.stringify("settled"))), "settled");
    assert.equal(parseEvalOutput("true"), true);
  });

  it("rejects a bare string result, so page scripts must JSON-encode strings", () => {
    assert.throws(() => parseEvalOutput(JSON.stringify("settled")), SyntaxError);
  });
});

describe("SETTLED", () => {
  /**
   * Runs the page script against a fake visible <main> whose height follows
   * `heights`, then stays at the last. `skeleton[i]` says whether read i still
   * finds a loading marker (the last value holds after the list ends).
   */
  const settle = async (heights: number[] | null, skeleton: boolean[] = [false]) => {
    let reads = 0;
    const selectors: string[] = [];
    const main = {
      checkVisibility: () => true,
      get scrollHeight() {
        reads++;
        return heights ? (heights[Math.min(reads - 1, heights.length - 1)] ?? 0) : 0;
      },
      querySelector: (selector: string) => {
        selectors.push(selector);
        return skeleton[Math.min(reads - 1, skeleton.length - 1)] ? {} : null;
      },
    };
    // A suspended route can leave a hidden <main> before the visible one.
    const hidden = { checkVisibility: () => false, scrollHeight: 0, querySelector: () => ({}) };
    // The page script reads the globals `document` and `setTimeout`; parameters
    // stand in for them, and the timer fires at once, so the 8s limit costs no real time.
    const run = new Function("document", "setTimeout", `return ${SETTLED};`) as (
      doc: unknown,
      timer: (done: () => void) => void,
    ) => Promise<string>;
    const value = await run({ querySelectorAll: () => (heights ? [hidden, main] : []) }, (done) =>
      done(),
    );
    // Through the same adapter as a real run: agent-browser prints the value as JSON.
    const settled = parseEvalOutput(JSON.stringify(value));
    return { settled, reads, selectors };
  };

  it("waits until the content stops growing (rows arrive after the footer)", async () => {
    const { settled, reads } = await settle([681, 681, 986, 1200]);
    assert.equal(settled, "settled");
    // Three changes, then five unchanged reads in a row.
    assert.equal(reads, 9);
  });

  it("does not settle on a skeleton that holds one height before the data arrives", async () => {
    // A skeleton at 681px for 10 reads (stable for well over five), then the rows.
    const heights = [...Array(10).fill(681), 1200];
    const skeleton = [...Array(10).fill(true), false];
    const { settled, reads, selectors } = await settle(heights, skeleton);
    assert.equal(settled, "settled");
    // Ten skeleton reads count for nothing; then the loaded height, then five unchanged reads.
    assert.equal(reads, 16);
    assert.equal(selectors[0], LOADING_MARKER);
  });

  it("looks for the app's skeleton and busy markers", () => {
    assert.match(LOADING_MARKER, /\[data-slot="skeleton"\]/);
    assert.match(LOADING_MARKER, /\[aria-busy="true"\]/);
  });

  it("reports a page still loading after 8s, distinct from one that keeps changing", async () => {
    const loading = await settle([681], [true]);
    assert.equal(loading.settled, "loading");
    assert.equal(loading.reads, 80);
    const growing = Array.from({ length: 100 }, (_, i) => 500 + i * 10);
    const changing = await settle(growing);
    assert.equal(changing.settled, "changing");
    assert.equal(changing.reads, 80);
  });

  it("does not wait on a page without a scroller", async () => {
    const { settled, reads } = await settle(null);
    assert.deepEqual({ settled, reads }, { settled: "settled", reads: 0 });
  });
});
