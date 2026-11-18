import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import {
  AGE_SHA256,
  AGE_VERSION,
  ageArch,
  ensureAge,
  isPinnedAgeDir,
  putPinnedAgeOnPath,
} from "./age-pin.mjs";

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

test("a pinned install published concurrently is kept, never removed under its users", async (t) => {
  const f = await fixture(t);
  const winner = async () => {
    // Another test process finishes its install while this one downloads.
    await mkdir(f.dir, { recursive: true });
    for (const bin of ["age", "age-keygen"]) {
      await writeFile(join(f.dir, bin), `#!/bin/sh\necho ${AGE_VERSION}\n`);
      await chmod(join(f.dir, bin), 0o755);
    }
    await writeFile(join(f.dir, "in-use"), "");
    return f.bytes;
  };
  assert.equal(
    await ensureAge({ dir: f.dir, arch: "amd64", sha256: f.sha256, download: winner }),
    f.dir,
  );
  assert.equal(existsSync(join(f.dir, "in-use")), true);
  assert.deepEqual(
    (await readdir(join(f.dir, ".."))).filter((name) => name.includes(".tmp-")),
    [],
  );
});

test("outside Linux only a host age reporting the pinned version is put on PATH", async (t) => {
  const f = await fixture(t);
  const pinned = join(f.root, "src", "age");
  const other = await fixture(t, "v1.2.1");
  const env = { PATH: [join(other.root, "src", "age"), pinned].join(delimiter) };
  assert.equal(await putPinnedAgeOnPath(env, "darwin"), pinned);
  assert.equal(env.PATH.split(delimiter)[0], pinned);
  statSync(join(pinned, "age"));
  await assert.rejects(
    putPinnedAgeOnPath({ PATH: join(other.root, "src", "age") }, "darwin"),
    /pinned archives are Linux-only/,
  );
});

test("replacing a stale install waits for a concurrent replacer and keeps its install", async (t) => {
  const f = await fixture(t);
  await mkdir(f.dir, { recursive: true });
  await writeFile(join(f.dir, "age"), "#!/bin/sh\necho v1.2.1\n");
  // Another process holds the replacement lock, then publishes a pinned install.
  await mkdir(`${f.dir}.lock`);
  const other = (async () => {
    await new Promise((done) => setTimeout(done, 300));
    await rm(f.dir, { recursive: true, force: true });
    await mkdir(f.dir);
    for (const bin of ["age", "age-keygen"]) {
      await writeFile(join(f.dir, bin), `#!/bin/sh\necho ${AGE_VERSION}\n`);
      await chmod(join(f.dir, bin), 0o755);
    }
    await writeFile(join(f.dir, "in-use"), "");
    await rm(`${f.dir}.lock`, { recursive: true });
  })();
  assert.equal(
    await ensureAge({ dir: f.dir, arch: "amd64", sha256: f.sha256, download: async () => f.bytes }),
    f.dir,
  );
  await other;
  assert.equal(existsSync(join(f.dir, "in-use")), true);
  assert.equal(existsSync(`${f.dir}.lock`), false);
  await assert.rejects(
    (async () => {
      await writeFile(join(f.dir, "age"), "#!/bin/sh\necho v1.2.1\n");
      await mkdir(`${f.dir}.lock`);
      await ensureAge({
        dir: f.dir,
        arch: "amd64",
        sha256: f.sha256,
        download: async () => f.bytes,
        lockWaitMs: 200,
      });
    })(),
    /\.lock is held; remove it if no install is running/,
  );
});
