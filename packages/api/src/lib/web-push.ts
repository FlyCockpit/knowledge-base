import { env } from "@knowledge-base/env/server";
import type { PushSubscription } from "web-push";

let initialized = false;

async function getWebPush() {
  const webpush = await import("web-push");

  if (!initialized && env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT) {
    webpush.setVapidDetails(
      env.VAPID_SUBJECT,
      env.VAPID_PUBLIC_KEY,
      env.VAPID_PRIVATE_KEY.reveal(),
    );
    initialized = true;
  }

  return webpush;
}

/**
 * Are the VAPID credentials present? Read at call time, never memoized at
 * module load — so callers can refuse at
 * the procedure boundary instead of learning the gap from a per-delivery
 * error after the work has started.
 */
export function isWebPushConfigured(): boolean {
  return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT);
}

export async function sendPushNotification(subscription: PushSubscription, payload: string) {
  if (!isWebPushConfigured()) {
    throw new Error(
      "Web push is not configured: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and VAPID_SUBJECT must all be set",
    );
  }

  const webpush = await getWebPush();
  return webpush.sendNotification(subscription, payload, {
    TTL: 60 * 60,
    timeout: 10_000,
    urgency: "high",
  });
}
