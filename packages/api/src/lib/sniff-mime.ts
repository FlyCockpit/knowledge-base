import { crc32, inflateSync } from "node:zlib";

import { CAS_BLOB_MAX_BYTES } from "./kb/limits";

/** MIME types allowed for immutable CAS asset bytes. */
export const CAS_SNIFF_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/webm",
  "audio/mpeg",
  "audio/wav",
  "audio/ogg",
  "application/pdf",
] as const;

export type CasSniffMime = (typeof CAS_SNIFF_MIME_TYPES)[number];

export type SniffResult =
  | { ok: true; mime: CasSniffMime; attachmentOnly: boolean }
  | { ok: false; reason: string };

const MEDIA_SCAN_MULTIPLIER = 32;
const MEDIA_MIN_VISITS = 100_000;
const MEDIA_MAX_DEPTH = 64;

class MediaBudgetExceeded extends Error {}

/** One invocation owns this budget, including failed format probes. Scan charges
 * reserve conservative byte spans BEFORE walking/copying them; skipped payloads
 * may be overcharged. No parser, nested container or PDF reader resets it.
 */
class MediaWorkBudget {
  scannedBytes = 0;
  visits = 0;
  maxDepth = 0;
  decodedBytes = 0;
  readonly scanLimit: number;
  readonly visitLimit: number;
  constructor(inputBytes: number) {
    this.scanLimit = inputBytes * MEDIA_SCAN_MULTIPLIER;
    // Even one-byte samples and short audio packets are valid. Budget records
    // against encoded bytes, not duration or an assumed average codec bitrate.
    // All byte scans, repeated references and decoding also spend the scan budget.
    this.visitLimit = Math.max(MEDIA_MIN_VISITS, inputBytes);
  }

  scan(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.scanLimit - this.scannedBytes)
      throw new MediaBudgetExceeded("media scan budget");
    this.scannedBytes += bytes;
  }

  visit(count = 1): void {
    if (!Number.isSafeInteger(count) || count < 0 || count > this.visitLimit - this.visits)
      throw new MediaBudgetExceeded("media record budget");
    this.visits += count;
  }

  depth(depth: number): void {
    if (depth > MEDIA_MAX_DEPTH) throw new MediaBudgetExceeded("media depth budget");
    this.maxDepth = Math.max(this.maxDepth, depth);
  }
}

const CAS_SNIFF_SET = new Set<string>(CAS_SNIFF_MIME_TYPES);

export function isCasSniffMime(mime: string): mime is CasSniffMime {
  return CAS_SNIFF_SET.has(mime);
}

function readU16Be(bytes: Buffer, offset: number): number | null {
  if (offset + 2 > bytes.length) return null;
  return bytes.readUInt16BE(offset);
}

function readU32Be(bytes: Buffer, offset: number): number | null {
  if (offset + 4 > bytes.length) return null;
  return bytes.readUInt32BE(offset);
}

function readU32Le(bytes: Buffer, offset: number): number | null {
  if (offset + 4 > bytes.length) return null;
  return bytes.readUInt32LE(offset);
}

/** Container identifiers are byte strings; decoding must never alias distinct tags. */
function bytesEqual(bytes: Buffer, literal: string): boolean {
  return bytes.equals(Buffer.from(literal, "latin1"));
}

function hasPrefix(bytes: Buffer, offset: number, literal: string): boolean {
  return bytesEqual(bytes.subarray(offset, offset + literal.length), literal);
}

function looksLikeHtml(bytes: Buffer): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.length, 512)).toString("utf8").trimStart();
  if (/^<!DOCTYPE\s+html/i.test(sample) || /^<html[\s>]/i.test(sample)) return true;
  if (/<script[\s>]/i.test(sample)) return true;
  return false;
}

function looksLikeSvg(bytes: Buffer): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.length, 512)).toString("utf8").trimStart();
  if (/<svg[\s>]/i.test(sample)) return true;
  if (/^<\?xml/i.test(sample) && /<svg[\s>]/i.test(sample)) return true;
  return false;
}

function isJpegSofMarker(marker: number): boolean {
  return (
    marker >= 0xc0 &&
    marker <= 0xcf &&
    marker !== 0xc4 && // DHT
    marker !== 0xc8 && // reserved JPG
    marker !== 0xcc // DAC
  );
}

/**
 * Structural JPEG walk. Requires SOI, a frame (SOF), at least one scan (SOS)
 * with entropy-coded data, and a final EOI at the exact end of the file.
 * Progressive JPEGs (multiple scans with markers between them) and restart
 * markers inside scans are accepted.
 */
function validateJpeg(budget: MediaWorkBudget, bytes: Buffer): boolean {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;
  if (bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) return false;
  budget.scan(bytes.length * 2);
  let i = 2;
  let sof = 0;
  let framePrecision = 0;
  const components = new Set<number>();
  let seenSos = false;
  while (i < bytes.length - 1) {
    budget.visit();
    if (bytes[i] !== 0xff) return false;
    let j = i + 1;
    while (j < bytes.length && bytes[j] === 0xff) j += 1; // fill bytes
    if (j >= bytes.length) return false;
    const marker = bytes[j]!;
    j += 1;
    if (marker === 0xd9) return j === bytes.length && sof !== 0 && seenSos;
    if (marker === 0xd8 || marker === 0x00) return false;
    if (marker >= 0xd0 && marker <= 0xd7) return false; // restart markers belong inside scans
    if (marker === 0x01) {
      i = j;
      continue;
    }
    const lengthPrefixed =
      isJpegSofMarker(marker) ||
      marker === 0xc4 || // DHT
      marker === 0xc8 || // reserved
      marker === 0xcc || // DAC
      marker === 0xda || // SOS
      (marker >= 0xdb && marker <= 0xdf) ||
      (marker >= 0xe0 && marker <= 0xef) || // APPn
      (marker >= 0xf0 && marker <= 0xfd) ||
      marker === 0xfe; // COM
    if (!lengthPrefixed) return false;
    const len = readU16Be(bytes, j);
    if (len === null || len < 2 || j + len > bytes.length) return false;
    if (marker === 0xda) {
      const ns = bytes[j + 2]!;
      if (!sof || len < 8 || ns < 1 || ns > 4 || len !== 6 + 2 * ns) return false;
      const scanComponents = new Set<number>();
      for (let c = 0; c < ns; c += 1) {
        const id = bytes[j + 3 + 2 * c]!;
        const tables = bytes[j + 4 + 2 * c]!;
        if (!components.has(id) || scanComponents.has(id) || tables >> 4 > 3 || (tables & 15) > 3)
          return false;
        scanComponents.add(id);
      }
      const ss = bytes[j + 3 + 2 * ns]!;
      const se = bytes[j + 4 + 2 * ns]!;
      const ah = bytes[j + 5 + 2 * ns]! >> 4;
      const al = bytes[j + 5 + 2 * ns]! & 15;
      const mode = sof & 3;
      if (mode === 3) {
        if (ss < 1 || ss > 7 || se !== 0 || ah !== 0 || al >= framePrecision) return false;
      } else if (mode === 2) {
        if (
          ss > se ||
          se > 63 ||
          (ss === 0 ? se !== 0 : ns !== 1) ||
          ah > 13 ||
          al > 13 ||
          (ah !== 0 && ah !== al + 1)
        )
          return false;
      } else if (ss !== 0 || se !== 63 || ah !== 0 || al !== 0) return false;
      seenSos = true;
      // Entropy-coded scan: stuffed bytes and restart markers stay inside the
      // scan; any other marker returns to the outer parser (progressive scans,
      // interleaved DHT/DRI segments, or the final EOI).
      let p = j + len;
      let resumed = false;
      let entropyBytes = 0;
      while (p < bytes.length - 1) {
        if (bytes[p] !== 0xff) {
          entropyBytes += 1;
          p += 1;
          continue;
        }
        const next = bytes[p + 1]!;
        if (next === 0x00 || next === 0xff || (next >= 0xd0 && next <= 0xd7)) {
          if (next >= 0xd0 && next <= 0xd7) budget.visit();
          if (next === 0x00) entropyBytes += 1;
          p += 2;
          continue;
        }
        resumed = true;
        break;
      }
      if (!resumed || entropyBytes === 0) return false;
      i = p;
      continue;
    }
    if (isJpegSofMarker(marker)) {
      if (sof || len < 8) return false;
      sof = marker;
      const precision = bytes[j + 2]!;
      framePrecision = precision;
      const lossless = (marker & 3) === 3;
      if (
        marker === 0xc0
          ? precision !== 8
          : lossless
            ? precision < 2 || precision > 16
            : precision !== 8 && precision !== 12
      )
        return false;
      if (bytes.readUInt16BE(j + 3) === 0 || bytes.readUInt16BE(j + 5) === 0) return false;
      const nf = bytes[j + 7]!;
      if (nf < 1 || nf > 4 || len !== 8 + 3 * nf) return false;
      for (let c = 0; c < nf; c += 1) {
        const id = bytes[j + 8 + 3 * c]!;
        const sampling = bytes[j + 9 + 3 * c]!;
        const table = bytes[j + 10 + 3 * c]!;
        if (
          components.has(id) ||
          sampling >> 4 < 1 ||
          sampling >> 4 > 4 ||
          (sampling & 15) < 1 ||
          (sampling & 15) > 4 ||
          table > 3 ||
          (lossless && table !== 0)
        )
          return false;
        components.add(id);
      }
    }
    i = j + len;
  }
  return false;
}

/**
 * Structural PNG walk. Requires IHDR, at least one non-empty IDAT chunk with
 * actual image data, and IEND at the exact end of the file.
 */
function validatePng(budget: MediaWorkBudget, bytes: Buffer): boolean {
  if (
    bytes.length < 8 ||
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47 ||
    bytes[4] !== 0x0d ||
    bytes[5] !== 0x0a ||
    bytes[6] !== 0x1a ||
    bytes[7] !== 0x0a
  ) {
    return false;
  }
  budget.scan(bytes.length * 2); // chunk walk and CRC
  let off = 8;
  let color = -1;
  let depth = 0;
  let palette = false;
  let idat = false;
  let imageBytes = 0;
  let endedIdat = false;
  const depths: Record<number, readonly number[]> = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16],
  };
  while (off + 12 <= bytes.length) {
    budget.visit();
    const len = bytes.readUInt32BE(off);
    const type = bytes.subarray(off + 4, off + 8);
    if (
      len > 0x7fffffff ||
      off + 12 + len > bytes.length ||
      !type.every((byte) => (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122)) ||
      (type[2]! & 0x20) !== 0
    )
      return false;
    if (bytes.readUInt32BE(off + 8 + len) !== crc32(bytes.subarray(off + 4, off + 8 + len)))
      return false;
    if (off === 8 && !bytesEqual(type, "IHDR")) return false;
    if (bytesEqual(type, "IHDR")) {
      if (off !== 8 || len !== 13) return false;
      const width = bytes.readUInt32BE(off + 8),
        height = bytes.readUInt32BE(off + 12);
      depth = bytes[off + 16]!;
      color = bytes[off + 17]!;
      if (
        !width ||
        width > 0x7fffffff ||
        !height ||
        height > 0x7fffffff ||
        !depths[color]?.includes(depth) ||
        bytes[off + 18] !== 0 ||
        bytes[off + 19] !== 0 ||
        bytes[off + 20]! > 1
      )
        return false;
    } else if (bytesEqual(type, "PLTE")) {
      if (
        palette ||
        idat ||
        color === 0 ||
        color === 4 ||
        len === 0 ||
        len % 3 ||
        len > 768 ||
        (color === 3 && len / 3 > 2 ** depth)
      )
        return false;
      palette = true;
    } else if (bytesEqual(type, "IDAT")) {
      if (endedIdat || (color === 3 && !palette)) return false;
      idat = true;
      imageBytes += len;
    } else {
      if (idat) endedIdat = true;
      if (bytesEqual(type, "IEND")) return len === 0 && imageBytes > 0 && off + 12 === bytes.length;
      if ((type[0]! & 0x20) === 0) return false; // unknown critical chunk
    }
    off += 12 + len;
  }
  return false;
}

function skipGifSubBlocks(
  budget: MediaWorkBudget,
  bytes: Buffer,
  i: number,
  requireData = false,
): number {
  let dataBytes = 0;
  // i points at the first sub-block size byte; returns the offset just past
  // the terminating zero block, or -1 when the chain is malformed/truncated.
  while (i < bytes.length) {
    budget.visit();
    const size = bytes[i]!;
    i += 1;
    if (size === 0) return requireData && dataBytes === 0 ? -1 : i;
    if (i + size > bytes.length) return -1;
    dataBytes += size;
    i += size;
  }
  return -1;
}

/**
 * Structural GIF walk. Handles the full sub-block chains of graphic control,
 * comment, application and plain-text extensions (animated and commented
 * GIFs), and requires at least one image descriptor before the trailer.
 */
function validateGif(budget: MediaWorkBudget, bytes: Buffer): boolean {
  if (bytes.length < 14) return false;
  if (!hasPrefix(bytes, 0, "GIF87a") && !hasPrefix(bytes, 0, "GIF89a")) return false;
  budget.scan(bytes.length * 2); // descriptors and sub-block walks
  const width = bytes.readUInt16LE(6),
    height = bytes.readUInt16LE(8);
  if (!width || !height) return false;
  let i = 13;
  const packed = bytes[10]!;
  if (packed & 0x80) {
    const colors = 2 ** ((packed & 0x07) + 1);
    if (bytes[11]! >= colors) return false;
    i += 3 * colors;
  }
  let seenImage = false;
  while (i < bytes.length) {
    budget.visit();
    const block = bytes[i]!;
    if (block === 0x3b) return i === bytes.length - 1 && seenImage;
    if (block === 0x21) {
      if (i + 2 >= bytes.length) return false;
      const label = bytes[i + 1]!;
      const size = bytes[i + 2]!;
      if (label === 0xf9) {
        if (
          size !== 4 ||
          i + 8 > bytes.length ||
          bytes[i + 7] !== 0 ||
          bytes[i + 3]! & 0xe0 ||
          ((bytes[i + 3]! >> 2) & 7) > 3
        )
          return false;
      } else if (label === 0xff) {
        if (size !== 11) return false;
      } else if (label === 0x01) {
        if (size !== 12 || i + 15 > bytes.length || !(packed & 0x80)) return false;
        const gridWidth = bytes.readUInt16LE(i + 7),
          gridHeight = bytes.readUInt16LE(i + 9);
        const colors = 2 ** ((packed & 7) + 1);
        if (
          !gridWidth ||
          !gridHeight ||
          bytes.readUInt16LE(i + 3) + gridWidth > width ||
          bytes.readUInt16LE(i + 5) + gridHeight > height ||
          !bytes[i + 11] ||
          !bytes[i + 12] ||
          bytes[i + 13]! >= colors ||
          bytes[i + 14]! >= colors
        )
          return false;
      } else if (label !== 0xfe) return false;
      i = skipGifSubBlocks(budget, bytes, i + 2); // extension chains may be empty
      if (i === -1) return false;
      continue;
    }
    if (block === 0x2c) {
      if (i + 10 >= bytes.length) return false;
      const left = bytes.readUInt16LE(i + 1),
        top = bytes.readUInt16LE(i + 3);
      const imageWidth = bytes.readUInt16LE(i + 5),
        imageHeight = bytes.readUInt16LE(i + 7);
      const packedLocal = bytes[i + 9]!;
      if (
        !imageWidth ||
        !imageHeight ||
        left + imageWidth > width ||
        top + imageHeight > height ||
        packedLocal & 0x18 ||
        !((packedLocal | packed) & 0x80)
      )
        return false;
      let skip = 10;
      if (packedLocal & 0x80) {
        skip += 3 * 2 ** ((packedLocal & 0x07) + 1);
      }
      if (i + skip >= bytes.length) return false;
      const codeSize = bytes[i + skip]!;
      if (codeSize < 2 || codeSize > 8) return false;
      i = skipGifSubBlocks(budget, bytes, i + skip + 1, true);
      if (i === -1) return false;
      seenImage = true;
      continue;
    }
    return false;
  }
  return false;
}

/** Lossy VP8 payload must open with a keyframe: frame tag, start code, dimensions. */
function webpVp8ChunkOk(bytes: Buffer, start: number, end: number): boolean {
  if (end - start <= 10) return false; // fixed header alone has no coded data
  if ((bytes[start]! & 0x01) !== 0) return false; // frame type bit: 0 = keyframe
  if (bytes[start + 3] !== 0x9d || bytes[start + 4] !== 0x01 || bytes[start + 5] !== 0x2a) {
    return false;
  }
  const width = bytes[start + 6]! | ((bytes[start + 7]! & 0x3f) << 8);
  const height = bytes[start + 8]! | ((bytes[start + 9]! & 0x3f) << 8);
  const tag = bytes.readUIntLE(start, 3);
  const partition = tag >>> 5;
  return (
    width > 0 &&
    height > 0 &&
    ((tag >> 1) & 7) <= 3 &&
    (tag & 16) !== 0 &&
    partition > 0 &&
    partition <= end - start - 10
  );
}

/** VP8L: signature, 14-bit width-1, 14-bit height-1, alpha hint, 3-bit version. */
function webpVp8lChunkOk(bytes: Buffer, start: number, end: number): boolean {
  if (end - start <= 5) return false; // require data after the image header
  if (bytes[start] !== 0x2f) return false;
  const bits = bytes.readUInt32LE(start + 1);
  // Every encoded dimension denotes 1..16384 pixels; alpha is only a hint.
  // Only the version (bits 29..31) is reserved and must be zero.
  return bits >>> 29 === 0;
}

/** An animation frame is valid when its subchunks contain a non-empty coded image. */
function webpAnmfChunkOk(
  budget: MediaWorkBudget,
  bytes: Buffer,
  start: number,
  end: number,
  canvasWidth: number,
  canvasHeight: number,
): boolean {
  budget.depth(2);
  budget.scan(end - start);
  if (end - start < 16) return false;
  const width = bytes.readUIntLE(start + 6, 3) + 1,
    height = bytes.readUIntLE(start + 9, 3) + 1;
  if (
    bytes[start + 15]! & 0xfc ||
    bytes.readUIntLE(start, 3) * 2 + width > canvasWidth ||
    bytes.readUIntLE(start + 3, 3) * 2 + height > canvasHeight
  )
    return false;
  let off = start + 16; // frame x/y, width-1/height-1, duration, flags
  let sawImage = false;
  while (off + 8 <= end) {
    budget.visit();
    const size = readU32Le(bytes, off + 4);
    if (size === null) return false;
    const fourcc = bytes.subarray(off, off + 4);
    const total = 8 + size + (size % 2);
    if (off + total > end) return false;
    if (bytesEqual(fourcc, "VP8 ") || bytesEqual(fourcc, "VP8L")) {
      if (sawImage) return false;
      const valid = bytesEqual(fourcc, "VP8 ")
        ? webpVp8ChunkOk(bytes, off + 8, off + 8 + size)
        : webpVp8lChunkOk(bytes, off + 8, off + 8 + size);
      if (!valid || !webpDimensionsMatch(bytes, off + 8, fourcc, width, height)) return false;
      sawImage = true;
    }
    off += total;
  }
  return sawImage && off === end;
}

function webpDimensionsMatchSafe(
  bytes: Buffer,
  start: number,
  end: number,
  type: Buffer,
  width: number,
  height: number,
): boolean {
  return (
    end - start > (bytesEqual(type, "VP8 ") ? 10 : 5) &&
    webpDimensionsMatch(bytes, start, type, width, height)
  );
}

function webpDimensionsMatch(
  bytes: Buffer,
  start: number,
  type: Buffer,
  width: number,
  height: number,
): boolean {
  if (bytesEqual(type, "VP8 "))
    return (
      (bytes.readUInt16LE(start + 6) & 0x3fff) === width &&
      (bytes.readUInt16LE(start + 8) & 0x3fff) === height
    );
  const bits = bytes.readUInt32LE(start + 1);
  return (bits & 0x3fff) + 1 === width && ((bits >>> 14) & 0x3fff) + 1 === height;
}

/**
 * Structural WebP walk. Requires a RIFF container with an exact size and
 * actual image data: either a valid coded-image chunk (VP8/VP8L), or the
 * extended format (VP8X) plus a coded image or a valid animation frame
 * (ANMF). A bare VP8X header is not an image.
 */
function validateWebp(budget: MediaWorkBudget, bytes: Buffer): boolean {
  if (bytes.length < 12) return false;
  if (!hasPrefix(bytes, 0, "RIFF")) return false;
  if (!hasPrefix(bytes, 8, "WEBP")) return false;
  const riffSize = readU32Le(bytes, 4);
  if (riffSize === null || riffSize + 8 !== bytes.length) return false;
  budget.scan(bytes.length * 2);
  let off = 12;
  let seenCodedImage = false;
  let seenExtended = false;
  let seenAnimationFrame = false;
  let animation = false;
  let animationHeader = false;
  let width = 0,
    height = 0;
  while (off + 8 <= bytes.length) {
    budget.visit();
    const chunkSize = readU32Le(bytes, off + 4);
    if (chunkSize === null) return false;
    const fourcc = bytes.subarray(off, off + 4);
    const total = 8 + chunkSize + (chunkSize % 2);
    if (off + total > bytes.length) return false;
    const payloadStart = off + 8;
    const payloadEnd = payloadStart + chunkSize;
    if (bytesEqual(fourcc, "VP8 ") || bytesEqual(fourcc, "VP8L")) {
      if (
        seenCodedImage ||
        animation ||
        (seenExtended &&
          !webpDimensionsMatchSafe(bytes, payloadStart, payloadEnd, fourcc, width, height))
      )
        return false;
    }
    if (bytesEqual(fourcc, "VP8 ")) {
      if (!webpVp8ChunkOk(bytes, payloadStart, payloadEnd)) return false;
      seenCodedImage = true;
    }
    if (bytesEqual(fourcc, "VP8L")) {
      if (!webpVp8lChunkOk(bytes, payloadStart, payloadEnd)) return false;
      seenCodedImage = true;
    }
    if (bytesEqual(fourcc, "VP8X")) {
      if (
        off !== 12 ||
        seenExtended ||
        chunkSize !== 10 ||
        bytes[payloadStart]! & 0xc1 ||
        bytes.readUIntLE(payloadStart + 1, 3) !== 0
      )
        return false;
      seenExtended = true;
      animation = (bytes[payloadStart]! & 2) !== 0;
      width = bytes.readUIntLE(payloadStart + 4, 3) + 1;
      height = bytes.readUIntLE(payloadStart + 7, 3) + 1;
      if (width * height > 0xffffffff) return false;
    }
    if (bytesEqual(fourcc, "ANIM")) {
      if (!animation || animationHeader || seenAnimationFrame || chunkSize !== 6) return false;
      animationHeader = true;
    }
    if (bytesEqual(fourcc, "ANMF")) {
      if (
        !animationHeader ||
        !webpAnmfChunkOk(budget, bytes, payloadStart, payloadEnd, width, height)
      )
        return false;
      seenAnimationFrame = true;
    }
    off += total;
  }
  // Retain the existing encoder fixture's two zero alignment bytes, but no
  // arbitrary trailing data or incomplete chunk header is admitted.
  if (bytes.length - off > 2 || bytes.subarray(off).some((byte) => byte !== 0)) return false;
  if (seenCodedImage) return true;
  return animation && animationHeader && seenAnimationFrame;
}

type Mp4Box = { type: Buffer; start: number; payloadStart: number; payloadEnd: number };

/**
 * Reads one level of ISO-BMFF boxes. Sizes honor 64-bit largesize and the
 * size-0 "to end of container" form; the chain must consume its container
 * exactly or the level is malformed.
 */
function mp4ChildBoxes(
  budget: MediaWorkBudget,
  bytes: Buffer,
  start: number,
  end: number,
): Mp4Box[] | null {
  budget.depth(8); // deepest supported path: moov/trak/mdia/minf/dinf/dref/url
  budget.scan((end - start) * 2);
  const boxes: Mp4Box[] = [];
  let off = start;
  while (off + 8 <= end) {
    budget.visit();
    let size = readU32Be(bytes, off);
    if (size === null) return null;
    let header = 8;
    if (size === 1) {
      if (off + 16 > end) return null;
      const wide = bytes.readBigUInt64BE(off + 8);
      if (wide > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      size = Number(wide);
      header = 16;
    } else if (size === 0) {
      size = end - off; // extends to end of the enclosing container, last box
    }
    if (size < header) return null;
    if (off + size > end) return null;
    boxes.push({
      type: bytes.subarray(off + 4, off + 8),
      start: off,
      payloadStart: off + header,
      payloadEnd: off + size,
    });
    off += size;
  }
  return off === end ? boxes : null;
}

/** Singleton records cannot hide a conflicting second interpretation. */
function mp4One(budget: MediaWorkBudget, boxes: Mp4Box[], ...types: string[]): Mp4Box | undefined {
  const matches = mp4BoxesOf(budget, boxes, ...types);
  return matches.length === 1 ? matches[0] : undefined;
}

function mp4BoxesOf(budget: MediaWorkBudget, boxes: Mp4Box[], ...types: string[]): Mp4Box[] {
  budget.scan(boxes.length * 4 * types.length);
  return boxes.filter((box) => types.some((type) => bytesEqual(box.type, type)));
}

type Mp4Media = { extents: Mp4Box[]; samplesLeft: number };
type Mp4Track = { id: number; descriptions: number; samples: number };
type Mp4Defaults = { description: number; size: number };

/** Extents are sorted, disjoint top-level mdat payloads, excluding box headers. */
function mp4Contains(
  budget: MediaWorkBudget,
  media: Mp4Media,
  start: number,
  length: number,
): boolean {
  if (!Number.isSafeInteger(start) || start < 0 || length <= 0) return false;
  let low = 0;
  let high = media.extents.length;
  while (low < high) {
    budget.scan(8); // charge every reference lookup, including repeated extents
    const mid = Math.floor((low + high) / 2);
    if (media.extents[mid]!.payloadStart <= start) low = mid + 1;
    else high = mid;
  }
  const extent = media.extents[low - 1];
  return extent !== undefined && length <= extent.payloadEnd - start;
}

/** Counted FullBox table, checked before any record access or count-driven loop. */
function mp4TableCount(
  bytes: Buffer,
  box: Mp4Box | undefined,
  width: number,
  version1 = false,
): number | null {
  if (!box || box.payloadEnd - box.payloadStart < 8) return null;
  const p = box.payloadStart;
  const version = bytes.readUInt32BE(p);
  if (version !== 0 && !(version1 && version === 0x01000000)) return null;
  const count = bytes.readUInt32BE(p + 4);
  return box.payloadEnd - p === 8 + count * width ? count : null;
}

function mp4Descriptions(
  budget: MediaWorkBudget,
  bytes: Buffer,
  stsd: Mp4Box,
  handler: Buffer,
  refs: number,
): number {
  // FullBox version/flags + count, then bounded SampleEntry records, each
  // with six reserved bytes and a nonzero data-reference index after its box header.
  const start = stsd.payloadStart;
  if (stsd.payloadEnd - start < 8 || bytes.readUInt32BE(start) !== 0) return 0;
  const count = bytes.readUInt32BE(start + 4);
  if (count === 0 || count > (stsd.payloadEnd - start - 8) / 16) return 0;
  const entries = mp4ChildBoxes(budget, bytes, start + 8, stsd.payloadEnd);
  if (!entries || entries.length !== count) return 0;
  const valid = entries.every((entry) => {
    const p = entry.payloadStart;
    const size = entry.payloadEnd - p;
    if (size < 8 || bytes.readUInt16BE(p + 6) === 0 || bytes.readUInt16BE(p + 6) > refs)
      return false;
    if (bytesEqual(handler, "vide")) {
      return size >= 78 && bytes.readUInt16BE(p + 24) > 0 && bytes.readUInt16BE(p + 26) > 0;
    }
    if (bytesEqual(handler, "soun")) {
      return size >= 28 && bytes.readUInt16BE(p + 16) > 0 && bytes.readUInt32BE(p + 24) > 0;
    }
    return true;
  });
  return valid ? count : 0;
}

/** Sample sizes may be fixed, 32-bit, or packed 4/8/16-bit values. No expanded array. */
function mp4SampleSizes(bytes: Buffer, box: Mp4Box) {
  const p = box.payloadStart;
  if (box.payloadEnd - p < 12 || bytes.readUInt32BE(p) !== 0) return null;
  const count = bytes.readUInt32BE(p + 8);
  if (bytesEqual(box.type, "stsz")) {
    const fixed = bytes.readUInt32BE(p + 4);
    if (box.payloadEnd - p !== 12 + (fixed === 0 ? count * 4 : 0)) return null;
    return { count, at: (i: number) => fixed || bytes.readUInt32BE(p + 12 + i * 4) };
  }
  const bits = bytes[p + 7]!;
  if (bytes.readUIntBE(p + 4, 3) !== 0 || ![4, 8, 16].includes(bits)) return null;
  if (box.payloadEnd - p !== 12 + Math.ceil((count * bits) / 8)) return null;
  return {
    count,
    at: (i: number) => {
      if (bits === 16) return bytes.readUInt16BE(p + 12 + i * 2);
      const value = bytes[p + 12 + Math.floor((i * bits) / 8)]!;
      return bits === 8 ? value : (value >> (i % 2 === 0 ? 4 : 0)) & 15;
    },
  };
}

function mp4Stbl(
  budget: MediaWorkBudget,
  bytes: Buffer,
  stbl: Mp4Box,
  handler: Buffer,
  refs: number,
  media: Mp4Media,
): Omit<Mp4Track, "id"> | null {
  const children = mp4ChildBoxes(budget, bytes, stbl.payloadStart, stbl.payloadEnd);
  if (!children) return null;
  const stsd = mp4One(budget, children, "stsd");
  const sizeBox = mp4One(budget, children, "stsz", "stz2");
  const offsets = mp4One(budget, children, "stco", "co64");
  const stsc = mp4One(budget, children, "stsc");
  const stts = mp4One(budget, children, "stts");
  if (!stsd || !sizeBox || !offsets || !stsc || !stts) return null;
  const descriptions = mp4Descriptions(budget, bytes, stsd, handler, refs);
  const sizes = mp4SampleSizes(bytes, sizeBox);
  const offsetWidth = bytesEqual(offsets.type, "co64") ? 8 : 4;
  const chunks = mp4TableCount(bytes, offsets, offsetWidth);
  const mappings = mp4TableCount(bytes, stsc, 12);
  const timings = mp4TableCount(bytes, stts, 8);
  if (!descriptions || !sizes || chunks === null || mappings === null || timings === null)
    return null;
  if (sizes.count > media.samplesLeft) return null;
  media.samplesLeft -= sizes.count;
  budget.visit(sizes.count);
  budget.scan(sizes.count * 4); // fixed/packed sizes can expand beyond table bytes
  let timed = 0;
  budget.visit(timings);
  for (let i = 0; i < timings; i++) {
    const n = bytes.readUInt32BE(stts.payloadStart + 8 + i * 8);
    if (n === 0) return null;
    timed += n;
    if (timed > sizes.count) return null;
  }
  if (timed !== sizes.count) return null;
  // Optional sample-indexed tables must agree with the same sample inventory.
  for (const type of ["ctts", "stss"]) {
    const records = mp4BoxesOf(budget, children, type);
    if (records.length > 1) return null;
    const box = records[0];
    if (!box) continue;
    const count = mp4TableCount(bytes, box, type === "ctts" ? 8 : 4, type === "ctts");
    if (count === null) return null;
    budget.visit(count);
    let covered = 0;
    for (let i = 0; i < count; i++) {
      const value = bytes.readUInt32BE(box.payloadStart + 8 + i * (type === "ctts" ? 8 : 4));
      if (value === 0 || (type === "stss" && value <= covered)) return null;
      covered = type === "ctts" ? covered + value : value;
      if (covered > sizes.count) return null;
    }
    if (type === "ctts" && covered !== sizes.count) return null;
  }
  budget.visit(mappings + chunks);
  let sample = 0;
  let previousFirst = 0;
  for (let i = 0; i < mappings; i++) {
    const p = stsc.payloadStart + 8 + i * 12;
    const first = bytes.readUInt32BE(p);
    const perChunk = bytes.readUInt32BE(p + 4);
    const description = bytes.readUInt32BE(p + 8);
    const next = i + 1 < mappings ? bytes.readUInt32BE(p + 12) : chunks + 1;
    if (
      (i === 0 && first !== 1) ||
      first <= previousFirst ||
      first > chunks ||
      next <= first ||
      next > chunks + 1 ||
      perChunk === 0 ||
      description === 0 ||
      description > descriptions ||
      (next - first) * perChunk > sizes.count - sample
    )
      return null;
    previousFirst = first;
    for (let chunk = first; chunk < next; chunk++) {
      const pos = offsets.payloadStart + 8 + (chunk - 1) * offsetWidth;
      const offset =
        offsetWidth === 8 ? Number(bytes.readBigUInt64BE(pos)) : bytes.readUInt32BE(pos);
      let length = 0;
      for (let j = 0; j < perChunk; j++) {
        const size = sizes.at(sample++);
        if (size === 0) return null;
        length += size;
        if (length > bytes.length) return null;
      }
      if (!mp4Contains(budget, media, offset, length)) return null;
    }
  }
  if (
    sample !== sizes.count ||
    (chunks === 0) !== (mappings === 0) ||
    (sizes.count === 0) !== (chunks === 0)
  )
    return null;
  return { descriptions, samples: sample };
}

/** Complete versioned movie/media/track headers, including their trailing fields. */
function mp4HeaderOk(bytes: Buffer, box: Mp4Box | undefined, version0Size: number): boolean {
  if (!box || box.payloadEnd - box.payloadStart < 4) return false;
  const start = box.payloadStart;
  const version = bytes[start]!;
  if (version > 1 || box.payloadEnd - start !== version0Size + (version === 1 ? 12 : 0)) {
    return false;
  }
  // Movie/media timescale and track ID share this offset in their respective headers.
  return bytes.readUInt32BE(start + (version === 1 ? 20 : 12)) > 0;
}

/** Every sample description must refer to this file, never an external URL/URN. */
function mp4DataReferences(budget: MediaWorkBudget, bytes: Buffer, minf: Mp4Box[]): number {
  const dinf = mp4One(budget, minf, "dinf");
  if (!dinf) return 0;
  const children = mp4ChildBoxes(budget, bytes, dinf.payloadStart, dinf.payloadEnd);
  const dref = children && mp4One(budget, children, "dref");
  if (!dref || dref.payloadEnd - dref.payloadStart < 8) return 0;
  const p = dref.payloadStart;
  if (bytes.readUInt32BE(p) !== 0) return 0;
  const refs = mp4ChildBoxes(budget, bytes, p + 8, dref.payloadEnd);
  if (!refs || refs.length !== bytes.readUInt32BE(p + 4)) return 0;
  return refs.every(
    (ref) =>
      bytesEqual(ref.type, "url ") &&
      ref.payloadEnd - ref.payloadStart === 4 &&
      bytes.readUInt32BE(ref.payloadStart) === 1,
  )
    ? refs.length
    : 0;
}

function mp4Trak(
  budget: MediaWorkBudget,
  bytes: Buffer,
  trak: Mp4Box,
  media: Mp4Media,
): Mp4Track | null {
  const children = mp4ChildBoxes(budget, bytes, trak.payloadStart, trak.payloadEnd);
  if (!children) return null;
  const tkhd = mp4One(budget, children, "tkhd");
  if (!tkhd || !mp4HeaderOk(bytes, tkhd, 84)) return null;
  const id = bytes.readUInt32BE(tkhd.payloadStart + (bytes[tkhd.payloadStart] === 1 ? 20 : 12));
  const mdia = mp4One(budget, children, "mdia");
  if (!mdia) return null;
  const mdiaChildren = mp4ChildBoxes(budget, bytes, mdia.payloadStart, mdia.payloadEnd);
  if (!mdiaChildren || !mp4HeaderOk(bytes, mp4One(budget, mdiaChildren, "mdhd"), 24)) return null;
  const hdlr = mp4One(budget, mdiaChildren, "hdlr");
  if (
    !hdlr ||
    hdlr.payloadEnd - hdlr.payloadStart < 24 ||
    bytes.readUInt32BE(hdlr.payloadStart) !== 0
  )
    return null;
  const handler = bytes.subarray(hdlr.payloadStart + 8, hdlr.payloadStart + 12);
  if (handler.some((byte) => byte < 0x20 || byte > 0x7e) || handler.every((byte) => byte === 0x20))
    return null;
  const minf = mp4One(budget, mdiaChildren, "minf");
  if (!minf) return null;
  const minfChildren = mp4ChildBoxes(budget, bytes, minf.payloadStart, minf.payloadEnd);
  if (!minfChildren) return null;
  const refs = mp4DataReferences(budget, bytes, minfChildren);
  const stbl = mp4One(budget, minfChildren, "stbl");
  if (!refs || !stbl) return null;
  const table = mp4Stbl(budget, bytes, stbl, handler, refs, media);
  return table && { id, ...table };
}

/** Resolve all fragment size/description defaults once, indexed by declared track. */
function mp4Trex(
  budget: MediaWorkBudget,
  bytes: Buffer,
  mvex: Mp4Box,
  tracks: Map<number, Mp4Track>,
) {
  const children = mp4ChildBoxes(budget, bytes, mvex.payloadStart, mvex.payloadEnd);
  if (!children) return null;
  const defaults = new Map<number, Mp4Defaults>();
  for (const box of mp4BoxesOf(budget, children, "trex")) {
    const p = box.payloadStart;
    if (box.payloadEnd - p !== 24 || bytes.readUInt32BE(p) !== 0) return null;
    const id = bytes.readUInt32BE(p + 4);
    const track = tracks.get(id);
    const description = bytes.readUInt32BE(p + 8);
    if (!track || defaults.has(id) || description === 0 || description > track.descriptions)
      return null;
    defaults.set(id, { description, size: bytes.readUInt32BE(p + 16) });
  }
  return defaults.size > 0 ? defaults : null;
}

/**
 * Resolve each trun using tfhd/trex defaults. First run starts at base + signed
 * data_offset (or base); omitted offsets on later runs continue the previous run.
 * ISO/IEC 14496-12 §8.8.7–8.8.8 (not FFmpeg's always-base-relative shortcut).
 * Count and record length are checked before traversal, including zero-stride runs.
 */
function mp4Traf(
  budget: MediaWorkBudget,
  bytes: Buffer,
  traf: Mp4Box,
  moof: Mp4Box,
  implicitBase: number,
  tracks: Map<number, Mp4Track>,
  defaults: Map<number, Mp4Defaults>,
  media: Mp4Media,
): number | null {
  const children = mp4ChildBoxes(budget, bytes, traf.payloadStart, traf.payloadEnd);
  if (!children) return null;
  const tfhd = mp4One(budget, children, "tfhd");
  if (!tfhd || children[0] !== tfhd || tfhd.payloadEnd - tfhd.payloadStart < 8) return null;
  const p = tfhd.payloadStart;
  const flags = bytes.readUInt32BE(p);
  if ((flags & ~0x03003b) !== 0) return null;
  const id = bytes.readUInt32BE(p + 4);
  const track = tracks.get(id),
    fallback = defaults.get(id);
  if (!track || !fallback) return null;
  const expected = 8 + (flags & 1 ? 8 : 0) + [2, 8, 16, 32].filter((f) => flags & f).length * 4;
  if (tfhd.payloadEnd - p !== expected) return null;
  let at = p + 8;
  let base = flags & 0x020000 ? moof.start : implicitBase;
  if (flags & 1) {
    base = Number(bytes.readBigUInt64BE(at));
    at += 8;
  }
  if (!Number.isSafeInteger(base) || base < 0 || base > bytes.length) return null;
  let description = fallback.description;
  if (flags & 2) {
    description = bytes.readUInt32BE(at);
    at += 4;
  }
  if (description === 0 || description > track.descriptions) return null;
  if (flags & 8) at += 4; // default duration does not affect byte extents
  let size = fallback.size;
  if (flags & 16) {
    size = bytes.readUInt32BE(at);
    at += 4;
  }
  const decodeTimes = mp4BoxesOf(budget, children, "tfdt");
  if (decodeTimes.length > 1) return null;
  for (const box of decodeTimes) {
    const len = box.payloadEnd - box.payloadStart;
    if (len < 4) return null;
    const version = bytes.readUInt32BE(box.payloadStart);
    if (!((version === 0 && len === 8) || (version === 0x01000000 && len === 12))) return null;
  }
  const runs = mp4BoxesOf(budget, children, "trun");
  if (flags & 0x010000 ? runs.length !== 0 : runs.length === 0) return null;
  let end = base;
  for (const run of runs) {
    const r = run.payloadStart;
    if (run.payloadEnd - r < 8) return null;
    const version = bytes[r]!;
    const fields = bytes.readUIntBE(r + 1, 3);
    if (version > 1 || (fields & ~0x000f05) !== 0 || (fields & 4 && fields & 0x400)) return null;
    const count = bytes.readUInt32BE(r + 4);
    if (count > media.samplesLeft || (flags & 0x010000 && count !== 0)) return null;
    const stride = [0x100, 0x200, 0x400, 0x800].filter((f) => fields & f).length * 4;
    const header = 8 + (fields & 1 ? 4 : 0) + (fields & 4 ? 4 : 0);
    if (run.payloadEnd - r !== header + stride * count) return null;
    budget.visit(count);
    budget.scan(count * 4); // zero-stride/default-size runs still consume work
    if (fields & 1) end = base + bytes.readInt32BE(r + 8);
    let length = 0;
    for (let i = 0; i < count; i++) {
      const sampleSize =
        fields & 0x200
          ? bytes.readUInt32BE(r + header + i * stride + (fields & 0x100 ? 4 : 0))
          : size;
      if (sampleSize === 0) return null;
      length += sampleSize;
      if (length > bytes.length) return null;
    }
    if (count > 0 && !mp4Contains(budget, media, end, length)) return null;
    end += length;
    track.samples += count;
    media.samplesLeft -= count;
  }
  return end;
}

/** All conventional and fragmented sample references must land in local mdat bytes. */
function validateMp4(budget: MediaWorkBudget, bytes: Buffer): boolean {
  if (!hasPrefix(bytes, 4, "ftyp")) return false;
  const top = mp4ChildBoxes(budget, bytes, 0, bytes.length);
  if (!top || top.length === 0) return false;
  const ftyp = top[0]!;
  if (
    !bytesEqual(ftyp.type, "ftyp") ||
    !mp4One(budget, top, "ftyp") ||
    ftyp.payloadEnd - ftyp.payloadStart < 8 ||
    (ftyp.payloadEnd - ftyp.payloadStart) % 4 !== 0
  )
    return false;
  const moov = mp4One(budget, top, "moov");
  if (!moov) return false;
  const media: Mp4Media = {
    extents: mp4BoxesOf(budget, top, "mdat").filter((box) => box.payloadEnd > box.payloadStart),
    // Shared across every track/run: compressed sample counts must not amplify work.
    samplesLeft: bytes.length,
  };
  if (media.extents.length === 0) return false;
  const children = mp4ChildBoxes(budget, bytes, moov.payloadStart, moov.payloadEnd);
  if (!children || !mp4HeaderOk(bytes, mp4One(budget, children, "mvhd"), 100)) return false;
  const tracks = new Map<number, Mp4Track>();
  for (const trak of mp4BoxesOf(budget, children, "trak")) {
    const track = mp4Trak(budget, bytes, trak, media);
    if (!track || tracks.has(track.id)) return false;
    tracks.set(track.id, track);
  }
  if (tracks.size === 0) return false;
  const extensions = mp4BoxesOf(budget, children, "mvex");
  if (extensions.length > 1) return false;
  const defaults = extensions[0]
    ? mp4Trex(budget, bytes, extensions[0], tracks)
    : new Map<number, Mp4Defaults>();
  if (!defaults) return false;
  let sequence = -1;
  for (const moof of mp4BoxesOf(budget, top, "moof")) {
    if (moof.start < moov.payloadEnd) return false;
    const fragments = mp4ChildBoxes(budget, bytes, moof.payloadStart, moof.payloadEnd);
    if (!fragments) return false;
    const mfhd = mp4One(budget, fragments, "mfhd");
    if (
      !mfhd ||
      fragments[0] !== mfhd ||
      mfhd.payloadEnd - mfhd.payloadStart !== 8 ||
      bytes.readUInt32BE(mfhd.payloadStart) !== 0
    )
      return false;
    const nextSequence = bytes.readUInt32BE(mfhd.payloadStart + 4);
    if (nextSequence <= sequence) return false;
    sequence = nextSequence;
    const trafs = mp4BoxesOf(budget, fragments, "traf");
    if (trafs.length === 0) return false;
    let end = moof.start;
    for (const traf of trafs) {
      const result = mp4Traf(budget, bytes, traf, moof, end, tracks, defaults, media);
      if (result === null) return false;
      end = result;
    }
  }
  return [...tracks.values()].every((track) => track.samples > 0);
}

// EBML vints decode through BigInt: eight-byte sizes overflow JavaScript's
// 32-bit bitwise arithmetic, and a truncated size can stall the walker.
function readEbmlVint(bytes: Buffer, offset: number): { value: bigint; length: number } | null {
  if (offset >= bytes.length) return null;
  const first = bytes[offset]!;
  if (first === 0) return null;
  let mask = 0x80;
  let length = 1;
  while (length <= 8 && (first & mask) === 0) {
    mask >>= 1;
    length += 1;
  }
  if (length > 8 || offset + length > bytes.length) return null;
  let value = BigInt(first & (mask - 1));
  for (let i = 1; i < length; i += 1) {
    value = (value << 8n) | BigInt(bytes[offset + i]!);
  }
  return { value, length };
}

function readEbmlId(bytes: Buffer, offset: number): { id: number; length: number } | null {
  if (offset >= bytes.length) return null;
  const first = bytes[offset]!;
  if (first === 0 || first === 0xff) return null;
  let mask = 0x80;
  let length = 1;
  while (length <= 4 && (first & mask) === 0) {
    mask >>= 1;
    length += 1;
  }
  if (length > 4 || offset + length > bytes.length) return null;
  let id = first;
  for (let i = 1; i < length; i += 1) {
    id = (id << 8) | bytes[offset + i]!;
  }
  return { id, length };
}

function readEbmlSize(
  bytes: Buffer,
  offset: number,
): { size: number | null; length: number } | null {
  const vint = readEbmlVint(bytes, offset);
  if (vint === null) return null;
  // The all-ones vint is the unknown-size sentinel; any other value is a
  // finite size that must stay exactly representable and fit the whole input.
  const unknownMarker = (1n << BigInt(7 * vint.length)) - 1n;
  if (vint.value === unknownMarker) return { size: null, length: vint.length };
  if (vint.value > BigInt(Number.MAX_SAFE_INTEGER) || vint.value > BigInt(bytes.length)) {
    return null;
  }
  return { size: Number(vint.value), length: vint.length };
}

const EBML_DOCTYPE_ID = 0x4282;
const WEBM_SEGMENT_ID = 0x18538067;
const WEBM_TRACKS_ID = 0x1654ae6b;
const WEBM_CLUSTER_ID = 0x1f43b675;
const WEBM_BLOCK_GROUP_ID = 0xa0;
const WEBM_BLOCK_ID = 0xa1;
const WEBM_SIMPLE_BLOCK_ID = 0xa3;

function walkEbmlChildren(
  budget: MediaWorkBudget,
  bytes: Buffer,
  start: number,
  end: number,
  visit: (id: number, dataStart: number, dataEnd: number) => boolean | undefined,
): boolean {
  budget.depth(6); // Segment/Tracks/TrackEntry/Video or Cluster/BlockGroup/Block
  budget.scan((end - start) * 2);
  let off = start;
  while (off < end) {
    budget.visit();
    const id = readEbmlId(bytes, off);
    if (id === null) return false;
    const size = readEbmlSize(bytes, off + id.length);
    if (size === null) return false;
    const dataStart = off + id.length + size.length;
    if (dataStart > end) return false;
    const dataEnd = size.size === null ? end : dataStart + size.size;
    if (dataEnd < dataStart || dataEnd > end) return false;
    if (size.size === null && id.id !== WEBM_SEGMENT_ID && id.id !== WEBM_CLUSTER_ID) return false;
    if (visit(id.id, dataStart, dataEnd) === false) return false;
    const next = size.size === null ? end : dataEnd;
    if (next <= off) return false; // cursor must strictly advance every iteration
    off = next;
  }
  return true;
}

function ebmlUint(bytes: Buffer, start: number, end: number): number | null {
  if (end <= start || end - start > 8) return null;
  let value = 0n;
  for (let i = start; i < end; i += 1) value = (value << 8n) | BigInt(bytes[i]!);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}

type WebmTrack = { lacing: boolean };

function readWebmTracks(
  budget: MediaWorkBudget,
  bytes: Buffer,
  start: number,
  end: number,
  tracks: Map<number, WebmTrack>,
): boolean {
  return walkEbmlChildren(budget, bytes, start, end, (id, from, to) => {
    if (id !== 0xae) return; // TrackEntry
    let number: number | null = null;
    let uid = false;
    let type: number | null = null;
    let codec: Buffer = Buffer.alloc(0);
    let lacing = true;
    let width = 0;
    let height = 0;
    let audio = false;
    const fields = new Set<number>();
    if (
      !walkEbmlChildren(budget, bytes, from, to, (field, a, b) => {
        if ([0xd7, 0x73c5, 0x83, 0x86, 0x9c, 0xe0, 0xe1].includes(field)) {
          if (fields.has(field)) return false;
          fields.add(field);
        }
        if (field === 0xd7) number = ebmlUint(bytes, a, b);
        // UID is an opaque unsigned 64-bit value, not a JS numeric identifier.
        if (field === 0x73c5)
          uid = b > a && b - a <= 8 && bytes.subarray(a, b).some((v) => v !== 0);
        if (field === 0x83) type = ebmlUint(bytes, a, b);
        if (field === 0x86) codec = bytes.subarray(a, b);
        if (field === 0x9c) {
          const flag = ebmlUint(bytes, a, b);
          if (flag !== 0 && flag !== 1) return false;
          lacing = flag === 1;
        }
        if (field === 0xe1) {
          audio = true;
          const audioFields = new Set<number>();
          return walkEbmlChildren(budget, bytes, a, b, (v, x, y) => {
            if (![0xb5, 0x78b5, 0x9f, 0x6264].includes(v)) return;
            if (audioFields.has(v)) return false;
            audioFields.add(v);
            if (v === 0xb5 || v === 0x78b5) {
              if (y - x !== 4 && y - x !== 8) return false;
              const rate = y - x === 4 ? bytes.readFloatBE(x) : bytes.readDoubleBE(x);
              return Number.isFinite(rate) && rate > 0;
            }
            const value = ebmlUint(bytes, x, y);
            return value !== null && value > 0 && (v !== 0x9f || value <= 255);
          });
        }
        if (field === 0xe0) {
          const dimensions = new Set<number>();
          return walkEbmlChildren(budget, bytes, a, b, (v, x, y) => {
            if (v !== 0xb0 && v !== 0xba) return;
            const value = ebmlUint(bytes, x, y);
            if (dimensions.has(v) || value === null || value === 0) return false;
            dimensions.add(v);
            if (v === 0xb0) width = value;
            else height = value;
          });
        }
      })
    )
      return false;
    if (number === null || number <= 0 || tracks.has(number) || !uid) return false;
    if (type === 1) {
      if (
        !["V_VP8", "V_VP9", "V_AV1"].some((id) => bytesEqual(codec, id)) ||
        width <= 0 ||
        height <= 0
      )
        return false;
    } else if (type !== 2 || !audio || !["A_VORBIS", "A_OPUS"].some((id) => bytesEqual(codec, id)))
      return false;
    tracks.set(number, { lacing });
  });
}

/** Validate the complete block header and each lace's payload bounds, without decoding frames. */
function webmBlockOk(
  budget: MediaWorkBudget,
  bytes: Buffer,
  start: number,
  end: number,
  simple: boolean,
  tracks: Map<number, WebmTrack>,
): boolean {
  budget.scan(end - start);
  const track = readEbmlVint(bytes, start);
  if (!track || track.value > BigInt(Number.MAX_SAFE_INTEGER)) return false;
  const declared = tracks.get(Number(track.value));
  let offset = start + track.length + 3; // track, signed timestamp, flags
  if (!declared || offset >= end) return false;
  const flags = bytes[offset - 1]!;
  if (flags & (simple ? 0x70 : 0xf1)) return false;
  const lacing = (flags >> 1) & 3;
  if (lacing === 0) return true;
  if (!declared.lacing) return false;
  const frames = bytes[offset++]! + 1;
  budget.visit(frames);
  if (frames < 2 || offset >= end) return false;
  if (lacing === 2) return (end - offset) % frames === 0 && end - offset >= frames;
  let total = 0;
  let previous = 0;
  for (let frame = 0; frame < frames - 1; frame += 1) {
    let size = 0;
    if (lacing === 1) {
      let part: number;
      do {
        if (offset >= end) return false;
        part = bytes[offset++]!;
        size += part;
      } while (part === 255);
    } else {
      const vint = readEbmlVint(bytes, offset);
      if (!vint || offset + vint.length > end) return false;
      offset += vint.length;
      const value =
        frame === 0
          ? vint.value
          : BigInt(previous) + vint.value - ((1n << BigInt(7 * vint.length - 1)) - 1n);
      if (value <= 0n || value > BigInt(end - start)) return false;
      size = Number(value);
    }
    if (size <= 0) return false;
    previous = size;
    total += size;
    if (total >= end - offset) return false;
  }
  return total < end - offset; // the last frame consumes the remaining bytes
}

/** WebM needs declared tracks and complete blocks referencing those tracks. */
function validateWebm(budget: MediaWorkBudget, bytes: Buffer): boolean {
  if (readU32Be(bytes, 0) !== 0x1a45dfa3) return false;
  const headerSize = readEbmlSize(bytes, 4);
  if (!headerSize || headerSize.size === null) return false;
  const headerStart = 4 + headerSize.length;
  const headerEnd = headerStart + headerSize.size;
  if (headerEnd > bytes.length) return false;
  let docTypeOk = false;
  const headerFields = new Set<number>();
  if (
    !walkEbmlChildren(budget, bytes, headerStart, headerEnd, (id, start, end) => {
      if (headerFields.has(id)) return false;
      headerFields.add(id);
      if (id === EBML_DOCTYPE_ID) docTypeOk = bytesEqual(bytes.subarray(start, end), "webm");
      else if ([0x4286, 0x42f7, 0x42f2, 0x42f3, 0x4287, 0x4285].includes(id)) {
        const value = ebmlUint(bytes, start, end);
        if (value === null || value === 0) return false;
        if (id === 0x42f7 && value !== 1) return false;
        if (id === 0x42f2 && value !== 4) return false;
        if (id === 0x42f3 && value > 8) return false;
        if (id === 0x4285 && value > 4) return false;
      }
    }) ||
    !docTypeOk
  )
    return false;
  let sawSegment = false;
  let sawBlock = false;
  const valid = walkEbmlChildren(budget, bytes, headerEnd, bytes.length, (id, start, end) => {
    if (id !== WEBM_SEGMENT_ID) return;
    if (sawSegment) return false;
    sawSegment = true;
    const tracks = new Map<number, WebmTrack>();
    if (
      !walkEbmlChildren(budget, bytes, start, end, (child, a, b) => {
        if (child === WEBM_TRACKS_ID) return readWebmTracks(budget, bytes, a, b, tracks);
      }) ||
      tracks.size === 0
    )
      return false;
    return walkEbmlChildren(budget, bytes, start, end, (child, a, b) => {
      if (child !== WEBM_CLUSTER_ID) return;
      return walkEbmlChildren(budget, bytes, a, b, (block, x, y) => {
        if (block === WEBM_SIMPLE_BLOCK_ID) {
          if (!webmBlockOk(budget, bytes, x, y, true, tracks)) return false;
          sawBlock = true;
        }
        if (block === WEBM_BLOCK_GROUP_ID) {
          let groupBlock = false;
          const ok = walkEbmlChildren(budget, bytes, x, y, (inner, p, q) => {
            if (inner !== WEBM_BLOCK_ID) return;
            if (groupBlock || !webmBlockOk(budget, bytes, p, q, false, tracks)) return false;
            groupBlock = true;
            sawBlock = true;
          });
          return ok && groupBlock;
        }
      });
    });
  });
  return valid && sawSegment && sawBlock;
}

const MP3_BITRATES_V1_L1 = [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448];
const MP3_BITRATES_V1_L2 = [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384];
const MP3_BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MP3_BITRATES_V2_L1 = [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256];
const MP3_BITRATES_V2_L23 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const MP3_SAMPLE_RATES_V1 = [44100, 48000, 32000];
const MP3_SAMPLE_RATES_V2 = [22050, 24000, 16000];
const MP3_SAMPLE_RATES_V25 = [11025, 12000, 8000];

/** Frame length computed from this frame's own header, or null when invalid. */
function mpegFrameLength(bytes: Buffer, off: number): number | null {
  if (off + 4 > bytes.length) return null;
  if (bytes[off] !== 0xff || (bytes[off + 1]! & 0xe0) !== 0xe0) return null;
  const versionBits = (bytes[off + 1]! >> 3) & 0x03;
  const layerBits = (bytes[off + 1]! >> 1) & 0x03;
  if (versionBits === 1 || layerBits === 0) return null;
  const bitrateIndex = (bytes[off + 2]! >> 4) & 0x0f;
  const sampleRateIndex = (bytes[off + 2]! >> 2) & 0x03;
  const emphasis = bytes[off + 3]! & 0x03;
  if (bitrateIndex === 0 || bitrateIndex === 0x0f || sampleRateIndex === 3 || emphasis === 2) {
    return null;
  }
  const bitrateTable =
    versionBits === 3
      ? layerBits === 3
        ? MP3_BITRATES_V1_L1
        : layerBits === 2
          ? MP3_BITRATES_V1_L2
          : MP3_BITRATES_V1_L3
      : layerBits === 3
        ? MP3_BITRATES_V2_L1
        : MP3_BITRATES_V2_L23;
  const sampleRate = (
    versionBits === 3
      ? MP3_SAMPLE_RATES_V1
      : versionBits === 2
        ? MP3_SAMPLE_RATES_V2
        : MP3_SAMPLE_RATES_V25
  )[sampleRateIndex]!;
  const bitrate = bitrateTable[bitrateIndex]!;
  const padding = (bytes[off + 2]! >> 1) & 0x01 ? 1 : 0;
  const samplesPerFrame =
    layerBits === 3 ? 384 : layerBits === 2 ? 1152 : versionBits === 3 ? 1152 : 576;
  const frameLen =
    layerBits === 3
      ? (Math.floor((12 * bitrate * 1000) / sampleRate) + padding) * 4
      : Math.floor(((samplesPerFrame / 8) * bitrate * 1000) / sampleRate) + padding;
  return frameLen >= 4 ? frameLen : null;
}

/**
 * Structural MPEG audio walk. Skips a leading ID3v2 tag (v2.3/2.4, optional
 * footer), then requires every remaining byte to be covered by valid MPEG
 * frames whose lengths are computed per frame (VBR and alternating padding
 * included), allowing a trailing ID3v1 "TAG" (and "TAG+") block.
 */
function validateMp3(budget: MediaWorkBudget, bytes: Buffer): boolean {
  if (bytes.length < 4) return false;
  if (!hasPrefix(bytes, 0, "ID3") && mpegFrameLength(bytes, 0) === null) return false;
  budget.scan(bytes.length);
  let start = 0;
  if (hasPrefix(bytes, 0, "ID3")) {
    if (bytes.length < 10) return false;
    const major = bytes[3]!;
    if (major !== 3 && major !== 4) return false;
    const flags = bytes[5]!;
    if (
      bytes[4] === 0xff ||
      flags & (major === 3 ? 0x1f : 0x0f) ||
      bytes.subarray(6, 10).some((byte) => byte > 127)
    )
      return false;
    const b6 = bytes[6]!;
    const b7 = bytes[7]!;
    const b8 = bytes[8]!;
    const b9 = bytes[9]!;
    const tagSize = ((b6 & 0x7f) << 21) | ((b7 & 0x7f) << 14) | ((b8 & 0x7f) << 7) | (b9 & 0x7f);
    start = 10 + tagSize + ((flags & 0x10) !== 0 ? 10 : 0);
    if (start >= bytes.length) return false; // tag-only file has no audio
    if (
      flags & 0x10 &&
      (!hasPrefix(bytes, start - 10, "3DI") ||
        !bytes.subarray(start - 7, start).equals(bytes.subarray(3, 10)))
    )
      return false;
  }
  let end = bytes.length;
  if (end - start >= 128 && hasPrefix(bytes, end - 128, "TAG")) {
    end -= 128;
    if (end - start >= 227 && hasPrefix(bytes, end - 227, "TAG+")) end -= 227;
  }
  let off = start;
  let frames = 0;
  const streamVersionLayer = bytes[start + 1]! & 0x1e;
  const streamRate = bytes[start + 2]! & 0x0c;
  while (off < end) {
    budget.visit();
    const frameLen = mpegFrameLength(bytes, off);
    if (
      frameLen === null ||
      (bytes[off + 1]! & 0x1e) !== streamVersionLayer ||
      (bytes[off + 2]! & 0x0c) !== streamRate
    )
      return false;
    if (off + frameLen > end) return false;
    off += frameLen;
    frames += 1;
  }
  return frames >= 2;
}

/** Validate WAVEFORMAT fields and return the PCM/float sample-frame alignment. */
function wavFormatAlignment(bytes: Buffer, start: number, size: number): number | null {
  if (size < 16 || size === 17) return null;
  let format = bytes.readUInt16LE(start);
  const channels = bytes.readUInt16LE(start + 2);
  const sampleRate = bytes.readUInt32LE(start + 4);
  const byteRate = bytes.readUInt32LE(start + 8);
  const blockAlign = bytes.readUInt16LE(start + 12);
  const bits = bytes.readUInt16LE(start + 14);
  if (!format || !channels || !sampleRate || !byteRate || !blockAlign) return null;
  if (size > 16 && bytes.readUInt16LE(start + 16) > size - 18) return null;
  if (format === 0xfffe) {
    if (size < 40 || bytes.readUInt16LE(start + 16) < 22) return null;
    // WAVEFORMATEXTENSIBLE carries a subtype GUID, not another bare format tag.
    const subtype = bytes.subarray(start + 24, start + 40);
    if (subtype.every((byte) => byte === 0)) return null;
    if (subtype.subarray(4).equals(Buffer.from("00001000800000aa00389b71", "hex"))) {
      format = subtype.readUInt32LE(0);
    }
    if (format === 1 || format === 3) {
      const validBits = bytes.readUInt16LE(start + 18);
      if (validBits === 0 || validBits > bits) return null;
    }
  }
  if (format === 1 || format === 3) {
    if (bits === 0 || bits % 8 !== 0 || (format === 3 && bits !== 32 && bits !== 64)) return null;
    if (blockAlign !== (channels * bits) / 8 || byteRate !== sampleRate * blockAlign) return null;
    return blockAlign;
  }
  // Compressed WAVEFORMATEX still requires cbSize; its codec-specific frames
  // need not have PCM's fixed bytes-per-sample relationship.
  return size >= 18 ? 1 : null;
}

function validateWav(budget: MediaWorkBudget, bytes: Buffer): boolean {
  if (bytes.length < 12) return false;
  if (!hasPrefix(bytes, 0, "RIFF")) return false;
  if (!hasPrefix(bytes, 8, "WAVE")) return false;
  const riffSize = readU32Le(bytes, 4);
  if (riffSize === null || riffSize + 8 !== bytes.length) return false;
  budget.scan(bytes.length * 2);
  let off = 12;
  let alignment: number | null = null;
  let seenData = false;
  while (off + 8 <= bytes.length) {
    budget.visit();
    const id = bytes.subarray(off, off + 4);
    const chunkSize = readU32Le(bytes, off + 4);
    if (chunkSize === null) return false;
    const total = 8 + chunkSize + (chunkSize % 2);
    if (off + total > bytes.length) return false;
    if (bytesEqual(id, "fmt ")) {
      if (alignment !== null) return false;
      alignment = wavFormatAlignment(bytes, off + 8, chunkSize);
      if (alignment === null) return false;
    }
    if (bytesEqual(id, "data")) {
      if (alignment === null || chunkSize === 0 || chunkSize % alignment !== 0) return false;
      seenData = true;
    }
    off += total;
  }
  return alignment !== null && seenData && off === bytes.length;
}

const OGG_CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let crc = index << 24;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc << 1) ^ (crc & 0x80000000 ? 0x04c11db7 : 0);
  return crc >>> 0;
});

type OggStream = {
  sequence: number;
  codec: "vorbis" | "opus" | null;
  packets: number;
  media: number;
  parts: Buffer[];
  ended: boolean;
};

function oggCommentsOk(
  budget: MediaWorkBudget,
  packet: Buffer,
  offset: number,
  vorbis: boolean,
): boolean {
  budget.scan(packet.length);
  const vendorLength = readU32Le(packet, offset);
  if (vendorLength === null) return false;
  offset += 4 + vendorLength;
  const count = readU32Le(packet, offset);
  if (count === null) return false;
  offset += 4;
  if (count > (packet.length - offset) / 4) return false;
  budget.visit(count);
  for (let i = 0; i < count; i += 1) {
    const length = readU32Le(packet, offset);
    if (length === null || offset + 4 + length > packet.length) return false;
    offset += 4 + length;
  }
  return vorbis ? offset + 1 === packet.length && packet[offset] === 1 : offset <= packet.length;
}

function opusHeadOk(packet: Buffer): boolean {
  if (!hasPrefix(packet, 0, "OpusHead") || packet.length < 19 || packet[8]! > 15) return false;
  const channels = packet[9]!;
  if (channels === 0) return false;
  if (packet[18] === 0) return channels <= 2 && (packet[8] !== 1 || packet.length === 19);
  if (packet.length < 21 + channels) return false;
  const streams = packet[19]!;
  const coupled = packet[20]!;
  return (
    streams > 0 &&
    coupled <= streams &&
    streams + coupled <= 255 &&
    packet.subarray(21, 21 + channels).every((c) => c === 255 || c < streams + coupled)
  );
}

function oggPacketOk(budget: MediaWorkBudget, stream: OggStream, packet: Buffer): boolean {
  budget.visit();
  const index = stream.packets++;
  if (index === 0) {
    if (packet.length === 30 && hasPrefix(packet, 0, "\x01vorbis")) {
      const short = packet[28]! & 15;
      const long = packet[28]! >> 4;
      if (
        packet.readUInt32LE(7) !== 0 ||
        packet[11] === 0 ||
        packet.readUInt32LE(12) === 0 ||
        short < 6 ||
        long > 13 ||
        short > long ||
        packet[29] !== 1
      )
        return false;
      stream.codec = "vorbis";
      return true;
    }
    if (!opusHeadOk(packet)) return false;
    stream.codec = "opus";
    return true;
  }
  if (index === 1) {
    const vorbis = stream.codec === "vorbis";
    return (
      hasPrefix(packet, 0, vorbis ? "\x03vorbis" : "OpusTags") &&
      oggCommentsOk(budget, packet, vorbis ? 7 : 8, vorbis)
    );
  }
  if (stream.codec === "vorbis" && index === 2) {
    // The setup packet must include codebook data after the mandatory header.
    // Codec tables/entropy data are not decoded by this container validator.
    return packet.length > 16 && hasPrefix(packet, 0, "\x05vorbis") && hasPrefix(packet, 8, "BCV");
  }
  if (packet.length === 0 || (stream.codec === "vorbis" && (packet[0]! & 1) !== 0)) return false;
  stream.media += 1;
  return true;
}

/** Complete, checksum-valid logical audio streams, including continued packets and chaining. */
function validateOgg(budget: MediaWorkBudget, bytes: Buffer): boolean {
  if (!hasPrefix(bytes, 0, "OggS")) return false;
  budget.scan(bytes.length * 3); // page CRC, segment walk and once-only packet concatenation
  const streams = new Map<number, OggStream>();
  let off = 0;
  while (off < bytes.length) {
    budget.visit();
    if (off + 27 > bytes.length || !hasPrefix(bytes, off, "OggS") || bytes[off + 4] !== 0)
      return false;
    const flags = bytes[off + 5]!;
    if (flags & ~7) return false;
    const serial = bytes.readUInt32LE(off + 14);
    const sequence = bytes.readUInt32LE(off + 18);
    const segments = bytes[off + 26]!;
    budget.visit(segments);
    let payload = off + 27 + segments;
    if (payload > bytes.length) return false;
    let end = payload;
    for (let i = 0; i < segments; i += 1) end += bytes[off + 27 + i]!;
    if (end > bytes.length) return false;
    let crc = 0;
    for (let i = off; i < end; i += 1) {
      const byte = i >= off + 22 && i < off + 26 ? 0 : bytes[i]!;
      crc = ((crc << 8) ^ OGG_CRC_TABLE[((crc >>> 24) ^ byte) & 255]!) >>> 0;
    }
    if (crc !== bytes.readUInt32LE(off + 22)) return false;
    let stream = streams.get(serial);
    if (!stream) {
      if ((flags & 3) !== 2 || sequence !== 0) return false;
      stream = { sequence: 0, codec: null, packets: 0, media: 0, parts: [], ended: false };
      streams.set(serial, stream);
    } else if (flags & 2) return false;
    if (
      stream.ended ||
      sequence !== stream.sequence ||
      Boolean(flags & 1) !== stream.parts.length > 0
    )
      return false;
    stream.sequence = (sequence + 1) >>> 0;
    for (let i = 0; i < segments; i += 1) {
      const length = bytes[off + 27 + i]!;
      stream.parts.push(bytes.subarray(payload, payload + length));
      payload += length;
      if (length < 255) {
        if (!oggPacketOk(budget, stream, Buffer.concat(stream.parts))) return false;
        stream.parts = [];
      }
    }
    // Both supported codecs put only the complete identification packet on BOS.
    if (flags & 2 && (stream.packets !== 1 || stream.parts.length !== 0)) return false;
    if (flags & 4) {
      if (stream.media === 0 || stream.parts.length !== 0) return false;
      stream.ended = true;
    }
    off = end;
  }
  return streams.size > 0 && [...streams.values()].every((stream) => stream.ended);
}

type PdfRef = { object: number; generation: number };
type PdfValue = number | string | null | PdfRef | PdfValue[] | Map<string, PdfValue>;
type PdfXrefEntry =
  | { type: "free" }
  | { type: "direct"; offset: number; generation: number }
  | { type: "compressed"; stream: number; index: number };

/** Small bounded syntax reader for structural dictionaries; never executes PDF content. */
class PdfStructureReader {
  readonly text: string;
  offset = 0;
  constructor(
    readonly budget: MediaWorkBudget,
    text: string,
    readonly base: number,
    end = text.length,
  ) {
    // Reserve an upper bound for slicing, syntax scans (including failed
    // lookahead), name unescaping and strings/comments. Sticky expressions
    // advance monotonically; only the number -> reference lookahead can revisit
    // a following token. A failed value terminates parsing. No suffix-wide
    // search or uncharged whitespace/comment scan is allowed outside this span.
    budget.scan((end - base) * 8);
    this.text = text.slice(base, end);
  }

  get position(): number {
    return this.base + this.offset;
  }

  match(pattern: RegExp): RegExpExecArray | null {
    pattern.lastIndex = this.offset;
    const found = pattern.exec(this.text);
    if (found) this.offset = pattern.lastIndex;
    return found;
  }

  space(): void {
    this.match(/(?:[\0\t\n\f\r ]|%[^\r\n]*)*/y);
  }

  value(depth = 0): PdfValue {
    this.budget.depth(depth);
    this.budget.visit();
    this.space();
    if (this.match(/<</y)) {
      const dict = new Map<string, PdfValue>();
      for (;;) {
        this.space();
        if (this.match(/>>/y)) return dict;
        const name = this.value(depth + 1);
        if (typeof name !== "string" || !name.startsWith("/") || dict.has(name))
          throw new Error("PDF key");
        dict.set(name, this.value(depth + 1));
      }
    }
    if (this.match(/\[/y)) {
      const values: PdfValue[] = [];
      for (;;) {
        this.space();
        if (this.match(/\]/y)) return values;
        values.push(this.value(depth + 1));
      }
    }
    const name = this.match(/\/[^\0\t\n\f\r ()<>[\]{}/%]+/y);
    if (name)
      return name[0].replace(/#([0-9a-f]{2})/gi, (_, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      );
    if (this.match(/\(/y)) {
      let nesting = 1;
      while (this.offset < this.text.length && nesting > 0) {
        const char = this.text[this.offset++];
        if (char === "\\") this.offset += 1;
        else if (char === "(") {
          nesting += 1;
          this.budget.depth(depth + nesting);
        } else if (char === ")") nesting -= 1;
      }
      if (nesting || this.offset > this.text.length) throw new Error("PDF string");
      return null;
    }
    if (this.match(/<[0-9a-f\0\t\n\f\r ]*>/iy) || this.match(/(?:null|true|false)\b/y)) return null;
    const number = this.match(/[+-]?(?:\d+\.?\d*|\.\d+)/y);
    if (!number) throw new Error("PDF value");
    const numeric = Number(number[0]);
    if (!Number.isFinite(numeric)) throw new Error("PDF number");
    const end = this.offset;
    const ref = this.match(/[\0\t\n\f\r ]+(\d+)[\0\t\n\f\r ]+R\b/y);
    if (ref) {
      if (!Number.isSafeInteger(numeric) || numeric < 1 || Number(ref[1]) > 65535)
        throw new Error("PDF reference");
      return { object: numeric, generation: Number(ref[1]) };
    }
    this.offset = end;
    return numeric;
  }
}

function pdfRef(value: PdfValue | undefined): value is PdfRef {
  return typeof value === "object" && value !== null && "object" in value;
}

function pdfInteger(value: PdfValue | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function pdfStream(
  bytes: Buffer,
  reader: PdfStructureReader,
  dict: Map<string, PdfValue>,
  budget: MediaWorkBudget,
): Buffer {
  const length = dict.get("/Length");
  if (!pdfInteger(length) || length < 1) throw new Error("PDF stream length");
  reader.space();
  if (!reader.match(/stream(?:\r\n|\n)/y) || reader.position + length > bytes.length)
    throw new Error("PDF stream");
  if (reader.offset + length > reader.text.length) throw new Error("PDF stream bounds");
  budget.scan(length);
  let data = bytes.subarray(reader.position, reader.position + length);
  reader.offset += length;
  reader.space();
  if (!reader.match(/endstream\b/y)) throw new Error("PDF stream end");
  reader.space();
  if (!reader.match(/endobj\b/y)) throw new Error("PDF object end");
  const filter = dict.get("/Filter");
  if (filter !== undefined) {
    if (
      filter !== "/FlateDecode" &&
      !(Array.isArray(filter) && filter.length === 1 && filter[0] === "/FlateDecode")
    )
      throw new Error("PDF structural stream filter");
    const maxOutputLength = Math.min(
      CAS_BLOB_MAX_BYTES - budget.decodedBytes,
      budget.scanLimit - budget.scannedBytes,
    );
    if (maxOutputLength < 1) throw new MediaBudgetExceeded("PDF inflate budget");
    try {
      data = inflateSync(data, { maxOutputLength });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ERR_BUFFER_TOO_LARGE")
        throw new MediaBudgetExceeded("PDF inflate budget");
      throw error;
    }
  }
  budget.scan(data.length);
  budget.decodedBytes += data.length;
  if (budget.decodedBytes > CAS_BLOB_MAX_BYTES) throw new MediaBudgetExceeded("PDF stream budget");
  let params = dict.get("/DecodeParms");
  if (Array.isArray(params)) params = params[0];
  if (!(params instanceof Map) || !params.has("/Predictor") || params.get("/Predictor") === 1)
    return data;
  const predictor = params.get("/Predictor");
  const columns = params.get("/Columns") ?? 1;
  if (
    !pdfInteger(predictor) ||
    predictor < 10 ||
    predictor > 15 ||
    !pdfInteger(columns) ||
    columns < 1 ||
    (params.get("/Colors") ?? 1) !== 1 ||
    (params.get("/BitsPerComponent") ?? 8) !== 8 ||
    data.length % (columns + 1)
  )
    throw new Error("PDF predictor");
  budget.scan(data.length * 2); // predictor reads and output allocation
  budget.visit(data.length / (columns + 1));
  const decoded = Buffer.alloc((data.length / (columns + 1)) * columns);
  for (let source = 0, target = 0; source < data.length; ) {
    const type = data[source++]!;
    if (type > 4) throw new Error("PDF predictor row");
    for (let column = 0; column < columns; column += 1, target += 1) {
      const left = column ? decoded[target - 1]! : 0;
      const up = target >= columns ? decoded[target - columns]! : 0;
      const corner = column && target >= columns ? decoded[target - columns - 1]! : 0;
      const p = left + up - corner;
      const pa = Math.abs(p - left),
        pb = Math.abs(p - up),
        pc = Math.abs(p - corner);
      const paeth = pa <= pb && pa <= pc ? left : pb <= pc ? up : corner;
      const prior = [0, left, up, Math.floor((left + up) / 2), paeth][type]!;
      decoded[target] = (data[source++]! + prior) & 255;
    }
  }
  return decoded;
}

/** Validate header, trailer, xref records and the catalog. Only structural streams
 * are decoded, under one shared byte budget; page content is never interpreted.
 */
function validatePdf(budget: MediaWorkBudget, bytes: Buffer): boolean {
  if (!/^%PDF-(?:1\.[0-7]|2\.0)(?:\r\n?|\n)/.test(bytes.subarray(0, 10).toString("latin1")))
    return false;
  budget.scan(bytes.length);
  const text = bytes.toString("latin1");
  const tailStart = Math.max(0, text.length - 1024);
  budget.scan((text.length - tailStart) * 4);
  const footer = /(?:\r\n?|\n)startxref[\0\t\n\f\r ]+(\d+)[\0\t\n\f\r ]+%%EOF[\0\t\n\f\r ]*$/.exec(
    text.slice(tailStart),
  );
  if (!footer) return false;
  const footerStart = tailStart + footer.index;
  let offset = Number(footer[1]);
  const visited = new Set<number>();
  // One current entry per object number, regardless of generation or storage.
  // A free entry is a tombstone: neither it nor a compressed replacement may
  // fall back to an older direct definition in the /Prev chain.
  const objects = new Map<number, PdfXrefEntry>();
  const physicalStarts = new Set<number>();
  let root: PdfRef | undefined;
  try {
    let revisionDepth = 0;
    let hybrid:
      | { entries: Map<number, PdfXrefEntry>; dictionary: Map<string, PdfValue> }
      | undefined;
    while (true) {
      if (!hybrid) budget.depth(++revisionDepth);
      budget.visit();
      if (
        !Number.isSafeInteger(offset) ||
        offset < 9 ||
        offset >= footerStart ||
        visited.has(offset)
      )
        return false;
      visited.add(offset);
      // Incremental revisions run newest to oldest. End the reservation at the
      // nearest already visited xref, not at the latest footer on every /Prev.
      // Also allow forward /Prev links (linearized files); charge their actual
      // interval again rather than treating previously reserved bytes as free.
      let revisionEnd = footerStart;
      for (const start of visited) {
        budget.scan(8);
        if (start > offset) revisionEnd = Math.min(revisionEnd, start);
      }
      const reader = new PdfStructureReader(budget, text, offset, revisionEnd);
      let dictionary: PdfValue;
      let largestObject = 0;
      const entries = new Map<number, PdfXrefEntry>();
      const classic = Boolean(reader.match(/xref\b/y));
      if (classic) {
        if (hybrid) return false;
        for (;;) {
          reader.space();
          if (reader.match(/trailer\b/y)) break;
          const subsection = reader.match(/(\d+)[ \t]+(\d+)[ \t]*(?:\r\n?|\n)/y);
          if (!subsection) return false;
          const first = Number(subsection[1]);
          const count = Number(subsection[2]);
          if (
            !Number.isSafeInteger(first) ||
            count < 1 ||
            count > (footerStart - reader.position) / 18
          )
            return false;
          largestObject = Math.max(largestObject, first + count - 1);
          budget.visit(count);
          for (let i = 0; i < count; i += 1) {
            const row = reader.match(/(\d{10})[ \t](\d{5})[ \t]([nf])[ \t]*(?:\r\n?|\n)/y);
            if (!row || Number(row[2]) > 65535) return false;
            let entry: PdfXrefEntry = { type: "free" };
            if (row[3] === "n") {
              const objectOffset = Number(row[1]);
              if (objectOffset < 9 || objectOffset >= footerStart) return false;
              physicalStarts.add(objectOffset);
              entry = { type: "direct", offset: objectOffset, generation: Number(row[2]) };
            }
            if (entries.has(first + i)) return false;
            entries.set(first + i, entry);
          }
        }
        dictionary = reader.value();
      } else {
        // PDF 1.5+ may store the xref and trailer as a stream object.
        if (!reader.match(/\d+\s+\d+\s+obj\b/y)) return false;
        dictionary = reader.value();
        if (!(dictionary instanceof Map) || dictionary.get("/Type") !== "/XRef") return false;
        const widths = dictionary.get("/W");
        const size = dictionary.get("/Size");
        const indices = dictionary.get("/Index") ?? [0, size];
        if (
          !Array.isArray(widths) ||
          widths.length !== 3 ||
          !widths.every((v): v is number => pdfInteger(v) && v <= 8) ||
          !pdfInteger(size) ||
          size < 2 ||
          !Array.isArray(indices) ||
          indices.length % 2 ||
          indices.length === 0 ||
          !indices.every(pdfInteger)
        )
          return false;
        const width = widths.reduce((sum, v) => sum + v, 0);
        if (width === 0) return false;
        const data = pdfStream(bytes, reader, dictionary, budget);
        budget.scan(data.length);
        let at = 0;
        const field = (width: number, fallback: number) => {
          if (width === 0) return fallback;
          let value = 0n;
          for (let i = 0; i < width; i += 1) value = (value << 8n) | BigInt(data[at++]!);
          if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("PDF xref field");
          return Number(value);
        };
        let previousEnd = 0;
        for (let i = 0; i < indices.length; i += 2) {
          const first = indices[i]!,
            count = indices[i + 1]!;
          if (
            first < previousEnd ||
            count < 1 ||
            first + count > size ||
            count * width > data.length - at
          )
            return false;
          previousEnd = first + count;
          budget.visit(count);
          for (let object = first; object < first + count; object += 1) {
            const type = field(widths[0]!, 1),
              value = field(widths[1]!, 0),
              generation = field(widths[2]!, 0);
            if (type === 1) {
              if (value < 9 || value >= footerStart || generation > 65535) return false;
              physicalStarts.add(value);
              entries.set(object, { type: "direct", offset: value, generation });
            } else if (type === 2) {
              if (value < 1 || value >= size) return false;
              entries.set(object, { type: "compressed", stream: value, index: generation });
            } else if (type === 0) {
              if (generation > 65535) return false;
              entries.set(object, { type: "free" });
            } else return false;
          }
        }
        if (at !== data.length) return false;
      }
      if (reader.position > footerStart || !(dictionary instanceof Map)) return false;
      const size = dictionary.get("/Size");
      if (!pdfInteger(size) || size < 2 || largestObject >= size) return false;
      const sectionRoot = dictionary.get("/Root");
      if (sectionRoot !== undefined && (!pdfRef(sectionRoot) || sectionRoot.object >= size))
        return false;
      let current = entries;
      if (hybrid) {
        // ISO 32000-1 7.5.8.4: the supplemental stream overrides this
        // revision's table, then follow the table's /Prev (not the stream's).
        for (const [object, entry] of entries) {
          budget.scan(8);
          hybrid.entries.set(object, entry);
        }
        current = hybrid.entries;
        dictionary = hybrid.dictionary;
        hybrid = undefined;
      } else if (classic && dictionary.has("/XRefStm")) {
        const supplement = dictionary.get("/XRefStm");
        if (!pdfInteger(supplement)) return false;
        hybrid = { entries, dictionary };
        offset = supplement;
        continue;
      }
      for (const [object, entry] of current) {
        budget.scan(8);
        if (!objects.has(object)) objects.set(object, entry);
      }
      const candidate = dictionary.get("/Root");
      if (!root && pdfRef(candidate)) root = candidate;
      const previous = dictionary.get("/Prev");
      if (previous === undefined) break;
      if (!pdfInteger(previous)) return false;
      offset = previous;
    }
    if (!root) return false;
    // Check each current direct object's identity once, after revision merging.
    // Historical offsets are only physical bounds, never resolution candidates.
    for (const [object, entry] of objects) {
      if (entry.type !== "direct") continue;
      budget.scan(64);
      const header = /^(\d+)\s+(\d+)\s+obj\b/.exec(text.slice(entry.offset, entry.offset + 64));
      if (!header || Number(header[1]) !== object || Number(header[2]) !== entry.generation)
        return false;
    }
    // Bound direct readers at the next physical object/xref, so reserving a
    // syntax span never charges the whole file suffix for each small object.
    const starts = [...new Set([...physicalStarts, ...visited, footerStart])].sort((a, b) => {
      budget.scan(8);
      return a - b;
    });
    const ends = new Map(starts.slice(0, -1).map((start, i) => [start, starts[i + 1]!]));
    // Each object id/generation is parsed once, including shared indirect values
    // and compressed objects. Cache decoded text once per object stream as well.
    const streamCache = new Map<
      number,
      { text: string; entries: { object: number; start: number; end: number }[] }
    >();
    const parseObject = (ref: PdfRef, depth: number): PdfValue => {
      const entry = objects.get(ref.object);
      if (!entry || entry.type === "free") throw new Error("PDF missing reference");
      if (entry.type === "direct") {
        if (entry.generation !== ref.generation) throw new Error("PDF reference generation");
        const reader = new PdfStructureReader(budget, text, entry.offset, ends.get(entry.offset));
        if (!reader.match(/\d+\s+\d+\s+obj\b/y)) throw new Error("PDF object");
        const value = reader.value(depth);
        reader.space();
        if (!reader.match(/endobj\b/y)) throw new Error("PDF object end");
        return value;
      }
      const stream = objects.get(entry.stream);
      if (stream?.type !== "direct" || stream.generation !== 0 || ref.generation !== 0)
        throw new Error("PDF missing reference");
      const streamOffset = stream.offset;
      let cached = streamCache.get(entry.stream);
      if (!cached) {
        const reader = new PdfStructureReader(budget, text, streamOffset, ends.get(streamOffset));
        if (!reader.match(/\d+\s+0\s+obj\b/y)) throw new Error("PDF object stream");
        budget.visit();
        const dict = reader.value(depth);
        if (!(dict instanceof Map) || dict.get("/Type") !== "/ObjStm")
          throw new Error("PDF object stream type");
        const count = dict.get("/N"),
          first = dict.get("/First");
        if (!pdfInteger(count) || !pdfInteger(first) || count < 1)
          throw new Error("PDF object stream fields");
        const data = pdfStream(bytes, reader, dict, budget);
        if (first >= data.length || count > first / 3) throw new Error("PDF object stream bounds");
        budget.scan(data.length);
        const streamText = data.toString("latin1");
        const header = new PdfStructureReader(budget, streamText, 0, first);
        const entries: { object: number; start: number; end: number }[] = [];
        const ids = new Set<number>();
        budget.visit(count);
        for (let i = 0; i < count; i += 1) {
          header.space();
          const pair = header.match(/(\d+)\s+(\d+)\b/y);
          if (!pair) throw new Error("PDF object stream index");
          const object = Number(pair[1]),
            position = first + Number(pair[2]);
          const previous = entries.at(-1);
          if (
            !Number.isSafeInteger(object) ||
            object < 1 ||
            ids.has(object) ||
            position >= data.length ||
            (previous && position <= previous.start)
          )
            throw new Error("PDF object stream entry");
          ids.add(object);
          if (previous) previous.end = position;
          entries.push({ object, start: position, end: data.length });
        }
        header.space();
        if (header.offset !== first) throw new Error("PDF object stream header");
        cached = { text: streamText, entries };
        streamCache.set(entry.stream, cached);
      }
      const item = cached.entries[entry.index];
      if (!item || item.object !== ref.object) throw new Error("PDF object stream reference");
      const reader = new PdfStructureReader(budget, cached.text, item.start, item.end);
      const value = reader.value(depth);
      reader.space();
      if (reader.offset !== reader.text.length) throw new Error("PDF compressed object end");
      return value;
    };
    const resolved = new Map<string, { value: PdfValue; referenceDepth: number }>();
    const resolving = new Set<string>();
    const resolve = (ref: PdfRef, depth: number): { value: PdfValue; referenceDepth: number } => {
      budget.depth(depth);
      budget.visit();
      const key = `${ref.object}:${ref.generation}`;
      const cached = resolved.get(key);
      if (cached) {
        budget.depth(depth + cached.referenceDepth);
        return cached;
      }
      if (resolving.has(key)) throw new Error("PDF reference cycle");
      resolving.add(key);
      try {
        const parsed = parseObject(ref, depth);
        const target = pdfRef(parsed) ? resolve(parsed, depth + 1) : null;
        const result = target
          ? { value: target.value, referenceDepth: target.referenceDepth + 1 }
          : { value: parsed, referenceDepth: 0 };
        resolved.set(key, result);
        return result;
      } finally {
        resolving.delete(key);
      }
    };
    const catalog = resolve(root, 1).value;
    if (!(catalog instanceof Map) || catalog.get("/Type") !== "/Catalog") return false;
    const pages = catalog.get("/Pages");
    if (!pdfRef(pages)) return false;
    const pageNodes = new Set<string>();
    const pageCount = (
      ref: PdfRef,
      parent: PdfRef | null,
      inheritedBox: PdfValue | undefined,
      depth: number,
    ): number => {
      const key = `${ref.object}:${ref.generation}`;
      budget.depth(depth);
      budget.visit();
      if (pageNodes.has(key)) throw new Error("PDF page tree cycle");
      pageNodes.add(key);
      const node = resolve(ref, depth).value;
      if (!(node instanceof Map)) throw new Error("PDF page node");
      const declaredParent = node.get("/Parent");
      if (
        parent &&
        (!pdfRef(declaredParent) ||
          declaredParent.object !== parent.object ||
          declaredParent.generation !== parent.generation)
      )
        throw new Error("PDF page parent");
      let box = node.get("/MediaBox") ?? inheritedBox;
      if (pdfRef(box)) box = resolve(box, depth + 1).value;
      if (node.get("/Type") === "/Page") {
        if (!parent) throw new Error("PDF page tree root");
        if (
          !Array.isArray(box) ||
          box.length !== 4 ||
          !box.every((v): v is number => typeof v === "number" && Number.isFinite(v)) ||
          box[2]! <= box[0]! ||
          box[3]! <= box[1]!
        )
          throw new Error("PDF page rectangle");
        return 1; // a blank page is an actual page; content decoding is out of scope
      }
      const count = node.get("/Count"),
        kids = node.get("/Kids");
      if (
        node.get("/Type") !== "/Pages" ||
        !pdfInteger(count) ||
        count === 0 ||
        !Array.isArray(kids) ||
        kids.length === 0 ||
        !kids.every(pdfRef)
      )
        throw new Error("PDF pages");
      let actual = 0;
      for (const child of kids) actual += pageCount(child, ref, box, depth + 1);
      if (actual !== count) throw new Error("PDF page count");
      return actual;
    };
    return pageCount(pages, null, undefined, 2) > 0;
  } catch (error) {
    if (error instanceof MediaBudgetExceeded) throw error;
    return false;
  }
}

/** Single admission table: every allowlisted MIME must supply its bounded structural validator. */
const CAS_MEDIA_VALIDATORS: Record<
  CasSniffMime,
  (budget: MediaWorkBudget, bytes: Buffer) => boolean
> = {
  "image/jpeg": validateJpeg,
  "image/png": validatePng,
  "image/gif": validateGif,
  "image/webp": validateWebp,
  "video/mp4": validateMp4,
  "video/webm": validateWebm,
  "audio/mpeg": validateMp3,
  "audio/wav": validateWav,
  "audio/ogg": validateOgg,
  "application/pdf": validatePdf,
};

function sniffTrustedMime(bytes: Buffer, budget: MediaWorkBudget): SniffResult {
  if (bytes.length === 0 || bytes.length > CAS_BLOB_MAX_BYTES) {
    return { ok: false, reason: "size out of bounds" };
  }
  try {
    budget.scan(Math.min(bytes.length, 512) * 8); // bounded rejection-only text probes
    if (looksLikeHtml(bytes) || looksLikeSvg(bytes)) {
      return { ok: false, reason: "active content rejected" };
    }
    for (const mime of CAS_SNIFF_MIME_TYPES) {
      budget.scan(Math.min(bytes.length, 16));
      budget.visit();
      budget.depth(1);
      if (CAS_MEDIA_VALIDATORS[mime](budget, bytes))
        return { ok: true, mime, attachmentOnly: mime === "application/pdf" };
    }
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof MediaBudgetExceeded
          ? "media work budget exceeded"
          : "invalid media structure",
    };
  }
  return { ok: false, reason: "unknown or unsupported type" };
}

/** Validates declared MIME against bounded content sniffing. */
export function validateCasMediaBytes(
  bytes: Buffer,
  declaredMime: string,
): SniffResult | { ok: false; reason: "mime mismatch"; sniffed: CasSniffMime | null } {
  if (!isCasSniffMime(declaredMime)) {
    return { ok: false, reason: "mime mismatch", sniffed: null };
  }
  const sniffed = sniffTrustedMime(bytes, new MediaWorkBudget(bytes.length));
  if (!sniffed.ok) return sniffed;
  if (sniffed.mime !== declaredMime) {
    return { ok: false, reason: "mime mismatch", sniffed: sniffed.mime };
  }
  return sniffed;
}

export function sniffTrustedMimeForTest(bytes: Buffer) {
  const budget = new MediaWorkBudget(bytes.length);
  const result = sniffTrustedMime(bytes, budget);
  return {
    ...result,
    work: {
      scannedBytes: budget.scannedBytes,
      scanLimit: budget.scanLimit,
      visits: budget.visits,
      visitLimit: budget.visitLimit,
      maxDepth: budget.maxDepth,
      depthLimit: MEDIA_MAX_DEPTH,
    },
  };
}
