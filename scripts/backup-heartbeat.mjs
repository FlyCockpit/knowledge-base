#!/usr/bin/env node
/**
 * Optional dead-man's-switch ping, sent by scripts/backup.sh after an encrypted bundle has
 * been uploaded off-site.
 *
 * A backup scheduler that stops running produces no error anywhere. An external
 * monitor (healthchecks.io, Cronitor, Uptime Kuma push URL, or your own
 * endpoint) inverts that: it expects this GET on a schedule and alerts when it
 * stops arriving. So the ping means exactly one thing — "an encrypted bundle landed in the
 * bucket" — and backup.sh only runs it after a successful upload.
 *
 * Failure here never fails the backup: the encrypted bundle is already safe, and a missed
 * ping is self-correcting because the monitor raises the alarm on its own. So
 * every error path warns and exits 0.
 *
 * The URL usually embeds a secret token, so only its hostname is ever printed.
 */

const TIMEOUT_MS = 10_000;
const ATTEMPTS = 3;
const BACKOFF_MS = [1_000, 2_000];

/** Warn and exit 0 — a heartbeat problem must never fail a good backup. */
function giveUp(message) {
  console.error(`WARNING: ${message}`);
  process.exit(0);
}

const raw = process.env.BACKUP_HEARTBEAT_URL;
if (!raw) {
  giveUp("BACKUP_HEARTBEAT_URL is not set — no heartbeat sent.");
}

let url;
try {
  url = new URL(raw);
} catch {
  giveUp("BACKUP_HEARTBEAT_URL is not a valid URL — no heartbeat sent.");
}

if (url.protocol !== "http:" && url.protocol !== "https:") {
  giveUp(
    `BACKUP_HEARTBEAT_URL must be an http:// or https:// URL (got "${url.protocol}") — no heartbeat sent.`,
  );
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let lastError = "unknown error";

for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { method: "GET", signal: controller.signal });
    if (response.ok) {
      console.log("Heartbeat sent.");
      process.exit(0);
    }
    lastError = `${url.host} responded ${response.status}`;
  } catch (error) {
    lastError =
      error?.name === "AbortError"
        ? `${url.host} did not respond within ${TIMEOUT_MS / 1000}s`
        : `${url.host} unreachable`;
  } finally {
    clearTimeout(timer);
  }

  const backoff = BACKOFF_MS[attempt - 1];
  if (attempt < ATTEMPTS && backoff !== undefined) await sleep(backoff);
}

giveUp(
  `backup heartbeat failed after ${ATTEMPTS} attempts: ${lastError}. The encrypted bundle itself is safe.`,
);
