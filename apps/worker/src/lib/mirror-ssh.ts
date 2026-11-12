import { spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  statfs,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type DeployKeySeed,
  parseApprovedHostKeys,
  renderOpenSshPrivateKey,
} from "@knowledge-base/api/lib/kb/deploy-key";
import { assertResolvedAddressesSafe } from "@knowledge-base/api/lib/kb/egress";
import { hardenedGitEnv, runGitAsync } from "@knowledge-base/api/lib/kb/git-read";
import { parseMirrorSshUrl } from "@knowledge-base/api/lib/kb/ssh-url";

export const MIRROR_TMPFS = "/run/kb-mirror";
export type MirrorOutcome = { state: "COMPLETED" | "FAILED" | "UNKNOWN"; resultCode: string };

/** The helper's reply is protocol data on its own descriptor, never a log record. */
export const MIRROR_REPLY_FD = 3;
const MIRROR_REPLY_MAX_BYTES = 256;
const MIRROR_REPLIES = {
  COMPLETED: ["RECONCILED", "VERIFIED", "PUSHED"],
  FAILED: ["SSH_REJECTED", "PUSH_REJECTED", "TRANSPORT_UNAVAILABLE"],
  UNKNOWN: ["INTERRUPTED", "REMOTE_OUTCOME_UNKNOWN", "TRANSPORT_UNAVAILABLE"],
} as const;
type MirrorReplies = typeof MIRROR_REPLIES;
export type MirrorReply = {
  [S in keyof MirrorReplies]: { state: S; resultCode: MirrorReplies[S][number] };
}[keyof MirrorReplies];

/** One fixed frame: `<state> <resultCode>\n`. */
export function encodeMirrorReply(reply: MirrorReply): string {
  return `${reply.state} ${reply.resultCode}\n`;
}
/** Accept exactly one closed-set frame; anything else (including no reply) is a lost helper. */
export function parseMirrorReply(bytes: Buffer): MirrorReply | undefined {
  if (bytes.length > MIRROR_REPLY_MAX_BYTES) return undefined;
  const match = /^([A-Z]+) ([A-Z_]+)\n$/.exec(bytes.toString("latin1"));
  if (!match) return undefined;
  const state = match[1]!;
  if (!Object.hasOwn(MIRROR_REPLIES, state)) return undefined;
  const codes: readonly string[] = MIRROR_REPLIES[state as keyof MirrorReplies];
  return codes.includes(match[2]!) ? ({ state, resultCode: match[2] } as MirrorReply) : undefined;
}
export type MirrorTransportInput = {
  attemptId: string;
  canonicalRepo: string;
  url: string;
  hostKeys: string[];
  seed: DeployKeySeed;
  sha: string;
  activate: boolean;
  signal: AbortSignal;
};
type SshConfig = {
  address: string;
  port: number;
  host: string;
  key: string;
  knownHosts: string;
  command: string;
};
export function fixedSshArgs(c: SshConfig): string[] {
  return [
    "-F",
    "/dev/null",
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `HostKeyAlias=${c.host}`,
    "-o",
    `Hostname=${c.address}`,
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "IdentityAgent=none",
    "-o",
    "ForwardAgent=no",
    "-o",
    "ForwardX11=no",
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "ProxyCommand=none",
    "-o",
    "ProxyJump=none",
    "-o",
    "PermitLocalCommand=no",
    "-o",
    "CanonicalizeHostname=no",
    "-o",
    "UpdateHostKeys=no",
    "-o",
    "GlobalKnownHostsFile=/dev/null",
    "-o",
    `UserKnownHostsFile=${c.knownHosts}`,
    "-o",
    "PasswordAuthentication=no",
    "-o",
    "KbdInteractiveAuthentication=no",
    "-o",
    "ConnectTimeout=10",
    "-i",
    c.key,
    "-p",
    String(c.port),
    "git@" + c.host,
    c.command,
  ];
}
async function privateTmpfs(root: string) {
  const info = await lstat(root);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0 ||
    (await realpath(root)) !== resolve(root) ||
    (await statfs(root)).type !== 0x01021994
  )
    throw new Error("Mirror keys require a private UID-owned tmpfs");
}
/**
 * Runtime admission: mirror keys live only on a private, UID-owned tmpfs. The
 * worker mounts the one data volume read-write (no read-only canonical mount).
 */
export async function assertMirrorStorage(root: string) {
  await privateTmpfs(root);
}
export async function prepareMirrorScratch(
  root: string,
  canonical: string,
  seed: DeployKeySeed,
  hostKeys: string[],
  host: string,
  attemptId = "test",
) {
  await privateTmpfs(root);
  if (!/^[a-zA-Z0-9-]+$/.test(attemptId) || /[\r\n]/.test(canonical))
    throw new Error("Invalid scratch identity");
  const dir = await mkdtemp(join(root, `${attemptId}-`));
  const close = async () => {
    try {
      // This local close is only used before helper dispatch. Preparation's Git
      // child has joined, so interrupted cleanup may retain the same drain proof.
      const drained = `${dir}.drained`;
      try {
        await rename(dir, drained);
      } catch (cause) {
        if (!isAbsent(cause)) throw cause;
      }
      await rm(drained, { recursive: true, force: true });
    } catch (cause) {
      throw new MirrorDrainError("Mirror scratch cleanup unconfirmed", { cause });
    }
  };
  const key = join(dir, "key"),
    repo = join(dir, "repo.git"),
    knownHosts = join(dir, "hosts");
  const bytes = renderOpenSshPrivateKey(seed);
  try {
    // The helper and network group each wait for GO. Their identities replace
    // these explicit pre-dispatch markers atomically before either receives GO.
    await writeMirrorMarker(join(dir, "owner"), "PREPARED");
    await writeMirrorMarker(join(dir, "group"), "NOT_STARTED");
    await writeFile(key, bytes, { mode: 0o600, flag: "wx" });
    await writeFile(
      knownHosts,
      parseApprovedHostKeys(hostKeys)
        .map((k) => `${host} ${k.key}\n`)
        .join(""),
      { mode: 0o600, flag: "wx" },
    );
    await mkdir(repo, { mode: 0o700 });
    await runGitAsync(repo, ["init", "--bare", "--template="]);
    await writeFile(join(repo, "objects/info/alternates"), `${canonical}/objects\n`);
    return { dir, key, repo, knownHosts, close };
  } catch (error) {
    await close();
    throw error;
  } finally {
    bytes.fill(0);
  }
}
export class MirrorDrainError extends Error {}

function isAbsent(error: unknown) {
  return (
    error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ESRCH")
  );
}

/** A partially written ownership marker must never resemble pre-dispatch. */
export async function writeMirrorMarker(path: string, marker: string) {
  await writeFile(`${path}.pending`, marker, { mode: 0o600, flag: "wx" });
  await rename(`${path}.pending`, path);
}

async function processStat(pid: number) {
  try {
    for (let observation = 0; ; observation++) {
      const raw = await readFile(`/proc/${pid}/stat`, "utf8");
      const end = raw.lastIndexOf(") ");
      const fields = raw
        .slice(end + 2)
        .trim()
        .split(" ");
      if (
        raw.startsWith(`${pid} (`) &&
        end >= 0 &&
        /^[A-Za-z]$/.test(fields[0] ?? "") &&
        /^\d+$/.test(fields[2] ?? "") &&
        /^\d+$/.test(fields[19] ?? "")
      )
        return { state: fields[0], group: fields[2], identity: fields[19]! };
      // Task teardown can transiently render an invalid group (e.g. X/-1).
      // Invalid bytes prove neither identity nor absence: re-observe at most
      // twice, accepting only a new validated record or ENOENT/ESRCH below.
      if (observation === 2) throw new MirrorDrainError("Invalid mirror process observation");
      await new Promise((r) => setTimeout(r, 5));
    }
  } catch (cause) {
    if (isAbsent(cause)) return null; // A disappearing /proc entry is authoritative.
    throw new MirrorDrainError("Mirror process observation unavailable", { cause });
  }
}
export async function processIdentity(pid: number): Promise<string | null> {
  const info = await processStat(pid);
  return !info || info.state === "Z" ? null : info.identity;
}

function signalMirrorProcess(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(pid, signal);
  } catch (cause) {
    if (!isAbsent(cause))
      throw new MirrorDrainError("Mirror process termination unavailable", { cause });
  }
}

export async function drainMirrorGroup(id: number) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    let alive = false;
    let entries: string[];
    try {
      entries = await readdir("/proc");
    } catch (cause) {
      throw new MirrorDrainError("Mirror process inventory unavailable", { cause });
    }
    for (const pid of entries) {
      if (!/^\d+$/.test(pid)) continue;
      const info = await processStat(Number(pid));
      if (info?.group === String(id) && info.state !== "Z") alive = true;
    }
    if (!alive) return;
    signalMirrorProcess(-id, "SIGKILL");
    if (Date.now() > deadline) throw new MirrorDrainError("Mirror group did not drain");
    await new Promise((r) => setTimeout(r, 20));
  }
}
/** Called under the KB execution lock before recovering a durable RESERVED row.
 * The helper observes parent pipe EOF and drains independently on worker death.
 * Same-container restarts additionally join/terminate its persisted identity.
 * Container restarts remove both the process namespace and its private tmpfs. */
export async function recoverMirrorScratch(attemptId: string, root = MIRROR_TMPFS) {
  try {
    await privateTmpfs(root);
    for (const name of await readdir(root)) {
      if (!name.startsWith(`${attemptId}-`)) continue;
      const dir = join(root, name);
      await privateTmpfs(dir);
      // Only the KB-lease owner renames a positively drained scratch. A partial
      // recursive removal can discard markers, so preserve that proof in the
      // directory name until deletion completes. This is not an execution lock.
      if (name.endsWith(".drained")) {
        await rm(dir, { recursive: true, force: true });
        continue;
      }
      // A crash immediately after mkdtemp cannot leave key material or children.
      if ((await readdir(dir)).length === 0) {
        await rm(dir, { recursive: true });
        continue;
      }
      const owner = await readFile(join(dir, "owner"), "utf8");
      // Validate both markers before terminating anything. A failed observation
      // retains all evidence and the durable RESERVED fence for a later recovery.
      const initialGroup = await readFile(join(dir, "group"), "utf8");
      if (owner !== "PREPARED") parseProcessMarker(owner);
      if (initialGroup !== "NOT_STARTED") {
        if (owner === "PREPARED") throw new MirrorDrainError("Invalid mirror dispatch state");
        parseProcessMarker(initialGroup);
      }
      if (owner !== "PREPARED") {
        const { pid, identity } = parseProcessMarker(owner);
        if ((await processIdentity(pid)) === identity) {
          signalMirrorProcess(pid, "SIGTERM");
          const deadline = Date.now() + 10_000;
          while ((await processIdentity(pid)) === identity) {
            if (Date.now() > deadline) throw new MirrorDrainError("Mirror helper did not drain");
            await new Promise((r) => setTimeout(r, 25));
          }
        }
      }
      // Re-read only after joining the helper: it can no longer publish a group
      // or send GO while recovery is inspecting the network ownership marker.
      const group = await readFile(join(dir, "group"), "utf8");
      if (group !== "NOT_STARTED") {
        if (owner === "PREPARED") throw new MirrorDrainError("Invalid mirror dispatch state");
        const { pid, identity } = parseProcessMarker(group);
        const current = await processIdentity(pid);
        if (current && current !== identity)
          throw new MirrorDrainError("Mirror group identity changed");
        await drainMirrorGroup(pid);
      }
      const drained = `${dir}.drained`;
      await rename(dir, drained);
      await rm(drained, { recursive: true, force: true });
    }
  } catch (cause) {
    if (cause instanceof MirrorDrainError) throw cause;
    throw new MirrorDrainError("Mirror scratch drain unconfirmed", { cause });
  }
}

function parseProcessMarker(marker: string) {
  if (!/^[1-9]\d* (0|[1-9]\d*)$/.test(marker))
    throw new MirrorDrainError("Invalid mirror ownership marker");
  const [rawPid, identity] = marker.split(" ");
  const pid = Number(rawPid);
  if (!Number.isSafeInteger(pid) || pid <= 1)
    throw new MirrorDrainError("Invalid mirror process identity");
  return { pid, identity: identity! };
}
export async function runMirrorSsh(
  input: MirrorTransportInput,
  options: {
    root?: string;
    wrapperPath?: string;
    timeoutMs?: number;
    resolveAddress?: (host: string) => Promise<string>;
  } = {},
): Promise<MirrorOutcome> {
  const remote = parseMirrorSshUrl(input.url);
  const resolution = (async () => {
    if (options.resolveAddress) return options.resolveAddress(remote.host);
    const addresses = await lookup(remote.host, { all: true, verbatim: true });
    assertResolvedAddressesSafe(addresses);
    return addresses[0]!.address;
  })();
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(10_000)]);
  const address = await new Promise<string>((resolveAddress, reject) => {
    const abort = () => reject(new Error("Mirror DNS cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void resolution
      .then(resolveAddress, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
  input.signal.throwIfAborted();
  const scratch = await prepareMirrorScratch(
    options.root ?? MIRROR_TMPFS,
    input.canonicalRepo,
    input.seed,
    input.hostKeys,
    remote.host,
    input.attemptId,
  );
  const wrapper =
    options.wrapperPath ?? fileURLToPath(new URL("./ssh-wrapper.mjs", import.meta.url));
  try {
    const config = join(scratch.dir, "config.json");
    await writeFile(
      config,
      JSON.stringify({
        ...scratch,
        close: undefined,
        ...remote,
        address,
        sha: input.sha,
        activate: input.activate,
        wrapper,
        timeoutMs: options.timeoutMs ?? 20_000,
      }),
      { mode: 0o600 },
    );
    input.signal.throwIfAborted();
    return await new Promise<MirrorOutcome>((resolveResult, reject) => {
      // stdout/stderr are not read: the reply has its own bounded descriptor.
      const child = spawn(process.execPath, [wrapper, "--run", config], {
        env: hardenedGitEnv({ HOME: scratch.dir }),
        stdio: ["pipe", "ignore", "ignore", "pipe"],
      });
      const stdin = child.stdin!;
      const abort = () => stdin.end(); // helper owns kill + group drain
      input.signal.addEventListener("abort", abort, { once: true });
      if (input.signal.aborted) abort();
      let reply = Buffer.alloc(0);
      const replies = child.stdio[MIRROR_REPLY_FD] as NodeJS.ReadableStream;
      replies.on("data", (chunk: Buffer) => {
        if (reply.length <= MIRROR_REPLY_MAX_BYTES) reply = Buffer.concat([reply, chunk]);
      });
      child.once("error", reject);
      stdin.on("error", abort);
      const dispatch = (async () => {
        if (!child.pid) throw new Error("Missing mirror helper");
        const identity = await processIdentity(child.pid);
        if (!identity) throw new Error("Mirror helper exited before dispatch");
        await writeMirrorMarker(join(scratch.dir, "owner"), `${child.pid} ${identity}`);
        if (input.signal.aborted) abort();
        else stdin.write("GO");
      })();
      void dispatch.catch(abort);
      child.once("close", async () => {
        // A failed/late ownership write must settle before scratch recovery.
        await dispatch.catch(() => {});
        input.signal.removeEventListener("abort", abort);
        resolveResult(parseMirrorReply(reply) ?? { state: "UNKNOWN", resultCode: "HELPER_LOST" });
      });
    });
  } finally {
    // Even a helper crash must not let an orphan group keep using an unlinked key.
    await recoverMirrorScratch(input.attemptId, options.root ?? MIRROR_TMPFS);
  }
}
