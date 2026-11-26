import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  INIT_SCRIPT,
  judgeShellLoading,
  type ShellFrame,
  type ShellRecording,
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
const loaded: ShellFrame = { ...shell, t: 3000, skeleton: false, loading: false };

function recording(frames: ShellFrame[], cls = 0): ShellRecording {
  return { frames, final: loaded, cls };
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
    const bad = judgeShellLoading("p", recording([light, loaded], 0.2), true);
    assert.ok(bad.some((line) => /is light, the stored theme is dark/.test(line)));
    assert.ok(bad.some((line) => /cumulative layout shift 0.200 exceeds 0.05/.test(line)));
  });

  it("refuses to judge a page that never finished loading", () => {
    for (const final of [
      { ...loaded, skeleton: true },
      { ...loaded, loading: true },
    ])
      assert.deepEqual(judgeShellLoading("p", { frames: [shell], final, cls: 0 }, true), [
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
      judgeShellLoading("p", { frames: [shell], final: { ...loaded, main: null }, cls: 0 }, true),
      ["p: the loaded page has no <main>"],
    );
    assert.deepEqual(
      judgeShellLoading("p", { frames: [shell], final: { ...loaded, header: null }, cls: 0 }, true),
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
