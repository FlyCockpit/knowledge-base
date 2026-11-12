import type { IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import { isGlobalEgressAddress } from "@knowledge-base/config/egress-address";
import { describe, expect, it } from "vitest";
import * as egress from "./egress.js";
import {
  assertResolvedAddressesSafe,
  canonicalizeHttpsEndpointUrl,
  createPinnedLookup,
  type DnsLookupFn,
  KbEgressError,
  type KbEgressTransport,
  kbHttpsRequest,
  readBoundedResponseBody,
  redactEgressError,
  resolveAndValidateHttpsEndpoint,
  sanitizeEgressRequestHeaders,
  validateHttpsEndpointUrl,
} from "./egress.js";
import egressPrefixes from "./fixtures/egress-prefixes.json";

const publicLookup: DnsLookupFn = (_hostname, _options, callback) => {
  callback(null, [{ address: "93.184.216.34", family: 4 }]);
};

function resolvingTransport(
  hooks: {
    onRequest?: (input: {
      hostname: string;
      addresses: { address: string; family: number }[];
      servername?: string;
      headers: Record<string, string>;
    }) => void;
    statusCode?: number;
  } = {},
): KbEgressTransport {
  return {
    request(url, options, policy, innerLookup) {
      const headers = (options.headers ?? {}) as Record<string, string>;
      return new Promise((resolve, reject) => {
        innerLookup(url.hostname, { all: true }, (error, addresses) => {
          if (error) return reject(error);
          try {
            assertResolvedAddressesSafe(addresses, policy);
          } catch (validationError) {
            return reject(validationError);
          }
          hooks.onRequest?.({
            hostname: url.hostname,
            addresses,
            servername: options.servername,
            headers,
          });
          const statusCode = hooks.statusCode ?? 204;
          if (statusCode >= 300 && statusCode < 400) {
            reject(new KbEgressError());
            return;
          }
          const response = Object.assign(new PassThrough(), { statusCode, headers: {} });
          response.end();
          resolve(response as unknown as IncomingMessage);
        });
      });
    },
  };
}

/** Transport that resolves with a real Node stream so stream-mode semantics are exercised honestly. */
function streamingTransport(setup: (stream: PassThrough) => void): {
  transport: KbEgressTransport;
  streams: PassThrough[];
} {
  const streams: PassThrough[] = [];
  const transport: KbEgressTransport = {
    request(url, options, policy, innerLookup) {
      void options;
      return new Promise((resolve, reject) => {
        innerLookup(url.hostname, { all: true }, (error, addresses) => {
          if (error) return reject(error);
          try {
            assertResolvedAddressesSafe(addresses, policy);
          } catch (validationError) {
            return reject(validationError);
          }
          const stream = new PassThrough();
          streams.push(stream);
          resolve(
            Object.assign(stream, { statusCode: 200, headers: {} }) as unknown as IncomingMessage,
          );
          setup(stream);
        });
      });
    },
  };
  return { transport, streams };
}

describe("kb https endpoint policy", () => {
  it("does not export an unchecked request transport", () => {
    expect(egress).not.toHaveProperty("defaultTransport");
  });

  it.each([
    "http://example.com/v1",
    "http://127.0.0.1/v1",
    "https://127.0.0.1/v1",
    "https://10.0.0.1/v1",
    "https://169.254.169.254/v1",
    "https://[::1]/v1",
    "https://[::ffff:127.0.0.1]/v1",
  ])("rejects %s through the exported request API before DNS/connect", async (url) => {
    let lookups = 0;
    const lookup: DnsLookupFn = () => {
      lookups += 1;
      throw new Error("Rejected endpoints must never resolve");
    };
    await expect(
      kbHttpsRequest(
        url,
        { providerBearerToken: "never-sent-canary", body: Buffer.from("never-sent-body") },
        {},
        { lookup },
      ),
    ).rejects.toThrow(/HTTPS|private/u);
    expect(lookups).toBe(0);
  });

  it("requires HTTPS and forbids credentials, query, and fragment", () => {
    expect(() => validateHttpsEndpointUrl("http://example.com")).toThrow(/HTTPS/u);
    expect(() => validateHttpsEndpointUrl("https://user:pass@example.com")).toThrow(/credentials/u);
    expect(() => validateHttpsEndpointUrl("https://example.com?q=1")).toThrow(/query/u);
    expect(() => validateHttpsEndpointUrl("https://127.0.0.1")).toThrow(/private/u);
    expect(() => validateHttpsEndpointUrl("https://[fec1::1]/")).toThrow(/private/u);
    expect(() => validateHttpsEndpointUrl("https://[::169.254.169.254]/")).toThrow(/private/u);
    expect(validateHttpsEndpointUrl("https://api.example.com/v1/embeddings").href).toBe(
      "https://api.example.com/v1/embeddings",
    );
  });

  it("canonicalizes hosts without conflating ports or paths", () => {
    const a = canonicalizeHttpsEndpointUrl("https://API.EXAMPLE.com:8443/v1/embeddings");
    const b = canonicalizeHttpsEndpointUrl("https://api.example.com:9443/v1/embeddings");
    const c = canonicalizeHttpsEndpointUrl("https://api.example.com:8443/v2/embeddings");
    expect(a).toBe("https://api.example.com:8443/v1/embeddings");
    expect(b).toBe("https://api.example.com:9443/v1/embeddings");
    expect(c).toBe("https://api.example.com:8443/v2/embeddings");
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("drops inbound authorization and cookies from sanitized headers", () => {
    expect(
      sanitizeEgressRequestHeaders({
        authorization: "Bearer inbound-secret",
        cookie: "session=bad",
        accept: "application/json",
        "content-type": "application/json",
      }),
    ).toEqual({ accept: "application/json", "content-type": "application/json" });
  });

  it("rejects mixed DNS answers", () => {
    expect(() =>
      assertResolvedAddressesSafe([
        { address: "93.184.216.34", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ]),
    ).toThrow();
    expect(() =>
      assertResolvedAddressesSafe([{ address: "::ffff:a9fe:a9fe", family: 6 }]),
    ).toThrow();
    expect(() => assertResolvedAddressesSafe([{ address: "fec1::1", family: 6 }])).toThrow();
    expect(() =>
      assertResolvedAddressesSafe([{ address: "::169.254.169.254", family: 6 }]),
    ).toThrow();
  });

  it("redacts credential-looking error text", () => {
    const redacted = redactEgressError("authorization: Bearer-secret token=token-abcdefgh");
    expect(redacted).not.toContain("Bearer-secret");
    expect(redacted).not.toContain("token-abcdefgh");
  });

  it("rejects redirects without forwarding provider credentials", async () => {
    let observed: Record<string, string> = {};
    const transport = resolvingTransport({
      statusCode: 302,
      onRequest: ({ headers }) => {
        observed = headers;
      },
    });
    await expect(
      kbHttpsRequest(
        "https://redirect.test/v1",
        {
          method: "GET",
          providerBearerToken: "must-not-forward",
        },
        { timeoutMs: 500 },
        { lookup: publicLookup, transport },
      ),
    ).rejects.toThrow("Outbound request failed");
    expect(observed.authorization).toBe("Bearer must-not-forward");
  });

  it("pins the first approved address and keeps the TLS servername on the original host", async () => {
    const pinned: string[] = [];
    const servernames: string[] = [];
    const lookup: DnsLookupFn = (hostname, _options, callback) => {
      if (hostname === "rebind.test") {
        callback(null, [{ address: "93.184.216.34", family: 4 }]);
        return;
      }
      callback(null, [{ address: "127.0.0.1", family: 4 }]);
    };
    const transport = resolvingTransport({
      onRequest: ({ addresses, servername }) => {
        pinned.push(addresses[0]?.address ?? "");
        servernames.push(servername ?? "");
      },
    });
    await kbHttpsRequest(
      "https://rebind.test/v1/embeddings",
      { method: "GET" },
      {},
      { lookup, transport },
    );
    expect(pinned).toEqual(["93.184.216.34"]);
    expect(servernames).toEqual(["rebind.test"]);
  });

  it("omits SNI for public IP-literal endpoints and pins it for hostnames", async () => {
    const seen: (string | undefined)[] = [];
    const transport = resolvingTransport({
      onRequest: ({ servername }) => {
        seen.push(servername);
      },
    });
    await kbHttpsRequest(
      "https://93.184.216.34/v1",
      { method: "GET" },
      {},
      { lookup: publicLookup, transport },
    );
    await kbHttpsRequest(
      "https://[2606:4700::1111]/v1",
      { method: "GET" },
      {},
      { lookup: publicLookup, transport },
    );
    await kbHttpsRequest(
      "https://api.example.com/v1",
      { method: "GET" },
      {},
      { lookup: publicLookup, transport },
    );
    // Bracketed IPv6 hostnames must never reach TLS identity: Node would
    // compare the bracketed string against the certificate and fail.
    expect(seen).toEqual([undefined, undefined, "api.example.com"]);
  });

  it("skips DNS for validated IP-literal endpoints", async () => {
    let calls = 0;
    const lookup: DnsLookupFn = () => {
      calls += 1;
    };
    const url = await resolveAndValidateHttpsEndpoint("https://[2606:4700::1111]/v1", lookup);
    expect(url.href).toBe("https://[2606:4700::1111]/v1");
    expect(calls).toBe(0);
  });

  it("rejects a lookup that flips to a private address on a later resolution", async () => {
    let calls = 0;
    const lookup: DnsLookupFn = (_hostname, _options, callback) => {
      calls += 1;
      if (calls === 1) {
        callback(null, [{ address: "93.184.216.34", family: 4 }]);
        return;
      }
      callback(null, [{ address: "127.0.0.1", family: 4 }]);
    };
    const transport = resolvingTransport();
    await kbHttpsRequest("https://safe.test/v1", { method: "GET" }, {}, { lookup, transport });
    await expect(
      kbHttpsRequest("https://safe.test/v1", { method: "GET" }, {}, { lookup, transport }),
    ).rejects.toThrow("Outbound request failed");
  });

  it("bounds stalled requests", async () => {
    const transport: KbEgressTransport = {
      request() {
        return new Promise(() => {
          // Intentionally never settles; kbHttpsRequest timeout should win.
        });
      },
    };
    await expect(
      kbHttpsRequest(
        "https://slow.test/v1",
        { method: "GET" },
        { timeoutMs: 20 },
        { lookup: publicLookup, transport },
      ),
    ).rejects.toThrow("Outbound request failed");
  });

  it("sends provider bearer credentials on the validated initial request", async () => {
    let observed: Record<string, string> = {};
    const transport = resolvingTransport({
      onRequest: ({ headers }) => {
        observed = headers;
      },
    });
    await kbHttpsRequest(
      "https://provider.test/v1",
      { method: "POST", providerBearerToken: "disposable-canary" },
      {},
      { lookup: publicLookup, transport },
    );
    expect(observed.authorization).toBe("Bearer disposable-canary");
  });

  it("ignores caller attempts to override host, path, or auth after validation", async () => {
    let hostname = "";
    const transport = resolvingTransport({
      onRequest: ({ hostname: seen }) => {
        hostname = seen;
      },
    });
    await kbHttpsRequest(
      "https://api.example.com/v1/embeddings",
      {
        method: "GET",
        // @ts-expect-error — runtime must not forward override fields to the transport.
        host: "127.0.0.1",
        path: "/evil",
        auth: "user:pass",
      },
      {},
      { lookup: publicLookup, transport },
    );
    expect(hostname).toBe("api.example.com");
  });

  it("honors lookup all=true with a single approved address", async () => {
    const lookup: DnsLookupFn = (_hostname, _options, callback) => {
      callback(null, [{ address: "93.184.216.34", family: 4 }]);
    };
    const pinned = createPinnedLookup({}, lookup);
    await new Promise<void>((resolve, reject) => {
      pinned("example.com", { all: true }, (error, addresses) => {
        try {
          expect(error).toBeNull();
          expect(addresses).toEqual([{ address: "93.184.216.34", family: 4 }]);
          resolve();
        } catch (caught) {
          reject(caught);
        }
      });
    });
  });

  it("rejects oversized request bodies", async () => {
    await expect(
      kbHttpsRequest(
        "https://api.example.com/v1",
        { method: "POST", body: new Uint8Array(3 * 1024 * 1024) },
        { maxBodyBytes: 1024 },
        { lookup: publicLookup, transport: resolvingTransport() },
      ),
    ).rejects.toThrow("Outbound request failed");
  });
});

describe("kb egress response bodies (real streams)", () => {
  it.each(["direct", "reader-default", "reader-larger"])(
    "enforces raw byte limits before decoding with %s consumption",
    async (consumer) => {
      for (const [body, encoding] of [
        [Buffer.alloc(128, "a"), "utf8"],
        [Buffer.from("€€€"), "utf8"],
        // UTF-16 decoding drops the incomplete final byte. Recounting decoded
        // strings would miss this overflow even with the right encoding.
        [Buffer.alloc(9), "utf16le"],
      ] as const) {
        const { transport, streams } = streamingTransport((stream) => stream.end(body));
        const response = await kbHttpsRequest(
          "https://api.example.com/v1",
          {},
          { maxResponseBytes: 8, timeoutMs: 2000 },
          { lookup: publicLookup, transport },
        );
        response.setEncoding(encoding);
        let deliveredBytes = 0;
        const consume = async () => {
          if (consumer === "direct") {
            for await (const chunk of response)
              deliveredBytes += Buffer.byteLength(chunk, encoding);
          } else {
            const body = await readBoundedResponseBody(
              response,
              consumer === "reader-larger" ? { maxResponseBytes: 1024 } : undefined,
            );
            deliveredBytes += body.byteLength;
          }
        };
        await expect(consume()).rejects.toThrow("Outbound request failed");
        expect(deliveredBytes).toBeLessThanOrEqual(8);
        expect(response.destroyed).toBe(true);
        expect(streams[0]?.destroyed).toBe(true);
      }
    },
  );

  it.each(["direct", "reader"])("preserves exact-limit multibyte text for %s", async (consumer) => {
    const original = Buffer.from("€😀");
    const { transport } = streamingTransport((stream) => {
      stream.write(original.subarray(0, 2));
      stream.end(original.subarray(2));
    });
    const response = await kbHttpsRequest(
      "https://api.example.com/v1",
      {},
      { maxResponseBytes: original.byteLength, timeoutMs: 2000 },
      { lookup: publicLookup, transport },
    );
    response.setEncoding("utf8");
    let text = "";
    if (consumer === "direct") {
      for await (const chunk of response) text += chunk;
    } else {
      text = Buffer.from(await readBoundedResponseBody(response)).toString("utf8");
    }
    expect(text).toBe("€😀");
  });

  it("lets the reader tighten the request cap and disposes the source", async () => {
    const { transport, streams } = streamingTransport((stream) => stream.write("123456789"));
    const response = await kbHttpsRequest(
      "https://api.example.com/v1",
      {},
      { maxResponseBytes: 16, timeoutMs: 2000 },
      { lookup: publicLookup, transport },
    );
    await expect(readBoundedResponseBody(response, { maxResponseBytes: 8 })).rejects.toThrow(
      "Outbound request failed",
    );
    expect(streams[0]?.destroyed).toBe(true);
  });

  it.each([undefined, new Error("private-upstream-canary")])(
    "redacts source errors and rejects premature close (%s)",
    async (error) => {
      const { transport, streams } = streamingTransport(() => undefined);
      const response = await kbHttpsRequest(
        "https://api.example.com/v1",
        {},
        { timeoutMs: 2000 },
        { lookup: publicLookup, transport },
      );
      const reading = readBoundedResponseBody(response);
      streams[0]!.destroy(error);
      await expect(reading).rejects.toThrow("Outbound request failed");
      expect(response.destroyed).toBe(true);
    },
  );

  it("propagates backpressure and consumer disposal to the raw stream", async () => {
    const { transport, streams } = streamingTransport((stream) => {
      for (let part = 0; part < 32; part += 1) stream.write(Buffer.alloc(8 * 1024));
      stream.end();
    });
    const response = await kbHttpsRequest(
      "https://api.example.com/v1",
      {},
      { timeoutMs: 2000 },
      { lookup: publicLookup, transport },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(streams[0]?.isPaused()).toBe(true);
    expect(streams[0]?.readableEnded).toBe(false);
    response.destroy();
    expect(streams[0]?.destroyed).toBe(true);
  });

  it("keeps the response paused so a delayed consumer still reads the whole body", async () => {
    const { transport } = streamingTransport((stream) => {
      stream.write("complete-");
      stream.end("body");
    });
    const response = await kbHttpsRequest(
      "https://api.example.com/v1",
      { method: "GET" },
      { timeoutMs: 2000 },
      { lookup: publicLookup, transport },
    );
    // The accounting bound must not consume the body while nobody reads it.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const body = await readBoundedResponseBody(response);
    expect(Buffer.from(body).toString("utf8")).toBe("complete-body");
  });

  it("reads the whole body for an immediate consumer iterating directly", async () => {
    const { transport } = streamingTransport((stream) => {
      stream.end("immediate-body");
    });
    const response = await kbHttpsRequest(
      "https://api.example.com/v1",
      { method: "GET" },
      { timeoutMs: 2000 },
      { lookup: publicLookup, transport },
    );
    let got = "";
    for await (const chunk of response) {
      got += chunk.toString();
    }
    expect(got).toBe("immediate-body");
  });

  it("destroys manual consumption that exceeds maxResponseBytes (armed bound)", async () => {
    const { transport, streams } = streamingTransport((stream) => {
      stream.write(Buffer.alloc(512));
      stream.end(Buffer.alloc(512));
    });
    const response = await kbHttpsRequest(
      "https://api.example.com/v1",
      { method: "GET" },
      { maxResponseBytes: 600, timeoutMs: 2000 },
      { lookup: publicLookup, transport },
    );
    await expect(
      (async () => {
        for await (const _chunk of response) {
          // Drain; the armed bound must destroy the response mid-iteration.
        }
      })(),
    ).rejects.toThrow("Outbound request failed");
    expect(streams[0]?.destroyed).toBe(true);
  });

  it("readBoundedResponseBody rejects oversized bodies and destroys the stream", async () => {
    const { transport, streams } = streamingTransport((stream) => {
      stream.write(Buffer.alloc(512));
      stream.write(Buffer.alloc(512));
      stream.end();
    });
    const response = await kbHttpsRequest(
      "https://api.example.com/v1",
      { method: "GET" },
      { maxResponseBytes: 600, timeoutMs: 2000 },
      { lookup: publicLookup, transport },
    );
    await expect(readBoundedResponseBody(response, { maxResponseBytes: 600 })).rejects.toThrow(
      "Outbound request failed",
    );
    expect(streams[0]?.destroyed).toBe(true);
  });

  it("destroys a body that outlives the deadline and fails the reader", async () => {
    const { transport, streams } = streamingTransport(() => {
      // Never emits, never ends: only the deadline can end this body.
    });
    const response = await kbHttpsRequest(
      "https://api.example.com/v1",
      { method: "GET" },
      { timeoutMs: 40 },
      { lookup: publicLookup, transport },
    );
    await expect(readBoundedResponseBody(response)).rejects.toThrow("Outbound request failed");
    expect(streams[0]?.destroyed).toBe(true);
  });

  it("destroys the response when the caller aborts mid-body", async () => {
    const controller = new AbortController();
    const { transport, streams } = streamingTransport((stream) => {
      stream.write("part-1");
    });
    const response = await kbHttpsRequest(
      "https://api.example.com/v1",
      { method: "GET", signal: controller.signal },
      { timeoutMs: 5000 },
      { lookup: publicLookup, transport },
    );
    controller.abort();
    await expect(readBoundedResponseBody(response)).rejects.toThrow("Outbound request failed");
    expect(streams[0]?.destroyed).toBe(true);
  });
});

describe("kb egress cancellation (real transport)", () => {
  it("performs zero DNS work for a pre-aborted request", async () => {
    let lookupCalls = 0;
    const lookup: DnsLookupFn = (_hostname, _options, callback) => {
      lookupCalls += 1;
      callback(null, [{ address: "93.184.216.34", family: 4 }]);
    };
    const controller = new AbortController();
    controller.abort();
    await expect(
      kbHttpsRequest(
        "https://abort.test/v1",
        {
          method: "POST",
          body: new Uint8Array([1]),
          providerBearerToken: "never-sent-canary",
          signal: controller.signal,
        },
        { timeoutMs: 1000 },
        { lookup },
      ),
    ).rejects.toThrow("Outbound request failed");
    expect(lookupCalls).toBe(0);
  });

  it("destroys a response handed over after the abort already fired", async () => {
    const controller = new AbortController();
    const { transport } = streamingTransport((stream) => {
      stream.end("handed-over");
    });
    const pending = kbHttpsRequest(
      "https://api.example.com/v1",
      { method: "GET", signal: controller.signal },
      { timeoutMs: 5000 },
      { lookup: publicLookup, transport },
    );
    // Abort after the transport resolved but before the response handoff runs.
    controller.abort();
    const response = await pending;
    expect(response.destroyed).toBe(true);
  });
});

it("matches the shared exhaustive IPv4 prefix boundaries and embedded forms", () => {
  const numeric = (address: string) =>
    address.split(".").reduce((v, octet) => v * 256 + Number(octet), 0);
  const address = (v: number) =>
    [24, 16, 8, 0].map((shift) => Math.floor(v / 2 ** shift) % 256).join(".");
  const ranges = egressPrefixes.blockedRanges.map(([start, end]) => [
    numeric(String(start)),
    numeric(String(end)),
  ]);
  const cases = new Set<number>();
  for (const [start, end] of ranges) {
    if (start === undefined || end === undefined) throw new Error("invalid corpus range");
    for (const v of [start - 1, start, start + 1, end - 1, end, end + 1]) {
      if (v >= 0 && v <= 0xffffffff) cases.add(v);
    }
  }
  const sweep = egressPrefixes.sweep;
  for (let third = sweep.thirdFrom; third <= sweep.thirdTo; third++) {
    for (const last of sweep.lastOctets) cases.add(numeric(`${sweep.prefix}.${third}.${last}`));
  }
  for (const value of cases) {
    const ip = address(value);
    const expected =
      sweep.exceptions.includes(ip) ||
      !ranges.some(
        ([start, end]) =>
          start !== undefined && end !== undefined && value >= start && value <= end,
      );
    const hex = ip.split(".").map((octet) => Number(octet).toString(16).padStart(2, "0"));
    for (const form of [ip, `::ffff:${ip}`, `64:ff9b::${hex[0]}${hex[1]}:${hex[2]}${hex[3]}`])
      expect(isGlobalEgressAddress(form), form).toBe(expected);
  }
});
