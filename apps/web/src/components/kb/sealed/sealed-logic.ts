import type { AppRouterClient } from "@knowledge-base/api/routers/index";

/** CONTRACT: sealed plaintext is at most 16 KiB of UTF-8. */
export const SEALED_PLAINTEXT_MAX_BYTES = 16384;
/** CONTRACT: a value's name is at most 120 characters (server `sealedLabelSchema`). */
export const SEALED_LABEL_MAX = 120;
export const utf8ByteLength = (value: string) => new TextEncoder().encode(value).length;

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const PUBLIC_KEY = /^[A-Za-z0-9+/]{43}=$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

type Sealed = AppRouterClient["kbSealed"];
export type SealedValue = Awaited<ReturnType<Sealed["list"]>>["items"][number];
export type SealedGrant = SealedValue["grants"][number];
export type SealedConsumer = Awaited<ReturnType<Sealed["consumers"]>>["items"][number];
export type SealedConsumerProblem = SealedConsumer["problems"][number];
export type SealedUsage = Awaited<ReturnType<Sealed["usage"]>>["usage"][number];

/** A value's name: required, trimmed, at most 120 characters, no control characters. */
export function sealedLabelIssue(raw: string): "required" | "tooLong" | "invalid" | null {
  const value = raw.trim();
  if (!value) return "required";
  if (value.length > SEALED_LABEL_MAX) return "tooLong";
  if (CONTROL.test(value) || !value.isWellFormed()) return "invalid";
  return null;
}

/** The secret value's bounds: present and at most 16 KiB of UTF-8. */
export function sealedValueIssue(value: string): "required" | "tooLong" | null {
  const bytes = utf8ByteLength(value);
  if (bytes === 0) return "required";
  if (bytes > SEALED_PLAINTEXT_MAX_BYTES) return "tooLong";
  return null;
}

export const SEALED_EXPIRY_CHOICES = ["1", "7", "30", "365", "custom"] as const;
export type SealedExpiryChoice = (typeof SEALED_EXPIRY_CHOICES)[number];
/** The existing approval policy default: 30 days. */
export const SEALED_DEFAULT_EXPIRY: SealedExpiryChoice = "30";
const DAY_MS = 86_400_000;

/** `datetime-local` input text (local time) as a Date, or null. */
function localDateTime(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [y, mo, d, h, mi] = match.slice(1).map(Number) as [number, number, number, number, number];
  const date = new Date(y, mo - 1, d, h, mi);
  return date.getFullYear() === y &&
    date.getMonth() === mo - 1 &&
    date.getDate() === d &&
    date.getHours() === h &&
    date.getMinutes() === mi
    ? date
    : null;
}

/** The chosen access end, or null when the custom date is missing or not in the future. */
export function sealedExpiryFromChoice(
  choice: SealedExpiryChoice,
  custom: string,
  now: Date,
): Date | null {
  if (choice !== "custom") return new Date(now.getTime() + Number(choice) * DAY_MS);
  const date = localDateTime(custom);
  return date && date.getTime() > now.getTime() ? date : null;
}

export type SealedKey = { recipientKeyId: string; recipientPublicKey: string };

/** A manually entered key, trimmed, when both parts are well formed. */
export function manualKey(keyId: string, publicKey: string): SealedKey | null {
  const id = keyId.trim().toLowerCase();
  const key = publicKey.trim();
  return UUID.test(id) && PUBLIC_KEY.test(key)
    ? { recipientKeyId: id, recipientPublicKey: key }
    : null;
}

/** Why "Give access" is not available yet, in the order a person fixes them. */
export type GrantBlocker = "chooseToken" | "tokenProblem" | "needKey" | "alreadyGranted" | "expiry";

/**
 * Refuses an approval that could never be used before it is sent: a token
 * that cannot read sealed values here, no key to encrypt to, or an end date
 * that is not in the future.
 */
export function grantBlocker(input: {
  consumer: SealedConsumer | null;
  key: SealedKey | null;
  expiresAt: Date | null;
  now: Date;
  /** The value's existing approvals: the same token and key can be approved only once. */
  existing?: readonly { consumerId: string; recipientKeyId: string }[];
}): GrantBlocker | null {
  if (!input.consumer) return "chooseToken";
  if (input.consumer.problems.length > 0) return "tokenProblem";
  if (!input.key) return "needKey";
  const { consumerId } = input.consumer,
    { recipientKeyId } = input.key;
  if (
    input.existing?.some((g) => g.consumerId === consumerId && g.recipientKeyId === recipientKeyId)
  )
    return "alreadyGranted";
  if (!input.expiresAt || input.expiresAt.getTime() <= input.now.getTime()) return "expiry";
  return null;
}

/** The exact one-record, one-token, one-key approval the server receives. */
export function grantPayload(input: {
  kbId: string;
  reference: string;
  consumer: SealedConsumer;
  key: SealedKey;
  expiresAt: Date;
  idempotencyKey: string;
}) {
  return {
    kbId: input.kbId,
    idempotencyKey: input.idempotencyKey,
    reference: input.reference,
    consumerKind: "pat" as const,
    consumerId: input.consumer.consumerId,
    recipientKeyId: input.key.recipientKeyId,
    recipientPublicKey: input.key.recipientPublicKey,
    // Whole milliseconds, UTC `Z`: the server's exact-instant expiry spelling.
    expiresAt: new Date(Math.floor(input.expiresAt.getTime())).toISOString(),
  };
}

/**
 * One grant attempt: an unchanged retry (same form values) resends the frozen
 * first request, same absolute end date and idempotency key, so a committed
 * but unacknowledged approval replays its receipt; a changed form builds a new
 * request under a new key.
 */
export function nextGrantAttempt<P>(
  previous: { signature: string; payload: P } | null,
  signature: string,
  build: (renewKey: boolean) => P | null,
): { signature: string; payload: P } | null {
  if (previous && previous.signature === signature) return previous;
  const payload = build(previous !== null);
  return payload === null ? null : { signature, payload };
}

/**
 * A grant attempt's identity: the form values plus the key's id and bytes (not
 * where the key was found), so a retry never sends a key other than the one shown.
 */
export function grantAttemptSignature(values: unknown, key: SealedKey | null): string {
  return JSON.stringify({ values, key: key && [key.recipientKeyId, key.recipientPublicKey] });
}

/** A manually entered key belongs to the token it was typed for: switching clears it. */
export function switchConsumerDraft<
  T extends { consumerId: string; keyId: string; publicKey: string },
>(draft: T, consumerId: string): T {
  return draft.consumerId === consumerId
    ? draft
    : { ...draft, consumerId, keyId: "", publicKey: "" };
}

/** True when the token itself ends before the chosen access end. */
export function tokenEndsFirst(consumer: SealedConsumer | null, expiresAt: Date | null): boolean {
  if (!consumer?.expiresAt || !expiresAt) return false;
  return Date.parse(consumer.expiresAt) < expiresAt.getTime();
}

/** Your tokens and members' tokens; within each, tokens that would work come first. */
export function groupConsumers(items: readonly SealedConsumer[]) {
  const usableFirst = (list: SealedConsumer[]) =>
    list.sort((a, b) => Number(a.problems.length > 0) - Number(b.problems.length > 0));
  return {
    own: usableFirst(items.filter((c) => c.holder.kind === "self")),
    members: usableFirst(items.filter((c) => c.holder.kind === "member")),
  };
}

/** The exact identity `revokeGrant` removes: one record, one token, one key. */
export function revokeGrantPayload(input: {
  kbId: string;
  reference: string;
  grant: SealedGrant;
  idempotencyKey: string;
}) {
  return {
    kbId: input.kbId,
    idempotencyKey: input.idempotencyKey,
    reference: input.reference,
    consumerKind: "pat" as const,
    consumerId: input.grant.consumerId,
    recipientKeyId: input.grant.recipientKeyId,
  };
}

/** Short display of a key id: enough to compare with the CLI output. */
export const shortKeyId = (id: string) => id.slice(0, 8);

/** Relative time ("in 3 days", "2 hours ago") in the reader's language. */
export function relativeTime(iso: string, now: Date, lang: string): string {
  const diff = Date.parse(iso) - now.getTime();
  const abs = Math.abs(diff);
  const format = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });
  if (abs >= DAY_MS) return format.format(Math.round(diff / DAY_MS), "day");
  if (abs >= 3_600_000) return format.format(Math.round(diff / 3_600_000), "hour");
  return format.format(Math.round(diff / 60_000), "minute");
}

export const formatDate = (iso: string, lang: string) =>
  new Date(iso).toLocaleDateString(lang, { year: "numeric", month: "short", day: "numeric" });
