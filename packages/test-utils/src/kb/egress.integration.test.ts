import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DnsLookupFn, kbHttpsRequest } from "@knowledge-base/api/lib/kb/egress";
import {
  encryptKbSecretWithEnvKey,
  KbEncryptionUnavailableError,
  requireKbMasterKey,
} from "@knowledge-base/api/lib/kb/envelope";
import { validateKbMasterKeyFormat } from "@knowledge-base/env/kb-master-key";
import { sharedVars } from "@knowledge-base/env/vars/shared";
import { webVars } from "@knowledge-base/env/vars/web";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../../../..");

describe("kb encryption and env surfaces", () => {
  it("keeps KB_MASTER_KEY on the shared server/worker schema only", () => {
    expect(Object.keys(sharedVars)).toContain("KB_MASTER_KEY");
    expect(Object.keys(webVars)).not.toContain("KB_MASTER_KEY");
    for (const key of Object.keys(webVars)) {
      expect(key.startsWith("VITE_")).toBe(true);
    }
  });

  it("requires a configured master key before encrypting secrets", () => {
    const identity = {
      aadVersion: 1,
      purpose: "share-email" as const,
      userId: "user-a",
      objectId: "invite-1",
      revision: "1",
    };
    expect(() => encryptKbSecretWithEnvKey("secret@example.com", identity, undefined)).toThrow(
      KbEncryptionUnavailableError,
    );
    const key = randomBytes(32).toString("base64");
    expect(validateKbMasterKeyFormat(key).ok).toBe(true);
    const record = encryptKbSecretWithEnvKey("secret@example.com", identity, key);
    expect(record.ciphertext).not.toContain("secret@example.com");
  });

  it("runtime schema, canonical validator, and encryption helper agree on key format", () => {
    const valid = randomBytes(32).toString("base64");
    const malformed = [
      // Permissive base64 that still decodes to 32 bytes: a length-only
      // schema check accepts it, the canonical validator must not.
      `!${valid}`,
      `x${valid.slice(1)}`,
      `${valid.slice(0, 21)} ${valid.slice(21)}`,
      Buffer.alloc(16).toString("base64"),
      "0".repeat(64),
      "  ",
    ];
    for (const value of [valid, ...malformed]) {
      const schemaAccepts = sharedVars.KB_MASTER_KEY!.safeParse(value).success;
      const validatorAccepts = validateKbMasterKeyFormat(value).ok;
      expect(
        schemaAccepts,
        `schema vs validator disagreement for a ${value.length}-char input`,
      ).toBe(validatorAccepts);
      // The encryption path enforces the same outcome: a key the schema
      // rejects never becomes an encryption-unavailable surprise later.
      let encryptionThrew = false;
      try {
        requireKbMasterKey(value);
      } catch {
        encryptionThrew = true;
      }
      expect(encryptionThrew).toBe(!validatorAccepts);
      // Rejection reasons never echo the supplied value.
      const validation = validateKbMasterKeyFormat(value);
      const trimmed = value.trim();
      if (!validation.ok && trimmed.length > 0) {
        expect(validation.reason).not.toContain(trimmed);
      }
    }
  });

  it("ships a standalone KB_MASTER_KEY validator in server and worker images", () => {
    const entrypoint = readFileSync(join(ROOT, "scripts/docker-entrypoint.sh"), "utf8");
    expect(entrypoint).toContain("/app/scripts/lib/validate-kb-master-key.mjs");
    expect(entrypoint).not.toContain("@knowledge-base/env/kb-master-key");
    for (const dockerfile of ["Dockerfile", "Dockerfile.worker"]) {
      const text = readFileSync(join(ROOT, dockerfile), "utf8");
      expect(text).toContain("scripts/lib/validate-kb-master-key.mjs");
    }
  });

  it("runtime validator accepts a disposable key and rejects invalid shapes", () => {
    const script = join(ROOT, "scripts/lib/validate-kb-master-key.mjs");
    const key = randomBytes(32).toString("base64");
    const parity = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { validateKbMasterKeyFormat } from ${JSON.stringify(script)};
         console.log(JSON.stringify(validateKbMasterKeyFormat(${JSON.stringify(key)})));`,
      ],
      { encoding: "utf8" },
    );
    expect(parity.status).toBe(0);
    // The child prints the JSON projection of { ok: true, bytes: Buffer };
    // a real Buffer never deep-equals its { type: "Buffer", data: [...] }
    // projection, so compare JSON projections on both sides.
    expect(JSON.parse(parity.stdout.trim())).toEqual(
      JSON.parse(JSON.stringify(validateKbMasterKeyFormat(key))),
    );
    const ok = spawnSync(process.execPath, [script], {
      env: { ...process.env, KB_MASTER_KEY: key },
      encoding: "utf8",
    });
    expect(ok.status).toBe(0);
    const bad = spawnSync(process.execPath, [script], {
      env: { ...process.env, KB_MASTER_KEY: "not-valid" },
      encoding: "utf8",
    });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/FATAL/u);
    expect(`${bad.stderr}${bad.stdout}`).not.toContain(key);
  });
});

describe("kb egress default transport — pool isolation, TLS identity, redirects and body limits", () => {
  type CaseOutcome = {
    name: string;
    ok: boolean;
    body?: string;
    statusCode?: number;
    lookupCalls: number;
    error?: string;
  };

  it("enforces pool, redirect, TLS identity and raw response bounds", () => {
    // The fixture certificate is disposable: generated into tmpdir for the
    // lifetime of this test, deleted right after, never a real credential.
    const dir = mkdtempSync(join(tmpdir(), "kb-egress-tls-"));
    try {
      const certPath = join(dir, "fixture-cert.pem");
      const keyPath = join(dir, "fixture-key.pem");
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
          "/CN=egress-fixture.test",
          "-addext",
          "subjectAltName=DNS:egress-fixture.test,IP:93.184.216.34,IP:2606:4700::1111",
          "-keyout",
          keyPath,
          "-out",
          certPath,
        ],
        { encoding: "utf8" },
      );
      expect(
        generated.status === 0,
        `openssl fixture certificate generation failed: ${generated.stderr}`,
      ).toBe(true);

      // NODE_EXTRA_CA_CERTS must exist at process start, so the fixture child
      // runs in its own process that trusts the disposable root.
      const child = spawnSync(
        process.execPath,
        ["--import", "tsx", join(import.meta.dirname, "egress-tls-fixture.child.ts")],
        {
          cwd: ROOT,
          encoding: "utf8",
          timeout: 60_000,
          env: {
            ...process.env,
            NODE_EXTRA_CA_CERTS: certPath,
            KB_TEST_TLS_CERT: certPath,
            KB_TEST_TLS_KEY: keyPath,
          },
        },
      );
      expect(child.status === 0, `fixture child failed: ${child.stderr}`).toBe(true);
      const result = JSON.parse(child.stdout.trim().split("\n").at(-1) ?? "{}");
      const { pool, outcomes }: { pool: Record<string, unknown>; outcomes: CaseOutcome[] } = result;
      expect(pool).toEqual({
        primeBody: "fixture-body",
        poolPrimed: true,
        primedAddress: "127.0.0.1",
        rejected: true,
        lookupCalls: 1,
        // Only the ordinary priming request reaches the private peer. The KB
        // request sends neither its Authorization header nor any body bytes.
        requestsReceived: 1,
        authorizationRequests: 0,
        bodyBytes: 0,
      });
      const byName = new Map(outcomes.map((outcome) => [outcome.name, outcome]));

      const v4 = byName.get("v4-literal-ip-san");
      expect(v4?.ok).toBe(true);
      expect(v4?.body).toBe("fixture-body");
      expect(v4?.statusCode).toBe(200);
      // IP literals connect without any DNS resolution.
      expect(v4?.lookupCalls).toBe(0);

      const v6 = byName.get("v6-literal-ip-san");
      expect(v6?.ok).toBe(true);
      expect(v6?.body).toBe("fixture-body");
      expect(v6?.lookupCalls).toBe(0);

      // Identity follows the pinned servername, not the dialed IP.
      const pinned = byName.get("hostname-pinned-dns-san");
      expect(pinned?.ok).toBe(true);
      expect(pinned?.body).toBe("fixture-body");

      // A name absent from the certificate fails the handshake — the same
      // server and URL succeed only when the identity is listed.
      expect(byName.get("hostname-mismatch-rejected")?.ok).toBe(false);

      // Dialing the same fixture socket never overrides public IP identity.
      expect(byName.get("v4-ip-mismatch-rejected")?.ok).toBe(false);
      expect(byName.get("v6-ip-mismatch-rejected")?.ok).toBe(false);

      expect(result.redirects).toEqual(
        [302, 307].map((statusCode) => ({
          statusCode,
          rejected: true,
          error: "Outbound request failed",
          responseClosed: true,
          responseDestroyed: true,
          responseEnded: false,
        })),
      );
      expect(result.redirectRequests).toEqual(
        [302, 307].map((statusCode) => ({
          statusCode,
          method: "POST",
          authorization: "Bearer disposable-redirect-token-canary",
          body: "disposable-redirect-body-canary",
        })),
      );
      expect(result.destination).toEqual({
        requestsReceived: 0,
        authorizationRequests: 0,
        bodyBytes: 0,
      });
      expect(result.bounds).toEqual(
        ["ascii", "multibyte", "incomplete-utf16"].flatMap((name) =>
          ["direct", "reader-default", "reader-larger"].map((consumer) => ({
            name,
            consumer,
            rejected: true,
            error: "Outbound request failed",
            deliveredBytes: 0,
            responseDestroyed: true,
            responseClosed: true,
            sourceDestroyed: true,
            sourceEnded: false,
          })),
        ),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("kb egress default transport — cancellation", () => {
  it("performs zero DNS/connect/write work for a pre-aborted request", async () => {
    let lookupCalls = 0;
    const lookup: DnsLookupFn = (_hostname, _options, callback) => {
      lookupCalls += 1;
      callback(null, [{ address: "93.184.216.34", family: 4 }]);
    };
    const controller = new AbortController();
    controller.abort();
    await expect(
      kbHttpsRequest(
        "https://abort.test/v1",
        {
          method: "POST",
          body: new Uint8Array([1]),
          providerBearerToken: "never-sent-canary",
          signal: controller.signal,
        },
        { timeoutMs: 2000 },
        { lookup },
      ),
    ).rejects.toThrow("Outbound request failed");
    expect(lookupCalls).toBe(0);
  });

  it("destroys the in-flight request when aborted while DNS is pending", async () => {
    let lookupCalls = 0;
    const lookup: DnsLookupFn = () => {
      // Never answers: the request stays in the DNS phase, so no TCP socket
      // is ever opened and only the caller abort can end this request.
      lookupCalls += 1;
    };
    const controller = new AbortController();
    const startedAt = Date.now();
    const pending = kbHttpsRequest(
      "https://hang.test/v1",
      { method: "GET", signal: controller.signal },
      { timeoutMs: 5000 },
      { lookup },
    );
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toThrow("Outbound request failed");
    expect(lookupCalls).toBe(1);
    // The abort must end the request promptly — not by riding the 5 s deadline.
    expect(Date.now() - startedAt).toBeLessThan(1500);
  });
});
