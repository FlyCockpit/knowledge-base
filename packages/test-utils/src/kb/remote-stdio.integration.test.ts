/** Real official SDK -> CLI stdio -> kb-client -> official SDK HTTP. */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { KB_TOOL_NAMES } from "@knowledge-base/api/lib/kb/protocol/catalog";
import fixtures from "@knowledge-base/api/lib/kb/protocol/fixtures.json" with { type: "json" };
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ClientInteropFixture, startClientInteropFixture } from "./client-interop";
import { callResult, remotePeer } from "./parity";

const binary = resolve(import.meta.dirname, "../../../../apps/cli/target/debug/kb");
const root = mkdtempSync(join(tmpdir(), "kb-remote-stdio-"));
let server: ClientInteropFixture;
let remote: Awaited<ReturnType<typeof remotePeer>>;
const token = `kb_pat_remote_${randomBytes(16).toString("hex")}`;
const tools = fixtures.tools;
beforeAll(async () => {
  server = await startClientInteropFixture(token, { fullCatalog: true });
  remote = await remotePeer(binary, root, server.resource, token);
}, 120000);
afterAll(async () => {
  await remote?.close();
  await server?.close();
  rmSync(root, { recursive: true, force: true });
});
describe("remote stdio common data plane", () => {
  it("full pinned schema catalog and every malformed-input row reject before HTTP", async () => {
    const catalog = await remote.list();
    expect(catalog.tools.map((t) => t.name)).toEqual([...KB_TOOL_NAMES]);
    const before = server.requests.length;
    for (const name of KB_TOOL_NAMES) {
      for (const invalid of tools[name].invalidInputs) {
        const r = await remote.call(name, invalid.value);
        expect(r.structuredContent.error?.code, name).toBe("INVALID_ARGUMENT");
      }
    }
    await expect(remote.unsupported()).rejects.toMatchObject({ code: -32601 });
    expect(server.requests.length).toBe(before);
  }, 120000);
  it("lost mutation reply is unknown; identical-key retry produces one effect", async () => {
    const name = "knowledge_documents_create";
    const input = { ...tools[name].validInput, idempotencyKey: "remote-lost-reply-0001" };
    const lost = await remote.call(name, input);
    expect(lost.isError).toBe(true);
    expect(lost.structuredContent.error?.code).toBe("STORAGE_UNAVAILABLE");
    expect(server.mutationKeys).toHaveLength(1);
    const retried = await remote.call(name, input);
    expect(retried.structuredContent.data).toEqual(tools[name].validOutput);
    expect(server.mutationKeys).toEqual([input.idempotencyKey, input.idempotencyKey]);
    expect(server.mutationEffects).toBe(1);
    expect(remote.diagnostics()).toContain("same idempotency key");
  });
  it("read/search/propose/PR/upload/export/structured/sealed all reach the exact backend without changing results", async () => {
    for (const name of KB_TOOL_NAMES.filter(
      (n) => n !== "knowledge_index_status" && n !== "knowledge_documents_create",
    )) {
      const r = await remote.call(name, tools[name].validInput);
      expect(r.isError, name).toBe(false);
      expect(r.structuredContent.data, name).toEqual(tools[name].validOutput);
      expect(JSON.parse(r.content[0]!.text)).toEqual(r.structuredContent);
      expect(server.requests.at(-1)?.body.params).toMatchObject({
        name,
        arguments: tools[name].validInput,
      });
    }
    const sealed = await remote.call(
      "knowledge_sealed_resolve",
      tools.knowledge_sealed_resolve.validInput,
    );
    expect(sealed.structuredContent.data).toEqual(tools.knowledge_sealed_resolve.validOutput);
    expect(JSON.stringify(sealed)).not.toContain("disposable-sealed-plaintext");
    expect(remote.diagnostics()).not.toContain(token);
    const unresolved = await remote.call("knowledge_sealed_resolve", {
      ...tools.knowledge_sealed_resolve.validInput,
      path: "missing.md",
    });
    expect(unresolved.structuredContent.error).toMatchObject({
      code: "UNRESOLVED_REFERENCE",
      retryable: false,
      details: {},
    });
  });
  it("cancel reaches HTTP, drains, then the same stdio session admits another read", async () => {
    const abort = new AbortController();
    const call = remote.peer.request(
      {
        method: "tools/call",
        params: {
          name: "knowledge_index_status",
          arguments: tools.knowledge_index_status.validInput,
        },
      },
      { signal: abort.signal },
    );
    const caught = call.catch((error) => error);
    for (
      let i = 0;
      i < 300 && !server.requests.some((r) => r.body.params?.name === "knowledge_index_status");
      i++
    )
      await new Promise((r) => setTimeout(r, 10));
    expect(server.requests.some((r) => r.body.params?.name === "knowledge_index_status")).toBe(
      true,
    );
    abort.abort(new Error("remote cancellation"));
    // This pinned SDK wraps AbortSignal.reason using String(Error), and its
    // caller-side cancellation error uses REQUEST_TIMEOUT. HTTP drain below
    // discriminates actual cancellation from an elapsed request timer.
    await expect(caught).resolves.toMatchObject({
      code: "REQUEST_TIMEOUT",
      message: "Error: remote cancellation",
    });
    for (let i = 0; i < 300 && server.aborted.length === 0; i++)
      await new Promise((r) => setTimeout(r, 10));
    expect(server.aborted).toEqual(["knowledge_index_status"]);
    expect((await remote.call("knowledge_bases_list", {})).isError).toBe(false);
    await remote.close();
    remote = await remotePeer(binary, root, server.resource, token);
    expect((await remote.call("knowledge_bases_list", {})).isError).toBe(false);
    // Re-entry includes a private credential import (120s owned watchdog),
    // separate from the abort/HTTP-drain assertions above.
  }, 180000);
  it("the stdio deadline aborts the owning HTTP request and permits a later read", async () => {
    const before = server.aborted.length;
    const reply = callResult.parse(
      await remote.peer.request(
        {
          method: "tools/call",
          params: {
            name: "knowledge_index_status",
            arguments: tools.knowledge_index_status.validInput,
          },
        },
        { timeout: 130000 },
      ),
    );
    expect(reply.structuredContent.error?.code).toBe("DEADLINE_EXCEEDED");
    for (let i = 0; i < 300 && server.aborted.length === before; i++)
      await new Promise((r) => setTimeout(r, 10));
    expect(server.aborted.length).toBe(before + 1);
    expect((await remote.call("knowledge_bases_list", {})).isError).toBe(false);
  }, 140000);
  it("EOF and termination drain an active HTTP call before CLI exit", async () => {
    for (const termination of [false, true]) {
      const owned = await remotePeer(binary, root, server.resource, token);
      try {
        const before = server.aborted.length;
        const requests = server.requests.length;
        const pending = owned
          .call("knowledge_index_status", tools.knowledge_index_status.validInput)
          .catch((error: unknown) => error);
        for (let i = 0; i < 300 && server.requests.length === requests; i++)
          await new Promise((r) => setTimeout(r, 10));
        expect(server.requests.at(-1)?.body.params?.name).toBe("knowledge_index_status");
        if (termination) owned.child.kill("SIGTERM");
        else owned.child.stdin.end();
        await pending;
        await owned.close();
        expect(server.aborted.length).toBe(before + 1);
        expect(owned.child.exitCode).toBe(0);
      } finally {
        await owned.peer.close();
      }
    }
    expect((await remote.call("knowledge_bases_list", {})).isError).toBe(false);
    // Two independent CLI launches/imports retain their own I/O watchdogs.
  }, 300000);
  it("explicit proxy uses CONNECT, verifies origin TLS, and never sends the bearer outside the tunnel", async () => {
    const sockets = new Set<Socket>();
    const tunnels: string[] = [];
    const proxy = createServer();
    proxy.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    proxy.on("connect", (request, socket, head) => {
      tunnels.push(request.url!);
      expect(request.headers.authorization).toBeUndefined();
      expect(request.headers["proxy-authorization"]).toBeUndefined();
      const upstream = connect(Number(request.url!.split(":")[1]), "127.0.0.1", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        upstream.write(head);
        socket.pipe(upstream).pipe(socket);
      });
      sockets.add(upstream);
      upstream.on("close", () => {
        sockets.delete(upstream);
        socket.destroy();
      });
      upstream.on("error", () => socket.destroy());
      socket.on("close", () => upstream.destroy());
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("proxy port missing");
    const binary = resolve(import.meta.dirname, "../../../../apps/cli/target/debug/kb");
    try {
      for (const mode of ["trusted", "wrong-host", "untrusted"]) {
        const dir = join(root, `tls-${mode}`);
        mkdirSync(dir);
        const cert = join(dir, "cert.pem");
        const key = join(dir, "key.pem");
        const trustDir = join(dir, "trust-roots");
        mkdirSync(trustDir);
        // A valid but unrelated trust anchor forces an actual TLS rejection;
        // a missing cert file can instead fail during client construction.
        for (const prefix of mode === "untrusted" ? ["cert", "unrelated"] : ["cert"]) {
          execFileSync(
            "openssl",
            [
              "req",
              "-x509",
              "-newkey",
              "rsa:2048",
              "-nodes",
              "-keyout",
              prefix === "cert" ? key : join(dir, `${prefix}-key.pem`),
              "-out",
              join(dir, `${prefix}.pem`),
              "-days",
              "1",
              "-subj",
              "/CN=fixture",
              "-addext",
              "basicConstraints=critical,CA:FALSE",
              "-addext",
              mode === "wrong-host"
                ? "subjectAltName=DNS:wrong.invalid"
                : "subjectAltName=IP:127.0.0.1",
            ],
            { stdio: "ignore" },
          );
        }
        const tls = await startClientInteropFixture(token, {
          fullCatalog: true,
          tls: { key: readFileSync(key), cert: readFileSync(cert) },
        });
        mkdirSync(join(dir, "config"));
        writeFileSync(
          join(dir, "config/config.toml"),
          `proxy = "http://127.0.0.1:${address.port}"\n`,
        );
        const before = tunnels.length;
        try {
          if (mode === "trusted") {
            const peer = await remotePeer(binary, dir, tls.resource, token, {
              SSL_CERT_FILE: cert,
              SSL_CERT_DIR: trustDir,
            });
            expect((await peer.call("knowledge_bases_list", {})).isError).toBe(false);
            await peer.close();
          } else {
            await expect(
              remotePeer(binary, dir, tls.resource, token, {
                SSL_CERT_FILE: mode === "untrusted" ? join(dir, "unrelated.pem") : cert,
                SSL_CERT_DIR: trustDir,
              }),
            ).rejects.toThrow(/failed to verify TLS certificate/);
            expect(tls.requests).toEqual([]);
          }
          // Discovery/list/read reuse a connection; require CONNECT for each
          // mode without assuming one tunnel per HTTP request.
          expect(tunnels.length).toBeGreaterThan(before);
        } finally {
          await tls.close();
        }
      }
      expect(tunnels.length).toBeGreaterThanOrEqual(3);
    } finally {
      for (const socket of sockets) socket.destroy();
      proxy.close();
      await once(proxy, "close");
    }
  }, 180000);
});
