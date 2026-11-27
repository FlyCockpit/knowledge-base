import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  confirmDocumentIdentityFresh,
  connectIdentityPeers,
  identityVerificationGeneration,
  reportSessionRejected,
  resetDocumentIdentityForTests,
} from "./document-identity";
import {
  connectSessionRetry,
  isNativeSessionCheckPending,
  observeSessionRetry,
  recordSessionRetryAfter,
  resetSessionRetryForTests,
  runSessionCheck,
  trackNativeSessionCheck,
  waitForSessionCooldown,
} from "./session-retry";

let visible = true;
let online = true;
let events: EventTarget;
let disconnects: (() => void)[];
const check = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  visible = online = true;
  events = new EventTarget();
  const target = {
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
  };
  vi.stubGlobal("window", target);
  vi.stubGlobal("document", {
    ...target,
    get visibilityState() {
      return visible ? "visible" : "hidden";
    },
  });
  vi.stubGlobal("navigator", {
    get onLine() {
      return online;
    },
  });
  resetSessionRetryForTests();
  resetDocumentIdentityForTests(() => undefined);
  disconnects = [];
  check.mockReset().mockImplementation(async () => {
    observeSessionRetry({ status: 503 }, false);
  });
});
afterEach(() => {
  for (const disconnect of disconnects) disconnect();
  resetSessionRetryForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function mount() {
  disconnects.push(connectSessionRetry(check));
}
function fail() {
  observeSessionRetry({ status: 503 }, false);
}

describe("document session retry", () => {
  it("does not spend a scheduled probe after a deferred obligation was confirmed elsewhere", async () => {
    disconnects.push(connectIdentityPeers(() => {}));
    reportSessionRejected();
    mount();
    confirmDocumentIdentityFresh(identityVerificationGeneration());
    await vi.advanceTimersByTimeAsync(2_000);
    expect(check).not.toHaveBeenCalled();
  });

  it("shares a native atom refresh until it settles", async () => {
    const finish = trackNativeSessionCheck();
    const first = runSessionCheck(check);
    expect(runSessionCheck(check)).toBe(first);
    expect(isNativeSessionCheckPending()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(check).not.toHaveBeenCalled();
    finish();
    expect(await first).toBe(true);
    expect(isNativeSessionCheckPending()).toBe(false);
  });

  it("a native refresh preceding a newer invalidation must finish before a fresh check runs", async () => {
    const finish = trackNativeSessionCheck();
    reportSessionRejected();
    expect(isNativeSessionCheckPending()).toBe(false);
    const next = runSessionCheck(check);
    await vi.advanceTimersByTimeAsync(0);
    expect(check).not.toHaveBeenCalled();
    finish();
    await next;
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("cancels a native refresh waiting for cooldown without leaving a timer", async () => {
    recordSessionRetryAfter(new Response(null, { status: 429, headers: { "Retry-After": "60" } }));
    const controller = new AbortController();
    const wait = waitForSessionCooldown(controller.signal);
    const rejection = expect(wait).rejects.toThrow("superseded");
    controller.abort(new Error("superseded"));
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a native refresh also waits for a newer cooldown received while it was deferred", async () => {
    recordSessionRetryAfter(new Response(null, { status: 429, headers: { "Retry-After": "10" } }));
    const ready = vi.fn();
    const wait = waitForSessionCooldown().then(ready);
    await vi.advanceTimersByTimeAsync(5_000);
    recordSessionRetryAfter(new Response(null, { status: 429, headers: { "Retry-After": "20" } }));
    await vi.advanceTimersByTimeAsync(19_999);
    expect(ready).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await wait;
    expect(ready).toHaveBeenCalledTimes(1);
  });

  it.each(["hidden", "offline"])(
    "retains a deferred native refresh while %s until availability resumes",
    async (state) => {
      recordSessionRetryAfter(
        new Response(null, { status: 429, headers: { "Retry-After": "10" } }),
      );
      const ready = vi.fn();
      const wait = waitForSessionCooldown().then(ready);
      await vi.advanceTimersByTimeAsync(5_000);
      if (state === "hidden") visible = false;
      else online = false;
      events.dispatchEvent(new Event(state === "hidden" ? "visibilitychange" : "offline"));
      await vi.advanceTimersByTimeAsync(65_000);
      expect(ready).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      // The other unavailable condition must also keep the same request pending.
      visible = false;
      online = false;
      events.dispatchEvent(new Event("focus"));
      visible = true;
      events.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
      expect(ready).not.toHaveBeenCalled();
      online = true;
      events.dispatchEvent(new Event("online"));
      await wait;
      expect(ready).toHaveBeenCalledTimes(1);
    },
  );

  it("aborts an unavailable native refresh and removes its availability listeners", async () => {
    recordSessionRetryAfter(new Response(null, { status: 429, headers: { "Retry-After": "1" } }));
    const removeWindow = vi.spyOn(window, "removeEventListener");
    const removeDocument = vi.spyOn(document, "removeEventListener");
    const controller = new AbortController();
    const outcome = waitForSessionCooldown(controller.signal).then(
      () => null,
      (error: unknown) => error,
    );
    visible = false;
    await vi.advanceTimersByTimeAsync(1_000);
    removeWindow.mockClear();
    removeDocument.mockClear();
    controller.abort(new Error("superseded"));
    expect(await outcome).toMatchObject({ message: "superseded" });
    expect(vi.getTimerCount()).toBe(0);
    expect(removeWindow.mock.calls.map(([name]) => name)).toEqual(["online", "focus"]);
    expect(removeDocument.mock.calls.map(([name]) => name)).toEqual(["visibilitychange"]);
    visible = true;
    events.dispatchEvent(new Event("visibilitychange"));
    removeWindow.mockRestore();
    removeDocument.mockRestore();
  });

  it("two mounted consumers share the 2, 4, 8 … 60 second backoff", async () => {
    mount();
    mount();
    fail();
    for (const [i, delay] of [2000, 4000, 8000, 16000, 32000, 60000, 60000].entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(check).toHaveBeenCalledTimes(i);
      await vi.advanceTimersByTimeAsync(1);
      expect(check).toHaveBeenCalledTimes(i + 1);
    }
  });
  it("honors a 429 Retry-After; a missing header uses 60 seconds", async () => {
    mount();
    recordSessionRetryAfter(new Response(null, { status: 429, headers: { "Retry-After": "10" } }));
    fail();
    await vi.advanceTimersByTimeAsync(9999);
    expect(check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(check).toHaveBeenCalledTimes(1);
    recordSessionRetryAfter(new Response(null, { status: 429 }));
    await vi.advanceTimersByTimeAsync(59999);
    expect(check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(check).toHaveBeenCalledTimes(2);
  });
  it("defers automatic checks during Retry-After without reporting a completed check", async () => {
    mount();
    recordSessionRetryAfter(new Response(null, { status: 429, headers: { "Retry-After": "10" } }));
    fail();
    expect(await runSessionCheck(check, { automatic: true })).toBe(false);
    expect(check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(check).toHaveBeenCalledTimes(1);
  });
  it("pauses hidden/offline; visibility, online and focus resume once", async () => {
    mount();
    fail();
    visible = false;
    events.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(120000);
    expect(check).not.toHaveBeenCalled();
    visible = true;
    online = false;
    events.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(120000);
    expect(check).not.toHaveBeenCalled();
    online = true;
    events.dispatchEvent(new Event("online"));
    events.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(check).toHaveBeenCalledTimes(1);
  });
  it("does not launch an automatic peer check while hidden or offline", async () => {
    visible = false;
    expect(await runSessionCheck(check, { automatic: true })).toBe(false);
    visible = true;
    online = false;
    expect(await runSessionCheck(check, { automatic: true })).toBe(false);
    expect(check).not.toHaveBeenCalled();
    online = true;
    await runSessionCheck(check, { automatic: true });
    expect(check).toHaveBeenCalledOnce();
  });
  it("a success stops retries and the next failure starts at 2 seconds", async () => {
    mount();
    fail();
    await vi.advanceTimersByTimeAsync(2000);
    observeSessionRetry(null, false);
    await vi.advanceTimersByTimeAsync(120000);
    expect(check).toHaveBeenCalledTimes(1);
    fail();
    await vi.advanceTimersByTimeAsync(2000);
    expect(check).toHaveBeenCalledTimes(2);
  });
  it("coalesces checks until the in-flight promise settles", async () => {
    let finish!: () => void;
    check.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const first = runSessionCheck(check);
    expect(runSessionCheck(check)).toBe(first);
    await vi.advanceTimersByTimeAsync(0);
    expect(check).toHaveBeenCalledTimes(1);
    finish();
    await first;
  });
});
