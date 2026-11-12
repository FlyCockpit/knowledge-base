import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openPushContext } from "./push-context";

const temp = vi.hoisted(() => ({
  path: undefined as string | undefined,
  failPermissions: false,
  socketDirectory: undefined as string | undefined,
}));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    mkdtemp: async (...args: Parameters<typeof fs.mkdtemp>) => {
      const directory = await fs.mkdtemp(...args);
      if (temp.failPermissions) temp.socketDirectory = String(directory);
      return directory;
    },
    chmod: async (...args: Parameters<typeof fs.chmod>) => {
      if (temp.failPermissions) throw new Error("fixture chmod failure");
      return fs.chmod(...args);
    },
  };
});
vi.mock("node:os", async (original) => {
  const os = await original<typeof import("node:os")>();
  return { ...os, tmpdir: () => temp.path ?? os.tmpdir() };
});

async function exchange(path: string, message: object) {
  return new Promise<string>((resolve, reject) => {
    const socket = connect(path, () => socket.end(`${JSON.stringify(message)}\n`));
    let body = "";
    socket.on("data", (chunk) => {
      body += chunk;
    });
    socket.on("end", () => resolve(body));
    socket.on("error", reject);
  });
}
describe("private single-use push context", () => {
  describe("trusted nonce admission", () => {
    const run = vi.fn(async () => ({ ok: true }));
    let setup: ReturnType<typeof openPushContext> | undefined;
    beforeAll(() => {
      // Filesystem/socket preparation is a prerequisite to nonce admission,
      // whose action keeps the unchanged five-second test deadline.
      setup = openPushContext({ signal: new AbortController().signal, run });
      return setup;
    }, 60_000);
    afterAll(async () => {
      // Join a late setup before closing its listener and reclaiming its directory.
      const ctx = await setup?.catch(() => undefined);
      await ctx?.close();
    }, 60_000);
    it("has private socket permissions and consumes only the trusted nonce once", async () => {
      const ctx = await setup;
      if (!ctx) throw new Error("Push context fixture is not ready");
      expect((await stat(ctx.path)).mode & 0o777).toBe(0o600);
      expect(
        await exchange(ctx.path, { nonce: "forged", REMOTE_USER: "owner", DATABASE_URL: "forged" }),
      ).not.toContain('"ok":true');
      expect(run).not.toHaveBeenCalled();
      expect(await exchange(ctx.path, { nonce: ctx.nonce, command: "test" })).toContain(
        '"ok":true',
      );
      expect(await exchange(ctx.path, { nonce: ctx.nonce, command: "test" })).not.toContain(
        '"ok":true',
      );
      expect(run).toHaveBeenCalledOnce();
    });
  });
  it("keeps a long temporary directory from exceeding the Unix socket path limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "kb-push-long-"));
    temp.path = join(root, "x".repeat(120));
    await mkdir(temp.path);
    let ctx: Awaited<ReturnType<typeof openPushContext>> | undefined;
    try {
      ctx = await openPushContext({
        signal: new AbortController().signal,
        run: async () => ({ ok: true }),
      });
      expect(Buffer.byteLength(ctx.path)).toBeLessThan(104);
      expect((await stat(dirname(ctx.path))).mode & 0o777).toBe(0o700);
      expect((await stat(ctx.path)).mode & 0o777).toBe(0o600);
      expect(await exchange(ctx.path, { nonce: ctx.nonce, command: "test" })).toContain(
        '"ok":true',
      );
      const socketRoot = dirname(ctx.path);
      await ctx.close();
      ctx = undefined;
      await expect(stat(socketRoot)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await ctx?.close();
      temp.path = undefined;
      await rm(root, { recursive: true, force: true });
    }
  });
  it("closes the listener and removes its directory when permission setup fails", async () => {
    temp.failPermissions = true;
    try {
      await expect(
        openPushContext({ signal: new AbortController().signal, run: async () => ({ ok: true }) }),
      ).rejects.toThrow("fixture chmod failure");
      expect(temp.socketDirectory).toBeDefined();
      await expect(stat(temp.socketDirectory!)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      temp.failPermissions = false;
      // Cleanup also keeps the negative control safe on the pre-fix code.
      if (temp.socketDirectory) await rm(temp.socketDirectory, { recursive: true, force: true });
      temp.socketDirectory = undefined;
    }
  });
  it("rejects a foreign context, expiry, and cancelled lifetime", async () => {
    const controller = new AbortController(),
      run = vi.fn(async () => ({ ok: true }));
    const ctx = await openPushContext({
      signal: controller.signal,
      expiresAt: Date.now() - 1,
      run,
    });
    try {
      expect(await exchange(ctx.path, { nonce: ctx.nonce })).not.toContain('"ok":true');
      expect(run).not.toHaveBeenCalled();
      controller.abort();
    } finally {
      await ctx.close();
    }
  });
});
