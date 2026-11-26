import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { GEMMA_MODEL, QWEN_MODEL } from "../packages/api/src/lib/kb/builtin-model.ts";
import type { DownloadModelArtifactInput } from "../packages/api/src/lib/kb/model-artifact.ts";
import {
  checkLiveDownloads,
  LIVE_DOWNLOAD_TIMEOUT_MS,
  type LiveArtifact,
} from "./check-model-download.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "kb-model-live-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

function artifact(modelId: string, bytes: string): LiveArtifact & { bytes: string } {
  return {
    modelId,
    fileName: `${modelId}.gguf`,
    sizeBytes: Buffer.byteLength(bytes),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    url: `https://huggingface.co/example/${modelId}.gguf`,
    bytes,
  };
}
const a = artifact("model-a", "alpha bytes");
const b = artifact("model-b", "bravo bytes!");

/** Publishes `bytes` (default: the pinned ones) the way the downloader does. */
function publishing(bytes: Record<string, string> = {}) {
  const calls: DownloadModelArtifactInput[] = [];
  const download = async (input: DownloadModelArtifactInput) => {
    calls.push(input);
    assert.deepEqual(readdirSync(input.dir), [], "each artifact starts from an empty directory");
    assert.equal(input.signal.aborted, false);
    const model = [a, b].find((m) => m.fileName === input.expected.fileName)!;
    const path = join(input.dir, input.expected.fileName);
    writeFileSync(path, bytes[model.modelId] ?? model.bytes);
    return { outcome: "PUBLISHED" as const, path };
  };
  return { calls, download };
}

describe("checkLiveDownloads", () => {
  test("downloads every pin into an empty directory and re-hashes it", async () => {
    const lines: string[] = [];
    const { calls, download } = publishing();
    await checkLiveDownloads({ models: [a, b], download, scratch, log: (l) => lines.push(l) });
    assert.deepEqual(
      calls.map((c) => c.expected),
      [a, b],
    );
    assert.match(lines[0]!, /^model-a: PUBLISHED 11 bytes sha256 [0-9a-f]{64} in /);
    assert.match(lines[1]!, /^model-b: PUBLISHED 12 bytes/);
    for (const call of calls) assert.equal(existsSync(call.dir), false);
    assert.deepEqual(readdirSync(scratch), [], "scratch is removed");
  });

  test("a published file whose bytes differ from the pin fails, and the other pin is still checked", async () => {
    const { calls, download } = publishing({ "model-a": "alpha bytez" });
    await assert.rejects(
      checkLiveDownloads({ models: [a, b], download, scratch, log: () => {} }),
      (error: Error) => {
        assert.match(error.message, /model-a: sha256 [0-9a-f]{64}, pinned /);
        assert.doesNotMatch(error.message, /model-b/);
        return true;
      },
    );
    assert.equal(calls.length, 2);
    assert.deepEqual(readdirSync(scratch), []);
  });

  test("a size mismatch fails before hashing", async () => {
    const { download } = publishing({ "model-b": "short" });
    await assert.rejects(
      checkLiveDownloads({ models: [b], download, scratch, log: () => {} }),
      /model-b: 5 bytes, pinned 12/,
    );
  });

  test("ALREADY_PRESENT from an empty directory is a failure, not a pass", async () => {
    await assert.rejects(
      checkLiveDownloads({
        models: [a],
        download: async (input) => ({
          outcome: "ALREADY_PRESENT",
          path: join(input.dir, input.expected.fileName),
        }),
        scratch,
        log: () => {},
      }),
      /model-a: expected PUBLISHED, got ALREADY_PRESENT/,
    );
  });

  test("a downloader error is reported with its code and cause", async () => {
    await assert.rejects(
      checkLiveDownloads({
        models: [a, b],
        download: async (input) => {
          if (input.expected.fileName === a.fileName)
            throw new Error("MODEL_HTTP_STATUS", { cause: new Error("404 from huggingface.co") });
          return publishing().download(input);
        },
        scratch,
        log: () => {},
      }),
      /live model download failed:\nmodel-a: MODEL_HTTP_STATUS \(404 from huggingface\.co\)$/,
    );
  });

  test("the per-artifact budget is the former test's 290 s and aborts the download", async () => {
    assert.equal(LIVE_DOWNLOAD_TIMEOUT_MS, 290_000);
    await assert.rejects(
      checkLiveDownloads({
        models: [a],
        timeoutMs: 20,
        download: (input) =>
          new Promise((_, reject) => {
            // AbortSignal.timeout's timer is unreferenced; a real download's socket keeps
            // the process alive, and this referenced timer stands in for it.
            const alive = setTimeout(() => reject(new Error("budget never fired")), 10_000);
            input.signal.addEventListener("abort", () => {
              clearTimeout(alive);
              reject(new Error("MODEL_CANCELLED"));
            });
          }),
        scratch,
        log: () => {},
      }),
      /model-a: MODEL_CANCELLED/,
    );
  });
});

/**
 * A `.`/`..` segment (@actions/glob rejects it), after an inline YAML comment,
 * YAML quotes and Windows separators.
 */
function cachePathEscapes(line: string): boolean {
  const path = line
    .replace(/\s+#.*$/, "")
    .trim()
    .replace(/^(["'])(.*)\1$/, "$2")
    .replaceAll("\\", "/");
  return /(^|\/)\.\.?(\/|$)/.test(path);
}

/** A .dockerignore negation that could re-include model weights or everything. */
function reincludesWeights(line: string): boolean {
  const rule = /^\s*!\s*(.*)$/.exec(line)?.[1]?.replace(/^[/\\]+/, "");
  return rule !== undefined && /cache|gguf|kb-models|^\*/.test(rule);
}

describe("live download placement", () => {
  const workflow = readFileSync(join(ROOT, ".github/workflows/kb-model-live-download.yml"), "utf8");
  const smoke = readFileSync(join(ROOT, ".github/workflows/kb-model-smoke.yml"), "utf8");
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

  test("the weekly workflow runs only on its schedule or on demand", () => {
    const on = /^on:\n((?: .*\n|\n)*)/m.exec(workflow)?.[1] ?? "";
    assert.deepEqual(
      on
        .split("\n")
        .filter((line) => /^ {2}\S/.test(line))
        .map((line) => line.trim()),
      ["schedule:", "workflow_dispatch:"],
    );
    assert.match(on, /- cron: "17 4 \* \* 1"/);
    assert.match(workflow, /run: pnpm kb:models:live-download\n/);
    assert.equal(
      pkg.scripts["kb:models:live-download"],
      "node --import tsx scripts/check-model-download.ts",
    );
  });

  test("the per-run model lane never downloads; it reads the cached, verified artifacts", () => {
    // The lane's files, from its registration in scripts/test-kb.mjs.
    const runner = readFileSync(join(ROOT, "scripts/test-kb.mjs"), "utf8");
    const lane = /\n {2}"qwen-model": \{\n {4}include: \[([^\]]*)\]/.exec(runner)?.[1] ?? "";
    const files = [...lane.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
    assert.ok(files.length >= 2, "qwen-model lane files found");
    for (const file of files) {
      const source = readFileSync(join(ROOT, file), "utf8");
      assert.doesNotMatch(source, /downloadModelArtifact/, file);
    }
  });

  test("the CI cache keys and cache-miss URLs are the pins this check downloads", () => {
    const env = (name: string) => new RegExp(`^ {2}${name}: (\\S+)$`, "m").exec(smoke)?.[1];
    for (const [kind, model] of [
      ["QWEN", QWEN_MODEL],
      ["GEMMA", GEMMA_MODEL],
    ] as const) {
      assert.equal(env(`${kind}_SHA256`), model.sha256, kind);
      assert.equal(env(`${kind}_FILE`), model.fileName, kind);
      assert.equal(env(`${kind}_URL`), model.url, kind);
    }
  });

  test("push/PR workflows fetch weights only to fill an empty cache", () => {
    const dir = join(ROOT, ".github/workflows");
    for (const name of readdirSync(dir)) {
      const source = readFileSync(join(dir, name), "utf8");
      if (name !== "kb-model-live-download.yml")
        assert.doesNotMatch(source, /kb:models:live-download|check-model-download/, name);
      // Every step that fetches a pinned URL runs only when the SHA-keyed cache missed.
      for (const step of source
        .split(/\n {6}- /)
        .filter((s) => /_URL\b/.test(s) && /curl /.test(s)))
        assert.match(
          step,
          /if: steps\.[\w-]+\.outputs\.cache-hit != 'true'|MODELS_CACHE_HIT: \$\{\{ steps\.models\.outputs\.cache-hit \}\}[\s\S]*if \[ "\$MODELS_CACHE_HIT" != true \]; then\n\s+curl /,
          `${name}: ${step.split("\n")[0]}`,
        );
    }
    for (const script of ["test", "verify", "verify:fast", "gate"])
      assert.doesNotMatch(pkg.scripts[script], /live-download|qwen-model/, script);
  });

  test("every model leg restores the one shared, cross-OS model cache entry once", () => {
    const steps = smoke.split(/\n {6}- /);
    const cacheSteps = steps.filter((s) => /uses: actions\/cache[@/]/.test(s));
    const modelSteps = cacheSteps.filter((s) => /gguf/.test(s));
    // smoke and rust-smoke: one restore and one save-on-miss each.
    assert.deepEqual(
      modelSteps.map((s) => /actions\/cache\/(restore|save)@/.exec(s)?.[1]),
      ["restore", "save", "restore", "save"],
    );
    for (const step of modelSteps) {
      assert.match(step, /\n {10}path: \.cache\/kb-models\n/);
      assert.match(
        step,
        /\n {10}key: kb-gguf-\$\{\{ env\.GEMMA_SHA256 \}\}-\$\{\{ env\.QWEN_SHA256 \}\}\n/,
      );
      assert.match(step, /\n {10}enableCrossOsArchive: true(\n|$)/);
      if (/cache\/save@/.test(step))
        assert.match(step, /if: steps\.models\.outputs\.cache-hit != 'true'/);
    }
    // Every leg reads the weights where the cache restores them.
    assert.doesNotMatch(
      smoke,
      /runner\.temp \}\}\/kb-models|rust-models|qwen-model\/|gemma-model\//,
    );
    for (const kind of ["GEMMA", "QWEN"]) {
      const value = `\n {10}KB_${kind}_MODEL_PATH: (.*)\n`;
      const values = [...smoke.matchAll(new RegExp(value, "g"))].map((match) => match[1]);
      // One in the smoke job, one in rust-smoke, each the exact restored file.
      assert.deepEqual(
        values,
        Array(2).fill(`\${{ github.workspace }}/.cache/kb-models/\${{ env.${kind}_FILE }}`),
        kind,
      );
    }
    // The weights stay out of the image build context (COPY . . in the builder):
    // the root .dockerignore excludes them, with no rule re-including them and no
    // Dockerfile-specific ignore file that would replace it.
    const dockerignore = readFileSync(join(ROOT, ".dockerignore"), "utf8").split("\n");
    assert.ok(dockerignore.includes(".cache") && dockerignore.includes("**/*.gguf"));
    assert.deepEqual(dockerignore.filter(reincludesWeights), []);
    assert.deepEqual(
      readdirSync(ROOT).filter(
        (name) => name.endsWith(".dockerignore") && name !== ".dockerignore",
      ),
      [],
    );
    const acquire = steps.filter((s) => /^name: Acquire and verify both pinned models/.test(s));
    assert.equal(acquire.length, 2);
    for (const step of acquire) {
      assert.match(step, /dir="\$\{\{ github\.workspace \}\}\/\.cache\/kb-models"/);
      // A hit never downloads: a restored entry missing a file fails verification.
      assert.equal(step.split(/\bcurl /).length - 1, 1);
      assert.match(
        step,
        /\n {10}MODELS_CACHE_HIT: \$\{\{ steps\.models\.outputs\.cache-hit \}\}\n[\s\S]*\n {12}if \[ "\$MODELS_CACHE_HIT" != true \]; then\n {14}curl /,
      );
    }
  });

  test("the cache path guard sees quoted and Windows-style dot segments", () => {
    for (const path of [
      "../x",
      "./x",
      "a/../b",
      '"../x"',
      "'..\\x'",
      "a\\..\\b",
      "..",
      '"../x" # cache directory',
    ])
      assert.ok(cachePathEscapes(path), path);
    for (const path of [".cache/kb-models", "~/.npm", "node_modules", "a/b..c", '".cache/x"'])
      assert.ok(!cachePathEscapes(path), path);
  });

  test("the .dockerignore guard sees any negation that re-includes the weights", () => {
    for (const line of ["!/**", "!*", "! **/*.gguf", "!.cache/kb-models", "!/.cache", "!\\**"])
      assert.ok(reincludesWeights(line), line);
    for (const line of ["!.git/HEAD", "!THIRD-PARTY-LICENSES.md", ".cache", "**/*.gguf", ""])
      assert.ok(!reincludesWeights(line), line);
  });

  test("no actions/cache path climbs out of the workspace with ..", () => {
    // @actions/glob rejects `.`/`..` segments: the save only warns, so the cache
    // would silently never fill.
    const dir = join(ROOT, ".github/workflows");
    for (const name of readdirSync(dir)) {
      const source = readFileSync(join(dir, name), "utf8");
      for (const step of source.split(/\n {6}- /).filter((s) => /uses: actions\/cache[@/]/.test(s)))
        for (const line of /\n {10}path: \|?([^\n]*(?:\n {12}[^\n]*)*)/
          .exec(step)?.[1]
          ?.split("\n") ?? [])
          assert.ok(!cachePathEscapes(line), `${name}: ${line.trim()}`);
    }
  });

  test("only main pushes write the buildkit layer cache, and only final-image layers", () => {
    const dir = join(ROOT, ".github/workflows");
    const writers = readdirSync(dir).filter((name) =>
      /cache-to:/.test(readFileSync(join(dir, name), "utf8")),
    );
    // release.yml writes its own release-* scopes, on a manual release only.
    assert.deepEqual(writers.sort(), ["build-image.yml", "release.yml"]);
    const build = readFileSync(join(dir, "build-image.yml"), "utf8");
    assert.match(
      build,
      /cache-to: \$\{\{ github\.event_name == 'push' && github\.ref == 'refs\/heads\/main' && format\('type=gha,mode=min,scope=\{0\}', matrix\.name\) \|\| '' \}\}\n/,
    );
    assert.match(smoke, /cache-from: type=gha,scope=worker\n/);
  });
});
