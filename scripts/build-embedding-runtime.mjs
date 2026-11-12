/** Reproducible CPU embedding build. No npm install, git clone, or runtime network. */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  cpSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pin = JSON.parse(
  readFileSync(join(root, "packages/api/src/lib/kb/fixtures/embedding-runtime.json"), "utf8"),
);
const cmakeOptions = {
  KB_EMBEDDING_RUNTIME: pin.sourceSha256,
};
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
/** Own each tool's process group until all writers have exited. */
export function createBuildSupervisor({
  signal,
  timeoutMs = 19 * 60_000,
  graceMs = 1000,
  // Daemon drain acknowledgement shares the build-only bound class (test-kb
  // passes BUILD_TIMEOUT_MS), never a fixed window or a test budget: under I/O
  // pressure a single `docker buildx history ls` took 7-25 s, and a slow but
  // healthy daemon must not be reported as an incomplete drain. Only a daemon
  // that cannot confirm within this hang guard fails closed and retains intent.
  drainTimeoutMs = timeoutMs ?? 19 * 60_000,
  inheritedFd,
  groupDirectory,
  cleanupDirectory,
} = {}) {
  if (
    (timeoutMs !== null && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) ||
    !Number.isFinite(graceMs) ||
    graceMs < 0 ||
    !Number.isFinite(drainTimeoutMs) ||
    drainTimeoutMs <= 0
  )
    throw new Error("invalid native build deadline");
  if (inheritedFd !== undefined && (!Number.isSafeInteger(inheritedFd) || inheritedFd < 3))
    throw new Error("invalid native build lease descriptor");
  // test-kb creates this registry before admission. Nested native/cache owners
  // register their detached groups too, so killing an intermediate owner cannot
  // strand its writers. Standalone native builders retain their existing scope.
  const project = process.env.KB_TEST_PROJECT;
  const inheritedGroups =
    project && /^[a-zA-Z0-9-]+$/.test(project)
      ? join(tmpdir(), `kb-test-builds-${project}`, "build-groups")
      : undefined;
  const registry =
    cleanupDirectory ??
    (groupDirectory === null
      ? undefined
      : (groupDirectory ??
        (inheritedGroups && existsSync(inheritedGroups) ? inheritedGroups : undefined)));
  const controller = new AbortController();
  const abort = () =>
    controller.abort(
      Object.assign(new Error("native build cancelled", { cause: signal?.reason }), {
        code: "ABORT_ERR",
      }),
    );
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const onSignal = () => controller.abort(new Error("native build cancelled"));
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  const deadline =
    timeoutMs === null
      ? undefined
      : setTimeout(
          () =>
            controller.abort(
              Object.assign(new Error("native build deadline exceeded"), { code: "ETIMEDOUT" }),
            ),
          timeoutMs,
        );
  deadline?.unref();
  const send = (pid, sig) => {
    try {
      process.kill(-pid, sig);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  const liveGroups = (groups) => {
    const live = new Set();
    const valid = new Map(groups);
    for (const [group, birth] of groups) {
      try {
        const stat = readFileSync(`/proc/${group}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        if (birth !== 0n && BigInt(fields[19]) !== birth) valid.delete(group);
      } catch (error) {
        if (!["ENOENT", "ESRCH"].includes(error.code)) throw error;
        // Linux retains a group PID while any member still belongs to it.
      }
    }
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        const group = Number(fields[2]);
        // Registration records the leader's kernel start time; a recycled
        // group number cannot authorize signalling an unrelated newer group.
        if (
          valid.has(group) &&
          BigInt(fields[19]) >= valid.get(group) &&
          !["Z", "X"].includes(fields[0])
        )
          live.add(group);
      } catch (error) {
        if (!["ENOENT", "ESRCH"].includes(error.code)) throw error;
      }
    }
    return live;
  };
  const drainDocker = async (name, cwd, env) => {
    const end = Date.now() + drainTimeoutMs;
    while (true) {
      const probe = createBuildSupervisor({
        timeoutMs: Math.max(1, end - Date.now()),
        graceMs: 100,
        groupDirectory: null,
        cleanupDirectory: registry,
      });
      let output;
      try {
        output = (
          await probe.run(
            "docker",
            ["buildx", "history", "ls", "--no-trunc", "--format", "json"],
            cwd,
            { env, capture: true, maxBuffer: 4 * 1024 * 1024 },
          )
        ).stdout;
      } finally {
        probe.close();
      }
      const records = output
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const record = records.find((row) => row.name === name);
      if (record?.completed_at && ["Completed", "Error", "Canceled"].includes(record.status))
        return;
      if (Date.now() >= end)
        throw new Error(`Docker build did not acknowledge daemon drain: ${name}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  let active = false;
  return {
    check: () => controller.signal.throwIfAborted(),
    async run(
      cmd,
      argv,
      cwd,
      { env = process.env, capture = false, maxBuffer = 64 * 1024 * 1024 } = {},
    ) {
      controller.signal.throwIfAborted();
      if (!cleanupDirectory && registry && existsSync(join(registry, "cancelled")))
        throw new Error("native build cancelled before admission");
      if (active) throw new Error("native build admission is serial");
      active = true;
      let child;
      let dockerName;
      let dockerRecord;
      const drainDaemons = async () => {
        const records = groupDirectory
          ? readdirSync(groupDirectory)
              .filter((name) => name.startsWith("docker-") && name.endsWith(".json"))
              .map((name) => [
                join(groupDirectory, name),
                JSON.parse(readFileSync(join(groupDirectory, name), "utf8")),
              ])
          : dockerName
            ? [[dockerRecord, { name: dockerName }]]
            : [];
        for (const [path, record] of records) {
          try {
            await drainDocker(record.name, cwd, env);
          } catch (cause) {
            throw Object.assign(
              new Error(
                `Docker daemon drain incomplete for ${record.name}; retained intent ${path ?? record.name}`,
                { cause },
              ),
              { drainIncomplete: true },
            );
          }
          if (path) rmSync(path, { force: true });
        }
      };
      let stdout = "";
      let stderr = "";
      const stdoutDecoder = new StringDecoder("utf8");
      const stderrDecoder = new StringDecoder("utf8");
      let bytes = 0;
      let outputError;
      const groups = new Map();
      let stopAt;
      let admissionClosed;
      let admissionError;
      let admissionDone = !groupDirectory;
      const termed = new Set();
      const killed = new Set();
      const refresh = () => {
        if (!groupDirectory) return;
        for (const name of readdirSync(groupDirectory)) {
          const match = /^(\d+)-(\d+)$/.exec(name);
          if (match) groups.set(Number(match[1]), BigInt(match[2]));
        }
      };
      const stop = () => {
        if (stopAt !== undefined) return;
        stopAt = Date.now();
        if (groupDirectory) {
          // The same flock protects registration+spawn and closing admission.
          // An intermediate owner may die, but no unregistered writer can pass
          // this barrier before cancellation scans and signals registered groups.
          const gate = spawn(
            "flock",
            [
              "--exclusive",
              join(groupDirectory, "admission.lock"),
              process.execPath,
              fileURLToPath(import.meta.url),
              "--close-build-admission",
              groupDirectory,
            ],
            { stdio: "ignore" },
          );
          admissionClosed = new Promise((resolve, reject) => {
            gate.once("error", reject);
            gate.once("close", (code) =>
              code === 0 ? resolve() : reject(new Error("build admission close failed")),
            );
          })
            .catch((error) => {
              admissionError = error;
            })
            .finally(() => {
              admissionDone = true;
            });
        }
      };
      controller.signal.addEventListener("abort", stop, { once: true });
      try {
        if (cmd === "docker" && argv[0] === "build") {
          dockerName = `kb-build-${randomUUID()}`;
          argv = [argv[0], "--build-arg", `BUILDKIT_BUILD_NAME=${dockerName}`, ...argv.slice(1)];
          // Durable intent precedes the client/RPC effect. The outer owner can
          // still wait for the daemon if a nested SSH prebuilder is force-killed.
          if (registry) {
            dockerRecord = join(registry, `docker-${dockerName}.json`);
            writeFileSync(dockerRecord, JSON.stringify({ name: dockerName }), { flag: "wx" });
          }
        }
        // The child-side launcher registers its own group under the admission
        // lock before spawning any tool. Ordinary standalone builds need no gate.
        const launch = registry
          ? [
              "flock",
              [
                "--no-fork",
                "--exclusive",
                join(registry, "admission.lock"),
                process.execPath,
                fileURLToPath(import.meta.url),
                "--admit-build-tool",
                registry,
                inheritedFd === undefined ? "no-lease" : "lease",
                cleanupDirectory ? "cleanup" : "build",
                cmd,
                ...argv,
              ],
            ]
          : [cmd, argv];
        child = spawn(launch[0], launch[1], {
          cwd,
          detached: true,
          stdio: [
            capture ? "ignore" : "inherit",
            capture ? "pipe" : "inherit",
            capture ? "pipe" : "inherit",
            ...(inheritedFd === undefined ? [] : [inheritedFd]),
          ],
          env: { ...env, CMAKE_BUILD_PARALLEL_LEVEL: "3" },
        });
        const exited = new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("exit", (code, sig) => resolve(sig ?? code));
        });
        // Attach before any asynchronous operation, including a failed spawn.
        let outcome;
        let spawnError;
        exited.then(
          (code) => {
            outcome = code;
          },
          (error) => {
            spawnError = error;
          },
        );
        if (child.pid) {
          let birth;
          try {
            const stat = readFileSync(`/proc/${child.pid}/stat`, "utf8");
            birth = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
          } catch (error) {
            if (!["ENOENT", "ESRCH"].includes(error.code)) throw error;
          }
          // Never authorize a recycled PID with an unknown (zero) birth.
          // Gated launchers register themselves before tool effects, even if
          // their parent misses this provisional sample after a quick exit.
          if (birth !== undefined) groups.set(child.pid, BigInt(birth));
          if (registry && birth !== undefined) {
            writeFileSync(join(registry, `${child.pid}-${birth}`), "", { flag: "w" });
            if (!cleanupDirectory && existsSync(join(registry, "cancelled")))
              controller.abort(new Error("native build cancelled during admission"));
          }
        }
        if (capture) {
          const collect = (which, chunk) => {
            bytes += chunk.length;
            if (bytes > maxBuffer) {
              outputError ??= Object.assign(
                new Error("native build output exceeded capture limit"),
                { code: "ENOBUFS" },
              );
              controller.abort(outputError);
              return;
            }
            if (which === "stdout") stdout += stdoutDecoder.write(chunk);
            else stderr += stderrDecoder.write(chunk);
          };
          child.stdout.on("data", (chunk) => collect("stdout", chunk));
          child.stderr.on("data", (chunk) => collect("stderr", chunk));
        }
        // Do not scan /proc while a healthy tool is working. Its exit or
        // cancellation starts the drain; registry entries already own nested
        // groups without polling compiler processes during compilation.
        if (!controller.signal.aborted) {
          let wake;
          const cancelled = new Promise((resolve) => {
            wake = resolve;
          });
          controller.signal.addEventListener("abort", wake, { once: true });
          try {
            await Promise.race([exited.catch(() => {}), cancelled]);
          } finally {
            controller.signal.removeEventListener("abort", wake);
          }
        }
        // Observe exit independently of inherited output pipes. A surviving
        // descendant can hold those pipes open even after its leader exits.
        while (true) {
          if (controller.signal.aborted || outcome !== undefined || spawnError) stop();
          if (admissionError) throw admissionError;
          refresh();
          const live = liveGroups(groups);
          if (stopAt !== undefined) {
            const sig = Date.now() - stopAt >= graceMs ? "SIGKILL" : "SIGTERM";
            const sent = sig === "SIGTERM" ? termed : killed;
            for (const pid of live) {
              if (sent.has(pid)) continue;
              send(pid, sig);
              sent.add(pid);
            }
          }
          if ((outcome !== undefined || spawnError) && live.size === 0 && admissionDone) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        // Pipes are closed only after the owned groups have drained.
        await new Promise((resolve) => {
          if (child.stdout?.closed !== false && child.stderr?.closed !== false) resolve();
          else child.once("close", resolve);
        });
        await drainDaemons();
        stdout += stdoutDecoder.end();
        stderr += stderrDecoder.end();
        if (spawnError) throw spawnError;
        if (outputError) throw outputError;
        controller.signal.throwIfAborted();
        if (outcome !== 0)
          throw Object.assign(new Error(`native build tool failed: ${cmd} (${outcome})`), {
            status: outcome,
          });
        return { stdout, stderr };
      } catch (error) {
        // Setup/read failures must also retain ownership until all groups drain.
        stop();
        await admissionClosed;
        refresh();
        let live = liveGroups(groups);
        const end = Date.now() + graceMs;
        while (live.size) {
          for (const pid of live) send(pid, Date.now() >= end ? "SIGKILL" : "SIGTERM");
          await new Promise((resolve) => setTimeout(resolve, 20));
          refresh();
          live = liveGroups(groups);
        }
        if (!error.drainIncomplete) await drainDaemons();
        error.stdout = stdout;
        error.stderr = stderr;
        if (dockerName) error.dockerBuildName = dockerName;
        throw error;
      } finally {
        controller.signal.removeEventListener("abort", stop);
        active = false;
      }
    },
    close() {
      controller.abort(new Error("native build supervisor closed"));
      clearTimeout(deadline);
      signal?.removeEventListener("abort", abort);
      process.off("SIGTERM", onSignal);
      process.off("SIGINT", onSignal);
    },
  };
}

export async function buildEmbeddingRuntime(args = process.argv.slice(2)) {
  const option = (name, fallback) =>
    args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
  const supervisor = createBuildSupervisor({
    timeoutMs: Number(option("--timeout-ms", 19 * 60_000)),
  });
  // The builder retains the inherited cache lease while collecting/installing
  // outputs. Tools write only unique scratch, and must not hand the lease to
  // persistent compiler-cache daemons such as sccache.
  try {
    const pkg = realpathSync(
      option("--package", join(root, "apps/worker/node_modules/node-llama-cpp")),
    );
    const output = resolve(option("--output", join(root, "apps/worker/native/build")));
    if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch))
      throw new Error("native linux x64/arm64 required");
    if (JSON.parse(readFileSync(join(pkg, "package.json"))).version !== pin.nodeLlamaCpp)
      throw new Error("binding version mismatch");

    const { getBuildFolderNameForBuildOptions } = await import(
      pathToFileURL(join(pkg, "dist/bindings/utils/getBuildFolderNameForBuildOptions.js"))
    );
    const { builtinLlamaCppRelease } = await import(
      pathToFileURL(join(pkg, "dist/bindings/utils/binariesGithubRelease.js"))
    );
    const { getPlatformInfo } = await import(
      pathToFileURL(join(pkg, "dist/bindings/utils/getPlatformInfo.js"))
    );
    // Match the loader's options; the build metadata below records the actual source release.
    const buildOptions = {
      platform: "linux",
      arch: process.arch,
      gpu: false,
      platformInfo: await getPlatformInfo(),
      llamaCpp: { repo: "ggml-org/llama.cpp", release: builtinLlamaCppRelease },
      customCmakeOptions: new Map(Object.entries(cmakeOptions)),
    };
    const { withCustomCmakeOptions: folderName } =
      await getBuildFolderNameForBuildOptions(buildOptions);
    const release = join(output, folderName, "Release");
    const receipt = join(release, "kb-runtime.json");
    function verifyCache() {
      if (!existsSync(receipt)) return false;
      const cached = JSON.parse(readFileSync(receipt));
      if (
        JSON.stringify(cached.runtime) !== JSON.stringify(pin) ||
        cached.arch !== process.arch ||
        cached.platform !== process.platform ||
        !cached.files?.["llama-addon.node"]
      )
        throw new Error("native cache provenance mismatch");
      for (const [name, digest] of Object.entries(cached.files)) {
        if (!/^[A-Za-z0-9_.-]+$/.test(name) || hash(readFileSync(join(release, name))) !== digest)
          throw new Error("native cache checksum mismatch");
      }
      return true;
    }
    if (!verifyCache()) {
      const scratch = mkdtempSync(join(tmpdir(), "kb-native-build-"));
      const run = (cmd, argv, cwd = scratch) => supervisor.run(cmd, argv, cwd);
      try {
        const archive = option("--archive", join(scratch, "source.tar.gz"));
        if (!args.includes("--archive"))
          await run("curl", [
            "--fail",
            "--location",
            "--proto",
            "=https",
            "--retry",
            "3",
            "--output",
            archive,
            pin.sourceUrl,
          ]);
        if (hash(readFileSync(archive)) !== pin.sourceSha256)
          throw new Error("native source checksum mismatch");
        const binding = join(scratch, "binding");
        const llama = join(binding, "llama");
        mkdirSync(llama, { recursive: true });
        for (const name of ["CMakeLists.txt", "addon", "cmake"])
          cpSync(join(pkg, "llama", name), join(llama, name), { recursive: true });
        symlinkSync(dirname(pkg), join(binding, "node_modules"), "dir");
        mkdirSync(join(llama, "llama.cpp"));
        await run("tar", ["-xzf", archive, "--strip-components=1", "-C", join(llama, "llama.cpp")]);
        // node-api-headers is already in the lockfile via cmake-js; don't download Node headers.
        const require = createRequire(join(pkg, "package.json"));
        // The pinned binding owns its compiler dependency closure. Resolve the
        // tool named by its build script rather than an undeclared root dependency.
        const bindingPackage = JSON.parse(readFileSync(join(pkg, "package.json")));
        const buildTool = bindingPackage.scripts["cmake-js-llama"].split(" ").at(-1);
        if (!bindingPackage.dependencies[buildTool]) throw new Error("binding build tool missing");
        const cmakeRequire = createRequire(require.resolve(buildTool));
        const headers = join(dirname(cmakeRequire.resolve("node-api-headers")), "include");
        const build = join(scratch, "build");
        await run("cmake", [
          "-S",
          llama,
          "-B",
          build,
          "-DCMAKE_BUILD_TYPE=Release",
          `-DCMAKE_JS_INC=${headers}`,
          "-DCMAKE_BUILD_RPATH_USE_ORIGIN=ON",
          "-DCMAKE_BUILD_WITH_INSTALL_RPATH=ON",
          "-DCMAKE_INSTALL_RPATH=$ORIGIN",
          "-DGGML_NATIVE=OFF",
          "-DGGML_CUDA=OFF",
          "-DGGML_VULKAN=OFF",
          "-DGGML_METAL=OFF",
          "-DGGML_BLAS=OFF",
          "-DGGML_OPENMP=ON",
          "-DLLAMA_CURL=OFF",
          "-DLLAMA_BUILD_TESTS=OFF",
          "-DLLAMA_BUILD_EXAMPLES=OFF",
          "-DLLAMA_BUILD_TOOLS=OFF",
          "-DLLAMA_BUILD_SERVER=OFF",
          "-DLLAMA_BUILD_MTMD=OFF",
        ]);
        await run("cmake", ["--build", build, "--target", "llama-addon", "--parallel", "3"]);
        supervisor.check();
        // No receipt means no published release. Discard interrupted outputs
        // (including pending receipt files) before collecting this build.
        rmSync(release, { recursive: true, force: true });
        mkdirSync(release, { recursive: true });
        const collect = (dir) => {
          for (const item of readdirSync(dir, { withFileTypes: true })) {
            const path = join(dir, item.name);
            if (item.isDirectory()) collect(path);
            else if (
              item.name === "llama-addon.node" ||
              /^lib(?:llama|ggml).*\.so(?:\..*)?$/.test(item.name)
            )
              cpSync(path, join(release, item.name), { dereference: true });
          }
        };
        collect(build);
        if (!existsSync(join(release, "llama-addon.node")))
          throw new Error("native addon output missing");
        const metadata = {
          buildOptions: {
            ...buildOptions,
            llamaCpp: { repo: "ggml-org/llama.cpp", release: pin.release },
            customCmakeOptions: cmakeOptions,
          },
        };
        writeFileSync(join(release, "_nlcBuildMetadata.json"), JSON.stringify(metadata));
        const files = Object.fromEntries(
          readdirSync(release)
            .filter((name) => name !== "kb-runtime.json")
            .map((name) => [name, hash(readFileSync(join(release, name)))]),
        );
        const pendingReceipt = `${receipt}.${process.pid}.tmp`;
        try {
          writeFileSync(
            pendingReceipt,
            JSON.stringify(
              { runtime: pin, platform: process.platform, arch: process.arch, files },
              null,
              2,
            ),
          );
          renameSync(pendingReceipt, receipt);
        } finally {
          rmSync(pendingReceipt, { force: true });
        }
        writeFileSync(join(output, folderName, "buildDone.status"), "");
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    }
    verifyCache();
    if (args.includes("--install")) {
      const dest = join(pkg, "llama/localBuilds", folderName);
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(join(output, folderName), dest, { recursive: true });
      writeFileSync(join(pkg, "llama/lastBuild.json"), JSON.stringify({ folderName }));
    }
    console.log(
      `EMBEDDING_NATIVE_BUILD ${JSON.stringify({ folderName, runtime: pin, arch: process.arch, cached: true })}`,
    );
  } finally {
    supervisor.close();
  }
}

/** Child-side admission under flock; no tool effects precede registration. */
async function admitBuildTool([directory, lease, purpose, cmd, ...argv]) {
  const lock = statSync(join(directory, "admission.lock"), { bigint: true });
  let descriptor;
  // util-linux flock --no-fork preserves its lock FD across exec. fd3 may
  // already carry the cache lease; match inode identity instead of assuming it.
  for (let fd = 3; fd < 16; fd++) {
    try {
      const candidate = fstatSync(fd, { bigint: true });
      if (candidate.dev === lock.dev && candidate.ino === lock.ino) descriptor = fd;
    } catch (error) {
      if (error.code !== "EBADF") throw error;
    }
  }
  if (descriptor === undefined) throw new Error("build admission requires its inherited flock");
  if (
    purpose === "cleanup" &&
    !(cmd === "docker" && argv[0] === "buildx" && argv[1] === "history" && argv[2] === "ls")
  )
    throw new Error("build cleanup admission only permits the daemon readback");
  if (purpose !== "cleanup" && existsSync(join(directory, "cancelled")))
    throw new Error("native build cancelled before tool admission");
  const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  if (Number(fields[2]) !== process.pid)
    throw new Error("build launcher requires its own process group");
  writeFileSync(join(directory, `${process.pid}-${fields[19]}`), "", { flag: "w" });
  // Keep the group leader alive through the tool exit; its owner handles TERM
  // and KILL for the whole group, including a TERM-resistant compiler leaf.
  const onSignal = () => {};
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  const child = spawn(cmd, argv, {
    stdio: lease === "lease" ? ["inherit", "inherit", "inherit", 3] : "inherit",
  });
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, sig) => resolve(sig ? 1 : code));
  });
  closeSync(descriptor); // tool admitted and registered; cancellation may proceed
  try {
    process.exitCode = await done;
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--admit-build-tool") await admitBuildTool(process.argv.slice(3));
  else if (process.argv[2] === "--close-build-admission")
    writeFileSync(join(process.argv[3], "cancelled"), "");
  else await buildEmbeddingRuntime();
}
