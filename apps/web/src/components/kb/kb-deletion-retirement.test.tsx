import {
  type InfiniteData,
  QueryCache,
  QueryClient,
  QueryClientProvider,
  useInfiniteQuery,
  useQuery,
} from "@tanstack/react-query";
import { act, useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { finishKbDeletion } from "@/components/kb/kb-list";

// Same minimal React DOM fixture pattern as auth-form-refocus.test.tsx.
// No browser, layout, event simulation or new DOM dependency is needed here.
class FakeNode {
  childNodes: FakeNode[] = [];
  parentNode: FakeNode | null = null;
  constructor(
    readonly ownerDocument: FakeDocument | null,
    readonly nodeType: number,
    readonly nodeName: string,
  ) {}
  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }
  get lastChild(): FakeNode | null {
    return this.childNodes.at(-1) ?? null;
  }
  get parentElement(): FakeNode | null {
    return this.parentNode?.nodeType === 1 ? this.parentNode : null;
  }
  get nextSibling(): FakeNode | null {
    const siblings = this.parentNode?.childNodes;
    return siblings ? (siblings[siblings.indexOf(this) + 1] ?? null) : null;
  }
  get previousSibling(): FakeNode | null {
    const siblings = this.parentNode?.childNodes;
    return siblings ? (siblings[siblings.indexOf(this) - 1] ?? null) : null;
  }
  get textContent(): string {
    return this.childNodes.map((child) => child.textContent).join("");
  }
  set textContent(text: string) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    if (text) this.appendChild(new FakeText(this.ownerDocument, text));
  }
  appendChild<T extends FakeNode>(child: T): T {
    return this.insertBefore(child, null);
  }
  insertBefore<T extends FakeNode>(child: T, ref: FakeNode | null): T {
    child.parentNode?.removeChild(child);
    const at = ref ? this.childNodes.indexOf(ref) : this.childNodes.length;
    this.childNodes.splice(at, 0, child);
    child.parentNode = this;
    return child;
  }
  removeChild<T extends FakeNode>(child: T): T {
    this.childNodes.splice(this.childNodes.indexOf(child), 1);
    child.parentNode = null;
    return child;
  }
  contains(other: FakeNode | null): boolean {
    for (let node = other; node; node = node.parentNode) if (node === this) return true;
    return false;
  }
  getRootNode(): FakeNode {
    let node: FakeNode = this;
    while (node.parentNode) node = node.parentNode;
    return node;
  }
  addEventListener() {}
  removeEventListener() {}
}

class FakeText extends FakeNode {
  constructor(
    doc: FakeDocument | null,
    public nodeValue: string,
    nodeType = 3,
  ) {
    super(doc, nodeType, nodeType === 3 ? "#text" : "#comment");
  }
  get data() {
    return this.nodeValue;
  }
  override get textContent() {
    return this.nodeValue;
  }
  override set textContent(text: string) {
    this.nodeValue = text;
  }
}

class FakeElement extends FakeNode {
  readonly attributes = new Map<string, string>();
  readonly style = { setProperty() {}, removeProperty() {} };
  /** React DOM writes `value`, `type`, `checked` as properties. */
  [property: string]: unknown;
  constructor(
    doc: FakeDocument,
    readonly localName: string,
    readonly namespaceURI: string,
  ) {
    super(doc, 1, localName.toUpperCase());
  }
  get tagName() {
    return this.nodeName;
  }
  setAttribute(name: string, value: unknown) {
    this.attributes.set(name, String(value));
  }
  setAttributeNS(_namespace: string, name: string, value: unknown) {
    this.setAttribute(name, value);
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  hasAttribute(name: string) {
    return this.attributes.has(name);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  removeAttributeNS(_namespace: string, name: string) {
    this.removeAttribute(name);
  }
  focus() {}
  blur() {}
}

class FakeDocument extends FakeNode {
  readonly documentElement: FakeElement;
  readonly head: FakeElement;
  readonly body: FakeElement;
  readonly activeElement = null;
  defaultView: unknown = null;
  constructor() {
    super(null, 9, "#document");
    this.documentElement = this.appendChild(this.createElement("html"));
    this.head = this.documentElement.appendChild(this.createElement("head"));
    this.body = this.documentElement.appendChild(this.createElement("body"));
  }
  createElement(tag: string) {
    return new FakeElement(this, tag.toLowerCase(), "http://www.w3.org/1999/xhtml");
  }
  createElementNS(namespace: string, tag: string) {
    return new FakeElement(this, tag, namespace);
  }
  createTextNode(text: string) {
    return new FakeText(this, text);
  }
  createComment(text: string) {
    return new FakeText(this, text, 8);
  }
  querySelector() {
    return null;
  }
  querySelectorAll() {
    return [];
  }
}

type ReaderFixture = {
  treeKey: readonly unknown[];
  mirrorKey: readonly unknown[];
  pendingRead: (context: { signal: AbortSignal }) => Promise<never>;
  retire: () => void;
};
function WorkspacePaginator({ fixture }: { fixture: ReaderFixture }) {
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery({
    queryKey: fixture.treeKey,
    queryFn: fixture.pendingRead,
    initialPageParam: null as string | null,
    getNextPageParam: (last: { nextCursor: string | null }) => last.nextCursor,
    staleTime: Infinity,
  });
  // effect:audited — Test fixture models a mounted caller's automatic pagination.
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
  return null;
}
function SettingsPoller({ fixture }: { fixture: ReaderFixture }) {
  const { refetch } = useQuery({
    queryKey: fixture.mirrorKey,
    queryFn: fixture.pendingRead,
    staleTime: Infinity,
  });
  // effect:audited — Test fixture models polling and verifies its unmount cleanup.
  useEffect(() => {
    const timer = setInterval(() => {
      void refetch();
    }, 5);
    return () => clearInterval(timer);
  }, [refetch]);
  return null;
}
function Layout({ fixture }: { fixture: ReaderFixture }) {
  const [retired, setRetired] = useState(false);
  fixture.retire = () => flushSync(() => setRetired(true));
  return retired ? (
    <p>Deleted; return to knowledge bases</p>
  ) : (
    <>
      <WorkspacePaginator fixture={fixture} />
      <SettingsPoller fixture={fixture} />
    </>
  );
}
describe("deleted KB observers during delayed navigation", () => {
  it.each([false, true])(
    "unmounts workspace and settings readers before cancellation (navigation rejects=%s)",
    async (rejectNavigation) => {
      vi.useFakeTimers();
      const doc = new FakeDocument();
      const classes = {
        Node: FakeNode,
        Element: FakeElement,
        HTMLElement: FakeElement,
        HTMLIFrameElement: class {},
      };
      const win = {
        ...classes,
        addEventListener() {},
        removeEventListener() {},
        location: { href: "https://kb.example.com/en-US/kbs/kb1" },
      };
      doc.defaultView = win;
      vi.stubGlobal("window", win);
      vi.stubGlobal("document", doc);
      for (const [name, value] of Object.entries(classes)) vi.stubGlobal(name, value);
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      const root = createRoot(doc.body.appendChild(doc.createElement("div")) as unknown as Element);
      const errors = vi.fn();
      const client = new QueryClient({
        queryCache: new QueryCache({ onError: errors }),
        defaultOptions: { queries: { retry: false } },
      });
      const treeKey = [["documents", "tree"], { input: { kbId: "kb1" } }];
      const mirrorKey = [["kbMirror", "status"], { input: { kbId: "kb1" } }];
      client.setQueryData<InfiniteData<{ nextCursor: string | null }, string | null>>(treeKey, {
        pages: [{ nextCursor: "next" }],
        pageParams: [null],
      });
      client.setQueryData(mirrorKey, { active: true });
      const reads = vi.fn();
      const lateFailures: Array<(error: Error) => void> = [];
      const pendingRead = ({ signal }: { signal: AbortSignal }) => {
        reads();
        // Reading the signal opts the query into cancellation on real unmount.
        void signal.aborted;
        return new Promise<never>((_resolve, reject) => {
          lateFailures.push(reject);
        });
      };
      const fixture: ReaderFixture = { treeKey, mirrorKey, pendingRead, retire: () => {} };
      let completeNavigation = () => {};
      let failNavigation = (_error: Error) => {};
      const navigating = new Promise<void>((resolve, reject) => {
        completeNavigation = resolve;
        failNavigation = reject;
      });
      const navigate = vi.fn(() => navigating);
      try {
        await act(async () => {
          root.render(
            <QueryClientProvider client={client}>
              <Layout fixture={fixture} />
            </QueryClientProvider>,
          );
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(5);
        });
        expect(reads).toHaveBeenCalledTimes(2);
        let finished: Promise<void> = Promise.resolve();
        await act(async () => {
          finished = finishKbDeletion(client, "kb1", navigate, fixture.retire);
          // Attach the rejection handler before deliberately rejecting navigation.
          void finished.catch(() => {});
          await Promise.resolve();
        });
        expect(navigate).toHaveBeenCalledOnce();
        expect(client.getQueryCache().find({ queryKey: treeKey })?.getObserversCount()).toBe(0);
        expect(client.getQueryCache().find({ queryKey: mirrorKey })?.getObserversCount()).toBe(0);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(100);
        });
        expect(reads).toHaveBeenCalledTimes(2);
        expect(doc.body.textContent).toContain("Deleted; return to knowledge bases");
        const failure = new Error("Navigation failed");
        await act(async () => {
          for (const fail of lateFailures)
            fail(Object.assign(new Error("No access"), { code: "FORBIDDEN" }));
          if (rejectNavigation) failNavigation(failure);
          else completeNavigation();
          if (rejectNavigation) await expect(finished).rejects.toBe(failure);
          else await finished;
        });
        expect(client.getQueryData(treeKey)).toBeUndefined();
        expect(client.getQueryData(mirrorKey)).toBeUndefined();
        expect(errors).not.toHaveBeenCalled();
        expect(doc.body.textContent).toContain("Deleted; return to knowledge bases");
      } finally {
        act(() => root.unmount());
        client.clear();
        vi.useRealTimers();
        vi.unstubAllGlobals();
      }
    },
  );
});
