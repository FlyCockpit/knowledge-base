import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  classify,
  failureHint,
  formatWait,
  parseArgs,
  probe,
  sameCommit,
  UsageError,
  waitForRelease,
} from "./deploy-check.mjs";

const NEW = "1234567890abcdef1234567890abcdef12345678";
const OLD = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";

test("arguments: one https origin, optional commit and timeout", () => {
  assert.deepEqual(parseArgs(["https://app.example.com/"]), {
    url: "https://app.example.com",
    commit: null,
    timeoutSeconds: 10800,
  });
  assert.deepEqual(parseArgs(["http://localhost:3000", "--commit", "ABCDEF1", "--timeout=60"]), {
    url: "http://localhost:3000",
    commit: "abcdef1",
    timeoutSeconds: 60,
  });
  for (const bad of [
    [],
    ["http://app.example.com"],
    ["https://u:p@app.example.com"],
    ["https://app.example.com?x=1"],
    ["https://a.example.com", "https://b.example.com"],
    ["https://app.example.com", "--commit", "xyz"],
    ["https://app.example.com", "--commit", "abc12"],
    ["https://app.example.com", "--timeout", "0"],
    ["https://app.example.com", "--timeout", "1.5"],
    ["https://app.example.com", "--timeout", "21601"],
    ["https://app.example.com", "--commit"],
    ["https://app.example.com", "--bogus"],
  ])
    assert.throws(() => parseArgs(bad), UsageError, JSON.stringify(bad));
});

test("short and full SHAs match each other; different or too-short ones do not", () => {
  assert.equal(sameCommit(NEW, NEW.slice(0, 7)), true);
  assert.equal(sameCommit(NEW.slice(0, 12), NEW), true);
  assert.equal(sameCommit(NEW, OLD), false);
  assert.equal(sameCommit(NEW, NEW.slice(0, 6)), false);
  assert.equal(sameCommit(null, NEW), false);
  assert.equal(sameCommit(`${NEW}garbage`, NEW), false);
});

test("each /ready answer maps to one state", () => {
  const ready = (body, status = 200) => classify({ status, body }, NEW);
  assert.equal(ready({ ok: true, commit: NEW, checks: {} }).state, "pass");
  assert.equal(ready({ ok: true, commit: NEW }, 503).state, "not-ready");
  assert.equal(ready({ ok: true, commit: OLD }).state, "old");
  assert.equal(ready({ ok: false, commit: NEW, checks: { redis: false } }, 503).state, "not-ready");
  assert.equal(ready({ ok: true, commit: null }).state, "unknown-commit");
  assert.equal(ready({ ok: true }).state, "unreachable", "an old image without the field");
  assert.equal(ready(null, 502).state, "unreachable");
  assert.equal(ready({ error: "Too many requests" }, 429).state, "throttled");
  assert.equal(classify({ error: "ECONNREFUSED" }, NEW).state, "unreachable");
  for (const state of ["old", "not-ready", "unknown-commit", "unreachable"])
    assert.ok(failureHint({ state, detail: "" }).length > 20);
});

/** A local /ready server whose answers come from `answers` in order (last repeats). */
async function serve(answers) {
  let calls = 0;
  const server = createServer((request, response) => {
    const answer = answers[Math.min(calls, answers.length - 1)];
    calls++;
    assert.equal(request.url, "/ready");
    response.writeHead(answer.status, { "content-type": "application/json" });
    response.end(JSON.stringify(answer.body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
  return { url: `http://127.0.0.1:${port}`, server, calls: () => calls };
}

test("probe reads a live /ready over HTTP and never throws", async () => {
  const local = await serve([{ status: 503, body: { ok: false, commit: NEW, checks: {} } }]);
  try {
    assert.deepEqual(await probe(local.url), {
      status: 503,
      body: { ok: false, commit: NEW, checks: {} },
    });
  } finally {
    local.server.close();
  }
  const refused = await probe(local.url);
  assert.ok("error" in refused);
});

test("waits through the old release and a not-ready start, then passes on two ready answers", async () => {
  const local = await serve([
    { status: 200, body: { ok: true, commit: OLD, checks: {} } },
    { status: 429, body: { error: "slow down" } },
    { status: 503, body: { ok: false, commit: NEW, checks: { workers: false } } },
    { status: 200, body: { ok: true, commit: NEW, checks: {} } },
  ]);
  const lines = [];
  try {
    const result = await waitForRelease(
      { url: local.url, commit: NEW.slice(0, 7), timeoutSeconds: 60 },
      { pollMs: 1, log: (line) => lines.push(line) },
    );
    assert.equal(result.pass, true);
    assert.equal(local.calls(), 5);
    assert.deepEqual(
      lines.map((line) => line.replace(/^\[deploy:check\] /, "").split(" ")[0]),
      ["serving", "rate", "new", "serving"],
    );
  } finally {
    local.server.close();
  }
});

test("fails at the timeout while the old release keeps serving", async () => {
  const local = await serve([{ status: 200, body: { ok: true, commit: OLD, checks: {} } }]);
  let clock = 0;
  try {
    const result = await waitForRelease(
      { url: local.url, commit: NEW, timeoutSeconds: 30 },
      { pollMs: 10_000, now: () => clock, sleep: async (ms) => (clock += ms), log: () => {} },
    );
    assert.equal(result.pass, false);
    assert.equal(result.last?.state, "old");
    assert.equal(local.calls(), 4);
  } finally {
    local.server.close();
  }
});

test("the CLI prints PASS/FAIL and exits 0/1/2", async () => {
  const local = await serve([{ status: 200, body: { ok: true, commit: NEW, checks: {} } }]);
  const script = fileURLToPath(new URL("./deploy-check.mjs", import.meta.url));
  const run = (args) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [script, ...args], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout.on("data", (chunk) => (out += chunk));
      child.stderr.on("data", (chunk) => (out += chunk));
      child.on("close", (code) => resolve({ code, out }));
    });
  try {
    const usage = await run(["not a url"]);
    assert.equal(usage.code, 2);
    // Two answers 10 s apart are needed to pass; keep the test fast with a
    // commit that never matches and a 1 s timeout for FAIL instead.
    const fail = await run([local.url, "--commit", OLD, "--timeout", "1"]);
    assert.equal(fail.code, 1);
    assert.match(fail.out, /^FAIL: /m);
    assert.match(fail.out, /dokploy:verify/);
  } finally {
    local.server.close();
  }
});

test("the wait is shown in seconds under a minute, else in minutes", () => {
  assert.equal(formatWait(30), "30 s");
  assert.equal(formatWait(59), "59 s");
  assert.equal(formatWait(60), "1 min");
  assert.equal(formatWait(1200), "20 min");
});
