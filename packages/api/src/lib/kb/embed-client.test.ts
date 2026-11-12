import { Readable } from "node:stream";
import { Secret } from "@knowledge-base/env/secret";
import { describe, expect, it, vi } from "vitest";
import type { kbHttpsRequest } from "./egress";
import { requestOpenAiEmbeddings, validateEmbeddings } from "./embed-client";

const config = {
  endpointUrl: "https://example.com:8443/exact/embed",
  model: "m",
  dimensions: 2,
  apiKey: new Secret("fixture-canary"),
};
describe("embedding validation", () => {
  it("accepts only a complete permutation and restores source order with the RAW values", () => {
    const result = validateEmbeddings(
      {
        data: [
          { index: 1, embedding: [0, 2] },
          { index: 0, embedding: [3, 4] },
        ],
      },
      2,
      2,
    );
    // Neither rounded nor normalized: the index format normalizes exactly once (§1.4).
    expect(result).toEqual([
      [3, 4],
      [0, 2],
    ]);
  });
  it("returns the exact input numbers, never f32-rounded (0.1, 1/3 and 0.7 are not f32 values)", () => {
    const raw = [0.1, 1 / 3, 0.7];
    for (const value of raw) expect(Math.fround(value)).not.toBe(value);
    const [vector] = validateEmbeddings({ data: [{ index: 0, embedding: raw }] }, 1, 3);
    expect(vector).toHaveLength(3);
    for (const [i, value] of vector!.entries()) expect(value === raw[i]).toBe(true);
  });
  it.each([[0, 0], [0], [-1, 0], [0, 2], [0.5, 1]])(
    "rejects non-permutation indices %j",
    (...indices) => {
      const data = indices.map((index) => ({ index, embedding: [1, 2] }));
      expect(() => validateEmbeddings({ data }, 2, 2)).toThrow("Embedding provider unavailable");
    },
  );
  it.each([[0, 0], [NaN, 1], [Infinity, 1], [1e39, 1], [1e-50, 0], [1], [], [1, 2, 3]])(
    "rejects malformed vector %j",
    (...embedding) => {
      expect(() => validateEmbeddings({ data: [{ index: 0, embedding }] }, 1, 2)).toThrow();
    },
  );
  it("accepts dimensions 1 and 2000, rejects 0 and 2001, and declared mismatch", () => {
    for (const dimensions of [1, 2000]) {
      const [vector] = validateEmbeddings(
        { data: [{ index: 0, embedding: Array(dimensions).fill(1) }] },
        1,
        dimensions,
      );
      expect(vector).toEqual(Array(dimensions).fill(1));
    }
    for (const dimensions of [0, 2001])
      expect(() =>
        validateEmbeddings(
          { data: [{ index: 0, embedding: Array(dimensions).fill(1) }] },
          1,
          dimensions,
        ),
      ).toThrow();
  });
  it("empty input emits no network request; exact URL and explicit key are used once", async () => {
    const request = vi.fn<typeof kbHttpsRequest>().mockResolvedValue(
      Object.assign(Readable.from([Buffer.from('{"data":[{"index":0,"embedding":[3,4]}]}')]), {
        statusCode: 200,
        headers: {},
      }),
    );
    expect(await requestOpenAiEmbeddings(config, [], undefined, request)).toEqual([]);
    expect(request).not.toHaveBeenCalled();
    expect(await requestOpenAiEmbeddings(config, ["text"], undefined, request)).toEqual([[3, 4]]);
    expect(request).toHaveBeenCalledTimes(1);
    const [url, options] = request.mock.calls[0]!;
    expect(url).toBe(config.endpointUrl);
    expect(options.providerBearerToken).toBe(config.apiKey.reveal());
    expect(JSON.parse(Buffer.from(options.body!).toString())).toEqual({
      model: "m",
      dimensions: 2,
      input: ["text"],
      encoding_format: "float",
    });
  });
  it("fails closed on provider errors, HTTP failures, cancellation, oversized input and never probes suffixes", async () => {
    const request = vi
      .fn<typeof kbHttpsRequest>()
      .mockRejectedValue(new Error("fixture-canary response body"));
    await expect(requestOpenAiEmbeddings(config, ["x"], undefined, request)).rejects.toThrow(
      /^Embedding provider unavailable$/,
    );
    expect(request).toHaveBeenCalledTimes(1);
    const response = Object.assign(Readable.from([]), { statusCode: 401, headers: {} });
    request.mockResolvedValue(response);
    await expect(requestOpenAiEmbeddings(config, ["x"], undefined, request)).rejects.toThrow();
    expect(response.destroyed).toBe(true);
    request.mockClear();
    for (const [texts, signal] of [
      [Array(33).fill("x"), undefined],
      [["x"], AbortSignal.abort()],
    ] as const)
      await expect(requestOpenAiEmbeddings(config, texts, signal, request)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it("names the failure for the owner's probe without provider text", async () => {
    const reply = (statusCode: number, body: string) =>
      Object.assign(Readable.from([Buffer.from(body)]), { statusCode, headers: {} });
    const reasonOf = async (request: typeof kbHttpsRequest) => {
      try {
        await requestOpenAiEmbeddings(config, ["x"], undefined, request);
      } catch (error) {
        return (error as { reason?: unknown }).reason;
      }
      throw new Error("expected a failure");
    };
    expect(
      await reasonOf(vi.fn<typeof kbHttpsRequest>().mockRejectedValue(new Error("ENOTFOUND"))),
    ).toEqual({ kind: "unreachable" });
    expect(
      await reasonOf(vi.fn<typeof kbHttpsRequest>().mockResolvedValue(reply(401, "secret text"))),
    ).toEqual({ kind: "http_status", status: 401 });
    expect(
      await reasonOf(
        vi
          .fn<typeof kbHttpsRequest>()
          .mockResolvedValue(reply(200, '{"data":[{"index":0,"embedding":[1,2,3]}]}')),
      ),
    ).toEqual({ kind: "dimension_mismatch", received: 3 });
    expect(
      await reasonOf(vi.fn<typeof kbHttpsRequest>().mockResolvedValue(reply(200, "<html>"))),
    ).toEqual({ kind: "bad_response" });
  });
});
