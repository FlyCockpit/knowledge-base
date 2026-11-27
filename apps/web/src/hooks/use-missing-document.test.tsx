import { ORPCError } from "@orpc/client";
import { onlineManager, QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMissingDocument } from "./use-missing-document";

const gone = () => new ORPCError("NOT_FOUND", { data: { details: { reason: "PATH_NOT_FOUND" } } });

type Fixture = {
  answer: () => Promise<string>;
  missing: boolean;
  status: string;
  pending: boolean;
};

function Reader({ path, fixture }: { path: string; fixture: Fixture }) {
  const query = useQuery({
    queryKey: ["document", path],
    queryFn: () => fixture.answer(),
    retry: false,
  });
  fixture.missing = useMissingDocument(path, query);
  fixture.status = query.fetchStatus;
  fixture.pending = query.isPending;
  return null;
}

describe("useMissingDocument mounted with a query", () => {
  afterEach(() => {
    onlineManager.setOnline(true);
    vi.unstubAllGlobals();
  });

  it("remembers a missing answer during fetching and paused refetches, then clears it", async () => {
    const doc = {
      nodeType: 9,
      addEventListener() {},
      removeEventListener() {},
      activeElement: null,
    };
    const container = {
      nodeType: 1,
      nodeName: "DIV",
      tagName: "DIV",
      ownerDocument: doc,
      addEventListener() {},
      removeEventListener() {},
      textContent: "",
    };
    const win = {
      document: doc,
      HTMLIFrameElement: class {},
      addEventListener() {},
      removeEventListener() {},
    };
    vi.stubGlobal("window", win);
    vi.stubGlobal("document", doc);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const root = createRoot(container as unknown as Element);
    let resolveDocument: (value: string) => void = () => {};
    const fixture: Fixture = {
      answer: async () => {
        throw gone();
      },
      missing: false,
      status: "",
      pending: false,
    };
    const show = (path: string) =>
      root.render(
        <QueryClientProvider client={client}>
          <Reader path={path} fixture={fixture} />
        </QueryClientProvider>,
      );
    try {
      await act(async () => {
        show("a");
      });
      await vi.waitFor(() => expect(fixture.missing).toBe(true));
      fixture.answer = () =>
        new Promise((resolve) => {
          resolveDocument = resolve;
        });
      await act(async () => {
        void client.refetchQueries({ queryKey: ["document", "a"] });
      });
      await vi.waitFor(() => expect(fixture.status).toBe("fetching"));
      expect(fixture.missing).toBe(true);
      await act(async () => {
        resolveDocument("document");
      });
      await vi.waitFor(() => expect(fixture.missing).toBe(false));
      // A read that never had data: missing, then an offline refetch leaves it
      // pending and paused (no error, no data), and the answer is kept.
      fixture.answer = async () => {
        throw gone();
      };
      await act(async () => {
        show("c");
      });
      await vi.waitFor(() => expect(fixture.missing).toBe(true));
      onlineManager.setOnline(false);
      await act(async () => {
        void client.refetchQueries({ queryKey: ["document", "c"] });
      });
      await vi.waitFor(() => expect(fixture.status).toBe("paused"));
      expect(fixture.pending).toBe(true);
      expect(fixture.missing).toBe(true);
      await act(async () => {
        show("b");
      });
      expect(fixture.missing).toBe(false);
    } finally {
      await act(async () => {
        root.unmount();
      });
      client.clear();
    }
  });
});
