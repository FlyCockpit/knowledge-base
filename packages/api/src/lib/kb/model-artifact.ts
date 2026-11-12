/**
 * Verified local-model artifact download.
 *
 * Descriptor-selected pinned artifacts on the same audited download boundary. Every hop is HTTPS on an exact
 * allowlisted host, resolved to public addresses only, and connected to the
 * address that was validated (no second resolution for rebinding to exploit)
 * while TLS verifies the original hostname. Bytes stream into an exclusive
 * per-epoch temp file, are checked for exact size and SHA-256, fsynced, and
 * published with link(2) so an existing verified file is never replaced.
 *
 * This module has no DB or queue knowledge; the worker handler owns epochs,
 * quota and the volume lease. It never loads a model.
 */
import { createHash, type Hash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns";
import { constants, createReadStream } from "node:fs";
import { type FileHandle, link, lstat, open, readdir, unlink } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { join } from "node:path";
import { QWEN_MODEL } from "./builtin-model";
import type { DnsLookupFn } from "./egress";
import descriptors from "./fixtures/builtin-models.json" with { type: "json" };
import { isBlockedEgressAddress } from "./private-ip";

/** Registry constants; mirrored byte-for-byte in fixtures/qwen-artifact.json for the Rust CLI. */
export const QWEN_ARTIFACT = QWEN_MODEL;

export const MODEL_DOWNLOAD_ALLOWED_HOSTS = Object.freeze(descriptors.downloadHosts);
export const MODEL_MAX_REDIRECTS = descriptors.maxRedirects;
const HOP_TIMEOUT_MS = 30_000;
const STALL_TIMEOUT_MS = 60_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type ArtifactIdentity = {
  fileName: string;
  sizeBytes: number;
  sha256: string;
  url?: string;
};

export const MODEL_ARTIFACT_ERROR_CODES = [
  "MODEL_HOST_REJECTED",
  "MODEL_PRIVATE_NETWORK",
  "MODEL_REDIRECT_LIMIT",
  "MODEL_HTTP_STATUS",
  "MODEL_SIZE_MISMATCH",
  "MODEL_CHECKSUM_MISMATCH",
  "MODEL_DOWNLOAD_FAILED",
  "MODEL_CANCELLED",
  "MODEL_DISK_QUOTA",
  // Verified bytes that the pinned patched runtime cannot load/embed (unsupported
  // platform, missing guard, provenance or metadata mismatch). No runtime build.
  "MODEL_RUNTIME_UNSUPPORTED",
] as const;
export type ModelArtifactErrorCode = (typeof MODEL_ARTIFACT_ERROR_CODES)[number];

/** Fixed, redacted failure. `retryable` keeps the partial temp for a Range resume. */
export class ModelArtifactError extends Error {
  readonly code: ModelArtifactErrorCode;
  readonly retryable: boolean;
  constructor(code: ModelArtifactErrorCode, retryable = false, options?: ErrorOptions) {
    super(code, options);
    this.name = "ModelArtifactError";
    this.code = code;
    this.retryable = retryable;
  }
}

export type ModelHopRequest = {
  url: URL;
  /** Validated public address the connection must use. */
  address: string;
  family: 4 | 6;
  /** Original hostname for SNI and certificate verification. */
  servername: string;
  headers: Record<string, string>;
  signal: AbortSignal;
};
export type ModelHopResponse = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Uint8Array> & { destroy?(): void };
};
export type ModelTransport = { request(req: ModelHopRequest): Promise<ModelHopResponse> };

/** Parse one hop URL; anything but https://<exact allowlisted host>/ fails closed. */
export function validateModelHopUrl(raw: string | URL): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ModelArtifactError("MODEL_HOST_REJECTED");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port !== "" && url.port !== "443") ||
    !(MODEL_DOWNLOAD_ALLOWED_HOSTS as readonly string[]).includes(url.hostname)
  ) {
    throw new ModelArtifactError("MODEL_HOST_REJECTED");
  }
  url.hash = "";
  return url;
}

async function resolvePublic(
  hostname: string,
  lookup: DnsLookupFn,
): Promise<{ address: string; family: 4 | 6 }> {
  const addresses = await new Promise<{ address: string; family: number }[]>((resolve) => {
    lookup(hostname, { all: true, verbatim: true }, (error, result) =>
      resolve(error ? [] : result),
    );
  }).catch(() => []);
  if (addresses.length === 0) throw new ModelArtifactError("MODEL_DOWNLOAD_FAILED", true);
  if (addresses.some(({ address }) => isIP(address) === 0 || isBlockedEgressAddress(address))) {
    throw new ModelArtifactError("MODEL_PRIVATE_NETWORK");
  }
  const selected = addresses[0]!;
  return { address: selected.address, family: selected.family === 6 ? 6 : 4 };
}

/** Real transport: fresh socket to the pinned address, TLS verified for the original host. */
export function defaultModelTransport(hopTimeoutMs = HOP_TIMEOUT_MS): ModelTransport {
  return {
    request(req) {
      return new Promise<ModelHopResponse>((resolve, reject) => {
        if (req.signal.aborted) {
          reject(new ModelArtifactError("MODEL_CANCELLED"));
          return;
        }
        const request = httpsRequest(req.url, {
          method: "GET",
          agent: false,
          headers: req.headers,
          servername: req.servername,
          minVersion: "TLSv1.2",
          rejectUnauthorized: true,
          // Connect only to the address validated above; never re-resolve.
          lookup: (_host, options, callback) => {
            if (options.all) callback(null, [{ address: req.address, family: req.family }]);
            else callback(null, req.address, req.family);
          },
        });
        const timer = setTimeout(
          () => request.destroy(new ModelArtifactError("MODEL_DOWNLOAD_FAILED", true)),
          hopTimeoutMs,
        );
        const onAbort = () => request.destroy(new ModelArtifactError("MODEL_CANCELLED"));
        req.signal.addEventListener("abort", onAbort, { once: true });
        request.once("response", (response) => {
          clearTimeout(timer);
          req.signal.removeEventListener("abort", onAbort);
          const destroyOnAbort = () => response.destroy();
          req.signal.addEventListener("abort", destroyOnAbort, { once: true });
          response.once("close", () => req.signal.removeEventListener("abort", destroyOnAbort));
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: response,
          });
        });
        request.once("error", (error) => {
          clearTimeout(timer);
          req.signal.removeEventListener("abort", onAbort);
          reject(
            error instanceof ModelArtifactError
              ? error
              : new ModelArtifactError("MODEL_DOWNLOAD_FAILED", true),
          );
        });
        request.end();
      });
    },
  };
}

function header(headers: ModelHopResponse["headers"], name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function tempName(fileName: string, epoch: number) {
  return `.${fileName}.e${epoch}.partial`;
}

async function hashFile(path: string, limit?: number): Promise<{ hash: Hash; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  const stream = createReadStream(path, limit === undefined ? {} : { start: 0, end: limit - 1 });
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
    bytes += (chunk as Buffer).byteLength;
  }
  return { hash, bytes };
}

/** True only for a regular (non-symlink) file with the exact size and digest. */
export async function verifyPublishedArtifact(
  dir: string,
  expected: ArtifactIdentity,
): Promise<boolean> {
  const path = join(dir, expected.fileName);
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size !== expected.sizeBytes) return false;
    const { hash } = await hashFile(path);
    return hash.digest("hex") === expected.sha256;
  } catch {
    return false;
  }
}

async function unlinkQuiet(path: string) {
  await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

async function fsyncDir(dir: string) {
  const handle = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** A durable intent precedes file sync/close and publication. A process that
 * dies before settlement leaves this marker; recovery discards that inode,
 * rather than trying to make a known/possibly failed writeback succeed later.
 * All callers hold the exclusive model-volume lease.
 */
const publicationMarker = (dir: string, expected: ArtifactIdentity) =>
  join(dir, `.${expected.fileName}.publication`);
const publishedReceipt = (expected: ArtifactIdentity) => `PUBLISHED:${expected.sha256}`;

async function beginPublication(dir: string, expected: ArtifactIdentity, epoch: number) {
  const marker = await open(publicationMarker(dir, expected), "wx", 0o600);
  try {
    await marker.writeFile(String(epoch));
    await marker.sync();
  } finally {
    await marker.close();
  }
  await fsyncDir(dir);
}

async function recordPublished(dir: string, expected: ArtifactIdentity) {
  const marker = await open(
    publicationMarker(dir, expected),
    constants.O_RDWR | constants.O_NOFOLLOW,
  );
  try {
    const receipt = publishedReceipt(expected);
    await marker.writeFile(receipt);
    await marker.truncate(Buffer.byteLength(receipt));
    await marker.sync();
  } finally {
    await marker.close();
  }
}

async function clearPublication(dir: string, expected: ArtifactIdentity) {
  // Sync publication/discard while recovery intent still exists. Removing the
  // marker is the last operation: no failed durability barrier can lose it.
  // A resurrected completed receipt preserves the already-durable final file.
  await fsyncDir(dir);
  await unlinkQuiet(publicationMarker(dir, expected));
}

export async function recoverArtifactPublication(dir: string, expected: ArtifactIdentity) {
  try {
    const marker = publicationMarker(dir, expected);
    const info = await lstat(marker).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!info) return;
    // Refuse directories/symlinks as intent; never follow or recursively remove.
    if (!info.isFile() || info.size > 128) throw new ModelArtifactError("MODEL_DOWNLOAD_FAILED");
    const handle = await open(marker, constants.O_RDONLY | constants.O_NOFOLLOW);
    let published = false;
    try {
      published = (await handle.readFile("utf8")) === publishedReceipt(expected);
    } finally {
      await handle.close();
    }
    if (published && (await verifyPublishedArtifact(dir, expected))) {
      await clearPublication(dir, expected);
      return;
    }
    await unlinkQuiet(join(dir, expected.fileName));
    for (const name of await readdir(dir)) {
      const match = /^\.(.+)\.e(\d+)\.partial$/.exec(name);
      if (match?.[1] === expected.fileName) await unlinkQuiet(join(dir, name));
    }
    // Make discard durable before removing the recovery intent.
    await fsyncDir(dir);
    await clearPublication(dir, expected);
  } catch {
    throw new ModelArtifactError("MODEL_DOWNLOAD_FAILED");
  }
}

export type DownloadModelArtifactInput = {
  dir: string;
  epoch: number;
  expected: ArtifactIdentity;
  signal: AbortSignal;
  onProgress(bytes: number): void | Promise<void>;
  /** Called once, before any network request, only when bytes must be fetched. */
  beforeTransfer?(): Promise<void>;
  /** Final epoch check before link(2); false cancels and removes the temp. */
  beforePublish?(): Promise<boolean>;
  deps?: { transport?: ModelTransport; lookup?: DnsLookupFn; stallTimeoutMs?: number };
};

/**
 * Caller must hold the model volume lease: temp sweeping and resume assume no
 * other live writer. Retryable failures keep this epoch's temp for resume;
 * terminal failures and cancellation remove it.
 */
export async function downloadModelArtifact(
  input: DownloadModelArtifactInput,
): Promise<{ outcome: "PUBLISHED" | "ALREADY_PRESENT"; path: string }> {
  const { dir, expected, epoch, signal } = input;
  const finalPath = join(dir, expected.fileName);
  const temp = join(dir, tempName(expected.fileName, epoch));
  if (signal.aborted) throw new ModelArtifactError("MODEL_CANCELLED");

  await recoverArtifactPublication(dir, expected);

  // Sweep other epochs' temps (never a live writer: the caller holds the lease).
  for (const name of await readdir(dir)) {
    const match = /^\.(.+)\.e(\d+)\.partial$/.exec(name);
    if (match && match[1] === expected.fileName && Number(match[2]) !== epoch)
      await unlinkQuiet(join(dir, name));
  }

  if (await verifyPublishedArtifact(dir, expected)) {
    await unlinkQuiet(temp);
    return { outcome: "ALREADY_PRESENT", path: finalPath };
  }
  // An unverified file at the final path is not a model: remove it so the
  // verified bytes can be published with no-replace semantics.
  await unlinkQuiet(finalPath);

  let completed = false;
  let keepTemp = false;
  let durabilityFailed = false;
  try {
    await input.beforeTransfer?.();
    await transferAndVerify(
      input,
      temp,
      async () => {
        try {
          await beginPublication(dir, expected, epoch);
        } catch {
          durabilityFailed = true;
          throw new ModelArtifactError("MODEL_DOWNLOAD_FAILED");
        }
      },
      () => {
        durabilityFailed = true;
      },
    );
    if (!(await (input.beforePublish?.() ?? Promise.resolve(true)))) {
      throw new ModelArtifactError("MODEL_CANCELLED");
    }
    try {
      await link(temp, finalPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        keepTemp = true;
        throw new ModelArtifactError("MODEL_DOWNLOAD_FAILED", true);
      }
      // A newer publish won; never replace it. Accept it only if verified.
      await unlinkQuiet(temp);
      if (await verifyPublishedArtifact(dir, expected)) {
        durabilityFailed = true;
        await fsyncDir(dir);
        await recordPublished(dir, expected);
        await clearPublication(dir, expected);
        completed = true;
        return { outcome: "ALREADY_PRESENT", path: finalPath };
      }
      throw new ModelArtifactError("MODEL_DOWNLOAD_FAILED", true);
    }
    // From the link onward, a failure poisons this publication too.
    durabilityFailed = true;
    await unlink(temp);
    await fsyncDir(dir);
    await recordPublished(dir, expected);
    await clearPublication(dir, expected);
    durabilityFailed = false;
    completed = true;
    return { outcome: "PUBLISHED", path: finalPath };
  } catch (error) {
    const failure =
      error instanceof ModelArtifactError
        ? error
        : new ModelArtifactError(
            signal.aborted ? "MODEL_CANCELLED" : "MODEL_DOWNLOAD_FAILED",
            !signal.aborted,
          );
    keepTemp = !durabilityFailed && (keepTemp || failure.retryable);
    if (durabilityFailed) throw new ModelArtifactError("MODEL_DOWNLOAD_FAILED");
    throw signal.aborted && failure.code !== "MODEL_CANCELLED"
      ? new ModelArtifactError("MODEL_CANCELLED")
      : failure;
  } finally {
    await (async () => {
      try {
        if (!completed) {
          if (durabilityFailed) {
            // Leave the marker on any cleanup error so restart cannot accept bytes.
            await unlinkQuiet(temp);
            await unlinkQuiet(finalPath);
            await fsyncDir(dir);
            await clearPublication(dir, expected);
          } else {
            if (!keepTemp || signal.aborted) await unlinkQuiet(temp);
            await clearPublication(dir, expected);
          }
        }
      } catch {
        // Recovery failure never downgrades a poisoned publication to retryable.
        throw new ModelArtifactError("MODEL_DOWNLOAD_FAILED");
      }
    })();
  }
}

async function openTemp(temp: string): Promise<{ handle: FileHandle; offset: number }> {
  try {
    const info = await lstat(temp);
    if (!info.isFile()) {
      await unlinkQuiet(temp);
    } else {
      const handle = await open(temp, constants.O_RDWR | constants.O_NOFOLLOW);
      return { handle, offset: info.size };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // Exclusive create: O_CREAT|O_EXCL never follows or reuses another file.
  const handle = await open(temp, "wx", 0o600);
  return { handle, offset: 0 };
}

async function transferAndVerify(
  input: DownloadModelArtifactInput,
  temp: string,
  begin: () => Promise<void>,
  poison: () => void,
) {
  const { expected, signal } = input;
  const lookup = input.deps?.lookup ?? dnsLookup;
  const transport = input.deps?.transport ?? defaultModelTransport();
  const stallMs = input.deps?.stallTimeoutMs ?? STALL_TIMEOUT_MS;
  const size = expected.sizeBytes;
  let { handle, offset } = await openTemp(temp);
  let intent = false;
  const close = async () => {
    try {
      await handle.close();
    } catch {
      poison();
      throw new ModelArtifactError("MODEL_DOWNLOAD_FAILED");
    }
  };
  const beginOnce = async () => {
    if (!intent) {
      await begin();
      intent = true;
    }
  };
  try {
    let hash = createHash("sha256");
    if (offset > size) {
      await handle.truncate(0);
      offset = 0;
    } else if (offset > 0) {
      const prefix = await hashFile(temp, offset);
      if (prefix.bytes !== offset) throw new ModelArtifactError("MODEL_DOWNLOAD_FAILED", true);
      hash = prefix.hash;
    }
    if (offset < size) {
      const response = await followRedirects(
        transport,
        lookup,
        signal,
        offset,
        expected.url ?? QWEN_ARTIFACT.url,
      );
      if (offset > 0 && response.status === 200) {
        // Server ignored Range: restart from zero on the same response.
        await handle.truncate(0);
        offset = 0;
        hash = createHash("sha256");
      } else if (offset > 0) {
        const range = header(response.headers, "content-range");
        if (response.status !== 206 || range !== `bytes ${offset}-${size - 1}/${size}`) {
          response.body.destroy?.();
          // Discard the partial: the next attempt starts fresh.
          await handle.truncate(0);
          throw new ModelArtifactError("MODEL_DOWNLOAD_FAILED", true);
        }
      }
      const declared = header(response.headers, "content-length");
      if (declared !== undefined && Number(declared) !== size - offset) {
        response.body.destroy?.();
        throw new ModelArtifactError("MODEL_SIZE_MISMATCH");
      }
      offset = await streamBody(response, handle, hash, offset, size, signal, stallMs, input);
    }
    if (offset !== size) throw new ModelArtifactError("MODEL_SIZE_MISMATCH");
    if (hash.digest("hex") !== expected.sha256) {
      throw new ModelArtifactError("MODEL_CHECKSUM_MISMATCH");
    }
    await beginOnce();
    try {
      await handle.sync();
    } catch {
      poison();
      throw new ModelArtifactError("MODEL_DOWNLOAD_FAILED");
    }
    return { bytes: offset };
  } finally {
    // Close can report delayed writeback errors even after a network failure.
    try {
      await beginOnce();
    } finally {
      await close();
    }
  }
}

async function followRedirects(
  transport: ModelTransport,
  lookup: DnsLookupFn,
  signal: AbortSignal,
  offset: number,
  artifactUrl: string,
): Promise<ModelHopResponse> {
  let url = validateModelHopUrl(artifactUrl);
  for (let redirects = 0; ; redirects += 1) {
    if (signal.aborted) throw new ModelArtifactError("MODEL_CANCELLED");
    const pinned = await resolvePublic(url.hostname, lookup);
    const headers: Record<string, string> = {
      accept: "application/octet-stream",
      "accept-encoding": "identity",
    };
    if (offset > 0) headers.range = `bytes=${offset}-`;
    let response: ModelHopResponse;
    try {
      response = await transport.request({
        url,
        address: pinned.address,
        family: pinned.family,
        servername: url.hostname,
        headers,
        signal,
      });
    } catch (error) {
      if (error instanceof ModelArtifactError) throw error;
      throw new ModelArtifactError(
        signal.aborted ? "MODEL_CANCELLED" : "MODEL_DOWNLOAD_FAILED",
        true,
      );
    }
    if (!REDIRECT_STATUSES.has(response.status)) {
      if (response.status === 200 || response.status === 206) return response;
      response.body.destroy?.();
      const retryable =
        response.status >= 500 || response.status === 429 || response.status === 408;
      throw new ModelArtifactError("MODEL_HTTP_STATUS", retryable);
    }
    response.body.destroy?.();
    if (redirects + 1 > MODEL_MAX_REDIRECTS) throw new ModelArtifactError("MODEL_REDIRECT_LIMIT");
    const location = header(response.headers, "location");
    if (!location) throw new ModelArtifactError("MODEL_HOST_REJECTED");
    let next: URL;
    try {
      next = new URL(location, url);
    } catch {
      throw new ModelArtifactError("MODEL_HOST_REJECTED");
    }
    url = validateModelHopUrl(next);
  }
}

async function streamBody(
  response: ModelHopResponse,
  handle: FileHandle,
  hash: Hash,
  start: number,
  size: number,
  signal: AbortSignal,
  stallMs: number,
  input: DownloadModelArtifactInput,
): Promise<number> {
  let offset = start;
  const iterator = response.body[Symbol.asyncIterator]();
  const abandon = () => {
    response.body.destroy?.();
    void iterator.return?.().catch(() => undefined);
  };
  try {
    for (;;) {
      if (signal.aborted) throw new ModelArtifactError("MODEL_CANCELLED");
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      const next = await Promise.race([
        iterator.next(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new ModelArtifactError("MODEL_DOWNLOAD_FAILED", true)),
            stallMs,
          );
          onAbort = () => reject(new ModelArtifactError("MODEL_CANCELLED"));
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]).finally(() => {
        clearTimeout(timer);
        if (onAbort) signal.removeEventListener("abort", onAbort);
      });
      if (next.done) return offset;
      const chunk = next.value;
      if (offset + chunk.byteLength > size) throw new ModelArtifactError("MODEL_SIZE_MISMATCH");
      let written = 0;
      while (written < chunk.byteLength) {
        const { bytesWritten } = await handle
          .write(chunk, written, chunk.byteLength - written, offset + written)
          .catch(() => {
            throw new ModelArtifactError("MODEL_DOWNLOAD_FAILED");
          });
        written += bytesWritten;
      }
      hash.update(chunk);
      offset += chunk.byteLength;
      await input.onProgress(offset);
    }
  } catch (error) {
    abandon();
    if (error instanceof ModelArtifactError) throw error;
    throw new ModelArtifactError(
      signal.aborted ? "MODEL_CANCELLED" : "MODEL_DOWNLOAD_FAILED",
      true,
    );
  }
}
