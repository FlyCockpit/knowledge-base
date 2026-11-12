import { APP_LOCALE_HEADER } from "@knowledge-base/config/locales";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { describe, expect, it } from "vitest";

import { CORS_ALLOW_HEADERS } from "./cors-headers";

const APP_ORIGIN = "https://app.example.com";

// Mirrors the cross-origin branch in index.ts. Asserting against the real
// middleware rather than the constant is the point: a header missing from
// CORS_ALLOW_HEADERS is only observable as a preflight that fails to echo it
// back, which is exactly what the browser refuses on.
function buildApp() {
  const app = new Hono();
  app.use(
    "/*",
    cors({
      origin: APP_ORIGIN,
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: [...CORS_ALLOW_HEADERS],
      credentials: true,
    }),
  );
  app.post("/api/auth/sign-in/email", (c) => c.json({ ok: true }));
  return app;
}

function preflight(requestHeaders: string) {
  return buildApp().request("/api/auth/sign-in/email", {
    method: "OPTIONS",
    headers: {
      Origin: APP_ORIGIN,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": requestHeaders,
    },
  });
}

describe("CORS_ALLOW_HEADERS", () => {
  it("allows sender proofs at MCP only for the configured browser origin", async () => {
    for (const origin of [APP_ORIGIN, "https://foreign.example.com"]) {
      const res = await buildApp().request("/mcp", {
        method: "OPTIONS",
        headers: {
          Origin: origin,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "authorization,dpop,content-type",
        },
      });
      if (origin === APP_ORIGIN) {
        expect(res.headers.get("access-control-allow-origin")).toBe(APP_ORIGIN);
        expect(res.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("dpop");
      } else expect(res.headers.get("access-control-allow-origin")).toBeNull();
    }
  });
  it("allows the device nonce for approval from the configured web origin", async () => {
    const res = await preflight("x-device-approval-nonce");
    expect(res.headers.get("access-control-allow-headers")).toContain("x-device-approval-nonce");
  });
  it.each([...CORS_ALLOW_HEADERS])("echoes %s back on the preflight", async (header) => {
    const res = await preflight(header);
    const allowed = (res.headers.get("access-control-allow-headers") ?? "").toLowerCase();
    expect(allowed).toContain(header.toLowerCase());
  });

  it("allows the locale header the auth client sets on every request", async () => {
    // Regression guard. apps/web/src/lib/auth-client.ts sets APP_LOCALE_HEADER
    // in `onRequest`, so it rides along on sign-in, sign-up, and get-session.
    // Omitting it from allowHeaders fails the preflight and blocks all three —
    // but only when CORS_ORIGIN is set, so local dev and CI never see it and
    // the breakage lands on the first split-origin production deploy.
    expect(CORS_ALLOW_HEADERS).toContain(APP_LOCALE_HEADER);

    const res = await preflight(`content-type,${APP_LOCALE_HEADER}`);
    const allowed = (res.headers.get("access-control-allow-headers") ?? "").toLowerCase();
    expect(allowed).toContain(APP_LOCALE_HEADER);
  });

  it("allows the CSRF header Better-Auth's client plugin sets", async () => {
    const res = await preflight("x-csrf-token");
    const allowed = (res.headers.get("access-control-allow-headers") ?? "").toLowerCase();
    expect(allowed).toContain("x-csrf-token");
  });
});
