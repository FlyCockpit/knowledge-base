import prisma from "@knowledge-base/db";
import { ORPCError } from "@orpc/server";
import { z } from "zod";

/**
 * Shared Zod schema for a push-subscription payload.
 *
 * Used by both the `push.subscribe` oRPC procedure and the dedicated
 * `POST /sw/push-renew` HTTP endpoint that the service worker calls when the
 * browser rotates VAPID keys (`pushsubscriptionchange`). Keeping the shape in
 * one place prevents the two call sites from drifting.
 */
const allowedPushServiceHostSuffixes = [
  "fcm.googleapis.com",
  "android.googleapis.com",
  "updates.push.services.mozilla.com",
  "web.push.apple.com",
  "push.apple.com",
  "notify.windows.com",
];

export const pushEndpointSchema = z
  .string()
  .max(2048)
  .url()
  .refine((value) => isAllowedPushEndpoint(value), {
    message: "Push endpoint must be an HTTPS browser push service URL.",
  });

export const pushSubscriptionInputSchema = z.object({
  endpoint: pushEndpointSchema,
  keys: z.object({
    // PushSubscription.toJSON() uses base64url; the SW renewal path sends padded
    // standard base64 (`btoa`). Accept both alphabets, as web-push's decoder does.
    // Assert the absolute end: `$` also permits a trailing line terminator.
    p256dh: z.string().superRefine((value, ctx) => {
      if (!/^[A-Za-z0-9_+/-]{87}=?(?![\s\S])/.test(value)) {
        ctx.addIssue({ code: "custom", message: "INVALID_PUSH_P256DH" });
        return;
      }
      const decoded = Buffer.from(value, "base64url");
      if (decoded.length !== 65 || decoded[0] !== 0x04) {
        ctx.addIssue({ code: "custom", message: "INVALID_PUSH_P256DH" });
      }
    }),
    auth: z.string().superRefine((value, ctx) => {
      if (!/^[A-Za-z0-9_+/-]{22}(?:==)?(?![\s\S])/.test(value)) {
        ctx.addIssue({ code: "custom", message: "INVALID_PUSH_AUTH" });
        return;
      }
      if (Buffer.from(value, "base64url").length !== 16) {
        ctx.addIssue({ code: "custom", message: "INVALID_PUSH_AUTH" });
      }
    }),
  }),
});

/** Stored subscriptions per user; registrations beyond it replace the stalest. */
export const PUSH_SUBSCRIPTIONS_PER_USER = 20;

export type PushSubscriptionInput = z.infer<typeof pushSubscriptionInputSchema>;

/**
 * Upsert a web-push subscription for the given user.
 *
 * Endpoint is the natural primary key. The same user can refresh keys for an
 * existing endpoint, but another user cannot claim it by submitting the same
 * endpoint.
 */
export async function upsertPushSubscription(userId: string, input: PushSubscriptionInput) {
  try {
    await writePushSubscription(userId, input);
  } catch (error) {
    // Two users registering one new endpoint concurrently each lock only their
    // own user row; the loser hits the endpoint's unique index.
    if (isUniqueViolation(error)) throw endpointConflict();
    throw error;
  }
}

/** Prisma's unique-constraint code (P2002), or PostgreSQL's (23505) from a driver error. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "P2002" || error.code === "23505")
  );
}

function endpointConflict() {
  return new ORPCError("CONFLICT", {
    message: "Push subscription endpoint is already registered to another user.",
  });
}

async function writePushSubscription(userId: string, input: PushSubscriptionInput) {
  await prisma.$transaction(async (tx) => {
    // Serialize registrations for this user so concurrent requests cannot both
    // consume the final slot. The lock, count, and write share one transaction.
    await tx.$queryRaw`SELECT id FROM "user" WHERE id = ${userId} FOR UPDATE`;
    const existing = await tx.pushSubscription.findUnique({
      where: { endpoint: input.endpoint },
      select: { userId: true },
    });

    if (existing && existing.userId !== userId) throw endpointConflict();

    if (existing) {
      await tx.pushSubscription.update({
        where: { endpoint: input.endpoint },
        data: {
          p256dh: input.keys.p256dh,
          auth: input.keys.auth,
        },
      });
      return;
    }

    // At the cap, evict the least recently refreshed subscriptions instead of
    // refusing: the service worker's renewal registers a new endpoint without
    // removing the old one, so a refusal would silently end push on a device.
    const evict = await tx.pushSubscription.findMany({
      where: { userId },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      skip: PUSH_SUBSCRIPTIONS_PER_USER - 1,
      take: PUSH_SUBSCRIPTIONS_PER_USER,
      select: { id: true },
    });
    if (evict.length > 0) {
      await tx.pushSubscription.deleteMany({
        where: { userId, id: { in: evict.map((row) => row.id) } },
      });
    }

    await tx.pushSubscription.create({
      data: {
        endpoint: input.endpoint,
        p256dh: input.keys.p256dh,
        auth: input.keys.auth,
        userId,
      },
    });
  });
}

function isAllowedPushEndpoint(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (url.protocol !== "https:") return false;
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (isBlockedEndpointHost(hostname)) return false;
  return allowedPushServiceHostSuffixes.some(
    (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
  );
}

function isBlockedEndpointHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (hostname.startsWith("[") || hostname.endsWith("]")) return true;
  return isPrivateIpv4(hostname);
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map((part) => Number.parseInt(part, 10));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  const a = parts[0];
  const b = parts[1];
  if (a === undefined || b === undefined) return true;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}
