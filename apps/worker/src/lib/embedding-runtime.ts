import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { EMBEDDING_RUNTIME } from "@knowledge-base/api/lib/kb/builtin-model";

type Manifest = {
  runtime: Record<string, unknown>;
  platform: string;
  arch: string;
  files: Record<string, string>;
};
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseManifest(value: unknown): Manifest {
  if (
    !record(value) ||
    !record(value.runtime) ||
    !record(value.files) ||
    value.platform !== "linux" ||
    !["x64", "arm64"].includes(String(value.arch)) ||
    Object.entries(value.files).some(
      ([name, hash]) =>
        !/^[A-Za-z0-9_.-]+$/.test(name) || typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash),
    )
  )
    throw new Error("invalid runtime receipt");
  return value as Manifest;
}

/** Verify immutable image/cache files before mapping anything. No runtime download/build. */
export function verifyEmbeddingRuntime(dir: string) {
  const manifest = parseManifest(JSON.parse(readFileSync(join(dir, "kb-runtime.json"), "utf8")));
  if (
    manifest.platform !== process.platform ||
    manifest.arch !== process.arch ||
    Object.entries(EMBEDDING_RUNTIME).some(([key, value]) => manifest.runtime[key] !== value) ||
    !Object.hasOwn(manifest.files, "llama-addon.node")
  )
    throw new Error("embedding runtime provenance mismatch");
  for (const [name, digest] of Object.entries(manifest.files)) {
    const file = join(dir, name);
    if (
      !lstatSync(file).isFile() ||
      createHash("sha256").update(readFileSync(file)).digest("hex") !== digest
    )
      throw new Error("embedding runtime file mismatch");
  }
  return manifest;
}

/** Positive OS evidence: the checked addon and its native libraries are the mapped ones. */
export function assertLoadedRuntime(
  llama: { buildType: string; gpu: unknown; llamaCppRelease: { repo: string; release: string } },
  dir: string,
  maps: string,
  verifiedFiles?: Readonly<Record<string, string>>,
) {
  const folder = resolve(dir);
  const paths = maps
    .split("\n")
    .map((line) => line.slice(line.indexOf("/")))
    .filter((path) => /\/(?:llama-addon\.node|lib(?:llama|ggml)[^/]*)$/.test(path));
  if (
    llama.buildType !== "localBuild" ||
    llama.gpu !== false ||
    llama.llamaCppRelease.repo !== "ggml-org/llama.cpp" ||
    llama.llamaCppRelease.release !== EMBEDDING_RUNTIME.release ||
    !paths.includes(join(folder, "llama-addon.node")) ||
    paths.some(
      (path) =>
        !path.startsWith(`${folder}/`) ||
        (verifiedFiles && !Object.hasOwn(verifiedFiles, path.slice(folder.length + 1))),
    )
  )
    throw new Error("unverified embedding binary loaded");
}

/** Package root supplied by the child; lastBuild is only a pointer, never trusted identity. */
export function embeddingRuntimeDirectory(packageRoot: string): string {
  const pointer: unknown = JSON.parse(
    readFileSync(join(packageRoot, "llama/lastBuild.json"), "utf8"),
  );
  if (
    !record(pointer) ||
    typeof pointer.folderName !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(pointer.folderName)
  )
    throw new Error("invalid runtime pointer");
  return realpathSync(join(packageRoot, "llama/localBuilds", pointer.folderName, "Release"));
}
