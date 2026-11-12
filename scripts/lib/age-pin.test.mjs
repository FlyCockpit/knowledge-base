import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AGE_SHA256, AGE_VERSION, ageArch, ensureAge, isPinnedAgeDir } from "./age-pin.mjs";

// Local fixture archive shaped like the official release (age/age, age/age-keygen).
async function fixture(t, version = AGE_VERSION) {
  const root = await mkdtemp(join(tmpdir(), "kb-age-pin-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const src = join(root, "src", "age");
  await mkdir(src, { recursive: true });
  for (const bin of ["age", "age-keygen"]) {
    await writeFile(join(src, bin), `#!/bin/sh\necho ${version}\n`);
    await chmod(join(src, bin), 0o755);
  }
  const archive = join(root, "age.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", join(root, "src"), "age"]);
  const bytes = await readFile(archive);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  // Records every extraction so a test can prove tar never ran.
  const marker = join(root, "tar-ran");
  const tarBin = join(root, "tar-spy");
  await writeFile(tarBin, `#!/bin/sh\ntouch '${marker}'\nexec tar "$@"\n`);
  await chmod(tarBin, 0o755);
  return { root, bytes, sha256, marker, tarBin, dir: join(root, "cache", "age") };
}

test("pins exactly the approved v1.3.2 linux amd64/arm64 archives", () => {
  assert.equal(AGE_VERSION, "v1.3.2");
  assert.deepEqual(Object.keys(AGE_SHA256).sort(), ["amd64", "arm64"]);
  for (const hash of Object.values(AGE_SHA256)) assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(ageArch("x64"), "amd64");
  assert.equal(ageArch("arm64"), "arm64");
  assert.throws(() => ageArch("s390x"), /unsupported architecture "s390x"/);
});

test("a checksum mismatch is refused before anything is extracted", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    ensureAge({
      dir: f.dir,
      arch: "amd64",
      sha256: "0".repeat(64),
      tarBin: f.tarBin,
      download: async () => f.bytes,
    }),
    /checksum mismatch.*not extracted/,
  );
  assert.equal(existsSync(f.marker), false, "tar must not run on unverified bytes");
  assert.equal(existsSync(f.dir), false);
  // The staging dir is removed: only the (empty) parent remains.
  assert.deepEqual(await readdir(join(f.root, "cache")), []);
});

test("installs atomically, then reuses the cached binary without downloading", async (t) => {
  const f = await fixture(t);
  let downloads = 0;
  const options = {
    dir: f.dir,
    arch: "arm64",
    sha256: f.sha256,
    tarBin: f.tarBin,
    download: async () => {
      downloads += 1;
      return f.bytes;
    },
  };
  assert.equal(await ensureAge(options), f.dir);
  assert.equal(downloads, 1);
  assert.equal(isPinnedAgeDir(f.dir), true);
  assert.deepEqual(await readdir(join(f.root, "cache")), ["age"]);
  await rm(f.marker);
  assert.equal(
    await ensureAge({ ...options, download: async () => assert.fail("no download") }),
    f.dir,
  );
  assert.equal(existsSync(f.marker), false);
});

test("a cached binary reporting another version is replaced, and a wrong archive is rejected", async (t) => {
  const f = await fixture(t);
  await mkdir(f.dir, { recursive: true });
  for (const bin of ["age", "age-keygen"]) {
    await writeFile(join(f.dir, bin), "#!/bin/sh\necho v1.2.1\n");
    await chmod(join(f.dir, bin), 0o755);
  }
  assert.equal(isPinnedAgeDir(f.dir), false);
  assert.equal(
    await ensureAge({ dir: f.dir, arch: "amd64", sha256: f.sha256, download: async () => f.bytes }),
    f.dir,
  );
  assert.equal(isPinnedAgeDir(f.dir), true);

  const other = await fixture(t, "v9.9.9");
  await assert.rejects(
    ensureAge({
      dir: other.dir,
      arch: "amd64",
      sha256: other.sha256,
      download: async () => other.bytes,
    }),
    /age and age-keygen v1\.3\.2 not found/,
  );
  assert.equal(existsSync(other.dir), false);
});
