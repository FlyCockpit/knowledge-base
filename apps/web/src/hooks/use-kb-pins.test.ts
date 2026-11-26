import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/document-identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/document-identity")>()),
  reportSessionRejected: vi.fn(),
}));
beforeEach(() => vi.mocked(reportSessionRejected).mockClear());

import {
  forgetAllPins,
  forgetKbPin,
  forgetOnPinRefusal,
  type PinnedKb,
  readPinsOrForget,
  refreshKbPins,
  settlePinChange,
  shownPins,
} from "@/hooks/use-kb-pins";
import { reportSessionRejected } from "@/lib/document-identity";
import { orpc } from "@/utils/orpc";

const kb = (id: string): PinnedKb => ({ kbId: id, name: `Base ${id}`, slug: id });
/** A pin list's key, untyped so a test can seed a partial answer. */
const listKey = (recent?: string[]): readonly unknown[] =>
  orpc.kbPins.list.queryKey({ input: recent ? { recent } : {} });
const items = (client: QueryClient, key: readonly unknown[]) =>
  (client.getQueryData(key) as { items: PinnedKb[] } | undefined)?.items.map((i) => i.kbId);
const ids = (list: PinnedKb[]) => list.map((item) => item.kbId);

describe("pins shown while a change is in flight", () => {
  it("only hides or reorders the rows the server returned", () => {
    const served = [kb("a"), kb("b"), kb("c")];
    expect(ids(shownPins(served, null))).toEqual(["a", "b", "c"]);
    expect(ids(shownPins(served, { unpin: "b" }))).toEqual(["a", "c"]);
    expect(ids(shownPins(served, { reorder: ["c", "a", "b"] }))).toEqual(["c", "a", "b"]);
  });

  it("never brings back a KB the server stopped returning", () => {
    // A reorder sent with a, b; meanwhile the server's answer dropped b (access lost).
    expect(ids(shownPins([kb("a"), kb("x")], { reorder: ["b", "a"] }))).toEqual(["a", "x"]);
    // An unpin of b in flight while b is already gone: nothing to hide, nothing restored.
    expect(ids(shownPins([kb("a")], { unpin: "b" }))).toEqual(["a"]);
  });
});

describe("pin cache", () => {
  it("a finished change reads every pin list again", async () => {
    const client = new QueryClient();
    client.setQueryData(listKey(), { items: [kb("a")] });
    client.setQueryData(listKey(["r"]), { items: [kb("a")], recent: [kb("r")] });
    client.setQueryData(listKey(["b2"]), { items: [kb("b")] });
    await settlePinChange(client);
    expect(client.getQueryState(listKey())?.isInvalidated).toBe(true);
    expect(client.getQueryState(listKey(["r"]))?.isInvalidated).toBe(true);
    expect(client.getQueryState(listKey(["b2"]))?.isInvalidated).toBe(true);
    // Nothing is composed on the client: the cached answers are untouched.
    expect(items(client, listKey())).toEqual(["a"]);
  });

  it("forgets a KB whose access is gone in every cached list, recent ones too", async () => {
    const client = new QueryClient();
    client.setQueryData(listKey(["gone"]), {
      items: [kb("gone"), kb("a")],
      recent: [kb("gone")],
    });
    client.setQueryData(listKey(["b2"]), { items: [kb("gone")] });
    await forgetKbPin(client, "gone");
    expect(client.getQueryData(listKey(["gone"]))).toEqual({
      items: [kb("a")],
      recent: [],
    });
    expect(items(client, listKey(["b2"]))).toEqual([]);
  });

  it("a refusal for the whole session empties every pin list; a KB refusal drops that KB", async () => {
    const seeded = () => {
      const client = new QueryClient();
      client.setQueryData(listKey(["r"]), {
        items: [kb("a"), kb("b")],
        recent: [kb("r")],
      });
      client.setQueryData(listKey(), { items: [kb("a"), kb("b")] });
      client.setQueryData(listKey(["b2"]), { items: [kb("a")] });
      return client;
    };
    const denied = (code: string) => Object.assign(new Error(code), { code });
    // A session-wide denial of an unpin (with a kbId) and of a reorder (none).
    for (const [error, input] of [
      [denied("UNAUTHORIZED"), { kbId: "a" }],
      [denied("FORBIDDEN"), { kbIds: ["b", "a"] }],
    ] as const) {
      const client = seeded();
      await forgetOnPinRefusal(client, error, input);
      expect(client.getQueryData(listKey(["r"]))).toEqual({ items: [], recent: [] });
      expect(items(client, listKey())).toEqual([]);
      expect(items(client, listKey(["b2"]))).toEqual([]);
    }
    const client = seeded();
    await forgetOnPinRefusal(client, denied("NOT_FOUND"), { kbId: "a" });
    expect(items(client, listKey())).toEqual(["b"]);
    expect(items(client, listKey(["b2"]))).toEqual([]);
    // A reorder refused as stale (a pin in it may have been revoked) forgets them too.
    const stale = seeded();
    const changed = Object.assign(new Error("stale"), {
      code: "BAD_REQUEST",
      data: { reason: "PINS_CHANGED" },
    });
    await forgetOnPinRefusal(stale, changed, { kbIds: ["b", "a"] });
    expect(items(stale, listKey())).toEqual([]);
    expect(items(stale, listKey(["b2"]))).toEqual([]);
    // A transient failure forgets nothing.
    const kept = seeded();
    await forgetOnPinRefusal(kept, new TypeError("Failed to fetch"), { kbId: "a" });
    expect(items(kept, listKey())).toEqual(["a", "b"]);
  });

  it("drops an answer admitted before the access loss; a fresh read after it is the truth", async () => {
    const client = new QueryClient();
    const key = listKey();
    client.setQueryData(key, { items: [kb("a")] });
    let release: (value: unknown) => void = () => {};
    // A read admitted before the loss, still in flight (it names s).
    const early = client
      .fetchQuery({
        queryKey: key,
        staleTime: 0,
        queryFn: () => new Promise((resolve) => (release = resolve)),
      })
      .catch(() => null);
    await forgetKbPin(client, "s");
    release({ items: [kb("a"), kb("s")] });
    // The cancelled read never delivers its answer, to the cache or its caller.
    expect(JSON.stringify(await early)).not.toContain('"s"');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(items(client, key)).toEqual(["a"]);
    // A read that starts after the loss is not filtered: s readable again (or
    // another account's pin) shows.
    await client.fetchQuery({
      queryKey: key,
      staleTime: 0,
      queryFn: async () => ({ items: [kb("a"), kb("s")] }),
    });
    expect(items(client, key)).toEqual(["a", "s"]);
  });

  it("after a KB is renamed every pin list is read again; a deleted one is dropped at once", async () => {
    const client = new QueryClient();
    client.setQueryData(listKey(), { items: [kb("a"), kb("d")] });
    await refreshKbPins(client);
    expect(client.getQueryState(listKey())?.isInvalidated).toBe(true);
    // Delete succeeded: what the KB list does on success.
    await forgetKbPin(client, "d");
    expect(items(client, listKey())).toEqual(["a"]);
  });
});

describe("readPinsOrForget", () => {
  const empty = { items: [] as PinnedKb[], recent: [] as PinnedKb[] };
  const fail = (error: unknown) => () => Promise.reject(error);
  it("answers nothing once access is refused or the session is gone", async () => {
    for (const code of ["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND"])
      expect(await readPinsOrForget(fail(Object.assign(new Error(code), { code })), empty)).toBe(
        empty,
      );
    expect(
      await readPinsOrForget(fail(Object.assign(new Error("x"), { status: 401 })), empty),
    ).toBe(empty);
  });
  it("a session refusal answered empty still asks for the session check; other refusals don't", async () => {
    await readPinsOrForget(fail(Object.assign(new Error("x"), { code: "UNAUTHORIZED" })), empty);
    expect(reportSessionRejected).toHaveBeenCalledTimes(1);
    await readPinsOrForget(fail(Object.assign(new Error("x"), { status: 401 })), empty);
    expect(reportSessionRejected).toHaveBeenCalledTimes(2);
    await readPinsOrForget(fail(Object.assign(new Error("x"), { code: "FORBIDDEN" })), empty);
    await expect(readPinsOrForget(fail(new TypeError("Failed to fetch")), empty)).rejects.toThrow();
    expect(reportSessionRejected).toHaveBeenCalledTimes(2);
  });
  it("still fails on a transient error, and passes an answer through", async () => {
    await expect(readPinsOrForget(fail(new TypeError("Failed to fetch")), empty)).rejects.toThrow();
    const data = { items: [kb("a")], recent: [] };
    expect(await readPinsOrForget(() => Promise.resolve(data), empty)).toBe(data);
  });
  it("a denial replaces the cached names, so a later transient failure can't bring them back", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const key = listKey();
    const answers: (() => Promise<typeof empty>)[] = [
      () => Promise.resolve({ items: [kb("a")], recent: [kb("r")] }),
      fail(Object.assign(new Error("FORBIDDEN"), { code: "FORBIDDEN" })),
      fail(new TypeError("Failed to fetch")),
    ];
    const queryFn = () => readPinsOrForget(answers.shift()!, empty);
    await client.fetchQuery({ queryKey: key, queryFn });
    expect(items(client, key)).toEqual(["a"]);
    await client.fetchQuery({ queryKey: key, queryFn, staleTime: 0 });
    expect(items(client, key)).toEqual([]);
    await expect(client.fetchQuery({ queryKey: key, queryFn, staleTime: 0 })).rejects.toThrow();
    expect(client.getQueryData(key)).toEqual(empty);
  });
});

describe("a refused read", () => {
  it("empties the other pin lists too, without reading them again", async () => {
    const client = new QueryClient();
    client.setQueryData(listKey(["r"]), { items: [kb("a")], recent: [kb("r")] });
    client.setQueryData(listKey(), { items: [kb("a")] });
    client.setQueryData(listKey(["b2"]), { items: [kb("a")] });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const denied = Object.assign(new Error("UNAUTHORIZED"), { code: "UNAUTHORIZED" });
    let siblings: Promise<void> | undefined;
    const answer = await readPinsOrForget(
      () => Promise.reject(denied),
      { items: [], recent: [] },
      () => {
        siblings = forgetAllPins(client, { except: listKey() });
      },
    );
    await siblings;
    expect(answer).toEqual({ items: [], recent: [] });
    expect(client.getQueryData(listKey(["r"]))).toEqual({ items: [], recent: [] });
    // Its own key answers for itself (here still the seeded value).
    expect(items(client, listKey())).toEqual(["a"]);
    expect(items(client, listKey(["b2"]))).toEqual([]);
    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe("a refused read during a sibling's first read", () => {
  it("leaves the sibling answered empty, not pending with no data", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const sibling = listKey(["r"]);
    // The sibling's first read is in flight (it never answers on its own).
    void client.prefetchQuery({
      queryKey: sibling,
      queryFn: () => new Promise<{ items: PinnedKb[] }>(() => {}),
    });
    expect(client.getQueryState(sibling)?.fetchStatus).toBe("fetching");
    await forgetAllPins(client, { except: listKey() });
    expect(client.getQueryState(sibling)?.status).toBe("success");
    expect(client.getQueryData(sibling)).toEqual({ items: [], recent: [] });
  });
});
