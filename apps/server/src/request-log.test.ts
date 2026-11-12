import { captureLog } from "@knowledge-base/env/log";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { requestLog } from "./request-log";

const TOKEN = "rstTok9Zq7Kp2Xw9Lm4Rt8V";

/** The server's own shapes: request id, the log middleware, then the auth catch-all. */
function app() {
  const hono = new Hono<{ Variables: { requestId?: string } }>();
  hono.use("/*", async (c, next) => {
    c.set("requestId", "req12345");
    await next();
  });
  hono.use("/*", requestLog());
  hono.on(["POST", "GET"], "/api/auth/*", (c) => c.json({ ok: true }));
  hono.get("/git/:kb/*", (c) => c.text("git"));
  return hono;
}

describe("request log", () => {
  it.each([
    ["reset-password path token", `/api/auth/reset-password/${TOKEN}?callbackURL=%2Fen-US%2Freset`],
    ["verify-email query token", `/api/auth/verify-email?token=${TOKEN}&callbackURL=%2Fen-US`],
    ["magic link query token", `/api/auth/magic-link/verify?token=${TOKEN}`],
    ["unmatched path", `/nowhere/${TOKEN}?token=${TOKEN}`],
  ])("records the route template, never the path or query: %s", async (_name, url) => {
    const log = captureLog();
    try {
      const response = await app().request(url);
      expect(log.records).toHaveLength(1);
      const record = log.records[0]!;
      expect(record).toMatchObject({
        level: "info",
        site: "http.request",
        requestId: "req12345",
        method: "GET",
        status: response.status,
      });
      expect(typeof record.durationMs).toBe("number");
      expect(JSON.stringify(log.records)).not.toContain(TOKEN);
      expect(JSON.stringify(log.records)).not.toContain("callbackURL");
      if (url.startsWith("/api/auth/")) expect(record.route).toBe("/api/auth/*");
    } finally {
      log.restore();
    }
  });

  it("uses the parameterized template for parameterized routes", async () => {
    const log = captureLog();
    try {
      await app().request(`/git/${TOKEN}/info/refs?service=git-upload-pack`);
      expect(log.records[0]).toMatchObject({ route: "/git/:kb/*", status: 200 });
      expect(JSON.stringify(log.records)).not.toContain(TOKEN);
    } finally {
      log.restore();
    }
  });

  it("records the responder even when later catch-all middleware also matches", async () => {
    const log = captureLog();
    try {
      const hono = app();
      hono.use("/*", async (_c, next) => {
        await next();
      });
      await hono.request(`/api/auth/reset-password/${TOKEN}?token=${TOKEN}`);
      expect(log.records[0]).toMatchObject({ route: "/api/auth/*", status: 200 });
    } finally {
      log.restore();
    }
  });

  it("records handled failures and middleware refusals without a raw URL", async () => {
    const log = captureLog();
    try {
      const hono = app();
      hono.onError((_error, c) => c.text("failed", 500));
      hono.get("/failure/:token", () => {
        throw new Error(TOKEN);
      });
      hono.use("/refused/*", async (c) => c.text("refused", 403));
      await hono.request(`/failure/${TOKEN}?token=${TOKEN}`);
      await hono.request(`/refused/${TOKEN}?token=${TOKEN}`);
      expect(log.records).toHaveLength(2);
      expect(log.records[0]).toMatchObject({ route: "/failure/:token", status: 500 });
      expect(log.records[1]).toMatchObject({ route: "/refused/*", status: 403 });
      expect(JSON.stringify(log.records)).not.toContain(TOKEN);
    } finally {
      log.restore();
    }
  });

  it("is the request logger the server mounts (no library logger)", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(source).toContain('app.use("/*", requestLog());');
    expect(source).not.toMatch(/from "hono\/logger"/);
  });
});
