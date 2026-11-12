import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashTargetId, revealHashTarget, useHashTargetScroll } from "./use-hash-target-scroll";

type RenderEvent = {
  toLocation: { hash: string };
  hashChanged: boolean;
  pathChanged: boolean;
  hrefChanged?: boolean;
};
const fixture = vi.hoisted(() => ({
  resetScroll: true,
  beforeLoad: undefined as (() => void) | undefined,
  history: undefined as ((event: { action: { type: string } }) => void) | undefined,
  rendered: undefined as ((event: RenderEvent) => void) | undefined,
  cleanup: undefined as (() => void) | undefined,
  navigate: vi.fn(),
  unsubscribe: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({
    _scroll: {
      get n() {
        return fixture.resetScroll;
      },
    },
    latestLocation: {
      pathname: "/en-US/kbs/one/documents",
      searchStr: "?path=one.md",
      hash: "here",
    },
    navigate: fixture.navigate,
    history: {
      subscribe: (fn: typeof fixture.history) => {
        fixture.history = fn;
        return fixture.unsubscribe;
      },
    },
    subscribe: (name: string, fn: typeof fixture.rendered) => {
      if (name === "onBeforeLoad") fixture.beforeLoad = fn as () => void;
      else fixture.rendered = fn;
      return fixture.unsubscribe;
    },
  }),
}));
vi.mock("./use-mount-effect", () => ({
  useMountEffect: (effect: () => () => void) => {
    fixture.cleanup = effect();
  },
}));

class TestElement {
  position = "static";
  scrollIntoView = vi.fn();
  closest() {
    return this;
  }
}
class TestHtmlElement extends TestElement {
  focusable = false;
  focus = vi.fn();
  matches(selector: string) {
    return selector !== ":disabled" && this.focusable;
  }
}
class TestAnchor extends TestHtmlElement {
  target = "";
  href = "#late";
  getAttribute() {
    return this.href;
  }
  hasAttribute() {
    return false;
  }
}
class TestObserver {
  static active: TestObserver[] = [];
  constructor(readonly callback: () => void) {
    TestObserver.active.push(this);
  }
  observe = vi.fn();
  disconnect = vi.fn();
}
const targets = new Map<string, TestElement>();
let win: EventTarget & {
  location: { href: string; hash: string; origin: string };
  history: { state: unknown };
};
let doc: EventTarget;
const scroller = { scrollTop: 400 };
const replaceState = vi.fn();

beforeEach(() => {
  fixture.cleanup = undefined;
  fixture.resetScroll = true;
  vi.clearAllMocks();
  targets.clear();
  TestObserver.active = [];
  scroller.scrollTop = 400;
  win = Object.assign(new EventTarget(), {
    location: {
      href: "https://kb.test/en-US/kbs/one/documents?path=one.md",
      hash: "",
      origin: "https://kb.test",
    },
    history: { state: null as unknown },
  });
  doc = Object.assign(new EventTarget(), {
    body: {},
    getElementById: (id: string) => targets.get(id),
    querySelector: () => scroller,
  });
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("Element", TestElement);
  vi.stubGlobal("HTMLElement", TestHtmlElement);
  vi.stubGlobal("HTMLAnchorElement", TestAnchor);
  vi.stubGlobal("MutationObserver", TestObserver);
  vi.stubGlobal("History", { prototype: { replaceState } });
  vi.stubGlobal("getComputedStyle", (element: TestElement) => ({ position: element.position }));
  vi.stubGlobal("performance", { getEntriesByType: () => [{ type: "navigate" }] });
});
afterEach(() => {
  fixture.cleanup?.();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("decodes hashes and leaves malformed escapes usable", () => {
  expect(hashTargetId("#caf%C3%A9")).toBe("café");
  expect(hashTargetId("#bad%")).toBe("bad%");
  expect(hashTargetId("#")).toBeNull();
});

describe("delayed hash reveal", () => {
  it("waits for gated content and focuses reachable controls", () => {
    const cancel = revealHashTarget("late");
    const element = new TestHtmlElement();
    element.focusable = true;
    targets.set("late", element);
    TestObserver.active[0]!.callback();
    expect(element.scrollIntoView).toHaveBeenCalledOnce();
    expect(element.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(TestObserver.active[0]!.disconnect).toHaveBeenCalledOnce();
    cancel();
  });
  it.each(["wheel", "touchstart", "keydown", "pointerdown"])(
    "cancels when the user takes over with %s",
    (type) => {
      revealHashTarget("late");
      win.dispatchEvent(new Event(type));
      expect(TestObserver.active[0]!.disconnect).toHaveBeenCalledOnce();
    },
  );
  it("times out and can be cancelled without moving the page", () => {
    vi.useFakeTimers();
    const cancel = revealHashTarget("missing", 25);
    vi.advanceTimersByTime(26);
    cancel();
    expect(TestObserver.active[0]!.disconnect).toHaveBeenCalledOnce();
  });
  it("does not scroll the page to fixed chrome", () => {
    const element = new TestElement();
    element.position = "fixed";
    targets.set("fixed", element);
    revealHashTarget("fixed");
    expect(element.scrollIntoView).not.toHaveBeenCalled();
  });
});

describe("router hash history", () => {
  it("waits on PUSH while POP leaves restored scroll alone", () => {
    useHashTargetScroll();
    fixture.history?.({ action: { type: "PUSH" } });
    fixture.rendered?.({ toLocation: { hash: "late" }, pathChanged: true, hashChanged: true });
    expect(scroller.scrollTop).toBe(0);
    expect(TestObserver.active).toHaveLength(1);
    fixture.history?.({ action: { type: "BACK" } });
    scroller.scrollTop = 450;
    fixture.rendered?.({ toLocation: { hash: "here" }, pathChanged: true, hashChanged: true });
    expect(TestObserver.active[0]!.disconnect).toHaveBeenCalledOnce();
    expect(TestObserver.active).toHaveLength(1);
    expect(scroller.scrollTop).toBe(450);
  });
  it("preserves locale-switch scroll with a hash even after the router resets its render flag", () => {
    useHashTargetScroll();
    fixture.history?.({ action: { type: "REPLACE" } });
    fixture.resetScroll = false;
    fixture.beforeLoad?.();
    fixture.resetScroll = true;
    fixture.rendered?.({ toLocation: { hash: "late" }, pathChanged: true, hashChanged: false });
    expect(scroller.scrollTop).toBe(400);
    expect(TestObserver.active).toHaveLength(0);
  });
  it("starts a new search-selected document at the top when its hash is missing", () => {
    useHashTargetScroll();
    fixture.history?.({ action: { type: "PUSH" } });
    fixture.beforeLoad?.();
    fixture.rendered?.({
      toLocation: { hash: "missing" },
      pathChanged: false,
      hashChanged: false,
      hrefChanged: true,
    });
    expect(scroller.scrollTop).toBe(0);
  });
  it("preserves the first history entry while opting it out of native hash scrolling", () => {
    win.history.state = { __TSR_key: "first", custom: "keep" };
    useHashTargetScroll();
    expect(replaceState).toHaveBeenCalledWith(
      { __TSR_key: "first", custom: "keep", __hashScrollIntoViewOptions: false },
      "",
    );
  });
  it("does not reveal initial hashes on reload or back/forward restoration", () => {
    win.location.hash = "#old";
    vi.stubGlobal("performance", { getEntriesByType: () => [{ type: "back_forward" }] });
    useHashTargetScroll();
    expect(TestObserver.active).toHaveLength(0);
  });
  it("turns a plain fragment click into a router push, preserving query and pathname", () => {
    useHashTargetScroll();
    const anchor = new TestAnchor();
    const event = new Event("click", { cancelable: true });
    Object.defineProperties(event, { target: { value: anchor }, button: { value: 0 } });
    doc.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(fixture.navigate).toHaveBeenCalledWith({
      href: "/en-US/kbs/one/documents?path=one.md#late",
    });
    fixture.cleanup?.();
    expect(fixture.unsubscribe).toHaveBeenCalledTimes(3);
    fixture.cleanup = undefined;
  });
});
