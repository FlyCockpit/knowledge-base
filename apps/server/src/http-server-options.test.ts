import { mkdtemp, rm } from "node:fs/promises";
import { Agent, createServer, request, type ServerOptions } from "node:http";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HEADERS_TIMEOUT_MS,
  httpServerOptions,
  KEEP_ALIVE_TIMEOUT_MS,
} from "./http-server-options";

// Upstream idle-reuse windows of the proxies the deploy docs support.
const CLOUDFLARED_KEEP_ALIVE_MS = 90_000;
const TRAEFIK_IDLE_CONN_MS = 90_000;

// An owned Unix socket: the test I/O guard blocks TCP, and HTTP keep-alive
// semantics are the same over either transport.
async function withServer<T>(
  options: ServerOptions,
  run: (socketPath: string, server: ReturnType<typeof createServer>) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "kb-http-options-"));
  const socketPath = join(dir, "http.sock");
  const server = createServer(options, (_req, res) => res.end("ok"));
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => sockets.add(socket));
  await new Promise<void>((done) => server.listen(socketPath, done));
  try {
    return await run(socketPath, server);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(dir, { recursive: true, force: true });
  }
}

/** A keep-alive agent that dials the socket by path only (the guard admits nothing else). */
function unixAgent(socketPath: string, maxSockets = Number.POSITIVE_INFINITY): Agent {
  const agent = new Agent({ keepAlive: true, maxSockets });
  agent.createConnection = () => connect({ path: socketPath });
  return agent;
}

function get(agent: Agent) {
  return new Promise<{ keepAlive: string; socket: Socket }>((done, fail) => {
    const req = request({ host: "localhost", path: "/", agent });
    req.on("response", (res) => {
      res.resume();
      res.on("end", () =>
        done({ keepAlive: String(res.headers["keep-alive"] ?? ""), socket: req.socket! }),
      );
    });
    req.on("error", fail);
    req.end();
  });
}

describe("httpServerOptions", () => {
  it("keeps idle sockets open longer than cloudflared and Traefik reuse them", () => {
    expect(KEEP_ALIVE_TIMEOUT_MS).toBeGreaterThan(CLOUDFLARED_KEEP_ALIVE_MS);
    expect(KEEP_ALIVE_TIMEOUT_MS).toBeGreaterThan(TRAEFIK_IDLE_CONN_MS);
    // The slow-header bound is not raised along with the idle window.
    expect(HEADERS_TIMEOUT_MS).toBeLessThan(KEEP_ALIVE_TIMEOUT_MS);
  });

  it("is applied by a Node server, which advertises the idle window upstream", async () => {
    await withServer(httpServerOptions, async (socketPath, server) => {
      expect(server.keepAliveTimeout).toBe(KEEP_ALIVE_TIMEOUT_MS);
      expect(server.headersTimeout).toBe(HEADERS_TIMEOUT_MS);
      const agent = unixAgent(socketPath);
      try {
        expect((await get(agent)).keepAlive).toBe(`timeout=${KEEP_ALIVE_TIMEOUT_MS / 1000}`);
      } finally {
        agent.destroy();
      }
    });
  });

  it("a headersTimeout below keepAliveTimeout does not close a reused idle socket", async () => {
    // Same ratio as production, scaled down: idle past the header bound, inside the idle window.
    // (Node's client agent drops a socket 1 s before the advertised timeout, so keep >= 6 s.)
    const scaled: ServerOptions = {
      keepAliveTimeout: 6_000,
      headersTimeout: 1_000,
      connectionsCheckingInterval: 50,
    };
    await withServer(scaled, async (socketPath) => {
      const agent = unixAgent(socketPath, 1);
      try {
        const first = await get(agent);
        await new Promise((done) => setTimeout(done, 2_500));
        const second = await get(agent);
        expect(second.socket).toBe(first.socket);
      } finally {
        agent.destroy();
      }
    });
  });
});
