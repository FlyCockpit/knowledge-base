import { describe, expect, it } from "vitest";
import { logRecord } from "./log";
import { PASSWORD_PEPPER_DOCS } from "./log-record";
import { recordReader, renderServiceRecord } from "./service-output";

describe("dedicated record channel", () => {
  it("keeps split frames, rejects forged/unknown fields and recovers after oversized frames", () => {
    const accepted: unknown[] = [];
    const reader = recordReader((record) => accepted.push(record));
    const record = logRecord("server.listening", { port: 3000 });
    const line = Buffer.from(`${JSON.stringify(record)}\n`);
    for (const byte of line) reader.write(Buffer.from([byte]));
    reader.write(Buffer.from(`${JSON.stringify({ ...record, arbitrary: "password=canary" })}\n`));
    reader.write(Buffer.alloc(20000, 65));
    reader.write(Buffer.concat([Buffer.from("\n"), line]));
    reader.write(Buffer.from("truncated"));
    expect(accepted).toEqual([record, record]);
    expect(reader.finish()).toBe(3);
  });
});

describe("service exit", () => {
  it("publishes the exit and ends when descendants outlive the direct child", async () => {
    const { spawn } = await import("node:child_process");
    const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "kb-service-outlived-"));
    const entry = join(dir, "entry.mjs");
    const orphanPid = join(dir, "orphan.pid");
    // The direct child leaves a grandchild holding every inherited pipe, as an
    // orphan does when the native supervisor is killed.
    writeFileSync(
      entry,
      `import { spawn } from "node:child_process";
       import { writeFileSync } from "node:fs";
       const orphan = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
         detached: true, stdio: ["ignore", "inherit", "inherit", "inherit"] });
       writeFileSync(${JSON.stringify(orphanPid)}, String(orphan.pid));
       process.exit(0);`,
    );
    const driver = join(dir, "driver.mjs");
    writeFileSync(
      driver,
      `import { superviseService } from ${JSON.stringify(new URL("./service-output.ts", import.meta.url).href)};
       superviseService("worker", new URL(${JSON.stringify(`file://${entry}`)}));`,
    );
    const supervisor = spawn(process.execPath, ["--import", "tsx", driver], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    supervisor.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    try {
      const code = await new Promise<number | null>((done) => supervisor.once("close", done));
      expect(code).toBe(0);
      const records = stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(records.at(-1)).toMatchObject({
        site: "service.exit",
        exitCode: 0,
        reason: "DESCENDANTS_OUTLIVED_SERVICE",
      });
    } finally {
      try {
        process.kill(Number(readFileSync(orphanPid, "utf8")), "SIGKILL");
      } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

it("renders every validated pepper diagnostic with fixed operator guidance", () => {
  const fp = "0123456789abcdef";
  const previous = "abcdef0123456789";
  const cases = [
    [{ event: "ok", fingerprint: fp }, "info", "ok (key fp"],
    [{ event: "sealed", fingerprint: fp, count: 1 }, "info", "sealed 1 existing"],
    [
      { event: "rewrapped-complete", fingerprint: fp, previousFingerprint: previous, count: 2 },
      "info",
      "can now be removed",
    ],
    [
      {
        event: "previous-remaining",
        previousFingerprint: previous,
        count: 1,
        docs: PASSWORD_PEPPER_DOCS,
      },
      "warn",
      "keep BETTER_AUTH_SECRET_PREVIOUS",
    ],
    [
      { event: "unusable", count: 1, docs: PASSWORD_PEPPER_DOCS },
      "warn",
      "auth:pepper:reset-unusable",
    ],
    [
      {
        event: "key-refused",
        fingerprint: fp,
        previousFingerprint: previous,
        unknownFingerprint: previous,
        count: 2,
        docs: PASSWORD_PEPPER_DOCS,
      },
      "error",
      "Refusing to start",
    ],
  ] as const;
  for (const [fields, level, expected] of cases) {
    const accepted: ReturnType<typeof logRecord>[] = [];
    const reader = recordReader((record) => accepted.push(renderServiceRecord(record)));
    reader.write(Buffer.from(`${JSON.stringify(logRecord("password-pepper", fields))}\n`));
    expect(reader.finish()).toBe(0);
    expect(accepted[0]).toMatchObject({ level, message: expect.stringContaining(expected) });
  }
});
