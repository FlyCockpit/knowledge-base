import { APP_LOCALE_HEADER } from "@knowledge-base/config/locales";

/**
 * Request headers the browser is allowed to send cross-origin.
 *
 * Every header the client sets on a cross-origin request must appear here. A
 * custom header that isn't listed makes the browser's preflight fail, and the
 * real request is never sent — so the failure surfaces as "sign-in silently
 * does nothing", not as a readable error.
 *
 * This is easy to get wrong because the CORS middleware only mounts when
 * `CORS_ORIGIN` is set, and local development proxies the API same-origin
 * through Vite. An omission here therefore passes every local check and breaks
 * authentication on the first split-origin production deploy.
 *
 * Current entries and who sends them:
 *   - `Content-Type` / `Authorization` — standard.
 *   - `DPoP` — sender proof at OAuth issuance and at MCP / bearer-media resource verification.
 *   - `x-csrf-token` — Better-Auth's SimpleCsrfProtectionLinkPlugin, every request.
 *   - `x-device-approval-nonce` — session-bound human device approval.
 *   - APP_LOCALE_HEADER — the auth client (apps/web/src/lib/auth-client.ts),
 *     every auth request.
 *
 * **Adding a client-set header means adding it here.** cors-headers.test.ts
 * asserts the preflight actually echoes each one.
 */
export const CORS_ALLOW_HEADERS = [
  "Content-Type",
  "Authorization",
  "DPoP",
  "x-csrf-token",
  "x-device-approval-nonce",
  APP_LOCALE_HEADER,
] as const;
