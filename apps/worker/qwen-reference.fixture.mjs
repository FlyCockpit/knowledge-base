/**
 * Independent full-batch oracle for the real-model regression. Native CPU kernels
 * differ across hosts; compare batching on the SAME hardware/backend at the
 * unchanged 0.99999 tolerance. A separate process keeps the test parent addon-free
 * and releases the full-batch buffers before the production child is loaded.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { availableParallelism } from "node:os";
import { pathToFileURL } from "node:url";

const require = createRequire(new URL("./package.json", import.meta.url));
// Exercise the worker's installed native dependency; this fixture has no second copy.
const { getLlama, LlamaLogLevel } = await import(pathToFileURL(require.resolve("node-llama-cpp")));
const [modelPath, fixturesPath, artifactPath] = process.argv.slice(2);
const fixtures = JSON.parse(readFileSync(fixturesPath, "utf8"));
const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
const nativePin = JSON.parse(
  readFileSync(
    new URL("../../packages/api/src/lib/kb/fixtures/embedding-runtime.json", import.meta.url),
  ),
);
const llama = await getLlama({
  gpu: false,
  build: "never",
  usePrebuiltBinaries: false,
  cmakeOptions: {
    KB_EMBEDDING_RUNTIME: nativePin.sourceSha256,
  },
  skipDownload: true,
  progressLogs: false,
  logLevel: LlamaLogLevel.error,
});
if (llama.buildType !== "localBuild" || llama.llamaCppRelease.release !== nativePin.release)
  throw new Error("unverified native oracle");
try {
  const model = await llama.loadModel({
    modelPath,
    defaultContextFlashAttention: true,
    experimentalDefaultContextKvCacheKeyType: "F16",
    experimentalDefaultContextKvCacheValueType: "F16",
  });
  try {
    const context = await model.createEmbeddingContext({
      contextSize: 4097,
      batchSize: 4097,
      threads: Math.min(6, availableParallelism()),
    });
    const items = [];
    try {
      for (const item of fixtures.items) {
        const text = item.purpose === "query" ? artifact.queryPrefix + item.text : item.text;
        const tokens = [...model.tokenize(text, false), artifact.eosTokenId];
        if (tokens.length !== item.tokens || tokens.length >= 4097)
          throw new Error(`Reference token contract changed: ${item.id}`);
        const raw = Array.from((await context.getEmbeddingFor(tokens)).vector);
        const norm = Math.hypot(...raw);
        if (raw.length !== artifact.dimensions || !raw.every(Number.isFinite) || !(norm > 0))
          throw new Error(`Invalid reference vector: ${item.id}`);
        items.push({ id: item.id, tokens: tokens.length, vector: raw.map((v) => v / norm) });
      }
    } finally {
      await context.dispose();
    }
    // Inverse of the pooled-logits optimization: a normal context must still
    // produce logits and sampled tokens. Keep this on the same real backend.
    const generation = await model.createContext({
      contextSize: 256,
      batchSize: 512,
      threads: Math.min(6, availableParallelism()),
    });
    const generationTokens = [];
    try {
      for await (const token of generation.getSequence().evaluate(model.tokenize("Hello", false), {
        temperature: 0,
        yieldEogToken: true,
      })) {
        generationTokens.push(token);
        if (generationTokens.length === 3) break;
      }
    } finally {
      await generation.dispose();
    }
    process.stdout.write(JSON.stringify({ arch: process.arch, generationTokens, items }));
  } finally {
    await model.dispose();
  }
} finally {
  await llama.dispose();
}
