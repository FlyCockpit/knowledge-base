import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { removeDockerContainer } from "./docker.js";
import { NODE_BASE_IMAGE } from "./node-image.mjs";

describe("CIMD production TLS connection boundary", () => {
  it("blocks non-global DNS at a real IPv6 socket and preserves public exceptions", async () => {
    const suffix = randomBytes(4).toString("hex");
    const part = (Number.parseInt(randomBytes(2).toString("hex"), 16) || 1).toString(16);
    const networks = [`kb-r31b-blocked-${suffix}`, `kb-r31b-public-${suffix}`];
    const container = `kb-r31b-cimd-${suffix}`;
    const dir = mkdtempSync(resolve(tmpdir(), "kb-r31b-cimd-"));
    const root = resolve(import.meta.dirname, "../../../..");
    const blocked = `2001:100:${part}::2`;
    const allowed = `2001:3:${part}::2`;
    const docker = (...args: string[]) =>
      execFileSync("docker", args, {
        encoding: "utf8",
        timeout: 30_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
    try {
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          `${dir}/key.pem`,
          "-out",
          `${dir}/cert.pem`,
          "-days",
          "1",
          "-subj",
          "/CN=cimd-public.test",
          "-addext",
          "subjectAltName=DNS:cimd-public.test,DNS:cimd-blocked.test,DNS:cimd-mixed.test",
        ],
        { stdio: "ignore", timeout: 10_000 },
      );
      for (const [index, prefix] of ["2001:100", "2001:3"].entries())
        docker(
          "network",
          "create",
          "--ipv6",
          "--subnet",
          `${prefix}:${part}::/64`,
          networks[index]!,
        );
      docker(
        "create",
        "--name",
        container,
        "--network",
        networks[0]!,
        "--ip6",
        blocked,
        "--memory",
        "512m",
        "--cpus",
        "1",
        "--add-host",
        `cimd-blocked.test=${blocked}`,
        "--add-host",
        `cimd-public.test=${allowed}`,
        "--add-host",
        `cimd-wrong-name.test=${allowed}`,
        "--add-host",
        `cimd-mixed.test=${allowed}`,
        "--add-host",
        `cimd-mixed.test=${blocked}`,
        "-v",
        `${root}:/repo:ro`,
        "-v",
        `${dir}:/fixture:ro`,
        "-w",
        "/repo",
        "-e",
        "NODE_EXTRA_CA_CERTS=/fixture/cert.pem",
        NODE_BASE_IMAGE,
        "node",
        "--import",
        "tsx",
        "packages/test-utils/src/kb/cimd-tls-fixture.child.ts",
        "/fixture/cert.pem",
        "/fixture/key.pem",
        blocked,
        allowed,
      );
      docker("network", "connect", "--ip6", allowed, networks[1]!, container);
      const output = docker("start", "--attach", container);
      expect(docker("inspect", "--format", "{{.State.ExitCode}}", container).trim(), output).toBe(
        "0",
      );
      expect(JSON.parse(output.trim())).toMatchObject({
        blockedRequests: 0,
        publicSocket: allowed,
        requests: 5,
        tlsIdentity: "rejected",
        redirect: "not-followed",
        cancellation: "rejected",
        inFlightCancellation: "drained",
      });
    } finally {
      await removeDockerContainer(container);
      for (const network of networks) {
        try {
          docker("network", "rm", network);
        } catch {
          /* creation may have failed */
        }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
