import { fstatSync } from "node:fs";
import net from "node:net";
import { logInternalError } from "@knowledge-base/env/log";

export const DRAIN_MS = 5_000;
export const FENCE_LOCK_REL = ".private/server.fence";

export const MSG = {
  SPAWN: 1,
  DRAIN: 2,
  CLOSE: 3,
  PING: 4,
  SHUTDOWN: 5,
  SPAWNED: 101,
  EXITED: 102,
  ERR: 103,
  PONG: 104,
} as const;

const MAX_FRAME = 65_536;
const OP_ID = /^[A-Za-z0-9_-]{1,128}$/;

export class ProcessFenceError extends Error {
  readonly opId: string;
  constructor(
    opId: string,
    message: string,
    readonly spawnOutcome: "not-started" | "unknown" = "unknown",
  ) {
    super(opId ? `op ${opId}: ${message}` : message);
    this.name = "ProcessFenceError";
    this.opId = opId;
  }
}

export type MutatingSpawnRequest = {
  opId: string;
  argv: string[];
  cwd: string;
  env?: Record<string, string>;
};

export type SupervisedExit = {
  opId: string;
  pid: number;
  status: number;
};

function writeU16(out: number[], value: number): void {
  out.push((value >> 8) & 0xff, value & 0xff);
}

function writeU32(out: number[], value: number): void {
  out.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}

function writeStr(out: number[], value: string): void {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > 0xffff) throw new ProcessFenceError("", "control string too long");
  writeU16(out, bytes.length);
  for (const byte of bytes) out.push(byte);
}

export function encodeFrame(type: number, payload: Uint8Array): Buffer {
  const length = payload.length + 1;
  const header = Buffer.alloc(5);
  header.writeUInt32BE(length, 0);
  header[4] = type;
  return Buffer.concat([header, Buffer.from(payload)]);
}

export function encodeSpawn(req: MutatingSpawnRequest): Buffer {
  const body: number[] = [];
  writeStr(body, req.opId);
  writeStr(body, req.cwd);
  const argv = req.argv;
  writeU16(body, argv.length);
  for (const arg of argv) writeStr(body, arg);
  const envEntries = Object.entries(req.env ?? {});
  writeU16(body, envEntries.length);
  for (const [key, value] of envEntries) {
    writeStr(body, key);
    writeStr(body, value);
  }
  return encodeFrame(MSG.SPAWN, Uint8Array.from(body));
}

export function encodeDrain(opId: string, pid: number): Buffer {
  const body: number[] = [];
  writeStr(body, opId);
  writeU32(body, pid >>> 0);
  return encodeFrame(MSG.DRAIN, Uint8Array.from(body));
}

export function encodeClose(): Buffer {
  return encodeFrame(MSG.CLOSE, new Uint8Array());
}

export function encodePing(): Buffer {
  return encodeFrame(MSG.PING, new Uint8Array());
}

export type DecodedFrame =
  | { kind: "pong" }
  | { kind: "spawned"; opId: string; pid: number }
  | { kind: "exited"; opId: string; pid: number; status: number }
  | { kind: "err"; opId: string; code: number; message: string }
  | { kind: "other"; type: number };

function readU16(buf: Buffer, offset: number): { value: number; next: number } {
  if (offset + 2 > buf.length) throw new ProcessFenceError("", "truncated control frame");
  return { value: buf.readUInt16BE(offset), next: offset + 2 };
}

function readU32(buf: Buffer, offset: number): { value: number; next: number } {
  if (offset + 4 > buf.length) throw new ProcessFenceError("", "truncated control frame");
  return { value: buf.readUInt32BE(offset), next: offset + 4 };
}

function readStr(buf: Buffer, offset: number): { value: string; next: number } {
  const len = readU16(buf, offset);
  if (len.next + len.value > buf.length) throw new ProcessFenceError("", "truncated control frame");
  return {
    value: buf.subarray(len.next, len.next + len.value).toString("utf8"),
    next: len.next + len.value,
  };
}

export function decodeFrame(buffer: Buffer): { frame: DecodedFrame; rest: Buffer } | null {
  if (buffer.length < 4) return null;
  const length = buffer.readUInt32BE(0);
  if (length < 1 || length > MAX_FRAME) throw new ProcessFenceError("", "invalid control frame");
  if (buffer.length < 4 + length) return null;
  const type = buffer[4] ?? 0;
  const payload = buffer.subarray(5, 4 + length);
  const rest = buffer.subarray(4 + length);
  if (type === MSG.PONG) return { frame: { kind: "pong" }, rest };
  if (type === MSG.SPAWNED) {
    const opId = readStr(payload, 0);
    const pid = readU32(payload, opId.next);
    return { frame: { kind: "spawned", opId: opId.value, pid: pid.value }, rest };
  }
  if (type === MSG.EXITED) {
    const opId = readStr(payload, 0);
    const pid = readU32(payload, opId.next);
    const status = readU32(payload, pid.next);
    return {
      frame: { kind: "exited", opId: opId.value, pid: pid.value, status: status.value | 0 },
      rest,
    };
  }
  if (type === MSG.ERR) {
    const opId = readStr(payload, 0);
    const code = readU32(payload, opId.next);
    const message = readStr(payload, code.next);
    return {
      frame: { kind: "err", opId: opId.value, code: code.value, message: message.value },
      rest,
    };
  }
  return { frame: { kind: "other", type }, rest };
}

export function supervisorSockPath(addr = process.env.KB_SUPERVISOR_SOCK): string {
  if (!addr) {
    throw new ProcessFenceError("", "Process fence is unavailable: KB_SUPERVISOR_SOCK is not set.");
  }
  if (addr.startsWith("@")) return `\0${addr.slice(1)}`;
  return addr;
}

function assertFenceFd(): void {
  const raw = process.env.KB_FENCE_FD;
  const fd = raw === undefined || raw === "" ? Number.NaN : Number(raw);
  if (!Number.isInteger(fd) || fd < 3) {
    throw new ProcessFenceError(
      "",
      "Process fence is unavailable: KB_FENCE_FD is missing or invalid.",
    );
  }
  let stat: ReturnType<typeof fstatSync>;
  try {
    stat = fstatSync(fd);
  } catch {
    throw new ProcessFenceError("", "Process fence is unavailable: fence descriptor is closed.");
  }
  if (!stat.isFile()) {
    throw new ProcessFenceError(
      "",
      "Process fence is unavailable: fence descriptor is not a file.",
    );
  }
}

type Pending<T> = {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
};

type ExitWaiter = Pending<SupervisedExit> & { opId: string };

class FenceClient {
  private socket: net.Socket | undefined;
  private buffer = Buffer.alloc(0);
  private readonly spawned = new Map<string, Pending<{ pid: number }>>();
  private readonly exited = new Map<number, ExitWaiter[]>();
  private readonly completed = new Map<number, SupervisedExit>();
  private pingWaiters: Pending<void>[] = [];
  private connecting: Promise<void> | undefined;

  async ensure(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return;
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<void>((resolve, reject) => {
      const path = supervisorSockPath();
      const socket = net.connect({ path });
      const fail = (error: Error) => {
        this.connecting = undefined;
        reject(error);
      };
      socket.once("error", fail);
      socket.once("connect", () => {
        socket.off("error", fail);
        socket.on("error", (error: Error) => {
          // Retain only the class, without socket codes or other error metadata.
          logInternalError("server.control-socket", { constructor: error.constructor });
          socket.destroy();
        });
        this.socket = socket;
        this.buffer = Buffer.alloc(0);
        socket.on("data", (chunk: Buffer) => this.onData(chunk));
        socket.on("close", () => this.onClose());
        this.connecting = undefined;
        resolve();
      });
    });
    return this.connecting;
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.from(Buffer.concat([this.buffer, chunk]));
    for (;;) {
      const decoded = decodeFrame(this.buffer);
      if (!decoded) break;
      this.buffer = Buffer.from(decoded.rest);
      this.dispatch(decoded.frame);
    }
  }

  private dispatch(frame: DecodedFrame): void {
    if (frame.kind === "pong") {
      const waiters = this.pingWaiters;
      this.pingWaiters = [];
      for (const waiter of waiters) waiter.resolve();
      return;
    }
    if (frame.kind === "spawned") {
      this.completed.delete(frame.pid);
      const pending = this.spawned.get(frame.opId);
      this.spawned.delete(frame.opId);
      pending?.resolve({ pid: frame.pid });
      return;
    }
    if (frame.kind === "exited") {
      const exit: SupervisedExit = { opId: frame.opId, pid: frame.pid, status: frame.status };
      const pending = this.exited.get(frame.pid) ?? [];
      const waiters = pending.filter((waiter) => waiter.opId === frame.opId);
      const remaining = pending.filter((waiter) => waiter.opId !== frame.opId);
      if (remaining.length) this.exited.set(frame.pid, remaining);
      else this.exited.delete(frame.pid);
      if (waiters.length === 0) {
        this.completed.set(frame.pid, exit);
        return;
      }
      this.completed.delete(frame.pid);
      for (const waiter of waiters) waiter.resolve(exit);
      return;
    }
    if (frame.kind === "err") {
      const error = new ProcessFenceError(frame.opId, frame.message);
      const spawned = this.spawned.get(frame.opId);
      if (spawned) {
        this.spawned.delete(frame.opId);
        spawned.reject(error);
        return;
      }
      const notFound = frame.code === 4 || /not found/i.test(frame.message);
      for (const [pid, waiters] of this.exited) {
        const matching = waiters.filter((waiter) => waiter.opId === frame.opId);
        if (matching.length === 0) continue;
        const remaining = waiters.filter((waiter) => waiter.opId !== frame.opId);
        if (remaining.length === 0) this.exited.delete(pid);
        else this.exited.set(pid, remaining);
        const done = this.completed.get(pid);
        if (notFound && done?.opId === frame.opId) {
          this.completed.delete(pid);
          for (const waiter of matching) waiter.resolve(done);
          return;
        }
        for (const waiter of matching) waiter.reject(error);
        return;
      }
    }
  }

  private onClose(): void {
    this.socket = undefined;
    const error = new ProcessFenceError("", "control channel closed");
    for (const pending of this.spawned.values()) pending.reject(error);
    this.spawned.clear();
    for (const waiters of this.exited.values()) {
      for (const pending of waiters) pending.reject(error);
    }
    this.exited.clear();
    this.completed.clear();
    for (const pending of this.pingWaiters) pending.reject(error);
    this.pingWaiters = [];
  }

  private send(frame: Buffer): void {
    const socket = this.socket;
    if (!socket || socket.destroyed) {
      throw new ProcessFenceError("", "Process fence is unavailable: control channel is closed.");
    }
    socket.write(frame);
  }

  async ping(): Promise<void> {
    await this.ensure();
    await new Promise<void>((resolve, reject) => {
      this.pingWaiters.push({ resolve, reject });
      this.send(encodePing());
    });
  }

  async spawn(req: MutatingSpawnRequest): Promise<{ pid: number }> {
    let frame: Buffer;
    try {
      frame = encodeSpawn(req);
      await this.ensure();
      // Admission can close while connection establishment is pending.
      if (!admissionOpen) throw new ProcessFenceError(req.opId, "admission closed", "not-started");
      if (this.spawned.has(req.opId)) {
        throw new ProcessFenceError(req.opId, "duplicate in-flight operation id");
      }
    } catch (error) {
      throw withOpId(req.opId, error, "not-started");
    }
    return new Promise((resolve, reject) => {
      this.spawned.set(req.opId, { resolve, reject });
      // Once dispatched, an error is not proof that fork did not happen.
      // Even ERR frames are conservative: this protocol has no request IDs
      // distinguishing a concurrent drain error from a spawn rejection.
      try {
        this.send(frame);
      } catch (error) {
        this.spawned.delete(req.opId);
        reject(error);
      }
    });
  }

  private takeCompleted(pid: number): SupervisedExit | undefined {
    const done = this.completed.get(pid);
    if (done) this.completed.delete(pid);
    return done;
  }

  private awaitExit(opId: string, pid: number, signalDrain: boolean): Promise<SupervisedExit> {
    const done = this.takeCompleted(pid);
    if (done) {
      if (done.opId !== opId) {
        this.completed.set(pid, done);
        return Promise.reject(new ProcessFenceError(opId, "operation not found"));
      }
      return Promise.resolve(done);
    }
    return new Promise((resolve, reject) => {
      const waiters = this.exited.get(pid) ?? [];
      waiters.push({ opId, resolve, reject });
      this.exited.set(pid, waiters);
      if (signalDrain) this.send(encodeDrain(opId, pid));
    });
  }

  async wait(opId: string, pid: number): Promise<SupervisedExit> {
    await this.ensure();
    return this.awaitExit(opId, pid, false);
  }

  async drain(opId: string, pid: number): Promise<SupervisedExit> {
    await this.ensure();
    return this.awaitExit(opId, pid, true);
  }

  async closeAdmission(): Promise<void> {
    await this.ensure();
    this.send(encodeClose());
  }
}

const client = new FenceClient();

let admissionOpen = true;

export function isAdmissionOpen(): boolean {
  return admissionOpen;
}

export function resetAdmissionForTests(): void {
  admissionOpen = true;
}

export function assertProcessFence(): void {
  if (process.platform !== "linux") {
    throw new ProcessFenceError(
      "",
      "Process fence is unavailable: Linux supervisor required, no unsafe fallback.",
    );
  }
  supervisorSockPath();
  assertFenceFd();
}

export async function pingProcessFence(): Promise<void> {
  assertProcessFence();
  await client.ping();
}

function validateSpawn(req: MutatingSpawnRequest): void {
  if (!OP_ID.test(req.opId)) {
    throw new ProcessFenceError(req.opId, "invalid operation id");
  }
  if (!req.cwd || req.cwd.includes("\0")) {
    throw new ProcessFenceError(req.opId, "invalid cwd");
  }
  if (!Array.isArray(req.argv) || req.argv.length < 1 || req.argv.length > 32) {
    throw new ProcessFenceError(req.opId, "invalid argv count");
  }
  for (const arg of req.argv) {
    if (typeof arg !== "string" || arg.includes("\0")) {
      throw new ProcessFenceError(req.opId, "invalid argv");
    }
  }
}

/**
 * Only spawn path for mutating Git children. Node `child_process` must not
 * launch writers; the supervisor owns process groups and the inherited fence fd.
 */
function withOpId(
  opId: string,
  error: unknown,
  spawnOutcome = error instanceof ProcessFenceError ? error.spawnOutcome : "unknown",
): ProcessFenceError {
  const message =
    error instanceof ProcessFenceError
      ? error.message.replace(/^op [^:]+: /, "")
      : error instanceof Error
        ? error.message
        : "Process fence is unavailable";
  return new ProcessFenceError(opId, message, spawnOutcome);
}

export async function spawnMutatingChild(req: MutatingSpawnRequest): Promise<{ pid: number }> {
  try {
    validateSpawn(req);
    if (!admissionOpen) {
      throw new ProcessFenceError(req.opId, "admission closed");
    }
    assertProcessFence();
  } catch (error) {
    throw withOpId(req.opId, error, "not-started");
  }
  try {
    const env = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      ...req.env,
    };
    return await client.spawn({ ...req, env });
  } catch (error) {
    throw withOpId(req.opId, error);
  }
}

export async function waitMutatingChild(opId: string, pid: number): Promise<SupervisedExit> {
  if (!OP_ID.test(opId)) throw new ProcessFenceError(opId, "invalid operation id");
  try {
    assertProcessFence();
    return await client.wait(opId, pid);
  } catch (error) {
    throw withOpId(opId, error);
  }
}

export async function drainMutatingChild(opId: string, pid: number): Promise<SupervisedExit> {
  if (!OP_ID.test(opId)) throw new ProcessFenceError(opId, "invalid operation id");
  try {
    assertProcessFence();
    return await client.drain(opId, pid);
  } catch (error) {
    throw withOpId(opId, error);
  }
}

export async function closeAdmission(): Promise<void> {
  admissionOpen = false;
  if (!process.env.KB_SUPERVISOR_SOCK) return;
  await client.closeAdmission();
}
