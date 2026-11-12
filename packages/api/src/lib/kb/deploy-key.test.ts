import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  decryptDeployKey,
  encryptDeployKey,
  generateDeployKey,
  parseApprovedHostKeys,
  renderOpenSshPrivateKey,
  sshFingerprint,
} from "./deploy-key";

const master = randomBytes(32);
const identity = { kbId: "a".repeat(24), remoteVersion: 3, keyVersion: 7 };

function sshString(value: Buffer | string): Buffer {
  const bytes = Buffer.from(value);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(bytes.length);
  return Buffer.concat([len, bytes]);
}
const ed25519Line = (pub = randomBytes(32)) =>
  `ssh-ed25519 ${Buffer.concat([sshString("ssh-ed25519"), sshString(pub)]).toString("base64")}`;

describe("generated Ed25519 deploy key", () => {
  it("produces an OpenSSH public key whose fingerprint is SHA256 over the blob", () => {
    const key = generateDeployKey();
    try {
      expect(key.publicKey).toMatch(/^ssh-ed25519 [A-Za-z0-9+/]+=*$/);
      const blob = Buffer.from(key.publicKey.split(" ")[1]!, "base64");
      expect(key.fingerprint).toBe(
        `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`,
      );
      expect(sshFingerprint(blob)).toBe(key.fingerprint);
    } finally {
      key.seed.destroy();
    }
  });

  it("never serializes or inspects the private seed", () => {
    const key = generateDeployKey();
    try {
      expect(() => JSON.stringify(key.seed)).toThrow();
      expect(inspect(key.seed)).not.toMatch(/[A-Za-z0-9+/]{20,}/);
      expect(
        JSON.stringify({ publicKey: key.publicKey, fingerprint: key.fingerprint }),
      ).not.toMatch(/PRIVATE/);
    } finally {
      key.seed.destroy();
    }
  });

  it.skipIf(!existsSync("/usr/bin/ssh-keygen"))(
    "renders an unencrypted openssh-key-v1 private key that ssh-keygen accepts",
    () => {
      const key = generateDeployKey();
      const dir = mkdtempSync(join(tmpdir(), "kb-deploy-key-"));
      try {
        const file = join(dir, "id");
        const pem = renderOpenSshPrivateKey(key.seed);
        writeFileSync(file, pem, { mode: 0o600 });
        pem.fill(0);
        const derived = execFileSync("/usr/bin/ssh-keygen", ["-y", "-f", file], {
          encoding: "utf8",
          env: {},
        }).trim();
        expect(derived.split(" ").slice(0, 2).join(" ")).toBe(key.publicKey);
      } finally {
        rmSync(dir, { recursive: true, force: true });
        key.seed.destroy();
      }
    },
  );
});

describe("versioned deploy-key encryption", () => {
  it("round-trips under the exact KB, remote version and key version", () => {
    const key = generateDeployKey();
    const ciphertext = encryptDeployKey(key.seed, identity, master);
    const back = decryptDeployKey(ciphertext, identity, master);
    try {
      expect(back.publicKey()).toBe(key.publicKey);
      expect(ciphertext).not.toContain(key.publicKey.split(" ")[1]);
    } finally {
      back.destroy();
      key.seed.destroy();
    }
  });

  it("fails when ciphertext is swapped between KBs, remote versions or key versions", () => {
    const key = generateDeployKey();
    const ciphertext = encryptDeployKey(key.seed, identity, master);
    key.seed.destroy();
    for (const other of [
      { ...identity, kbId: "b".repeat(24) },
      { ...identity, remoteVersion: identity.remoteVersion + 1 },
      { ...identity, keyVersion: identity.keyVersion + 1 },
    ])
      expect(() => decryptDeployKey(ciphertext, other, master)).toThrow();
    expect(() => decryptDeployKey(ciphertext, identity, randomBytes(32))).toThrow();
  });

  it("does not decrypt a ciphertext from another envelope purpose", async () => {
    const { encryptKbSecret } = await import("./envelope");
    const foreign = JSON.stringify(
      encryptKbSecret(
        randomBytes(32),
        {
          aadVersion: 1,
          purpose: "provider-secret",
          userId: identity.kbId,
          objectId: String(identity.remoteVersion),
          revision: String(identity.keyVersion),
        },
        master,
      ),
    );
    expect(() => decryptDeployKey(foreign, identity, master)).toThrow();
  });
});

describe("approved SSH host public keys", () => {
  it("stores the full key and an independently computed SHA256 fingerprint", () => {
    const line = ed25519Line();
    const [parsed] = parseApprovedHostKeys([line]);
    const blob = Buffer.from(line.split(" ")[1]!, "base64");
    expect(parsed).toEqual({
      algorithm: "ssh-ed25519",
      key: line,
      fingerprint: `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`,
    });
  });

  it("rejects fingerprint-only entries, known_hosts host patterns, options and mismatched blobs", () => {
    const line = ed25519Line();
    for (const bad of [
      [],
      ["SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU"],
      [`github.com ${line}`],
      [`@cert-authority * ${line}`],
      [`${line} comment`],
      [`ssh-rsa ${line.split(" ")[1]}`],
      ["ssh-ed25519 not-base64!"],
      [
        `ssh-ed25519 ${Buffer.concat([sshString("ssh-ed25519"), sshString(randomBytes(31))]).toString("base64")}`,
      ],
      [
        `ssh-dss ${Buffer.concat([sshString("ssh-dss"), sshString(randomBytes(64))]).toString("base64")}`,
      ],
      [`${line}\n${line}`],
      [line, line],
      Array.from({ length: 9 }, () => ed25519Line()),
    ])
      expect(() => parseApprovedHostKeys(bad), JSON.stringify(bad)).toThrow();
  });

  it("accepts several distinct keys for one host", () => {
    expect(parseApprovedHostKeys([ed25519Line(), ed25519Line()])).toHaveLength(2);
  });
});
