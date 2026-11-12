import assert from "node:assert/strict";
import { test } from "node:test";
import {
  evaluateCompression,
  evaluateService,
  parseOptions,
  verifyDeployment,
} from "./verify-dokploy-deployment.mjs";

const service = {
  id: "service",
  version: 1,
  image: "server:latest",
  generation: 2,
  mode: { Replicated: { Replicas: 1 } },
};
const task = {
  id: "task",
  node: "local-host",
  image: service.image,
  generation: 2,
  slot: 1,
  desired: "running",
  status: "running",
  container: { ContainerID: "container", ExitCode: 0 },
};

test("runtime roles are required and the removed applier flag refuses", () => {
  assert.throws(() => parseOptions([]), /required/);
  assert.throws(
    () => parseOptions(["--server", "web", "--url", "https://app.example.com"]),
    /worker/,
  );
  assert.equal(
    parseOptions(["--server", "web", "--worker", "jobs", "--url", "https://app.example.com"])
      .timeout,
    10800,
  );
  assert.throws(
    () =>
      parseOptions([
        "--server",
        "web",
        "--worker",
        "jobs",
        "--applier",
        "schema",
        "--url",
        "https://example.com",
      ]),
    /Use/,
  );
  assert.throws(
    () =>
      parseOptions([
        "--server",
        "web",
        "--worker",
        "jobs",
        "--url",
        "https://user:password@example.com",
      ]),
    /credentials/,
  );
  assert.throws(
    () => parseOptions(["--server", "web", "--worker", "web", "--url", "https://example.com"]),
    /different/,
  );
});

test("previous healthy and terminal one-shot tasks cannot pass a runtime deployment", () => {
  assert.equal(evaluateService("server", service, [{ ...task, generation: 1 }]), null);
  assert.equal(evaluateService("server", service, [{ ...task, status: "complete" }]), null);
});

test("failed, rolled-back or multiple-writer deployment cannot report success", () => {
  assert.throws(
    () => evaluateService("server", service, [{ ...task, status: "failed" }]),
    /failed/,
  );
  assert.throws(
    () =>
      evaluateService("server", { ...service, update: { State: "rollback_completed" } }, [task]),
    /rolled back/,
  );
  for (const role of ["server", "worker"])
    assert.throws(
      () => evaluateService(role, { ...service, mode: { Replicated: { Replicas: 2 } } }, [task]),
      /exactly one/,
    );
});

test("verification cannot bypass the dedicated worker by calling its API directly", async () => {
  await assert.rejects(
    verifyDeployment({ server: "web", url: "https://example.com", timeout: 1 }),
    /worker/,
  );
});

test("verification refuses overlapping old writers and a worker on another host", async () => {
  for (const role of ["server", "worker"]) {
    const selected = task;
    for (const old of [
      { ...task, id: "old", generation: 1, desired: "shutdown" },
      { ...task, id: "old", desired: "shutdown" },
      { ...task, id: "old" },
    ])
      assert.equal(evaluateService(role, service, [selected, old]), null);
  }
  let role;
  const base = fakeDocker();
  await assert.rejects(
    verifyDeployment(
      { server: "web", worker: "jobs", url: "https://example.com", timeout: 1 },
      {
        inspect: async (args) => {
          if (args[0] === "service" && args[1] === "ps") role = args[4];
          if (args[2] === "task")
            return JSON.stringify({ ...task, node: role === "jobs" ? "other-host" : "local-host" });
          return base(args);
        },
        log: () => {},
        fetchReady: async () => ({ status: 200, json: async () => ({ ok: true }) }),
        fetchPage: async () => ({
          headers: new Headers({ "content-encoding": "br" }),
          arrayBuffer: async () => new ArrayBuffer(4096),
        }),
      },
    ),
    /same host/,
  );
});

function fakeDocker({ health = "healthy", mutate = false } = {}) {
  let reads = 0;
  return async (args) => {
    assert.ok(!args.join(" ").includes(".Env"));
    if (args[0] === "service" && args[1] === "inspect")
      return JSON.stringify({ ...service, generation: mutate && reads++ > 0 ? 3 : 2 });
    if (args[0] === "service") return "task";
    if (args[2] === "task") return JSON.stringify(task);
    return JSON.stringify({ running: true, health });
  };
}

test("verification requires healthy selected runtime and JSON public readiness", async () => {
  let queried = false;
  await verifyDeployment(
    { server: "web", worker: "jobs", url: "https://example.com", timeout: 1 },
    {
      inspect: fakeDocker(),
      log: () => {},
      fetchReady: async (url) => {
        queried = true;
        assert.equal(url, "https://example.com/ready");
        return { status: 200, json: async () => ({ ok: true }) };
      },
      fetchPage: async () => ({
        headers: new Headers({ "content-encoding": "br" }),
        arrayBuffer: async () => new ArrayBuffer(4096),
      }),
    },
  );
  assert.equal(queried, true);
  await assert.rejects(
    verifyDeployment(
      { server: "web", worker: "jobs", url: "https://example.com", timeout: 1 },
      { inspect: fakeDocker({ health: null }), log: () => {} },
    ),
    /no healthcheck/,
  );
  await assert.rejects(
    verifyDeployment(
      { server: "web", worker: "jobs", url: "https://example.com", timeout: 1 },
      { inspect: fakeDocker({ mutate: true }), log: () => {} },
    ),
    /changed/,
  );
});

test("an HTTP 200 HTML fallback does not pass public readiness; cancellation fails", async () => {
  const controller = new AbortController();
  await assert.rejects(
    verifyDeployment(
      { server: "web", worker: "jobs", url: "https://example.com", timeout: 1 },
      {
        inspect: fakeDocker(),
        log: () => {},
        signal: controller.signal,
        fetchReady: async () => ({
          status: 200,
          json: async () => {
            throw new Error("HTML");
          },
        }),
        sleep: async () => {
          controller.abort();
        },
      },
    ),
    /cancelled/,
  );
});

test("compression is classified per content-encoding token, including identity and multi-encodings", () => {
  assert.equal(evaluateCompression("gzip"), true);
  assert.equal(evaluateCompression("BR"), true);
  assert.equal(evaluateCompression("zstd"), true);
  assert.equal(evaluateCompression("gzip, br"), true);
  assert.equal(evaluateCompression("identity"), false);
  assert.equal(evaluateCompression(""), false);
  assert.equal(evaluateCompression(null), false);
});

test("compression advisory passes silently when compressed and warns without failing when not", async () => {
  const run = async (fetchPage) => {
    const messages = [];
    await verifyDeployment(
      { server: "web", worker: "jobs", url: "https://example.com", timeout: 1 },
      {
        inspect: fakeDocker(),
        log: (line) => messages.push(line),
        fetchReady: async () => ({ status: 200, json: async () => ({ ok: true }) }),
        fetchPage,
      },
    );
    return messages;
  };
  const page = (encoding, size) => async (url, init) => {
    assert.equal(url, "https://example.com/");
    assert.match(init.headers["accept-encoding"], /gzip/);
    assert.equal(init.redirect, "follow");
    return {
      headers: new Headers(encoding ? { "content-encoding": encoding } : {}),
      arrayBuffer: async () => new ArrayBuffer(size),
    };
  };
  const verified = (messages) => messages.some((line) => line.startsWith("Deployment verified:"));

  const compressed = await run(page("br", 4096));
  assert.ok(compressed.some((line) => /content-encoding: br/.test(line) && !/WARNING/.test(line)));
  assert.ok(verified(compressed));

  const uncompressed = await run(page(null, 4096));
  const warning = uncompressed.find((line) => line.includes("WARNING (non-fatal)"));
  assert.match(warning, /responded uncompressed/);
  assert.match(warning, /traefik\.http\.middlewares\.<name>\.compress/);
  assert.match(warning, /Platforms whose edge compresses for you can ignore this warning\.$/);
  assert.ok(verified(uncompressed));

  const identity = await run(page("identity", 4096));
  assert.match(
    identity.find((line) => line.includes("WARNING")),
    /uncompressed/,
  );

  const tiny = await run(page(null, 12));
  assert.match(
    tiny.find((line) => line.includes("WARNING")),
    /under ~1 KB/,
  );

  const unreadable = await run(async () => {
    throw new Error("offline");
  });
  assert.match(
    unreadable.find((line) => line.includes("WARNING")),
    /could not be verified/,
  );
});
