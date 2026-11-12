import type { Env, Hono } from "hono";
import { NONCE, secureHeaders } from "hono/secure-headers";

type SecurityHeadersOptions = {
  // connect-src list for the app CSP (self + optional CORS origin).
  cspConnectSrc: string[];
  // sha256 hash authorizing the inlined anti-FOUC theme bootstrap script.
  themeInitCspHash: string;
};

/** Registers the global security headers. */
export function mountSecurityHeaders<E extends Env>(
  app: Hono<E>,
  { cspConnectSrc, themeInitCspHash }: SecurityHeadersOptions,
): void {
  // Registered first, applied LAST while unwinding. The generic CSP and even
  // early errors/CORS middleware must never overwrite the raw-media sandbox.
  for (const path of ["/kb-assets/*", "/kb-exports/*"])
    app.use(path, async (c, next) => {
      await next();
      c.header("Content-Security-Policy", "sandbox; default-src 'none'; frame-ancestors 'none'");
      c.header("X-Content-Type-Options", "nosniff");
      c.header("Cache-Control", "private, no-store");
      c.header("Cross-Origin-Resource-Policy", "same-origin");
      for (const name of [
        "Access-Control-Allow-Origin",
        "Access-Control-Allow-Credentials",
        "Access-Control-Allow-Headers",
        "Access-Control-Allow-Methods",
        "Access-Control-Expose-Headers",
      ])
        c.header(name, undefined);
    });
  app.use(
    "/*",
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        // NONCE generates a fresh per-request nonce, exposed as
        // c.get("secureHeadersNonce"). The SSR handler forwards it to TanStack
        // Start so its inline hydration scripts carry a matching nonce.
        // Never add 'unsafe-eval' or 'wasm-unsafe-eval' unless a shipped feature
        // needs WASM compilation in the browser.
        scriptSrc: [NONCE, "'self'", themeInitCspHash],
        // Intentional template tradeoff: Tailwind/shadcn-driven app UI and AI
        // generated small-business customizations often rely on inline styles.
        // Keep script-src strict; remove this only after auditing app-specific UI.
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:"],
        workerSrc: ["'self'"],
        connectSrc: cspConnectSrc,
        fontSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        // Injected markup cannot POST credentials to an attacker origin. Safe
        // with genericOAuth: the SSO handshake is redirect-based, not a form
        // POST. A SAML IdP using HTTP-POST binding would need its origin added.
        formAction: ["'self'"],
      },
    }),
  );
}
