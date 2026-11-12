import { randomUUID } from "node:crypto";
import type { LockQuery } from "./lock";
import { KbAdmissionError } from "./principal";

export const AUDIT_METADATA_KEYS = [
  "kbId",
  "slug",
  "name",
  "state",
  "ownerId",
  "shareUserId",
  "requestId",
  "dimension",
  "amount",
  "reservationId",
  "headSha",
  "metadataVersion",
  "reasonCode",
  // Grant edits (mcpGrants.updateMine): canonical JSON of the changed ceiling fields.
  "before",
  "after",
  // Temporary access (elevations): its id and database-clock expiry.
  "elevationId",
  "expiresAt",
  // Elevations a narrowing ended (JSON array, at most MCP_ELEVATION_MAX_ACTIVE ids).
  "elevationIds",
] as const;

export type AuditMetadataKey = (typeof AUDIT_METADATA_KEYS)[number];
export type AuditMetadata = Partial<Record<AuditMetadataKey, string>>;
export type AuditOutcome = "SUCCESS" | "FAILURE";

const ALLOWED = new Set<string>(AUDIT_METADATA_KEYS);
const FORBIDDEN = /source|error|body|query|stack|email|token|secret|password|ciphertext/i;

export type AuditEventInput = {
  opId: string;
  action: string;
  outcome: AuditOutcome;
  actorKey: string;
  actorUserIdSnapshot: string;
  actorUserId?: string | null;
  grantIdSnapshot?: string | null;
  kbId?: string | null;
  revision?: string | null;
  metadata?: AuditMetadata;
};

export function sanitizeAuditMetadata(input: Record<string, unknown> | undefined): AuditMetadata {
  const metadata: AuditMetadata = {};
  if (!input) return metadata;
  for (const [key, value] of Object.entries(input)) {
    if (FORBIDDEN.test(key) || !ALLOWED.has(key)) {
      throw new KbAdmissionError("FORBIDDEN", "Audit metadata is not allowlisted");
    }
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") {
      throw new KbAdmissionError("FORBIDDEN", "Audit metadata is not allowlisted");
    }
    metadata[key as AuditMetadataKey] = value;
  }
  return metadata;
}

export async function recordAuditEvent(query: LockQuery, input: AuditEventInput): Promise<void> {
  const metadata = sanitizeAuditMetadata(input.metadata);
  await query(
    `INSERT INTO "audit_event"
      (id, "createdAt", "opId", action, outcome, "actorKey", "actorUserIdSnapshot",
       "actorUserId", "grantIdSnapshot", "kbId", revision, metadata)
     VALUES ($1, now(), $2, $3, $4::"AuditOutcome", $5, $6, $7, $8, $9, $10, $11::jsonb)
     ON CONFLICT ("opId", action, outcome) DO NOTHING`,
    [
      randomUUID().replaceAll("-", "").slice(0, 24),
      input.opId,
      input.action,
      input.outcome,
      input.actorKey,
      input.actorUserIdSnapshot,
      input.actorUserId ?? null,
      input.grantIdSnapshot ?? null,
      input.kbId ?? null,
      input.revision ?? null,
      JSON.stringify(metadata),
    ],
  );
}

export async function recordAuditFailure(
  query: LockQuery,
  input: Omit<AuditEventInput, "opId" | "outcome">,
): Promise<string> {
  const requestId = randomUUID();
  await recordAuditEvent(query, {
    ...input,
    opId: requestId,
    outcome: "FAILURE",
    metadata: { ...input.metadata, requestId },
  });
  return requestId;
}

const SECURITY_EVENTS_PER_MINUTE = 10;
const securityWindows = new Map<string, { startedAt: number; count: number }>();

/**
 * Redacted, rate-limited security event (auth failures). Admission is per actor
 * and minute, in-process: an attacker cannot turn denials into unbounded audit writes.
 * Never carries the attacker-chosen reference, path or KB id; the request id is independent.
 */
export function admitSecurityEvent(actorKey: string, now = Date.now()): boolean {
  const window = securityWindows.get(actorKey);
  if (!window || now - window.startedAt >= 60_000) {
    if (securityWindows.size > 10_000) securityWindows.clear();
    securityWindows.set(actorKey, { startedAt: now, count: 1 });
    return true;
  }
  if (window.count >= SECURITY_EVENTS_PER_MINUTE) return false;
  window.count += 1;
  return true;
}
