import net from "node:net";

import { describe, expect, it } from "vitest";

const testIoGuardKey = Symbol.for("knowledge-base.test-io-guard");

describe("test I/O guard caught-attempt fixture", () => {
  it("catches only the verified guard replacement", async () => {
    const guardedConnect = net.Socket.prototype.connect;

    // Do not call a native connect function if setup/configuration is absent.
    expect(Reflect.get(guardedConnect, testIoGuardKey)).toBe(true);
    expect(() => Reflect.apply(guardedConnect, {}, [])).toThrow("Test I/O guard blocked a TCP");
    // TCP shapes stay blocked even beside a Unix-socket allowance: options with a port,
    // a bare port, and the normalized array `net.connect` passes.
    expect(() =>
      Reflect.apply(guardedConnect, {}, [{ host: "127.0.0.1", port: 5432, path: "/tmp/x" }]),
    ).toThrow("Test I/O guard blocked a TCP");
    expect(() => Reflect.apply(guardedConnect, {}, [6379, "127.0.0.1"])).toThrow(
      "Test I/O guard blocked a TCP",
    );
    expect(() => Reflect.apply(guardedConnect, {}, [[{ port: 6379 }, null]])).toThrow(
      "Test I/O guard blocked a TCP",
    );
    // Historical-fault runs can only reach this reviewer-owned TCP listener.
    const listener = net.createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const address = listener.address();
    if (address === null || typeof address === "string") throw new Error("Missing fixture port");
    const sockets: net.Socket[] = [];
    const connect = (
      fn: typeof net.Socket.prototype.connect | typeof net.connect,
      receiver: unknown,
      port: string,
    ) => {
      const socket = Reflect.apply(fn, receiver, [port, "127.0.0.1"]);
      if (socket instanceof net.Socket) {
        sockets.push(socket);
        socket.on("error", () => {});
      }
      return socket;
    };
    try {
      for (const port of [
        String(address.port),
        ` ${address.port} `,
        `0x${address.port.toString(16)}`,
        `${address.port}e0`,
        "",
        " ",
      ]) {
        const socket = new net.Socket();
        sockets.push(socket);
        expect(() => connect(guardedConnect, socket, port)).toThrow("Test I/O guard blocked a TCP");
        expect(() => connect(net.connect, net, port)).toThrow("Test I/O guard blocked a TCP");
        expect(() => connect(net.createConnection, net, port)).toThrow(
          "Test I/O guard blocked a TCP",
        );
      }
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
  });
});
