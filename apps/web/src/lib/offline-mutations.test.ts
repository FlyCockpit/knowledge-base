import { MutationObserver, onlineManager, QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installOfflineMutationPolicy } from "./offline-mutations";

const offlineFetch = () => Promise.reject(new TypeError("Failed to fetch"));

let client: QueryClient;
const notices = { queued: vi.fn(), sent: vi.fn() };

beforeEach(() => {
  client = new QueryClient();
  client.mount();
  installOfflineMutationPolicy(client, notices);
  onlineManager.setOnline(false);
});

afterEach(() => {
  onlineManager.setOnline(true);
  client.unmount();
  vi.clearAllMocks();
});

describe("offline mutation policy", () => {
  it("fails fast offline by default: the request runs and the mutation settles as an error", async () => {
    const mutationFn = vi.fn(offlineFetch);
    const observer = new MutationObserver(client, { mutationFn });
    await expect(observer.mutate(undefined)).rejects.toThrow("Failed to fetch");
    expect(mutationFn).toHaveBeenCalledTimes(1);
    const result = observer.getCurrentResult();
    expect(result.isPending).toBe(false);
    expect(result.isPaused).toBe(false);
    expect(result.isError).toBe(true);
    expect(notices.queued).not.toHaveBeenCalled();
  });

  it("queues a mutation that opts in, tells the user, and sends it on reconnect", async () => {
    const mutationFn = vi.fn(async () => "saved");
    const observer = new MutationObserver(client, { mutationFn, meta: { offline: "queue" } });
    const done = observer.mutate(undefined);
    await vi.waitFor(() => expect(observer.getCurrentResult().isPaused).toBe(true));
    expect(mutationFn).not.toHaveBeenCalled();
    expect(notices.queued).toHaveBeenCalledTimes(1);

    onlineManager.setOnline(true);
    await expect(done).resolves.toBe("saved");
    expect(notices.queued).toHaveBeenCalledTimes(1);
    expect(notices.sent).toHaveBeenCalledTimes(1);
  });

  it("queues an inline-notice mutation without a toast: the call site renders isPaused", async () => {
    // The document editor's saves: queued, with the editor's own offline line.
    const mutationFn = vi.fn(async () => "saved");
    const observer = new MutationObserver(client, {
      mutationFn,
      meta: { offline: "queue", offlineNotice: "inline" },
    });
    const done = observer.mutate(undefined);
    await vi.waitFor(() => expect(observer.getCurrentResult().isPaused).toBe(true));
    expect(mutationFn).not.toHaveBeenCalled();

    onlineManager.setOnline(true);
    await expect(done).resolves.toBe("saved");
    expect(notices.queued).not.toHaveBeenCalled();
    expect(notices.sent).not.toHaveBeenCalled();
  });

  it("keeps an explicit networkMode", async () => {
    const mutationFn = vi.fn(async () => "ok");
    const observer = new MutationObserver(client, { mutationFn, networkMode: "online" });
    void observer.mutate(undefined);
    await vi.waitFor(() => expect(observer.getCurrentResult().isPaused).toBe(true));
    expect(mutationFn).not.toHaveBeenCalled();
  });

  it("does not announce a 'sent' for a mutation that never waited", async () => {
    onlineManager.setOnline(true);
    const observer = new MutationObserver(client, {
      mutationFn: async () => "ok",
      meta: { offline: "queue" },
    });
    await observer.mutate(undefined);
    expect(notices.queued).not.toHaveBeenCalled();
    expect(notices.sent).not.toHaveBeenCalled();
  });

  it("says nothing about a mutation that waits online behind another in its scope", async () => {
    onlineManager.setOnline(true);
    let release: () => void = () => undefined;
    const first = new MutationObserver(client, {
      mutationFn: () => new Promise<string>((resolve) => (release = () => resolve("one"))),
      scope: { id: "autosave" },
    });
    const second = new MutationObserver(client, {
      mutationFn: async () => "two",
      scope: { id: "autosave" },
    });
    const one = first.mutate(undefined);
    const two = second.mutate(undefined);
    await vi.waitFor(() => expect(second.getCurrentResult().isPaused).toBe(true));
    release();
    await expect(one).resolves.toBe("one");
    await expect(two).resolves.toBe("two");
    expect(notices.queued).not.toHaveBeenCalled();
    expect(notices.sent).not.toHaveBeenCalled();
  });

  it("does not promise replay for a fail-fast mutation paused behind its scope offline", async () => {
    onlineManager.setOnline(true);
    let release: () => void = () => undefined;
    const first = new MutationObserver(client, {
      mutationFn: () => new Promise<string>((resolve) => (release = () => resolve("one"))),
      scope: { id: "save" },
    });
    const second = new MutationObserver(client, {
      mutationFn: offlineFetch,
      scope: { id: "save" },
    });
    const one = first.mutate(undefined);
    const two = second.mutate(undefined);
    await vi.waitFor(() => expect(second.getCurrentResult().isPaused).toBe(true));
    onlineManager.setOnline(false);
    release();
    await expect(one).resolves.toBe("one");
    await expect(two).rejects.toThrow("Failed to fetch");
    expect(notices.queued).not.toHaveBeenCalled();
  });

  it("starts offline when the browser already is, so a cold start offline queues", async () => {
    onlineManager.setOnline(true);
    const other = new QueryClient();
    other.mount();
    vi.stubGlobal("navigator", { onLine: false });
    try {
      installOfflineMutationPolicy(other, notices);
      const mutationFn = vi.fn(async () => "saved");
      const observer = new MutationObserver(other, { mutationFn, meta: { offline: "queue" } });
      const done = observer.mutate(undefined);
      await vi.waitFor(() => expect(observer.getCurrentResult().isPaused).toBe(true));
      expect(mutationFn).not.toHaveBeenCalled();
      expect(notices.queued).toHaveBeenCalledTimes(1);
      onlineManager.setOnline(true);
      await expect(done).resolves.toBe("saved");
    } finally {
      vi.unstubAllGlobals();
      other.unmount();
    }
  });
});
