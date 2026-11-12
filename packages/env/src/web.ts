import { createEnv } from "@t3-oss/env-core";
import { DEFAULT_APP_NAME } from "./app-name.js";
import { webVars } from "./vars/web.js";

// Narrow type-only shim for `window.location.origin` so this file compiles
// without pulling DOM into the package's `lib`. The runtime guard
// (`typeof window !== "undefined"`) still works on Node (where this module
// happens to be imported during SSR-style flows) and the browser.
declare const window: { location: { origin: string } } | undefined;

// Declarations live in ./vars/web.ts — a side-effect-free module, so
// `pnpm env:check` can read the key set. Declare new VITE_* variables there,
// never inline in the `createEnv` call.
const baseEnv = createEnv({
  clientPrefix: "VITE_",
  client: webVars,
  runtimeEnv: (import.meta as unknown as Record<string, unknown>).env as Record<
    string,
    string | undefined
  >,
  emptyStringAsUndefined: true,
});

export const env = {
  ...baseEnv,
  get VITE_APP_NAME() {
    return baseEnv.VITE_APP_NAME ?? DEFAULT_APP_NAME;
  },
  get VITE_SERVER_URL() {
    return (
      baseEnv.VITE_SERVER_URL ??
      (typeof window !== "undefined" ? window.location.origin : "http://localhost:3000")
    );
  },
};
