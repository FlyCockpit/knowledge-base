import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DIALOGS, SHELL_PAGES } from "./browser-checks.config.ts";
import { type DialogProbe, judgeDialog, stepScript } from "./check-dialogs.ts";

const fits: DialogProbe = {
  vw: 1280,
  vh: 800,
  popup: { top: 200, bottom: 600, left: 440, right: 840 },
  scrollers: [],
  covered: [],
};

describe("judgeDialog", () => {
  it("passes a dialog that shows all of itself inside the viewport", () => {
    assert.deepEqual(judgeDialog("Create project 1280×800", fits), []);
  });

  it("fails a dialog whose popup or a box inside it scrolls", () => {
    const bad = judgeDialog("Create sandbox 390×844", {
      ...fits,
      scrollers: [{ name: "[data-slot=dialog-content]", scrollHeight: 1900, clientHeight: 780 }],
    });
    assert.equal(bad.length, 1);
    assert.match(
      bad[0] ?? "",
      /\[data-slot=dialog-content\] scrolls \(1900px of content in 780px\)/,
    );
    assert.match(bad[0] ?? "", /page or a wide side sheet/);
  });

  it("fails a dialog whose action bar or header sits on top of its fields", () => {
    const bad = judgeDialog("Create project 1280×800", {
      ...fits,
      covered: [{ bar: "action bar", what: "p", overlap: 9 }],
    });
    assert.deepEqual(bad, ["Create project 1280×800: the action bar covers 9px of p"]);
  });

  it("fails a dialog that reaches outside the viewport", () => {
    for (const popup of [
      { top: -4, bottom: 600, left: 440, right: 840 },
      { top: 200, bottom: 801, left: 440, right: 840 },
      { top: 200, bottom: 600, left: -1, right: 840 },
      { top: 200, bottom: 600, left: 440, right: 1281 },
    ])
      assert.match(judgeDialog("x", { ...fits, popup })[0] ?? "", /outside the 1280×800 viewport/);
  });

  it("fails when no dialog opened", () => {
    assert.deepEqual(judgeDialog("x", { ...fits, popup: null }), ["x: no dialog opened"]);
  });
});

describe("browser-checks.config", () => {
  it("names every dialog once, with a locale path and at least one opening step", () => {
    const names = DIALOGS.map((dialog) => dialog.name);
    assert.equal(new Set(names).size, names.length);
    for (const dialog of DIALOGS) {
      assert.match(dialog.path, /^\/[a-z]{2}-[A-Z]{2}\//);
      assert.ok(dialog.steps.length > 0, dialog.name);
    }
  });

  it("measures at least two signed-in pages for the shell loading check", () => {
    assert.ok(SHELL_PAGES.length >= 2);
    for (const page of SHELL_PAGES) assert.notEqual(page.role, "anonymous", page.name);
  });

  it("turns steps into page scripts that fail loudly when the target is missing", () => {
    assert.match(stepScript({ click: "#a" }), /querySelector\("#a"\)/);
    assert.match(stepScript({ clickText: "New project" }), /"New project"/);
    assert.match(stepScript({ clickText: "x" }), /throw new Error/);
  });
});
