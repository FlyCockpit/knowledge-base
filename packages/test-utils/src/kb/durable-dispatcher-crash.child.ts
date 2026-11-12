/**
 * Child process for the durable-jobs crash-barrier integration tests
 * (packages/test-utils/src/kb/jobs.integration.test.ts).
 *
 * It parks a production dispatcher cycle at afterClaim or beforePublish,
 * signals the parent, and waits for SIGKILL without releasing durable state.
 */

import { runDurableDispatcherCycle } from "@knowledge-base/api/lib/kb/dispatch";
import { PrismaClient } from "@knowledge-base/db/client";
import { createPrismaPgAdapter } from "@knowledge-base/db/prisma-adapter";
import { Queue } from "bullmq";
import Redis from "ioredis";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`crash child requires ${name}`);
  return value;
}

async function main(): Promise<void> {
  const dbUrl = requireEnv("KB_TEST_DB_URL");
  const redisUrl = requireEnv("KB_TEST_REDIS_URL");
  const redisPrefix = requireEnv("KB_TEST_REDIS_PREFIX");
  const owner = requireEnv("KB_TEST_OWNER");
  const mode = requireEnv("KB_TEST_MODE");

  const prisma = new PrismaClient({
    adapter: createPrismaPgAdapter({ connectionString: dbUrl, max: 2 }),
  });
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue("durable-probe", { connection, prefix: redisPrefix });
  if (mode !== "claim" && mode !== "before-publish") throw new Error("invalid crash mode");
  const park = async () => {
    process.stdout.write(`${JSON.stringify({ owner, claimed: 1, published: 0 })}\n`);
    // A real live process barrier; the parent kills this process group. The
    // failsafe bounds an orphan if the parent itself crashes.
    setInterval(() => {}, 60_000);
    setTimeout(() => process.exit(1), 120_000).unref();
    await new Promise<void>(() => {});
  };
  await runDurableDispatcherCycle({
    db: prisma,
    ownerId: owner,
    now: () => new Date(),
    getQueue: () => queue,
    hooks: mode === "claim" ? { afterClaim: park } : { beforePublish: park },
  });
  throw new Error("dispatcher did not reach the crash barrier");
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
