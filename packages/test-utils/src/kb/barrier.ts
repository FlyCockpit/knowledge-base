import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { reapProcessTree, spawnProcessGroup, type TrackedChild } from "./process.js";

type Frame = { type: "arrive" | "release"; boundary: string };

export type CrashBarrier = {
  name: string;
  path: string;
  waitUntil(boundary: string): Promise<void>;
  release(boundary: string): Promise<void>;
  spawnChild(boundary: string, afterRelease?: string): TrackedChild;
  close(): Promise<void>;
};

type Arrival = {
  arrived: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
  settled: boolean;
};

function parseFrame(line: string): Frame | undefined {
  try {
    const value = JSON.parse(line) as Frame;
    if (
      (value.type === "arrive" || value.type === "release") &&
      typeof value.boundary === "string"
    ) {
      return value;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export async function createCrashBarrier(name: string): Promise<CrashBarrier> {
  const arrivals = new Map<string, Arrival>();
  const sockets = new Set<Socket>();

  const arrival = (boundary: string) => {
    const existing = arrivals.get(boundary);
    if (existing) return existing;
    let resolve = () => {};
    let reject = (_error: Error) => {};
    const arrived = new Promise<void>((next, fail) => {
      resolve = next;
      reject = fail;
    });
    const entry: Arrival = {
      arrived,
      resolve: () => {
        entry.settled = true;
        resolve();
      },
      reject: (error) => {
        entry.settled = true;
        reject(error);
      },
      settled: false,
    };
    arrivals.set(boundary, entry);
    return entry;
  };

  const server = createServer((socket) => {
    sockets.add(socket);
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const frame = parseFrame(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (frame?.type === "arrive") arrival(frame.boundary).resolve();
        newline = buffer.indexOf("\n");
      }
    });
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Barrier socket did not bind.");
  const path = `127.0.0.1:${address.port}`;

  return {
    name,
    path,
    waitUntil(boundary: string) {
      return arrival(boundary).arrived;
    },
    async release(boundary: string) {
      const payload = `${JSON.stringify({ type: "release", boundary })}\n`;
      for (const socket of sockets) socket.write(payload);
    },
    spawnChild(boundary: string, afterRelease = "") {
      const dir = mkdtempSync(join(tmpdir(), "kb-barrier-child-"));
      const file = join(dir, "child.mjs");
      const arrive = `${JSON.stringify({ type: "arrive", boundary })}\n`;
      writeFileSync(
        file,
        [
          'import net from "node:net";',
          `const socket = net.createConnection({ host: "127.0.0.1", port: ${address.port} });`,
          "await new Promise((resolve, reject) => {",
          '  socket.once("connect", resolve);',
          '  socket.once("error", reject);',
          "});",
          'let buffer = "";',
          "const released = new Promise((resolve, reject) => {",
          '  socket.on("data", (chunk) => {',
          '    buffer += chunk.toString("utf8");',
          `    if (buffer.includes('"release"') && buffer.includes(${JSON.stringify(boundary)})) resolve();`,
          "  });",
          '  socket.once("error", reject);',
          "});",
          `socket.write(${JSON.stringify(arrive)});`,
          "await released;",
          afterRelease,
          "process.exit(0);",
        ].join("\n"),
      );
      const child = spawnProcessGroup(process.execPath, [file], {
        detached: true,
        stdio: ["ignore", "ignore", "ignore"],
      });
      void child.done.then((result) => {
        rmSync(dir, { recursive: true, force: true });
        const pending = arrivals.get(boundary);
        if (pending && !pending.settled) {
          pending.reject(
            new Error(
              `barrier child exited before ${boundary} (code=${result.code}, signal=${result.signal})`,
            ),
          );
        }
      });
      return child;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export async function killStuckChild(child: TrackedChild): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
}> {
  return reapProcessTree(child, "SIGKILL");
}

export async function waitForChildExit(child: TrackedChild) {
  return child.done;
}
