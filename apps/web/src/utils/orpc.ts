import type { AppRouterClient } from "@knowledge-base/api/routers/index";
import { KB_EXPORT_ACK_TIMEOUT_MS, ORPC_BATCH_MAX_SIZE } from "@knowledge-base/config/orpc-batch";
import { env } from "@knowledge-base/env/web";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import {
  BatchLinkPlugin,
  ClientRetryPlugin,
  DedupeRequestsPlugin,
  SimpleCsrfProtectionLinkPlugin,
} from "@orpc/client/plugins";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";

const isExportAcknowledgement = (path: readonly string[]) =>
  path[0] === "kbExports" && path[1] === "complete";

const link = new RPCLink({
  url: `${env.VITE_SERVER_URL}/rpc`,
  interceptors: [
    ({ next, ...options }) => {
      const { path, signal } = options;
      if (!isExportAcknowledgement(path)) return next();
      const deadline = AbortSignal.timeout(KB_EXPORT_ACK_TIMEOUT_MS);
      return next({ ...options, signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
    },
  ],
  plugins: [
    new SimpleCsrfProtectionLinkPlugin(),
    // `maxSize` must stay in sync with the server's `BatchHandlerPlugin` —
    // pass the shared constant on both sides, never a literal. A client value
    // above the server's makes the server 413 the whole batch. See
    // `packages/config/src/orpc-batch.ts`.
    new BatchLinkPlugin({
      groups: [{ condition: () => true, context: {} }],
      maxSize: ORPC_BATCH_MAX_SIZE,
      // A batch aborts only when every member aborts. Keep the post-save
      // deadline owned by this ACK without cancelling unrelated procedures.
      exclude: ({ path }) => isExportAcknowledgement(path),
    }),
    new DedupeRequestsPlugin({
      groups: [
        {
          // A post-denial access check must never join a pre-denial read.
          condition: ({ path, context }) =>
            !isExportAcknowledgement(path) && context.freshKbAccess !== true,
          context: {},
        },
      ],
    }),
    // ClientRetryPlugin only retries procedures that explicitly opt in via
    // `context: { retry: N }`. No procedure in this app opts in, so 429s are
    // never silently retried here — the global error handler in router.tsx
    // surfaces them as a friendly toast instead.
    new ClientRetryPlugin(),
  ],
  fetch(url, options) {
    return fetch(url, {
      ...options,
      credentials: "include",
    });
  },
});

const client: AppRouterClient = createORPCClient(link);

export const orpc = createTanstackQueryUtils(client);
