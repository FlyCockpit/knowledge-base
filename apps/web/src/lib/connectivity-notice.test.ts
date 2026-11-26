import { describe, expect, it, vi } from "vitest";

import { BACK_ONLINE_MS, createConnectivityNotice } from "./connectivity-notice";

function setup(initiallyOnline = true) {
  const target = new EventTarget();
  let online = initiallyOnline;
  const timers: { fn: () => void; ms: number }[] = [];
  const store = createConnectivityNotice(target, () => online, {
    set: (fn, ms) => timers.push({ fn, ms }),
    clear: () => timers.splice(0),
  });
  const changes = vi.fn();
  const unsubscribe = store.subscribe(changes);
  const go = (next: boolean) => {
    online = next;
    target.dispatchEvent(new Event(next ? "online" : "offline"));
  };
  return { store, go, timers, changes, unsubscribe, target };
}

describe("connectivity notice (the offline band's state)", () => {
  it("is empty while online", () => {
    expect(setup().store.getSnapshot()).toBeNull();
  });

  it("shows offline on the offline event, then a short back-online, then nothing", () => {
    const { store, go, timers, changes } = setup();
    go(false);
    expect(store.getSnapshot()).toBe("offline");
    go(true);
    expect(store.getSnapshot()).toBe("back-online");
    expect(timers).toHaveLength(1);
    expect(timers[0]?.ms).toBe(BACK_ONLINE_MS);
    timers[0]?.fn();
    expect(store.getSnapshot()).toBeNull();
    expect(changes).toHaveBeenCalledTimes(3);
  });

  it("starts offline when the page loads offline", () => {
    expect(setup(false).store.getSnapshot()).toBe("offline");
  });

  it("ignores an online event that is not a reconnect", () => {
    const { store, go, changes } = setup();
    go(true);
    expect(store.getSnapshot()).toBeNull();
    expect(changes).not.toHaveBeenCalled();
  });

  it("drops a pending back-online when the connection drops again", () => {
    const { store, go, timers } = setup();
    go(false);
    go(true);
    go(false);
    expect(timers).toHaveLength(0);
    expect(store.getSnapshot()).toBe("offline");
  });

  it("stops listening when the last subscriber leaves", () => {
    const { store, go, unsubscribe } = setup();
    unsubscribe();
    go(false);
    expect(store.getSnapshot()).toBeNull();
  });
});
