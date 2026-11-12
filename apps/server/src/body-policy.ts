import type { Context, MiddlewareHandler } from "hono";

/** MCP tool HTTP surface stays at 1 MiB. */
export const MCP_MAX_BODY_BYTES = 1024 * 1024;

/** Default oRPC / form JSON cap — unchanged from the prior global middleware. */
const DEFAULT_HTTP_BODY_BYTES = 10 * 1024 * 1024;

/** Bounded upload write frames (base64 + JSON envelope), well under MCP cap. */
export const UPLOAD_WRITE_JSON_MAX_BYTES = 512 * 1024;

/** oRPC encodes `kbUploads.write` as `/rpc/kbUploads/write` (and `/__batch__` variants). */
function isKbUploadWriteRpcPath(pathname: string): boolean {
  const path = pathname.split("?")[0] ?? pathname;
  return /\/rpc\/kbUploads\/write(?:\/__batch__)?$/.test(path);
}

export function maxBodyBytesForPath(pathname: string): number {
  const path = pathname.split("?")[0] ?? pathname;
  if (path.startsWith("/mcp") || path.includes("/mcp/")) {
    return MCP_MAX_BODY_BYTES;
  }
  if (isKbUploadWriteRpcPath(path)) {
    return UPLOAD_WRITE_JSON_MAX_BYTES;
  }
  return DEFAULT_HTTP_BODY_BYTES;
}

/**
 * Process-wide bound on request bytes buffered by this middleware at once. The
 * per-request cap alone lets many concurrent near-cap bodies (rate limiters and
 * auth run only after buffering) pin unbounded memory. Over budget → 503.
 */
const AGGREGATE_BUFFERED_BODY_BYTES = 64 * 1024 * 1024;
const CLIENT_BUFFERED_BODY_BYTES = 16 * 1024 * 1024;
const clientBufferedBytes = new Map<string, number>();
/** A body that has not finished arriving by then is abandoned (408). */
const BODY_READ_DEADLINE_MS = 30_000;

let bufferedBytes = 0;
/** Test hook: bytes currently reserved by in-flight bodies. */
export function bufferedBodyBytes(): number {
  return bufferedBytes;
}

export class BodyBudgetExceededError extends Error {
  constructor() {
    super("Server is busy buffering other request bodies");
    this.name = "BodyBudgetExceededError";
  }
}

export class BodyReadTimeoutError extends Error {
  constructor() {
    super("Request body was not received in time");
    this.name = "BodyReadTimeoutError";
  }
}

export class BodyTooLargeError extends Error {
  readonly maxBytes: number;
  constructor(maxBytes: number) {
    super("Request body exceeds limit");
    this.name = "BodyTooLargeError";
    this.maxBytes = maxBytes;
  }
}

/**
 * Reads the full body while enforcing a byte cap before buffering completes.
 * Bytes count against the process-wide budget as they arrive; the caller owns
 * the returned reservation and must call `release()` once the body is no
 * longer referenced. On any failure the reservation is released here.
 */
export async function readBodyWithLimit(
  request: Request,
  maxBytes: number,
  options: {
    budgetBytes?: number;
    clientKey?: string;
    clientBudgetBytes?: number;
    deadlineMs?: number;
  } = {},
): Promise<{ buffer: ArrayBuffer; release: () => void }> {
  const budget = options.budgetBytes ?? AGGREGATE_BUFFERED_BODY_BYTES;
  const clientKey = options.clientKey ?? "unknown";
  const clientBudget = options.clientBudgetBytes ?? CLIENT_BUFFERED_BODY_BYTES;
  const deadlineMs = options.deadlineMs ?? BODY_READ_DEADLINE_MS;
  let reserved = 0;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    bufferedBytes -= reserved;
    const remaining = (clientBufferedBytes.get(clientKey) ?? 0) - reserved;
    if (remaining > 0) clientBufferedBytes.set(clientKey, remaining);
    else clientBufferedBytes.delete(clientKey);
  };
  const body = request.body;
  if (!body) return { buffer: new ArrayBuffer(0), release };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BodyReadTimeoutError()), deadlineMs);
  });
  timedOut.catch(() => {});
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), timedOut]);
      if (done) break;
      if (!value) continue;
      if (reserved + value.byteLength > maxBytes) throw new BodyTooLargeError(maxBytes);
      const clientBytes = clientBufferedBytes.get(clientKey) ?? 0;
      if (
        bufferedBytes + value.byteLength > budget ||
        clientBytes + value.byteLength > clientBudget
      )
        throw new BodyBudgetExceededError();
      clientBufferedBytes.set(clientKey, clientBytes + value.byteLength);
      reserved += value.byteLength;
      bufferedBytes += value.byteLength;
      chunks.push(value);
    }
  } catch (error) {
    release();
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
  }
  try {
    const merged = new Uint8Array(reserved);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { buffer: merged.buffer, release };
  } catch (error) {
    release();
    throw error;
  }
}

/**
 * `clientKey` resolves the per-client share of the buffering budget. index.ts
 * passes the trusted client-IP resolver; it is injected (not imported) so this
 * module stays free of env loading for the many route tests that mount it.
 */
export function bodyPolicyMiddleware(
  options: { clientKey?: (c: Context) => string } = {},
): MiddlewareHandler {
  return async (c, next) => {
    // Git owns counted disk spooling/deadlines after authentication; never buffer it here.
    if (c.req.path.startsWith("/git/")) {
      await next();
      return;
    }
    const method = c.req.method.toUpperCase();
    // Media reads never buffer a request body (including unsupported methods).
    if (c.req.path.startsWith("/kb-assets/") && method !== "GET" && method !== "HEAD") {
      c.header("Allow", "GET, HEAD");
      return c.json({ error: "METHOD_NOT_ALLOWED" }, 405);
    }
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
      await next();
      return;
    }
    const maxBytes = maxBodyBytesForPath(c.req.path);
    const lengthHeader = c.req.header("content-length");
    if (lengthHeader !== undefined && lengthHeader !== "") {
      const parsed = Number(lengthHeader);
      if (!Number.isFinite(parsed) || parsed < 0) {
        return c.json({ error: "Invalid Content-Length" }, 400);
      }
      if (parsed > maxBytes) {
        return c.text("Payload Too Large", 413);
      }
    }
    let release: (() => void) | undefined;
    try {
      const read = await readBodyWithLimit(c.req.raw, maxBytes, {
        clientKey: options.clientKey?.(c) ?? "unknown",
      });
      release = read.release;
      const buffer = read.buffer;
      const headers = new Headers(c.req.raw.headers);
      headers.set("content-length", String(buffer.byteLength));
      const limited = new Request(c.req.url, {
        method: c.req.method,
        headers,
        body: buffer.byteLength > 0 ? buffer : null,
        signal: c.req.raw.signal,
      });
      c.req.raw = limited;
    } catch (error) {
      release?.();
      if (error instanceof BodyTooLargeError) {
        return c.text("Payload Too Large", 413);
      }
      if (error instanceof BodyBudgetExceededError) {
        c.header("Retry-After", "1");
        return c.text("Service Unavailable", 503);
      }
      if (error instanceof BodyReadTimeoutError) {
        return c.text("Request Timeout", 408);
      }
      throw error;
    }
    try {
      await next();
    } finally {
      release?.();
    }
  };
}
