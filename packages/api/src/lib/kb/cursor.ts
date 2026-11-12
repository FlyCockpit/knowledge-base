import { createHmac, timingSafeEqual } from "node:crypto";

import { KbDomainError } from "./errors";

export const CURSOR_TTL_MS = 15 * 60 * 1000;
/** A max-length Path plus a short ordinal/score prefix still fits one final ordered key. */
const MAX_LAST_KEY_BYTES = 600;
const MAX_CURSOR_BYTES = 1024;

export type CursorPayload = {
  v: 1;
  actorKey: string;
  kbId: string;
  filterHash: string;
  sortKey: string;
  revision: string;
  lastKey: string | null;
  exp: number;
};

export type CursorSigner = {
  sign(payload: CursorPayload): string;
  verify(token: string, expected: Omit<CursorPayload, "lastKey" | "exp" | "v">): CursorPayload;
};

function writeLengthPrefixed(buf: Buffer[], value: string, max: number): void {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > max) {
    throw new KbDomainError("INVALID_CURSOR", "Invalid cursor");
  }
  const len = Buffer.alloc(2);
  len.writeUInt16BE(bytes.length, 0);
  buf.push(len, bytes);
}

function readLengthPrefixed(
  data: Buffer,
  offset: number,
  max: number,
): { value: string; next: number } {
  const len = data.readUInt16BE(offset);
  offset += 2;
  if (len > max) throw new KbDomainError("INVALID_CURSOR", "Invalid cursor");
  const value = data.subarray(offset, offset + len).toString("utf8");
  return { value, next: offset + len };
}

function encodePayload(payload: CursorPayload): Buffer {
  if (payload.v !== 1) throw new KbDomainError("INVALID_CURSOR", "Invalid cursor");
  const parts: Buffer[] = [Buffer.from([1])];
  const exp = Buffer.alloc(6);
  exp.writeUIntBE(payload.exp, 0, 6);
  parts.push(exp);
  writeLengthPrefixed(parts, payload.actorKey, 128);
  writeLengthPrefixed(parts, payload.kbId, 64);
  const filter = Buffer.from(payload.filterHash, "hex");
  if (filter.length !== 32) throw new KbDomainError("INVALID_CURSOR", "Invalid cursor");
  parts.push(filter);
  writeLengthPrefixed(parts, payload.sortKey, 32);
  if (payload.revision === "*") {
    parts.push(Buffer.from([0]));
  } else {
    const rev = Buffer.from(payload.revision, "hex");
    if (rev.length !== 20) throw new KbDomainError("INVALID_CURSOR", "Invalid cursor");
    parts.push(Buffer.from([1]), rev);
  }
  if (payload.lastKey === null) {
    parts.push(Buffer.from([0xff, 0xff]));
  } else {
    writeLengthPrefixed(parts, payload.lastKey, MAX_LAST_KEY_BYTES);
  }
  return Buffer.concat(parts);
}

function decodePayload(body: Buffer): CursorPayload {
  let offset = 0;
  const version = body[offset++];
  if (version !== 1) throw new KbDomainError("INVALID_CURSOR", "Invalid cursor");
  const exp = Number(body.readUIntBE(offset, 6));
  offset += 6;
  const actor = readLengthPrefixed(body, offset, 128);
  offset = actor.next;
  const kb = readLengthPrefixed(body, offset, 64);
  offset = kb.next;
  const filterHash = body.subarray(offset, offset + 32).toString("hex");
  offset += 32;
  const sort = readLengthPrefixed(body, offset, 32);
  offset = sort.next;
  const revFlag = body[offset++];
  let revision: string;
  if (revFlag === 0) {
    revision = "*";
  } else if (revFlag === 1) {
    revision = body.subarray(offset, offset + 20).toString("hex");
    offset += 20;
  } else {
    throw new KbDomainError("INVALID_CURSOR", "Invalid cursor");
  }
  const lastLen = body.readUInt16BE(offset);
  offset += 2;
  let lastKey: string | null;
  if (lastLen === 0xffff) {
    lastKey = null;
  } else {
    if (lastLen > MAX_LAST_KEY_BYTES) throw new KbDomainError("INVALID_CURSOR", "Invalid cursor");
    lastKey = body.subarray(offset, offset + lastLen).toString("utf8");
    offset += lastLen;
  }
  if (offset !== body.length) throw new KbDomainError("INVALID_CURSOR", "Invalid cursor");
  return {
    v: 1,
    actorKey: actor.value,
    kbId: kb.value,
    filterHash,
    sortKey: sort.value,
    revision,
    lastKey,
    exp,
  };
}

export function createCursorSigner(secret: Buffer): CursorSigner {
  return {
    sign(payload) {
      const packed = encodePayload(payload);
      const body = packed.toString("base64url");
      const mac = createHmac("sha256", secret).update(body).digest("base64url");
      const token = `${body}.${mac}`;
      if (Buffer.byteLength(token, "utf8") > MAX_CURSOR_BYTES) {
        throw new KbDomainError("INVALID_CURSOR", "Invalid cursor");
      }
      return token;
    },
    verify(token, expected) {
      if (Buffer.byteLength(token, "utf8") > MAX_CURSOR_BYTES) {
        throw new KbDomainError("INVALID_CURSOR", "Invalid cursor");
      }
      const dot = token.lastIndexOf(".");
      if (dot <= 0) throw new KbDomainError("INVALID_CURSOR", "Invalid cursor");
      const body = token.slice(0, dot);
      const mac = token.slice(dot + 1);
      const expectedMac = createHmac("sha256", secret).update(body).digest("base64url");
      const a = Buffer.from(mac, "utf8");
      const b = Buffer.from(expectedMac, "utf8");
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        throw new KbDomainError("INVALID_CURSOR", "Invalid cursor");
      }
      const payload = decodePayload(Buffer.from(body, "base64url"));
      if (payload.exp < Date.now()) throw new KbDomainError("INVALID_CURSOR", "Cursor expired");
      if (
        payload.actorKey !== expected.actorKey ||
        payload.kbId !== expected.kbId ||
        payload.filterHash !== expected.filterHash ||
        // "*" (like revision) lets a caller read a signed pin, then validate it itself.
        (expected.sortKey !== "*" && payload.sortKey !== expected.sortKey) ||
        (expected.revision !== "*" && payload.revision !== expected.revision)
      ) {
        throw new KbDomainError("INVALID_CURSOR", "Invalid cursor");
      }
      return payload;
    },
  };
}

export function stableFilterHash(value: unknown): string {
  return createHmac("sha256", Buffer.from("kb-filter", "utf8"))
    .update(JSON.stringify(value ?? null))
    .digest("hex");
}

export function cursorExpiry(now = Date.now()): number {
  return now + CURSOR_TTL_MS;
}

export { KB_CURSOR_MAX_BYTES, KB_PAGE_DEFAULT, KB_PAGE_MAX } from "./protocol/common";
