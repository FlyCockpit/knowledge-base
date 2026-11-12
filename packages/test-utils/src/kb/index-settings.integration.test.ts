import {
  CHUNK_CEILING_SETTING_KEYS,
  readChunkCeilings,
  setChunkCeiling,
} from "@knowledge-base/api/lib/kb/index-settings";
import { Client } from "pg";
import { afterAll, expect, it } from "vitest";
import { openKbPostgresClusterFromEnv } from "./postgres";

const cluster = await openKbPostgresClusterFromEnv();
const db = await cluster.createDatabase();
db.applyPrismaSchema();
const prisma = db.createPrismaClient("runtime");
const client = new Client({ connectionString: db.urls.runtime });
await client.connect();
const query = client.query.bind(client);

afterAll(async () => {
  await client.end();
  await prisma.$disconnect();
  await cluster.close();
});

it("clamps absent and oversized ceilings and rejects int8 writes above 200k", async () => {
  expect(await readChunkCeilings(query)).toEqual({
    int8: { ceiling: 200_000, bound: 200_000 },
    binary_int8_rescore: { ceiling: 400_000, bound: 400_000 },
  });
  await prisma.appSetting.create({
    data: { key: CHUNK_CEILING_SETTING_KEYS.int8, value: "400000" },
  });
  expect((await readChunkCeilings(query)).int8).toEqual({ ceiling: 200_000, bound: 200_000 });
  await prisma.user.create({
    data: { id: "admin", email: "admin@example.invalid", name: "Admin", role: "admin" },
  });
  await expect(
    setChunkCeiling(
      query,
      { userId: "admin" },
      {
        quantization: "int8",
        amount: 200_001,
      },
    ),
  ).rejects.toMatchObject({ details: { reason: "CHUNK_CEILING_ABOVE_BOUND" } });
  expect(
    await prisma.appSetting.findUniqueOrThrow({
      where: { key: CHUNK_CEILING_SETTING_KEYS.int8 },
    }),
  ).toMatchObject({ value: "400000" });
  expect(
    (
      await setChunkCeiling(
        query,
        { userId: "admin" },
        {
          quantization: "int8",
          amount: 200_000,
        },
      )
    ).int8,
  ).toEqual({ ceiling: 200_000, bound: 200_000 });
});
