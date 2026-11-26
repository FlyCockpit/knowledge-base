import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";

import { ensureRouteQuery } from "./route-query";

const KEY = ["appConfig"] as const;
const clients: QueryClient[] = [];

function client() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(qc);
  return qc;
}

/** A component observer whose queryFn reads the abort signal, as oRPC's does. */
function observe(qc: QueryClient, value: string, ms: number) {
  const observer = new QueryObserver(qc, {
    queryKey: KEY,
    queryFn: ({ signal }) =>
      new Promise<string>((resolve, reject) => {
        const t = setTimeout(() => resolve(value), ms);
        signal.addEventListener("abort", () => {
          clearTimeout(t);
          reject(new Error("aborted"));
        });
      }),
  });
  return observer.subscribe(() => {});
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  for (const qc of clients.splice(0)) qc.clear();
});

describe("ensureRouteQuery", () => {
  it("plain ensureQueryData rejects when the observer unmounts mid-fetch (the bug)", async () => {
    const qc = client();
    const unsubscribe = observe(qc, "from-observer", 50);
    const pending = qc.ensureQueryData({ queryKey: KEY, queryFn: async () => "route" });
    unsubscribe();
    await expect(pending).rejects.toMatchObject({ revert: true });
  });

  it("survives the observer unmounting while the route waits on its fetch", async () => {
    const qc = client();
    const unsubscribe = observe(qc, "from-observer", 50);
    const pending = ensureRouteQuery(qc, KEY, async () => {
      await delay(10);
      return "from-route";
    });
    unsubscribe();
    await expect(pending).resolves.toBe("from-route");
    expect(qc.getQueryData(KEY)).toBe("from-route");
  });

  it("its own fetch is not cancelled when an observer mounts and unmounts", async () => {
    const qc = client();
    const pending = ensureRouteQuery(qc, KEY, async () => {
      await delay(30);
      return "from-route";
    });
    const unsubscribe = observe(qc, "from-observer", 50);
    await delay(5);
    unsubscribe();
    await expect(pending).resolves.toBe("from-route");
  });

  it("returns cached data without fetching", async () => {
    const qc = client();
    qc.setQueryData(KEY, "cached");
    let calls = 0;
    await expect(
      ensureRouteQuery(qc, KEY, async () => {
        calls += 1;
        return "fresh";
      }),
    ).resolves.toBe("cached");
    expect(calls).toBe(0);
  });

  it("passes real failures through", async () => {
    const qc = client();
    await expect(
      ensureRouteQuery(qc, KEY, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});
