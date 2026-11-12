import { randomBytes } from "node:crypto";

import Redis from "ioredis";

export type KbRedisFixture = {
  id: string;
  prefix: string;
  url: string;
  key(name: string): string;
  client(): Redis;
  close(): Promise<void>;
};

function assertPrefix(prefix: string): void {
  if (!/^kb_test_[a-z0-9]+$/.test(prefix)) {
    throw new Error(`Refusing non-test Redis prefix ${prefix}.`);
  }
}

export function assertTestRedisUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Refusing unparseable Redis URL before connecting.");
  }
  if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") {
    throw new Error("Refusing non-redis URL before connecting.");
  }
  const host = parsed.hostname;
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error("Refusing non-loopback Redis URL before connecting.");
  }
  return parsed;
}

export function openKbRedisFromEnv(
  id = process.env.KB_TEST_ID ?? randomBytes(4).toString("hex"),
): KbRedisFixture {
  const url = process.env.KB_TEST_REDIS_URL;
  if (!url) {
    throw new Error("KB redis fixtures require pnpm test:kb (missing KB_TEST_REDIS_URL).");
  }
  assertTestRedisUrl(url);
  const prefix = `kb_test_${id}`;
  assertPrefix(prefix);
  let shared: Redis | undefined;
  return {
    id,
    prefix,
    url,
    key(name: string) {
      assertPrefix(prefix);
      return `${prefix}:${name}`;
    },
    client() {
      if (!shared) {
        shared = new Redis(url, {
          maxRetriesPerRequest: 1,
          connectTimeout: 5_000,
          commandTimeout: 5_000,
          lazyConnect: false,
        });
      }
      return shared;
    },
    async close() {
      const client = shared;
      shared = undefined;
      if (!client) return;
      try {
        const keys = await client.keys(`${prefix}:*`);
        if (keys.length > 0) await client.del(...keys);
      } finally {
        client.disconnect();
      }
    },
  };
}
