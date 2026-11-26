/**
 * Workspace keyboard shortcuts: one table that both the key handler and the
 * `?` sheet read, so what is listed is exactly what works.
 *
 * Browsers keep some keys for themselves (Ctrl+W, Ctrl+Tab and Ctrl+P in
 * most tabs; an installed app gets more of them), so every tab command also
 * has an Alt alternate that always reaches the page.
 */

export type WorkspaceCommand =
  | "save"
  | "closeTab"
  | "nextTab"
  | "prevTab"
  | "quickOpen"
  | "toggleEdit"
  | "shortcuts"
  | "rename"
  | "toggleTree"
  | "search";

type KeyInput = Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">;

export type ShortcutContext = {
  mac: boolean;
  /** Focus is in a text field, textarea or contenteditable: plain letters are typing. */
  typing: boolean;
};

/** The command a key press means in the workspace, or null to leave it alone. */
export function commandForKey(e: KeyInput, ctx: ShortcutContext): WorkspaceCommand | null {
  // The platform's command modifier: ⌘ on Apple, Ctrl elsewhere.
  const mod = ctx.mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  // Shift+[ reports "{" on most layouts; the physical key code is stable.
  const bracket =
    e.code === "BracketLeft" || key === "[" || key === "{"
      ? "["
      : e.code === "BracketRight" || key === "]" || key === "}"
        ? "]"
        : null;

  if (mod && !e.altKey) {
    if (!e.shiftKey && key === "s") return "save";
    if (!e.shiftKey && key === "w") return "closeTab";
    if (!e.shiftKey && key === "p") return "quickOpen";
    if (!e.shiftKey && key === "b" && !ctx.typing) return "toggleTree";
    if (e.shiftKey && bracket === "]") return "nextTab";
    if (e.shiftKey && bracket === "[") return "prevTab";
  }
  // Ctrl+Tab on every platform (as browsers and editors do).
  if (e.ctrlKey && !e.metaKey && !e.altKey && key === "Tab") {
    return e.shiftKey ? "prevTab" : "nextTab";
  }
  // Alt alternates that browsers never reserve.
  if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
    if (e.code === "KeyW" || key === "w") return "closeTab";
    if (bracket === "]") return "nextTab";
    if (bracket === "[") return "prevTab";
  }
  if (e.metaKey || e.ctrlKey || e.altKey || ctx.typing) return null;
  if (key === "F2") return "rename";
  if (e.shiftKey) return key === "?" ? "shortcuts" : null;
  if (key === "e") return "toggleEdit";
  if (key === "?") return "shortcuts";
  if (key === "/") return "search";
  return null;
}

/** Whether the focused element takes text, so single-letter shortcuts stay out of its way. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== "function") return false;
  const element = target as HTMLElement;
  if (element.isContentEditable) return true;
  const tag = element.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (element as HTMLInputElement).type;
    return !["button", "checkbox", "radio", "submit", "reset", "range", "color", "file"].includes(
      type,
    );
  }
  return false;
}

export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform ?? nav.platform ?? nav.userAgent;
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/** Listed in the `?` sheet, in this order. Each entry's key lists are alternatives. */
export const SHORTCUTS: {
  command: WorkspaceCommand;
  keys: { mac: string[]; other: string[] };
}[] = [
  { command: "save", keys: { mac: ["⌘ S"], other: ["Ctrl S"] } },
  { command: "quickOpen", keys: { mac: ["⌘ P"], other: ["Ctrl P"] } },
  { command: "closeTab", keys: { mac: ["⌘ W", "⌥ W"], other: ["Ctrl W", "Alt W"] } },
  {
    command: "nextTab",
    keys: { mac: ["⌃ Tab", "⌘ ⇧ ]", "⌥ ]"], other: ["Ctrl Tab", "Ctrl Shift ]", "Alt ]"] },
  },
  {
    command: "prevTab",
    keys: {
      mac: ["⌃ ⇧ Tab", "⌘ ⇧ [", "⌥ ["],
      other: ["Ctrl Shift Tab", "Ctrl Shift [", "Alt ["],
    },
  },
  { command: "toggleEdit", keys: { mac: ["E"], other: ["E"] } },
  { command: "toggleTree", keys: { mac: ["⌘ B"], other: ["Ctrl B"] } },
  { command: "search", keys: { mac: ["/"], other: ["/"] } },
  { command: "rename", keys: { mac: ["F2"], other: ["F2"] } },
  { command: "shortcuts", keys: { mac: ["?"], other: ["?"] } },
];
