import { describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  matches: [] as {
    status?: string;
    _notFound?: boolean;
    _assetEnd?: number;
    meta?: { title?: string }[];
  }[],
}));
vi.mock("@tanstack/react-router", () => ({
  useRouterState: ({ select }: { select: (state: typeof fixture) => unknown }) => select(fixture),
}));
vi.mock("react", () => ({ useEffect: (effect: () => void) => effect() }));
const { useSyncDocumentTitle } = await import("./use-sync-document-title");

describe("useSyncDocumentTitle", () => {
  it("follows the deepest title after redirects and not-found navigation", () => {
    const document = { title: "" };
    vi.stubGlobal("document", document);
    fixture.matches = [
      { status: "success", meta: [{ title: "KnowledgeBase" }] },
      { status: "success", meta: [{ title: "Sign in · KnowledgeBase" }] },
    ];
    useSyncDocumentTitle();
    expect(document.title).toBe("Sign in · KnowledgeBase");
    fixture.matches[1] = {
      status: "success",
      meta: [{ title: "Knowledge bases · KnowledgeBase" }],
    };
    useSyncDocumentTitle();
    expect(document.title).toBe("Knowledge bases · KnowledgeBase");
    fixture.matches = [{ status: "success", meta: [{ title: "Not found · KnowledgeBase" }] }];
    useSyncDocumentTitle();
    expect(document.title).toBe("Not found · KnowledgeBase");
    fixture.matches = [
      { status: "success", meta: [{ title: "Root" }] },
      { status: "notFound", meta: [{ title: "Not found" }] },
      { status: "success", meta: [{ title: "Stale child" }] },
    ];
    useSyncDocumentTitle();
    expect(document.title).toBe("Not found");
    vi.unstubAllGlobals();
  });
});
