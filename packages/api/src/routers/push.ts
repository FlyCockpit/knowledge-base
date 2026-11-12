import prisma from "@knowledge-base/db";
import { logEvent } from "@knowledge-base/env/log";
import { env } from "@knowledge-base/env/server";
import { ORPCError } from "@orpc/server";
import { z } from "zod";

import { adminOr404Procedure, protectedProcedure } from "../index";
import { forEachPage, keysetWhere } from "../lib/pagination";
import {
  pushEndpointSchema,
  pushSubscriptionInputSchema,
  upsertPushSubscription,
} from "../lib/push-subscription";
import { entityId, pathOnlyUrl, shortText } from "../lib/schemas";

const PUSH_PAGE_SIZE = 100;
const PUSH_CONCURRENCY = 8;

function webPushStatusCode(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null || !("statusCode" in err)) return undefined;
  return typeof err.statusCode === "number" ? err.statusCode : undefined;
}

/** Host only — endpoint URLs carry a per-subscription secret and never enter logs. */
function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return "invalid-endpoint";
  }
}

async function mapWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<PromiseSettledResult<void>[]> {
  const results: PromiseSettledResult<void>[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const slice = items.slice(i, i + concurrency);
    const batch = await Promise.allSettled(slice.map((item) => fn(item)));
    results.push(...batch);
  }
  return results;
}

export const pushRouter = {
  subscribe: protectedProcedure
    .input(pushSubscriptionInputSchema)
    .handler(async ({ input, context }) => {
      await upsertPushSubscription(context.session.user.id, input);
      return { success: true };
    }),

  unsubscribe: protectedProcedure
    .input(z.object({ endpoint: pushEndpointSchema }))
    .handler(async ({ input, context }) => {
      await prisma.pushSubscription.deleteMany({
        where: {
          endpoint: input.endpoint,
          userId: context.session.user.id,
        },
      });
      return { success: true };
    }),

  send: adminOr404Procedure
    .input(
      z.object({
        title: shortText,
        body: z.string().max(2000),
        url: pathOnlyUrl.default("/"),
        userId: entityId.optional(),
      }),
    )
    .handler(async ({ input }) => {
      const { isWebPushConfigured, sendPushNotification } = await import("../lib/web-push");

      // SERVICE_UNAVAILABLE, not a silent `{ sent: 0 }`: the route exists and
      // the caller is allowed to be here — the server is not configured to
      // serve it. Same shape as the asset endpoints' unconfigured 503;
      // without this, an unconfigured deployment reports total delivery
      // failure as a 200 with nothing in the logs.
      if (!isWebPushConfigured()) {
        throw new ORPCError("SERVICE_UNAVAILABLE", {
          message: "Push notifications are not configured on this server.",
        });
      }

      const where = input.userId ? { userId: input.userId } : {};
      const payload = JSON.stringify({
        title: input.title,
        body: input.body,
        data: { url: input.url },
      });

      let sent = 0;
      let failed = 0;
      let total = 0;
      // Aggregated by endpoint host + status code, so a broadcast to N devices
      // logs one line per failure class, not N stack traces.
      const failureCounts = new Map<string, { host: string; statusCode: string; count: number }>();
      await forEachPage(
        (page) =>
          prisma.pushSubscription.findMany({
            where: { ...where, ...keysetWhere(page.afterId) },
            select: { id: true, endpoint: true, p256dh: true, auth: true },
            orderBy: { id: "asc" },
            take: page.take,
          }),
        PUSH_PAGE_SIZE,
        async (subscriptions) => {
          total += subscriptions.length;
          const results = await mapWithConcurrency(subscriptions, PUSH_CONCURRENCY, async (sub) => {
            try {
              await sendPushNotification(
                {
                  endpoint: sub.endpoint,
                  keys: { p256dh: sub.p256dh, auth: sub.auth },
                },
                payload,
              );
            } catch (err: unknown) {
              const statusCode = webPushStatusCode(err);
              if (statusCode === 410 || statusCode === 404) {
                await prisma.pushSubscription.delete({ where: { id: sub.id } });
              }
              const host = endpointHost(sub.endpoint);
              const status = statusCode === undefined ? "network" : String(statusCode);
              const key = `${host} ${status}`;
              const previous = failureCounts.get(key);
              failureCounts.set(key, {
                host,
                statusCode: status,
                count: (previous?.count ?? 0) + 1,
              });
              throw err;
            }
          });
          sent += results.filter((r) => r.status === "fulfilled").length;
          failed += results.filter((r) => r.status === "rejected").length;
        },
      );

      for (const { host, statusCode, count } of failureCounts.values()) {
        logEvent("push.delivery", { host, status: statusCode, count });
      }

      return { sent, total, failed };
    }),

  vapidPublicKey: protectedProcedure.handler(() => {
    return { key: env.VAPID_PUBLIC_KEY ?? null };
  }),
};
