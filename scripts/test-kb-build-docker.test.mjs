/**
 * Explicit real-daemon cancellation proof: the `test:kb build` suite, never the
 * Docker-free gate or every harness run.
 *
 * flk8: nothing here measures host speed. Docker work (both builds, the daemon
 * drain inside them, and the CLI readbacks) is bounded only by BUILD_TIMEOUT_MS,
 * the build-only hang guard that never shares a test budget. Everything else is
 * an event wait: the RUN's held request closing, the runner settling, and the
 * daemon's history record completing.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { buildArtifactDirectory } from "../packages/test-utils/src/kb/build-artifacts.mjs";
import { NODE_BASE_IMAGE } from "../packages/test-utils/src/kb/node-image.mjs";
import { BUILD_TIMEOUT_MS, runCaptured } from "./test-kb.mjs";

/** Docker CLI calls stall under I/O pressure; only the build hang guard bounds them. */
const docker = (args) =>
  promisify(execFile)("docker", args, {
    encoding: "utf8",
    timeout: BUILD_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
  });

/** Build-only hang guard for an event that a wedged daemon might never deliver. */
const hangGuard = (promise, what) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`build hang guard: ${what} not observed`)),
        BUILD_TIMEOUT_MS,
      );
    }),
  ]).finally(() => clearTimeout(timer));
};

test("flk4 Docker build cancellation stops real daemon RUN work, then accepts a fresh build", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "kb-daemon-cancel-"));
  const project = `kb-daemon-${randomUUID()}`;
  const image = `${project}:test`;
  const controller = new AbortController();
  let buildName;
  let late = false;
  let served = false;
  let heldClosed;
  const held = new Promise((resolve) => {
    heldClosed = resolve;
  });
  const server = createServer((req, res) => {
    if (req.url === "/ready") {
      // Never served. The RUN has no request timeout and moves on to /late
      // whenever this request ends for any reason while it is still alive, so
      // the connection closing with no /late means the RUN process is gone.
      req.socket.once("close", heldClosed);
      controller.abort();
      return;
    }
    if (req.url === "/late") late = true;
    served = true;
    res.end("ok");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const dockerfile = join(directory, "Dockerfile");
  const run = `import {get} from 'node:http';const hit=(path)=>new Promise((ok,no)=>get('http://127.0.0.1:${port}'+path,(r)=>r.resume().on('end',ok)).on('error',no));await hit('/ready').catch(()=>{});await hit('/late');`;
  writeFileSync(dockerfile, `FROM ${NODE_BASE_IMAGE}\nRUN node --input-type=module -e "${run}"\n`);
  try {
    await assert.rejects(
      runCaptured(
        "docker",
        ["build", "--network=host", "--progress=plain", "-t", image, directory],
        process.env,
        [],
        project,
        BUILD_TIMEOUT_MS,
        AbortSignal.any([controller.signal, context.signal]),
      ),
      (error) => {
        buildName = error.dockerBuildName;
        // ABORT_ERR, not drainIncomplete: the runner settles only after the
        // daemon confirmed the drain, however slowly it answers.
        assert.equal(error.drainIncomplete, undefined, error.message);
        return error.code === "ABORT_ERR";
      },
    );
    // The unique build name identifies only this build in daemon history.
    const { stdout } = await docker(["buildx", "history", "ls", "--no-trunc", "--format", "json"]);
    const record = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find((item) => item.name === buildName);
    assert.ok(record, "must find the actual daemon build record");
    assert.ok(["Error", "Canceled"].includes(record.status), JSON.stringify(record));
    assert.ok(record.completed_at, "daemon work must finish before runner settlement");
    await hangGuard(held, "RUN connection close after cancellation");
    assert.equal(served, false, "the cancelled RUN must not get past its held request");
    assert.equal(late, false, "daemon RUN must not complete its external effect after rejection");
    writeFileSync(dockerfile, `FROM ${NODE_BASE_IMAGE}\nRUN echo fresh-build\n`);
    await runCaptured(
      "docker",
      ["build", "-t", image, directory],
      process.env,
      [],
      project,
      BUILD_TIMEOUT_MS,
      context.signal,
    );
    await docker(["image", "inspect", image]);
    assert.equal(late, false, "the cancelled RUN must stay stopped through the fresh build");
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await docker(["rmi", "-f", image]).catch(() => {});
    rmSync(directory, { recursive: true, force: true });
    rmSync(buildArtifactDirectory(project), { recursive: true, force: true });
  }
});
