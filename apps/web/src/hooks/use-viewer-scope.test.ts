import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { VIEWER_SCOPED_CACHE, viewerScopedKey } from "@/hooks/use-viewer-scope";

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

describe("viewer-scoped sharing queries", () => {
  const base = ["kbs", "sharePendingList", { input: { kbId: "kb1" }, type: "infinite" }];
  const client = () =>
    new QueryClient({ defaultOptions: { queries: { staleTime: 5 * 60_000, gcTime: 5 * 60_000 } } });

  it("a mounted view never shows the previous account's answer after an account switch", async () => {
    const queryClient = client();
    let answer = "ana@example.com";
    const options = (viewer: string) => ({
      queryKey: viewerScopedKey(base, viewer),
      queryFn: async () => answer,
      ...VIEWER_SCOPED_CACHE,
    });
    const observer = new QueryObserver(queryClient, options("ana"));
    const seen: (string | undefined)[] = [];
    const unsubscribe = observer.subscribe((result) => seen.push(result.data));
    await tick();
    expect(observer.getCurrentResult().data).toBe("ana@example.com");
    // Another tab signs in as Bo; this view re-renders with Bo's session.
    answer = "(nothing for bo)";
    observer.setOptions(options("bo"));
    expect(observer.getCurrentResult().data).toBeUndefined();
    await tick(5);
    expect(observer.getCurrentResult().data).toBe("(nothing for bo)");
    // Ana's answer left the cache once nothing showed it.
    expect(
      queryClient.getQueryCache().find({ queryKey: viewerScopedKey(base, "ana") }),
    ).toBeUndefined();
    unsubscribe();
  });

  it("forgets the answer once nothing shows it, despite a long default stale time", async () => {
    const queryClient = client();
    const key = viewerScopedKey(base, "ana");
    const observer = new QueryObserver(queryClient, {
      queryKey: key,
      queryFn: async () => "ana@example.com",
      ...VIEWER_SCOPED_CACHE,
    });
    const unsubscribe = observer.subscribe(() => {});
    await tick();
    unsubscribe();
    await tick(5);
    expect(queryClient.getQueryCache().find({ queryKey: key })).toBeUndefined();
  });

  it("keeps prefix invalidation by the procedure's key working", () => {
    const queryClient = client();
    queryClient.setQueryData(viewerScopedKey(base, "ana"), "x");
    expect(
      queryClient.getQueryCache().findAll({ queryKey: ["kbs", "sharePendingList"] }),
    ).toHaveLength(1);
    expect(queryClient.getQueryCache().findAll({ queryKey: base })).toHaveLength(1);
  });
});
