import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  absoluteFragmentedMp4,
  alphaLosslessWebp,
  animatedGif,
  animatedLosslessWebp,
  animatedWebp,
  audioWebm,
  cbrMp3NoTag,
  commentGif,
  emptyFormatWav,
  emptyOgg,
  extendedWebp,
  fragmentedMp4,
  ftypOnlyMp4,
  headerOnlyMp4,
  htmlPolyglot,
  hybridMp4,
  identificationOnlyOgg,
  incompleteAnimatedWebp,
  incompleteTrackMp4,
  incompleteWebm,
  incrementalPdf,
  indexedPng,
  invalidMediaIdentifiers,
  invalidMp4References,
  linearMediaWorkCases,
  losslessWebp,
  manyChunksWav,
  manyFrameChunksWebp,
  markersOnlyPdf,
  mediaStructureCases,
  mediaWorkBudgetCases,
  minimalGif,
  minimalJpeg,
  minimalOgg,
  minimalPdf,
  minimalPng,
  minimalWav,
  minimalWebp,
  mp4FragmentVariants,
  mp4TableVariants,
  mp4WithLookalikeExtraBoxes,
  mp4WithTrailingOpenMdat,
  opusOgg,
  pdfRevisionCases,
  pngWithHeaderField,
  pngWithoutIdat,
  progressiveJpeg,
  realMp4,
  realWebm,
  sharedMediaBoxPdf,
  sharedSamplesMp4,
  streamPdf,
  structuralPdf,
  svgPolyglot,
  taggedMp3,
  vbrMp3,
  vp8xOnlyWebp,
  webmWithOverflowingSegmentSize,
  webmWithUnknownSegmentSize,
} from "./kb/fixtures/media-bytes";
import { CAS_SNIFF_MIME_TYPES, sniffTrustedMimeForTest, validateCasMediaBytes } from "./sniff-mime";

describe("sniff-mime", () => {
  it("covers every allowlisted format and rejects empty input", () => {
    expect(
      mediaStructureCases()
        .map((row) => row.mime)
        .sort(),
    ).toEqual([...CAS_SNIFF_MIME_TYPES].sort());
    expect(sniffTrustedMimeForTest(Buffer.alloc(0)).ok).toBe(false);
  });

  it.each(
    mediaStructureCases().flatMap(({ mime, invalid }) =>
      invalid.map(({ kind, bytes }) => ({ mime, kind, bytes })),
    ),
  )("rejects $mime: $kind", ({ mime, bytes }) => {
    expect(validateCasMediaBytes(bytes, mime).ok).toBe(false);
  });

  it.each([
    [16, 0, true],
    [20, 0, true],
    [16, 0x80000000, true],
    [24, 0, false],
    [24, 4, false],
    [25, 1, false],
    [25, 3, false],
    [26, 1, false],
    [27, 1, false],
    [28, 2, false],
  ] as const)("rejects invalid PNG IHDR field %i=%i with a correct CRC", (offset, value, wide) => {
    expect(validateCasMediaBytes(pngWithHeaderField(offset, value, wide), "image/png").ok).toBe(
      false,
    );
  });

  it.each([6, 8, 24, 26, 29])("rejects GIF zero dimensions or illegal LZW size at %i", (offset) => {
    const bytes = minimalGif();
    bytes[offset] = 0;
    expect(validateCasMediaBytes(bytes, "image/gif").ok).toBe(false);
  });

  it("checks GIF rectangle, reserved flags, and every image's data", () => {
    for (const [offset, value] of [
      [20, 2],
      [28, 0x18],
      [29, 9],
    ]) {
      const bytes = minimalGif();
      bytes[offset!] = value!;
      expect(validateCasMediaBytes(bytes, "image/gif").ok).toBe(false);
    }
    const first = minimalGif();
    const emptyImage = Buffer.from("2c0000000001000100000200", "hex");
    expect(
      validateCasMediaBytes(
        Buffer.concat([first.subarray(0, -1), emptyImage, Buffer.from([0x3b])]),
        "image/gif",
      ).ok,
    ).toBe(false);
    // Empty comments remain valid; they are not empty image data.
    expect(
      validateCasMediaBytes(
        Buffer.concat([first.subarray(0, -1), Buffer.from([0x21, 0xfe, 0, 0x3b])]),
        "image/gif",
      ).ok,
    ).toBe(true);
  });

  function pngChunk(type: string, payload: Buffer): Buffer {
    const chunk = Buffer.alloc(12 + payload.length);
    chunk.writeUInt32BE(payload.length);
    chunk.write(type, 4);
    payload.copy(chunk, 8);
    chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
    return chunk;
  }

  it("enforces PNG IHDR/palette/IDAT ordering, complete chunks and CRC", () => {
    const png = minimalPng();
    const signature = png.subarray(0, 8),
      header = png.subarray(8, 33),
      data = png.subarray(33, -12),
      end = png.subarray(-12);
    for (const chunks of [
      [data, header, end],
      [header, header, data, end],
      [header, data, pngChunk("tEXt", Buffer.from("a\0b")), data, end],
      [header, data, pngChunk("PLTE", Buffer.alloc(3)), end],
      [header, pngChunk("IDAT", Buffer.alloc(0)), end],
      [header, data.subarray(0, -1), end],
      [header, changedCrc(data), end],
    ])
      expect(validateCasMediaBytes(Buffer.concat([signature, ...chunks]), "image/png").ok).toBe(
        false,
      );
    const indexed = indexedPng();
    const palette = indexed.indexOf("PLTE") - 4;
    const after = palette + 12 + indexed.readUInt32BE(palette);
    expect(
      validateCasMediaBytes(
        Buffer.concat([indexed.subarray(0, palette), indexed.subarray(after)]),
        "image/png",
      ).ok,
    ).toBe(false);
  });

  function changedCrc(chunk: Buffer): Buffer {
    const bytes = Buffer.from(chunk);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    return bytes;
  }

  it("validates JPEG SOF fields and requires the frame before scans", () => {
    const original = minimalJpeg();
    const sof = original.indexOf(Buffer.from([0xff, 0xc0]));
    for (const [relative, value] of [
      [4, 0],
      [5, 0],
      [7, 0],
      [11, 0],
      [12, 4],
    ]) {
      const bytes = Buffer.from(original);
      if (relative === 5 || relative === 7) bytes.writeUInt16BE(value!, sof + relative);
      else bytes[sof + relative!] = value!;
      expect(validateCasMediaBytes(bytes, "image/jpeg").ok).toBe(false);
    }
    const end = sof + 2 + original.readUInt16BE(sof + 2);
    expect(
      validateCasMediaBytes(
        Buffer.concat([original.subarray(0, sof), original.subarray(end)]),
        "image/jpeg",
      ).ok,
    ).toBe(false);
    const sos = original.indexOf(Buffer.from([0xff, 0xda]));
    const bytes = Buffer.from(original);
    bytes[sos + 5] = 99;
    expect(validateCasMediaBytes(bytes, "image/jpeg").ok).toBe(false);
  });

  it("requires two consecutive MPEG frames and legal ID3 fields", () => {
    const single = cbrMp3NoTag().subarray(0, 417); // 128kbps, 44.1kHz, first frame unpadded
    expect(validateCasMediaBytes(single, "audio/mpeg").ok).toBe(false);
    for (const [offset, value] of [
      [5, 1],
      [6, 128],
    ]) {
      const bytes = taggedMp3();
      bytes[offset!] = value!;
      expect(validateCasMediaBytes(bytes, "audio/mpeg").ok).toBe(false);
    }
  });

  it("checks WebP extended and frame flags, canvas and ANIM ordering", () => {
    for (const mutate of [
      (b: Buffer) => {
        b[20] = b[20]! | 1;
      },
      (b: Buffer) => {
        b[21] = 1;
      },
      (b: Buffer) => {
        b.write("JUNK", b.indexOf("ANIM"));
      },
      (b: Buffer) => {
        b[b.indexOf("ANMF") + 23] = 4;
      },
      (b: Buffer) => {
        b[b.indexOf("ANMF") + 8] = 255;
      },
    ]) {
      const bytes = animatedWebp();
      mutate(bytes);
      expect(validateCasMediaBytes(bytes, "image/webp").ok).toBe(false);
    }
  });

  it("checks WebM audio rates/channels and declared EBML header limits", () => {
    for (const pattern of ["b588", "9f81", "42f281"]) {
      const bytes = audioWebm(),
        at = bytes.indexOf(Buffer.from(pattern, "hex"));
      expect(at).toBeGreaterThan(0);
      const length = pattern === "b588" ? 8 : 1;
      bytes.fill(0, at + pattern.length / 2, at + pattern.length / 2 + length);
      expect(validateCasMediaBytes(bytes, "video/webm").ok).toBe(false);
    }
  });

  it.each([
    ["/Pages 6 0 R", "/Pages 9 0 R"],
    ["/Count 1", "/Count 2"],
    ["[ 3 0 R ]", "[ 6 0 R ]"],
    ["/Parent 6 0 R", "/Parent 4 0 R"],
    ["/Type /Page\n", "/Type /Gone\n"],
  ])("requires a real bounded PDF page tree (%s)", (from, to) => {
    const original = minimalPdf().toString("latin1"),
      changed = original.replace(from, to);
    expect(changed).not.toBe(original);
    expect(validateCasMediaBytes(Buffer.from(changed, "latin1"), "application/pdf").ok).toBe(false);
  });

  it.each(invalidMp4References())("rejects MP4 sample references: $kind", ({ bytes }) => {
    expect(validateCasMediaBytes(bytes, "video/mp4").ok).toBe(false);
  });

  it.each(invalidMediaIdentifiers())(
    "rejects binary identifier look-alike: $kind",
    ({ mime, bytes }) => {
      expect(validateCasMediaBytes(bytes, mime).ok).toBe(false);
    },
  );

  it.each([...mp4TableVariants(), ...mp4FragmentVariants(), ...mp4WithLookalikeExtraBoxes()])(
    "accepts MP4 sample references: $kind",
    ({ bytes }) => {
      expect(validateCasMediaBytes(bytes, "video/mp4").ok).toBe(true);
    },
  );

  it.each([
    ["image/png", minimalPng],
    ["image/png", indexedPng],
    ["image/jpeg", minimalJpeg],
    ["image/jpeg", progressiveJpeg],
    ["image/gif", minimalGif],
    ["image/gif", animatedGif],
    ["image/gif", commentGif],
    ["image/webp", minimalWebp],
    ["image/webp", losslessWebp],
    ["image/webp", alphaLosslessWebp],
    ["image/webp", extendedWebp],
    ["image/webp", animatedWebp],
    ["image/webp", animatedLosslessWebp],
    ["video/mp4", realMp4],
    ["video/mp4", fragmentedMp4],
    ["video/mp4", absoluteFragmentedMp4],
    ["video/mp4", hybridMp4],
    ["video/mp4", mp4WithTrailingOpenMdat],
    ["video/webm", realWebm],
    ["video/webm", audioWebm],
    ["video/webm", webmWithUnknownSegmentSize],
    ["audio/mpeg", cbrMp3NoTag],
    ["audio/mpeg", taggedMp3],
    ["audio/mpeg", vbrMp3],
    ["audio/wav", minimalWav],
    ["audio/ogg", minimalOgg],
    ["audio/ogg", opusOgg],
    ["application/pdf", minimalPdf],
    ["application/pdf", streamPdf],
  ] as const)("accepts %s fixtures with exact declared type", (mime, bytes) => {
    const result = validateCasMediaBytes(bytes(), mime);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.mime).toBe(mime);
      if (mime === "application/pdf") expect(result.attachmentOnly).toBe(true);
    }
  });

  it.each([
    ["image/webp", incompleteAnimatedWebp],
    ["video/mp4", incompleteTrackMp4],
    ["audio/wav", emptyFormatWav],
    ["audio/ogg", emptyOgg],
    ["audio/ogg", identificationOnlyOgg],
    ["video/webm", incompleteWebm],
    ["application/pdf", markersOnlyPdf],
  ] as const)("rejects incomplete nested records in %s", (mime, fixture) => {
    expect(validateCasMediaBytes(fixture(), mime).ok).toBe(false);
  });

  it.each([minimalOgg, opusOgg])(
    "requires all headers, media and EOS on a complete Ogg stream",
    (fixture) => {
      const bytes = fixture();
      const pages: number[] = [];
      for (let at = 0; at < bytes.length; ) {
        pages.push(at);
        const segments = bytes[at + 26]!;
        let end = at + 27 + segments;
        for (let i = 0; i < segments; i += 1) end += bytes[at + 27 + i]!;
        at = end;
      }
      expect(validateCasMediaBytes(bytes.subarray(0, pages.at(-1)), "audio/ogg").ok).toBe(false);
      for (const [page, relative, value] of [
        [0, 5, 0], // missing BOS
        [1, 18, 7], // broken sequence
        [1, 5, 1], // continuation without a pending packet
        [pages.length - 1, 5, 0], // missing EOS on otherwise complete media
        [0, 28, 0], // identification magic
        [1, 27 + bytes[pages[1]! + 26]!, 0], // comment header magic
      ]) {
        const changed = Buffer.from(bytes);
        const start = pages[page!]!;
        const end = pages[page! + 1] ?? bytes.length;
        changed[start + relative!] = value!;
        // Recompute the real Ogg CRC so these cases exercise record validation.
        changed.fill(0, start + 22, start + 26);
        let crc = 0;
        for (let i = start; i < end; i += 1) {
          crc ^= changed[i]! << 24;
          for (let bit = 0; bit < 8; bit += 1)
            crc = (crc << 1) ^ (crc & 0x80000000 ? 0x04c11db7 : 0);
        }
        changed.writeUInt32LE(crc >>> 0, start + 22);
        expect(validateCasMediaBytes(changed, "audio/ogg").ok).toBe(false);
      }
      expect(validateCasMediaBytes(bytes.subarray(0, bytes.length - 1), "audio/ogg").ok).toBe(
        false,
      );
    },
  );

  it("accepts complete chained Ogg audio streams", () => {
    expect(validateCasMediaBytes(Buffer.concat([minimalOgg(), opusOgg()]), "audio/ogg").ok).toBe(
      true,
    );
  });

  function webmBlockFixture(blocks: string): Buffer {
    // One declared VP8 video track with UID and dimensions, followed by blocks.
    const tracks = Buffer.from(
      "1654ae6b9bae99d7810173c581018381018685565f565038e086b08110ba8110",
      "hex",
    );
    const data = Buffer.from(blocks, "hex");
    const cluster = Buffer.concat([
      Buffer.from("1f43b675", "hex"),
      Buffer.from([0x80 + data.length]),
      data,
    ]);
    const segment = Buffer.concat([tracks, cluster]);
    return Buffer.concat([
      realWebm().subarray(0, 36),
      Buffer.from("18538067", "hex"),
      Buffer.from([0x80 + segment.length]),
      segment,
    ]);
  }

  it.each([
    "a3858100008078", // complete unlaced header + one payload
    "a38781000084016162", // two fixed-size frames
    "a3888100008201016162", // two Xiph-laced frames
    "a3888100008601816162", // two EBML-laced frames
    "a087a1858100000078", // BlockGroup / Block
  ])("accepts complete WebM block framing (%s)", (blocks) => {
    expect(validateCasMediaBytes(webmBlockFixture(blocks), "video/webm").ok).toBe(true);
  });

  it.each([
    "a38178", // review's one-byte SimpleBlock
    "a38481000080", // header with no payload
    "a3858200008078", // undeclared track
    "a3868100008402aa", // fixed lacing: three frames, one byte
    "a3878100008201ff78", // unterminated Xiph length
    "a38781000086010078", // invalid EBML length
    "a38781000082010078", // zero-length Xiph frame
    "a087a1858200000078", // BlockGroup referencing an undeclared track
  ])("rejects malformed WebM blocks even after a valid block (%s)", (blocks) => {
    expect(
      validateCasMediaBytes(webmBlockFixture("a3858100008078" + blocks), "video/webm").ok,
    ).toBe(false);
  });

  it("rejects missing WebM track declarations and invalid CodecID", () => {
    for (const [from, to] of [
      ["d78101", "d78100"],
      ["565f565038", "585f565038"],
      ["b08110", "b08100"],
    ]) {
      const bytes = webmBlockFixture("a3858100008078");
      Buffer.from(to!, "hex").copy(bytes, bytes.indexOf(Buffer.from(from!, "hex")));
      expect(validateCasMediaBytes(bytes, "video/webm").ok).toBe(false);
    }
  });

  it.each([
    ["%PDF-1.3", "%PDF-x.y"],
    ["xref\n", "xxxx\n"],
    ["/Root ", "/Gone "],
    ["/Type /Catalog", "/Type /Garbage"],
    ["%%EOF", "%%BAD"],
  ])("rejects malformed PDF structural records (%s)", (from, to) => {
    const bytes = Buffer.from(minimalPdf().toString("latin1").replace(from, to), "latin1");
    expect(bytes).not.toEqual(minimalPdf());
    expect(validateCasMediaBytes(bytes, "application/pdf").ok).toBe(false);
  });

  it("rejects invalid PDF startxref offsets and truncated xref-stream payloads", () => {
    const pdf = minimalPdf().toString("latin1");
    expect(
      validateCasMediaBytes(
        Buffer.from(pdf.replace(/startxref\s+\d+/, "startxref\n9"), "latin1"),
        "application/pdf",
      ).ok,
    ).toBe(false);
    const stream = streamPdf().toString("latin1");
    for (const mutated of [
      stream.replace("/W [1 4 2]", "/W [1 4 3]"),
      stream.replace("endstream", "badstream"),
      stream.replace("/Size 6", "/Size 1"),
    ]) {
      expect(validateCasMediaBytes(Buffer.from(mutated, "latin1"), "application/pdf").ok).toBe(
        false,
      );
    }
  });

  it.each([losslessWebp, animatedLosslessWebp])("rejects reserved VP8L versions", (fixture) => {
    for (let version = 1; version <= 7; version += 1) {
      const bytes = fixture();
      const versionByte = bytes.indexOf("VP8L") + 12;
      bytes[versionByte] = bytes[versionByte]! | (version << 5);
      expect(validateCasMediaBytes(bytes, "image/webp").ok).toBe(false);
    }
  });

  it("validates every animated coded-image header", () => {
    for (const fixture of [animatedWebp, animatedLosslessWebp]) {
      const bytes = fixture();
      const fourcc = fixture === animatedWebp ? "VP8 " : "VP8L";
      const second = bytes.indexOf(fourcc, bytes.indexOf(fourcc) + 4);
      // Break only the second frame's signature; an earlier good frame cannot mask it.
      bytes[second + 8 + (fourcc === "VP8 " ? 3 : 0)] = 0;
      expect(validateCasMediaBytes(bytes, "image/webp").ok).toBe(false);
    }
  });

  it.each(["mvhd", "tkhd", "mdhd"])("validates MP4 %s version and required fields", (type) => {
    for (const version of [1, 2]) {
      const bytes = realMp4();
      // v1 needs wider timestamp/duration fields; the unchanged v0 payload is too short.
      bytes[bytes.indexOf(type) + 4] = version;
      expect(validateCasMediaBytes(bytes, "video/mp4").ok).toBe(false);
    }
    const bytes = realMp4();
    bytes.writeUInt32BE(0, bytes.indexOf(type) + 16); // timescale / track ID
    expect(validateCasMediaBytes(bytes, "video/mp4").ok).toBe(false);
  });

  it("requires a complete MP4 handler header", () => {
    const bytes = realMp4();
    bytes.writeUInt32BE(0, bytes.indexOf("hdlr") + 12);
    expect(validateCasMediaBytes(bytes, "video/mp4").ok).toBe(false);
  });

  it.each([0, 2, 0xffffffff])("rejects an invalid stsd entry count of %i", (count) => {
    const bytes = realMp4();
    bytes.writeUInt32BE(count, bytes.indexOf("stsd") + 8);
    expect(validateCasMediaBytes(bytes, "video/mp4").ok).toBe(false);
  });

  it.each([8, 16, 0xffffffff])(
    "rejects incomplete/out-of-bounds stsd entries (%i bytes)",
    (size) => {
      const bytes = realMp4();
      bytes.writeUInt32BE(size, bytes.indexOf("stsd") + 12);
      expect(validateCasMediaBytes(bytes, "video/mp4").ok).toBe(false);
    },
  );

  it("rejects sample entries without a data reference", () => {
    const bytes = realMp4();
    bytes.writeUInt16BE(0, bytes.indexOf("stsd") + 26);
    expect(validateCasMediaBytes(bytes, "video/mp4").ok).toBe(false);
  });

  it("rejects WAV without samples even with a valid format", () => {
    const bytes = minimalWav().subarray(0, 44);
    bytes.writeUInt32LE(bytes.length - 8, 4);
    bytes.writeUInt32LE(0, 40);
    expect(validateCasMediaBytes(bytes, "audio/wav").ok).toBe(false);
  });

  it.each([20, 22, 24, 28, 32, 34])("rejects invalid WAV format fields at offset %i", (offset) => {
    const bytes = minimalWav();
    bytes.writeUInt16LE(0, offset);
    expect(validateCasMediaBytes(bytes, "audio/wav").ok).toBe(false);
  });

  it("rejects incomplete PCM sample frames", () => {
    const bytes = minimalWav();
    bytes.writeUInt16LE(3, 22); // three channels, but eight data bytes
    bytes.writeUInt32LE(24_000, 28);
    bytes.writeUInt16LE(3, 32);
    expect(validateCasMediaBytes(bytes, "audio/wav").ok).toBe(false);
  });

  it("rejects declared MIME mismatches", () => {
    const bytes = minimalPng();
    const result = validateCasMediaBytes(bytes, "image/jpeg");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("mime mismatch");
  });

  it("rejects HTML, SVG and unknown content", () => {
    expect(sniffTrustedMimeForTest(Buffer.from("<html></html>", "utf8")).ok).toBe(false);
    expect(sniffTrustedMimeForTest(svgPolyglot()).ok).toBe(false);
    expect(sniffTrustedMimeForTest(htmlPolyglot()).ok).toBe(false);
    expect(sniffTrustedMimeForTest(Buffer.from("plain", "utf8")).ok).toBe(false);
  });

  it("rejects structurally incomplete media", () => {
    // JPEG with only SOI and EOI, no frame or scan.
    expect(sniffTrustedMimeForTest(Buffer.from([0xff, 0xd8, 0xff, 0xd9])).ok).toBe(false);
    // MP3 with only an empty ID3 tag and no audio frames.
    expect(
      sniffTrustedMimeForTest(
        Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
      ).ok,
    ).toBe(false);
    // MP4 with only an ftyp box, no movie or media data.
    expect(sniffTrustedMimeForTest(ftypOnlyMp4()).ok).toBe(false);
    // WebP with an empty RIFF container, no image chunk.
    const emptyWebp = Buffer.alloc(12);
    Buffer.from("RIFF", "ascii").copy(emptyWebp, 0);
    emptyWebp.writeUInt32LE(4, 4);
    Buffer.from("WEBP", "ascii").copy(emptyWebp, 8);
    expect(sniffTrustedMimeForTest(emptyWebp).ok).toBe(false);
    // WebP with only a VP8X extended-format header, no coded image or frame.
    expect(sniffTrustedMimeForTest(vp8xOnlyWebp()).ok).toBe(false);
    // WebM with only its EBML header, no segment/tracks/blocks.
    expect(sniffTrustedMimeForTest(realWebm().subarray(0, 36)).ok).toBe(false);
    // WebM whose Segment size vint overflows the remaining bytes must fail
    // fast instead of stalling the walker (regression: 32-bit size decoding).
    expect(sniffTrustedMimeForTest(webmWithOverflowingSegmentSize()).ok).toBe(false);
    // MP4 whose moov and mdat boxes exist but are empty: no track structure,
    // no media payload.
    expect(sniffTrustedMimeForTest(headerOnlyMp4()).ok).toBe(false);
    // PNG without its IDAT image data.
    expect(sniffTrustedMimeForTest(pngWithoutIdat()).ok).toBe(false);
  });

  it("rejects truncated real-encoder media", () => {
    expect(sniffTrustedMimeForTest(realMp4().subarray(0, realMp4().length - 1)).ok).toBe(false);
    expect(sniffTrustedMimeForTest(realWebm().subarray(0, realWebm().length - 1)).ok).toBe(false);
    expect(
      sniffTrustedMimeForTest(progressiveJpeg().subarray(0, progressiveJpeg().length - 1)).ok,
    ).toBe(false);
    expect(sniffTrustedMimeForTest(cbrMp3NoTag().subarray(0, cbrMp3NoTag().length - 1)).ok).toBe(
      false,
    );
    expect(sniffTrustedMimeForTest(animatedGif().subarray(0, animatedGif().length - 1)).ok).toBe(
      false,
    );
    expect(sniffTrustedMimeForTest(minimalPng().subarray(0, 8)).ok).toBe(false);
    expect(sniffTrustedMimeForTest(realMp4().subarray(0, 8)).ok).toBe(false);
  });

  it("rejects prefix-only image and audio signatures", () => {
    expect(sniffTrustedMimeForTest(Buffer.from([0xff, 0xd8, 0xff])).ok).toBe(false);
    expect(sniffTrustedMimeForTest(Buffer.from("ID3", "ascii")).ok).toBe(false);
  });
});

describe("shared trusted-media work budget", () => {
  it.each(pdfRevisionCases())("resolves the final PDF object map: $kind", ({ bytes, ok }) => {
    const result = sniffTrustedMimeForTest(bytes);
    expect(result.ok).toBe(ok);
    expect(result.work.scannedBytes).toBeLessThanOrEqual(32 * bytes.length);
    if (ok) expect(result).toMatchObject({ mime: "application/pdf", attachmentOnly: true });
    expect(validateCasMediaBytes(minimalPng(), "image/png").ok).toBe(true);
  });

  it.each(["classic", "stream", "mixed"] as const)(
    "charges incremental %s xrefs without overlapping later revisions",
    (encoding) => {
      for (const saves of [0, 6, 12, 60]) {
        const bytes = incrementalPdf(saves, encoding);
        const result = sniffTrustedMimeForTest(bytes);
        expect(result).toMatchObject({ ok: true, mime: "application/pdf", attachmentOnly: true });
        expect(result.work.scannedBytes).toBeLessThanOrEqual(32 * bytes.length);
        expect(validateCasMediaBytes(bytes.subarray(0, -8), "application/pdf").ok).toBe(false);
      }
    },
  );

  it.each(linearMediaWorkCases())("admits byte-backed work: $kind", ({ mime, bytes }) => {
    const result = sniffTrustedMimeForTest(bytes);
    expect(result).toMatchObject({ ok: true, mime });
    expect(result.work.visits).toBeGreaterThan(100_000);
    expect(result.work.visits).toBeLessThanOrEqual(result.work.visitLimit);
    expect(result.work.scannedBytes).toBeLessThanOrEqual(32 * bytes.length);
    expect(validateCasMediaBytes(bytes.subarray(0, -1), mime).ok).toBe(false);
  });

  it("bounds aggregate MP4 sample expansion even when many tracks share the same bytes", () => {
    const bytes = sharedSamplesMp4(64, 16_000);
    const result = sniffTrustedMimeForTest(bytes);
    expect(result.ok).toBe(false);
    expect(result.work.visits).toBeLessThanOrEqual(result.work.visitLimit);
    expect(result.work.scannedBytes).toBeLessThanOrEqual(result.work.scanLimit);
  });

  it.each(mediaStructureCases())("charges the normal $mime path", ({ mime, positive }) => {
    const result = sniffTrustedMimeForTest(positive);
    expect(result).toMatchObject({ ok: true, mime });
    expect(result.work.scannedBytes).toBeGreaterThan(0);
    expect(result.work.scannedBytes).toBeLessThanOrEqual(32 * positive.length);
    expect(result.work.visits).toBeGreaterThan(0);
    expect(result.work.visits).toBeLessThanOrEqual(result.work.visitLimit);
    expect(result.work.maxDepth).toBeLessThanOrEqual(64);
  });

  it.each([
    { compressed: false, commentBytes: 512 * 1024 },
    { compressed: true, commentBytes: 64 * 1024 },
  ])(
    "resolves a large shared MediaBox once (compressed=$compressed)",
    ({ compressed, commentBytes }) => {
      const bytes = sharedMediaBoxPdf(1000, commentBytes, compressed);
      const result = sniffTrustedMimeForTest(bytes);
      expect(result).toMatchObject({ ok: true, mime: "application/pdf", attachmentOnly: true });
      // Charging the shared comment once per page would exceed this by >100x.
      expect(result.work.scannedBytes).toBeLessThan(32 * bytes.length);
      const smaller = sniffTrustedMimeForTest(sharedMediaBoxPdf(500, commentBytes, compressed));
      expect(smaller.ok).toBe(true);
      expect(result.work.scannedBytes - smaller.work.scannedBytes).toBeLessThan(2_000_000);
    },
  );

  it.each(mediaWorkBudgetCases())("rejects $kind with no escaping error", ({ bytes, mime }) => {
    const result = sniffTrustedMimeForTest(bytes);
    expect(result).toMatchObject({ ok: false, reason: "media work budget exceeded" });
    expect(validateCasMediaBytes(bytes, mime).ok).toBe(false);
    expect(result.work.scannedBytes).toBeLessThanOrEqual(result.work.scanLimit);
    expect(result.work.visits).toBeLessThanOrEqual(result.work.visitLimit);
    // A failed call cannot exhaust or contaminate the next invocation's budget.
    expect(validateCasMediaBytes(minimalPng(), "image/png").ok).toBe(true);
  });

  it.each([
    { mime: "video/mp4", bytes: sharedSamplesMp4(2, 8000) },
    { mime: "image/webp", bytes: manyFrameChunksWebp(10, 100) },
    { mime: "audio/wav", bytes: manyChunksWav(1000) },
  ])("accepts the smaller $mime amplification control", ({ mime, bytes }) => {
    expect(validateCasMediaBytes(bytes, mime)).toMatchObject({ ok: true, mime });
  });

  it.each([false, true])(
    "rejects an indirect reference cycle (compressed=$compressed)",
    (compressed) => {
      const objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox 4 0 R >>",
        "5 0 R",
        "4 0 R",
      ];
      expect(validateCasMediaBytes(structuralPdf(objects, compressed), "application/pdf").ok).toBe(
        false,
      );
      objects[4] = "[0 0 100 100]";
      expect(validateCasMediaBytes(structuralPdf(objects, compressed), "application/pdf").ok).toBe(
        true,
      );
    },
  );

  it.each(["references", "arrays", "strings", "pages"])("bounds deep PDF %s", (kind) => {
    const build = (depth: number) => {
      const objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox 4 0 R >>",
        "[0 0 100 100]",
      ];
      if (kind === "references") {
        for (let i = 0; i < depth; i++) objects[3 + i] = `${5 + i} 0 R`;
        objects.push("[0 0 100 100]");
      } else if (kind === "pages") {
        const tree = [objects[0]!];
        for (let i = 0; i < depth; i++) {
          const id = i + 2;
          tree.push(
            `<< /Type /Pages ${i ? `/Parent ${id - 1} 0 R` : ""} /Count 1 /Kids [${id + 1} 0 R] >>`,
          );
        }
        tree.push(`<< /Type /Page /Parent ${depth + 1} 0 R /MediaBox [0 0 100 100] >>`);
        return structuralPdf(tree);
      } else {
        const value =
          kind === "arrays"
            ? `${"[".repeat(depth)}0${"]".repeat(depth)}`
            : `${"(".repeat(depth)}x${")".repeat(depth)}`;
        objects[0] = `<< /Type /Catalog /Pages 2 0 R /Unused ${value} >>`;
      }
      return structuralPdf(objects);
    };
    expect(validateCasMediaBytes(build(4), "application/pdf").ok).toBe(true);
    expect(sniffTrustedMimeForTest(build(70))).toMatchObject({
      ok: false,
      reason: "media work budget exceeded",
    });
  });
});
