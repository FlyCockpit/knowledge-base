import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hardenedGitEnv } from "@knowledge-base/api/lib/kb/git-read";
import { parsePushCommands, ZERO_SHA } from "@knowledge-base/api/lib/kb/push-validation";
import { describe, expect, it } from "vitest";
import { gitCgiEnvironment } from "./git-cgi";
import { PUSH_HOOKS_PATH, pushChannel, pushHookDiagnostic } from "./git-pre-receive";

describe("image-owned receive hook", () => {
  it("pins executable hook path and receive limits for every receive repo", () => {
    const env = gitCgiEnvironment({
      reposDir: "/repos",
      kbId: "a123456789012345678901234",
      userId: "u",
      method: "POST",
      discovery: false,
      protocol: null,
      length: 42,
      refs: ["refs/heads/main"],
      receive: true,
    });
    const config = Object.fromEntries(
      Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => [
        env[`GIT_CONFIG_KEY_${i}`],
        env[`GIT_CONFIG_VALUE_${i}`],
      ]),
    );
    expect(config["core.hooksPath"]).toBe(PUSH_HOOKS_PATH);
    expect(config["receive.denyNonFastForwards"]).toBe("true");
    expect(config["receive.denyDeletes"]).toBe("true");
    expect(config["core.fsync"]).toBe("all");
    expect(env.PATH_INFO).toMatch(/git-receive-pack$/);
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.KB_PUSH_NONCE).toBeUndefined();
  });
  it("reads the complete hook command list, including trailing invalid commands", () => {
    const valid = `${"1".repeat(40)} ${"2".repeat(40)} refs/heads/main\n`;
    expect(() => parsePushCommands(valid + "invalid\n")).toThrow();
    expect(() => parsePushCommands("")).toThrow();
  });
});

describe("hook failure diagnostics (R3-W3 review)", () => {
  it("carry only the class name and stable code, never the message", () => {
    const pat = `kbp_${"a".repeat(16)}_${"b".repeat(43)}`;
    const error = Object.assign(new Error(`fsync failed for ${pat} password=hunter2`), {
      code: "EIO",
    });
    expect(pushHookDiagnostic(error)).toEqual({ errorClass: "Error", errorCode: "EIO" });
    expect(pushHookDiagnostic(new TypeError(pat))).toEqual({ errorClass: "TypeError" });
    expect(
      JSON.stringify(pushHookDiagnostic(Object.assign(new Error("x"), { code: pat }))),
    ).not.toContain("b".repeat(43));
  });

  it("reach the server when a real hook run fails inside validation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kb-hook-fault-"));
    const repo = join(dir, "r.git");
    const socketPath = join(dir, "s");
    const nonce = randomBytes(32).toString("hex");
    try {
      execFileSync("git", ["init", "--bare", "--quiet", repo], { env: hardenedGitEnv() });
      const env = { ...hardenedGitEnv(), GIT_DIR: repo };
      const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
        env,
        input: "x\n",
        encoding: "utf8",
      }).trim();
      const tree = execFileSync("git", ["mktree"], {
        env,
        input: `100644 blob ${blob}\tindex.md\n`,
        encoding: "utf8",
      }).trim();
      const main = execFileSync("git", ["commit-tree", tree, "-m", "m"], {
        env,
        encoding: "utf8",
      }).trim();
      const reports: Record<string, unknown>[] = [];
      const server = createServer({ allowHalfOpen: true }, (socket) => {
        const channel = pushChannel(socket);
        void (async () => {
          await channel.receive();
          channel.send({ ok: true, mainSha: main });
          // The pushed commit does not exist, so validation's git fails in the hook.
          reports.push(await channel.receive());
          socket.end();
        })().catch(() => socket.destroy());
      });
      await new Promise<void>((resolve) => server.listen(socketPath, resolve));
      const child = spawn(
        process.execPath,
        [
          // Absolute: the hook runs with the repository as its cwd.
          "--import",
          createRequire(import.meta.url).resolve("tsx/esm"),
          "--input-type=module",
          "-e",
          `process.argv[1] = "/hooks/pre-receive"; await import(${JSON.stringify(join(import.meta.dirname, "git-pre-receive.ts"))});`,
        ],
        {
          cwd: repo,
          env: { ...process.env, KB_PUSH_NONCE: nonce, KB_PUSH_SOCKET: socketPath },
          stdio: ["pipe", "ignore", "pipe"],
        },
      );
      child.stdin.end(`${ZERO_SHA} ${"c".repeat(40)} refs/heads/topic\n`);
      const code = await new Promise((resolve) => child.once("close", resolve));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      expect(code).toBe(1);
      expect(reports).toHaveLength(1);
      // git merge-base exited 128 on the missing commit: class and exit status only.
      expect(reports[0]).toEqual({ failed: { errorClass: "Error", errorCode: 128 } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
