import { createHash } from "node:crypto";

/**
 * A backup namespace identifies a database deployment without storing its URL
 * or credentials in object keys. Credentials are intentionally excluded so a
 * key rotation does not make backups disappear; moving a database endpoint
 * creates a new namespace and therefore a safe "no proven backup yet" state.
 */
function backupOriginId(databaseUrl = process.env.DATABASE_URL) {
  if (!databaseUrl) throw new Error("DATABASE_URL is not set.");
  const url = new URL(databaseUrl);
  const database = decodeURIComponent(url.pathname.replace(/^\/+/, "").split("?")[0] ?? "");
  if (!database) throw new Error("DATABASE_URL does not name a database.");
  const canonical = `${url.protocol.toLowerCase()}//${url.hostname.toLowerCase()}:${url.port || "5432"}/${database}`;
  return createHash("sha256").update(canonical).digest("hex").slice(0, 24);
}

export function backupNamespace(prefix, databaseUrl = process.env.DATABASE_URL) {
  const normalized = (prefix ?? "database").replace(/^\/+|\/+$/g, "");
  if (!normalized) throw new Error("BACKUP_S3_PREFIX must not be empty.");
  return `${normalized}/${backupOriginId(databaseUrl)}`;
}

if (process.argv[1]?.endsWith("backup-identity.mjs")) {
  try {
    process.stdout.write(`${backupOriginId()}\n`);
  } catch (error) {
    console.error(`FATAL: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
