import { describe, expect, it } from "vitest";

import { commandForKey, isTypingTarget, SHORTCUTS } from "./shortcuts";

const press = (
  key: string,
  mods: Partial<Record<"meta" | "ctrl" | "alt" | "shift", boolean>> = {},
  code = "",
) => ({
  key,
  code,
  metaKey: Boolean(mods.meta),
  ctrlKey: Boolean(mods.ctrl),
  altKey: Boolean(mods.alt),
  shiftKey: Boolean(mods.shift),
});
const mac = { mac: true, typing: false };
const pc = { mac: false, typing: false };

describe("workspace shortcuts", () => {
  it("uses ⌘ on Apple and Ctrl elsewhere", () => {
    expect(commandForKey(press("s", { meta: true }), mac)).toBe("save");
    expect(commandForKey(press("s", { ctrl: true }), mac)).toBeNull();
    expect(commandForKey(press("s", { ctrl: true }), pc)).toBe("save");
    expect(commandForKey(press("S", { ctrl: true }), pc)).toBe("save");
    expect(commandForKey(press("s", { meta: true }), pc)).toBeNull();
    expect(commandForKey(press("w", { meta: true }), mac)).toBe("closeTab");
    expect(commandForKey(press("p", { ctrl: true }), pc)).toBe("quickOpen");
  });

  it("saves and quick-opens while typing, but leaves plain letters alone", () => {
    const typing = { mac: false, typing: true };
    expect(commandForKey(press("s", { ctrl: true }), typing)).toBe("save");
    expect(commandForKey(press("p", { ctrl: true }), typing)).toBe("quickOpen");
    expect(commandForKey(press("e"), typing)).toBeNull();
    expect(commandForKey(press("?", { shift: true }), typing)).toBeNull();
    expect(commandForKey(press("/"), typing)).toBeNull();
    expect(commandForKey(press("b", { ctrl: true }), typing)).toBeNull();
    expect(commandForKey(press("e"), pc)).toBe("toggleEdit");
    expect(commandForKey(press("E", { shift: true }), pc)).toBeNull();
    expect(commandForKey(press("?", { shift: true }), pc)).toBe("shortcuts");
    expect(commandForKey(press("/"), pc)).toBe("search");
    expect(commandForKey(press("F2"), pc)).toBe("rename");
  });

  it("switches tabs with Ctrl+Tab, ⌘⇧[ ] and the Alt alternates", () => {
    expect(commandForKey(press("Tab", { ctrl: true }), mac)).toBe("nextTab");
    expect(commandForKey(press("Tab", { ctrl: true, shift: true }), pc)).toBe("prevTab");
    expect(commandForKey(press("}", { meta: true, shift: true }, "BracketRight"), mac)).toBe(
      "nextTab",
    );
    expect(commandForKey(press("{", { ctrl: true, shift: true }, "BracketLeft"), pc)).toBe(
      "prevTab",
    );
    expect(commandForKey(press("‘", { alt: true }, "BracketRight"), mac)).toBe("nextTab");
    expect(commandForKey(press("[", { alt: true }, "BracketLeft"), pc)).toBe("prevTab");
    expect(commandForKey(press("∑", { alt: true }, "KeyW"), mac)).toBe("closeTab");
    expect(commandForKey(press("Tab"), pc)).toBeNull();
  });

  it("lists every command once, with keys for both platforms", () => {
    const commands = SHORTCUTS.map((s) => s.command);
    expect(new Set(commands).size).toBe(commands.length);
    for (const entry of SHORTCUTS) {
      expect(entry.keys.mac.length).toBeGreaterThan(0);
      expect(entry.keys.other.length).toBeGreaterThan(0);
    }
  });

  it("recognises text fields as typing targets", () => {
    const el = (tagName: string, extra: Record<string, unknown> = {}) =>
      ({
        tagName,
        closest: () => null,
        isContentEditable: false,
        ...extra,
      }) as unknown as EventTarget;
    expect(isTypingTarget(el("TEXTAREA"))).toBe(true);
    expect(isTypingTarget(el("INPUT", { type: "text" }))).toBe(true);
    expect(isTypingTarget(el("INPUT", { type: "checkbox" }))).toBe(false);
    expect(isTypingTarget(el("DIV", { isContentEditable: true }))).toBe(true);
    expect(isTypingTarget(el("BUTTON"))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
