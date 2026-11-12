import { randomUUID } from "node:crypto";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { type FileHandle, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { gitBinary, hardenedGitEnv } from "@knowledge-base/api/lib/kb/git-read";
import { PUSH_HOOKS_PATH } from "./git-pre-receive";
import {
  closeAdmission,
  DRAIN_MS,
  drainMutatingChild,
  ProcessFenceError,
  spawnMutatingChild,
  waitMutatingChild,
} from "./kb-process";

const FRAME = 256 * 1024;
const unavailable = () => new Error("GIT_TRANSPORT_UNAVAILABLE");
/** No user input becomes an executable, config key, query or environment name. */
export function gitCgiEnvironment(input: {
  reposDir: string;
  kbId: string;
  userId: string;
  method: "GET" | "POST";
  discovery: boolean;
  length: number;
  protocol: string | null;
  refs: string[];
  receive?: boolean;
}): Record<string, string> {
  if (
    // Same grammar as the protocol's kbIdSchema: generated ids may begin with a digit.
    !/^[a-z0-9]{24,32}$/.test(input.kbId) ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(input.userId) ||
    (input.protocol !== null && !/^version=[012]$/.test(input.protocol)) ||
    !Number.isSafeInteger(input.length) ||
    input.length < 0
  )
    throw unavailable();
  const config: [string, string][] = [
    ["core.hooksPath", input.receive ? PUSH_HOOKS_PATH : "/dev/null"],
    ["credential.helper", ""],
    ["gc.auto", "0"],
    ["maintenance.auto", "false"],
    ["http.receivepack", input.receive ? "true" : "false"],
    ["http.uploadpack", "true"],
    ["receive.denyNonFastForwards", "true"],
    ["receive.denyDeletes", "true"],
    ["receive.fsckObjects", "true"],
    ["receive.maxInputSize", String(50 * 1024 * 1024)],
    ["receive.autogc", "false"],
    ["core.fsync", "all"],
    ["core.fsyncMethod", "fsync"],
    ["receive.hideRefs", "refs"],
    ["uploadpack.allowAnySHA1InWant", "false"],
    ["uploadpack.allowTipSHA1InWant", "false"],
    ["uploadpack.allowReachableSHA1InWant", "false"],
    ["uploadpack.allowRefInWant", "false"],
    ["uploadpack.hideRefs", "refs"],
  ];
  for (const ref of input.refs) {
    if (
      !/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9_./-]{0,190}$/.test(ref) ||
      ref.includes("..") ||
      ref.includes("//") ||
      ref.endsWith("/") ||
      ref
        .split("/")
        .some((part) => part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock"))
    )
      throw unavailable();
    // Only the running service reads its hideRefs; the other key would only spend frame bytes.
    config.push([input.receive ? "receive.hideRefs" : "uploadpack.hideRefs", `!${ref}`]);
  }
  const service = input.receive ? "git-receive-pack" : "git-upload-pack";
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(
    // The receive hook is `#!/usr/bin/env node`: resolve `node` to this server's own
    // interpreter (nvm or /usr/local/bin in the image), never an ambient PATH entry.
    hardenedGitEnv({ PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: "/nonexistent" }),
  ))
    if (value !== undefined) env[key] = value;
  Object.assign(env, {
    GIT_PROJECT_ROOT: input.reposDir,
    GIT_HTTP_EXPORT_ALL: "1",
    REQUEST_METHOD: input.method,
    QUERY_STRING: input.discovery ? `service=${service}` : "",
    CONTENT_TYPE: input.discovery ? "" : `application/x-${service}-request`,
    CONTENT_LENGTH: String(input.length),
    REMOTE_USER: input.userId,
    PATH_INFO: `/kb_${input.kbId}.git/${input.discovery ? "info/refs" : service}`,
    GIT_CONFIG_COUNT: String(config.length),
  });
  config.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  // Never forward Git-Protocol: protocol v2 `fetch` serves any object named by SHA and
  // ignores uploadpack.allow*SHA1InWant, so a hidden commit (tag, replace, unowned branch)
  // would be fetchable by id. Without HTTP_GIT_PROTOCOL the backend speaks v0, which
  // enforces the advertised-tips-only rule configured above.
  // The native spawn frame is bounded at 64 KiB (argv, cwd and env together); the entry
  // count is bounded only by those bytes. Too many retained refs fail closed here.
  if (JSON.stringify(env).length > 48000) throw unavailable();
  return env;
}
export function parseCgiHead(bytes: Buffer) {
  const crlf = bytes.indexOf("\r\n\r\n");
  const lf = bytes.indexOf("\n\n");
  const end = crlf >= 0 ? crlf : lf;
  if (end < 0) {
    if (bytes.length > 16384) throw unavailable();
    return null;
  }
  if (end > 16384) throw unavailable();
  const raw = bytes.subarray(0, end).toString("latin1");
  if (/[^\x20-\x7e\r\n]/.test(raw)) throw unavailable();
  let status = 200;
  const headers = new Headers();
  const seen = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    const match = /^([A-Za-z-]+):[ ]*(.+)$/.exec(line);
    if (!match) throw unavailable();
    const name = match[1]!.toLowerCase();
    const value = match[2]!;
    if (seen.has(name)) throw unavailable();
    seen.add(name);
    if (name === "status") {
      if (!/^[245][0-9]{2} [\x20-\x7e]+$/.test(value)) throw unavailable();
      status = Number(value.slice(0, 3));
    } else if (["content-type", "expires", "date", "pragma", "cache-control"].includes(name))
      headers.set(name, value);
    else throw unavailable();
  }
  if (!headers.has("content-type")) throw unavailable();
  headers.set("cache-control", "private, no-store");
  headers.set("x-content-type-options", "nosniff");
  return { status, headers, rest: bytes.subarray(end + (crlf >= 0 ? 4 : 2)) };
}
/** No prefetch: the final await before each <=256 KiB emission is live authority.
 * Source is a bounded OS socket, never a whole-pack buffer or a temporary output file. */
export async function cgiResponse(input: {
  source: Readable;
  signal: AbortSignal;
  reauthorize(): Promise<void>;
  wait(): Promise<number>;
  cancel(): Promise<void>;
}) {
  let closing: Promise<void> | undefined;
  let ended = false;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const cleanup = () => {
    ended = true;
    input.signal.removeEventListener("abort", abort);
    closing ??= input.cancel();
    return closing;
  };
  const abort = () => {
    if (!ended) controller?.error(unavailable());
    input.source.destroy(unavailable());
    void cleanup().catch(() => {});
  };
  // destroy(error) can precede iterator installation when admission was already cancelled.
  input.source.on("error", () => {});
  input.signal.addEventListener("abort", abort, { once: true });
  const iterator = input.source[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  const check = () => {
    if (ended || input.signal.aborted) throw unavailable();
  };
  try {
    if (input.signal.aborted) abort();
    check();
    let bytes = Buffer.alloc(0);
    let head = parseCgiHead(bytes);
    while (!head) {
      const next = await iterator.next();
      check();
      if (next.done) throw unavailable();
      bytes = Buffer.concat([bytes, next.value]);
      head = parseCgiHead(bytes);
    }
    await input.reauthorize();
    check();
    let pending = head.rest;
    const body = new ReadableStream<Uint8Array>(
      {
        start(value) {
          controller = value;
        },
        async pull(value) {
          try {
            check();
            if (!pending.length) {
              const next = await iterator.next();
              check();
              if (next.done) {
                if ((await input.wait()) !== 0) throw unavailable();
                check();
                value.close();
                await cleanup();
                return;
              }
              pending = next.value;
            }
            const frame = pending.subarray(0, FRAME);
            pending = pending.subarray(frame.length);
            await input.reauthorize();
            check();
            value.enqueue(frame);
          } catch {
            if (!ended) value.error(unavailable());
            await cleanup();
          }
        },
        cancel() {
          input.source.destroy();
          return cleanup();
        },
      },
      { highWaterMark: 0 },
    );
    return new Response(body, { status: head.status, headers: head.headers });
  } catch (error) {
    await cleanup();
    throw error;
  }
}
// Fixed bridge code: sockets become Git's actual stdio, with no JS buffering.
// The inherited fence FD is explicitly duplicated to Git fd 3; same process group.
const BRIDGE = `const net=require('node:net'),{spawn}=require('node:child_process');
(async()=>{const[git,...paths]=process.argv.slice(1);const sockets=await Promise.all(paths.map(path=>new Promise((ok,no)=>{
 const s=net.connect({path,allowHalfOpen:true},()=>ok(s));s.on('error',no);
})));const child=spawn(git,['http-backend'],{env:{...process.env,KB_FENCE_FD:'3'},
 stdio:[...sockets,Number(process.env.KB_FENCE_FD)]});
 child.on('error',()=>process.exit(1));child.on('exit',code=>process.exit(code??1));
 for(const s of sockets)s.destroy();})().catch(()=>process.exit(1));`;

export async function runGitCgi(input: {
  env: Record<string, string>;
  signal: AbortSignal;
  reauthorize(): Promise<void>;
  file?: FileHandle;
  onDone(): Promise<void>;
  buffered?: boolean;
  onUnconfirmedDrain?(): void;
}) {
  const dir = await mkdtemp(join(tmpdir(), "kb-cgi-")).catch(async (error: unknown) => {
    await input.onDone();
    throw error;
  });
  const abort = new AbortController();
  const cancel = () => abort.abort(unavailable());
  input.signal.addEventListener("abort", cancel, { once: true });
  if (input.signal.aborted) cancel();
  const timer = setTimeout(cancel, 60000);
  timer.unref();
  const sockets: Socket[] = [];
  const servers: ReturnType<typeof createServer>[] = [];
  const opId = randomUUID();
  let pid: number | undefined;
  let spawning: Promise<{ pid: number }> | undefined;
  let exited = false;
  let closing: Promise<void> | undefined;
  let boundedClosing: Promise<void> | undefined;
  let feeding: Promise<void> | undefined;
  let nativeConfirmed = false;
  let unconfirmed = false;
  const failClosed = () => {
    if (unconfirmed) return;
    unconfirmed = true;
    // This closes local native admission synchronously, even if the peer is stalled.
    void closeAdmission().catch(() => {});
    input.onUnconfirmedDrain?.();
  };
  const cleanup = () => {
    closing ??= (async () => {
      clearTimeout(timer);
      input.signal.removeEventListener("abort", cancel);
      for (const socket of sockets) socket.destroy();
      for (const server of servers) server.close();
      try {
        // Retain the original acknowledgement waiter and directory ownership. A
        // late SPAWNED is still ours to drain, even after the caller has settled.
        await spawning;
        if (pid && !exited) await drainMutatingChild(opId, pid);
        nativeConfirmed = true;
      } catch (error) {
        if (error instanceof ProcessFenceError && error.spawnOutcome === "not-started")
          nativeConfirmed = true;
        else failClosed();
        throw error;
      } finally {
        for (const socket of sockets) socket.destroy();
        await feeding?.catch(() => {});
        await rm(dir, { recursive: true, force: true });
        await input.onDone();
      }
    })();
    // The caller's drain budget is bounded; the underlying owner remains joined
    // to the native acknowledgement. Never mistake this timeout for a reaped child.
    boundedClosing ??= new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => {
        if (!nativeConfirmed) failClosed();
        reject(unavailable());
      }, DRAIN_MS);
      closing!.then(resolve, reject).finally(() => clearTimeout(deadline));
    });
    return boundedClosing;
  };
  const onAbort = () => {
    for (const socket of sockets) socket.destroy(unavailable());
  };
  abort.signal.addEventListener("abort", onAbort);
  try {
    // Git silently skips absent/non-executable hooks. Check the fixed artifact
    // for every receive, including source development, before spawning Git.
    if (input.env.CONTENT_TYPE === "application/x-git-receive-pack-request") {
      try {
        const hook = join(PUSH_HOOKS_PATH, "pre-receive");
        const target = join(PUSH_HOOKS_PATH, "../git-pre-receive.mjs");
        if (realpathSync(hook) !== target || !statSync(target).isFile()) throw unavailable();
        accessSync(hook, constants.R_OK | constants.X_OK);
      } catch {
        throw unavailable();
      }
    }
    const paths = ["in", "out", "err"].map((name) => join(dir, name));
    const connections = paths.map(
      (path) =>
        new Promise<Socket>((resolve, reject) => {
          const server = createServer({ allowHalfOpen: true }, (socket) => {
            sockets.push(socket);
            socket.on("error", () => {});
            server.close();
            if (abort.signal.aborted || closing) {
              socket.destroy();
              reject(unavailable());
              return;
            }
            resolve(socket);
          });
          servers.push(server);
          server.once("error", reject);
          server.listen(path);
        }),
    );
    const ready = Promise.all(connections);
    void ready.catch(() => {});
    const cancelled = new Promise<never>((_, reject) =>
      abort.signal.addEventListener("abort", () => reject(unavailable()), { once: true }),
    );
    void cancelled.catch(() => {});
    abort.signal.throwIfAborted();
    spawning = spawnMutatingChild({
      opId,
      cwd: input.env.GIT_PROJECT_ROOT!,
      // The server's own resolved git, never the fixed CGI PATH's (one git per server).
      argv: [process.execPath, "-e", BRIDGE, gitBinary(), ...paths],
      env: { ...input.env, KB_FENCE_FD: process.env.KB_FENCE_FD! },
    }).then((child) => {
      pid = child.pid;
      return child;
    });
    ({ pid } = await Promise.race([spawning, cancelled]));
    const done = waitMutatingChild(opId, pid).then((exit) => {
      exited = true;
      return exit.status;
    });
    void done.catch(cancel);
    const [stdin, stdout, stderr] = await Promise.race([
      ready,
      cancelled,
      done.then(() => {
        throw unavailable();
      }),
    ]);
    abort.signal.throwIfAborted();
    // Drain and redact stderr completely; never retain or log arbitrary repository text.
    stderr!.on("data", () => {});
    feeding = input.file
      ? pipeline(input.file.createReadStream({ start: 0, autoClose: false }), stdin!)
      : Promise.resolve().then(() => {
          stdin!.end();
        });
    void feeding.catch(cancel);
    const response = await cgiResponse({
      source: stdout!,
      signal: abort.signal,
      reauthorize: input.reauthorize,
      wait: () => done,
      cancel: cleanup,
    });
    if (!input.buffered) return response;
    const reader = response.body!.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > 1024 * 1024) throw unavailable();
        chunks.push(chunk.value);
      }
      return new Response(Buffer.concat(chunks), {
        status: response.status,
        headers: response.headers,
      });
    } finally {
      await reader.cancel().catch(() => {});
    }
  } catch (error) {
    if (error instanceof ProcessFenceError && error.spawnOutcome === "unknown") failClosed();
    await cleanup();
    throw error;
  }
}
