#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { backupNamespace } from "./lib/backup-identity.mjs";
import { backupS3Config } from "./lib/backup-s3-env.mjs";
import { deliverBackup, digest, verifyEncryptedBundle } from "./lib/kb-backup.mjs";

// Keep one part in flight. createReadStream's high-water mark bounds memory;
// the part size is a request range, not a Buffer allocation. 512 MiB keeps an
// S3/Spaces-compatible upload below 10,000 parts through their 5 TB maximum.
export const MULTIPART_PART_SIZE_BYTES = 512 * 1024 * 1024;
// Preserve the existing conditional PutObject path through the conservative
// common 5 GB (decimal) limit. Only a dump above that boundary needs
// CompleteMultipartUpload's separate conditional-write contract.
export const MULTIPART_THRESHOLD_BYTES = 5_000_000_000;
export const MAX_MULTIPART_PARTS = 10_000;
export const S3_MAX_ATTEMPTS = 3;

async function sendWithRetry(client, makeCommand, signal) {
  let lastError;
  for (let attempt = 1; attempt <= S3_MAX_ATTEMPTS; attempt += 1) {
    try {
      // Each attempt constructs a new command. This is essential for PutObject
      // and UploadPart: a consumed ReadStream cannot be safely replayed.
      signal?.throwIfAborted();
      return await client.send(makeCommand(), { abortSignal: signal });
    } catch (error) {
      lastError = error;
      if (attempt === S3_MAX_ATTEMPTS) throw error;
    }
  }
  throw lastError;
}

function uploadBase(config, key) {
  const input = {
    Bucket: config.bucket,
    Key: key,
    ContentType: "application/octet-stream",
  };
  // R2 and several S3-compatible providers reject AWS SSE headers. Opt in for AWS.
  if (process.env.BACKUP_S3_SSE === "AES256") input.ServerSideEncryption = "AES256";
  return input;
}

function immutableResult(key, response, config) {
  return {
    key,
    eTag: response.ETag ?? null,
    versionId: response.VersionId ?? null,
    bucket: config.bucket,
    endpoint: config.endpoint ?? null,
    region: config.region,
  };
}

function unsupportedConditionalCompletion(error) {
  const status = error && typeof error === "object" ? error.$metadata?.httpStatusCode : undefined;
  return status === 400 || status === 405 || status === 501;
}

async function abortIncompleteUpload(client, base, uploadId) {
  try {
    await sendWithRetry(
      client,
      () => new AbortMultipartUploadCommand({ ...base, UploadId: uploadId }),
    );
  } catch (abortError) {
    console.error(
      `WARNING: could not abort incomplete multipart backup upload ${uploadId}: ${
        abortError instanceof Error ? abortError.message : String(abortError)
      }. Configure a bucket lifecycle rule to abort incomplete multipart uploads.`,
    );
  }
}

async function multipartUpload({ client, file, size, base, config, key, partSizeBytes, signal }) {
  // Do not retry initiation without an UploadId: a response lost after a
  // successful create leaves an unknown upload that this process cannot abort.
  // The bucket lifecycle owns that boundary; once we have an ID, parts/abort
  // are safely retryable with fresh streams.
  const create = await client.send(new CreateMultipartUploadCommand(base), { abortSignal: signal });
  if (!create.UploadId)
    throw new Error("S3 did not return an UploadId for the multipart backup upload.");
  let completed = false;
  try {
    const parts = [];
    const partCount = Math.ceil(size / partSizeBytes);
    if (partCount > MAX_MULTIPART_PARTS) {
      throw new Error(
        `Backup is ${size} bytes, which needs ${partCount} parts at ${partSizeBytes} bytes each; ` +
          `the S3 multipart limit is ${MAX_MULTIPART_PARTS} parts. Refusing an incomplete upload.`,
      );
    }
    for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
      const start = (partNumber - 1) * partSizeBytes;
      const end = Math.min(size, start + partSizeBytes) - 1;
      const response = await sendWithRetry(
        client,
        () =>
          new UploadPartCommand({
            ...base,
            UploadId: create.UploadId,
            PartNumber: partNumber,
            Body: createReadStream(file, { start, end }),
            ContentLength: end - start + 1,
          }),
        signal,
      );
      if (!response.ETag)
        throw new Error(`S3 did not return an ETag for multipart backup part ${partNumber}.`);
      parts.push({ ETag: response.ETag, PartNumber: partNumber });
    }
    // The conditional is on completion because initiating/uploading parts does
    // not create an object. Never replace a collision on an unversioned bucket.
    const complete = await sendWithRetry(
      client,
      () =>
        new CompleteMultipartUploadCommand({
          ...base,
          UploadId: create.UploadId,
          MultipartUpload: { Parts: parts },
          IfNoneMatch: "*",
        }),
      signal,
    );
    completed = true;
    return immutableResult(key, complete, config);
  } catch (error) {
    if (unsupportedConditionalCompletion(error)) {
      throw new Error(
        "This S3 endpoint rejected the required If-None-Match condition on multipart completion. " +
          "Backups refuse to weaken their no-overwrite contract; use AWS S3 or an endpoint that supports conditional CompleteMultipartUpload.",
        { cause: error },
      );
    }
    throw error;
  } finally {
    if (!completed) await abortIncompleteUpload(client, base, create.UploadId);
  }
}

/**
 * Upload one already-validated dump. Exported for inert injected-client tests;
 * production calls use the default S3 client and never mocks provider effects.
 */
export async function uploadObject({
  file,
  config = backupS3Config(),
  client = new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle,
    credentials: config.credentials,
    // Stream retries are owned above so each attempt can open a fresh range.
    maxAttempts: 1,
  }),
  multipartThresholdBytes = MULTIPART_THRESHOLD_BYTES,
  partSizeBytes = MULTIPART_PART_SIZE_BYTES,
  signal,
} = {}) {
  if (!file) throw new Error("backup upload requires a file path argument.");
  signal?.throwIfAborted();
  const size = (await stat(file)).size;
  const key = `${backupNamespace(config.prefix)}/${basename(file)}`;
  const base = uploadBase(config, key);
  if (size <= multipartThresholdBytes) {
    const response = await sendWithRetry(
      client,
      () => new PutObjectCommand({ ...base, Body: createReadStream(file), IfNoneMatch: "*" }),
      signal,
    );
    return immutableResult(key, response, config);
  }
  return multipartUpload({ client, file, size, base, config, key, partSizeBytes, signal });
}

/** Re-upload is idempotent only after reading and hashing the exact remote bytes.
 * Publish the remote marker last. A lost PUT reply therefore retries the same
 * immutable pair without overwriting a different object or claiming success.
 */
export async function uploadBackup({
  file,
  config = backupS3Config(),
  client,
  signal,
  multipartThresholdBytes = MULTIPART_THRESHOLD_BYTES,
  partSizeBytes = MULTIPART_PART_SIZE_BYTES,
} = {}) {
  await verifyEncryptedBundle(file);
  client ??= new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle,
    credentials: config.credentials,
    maxAttempts: 1,
  });
  const send = async (path) => {
    const expected = await digest(path);
    const key = `${backupNamespace(config.prefix)}/${basename(path)}`;
    try {
      await uploadObject({
        file: path,
        config,
        client,
        signal,
        multipartThresholdBytes,
        partSizeBytes,
      });
    } catch (error) {
      if (error?.$metadata?.httpStatusCode !== 412) throw error;
    }
    const response = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }), {
      abortSignal: signal,
    });
    const hash = createHash("sha256");
    let size = 0;
    try {
      for await (const bytes of response.Body) {
        signal?.throwIfAborted();
        size += bytes.length;
        if (size > expected.size) throw new Error("Remote backup size mismatch.");
        hash.update(bytes);
      }
    } finally {
      response.Body?.destroy?.();
    }
    if (size !== expected.size || hash.digest("hex") !== expected.sha256)
      throw new Error("Remote backup digest mismatch.");
    return { ...immutableResult(key, response, config), ...expected };
  };
  const bundle = await send(file);
  const completion = await send(`${file}.complete`);
  return { ...bundle, completion };
}

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("FATAL: backup upload requires a file path argument.");
    process.exitCode = 1;
    return;
  }
  try {
    const result = await deliverBackup({
      file: resolve(file),
      label: "manual",
      resultFile: process.env.BACKUP_RESULT_FILE,
      connectionString: process.env.DATABASE_URL,
      configured: true,
      upload: uploadBackup,
    });
    console.log(`Uploaded backup to s3://${result.upload.bucket}/${result.upload.key}`);
    console.log(
      "Restore offline with the downloaded complete bundle and marker: restore <bundle.age> <identity-file> <attempt-uuid> (see docs/backup-restore.md).",
    );
  } catch (error) {
    console.error(
      `FATAL: backup upload failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith("upload-backup-to-s3.mjs")) await main();
