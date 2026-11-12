/** Restore a validated pg_restore script byte-for-byte; never apply migrations here. */
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { boundedChild } from "./lib/bounded-child.mjs";

// Only pg_restore's bounded, generated preamble is inspected. Never search or
// substitute the body: COPY rows can contain SQL-looking timeout statements.
export async function restorePrefix(path) {
  const file = await open(path, "r");
  const buffer = Buffer.alloc(65_536);
  let bytesRead;
  try {
    ({ bytesRead } = await file.read(buffer));
  } finally {
    await file.close();
  }
  const text = buffer.subarray(0, bytesRead).toString("utf8");
  const marker = /\n--\n-- (?:Name: |Data for Name: |PostgreSQL database dump complete)/.exec(text);
  if (!marker) throw new Error("Unsupported pg_restore preamble boundary.");
  const prefix = text.slice(0, marker.index + 1);
  const lines = prefix.split("\n");
  const settings = new Set();
  for (const line of lines) {
    if (!line || line.startsWith("--")) continue;
    if (/^\\restrict [A-Za-z0-9]+$/.test(line)) continue;
    if (line === "SELECT pg_catalog.set_config('search_path', '', false);") continue;
    const setting =
      /^SET (statement_timeout|lock_timeout|idle_in_transaction_session_timeout|transaction_timeout) = 0;$/.exec(
        line,
      );
    if (setting) {
      settings.add(setting[1]);
      continue;
    }
    if (
      /^SET (?:client_encoding = 'UTF8'|standard_conforming_strings = on|check_function_bodies = false|xmloption = content|client_min_messages = warning|row_security = off|default_tablespace = ''|default_table_access_method = heap);$/.test(
        line,
      )
    )
      continue;
    throw new Error("Unsupported pg_restore preamble statement.");
  }
  // PG18.6 still emits exactly these four timeout resets; other SETs above
  // are allowlisted separately. Never admit an unknown preamble statement.
  if (settings.size !== 4) throw new Error("PostgreSQL 18 pg_restore timeout preamble required.");
  return { prefix, offset: Buffer.byteLength(prefix) };
}

export async function applyArchive(
  path,
  {
    env = process.env,
    signal,
    limits = ["5s", "60s", "1800s"],
    timeout = 1_810_000,
    psql = "psql",
  } = {},
) {
  const { prefix, offset } = await restorePrefix(path);
  if (limits.some((value) => !/^\d+(?:ms|s)$/.test(value)))
    throw new Error("Invalid restore limits.");
  const owner = boundedChild(
    psql,
    ["-X", "-q", "--single-transaction", "-v", "ON_ERROR_STOP=1", "--file=-"],
    {
      env: {
        ...env,
        PGCONNECT_TIMEOUT: "10",
        PGOPTIONS: "-c statement_timeout=60s -c lock_timeout=5s",
      },
      signal,
      timeout,
      stdio: ["pipe", "inherit", "inherit"],
    },
  );
  const body = createReadStream(path, { start: offset });
  owner.child.stdin.on("error", () => owner.stop());
  body.on("error", () => owner.stop());
  // psql starts BEGIN before reading stdin. Override only generated resets,
  // before any archive object/data; the remainder is streamed byte-for-byte.
  owner.child.stdin.write(prefix);
  owner.child.stdin.write(
    `SET LOCAL lock_timeout = '${limits[0]}';\nSET LOCAL statement_timeout = '${limits[1]}';\nSET LOCAL transaction_timeout = '${limits[2]}';\nSET LOCAL idle_in_transaction_session_timeout = '60s';\n`,
  );
  body.pipe(owner.child.stdin);
  try {
    await owner.done;
  } finally {
    body.destroy();
  }
}

export async function prepareArchive(path, output, { env = process.env, signal } = {}) {
  const input = await open(path, "r"),
    out = await open(output, "w", 0o600);
  try {
    await boundedChild(
      "pg_restore",
      ["--no-owner", "--no-privileges", `--exclude-schema=knowledge_base_control`, "--file=-"],
      { env, signal, timeout: 120000, stdio: [input.fd, out.fd, "ignore"] },
    ).done;
    await out.sync();
  } finally {
    await input.close();
    await out.close();
  }
  await restorePrefix(output);
}
