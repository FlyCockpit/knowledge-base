/** Owner-run one-shot recovery. Stop all servers first; preview before --confirm <count>. */
import "@knowledge-base/env/load-dotenv";

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { createPasswordPepper, type PasswordPepper } from "../packages/auth/src/password-pepper.ts";

// Loaded through variables, like seed-e2e.ts: the store and the Prisma client
// need the generated client, which tsconfig.scripts.json must not depend on.
type StoreModule = {
  resetUnusablePasswords(
    db: unknown,
    pepper: PasswordPepper,
    options: { confirm?: number },
  ): Promise<{ count: number; userIds: string[]; reset: number }>;
};
type DbModule = { default: { $disconnect(): Promise<void> } };
const STORE_MODULE = "../packages/auth/src/password-pepper-store.ts";
const DB_MODULE = "../packages/db/src/index.ts";

async function main() {
  const { values } = parseArgs({
    options: {
      confirm: { type: "string" },
      "allow-non-local": { type: "boolean", default: false },
    },
  });
  if (values.confirm !== undefined && !/^(0|[1-9][0-9]*)$/.test(values.confirm)) {
    throw new Error("--confirm requires an exact non-negative integer count");
  }
  const confirm = values.confirm === undefined ? undefined : Number(values.confirm);
  if (confirm !== undefined && !Number.isSafeInteger(confirm)) {
    throw new Error("--confirm count is too large");
  }
  if (!values["allow-non-local"]) {
    // Same exact-checkout DB and connection-override checks as local db:* tools.
    const guard = spawnSync(
      "bash",
      [resolve(import.meta.dirname, "assert-local-database.sh"), "auth:pepper:reset-unusable"],
      { stdio: "inherit" },
    );
    if (guard.status !== 0) {
      console.error(
        "Refused: database must be local unless the owner passes --allow-non-local with all servers stopped.",
      );
      process.exitCode = 1;
      return;
    }
  }
  // Validate the same environment as the server, without importing auth's
  // server entrypoint or starting a listener. Do not print env or DB errors.
  const { env } = await import("../packages/env/src/server.ts");
  const pepper = createPasswordPepper({
    secret: env.BETTER_AUTH_SECRET.reveal(),
    previousSecret: env.BETTER_AUTH_SECRET_PREVIOUS?.reveal(),
  });
  const { resetUnusablePasswords } = (await import(STORE_MODULE)) as StoreModule;
  const { default: db } = (await import(DB_MODULE)) as DbModule;
  try {
    const result = await resetUnusablePasswords(
      db,
      pepper,
      confirm === undefined ? {} : { confirm },
    );
    console.log(`Unusable password rows: ${result.count}`);
    console.log(`Affected user ids: ${JSON.stringify(result.userIds)}`);
    if (confirm === undefined || confirm !== result.count) {
      console.log("Nothing changed. Review the count and re-run with --confirm <count> to apply.");
      if (confirm !== undefined) process.exitCode = 1;
    } else {
      console.log(`Reset ${result.reset} password row(s).`);
      if (result.reset !== result.count) {
        console.error("Some values changed concurrently; keep servers stopped and preview again.");
        process.exitCode = 1;
      } else {
        console.log("Start the server and tell the listed users to use forgot-password.");
      }
    }
  } finally {
    await db.$disconnect();
  }
}

main().catch(() => {
  console.error(
    "Password recovery failed. Check arguments, validated server environment, and database access; no password values are printed.",
  );
  process.exitCode = 1;
});
