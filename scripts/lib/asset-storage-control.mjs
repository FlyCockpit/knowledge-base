/** Outside public/archive metadata; never cleared by age or a schema receipt. */
export const MIGRATION_TABLE = "knowledge_base_control.asset_storage_migration";
export const MIGRATION_ITEMS = "knowledge_base_control.asset_storage_migration_item";
export async function assertNoStorageMigration(client) {
  const present = await client.query(`SELECT to_regclass('${MIGRATION_TABLE}') AS present`);
  if (
    present.rows[0]?.present &&
    (await client.query(`SELECT 1 FROM ${MIGRATION_TABLE} WHERE state<>'READY' LIMIT 1`)).rows
      .length
  )
    throw new Error("Pending asset storage migration requires offline recovery.");
}
export async function installStorageMigrationControl(client) {
  await client.query(`CREATE SCHEMA IF NOT EXISTS knowledge_base_control;
    CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (
      "attemptId" uuid PRIMARY KEY, source jsonb NOT NULL, target jsonb NOT NULL,
      "targetGeneration" uuid NOT NULL, "targetLocator" text, "targetMode" text NOT NULL,
      "cacheLimit" text, "cacheId" text NOT NULL,
      state text NOT NULL CHECK(state IN ('INVENTORY','COPYING','CONVERTING','VERIFYING','READY')),
      "inventoryDigest" text, "lastHash" text, "itemCount" bigint NOT NULL DEFAULT 0);
    CREATE UNIQUE INDEX IF NOT EXISTS asset_storage_one_pending
      ON ${MIGRATION_TABLE} ((true)) WHERE state<>'READY';
    CREATE TABLE IF NOT EXISTS ${MIGRATION_ITEMS} (
      "attemptId" uuid NOT NULL REFERENCES ${MIGRATION_TABLE}("attemptId"),
      hash text NOT NULL, size integer NOT NULL, PRIMARY KEY("attemptId",hash));
    GRANT USAGE ON SCHEMA knowledge_base_control TO PUBLIC;
    GRANT SELECT ON ${MIGRATION_TABLE} TO PUBLIC;`);
}

/** Read-only mode check for schema leaders/followers; credentials are irrelevant. */
async function configuredStorageSelection(env) {
  const { assetStorageAdmissionDomain } = await import("./asset-storage-domain.mjs");
  if (env.KB_ASSET_S3_ENABLED && !["true", "false"].includes(env.KB_ASSET_S3_ENABLED))
    throw new Error("Invalid KB_ASSET_S3_ENABLED");
  return (await assetStorageAdmissionDomain()).assetStorageSelection({
    ...env,
    KB_ASSET_S3_ENABLED: env.KB_ASSET_S3_ENABLED === "true",
  });
}
export async function assertStorageConfiguration(client, env) {
  const selected = await configuredStorageSelection(env);
  if (!(await client.query("SELECT to_regclass('public.app_setting') AS present")).rows[0]?.present)
    return;
  const row = (await client.query("SELECT value FROM app_setting WHERE key='kb.asset-storage'"))
    .rows[0];
  if (!row) return; // Initial authority is established only by the fenced server.
  const { assetStorageAdmissionDomain } = await import("./asset-storage-domain.mjs");
  const domain = await assetStorageAdmissionDomain();
  if (!domain.sameAssetStorage(domain.parseAssetStorageMarker(row.value), selected))
    throw new Error("Asset storage mode/location requires offline migration.");
}
