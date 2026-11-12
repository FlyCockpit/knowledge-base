/// <reference lib="webworker" />
import { ExpirationPlugin } from "workbox-expiration";
import { cleanupOutdatedCaches, precacheAndRoute } from "workbox-precaching";
import { registerRoute } from "workbox-routing";
import { CacheFirst } from "workbox-strategies";

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<string | { url: string; revision: string | null }>;
};

// Workbox precaching (injected by vite-plugin-pwa)
cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

function toOrigin(value: string): string {
  return new URL(value).origin;
}

// --- Runtime Caching ---

// WASM files — CacheFirst, 90 day expiration
registerRoute(
  ({ request }) => request.url.endsWith(".wasm"),
  new CacheFirst({
    cacheName: "wasm-cache",
    plugins: [
      new ExpirationPlugin({
        maxAgeSeconds: 90 * 24 * 60 * 60,
      }),
    ],
  }),
);

// Worker scripts — CacheFirst, 90 day expiration
registerRoute(
  ({ request }) => request.destination === "worker",
  new CacheFirst({
    cacheName: "worker-cache",
    plugins: [
      new ExpirationPlugin({
        maxAgeSeconds: 90 * 24 * 60 * 60,
      }),
    ],
  }),
);

// Fonts — CacheFirst, 1 year expiration
registerRoute(
  ({ request }) => request.destination === "font",
  new CacheFirst({
    cacheName: "font-cache",
    plugins: [
      new ExpirationPlugin({
        maxAgeSeconds: 365 * 24 * 60 * 60,
      }),
    ],
  }),
);

// --- Offline Fallback ---

const OFFLINE_URL = "/offline.html";
const OFFLINE_CACHE = "offline";

// Cache the offline page on install, then activate immediately
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(OFFLINE_CACHE).then((cache) => cache.add(OFFLINE_URL)));
  self.skipWaiting();
});

// Claim all clients so the new SW takes effect without a second navigation
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Serve offline page for failed navigation requests
self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;

  event.respondWith(
    fetch(event.request).catch(async () => {
      const cache = await caches.open(OFFLINE_CACHE);
      const cached = await cache.match(OFFLINE_URL);
      return cached || new Response("Offline", { status: 503 });
    }),
  );
});

// --- Push Notifications ---

// The server always sends a title: `push.send` requires it (shortText), and
// it is the only producer of push payloads in this repo. The "Notification"
// fallback below is a last resort for foreign or malformed pushes — service
// workers cannot call t(), so it stays a documented English constant.
self.addEventListener("push", (event) => {
  let data = { title: "Notification", body: "", data: {} as Record<string, string> };

  if (event.data) {
    try {
      data = event.data.json();
    } catch {
      data.body = event.data.text();
    }
  }

  event.waitUntil(
    self.registration.showNotification(data.title || "Notification", {
      body: data.body,
      // Reuse the PWA manifest assets — no separate /icons/ dir ships in
      // public/, so pointing elsewhere renders a broken notification icon.
      icon: "/pwa-192x192.png",
      badge: "/pwa-64x64.png",
      tag: "default",
      data: data.data ?? {},
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const url = (event.notification.data?.url as string) || "/";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (new URL(client.url).pathname === url && "focus" in client) {
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});

self.addEventListener("pushsubscriptionchange", ((event: Event) => {
  const pushEvent = event as ExtendableEvent & {
    oldSubscription?: PushSubscription;
  };

  pushEvent.waitUntil(
    (async () => {
      const oldSubscription = pushEvent.oldSubscription;
      if (!oldSubscription?.options) return;

      const newSubscription = await self.registration.pushManager.subscribe(
        oldSubscription.options,
      );

      // Dedicated SW-renewal endpoint on the server (see
      // `apps/server/src/index.ts → POST /sw/push-renew`). Using a plain HTTP
      // route instead of the oRPC wire protocol because SWs cannot easily
      // import the oRPC client, and because the renewal path needs to work
      // without the CSRF-token dance the main oRPC client performs.
      // `credentials: "include"` carries the Better-Auth session cookie,
      // which is how the endpoint authenticates the caller.
      const serverUrl = toOrigin(import.meta.env.VITE_SERVER_URL || self.location.origin);
      await fetch(`${serverUrl}/sw/push-renew`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          endpoint: newSubscription.endpoint,
          keys: {
            p256dh: btoa(String.fromCharCode(...new Uint8Array(newSubscription.getKey("p256dh")!))),
            auth: btoa(String.fromCharCode(...new Uint8Array(newSubscription.getKey("auth")!))),
          },
        }),
      });
    })(),
  );
}) as EventListener);
