import { initializeConnection } from "@knowledge-base/env/connection-config";
import { env } from "@knowledge-base/env/shared";
import { PrismaClient } from "../prisma/generated/client";
import { configureLockSlots } from "./lock-slots";
import { createPrismaPgAdapter } from "./prisma-adapter";

export type { Prisma } from "../prisma/generated/client";

const prisma = initializeConnection("DATABASE_URL", () => {
  const poolMax = env.DATABASE_POOL_MAX;
  configureLockSlots(poolMax);
  const adapter = createPrismaPgAdapter({
    connectionString: env.DATABASE_URL.reveal(),
    max: poolMax,
  });
  return new PrismaClient({ adapter });
});

export default prisma;
