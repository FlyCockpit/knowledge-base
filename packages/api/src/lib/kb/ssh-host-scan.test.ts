import {
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  type KeyObject,
  sign,
} from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, connect as netConnect, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { sshFingerprint } from "./deploy-key";
import { scanSshHostKeys } from "./ssh-host-scan";

/* A minimal in-process SSH server: banner, KEXINIT, curve25519 ECDH reply signed
 * with a real host key over the real exchange hash. Modes break one rule each. */

type Mode = "good" | "tamper" | "silent" | "flood" | "wrong-type" | "disconnect";

const str = (value: Buffer | string) => {
  const bytes = Buffer.from(value);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(bytes.length);
  return Buffer.concat([len, bytes]);
};
const mpint = (bytes: Buffer) => {
  let i = 0;
  while (i < bytes.length && bytes[i] === 0) i++;
  let body = bytes.subarray(i);
  if (body.length && body[0]! & 0x80) body = Buffer.concat([Buffer.from([0]), body]);
  return str(body);
};
const packet = (payload: Buffer) => {
  let pad = 8 - ((payload.length + 5) % 8);
  if (pad < 4) pad += 8;
  const len = Buffer.alloc(4);
  len.writeUInt32BE(payload.length + pad + 1);
  return Buffer.concat([len, Buffer.from([pad]), payload, Buffer.alloc(pad)]);
};
const b64u = (s: string) => Buffer.from(s, "base64url");

type HostKey = { type: string; blob: Buffer; sign: (h: Buffer) => Buffer };
function hostKeys(): Record<string, HostKey> {
  const ed = generateKeyPairSync("ed25519");
  const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const edJwk = ed.publicKey.export({ format: "jwk" });
  const ecJwk = ec.publicKey.export({ format: "jwk" });
  const rsaJwk = rsa.publicKey.export({ format: "jwk" });
  const signEc = (key: KeyObject, h: Buffer) => {
    const rs = sign("sha256", h, { key, dsaEncoding: "ieee-p1363" });
    return Buffer.concat([mpint(rs.subarray(0, 32)), mpint(rs.subarray(32))]);
  };
  return {
    "ssh-ed25519": {
      type: "ssh-ed25519",
      blob: Buffer.concat([str("ssh-ed25519"), str(b64u(edJwk.x!))]),
      sign: (h) => Buffer.concat([str("ssh-ed25519"), str(sign(null, h, ed.privateKey))]),
    },
    "ecdsa-sha2-nistp256": {
      type: "ecdsa-sha2-nistp256",
      blob: Buffer.concat([
        str("ecdsa-sha2-nistp256"),
        str("nistp256"),
        str(Buffer.concat([Buffer.from([4]), b64u(ecJwk.x!), b64u(ecJwk.y!)])),
      ]),
      sign: (h) => Buffer.concat([str("ecdsa-sha2-nistp256"), str(signEc(ec.privateKey, h))]),
    },
    "ssh-rsa": {
      type: "ssh-rsa",
      blob: Buffer.concat([str("ssh-rsa"), mpint(b64u(rsaJwk.e!)), mpint(b64u(rsaJwk.n!))]),
      sign: (h) => Buffer.concat([str("rsa-sha2-512"), str(sign("sha512", h, rsa.privateKey))]),
    },
  };
}

function serve(socket: Socket, keys: Record<string, HostKey>, mode: Mode) {
  if (mode === "silent") return;
  if (mode === "flood") {
    const line = Buffer.from(`${"x".repeat(200)}\r\n`);
    const pump = () => {
      while (!socket.destroyed && socket.write(line));
      if (!socket.destroyed) socket.once("drain", pump);
    };
    socket.on("error", () => {});
    pump();
    return;
  }
  const serverVersion = "SSH-2.0-FakeServer_1";
  socket.write(`${serverVersion}\r\n`);
  let buffer = Buffer.alloc(0);
  let clientVersion: string | null = null;
  let clientInit: Buffer | null = null;
  const serverInit = Buffer.concat([
    Buffer.from([20]),
    Buffer.alloc(16, 7),
    str("curve25519-sha256"),
    str(Object.keys(keys).join(",")),
    str("aes128-ctr"),
    str("aes128-ctr"),
    str("hmac-sha2-256"),
    str("hmac-sha2-256"),
    str("none"),
    str("none"),
    str(""),
    str(""),
    Buffer.alloc(5),
  ]);
  socket.on("error", () => {});
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (clientVersion === null) {
      const end = buffer.indexOf("\r\n");
      if (end < 0) return;
      clientVersion = buffer.subarray(0, end).toString("latin1");
      buffer = buffer.subarray(end + 2);
      socket.write(packet(serverInit));
    }
    while (buffer.length >= 4) {
      const len = buffer.readUInt32BE(0);
      if (buffer.length < len + 4) return;
      const pad = buffer[4]!;
      const payload = buffer.subarray(5, 4 + len - pad);
      buffer = buffer.subarray(len + 4);
      if (payload[0] === 20) {
        clientInit = Buffer.from(payload);
        if (mode === "disconnect") {
          socket.end(packet(Buffer.concat([Buffer.from([1]), Buffer.alloc(4), str(""), str("")])));
          return;
        }
      } else if (payload[0] === 30 && clientInit) {
        const qc = payload.subarray(5, 5 + payload.readUInt32BE(1));
        // The client offers one host-key type per connection; serve that one.
        const offered = clientInit.subarray(17);
        const kexLen = offered.readUInt32BE(0);
        const hkLen = offered.readUInt32BE(4 + kexLen);
        const asked = offered
          .subarray(8 + kexLen, 8 + kexLen + hkLen)
          .toString()
          .split(",")[0]!;
        const type = asked.startsWith("rsa-sha2") ? "ssh-rsa" : asked;
        const key =
          mode === "wrong-type" && type !== "ssh-ed25519" ? keys["ssh-ed25519"]! : keys[type]!;
        const eph = generateKeyPairSync("x25519");
        const qs = b64u(eph.publicKey.export({ format: "jwk" }).x!);
        const shared = diffieHellman({
          privateKey: eph.privateKey,
          publicKey: createPublicKey({
            key: { kty: "OKP", crv: "X25519", x: qc.toString("base64url") },
            format: "jwk",
          }),
        });
        const h = createHash("sha256")
          .update(
            Buffer.concat([
              str(clientVersion),
              str(serverVersion),
              str(clientInit),
              str(serverInit),
              str(key.blob),
              str(qc),
              str(qs),
              mpint(shared),
            ]),
          )
          .digest();
        const signature = key.sign(h);
        if (mode === "tamper") signature[signature.length - 1]! ^= 1;
        socket.write(
          packet(Buffer.concat([Buffer.from([31]), str(key.blob), str(qs), str(signature)])),
        );
      }
    }
  });
}

let server: Server | undefined;
const sockets = new Set<Socket>();
async function fakeServer(mode: Mode) {
  const keys = hostKeys();
  server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    serve(socket, keys, mode);
  });
  const path = join(socketDir, `ssh-${++socketCount}.sock`);
  await new Promise<void>((resolve) => server!.listen(path, resolve));
  return { path, keys };
}
// Unit tests never open TCP (the repo's test I/O guard): the fake server is a
// Unix socket, reached through the scanner's injectable connector.
const socketDir = mkdtempSync(join(tmpdir(), "kb-ssh-scan-"));
let socketCount = 0;
afterAll(() => rmSync(socketDir, { recursive: true, force: true }));
const target = { address: "203.0.113.7", port: 22 };
const via = (path: string, extra: { timeoutMs?: number } = {}) => ({
  ...extra,
  connect: () => netConnect({ path }),
});
afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

describe("SSH host-key scan", () => {
  it("returns each scanned key with its fingerprint once the server proves it holds it", async () => {
    const asked: { host: string; port: number }[] = [];
    const { path, keys } = await fakeServer("good");
    const scan = await scanSshHostKeys(target, {
      connect: (to) => {
        asked.push(to);
        return netConnect({ path });
      },
    });
    // One connection per key type, each to exactly the address it was given.
    expect(asked).toEqual(
      [target, target, target].map(({ address, port }) => ({ host: address, port })),
    );
    expect(scan.reachable).toBe(true);
    expect(scan.keys.map((k) => [k.algorithm, k.fingerprint])).toEqual(
      ["ssh-ed25519", "ecdsa-sha2-nistp256", "ssh-rsa"].map((type) => [
        type,
        sshFingerprint(keys[type]!.blob),
      ]),
    );
    expect(scan.keys[0]!.key).toBe(`ssh-ed25519 ${keys["ssh-ed25519"]!.blob.toString("base64")}`);
  });

  it("refuses keys whose exchange signature does not verify", async () => {
    const { path } = await fakeServer("tamper");
    expect(await scanSshHostKeys(target, via(path))).toEqual({
      reachable: true,
      keys: [],
    });
  });

  it("refuses a key of a different type than the one negotiated", async () => {
    const { path, keys } = await fakeServer("wrong-type");
    const scan = await scanSshHostKeys(target, via(path));
    expect(scan.keys.map((k) => k.fingerprint)).toEqual([
      sshFingerprint(keys["ssh-ed25519"]!.blob),
    ]);
  });

  it("treats a disconnect during negotiation as no key", async () => {
    const { path } = await fakeServer("disconnect");
    expect(await scanSshHostKeys(target, via(path))).toEqual({
      reachable: true,
      keys: [],
    });
  });

  it("reports a host nobody answers on as unreachable", async () => {
    expect(await scanSshHostKeys(target, via(join(socketDir, "nobody-listens.sock")))).toEqual({
      reachable: false,
      keys: [],
    });
  });

  it("gives up on a silent server within its time bound", async () => {
    const { path } = await fakeServer("silent");
    const started = Date.now();
    const scan = await scanSshHostKeys(target, via(path, { timeoutMs: 300 }));
    expect(scan.keys).toEqual([]);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("stops reading a server that floods banner lines", async () => {
    const { path } = await fakeServer("flood");
    const scan = await scanSshHostKeys(target, via(path, { timeoutMs: 3_000 }));
    expect(scan).toEqual({ reachable: true, keys: [] });
  });
});
