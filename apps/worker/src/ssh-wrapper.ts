import { spawn } from "node:child_process";
import { writeSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
  drainMirrorGroup,
  encodeMirrorReply,
  fixedSshArgs,
  MIRROR_REPLY_FD,
  type MirrorReply,
  processIdentity,
  writeMirrorMarker,
} from "./lib/mirror-ssh";

type Config = {
  dir: string;
  repo: string;
  key: string;
  knownHosts: string;
  host: string;
  port: number;
  path: string;
  url: string;
  address: string;
  sha: string;
  activate: boolean;
  wrapper: string;
  timeoutMs: number;
};
const configPath = process.argv[3]!;
const c: Config = JSON.parse(await readFile(configPath, "utf8"));
const safeEnv = {
  PATH: "/usr/local/bin:/usr/bin:/bin",
  HOME: c.dir,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_SSH_VARIANT: "ssh",
};
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
if (process.argv[2] === "--ssh") {
  const command = process.argv.at(-1)!;
  if (!["git-upload-pack", "git-receive-pack"].some((bin) => command === `${bin} '${c.path}'`))
    process.exit(128);
  const ssh = spawn("/usr/bin/ssh", fixedSshArgs({ ...c, command }), {
    env: safeEnv,
    stdio: "inherit",
  });
  ssh.once("error", () => process.exit(128));
  ssh.once("close", (code) => process.exit(code ?? 128));
} else if (process.argv[2] === "--git") {
  // The group cannot reach the network until its supervisor persists ownership.
  // Losing the supervisor pipe also kills this entire group independently.
  process.stdin.on("end", () => {
    process.kill(-process.pid, "SIGKILL");
  });
  process.stdin.once("data", () => {
    const git = spawn("/usr/bin/git", process.argv.slice(4), {
      cwd: c.repo,
      env: {
        ...safeEnv,
        GIT_SSH_COMMAND: `${quote(process.execPath)} ${quote(c.wrapper)} --ssh ${quote(configPath)}`,
      },
      stdio: ["ignore", "inherit", "ignore"],
    });
    git.once("error", () => process.exit(128));
    git.once("close", (code) => process.exit(code ?? 128));
  });
  process.stdin.resume();
} else if (process.argv[2] === "--run") {
  let pgid: number | undefined,
    stopped = false,
    dispatchedPush = false;
  const stop = () => {
    stopped = true;
    if (pgid) {
      try {
        process.kill(-pgid, "SIGKILL");
      } catch {}
    }
  };
  process.stdin.resume();
  process.stdin.on("end", stop);
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  // The parent records this helper's identity before permitting any group spawn.
  // Install stop before awaiting GO so a following EOF cannot be missed.
  const admitted = await new Promise<boolean>((resolve) => {
    process.stdin.once("data", (bytes: Buffer) => resolve(bytes.toString() === "GO"));
    process.stdin.once("end", () => resolve(false));
    process.stdin.resume();
  });
  if (!admitted || stopped) process.exit(128);
  const timer = setTimeout(stop, c.timeoutMs);
  async function git(args: string[]) {
    if (stopped) throw new Error("stopped");
    const result = await new Promise<{ code: number | null; text: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [c.wrapper, "--git", configPath, ...args], {
        cwd: c.repo,
        detached: true,
        env: safeEnv,
        stdio: ["pipe", "pipe", "ignore"],
      });
      pgid = child.pid;
      const dispatch = (async () => {
        if (!pgid) throw new Error("Missing group");
        const identity = await processIdentity(pgid);
        if (!identity) throw new Error("Group exited before dispatch");
        await writeMirrorMarker(`${c.dir}/group`, `${pgid} ${identity}`);
        if (stopped) stop();
        else child.stdin.write("GO");
      })();
      void dispatch.catch(() => {
        stop();
        reject(new Error("Group ownership unavailable"));
      });
      child.stdin.on("error", stop);
      let text = "";
      child.stdout.on("data", (b: Buffer) => {
        text += b.toString();
        if (text.length > 65536) stop();
      });
      child.once("error", reject);
      child.once("close", async (code) => {
        await dispatch.catch(() => {});
        resolve({ code, text });
      });
    });
    if (pgid) {
      try {
        process.kill(-pgid, "SIGKILL");
      } catch {}
      await drainMirrorGroup(pgid);
      pgid = undefined;
    }
    return result;
  }
  let result: MirrorReply = { state: "UNKNOWN", resultCode: "INTERRUPTED" };
  try {
    if (!/^[0-9a-f]{40}$/.test(c.sha)) throw new Error("invalid sha");
    const remote = await git(["ls-remote", "--refs", c.url, "refs/heads/main"]);
    if (remote.code !== 0) result = { state: "FAILED", resultCode: "SSH_REJECTED" };
    else if (!c.activate && remote.text.trim() === `${c.sha}\trefs/heads/main`)
      result = { state: "COMPLETED", resultCode: "RECONCILED" };
    else {
      dispatchedPush = !c.activate;
      const pushed = await git([
        "push",
        "--porcelain",
        ...(c.activate ? ["--dry-run"] : []),
        c.url,
        `${c.sha}:refs/heads/main`,
      ]);
      const rejected =
        c.activate ||
        /^!\t[^\t]+:refs\/heads\/main\t\[(?:rejected|remote rejected)\]/m.test(pushed.text);
      result =
        pushed.code === 0
          ? { state: "COMPLETED", resultCode: c.activate ? "VERIFIED" : "PUSHED" }
          : // An aggregate Git exit code also covers lost acknowledgements
            // after acceptance. Only an explicit per-ref rejection proves
            // that this single-ref push did not update remote main.
            rejected
            ? { state: "FAILED", resultCode: "PUSH_REJECTED" }
            : { state: "UNKNOWN", resultCode: "REMOTE_OUTCOME_UNKNOWN" };
    }
    if (stopped) result = { state: "UNKNOWN", resultCode: "REMOTE_OUTCOME_UNKNOWN" };
  } catch {
    result =
      dispatchedPush || stopped
        ? { state: "UNKNOWN", resultCode: "TRANSPORT_UNAVAILABLE" }
        : { state: "FAILED", resultCode: "TRANSPORT_UNAVAILABLE" };
  } finally {
    clearTimeout(timer);
    stop();
    if (pgid) await drainMirrorGroup(pgid);
    // Only the parent/recovery path removes scratch after joining this helper
    // and independently checking its persisted group. A lost helper reply is
    // not permission to discard ownership evidence.
  }
  // The reply is protocol data on the parent's dedicated descriptor. This
  // helper has no log channel and never logs.
  try {
    writeSync(MIRROR_REPLY_FD, encodeMirrorReply(result));
  } catch {
    process.exit(128);
  }
  process.exit(0);
} else process.exit(128);
