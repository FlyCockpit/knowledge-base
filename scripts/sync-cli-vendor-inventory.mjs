/**
 * Per-file SHA-256 inventory of the CLI's vendored llama.cpp bindings
 * (`apps/cli/vendor/inventory.json`), derived from the pinned upstream archives.
 *
 *   node scripts/sync-cli-vendor-inventory.mjs            # regenerate (network)
 *   node scripts/sync-cli-vendor-inventory.mjs --check    # offline tree check (gate)
 *   node scripts/sync-cli-vendor-inventory.mjs --check --from-archives
 *                                                         # re-derive and compare
 *
 * Every vendored file must be byte-identical to its pinned archive except the
 * fork edits and added license files listed below. Regeneration fails when a file
 * differs from upstream without a FORK_EDITS entry, or an entry no longer
 * differs. `--check` fails on any added, removed, changed or executable file and
 * on pin drift against the server runtime pin and the Cargo pins.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const VENDOR = join(root, "apps/cli/vendor");
const INVENTORY = join(VENDOR, "inventory.json");
const RUNTIME_PIN = join(root, "packages/api/src/lib/kb/fixtures/embedding-runtime.json");
const KB_LOCAL_MANIFEST = join(root, "apps/cli/crates/kb-local/Cargo.toml");

/** Ours, not upstream: the vendor README, the fork patch record and this inventory. */
const VENDOR_ROOT_ENTRIES = [
  "README.md",
  "inventory.json",
  "llama-cpp-2",
  "llama-cpp-sys-2",
  "patches",
];
const CRATES = ["llama-cpp-2", "llama-cpp-sys-2"];
/** Upstream crate content deliberately not vendored. */
const CRATE_REMOVED = [
  "Cargo.lock",
  "Cargo.toml.orig",
  ".cargo_vcs_info.json",
  "tests/",
  // Replaced by the pinned llama.cpp release below.
  "llama.cpp/",
];
/** Added from the binding source revision recorded in the crate's .cargo_vcs_info.json. */
const ADDED_LICENSES = ["LICENSE-APACHE", "LICENSE-MIT"];
/** The documented fork edits (apps/cli/vendor/README.md). Nothing else may differ. */
export const FORK_EDITS = {
  "llama-cpp-2/Cargo.toml":
    "sys dependency without its default `common` feature; macOS without automatic Metal; upstream test target dropped",
  "llama-cpp-2/src/lib.rs": "feature-gate imports used only by `common`",
  "llama-cpp-2/src/log.rs": "feature-gate the `mtmd` log module",
  "llama-cpp-2/src/model/params.rs": "feature-gate `common`-only import and field",
  "llama-cpp-2/src/sampling.rs": "feature-gate `common`-only import and helper",
  "llama-cpp-2/src/timing.rs": "zero-initialize the llama.cpp v0.7.0 graph-reallocation counters",
  "llama-cpp-sys-2/Cargo.toml": "cc >= 1.7.0 build dependency",
  "llama-cpp-sys-2/build.rs":
    "cap native build jobs at three; read the MSVC INCLUDE path via `Tool::get_envs`; force GPU backends OFF; link OpenMP and libstdc++ statically on musl targets",
};
/**
 * llama.cpp paths kept from the release archive (the sys crate's build inputs).
 * An entry with a recursive glob segment mirrors the sys crate's Cargo `include`
 * glob: files at any depth under the directory before it whose name matches the
 * leaf after it (an exact name, or a `*` suffix such as `*.h`).
 */
const LLAMA_SELECTION = [
  "CMakeLists.txt",
  "LICENSE",
  "cmake",
  "common",
  "ggml",
  "include",
  "pocs",
  "src",
  "vendor",
  "tools/CMakeLists.txt",
  "tools/mtmd/**/*.h",
  "tools/mtmd/**/*.cpp",
  "tools/mtmd/**/CMakeLists.txt",
];
const LLAMA_ROOT = "llama-cpp-sys-2/llama.cpp";

/** Whether the file name of `path` matches `leaf` (`*.ext` suffix or an exact name). */
const matchesLeaf = (path, leaf) => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return leaf.startsWith("*") ? name.endsWith(leaf.slice(1)) : name === leaf;
};

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Regular files under `dir`, relative and `/`-separated; rejects links and specials. */
export function listFiles(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) out.push(relative(dir, path).split("\\").join("/"));
      else throw new Error(`vendored path is not a regular file: ${relative(dir, path)}`);
    }
  };
  walk(dir);
  return out.sort();
}

/** Every difference between a vendor tree and an inventory file map. */
export function compareTree(dir, files) {
  const problems = [];
  const actual = new Set();
  for (const crate of CRATES)
    for (const file of listFiles(join(dir, crate))) actual.add(`${crate}/${file}`);
  for (const path of actual) {
    if (!(path in files)) {
      problems.push(`added: ${path}`);
      continue;
    }
    const full = join(dir, path);
    if (sha256(readFileSync(full)) !== files[path]) problems.push(`changed: ${path}`);
    if (process.platform !== "win32" && (lstatSync(full).mode & 0o111) !== 0)
      problems.push(`executable: ${path}`);
  }
  for (const path of Object.keys(files)) if (!actual.has(path)) problems.push(`removed: ${path}`);
  const entries = readdirSync(dir).sort();
  for (const entry of entries)
    if (!VENDOR_ROOT_ENTRIES.includes(entry)) problems.push(`added: ${entry}`);
  return problems;
}

function cargoVersion(manifest) {
  const match = /^\[package\][^[]*?^version = "([^"]+)"/ms.exec(readFileSync(manifest, "utf8"));
  if (!match) throw new Error(`no package version in ${manifest}`);
  return match[1];
}

/** Pins the inventory must agree with: server runtime pin and Cargo manifests. */
export function pinProblems(inventory) {
  const problems = [];
  const pin = JSON.parse(readFileSync(RUNTIME_PIN, "utf8"));
  const llama = inventory.llamaCpp;
  for (const [key, expected] of [
    ["release", pin.release],
    ["commit", pin.commit],
    ["archive", pin.sourceUrl],
    ["archiveSha256", pin.sourceSha256],
  ])
    if (llama?.[key] !== expected) problems.push(`llama.cpp ${key} drifts from the server pin`);
  const kbLocal = readFileSync(KB_LOCAL_MANIFEST, "utf8");
  for (const crate of inventory.crates ?? []) {
    const version = cargoVersion(join(VENDOR, crate.name, "Cargo.toml"));
    if (crate.version !== version)
      problems.push(`${crate.name} version drifts from its Cargo.toml`);
    if (
      crate.name === "llama-cpp-2" &&
      !kbLocal.includes(`llama-cpp-2 = { version = "=${version}"`)
    )
      problems.push("kb-local does not pin the vendored llama-cpp-2 version exactly");
  }
  const listed = Object.fromEntries(
    (inventory.crates ?? []).flatMap((crate) =>
      Object.entries(crate.forkEdits ?? {}).map(([path, edit]) => [path, edit.reason]),
    ),
  );
  if (JSON.stringify(listed) !== JSON.stringify(FORK_EDITS))
    problems.push("inventory fork edits differ from the documented FORK_EDITS list");
  return problems;
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] });
  if (result.status !== 0) throw new Error(`${cmd} failed: ${result.stderr.trim()}`);
}

async function fetchBytes(url) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`fetch ${url}: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/** crates.io index checksum for an exact version (the same value Cargo verifies). */
async function cratesIoChecksum(name, version) {
  const prefix = `${name.slice(0, 2)}/${name.slice(2, 4)}`;
  const index = (await fetchBytes(`https://index.crates.io/${prefix}/${name}`)).toString("utf8");
  for (const line of index.split("\n").filter(Boolean)) {
    const entry = JSON.parse(line);
    if (entry.vers === version) return entry.cksum;
  }
  throw new Error(`${name} ${version} is not in the crates.io index`);
}

/** Derive the expected inventory from the pinned archives plus the current fork edits. */
export async function deriveInventory() {
  const pin = JSON.parse(readFileSync(RUNTIME_PIN, "utf8"));
  const scratch = mkdtempSync(join(tmpdir(), "kb-vendor-inventory-"));
  try {
    const files = {};
    const crates = [];
    for (const name of CRATES) {
      const version = cargoVersion(join(VENDOR, name, "Cargo.toml"));
      const archive = `https://static.crates.io/crates/${name}/${name}-${version}.crate`;
      const bytes = await fetchBytes(archive);
      const archiveSha256 = sha256(bytes);
      if (archiveSha256 !== (await cratesIoChecksum(name, version)))
        throw new Error(`${name} ${version} archive does not match the crates.io index`);
      const crateFile = join(scratch, `${name}.crate`);
      writeFileSync(crateFile, bytes);
      run("tar", ["-xzf", crateFile, "-C", scratch]);
      const upstreamDir = join(scratch, `${name}-${version}`);
      const revision = JSON.parse(readFileSync(join(upstreamDir, ".cargo_vcs_info.json"), "utf8"))
        .git.sha1;
      const forkEdits = {};
      for (const file of listFiles(upstreamDir)) {
        if (CRATE_REMOVED.some((p) => (p.endsWith("/") ? file.startsWith(p) : file === p)))
          continue;
        const path = `${name}/${file}`;
        const upstream = sha256(readFileSync(join(upstreamDir, file)));
        let vendored;
        try {
          vendored = sha256(readFileSync(join(VENDOR, path)));
        } catch {
          throw new Error(`upstream file missing from vendor without a removal rule: ${path}`);
        }
        if (vendored !== upstream) {
          if (!(path in FORK_EDITS)) throw new Error(`undocumented fork edit: ${path}`);
          forkEdits[path] = { reason: FORK_EDITS[path], upstreamSha256: upstream };
        } else if (path in FORK_EDITS)
          throw new Error(`documented fork edit no longer differs from upstream: ${path}`);
        files[path] = vendored;
      }
      const added = {};
      for (const license of ADDED_LICENSES) {
        const source = `https://raw.githubusercontent.com/utilityai/llama-cpp-rs/${revision}/${license}`;
        const digest = sha256(await fetchBytes(source));
        added[`${name}/${license}`] = { source, sha256: digest };
        files[`${name}/${license}`] = digest;
      }
      crates.push({
        name,
        version,
        archive,
        archiveSha256,
        bindingRevision: revision,
        removed: CRATE_REMOVED,
        added,
        forkEdits,
      });
    }
    const archiveBytes = await fetchBytes(pin.sourceUrl);
    if (sha256(archiveBytes) !== pin.sourceSha256)
      throw new Error("llama.cpp archive checksum mismatch");
    const archive = join(scratch, "llama.tar.gz");
    const source = join(scratch, "llama.cpp");
    writeFileSync(archive, archiveBytes);
    run("mkdir", ["-p", source]);
    run("tar", ["-xzf", archive, "--strip-components=1", "-C", source]);
    const omitted = [];
    for (const selected of LLAMA_SELECTION) {
      const [base, leaf] = selected.split("/**/");
      const full = join(source, base);
      const entries = lstatSync(full).isDirectory()
        ? listFiles(full)
            .filter((file) => leaf === undefined || matchesLeaf(file, leaf))
            .map((file) => `${base}/${file}`)
        : [selected];
      for (const file of entries) {
        const bytes = readFileSync(join(source, file));
        // Interpreter scripts (GPU/multimodal generators and tests) are not build inputs.
        if (bytes.subarray(0, 2).toString("latin1") === "#!") omitted.push(file);
        else files[`${LLAMA_ROOT}/${file}`] = sha256(bytes);
      }
    }
    return {
      llamaCpp: {
        release: pin.release,
        commit: pin.commit,
        archive: pin.sourceUrl,
        archiveSha256: pin.sourceSha256,
        root: LLAMA_ROOT,
        selection: LLAMA_SELECTION,
        omitted: omitted.sort(),
        forkEdits: {},
      },
      crates,
      files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1))),
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const serialize = (inventory) => `${JSON.stringify(inventory, null, 2)}\n`;
/** Format like every checked-in JSON file (biome), so the gate's lint stays clean. */
function formatWithBiome(path) {
  run(join(root, "node_modules/.bin/biome"), ["format", "--write", path]);
}

async function main(args) {
  if (!args.includes("--check")) {
    const inventory = await deriveInventory();
    writeFileSync(INVENTORY, serialize(inventory));
    formatWithBiome(INVENTORY);
    const problems = [...compareTree(VENDOR, inventory.files), ...pinProblems(inventory)];
    if (problems.length) throw new Error(`vendored tree differs:\n${problems.join("\n")}`);
    return;
  }
  const text = readFileSync(INVENTORY, "utf8");
  const inventory = JSON.parse(text);
  const problems = [...compareTree(VENDOR, inventory.files), ...pinProblems(inventory)];
  // Compare content, not layout: the checked-in file is biome-formatted.
  if (
    args.includes("--from-archives") &&
    serialize(await deriveInventory()) !== serialize(inventory)
  )
    problems.push("inventory.json is not the derivation of the pinned archives; regenerate it");
  if (problems.length)
    throw new Error(
      `CLI vendor inventory check failed:\n${problems.join("\n")}\n` +
        "Restore the vendored files, or run node scripts/sync-cli-vendor-inventory.mjs after a reviewed upgrade.",
    );
  console.log(`CLI vendor inventory OK — ${Object.keys(inventory.files).length} files match.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
