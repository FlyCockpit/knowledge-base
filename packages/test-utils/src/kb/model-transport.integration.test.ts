import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it("real model HTTPS transport pins sockets, verifies the original SAN, avoids pooled sockets and cancels", () => {
  const dir = mkdtempSync(join(tmpdir(), "kb-model-tls-"));
  try {
    const cert = join(dir, "fixture.pem");
    const key = join(dir, "fixture-key.pem");
    const generated = spawnSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-days",
        "1",
        "-nodes",
        "-subj",
        "/CN=huggingface.co",
        "-addext",
        "subjectAltName=DNS:huggingface.co,DNS:cdn-lfs.huggingface.co",
        "-keyout",
        key,
        "-out",
        cert,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(generated.status, generated.stderr).toBe(0);
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", join(import.meta.dirname, "model-tls-fixture.child.ts")],
      {
        cwd: resolve(import.meta.dirname, "../../../.."),
        env: {
          ...process.env,
          NODE_EXTRA_CA_CERTS: cert,
          KB_TEST_TLS_CERT: cert,
          KB_TEST_TLS_KEY: key,
        },
        encoding: "utf8",
        timeout: 20_000,
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "TLS pin/SAN/fresh-socket/pool/preabort/header-timeout/body-abort PASS",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
