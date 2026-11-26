import {
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  verify,
} from "node:crypto";
import { connect as netConnect, type Socket } from "node:net";
import { type ApprovedHostKey, parseApprovedHostKeys } from "./deploy-key";

/**
 * Bounded `ssh-keyscan` equivalent: runs the SSH key exchange (RFC 4253 with
 * curve25519-sha256, RFC 8731) far enough to receive the server's host key and
 * its signature over the exchange hash, verifies that signature, and hangs up.
 * No authentication is attempted and nothing is sent after the key exchange.
 *
 * The caller passes an address that already passed the mirror egress policy;
 * this module never resolves names. A scanned key is only a candidate: it is
 * trusted solely by a published-fingerprint match or the user's confirmation.
 */

const CLIENT_VERSION = "SSH-2.0-KnowledgeBase_Keyscan";
const MAX_BYTES_PER_CONNECTION = 64 * 1024;
const MAX_PACKET = 35_000;
const MAX_BANNER_LINES = 32;
const MAX_PACKETS = 16;
const SSH_SCAN_TIMEOUT_MS = 6_000;

const MSG_DISCONNECT = 1;
const MSG_IGNORE = 2;
const MSG_UNIMPLEMENTED = 3;
const MSG_DEBUG = 4;
const MSG_KEXINIT = 20;
const MSG_KEX_ECDH_INIT = 30;
const MSG_KEX_ECDH_REPLY = 31;

/** Key types scanned, one connection each (a server proves one host key per exchange). */
const SCANNED_KEY_TYPES = [
  { keyType: "ssh-ed25519", offer: ["ssh-ed25519"] },
  { keyType: "ecdsa-sha2-nistp256", offer: ["ecdsa-sha2-nistp256"] },
  // RSA keys are proven with SHA-2 signatures only; SHA-1 `ssh-rsa` is not offered.
  { keyType: "ssh-rsa", offer: ["rsa-sha2-512", "rsa-sha2-256"] },
] as const;

class ScanFailure extends Error {
  constructor(readonly kind: "UNREACHABLE" | "PROTOCOL") {
    super(kind === "UNREACHABLE" ? "SSH host unreachable" : "SSH key exchange failed");
  }
}

function sshString(value: Buffer | string): Buffer {
  const bytes = Buffer.from(value);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

function mpint(bytes: Buffer): Buffer {
  let start = 0;
  while (start < bytes.length && bytes[start] === 0) start++;
  let body = bytes.subarray(start);
  if (body.length > 0 && body[0]! & 0x80) body = Buffer.concat([Buffer.from([0]), body]);
  return sshString(body);
}

class Reader {
  #offset = 0;
  constructor(readonly bytes: Buffer) {}
  byte(): number {
    if (this.#offset + 1 > this.bytes.length) throw new ScanFailure("PROTOCOL");
    return this.bytes[this.#offset++]!;
  }
  string(): Buffer {
    if (this.#offset + 4 > this.bytes.length) throw new ScanFailure("PROTOCOL");
    const length = this.bytes.readUInt32BE(this.#offset);
    this.#offset += 4;
    if (length > this.bytes.length - this.#offset) throw new ScanFailure("PROTOCOL");
    const out = this.bytes.subarray(this.#offset, this.#offset + length);
    this.#offset += length;
    return out;
  }
  done(): boolean {
    return this.#offset === this.bytes.length;
  }
}

function packet(payload: Buffer): Buffer {
  // Unencrypted framing: block size 8, at least 4 bytes of padding.
  let padding = 8 - ((payload.length + 5) % 8);
  if (padding < 4) padding += 8;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length + padding + 1);
  return Buffer.concat([length, Buffer.from([padding]), payload, randomBytes(padding)]);
}

function nameList(names: readonly string[]): Buffer {
  return sshString(names.join(","));
}

function kexInit(hostKeyAlgorithms: readonly string[]): Buffer {
  const ciphers = [
    "chacha20-poly1305@openssh.com",
    "aes128-gcm@openssh.com",
    "aes256-gcm@openssh.com",
    "aes128-ctr",
    "aes192-ctr",
    "aes256-ctr",
  ];
  const macs = [
    "hmac-sha2-256-etm@openssh.com",
    "hmac-sha2-512-etm@openssh.com",
    "hmac-sha2-256",
    "hmac-sha2-512",
  ];
  return Buffer.concat([
    Buffer.from([MSG_KEXINIT]),
    randomBytes(16),
    nameList(["curve25519-sha256", "curve25519-sha256@libssh.org"]),
    nameList(hostKeyAlgorithms),
    nameList(ciphers),
    nameList(ciphers),
    nameList(macs),
    nameList(macs),
    nameList(["none"]),
    nameList(["none"]),
    nameList([]),
    nameList([]),
    Buffer.from([0, 0, 0, 0, 0]),
  ]);
}

/** Byte stream with bounded buffering and a single pending reader. */
class Wire {
  #buffer = Buffer.alloc(0);
  #received = 0;
  #failure: ScanFailure | null = null;
  #wake: (() => void) | null = null;
  #connected = false;
  constructor(readonly socket: Socket) {
    socket.on("connect", () => {
      this.#connected = true;
    });
    socket.on("data", (chunk: Buffer) => {
      this.#received += chunk.length;
      if (this.#received > MAX_BYTES_PER_CONNECTION) {
        this.fail(new ScanFailure("PROTOCOL"));
        socket.destroy();
        return;
      }
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
      this.#notify();
    });
    const closed = () => this.fail(new ScanFailure(this.#connected ? "PROTOCOL" : "UNREACHABLE"));
    socket.on("error", closed);
    socket.on("close", closed);
    socket.on("end", closed);
  }
  get connected() {
    return this.#connected;
  }
  fail(failure: ScanFailure) {
    this.#failure ??= failure;
    this.#notify();
  }
  #notify() {
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
  }
  async #until(ready: () => boolean): Promise<void> {
    while (!ready()) {
      if (this.#failure) throw this.#failure;
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
    }
  }
  async take(length: number): Promise<Buffer> {
    await this.#until(() => this.#buffer.length >= length);
    const out = this.#buffer.subarray(0, length);
    this.#buffer = this.#buffer.subarray(length);
    return out;
  }
  async line(): Promise<string> {
    await this.#until(() => this.#buffer.includes(0x0a) || this.#buffer.length > 255);
    const end = this.#buffer.indexOf(0x0a);
    if (end < 0) throw new ScanFailure("PROTOCOL");
    const raw = this.#buffer.subarray(0, end).toString("latin1");
    this.#buffer = this.#buffer.subarray(end + 1);
    return raw.endsWith("\r") ? raw.slice(0, -1) : raw;
  }
  async packet(): Promise<Buffer> {
    const length = (await this.take(4)).readUInt32BE(0);
    if (length < 5 || length > MAX_PACKET) throw new ScanFailure("PROTOCOL");
    const body = await this.take(length);
    const padding = body[0]!;
    if (padding < 4 || padding >= length) throw new ScanFailure("PROTOCOL");
    return body.subarray(1, length - padding);
  }
}

async function nextMessage(wire: Wire): Promise<Buffer> {
  for (let i = 0; i < MAX_PACKETS; i++) {
    const payload = await wire.packet();
    const type = payload[0];
    if (type === MSG_IGNORE || type === MSG_DEBUG || type === MSG_UNIMPLEMENTED) continue;
    if (type === MSG_DISCONNECT || payload.length === 0) throw new ScanFailure("PROTOCOL");
    return payload;
  }
  throw new ScanFailure("PROTOCOL");
}

const b64url = (bytes: Buffer) => bytes.toString("base64url");

function leftPad(bytes: Buffer, size: number): Buffer {
  let start = 0;
  while (start < bytes.length - size && bytes[start] === 0) start++;
  const trimmed = bytes.subarray(start);
  if (trimmed.length > size) throw new ScanFailure("PROTOCOL");
  return Buffer.concat([Buffer.alloc(size - trimmed.length), trimmed]);
}

function verifyHostSignature(
  keyType: string,
  hostKey: Buffer,
  signatureBlob: Buffer,
  exchangeHash: Buffer,
): boolean {
  const key = new Reader(hostKey);
  const signature = new Reader(signatureBlob);
  const signatureAlgorithm = signature.string().toString("latin1");
  const signatureBytes = signature.string();
  if (!signature.done() || key.string().toString("latin1") !== keyType) return false;
  let publicKey: KeyObject;
  try {
    if (keyType === "ssh-ed25519") {
      const raw = key.string();
      if (!key.done() || raw.length !== 32 || signatureAlgorithm !== keyType) return false;
      publicKey = createPublicKey({
        key: { kty: "OKP", crv: "Ed25519", x: b64url(raw) },
        format: "jwk",
      });
      return verify(null, exchangeHash, publicKey, signatureBytes);
    }
    if (keyType === "ecdsa-sha2-nistp256") {
      const curve = key.string().toString("latin1");
      const point = key.string();
      if (!key.done() || curve !== "nistp256" || point.length !== 65 || point[0] !== 4)
        return false;
      if (signatureAlgorithm !== keyType) return false;
      publicKey = createPublicKey({
        key: {
          kty: "EC",
          crv: "P-256",
          x: b64url(point.subarray(1, 33)),
          y: b64url(point.subarray(33)),
        },
        format: "jwk",
      });
      const rs = new Reader(signatureBytes);
      const r = leftPad(rs.string(), 32);
      const s = leftPad(rs.string(), 32);
      if (!rs.done()) return false;
      return verify(
        "sha256",
        exchangeHash,
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.concat([r, s]),
      );
    }
    if (keyType === "ssh-rsa") {
      const e = key.string();
      const n = key.string();
      if (!key.done()) return false;
      const hash =
        signatureAlgorithm === "rsa-sha2-512"
          ? "sha512"
          : signatureAlgorithm === "rsa-sha2-256"
            ? "sha256"
            : null;
      if (!hash) return false;
      const modulus = leftPad(n, n[0] === 0 ? n.length - 1 : n.length);
      publicKey = createPublicKey({
        key: {
          kty: "RSA",
          n: b64url(modulus),
          e: b64url(leftPad(e, e[0] === 0 ? e.length - 1 : e.length)),
        },
        format: "jwk",
      });
      return verify(hash, exchangeHash, publicKey, leftPad(signatureBytes, modulus.length));
    }
  } catch {
    return false;
  }
  return false;
}

async function exchange(
  wire: Wire,
  type: (typeof SCANNED_KEY_TYPES)[number],
): Promise<ApprovedHostKey> {
  wire.socket.write(`${CLIENT_VERSION}\r\n`);
  let serverVersion: string | null = null;
  for (let i = 0; i < MAX_BANNER_LINES && serverVersion === null; i++) {
    const line = await wire.line();
    if (line.startsWith("SSH-")) serverVersion = line;
  }
  if (!serverVersion || !/^SSH-(?:2\.0|1\.99)-[\x21-\x7e]+(?: [\x20-\x7e]*)?$/.test(serverVersion))
    throw new ScanFailure("PROTOCOL");
  const clientInit = kexInit(type.offer);
  wire.socket.write(packet(clientInit));
  const serverInit = await nextMessage(wire);
  if (serverInit[0] !== MSG_KEXINIT) throw new ScanFailure("PROTOCOL");

  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const clientPublic = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");
  wire.socket.write(
    packet(Buffer.concat([Buffer.from([MSG_KEX_ECDH_INIT]), sshString(clientPublic)])),
  );
  const reply = await nextMessage(wire);
  if (reply[0] !== MSG_KEX_ECDH_REPLY) throw new ScanFailure("PROTOCOL");
  const fields = new Reader(reply.subarray(1));
  const hostKey = fields.string();
  const serverPublic = fields.string();
  const signature = fields.string();
  if (!fields.done() || serverPublic.length !== 32) throw new ScanFailure("PROTOCOL");

  let shared: Buffer;
  try {
    shared = diffieHellman({
      privateKey,
      publicKey: createPublicKey({
        key: { kty: "OKP", crv: "X25519", x: b64url(serverPublic) },
        format: "jwk",
      }),
    });
  } catch {
    throw new ScanFailure("PROTOCOL");
  }
  if (shared.every((byte) => byte === 0)) throw new ScanFailure("PROTOCOL");
  const exchangeHash = createHash("sha256")
    .update(
      Buffer.concat([
        sshString(CLIENT_VERSION),
        sshString(serverVersion),
        sshString(clientInit),
        sshString(serverInit),
        sshString(hostKey),
        sshString(clientPublic),
        sshString(serverPublic),
        mpint(shared),
      ]),
    )
    .digest();
  shared.fill(0);
  // The server must prove it holds the private half of the key it presented.
  if (!verifyHostSignature(type.keyType, hostKey, signature, exchangeHash))
    throw new ScanFailure("PROTOCOL");
  try {
    return parseApprovedHostKeys([`${type.keyType} ${hostKey.toString("base64")}`])[0]!;
  } catch {
    throw new ScanFailure("PROTOCOL");
  }
}

export type SshConnect = (options: { host: string; port: number }) => Socket;

async function scanOne(
  target: { address: string; port: number },
  type: (typeof SCANNED_KEY_TYPES)[number],
  signal: AbortSignal,
  connect: SshConnect,
): Promise<{ key: ApprovedHostKey | null; reached: boolean }> {
  const socket = connect({ host: target.address, port: target.port });
  const wire = new Wire(socket);
  const abort = () => {
    wire.fail(new ScanFailure(wire.connected ? "PROTOCOL" : "UNREACHABLE"));
    socket.destroy();
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    return { key: await exchange(wire, type), reached: true };
  } catch {
    return { key: null, reached: wire.connected };
  } finally {
    signal.removeEventListener("abort", abort);
    socket.destroy();
  }
}

export type SshHostScan = { reachable: boolean; keys: ApprovedHostKey[] };

/** Scan the supported key types in parallel; every connection is bounded in time and bytes. */
export async function scanSshHostKeys(
  target: { address: string; port: number },
  options: { signal?: AbortSignal; timeoutMs?: number; connect?: SshConnect } = {},
): Promise<SshHostScan> {
  const signal = AbortSignal.any([
    AbortSignal.timeout(options.timeoutMs ?? SSH_SCAN_TIMEOUT_MS),
    ...(options.signal ? [options.signal] : []),
  ]);
  const connect: SshConnect = options.connect ?? ((o) => netConnect({ ...o, noDelay: true }));
  const results = await Promise.all(
    SCANNED_KEY_TYPES.map((type) => scanOne(target, type, signal, connect)),
  );
  const keys: ApprovedHostKey[] = [];
  for (const result of results)
    if (result.key && !keys.some((key) => key.fingerprint === result.key!.fingerprint))
      keys.push(result.key);
  return { reachable: results.some((result) => result.reached), keys };
}
