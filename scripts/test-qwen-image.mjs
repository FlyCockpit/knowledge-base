/**
 * Mandatory built-image smoke for the built-in Qwen model.
 *
 * Host mode (default): verifies the checksum-cached real artifact, builds (or
 * reuses via KB_QWEN_IMAGE) the actual `Dockerfile.worker` runner image for the
 * host's native architecture — Debian `node:26-trixie-slim`, never Alpine — and runs
 * this same file inside it with `--inside`, the model mounted read-only and no
 * network. A missing artifact, checksum mismatch, missing Docker, unsupported
 * architecture or any failed assertion exits non-zero: there is no skip path.
 *
 * Inside mode speaks the real parent/child IPC protocol to the bundled
 * `dist/qwen-child.mjs` through the image's parent-death guard, so it proves:
 * the pinned patched CPU build loads on this arch, descriptor-sized finite
 * vectors, fixture retrieval ordering, the 4096-token context boundary
 * (4095 + EOS accepted, 4096 + EOS rejected without truncation), shutdown exit
 * observed by PID/`/proc` and reload on a new PID, and that the native addon is
 * mapped only by the child. It prints one `QWEN_SMOKE_EVIDENCE {json}` line of
 * versions and rounded numbers (no document text).
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SELF), "..");
const RUNTIME_FIXTURE = join(ROOT, "packages/api/src/lib/kb/fixtures/embedding-runtime.json");
const FIXTURE = join(ROOT, "packages/api/src/lib/kb/fixtures/qwen-artifact.json");
const EVIDENCE_PREFIX = "QWEN_SMOKE_EVIDENCE ";
/** Qwen compatibility smoke config; fresh instances select disabled Gemma1K. */
const DEFAULT_CONTEXT_TOKENS = 4096;

const IN_IMAGE = {
  guard: "/usr/local/bin/kb-child-guard",
  child: "/app/apps/worker/dist/qwen-child.mjs",
  workerModules: "/app/apps/worker/node_modules",
  modelDir: "/models",
  fixture: "/fixture.json",
  runtimeFixture: "/runtime-fixture.json",
};

/** Registry identity; the fixture mirrors model-artifact.ts byte for byte. */
export function loadArtifactIdentity(path = FIXTURE) {
  const { modelId, fileName, sizeBytes, sha256, dimensions, contextTiers, memoryEstimates } =
    JSON.parse(readFileSync(path, "utf8"));
  // Preserve the Qwen compatibility smoke config ({4096, f16, f16}).
  return {
    modelId,
    fileName,
    sizeBytes,
    sha256,
    dimensions,
    contextTiers,
    memoryEstimates,
    contextTokens: DEFAULT_CONTEXT_TOKENS,
  };
}

/**
 * Accepts only a regular file with the pinned size and SHA-256. Used for the CI
 * cache (a tampered cache fails here, before any test) and again in the image.
 */
export async function verifyModelArtifact(path, expected = loadArtifactIdentity()) {
  if (!path) {
    const variable =
      expected.modelId === "embeddinggemma-2-q8_0" ? "KB_GEMMA_MODEL_PATH" : "KB_QWEN_MODEL_PATH";
    throw new Error(`${variable} is required: the qwen-model lane never skips.`);
  }
  let info;
  try {
    info = lstatSync(path);
  } catch {
    throw new Error(`Qwen model artifact missing at ${path}.`);
  }
  if (!info.isFile()) throw new Error("Qwen model artifact must be a regular file (no symlink).");
  if (info.size !== expected.sizeBytes)
    throw new Error(`Qwen model artifact size mismatch (${info.size} != ${expected.sizeBytes}).`);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  const digest = hash.digest("hex");
  if (digest !== expected.sha256) throw new Error("Qwen model artifact checksum mismatch.");
  return { path, sizeBytes: info.size, sha256: digest };
}

/** Native lane only: an image is smoked on the architecture that runs it. */
export function nativeDockerPlatform(arch = process.arch) {
  if (arch === "x64") return { platform: "linux/amd64", arch: "x64" };
  if (arch === "arm64") return { platform: "linux/arm64", arch: "arm64" };
  throw new Error(`Unsupported architecture for the Qwen runtime: ${arch}.`);
}

/** Host-side acceptance of the in-image evidence; every field must be present. */
export function assertSmokeEvidence(evidence, expectedArch, expected = loadArtifactIdentity()) {
  const fail = (what) => {
    throw new Error(`Qwen image smoke evidence invalid: ${what}`);
  };
  if (!evidence || typeof evidence !== "object") fail("missing");
  if (evidence.arch !== expectedArch) fail(`arch ${evidence.arch} != ${expectedArch}`);
  if (!/^v26\./.test(String(evidence.node))) fail(`node ${evidence.node} is not Node 26`);
  if (evidence.libc !== "glibc") fail("not glibc");
  if (evidence.buildType !== "localBuild") fail("native build is not localBuild");
  const pin = JSON.parse(
    readFileSync(
      process.argv.includes("--inside") ? IN_IMAGE.runtimeFixture : RUNTIME_FIXTURE,
      "utf8",
    ),
  );
  if (evidence.nodeLlamaCpp !== pin.nodeLlamaCpp)
    fail(`node-llama-cpp ${evidence.nodeLlamaCpp} is not the pinned ${pin.nodeLlamaCpp}`);
  if (Object.entries(pin).some(([key, value]) => evidence.nativeRuntime?.[key] !== value))
    fail("native runtime pin mismatch");
  if (evidence.modelId !== expected.modelId) fail("model identity");
  if (evidence.dimensions !== expected.dimensions) fail("dimensions");
  if (!(evidence.maxNormError <= 1e-3)) fail("unit norm");
  if (evidence.topDocument !== "sourdough") fail("retrieval ordering");
  if (!(evidence.margin > 0)) fail("retrieval margin");
  if (evidence.acceptedTokens !== expected.contextTokens) fail("context boundary accept");
  if (evidence.rejectedTokens !== expected.contextTokens + 1) fail("context boundary reject");
  if (evidence.overflowCode !== "EMBEDDING_INPUT_TOO_LONG") fail("overflow code");
  if (evidence.idleExitState !== "gone") fail("shutdown child still present");
  if (!(evidence.reloadPid > 0) || evidence.reloadPid === evidence.firstPid) fail("reload PID");
  if (!(evidence.reloadMaxDelta <= 1e-4)) fail("reload determinism");
  if (evidence.parentMapsAddon !== false) fail("parent mapped the native addon");
  if (evidence.childMapsAddon !== true) fail("child did not map the native addon");
  if (!(evidence.referenceMinCosine >= 0.999)) fail("reference cosine");
  if (
    JSON.stringify(evidence.tiers?.map((row) => row.contextTokens)) !==
    JSON.stringify(expected.contextTiers)
  )
    fail("context tiers missing");
  for (const row of evidence.tiers)
    if (
      !(row.peakRssBytes > 0) ||
      !(row.peakRssBytes < expected.memoryEstimates[row.contextTokens]) ||
      row.estimate !== expected.memoryEstimates[row.contextTokens]
    )
      fail("patched memory envelope");
  return true;
}

// ---- inside the image -------------------------------------------------------

const FIXTURE_DOCS = {
  sourdough:
    "To bake sourdough bread, feed the starter, mix flour, water and salt, let the dough rise overnight and bake it in a hot Dutch oven.",
  compiler:
    "The Rust compiler checks ownership and borrowing rules at compile time and reports lifetime errors before the program runs.",
  tides:
    "Ocean tides are caused mainly by the gravitational pull of the Moon, with a smaller contribution from the Sun.",
};
const FIXTURE_QUERY = "how do I bake bread with a sourdough starter";

function procState(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2)[0] === "Z" ? "zombie" : "alive";
  } catch {
    return "gone";
  }
}

function mapsAddon(pid) {
  const maps = readFileSync(`/proc/${pid}/maps`, "utf8");
  return /@node-llama-cpp|libllama|llama-addon|libggml/.test(maps);
}

function normalize(vector) {
  const norm = Math.hypot(...vector);
  return { norm, unit: vector.map((value) => value / norm) };
}

const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);

function startChild(modelPath, identity, contextTokens = identity.contextTokens) {
  const child = spawn(
    IN_IMAGE.guard,
    [String(process.pid), process.execPath, IN_IMAGE.child, identity.modelId],
    {
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      env: {
        KB_QWEN_CHILD: "1",
        KB_QWEN_MODEL_PATH: modelPath,
        KB_QWEN_CONTEXT_TOKENS: String(contextTokens),
        KB_QWEN_KV_KEY_TYPE: "f16",
        KB_QWEN_KV_VALUE_TYPE: "f16",
        PATH: process.env.PATH ?? "",
      },
    },
  );
  const waiting = new Map();
  let exited = false;
  const exit = new Promise((resolveExit) =>
    child.once("exit", () => {
      exited = true;
      for (const { reject } of waiting.values()) reject(new Error("child exited"));
      resolveExit();
    }),
  );
  const ready = new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error("child load timeout")), 180_000);
    child.on("message", (message) => {
      if (message?.t === "ready") {
        clearTimeout(timer);
        resolveReady();
      } else if (message?.t === "load_failed") {
        clearTimeout(timer);
        rejectReady(new Error("verified native runtime or model failed to load"));
      } else if (message?.token && waiting.has(message.token)) {
        const pending = waiting.get(message.token);
        waiting.delete(message.token);
        pending.resolve(message);
      }
    });
    exit.then(() => {
      clearTimeout(timer);
      rejectReady(new Error("child exited before ready"));
    });
  });
  const request = (op, purpose, texts) =>
    new Promise((resolveEmbed, reject) => {
      if (exited) return reject(new Error("child exited"));
      const token = randomBytes(8).toString("hex");
      waiting.set(token, { resolve: resolveEmbed, reject });
      child.send({ t: op, token, purpose, texts });
    });
  return {
    child,
    ready,
    exit,
    embed: (purpose, texts) => request("embed", purpose, texts),
    count: (texts) => request("count", "document", texts),
    probe: () => request("probe", "document", []),
  };
}

function packageVersion(path) {
  return JSON.parse(readFileSync(path, "utf8")).version;
}

async function insideImage(modelPath) {
  const identity = loadArtifactIdentity(IN_IMAGE.fixture);
  await verifyModelArtifact(modelPath, identity);
  const llamaDir = realpathSync(join(IN_IMAGE.workerModules, "node-llama-cpp"));
  const llamaVersion = packageVersion(join(llamaDir, "package.json"));
  const nativeManifestPath = join(
    llamaDir,
    "llama/localBuilds",
    JSON.parse(readFileSync(join(llamaDir, "llama/lastBuild.json"))).folderName,
    "Release/kb-runtime.json",
  );
  const nativeRuntime = JSON.parse(readFileSync(nativeManifestPath)).runtime;
  const libc = process.report?.getReport?.().header?.glibcVersionRuntime ? "glibc" : "other";

  const first = startChild(modelPath, identity);
  await first.ready;
  const names = Object.keys(FIXTURE_DOCS);
  const docs = await first.embed("document", Object.values(FIXTURE_DOCS));
  const query = await first.embed("query", [FIXTURE_QUERY]);
  if (docs.t !== "result" || query.t !== "result") throw new Error("fixture embed failed");
  const all = [...docs.vectors, ...query.vectors];
  let maxNormError = 0;
  const units = all.map((vector) => {
    if (vector.length !== identity.dimensions || vector.some((v) => !Number.isFinite(v)))
      throw new Error("non-finite or wrong-dimension vector");
    const { unit } = normalize(vector);
    maxNormError = Math.max(maxNormError, Math.abs(Math.hypot(...unit) - 1));
    return unit;
  });
  const queryUnit = units.at(-1);
  const scores = names
    .map((name, i) => ({ name, score: dot(queryUnit, units[i]) }))
    .sort((a, b) => b.score - a.score);

  // Find exact model-token boundaries, including document prefix/BOS/EOS.
  const text = (n) => " a".repeat(n);
  let n = identity.contextTokens;
  for (let attempt = 0; attempt < 8; attempt++) {
    const counts = await first.count([text(n)]);
    if (counts.t !== "counts") throw new Error("boundary count failed");
    if (counts.counts[0] === identity.contextTokens) break;
    n += identity.contextTokens - counts.counts[0];
  }
  const boundary = await first.count([text(n), text(n + 1)]);
  if (
    boundary.counts?.[0] !== identity.contextTokens ||
    boundary.counts?.[1] !== identity.contextTokens + 1
  )
    throw new Error("boundary token contract");
  const accepted = await first.embed("document", [text(n)]);
  const rejected = await first.embed("document", [text(n + 1)]);
  if (accepted.t !== "result") throw new Error("exact-context input was not embedded");

  const parentMapsAddon = mapsAddon(process.pid);
  // The guard execs node in place, so the child PID is the model process.
  const childMapsAddon = mapsAddon(first.child.pid);
  const firstPid = first.child.pid;

  // Exercise the shutdown IPC message and OS exit. Supervisor idle timers are
  // exercised separately by the host qwen-model/qwen-process tests.
  // idleExitState is the legacy evidence key for this shutdown/reload check.
  first.child.send({ t: "shutdown" });
  await Promise.race([
    first.exit,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("shutdown exit timeout")), 10_000),
    ),
  ]);
  let idleExitState = procState(firstPid);
  for (let i = 0; i < 100 && idleExitState !== "gone"; i++) {
    await new Promise((r) => setTimeout(r, 20));
    idleExitState = procState(firstPid);
  }

  const reference = JSON.parse(readFileSync("/reference.json", "utf8"));
  let referenceMinCosine = 1;
  const referenceChild = startChild(modelPath, identity);
  await referenceChild.ready;
  for (const item of reference.items) {
    const response = await referenceChild.embed(item.purpose, [item.text]);
    if (response.t !== "result") throw new Error("reference embedding failed");
    const vector = normalize(response.vectors[0]).unit;
    const score = dot(vector, normalize(item.vector).unit);
    referenceMinCosine = Math.min(referenceMinCosine, score);
    if (!(score >= 0.999)) throw new Error(`reference cosine below bound: ${item.id}`);
  }
  referenceChild.child.kill("SIGKILL");
  await referenceChild.exit;
  const tiers = [];
  for (const contextTokens of identity.contextTiers) {
    const tier = startChild(modelPath, identity, contextTokens);
    await tier.ready;
    const response = await tier.probe();
    const estimate = identity.memoryEstimates[contextTokens];
    if (
      response.t !== "result" ||
      !(response.peakRssBytes > 0) ||
      !(response.peakRssBytes < estimate)
    )
      throw new Error(`patched tier memory assertion: ${contextTokens}`);
    tiers.push({ contextTokens, peakRssBytes: response.peakRssBytes, estimate });
    tier.child.kill("SIGKILL");
    await tier.exit;
  }

  const reload = startChild(modelPath, identity);
  await reload.ready;
  const again = await reload.embed("query", [FIXTURE_QUERY]);
  const reloadUnit = normalize(again.vectors[0]).unit;
  const reloadMaxDelta = Math.max(...reloadUnit.map((v, i) => Math.abs(v - queryUnit[i])));
  const reloadPid = reload.child.pid;
  reload.child.kill("SIGKILL");
  await reload.exit;

  const round = (value) => Math.round(value * 1000) / 1000;
  const evidence = {
    node: process.version,
    arch: process.arch,
    libc,
    nodeLlamaCpp: llamaVersion,
    buildType: "localBuild",
    nativeRuntime,
    modelId: identity.modelId,
    dimensions: all[0].length,
    maxNormError: round(maxNormError),
    rawNorm: round(Math.hypot(...all.at(-1))),
    scores: scores.map(({ name, score }) => ({ name, score: round(score) })),
    topDocument: scores[0].name,
    margin: round(scores[0].score - scores[1].score),
    acceptedTokens: identity.contextTokens,
    rejectedTokens: rejected.t === "error" ? identity.contextTokens + 1 : -1,
    overflowCode: rejected.t === "error" ? rejected.code : null,
    firstPid,
    idleExitState,
    reloadPid,
    reloadMaxDelta,
    parentMapsAddon,
    childMapsAddon,
    referenceMinCosine,
    tiers,
  };
  process.stdout.write(`${EVIDENCE_PREFIX}${JSON.stringify(evidence)}\n`);
}

// ---- host ---------------------------------------------------------------------

function docker(args, options = {}) {
  return execFileSync("docker", args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
}

function removeSmokeContainer(name) {
  try {
    docker(["rm", "--force", name], { stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
  } catch (error) {
    if (!String(error.stderr).includes(`No such container: ${name}`)) throw error;
  }
  if (docker(["ps", "--all", "--quiet", "--filter", `name=^/${name}$`], { timeout: 60_000 }).trim())
    throw new Error(`Model smoke container survived cleanup: ${name}`);
}

export function parseEvidence(stdout) {
  const line = String(stdout)
    .split("\n")
    .find((entry) => entry.startsWith(EVIDENCE_PREFIX));
  if (!line) throw new Error("Qwen image smoke produced no evidence line.");
  return JSON.parse(line.slice(EVIDENCE_PREFIX.length));
}

export async function runImageSmoke({
  modelPath = process.env.KB_QWEN_MODEL_PATH,
  image = process.env.KB_QWEN_IMAGE,
  evidenceOut = process.env.KB_QWEN_EVIDENCE_OUT,
  modelId,
} = {}) {
  const artifactFixture =
    modelId === "embeddinggemma-2-q8_0"
      ? join(ROOT, "packages/api/src/lib/kb/fixtures/gemma-artifact.json")
      : FIXTURE;
  const identity = loadArtifactIdentity(artifactFixture);
  const artifact = await verifyModelArtifact(modelPath, identity);
  const { platform, arch } = nativeDockerPlatform();
  try {
    docker(["info"], { stdio: ["ignore", "ignore", "ignore"] });
  } catch {
    throw new Error("Docker is required for the qwen-model image lane (daemon not reachable).");
  }
  const built = !image;
  const container = `kb-model-smoke-${process.pid}-${randomBytes(6).toString("hex")}`;
  const tag = image ?? `kb-worker-qwen-smoke:${process.pid}-${randomBytes(3).toString("hex")}`;
  try {
    if (built)
      docker(
        [
          "build",
          "--platform",
          platform,
          "-f",
          "Dockerfile.worker",
          "--target",
          "runner",
          "-t",
          tag,
          ".",
        ],
        {
          stdio: ["ignore", "inherit", "inherit"],
        },
      );
    const imageArch = docker(["image", "inspect", "--format", "{{.Architecture}}", tag]).trim();
    if (imageArch !== (arch === "x64" ? "amd64" : "arm64"))
      throw new Error(`Image architecture ${imageArch} does not match the native lane ${arch}.`);
    const out = docker([
      "run",
      "--name",
      container,
      "--rm",
      "--network",
      "none",
      "--platform",
      platform,
      "--memory",
      "3g",
      "--entrypoint",
      "node",
      "-v",
      `${realpathSync(artifact.path)}:${IN_IMAGE.modelDir}/${identity.fileName}:ro`,
      "-v",
      `${SELF}:/smoke/test-qwen-image.mjs:ro`,
      "-v",
      `${artifactFixture}:${IN_IMAGE.fixture}:ro`,
      "-v",
      `${RUNTIME_FIXTURE}:${IN_IMAGE.runtimeFixture}:ro`,
      "-v",
      `${join(ROOT, modelId === "embeddinggemma-2-q8_0" ? "packages/test-utils/src/kb/gemma-reference.json" : "packages/test-utils/src/kb/qwen-batch-reference.json")}:/reference.json:ro`,
      tag,
      "/smoke/test-qwen-image.mjs",
      "--inside",
      `${IN_IMAGE.modelDir}/${identity.fileName}`,
    ]);
    const evidence = parseEvidence(out);
    assertSmokeEvidence(evidence, arch, identity);
    process.stdout.write(`${EVIDENCE_PREFIX}${JSON.stringify(evidence)}\n`);
    if (evidenceOut) writeFileSync(evidenceOut, `${JSON.stringify(evidence, null, 2)}\n`);
    return evidence;
  } finally {
    try {
      // Ownership precedes `run`: even a stalled create has an exact name.
      removeSmokeContainer(container);
    } finally {
      if (built) docker(["image", "rm", "-f", tag], { stdio: ["ignore", "ignore", "ignore"] });
    }
  }
}

/**
 * Release gate over uploaded per-arch evidence: every expected `file:arch` pair
 * must exist and pass. A missing or skipped leg therefore fails the gate.
 */
export function checkEvidenceFiles(
  pairs,
  required = ["x64", "arm64"],
  expected = loadArtifactIdentity(),
) {
  const seen = new Set();
  for (const pair of pairs) {
    const index = pair.lastIndexOf(":");
    const file = pair.slice(0, index);
    const arch = pair.slice(index + 1);
    let evidence;
    try {
      evidence = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      throw new Error(`Missing Qwen smoke evidence for ${arch}.`);
    }
    assertSmokeEvidence(evidence, arch, expected);
    seen.add(arch);
  }
  const missing = required.filter((arch) => !seen.has(arch));
  if (missing.length > 0) throw new Error(`Missing Qwen smoke lanes: ${missing.join(", ")}.`);
  return true;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === SELF;
if (isMain) {
  const args = process.argv.slice(2);
  const run =
    args[0] === "--inside"
      ? insideImage(args[1] ?? "")
      : args[0] === "--verify-gemma"
        ? verifyModelArtifact(
            args[1],
            loadArtifactIdentity(
              join(ROOT, "packages/api/src/lib/kb/fixtures/gemma-artifact.json"),
            ),
          )
        : args[0] === "--check-gemma-evidence"
          ? Promise.resolve().then(() =>
              checkEvidenceFiles(
                args.slice(1),
                ["x64", "arm64"],
                loadArtifactIdentity(
                  join(ROOT, "packages/api/src/lib/kb/fixtures/gemma-artifact.json"),
                ),
              ),
            )
          : args[0] === "--verify-only"
            ? verifyModelArtifact(args[1])
            : args[0] === "--check-evidence"
              ? Promise.resolve().then(() => checkEvidenceFiles(args.slice(1)))
              : runImageSmoke({ modelPath: args[0] });
  run.then(
    () => process.exit(0),
    (error) => {
      console.error(error?.message ?? String(error));
      process.exit(1);
    },
  );
}
