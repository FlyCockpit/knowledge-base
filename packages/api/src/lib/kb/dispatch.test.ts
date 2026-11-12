import { Duplex } from "node:stream";
import { describe, expect, it } from "vitest";
import { listenForDispatchWake } from "./dispatch";

/** A transport that connects and then never answers the PostgreSQL handshake. */
class StalledSocket extends Duplex {
  setNoDelay() {}
  setKeepAlive() {}
  connect() {
    setImmediate(() => this.emit("connect"));
    return this;
  }
  override _read() {}
  override _write(_chunk: unknown, _encoding: BufferEncoding, done: () => void) {
    done();
  }
}
function stalledPostgres() {
  const sockets: StalledSocket[] = [];
  return {
    url: "postgres://user:pass@127.0.0.1:5432/db",
    stream: () => {
      const socket = new StalledSocket();
      sockets.push(socket);
      return socket;
    },
    connections: () => sockets.length,
    closed: () => sockets.filter((s) => s.destroyed).length,
    drop: () => {
      for (const socket of sockets) socket.destroy();
    },
  };
}
const until = async (check: () => boolean, ms = 3_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("listenForDispatchWake (R3-W4)", () => {
  it("close() cancels a stalled handshake at once instead of waiting for it", async () => {
    const pg = stalledPostgres();
    let wakes = 0;
    const listener = listenForDispatchWake(pg.url, () => (wakes += 1), {
      setupMs: 30_000,
      retryMs: 30_000,
      stream: pg.stream,
    });
    await until(() => pg.connections() === 1);
    const started = Date.now();
    await listener.close();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(pg.closed()).toBe(1);
    expect(wakes).toBe(0);
  });

  it("a stalled setup is bounded: the client is dropped and the listener retries", async () => {
    const pg = stalledPostgres();
    const listener = listenForDispatchWake(pg.url, () => {}, {
      setupMs: 100,
      retryMs: 20,
      stream: pg.stream,
    });
    try {
      await until(() => pg.connections() >= 3);
      expect(pg.closed()).toBeGreaterThanOrEqual(2);
    } finally {
      await listener.close();
    }
    expect(pg.closed()).toBe(pg.connections());
  });

  it("a dropped connection reconnects", async () => {
    const pg = stalledPostgres();
    const listener = listenForDispatchWake(pg.url, () => {}, {
      setupMs: 5_000,
      retryMs: 20,
      stream: pg.stream,
    });
    try {
      await until(() => pg.connections() === 1);
      pg.drop();
      await until(() => pg.connections() === 2);
    } finally {
      await listener.close();
    }
  });
});
