import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@knowledge-base/env/web", () => ({
  env: { VITE_SERVER_URL: "https://api.example.test" },
}));

const { orpc } = await import("./orpc");

type Sent = { path: string; batch: string | null };

function recordFetch(): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      sent.push({
        path: new URL(request.url).pathname,
        batch: request.headers.get("x-orpc-batch"),
      });
      // Any answer will do: the test inspects only what was sent.
      return new Response(JSON.stringify({ error: "x" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return sent;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("oRPC link", () => {
  it("sends upload frames unbatched to their own path while other calls still batch", async () => {
    const sent = recordFetch();
    const kbId = "a".repeat(24);
    const frame = (offset: number) =>
      orpc.kbUploads.write.call({
        kbId,
        uploadId: "00000000-0000-4000-8000-000000000001",
        offset,
        bytesBase64: "AAAA",
      });
    await Promise.allSettled([
      frame(0),
      frame(3),
      orpc.kbs.get.call({ kbId }),
      orpc.kbs.get.call({ kbId: "b".repeat(24) }),
    ]);
    const frames = sent.filter((s) => s.path === "/rpc/kbUploads/write");
    expect(frames).toEqual([
      { path: "/rpc/kbUploads/write", batch: null },
      { path: "/rpc/kbUploads/write", batch: null },
    ]);
    expect(sent.some((s) => s.path.includes("kbUploads") && s.batch !== null)).toBe(false);
    // The other two still share one batch request.
    expect(sent.filter((s) => s.batch !== null)).toHaveLength(1);
  });
});
