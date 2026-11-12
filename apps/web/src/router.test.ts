import { toast } from "@knowledge-base/ui/components/sileo";
import { QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getRouter } from "./router";

vi.mock("@knowledge-base/ui/components/sileo", () => ({ toast: { error: vi.fn() } }));
vi.mock("@tanstack/react-router", () => ({ createRouter: (options: unknown) => ({ options }) }));
vi.mock("@tanstack/react-router-ssr-query", () => ({ setupRouterSsrQueryIntegration: vi.fn() }));
vi.mock("@tanstack/react-start", () => ({
  createIsomorphicFn: () => ({
    server: () => ({ client: (fn: () => unknown) => fn }),
  }),
}));
vi.mock("@tanstack/react-start/server", () => ({ getRequestHeader: vi.fn() }));
vi.mock("./components/error-state", () => ({ default: () => null }));
vi.mock("./components/loader", () => ({ default: () => null }));
vi.mock("./components/not-found-state", () => ({ default: () => null }));
vi.mock("./i18n", () => ({
  default: { t: (key: string) => key },
  createRequestI18n: () => ({ t: (key: string) => key }),
}));
vi.mock("./routeTree.gen", () => ({ routeTree: {} }));
vi.mock("./utils/orpc", () => ({ orpc: {} }));

describe("query error toast retry", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {});
    vi.mocked(toast.error).mockClear();
  });

  afterEach(() => vi.unstubAllGlobals());

  it("refetches the failed active query and leaves queries with a matching prefix alone", async () => {
    const client = getRouter().options.context.queryClient;
    const queryKey = ["document", "one"];
    const siblingKey = [...queryKey, "history"];
    client.setQueryData(siblingKey, "cached history");
    const queryFn = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue("ok");
    const observer = new QueryObserver(client, { queryKey, queryFn, retry: false });
    const unsubscribe = observer.subscribe(() => {});
    try {
      await vi.waitFor(() => expect(toast.error).toHaveBeenCalledOnce());
      const action = vi.mocked(toast.error).mock.calls[0]?.[1]?.action;
      expect(action?.label).toBe("common:actions.tryAgain");
      expect(action).toBeDefined();
      expect(() => action?.onClick()).not.toThrow();
      await vi.waitFor(() => expect(client.getQueryData(queryKey)).toBe("ok"));
      expect(queryFn).toHaveBeenCalledTimes(2);
      expect(client.getQueryState(siblingKey)?.isInvalidated).toBe(false);
      expect(client.getQueryData(siblingKey)).toBe("cached history");
    } finally {
      unsubscribe();
      client.clear();
    }
  });

  it("can retry again when the refetch also fails", async () => {
    const client = getRouter().options.context.queryClient;
    const queryFn = vi.fn().mockRejectedValue(new Error("offline"));
    const observer = new QueryObserver(client, {
      queryKey: ["document"],
      queryFn,
      retry: false,
    });
    const unsubscribe = observer.subscribe(() => {});
    try {
      await vi.waitFor(() => expect(toast.error).toHaveBeenCalledOnce());
      vi.mocked(toast.error).mock.calls[0]?.[1]?.action?.onClick();
      await vi.waitFor(() => expect(toast.error).toHaveBeenCalledTimes(2));
      expect(queryFn).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
      client.clear();
    }
  });

  it.each(["server", "inline"])("keeps %s errors out of the toast queue", async (surface) => {
    if (surface === "server") vi.stubGlobal("window", undefined);
    const client = getRouter().options.context.queryClient;
    try {
      await expect(
        client.fetchQuery({
          queryKey: ["document"],
          queryFn: () => Promise.reject(new Error("offline")),
          retry: false,
          meta: { skipGlobalErrorToast: surface === "inline" },
        }),
      ).rejects.toThrow("offline");
      expect(toast.error).not.toHaveBeenCalled();
    } finally {
      client.clear();
    }
  });
});

it("restores the bounded main and delegates hash reveal without page snapshots", () => {
  const { options } = getRouter();
  expect(options.scrollRestoration).toBe(true);
  expect(options.scrollToTopSelectors).toEqual(['[data-scroll-restoration-id="app-main"]']);
  expect(options.defaultHashScrollIntoView).toBe(false);
  expect(options.defaultViewTransition).toBeUndefined();
});
