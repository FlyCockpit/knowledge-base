import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BodyBudgetExceededError,
  BodyReadTimeoutError,
  BodyTooLargeError,
  bodyPolicyMiddleware,
  bufferedBodyBytes,
  MCP_MAX_BODY_BYTES,
  maxBodyBytesForPath,
  readBodyWithLimit,
  UPLOAD_WRITE_JSON_MAX_BYTES,
} from "./body-policy.js";

vi.mock("./client-ip.js", () => ({ resolveClientIp: () => "resolved-client" }));
afterEach(() => vi.unstubAllGlobals());

describe("bodyPolicyMiddleware", () => {
  it("releases bytes when reconstructing the request throws", async () => {
    const app = new Hono();
    app.use("*", bodyPolicyMiddleware());
    app.post("/rpc/test", (c) => c.text("ok"));
    app.onError((_err, c) => c.text("failed", 500));
    const request = new Request("https://example.test/rpc/test", {
      method: "POST",
      body: "payload",
    });
    vi.stubGlobal(
      "Request",
      class extends Request {
        constructor(..._args: ConstructorParameters<typeof Request>) {
          super("https://example.test");
          throw new TypeError("replacement failed");
        }
      },
    );
    expect((await app.fetch(request)).status).toBe(500);
    expect(bufferedBodyBytes()).toBe(0);
  });
  it("propagates a client abort to the rebuilt request after buffering", async () => {
    const controller = new AbortController();
    const app = new Hono();
    app.use("*", bodyPolicyMiddleware());
    app.post("/rpc/test", async (c) => {
      expect(await c.req.text()).toBe("payload");
      expect(c.req.raw.signal.aborted).toBe(false);
      controller.abort(new Error("client disconnected"));
      expect(c.req.raw.signal.aborted).toBe(true);
      expect(c.req.raw.signal.reason).toBe(controller.signal.reason);
      return c.text("ok");
    });
    const response = await app.request("https://example.test/rpc/test", {
      method: "POST",
      body: "payload",
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
  });
});

describe("maxBodyBytesForPath", () => {
  it("keeps MCP requests at 1 MiB", () => {
    expect(maxBodyBytesForPath("/mcp/tools/call")).toBe(MCP_MAX_BODY_BYTES);
  });

  it("caps kb upload write JSON below MCP", () => {
    expect(maxBodyBytesForPath("/rpc/kbUploads/write")).toBe(UPLOAD_WRITE_JSON_MAX_BYTES);
    expect(maxBodyBytesForPath("/rpc/kbUploads/write/__batch__")).toBe(UPLOAD_WRITE_JSON_MAX_BYTES);
    expect(UPLOAD_WRITE_JSON_MAX_BYTES).toBeLessThan(MCP_MAX_BODY_BYTES);
  });
});

describe("readBodyWithLimit", () => {
  it("stops reading once the cap is exceeded", async () => {
    const body = new Uint8Array(UPLOAD_WRITE_JSON_MAX_BYTES + 32);
    const request = new Request("https://example.test/rpc/kbUploads/write", {
      method: "POST",
      body,
    });
    await expect(readBodyWithLimit(request, UPLOAD_WRITE_JSON_MAX_BYTES)).rejects.toBeInstanceOf(
      BodyTooLargeError,
    );
  });

  it("rejects oversized bodies while streaming even with a small Content-Length", async () => {
    const oversized = new Uint8Array(UPLOAD_WRITE_JSON_MAX_BYTES + 64);
    const request = new Request("https://example.test/rpc/kbUploads/write", {
      method: "POST",
      headers: { "content-length": "10" },
      body: oversized,
    });
    await expect(readBodyWithLimit(request, UPLOAD_WRITE_JSON_MAX_BYTES)).rejects.toBeInstanceOf(
      BodyTooLargeError,
    );
  });
});

describe("aggregate body budget", () => {
  function stalledRequest(first: Uint8Array) {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(first);
        // never closes: models a slow client holding its buffered bytes
      },
    });
    return new Request("https://example.test/rpc/test", {
      method: "POST",
      body: stream,
      duplex: "half",
    } as RequestInit);
  }

  it("refuses a body that would push concurrent buffering over the budget, then releases", async () => {
    const holder = readBodyWithLimit(stalledRequest(new Uint8Array(600)), 10_000, {
      budgetBytes: 1000,
      deadlineMs: 200,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(bufferedBodyBytes()).toBe(600);
    const second = new Request("https://example.test/rpc/test", {
      method: "POST",
      body: new Uint8Array(500),
    });
    await expect(readBodyWithLimit(second, 10_000, { budgetBytes: 1000 })).rejects.toBeInstanceOf(
      BodyBudgetExceededError,
    );
    // The stalled body times out and gives its reservation back.
    await expect(holder).rejects.toBeInstanceOf(BodyReadTimeoutError);
    expect(bufferedBodyBytes()).toBe(0);
  });

  it("caps one client's concurrent share while other clients retain capacity", async () => {
    const request = () =>
      new Request("https://example.test/rpc/test", {
        method: "POST",
        body: new Uint8Array(600),
      });
    const first = await readBodyWithLimit(request(), 10_000, {
      clientKey: "a",
      clientBudgetBytes: 1000,
      budgetBytes: 3000,
    });
    await expect(
      readBodyWithLimit(request(), 10_000, {
        clientKey: "a",
        clientBudgetBytes: 1000,
        budgetBytes: 3000,
      }),
    ).rejects.toBeInstanceOf(BodyBudgetExceededError);
    const other = await readBodyWithLimit(request(), 10_000, {
      clientKey: "b",
      clientBudgetBytes: 1000,
      budgetBytes: 3000,
    });
    expect(bufferedBodyBytes()).toBe(1200);
    first.release();
    first.release();
    const retry = await readBodyWithLimit(request(), 10_000, {
      clientKey: "a",
      clientBudgetBytes: 1000,
      budgetBytes: 3000,
    });
    other.release();
    retry.release();
    expect(bufferedBodyBytes()).toBe(0);
  });

  it("releases a completed body's reservation once the handler finishes", async () => {
    const app = new Hono();
    app.use("*", bodyPolicyMiddleware());
    let during = -1;
    app.post("/rpc/test", async (c) => {
      await c.req.text();
      during = bufferedBodyBytes();
      return c.text("ok");
    });
    const response = await app.request("https://example.test/rpc/test", {
      method: "POST",
      body: "payload",
    });
    expect(response.status).toBe(200);
    expect(during).toBe(7);
    expect(bufferedBodyBytes()).toBe(0);
  });

  it("answers 408 when a body never finishes arriving", async () => {
    const result = readBodyWithLimit(stalledRequest(new Uint8Array(10)), 10_000, {
      deadlineMs: 30,
    });
    await expect(result).rejects.toBeInstanceOf(BodyReadTimeoutError);
    expect(bufferedBodyBytes()).toBe(0);
  });
});
