import { EventEmitter } from "node:events";
import type { IncomingMessage, RequestOptions } from "node:http";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchClientMetadataResource } from "./mcp-cimd";

const { lookup, request } = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup }));
vi.mock("node:https", () => ({ request }));

beforeEach(() => {
  vi.useFakeTimers();
  lookup.mockReset().mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
  request.mockReset();
});
afterEach(() => vi.useRealTimers());

function transport(statusCode: number, contentType: string) {
  const response = Object.assign(new PassThrough(), {
    headers: { "content-type": contentType },
    statusCode,
  });
  // An open body with no EOF models the rejected/stalled metadata service.
  response.on("error", () => {});
  const connection = Object.assign(new EventEmitter(), {
    end: vi.fn(),
    destroy: vi.fn((error?: Error) => {
      response.destroy(error);
      if (error) connection.emit("error", error);
      return connection;
    }),
  });
  request.mockImplementation(
    (_url: URL, options: RequestOptions, receive: (r: IncomingMessage) => void) => {
      const onAbort = () => connection.destroy(new DOMException("Aborted", "AbortError"));
      options.signal?.addEventListener("abort", onAbort, { once: true });
      response.once("close", () => options.signal?.removeEventListener("abort", onAbort));
      connection.end.mockImplementation(() => receive(response as unknown as IncomingMessage));
      return connection;
    },
  );
  return { response, connection };
}

describe("CIMD transport lifetime", () => {
  it.each([
    [200, "text/plain"],
    [503, "application/json"],
    [302, "application/json"],
    [304, ""],
  ] as const)("destroys unconsumed HTTP %s / %s responses immediately", async (status, type) => {
    const { response, connection } = transport(status, type);
    const result = await fetchClientMetadataResource("https://client.example/metadata");
    expect(result.status).toBe(status);
    expect(result.body).toBeNull();
    expect(response.destroyed).toBe(true);
    expect(connection.destroy).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("owns an absolute deadline even after headers were accepted", async () => {
    const { response, connection } = transport(200, "application/json");
    const result = await fetchClientMetadataResource("https://client.example/metadata");
    expect(response.destroyed).toBe(false);
    const body = expect(result.text()).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(5_000);
    await body;
    expect(connection.destroy).toHaveBeenCalled();
    expect(response.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses the same deadline across DNS and the response body", async () => {
    const { response } = transport(200, "application/json");
    const dns = Promise.withResolvers<Array<{ address: string; family: number }>>();
    lookup.mockReturnValue(dns.promise);
    const pending = fetchClientMetadataResource("https://client.example/metadata");
    await vi.advanceTimersByTimeAsync(4_000);
    dns.resolve([{ address: "8.8.8.8", family: 4 }]);
    const result = await pending;
    const body = expect(result.text()).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(1_000);
    await body;
    expect(response.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases its deadline on successful completion and body cancellation", async () => {
    const first = transport(200, "application/jwk-set+json; charset=utf-8");
    const result = await fetchClientMetadataResource("https://client.example/metadata");
    first.response.end("{}");
    expect(await result.text()).toBe("{}");
    expect(vi.getTimerCount()).toBe(0);
    const second = transport(200, "application/json");
    const cancelled = await fetchClientMetadataResource("https://client.example/metadata");
    await cancelled.body?.cancel();
    expect(second.response.destroyed).toBe(true);
    // Stream destruction emits close on the next tick.
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["caller", "transport"] as const)(
    "interrupts pending DNS on %s cancellation without later HTTPS",
    async (owner) => {
      const dns = Promise.withResolvers<Array<{ address: string; family: number }>>();
      lookup.mockReturnValue(dns.promise);
      const controller = new AbortController();
      const pending = fetchClientMetadataResource("https://client.example/metadata", {
        signal: controller.signal,
      });
      const outcome = expect(pending).rejects.toThrow();
      if (owner === "caller") controller.abort(new Error("cancelled"));
      else await vi.advanceTimersByTimeAsync(5_000);
      await outcome;
      dns.resolve([{ address: "8.8.8.8", family: 4 }]);
      await vi.advanceTimersByTimeAsync(0);
      expect(request).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("handles a late DNS rejection after cancellation", async () => {
    const dns = Promise.withResolvers<never>();
    lookup.mockReturnValue(dns.promise);
    const controller = new AbortController();
    const pending = fetchClientMetadataResource("https://client.example/metadata", {
      signal: controller.signal,
    });
    const outcome = expect(pending).rejects.toThrow("cancelled");
    controller.abort(new Error("cancelled"));
    await outcome;
    dns.reject(new Error("late lookup failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps every DNS answer subject to public-address admission", async () => {
    lookup.mockResolvedValue([
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);
    await expect(fetchClientMetadataResource("https://client.example/metadata")).rejects.toThrow(
      "public-routable",
    );
    expect(request).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
