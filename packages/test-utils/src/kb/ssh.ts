import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { readdirSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createBuildSupervisor } from "../../../../scripts/build-embedding-runtime.mjs";
import { dockerFixtureLabels, removeDockerContainer, withDockerContainer } from "./docker.js";
import { NODE_BASE_IMAGE } from "./node-image.mjs";

const exec = promisify(execFile);
const fixtureUid = process.getuid?.() ?? 1000;
const dockerfile = `FROM ${NODE_BASE_IMAGE}
RUN apt-get update -qq && apt-get install -y --no-install-recommends git openssh-server && rm -rf /var/lib/apt/lists/*
ARG FIXTURE_UID=1000
RUN usermod -u "$FIXTURE_UID" -l git node && passwd -d git && mkdir -p /run/sshd /o/r.git && chown git:node /o/r.git && runuser -u git -- git init --bare /o/r.git
CMD ["/usr/sbin/sshd", "-D", "-e", "-f", "/fixture/sshd_config"]
`;
// Content + UID address the standalone image; runner projects own disposable tags.
const imageIdentity = createHash("sha256")
  .update(`${dockerfile}\n${fixtureUid}`)
  .digest("hex")
  .slice(0, 16);
const IMAGE = `kb-mirror-ssh-fixture:${(process.env.KB_TEST_PROJECT === "standalone" ? undefined : process.env.KB_TEST_PROJECT) ?? imageIdentity}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
export function snapshotRepo(repo: string): Record<string, string> {
  const out: Record<string, string> = {};
  function walk(dir: string, prefix: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const key = prefix + entry.name,
        path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, `${key}/`);
      else out[key] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  }
  walk(repo, "");
  return out;
}
async function imagePresent(): Promise<boolean> {
  try {
    await exec("docker", ["image", "inspect", IMAGE], { timeout: 10_000 });
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "stderr" in error &&
      typeof error.stderr === "string" &&
      /No such image:/i.test(error.stderr)
    )
      return false;
    throw new Error(
      `SSH fixture image inspect failed for ${IMAGE} (code=${String(Reflect.get(Object(error), "code"))} signal=${String(Reflect.get(Object(error), "signal"))} killed=${String(Reflect.get(Object(error), "killed"))}): ${String(Reflect.get(Object(error), "stderr") ?? "")}`,
      { cause: error },
    );
  }
}

/** Image-only prerequisite: no keys, containers or network fixture are started. */
async function prebuildImage(): Promise<void> {
  if (await imagePresent()) return;
  const dir = await mkdtemp("/dev/shm/kb-ssh-build-");
  const supervisor = createBuildSupervisor({ timeoutMs: 30 * 60 * 1000 });
  try {
    await writeFile(join(dir, "Dockerfile"), dockerfile);
    // Keep the SSH account aligned with the owner of the private bind
    // mount (GitHub uses uid 1001; the Node image defaults to uid 1000).
    await supervisor.run(
      "docker",
      ["build", "--quiet", "--build-arg", `FIXTURE_UID=${fixtureUid}`, "-t", IMAGE, dir],
      dir,
    );
  } finally {
    supervisor.close();
    await rm(dir, { recursive: true, force: true });
  }
}

/** Real isolated OpenSSH server. Every key is generated for this test and kept
 * in tmpfs. Only the selected fixture hostname resolves to loopback in tests. */
export async function createSshFixture() {
  const name = `kb-ssh-${randomUUID()}`;
  const dir = await mkdtemp("/dev/shm/kb-ssh-"),
    root = join(dir, "keys");
  let containerRequested = false;
  async function close() {
    if (containerRequested) await removeDockerContainer(name);
    await rm(dir, { recursive: true, force: true });
  }
  try {
    await mkdir(root, { mode: 0o700 });
    await exec("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(dir, "host")]);
    await writeFile(join(dir, "authorized_keys"), "", { mode: 0o600 });
    await writeFile(join(dir, "mode"), "normal");
    await writeFile(
      join(dir, "sshd_config"),
      `Port 2222\nListenAddress 0.0.0.0\nHostKey /fixture/host\nPidFile /fixture/sshd.pid\nAuthorizedKeysFile /fixture/authorized_keys\nStrictModes no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nAllowUsers git\nAllowTcpForwarding no\nPermitTTY no\nForceCommand /bin/sh /fixture/serve\n`,
    );
    await writeFile(
      join(dir, "serve"),
      `#!/bin/sh
set -eu
touch /fixture/connected
while [ "$(cat /fixture/mode)" = pause ]; do sleep 0.05; done
case "$SSH_ORIGINAL_COMMAND" in
  "git-upload-pack '/o/r.git'") exec git-upload-pack /o/r.git ;;
  "git-receive-pack '/o/r.git'") echo push >> /fixture/pushes; exec git-receive-pack /o/r.git ;;
  *) exit 1 ;;
esac
`,
    );
    await writeFile(
      join(dir, "post-receive"),
      `#!/bin/sh
touch /fixture/accepted
if [ "$(cat /fixture/mode)" = accepted-eof ]; then kill -KILL "$PPID"; fi
while [ "$(cat /fixture/mode)" = lost-reply ]; do sleep 0.05; done
`,
    );
    await chmod(join(dir, "post-receive"), 0o755);
    // Record dispatch before awaiting Docker: a lost reply may still have
    // created a container. Earlier setup failures own only the directory.
    containerRequested = true;
    await exec("docker", [
      "run",
      "-d",
      // The prerequisite already checked/built this tag. Let container creation
      // resolve it atomically instead of adding a timed metadata probe under load.
      "--pull=never",
      "--name",
      name,
      ...dockerFixtureLabels(),
      "--cpus=1",
      "--memory=256m",
      "-p",
      "127.0.0.1::2222",
      "-v",
      `${dir}:/fixture`,
      IMAGE,
    ]);
    await exec("docker", [
      "exec",
      name,
      "sh",
      "-c",
      "cp /fixture/post-receive /o/r.git/hooks/post-receive && chmod 755 /o/r.git/hooks/post-receive",
    ]);
    const port = (await exec("docker", ["port", name, "2222/tcp"])).stdout
      .trim()
      .split(":")
      .at(-1)!;
    const hostKey = (await readFile(join(dir, "host.pub"), "utf8"))
      .trim()
      .split(" ")
      .slice(0, 2)
      .join(" ");
    // sshd starts before Docker announces the binding; readiness is bounded.
    for (let i = 0; i < 100; i++) {
      if (await readFile(join(dir, "sshd.pid"), "utf8").catch(() => "")) break;
      if (i === 99) throw new Error("Fixture sshd failed readiness");
      await wait(20);
    }
    return {
      name,
      directory: dir,
      url: `ssh://git@mirror.example.invalid:${port}/o/r.git`,
      hostKey,
      options: {
        root,
        wrapperPath: resolve(import.meta.dirname, "../../../../apps/worker/dist/ssh-wrapper.mjs"),
        resolveAddress: async (host: string) => {
          if (host !== "mirror.example.invalid") throw new Error("Unexpected host");
          return "127.0.0.1";
        },
      },
      async startCrashablePush(input: {
        attemptId: string;
        canonicalRepo: string;
        sha: string;
        seed: string;
      }) {
        const repo = resolve(import.meta.dirname, "../../../..");
        const program = `import { runMirrorSsh } from ${JSON.stringify(join(repo, "apps/worker/src/lib/mirror-ssh.ts"))};
          import { DeployKeySeed } from ${JSON.stringify(join(repo, "packages/api/src/lib/kb/deploy-key.ts"))};
          let raw = ""; for await (const chunk of process.stdin) raw += chunk;
          const c = JSON.parse(raw); const seed = DeployKeySeed.take(Buffer.from(c.seed,"base64"));
          process.stdout.write("ready\\n");
          await runMirrorSsh({...c, seed, signal: new AbortController().signal}, {...c.options, resolveAddress: async () => "127.0.0.1"});`;
        const child = spawn(
          process.execPath,
          ["--import", "tsx", "--input-type=module", "-e", program],
          { cwd: repo, stdio: ["pipe", "pipe", "ignore"] },
        );
        child.stdin.end(
          JSON.stringify({
            ...input,
            url: `ssh://git@mirror.example.invalid:${port}/o/r.git`,
            hostKeys: [hostKey],
            activate: false,
            options: { root, wrapperPath: join(repo, "apps/worker/dist/ssh-wrapper.mjs") },
          }),
        );
        const done = new Promise<void>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", () => resolve());
        });
        try {
          await Promise.race([
            once(child.stdout, "data", { signal: AbortSignal.timeout(20_000) }),
            done.then(() => {
              throw new Error("Crashable push exited before readiness");
            }),
          ]);
        } catch (error) {
          child.kill("SIGKILL");
          await done;
          throw error;
        }
        return async () => {
          child.kill("SIGKILL");
          await done;
        };
      },
      authorize: (keys: string[]) =>
        writeFile(join(dir, "authorized_keys"), `${keys.join("\n")}\n`, { mode: 0o600 }),
      async mode(mode: "normal" | "pause" | "lost-reply" | "accepted-eof") {
        await rm(join(dir, "connected"), { force: true });
        await rm(join(dir, "accepted"), { force: true });
        await writeFile(join(dir, "mode"), mode);
      },
      async waitConnected(signal: AbortSignal) {
        while (!signal.aborted) {
          if (
            await readFile(join(dir, "connected"))
              .then(() => true)
              .catch(() => false)
          )
            return;
          await wait(10);
        }
        signal.throwIfAborted();
      },
      async waitAccepted() {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          if (
            await readFile(join(dir, "accepted"))
              .then(() => true)
              .catch(() => false)
          )
            return;
          await wait(10);
        }
        throw new Error("Remote did not accept the SSH push");
      },
      async mainSha() {
        return (
          (
            await exec("docker", [
              "exec",
              "-u",
              "git",
              name,
              "git",
              "--git-dir=/o/r.git",
              "rev-parse",
              "refs/heads/main",
            ]).catch(() => ({ stdout: "" }))
          ).stdout.trim() || null
        );
      },
      async pushCount() {
        return (await readFile(join(dir, "pushes"), "utf8").catch(() => ""))
          .split("\n")
          .filter(Boolean).length;
      },
      keysRemaining: () => readdir(root),
      async diverge() {
        await exec("docker", [
          "exec",
          "-u",
          "git",
          name,
          "sh",
          "-c",
          'tree=$(git --git-dir=/o/r.git hash-object -t tree -w --stdin </dev/null); sha=$(git -c user.name=fixture -c user.email=fixture@example.invalid --git-dir=/o/r.git commit-tree "$tree" -m divergent); git --git-dir=/o/r.git update-ref refs/heads/main "$sha"',
        ]);
      },
      async assertReadonly(repo: string) {
        const name = `kb-ssh-readonly-${randomUUID()}`;
        return withDockerContainer(name, () =>
          execFileSync(
            "docker",
            [
              "run",
              "--pull=never",
              "--name",
              name,
              ...dockerFixtureLabels(),
              "--rm",
              "--network=none",
              "--user",
              String(fixtureUid),
              "--mount",
              `type=bind,src=${repo},dst=/canonical,readonly`,
              IMAGE,
              "sh",
              "-c",
              "if touch /canonical/forbidden 2>/dev/null; then exit 1; fi; test -r /canonical/config",
            ],
            { timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] },
          ),
        );
      },
      close,
    };
  } catch (error) {
    const setupError = /No such image:/i.test(String(Reflect.get(Object(error), "stderr") ?? ""))
      ? new Error(
          "Missing prebuilt SSH fixture image; run via pnpm test:kb, which prebuilds it. For a standalone run, prebuild with: pnpm test:kb --build-only mirror",
          { cause: error },
        )
      : error;
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([setupError, cleanupError], "SSH fixture setup and cleanup failed");
    }
    throw setupError;
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (process.argv[2] !== "--prebuild-image")
    throw new Error("Usage: ssh.ts --prebuild-image (or pnpm test:kb --build-only mirror)");
  await prebuildImage();
}
