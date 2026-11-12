import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import type { ClientMetadataResourceFetch } from "@better-auth/oauth-provider";
import { isGlobalEgressAddress } from "@knowledge-base/config/egress-address";

const EXCHANGE_DEADLINE_MS = 5_000;
// Match the CIMD consumer's accepted media types before handing over a body.
const JSON_CONTENT_TYPE = /^application\/(?:[-\w.]+\+)?json\s*(?:;|$)/i;

/** DNS itself is not cancellable; detach promptly, retaining both settlement handlers. */
function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => reject(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
    if (signal.aborted) cancel();
  });
}

/** Every DNS answer is checked once, then pinned at the actual TLS connection. */
export const fetchClientMetadataResource: ClientMetadataResourceFetch = async (input, init) => {
  const req = new Request(input, init);
  const url = new URL(req.url);
  if (url.protocol !== "https:" || url.username || url.password || url.hash)
    throw new TypeError("CIMD requires an HTTPS URL without credentials or fragments");
  if (req.method !== "GET" && req.method !== "HEAD")
    throw new TypeError("CIMD requires GET or HEAD");
  req.signal.throwIfAborted();
  const lifetime = new AbortController();
  const cancel = () => lifetime.abort(req.signal.reason);
  req.signal.addEventListener("abort", cancel, { once: true });
  if (req.signal.aborted) cancel();
  // This absolute deadline survives the consumer clearing its own header-fetch timer.
  const deadline = setTimeout(
    () => lifetime.abort(new DOMException("CIMD exchange deadline exceeded", "TimeoutError")),
    EXCHANGE_DEADLINE_MS,
  );
  deadline.unref();
  const release = () => {
    clearTimeout(deadline);
    req.signal.removeEventListener("abort", cancel);
  };
  const signal = lifetime.signal;
  try {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(host)
      ? [{ address: host, family: isIP(host) }]
      : await abortable(lookup(host, { all: true, verbatim: true }), signal);
    if (!addresses.length || addresses.some(({ address }) => !isGlobalEgressAddress(address)))
      throw new TypeError("CIMD requires public-routable addresses");
    signal.throwIfAborted();
    const selected = addresses[0]!;
    return await new Promise<Response>((resolve, reject) => {
      const connection = request(
        url,
        {
          agent: false,
          method: req.method,
          headers: { ...Object.fromEntries(req.headers), host: url.host },
          servername: isIP(host) ? undefined : host,
          signal,
          lookup: (_hostname, options, callback) => {
            if (options.all) callback(null, [selected]);
            else callback(null, selected.address, selected.family);
          },
        },
        (response) => {
          response.once("end", release);
          response.once("close", release);
          try {
            const headers = new Headers();
            for (const [name, value] of Object.entries(response.headers)) {
              if (Array.isArray(value)) for (const item of value) headers.append(name, item);
              else if (value !== undefined) headers.set(name, value);
            }
            const status = response.statusCode ?? 500;
            const unconsumed =
              status !== 200 || !JSON_CONTENT_TYPE.test(headers.get("content-type") ?? "");
            const noBody = unconsumed || req.method === "HEAD";
            const result = new Response(
              noBody ? null : (Readable.toWeb(response) as ReadableStream<Uint8Array>),
              { status, headers },
            );
            if (noBody) {
              response.destroy();
              connection.destroy();
              release();
            }
            resolve(result);
          } catch (error) {
            response.destroy();
            connection.destroy();
            release();
            reject(error);
          }
        },
      );
      connection.once("error", (error) => {
        release();
        reject(error);
      });
      connection.end();
    });
  } catch (error) {
    release();
    throw error;
  }
};
