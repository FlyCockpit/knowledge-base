import { afterEach, describe, expect, it, vi } from "vitest";

import {
  parseRecentKbs,
  RECENT_KBS_KEPT,
  readRecentKbs,
  readSidebarKbsOpen,
  recentKbsSnapshot,
  recordRecentKb,
  subscribeRecentKbs,
  writeSidebarKbsOpen,
} from "./recent-kbs";

describe("recent knowledge bases", () => {
  it("keeps the newest first, once each, capped, per viewer", () => {
    for (let i = 0; i < RECENT_KBS_KEPT + 3; i++) recordRecentKb("u1", `kb${i}`);
    recordRecentKb("u1", "kb5");
    const recent = readRecentKbs("u1");
    expect(recent).toHaveLength(RECENT_KBS_KEPT);
    expect(recent[0]).toBe("kb5");
    expect(new Set(recent).size).toBe(recent.length);
    expect(readRecentKbs("u2")).toEqual([]);
  });

  it("ignores malformed ids", () => {
    recordRecentKb("u3", "a");
    recordRecentKb("u3", "bad id with spaces");
    expect(readRecentKbs("u3")).toEqual(["a"]);
  });

  it("treats stored garbage as nothing", () => {
    expect(parseRecentKbs("not json")).toEqual([]);
    expect(parseRecentKbs('{"a":1}')).toEqual([]);
    expect(parseRecentKbs('["a", 3, "a", "b", "../x"]')).toEqual(["a", "b"]);
    expect(parseRecentKbs(null)).toEqual([]);
  });

  it("remembers whether the sidebar list is open, open by default", () => {
    expect(readSidebarKbsOpen("u4")).toBe(true);
    writeSidebarKbsOpen("u4", false);
    expect(readSidebarKbsOpen("u4")).toBe(false);
    expect(readSidebarKbsOpen("u5")).toBe(true);
  });

  it("tells same-tab readers at once, with a stable snapshot between changes", () => {
    let heard = 0;
    const stop = subscribeRecentKbs(() => heard++);
    const before = recentKbsSnapshot("u9");
    expect(recentKbsSnapshot("u9")).toBe(before);
    recordRecentKb("u9", "kb-a");
    expect(heard).toBe(1);
    const after = recentKbsSnapshot("u9");
    expect(after).toEqual(["kb-a"]);
    expect(recentKbsSnapshot("u9")).toBe(after);
    // Opening the newest again changes nothing and tells no one.
    recordRecentKb("u9", "kb-a");
    expect(heard).toBe(1);
    stop();
    recordRecentKb("u9", "kb-b");
    expect(heard).toBe(1);
  });

  describe("another tab", () => {
    afterEach(() => vi.unstubAllGlobals());
    it("sees another tab's write announced by the storage event", () => {
      const data = new Map<string, string>();
      const target = new EventTarget();
      vi.stubGlobal("window", {
        localStorage: {
          getItem: (k: string) => data.get(k) ?? null,
          setItem: (k: string, v: string) => void data.set(k, v),
        },
        addEventListener: target.addEventListener.bind(target),
        removeEventListener: target.removeEventListener.bind(target),
      });
      recordRecentKb("tabs", "kb-a");
      expect(recentKbsSnapshot("tabs")).toEqual(["kb-a"]);
      let heard = 0;
      const stop = subscribeRecentKbs(() => heard++);
      // The other tab opens kb-b: it writes the key, this tab hears a storage event.
      const key = [...data.keys()].find((k) => k.startsWith("kb-recent:"))!;
      data.set(key, JSON.stringify(["kb-b", "kb-a"]));
      const event = new Event("storage") as Event & { key: string };
      Object.defineProperty(event, "key", { value: key });
      target.dispatchEvent(event);
      expect(heard).toBe(1);
      expect(recentKbsSnapshot("tabs")).toEqual(["kb-b", "kb-a"]);
      // Opening another KB here keeps the other tab's history.
      recordRecentKb("tabs", "kb-c");
      expect(recentKbsSnapshot("tabs")).toEqual(["kb-c", "kb-b", "kb-a"]);
      stop();
    });
  });
});
