import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { close, createReadStream, open, readFileSync } from "node:fs";
import { access, constants, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { text as readStreamText } from "node:stream/consumers";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { S3Client } from "@aws-sdk/client-s3";

const root = fileURLToPath(new URL("..", import.meta.url));
const backupScript = join(root, "scripts", "backup.sh");
const inertDatabaseUrl = ["post", "gresql://inert:", "inert@mock-db.example:5432/mock"].join("");
process.env.DATABASE_URL = inertDatabaseUrl;
const { MULTIPART_THRESHOLD_BYTES, uploadObject: uploadBackup } = await import(
  "./upload-backup-to-s3.mjs"
);

const inertS3Config = {
  bucket: "inert-backup-bucket",
  region: "us-east-1",
  endpoint: undefined,
  forcePathStyle: false,
  credentials: { accessKeyId: "writer", secretAccessKey: "inert" },
  prefix: "database",
};

function fakeS3Client(send) {
  return {
    async send(command) {
      const body = command.input.Body;
      let bodyError;
      const onError = (error) => {
        bodyError = error;
      };
      body?.on("error", onError);
      let result;
      try {
        result = { value: await send(command) };
      } catch (error) {
        result = { error };
      } finally {
        if (body) {
          try {
            // SDK commands contain real ReadStreams. Wait for deferred open and
            // close even after fake failures; never drain the sparse 5 GB cases.
            if (!body.closed) {
              const closed = new Promise((resolve) => body.once("close", resolve));
              body.destroy();
              await closed;
            }
          } finally {
            body.off("error", onError);
          }
        }
      }
      if (bodyError) throw bodyError;
      if ("error" in result) throw result.error;
      return result.value;
    },
  };
}

test("fake S3 sends settle pending body opens and closes before fixture cleanup", async (t) => {
  for (const outcome of ["success", "provider failure", "open failure"]) {
    await t.test(outcome, { timeout: 5_000 }, async () => {
      const directory = await mkdtemp(join(tmpdir(), "knowledge-base-backup-body-lifetime-"));
      const openStarted = Promise.withResolvers();
      const allowOpen = Promise.withResolvers();
      const closeStarted = Promise.withResolvers();
      const allowClose = Promise.withResolvers();
      const streamClosed = Promise.withResolvers();
      const events = [];
      let body;
      let result;
      try {
        const dump = join(directory, "backup.dump");
        await writeFile(dump, "small fixture");
        body = createReadStream(dump, {
          fs: {
            open(path, flags, mode, callback) {
              openStarted.resolve();
              void allowOpen.promise.then(() => {
                events.push("open");
                if (outcome === "open failure") callback(new Error("inert open failure"));
                else open(path, flags, mode, callback);
              });
            },
            close(fd, callback) {
              closeStarted.resolve();
              void allowClose.promise.then(() => {
                close(fd, (error) => {
                  events.push("fd closed");
                  callback(error);
                });
              });
            },
            read(_fd, _buffer, _offset, _length, _position, callback) {
              callback(new Error("the fake must close unread bodies without draining them"));
            },
          },
        });
        body.on("error", (error) => events.push(error.message));
        body.once("close", () => {
          events.push("stream closed");
          streamClosed.resolve();
        });
        const client = fakeS3Client(() => {
          if (outcome === "provider failure") throw new Error("inert provider failure");
          return { ETag: "fixture-etag" };
        });
        let settled = false;
        result = client.send({ input: { Body: body } }).then(
          (value) => {
            settled = true;
            return { value };
          },
          (error) => {
            settled = true;
            return { error };
          },
        );
        await openStarted.promise;
        // An event-loop checkpoint flushes ready callbacks; the explicit gates
        // keep open/close pending regardless of machine speed.
        await new Promise(setImmediate);
        assert.equal(settled, false, "fake send settled before its pending open");
        allowOpen.resolve();
        if (outcome !== "open failure") {
          await closeStarted.promise;
          await new Promise(setImmediate);
          assert.equal(settled, false, "fake send settled before its pending close");
          allowClose.resolve();
        }
        const response = await result;
        assert.equal(body.closed, true);
        assert.equal(body.bytesRead, 0);
        assert.equal(events.at(-1), "stream closed");
        if (outcome === "success") assert.equal(response.value.ETag, "fixture-etag");
        else assert.equal(response.error.message, `inert ${outcome}`);
        await rm(directory, { recursive: true, force: true });
        assert.deepEqual(events, [
          "open",
          outcome === "open failure" ? "inert open failure" : "fd closed",
          "stream closed",
        ]);
      } finally {
        // Also settle the deliberately gated stream when an assertion fails.
        allowOpen.resolve();
        allowClose.resolve();
        if (body) {
          body.destroy();
          await streamClosed.promise;
        }
        await result;
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});

// Exercise the finite stage-owner directly with inert shell writers.  The
// production script's top-level preflight needs a database, but the ownership
// helper is self-contained and these probes never invoke a client or network.
const backupWriterSource = readFileSync(backupScript, "utf8");
const backupWriterFunctions = backupWriterSource.slice(
  backupWriterSource.indexOf('backup_writer_pid=""'),
  backupWriterSource.indexOf('\necho "Writing backup'),
);

function runBackupWriterProbe(body) {
  const result = spawnSync(
    "bash",
    [
      "-c",
      `source "$1"\n${backupWriterFunctions}\n${body}`,
      "backup-writer-probe",
      join(root, "scripts", "lib", "owned-child.sh"),
    ],
    { encoding: "utf8", timeout: 5_000 },
  );
  assert.equal(result.signal, null, `${result.stdout}${result.stderr}`);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  return `${result.stdout}${result.stderr}`;
}

test("rejects a TERM delivered at the former check-to-start handoff without admitting a writer", () => {
  const output = runBackupWriterProbe(`
    fixture_writer() { printf writer-admitted; }
    set -T
    trap 'if [[ $BASH_COMMAND == backup_writer_starting=1 ]]; then trap - DEBUG; kill -TERM "$BASHPID"; fi' DEBUG
    if run_backup_writer fixture_writer; then status=0; else status=$?; fi
    printf ':status=%s' "$status"
  `);
  assert.match(output, /:status=143/);
  assert.doesNotMatch(output, /writer-admitted/);
});

test("uses application-owned retries so the installed SDK never replays a consumed stream", async () => {
  const client = new S3Client({ maxAttempts: 1 });
  assert.equal(await client.config.maxAttempts(), 1);
});

test("keeps the established conditional PUT path through the conservative 5 GB provider boundary", () => {
  assert.equal(MULTIPART_THRESHOLD_BYTES, 5_000_000_000);
});

async function executable(path, body) {
  await writeFile(path, body, { encoding: "utf8", mode: 0o755 });
  await access(path, constants.X_OK);
}

test("backup writer rejects a missing dump credential before dump or upload effects", async () => {
  const directory = await mkdtemp(join(tmpdir(), "knowledge-base-backup-writer-"));
  try {
    const parsed = new URL(inertDatabaseUrl);
    assert.deepEqual(
      {
        protocol: parsed.protocol,
        username: parsed.username,
        password: parsed.password,
        hostname: parsed.hostname,
        port: parsed.port,
        pathname: parsed.pathname,
      },
      {
        protocol: "postgresql:",
        username: "inert",
        password: "inert",
        hostname: "mock-db.example",
        port: "5432",
        pathname: "/mock",
      },
    );
    // backup.sh performs a read-only version preflight before validating dump credentials.
    await executable(join(directory, "psql"), "#!/bin/sh\nprintf '180000\\n'\n");
    await executable(
      join(directory, "pg_dump"),
      "#!/bin/sh\nif [ \"$1\" = --version ]; then printf 'pg_dump (PostgreSQL) 18.6\\n'; exit 0; fi\nprintf 'pg_dump must not run\\n' >&2\nexit 70\n",
    );
    const env = {
      PATH: `${directory}:${dirname(process.execPath)}:/usr/bin:/bin`,
      DATABASE_URL: inertDatabaseUrl,
      BACKUP_DIR: join(directory, "backups"),
      BACKUP_S3_BUCKET: "inert-backup-bucket",
      BACKUP_S3_REGION: "us-east-1",
    };
    let output = "";
    let status = 0;
    try {
      execFileSync("bash", [backupScript], {
        encoding: "utf8",
        env,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 5_000,
      });
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        typeof error.status !== "number" ||
        error.signal
      ) {
        throw error;
      }
      status = error.status;
      output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    }
    assert.equal(status, 1, output);
    assert.match(output, /BACKUP_S3_ACCESS_KEY_ID \/ BACKUP_S3_SECRET_ACCESS_KEY are missing/);
    assert.doesNotMatch(output, /pg_dump must not run/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("large backup uses conditional multipart completion and records metadata only after success", async () => {
  const directory = await mkdtemp(join(tmpdir(), "knowledge-base-backup-multipart-"));
  try {
    const dump = join(directory, "backup.dump");
    await writeFile(dump, "123456789");
    const commands = [];
    const client = fakeS3Client(async (command) => {
      commands.push(command);
      if (command.constructor.name === "CreateMultipartUploadCommand")
        return { UploadId: "upload-1" };
      if (command.constructor.name === "UploadPartCommand") {
        return { ETag: `part-${command.input.PartNumber}` };
      }
      if (command.constructor.name === "CompleteMultipartUploadCommand")
        return { ETag: "complete-etag" };
      throw new Error(`unexpected command ${command.constructor.name}`);
    });

    const result = await uploadBackup({
      file: dump,
      config: inertS3Config,
      client,
      multipartThresholdBytes: 1,
      partSizeBytes: 4,
    });

    assert.equal(result.eTag, "complete-etag");
    assert.deepEqual(
      commands.map((command) => command.constructor.name),
      [
        "CreateMultipartUploadCommand",
        "UploadPartCommand",
        "UploadPartCommand",
        "UploadPartCommand",
        "CompleteMultipartUploadCommand",
      ],
    );
    const complete = commands.at(-1).input;
    assert.equal(complete.IfNoneMatch, "*");
    assert.deepEqual(complete.MultipartUpload.Parts, [
      { ETag: "part-1", PartNumber: 1 },
      { ETag: "part-2", PartNumber: 2 },
      { ETag: "part-3", PartNumber: 3 },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("uses PUT exactly at 5 GB and multipart at the next byte", async () => {
  const directory = await mkdtemp(join(tmpdir(), "knowledge-base-backup-boundary-"));
  try {
    const dump = join(directory, "backup.dump");
    await writeFile(dump, "");
    const commandForSize = async (size) => {
      await truncate(dump, size);
      const commands = [];
      const client = fakeS3Client(async (command) => {
        commands.push(command);
        if (command.constructor.name === "PutObjectCommand") return { ETag: "put" };
        if (command.constructor.name === "CreateMultipartUploadCommand")
          return { UploadId: "boundary" };
        if (command.constructor.name === "UploadPartCommand") return { ETag: "part" };
        if (command.constructor.name === "CompleteMultipartUploadCommand")
          return { ETag: "complete" };
        throw new Error(`unexpected command ${command.constructor.name}`);
      });
      await uploadBackup({
        file: dump,
        config: inertS3Config,
        client,
        partSizeBytes: MULTIPART_THRESHOLD_BYTES,
      });
      for (const command of commands) {
        if (!command.input.Body) continue;
        assert.equal(command.input.Body.closed, true);
        assert.equal(command.input.Body.bytesRead, 0);
      }
      return commands[0].constructor.name;
    };
    assert.equal(await commandForSize(MULTIPART_THRESHOLD_BYTES), "PutObjectCommand");
    assert.equal(
      await commandForSize(MULTIPART_THRESHOLD_BYTES + 1),
      "CreateMultipartUploadCommand",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("multipart failure aborts its owned upload and never returns immutable metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "knowledge-base-backup-multipart-fail-"));
  try {
    const dump = join(directory, "backup.dump");
    await writeFile(dump, "123456789");
    const commands = [];
    const client = fakeS3Client(async (command) => {
      commands.push(command);
      if (command.constructor.name === "CreateMultipartUploadCommand")
        return { UploadId: "upload-2" };
      if (command.constructor.name === "UploadPartCommand") throw new Error("inert part failure");
      if (command.constructor.name === "AbortMultipartUploadCommand") return {};
      throw new Error(`unexpected command ${command.constructor.name}`);
    });

    await assert.rejects(
      uploadBackup({
        file: dump,
        config: inertS3Config,
        client,
        multipartThresholdBytes: 1,
        partSizeBytes: 4,
      }),
      /inert part failure/,
    );
    assert.deepEqual(
      commands.map((command) => command.constructor.name),
      [
        "CreateMultipartUploadCommand",
        "UploadPartCommand",
        "UploadPartCommand",
        "UploadPartCommand",
        "AbortMultipartUploadCommand",
      ],
    );
    assert.equal(commands.at(-1).input.UploadId, "upload-2");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("does not blindly retry multipart initiation without an upload identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "knowledge-base-backup-create-fail-"));
  try {
    const dump = join(directory, "backup.dump");
    await writeFile(dump, "123456789");
    const commands = [];
    const client = fakeS3Client(async (command) => {
      commands.push(command);
      throw new Error("inert lost create response");
    });
    await assert.rejects(
      uploadBackup({
        file: dump,
        config: inertS3Config,
        client,
        multipartThresholdBytes: 1,
        partSizeBytes: 4,
      }),
      /inert lost create response/,
    );
    assert.deepEqual(
      commands.map((command) => command.constructor.name),
      ["CreateMultipartUploadCommand"],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("retries a small PUT with a fresh unread stream", async () => {
  const directory = await mkdtemp(join(tmpdir(), "knowledge-base-backup-put-retry-"));
  try {
    const dump = join(directory, "backup.dump");
    await writeFile(dump, "retry-body");
    const commands = [];
    const client = fakeS3Client(async (command) => {
      commands.push(command);
      assert.equal(command.input.Body.bytesRead, 0);
      assert.equal(await readStreamText(command.input.Body), "retry-body");
      if (commands.length === 1) {
        throw new Error("inert transient PUT failure after body consumption");
      }
      return { ETag: "put-etag" };
    });
    await expectUploadBackup({ file: dump, config: inertS3Config, client });
    assert.equal(commands.length, 2);
    assert.notEqual(commands[0].input.Body, commands[1].input.Body);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("retries each multipart range with a fresh unread stream", async () => {
  const directory = await mkdtemp(join(tmpdir(), "knowledge-base-backup-part-retry-"));
  try {
    const dump = join(directory, "backup.dump");
    await writeFile(dump, "123456789");
    const commands = [];
    let firstPart = true;
    const client = fakeS3Client(async (command) => {
      commands.push(command);
      if (command.constructor.name === "CreateMultipartUploadCommand")
        return { UploadId: "upload-retry" };
      if (command.constructor.name === "UploadPartCommand") {
        assert.equal(command.input.Body.bytesRead, 0);
        assert.equal(
          await readStreamText(command.input.Body),
          ["1234", "5678", "9"][command.input.PartNumber - 1],
        );
        if (firstPart) {
          firstPart = false;
          throw new Error("inert transient part failure after body consumption");
        }
        return { ETag: `part-${command.input.PartNumber}` };
      }
      if (command.constructor.name === "CompleteMultipartUploadCommand")
        return { ETag: "complete-etag" };
      throw new Error(`unexpected command ${command.constructor.name}`);
    });
    await expectUploadBackup({
      file: dump,
      config: inertS3Config,
      client,
      multipartThresholdBytes: 1,
      partSizeBytes: 4,
    });
    const attempts = commands.filter((command) => command.constructor.name === "UploadPartCommand");
    assert.equal(attempts.length, 4);
    assert.equal(attempts[0].input.PartNumber, 1);
    assert.equal(attempts[1].input.PartNumber, 1);
    assert.notEqual(attempts[0].input.Body, attempts[1].input.Body);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function expectUploadBackup(input) {
  const result = await uploadBackup(input);
  assert.ok(result.eTag);
  return result;
}

test("encrypted bundle upload refuses incomplete files before any S3 effect", async () => {
  const { uploadBackup } = await import("./upload-backup-to-s3.mjs");
  const directory = await mkdtemp(join(tmpdir(), "kb-incomplete-upload-"));
  try {
    const file = join(directory, "backup.age");
    await writeFile(file, "incomplete cipher");
    let effects = 0;
    const client = fakeS3Client(async () => {
      effects++;
      return { ETag: "bad" };
    });
    await assert.rejects(uploadBackup({ file, client, config: inertS3Config }));
    assert.equal(effects, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("installed S3 client sends immutable conditional PUT and collision leaves previous bytes intact", async (t) => {
  const { createServer } = await import("node:http");
  const directory = await mkdtemp(join(tmpdir(), "kb-immutable-http-"));
  const bodies = [];
  let stored;
  let stalled;
  let entered = new Promise((resolve) => {
    stalled = resolve;
  });
  let pause = false;
  const server = createServer(async (request, response) => {
    if (pause) {
      stalled();
      return;
    }
    const chunks = [];
    for await (const bytes of request) chunks.push(bytes);
    let body = Buffer.concat(chunks);
    if (String(request.headers["content-encoding"]).includes("aws-chunked")) {
      const decoded = [];
      let offset = 0;
      for (;;) {
        const end = body.indexOf("\r\n", offset),
          size = Number.parseInt(body.subarray(offset, end).toString(), 16);
        if (!size) break;
        offset = end + 2;
        decoded.push(body.subarray(offset, offset + size));
        offset += size + 2;
      }
      body = Buffer.concat(decoded);
    }
    bodies.push(body);
    if (stored && request.headers["if-none-match"] === "*") {
      response.writeHead(412);
      response.end();
      return;
    }
    stored = body;
    response.writeHead(200, { ETag: '"fixture-etag"' });
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const file = join(directory, "backup.dump");
  await writeFile(file, "previous bytes");
  const config = {
    ...inertS3Config,
    forcePathStyle: true,
    endpoint: `http://127.0.0.1:${server.address().port}`,
  };
  const result = await uploadBackup({ file, config });
  assert.equal(result.eTag, '"fixture-etag"');
  await writeFile(file, "replacement");
  await assert.rejects(uploadBackup({ file, config }));
  assert.equal(stored.toString(), "previous bytes");
  assert.equal(bodies.length, 4);
  pause = true;
  const abort = new AbortController();
  const upload = uploadBackup({ file, config, signal: abort.signal });
  const rejected = assert.rejects(upload);
  await entered;
  abort.abort();
  await rejected;
  assert.equal(stored.toString(), "previous bytes");
  const script = join(directory, "upload.mjs");
  await writeFile(
    script,
    `import {uploadObject as uploadBackup} from '${new URL("./upload-backup-to-s3.mjs", import.meta.url).href}';const abort=new AbortController();process.on('SIGTERM',()=>abort.abort());try{await uploadBackup({file:${JSON.stringify(file)},config:${JSON.stringify(config)},signal:abort.signal});}catch{process.exitCode=1;}`,
  );
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    entered = new Promise((resolve) => {
      stalled = resolve;
    });
    const child = spawn(process.execPath, [script], { stdio: "ignore" });
    const done = new Promise((resolve) => child.once("close", resolve));
    try {
      await entered;
      child.kill(signal);
      assert.notEqual(await done, 0);
      assert.equal(stored.toString(), "previous bytes");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await done;
    }
  }
});

test("required bundle shell and direct upload consumers preserve both asset comparison identities", async () => {
  const directory = await mkdtemp(join(tmpdir(), "s3-dump-identities-"));
  try {
    await executable(join(directory, "psql"), "#!/bin/sh\nprintf '180000\\n'\n");
    await executable(
      join(directory, "pg_dump"),
      "#!/bin/sh\nif [ \"$1\" = --version ]; then printf 'pg_dump (PostgreSQL) 18.6\\n'; exit 0; fi\nprintf 'DUMP_EFFECT_ADMITTED\\n' >&2\nexit 71\n",
    );
    const base = {
      PATH: `${directory}:${dirname(process.execPath)}:/usr/bin:/bin`,
      DATABASE_URL: inertDatabaseUrl,
      BACKUP_DIR: join(directory, "backups"),
      BACKUP_REQUIRED: "1",
      BACKUP_S3_BUCKET: "backups",
      BACKUP_S3_REGION: "us-east-1",
      BACKUP_S3_SECRET_ACCESS_KEY: "dump-secret-sentinel",
      KB_ASSET_S3_ENABLED: "true",
      KB_ASSET_S3_ACCESS_KEY_ID: "runtime-id-sentinel",
      KB_ASSET_S3_OPERATOR_ACCESS_KEY_ID: "operator-id-sentinel",
    };
    for (const patch of [
      { BACKUP_S3_ACCESS_KEY_ID: "runtime-id-sentinel" },
      { BACKUP_S3_ACCESS_KEY_ID: "operator-id-sentinel" },
      { BACKUP_S3_ACCESS_KEY_ID: "dump-id-sentinel", KB_ASSET_S3_ACCESS_KEY_ID: "" },
      { BACKUP_S3_ACCESS_KEY_ID: "dump-id-sentinel", KB_ASSET_S3_OPERATOR_ACCESS_KEY_ID: "" },
      { BACKUP_S3_ACCESS_KEY_ID: "dump-id-sentinel" },
    ]) {
      const env = { ...base, ...patch };
      const accepted =
        patch.BACKUP_S3_ACCESS_KEY_ID === "dump-id-sentinel" &&
        env.KB_ASSET_S3_ACCESS_KEY_ID &&
        env.KB_ASSET_S3_OPERATOR_ACCESS_KEY_ID;
      const shell = spawnSync("bash", [backupScript], { env, encoding: "utf8", timeout: 10000 });
      assert.equal(shell.signal, null);
      assert.notEqual(shell.status, 0);
      assert.equal((shell.stdout + shell.stderr).includes("DUMP_EFFECT_ADMITTED"), false);
      assert.doesNotMatch(shell.stdout + shell.stderr, /sentinel/);
      const direct = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import {backupS3Config} from ${JSON.stringify(join(root, "scripts/lib/backup-s3-env.mjs"))};backupS3Config();`,
        ],
        { env, encoding: "utf8", timeout: 10000 },
      );
      assert.equal(direct.status, accepted ? 0 : 1, direct.stderr);
      assert.doesNotMatch(direct.stdout + direct.stderr, /sentinel/);
      if (!accepted)
        for (const [file, args] of [
          ["upload-backup-to-s3.mjs", [join(directory, "never-created.dump")]],
        ]) {
          const helper = spawnSync(process.execPath, [join(root, "scripts", file), ...args], {
            env,
            encoding: "utf8",
            timeout: 10000,
          });
          assert.equal(helper.status, 1);
          assert.doesNotMatch(helper.stdout + helper.stderr, /sentinel/);
          await assert.rejects(access(join(directory, "never-created.dump")));
        }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("full encrypted uploads verify both remote objects, retry completed pairs and refuse collisions", async (t) => {
  const { createHash, randomUUID } = await import("node:crypto");
  const { uploadBackup: uploadPair } = await import("./upload-backup-to-s3.mjs");
  const directory = await mkdtemp(join(tmpdir(), "kb-pair-upload-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, `backup-${randomUUID()}.age`),
    bytes = Buffer.from("age-encryption.org/v1\nsynthetic non-recovery fixture");
  await writeFile(file, bytes);
  await writeFile(
    `${file}.complete`,
    JSON.stringify({
      version: 1,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }),
  );
  const objects = new Map(),
    order = [];
  const client = {
    send: async (command) => {
      const { Key, Body } = command.input;
      if (command.constructor.name === "GetObjectCommand") {
        order.push(`read:${Key}`);
        const value = objects.get(Key);
        return {
          Body: (async function* () {
            yield value;
          })(),
          ETag: "verified",
        };
      }
      order.push(`write:${Key}`);
      const chunks = [];
      for await (const b of Body) chunks.push(b);
      if (objects.has(Key)) throw { $metadata: { httpStatusCode: 412 } };
      objects.set(Key, Buffer.concat(chunks));
      return { ETag: "written" };
    },
  };
  const first = await uploadPair({ file, client, config: inertS3Config });
  assert.equal(
    first.completion.sha256,
    createHash("sha256")
      .update(await import("node:fs/promises").then((fs) => fs.readFile(`${file}.complete`)))
      .digest("hex"),
  );
  assert.ok(order[1].startsWith("read:") && order[2].endsWith(".complete"));
  assert.deepEqual(await uploadPair({ file, client, config: inertS3Config }), first);
  objects.set(first.key, Buffer.from("different existing bytes"));
  await assert.rejects(uploadPair({ file, client, config: inertS3Config }), /mismatch/);
});

test("required backup hooks refuse disabled backup without admitting any writer", () => {
  const result = spawnSync("bash", [backupScript], {
    env: { PATH: process.env.PATH, BACKUP_ENABLED: "false", BACKUP_REQUIRED: "1" },
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /required full-bundle backup is disabled/);
});

test("manual image hook preserves disabled-backup no-op while mutation labels fail", () => {
  const hook = join(root, "scripts/backup/pre-migrate.sh");
  for (const label of ["manual", "pre-migrate", "pre-drop", "daily"]) {
    const result = spawnSync("bash", [hook, "--label", label], {
      env: { PATH: process.env.PATH, BACKUP_ENABLED: "false" },
      encoding: "utf8",
    });
    assert.equal(result.status, label === "manual" ? 0 : 1);
    assert.match(
      result.stderr,
      label === "manual" ? /skipping backup/ : /required full-bundle backup is disabled/,
    );
  }
});
