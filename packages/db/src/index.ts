import { initializeConnection } from "@knowledge-base/env/connection-config";
import { env } from "@knowledge-base/env/shared";
import { PrismaClient } from "../prisma/generated/client";
import { createPrismaPgAdapter } from "./prisma-adapter";

export type { Prisma } from "../prisma/generated/client";

const prisma = initializeConnection("DATABASE_URL", () => {
  const adapter = createPrismaPgAdapter({
    connectionString: env.DATABASE_URL.reveal(),
    max: env.DATABASE_POOL_MAX,
  });
  return new PrismaClient({ adapter });
});

export default prisma;
