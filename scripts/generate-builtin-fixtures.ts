/** Model smoke/CLI artifact projections; descriptor is the source of truth. */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { GEMMA_MODEL, QWEN_MODEL } from "../packages/api/src/lib/kb/builtin-model";
import {
  MODEL_DOWNLOAD_ALLOWED_HOSTS,
  MODEL_MAX_REDIRECTS,
} from "../packages/api/src/lib/kb/model-artifact";

import { estimateBuiltinPeakBytes } from "../packages/api/src/lib/kb/qwen-runtime-config";

for (const [file, model] of [
  ["qwen-artifact.json", QWEN_MODEL],
  ["gemma-artifact.json", GEMMA_MODEL],
] as const) {
  const path = resolve("packages/api/src/lib/kb/fixtures", file);
  const {
    modelId,
    fileName,
    sizeBytes,
    sha256,
    url,
    dimensions,
    pooling,
    queryPrefix,
    addBos,
    addEos,
    eosTokenId,
  } = model;
  const data = {
    modelId,
    fileName,
    sizeBytes,
    sha256,
    url,
    dimensions,
    pooling,
    queryPrefix,
    addBos,
    addEos,
    eosTokenId,
    contextTiers: model.contextTiers,
    memoryEstimates: Object.fromEntries(
      model.contextTiers.map((contextTokens) => [
        contextTokens,
        estimateBuiltinPeakBytes(model, { contextTokens, kvKeyType: "f16", kvValueType: "f16" }),
      ]),
    ),
    allowedHosts: MODEL_DOWNLOAD_ALLOWED_HOSTS,
    maxRedirects: MODEL_MAX_REDIRECTS,
  };
  const output = (JSON.stringify(data, null, 2) + "\n").replace(
    /"contextTiers": \[\n[\s\S]*?\n {2}\]/,
    `"contextTiers": ${JSON.stringify(model.contextTiers).replaceAll(",", ", ")}`,
  );
  if (process.argv.includes("--check")) {
    if (readFileSync(path, "utf8") !== output) throw new Error(`Model fixture drift: ${file}`);
  } else writeFileSync(path, output);
}
