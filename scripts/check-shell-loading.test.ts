import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  fits,
  footerPushedBelow,
  INIT_SCRIPT,
  judgeShellLoading,
  type LoadedFrame,
  READ,
  type ShellFrame,
  type ShellRecording,
  type Shift,
  type ShiftSource,
  shiftScore,
} from "./check-shell-loading.ts";

const shell: ShellFrame = {
  t: 0,
  painted: true,
  header: [0, 0, 390, 61],
  bottomNav: [0, 788, 390, 56],
  main: [0, 61, 390, 727],
  dark: true,
  skeleton: true,
  loading: true,
};
/** The app shell's loaded page: no public footer. */
const loaded: LoadedFrame = {
  ...shell,
  t: 3000,
  skeleton: false,
  loading: false,
  footer: null,
  vh: 844,
  contentEnd: 400,
};

function recording(frames: ShellFrame[], shifts: Shift[] = []): ShellRecording {
  return { frames, final: loaded, shifts };
}

describe("judgeShellLoading", () => {
  it("passes a load that paints the shell first and never moves it", () => {
    const frames = [
      { ...shell, painted: false, header: null, bottomNav: null, main: null, skeleton: false },
      { ...shell, t: 500 },
      { ...shell, t: 1500 },
      loaded,
    ];
    assert.deepEqual(judgeShellLoading("projects 390×844", recording(frames), true), []);
  });

  it("fails a first paint without the shell (the shell-less skeleton)", () => {
    const bare = { ...shell, header: null, bottomNav: null, main: null, skeleton: false };
    const bad = judgeShellLoading("p", recording([bare, loaded]), true);
    for (const message of [
      "the first painted frame has no header",
      "the first painted frame has no <main>",
      "the first painted frame has no bottom nav",
      "the first painted frame is not the content skeleton",
      "the header is missing 0ms into the load",
    ])
      assert.ok(
        bad.some((line) => line.includes(message)),
        message,
      );
  });

  it("fails when the header, the bottom nav or the content area move", () => {
    const shifted = {
      ...shell,
      header: [0, 0, 390, 57] as ShellFrame["header"],
      bottomNav: [0, 790, 390, 56] as ShellFrame["bottomNav"],
      main: [0, 57, 390, 731] as ShellFrame["main"],
    };
    const bad = judgeShellLoading("p", recording([shifted, loaded]), true);
    assert.ok(bad.some((line) => /the header moves/.test(line)));
    assert.ok(bad.some((line) => /the bottom nav moves/.test(line)));
    assert.ok(
      bad.some((line) => /content area starts at 57px while loading, 61px loaded/.test(line)),
    );
  });

  it("fails a later frame that loses <main> or the bottom nav", () => {
    const bad = judgeShellLoading(
      "p",
      recording([shell, { ...shell, t: 900, main: null, bottomNav: null }, loaded]),
      true,
    );
    assert.ok(bad.some((line) => line.includes("<main> is missing 900ms into the load")));
  });

  it("tolerates a 1px rounding difference", () => {
    const nudged = { ...shell, header: [0, 0, 390, 62] as ShellFrame["header"] };
    assert.deepEqual(judgeShellLoading("p", recording([nudged, loaded]), true), []);
  });

  it("fails a frame in the other theme and a layout shift above 0.05", () => {
    const light = { ...shell, dark: false };
    const bad = judgeShellLoading(
      "p",
      recording([light, loaded], [{ v: 0.2, below: false }]),
      true,
    );
    assert.ok(bad.some((line) => /is light, the stored theme is dark/.test(line)));
    assert.ok(bad.some((line) => /cumulative layout shift 0.200 exceeds 0.05/.test(line)));
  });

  it("refuses to judge a page that never finished loading", () => {
    for (const final of [
      { ...loaded, skeleton: true },
      { ...loaded, loading: true },
    ])
      assert.deepEqual(judgeShellLoading("p", { frames: [shell], final, shifts: [] }, true), [
        "p: the page never finished loading (a skeleton is still on screen)",
      ]);
  });

  it("fails when the loaded page falls back to the route skeleton", () => {
    const bad = judgeShellLoading(
      "p",
      recording([shell, { ...loaded, t: 2000 }, { ...shell, t: 2500 }, loaded]),
      true,
    );
    assert.deepEqual(bad, [
      "p: the page had loaded, then went back to the route skeleton 2500ms into the load (something in the shell suspended)",
    ]);
  });

  it("refuses a loaded page without its header or <main>", () => {
    assert.deepEqual(
      judgeShellLoading(
        "p",
        { frames: [shell], final: { ...loaded, main: null }, shifts: [] },
        true,
      ),
      ["p: the loaded page has no <main>"],
    );
    assert.deepEqual(
      judgeShellLoading(
        "p",
        { frames: [shell], final: { ...loaded, header: null }, shifts: [] },
        true,
      ),
      ["p: the loaded page has no header"],
    );
  });

  it("fails when nothing painted", () => {
    assert.deepEqual(judgeShellLoading("p", recording([]), true), [
      "p: no painted frame was recorded",
    ]);
  });
});

describe("probe privacy", () => {
  it("records structure only, never page text (a page can show private documents)", () => {
    for (const reader of ["innerText", "textContent", "innerHTML", "outerHTML"])
      assert.equal(INIT_SCRIPT.includes(reader), false, reader);
  });
});

// The long-page footer rule, mirroring tunnel's reload-shell check
// (crates/web/checks/reload-shell.test.mjs), on a page with the public footer.
describe("the long-page footer rule", () => {
  const page = (over: Partial<LoadedFrame> = {}): LoadedFrame => ({
    ...loaded,
    bottomNav: null,
    vh: 800,
    footer: [0, 750, 1280, 50],
    contentEnd: 400,
    ...over,
  });
  const record = (final: LoadedFrame, shifts: Shift[]): ShellRecording => ({
    frames: [{ ...shell, bottomNav: null }, final],
    final,
    shifts,
  });
  // A long list pushing the footer out of the first screen (e2e5-tun follow-up 01).
  const footerLeaves: Shift = { v: 0.063, below: true };
  const long = page({ footer: [0, 2173, 1280, 50], contentEnd: 2173 });
  const short = page();
  const none = { top: 0, width: 0, height: 0 };

  it("counts as below the fold only the footer pushed below the first screen", () => {
    const footer = (top: number | null, rect = none): ShiftSource => ({ footer: true, top, rect });
    assert.equal(footerPushedBelow([footer(2173)], 800), true);
    assert.equal(footerPushedBelow([footer(800)], 800), true);
    // Gone up, not down: the clipped rect is empty either way; its live position tells.
    assert.equal(footerPushedBelow([footer(-60)], 800), false);
    // Still (partly) on screen.
    assert.equal(
      footerPushedBelow([footer(780, { top: 780, width: 1280, height: 20 })], 800),
      false,
    );
    // No longer in the page: the direction is unknown, so it counts.
    assert.equal(footerPushedBelow([footer(null)], 800), false);
    // Any other moved box makes the whole entry count.
    assert.equal(
      footerPushedBelow([footer(2173), { footer: false, top: 900, rect: none }], 800),
      false,
    );
    assert.equal(footerPushedBelow([], 800), false);
  });

  it("does not count the footer leaving the first screen of a long page", () => {
    assert.deepEqual(shiftScore([footerLeaves], long), { cls: 0, belowFold: 0.063, all: 0.063 });
    assert.deepEqual(judgeShellLoading("p", record(long, [footerLeaves]), true), []);
  });

  it("counts every shift on a page that fits the viewport", () => {
    assert.deepEqual(shiftScore([footerLeaves], short), { cls: 0.063, belowFold: 0, all: 0.063 });
    assert.match(
      judgeShellLoading("p", record(short, [footerLeaves]), true).join("\n"),
      /cumulative layout shift 0.063 exceeds/,
    );
  });

  it("counts shifts in the first screen on a long page too", () => {
    const seen: Shift = { v: 0.04, below: false };
    assert.deepEqual(shiftScore([seen, footerLeaves, seen], long), {
      cls: 0.08,
      belowFold: 0.063,
      all: 0.143,
    });
    assert.equal(judgeShellLoading("p", record(long, [seen, footerLeaves, seen]), true).length, 1);
  });

  it("wants the footer in the viewport when the content fits", () => {
    assert.equal(fits(short), true);
    assert.equal(fits(page({ contentEnd: 760 })), false);
    assert.deepEqual(judgeShellLoading("p", record(short, []), true), []);
    // Held taller than its content (a min-height left on): still fitting, so a
    // footer below the fold fails, and shifts pushing it there count.
    const held = page({ footer: [0, 852, 1280, 50] });
    assert.match(
      judgeShellLoading("p", record(held, []), true).join("\n"),
      /the content fits the viewport, but the footer \(0,852 1280×50\) is not in it/,
    );
    assert.equal(shiftScore([footerLeaves], held).cls, 0.063);
    // Above the viewport is not in it either.
    assert.match(
      judgeShellLoading("p", record(page({ footer: [0, -60, 1280, 50] }), []), true).join("\n"),
      /footer/,
    );
    // A long page may end below the fold.
    assert.deepEqual(judgeShellLoading("p", record(long, []), true), []);
  });

  it("does not ask the app shell, which has no public footer, for one", () => {
    assert.deepEqual(judgeShellLoading("p", record(page({ footer: null }), []), true), []);
  });
});

/** Just enough DOM for INIT_SCRIPT and READ: boxes, attributes, simple selectors. */
interface FakeElement {
  tagName: string;
  id: string;
  attrs: Record<string, string>;
  children: FakeElement[];
  parentElement: FakeElement | null;
  rect: { left: number; top: number; width: number; height: number };
  paddingBottom: string;
  nodeType: 1;
  isConnected: boolean;
}

function fakeDom(viewport: number) {
  const el = (
    tag: string,
    rect: [number, number, number, number],
    attrs: Record<string, string> = {},
    children: FakeElement[] = [],
    paddingBottom = "0px",
  ): FakeElement => {
    const node: FakeElement = {
      tagName: tag.toUpperCase(),
      id: attrs.id ?? "",
      attrs,
      children,
      parentElement: null,
      rect: { left: rect[0], top: rect[1], width: rect[2], height: rect[3] },
      paddingBottom,
      nodeType: 1,
      isConnected: true,
    };
    for (const child of children) child.parentElement = node;
    return node;
  };
  const matchOne = (node: FakeElement, selector: string): boolean => {
    if (selector === "*") return true;
    if (selector.startsWith("#")) return node.id === selector.slice(1);
    const attr = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(selector);
    if (attr?.[1])
      return attr[1] in node.attrs && (attr[2] === undefined || node.attrs[attr[1]] === attr[2]);
    return node.tagName === selector.toUpperCase();
  };
  const descendants = (node: FakeElement): FakeElement[] =>
    node.children.flatMap((child) => [child, ...descendants(child)]);
  const matches = (node: FakeElement, selector: string): boolean => {
    const parts = selector.split(" ");
    const last = parts.pop() ?? "";
    if (!matchOne(node, last)) return false;
    if (!parts.length) return true;
    for (let up = node.parentElement; up; up = up.parentElement)
      if (matches(up, parts.join(" "))) return true;
    return false;
  };
  // A long page: rows down to 2000px, 24px of page padding, then the footer.
  const footerText = el("p", [16, 2116, 200, 20]);
  const footer = el("footer", [0, 2100, 1280, 50], { "data-public-footer": "" }, [footerText]);
  const row = el("div", [16, 1960, 1248, 40]);
  const page = el("div", [0, 60, 1280, 1964], {}, [el("h1", [16, 80, 400, 32]), row], "24px");
  const main = el("main", [0, 60, 1280, 740], { id: "main-content" }, [
    el("div", [0, 60, 1280, 2090], {}, [page, footer]),
  ]);
  const header = el("header", [0, 0, 1280, 60], { "data-app-header": "" });
  const body = el("body", [0, 0, 1280, viewport], {}, [header, main]);
  const all = () => descendants(body);
  const api = (node: FakeElement) =>
    Object.assign(node, {
      getBoundingClientRect: () => ({ ...node.rect, bottom: node.rect.top + node.rect.height }),
      querySelectorAll: (selector: string) => descendants(node).filter((n) => matches(n, selector)),
      closest: (selector: string) => {
        for (let up: FakeElement | null = node; up; up = up.parentElement)
          if (matches(up, selector)) return up;
        return null;
      },
      matches: (selector: string) => matches(node, selector),
    });
  for (const node of [body, ...all()]) api(node);
  const document = {
    body,
    documentElement: { classList: { contains: (name: string) => name === "dark" } },
    querySelectorAll: (selector: string) => all().filter((n) => matches(n, selector)),
  };
  return { document, footer, row };
}

describe("INIT_SCRIPT in the page", () => {
  it("parses, records shifts and measures the loaded page", () => {
    const { document, footer, row } = fakeDom(800);
    const window: Record<string, unknown> = { innerHeight: 800 };
    window.top = window;
    let observe: ((list: { getEntries(): unknown[] }) => void) | undefined;
    class PerformanceObserver {
      constructor(callback: (list: { getEntries(): unknown[] }) => void) {
        observe = callback;
      }
      observe() {}
    }
    const getComputedStyle = (node: FakeElement) => ({
      visibility: "visible",
      paddingBottom: node.paddingBottom,
    });
    const globals = {
      window,
      document,
      getComputedStyle,
      PerformanceObserver,
      performance: { now: () => 0 },
      requestAnimationFrame: () => 0,
    };
    // The page runs INIT_SCRIPT as plain JavaScript: the embedded
    // footerPushedBelow must have come out of the type stripping as JS.
    new Function(...Object.keys(globals), INIT_SCRIPT)(...Object.values(globals));
    assert.ok(observe, "the layout-shift observer was registered");
    const none = { top: 0, left: 0, width: 0, height: 0 };
    observe({
      getEntries: () => [
        {
          value: 0.063,
          hadRecentInput: false,
          // The footer and a box inside it: both are the footer.
          sources: [
            { node: footer, currentRect: none },
            { node: footer.children[0], currentRect: none },
          ],
        },
        { value: 0.02, hadRecentInput: false, sources: [{ node: row, currentRect: none }] },
        { value: 0.5, hadRecentInput: true, sources: [] },
      ],
    });
    const read = new Function(...Object.keys(globals), `return ${READ}`)(
      ...Object.values(globals),
    ) as string;
    const recording = JSON.parse(read) as ShellRecording;
    assert.deepEqual(recording.shifts, [
      { v: 0.063, below: true },
      { v: 0.02, below: false },
    ]);
    assert.deepEqual(recording.final.footer, [0, 2100, 1280, 50]);
    assert.equal(recording.final.vh, 800);
    // The lowest row (2000px) plus the page's 24px padding; the footer's own text does not count.
    assert.equal(recording.final.contentEnd, 2024);
    assert.deepEqual(recording.final.header, [0, 0, 1280, 60]);
    assert.deepEqual(shiftScore(recording.shifts, recording.final), {
      cls: 0.02,
      belowFold: 0.063,
      all: 0.083,
    });
  });
});
