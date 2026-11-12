/**
 * dev-docker teardown must never delete the per-project KB_MASTER_KEY while
 * the stack's data can survive it. Runs the real wrappers from a scratch copy
 * of their layout, with CONTAINER_RUNTIME pointing at a stub `docker`.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Stub runtime: `compose version` works; `compose ... down` exits FAKE_DOWN_EXIT;
// `volume ls` prints FAKE_VOLUMES; every call is appended to FAKE_LOG.
const STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_LOG"
case "$*" in
  "compose version") exit 0 ;;
  compose*" down "*) exit "\${FAKE_DOWN_EXIT:-0}" ;;
  volume\\ ls*) [ -n "\${FAKE_VOLUMES:-}" ] && printf '%s\\n' $FAKE_VOLUMES; exit 0 ;;
  *) exit 0 ;;
esac
`;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "kb-dev-docker-"));
  mkdirSync(join(dir, "repo/scripts/lib"), { recursive: true });
  for (const file of [
    "dev-docker.sh",
    "dev-docker-down.sh",
    "lib/dev-docker-runtime.sh",
    "lib/dev-toolchain-check.sh",
  ])
    copyFileSync(join(ROOT, "scripts", file), join(dir, "repo/scripts", file));
  writeFileSync(join(dir, "repo/docker-compose.agent.yml"), "services: {}\n");
  const stub = join(dir, "docker");
  writeFileSync(stub, STUB);
  chmodSync(stub, 0o755);
  const log = join(dir, "calls.log");
  writeFileSync(log, "");
  const port = String(20000 + Math.floor(Math.random() * 20000));
  const run = (script, args, env = {}) =>
    spawnSync("bash", [join(dir, "repo/scripts", script), ...args], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, CONTAINER_RUNTIME: stub, FAKE_LOG: log, ...env },
    });
  // A first start generates and persists the project's key.
  const started = run("dev-docker.sh", [port]);
  assert.equal(started.status, 0, started.stderr);
  const volumes = join(dir, "repo/.docker-volumes");
  const [project] = existsSync(volumes) ? readdirSync(volumes) : [];
  const keyFile = join(volumes, project, "kb-master-key");
  assert.ok(existsSync(keyFile), "first start persisted no KB_MASTER_KEY");
  writeFileSync(log, "");
  return {
    port,
    run,
    keyFile,
    key: () => readFileSync(keyFile, "utf8"),
    calls: () => readFileSync(log, "utf8"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

for (const [script, args] of [
  ["dev-docker-down.sh", []],
  ["dev-docker.sh", ["--reset"]],
]) {
  test(`${script} keeps the key when compose teardown fails`, () => {
    const f = fixture();
    try {
      const key = f.key();
      const result = f.run(script, [f.port, ...args], { FAKE_DOWN_EXIT: "1" });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /failed; kept .*KB_MASTER_KEY/s);
      assert.equal(f.key(), key);
      assert.doesNotMatch(f.calls(), / up --build/, "the stack started after a failed teardown");
    } finally {
      f.cleanup();
    }
  });

  test(`${script} keeps the key when a project volume survives teardown`, () => {
    const f = fixture();
    try {
      const key = f.key();
      const result = f.run(script, [f.port, ...args], { FAKE_VOLUMES: "proj_kb-data" });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /survived teardown: proj_kb-data/);
      assert.equal(f.key(), key);
    } finally {
      f.cleanup();
    }
  });
}

test("a confirmed teardown removes the key; --reset then starts with a new one", () => {
  const f = fixture();
  try {
    const key = f.key();
    const reset = f.run("dev-docker.sh", [f.port, "--reset"]);
    assert.equal(reset.status, 0, reset.stderr);
    assert.notEqual(f.key(), key, "--reset kept the old key after wiping the data");
    const down = f.run("dev-docker-down.sh", [f.port]);
    assert.equal(down.status, 0, down.stderr);
    assert.equal(existsSync(f.keyFile), false);
  } finally {
    f.cleanup();
  }
});

function workspaceFixture(compose) {
  const dir = mkdtempSync(join(tmpdir(), "kb-dev-docker-ws-"));
  mkdirSync(join(dir, "repo/scripts/lib"), { recursive: true });
  for (const file of [
    "dev-docker.sh",
    "dev-docker-down.sh",
    "lib/dev-docker-runtime.sh",
    "lib/dev-toolchain-check.sh",
  ])
    copyFileSync(join(ROOT, "scripts", file), join(dir, "repo/scripts", file));
  // A dependency-free package: `pnpm install` creates no node_modules for it.
  mkdirSync(join(dir, "repo/packages/config"), { recursive: true });
  writeFileSync(join(dir, "repo/packages/config/package.json"), "{}\n");
  writeFileSync(join(dir, "repo/docker-compose.agent.yml"), compose);
  const stub = join(dir, "docker");
  writeFileSync(stub, STUB);
  chmodSync(stub, 0o755);
  const log = join(dir, "calls.log");
  writeFileSync(log, "");
  const result = spawnSync(
    "bash",
    [join(dir, "repo/scripts/dev-docker.sh"), String(20000 + Math.floor(Math.random() * 20000))],
    { encoding: "utf8", env: { PATH: process.env.PATH, CONTAINER_RUNTIME: stub, FAKE_LOG: log } },
  );
  return { dir, result, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// biome-ignore lint/suspicious/noTemplateCurlyInString: a literal Compose interpolation, not a JS template.
const MOUNT = "${AGENT_VOLUME_ROOT}/nm_packages_config:/app/packages/config/node_modules";

test("pre-creates every package's mountpoint so the read-only worker mount succeeds", () => {
  const f = workspaceFixture(`services: {}\n# - ${MOUNT}\n# - ${MOUNT}:ro\n`);
  try {
    assert.equal(f.result.status, 0, f.result.stderr);
    assert.ok(existsSync(join(f.dir, "repo/packages/config/node_modules")));
  } finally {
    f.cleanup();
  }
});

test("the rot guard also requires each package's read-only worker-dev mount", () => {
  const f = workspaceFixture(`services: {}\n# - ${MOUNT}\n`);
  try {
    assert.notEqual(f.result.status, 0);
    assert.match(f.result.stderr, /packages\/config\(worker-dev :ro\)/);
  } finally {
    f.cleanup();
  }
});

/**
 * A fake toolchain tree. It cannot be root-owned on the host, so the check is
 * told the expected owner (TOOLCHAIN_UID/GID) and to stop the ancestor walk at
 * /tmp; everything else is the same rule the image is held to.
 */
function toolchainFixture() {
  const dir = mkdtempSync(join("/tmp", "kb-dev-toolchain-"));
  const pnpmHome = join(dir, "pnpm");
  const corepack = join(dir, "corepack");
  const wrapper = join(corepack, "v1/pnpm/1.2.3");
  // npm's global Corepack install, separate from COREPACK_HOME's pnpm cache.
  const dist = join(dir, "node/lib/node_modules/corepack/dist");
  for (const d of [
    pnpmHome,
    join(pnpmHome, "store"),
    join(wrapper, "dist"),
    join(dist, "lib"),
    join(dir, "home"),
  ])
    mkdirSync(d, { recursive: true });
  writeFileSync(join(wrapper, "pnpm-native"), "#!/bin/sh\necho 1.2.3\n");
  writeFileSync(join(wrapper, "dist/pnpm.mjs"), "");
  writeFileSync(join(dist, "lib/corepack.cjs"), "");
  // The fake pnpm the usability probe must run (not a host pnpm): it leaves a marker.
  writeFileSync(join(dist, "pnpm.js"), '#!/bin/sh\ntouch "$HOME/fake-pnpm-ran"\necho 1.2.3\n', {
    mode: 0o755,
  });
  symlinkSync(join(dist, "pnpm.js"), join(pnpmHome, "pnpm"));
  writeFileSync(join(dist, "pnpx.js"), "");
  symlinkSync("../node/lib/node_modules/corepack/dist/pnpx.js", join(pnpmHome, "pnpx"));
  // The node the shims run, on PATH after $PNPM_HOME as in the image.
  const nodeBin = join(dir, "bin");
  mkdirSync(nodeBin);
  writeFileSync(join(nodeBin, "node"), "#!/bin/sh\n", { mode: 0o755 });
  for (const path of [dir, pnpmHome, corepack, join(dir, "node"), nodeBin])
    spawnSync("chmod", ["-R", "go-w", path]);
  chmodSync(join(pnpmHome, "store"), 0o777);
  chmodSync(join(dir, "home"), 0o777);
  const run = (mode = "immutability", env = {}) =>
    spawnSync("sh", [join(ROOT, "scripts/lib/dev-toolchain-check.sh"), mode], {
      encoding: "utf8",
      env: {
        PATH: `${pnpmHome}:${nodeBin}:/usr/bin:/bin`,
        PNPM_HOME: pnpmHome,
        COREPACK_HOME: corepack,
        HOME: join(dir, "home"),
        TOOLCHAIN_UID: String(process.getuid()),
        TOOLCHAIN_GID: String(process.getgid()),
        TOOLCHAIN_ANCESTOR_STOP: "/tmp",
        ...env,
      },
    });
  const cleanup = () => {
    spawnSync("chmod", ["-R", "u+w", dir]);
    rmSync(dir, { recursive: true, force: true });
  };
  return {
    dir,
    home: join(dir, "home"),
    pnpmHome,
    corepack,
    wrapper,
    dist,
    nodeBin,
    run,
    cleanup,
  };
}

const NOT_IMMUTABLE = /not immutable/;
test("toolchain immutability: real files, owner and no group/other write bit", () => {
  const f = toolchainFixture();
  try {
    const clean = f.run();
    assert.equal(clean.status, 0, clean.stderr);
    const usable = f.run("usability", { PATH: `${f.pnpmHome}:/usr/bin:/bin` });
    assert.equal(usable.status, 0, usable.stderr);
    assert.ok(existsSync(join(f.home, "fake-pnpm-ran")), "usability did not run the fixture pnpm");
    // Group-writable (the runtime's gid) and other-writable files, a nested
    // wrapper file, the resolved shim target, the home itself, an ancestor.
    for (const [target, mode] of [
      [join(f.wrapper, "pnpm-native"), 0o775],
      [join(f.wrapper, "pnpm-native"), 0o757],
      [join(f.wrapper, "dist/pnpm.mjs"), 0o666],
      [join(f.dist, "pnpm.js"), 0o775],
      [join(f.dist, "lib/corepack.cjs"), 0o666],
      [dirname(f.dist), 0o775],
      [f.pnpmHome, 0o775],
      [f.dir, 0o757],
    ]) {
      const before = statSync(target).mode & 0o777;
      chmodSync(target, mode);
      const result = f.run();
      assert.notEqual(result.status, 0, `${target} ${mode.toString(8)}`);
      assert.match(result.stderr, NOT_IMMUTABLE);
      chmodSync(target, before);
    }
    // A foreign owner: expect a uid that differs from the fixture's.
    const foreign = String(process.getuid() === 0 ? 1 : 0);
    assert.notEqual(f.run("immutability", { TOOLCHAIN_UID: foreign }).status, 0);
    // Fail closed: an unreadable directory holding a writable executable
    // (as root the directory is readable and the bits fail instead).
    const hidden = join(f.wrapper, "dist/node-gyp-bin");
    chmodSync(join(f.wrapper, "dist"), 0o755);
    mkdirSync(hidden);
    writeFileSync(join(hidden, "node-gyp"), "", { mode: 0o777 });
    chmodSync(join(hidden, "node-gyp"), 0o777);
    chmodSync(hidden, 0o311);
    const unreadable = f.run();
    assert.notEqual(unreadable.status, 0);
    assert.match(unreadable.stderr, NOT_IMMUTABLE);
    chmodSync(hidden, 0o755);
    rmSync(hidden, { recursive: true });
    chmodSync(join(f.wrapper, "dist"), 0o555);
    assert.equal(f.run().status, 0);
    // What a lint miss like `/bin/chmod -R a+rwX "$PNPM_HOME"` leaves behind.
    spawnSync("chmod", ["-R", "a+rwX", f.pnpmHome]);
    assert.notEqual(f.run().status, 0);
  } finally {
    f.cleanup();
  }
});

test("toolchain immutability covers the node the shims run and the PATH before it", () => {
  const f = toolchainFixture();
  try {
    assert.equal(f.run().status, 0, f.run().stderr);
    // The node binary and its directory: group/other writable.
    for (const [target, mode] of [
      [join(f.nodeBin, "node"), 0o775],
      [join(f.nodeBin, "node"), 0o757],
      [f.nodeBin, 0o775],
    ]) {
      const before = statSync(target).mode & 0o777;
      chmodSync(target, mode);
      const result = f.run();
      assert.notEqual(result.status, 0, `${target} ${mode.toString(8)}`);
      assert.match(result.stderr, NOT_IMMUTABLE);
      chmodSync(target, before);
    }
    // A writable PATH directory searched before node could shadow it.
    const shadow = join(f.dir, "shadow");
    mkdirSync(shadow);
    chmodSync(shadow, 0o777);
    const shadowed = f.run("immutability", {
      PATH: `${f.pnpmHome}:${shadow}:${f.nodeBin}:/usr/bin:/bin`,
    });
    assert.notEqual(shadowed.status, 0);
    assert.match(shadowed.stderr, /shadow \(mode 777/);
    // ...but a directory after node is outside the toolchain.
    const after = f.run("immutability", {
      PATH: `${f.pnpmHome}:${f.nodeBin}:${shadow}:/usr/bin:/bin`,
    });
    assert.equal(after.status, 0, after.stderr);
    // A missing PATH directory is judged by its parent; an empty entry is the cwd.
    assert.equal(
      f.run("immutability", { PATH: `${f.pnpmHome}:${f.dir}/absent:${f.nodeBin}:/usr/bin:/bin` })
        .status,
      0,
    );
    assert.match(
      f.run("immutability", { PATH: `${f.pnpmHome}::${f.nodeBin}:/usr/bin:/bin` }).stderr,
      /empty entry/,
    );
    // PATH components stay literal: a writable `safe dir` is not the safe `safe/dir`,
    // and glob characters never expand to some other, compliant directory.
    for (const name of ["safe dir", "safe\tdir", "sa*", "s?fe", "[s]afe", "safe$HOME"]) {
      const odd = join(f.dir, name);
      mkdirSync(odd);
      chmodSync(odd, 0o777);
      mkdirSync(join(f.dir, "safe", "dir"), { recursive: true });
      const result = f.run("immutability", {
        PATH: `${f.pnpmHome}:${odd}:${f.nodeBin}:/usr/bin:/bin`,
      });
      assert.notEqual(result.status, 0, name);
      assert.match(result.stderr, /unsupported character in a toolchain path/, name);
      rmSync(odd, { recursive: true });
    }
    // A symlinked node is indirection.
    chmodSync(f.nodeBin, 0o755);
    renameSync(join(f.nodeBin, "node"), join(f.dir, "real-node"));
    symlinkSync(join(f.dir, "real-node"), join(f.nodeBin, "node"));
    assert.match(f.run().stderr, /bin\/node \(symlink in a toolchain path\)/);
  } finally {
    f.cleanup();
  }
});

test("toolchain immutability: no indirection beyond pnpm's own shims", () => {
  const f = toolchainFixture();
  try {
    // An intermediate symlink chain: COREPACK_HOME -> hop/link -> real tree.
    const real = join(f.dir, "real");
    renameSync(f.corepack, real);
    mkdirSync(join(f.dir, "hop"));
    symlinkSync(real, join(f.dir, "hop/link"));
    symlinkSync(join(f.dir, "hop/link"), f.corepack);
    const chain = f.run();
    assert.notEqual(chain.status, 0);
    assert.match(chain.stderr, /symlink in a toolchain path/);
    rmSync(f.corepack);
    renameSync(real, f.corepack);
    assert.equal(f.run().status, 0);
    // A nested link inside the tree.
    chmodSync(join(f.wrapper, "dist"), 0o755);
    symlinkSync("/tmp", join(f.wrapper, "dist/cache"));
    const nested = f.run();
    assert.notEqual(nested.status, 0);
    assert.match(nested.stderr, /dist\/cache \(symlink inside the toolchain\)/);
    rmSync(join(f.wrapper, "dist/cache"));
    // A `..` through a symlinked hop must not be normalized away: a compliant
    // copy sits at the lexical path while the real target is elsewhere.
    const elsewhere = join(f.dir, "elsewhere");
    mkdirSync(join(elsewhere, "corepack/dist"), { recursive: true });
    copyFileSync(join(f.dist, "pnpm.js"), join(elsewhere, "corepack/dist/pnpm.js"));
    chmodSync(join(f.dir, "node"), 0o755);
    mkdirSync(join(elsewhere, "x"));
    symlinkSync(join(elsewhere, "x"), join(f.dir, "node/lib/node_modules/hop"));
    chmodSync(f.pnpmHome, 0o755);
    rmSync(join(f.pnpmHome, "pnpm"));
    // A literal string: path.join would normalize the `..` away itself.
    symlinkSync(
      `${f.dir}/node/lib/node_modules/hop/../corepack/dist/pnpm.js`,
      join(f.pnpmHome, "pnpm"),
    );
    const dotdot = f.run();
    assert.notEqual(dotdot.status, 0);
    assert.match(dotdot.stderr, /node\/lib\/node_modules\/hop \(symlink in a toolchain path\)/);
    rmSync(join(f.pnpmHome, "pnpm"));
    rmSync(join(f.dir, "node/lib/node_modules/hop"));
    symlinkSync(join(f.dist, "pnpm.js"), join(f.pnpmHome, "pnpm"));
    // A shim that is not one of pnpm's (e.g. corepack's yarn).
    symlinkSync(join(f.dist, "pnpm.js"), join(f.pnpmHome, "yarn"));
    assert.match(f.run().stderr, /pnpm\/yarn \(symlink inside the toolchain\)/);
  } finally {
    f.cleanup();
  }
});

test("a root caller runs both probes as root (the immutability rule is identity-independent)", () => {
  const dir = mkdtempSync(join(tmpdir(), "kb-dev-docker-root-"));
  try {
    mkdirSync(join(dir, "repo/scripts/lib"), { recursive: true });
    for (const file of [
      "dev-docker.sh",
      "dev-docker-down.sh",
      "lib/dev-docker-runtime.sh",
      "lib/dev-toolchain-check.sh",
    ])
      copyFileSync(join(ROOT, "scripts", file), join(dir, "repo/scripts", file));
    writeFileSync(join(dir, "repo/docker-compose.agent.yml"), "services: {}\n");
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "id"), "#!/bin/sh\necho 0\n");
    chmodSync(join(bin, "id"), 0o755);
    const stub = join(dir, "docker");
    writeFileSync(stub, STUB);
    chmodSync(stub, 0o755);
    const log = join(dir, "calls.log");
    writeFileSync(log, "");
    const result = spawnSync(
      "bash",
      [join(dir, "repo/scripts/dev-docker.sh"), String(20000 + Math.floor(Math.random() * 20000))],
      {
        encoding: "utf8",
        env: { PATH: `${bin}:${process.env.PATH}`, CONTAINER_RUNTIME: stub, FAKE_LOG: log },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const calls = readFileSync(log, "utf8");
    assert.match(calls, /run --rm -i --network none --user 0:0 .* -s usability/);
    assert.match(calls, /run --rm -i --network none --user 0:0 .* -s immutability/);
    assert.doesNotMatch(calls, /4242/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
