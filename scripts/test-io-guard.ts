import net from "node:net";

import { afterAll } from "vitest";

const testIoGuardKey = Symbol.for("knowledge-base.test-io-guard");

type TestIoGuardState = {
  active: true;
  connectionAttempts: number;
};

const existingState = Reflect.get(globalThis, testIoGuardKey);
const state: TestIoGuardState =
  typeof existingState === "object" &&
  existingState !== null &&
  Reflect.get(existingState, "active") === true &&
  typeof Reflect.get(existingState, "connectionAttempts") === "number"
    ? (existingState as TestIoGuardState)
    : { active: true, connectionAttempts: 0 };

if (existingState === undefined) {
  Object.defineProperty(globalThis, testIoGuardKey, {
    configurable: false,
    enumerable: false,
    value: state,
    writable: false,
  });

  const nativeConnect = net.Socket.prototype.connect;
  // Only a Unix-domain (path) connection passes: a test that owns a local IPC socket
  // (for example the push-context hook socket) is not network I/O. Every other shape
  // — port/host options, a bare port, missing arguments — stays blocked. `net.connect`
  // hands the prototype an already-normalized `[options, listener]` array.
  const unixSocketPath = (args: unknown[]): string | undefined => {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    // Node's isPipeName uses Number(s) >= 0, including whitespace, hex and
    // exponential port strings. Only strings it treats as paths may pass.
    if (typeof first === "string")
      return Number(first) >= 0 || first.length === 0 ? undefined : first;
    if (typeof first !== "object" || first === null) return undefined;
    const path = Reflect.get(first, "path");
    const port = Reflect.get(first, "port");
    return typeof path === "string" && path.length > 0 && port === undefined ? path : undefined;
  };
  const guardedConnect = function testIoGuardedSocketConnect(this: net.Socket, ...args: unknown[]) {
    if (unixSocketPath(args) !== undefined) return Reflect.apply(nativeConnect, this, args);
    state.connectionAttempts += 1;
    throw new Error("Test I/O guard blocked a TCP socket connection.");
  };
  Object.defineProperty(guardedConnect, testIoGuardKey, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
  Object.defineProperty(net.Socket.prototype, "connect", {
    configurable: false,
    enumerable: false,
    value: guardedConnect,
    writable: false,
  });
}

// Queue producers create a TCP connection while their barrel is evaluated.
// This direct prototype replacement blocks that connection before a socket
// exists, including when a dependency was externalized past Vitest's module
// mocks. It is deliberately not a general network or subprocess sandbox.
// `vi.restoreAllMocks()` cannot restore this non-Vitest replacement.
afterAll(() => {
  if (state.connectionAttempts !== 0) {
    throw new Error(
      `Test I/O guard blocked ${state.connectionAttempts} TCP connection attempt(s); mock the import boundary.`,
    );
  }
});
