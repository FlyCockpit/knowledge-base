import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import {
  GetObjectCommand,
  HeadObjectCommand,
  type HeadObjectCommandOutput,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  type AssetS3Config,
  assetS3Locator,
  normalizeAssetS3Location,
} from "@knowledge-base/env/asset-storage-config";
import type { AssetCache } from "./asset-cache";
import type { AssetPublicationState } from "./asset-publication-state";
import type { AssetStorageLifecycle } from "./asset-storage-lifecycle";
import { BLOB_FRAME_BYTES, type BlobReader, type BlobStore } from "./blob-store";
import { withVerifiedCasPublication } from "./blob-store-disk";
import { parseCasHash } from "./cas";
import { KbDomainError } from "./errors";
import { CAS_BLOB_MAX_BYTES } from "./limits";
import { KbAdmissionError } from "./principal";

const unavailable = () => new KbAdmissionError("STORAGE_UNAVAILABLE", "Asset storage unavailable");
const status = (error: unknown) => {
  if (!error || typeof error !== "object" || !("$metadata" in error)) return undefined;
  return (error.$metadata as { httpStatusCode?: number })?.httpStatusCode;
};

export function assetS3Key(prefix: string, hash: string): string {
  const hex = parseCasHash(hash);
  return `${prefix ? `${prefix}/` : ""}objects/${hex.slice(0, 2)}/${hex.slice(2)}`;
}

/** Shared remote verification for runtime and fenced offline inventories. */
export function createS3AssetTransport(config: AssetS3Config, lifecycle: AssetStorageLifecycle) {
  const location = normalizeAssetS3Location(config);
  if (!config.credentials.accessKeyId || !config.credentials.secretAccessKey) throw unavailable();
  const client = new S3Client({
    ...location,
    credentials: { ...config.credentials },
    // Only normalized, recorded configuration may select the authority. SDK
    // environment/profile discovery must never change where asset bytes go.
    ignoreConfiguredEndpointUrls: true,
    useFipsEndpoint: false,
    useDualstackEndpoint: false,
    useAccelerateEndpoint: false,
    useGlobalEndpoint: false,
    // The publisher controls replay and probes ambiguous outcomes itself.
    maxAttempts: 1,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    requestHandler: {
      connectionTimeout: 5000,
      requestTimeout: 30000,
      socketTimeout: 30000,
      throwOnRequestTimeout: true,
    },
  });
  lifecycle.own(async () => {
    client.destroy();
  });

  const verifyRemote = async (
    hash: string,
    size: number,
    signal: AbortSignal,
  ): Promise<boolean> => {
    signal.throwIfAborted();
    const params = { Bucket: location.bucket, Key: assetS3Key(location.prefix, hash) };
    let head: HeadObjectCommandOutput;
    try {
      head = await client.send(new HeadObjectCommand(params), { abortSignal: signal });
    } catch (error) {
      if (status(error) === 404) return false;
      throw error;
    }
    signal.throwIfAborted();
    if (
      head.ContentLength !== size ||
      (head.Metadata?.size !== undefined && head.Metadata.size !== String(size))
    )
      throw unavailable();
    if (head.Metadata?.sha256 !== undefined) {
      if (head.Metadata.sha256 !== parseCasHash(hash)) throw unavailable();
      return true;
    }
    // Size/ETag alone cannot prove integrity. Legacy/compatible objects without
    // canonical hash metadata are hashed completely without cache admission.
    const response = await client.send(new GetObjectCommand(params), { abortSignal: signal });
    const body = response.Body as Readable | undefined;
    if (!body || typeof body.destroy !== "function") throw unavailable();
    const drained = finished(body, { cleanup: true }).catch(() => {});
    const cancel = () => body.destroy(unavailable());
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    try {
      if (response.ContentLength !== size) throw unavailable();
      const digest = createHash("sha256");
      let count = 0;
      for await (const bytes of body) {
        signal.throwIfAborted();
        if (!(bytes instanceof Uint8Array)) throw unavailable();
        count += bytes.length;
        if (count > size) throw unavailable();
        digest.update(bytes);
      }
      signal.throwIfAborted();
      if (count !== size || `sha256:${digest.digest("hex")}` !== hash) throw unavailable();
      return true;
    } finally {
      signal.removeEventListener("abort", cancel);
      body.destroy();
      await drained;
    }
  };
  return { client, verifyRemote };
}

/** Test/offline factory only until P7. No ambient credentials, mode inference,
 * fallback authority, multipart, presigning, deletion or public ACLs.
 */
export function createS3BlobStore(input: {
  assetsDir: string;
  offlineScratchName?: string;
  config: AssetS3Config;
  publication: AssetPublicationState;
  cache?: Pick<AssetCache, "open" | "beginFill" | "state">;
  lifecycle: AssetStorageLifecycle;
}): BlobStore {
  const location = normalizeAssetS3Location(input.config);
  const locator = assetS3Locator(location);
  const binding = input.publication.binding;
  if (
    binding.locator !== locator ||
    (input.publication.scope === "active" && !input.cache) ||
    (input.cache !== undefined &&
      input.cache.state.binding.storageGeneration !== binding.storageGeneration) ||
    !input.config.credentials.accessKeyId ||
    !input.config.credentials.secretAccessKey
  )
    throw unavailable();
  const { client, verifyRemote } = createS3AssetTransport(input.config, input.lifecycle);
  const scoped = <T>(
    signal: AbortSignal | undefined,
    deadlineAt: number | undefined,
    work: (signal: AbortSignal, deadline: number) => Promise<T>,
  ): Promise<T> =>
    input.lifecycle.track(async () => {
      const deadline = Math.min(deadlineAt ?? Infinity, Date.now() + 120000);
      const timeout = new AbortController();
      const timer = setTimeout(
        () => timeout.abort(unavailable()),
        Math.max(0, deadline - Date.now()),
      );
      const active = AbortSignal.any([
        input.lifecycle.signal,
        timeout.signal,
        ...(signal ? [signal] : []),
      ]);
      try {
        active.throwIfAborted();
        return await work(active, deadline);
      } catch (error) {
        if (error instanceof KbDomainError && error.code === "INVALID_ARGUMENT") throw error;
        throw unavailable();
      } finally {
        clearTimeout(timer);
      }
    });

  const durable = async (
    hash: string,
    size: number,
    signal: AbortSignal,
    deadline: number,
    body?: Buffer,
  ) => {
    parseCasHash(hash);
    if (!Number.isSafeInteger(size) || size < 1 || size > CAS_BLOB_MAX_BYTES) throw unavailable();
    // Even dedup publications establish an active-generation obligation, never
    // authority/catalog/lineage. PENDING survives every unknown remote outcome.
    await input.publication.pending(hash, size, deadline);
    signal.throwIfAborted();
    let exists: boolean;
    try {
      exists = await verifyRemote(hash, size, signal);
    } catch (error) {
      // Missing keys return 403 without ListBucket. Only a verified local body
      // permits an immutable conditional create; every outcome is then verified
      // normally. A denied/mismatched existing object is never overwritten.
      if (!body || status(error) !== 403) throw error;
      exists = false;
    }
    if (!exists && body) {
      for (let attempt = 0; attempt < 2 && !exists; attempt++) {
        signal.throwIfAborted();
        try {
          await client.send(
            new PutObjectCommand({
              Bucket: location.bucket,
              Key: assetS3Key(location.prefix, hash),
              Body: Buffer.from(body),
              ContentLength: size,
              Metadata: { sha256: parseCasHash(hash), size: String(size) },
              IfNoneMatch: "*",
            }),
            { abortSignal: signal },
          );
        } catch (error) {
          signal.throwIfAborted();
          // 409/412 contend with a conditional creator. Lost acknowledgements
          // and transport failures probe the exact immutable key before replay.
          const code = status(error);
          if (code !== undefined && code < 500 && code !== 409 && code !== 412) throw error;
        }
        signal.throwIfAborted();
        exists = await verifyRemote(hash, size, signal);
      }
    }
    if (!exists) throw unavailable();
    signal.throwIfAborted();
    await input.publication.durable(hash, size, deadline);
    signal.throwIfAborted();
  };

  const admit = async (hash: string, body: Buffer, signal: AbortSignal, deadline: number) => {
    const cache = input.cache;
    if (!cache) throw unavailable();
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      const reader = await cache.open(hash, body.length, deadline, signal);
      if (reader) {
        try {
          await reader.preflight();
          await reader.complete();
        } finally {
          await reader.close();
        }
        return;
      }
      const fill = await cache.beginFill(hash, body.length, deadline, signal);
      if (fill) {
        try {
          for (let offset = 0; offset < body.length; offset += BLOB_FRAME_BYTES) {
            signal.throwIfAborted();
            fill.write(body.subarray(offset, offset + BLOB_FRAME_BYTES));
          }
          await fill.complete();
        } finally {
          await fill.close();
        }
        return;
      }
      // Wait for same-hash filling/pins without holding a SQL transaction.
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", finish);
          resolve();
        };
        const timer = setTimeout(finish, Math.min(20, Math.max(1, deadline - Date.now())));
        signal.addEventListener("abort", finish, { once: true });
        if (signal.aborted) finish();
      });
    }
    throw unavailable();
  };
  /** Each reader owns its deadline, GET body and byte pin through close/drain.
   * Pulling at most one bounded frame tees bytes to cache before returning them;
   * complete drains the tail/EOF and promotes READY before the final HTTP frame.
   */
  const openReader: BlobStore["open"] = (object) =>
    input.lifecycle.track(async () => {
      parseCasHash(object.hash);
      if (!Number.isSafeInteger(object.size) || object.size < 1) throw unavailable();
      const deadline = Math.min(object.deadlineAt ?? Infinity, Date.now() + 120000);
      const abort = new AbortController();
      const signal = AbortSignal.any([object.signal, input.lifecycle.signal, abort.signal]);
      const timer = setTimeout(
        () => abort.abort(unavailable()),
        Math.max(0, deadline - Date.now()),
      );
      timer.unref();
      let hit: Awaited<ReturnType<AssetCache["open"]>>;
      let fill: Awaited<ReturnType<AssetCache["beginFill"]>>;
      let body: Readable | undefined;
      let drained: Promise<void> | undefined;
      let active: Promise<unknown> | undefined;
      let closing: Promise<void> | undefined;
      let disown = () => {};
      const nestedFills = new Set<() => Promise<void>>();
      const ownFill: AssetStorageLifecycle["own"] = (closeFill) => {
        nestedFills.add(closeFill);
        return () => nestedFills.delete(closeFill);
      };
      let verified = false;
      let started = false;
      let failed = false;
      let position = 0;
      const digest = createHash("sha256");
      const check = () => {
        signal.throwIfAborted();
        if (closing || failed || Date.now() >= deadline) throw unavailable();
      };
      const cancelBody = () => body?.destroy(unavailable());
      signal.addEventListener("abort", cancelBody);
      const close = () => {
        if (closing) return closing;
        abort.abort(unavailable());
        closing = (async () => {
          await active?.catch(() => {});
          body?.destroy();
          await drained;
          try {
            await hit?.close();
            // Nested ownership is exclusively drained here, after GET and any
            // outstanding reader operation. Global shutdown cannot race a fill
            // pin release against destruction of its upstream body.
            for (const closeFill of nestedFills) await closeFill();
            await fill?.close();
            disown();
          } finally {
            clearTimeout(timer);
            signal.removeEventListener("abort", cancelBody);
          }
        })();
        return closing;
      };
      const io = <T>(work: () => Promise<T>): Promise<T> => {
        check();
        if (active) return Promise.reject(unavailable());
        const task = (async () => {
          try {
            const result = await work();
            check();
            return result;
          } catch {
            failed = true;
            cancelBody();
            throw unavailable();
          }
        })();
        active = task;
        void task
          .finally(() => {
            if (active === task) active = undefined;
          })
          .catch(() => {});
        return task;
      };
      // Readable.read(n) caps each allocation and applies upstream backpressure.
      // Never retain an async-iterator chunk of unbounded provider-selected size.
      const next = async (length: number): Promise<Buffer | undefined> => {
        for (;;) {
          check();
          // Consume available bytes before waiting. Waiting for a full frame
          // while a smaller prefix is buffered can repeatedly emit `readable`
          // and starve the socket/abort timer under real HTTP backpressure.
          const available = Math.min(length, body!.readableLength);
          const bytes: unknown = body!.read(available);
          if (bytes !== null) {
            if (!(bytes instanceof Buffer) || bytes.length > length) throw unavailable();
            return bytes;
          }
          if (body!.readableEnded) return;
          if (body!.destroyed) throw unavailable();
          await new Promise<void>((resolve, reject) => {
            const cleanup = () => {
              body!.off("readable", ready);
              body!.off("end", ready);
              body!.off("error", error);
              body!.off("close", ready);
              signal.removeEventListener("abort", canceled);
            };
            const ready = () => {
              cleanup();
              resolve();
            };
            const error = () => {
              cleanup();
              reject(unavailable());
            };
            const canceled = () => {
              cleanup();
              reject(unavailable());
            };
            body!.once("readable", ready);
            body!.once("end", ready);
            body!.once("error", error);
            body!.once("close", ready);
            signal.addEventListener("abort", canceled, { once: true });
            if (signal.aborted) canceled();
          });
        }
      };
      const consume = async (length: number) => {
        const bytes = await next(Math.min(length, BLOB_FRAME_BYTES));
        check();
        if (!bytes?.length || position + bytes.length > object.size) throw unavailable();
        fill?.write(bytes);
        digest.update(bytes);
        position += bytes.length;
        return bytes;
      };
      try {
        disown = input.lifecycle.own(close);
        await io(async () => {
          const cache = input.cache;
          if (cache) {
            for (;;) {
              check();
              hit = await cache.open(object.hash, object.size, deadline, signal);
              check();
              if (
                hit ||
                object.purpose === "internal" ||
                BigInt(object.size) > cache.state.binding.limit
              )
                break;
              fill = await cache.beginFill(object.hash, object.size, deadline, signal, ownFill);
              check();
              if (fill) break;
              // Same-hash followers and all-pinned capacity wait without a SQL lock.
              await new Promise<void>((resolve) => {
                const done = () => {
                  clearTimeout(wait);
                  signal.removeEventListener("abort", done);
                  resolve();
                };
                const wait = setTimeout(done, Math.min(20, Math.max(1, deadline - Date.now())));
                signal.addEventListener("abort", done, { once: true });
                if (signal.aborted) done();
              });
            }
          } else if (object.purpose === "download") throw unavailable();
        });
        const reader: BlobReader = {
          get verified() {
            return hit?.verified ?? verified;
          },
          preflight: (checkActive) =>
            io(async () => {
              checkActive?.();
              if (hit) return hit.preflight(checkActive);
              if (started) throw unavailable();
              started = true;
              const response = await client.send(
                new GetObjectCommand({
                  Bucket: location.bucket,
                  Key: assetS3Key(location.prefix, object.hash),
                }),
                { abortSignal: signal },
              );
              body = response.Body as Readable | undefined;
              if (!body || typeof body.destroy !== "function") throw unavailable();
              drained = finished(body, { cleanup: true }).then(
                () => {},
                () => {},
              );
              check();
              if (
                response.ContentLength !== object.size ||
                (response.Metadata?.sha256 !== undefined &&
                  response.Metadata.sha256 !== parseCasHash(object.hash)) ||
                (response.Metadata?.size !== undefined &&
                  response.Metadata.size !== String(object.size))
              )
                throw unavailable();
            }),
          readFrame: (offset, length) =>
            io(async () => {
              if (hit) return hit.readFrame(offset, length);
              if (
                !started ||
                verified ||
                !Number.isSafeInteger(offset) ||
                offset < position ||
                !Number.isSafeInteger(length) ||
                length < 1 ||
                length > BLOB_FRAME_BYTES ||
                offset + length > object.size
              )
                throw unavailable();
              while (position < offset)
                await consume(Math.min(BLOB_FRAME_BYTES, offset - position));
              const frame = Buffer.alloc(length);
              let used = 0;
              while (used < length) {
                const bytes = await consume(length - used);
                bytes.copy(frame, used);
                used += bytes.length;
              }
              return frame;
            }),
          complete: () =>
            io(async () => {
              if (hit) return hit.complete();
              if (!started) throw unavailable();
              if (verified) return;
              while (position < object.size) await consume(object.size - position);
              if (await next(1)) throw unavailable();
              if (`sha256:${digest.digest("hex")}` !== object.hash) throw unavailable();
              await fill?.complete();
              verified = true;
            }),
          sampleDownload() {
            if (object.purpose !== "download" || closing || signal.aborted) return;
            try {
              (hit ?? fill)?.sampleDownload();
            } catch {
              /* advisory only */
            }
          },
          close,
        };
        return reader;
      } catch {
        await close();
        throw unavailable();
      }
    });
  return {
    backend: "s3",
    publishVerified: (publication) =>
      scoped(publication.signal, publication.deadlineAt, (signal, deadline) =>
        withVerifiedCasPublication(
          input.assetsDir,
          { ...publication, signal },
          async ({ body, hash, size, mime }) => {
            await durable(hash, size, signal, deadline, body);
            if (input.publication.scope === "active") await admit(hash, body, signal, deadline);
            signal.throwIfAborted();
            await publication.afterDurableBytes?.();
            signal.throwIfAborted();
            return { hash, size, mime, durability: { backend: "s3", ...binding } };
          },
          input.offlineScratchName,
        ),
      ),
    assertDurable: (object) =>
      scoped(object.signal, object.deadlineAt, (signal, deadline) =>
        durable(object.hash, object.size, signal, deadline),
      ),
    open: openReader,
  };
}
