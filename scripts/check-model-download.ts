/**
 * `pnpm kb:models:live-download`: the live check of the pinned built-in model
 * artifacts. `.github/workflows/kb-model-live-download.yml` runs it weekly
 * (Monday 04:17 UTC) and on demand; it never gates a push or pull request.
 *
 * Each pinned artifact is fetched from its production URL into an empty
 * directory through the production downloader (`downloadModelArtifact`: HTTPS
 * on the allowlisted hosts, public-address DNS, bounded redirects, exact size
 * and SHA-256, link(2) publication), then hashed again here. An upstream file
 * move, a changed hash or a broken redirect turns that workflow red. The
 * push/PR model lanes use the SHA-keyed, verified CI cache instead and never
 * download from Hugging Face unless that cache is empty.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GEMMA_MODEL, QWEN_MODEL } from "../packages/api/src/lib/kb/builtin-model.ts";
import {
  type DownloadModelArtifactInput,
  downloadModelArtifact,
} from "../packages/api/src/lib/kb/model-artifact.ts";

/** Per-artifact budget, unchanged from the former per-run live download test. */
export const LIVE_DOWNLOAD_TIMEOUT_MS = 290_000;

export type LiveArtifact = {
  modelId: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
  url: string;
};

export type LiveDownloadOptions = {
  models?: readonly LiveArtifact[];
  download?: (
    input: DownloadModelArtifactInput,
  ) => Promise<{ outcome: "PUBLISHED" | "ALREADY_PRESENT"; path: string }>;
  scratch?: string;
  timeoutMs?: number;
  log?: (line: string) => void;
};

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** A downloader error's code (its message), plus the underlying cause when there is one. */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? ` (${error.cause.message})` : "";
  return `${error.message}${cause}`;
}

async function checkOne(
  model: LiveArtifact,
  scratch: string,
  download: NonNullable<LiveDownloadOptions["download"]>,
  timeoutMs: number,
): Promise<string> {
  const dir = await mkdtemp(join(scratch, `${model.modelId}-`));
  try {
    const started = Date.now();
    const result = await download({
      dir,
      epoch: 1,
      expected: model,
      signal: AbortSignal.timeout(timeoutMs),
      onProgress: () => {},
    });
    // The directory started empty, so anything but a fresh publication is wrong.
    if (result.outcome !== "PUBLISHED")
      throw new Error(`expected PUBLISHED, got ${result.outcome}`);
    const expectedPath = join(dir, model.fileName);
    if (result.path !== expectedPath)
      throw new Error(`published ${result.path}, expected ${expectedPath}`);
    const { size } = await stat(expectedPath);
    if (size !== model.sizeBytes) throw new Error(`${size} bytes, pinned ${model.sizeBytes}`);
    const actual = await sha256(expectedPath);
    if (actual !== model.sha256) throw new Error(`sha256 ${actual}, pinned ${model.sha256}`);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    return `${model.modelId}: PUBLISHED ${size} bytes sha256 ${actual} in ${seconds} s from ${model.url}`;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Checks every artifact (one failure does not hide another), then throws if any failed. */
export async function checkLiveDownloads(options: LiveDownloadOptions = {}): Promise<void> {
  const models = options.models ?? [QWEN_MODEL, GEMMA_MODEL];
  const download = options.download ?? downloadModelArtifact;
  const timeoutMs = options.timeoutMs ?? LIVE_DOWNLOAD_TIMEOUT_MS;
  const log = options.log ?? console.log;
  if (models.length === 0) throw new Error("no pinned artifacts to check");
  const scratch = await mkdtemp(join(options.scratch ?? tmpdir(), "kb-model-live-"));
  const failures: string[] = [];
  try {
    for (const model of models) {
      try {
        log(await checkOne(model, scratch, download, timeoutMs));
      } catch (error) {
        failures.push(`${model.modelId}: ${describe(error)}`);
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  if (failures.length > 0) throw new Error(`live model download failed:\n${failures.join("\n")}`);
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  checkLiveDownloads({ scratch: process.env.RUNNER_TEMP }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
