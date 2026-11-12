import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const testIoGuardKey = Symbol.for("knowledge-base.test-io-guard");

describe("test I/O guard", () => {
  it("loads the non-restorable TCP guard before test imports", () => {
    const state = Reflect.get(globalThis, testIoGuardKey) as
      | { active?: unknown; connectionAttempts?: unknown }
      | undefined;

    expect(state?.active).toBe(true);
    expect(state?.connectionAttempts).toBe(0);
    expect(Reflect.get(net.Socket.prototype.connect, testIoGuardKey)).toBe(true);
  });

  it("lets a test reach its own Unix-domain socket without counting an attempt", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kb-io-guard-"));
    const socketPath = path.join(dir, "ipc");
    const server = net.createServer((socket) => socket.end("pong"));
    try {
      await new Promise<void>((resolve) => server.listen(socketPath, resolve));
      const reply = await new Promise<string>((resolve, reject) => {
        let body = "";
        const client = new net.Socket().connect(socketPath);
        client.on("data", (chunk) => {
          body += chunk;
        });
        client.on("end", () => resolve(body));
        client.on("error", reject);
      });
      expect(reply).toBe("pong");
      const state = Reflect.get(globalThis, testIoGuardKey) as { connectionAttempts: number };
      expect(state.connectionAttempts).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps child runners asynchronous without a fixed process timeout", () => {
    const source = readFileSync(fileURLToPath(import.meta.url), "utf8");
    const childProcessImports = Array.from(
      source.matchAll(/import\s+(.+?)\s+from\s+["']node:child_process["']/g),
      (match) => match[1],
    );
    expect(childProcessImports).toEqual(["{ spawn }"]);
    expect(source).not.toMatch(/\btimeout\s*:\s*[\d_]+/);
  });

  it("fails the suite when code catches a blocked TCP attempt", async ({
    task,
    signal,
    onTestFinished,
  }) => {
    const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const repoRoot = path.resolve(apiRoot, "../..");
    const vitestEntrypoint = path.join(repoRoot, "node_modules/vitest/vitest.mjs");
    const fixture = path.join(apiRoot, "src/test-io-guard-caught.fixture.ts");
    const config = path.join(repoRoot, "scripts/vitest-test-io-guard-fixture.config.ts");
    // Use Node's native TS config loader instead of starting esbuild and writing
    // a config bundle while other gate processes are using the shared disk.
    // TEST (flk14): runner startup is not the invariant. Use the configured outer
    // budget only as a hang watchdog, reserving time for close and diagnostics.
    const hangTimeout = Math.floor(task.timeout * 0.9);
    expect(hangTimeout).toBeGreaterThan(0);
    expect(hangTimeout).toBeLessThan(task.timeout);
    const child = spawn(
      process.execPath,
      [
        vitestEntrypoint,
        "run",
        fixture,
        "--config",
        config,
        "--configLoader",
        "native",
        "--no-color",
      ],
      { cwd: apiRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    let error: Error | undefined;
    let timedOut = false;
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    const stop = () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    };
    const watchdog = setTimeout(() => {
      timedOut = true;
      stop();
    }, hangTimeout);
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.on("error", (cause) => {
          error = cause;
        });
        child.once("close", (code, childSignal) => {
          clearTimeout(watchdog);
          signal.removeEventListener("abort", stop);
          resolve({ code, signal: childSignal });
        });
      },
    );
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    onTestFinished(async () => {
      stop();
      await closed;
    });
    const result = await closed;
    const diagnostics = `Child Vitest: ${JSON.stringify({ ...result, timedOut, hangTimeout, error: error?.message })}\nstdout:\n${stdout}\nstderr:\n${stderr}`;

    expect(error, diagnostics).toBeUndefined();
    expect(timedOut, diagnostics).toBe(false);
    expect(result.code, diagnostics).toBe(1);
    expect(result.signal, diagnostics).toBeNull();
    expect(`${stdout}${stderr}`, diagnostics).toContain(
      "Test I/O guard blocked 22 TCP connection attempt(s)",
    );
    expect(stdout, diagnostics).toMatch(/Tests\s+1 passed \(1\)/);
  }, 90_000);
});
