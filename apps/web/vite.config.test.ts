import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

import { validateLogRecord } from "@knowledge-base/env/log-record";
import { describe, expect, it } from "vitest";

const WEB = new URL(".", import.meta.url).pathname;

/** The developer's default `.env`: the template with its generated secrets
 * filled in, as `pnpm setup` writes it. */
function defaultDevEnv(): Record<string, string> {
  const template = parseEnv(readFileSync(new URL("../../.env.example", import.meta.url), "utf8"));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(template)) if (value) env[key] = value;
  env.BETTER_AUTH_SECRET = randomBytes(32).toString("hex");
  env.KB_MASTER_KEY = randomBytes(32).toString("base64");
  return env;
}

// `vite dev` evaluates TanStack Start server functions in its SSR module
// runner, in this Vite process. The first guarded route's getRouteSession
// imports @knowledge-base/auth, which validates the environment and logs its
// dev-mode warnings. That process needs no setup: it must stay up and
// put the warning record on the developer's terminal.
const DRIVER = `
import { createServer } from "vite";
const server = await createServer({ configFile: "vite.config.ts", logLevel: "silent", server: { port: 0, hmr: false, ws: false } });
process.on("unhandledRejection", () => { process.stdout.write("unhandled\\n"); process.exit(9); });
process.on("uncaughtException", () => { process.stdout.write("uncaught\\n"); process.exit(9); });
await server.environments.ssr.runner.import("@knowledge-base/auth");
process.stdout.write("imported\\n");
// A throw inside a validation callback surfaced as a later rejection: wait it out.
await new Promise((resolve) => setTimeout(resolve, 1000));
process.stdout.write("alive\\n");
await server.close();
process.exit(0);
`;

describe("the vite dev server host", () => {
  it("loads the server-function graph with a default .env, stays up and logs config warnings to stderr", async () => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", DRIVER], {
      cwd: WEB,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...defaultDevEnv() },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const status = await new Promise<number | null>((resolve) => child.on("close", resolve));
    expect(stdout, stderr).toBe("imported\nalive\n");
    expect(status).toBe(0);
    const records = stderr
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => validateLogRecord(JSON.parse(line)));
    expect(records).not.toContain(undefined);
    expect(records).toContainEqual(expect.objectContaining({ site: "backup.config" }));
  }, 120_000);
});
