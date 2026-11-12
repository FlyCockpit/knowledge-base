import { describe, expect, it, vi } from "vitest";
import { sendPushNotification } from "./web-push";

const { sendNotification } = vi.hoisted(() => ({ sendNotification: vi.fn() }));
vi.mock("web-push", () => ({ sendNotification, setVapidDetails: vi.fn() }));
vi.mock("@knowledge-base/env/server", () => ({
  env: {
    VAPID_PUBLIC_KEY: "public",
    VAPID_PRIVATE_KEY: { reveal: () => "test-only" },
    VAPID_SUBJECT: "mailto:admin@example.com",
  },
}));

describe("push transport", () => {
  it("gives the library a finite socket timeout while retaining TTL and urgency", async () => {
    const subscription = {
      endpoint: "https://fcm.googleapis.com/fcm/send/test",
      keys: { p256dh: "public", auth: "auth" },
    };
    sendNotification.mockResolvedValue({ statusCode: 201 });
    await sendPushNotification(subscription, "{}");
    expect(sendNotification).toHaveBeenCalledExactlyOnceWith(subscription, "{}", {
      TTL: 3600,
      urgency: "high",
      timeout: 10_000,
    });
  });
});
