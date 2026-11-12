import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import type { IncomingMessage } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { isIP } from "node:net";
import { type Readable, Transform } from "node:stream";
import { isBlockedEgressAddress, stripIpBrackets } from "./private-ip.js";

export const KB_PRIVATE_NETWORK_REJECTED = "KB_PRIVATE_NETWORK_REJECTED";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;

const ALLOWED_REQUEST_HEADERS = new Set(["accept", "content-type", "content-length"]);

export interface KbEgressPolicy {
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxBodyBytes?: number;
}

export class KbEgressError extends Error {
  constructor(message = "Outbound request failed") {
    super(message);
    this.name = "KbEgressError";
  }
}

export class KbEndpointUrlError extends Error {
  readonly reason: typeof KB_PRIVATE_NETWORK_REJECTED;

  constructor(message: string, reason: typeof KB_PRIVATE_NETWORK_REJECTED) {
    super(message);
    this.name = "KbEndpointUrlError";
    this.reason = reason;
  }
}

export type DnsLookupFn = (
  hostname: string,
  options: { all: true; verbatim?: boolean },
  callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

export type KbHttpsRequestOptions = {
  method?: string;
  headers?: Headers | Record<string, string>;
  body?: Uint8Array;
  signal?: AbortSignal;
  /** Provider API key — applied as Authorization only on the validated initial request. */
  providerBearerToken?: string;
};

type PinnedTransportOptions = {
  method?: string;
  headers?: Record<string, string>;
  body?: Uint8Array;
  signal?: AbortSignal;
  /**
   * TLS identity for the connection. Undefined for IP-literal endpoints: Node
   * then skips SNI (IPs are not valid SNI values) and verifies the
   * certificate's IP SANs against the URL host instead.
   */
  servername?: string;
};

export type KbEgressTransport = {
  request(
    url: URL,
    options: PinnedTransportOptions,
    policy: KbEgressPolicy,
    lookup: DnsLookupFn,
  ): Promise<IncomingMessage>;
};

/** Response metadata and bounded body; the raw transport stream stays private. */
export type KbHttpsResponse = Readable & Pick<IncomingMessage, "statusCode" | "headers">;

const responseLimits = new WeakMap<Readable, number>();

function combineAbortSignals(signals: (AbortSignal | undefined)[]): AbortSignal {
  const defined = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (defined.length === 0) {
    throw new Error("combineAbortSignals requires at least one signal");
  }
  if (defined.length === 1) {
    return defined[0]!;
  }
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any(defined);
  }
  const controller = new AbortController();
  for (const signal of defined) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

export function createPinnedLookup(
  policy: KbEgressPolicy,
  lookup: DnsLookupFn,
): NonNullable<RequestOptions["lookup"]> {
  return (hostname, lookupOptions, callback) => {
    lookup(hostname, { ...lookupOptions, all: true }, (error, addresses) => {
      if (error) {
        if (lookupOptions.all) {
          callback(error, []);
          return;
        }
        callback(error, "", 0);
        return;
      }
      try {
        assertResolvedAddressesSafe(addresses, policy);
      } catch (validationError) {
        const err = validationError as NodeJS.ErrnoException;
        if (lookupOptions.all) {
          callback(err, []);
          return;
        }
        callback(err, "", 0);
        return;
      }
      const selected = addresses[0];
      if (!selected) {
        const err = new Error("Hostname did not resolve") as NodeJS.ErrnoException;
        if (lookupOptions.all) {
          callback(err, []);
          return;
        }
        callback(err, "", 0);
        return;
      }
      if (lookupOptions.all) {
        callback(null, [{ address: selected.address, family: selected.family }]);
        return;
      }
      callback(null, selected.address, selected.family);
    });
  };
}

/**
 * The unbracketed IP literal behind a URL hostname, or null when the hostname
 * is a DNS name. WHATWG URL hostnames keep brackets around IPv6 literals; Node
 * TLS would compare that bracketed string against the certificate and fail, so
 * identity decisions must go through this helper.
 */
function ipLiteralFromHostname(hostname: string): string | null {
  const literal = stripIpBrackets(hostname);
  return isIP(literal) === 0 ? null : literal;
}

/**
 * Internal sender: only kbHttpsRequest may dispatch, after URL validation and
 * with mandatory request/response bounds. Fixtures inject their own transport
 * or mock the connector in the test process; no unchecked sender is exported.
 */
function defaultTransport(): KbEgressTransport {
  return {
    request(url, options, policy, lookup) {
      const { body, signal, servername, method, headers } = options;
      if (signal?.aborted) {
        // Already-aborted signals never emit another abort event; bail before
        // creating a request so zero DNS/connect/write work happens.
        return Promise.reject(new KbEgressError());
      }
      return new Promise<IncomingMessage>((resolve, reject) => {
        let settled = false;
        const fail = (error: Error) => {
          if (settled) return;
          settled = true;
          reject(error instanceof KbEgressError ? error : new KbEgressError());
        };
        const succeed = (response: IncomingMessage) => {
          if (settled) return;
          settled = true;
          resolve(response);
        };

        const req = httpsRequest(url, {
          // Never reuse global-pool sockets: they may have been connected by
          // another caller without our DNS validation. Each request must pass
          // through its own checked, pinned connection.
          agent: false,
          method,
          headers,
          // An undefined servername must stay absent, not override Node's
          // URL-derived identity (bracket handling for IPv6 literals).
          ...(servername === undefined ? {} : { servername }),
          lookup: createPinnedLookup(policy, lookup),
        });

        const abortRequest = () => {
          req.destroy(new KbEgressError());
          fail(new KbEgressError());
        };
        signal?.addEventListener("abort", abortRequest, { once: true });

        req.once("response", (response) => {
          signal?.removeEventListener("abort", abortRequest);
          const statusCode = response.statusCode ?? 0;
          if (statusCode >= 300 && statusCode < 400) {
            response.resume();
            response.destroy();
            fail(new KbEgressError());
            return;
          }
          succeed(response);
        });
        req.once("error", () => {
          signal?.removeEventListener("abort", abortRequest);
          fail(new KbEgressError());
        });
        if (body) req.end(body);
        else req.end();
      });
    },
  };
}

export function validateHttpsEndpointUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new KbEgressError("Endpoint URL is invalid");
  }
  if (url.protocol !== "https:") {
    throw new KbEgressError("Endpoint URL must use HTTPS");
  }
  if (url.username || url.password) {
    throw new KbEgressError("Endpoint URL must not contain credentials");
  }
  if (url.hash || url.search) {
    throw new KbEgressError("Endpoint URL must not contain query or fragment components");
  }
  const literalHost = ipLiteralFromHostname(url.hostname);
  if (literalHost !== null && isBlockedEgressAddress(literalHost)) {
    throw new KbEndpointUrlError(
      "Endpoint URL resolves to a private or special network",
      KB_PRIVATE_NETWORK_REJECTED,
    );
  }
  return url;
}

/**
 * Canonical HTTPS embedding endpoint fingerprint: lowercase host, explicit port when
 * non-default, path preserved. Two different providers must not collapse together.
 */
export function canonicalizeHttpsEndpointUrl(rawUrl: string): string {
  const url = validateHttpsEndpointUrl(rawUrl);
  const isDefaultPort = url.port === "" || url.port === "443";
  const portPart = isDefaultPort ? "" : `:${url.port}`;
  const host = url.hostname.toLowerCase();
  return `${url.protocol}//${host}${portPart}${url.pathname}`;
}

export function assertResolvedAddressesSafe(
  addresses: readonly Pick<LookupAddress, "address">[],
  _policy: KbEgressPolicy = {},
): void {
  if (addresses.length === 0) throw new KbEgressError();
  if (addresses.some(({ address }) => isBlockedEgressAddress(address))) {
    throw new KbEgressError();
  }
}

export function sanitizeEgressRequestHeaders(
  headers: Headers | Record<string, string> | undefined,
): Record<string, string> {
  const entries = headers instanceof Headers ? headers.entries() : Object.entries(headers ?? {});
  const sanitized: Record<string, string> = {};
  for (const [rawName, value] of entries) {
    const name = rawName.toLowerCase();
    if (ALLOWED_REQUEST_HEADERS.has(name)) {
      sanitized[name] = value;
    }
  }
  return sanitized;
}

export function redactEgressError(value: unknown): string {
  void value;
  return "Outbound request failed";
}

export async function resolveAndValidateHttpsEndpoint(
  rawUrl: string,
  lookup: DnsLookupFn = dnsLookup,
): Promise<URL> {
  const url = validateHttpsEndpointUrl(rawUrl);
  // An IP literal was already validated above; DNS would only re-derive the
  // literal (and a bracketed URL hostname is not a DNS name at all).
  if (ipLiteralFromHostname(url.hostname) !== null) return url;
  const addresses = await new Promise<LookupAddress[]>((resolve, reject) => {
    lookup(url.hostname, { all: true, verbatim: true }, (error, result) =>
      error ? reject(error) : resolve(result),
    );
  });
  assertResolvedAddressesSafe(addresses);
  return url;
}

function boundResponse(
  response: IncomingMessage,
  policy: KbEgressPolicy,
  deadline: AbortSignal,
): KbHttpsResponse {
  const maxResponse = policy.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  let received = 0;
  const bounded = Object.assign(
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        // Count raw bytes BEFORE pushing into the consumer's readable side.
        // setEncoding() there cannot change this count or expose an overflow.
        received += chunk.byteLength;
        if (received > maxResponse) callback(new KbEgressError());
        else callback(null, chunk);
      },
      destroy(error, callback) {
        deadline.removeEventListener("abort", fail);
        response.unpipe(bounded);
        response.destroy();
        callback(error ? new KbEgressError() : null);
      },
    }),
    { statusCode: response.statusCode, headers: response.headers },
  );
  const fail = () => bounded.destroy(new KbEgressError());
  responseLimits.set(bounded, maxResponse);
  // Deadline/transport failures can arrive before the consumer attaches.
  bounded.on("error", () => undefined);
  response.once("error", fail);
  response.once("close", () => {
    if (!response.readableEnded) fail();
  });
  if (deadline.aborted || (response.destroyed && !response.readableEnded)) {
    fail();
  } else {
    deadline.addEventListener("abort", fail, { once: true });
    // pipe honors the transform's bounded buffers and propagates backpressure
    // to the socket. No consumer decoding is ever applied to the raw stream.
    response.pipe(bounded);
  }
  return bounded;
}

/**
 * Bounded body reader — the owning consumption path for egress responses.
 * Reads with async iteration and optionally tightens the request's byte cap.
 * Defaults and explicit overrides can never relax the original request cap.
 * Deadline, size, transport and caller-abort failures remain redacted.
 */
export async function readBoundedResponseBody(
  response: Readable,
  policy: KbEgressPolicy = {},
): Promise<Uint8Array> {
  const requestMax = responseLimits.get(response);
  const maxResponse = Math.min(
    requestMax ?? Infinity,
    policy.maxResponseBytes ?? requestMax ?? DEFAULT_MAX_RESPONSE_BYTES,
  );
  const parts: Buffer[] = [];
  let received = 0;
  try {
    for await (const chunk of response) {
      const bytes = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk, response.readableEncoding ?? "utf8");
      received += bytes.byteLength;
      if (received > maxResponse) {
        response.destroy(new KbEgressError());
        throw new KbEgressError();
      }
      parts.push(bytes);
    }
  } catch (error) {
    throw error instanceof KbEgressError ? error : new KbEgressError();
  }
  return Buffer.concat(parts);
}

export async function kbHttpsRequest(
  rawUrl: string,
  options: KbHttpsRequestOptions,
  policy: KbEgressPolicy = {},
  deps: {
    lookup?: DnsLookupFn;
    transport?: KbEgressTransport;
  } = {},
): Promise<KbHttpsResponse> {
  // A pre-aborted signal never replays its abort event, so an unchecked
  // request would still dispatch and could send provider credentials to a
  // peer the caller already cancelled. Refuse before any transport work.
  if (options.signal?.aborted) {
    throw new KbEgressError();
  }
  const lookup = deps.lookup ?? dnsLookup;
  const transport = deps.transport ?? defaultTransport();
  const url = validateHttpsEndpointUrl(rawUrl);
  const maxBody = policy.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (options.body && options.body.byteLength > maxBody) {
    throw new KbEgressError();
  }
  const headers = sanitizeEgressRequestHeaders(options.headers);
  if (options.providerBearerToken) {
    headers.authorization = `Bearer ${options.providerBearerToken}`;
  }
  const timeoutMs = policy.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadlineSignal = AbortSignal.timeout(timeoutMs);
  const signal = combineAbortSignals(
    [options.signal, deadlineSignal].filter((value): value is AbortSignal => value !== undefined),
  );

  try {
    const response = await Promise.race([
      transport.request(
        url,
        {
          method: options.method,
          headers,
          body: options.body,
          signal,
          // Separate URL serialization from connection identity: hostname
          // endpoints pin the original validated host; IP literals omit the
          // servername so Node skips SNI and verifies the certificate's IP
          // SANs against the URL host.
          servername: ipLiteralFromHostname(url.hostname) === null ? url.hostname : undefined,
        },
        policy,
        lookup,
      ),
      new Promise<IncomingMessage>((_resolve, reject) => {
        // Abort events are not replayed: an already-aborted signal must settle
        // the race now, or a cancelled request could outrun its deadline.
        if (signal.aborted) {
          reject(new KbEgressError());
          return;
        }
        signal.addEventListener("abort", () => reject(new KbEgressError()), { once: true });
      }),
    ]);
    return boundResponse(response, policy, signal);
  } catch (error) {
    throw error instanceof KbEgressError ? error : new KbEgressError();
  }
}
