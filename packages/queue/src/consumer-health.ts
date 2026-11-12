import { randomUUID } from "node:crypto";
import type IORedis from "ioredis";

// A Redis database is an application/environment boundary, just like QUEUE_NAMES.
// UUID members prevent a retiring replica from withdrawing its replacement.
const KEY = "knowledge-base:consumers:";
export const CONSUMER_HEARTBEAT_TTL_MS = 15_000;
const INTERVAL_MS = 5_000;
type HealthRedis = Pick<IORedis, "eval" | "zrem">;
const PUBLISH = `
local now = redis.call('TIME')
local ms = now[1] * 1000 + math.floor(now[2] / 1000)
for _, key in ipairs(KEYS) do
  redis.call('ZREMRANGEBYSCORE', key, '-inf', ms)
  redis.call('ZADD', key, ms + tonumber(ARGV[2]), ARGV[1])
  redis.call('PEXPIRE', key, ARGV[2])
end
return 1`;
const READ = `
local now = redis.call('TIME')
local ms = now[1] * 1000 + math.floor(now[2] / 1000)
for _, key in ipairs(KEYS) do
  if redis.call('ZCOUNT', key, '(' .. ms, '+inf') == 0 then return 0 end
end
return 1`;

/** Callers pass Object.values(QUEUE_NAMES), including provider-probe, index-kb, query-embedding, push-mirror, download-model, kb-email and kb-retention: Redis alone is not readiness. */
export async function hasExternalConsumer(
  connection: HealthRedis,
  requiredQueues: readonly string[],
): Promise<boolean> {
  if (!requiredQueues.length) return false;
  const keys = [...new Set(requiredQueues)].map((name) => `${KEY}external:${name}`);
  return Number(await connection.eval(READ, keys.length, ...keys)) === 1;
}

/** Publish only while all consumers are running; stop drains publication before withdrawal. */
export function createConsumerHeartbeat(
  connection: HealthRedis,
  queues: readonly string[],
  healthy: () => boolean,
) {
  const id = randomUUID();
  const keys = [...new Set(queues)].map((name) => `${KEY}external:${name}`);
  let lastSuccess = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  async function publish(): Promise<void> {
    if (stopped || !keys.length || !healthy()) {
      lastSuccess = 0;
      return;
    }
    await connection.eval(PUBLISH, keys.length, ...keys, id, CONSUMER_HEARTBEAT_TTL_MS);
    if (!stopped) lastSuccess = performance.now();
  }
  function schedule() {
    if (stopped) return;
    timer = setTimeout(() => {
      pending = publish()
        .catch(() => {
          lastSuccess = 0;
        })
        .finally(schedule);
    }, INTERVAL_MS);
    timer.unref();
  }
  return {
    async start() {
      if (stopped || pending) throw new Error("Consumer heartbeat already started or stopped.");
      pending = publish();
      await pending;
      if (stopped || !keys.length || !healthy()) throw new Error("Job consumers are not running.");
      schedule();
    },
    isReady: () =>
      !stopped &&
      healthy() &&
      lastSuccess > 0 &&
      performance.now() - lastSuccess < CONSUMER_HEARTBEAT_TTL_MS,
    stop(): Promise<void> {
      if (closing) return closing;
      stopped = true;
      lastSuccess = 0;
      clearTimeout(timer);
      closing = (async () => {
        await pending?.catch(() => {});
        await Promise.all(keys.map((key) => connection.zrem(key, id)));
      })();
      return closing;
    },
  };
}
