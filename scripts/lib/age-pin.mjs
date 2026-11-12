// The single source of truth for the approved age release (official
// FiloSottile/age v1.3.2 linux archives, pinned by their published SHA-256).
// Used by Dockerfile (age-tooling stage, `--install /opt/age`) and by
// scripts/test-kb.mjs, which provisions the same binaries for suites that run
// real age. Node builtins + the system `tar` only; no npm dependency.
//
//   node scripts/lib/age-pin.mjs                       # ensure the per-user cache, print its dir
//   node scripts/lib/age-pin.mjs --install /opt/age --arch amd64
//
// The archive's SHA-256 is verified BEFORE anything is extracted; installation
// is staged in a sibling temp dir and renamed into place, and an existing
// install is reused only when its binaries report exactly the pinned version.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const AGE_VERSION = "v1.3.2";
export const AGE_SHA256 = Object.freeze({
  amd64: "cbe24006683f8eb669266162894b9a522a1af52f2665fbc63a4bb032ed26ac10",
  arm64: "6b8dc4333c53a5a57c9e5834e3a48f92605d7154014cd07269ff3327db5d37f4",
});

const NODE_ARCH = { x64: "amd64", arm64: "arm64" };

/** Map a Node or Docker architecture name to a pinned age archive arch, or throw. */
export function ageArch(arch = process.arch) {
  const mapped = NODE_ARCH[arch] ?? arch;
  if (!Object.hasOwn(AGE_SHA256, mapped))
    throw new Error(
      `age ${AGE_VERSION}: unsupported architecture "${arch}" (pinned: ${Object.keys(AGE_SHA256).join(", ")})`,
    );
  return mapped;
}

function ageArchiveUrl(arch) {
  return `https://github.com/FiloSottile/age/releases/download/${AGE_VERSION}/age-${AGE_VERSION}-linux-${arch}.tar.gz`;
}

/** Default per-user cache install dir for one arch. */
function defaultAgeDir(arch = ageArch(), env = process.env) {
  const cache = env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(cache, "kb-tools", `age-${AGE_VERSION}-linux-${arch}`);
}

/** True when dir holds age + age-keygen that both report exactly the pinned version. */
export function isPinnedAgeDir(dir, version = AGE_VERSION) {
  for (const bin of ["age", "age-keygen"]) {
    const file = join(dir, bin);
    if (!existsSync(file)) return false;
    try {
      const out = execFileSync(file, ["--version"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 10_000,
      });
      if (out.trim() !== version) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** Throw a clear error unless dir holds the pinned age binaries. */
export function assertPinnedAgeDir(dir, label = dir) {
  if (!isPinnedAgeDir(dir))
    throw new Error(
      `${label}: age and age-keygen ${AGE_VERSION} not found (each must print ${AGE_VERSION})`,
    );
  return dir;
}

async function fetchArchive(url) {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`age download failed: HTTP ${response.status} for ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Ensure the pinned age binaries are installed in `dir` and return it.
 * Options (tests only): `download(url)` returns the archive bytes, `sha256`
 * overrides the expected digest, `tarBin` overrides the extractor.
 */
export async function ensureAge(options = {}) {
  const arch = ageArch(options.arch);
  const dir = resolve(options.dir ?? defaultAgeDir(arch, options.env));
  if (isPinnedAgeDir(dir)) return dir;
  const expected = options.sha256 ?? AGE_SHA256[arch];
  const parent = dirname(dir);
  mkdirSync(parent, { recursive: true });
  const stage = mkdtempSync(join(parent, `.${basename(dir)}.tmp-`));
  try {
    const bytes = await (options.download ?? fetchArchive)(ageArchiveUrl(arch));
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== expected)
      throw new Error(
        `age ${AGE_VERSION} ${arch}: checksum mismatch (expected ${expected}, got ${actual}); not extracted`,
      );
    const archive = join(stage, "age.tar.gz");
    writeFileSync(archive, bytes, { mode: 0o600 });
    const tree = join(stage, "tree");
    mkdirSync(tree);
    execFileSync(options.tarBin ?? "tar", ["-xzf", archive, "-C", tree], { stdio: "pipe" });
    const extracted = join(tree, "age");
    assertPinnedAgeDir(extracted, `age ${AGE_VERSION} archive`);
    // A stale or foreign install is replaced, never trusted.
    rmSync(dir, { recursive: true, force: true });
    try {
      renameSync(extracted, dir);
    } catch (error) {
      // A concurrent installer won the rename: accept its install only if pinned.
      if (!isPinnedAgeDir(dir)) throw error;
    }
    return assertPinnedAgeDir(dir);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

async function main(argv) {
  const args = { arch: undefined, dir: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--install") args.dir = argv[++i];
    else if (argv[i] === "--arch") args.arch = argv[++i];
    else
      throw new Error(`Usage: age-pin.mjs [--install <dir>] [--arch amd64|arm64] (got ${argv[i]})`);
  }
  process.stdout.write(`${await ensureAge(args)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
