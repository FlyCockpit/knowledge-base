import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { buildArtifactPath } from "../packages/test-utils/src/kb/build-artifacts.mjs";
import {
  assertBrowserReport,
  assertImageGitReached,
  assertSuiteCoverage,
  checkPrerequisites,
  filesForSuite,
  ISOLATED_NODE_OPTIONS,
  installImageGit,
  listIntegrationFiles,
  matchGlob,
  parseRunProject,
  reapDeadRuns,
  redactText,
  removeImageContainers,
  resolveAgeDir,
  resolveSuiteName,
  resolveTestTimeZones,
  runIsLive,
  runSuite,
  SUITES,
  splitSupervisedIncludes,
  supervisedVitestArgv,
  vitestInvocations,
} from "./test-kb.mjs";
import {
  assertSmokeEvidence,
  checkEvidenceFiles,
  loadArtifactIdentity,
  nativeDockerPlatform,
  parseEvidence,
  verifyModelArtifact,
} from "./test-qwen-image.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Synthetic suites belong to regenerable output, outside the source inventory.
function selfTestDirectory(tag) {
  const output = join(ROOT, ".turbo");
  mkdirSync(output, { recursive: true });
  return mkdtempSync(join(output, `kb-self-${tag}-`));
}

const runner = join(ROOT, "scripts/test-kb.mjs");

describe("test-kb runner", () => {
  it("model smoke validates both architectures from the current candidate workflow run", () => {
    const workflow = readFileSync(join(ROOT, ".github/workflows/kb-model-smoke.yml"), "utf8");
    const smoke = workflow.slice(workflow.indexOf("  smoke:"), workflow.indexOf("  rust-smoke:"));
    const required = workflow.slice(workflow.indexOf("  required:"));
    for (const job of [smoke, required])
      assert.match(job, /name: Checkout[\s\S]*?ref: \$\{\{ github\.sha \}\}/);
    assert.match(smoke, /arch: x64\n\s+runner: ubuntu-latest/);
    assert.match(smoke, /arch: arm64\n(?:\s+#.*\n)*\s+runner: ubuntu-26\.04-arm/);
    assert.match(smoke, /name: qwen-evidence-\$\{\{ matrix\.arch \}\}/);
    assert.match(smoke, /name: gemma-evidence-\$\{\{ matrix\.arch \}\}/);
    // No cross-run or alternate-repository artifact selector can supply evidence.
    assert.doesNotMatch(required, /run-id:|repository:|github-token:/);
    assert.match(required, /pattern: "\*-evidence-\*"/);
    assert.match(
      required,
      /--check-evidence evidence\/qwen-evidence-x64\.json:x64 evidence\/qwen-evidence-arm64\.json:arm64/,
    );
    assert.match(
      required,
      /--check-gemma-evidence evidence\/gemma-evidence-x64\.json:x64 evidence\/gemma-evidence-arm64\.json:arm64/,
    );
    const block = required
      .split("      - name: Every matrix leg succeeded\n        run: |\n")[1]
      .split("\n      - name:")[0]
      .split("\n")
      .map((line) => line.slice(10))
      .join("\n")
      .replaceAll(`\${{ needs.smoke.result }}`, `\${SMOKE_RESULT}`)
      .replaceAll(`\${{ needs.rust-smoke.result }}`, `\${RUST_RESULT}`);
    for (const smokeResult of ["success", "failure", "cancelled", "skipped", ""]) {
      for (const rustResult of ["success", "failure", "cancelled", "skipped", ""]) {
        const result = spawnSync("bash", ["-euc", block], {
          env: { PATH: process.env.PATH, SMOKE_RESULT: smokeResult, RUST_RESULT: rustResult },
          encoding: "utf8",
          timeout: 10_000,
        });
        assert.equal(result.status === 0, smokeResult === "success" && rustResult === "success");
      }
    }
  });

  it("CI inventories every suite and its required prerequisites, and the aggregate fails closed", () => {
    const workflow = readFileSync(join(ROOT, ".github/workflows/pr-checks.yml"), "utf8");
    const lines = workflow.split("\n");
    const runBlock = (name) => {
      const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
      assert.ok(start >= 0, name);
      const run = lines.findIndex((line, i) => i > start && line.trim() === "run: |");
      assert.ok(run > start, name);
      const body = [];
      for (const line of lines.slice(run + 1)) {
        if (line.trim() && !line.startsWith("          ")) break;
        body.push(line.slice(10));
      }
      return body.join("\n");
    };
    const tmp = mkdtempSync(join(tmpdir(), "kb-ci-matrix-"));
    try {
      const output = join(tmp, "output");
      const result = spawnSync(
        "bash",
        ["-euc", runBlock("Inventory every registered integration suite")],
        {
          cwd: ROOT,
          env: { PATH: process.env.PATH, GITHUB_OUTPUT: output },
          encoding: "utf8",
          timeout: 10_000,
        },
      );
      assert.equal(result.status, 0, result.stderr);
      const matrix = JSON.parse(readFileSync(output, "utf8").trim().slice("json=".length));
      assert.deepEqual(
        matrix.map((row) => row.suite),
        Object.entries(SUITES)
          .filter(([, suite]) => !suite.qwenModel)
          .map(([name]) => name),
      );
      assert.ok(matrix.length > 0);
      for (const row of matrix) {
        assert.equal(row.browser, Boolean(SUITES[row.suite].playwright));
      }
      assert.match(workflow, /include: \$\{\{ fromJSON\(needs\.setup\.outputs\.kb-suites\) \}\}/);
      assert.match(workflow, /run: pnpm test:kb -- \$\{\{ matrix\.suite \}\}/);
      assert.match(
        workflow,
        /Install Chromium and its system dependencies\n\s+if: matrix\.browser\n\s+run: pnpm --filter web exec playwright install --with-deps chromium/,
      );
      const modelWorkflow = readFileSync(
        join(ROOT, ".github/workflows/kb-model-smoke.yml"),
        "utf8",
      );
      assert.match(modelWorkflow, /pnpm test:kb -- qwen-model/);
      assert.match(modelWorkflow, /--check-evidence/);
      assert.match(modelWorkflow, /--check-gemma-evidence/);
      assert.deepEqual(
        Object.entries(SUITES)
          .filter(([, suite]) => suite.qwenModel)
          .map(([name]) => name),
        ["qwen-model"],
      );
      const aggregate = runBlock("Require every registered suite to pass");
      for (const draft of ["false", "true"]) {
        for (const status of ["success", "failure", "cancelled", "skipped", ""]) {
          const result = spawnSync("bash", ["-euc", aggregate], {
            env: { PATH: process.env.PATH, DRAFT: draft, RESULT: status },
            encoding: "utf8",
            timeout: 10_000,
          });
          const allowed = status === "success" || (draft === "true" && status === "skipped");
          assert.equal(result.status === 0, allowed, `${draft}/${status}`);
        }
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("runs supervised integration files apart from their mocked unit files", () => {
    for (const [name, suite] of Object.entries(SUITES).filter(([, suite]) => suite.supervised)) {
      const [supervised, plain] = splitSupervisedIncludes(suite.include);
      assert.ok(supervised.length > 0, name);
      assert.ok(
        supervised.every((file) => file.endsWith(".integration.test.ts")),
        name,
      );
      assert.ok(
        plain.every((file) => !file.endsWith(".integration.test.ts")),
        name,
      );
      assert.deepEqual([...supervised, ...plain].sort(), [...suite.include].sort(), name);
    }
    assert.throws(() => splitSupervisedIncludes(["apps/server/src/git-http.test.ts"]));
  });

  it("keeps one long-lived non-isolated thread for the supervisor's control connection", () => {
    const argv = supervisedVitestArgv("/usr/bin/node");
    assert.equal(argv[0], "--");
    assert.equal(argv[1], "/usr/bin/node");
    for (const flag of ["--pool=threads", "--maxWorkers=1", "--isolate=false"])
      assert.ok(argv.includes(flag), flag);
  });

  it("supervised teardown preserves pass/fail and still rejects interruption during tests", () => {
    const tmp = mkdtempSync(join(tmpdir(), "kb-supervised-teardown-"));
    try {
      const setup = join(ROOT, "scripts/kb-supervised-vitest-setup.ts");
      const run = (
        code,
        duringTest = false,
        unhandled = false,
        pendingSibling = false,
        fileFailed = false,
        reportingPending = false,
      ) => {
        const child = join(tmp, "probe.mjs");
        writeFileSync(
          child,
          `
          import setup from ${JSON.stringify(setup)};
          let reported = ${JSON.stringify(!reportingPending)};
          // Vitest's terminal cleanup races worker/control-channel teardown.
          process.once("SIGTERM", () => process.exit(99));
          setup({ vitest: { config: { include: ${JSON.stringify(pendingSibling ? ["probe.test.ts", "pending.test.ts"] : ["probe.test.ts"])} }, state: {
            getFiles: () => ${duringTest ? "[]" : "[{ result: { state: reported ? " + JSON.stringify(code || fileFailed ? "fail" : "pass") + " : 'run' } }]"},
            getUnhandledErrors: () => ${unhandled ? "[new Error('fixture error')]" : "[]"},
          } } });
          process.exitCode = ${code};
          // Worker teardown can precede global teardown and result reporting.
          process.kill(process.pid, "SIGTERM");
          setTimeout(() => { reported = true; }, 25);
        `,
        );
        return spawnSync(process.execPath, [child], {
          cwd: ROOT,
          encoding: "utf8",
          timeout: 5000,
        });
      };
      assert.equal(run(0).status, 0);
      assert.equal(
        run(0, false, false, false, false, true).status,
        0,
        "worker exit before main-thread reporting must preserve success",
      );
      assert.equal(
        run(0, false, false, false, true, true).status,
        1,
        "late reporting of a failed file must still fail",
      );
      assert.equal(run(1).status, 1, "a failed suite must stay failed");
      assert.equal(run(0, true).status, 1, "interruption before completion must fail");
      assert.equal(run(0, false, true).status, 1, "unhandled errors must fail");
      assert.equal(run(0, false, false, true).status, 1, "an uncollected selected file must fail");
      assert.equal(
        run(0, false, false, false, true).status,
        1,
        "failure before reporting must fail",
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("browser suite fails unless Playwright executed and passed every test", () => {
    assert.equal(SUITES.browser.playwright, "apps/web/playwright.kb.config.ts");
    assert.equal(
      assertBrowserReport({ stats: { expected: 5, unexpected: 0, flaky: 0, skipped: 0 } }),
      5,
    );
    assert.throws(() => assertBrowserReport(undefined), /no browser tests ran/);
    assert.throws(() => assertBrowserReport({}), /no browser tests ran/);
    assert.throws(
      () => assertBrowserReport({ stats: { expected: 0 } }),
      /No browser tests executed/,
    );
    assert.throws(() => assertBrowserReport({ stats: { expected: 3, unexpected: 1 } }), /failed/);
    assert.throws(() => assertBrowserReport({ stats: { expected: 3, flaky: 1 } }), /failed/);
    assert.throws(() => assertBrowserReport({ stats: { expected: 3, skipped: 1 } }), /skipped/);
  });

  it("rejects an unknown suite", () => {
    assert.throws(() => resolveSuiteName(["not-a-suite"]), /Unknown suite: not-a-suite/);
    const result = spawnSync(process.execPath, [runner, "not-a-suite"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /Unknown suite: not-a-suite/);
  });

  it("fails a suite that matches no tests", async () => {
    assert.equal(
      filesForSuite({ include: ["does-not-exist/**/*.integration.test.ts"] }, []).length,
      0,
    );
    await assert.rejects(
      runSuite(
        "empty",
        { include: ["does-not-exist/**/*.integration.test.ts"], services: [] },
        {
          skipServices: true,
          files: [],
        },
      ),
      /matched no tests/,
    );
  });

  it("keeps an intentional failed assertion failed", async () => {
    const dir = selfTestDirectory("fail");
    const abs = join(dir, "fail.integration.test.ts");
    const rel = relative(ROOT, abs).replaceAll("\\", "/");
    writeFileSync(
      abs,
      `import { it, expect } from "vitest";\nit("fails", () => { expect(1).toBe(2); });\n`,
    );
    try {
      assert.ok(
        !listIntegrationFiles().includes(rel),
        "synthetic suites stay out of source discovery",
      );
      await assert.rejects(
        runSuite(
          "self-fail",
          { include: [rel], services: [] },
          { skipServices: true, files: [rel], project: `kb-self-fail-${process.pid}` },
        ),
        (error) => {
          assert.notEqual(error.status, 0);
          assert.match(`${error.stdout ?? ""}${error.stderr ?? ""}`, /expected 1 to be 2/);
          return true;
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed when Docker or Git is missing", () => {
    assert.throws(
      () => checkPrerequisites({ dockerBin: "/nonexistent/kb-docker", git: false }),
      /Docker is required/,
    );
    assert.throws(
      () => checkPrerequisites({ docker: false, gitBin: "/nonexistent/kb-git" }),
      /Git is required/,
    );
  });

  it("registers every integration file on exactly one suite", () => {
    assert.equal(
      matchGlob("packages/auth/src/bootstrap.integration.test.ts", SUITES.bootstrap.include[0]),
      true,
    );
    assert.throws(
      () =>
        assertSuiteCoverage({ harness: { include: ["a.integration.test.ts"] } }, [
          "a.integration.test.ts",
          "orphan.integration.test.ts",
        ]),
      /not registered/,
    );
    assert.throws(
      () =>
        assertSuiteCoverage(
          {
            a: { include: ["shared.integration.test.ts"] },
            b: { include: ["shared.integration.test.ts"] },
          },
          ["shared.integration.test.ts"],
        ),
      /belongs to both/,
    );
    assertSuiteCoverage();
  });

  it("suites needing age get the pinned binaries: KB_AGE_DIR must be v1.3.2, else the pin script provisions", async () => {
    assert.equal(SUITES.backup.age, true);
    const dir = mkdtempSync(join(tmpdir(), "kb-age-dir-"));
    try {
      for (const [bin, version] of [
        ["age", "v1.3.2"],
        ["age-keygen", "v1.2.1"],
      ])
        writeFileSync(join(dir, bin), `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
      const never = () => assert.fail("explicit KB_AGE_DIR must not provision");
      await assert.rejects(
        resolveAgeDir({ KB_AGE_DIR: dir }, never),
        /KB_AGE_DIR=.*v1\.3\.2 not found/,
      );
      writeFileSync(join(dir, "age-keygen"), "#!/bin/sh\necho v1.3.2\n", { mode: 0o755 });
      assert.equal(await resolveAgeDir({ KB_AGE_DIR: dir }, never), dir);
      const env = { XDG_CACHE_HOME: dir };
      assert.equal(
        await resolveAgeDir(env, async (options) => {
          assert.equal(options.env, env);
          return "/cache/age";
        }),
        "/cache/age",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pins distinct non-UTC process and PostgreSQL time zones", () => {
    assert.deepEqual(resolveTestTimeZones({}), {
      tz: "America/Chicago",
      pgTimeZone: "Pacific/Kiritimati",
    });
    assert.deepEqual(resolveTestTimeZones({ KB_TEST_TZ: "Pacific/Pago_Pago" }), {
      tz: "Pacific/Pago_Pago",
      pgTimeZone: "Pacific/Kiritimati",
    });
    assert.deepEqual(resolveTestTimeZones({ KB_TEST_TZ: "Pacific/Kiritimati" }), {
      tz: "Pacific/Kiritimati",
      pgTimeZone: "Pacific/Pago_Pago",
    });
    assert.throws(() => resolveTestTimeZones({ KB_TEST_TZ: "UTC" }), /UTC offset of zero/);
    assert.throws(() => resolveTestTimeZones({ KB_TEST_TZ: "Etc/GMT" }), /UTC offset of zero/);
    assert.throws(
      () => resolveTestTimeZones({ KB_TEST_TZ: "Europe/London" }),
      /UTC offset of zero/,
    );
    assert.throws(() => resolveTestTimeZones({ KB_TEST_TZ: "Not/AZone" }), /not a valid IANA/);
    assert.throws(
      () => resolveTestTimeZones({ KB_TEST_PG_TIMEZONE: "Etc/UTC" }),
      /UTC offset of zero/,
    );
    assert.throws(
      () =>
        resolveTestTimeZones({
          KB_TEST_TZ: "Asia/Tokyo",
          KB_TEST_PG_TIMEZONE: "Asia/Tokyo",
        }),
      /must differ/,
    );
  });

  it("honours an inherited TZ, and falls back when it cannot pin", () => {
    // The acceptance criteria spell the override as `TZ=<zone> pnpm test:kb`.
    assert.deepEqual(resolveTestTimeZones({ TZ: "Pacific/Pago_Pago" }), {
      tz: "Pacific/Pago_Pago",
      pgTimeZone: "Pacific/Kiritimati",
    });
    assert.deepEqual(resolveTestTimeZones({ TZ: "Pacific/Kiritimati" }), {
      tz: "Pacific/Kiritimati",
      pgTimeZone: "Pacific/Pago_Pago",
    });
    // KB_TEST_TZ is the explicit variable and wins over an inherited TZ.
    assert.deepEqual(resolveTestTimeZones({ KB_TEST_TZ: "Asia/Tokyo", TZ: "Pacific/Pago_Pago" }), {
      tz: "Asia/Tokyo",
      pgTimeZone: "Pacific/Kiritimati",
    });
    // A UTC-at-solstice or invalid inherited TZ cannot decide the pin.
    assert.deepEqual(resolveTestTimeZones({ TZ: "UTC" }), {
      tz: "America/Chicago",
      pgTimeZone: "Pacific/Kiritimati",
    });
    assert.deepEqual(resolveTestTimeZones({ TZ: "Not/AZone" }), {
      tz: "America/Chicago",
      pgTimeZone: "Pacific/Kiritimati",
    });
  });

  it("runs an isolated-first file alone, first, in its own vitest process", async () => {
    const dir = selfTestDirectory("iso");
    const log = join(dir, "run.log");
    const rel = (name) =>
      relative(ROOT, join(dir, `${name}.integration.test.ts`)).replaceAll("\\", "/");
    const write = (name) =>
      writeFileSync(
        join(ROOT, rel(name)),
        [
          'import { appendFileSync } from "node:fs";',
          'import { it } from "vitest";',
          `it("${name}", () => {`,
          `  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ name: "${name}", pid: process.pid, isolated: process.env.KB_TEST_ISOLATED_FILE ?? null, include: process.env.KB_TEST_INCLUDE, nodeOptions: process.env.NODE_OPTIONS ?? "" }) + "\\n");`,
          "});",
          "",
        ].join("\n"),
      );
    write("a");
    write("b");
    try {
      const suite = { include: [rel("b"), rel("a")], isolatedFirst: [rel("a")], services: [] };
      assert.deepEqual(vitestInvocations(suite), [
        { include: [rel("a")], isolated: rel("a"), nodeOptions: ISOLATED_NODE_OPTIONS },
        { include: [rel("b")] },
      ]);
      await runSuite("iso", suite, {
        skipServices: true,
        files: [rel("a"), rel("b")],
        project: `kb-iso-${process.pid}`,
      });
      const lines = readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.deepEqual(
        lines.map((l) => [l.name, l.isolated, l.include]),
        [
          ["a", rel("a"), rel("a")],
          ["b", null, rel("b")],
        ],
      );
      assert.notEqual(lines[0].pid, lines[1].pid);
      // The isolated test process (Vitest's fork) runs with V8's
      // young generation pinned; the shared run does not.
      assert.match(lines[0].nodeOptions, /(^|\s)--max-semi-space-size=\d+(\s|$)/);
      assert.ok(lines[0].nodeOptions.includes(ISOLATED_NODE_OPTIONS));
      assert.equal(lines[1].nodeOptions.includes("--max-semi-space-size"), false);
      assert.throws(
        () => vitestInvocations({ include: [rel("b")], isolatedFirst: [rel("a")] }),
        /isolatedFirst/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("the exports RSS test is the exports suite's isolated-first file", () => {
    const rss = "packages/test-utils/src/kb/exports-rss.integration.test.ts";
    const runs = vitestInvocations(SUITES.exports);
    assert.deepEqual(runs[0], {
      include: [rss],
      isolated: rss,
      nodeOptions: ISOLATED_NODE_OPTIONS,
    });
    // The young-generation size is pinned for the RSS measurement.
    assert.match(ISOLATED_NODE_OPTIONS, /(^|\s)--max-semi-space-size=\d+(\s|$)/);
    assert.equal(
      runs.slice(1).some((run) => run.include.includes(rss)),
      false,
    );
  });
  it("runs the vitest child under the pinned time zones", async () => {
    const dir = selfTestDirectory("tz");
    const abs = join(dir, "tz.integration.test.ts");
    const rel = relative(ROOT, abs).replaceAll("\\", "/");
    writeFileSync(
      abs,
      [
        'import { it, expect } from "vitest";',
        'it("pins TZ", () => {',
        '  expect(process.env.TZ).toBe("Asia/Kathmandu");',
        "  expect(new Date(Date.UTC(2026, 0, 1)).getTimezoneOffset()).toBe(-345);",
        '  expect(process.env.KB_TEST_PG_TIMEZONE).toBe("Pacific/Kiritimati");',
        "});",
        "",
      ].join("\n"),
    );
    try {
      await runSuite(
        "tz-pin",
        { include: [rel], services: [] },
        {
          skipServices: true,
          files: [rel],
          project: `kb-tz-pin-${process.pid}`,
          // Inherited `TZ`, the form the acceptance criteria spell. Before the
          // fix this was discarded and the child ran at America/Chicago.
          env: { TZ: "Asia/Kathmandu" },
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("redacts secrets from timeout/failure artifacts", () => {
    const redacted = redactText("postgresql://kb_runtime_x:s3cret-value@127.0.0.1:5433/kb_test_x", [
      "s3cret-value",
    ]);
    assert.equal(redacted.includes("s3cret-value"), false);
    assert.match(redacted, /\*\*\*/);
  });

  describe("qwen-model lane", () => {
    const good = {
      node: "v26.13.0",
      arch: "x64",
      libc: "glibc",
      nodeLlamaCpp: "3.22.2",
      buildType: "localBuild",
      nativeRuntime: JSON.parse(
        readFileSync(join(ROOT, "packages/api/src/lib/kb/fixtures/embedding-runtime.json"), "utf8"),
      ),
      modelId: "qwen3-embedding-0.6b-q8_0",
      dimensions: 1024,
      maxNormError: 0,
      topDocument: "sourdough",
      margin: 0.2,
      acceptedTokens: 4096,
      rejectedTokens: 4097,
      overflowCode: "EMBEDDING_INPUT_TOO_LONG",
      firstPid: 10,
      idleExitState: "gone",
      reloadPid: 11,
      reloadMaxDelta: 0,
      parentMapsAddon: false,
      childMapsAddon: true,
      referenceMinCosine: 1,
      tiers: loadArtifactIdentity().contextTiers.map((contextTokens) => ({
        contextTokens,
        peakRssBytes: 1000,
        estimate: loadArtifactIdentity().memoryEstimates[contextTokens],
      })),
    };

    it("is a registered explicit suite that owns the real-model build test and PostgreSQL", () => {
      assert.deepEqual(SUITES["qwen-model"].services, ["postgres"]);
      assert.equal(SUITES["qwen-model"].qwenModel, true);
      assert.deepEqual(
        filesForSuite(SUITES["qwen-model"], [
          "packages/test-utils/src/kb/qwen-model.integration.test.ts",
        ]),
        ["packages/test-utils/src/kb/qwen-model.integration.test.ts"],
      );
    });

    it("fails before any test when the artifact is missing: no skip-if-missing pass", async () => {
      await assert.rejects(
        runSuite("qwen-model", SUITES["qwen-model"], {
          env: {},
          files: ["packages/test-utils/src/kb/qwen-model.integration.test.ts"],
        }),
        /KB_QWEN_MODEL_PATH is required/,
      );
      await assert.rejects(verifyModelArtifact(undefined), /KB_QWEN_MODEL_PATH is required/);
      await assert.rejects(verifyModelArtifact("/nonexistent/model.gguf"), /missing/);
    });

    it("accepts only the exact bytes: a tampered cache and a symlink are rejected", async () => {
      const dir = mkdtempSync(join(tmpdir(), "kb-qwen-cache-"));
      try {
        const bytes = Buffer.from("fixture-model-".repeat(4096));
        const expected = {
          ...loadArtifactIdentity(),
          sizeBytes: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        };
        const path = join(dir, "model.gguf");
        writeFileSync(path, bytes);
        assert.equal((await verifyModelArtifact(path, expected)).sha256, expected.sha256);
        const tampered = Buffer.from(bytes);
        tampered[100] ^= 1;
        writeFileSync(path, tampered);
        await assert.rejects(verifyModelArtifact(path, expected), /checksum mismatch/);
        writeFileSync(path, bytes.subarray(1));
        await assert.rejects(verifyModelArtifact(path, expected), /size mismatch/);
        writeFileSync(path, bytes);
        symlinkSync(path, join(dir, "link.gguf"));
        await assert.rejects(verifyModelArtifact(join(dir, "link.gguf"), expected), /regular file/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("pins the real registry identity and supports only the two Linux lanes", () => {
      assert.deepEqual(
        {
          sizeBytes: loadArtifactIdentity().sizeBytes,
          sha256: loadArtifactIdentity().sha256,
        },
        {
          sizeBytes: 639150592,
          sha256: "06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439",
        },
      );
      assert.deepEqual(nativeDockerPlatform("x64"), { platform: "linux/amd64", arch: "x64" });
      assert.deepEqual(nativeDockerPlatform("arm64"), { platform: "linux/arm64", arch: "arm64" });
      assert.throws(() => nativeDockerPlatform("ia32"), /Unsupported architecture/);
    });

    it("image evidence must prove every acceptance point on the native arch", () => {
      assert.equal(assertSmokeEvidence(good, "x64"), true);
      assert.deepEqual(parseEvidence(`noise\nQWEN_SMOKE_EVIDENCE ${JSON.stringify(good)}\n`), good);
      assert.throws(() => parseEvidence("no evidence"), /no evidence line/);
      for (const [patch, pattern] of [
        [{ arch: "arm64" }, /arch/],
        [{ node: "v24.22.2" }, /Node 26/],
        [{ node: "v25.7.0" }, /Node 26/],
        [{ node: "v27.0.0" }, /Node 26/],
        [{ libc: "musl" }, /glibc/],
        [{ buildType: "prebuilt" }, /build/],
        [{ nativeRuntime: {} }, /runtime/],
        [{ nodeLlamaCpp: "3.22.0" }, /not the pinned 3\.22\.2/],
        [{ dimensions: 768 }, /dimensions/],
        [{ maxNormError: 0.01 }, /unit norm/],
        [{ topDocument: "tides" }, /ordering/],
        [{ rejectedTokens: -1 }, /reject/],
        [{ acceptedTokens: 4094 }, /accept/],
        [{ idleExitState: "zombie" }, /shutdown/],
        [{ reloadPid: 10 }, /reload PID/],
        [{ reloadMaxDelta: 0.1 }, /determinism/],
        [{ parentMapsAddon: true }, /parent mapped/],
        [{ childMapsAddon: false }, /child did not/],
        [{ referenceMinCosine: 0.9 }, /reference cosine/],
        [{ tiers: [] }, /tiers/],
      ])
        assert.throws(() => assertSmokeEvidence({ ...good, ...patch }, "x64"), pattern);
    });

    it("the release gate needs valid evidence from BOTH architecture lanes", () => {
      const dir = mkdtempSync(join(tmpdir(), "kb-qwen-evidence-"));
      try {
        const x64 = join(dir, "x64.json");
        const arm = join(dir, "arm64.json");
        writeFileSync(x64, JSON.stringify(good));
        writeFileSync(
          arm,
          JSON.stringify({
            ...good,
            arch: "arm64",
            buildType: "localBuild",
          }),
        );
        assert.equal(checkEvidenceFiles([`${x64}:x64`, `${arm}:arm64`]), true);
        assert.throws(() => checkEvidenceFiles([`${x64}:x64`]), /Missing Qwen smoke lanes: arm64/);
        assert.throws(
          () => checkEvidenceFiles([`${x64}:x64`, `${join(dir, "absent.json")}:arm64`]),
          /Missing Qwen smoke evidence for arm64/,
        );
        // x64 evidence cannot stand in for the arm64 leg.
        assert.throws(() => checkEvidenceFiles([`${x64}:x64`, `${x64}:arm64`]), /arch/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

it("46r10 missing Gemma artifact names its own required variable", async () => {
  const expected = loadArtifactIdentity(
    join(ROOT, "packages/api/src/lib/kb/fixtures/gemma-artifact.json"),
  );
  await assert.rejects(verifyModelArtifact(undefined, expected), /KB_GEMMA_MODEL_PATH is required/);
});

it("every pnpm hook explicitly disables automatic install without disabling checks", () => {
  const hooks = readFileSync(join(ROOT, "lefthook.yml"), "utf8");
  const commands = hooks.split("\n").filter((line) => line.trim().startsWith("run:"));
  assert.ok(commands.length >= 5);
  for (const line of commands) {
    // Keep the exhaustive inventory visible to this guard; multiline shell
    // commands must not hide a second unguarded pnpm invocation.
    assert.doesNotMatch(line, /run:\s*[|>]/);
    const invocations = [...line.matchAll(/\bpnpm\s/g)];
    assert.equal(
      invocations.length,
      [...line.matchAll(/\bpnpm_config_verify_deps_before_run=false pnpm\s/g)].length,
      line,
    );
    assert.doesNotMatch(line, /\bpnpm\s+(?:install|i|add|update|up|remove|rm)\b/);
  }
});
it("reaps only kb-test resources of exited runners", () => {
  assert.deepEqual(parseRunProject("kb-test-deployment-609696-6e3870-deployment-server-1"), {
    project: "kb-test-deployment-609696-6e3870",
    pid: 609696,
  });
  assert.deepEqual(parseRunProject("kb-test-git-push-12-abcdef_default"), {
    project: "kb-test-git-push-12-abcdef",
    pid: 12,
  });
  for (const foreign of ["template-runtime-pg-1", "kb-ssh-1", "kb-test-x-1-abcdefg", "other"])
    assert.equal(parseRunProject(foreign), null);
  const dead = "kb-test-deployment-111-aaaaaa";
  const live = "kb-test-deployment-222-bbbbbb";
  const calls = [];
  const listings = {
    ps: [
      `c1\t${dead}-deployment-server-1\tx\t${dead}-deployment`,
      `c2\tamazing_einstein\t${dead}-server\t\t${dead}`,
      `c3\t${live}-redis-1\tvalkey/valkey:9.1.3-trixie@sha256:3add1a336a920ea54770a001ab6feb3da5fceea96a40373a3a2cd469b815f0b7\t${live}`,
      "c4\tunrelated\tpostgres\tother-project",
      "c5\ttemplate-runtime-pg-1\tpgvector\t",
    ].join("\n"),
    network: `${dead}_z-deployment\n${live}_default\nbridge`,
    volume: `${dead}-deployment-kb-repos\n${live}_pg\nforeign`,
    images: `${dead}-server:latest\n${live}-server:latest\nkb-mirror-ssh-fixture:43`,
  };
  reapDeadRuns({
    docker: (args) => {
      if (args.includes("ls") || args[0] === "ps" || args[0] === "images")
        return listings[args[0]] ?? "";
      calls.push(args);
      return "";
    },
    isLive: (project) => project === live,
  });
  assert.deepEqual(calls, [
    ["rm", "-f", "-v", "c1", "c2"],
    ["network", "rm", `${dead}_z-deployment`],
    ["volume", "rm", `${dead}-deployment-kb-repos`],
    ["rmi", `${dead}-server:latest`],
  ]);
});
it("reaps exact labelled fixture names only after their owning run exits", () => {
  const dead = "kb-test-mirror-111-aaaaaa";
  const live = "kb-test-fence-222-bbbbbb";
  const uuid = "01234567-89ab-4cde-8fab-0123456789ab";
  const names = [
    `kb-ssh-${uuid}`,
    `kb-ssh-readonly-${uuid}`,
    `kb-memory-${uuid}`,
    `kb-push-hook-${uuid}`,
    "kb-fence-333-abcdef",
    `kb-fence-smoke-${uuid}`,
  ];
  const rows = names.flatMap((name, i) => [
    `dead${i}\t${name}\tnode:26-slim\t\t${dead}`,
    `live${i}\t${name}\tnode:26-slim\t\t${live}`,
    `absent${i}\t${name}\tnode:26-slim\t\t`,
    `conflict${i}\t${name}\tnode:26-slim\tforeign-project\t${dead}`,
    `current${i}\t${name}\tnode:26-slim\t\tkb-test-harness-${process.pid}-cccccc`,
  ]);
  for (const name of [
    "other",
    "kb-ssh-1",
    `kb-unrelated-${uuid}`,
    `kb-ssh-${uuid}-extra`,
    "kb-fence-smoke",
  ])
    rows.push(`foreign-${name}\t${name}\tnode:26-slim\t\t${dead}`);
  const calls = [];
  const checked = [];
  reapDeadRuns({
    docker: (args) => {
      if (args[0] === "ps") return rows.join("\n");
      if (args.includes("ls") || args[0] === "images") return "";
      calls.push(args);
      return "";
    },
    isLive: (project, pid) => {
      checked.push([project, pid]);
      return project === live;
    },
  });
  assert.deepEqual(calls, [["rm", "-f", "-v", ...names.map((_, i) => `dead${i}`)]]);
  assert.deepEqual(checked, [
    [dead, 111],
    [live, 222],
  ]);
});
it("both cleanup paths reject foreign, live, absent and conflicting container ownership", () => {
  const dead = "kb-test-deployment-2147483647-aaaaaa";
  const live = "kb-test-pr-222-bbbbbb";
  const image = `${dead}-server`;
  const rows = [
    `own-compose\t${dead}-deployment-server-1\t${image}\t${dead}-deployment\t`,
    `own-plain\trandom_name\t${image}\t\t${dead}`,
    `live\t${live}-server-1\t${image}\t${live}\t`,
    `foreign\tother-project-server-1\t${image}\tother-project\t`,
    `unlabelled\t${dead}-server-1\t${image}\t\t`,
    `conflicting-labels\t${dead}-server-1\t${image}\tother-project\t${dead}`,
    `conflicting-runs\t${dead}-server-1\t${image}\t${live}\t${dead}`,
    `conflicting-name\t${live}-server-1\t${image}\t${dead}\t`,
    `conflicting-image\t${dead}-server-1\t${live}-server\t${dead}\t`,
  ].join("\n");
  for (const cleanup of [
    (docker) => reapDeadRuns({ docker, isLive: (project) => project === live }),
    (docker) => removeImageContainers(image, dead, docker),
  ]) {
    const calls = [];
    cleanup((args) => {
      if (args[0] === "ps") return rows;
      if (args.includes("ls") || args[0] === "images") return "";
      calls.push(args);
      return "";
    });
    assert.deepEqual(calls, [["rm", "-f", "-v", "own-compose", "own-plain"]]);
  }
});

it("coordinator cleanup is reachable from the CLI and separate from suite execution", () => {
  const directory = mkdtempSync(join(tmpdir(), "kb-reaper-cli-"));
  const log = join(directory, "commands.jsonl");
  const owner = `kb-test-harness-${process.pid}-aaaaaa`;
  const uuid = "01234567-89ab-4cde-8fab-0123456789ab";
  const listing = [
    `live\tkb-ssh-${uuid}\tnode:26-slim\t\t${owner}`,
    `foreign\tkb-memory-${uuid}\tnode:26-slim\tother-project\t`,
  ].join("\n");
  writeFileSync(
    join(directory, "docker"),
    `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[0] === 'info' && process.env.REAPER_TEST_DAEMON_DOWN === '1') process.exit(1);
if (args[0] === 'ps' && process.env.REAPER_TEST_EMPTY !== '1')
  process.stdout.write(${JSON.stringify(listing)});
`,
    { mode: 0o755 },
  );
  const run = (args, extraEnv = {}) =>
    spawnSync(process.execPath, [runner, ...args], {
      cwd: ROOT,
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, ...extraEnv },
      encoding: "utf8",
    });
  const commands = () =>
    readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  try {
    for (const empty of ["0", "1"]) {
      writeFileSync(log, "");
      const result = run(["--", "--reap-dead-runs"], { REAPER_TEST_EMPTY: empty });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(
        commands().map((args) => args.slice(0, 2)),
        [["info"], ["ps", "-a"], ["network", "ls"], ["volume", "ls"], ["images", "--format"]],
      );
      assert.equal(result.stdout, "", "empty, live and foreign resources require no removal");
    }
    writeFileSync(log, "");
    const unavailable = run(["--reap-dead-runs"], { REAPER_TEST_DAEMON_DOWN: "1" });
    assert.notEqual(unavailable.status, 0);
    assert.match(unavailable.stderr, /Docker is required/);
    assert.deepEqual(commands(), [["info"]]);

    writeFileSync(log, "");
    for (const args of [
      ["--reap-dead-runs", "harness"],
      ["--build-only", "--reap-dead-runs"],
      ["--reap-dead-runs", "--reap-dead-runs"],
    ]) {
      const invalid = run(args);
      assert.notEqual(invalid.status, 0);
      assert.match(invalid.stderr, /Coordinator cleanup must run alone/);
    }
    assert.deepEqual(commands(), [], "invalid cleanup must not contact Docker");

    const suite = run(["--build-only", "harness"]);
    assert.equal(suite.status, 0, suite.stderr);
    assert.deepEqual(commands(), [], "a normal suite must not reap another run's resources");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("liveness protects the actual runner PID without needing a readable proc tree", () => {
  assert.equal(runIsLive("kb-test-harness-2147483647-abcdef", process.pid, "/absent-proc"), true);
});

for (const dumpable of [true, false]) {
  it(`liveness retains a real ${dumpable ? "readable" : "non-dumpable"} descendant until exit`, {
    timeout: 10_000,
  }, async (t) => {
    const project = "kb-test-harness-2147483647-abcdef";
    const procRoot = mkdtempSync(join(tmpdir(), "kb-test-proc-"));
    const child = spawn(
      "python3",
      [
        "-c",
        `
import ctypes, signal
${dumpable ? "" : "assert ctypes.CDLL(None).prctl(4, 0, 0, 0, 0) == 0"}
print("ready", flush=True)
signal.pause()
`,
      ],
      {
        env: { PATH: process.env.PATH, KB_TEST_PROJECT: project },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const exited = once(child, "exit");
    t.after(async () => {
      child.kill("SIGKILL");
      await exited;
      rmSync(procRoot, { recursive: true, force: true });
    });
    const [marker] = await once(child.stdout, "data");
    assert.equal(marker.toString().trim(), "ready");
    symlinkSync(`/proc/${child.pid}`, join(procRoot, String(child.pid)));
    if (dumpable) {
      assert.ok(readFileSync(`/proc/${child.pid}/environ`, "latin1").includes(project));
    } else {
      assert.throws(() => readFileSync(`/proc/${child.pid}/environ`), { code: "EACCES" });
    }
    assert.equal(runIsLive(project, 2147483647, procRoot), true);
    child.kill("SIGTERM");
    await exited;
    // An inaccessible/disappeared environment must not permanently prevent reaping
    // after the process is actually gone. The stale proc symlink is intentional.
    assert.equal(runIsLive(project, 2147483647, procRoot), false);
  });
}

it("liveness fails closed on an unreadable proc inventory and ignores unrelated readable processes", () => {
  const project = "kb-test-harness-2147483647-abcdef";
  assert.equal(runIsLive(project, 2147483647, "/absent-proc"), true);
  const procRoot = mkdtempSync(join(tmpdir(), "kb-test-proc-"));
  try {
    mkdirSync(join(procRoot, "2147483646"));
    writeFileSync(join(procRoot, "2147483646", "environ"), "UNRELATED=fixture\0");
    assert.equal(runIsLive(project, 2147483647, procRoot), false);
  } finally {
    rmSync(procRoot, { recursive: true, force: true });
  }
});
it("flushes deployment image builds before any bounded container start", () => {
  const source = readFileSync(runner, "utf8");
  const build = source.indexOf("for (const [role, image] of Object.entries(deploymentImages))");
  const flush = source.search(/run\(\s*"sync",\s*\[\]/);
  assert.ok(build > 0 && flush > build, "sync follows the deployment image builds");
  assert.ok(flush < source.indexOf("const vitest ="), "sync precedes the suite");
});

it("flk13 deployment leaves prebuilt image cleanup to its owning runner", () => {
  const source = readFileSync(join(ROOT, SUITES.deployment.include[0]), "utf8");
  // The fixture consumes a project tag built by test-kb. It must not claim a
  // shared legacy tag merely because an inspect failed (including a deadline).
  assert.doesNotMatch(source, /kb-mirror-ssh-fixture:43/);
  assert.doesNotMatch(source, /\["image", "rm"/);
});

it("flk13 all and deployment consume the prebuilt project tag and clean only their own images", () => {
  const dir = mkdtempSync(join(tmpdir(), "kb-ssh-cli-"));
  const state = join(dir, "state.json");
  const log = join(dir, "commands.jsonl");
  const suiteLog = join(dir, "suites.jsonl");
  const inspectFailure = join(dir, "inspect-failure");
  const foreign = ["kb-mirror-ssh-fixture:kb-test-mirror-222-bbbbbb", "other-project:latest"];
  const fixtureProgram = `import {createSshFixture} from ${JSON.stringify(join(ROOT, "packages/test-utils/src/kb/ssh.ts"))};const fixture=await createSshFixture();await fixture.close();`;
  const dockerProgram = `#!${process.execPath}
import {appendFileSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
const args=process.argv.slice(2), statePath=${JSON.stringify(state)};
const state=JSON.parse(readFileSync(statePath,'utf8'));
appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');
if(args[0]==='build') {
  const tag=args[args.indexOf(args.includes('-t')?'-t':'--tag')+1];
  state.images.push(tag);
  state.history.push({name:args.find(arg=>arg.startsWith('BUILDKIT_BUILD_NAME=')).split('=').slice(1).join('='),status:'Completed',completed_at:new Date().toISOString()});
  writeFileSync(statePath,JSON.stringify(state));
}
if(args[0]==='buildx') process.stdout.write(state.history.map(row=>JSON.stringify(row)).join('\\n')+'\\n');
if(args[0]==='image' && args[1]==='inspect') {
  if(existsSync(${JSON.stringify(inspectFailure)})) process.kill(process.pid,'SIGTERM');
  if(!state.images.includes(args[2])) { console.error('No such image: '+args[2]);process.exit(1); }
}
if(args[0]==='images' && args[1]==='-q' && state.images.includes(args[2])) process.stdout.write('sha256:fixture\\n');
if(args[0]==='rmi') {
  state.images=state.images.filter(tag=>tag!==args[1]);
  writeFileSync(statePath,JSON.stringify(state));
}
if(args[0]==='compose' && args.includes('port')) process.stdout.write('127.0.0.1:5432\\n');
if(args[0]==='run') {
  if(!state.images.includes(args.at(-1))) { console.error('No such image: '+args.at(-1));process.exit(1); }
  writeFileSync(args[args.indexOf('-v')+1].split(':')[0]+'/sshd.pid','1');
}
if(args[0]==='port') process.stdout.write('127.0.0.1:22222\\n');
`;
  try {
    writeFileSync(join(dir, "docker"), dockerProgram, { mode: 0o755 });
    writeFileSync(join(dir, "sync"), `#!${process.execPath}\n`, { mode: 0o755 });
    writeFileSync(join(dir, "make"), `#!${process.execPath}\n`, { mode: 0o755 });
    for (const mode of ["deployment", "all"]) {
      writeFileSync(state, JSON.stringify({ images: foreign, history: [] }));
      writeFileSync(log, "");
      writeFileSync(suiteLog, "");
      rmSync(inspectFailure, { force: true });
      writeFileSync(
        join(dir, "pnpm"),
        `#!${process.execPath}
import {appendFileSync,writeFileSync} from 'node:fs';import {spawnSync} from 'node:child_process';
appendFileSync(${JSON.stringify(suiteLog)},JSON.stringify(process.env.KB_TEST_SUITE)+'\\n');
// Earlier suites in all have their own fixtures; only deployment consumes SSH here.
if(process.env.KB_TEST_SUITE!=='deployment') process.exit(0);
writeFileSync(${JSON.stringify(inspectFailure)},'kill metadata probes after prebuild');
const result=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',${JSON.stringify(fixtureProgram)}],{stdio:'inherit'});
if(result.status!==0) process.exit(result.status ?? 1);
console.log('flk13 deployment fixture consumed');
// Stop all after deployment so this probe never admits later lanes.
process.exit(${mode === "all" ? 77 : 0});
`,
        { mode: 0o755 },
      );
      const result = spawnSync(process.execPath, [runner, "--", mode], {
        cwd: ROOT,
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
        encoding: "utf8",
        timeout: 30_000,
      });
      assert.equal(result.status, mode === "all" ? 1 : 0, result.stderr);
      assert.match(`${result.stdout}${result.stderr}`, /flk13 deployment fixture consumed/);
      const suites = readFileSync(suiteLog, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const registered = Object.keys(SUITES);
      assert.deepEqual(
        suites,
        mode === "all" ? registered.slice(0, registered.indexOf("deployment") + 1) : ["deployment"],
      );
      const commands = readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const prebuild = commands.find((args) => args[0] === "build" && args.includes("-t"));
      const image = prebuild[prebuild.indexOf("-t") + 1];
      const project = image.split(":")[1];
      assert.match(project, /^kb-test-deployment-\d+-[0-9a-f]{6}$/);
      const run = commands.find((args) => args[0] === "run");
      assert.equal(run.at(-1), image);
      assert.ok(run.includes("--pull=never"));
      assert.ok(run.includes(`io.knowledge-base.test-project=${project}`));
      assert.deepEqual(
        commands.filter((args) => args[0] === "image"),
        [["image", "inspect", image]],
      );
      assert.deepEqual(
        commands.filter((args) => args[0] === "rmi").map((args) => args[1]),
        [image, `${project}-server`, `${project}-worker`],
      );
      assert.deepEqual(JSON.parse(readFileSync(state, "utf8")).images, foreign);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// flk4: these assertions are derived from the suite/build inventory, not hook budgets.
describe("flk4 build prerequisites", () => {
  it("prebuilds exactly the suites consuming CLI, SDK, SSH and native artifacts", async () => {
    const { buildPrerequisites, BUILD_TIMEOUT_MS } = await import("./test-kb.mjs");
    assert.equal(BUILD_TIMEOUT_MS, 30 * 60 * 1000);
    const artifacts = (name) => buildPrerequisites(name, SUITES[name]).map((step) => step.artifact);
    const expected = {
      "asset-migration": ["supervisor"],
      restore: ["supervisor"],
      backup: ["supervisor"],
      "git-push": ["supervisor", "static-supervisor"],
      "git-http": ["supervisor"],
      mcp: ["cli", "process-owner"],
      device: ["cli"],
      mirror: ["ssh-image"],
      deployment: ["ssh-image"],
      "client-interop": ["cli", "sdk-interop"],
      "qwen-process": ["process-owner", "child-guard"],
      "model-download": ["child-guard"],
      "qwen-model": ["child-guard"],
      fence: [
        "supervisor",
        "static-supervisor",
        "pause-child",
        "fork-ignore-child",
        "process-owner",
      ],
      locks: ["supervisor"],
      pr: ["supervisor"],
      "entry-canary": ["supervisor", "output-canary"],
      exports: ["cli"],
      parity: ["cli", "parity-fixture"],
      browser: ["cli", "browser-harness"],
    };
    for (const name of Object.keys(SUITES))
      assert.deepEqual(artifacts(name), expected[name] ?? [], name);
    for (const suite of ["device", "exports", "mcp", "parity"])
      assert.ok(artifacts(suite).includes("cli"), suite);
    assert.ok(artifacts("client-interop").includes("sdk-interop"));
    for (const suite of ["mirror", "deployment"])
      assert.ok(artifacts(suite).includes("ssh-image"), suite);
    for (const suite of [
      "asset-migration",
      "backup",
      "restore",
      "fence",
      "locks",
      "git-push",
      "git-http",
      "pr",
      "entry-canary",
    ])
      assert.ok(artifacts(suite).includes("supervisor"), suite);
    for (const suite of ["qwen-process", "qwen-model"])
      assert.ok(artifacts(suite).includes("child-guard"), suite);
    for (const suite of ["fence", "mcp"])
      assert.ok(artifacts(suite).includes("process-owner"), suite);
    assert.ok(artifacts("fence").includes("pause-child"));
    assert.ok(artifacts("fence").includes("fork-ignore-child"));
    for (const suite of ["fence", "git-push"])
      assert.ok(artifacts(suite).includes("static-supervisor"), suite);
    assert.deepEqual(artifacts("tree"), []);
    const cli = buildPrerequisites("device", SUITES.device).find((step) => step.artifact === "cli");
    assert.equal(cli.file, "cargo");
    assert.ok(cli.args.includes("--locked"));
    assert.ok(cli.args.includes("-j3"));
    const parityFixture = buildPrerequisites("parity", SUITES.parity).find(
      (step) => step.artifact === "parity-fixture",
    );
    assert.equal(parityFixture.file, "cargo");
    for (const arg of ["build", "--locked", "-j3"])
      assert.ok(parityFixture.args.includes(arg), arg);
    assert.equal(parityFixture.args[parityFixture.args.indexOf("-p") + 1], "kb-local");
    assert.equal(parityFixture.args[parityFixture.args.indexOf("--bin") + 1], "kb-parity-fixture");
    const sdk = buildPrerequisites("client-interop", SUITES["client-interop"]).find(
      (step) => step.artifact === "sdk-interop",
    );
    assert.equal(sdk.file, "cargo");
    for (const arg of ["test", "--no-run", "--locked", "--message-format=json", "sdk_interop"])
      assert.ok(sdk.args.includes(arg), arg);
  });

  it("runs every prerequisite through runCaptured before any Vitest invocation", () => {
    const source = readFileSync(runner, "utf8");
    const prebuild = source.indexOf("for (const step of buildPrerequisites(");
    assert.ok(prebuild > 0);
    assert.ok(prebuild < source.indexOf("const vitest ="));
    assert.match(
      source.slice(prebuild, source.indexOf("const vitest =")),
      /run\([\s\S]*BUILD_TIMEOUT_MS/,
    );
    assert.match(source, /if \(options\.buildOnly\) return/);
    assert.match(source, /const workerImage =[\s\S]*suite\.qwenModel/);
    assert.match(source, /runImageSmoke\(\{ modelPath, image: workerImage \}\)/);
    assert.match(source, /modelPath: gemmaPath,\s*image: workerImage/);
    // Package unit tests exec the prebuilt supervisor (push-spool, merge-scratch,
    // git-cgi). Every root script that runs them must prebuild it first.
    const commands = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts;
    assert.match(
      commands.test,
      /^node scripts\/test-kb\.mjs --build-only git-http && turbo run test/,
    );
    const unitRunners = Object.entries(commands).filter(([, command]) =>
      /\bturbo run test\b/.test(command),
    );
    assert.deepEqual(unitRunners.map(([name]) => name).sort(), ["test", "verify:fast"]);
    for (const [name, command] of unitRunners) {
      const run = command.search(/(?:pnpm )?turbo run test\b/);
      assert.match(
        command.slice(0, run),
        /node scripts\/test-kb\.mjs --build-only git-http && $/,
        `${name} must prebuild the supervisor immediately before turbo run test`,
      );
    }
  });

  it("registered test sources cannot compile in tests or hooks, including implicit cargo test builds", () => {
    const roots = [
      "packages/test-utils/src/kb",
      "apps/server/src",
      "packages/api/src/lib/kb",
      "apps/web/tests",
    ];
    for (const root of roots) {
      for (const entry of readdirSync(join(ROOT, root), { recursive: true })) {
        if (!/\.(test|spec|setup)\.ts$/.test(entry) && !entry.endsWith(".harness.tsx")) continue;
        const source = readFileSync(join(ROOT, root, entry), "utf8");
        assert.doesNotMatch(
          source,
          /(?:execFileSync|execFile|run)\(\s*"(?:cargo|make|gcc|clang)"/,
          entry,
        );
        assert.doesNotMatch(source, /\[\s*"build"\s*,/, entry);
        assert.doesNotMatch(source, /(?:await\s+)?build\(\s*config\s*\)/, entry);
      }
    }
    for (const entry of readdirSync(join(ROOT, "packages/test-utils/src/kb"), {
      recursive: true,
    })) {
      if (!entry.endsWith(".ts")) continue;
      const source = readFileSync(join(ROOT, "packages/test-utils/src/kb", entry), "utf8");
      assert.doesNotMatch(
        source,
        /(?:execFileSync|execFile|run)\(\s*"(?:cargo|make|gcc|clang)"/,
        entry,
      );
    }
    const ssh = readFileSync(join(ROOT, "packages/test-utils/src/kb/ssh.ts"), "utf8");
    assert.match(ssh, /prebuild/);
    assert.match(ssh, /"image", "inspect"/);
    assert.match(ssh, /pnpm test:kb/);
  });

  it("preserves the device and SDK hook budgets and documents the prebuild path", () => {
    const device = readFileSync(
      join(ROOT, "packages/test-utils/src/kb/device.integration.test.ts"),
      "utf8",
    );
    const sdk = readFileSync(
      join(ROOT, "packages/test-utils/src/kb/client-interop.integration.test.ts"),
      "utf8",
    );
    assert.match(device, /beforeAll\([\s\S]*?}, 180_000\)/);
    assert.match(sdk, /}, 900_000\)/);
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    assert.match(readme, /pnpm test:kb -- <suite>/);
    assert.match(readme, /prerequisite/i);
    assert.match(readme, /--build-only/);
    assert.match(readme, /parity.*`kb`.*`kb-parity-fixture`/);
    assert.match(readme, /pnpm test:kb --build-only parity/);
  });
});

it("flk4 missing executables fail fast with both runner and standalone prebuild instructions", async () => {
  const { requireBuiltArtifact } = await import(
    "../packages/test-utils/src/kb/build-artifacts.mjs"
  );
  const dir = mkdtempSync(join(tmpdir(), "kb-artifact-check-"));
  try {
    const binary = join(dir, "binary");
    const command = "pnpm test:kb --build-only device";
    assert.throws(
      () => requireBuiltArtifact(binary, command),
      /run via pnpm test:kb.*--build-only device/,
    );
    writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    assert.equal(requireBuiltArtifact(binary, command), binary);
    const module = join(dir, "module.mjs");
    writeFileSync(module, "export default 1;", { mode: 0o600 });
    assert.equal(requireBuiltArtifact(module, command, false), module);
    assert.throws(() => requireBuiltArtifact(module, command), /prebuild/);
    assert.throws(() => requireBuiltArtifact(dir, command), /prebuild/);
    rmSync(binary);
    assert.throws(() => requireBuiltArtifact(binary, command), /prebuild/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("flk4 SSH image builds only for an absent image in the explicit prerequisite path", () => {
  const dir = mkdtempSync(join(tmpdir(), "kb-ssh-prebuild-check-"));
  const log = join(dir, "log");
  const image = join(dir, "image");
  const unavailable = join(dir, "unavailable");
  const inspectFailure = join(dir, "inspect-failure");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "docker"),
    `#!${process.execPath}
import {appendFileSync, existsSync, readFileSync, writeFileSync} from 'node:fs';
const args=process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args)+'\\n');
if(args[0]==='image' && args[1]==='inspect') {
  if(existsSync(${JSON.stringify(inspectFailure)})) process.kill(process.pid,'SIGTERM');
  if(existsSync(${JSON.stringify(unavailable)})) { console.error('Cannot connect to the Docker daemon'); process.exit(1); }
  if(!existsSync(${JSON.stringify(image)})) { console.error('Error response from daemon: No such image: fixture'); process.exit(1); }
}
if(args[0]==='build') writeFileSync(${JSON.stringify(image)}, JSON.stringify({name:args.find(arg=>arg.startsWith('BUILDKIT_BUILD_NAME=')).split('=').slice(1).join('='),status:'Completed',completed_at:new Date().toISOString()}));
if(args[0]==='buildx' && args[1]==='history') process.stdout.write(readFileSync(${JSON.stringify(image)},'utf8')+'\\n');
if(args[0]==='run') {
  if(existsSync(${JSON.stringify(unavailable)})) { console.error('Cannot connect to the Docker daemon'); process.exit(1); }
  if(!existsSync(${JSON.stringify(image)})) { console.error('Error response from daemon: No such image: fixture'); process.exit(1); }
  const volume=args[args.indexOf('-v')+1].split(':')[0];
  writeFileSync(volume+'/sshd.pid','1');
}
if(args[0]==='port') process.stdout.write('127.0.0.1:22222\\n');
`,
    { mode: 0o755 },
  );
  const program = `import {createSshFixture} from ${JSON.stringify(join(ROOT, "packages/test-utils/src/kb/ssh.ts"))};
try { const fixture=await createSshFixture();await fixture.close(); } catch(error) {console.error(error.message);process.exitCode=1;}`;
  const run = (imageOnly = false) =>
    spawnSync(
      process.execPath,
      imageOnly
        ? ["--import", "tsx", join(ROOT, "packages/test-utils/src/kb/ssh.ts"), "--prebuild-image"]
        : ["--import", "tsx", "--input-type=module", "-e", program],
      {
        cwd: ROOT,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        encoding: "utf8",
        timeout: 20_000,
      },
    );
  const builds = () =>
    readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((args) => args[0] === "build").length;
  const runs = () =>
    readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((args) => args[0] === "run");
  try {
    const missing = run(false);
    assert.equal(missing.status, 1, missing.stderr);
    assert.match(missing.stderr, /run via pnpm test:kb.*--build-only mirror/);
    assert.equal(builds(), 0);
    const runsBeforePrebuild = runs().length;
    const cold = run(true);
    assert.equal(cold.status, 0, cold.stderr);
    assert.equal(builds(), 1);
    const coldCommands = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(
      coldCommands.filter((args) => args[0] === "run").length,
      runsBeforePrebuild,
      "image prerequisite must not start a network fixture",
    );
    for (const prebuild of [false, true]) {
      const warm = run(prebuild);
      assert.equal(warm.status, 0, warm.stderr);
      assert.equal(builds(), 1);
    }
    // flk13: the tag still exists when an inspect client is killed. A metadata
    // probe is not part of container creation and must not fail a warm fixture.
    writeFileSync(inspectFailure, "kill inspect only");
    const warmWithoutInspect = run(false);
    assert.equal(warmWithoutInspect.status, 0, warmWithoutInspect.stderr);
    assert.equal(existsSync(image), true);
    assert.equal(builds(), 1);
    assert.ok(runs().every((args) => args.includes("--pull=never")));
    const failedInspect = run(true);
    assert.equal(failedInspect.status, 1);
    assert.match(failedInspect.stderr, /signal=SIGTERM/);
    rmSync(inspectFailure);
    rmSync(image);
    assert.equal(run(false).status, 1);
    assert.equal(builds(), 1);
    writeFileSync(unavailable, "unavailable");
    const daemonFailure = run(true);
    assert.equal(daemonFailure.status, 1, daemonFailure.stderr);
    assert.match(daemonFailure.stderr, /Cannot connect to the Docker daemon/);
    assert.equal(builds(), 1, "daemon errors are not absent images and must not trigger a build");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("flk4 runner executes prerequisites before Vitest and a failed build prevents tests", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kb-build-order-"));
  const log = join(dir, "commands");
  const failure = join(dir, "fail");
  const oldPath = process.env.PATH;
  const program = `#!${process.execPath}
import {appendFileSync,existsSync} from 'node:fs';
import {basename} from 'node:path';
const file=basename(process.argv[1]);
appendFileSync(${JSON.stringify(log)},JSON.stringify({file,args:process.argv.slice(2)})+'\\n');
if(file==='cargo' && existsSync(${JSON.stringify(failure)})) process.exit(9);
`;
  try {
    for (const file of ["cargo", "pnpm"]) writeFileSync(join(dir, file), program, { mode: 0o755 });
    process.env.PATH = `${dir}:${oldPath}`;
    const options = {
      files: [SUITES.device.include[0]],
      skipServices: true,
      project: `kb-build-order-${process.pid}`,
    };
    await assert.rejects(
      runSuite("device", SUITES.device, { ...options, buildTimeoutMs: 0 }),
      /positive.*build|build.*positive/,
    );
    await runSuite("device", SUITES.device, options);
    const commands = () =>
      readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    assert.deepEqual(
      commands().map(({ file }) => file),
      ["cargo", "pnpm"],
    );
    const { buildArtifactDirectory } = await import(
      "../packages/test-utils/src/kb/build-artifacts.mjs"
    );
    assert.equal(existsSync(buildArtifactDirectory(options.project)), false);
    assert.equal(commands()[0].args[0], "build");
    assert.ok(commands()[1].args.includes("vitest"));
    writeFileSync(log, "");
    await runSuite("browser", SUITES.browser, { ...options, files: [], buildOnly: true });
    assert.deepEqual(
      commands().map(({ file }) => file),
      ["cargo", "pnpm"],
      "browser build-only must prepare both artifacts without Playwright admission",
    );
    assert.ok(commands()[1].args.some((arg) => arg.endsWith("kb-browser.build.ts")));
    writeFileSync(log, "");
    await runSuite("device", SUITES.device, { ...options, buildOnly: true });
    assert.deepEqual(
      commands().map(({ file }) => file),
      ["cargo"],
    );
    assert.equal(existsSync(buildArtifactDirectory(options.project)), true);
    writeFileSync(log, "");
    writeFileSync(failure, "fail");
    await assert.rejects(runSuite("device", SUITES.device, options), (error) => error.status === 9);
    assert.deepEqual(
      commands().map(({ file }) => file),
      ["cargo"],
    );
    assert.equal(existsSync(buildArtifactDirectory(options.project)), false);
    await assert.rejects(
      runSuite("device", SUITES.device, { ...options, buildOnly: true }),
      (error) => error.status === 9,
    );
    assert.equal(
      existsSync(buildArtifactDirectory(options.project)),
      false,
      "failed standalone prebuild must remove partial artifacts",
    );
    // Deadline admission/drain is covered by the real compiler cases below.
    // A short deadline can correctly expire before a cold fake tool starts.
  } finally {
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

const buildDelay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function buildUntil(check) {
  const end = Date.now() + 10_000;
  while (!check()) {
    assert.ok(Date.now() < end, "build fixture did not reach pending work");
    await buildDelay(20);
  }
}
function buildAlive(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return !["Z", "X"].includes(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

for (const mode of ["immune", "descendant", "nested"]) {
  it(`flk4 deadline drains real ${mode} compiler work before cleanup and permits a fresh retry`, {
    timeout: 30_000,
  }, async () => {
    const directory = mkdtempSync(join(tmpdir(), "kb-build-drain-"));
    const marker = join(directory, "pid");
    const late = join(directory, "late");
    const release = join(directory, "release");
    const vitestStarted = join(directory, "vitest-started");
    const oldPath = process.env.PATH;
    const project = `kb-build-drain-${process.pid}-${mode}`;
    const { buildArtifactDirectory } = await import(
      "../packages/test-utils/src/kb/build-artifacts.mjs"
    );
    const supervisorModule = new URL("./build-embedding-runtime.mjs", import.meta.url).href;
    const leaf = `import {existsSync,writeFileSync} from 'node:fs';process.on('SIGTERM',()=>{});writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{if(existsSync(${JSON.stringify(release)}))writeFileSync(${JSON.stringify(late)},'late')},20);`;
    const program =
      mode === "immune"
        ? leaf
        : mode === "descendant"
          ? `import {spawn} from 'node:child_process';spawn(process.execPath,['--input-type=module','-e',${JSON.stringify(leaf)}],{stdio:'ignore'});setInterval(()=>{},1000);`
          : `import {createBuildSupervisor} from ${JSON.stringify(supervisorModule)};const owner=createBuildSupervisor({graceMs:5000});try{await owner.run(process.execPath,['--input-type=module','-e',${JSON.stringify(leaf)}],${JSON.stringify(directory)});}finally{owner.close();}`;
    let pending;
    let rejected;
    let pid;
    try {
      writeFileSync(join(directory, "cargo"), `#!${process.execPath}\n${program}`, { mode: 0o755 });
      writeFileSync(
        join(directory, "pnpm"),
        `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(vitestStarted)},'started');`,
        { mode: 0o755 },
      );
      process.env.PATH = `${directory}:${oldPath}`;
      const options = {
        files: [SUITES.device.include[0]],
        skipServices: true,
        project,
        buildTimeoutMs: 5000,
      };
      pending = runSuite("device", SUITES.device, options);
      rejected = assert.rejects(pending, (error) => error.code === "ETIMEDOUT");
      await buildUntil(() => existsSync(marker));
      pid = Number(readFileSync(marker, "utf8"));
      // The leaf records its PID before scheduling any effect; cold launcher
      // admission may consume part of the build budget before this observer runs.
      assert.ok(Number.isSafeInteger(pid) && pid > 0, "must execute the real compiler leaf");
      await rejected;
      assert.equal(existsSync(vitestStarted), false, "a failed build must prevent Vitest");
      writeFileSync(release, "released after rejection");
      assert.equal(
        buildAlive(pid),
        false,
        "rejection must follow group drain, including detached nested owners",
      );
      assert.equal(existsSync(buildArtifactDirectory(project)), false);
      await buildDelay(1000);
      assert.equal(existsSync(late), false, "a compiler must not write after rejection/cleanup");
      writeFileSync(
        join(directory, "cargo"),
        `#!${process.execPath}\nprocess.stdout.write('fresh build');`,
        { mode: 0o755 },
      );
      await runSuite("device", SUITES.device, { ...options, buildTimeoutMs: undefined });
      assert.equal(existsSync(vitestStarted), true, "a successful retry must admit Vitest");
      assert.equal(existsSync(buildArtifactDirectory(project)), false);
    } finally {
      process.env.PATH = oldPath;
      if (pid && buildAlive(pid)) process.kill(pid, "SIGKILL");
      await pending?.catch(() => {});
      await rejected?.catch(() => {});
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  it(`flk4 ${signal} of a runner drains real compiler descendants before settling`, {
    timeout: 20_000,
  }, async () => {
    const directory = mkdtempSync(join(tmpdir(), "kb-build-signal-"));
    const marker = join(directory, "pid");
    const late = join(directory, "late");
    const release = join(directory, "release");
    const project = `kb-build-signal-${process.pid}-${signal.toLowerCase()}`;
    const { buildArtifactDirectory } = await import(
      "../packages/test-utils/src/kb/build-artifacts.mjs"
    );
    const leaf = `import {existsSync,writeFileSync} from 'node:fs';process.on('SIGTERM',()=>{});writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{if(existsSync(${JSON.stringify(release)}))writeFileSync(${JSON.stringify(late)},'late')},20);`;
    writeFileSync(
      join(directory, "cargo"),
      `#!${process.execPath}\nimport {spawn} from 'node:child_process';spawn(process.execPath,['--input-type=module','-e',${JSON.stringify(leaf)}],{stdio:'ignore'});setInterval(()=>{},1000);`,
      { mode: 0o755 },
    );
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import {runSuite,SUITES} from ${JSON.stringify(new URL("./test-kb.mjs", import.meta.url).href)};try{await runSuite('device',SUITES.device,{files:[SUITES.device.include[0]],skipServices:true,project:${JSON.stringify(project)}});}catch(error){console.error(error.message);process.exitCode=1;}`,
      ],
      {
        detached: true,
        env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
        stdio: "ignore",
      },
    );
    const closed = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code));
    });
    let pid;
    try {
      await buildUntil(() => existsSync(marker));
      pid = Number(readFileSync(marker, "utf8"));
      assert.ok(buildAlive(pid));
      child.kill(signal);
      assert.equal(await closed, 1);
      writeFileSync(release, "released after interrupted runner exit");
      assert.equal(buildAlive(pid), false);
      assert.equal(existsSync(buildArtifactDirectory(project)), false);
      await buildDelay(1800);
      assert.equal(existsSync(late), false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid, "SIGKILL");
      if (pid && buildAlive(pid)) process.kill(pid, "SIGKILL");
      await closed;
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  for (const phase of ["startup", "behavioral"])
    it(`R5 ${signal} during ${phase} tests drains descendants and removes compose services`, async () => {
      const directory = mkdtempSync(join(tmpdir(), "kb-test-behavior-signal-"));
      const marker = join(directory, "pid");
      const resource = join(directory, "service");
      const project = `kb-test-signal-${process.pid}-${signal.toLowerCase()}-${phase}`;
      const hold = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`)}],{stdio:'ignore'});setInterval(()=>{},1000);`;
      const program = `#!${process.execPath}
import {writeFileSync,rmSync} from 'node:fs';
import {createRequire} from 'node:module';const require=createRequire(import.meta.url);
const args=process.argv.slice(2);
if(args.includes('up')){writeFileSync(${JSON.stringify(resource)},'owned');${phase === "startup" ? hold : ""}}
if(args.includes('down'))rmSync(${JSON.stringify(resource)},{force:true});
if(args.includes('port'))console.log('127.0.0.1:35555');
`;
      writeFileSync(join(directory, "docker"), program, { mode: 0o755 });
      writeFileSync(
        join(directory, "pnpm"),
        `#!${process.execPath}
import {spawn} from 'node:child_process';
spawn(process.execPath,['-e',${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`)}],{stdio:'ignore'});
setInterval(()=>{},1000);
`,
        { mode: 0o755 },
      );
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import {runSuite} from ${JSON.stringify(new URL("./test-kb.mjs", import.meta.url).href)};try{await runSuite('signal',{include:['fake.integration.test.ts'],services:['postgres']},{files:['fake.integration.test.ts'],project:${JSON.stringify(project)}})}catch(error){console.error(error.message);process.exitCode=1;}`,
        ],
        {
          detached: true,
          env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
          stdio: "ignore",
        },
      );
      const closed = once(child, "close");
      let pid;
      try {
        await buildUntil(() => existsSync(marker));
        pid = Number(readFileSync(marker, "utf8"));
        assert.equal(existsSync(resource), true);
        child.kill(signal);
        assert.equal((await closed)[0], 1);
        assert.equal(buildAlive(pid), false);
        assert.equal(existsSync(resource), false);
      } finally {
        if (child.exitCode === null && child.signalCode === null)
          process.kill(-child.pid, "SIGKILL");
        if (pid && buildAlive(pid)) process.kill(pid, "SIGKILL");
        await closed;
        rmSync(directory, { recursive: true, force: true });
      }
    });
}

it("flk4 captured supervisor preserves output/errors, rejects overflow and closes admission on cancellation", async () => {
  const { createBuildSupervisor } = await import("./build-embedding-runtime.mjs");
  const owner = createBuildSupervisor({ timeoutMs: 60_000, graceMs: 50 });
  try {
    const output = await owner.run(
      process.execPath,
      ["-e", "process.stdout.write('ok');process.stderr.write('diagnostic');"],
      ROOT,
      { capture: true },
    );
    assert.deepEqual(output, { stdout: "ok", stderr: "diagnostic" });
    await assert.rejects(
      owner.run(
        process.execPath,
        ["-e", "process.stderr.write('compiler error');process.exit(7);"],
        ROOT,
        { capture: true },
      ),
      (error) => error.status === 7 && error.stderr === "compiler error",
    );
    await assert.rejects(
      owner.run(
        process.execPath,
        [
          "-e",
          "process.on('SIGTERM',()=>{});setInterval(()=>process.stdout.write('x'.repeat(2048)),10);",
        ],
        ROOT,
        { capture: true, maxBuffer: 1024 },
      ),
      (error) => error.code === "ENOBUFS",
    );
  } finally {
    owner.close();
  }
  await assert.rejects(
    owner.run(process.execPath, ["-e", "process.exit(0)"], ROOT),
    (error) => error.code === "ENOBUFS",
  );
  const closed = createBuildSupervisor();
  closed.close();
  await assert.rejects(closed.run(process.execPath, ["-e", "process.exit(0)"], ROOT), /closed/);
});

it("flk4 browser setup rejects absent or deleted harness files before opening a fixture", async () => {
  const project = `kb-browser-artifacts-${process.pid}`;
  const harness = buildArtifactPath("browser-harness", project);
  const program = `import setup from ${JSON.stringify(join(ROOT, "apps/web/tests/kb-browser.setup.ts"))};await setup();`;
  const run = () =>
    spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", program], {
      cwd: ROOT,
      env: { ...process.env, KB_TEST_PROJECT: project },
      encoding: "utf8",
      timeout: 15_000,
    });
  try {
    let missing = run();
    assert.equal(missing.status, 1, missing.stderr);
    assert.match(missing.stderr, /run via pnpm test:kb.*--build-only browser/);
    mkdirSync(join(harness, "dist"), { recursive: true });
    writeFileSync(join(harness, "complete.json"), "{}");
    for (const name of readdirSync(join(ROOT, "apps/web/tests"))) {
      const entry = /^kb-(.+)\.harness\.tsx$/.exec(name)?.[1];
      if (entry) writeFileSync(join(harness, "dist", `${entry}.html`), "<html></html>");
    }
    rmSync(join(harness, "dist", "mcp.html"));
    missing = run();
    assert.equal(missing.status, 1, missing.stderr);
    assert.match(missing.stderr, /mcp\.html.*run via pnpm test:kb.*--build-only browser/);
  } finally {
    rmSync(buildArtifactPath("", project), { recursive: true, force: true });
  }
});

it("flk4 uncertain Docker daemon drain retains intent and blocks retry without new builds", {
  timeout: 30_000,
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), "kb-daemon-readback-"));
  const project = `kb-daemon-readback-${process.pid}`;
  const log = join(directory, "commands");
  const { buildArtifactDirectory } = await import(
    "../packages/test-utils/src/kb/build-artifacts.mjs"
  );
  const oldPath = process.env.PATH;
  const supervisor = new URL("./build-embedding-runtime.mjs", import.meta.url).href;
  writeFileSync(
    join(directory, "docker"),
    `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(log)},process.argv[2]+'\\n');if(process.argv[2]==='buildx')process.exit(9);`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(directory, "cargo"),
    `#!${process.execPath}\nimport {createBuildSupervisor} from ${JSON.stringify(supervisor)};const owner=createBuildSupervisor({timeoutMs:10000});try{await owner.run('docker',['build','.'],process.cwd());}finally{owner.close();}`,
    { mode: 0o755 },
  );
  const options = {
    files: [SUITES.device.include[0]],
    skipServices: true,
    project,
    buildTimeoutMs: 10_000,
  };
  try {
    process.env.PATH = `${directory}:${oldPath}`;
    await assert.rejects(
      runSuite("device", SUITES.device, options),
      (error) => error.drainIncomplete === true,
    );
    const groups = join(buildArtifactDirectory(project), "build-groups");
    assert.ok(
      readdirSync(groups).some((name) => name.startsWith("docker-") && name.endsWith(".json")),
      "durable daemon intent must survive failure and suite cleanup",
    );
    await assert.rejects(
      runSuite("device", SUITES.device, options),
      /Previous Docker build drain is incomplete/,
    );
    const commands = readFileSync(log, "utf8").trim().split("\n");
    assert.equal(
      commands.filter((command) => command === "build").length,
      1,
      "retry must not overlap unacknowledged daemon work",
    );
    assert.ok(existsSync(groups));
  } finally {
    process.env.PATH = oldPath;
    rmSync(directory, { recursive: true, force: true });
    rmSync(buildArtifactDirectory(project), { recursive: true, force: true });
  }
});

it("flk8 real-daemon Docker proof runs only in its own build suite, under build-only bounds", () => {
  const docker = "scripts/test-kb-build-docker.test.mjs";
  const owners = Object.entries(SUITES)
    .filter(([, suite]) => (suite.nodeTests ?? []).includes(docker))
    .map(([name]) => name);
  assert.deepEqual(owners, ["build"]);
  assert.deepEqual(SUITES.build.services, []);
  assert.equal(SUITES.build.requireDocker, true);
  assert.ok(!SUITES.harness.nodeTests.includes(docker), "not in every harness run");
  // Merge selection matches a suite name against path segments split on -_. so
  // edits to the build supervisor select this suite.
  for (const path of [docker, "scripts/build-embedding-runtime.mjs"])
    assert.ok(
      path.split("/").some((segment) =>
        segment
          .replace(/\.[^.]+$/, "")
          .split(/[-_.]/)
          .includes("build"),
      ),
      path,
    );
  const source = readFileSync(join(ROOT, docker), "utf8");
  // No test budget and no fixed sleeps: Docker work is bounded only by the
  // build hang guard; everything else is an event wait.
  assert.doesNotMatch(source, /timeout:\s*\d/);
  assert.doesNotMatch(source, /setTimeout\(\s*(?:resolve|r)\s*,/);
  assert.doesNotMatch(source, /\b\d[\d_]*_000\b/);
  assert.match(source, /BUILD_TIMEOUT_MS/);
  const supervisor = readFileSync(join(ROOT, "scripts/build-embedding-runtime.mjs"), "utf8");
  assert.match(supervisor, /const end = Date\.now\(\) \+ drainTimeoutMs;/);
});

it("flk4 browser harness build covers every entry that setup routes to", () => {
  const tests = join(import.meta.dirname, "../apps/web/tests");
  const setup = readFileSync(join(tests, "kb-browser.setup.ts"), "utf8");
  const routed = new Set(
    [
      ...setup
        .split("HARNESS_BY_PATH")[1]
        .split("};")[0]
        .matchAll(/:\s*"([a-z0-9-]+)"/g),
    ].map((m) => m[1]),
  );
  assert.ok(routed.size > 0);
  const built = readFileSync(join(tests, "kb-browser.build.ts"), "utf8");
  // The build derives entries from tests/kb-<entry>.harness.tsx, never a hand-kept list.
  assert.match(built, /readdirSync\(resolve\(webRoot, "tests"\)\)/);
  for (const entry of routed) assert.ok(existsSync(join(tests, `kb-${entry}.harness.tsx`)), entry);
});

describe("image git lane (R3-W1)", () => {
  it("runs every git-heavy suite against the image's git and names what must reach it", () => {
    for (const name of ["pr", "changes", "git-push", "git-http", "mcp"])
      assert.ok(SUITES[name].imageGit.reached.length > 0, name);
    assert.ok(SUITES["git-push"].imageGit.reached.includes("path http-backend"));
    assert.ok(SUITES["git-push"].imageGit.reached.includes("core git merge-base"));
  });

  /** A fake bounded runner: records every Docker call and fakes `docker cp`. */
  const fakeRun = ({ reported = "git version 2.47.3", fail } = {}) => {
    const calls = [];
    const run = async (file, args, _env, _secrets, _project, timeoutMs) => {
      calls.push({ args, timeoutMs });
      assert.equal(file, "docker");
      assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0, "every Docker step is bounded");
      if (fail?.(args)) throw Object.assign(new Error(`failed ${args[0]}`), { stderr: "boom" });
      if (args[0] === "run") return "git version 2.47.3\n";
      if (args[0] === "cp") {
        const [src, dst] = args.slice(1);
        if (src.endsWith("/usr/bin/git"))
          writeFileSync(
            dst,
            `#!/bin/sh\ncase "$GIT_EXEC_PATH" in */image-git/git-core) echo "${reported}";; *) echo wrong;; esac\n`,
            { mode: 0o755 },
          );
        else {
          mkdirSync(dst, { recursive: true });
          if (src.endsWith("git-core")) writeFileSync(join(dst, "git"), "real", { mode: 0o755 });
        }
      }
      return "";
    };
    return { calls, run };
  };
  const project = (tag) => `kb-test-imagegit-${tag}-${process.pid}`;
  const cleaned = (calls, p) => {
    assert.ok(calls.some(({ args }) => args.join(" ") === `rm --force ${p}-git`));
    assert.ok(calls.some(({ args }) => args.join(" ") === `image rm --force ${p}-git`));
  };

  it("labels its build, run and container, and returns logging wrappers for the copied git", async () => {
    const p = project("ok");
    const { calls, run } = fakeRun();
    try {
      const bin = await installImageGit({ project: p, env: {}, secrets: [], run });
      const label = `io.knowledge-base.test-project=${p}`;
      for (const verb of ["build", "run", "create"])
        assert.ok(
          calls.find(({ args }) => args[0] === verb).args.includes(label),
          `${verb} carries the runner label`,
        );
      assert.deepEqual(calls.find(({ args }) => args[0] === "create").args.slice(-3), [
        "--name",
        `${p}-git`,
        `${p}-git`,
      ]);
      const out = spawnSync(join(bin, "git"), ["--version"], { encoding: "utf8" }).stdout.trim();
      assert.equal(out, "git version 2.47.3");
      // The exec path's git (and its dashed links) is the logging dispatcher too.
      const core = join(dirname(bin), "git-core", "git");
      symlinkSync("git", join(dirname(bin), "git-core", "git-upload-pack"));
      spawnSync(join(dirname(bin), "git-core", "git-upload-pack"), ["/repo"], { encoding: "utf8" });
      spawnSync(core, ["merge-base", "a"], { encoding: "utf8" });
      spawnSync(join(bin, "git"), ["http-backend"], { encoding: "utf8" });
      assertImageGitReached(bin, [
        "path http-backend",
        "core git-upload-pack /repo",
        "core git merge-base",
      ]);
      assert.throws(() => assertImageGitReached(bin, ["core git receive-pack"]), /not reached by/);
      cleaned(calls, p);
    } finally {
      rmSync(buildArtifactPath("image-git", p), { recursive: true, force: true });
    }
  });

  it("removes the container by its known name when the create is never acknowledged", async () => {
    const p = project("create");
    const { calls, run } = fakeRun({ fail: (args) => args[0] === "create" });
    try {
      await assert.rejects(
        installImageGit({ project: p, env: {}, secrets: [], run }),
        /failed create/,
      );
      cleaned(calls, p);
    } finally {
      rmSync(buildArtifactPath("image-git", p), { recursive: true, force: true });
    }
  });

  it("cleans both extraction containers after cancellation rejects further suite work", async () => {
    const p = project("cancel");
    const { calls, run: cleanupRun } = fakeRun();
    const interrupted = new Error("interrupted extraction");
    let cancelled = false;
    const run = async (...args) => {
      if (cancelled) throw interrupted;
      if (args[1][0] === "run") {
        cancelled = true;
        throw interrupted;
      }
      return cleanupRun(...args);
    };
    try {
      await assert.rejects(
        installImageGit({ project: p, env: {}, secrets: [], run, cleanupRun }),
        interrupted,
      );
      cleaned(calls, p);
      assert.ok(calls.some(({ args }) => args.join(" ") === `rm --force ${p}-git-version`));
    } finally {
      rmSync(buildArtifactPath("image-git", p), { recursive: true, force: true });
    }
  });

  it("cleans up after an interrupted copy and a version mismatch", async () => {
    for (const [tag, options, error] of [
      ["copy", { fail: (args) => args[0] === "cp" && args[1].endsWith("git-core") }, /failed cp/],
      [
        "version",
        { reported: "git version 2.39.5" },
        /reports "git version 2\.39\.5", the image "git version 2\.47\.3"/,
      ],
    ]) {
      const p = project(tag);
      const { calls, run } = fakeRun(options);
      try {
        await assert.rejects(installImageGit({ project: p, env: {}, secrets: [], run }), error);
        cleaned(calls, p);
      } finally {
        rmSync(buildArtifactPath("image-git", p), { recursive: true, force: true });
      }
    }
  });

  it("bounds the whole extraction by the build budget", async () => {
    const p = project("budget");
    const { calls, run } = fakeRun();
    try {
      await installImageGit({ project: p, env: {}, secrets: [], run, timeoutMs: 5_000 });
      for (const { args, timeoutMs } of calls)
        if (args[0] !== "rm" && args[1] !== "rm") assert.ok(timeoutMs <= 5_000, args[0]);
    } finally {
      rmSync(buildArtifactPath("image-git", p), { recursive: true, force: true });
    }
  });
});

it("PR validation refuses failed, cancelled, skipped or missing migration checks", () => {
  const workflow = readFileSync(join(ROOT, ".github/workflows/pr-checks.yml"), "utf8");
  const step = workflow.slice(
    workflow.indexOf("      - name: Require successful validation for ready pull requests"),
  );
  const block = step
    .split("        run: |\n")[1]
    .split("\n")
    .map((line) => line.slice(10))
    .join("\n");
  const names = [...step.matchAll(/^ {10}([A-Z_]+):/gm)].map((match) => match[1]);
  assert.ok(names.includes("MIGRATIONS_RESULT"));
  for (const result of ["success", "failure", "cancelled", "skipped", ""]) {
    const env = Object.fromEntries(names.map((name) => [name, "success"]));
    const run = spawnSync("bash", ["-euc", block], {
      env: { PATH: process.env.PATH, ...env, IS_DRAFT: "false", MIGRATIONS_RESULT: result },
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(run.status === 0, result === "success", `migration result ${result || "missing"}`);
  }
});
