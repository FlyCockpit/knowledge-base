import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { captureLog, LOG_SITES, validateLogRecord } from "@knowledge-base/env/log";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertProcessFence,
  closeAdmission,
  DRAIN_MS,
  decodeFrame,
  drainMutatingChild,
  encodeClose,
  encodeDrain,
  encodeFrame,
  encodePing,
  encodeSpawn,
  FENCE_LOCK_REL,
  MSG,
  ProcessFenceError,
  pingProcessFence,
  resetAdmissionForTests,
  spawnMutatingChild,
  supervisorSockPath,
  waitMutatingChild,
} from "./kb-process.js";

const originalEnv = {
  sock: process.env.KB_SUPERVISOR_SOCK,
  fence: process.env.KB_FENCE_FD,
};

afterEach(() => {
  resetAdmissionForTests();
  if (originalEnv.sock === undefined) delete process.env.KB_SUPERVISOR_SOCK;
  else process.env.KB_SUPERVISOR_SOCK = originalEnv.sock;
  if (originalEnv.fence === undefined) delete process.env.KB_FENCE_FD;
  else process.env.KB_FENCE_FD = originalEnv.fence;
});

describe("kb-process fence client", () => {
  it("handles connected socket errors, rejects pending operations, and reconnects", async () => {
    const log = captureLog();
    const fd = openSync(import.meta.filename, "r");
    const socket = new net.Socket();
    const replacement = new net.Socket();
    const closed = [socket, replacement].map(
      (next) => new Promise<void>((resolve) => next.once("close", resolve)),
    );
    process.env.KB_FENCE_FD = String(fd);
    process.env.KB_SUPERVISOR_SOCK = "@test-socket-error";
    const connect = vi.spyOn(net, "connect");
    for (const next of [socket, replacement]) {
      connect.mockImplementationOnce(() => {
        queueMicrotask(() => next.emit("connect"));
        return next;
      });
      vi.spyOn(next, "write").mockReturnValue(true);
    }
    try {
      const spawning = spawnMutatingChild({ opId: "pending-spawn", argv: ["git"], cwd: "/tmp" });
      const waiting = waitMutatingChild("pending-exit", 1234);
      const draining = drainMutatingChild("pending-drain", 5678);
      const pinging = pingProcessFence();
      const rejected = [spawning, waiting, draining, pinging].map((pending) =>
        expect(pending).rejects.toBeInstanceOf(ProcessFenceError),
      );
      const uncertain = expect(spawning).rejects.toMatchObject({
        opId: "pending-spawn",
        spawnOutcome: "unknown",
      });
      await vi.waitFor(() => expect(socket.write).toHaveBeenCalledTimes(3));
      expect(() =>
        socket.emit(
          "error",
          Object.assign(new TypeError("socket failure /private/control.sock git --secret"), {
            code: "ECONNRESET",
            path: "/private/control.sock",
            argv: ["git", "--secret"],
          }),
        ),
      ).not.toThrow();
      expect(socket.destroyed).toBe(true);
      expect(log.records).toEqual([
        {
          level: "error",
          site: "server.control-socket",
          message: "process fence control socket failed",
          errorClass: "TypeError",
        },
      ]);
      await Promise.all([...rejected, uncertain]);

      const reconnected = pingProcessFence();
      await vi.waitFor(() => expect(replacement.write).toHaveBeenCalledOnce());
      replacement.emit("data", encodeFrame(MSG.PONG, new Uint8Array()));
      await expect(reconnected).resolves.toBeUndefined();
      expect(connect).toHaveBeenCalledTimes(2);
    } finally {
      socket.destroy();
      replacement.destroy();
      await Promise.all(closed);
      closeSync(fd);
      vi.restoreAllMocks();
      log.restore();
    }
  });

  it("dispatches live and cached exits only to the matching operation at a shared PID", async () => {
    const fd = openSync(import.meta.filename, "r");
    const socket = new net.Socket();
    process.env.KB_FENCE_FD = String(fd);
    process.env.KB_SUPERVISOR_SOCK = "@test-identity";
    vi.spyOn(net, "connect").mockImplementationOnce(() => {
      queueMicrotask(() => socket.emit("connect"));
      return socket;
    });
    vi.spyOn(socket, "write").mockReturnValue(true);
    const exitFrame = (opId: string, pid: number) => {
      const op = Buffer.from(opId);
      const payload = Buffer.alloc(2 + op.length + 8);
      payload.writeUInt16BE(op.length);
      op.copy(payload, 2);
      payload.writeUInt32BE(pid, 2 + op.length);
      return encodeFrame(MSG.EXITED, payload);
    };
    const errFrame = (opId: string) => {
      const op = Buffer.from(opId),
        msg = Buffer.from("operation not found");
      const payload = Buffer.alloc(2 + op.length + 4 + 2 + msg.length);
      payload.writeUInt16BE(op.length);
      op.copy(payload, 2);
      payload.writeUInt32BE(4, 2 + op.length);
      payload.writeUInt16BE(msg.length, 6 + op.length);
      msg.copy(payload, 8 + op.length);
      return encodeFrame(MSG.ERR, payload);
    };
    try {
      let staleResolved = false;
      const stale = waitMutatingChild("stale", 1234);
      void stale.then(
        () => {
          staleResolved = true;
        },
        () => {},
      );
      const live = waitMutatingChild("live", 1234);
      await vi.waitFor(() => expect(socket.listenerCount("data")).toBe(1));
      socket.emit("data", exitFrame("live", 1234));
      await expect(live).resolves.toMatchObject({ opId: "live", pid: 1234 });
      expect(staleResolved).toBe(false);
      const rejected = expect(stale).rejects.toThrow("operation not found");
      socket.emit("data", errFrame("stale"));
      await rejected;

      // A not-found drain must also not consume another owner's cached EXITED.
      socket.emit("data", exitFrame("cached", 5678));
      await expect(drainMutatingChild("stale", 5678)).rejects.toThrow("operation not found");
      await expect(waitMutatingChild("cached", 5678)).resolves.toMatchObject({ opId: "cached" });

      const pending = drainMutatingChild("missing", 9012);
      const pendingReject = expect(pending).rejects.toThrow("operation not found");
      await vi.waitFor(() => expect(socket.write).toHaveBeenCalled());
      await new Promise((resolve) => setImmediate(resolve));
      socket.emit("data", exitFrame("cached-other", 9012));
      socket.emit("data", errFrame("missing"));
      await pendingReject;
      await expect(waitMutatingChild("cached-other", 9012)).resolves.toMatchObject({
        opId: "cached-other",
      });
    } finally {
      socket.emit("close");
      socket.destroy();
      closeSync(fd);
      vi.restoreAllMocks();
    }
  });
  it("rejects mutating spawn after admission is closed", async () => {
    delete process.env.KB_SUPERVISOR_SOCK;
    await closeAdmission();
    await expect(
      spawnMutatingChild({ opId: "op_closed", argv: ["/bin/true"], cwd: "/tmp" }),
    ).rejects.toMatchObject({
      name: "ProcessFenceError",
      opId: "op_closed",
      message: expect.stringMatching(/admission closed/),
      spawnOutcome: "not-started",
    });
  });

  it("fails closed when the supervisor socket and fence fd are missing", () => {
    delete process.env.KB_SUPERVISOR_SOCK;
    delete process.env.KB_FENCE_FD;
    expect(() => assertProcessFence()).toThrow(/Process fence is unavailable/);
    expect(() => supervisorSockPath()).toThrow(ProcessFenceError);
  });

  it("names the operation id in errors and never includes argv or bodies", async () => {
    delete process.env.KB_SUPERVISOR_SOCK;
    const secretArgv = ["git", "-c", "http.extraHeader=Authorization: Bearer secret-token"];
    const body = "# confidential document body\n";
    await expect(
      spawnMutatingChild({
        opId: "op_fence_1",
        argv: secretArgv,
        cwd: "/tmp",
        env: { DOCUMENT: body },
      }),
    ).rejects.toMatchObject({
      name: "ProcessFenceError",
      opId: "op_fence_1",
      message: expect.stringContaining("op op_fence_1"),
      spawnOutcome: "not-started",
    });
    try {
      await spawnMutatingChild({
        opId: "op_fence_1",
        argv: secretArgv,
        cwd: "/tmp",
        env: { DOCUMENT: body },
      });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      expect(text).toContain("op op_fence_1");
      expect(text).not.toContain("secret-token");
      expect(text).not.toContain("Authorization");
      expect(text).not.toContain(body);
      expect(text).not.toContain("git");
    }
  });

  it("round-trips spawn/drain/error frames without leaking argv", () => {
    const req = {
      opId: "op_roundtrip",
      argv: ["/opt/fixture/git", "hash-object", "--stdin"],
      cwd: "/var/lib/knowledge-base/repos",
      env: { PATH: "/usr/bin" },
    };
    const encoded = encodeSpawn(req);
    const decoded = decodeFrame(encoded);
    expect(decoded?.frame).toEqual({ kind: "other", type: MSG.SPAWN });
    const drain = decodeFrame(encodeDrain("op_roundtrip", 4321));
    expect(drain?.frame).toEqual({ kind: "other", type: MSG.DRAIN });
    expect(decodeFrame(encodePing())?.frame).toEqual({ kind: "other", type: MSG.PING });
    const err = decodeFrame(
      encodeFrame(
        MSG.ERR,
        (() => {
          const op = Buffer.from("op_roundtrip");
          const msg = Buffer.from("admission closed");
          const buf = Buffer.alloc(2 + op.length + 4 + 2 + msg.length);
          buf.writeUInt16BE(op.length, 0);
          op.copy(buf, 2);
          buf.writeUInt32BE(2, 2 + op.length);
          buf.writeUInt16BE(msg.length, 6 + op.length);
          msg.copy(buf, 8 + op.length);
          return buf;
        })(),
      ),
    );
    expect(err?.frame).toEqual({
      kind: "err",
      opId: "op_roundtrip",
      code: 2,
      message: "admission closed",
    });
    expect(JSON.stringify(err?.frame)).not.toContain("hash-object");
    expect(decodeFrame(encodeClose())?.frame).toEqual({ kind: "other", type: MSG.CLOSE });
    expect(DRAIN_MS).toBe(5_000);
    expect(FENCE_LOCK_REL).toBe(".private/server.fence");
  });

  it("maps abstract supervisor addresses and rejects a missing fence fd", () => {
    process.env.KB_SUPERVISOR_SOCK = "@kb-sup-9";
    expect(supervisorSockPath()).toBe("\0kb-sup-9");
    delete process.env.KB_FENCE_FD;
    expect(() => assertProcessFence()).toThrow(/KB_FENCE_FD/);
  });

  it("requires mutating Git children to use the supervisor spawn API", () => {
    const processSource = readFileSync(new URL("./kb-process.ts", import.meta.url), "utf8");
    const lifecycle = readFileSync(new URL("./lifecycle.ts", import.meta.url), "utf8");
    expect(processSource).toContain("export async function spawnMutatingChild");
    expect(processSource).toContain("export async function waitMutatingChild");
    expect(processSource).toContain("export async function drainMutatingChild");
    expect(processSource).toContain("Only spawn path for mutating Git children");
    expect(lifecycle).toContain("pingProcessFence");
    const serverSrc = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(serverSrc).not.toMatch(/spawn\(\s*["']git["']/);
    expect(serverSrc).not.toMatch(/execFile\(\s*["']git["']/);
  });
});

// The output supervisor starts native kb-supervisor, which must still exec the
// application directly so its inherited fence and PID admission stay intact.
const serverRoot = resolve(import.meta.dirname, "..");
const supervisor = join(serverRoot, "native/kb-supervisor");
describe("server dev command under output and native supervisors", () => {
  it.skipIf(!existsSync(supervisor))(
    "keeps the inherited volume fence descriptor in the real service process",
    async () => {
      const { scripts } = JSON.parse(readFileSync(join(serverRoot, "package.json"), "utf8")) as {
        scripts: { dev: string };
      };
      expect(scripts.dev).toContain("node --import tsx src/output.ts --fenced");
      const dataRoot = mkdtempSync(join(tmpdir(), "kb-dev-fence-"));
      try {
        mkdirSync(join(dataRoot, "repos/.private"), { recursive: true });
        const probe = join(dataRoot, "probe.mjs");
        writeFileSync(
          probe,
          [
            'import { fstatSync, writeSync } from "node:fs";',
            'if (process.argv[1]?.endsWith("bootstrap.ts")) {',
            "const count = Number(fstatSync(Number(process.env.KB_FENCE_FD)).isFile());",
            'writeSync(3, JSON.stringify({level: "info", site: "server.git", message: "git capability probe passed", count}) + "\\n");',
            "process.exit(0);",
            "}",
          ].join("\n"),
        );
        const { stdout } = await promisify(execFile)(
          process.execPath,
          ["--import", "tsx", "--import", probe, "src/output.ts", "--fenced"],
          {
            cwd: serverRoot,
            env: { PATH: process.env.PATH, TMPDIR: tmpdir(), KB_DATA_ROOT: dataRoot },
            timeout: 30_000,
          },
        );
        const records = stdout
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(records).toContainEqual(expect.objectContaining({ site: "server.git", count: 1 }));
        expect(records).toContainEqual(
          expect.objectContaining({ site: "service.exit", exitCode: 0 }),
        );
      } finally {
        rmSync(dataRoot, { recursive: true, force: true });
      }
    },
    40_000,
  );
});

describe("native supervisor records", () => {
  it("writes exactly the LOG_SITES entries the output supervisor validates", () => {
    const native = readFileSync(join(serverRoot, "native/kb-supervisor.c"), "utf8");
    const table = [
      ...native.matchAll(/\[REC_[A-Z_]+\] = \{"([^"]+)", "([^"]+)", "([^"]+)"\}/g),
    ].map(([, site, level, message]) => [site, [level, message]] as const);
    expect(table.length).toBeGreaterThan(0);
    expect(Object.fromEntries(table)).toEqual(
      Object.fromEntries(
        Object.entries(LOG_SITES).filter(([site]) => site.startsWith("supervisor.")),
      ),
    );
    // Every reason the C side can emit is a valid identifier-like field value.
    const reasons = [...native.matchAll(/return "([A-Z_]+)";/g)].map(([, reason]) => reason!);
    for (const reason of reasons)
      expect(
        validateLogRecord({
          level: "error",
          site: "supervisor.fatal",
          message: LOG_SITES["supervisor.fatal"][1],
          reason,
        }),
      ).toBeDefined();
  });

  const runFenced = async (dataRoot: string | undefined) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/output.ts", "--fenced"], {
      cwd: serverRoot,
      env: {
        PATH: process.env.PATH,
        TMPDIR: tmpdir(),
        ...(dataRoot ? { KB_DATA_ROOT: dataRoot } : {}),
      },
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    const [code] = await once(child, "close");
    return {
      code,
      records: stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    };
  };

  it.skipIf(!existsSync(supervisor))(
    "tells a fence held by another server apart from other startup failures",
    async () => {
      const dataRoot = mkdtempSync(join(tmpdir(), "kb-fence-held-"));
      mkdirSync(join(dataRoot, "repos/.private"), { recursive: true });
      // Another server holds the volume fence for the duration of the attempt.
      const holder = spawn(supervisor, ["--", process.execPath, "-e", "process.stdin.resume()"], {
        env: { PATH: process.env.PATH, KB_DATA_ROOT: dataRoot },
        stdio: ["pipe", "ignore", "ignore"],
      });
      const held = once(holder, "close");
      try {
        let ready = false;
        for (let i = 0; i < 100; i++) {
          const probe = await promisify(execFile)(supervisor, ["--", "true"], {
            env: { PATH: process.env.PATH, KB_DATA_ROOT: dataRoot },
          }).then(
            () => false,
            (error: { code?: number }) => error.code === 85,
          );
          if (probe) {
            ready = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(ready, "the fixture must acquire its fence before testing a competing server").toBe(
          true,
        );
        const fenced = await runFenced(dataRoot);
        expect(fenced.code, JSON.stringify(fenced.records)).toBe(85);
        expect(fenced.records).toContainEqual({
          level: "error",
          site: "supervisor.fatal",
          message: "native supervisor could not start",
          reason: "FENCE_HELD",
          exitCode: 85,
        });
        expect(fenced.records).toContainEqual(
          expect.objectContaining({ site: "service.exit", exitCode: 85 }),
        );
        expect(fenced.records).not.toContainEqual(
          expect.objectContaining({ site: "service.records-rejected" }),
        );

        const missing = await runFenced(undefined);
        expect(missing.code).toBe(82);
        expect(missing.records).toContainEqual(
          expect.objectContaining({ site: "supervisor.fatal", reason: "DATA_ROOT_MISSING" }),
        );
        expect(missing.records).not.toContainEqual(
          expect.objectContaining({ reason: "FENCE_HELD" }),
        );
      } finally {
        holder.stdin.end();
        holder.kill("SIGTERM");
        await held;
        rmSync(dataRoot, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
