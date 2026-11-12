import { createHash } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import type { CasSniffMime } from "../../sniff-mime";

export function sha256Buffer(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** 1×1 PNG */
export function minimalPng(): Buffer {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
}

/** 1×1 PNG with different content (regression tests for CAS identity checks). */
export function alternatePng(): Buffer {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
    "base64",
  );
}

/** 16×16 progressive JPEG (Pillow, progressive=True; multiple SOS scans). */
export function progressiveJpeg(): Buffer {
  return Buffer.from(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwg" +
      "IyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgo" +
      "KCgoKCgoKCgoKCgoKCj/wgARCAAQABADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAABQb/xAAUAQEAAAAAAAAAAAAA" +
      "AAAAAAAA/9oADAMBAAIQAxAAAAGPeZeP/8QAFhAAAwAAAAAAAAAAAAAAAAAAAAME/9oACAEBAAEFAkzCZhMwmY//xAAVEQEB" +
      "AAAAAAAAAAAAAAAAAAAFAP/aAAgBAwEBPwExO//EABURAQEAAAAAAAAAAAAAAAAAAAIA/9oACAECAQE/AQ7/xAAUEAEAAAAA" +
      "AAAAAAAAAAAAAAAg/9oACAEBAAY/Ah//xAAWEAADAAAAAAAAAAAAAAAAAAAAITH/2gAIAQEAAT8hmiaJomj/2gAMAwEAAgAD" +
      "AAAAEFP/xAAWEQADAAAAAAAAAAAAAAAAAAAAITH/2gAIAQMBAT8Qgz//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/" +
      "EH//xAAVEAEBAAAAAAAAAAAAAAAAAAAA8f/aAAgBAQABPxCCgoKC/9k=",
    "base64",
  );
}

/** Two-frame animated GIF (Pillow; graphic control + NETSCAPE loop extensions). */
export function animatedGif(): Buffer {
  return Buffer.from(
    "R0lGODlhEAAQAIQAAAAIEBggKDA4QEhQWGBocHiAiJCYoKiwuMDI0Njg6PD4////////////////////////////////////" +
      "/////////////////////////////////////////////wAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAEAAQ" +
      "AAAIhQABBBAwgEABAwcQJFCwgEEDBw8GFjyYcGHDhw8gEDSIUCFDhxAhRJjY0SLIjBEkcKz4EaNICRMoerwYMuUECiVb1oRJ" +
      "oQJLmih5VrAw8+TLm0MvmHRps6eFCxh0BkX6FEMGoEedQs2gwWjTpFY1bGAqtCrXDRx2Ut0qlkOHqVrDou3gISAAIfkEAQoA" +
      "HwAsAAAAAAsACwCE////////////////////////////////////////////////////////////////////////////////" +
      "////////////////////////////////////////////AAAACDwAAQQQMIBAAQMHECRQMLDgwYQLPxA0iFChgg8fHFaMiJEi" +
      "xIsYPzy0GBLjRpAlP5YMSXIlRo4uP6CMGRAAOw==",
    "base64",
  );
}

/** GIF with a comment extension (Pillow, comment=b"hello"). */
export function commentGif(): Buffer {
  return Buffer.from(
    "R0lGODlhEAAQAIQAAAAIEBggKDA4QEhQWGBocHiAiJCYoKiwuMDI0Njg6PD4////////////////////////////////////" +
      "/////////////////////////////////////////////wAAACH+BWhlbGxvACwAAAAAEAAQAEAIggABBBAwgEABAwcQJFCw" +
      "gEEDBw8UMnQIEUIECRMoVLBwwSBCiQ0fPrCIkeLIixk3XsCQQcMGgh4TLgxZMcLHmSZJppwoUqdGjixrYvy5suUGDh0GFjwo" +
      "k2fFpTednpTAFGROlBSa0pya0gLOnlhVYtjqU2xLsEPNuuTAlSjLtR08BAQAOw==",
    "base64",
  );
}

/** 0.3 s 64×48 H.264 MP4 (ffmpeg 6.1.1: ftyp, free, mdat, moov). */
export function realMp4(): Buffer {
  return Buffer.from(
    "AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAAIZnJlZQAAC8VtZGF0AAACVAYF//9Q3EXpvebZSLeWLNgg2SPu" +
      "73gyNjQgLSBjb3JlIDE2NCByMzEwOCAzMWUxOWY5IC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMt" +
      "MjAyMyAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTAgcmVmPTEgZGVibG9j" +
      "az0wOjA6MCBhbmFseXNlPTA6MCBtZT1kaWEgc3VibWU9MCBwc3k9MSBwc3lfcmQ9MS4wMDowLjAwIG1peGVkX3JlZj0wIG1l" +
      "X3JhbmdlPTE2IGNocm9tYV9tZT0xIHRyZWxsaXM9MCA4eDhkY3Q9MCBjcW09MCBkZWFkem9uZT0yMSwxMSBmYXN0X3Bza2lw" +
      "PTEgY2hyb21hX3FwX29mZnNldD0wIHRocmVhZHM9MSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9" +
      "MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTAg" +
      "d2VpZ2h0cD0wIGtleWludD0yNTAga2V5aW50X21pbj0xMCBzY2VuZWN1dD0wIGludHJhX3JlZnJlc2g9MCByYz1jcmYgbWJ0" +
      "cmVlPTAgY3JmPTIzLjAgcWNvbXA9MC42MCBxcG1pbj0wIHFwbWF4PTY5IHFwc3RlcD00IGlwX3JhdGlvPTEuNDAgYXE9MACA" +
      "AAAEYWWIhDoMYACAACAEJdA2gusWN5FER6AYjD8ADzZqt/QEw039gAPNmq39ATDTf257MzY36nV34AWAEoAXUDiCT4HXrmA0" +
      "maJP1BdNN/YMOEAAcAVaggABA1AAEBgMKwAeg6jWCQeJlAbi3mezbOABYDkASMLN6wXMLFCgKhMYxGGdyilOcGP8aqqoAAQg" +
      "gABFho2+oKEJ+YMP/+EgAQAFAAECYJAAEDsAAQRgABCa55mNeUvcX0pDD8ZmMrqK3Ukpa0MOGMHAAEH4AASYP8AERtO1tH/8" +
      "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",
    "base64",
  );
}

/** 0.3 s 64×48 VP8 WebM (ffmpeg 6.1.1 libvpx: EBML header, Segment, Tracks, Clusters). */
export function realWebm(): Buffer {
  return Buffer.from(
    "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",
    "base64",
  );
}

/** 0.15 s 440 Hz sine MP3, CBR 128k, no ID3, no Xing (ffmpeg -write_xing 0 -id3v2_version 0). */
export function cbrMp3NoTag(): Buffer {
  return Buffer.from(
    "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" +
      "VRbIAqm8YdySkaSZOC2hI1WsKMOkgO0T2G59NQmg2gxXM2DCEYWyWnM2qmgdwmZODOC6R1fI0HJ1FFxtWczBmZrSPZzQS1O0" +
      "gypIDVNWGokbMCIAoTAjwNwwLoFfME5CpjCziCE0t/7rNJeH9zChwlgz8wTOY8N1Jc5LODYpaAxVSSdWRYItru9SwMx8yrMc" +
      "JMZ3a0zimTQxFZXY45XZXdy5cqXVkS0lZLzqqOhCGtJK+imO5NkKSW77MjKY12Lq7PZ1R1Rkazq5HZTCCUU7NsmMma3Gxfrn" +
      "ivoP3axvwOLT/l325FC/xTjiaCEoCSYDmB6mDcgpJg9AgUYjsRVHN5Wh5xT6B6ZGOMZmJUhGZguIWqYUmElmE5hM5gQoGuYB" +
      "aAEhgAWsI7j8BwUZzsx7MoAmR0O7GHCwSD5RJ2RUQ91LR1WO3ExQlzIt0OLGYsgfRDHU21qLVlXZ2VnPNaysaVGIPWqsofEJ" +
      "jP/7ksSMAxMtYwIP8KbK070gBr5QAa7CwvlOajkWdhdkkvOMedBs7K0TnJap0MtiNlZapOPp5ylVS7uc6VrTTU5plIICiqy5" +
      "ryM0xeoAASIAAxBwwjMIxANCYYk4bcRjA/CIEg0j33BSMQkA06IzzDMJK2MFQH0wPAdzAfASMB8BkwyhNzAlDIAwQBgBgImc" +
      "hZbQ2WmMpdXSkSw4YHrwNEYDDB4z8NdJOZ32aRNnylhmwoZICmSgwQSraZVG2xLcgZlivIuYoKgEQHAsGBYgBpVXoKvKR1Jv" +
      "tS6YKHoZhggChMOBgwJqynCOynCXz9mXyO9mr5AMmitpVZeamEzjreX6n8OZ3LF7Vh9GTsEbVpzyrtaU9NbOtlu5r9WO4WP7" +
      "++946LoOHK3kd+Bn5izlPrv94/vH9/+d/87ev7rDn4XuwU+0BwxKIvDkVh6df2JUMRiH/+tfrX6///+c///P/zz/+6/9Yf//" +
      "///w3TyyLz0Vno1KaCVTcoqS+WTsunftF19gooQkONDmhS8yRO1TYFnAFUarnrZ2alwZZHvAC8QDN0z/+5LEqwAm6fcUue2A" +
      "ApCc1wOw8AACo2RwrBbh6jKfl9IMPUQpaP0nKEronTwgxCnZyk5QldGk4sTNDTqGssJPK169ri1s1gsL2jEro0FWxoMXD59G" +
      "gvd1i6ta3rv5rXXtbEKNutdYth8+3V7Usd9YKuUCp0Gh50NCIOiU9/ERY8JRh4Gh4K/WCowGuJYhDRYOiU94l4iPAqMDlUxB" +
      "TUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV" +
      "VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV" +
      "VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV" +
      "VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV",
    "base64",
  );
}

/** 0.15 s 440 Hz sine MP3, CBR 128k, with ID3v2.4 + TSSE and LAME Info frames (ffmpeg defaults). */
export function taggedMp3(): Buffer {
  return Buffer.from(
    "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" +
      "nJap0MtiNlZapOPp5ylVS7uc6VrTTU5plIICiqy5ryM0xeoAASIAAxBwwjMIxANCYYk4bcRjA/CIEg0j33BSMQkA06IzzDMJ" +
      "K2MFQH0wPAdzAfASMB8BkwyhNzAlDIAwQBgBgImchZbQ2WmMpdXSkSw4YHrwNEYDDB4z8NdJOZ32aRNnylhmwoZICmSgwQSr" +
      "aZVG2xLcgZlivIuYoKgEQHAsGBYgBpVXoKvKR1JvtS6YKHoZhggChMOBgwJqynCOynCXz9mXyO9mr5AMmitpVZeamEzjreX6" +
      "n8OZ3LF7Vh9GTsEbVpzyrtaU9NbOtlu5r9WO4WP7++946LoOHK3kd+Bn5izlPrv94/vH9/+d/87ev7rDn4XuwU+0BwxKIvDk" +
      "Vh6df2JUMRiH/+tfrX6///+c///P/zz/+6/9Yf/////w3TyyLz0Vno1KaCVTcoqS+WTsunftF19gooQkONDmhS8yRO1TYFnA" +
      "FUarnrZ2alwZZHvAC8QDN0z/+5LEqwAm6fcUue2AApCc1wOw8AACo2RwrBbh6jKfl9IMPUQpaP0nKEronTwgxCnZyk5QldGk" +
      "4sTNDTqGssJPK169ri1s1gsL2jEro0FWxoMXD59Ggvd1i6ta3rv5rXXtbEKNutdYth8+3V7Usd9YKuUCp0Gh50NCIOiU9/ER" +
      "Y8JRh4Gh4K/WCowGuJYhDRYOiU94l4iPAqMDlUxBTUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV" +
      "VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV" +
      "VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV" +
      "VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV" +
      "VVVV",
    "base64",
  );
}

/** 0.15 s 440 Hz sine MP3, VBR (-q:a 0), no ID3, no Xing (per-frame bitrate varies). */
export function vbrMp3(): Buffer {
  return Buffer.from(
    "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" +
      "DeSJGe9lhuHeE+M+vMAEOS+eltqNSn//f7/9//e//f//5/859yar0mFuks2rNLWu1an///+v/////+f//3//v///////z///" +
      "p87Fu1ZtU1W5Wr1MLdiza5S1rtWpXzsW6kxBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq" +
      "qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq" +
      "qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq//uAxP6AK8oJH/nuAAAAAD/DgAAEqqqqqqqqqqqqqqqq" +
      "qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq" +
      "qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq" +
      "qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq" +
      "qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq" +
      "qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqo=",
    "base64",
  );
}

/** Minimal PNG with every IDAT chunk removed (structurally incomplete). */
export function pngWithoutIdat(): Buffer {
  const src = minimalPng();
  const parts: Buffer[] = [src.subarray(0, 8)];
  let off = 8;
  while (off + 12 <= src.length) {
    const len = src.readUInt32BE(off);
    const type = src.subarray(off + 4, off + 8).toString("ascii");
    if (type !== "IDAT") parts.push(src.subarray(off, off + 12 + len));
    off += 12 + len;
    if (type === "IEND") break;
  }
  return Buffer.concat(parts);
}

/** 1×1 baseline JPEG */
export function minimalJpeg(): Buffer {
  return Buffer.from(
    "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAAA//EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AfwD/2Q==",
    "base64",
  );
}

/** 1×1 GIF without extensions */
export function minimalGif(): Buffer {
  return Buffer.from("R0lGODdhAQABAIAAAP///////ywAAAAAAQABAAACAkQBADs=", "base64");
}

/** Lossy WebP with a VP8 chunk */
export function minimalWebp(): Buffer {
  const bytes = Buffer.from(
    "UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAQAcJaQAA3AA/v56QAAAAA==",
    "base64",
  );
  bytes.writeUInt32LE(bytes.length - 8, 4);
  return bytes;
}

/** 16×16 lossless WebP (Pillow 12.1.1, RGB red, lossless=True). */
export function losslessWebp(): Buffer {
  return Buffer.from("UklGRhwAAABXRUJQVlA4TA8AAAAvD8ADAAcQ/Y/+ByKi/wEA", "base64");
}

/** Same encoder/dimensions, RGBA red with alpha=128. */
export function alphaLosslessWebp(): Buffer {
  return Buffer.from("UklGRhwAAABXRUJQVlA4TA8AAAAvD8ADEAcQ/Y8CBiKi/wEA", "base64");
}

/** MP4 with only an ftyp box (structurally incomplete). */
export function ftypOnlyMp4(): Buffer {
  return Buffer.from([
    0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0, 0x69, 0x73, 0x6f, 0x6d,
  ]);
}

/** MP4 whose moov and mdat boxes exist but carry no movie or media payload. */
export function headerOnlyMp4(): Buffer {
  return Buffer.from("000000106674797069736f6d30303030000000086d6f6f76000000086d646174", "hex");
}

/** WebP with only a VP8X extended-format header and no image data. */
export function vp8xOnlyWebp(): Buffer {
  return Buffer.from("524946461600000057454250565038580a00000000000000000000000000", "hex");
}

/** The VP8 chunk of minimalWebp without container padding. */
function webpVp8ChunkBytes(): Buffer {
  const src = minimalWebp();
  const size = src.readUInt32LE(16);
  return src.subarray(12, 12 + 8 + size);
}

/** Extended-format WebP: VP8X header plus the minimalWebp VP8 coded image. */
export function extendedWebp(): Buffer {
  return wrapWebpChunks(webpVp8xChunk(0), webpVp8ChunkBytes());
}

/** Two 16×16 red/blue frames (Pillow 12.1.1, duration=100, loop=0). */
export function animatedWebp(): Buffer {
  return Buffer.from(
    "UklGRsQAAABXRUJQVlA4WAoAAAACAAAADwAADwAAQU5JTQYAAAAAAAAAAABBTk1GSgAAAAAAAAAAAA8AAA8AAGQAAAJWUDggMgAAADABAJ0BKhAAEAABQCYloAADcAD+8ut///mwP/bz/wR6Af//0uD//pcH//S4P/SkAAAAQU5NRkYAAAAAAAAAAAAPAAAPAABkAAAAVlA4IC4AAAA0AQCdASoQABAAAAAmJaAAA3AA/vtV4///S4P/+lwf/9Lg/9Lg//rV5Vesq6AA",
    "base64",
  );
}

/** Same animation encoded with lossless=True (VP8L inside ANMF). */
export function animatedLosslessWebp(): Buffer {
  return Buffer.from(
    "UklGRoQAAABXRUJQVlA4WAoAAAACAAAADwAADwAAQU5JTQYAAAAAAAAAAABBTk1GKAAAAAAAAAAAAA8AAA8AAGQAAAJWUDhMDwAAAC8PwAMABxD9j/4HIqL/AQBBTk1GKAAAAAAAAAAAAA8AAA8AAGQAAABWUDhMDwAAAC8PwAMABxDR//4HIqL/AQA=",
    "base64",
  );
}

/** Round-4 review repro: an ANMF containing a one-byte VP8 payload. */
export function incompleteAnimatedWebp(): Buffer {
  return Buffer.from(
    "524946463800000057454250565038580a00000002000000000000000000414e4d461a0000000000000000000000000000000000000056503820010000007800",
    "hex",
  );
}

/** Round-4 review repro: box names without mandatory header/sample records. */
export function incompleteTrackMp4(): Buffer {
  const box = (type: string, ...parts: Buffer[]) => {
    const payload = Buffer.concat(parts);
    const header = Buffer.alloc(8);
    header.writeUInt32BE(payload.length + 8);
    header.write(type, 4, "ascii");
    return Buffer.concat([header, payload]);
  };
  return Buffer.concat([
    box("ftyp", Buffer.from("isom0000")),
    box(
      "moov",
      box("mvhd", Buffer.alloc(20)),
      box(
        "trak",
        box("tkhd"),
        box(
          "mdia",
          box("mdhd"),
          box("hdlr"),
          box("minf", box("stbl", box("stsd", Buffer.alloc(16)))),
        ),
      ),
    ),
    box("mdat", Buffer.from("x")),
  ]);
}

/** Round-4 review repro: empty format and audio chunks. */
export function emptyFormatWav(): Buffer {
  return Buffer.from("524946461400000057415645666d7420000000006461746100000000", "hex");
}

function webpVp8xChunk(flags: number): Buffer {
  const vp8x = Buffer.alloc(18);
  Buffer.from("VP8X", "ascii").copy(vp8x, 0);
  vp8x.writeUInt32LE(10, 4);
  vp8x[8] = flags;
  // canvas width-1 / height-1 (3 bytes LE each) stay 0 → 1×1 canvas
  return vp8x;
}

function wrapWebpChunks(...chunks: Buffer[]): Buffer {
  const body = Buffer.concat([Buffer.from("WEBP", "ascii"), ...chunks]);
  const out = Buffer.alloc(8 + body.length);
  Buffer.from("RIFF", "ascii").copy(out, 0);
  out.writeUInt32LE(body.length, 4);
  body.copy(out, 8);
  return out;
}

/**
 * realWebm() with the Segment element's size vint rewritten to the eight-byte
 * all-ones sentinel: the Segment has unknown length and extends to EOF.
 */
export function webmWithUnknownSegmentSize(): Buffer {
  const src = realWebm();
  const segIdx = src.indexOf(Buffer.from([0x18, 0x53, 0x80, 0x67]));
  if (segIdx < 0) throw new Error("realWebm fixture lost its Segment element");
  const sizeFirst = src[segIdx + 4]!;
  if (sizeFirst === 0) throw new Error("realWebm fixture has an unreadable Segment size");
  let vintLength = 1;
  let probe = 0x80;
  while ((sizeFirst & probe) === 0) {
    probe >>= 1;
    vintLength += 1;
  }
  return Buffer.concat([
    src.subarray(0, segIdx + 4),
    Buffer.from("01ffffffffffffff", "hex"),
    src.subarray(segIdx + 4 + vintLength),
  ]);
}

/**
 * realWebm()'s EBML header followed by a Segment whose eight-byte size vint
 * overflows the remaining bytes (32-bit-shifted decoders loop forever on it).
 */
export function webmWithOverflowingSegmentSize(): Buffer {
  return Buffer.concat([
    realWebm().subarray(0, 36),
    Buffer.from("1853806701fffffffffffff4", "hex"),
  ]);
}

/** realMp4() with the media data tail rewritten as a size-0 (to-EOF) mdat box. */
export function mp4WithTrailingOpenMdat(): Buffer {
  const src = realMp4();
  const boxes: { type: string; start: number; end: number }[] = [];
  let off = 0;
  while (off + 8 <= src.length) {
    const size = src.readUInt32BE(off);
    boxes.push({
      type: src.subarray(off + 4, off + 8).toString("ascii"),
      start: off,
      end: off + size,
    });
    off += size;
  }
  const ftyp = boxes.find((box) => box.type === "ftyp");
  const moov = boxes.find((box) => box.type === "moov");
  const mdat = boxes.find((box) => box.type === "mdat");
  if (!ftyp || !moov || !mdat) throw new Error("realMp4 fixture lost an expected box");
  const openHeader = Buffer.alloc(8);
  openHeader.write("mdat", 4, "ascii"); // size 0 → box extends to end of file
  const result = Buffer.concat([
    src.subarray(ftyp.start, ftyp.end),
    src.subarray(moov.start, moov.end),
    openHeader,
    src.subarray(mdat.start + 8, mdat.end),
  ]);
  // Moving moov ahead of mdat also moves the actual sample bytes.
  result.writeUInt32BE(
    ftyp.end - ftyp.start + moov.end - moov.start + 8,
    result.indexOf("stco") + 12,
  );
  return result;
}

export function minimalWav(): Buffer {
  // Python wave encoder: mono PCM u8, 8 kHz, eight silent samples.
  return Buffer.from(
    "UklGRiwAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQgAAACAgICAgICAgA==",
    "base64",
  );
}

// ffmpeg 0.1s mono silence, vorbis.
export function minimalOgg(): Buffer {
  return Buffer.from(
    "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" +
      "dVeWdV22bd2XNM00NVFUVU0UVddUVds2VdW2NVF0XVFVZVlUVVl2XVnXVVfWfU0UVdVTTdkVVVWWVdnVZVWWdV90Vd1WXdnXVVnW" +
      "fdvWhV/WfcKoqrpuyq6uq7Ks+7Iu+7rt65RJ00xTE0VV1URRVU1XtW1TdW1bE0XXFVXVlkVTdWVVln1fdWXZ10TRdUVVlWVRVWVZ" +
      "lWVdd2VXt0VV1W1Vdn3fdF1dl3VdWGZb94XTdXVdlWXfV2VZ92Vdx9Z13/dM07ZN19V101V139Z15Zlt2/hFVdV1VZaFX5Vl39eF" +
      "4Xlu3ReeUVV13ZRdX1dlWRduXzfavm48r21j2z6yryMMR76wLF3bNrq+TZh13egbQ+E3hjTTtG3TVXXddF1fl3XdaOu6UFRVXVdl" +
      "2fdVV/Z9W/eF4fZ93xhV1/dVWRaG1ZadYfd9pe4LlVW2hd/WdeeYbV1YfuPo/L4ydHVbaOu6scy+rjy7cXSGPgIAAAYcAAACTCgD" +
      "hYasCADiBAAYhJxDTEGIFIMQQkgphJBSxBiEzDkpGXNSQimphVJSixiDkDkmJXNOSiihpVBKS6GE1kIpsYVSWmyt1ZpaizWE0loo" +
      "pbVQSouppRpbazVGjEHInJOSOSellNJaKKW1zDkqnYOUOggppZRaLCnFWDknJYOOSgchpZJKTCWlGEMqsZWUYiwpxdhabLnFmHMo" +
      "pcWSSmwlpVhbTDm2GHOOGIOQOSclc05KKKW1UlJrlXNSOggpZQ5KKinFWEpKMXNOSgchpQ5CSiWlGFNKsYVSYisp1VhKarHFmHNL" +
      "MdZQUoslpRhLSjG2GHNuseXWQWgtpBJjKCXGFmOurbUaQymxlZRiLCnVFmOtvcWYcyglxpJKjSWlWFuNucYYc06x5ZparLnF2Gtt" +
      "ufWac9CptVpTTLm2GHOOuQVZc+69g9BaKKXFUEqMrbVaW4w5h1JiKynVWEqKtcWYc2ux9lBKjCWlWEtKNbYYa4419ppaq7XFmGtq" +
      "seaac+8x5thTazW3GGtOseVac+695tZjAQAAAw4AAAEmlIFCQ1YCAFEAAAQhSjEGoUGIMeekNAgx5pyUijHnIKRSMeYchFIy5yCU" +
      "klLmHIRSUgqlpJJSa6GUUlJqrQAAgAIHAIAAGzQlFgcoNGQlAJAKAGBwHMvyPFE0Vdl2LMnzRNE0VdW2HcvyPFE0TVW1bcvzRNE0" +
      "VdV1dd3yPFE0VVV1XV33RFE1VdV1ZVn3PVE0VVV1XVn2fdNUVdV1ZVm2hV80VVd1XVmWZd9YXdV1ZVm2dVsYVtV1XVmWbVs3hlvX" +
      "dd33hWE5Ordu67rv+8LxO8cAAPAEBwCgAhtWRzgpGgssNGQlAJABAEAYg5BBSCGDEFJIIaUQUkoJAAAYcAAACDChDBQashIAiAIA" +
      "AAiRUkopjZRSSimlkVJKKaWUEkIIIYQQQgghhBBCCCGEEEIIIYQQQgghhBBCCCGEEEIIBQD4TzgA+D/YoCmxOEChISsBgHAAAMAY" +
      "pZhyDDoJKTWMOQahlJRSaq1hjDEIpaTUWkuVcxBKSam12GKsnINQUkqtxRpjByGl1lqssdaaOwgppRZrrDnYHEppLcZYc86995BS" +
      "azHWWnPvvZfWYqw159yDEMK0FGOuufbge+8ptlprzT34IIRQsdVac/BBCCGEizH33IPwPQghXIw55x6E8MEHYQAAd4MDAESCjTOs" +
      "JJ0VjgYXGrISAAgJACAQYoox55yDEEIIkVKMOecchBBCKCVSijHnnIMOQgglZIw55xyEEEIopZSMMeecgxBCCaWUkjnnHIQQQiil" +
      "lFIy56CDEEIJpZRSSucchBBCCKWUUkrpoIMQQgmllFJKKSGEEEIJpZRSSiklhBBCCaWUUkoppYQQSiillFJKKaWUEEIppZRSSiml" +
      "lBJCKKWUUkoppZSSQimllFJKKaWUUlIopZRSSimllFJKCaWUUkoppZSUUkkFAAAcOAAABBhBJxlVFmGjCRcegEJDVgIAQAAAFMRW" +
      "U4mdQcwxZ6khCDGoqUJKKYYxQ8ogpilTCiGFIXOKIQKhxVZLxQAAABAEAAgICQAwQFAwAwAMDhA+B0EnQHC0AQAIQmSGSDQsBIcH" +
      "lQARMRUAJCYo5AJAhcVF2sUFdBnggi7uOhBCEIIQxOIACkjAwQk3PPGGJ9zgBJ2iUgcBAAAAAGAAAA8AAMcFEBHRHEaGxgZHh8cH" +
      "SEgAAAAAALgAwAcAwCECREQ0h5GhscHR4fEBEhIAAAAAAAAAAAAEBAQAAAAAAAIAAAAEBE9nZ1MABMASAAAAAAAATJaLLAIAAACN" +
      "gasPBwEBAQEBAQEACg4ODg4O",
    "base64",
  );
}

// ffmpeg 0.1s mono silence, opus.
export function opusOgg(): Buffer {
  return Buffer.from(
    "T2dnUwACAAAAAAAAAAALSyIeAAAAAPBTbN0BE09wdXNIZWFkAQE4AYC7AAAAAABPZ2dTAAAAAAAAAAAAAAtLIh4BAAAABqeMoAE+" +
      "T3B1c1RhZ3MNAAAATGF2ZjYwLjE2LjEwMAEAAAAdAAAAZW5jb2Rlcj1MYXZjNjAuMzEuMTAyIGxpYm9wdXNPZ2dTAAT4EwAAAAAA" +
      "AAtLIh4CAAAAvfGceAYDAwMDAwP4//74//74//74//74//74//4=",
    "base64",
  );
}

// ReportLab invariant PDF.
export function minimalPdf(): Buffer {
  return Buffer.from(
    "JVBERi0xLjMKJZOMi54gUmVwb3J0TGFiIEdlbmVyYXRlZCBQREYgZG9jdW1lbnQgKG9wZW5zb3VyY2UpCjEgMCBvYmoKPDwKL0Yx" +
      "IDIgMCBSCj4+CmVuZG9iagoyIDAgb2JqCjw8Ci9CYXNlRm9udCAvSGVsdmV0aWNhIC9FbmNvZGluZyAvV2luQW5zaUVuY29kaW5n" +
      "IC9OYW1lIC9GMSAvU3VidHlwZSAvVHlwZTEgL1R5cGUgL0ZvbnQKPj4KZW5kb2JqCjMgMCBvYmoKPDwKL0NvbnRlbnRzIDcgMCBS" +
      "IC9NZWRpYUJveCBbIDAgMCA1OTUuMjc1NiA4NDEuODg5OCBdIC9QYXJlbnQgNiAwIFIgL1Jlc291cmNlcyA8PAovRm9udCAxIDAg" +
      "UiAvUHJvY1NldCBbIC9QREYgL1RleHQgL0ltYWdlQiAvSW1hZ2VDIC9JbWFnZUkgXQo+PiAvUm90YXRlIDAgL1RyYW5zIDw8Cgo+" +
      "PiAKICAvVHlwZSAvUGFnZQo+PgplbmRvYmoKNCAwIG9iago8PAovUGFnZU1vZGUgL1VzZU5vbmUgL1BhZ2VzIDYgMCBSIC9UeXBl" +
      "IC9DYXRhbG9nCj4+CmVuZG9iago1IDAgb2JqCjw8Ci9BdXRob3IgKGFub255bW91cykgL0NyZWF0aW9uRGF0ZSAoRDoyMDAwMDEw" +
      "MTAwMDAwMCswMCcwMCcpIC9DcmVhdG9yIChhbm9ueW1vdXMpIC9LZXl3b3JkcyAoKSAvTW9kRGF0ZSAoRDoyMDAwMDEwMTAwMDAw" +
      "MCswMCcwMCcpIC9Qcm9kdWNlciAoUmVwb3J0TGFiIFBERiBMaWJyYXJ5IC0gXChvcGVuc291cmNlXCkpIAogIC9TdWJqZWN0ICh1" +
      "bnNwZWNpZmllZCkgL1RpdGxlICh1bnRpdGxlZCkgL1RyYXBwZWQgL0ZhbHNlCj4+CmVuZG9iago2IDAgb2JqCjw8Ci9Db3VudCAx" +
      "IC9LaWRzIFsgMyAwIFIgXSAvVHlwZSAvUGFnZXMKPj4KZW5kb2JqCjcgMCBvYmoKPDwKL0ZpbHRlciBbIC9BU0NJSTg1RGVjb2Rl" +
      "IC9GbGF0ZURlY29kZSBdIC9MZW5ndGggMTAxCj4+CnN0cmVhbQpHYXBRaDBFPUYsMFVcSDNUXHBOWVReUUtrP3RjPklQLDtXI1Ux" +
      "XjIzaWhQRU1fP0NXNEtJU2k8IVs3YCNPQl9xdUI/K0Q2Wyo0RGpkXDldOEtvZGo+JjFydUkiWUtjWld0T1h+PmVuZHN0cmVhbQpl" +
      "bmRvYmoKeHJlZgowIDgKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDYxIDAwMDAwIG4gCjAwMDAwMDAwOTIgMDAwMDAgbiAK" +
      "MDAwMDAwMDE5OSAwMDAwMCBuIAowMDAwMDAwNDAyIDAwMDAwIG4gCjAwMDAwMDA0NzAgMDAwMDAgbiAKMDAwMDAwMDczMSAwMDAw" +
      "MCBuIAowMDAwMDAwNzkwIDAwMDAwIG4gCnRyYWlsZXIKPDwKL0lEIApbPDFjMTc4MTk4ZmJkZmE1MWIyNTk5NWQ4OWQ0MTAyMDQz" +
      "PjwxYzE3ODE5OGZiZGZhNTFiMjU5OTVkODlkNDEwMjA0Mz5dCiUgUmVwb3J0TGFiIGdlbmVyYXRlZCBQREYgZG9jdW1lbnQgLS0g" +
      "ZGlnZXN0IChvcGVuc291cmNlKQoKL0luZm8gNSAwIFIKL1Jvb3QgNCAwIFIKL1NpemUgOAo+PgpzdGFydHhyZWYKOTgxCiUlRU9G" +
      "Cg==",
    "base64",
  );
}

export function htmlPolyglot(): Buffer {
  return Buffer.concat([
    minimalJpeg().subarray(0, 3),
    Buffer.from("<html><script>alert(1)</script>", "utf8"),
  ]);
}

export function svgPolyglot(): Buffer {
  return Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>', "utf8");
}

// Exact round-five invalid publications, shared by sniffing and publication tests.
export function emptyOgg(): Buffer {
  const page = Buffer.alloc(27);
  page.write("OggS");
  return page;
}

export function identificationOnlyOgg(): Buffer {
  return minimalOgg().subarray(0, 58);
}

export function incompleteWebm(): Buffer {
  return Buffer.concat([
    realWebm().subarray(0, 36),
    Buffer.from("185380678d1654ae6b801f43b67583a38178", "hex"),
  ]);
}

export function markersOnlyPdf(): Buffer {
  return Buffer.from("%PDF-%%EOF");
}

// One blank page, compressed catalog/page objects and PNG-predicted Flate xref.
// Independently validated with pypdf strict mode.
export function streamPdf(): Buffer {
  return Buffer.from(
    "JVBERi0xLjUKJeLjz9MKNCAwIG9iago8PCAvVHlwZSAvT2JqU3RtIC9OIDMgL0ZpcnN0IDE0IC9MZW5ndGggMTIyIC9GaWx0ZXIg" +
      "L0ZsYXRlRGVjb2RlID4+CnN0cmVhbQp4nDNUMFAwUjA2UTBWMDdTsLFR0A+pLEhV0HdOLEnMyU9X0A9ITE8tBioxUAhSsLPjQqiA" +
      "SOh7Z6YUK0Qbg+RjgdryS/NKFAwxVYLIolSgHMQkfd/UlMxEp/wKhWgDoIChARgDDQhKLc4vLUoGmgzUb2cHMggAqNYrXQplbmRz" +
      "dHJlYW0KZW5kb2JqCjUgMCBvYmoKPDwgL1R5cGUgL1hSZWYgL1NpemUgNiAvUm9vdCAxIDAgUiAvVyBbMSA0IDJdIC9MZW5ndGgg" +
      "MzYgL0ZpbHRlciAvRmxhdGVEZWNvZGUgL0RlY29kZVBhcm1zIDw8IC9QcmVkaWN0b3IgMTIgL0NvbHVtbnMgNyA+PiA+PgpzdHJl" +
      "YW0KeJxjYgCB//+ZmIAUCyMjE5jPgKD/A0luhn9g/n0GBgBwaQT8CmVuZHN0cmVhbQplbmRvYmoKc3RhcnR4cmVmCjIzOAolJUVP" +
      "Rgo=",
    "base64",
  );
}

// Structural admission corpus: mutate real bytes while retaining enclosing
// lengths/checksums where possible, so field/data checks are actually exercised.
function changed(bytes: Buffer, mutate: (bytes: Buffer) => void): Buffer {
  mutate(bytes);
  return bytes;
}

export function pngWithHeaderField(offset: number, value: number, wide = false): Buffer {
  return changed(minimalPng(), (bytes) => {
    if (wide) bytes.writeUInt32BE(value, offset);
    else bytes[offset] = value;
    bytes.writeUInt32BE(crc32(bytes.subarray(12, 29)), 29);
  });
}

export function gifWithoutImageData(): Buffer {
  return Buffer.from("47494638376101000100800000ffffffffffff2c00000000010001000002003b", "hex");
}

function oggCrc(bytes: Buffer, start: number, end: number): void {
  bytes.fill(0, start + 22, start + 26);
  let crc = 0;
  for (let i = start; i < end; i += 1) {
    crc ^= bytes[i]! << 24;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc << 1) ^ (crc & 0x80000000 ? 0x04c11db7 : 0);
  }
  bytes.writeUInt32LE(crc >>> 0, start + 22);
}

function oggWithoutMedia(): Buffer {
  const bytes = minimalOgg();
  let at = 0;
  for (let page = 0; page < 2; page += 1) {
    const segments = bytes[at + 26]!;
    let size = 27 + segments;
    for (let i = 0; i < segments; i += 1) size += bytes[at + 27 + i]!;
    at += size;
  }
  const eos = Buffer.from(bytes.subarray(at, at + 27));
  eos[5] = 4;
  eos[26] = 0;
  oggCrc(eos, 0, eos.length);
  return Buffer.concat([bytes.subarray(0, at), eos]);
}

function webmWithoutFrames(): Buffer {
  const tracks = Buffer.from(
    "1654ae6b9bae99d7810173c581018381018685565f565038e086b08110ba8110",
    "hex",
  );
  const cluster = Buffer.from("1f43b67586a38481000080", "hex");
  const data = Buffer.concat([tracks, cluster]);
  return Buffer.concat([
    realWebm().subarray(0, 36),
    Buffer.from("18538067", "hex"),
    Buffer.from([0x80 + data.length]),
    data,
  ]);
}

function jpegWithoutScanData(): Buffer {
  const bytes = minimalJpeg();
  const scan = bytes.indexOf(Buffer.from([0xff, 0xda]));
  return Buffer.concat([
    bytes.subarray(0, scan + 2 + bytes.readUInt16BE(scan + 2)),
    Buffer.from([0xff, 0xd9]),
  ]);
}

/** All ten allowed formats: real positive plus four independent failure categories. */
export function mediaStructureCases(): {
  mime: CasSniffMime;
  positive: Buffer;
  invalid: { kind: string; bytes: Buffer }[];
}[] {
  const cases: {
    mime: CasSniffMime;
    positive: Buffer;
    header: Buffer;
    illegal: Buffer;
    missing: Buffer;
  }[] = [
    {
      mime: "image/jpeg",
      positive: minimalJpeg(),
      header: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      illegal: changed(minimalJpeg(), (b) =>
        b.writeUInt16BE(0, b.indexOf(Buffer.from([0xff, 0xc0])) + 7),
      ),
      missing: jpegWithoutScanData(),
    },
    {
      mime: "image/png",
      positive: minimalPng(),
      header: minimalPng().subarray(0, 33),
      illegal: pngWithHeaderField(16, 0, true),
      missing: pngWithoutIdat(),
    },
    {
      mime: "image/gif",
      positive: minimalGif(),
      header: Buffer.concat([minimalGif().subarray(0, 19), Buffer.from([0x3b])]),
      illegal: changed(minimalGif(), (b) => b.writeUInt16LE(0, 24)),
      missing: gifWithoutImageData(),
    },
    {
      mime: "image/webp",
      positive: losslessWebp(),
      header: vp8xOnlyWebp(),
      illegal: changed(losslessWebp(), (b) => {
        b[24] = b[24]! | 0xe0;
      }),
      missing: wrapWebpChunks(Buffer.from("VP8L\x05\0\0\0\x2f\0\0\0\0\0", "latin1")),
    },
    {
      mime: "video/mp4",
      positive: realMp4(),
      header: ftypOnlyMp4(),
      illegal: changed(realMp4(), (b) => b.writeUInt16BE(0, b.indexOf("stsd") + 44)),
      missing: changed(realMp4(), (b) => {
        b.write("free", b.indexOf("mdat"));
      }),
    },
    {
      mime: "video/webm",
      positive: realWebm(),
      header: realWebm().subarray(0, 36),
      illegal: changed(realWebm(), (b) => {
        b[b.indexOf(Buffer.from("b08110", "hex")) + 2] = 0;
      }),
      missing: webmWithoutFrames(),
    },
    {
      mime: "audio/mpeg",
      positive: cbrMp3NoTag(),
      header: cbrMp3NoTag().subarray(0, 4),
      illegal: changed(cbrMp3NoTag(), (b) => {
        b[2] = b[2]! | 0x0c;
      }),
      missing: Buffer.from("49443304000000000000", "hex"),
    },
    {
      mime: "audio/wav",
      positive: minimalWav(),
      header: emptyFormatWav(),
      illegal: changed(minimalWav(), (b) => b.writeUInt32LE(0, 24)),
      missing: changed(minimalWav().subarray(0, 44), (b) => {
        b.writeUInt32LE(36, 4);
        b.writeUInt32LE(0, 40);
      }),
    },
    {
      mime: "audio/ogg",
      positive: minimalOgg(),
      header: identificationOnlyOgg(),
      illegal: changed(minimalOgg(), (b) => {
        b[39] = 0;
        oggCrc(b, 0, 58);
      }),
      missing: oggWithoutMedia(),
    },
    {
      mime: "application/pdf",
      positive: minimalPdf(),
      header: Buffer.from("%PDF-1.3\n"),
      illegal: Buffer.from(
        minimalPdf().toString("latin1").replace("595.2756", "0.000000"),
        "latin1",
      ),
      missing: Buffer.from(
        minimalPdf()
          .toString("latin1")
          .replace("/Count 1", "/Count 0")
          .replace("[ 3 0 R ]", "[       ]"),
        "latin1",
      ),
    },
  ];
  return cases.map(({ mime, positive, header, illegal, missing }) => ({
    mime,
    positive,
    invalid: [
      {
        kind: "truncated",
        bytes: positive.subarray(0, positive.length - (mime === "application/pdf" ? 6 : 1)),
      },
      { kind: "header only", bytes: header },
      { kind: "illegal field", bytes: illegal },
      { kind: "missing data unit", bytes: missing },
    ],
  }));
}

/** FFmpeg libopus, 48kHz mono, 40ms silence; real audio-only WebM. */
export function audioWebm(): Buffer {
  return Buffer.from(
    "GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQRChYECGFOAZwEAAAAAAAIGEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHYTbuMU6uEElTDZ1OsggFCTbuMU6uEHFO7a1OsggHw7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsirXsYMPQkBNgI1MYXZmNjAuMTYuMTAwV0GNTGF2ZjYwLjE2LjEwMESJiEBIAAAAAAAAFlSua+WuAQAAAAAAAFzXgQFzxYhAqlI1c0b035yBACK1nIN1bmSIgQCGhkFfT1BVU1aqg2MuoFa7hATEtACDgQLhkZ+BAbWIQOdwAAAAAABiZIEQY6KTT3B1c0hlYWQBATgBgLsAAAAAABJUw2f9c3OgY8CAZ8iaRaOHRU5DT0RFUkSHjUxhdmY2MC4xNi4xMDBzc9djwItjxYhAqlI1c0b032fIokWjh0VOQ09ERVJEh5VMYXZjNjAuMzEuMTAyIGxpYm9wdXNnyKFFo4hEVVJBVElPTkSHkzAwOjAwOjAwLjA0ODAwMDAwMAAfQ7Z1p+eBAKOHgQAAgPj//qOHgQAVgPj//qCQoYeBACkA+P/+daKEAM3+YBxTu2uRu4+zgQC3iveBAfGCAcTwgQM=",
    "base64",
  );
}

/** Pillow indexed-color PNG with PLTE. */
export function indexedPng(): Buffer {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACAQMAAABIeJ9nAAAAA1BMVEUAAACnej3aAAAADElEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC",
    "base64",
  );
}

/** FFmpeg stream-copy of realMp4; fragmented sample addressing. */
export function fragmentedMp4(): Buffer {
  return Buffer.from(
    "AAAAHGZ0eXBpc281AAACAGlzbzVpc282bXA0MQAAAvltb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAAAAAAABAAABAAAAAAAA" +
      "AAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAB+3Ry" +
      "YWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAA" +
      "AAAAAAAAAEAAAAAAQAAAADAAAAAAAZdtZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAACgAAAAAAFXEAAAAAAAtaGRscgAAAAAAAAAA" +
      "dmlkZQAAAAAAAAAAAAAAAFZpZGVvSGFuZGxlcgAAAAFCbWluZgAAABR2bWhkAAAAAQAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAA" +
      "AAAAAAABAAAADHVybCAAAAABAAABAnN0YmwAAAC2c3RzZAAAAAAAAAABAAAApmF2YzEAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAA" +
      "QAAwAEgAAABIAAAAAAAAAAEVTGF2YzYwLjMxLjEwMiBsaWJ4MjY0AAAAAAAAAAAAAAAY//8AAAAsYXZjQwFCwAr/4QAVZ0LACtoR" +
      "7ARAAAADAEAAAAUDxImoAQAEaM4PyAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAATkFAAE5BQAAABBzdHRzAAAAAAAAAAAA" +
      "AAAQc3RzYwAAAAAAAAAAAAAAFHN0c3oAAAAAAAAAAAAAAAAAAAAQc3RjbwAAAAAAAAAAAAAAKG12ZXgAAAAgdHJleAAAAAAAAAAB" +
      "AAAAAQAAAAAAAAAAAAAAAAAAAGJ1ZHRhAAAAWm1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALWls" +
      "c3QAAAAlqXRvbwAAAB1kYXRhAAAAAQAAAABMYXZmNjAuMTYuMTAwAAAAdG1vb2YAAAAQbWZoZAAAAAAAAAABAAAAXHRyYWYAAAAc" +
      "dGZoZAACADgAAAABAAAEAAAABr0BAQAAAAAAFHRmZHQBAAAAAAAAAAAAAAAAAAAkdHJ1bgAAAgUAAAADAAAAfAIAAAAAAAa9AAAD" +
      "LAAAAdQAAAvFbWRhdAAAAlQGBf//UNxF6b3m2Ui3lizYINkj7u94MjY0IC0gY29yZSAxNjQgcjMxMDggMzFlMTlmOSAtIEguMjY0" +
      "L01QRUctNCBBVkMgY29kZWMgLSBDb3B5bGVmdCAyMDAzLTIwMjMgLSBodHRwOi8vd3d3LnZpZGVvbGFuLm9yZy94MjY0Lmh0bWwg" +
      "LSBvcHRpb25zOiBjYWJhYz0wIHJlZj0xIGRlYmxvY2s9MDowOjAgYW5hbHlzZT0wOjAgbWU9ZGlhIHN1Ym1lPTAgcHN5PTEgcHN5" +
      "X3JkPTEuMDA6MC4wMCBtaXhlZF9yZWY9MCBtZV9yYW5nZT0xNiBjaHJvbWFfbWU9MSB0cmVsbGlzPTAgOHg4ZGN0PTAgY3FtPTAg" +
      "ZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tpcD0xIGNocm9tYV9xcF9vZmZzZXQ9MCB0aHJlYWRzPTEgbG9va2FoZWFkX3RocmVhZHM9" +
      "MSBzbGljZWRfdGhyZWFkcz0wIG5yPTAgZGVjaW1hdGU9MSBpbnRlcmxhY2VkPTAgYmx1cmF5X2NvbXBhdD0wIGNvbnN0cmFpbmVk" +
      "X2ludHJhPTAgYmZyYW1lcz0wIHdlaWdodHA9MCBrZXlpbnQ9MjUwIGtleWludF9taW49MTAgc2NlbmVjdXQ9MCBpbnRyYV9yZWZy" +
      "ZXNoPTAgcmM9Y3JmIG1idHJlZT0wIGNyZj0yMy4wIHFjb21wPTAuNjAgcXBtaW49MCBxcG1heD02OSBxcHN0ZXA9NCBpcF9yYXRp" +
      "bz0xLjQwIGFxPTAAgAAABGFliIQ6DGAAgAAgBCXQNoLrFjeRREegGIw/AA82arf0BMNN/YADzZqt/QEw039uezM2N+p1d+AFgBKA" +
      "F1A4gk+B165gNJmiT9QXTTf2DDhAAHAFWoIAAQNQABAYDCsAHoOo1gkHiZQG4t5ns2zgAWA5AEjCzesFzCxQoCoTGMRhncopTnBj" +
      "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" +
      "cm8AAAAAAAAAQw==",
    "base64",
  );
}

/** FFmpeg stream-copy of realMp4; fragmented-absolute sample addressing. */
export function absoluteFragmentedMp4(): Buffer {
  return Buffer.from(
    "AAAAJGZ0eXBpc29tAAACAGlzb21pc282aXNvMmF2YzFtcDQxAAAC+W1vb3YAAABsbXZoZAAAAAAAAAAAAAAAAAAAA+gAAAAAAAEA" +
      "AAEAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
      "AAIAAAH7dHJhawAAAFx0a2hkAAAAAwAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAA" +
      "AQAAAAAAAAAAAAAAAAAAQAAAAABAAAAAMAAAAAABl21kaWEAAAAgbWRoZAAAAAAAAAAAAAAAAAAAKAAAAAAAVcQAAAAAAC1oZGxy" +
      "AAAAAAAAAAB2aWRlAAAAAAAAAAAAAAAAVmlkZW9IYW5kbGVyAAAAAUJtaW5mAAAAFHZtaGQAAAABAAAAAAAAAAAAAAAkZGluZgAA" +
      "ABxkcmVmAAAAAAAAAAEAAAAMdXJsIAAAAAEAAAECc3RibAAAALZzdHNkAAAAAAAAAAEAAACmYXZjMQAAAAAAAAABAAAAAAAAAAAA" +
      "AAAAAAAAAABAADAASAAAAEgAAAAAAAAAARVMYXZjNjAuMzEuMTAyIGxpYngyNjQAAAAAAAAAAAAAABj//wAAACxhdmNDAULACv/h" +
      "ABVnQsAK2hHsBEAAAAMAQAAABQPEiagBAARozg/IAAAAEHBhc3AAAAABAAAAAQAAABRidHJ0AAAAAAABOQUAATkFAAAAEHN0dHMA" +
      "AAAAAAAAAAAAABBzdHNjAAAAAAAAAAAAAAAUc3RzegAAAAAAAAAAAAAAAAAAABBzdGNvAAAAAAAAAAAAAAAobXZleAAAACB0cmV4" +
      "AAAAAAAAAAEAAAABAAAAAAAAAAAAAAAAAAAAYnVkdGEAAABabWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAA" +
      "AAAAAAAtaWxzdAAAACWpdG9vAAAAHWRhdGEAAAABAAAAAExhdmY2MC4xNi4xMDAAAAB8bW9vZgAAABBtZmhkAAAAAAAAAAEAAABk" +
      "dHJhZgAAACR0ZmhkAAAAOQAAAAEAAAAAAAADHQAABAAAAAa9AQEAAAAAABR0ZmR0AQAAAAAAAAAAAAAAAAAAJHRydW4AAAIFAAAA" +
      "AwAAAIQCAAAAAAAGvQAAAywAAAHUAAALxW1kYXQAAAJUBgX//1DcRem95tlIt5Ys2CDZI+7veDI2NCAtIGNvcmUgMTY0IHIzMTA4" +
      "IDMxZTE5ZjkgLSBILjI2NC9NUEVHLTQgQVZDIGNvZGVjIC0gQ29weWxlZnQgMjAwMy0yMDIzIC0gaHR0cDovL3d3dy52aWRlb2xh" +
      "bi5vcmcveDI2NC5odG1sIC0gb3B0aW9uczogY2FiYWM9MCByZWY9MSBkZWJsb2NrPTA6MDowIGFuYWx5c2U9MDowIG1lPWRpYSBz" +
      "dWJtZT0wIHBzeT0xIHBzeV9yZD0xLjAwOjAuMDAgbWl4ZWRfcmVmPTAgbWVfcmFuZ2U9MTYgY2hyb21hX21lPTEgdHJlbGxpcz0w" +
      "IDh4OGRjdD0wIGNxbT0wIGRlYWR6b25lPTIxLDExIGZhc3RfcHNraXA9MSBjaHJvbWFfcXBfb2Zmc2V0PTAgdGhyZWFkcz0xIGxv" +
      "b2thaGVhZF90aHJlYWRzPTEgc2xpY2VkX3RocmVhZHM9MCBucj0wIGRlY2ltYXRlPTEgaW50ZXJsYWNlZD0wIGJsdXJheV9jb21w" +
      "YXQ9MCBjb25zdHJhaW5lZF9pbnRyYT0wIGJmcmFtZXM9MCB3ZWlnaHRwPTAga2V5aW50PTI1MCBrZXlpbnRfbWluPTEwIHNjZW5l" +
      "Y3V0PTAgaW50cmFfcmVmcmVzaD0wIHJjPWNyZiBtYnRyZWU9MCBjcmY9MjMuMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9Njkg" +
      "cXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0wAIAAAARhZYiEOgxgAIAAIAQl0DaC6xY3kURHoBiMPwAPNmq39ATDTf2AA82arf0B" +
      "MNN/bnszNjfqdXfgBYASgBdQOIJPgdeuYDSZok/UF0039gw4QABwBVqCAAEDUAAQGAwrAB6DqNYJB4mUBuLeZ7Ns4AFgOQBIws3r" +
      "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" +
      "AAAAAAADHQEBAQAAABBtZnJvAAAAAAAAAEM=",
    "base64",
  );
}

/** FFmpeg stream-copy of realMp4; hybrid sample addressing. */
export function hybridMp4(): Buffer {
  return Buffer.from(
    "AAAAJGZ0eXBpc29tAAACAGlzb21pc282aXNvMmF2YzFtcDQxAAADEW1vb3YAAABsbXZoZAAAAAAAAAAAAAAAAAAAA+gAAABkAAEA" +
      "AAEAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
      "AAIAAAITdHJhawAAAFx0a2hkAAAAAwAAAAAAAAAAAAAAAQAAAAAAAABkAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAA" +
      "AQAAAAAAAAAAAAAAAAAAQAAAAABAAAAAMAAAAAABr21kaWEAAAAgbWRoZAAAAAAAAAAAAAAAAAAAKAAAAAQAVcQAAAAAAC1oZGxy" +
      "AAAAAAAAAAB2aWRlAAAAAAAAAAAAAAAAVmlkZW9IYW5kbGVyAAAAAVptaW5mAAAAFHZtaGQAAAABAAAAAAAAAAAAAAAkZGluZgAA" +
      "ABxkcmVmAAAAAAAAAAEAAAAMdXJsIAAAAAEAAAEac3RibAAAALZzdHNkAAAAAAAAAAEAAACmYXZjMQAAAAAAAAABAAAAAAAAAAAA" +
      "AAAAAAAAAABAADAASAAAAEgAAAAAAAAAARVMYXZjNjAuMzEuMTAyIGxpYngyNjQAAAAAAAAAAAAAABj//wAAACxhdmNDAULACv/h" +
      "ABVnQsAK2hHsBEAAAAMAQAAABQPEiagBAARozg/IAAAAEHBhc3AAAAABAAAAAQAAABRidHJ0AAAAAAACGxAAAhsQAAAAGHN0dHMA" +
      "AAAAAAAAAQAAAAEAAAQAAAAAHHN0c2MAAAAAAAAAAQAAAAEAAAABAAAAAQAAABRzdHN6AAAAAAAABr0AAAABAAAAFHN0Y28AAAAA" +
      "AAAAAQAAAz0AAAAobXZleAAAACB0cmV4AAAAAAAAAAEAAAABAAAAAAAAAAAAAAAAAAAAYnVkdGEAAABabWV0YQAAAAAAAAAhaGRs" +
      "cgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAtaWxzdAAAACWpdG9vAAAAHWRhdGEAAAABAAAAAExhdmY2MC4xNi4xMDAAAAbF" +
      "bWRhdAAAAlQGBf//UNxF6b3m2Ui3lizYINkj7u94MjY0IC0gY29yZSAxNjQgcjMxMDggMzFlMTlmOSAtIEguMjY0L01QRUctNCBB" +
      "VkMgY29kZWMgLSBDb3B5bGVmdCAyMDAzLTIwMjMgLSBodHRwOi8vd3d3LnZpZGVvbGFuLm9yZy94MjY0Lmh0bWwgLSBvcHRpb25z" +
      "OiBjYWJhYz0wIHJlZj0xIGRlYmxvY2s9MDowOjAgYW5hbHlzZT0wOjAgbWU9ZGlhIHN1Ym1lPTAgcHN5PTEgcHN5X3JkPTEuMDA6" +
      "MC4wMCBtaXhlZF9yZWY9MCBtZV9yYW5nZT0xNiBjaHJvbWFfbWU9MSB0cmVsbGlzPTAgOHg4ZGN0PTAgY3FtPTAgZGVhZHpvbmU9" +
      "MjEsMTEgZmFzdF9wc2tpcD0xIGNocm9tYV9xcF9vZmZzZXQ9MCB0aHJlYWRzPTEgbG9va2FoZWFkX3RocmVhZHM9MSBzbGljZWRf" +
      "dGhyZWFkcz0wIG5yPTAgZGVjaW1hdGU9MSBpbnRlcmxhY2VkPTAgYmx1cmF5X2NvbXBhdD0wIGNvbnN0cmFpbmVkX2ludHJhPTAg" +
      "YmZyYW1lcz0wIHdlaWdodHA9MCBrZXlpbnQ9MjUwIGtleWludF9taW49MTAgc2NlbmVjdXQ9MCBpbnRyYV9yZWZyZXNoPTAgcmM9" +
      "Y3JmIG1idHJlZT0wIGNyZj0yMy4wIHFjb21wPTAuNjAgcXBtaW49MCBxcG1heD02OSBxcHN0ZXA9NCBpcF9yYXRpbz0xLjQwIGFx" +
      "PTAAgAAABGFliIQ6DGAAgAAgBCXQNoLrFjeRREegGIw/AA82arf0BMNN/YADzZqt/QEw039uezM2N+p1d+AFgBKAF1A4gk+B165g" +
      "NJmiT9QXTTf2DDhAAHAFWoIAAQNQABAYDCsAHoOo1gkHiZQG4t5ns2zgAWA5AEjCzesFzCxQoCoTGMRhncopTnBj/GqqqAAEIIAA" +
      "RYaNvqChCfmDD//hIAEABQABAmCQABA7AAEEYAAQmueZjXlL3F9KQw/GZjK6it1JKWtDDhjBwABB+AAEmD/ABEbTtbR//BwABANA" +
      "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" +
      "AAAAAAAADZoBAQEAAAAQbWZybwAAAAAAAABW",
    "base64",
  );
}

/** Rewrite bounded fixture boxes, preserving ancestors' lengths. mdat precedes moov. */
function editMp4Boxes(bytes: Buffer, edit: (type: string, box: Buffer) => Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let at = 0; at < bytes.length; ) {
    const size = bytes.readUInt32BE(at);
    if (size < 8 || size > bytes.length - at) throw new Error("bad fixture box");
    const type = bytes.toString("latin1", at + 4, at + 8);
    let box: Buffer = Buffer.from(bytes.subarray(at, at + size));
    if (["moov", "trak", "mdia", "minf", "stbl", "mvex", "moof", "traf", "dinf"].includes(type)) {
      box = mp4FixtureBox(type, editMp4Boxes(box.subarray(8), edit));
    }
    parts.push(edit(type, box));
    at += size;
  }
  return Buffer.concat(parts);
}

function mp4FixtureBox(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(payload.length + 8);
  header.write(type, 4, "latin1");
  return Buffer.concat([header, payload]);
}

function mp4Words(...values: number[]): Buffer {
  const result = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => {
    result.writeUInt32BE(value, index * 4);
  });
  return result;
}

/** Preserve payloads and lengths; only one byte of a required binary ID changes. */
export function invalidMediaIdentifiers(): { kind: string; mime: string; bytes: Buffer }[] {
  return (
    [
      ["MP4 stsz", "video/mp4", realMp4, "stsz"],
      ["MP4 stco", "video/mp4", realMp4, "stco"],
      ["MP4 moov", "video/mp4", realMp4, "moov"],
      ["MP4 trun", "video/mp4", fragmentedMp4, "trun"],
      ["WebP still VP8", "image/webp", minimalWebp, "VP8 "],
      ["WebP animated VP8", "image/webp", animatedWebp, "VP8 "],
      ["WAV fmt", "audio/wav", minimalWav, "fmt "],
      ["WAV data", "audio/wav", minimalWav, "data"],
    ] as const
  ).flatMap(([kind, mime, fixture, id]) =>
    Array.from({ length: 4 }, (_, byte) => {
      const bytes = fixture();
      const offset = bytes.indexOf(Buffer.from(id, "latin1"));
      if (offset < 0) throw new Error(`missing fixture identifier: ${kind}`);
      bytes[offset + byte] = bytes[offset + byte]! | 0x80;
      return { kind: `${kind} high bit in byte ${byte}`, mime, bytes };
    }),
  );
}

/** An unknown sibling must not alias the genuine singleton sample-size table. */
export function mp4WithLookalikeExtraBoxes(): { kind: string; bytes: Buffer }[] {
  return Array.from({ length: 4 }, (_, byte) => ({
    kind: `unknown stsz look-alike in byte ${byte} alongside genuine stsz`,
    bytes: editMp4Boxes(realMp4(), (type, box) => {
      if (type !== "stsz") return box;
      const extra = Buffer.from(box);
      extra[4 + byte] = extra[4 + byte]! | 0x80;
      // mdat precedes moov, so growing the table's ancestors moves no samples.
      return Buffer.concat([box, extra]);
    }),
  }));
}

/** Same real encoded samples, one chunk in each mdat, co64 or compact size tables. */
export function mp4TableVariants(): { kind: string; bytes: Buffer }[] {
  const src = realMp4();
  const p = src.indexOf("stsz");
  const sizes = [0, 1, 2].map((i) => src.readUInt32BE(p + 16 + i * 4));
  const start = src.indexOf("mdat") + 4;
  const offsets = [start, start + sizes[0]! + 8, start + sizes[0]! + sizes[1]! + 16];
  const split = editMp4Boxes(src, (type, box) => {
    if (type === "stsc") return mp4FixtureBox(type, mp4Words(0, 1, 1, 1, 1));
    if (type === "stco") return mp4FixtureBox(type, mp4Words(0, 3, ...offsets));
    if (type !== "mdat") return box;
    let at = 8;
    return Buffer.concat(
      sizes.map((size) => {
        const data = mp4FixtureBox("mdat", box.subarray(at, at + size));
        at += size;
        return data;
      }),
    );
  });
  const co64 = editMp4Boxes(split, (type, box) => {
    if (type !== "stco") return box;
    const payload = Buffer.alloc(32);
    payload.writeUInt32BE(3, 4);
    offsets.forEach((offset, i) => {
      payload.writeBigUInt64BE(BigInt(offset), 8 + i * 8);
    });
    return mp4FixtureBox("co64", payload);
  });
  const compact = editMp4Boxes(src, (type, box) => {
    if (type !== "stsz") return box;
    const payload = Buffer.alloc(18);
    payload[7] = 16;
    payload.writeUInt32BE(3, 8);
    sizes.forEach((size, i) => {
      payload.writeUInt16BE(size, 12 + i * 2);
    });
    return mp4FixtureBox("stz2", payload);
  });
  const fixed = editMp4Boxes(src, (type, box) => {
    if (type === "stsz") return mp4FixtureBox(type, mp4Words(0, sizes[0]!, 3));
    if (type === "mdat")
      return mp4FixtureBox(
        type,
        Buffer.concat(Array.from({ length: 3 }, () => src.subarray(start, start + sizes[0]!))),
      );
    if (type === "stss") return mp4FixtureBox(type, mp4Words(0, 3, 1, 2, 3));
    return box;
  });
  const small = [4, 8].map((bits) => ({
    kind: `${bits}-bit compact sample sizes`,
    bytes: editMp4Boxes(pcmSampleMp4(), (type, box) => {
      if (type !== "stsz") return box;
      const count = box.readUInt32BE(16);
      const payload = Buffer.alloc(12 + Math.ceil((count * bits) / 8));
      payload[7] = bits;
      payload.writeUInt32BE(count, 8);
      payload.fill(bits === 4 ? 0x22 : 2, 12);
      return mp4FixtureBox("stz2", payload);
    }),
  }));
  const twoTracks = editMp4Boxes(src, (type, box) => {
    if (type !== "trak") return box;
    const second = Buffer.from(box);
    second.writeUInt32BE(2, second.indexOf("tkhd") + 16);
    return Buffer.concat([box, second]);
  });
  return [
    { kind: "multiple mdat/chunks", bytes: split },
    { kind: "64-bit chunk offsets", bytes: co64 },
    { kind: "16-bit compact sample sizes", bytes: compact },
    { kind: "fixed sample sizes", bytes: fixed },
    { kind: "two tracks", bytes: twoTracks },
    ...small,
  ];
}

/** Real H.264 samples with implicit run continuation and inherited size variants. */
export function mp4FragmentVariants(): { kind: string; bytes: Buffer }[] {
  const src = fragmentedMp4();
  const setRunOffset = (bytes: Buffer) => {
    const moof = bytes.indexOf("moof") - 4;
    bytes.writeInt32BE(bytes.readUInt32BE(moof) + 8, bytes.indexOf("trun") + 12);
    return bytes;
  };
  const split = setRunOffset(
    editMp4Boxes(src, (type, box) => {
      if (type === "tfhd") box.writeUInt32BE(box.readUInt32BE(8) & ~0x020000, 8);
      if (type !== "trun") return box;
      return Buffer.concat([
        mp4FixtureBox(type, mp4Words(0x205, 1, 0, 0x02000000, box.readUInt32BE(24))),
        mp4FixtureBox(type, mp4Words(0x200, 2, box.readUInt32BE(28), box.readUInt32BE(32))),
      ]);
    }),
  );
  const fixed = setRunOffset(
    editMp4Boxes(src, (type, box) => {
      if (type === "trun") return mp4FixtureBox(type, mp4Words(5, 3, 0, 0x02000000));
      if (type === "mdat")
        return mp4FixtureBox(
          type,
          Buffer.concat(Array.from({ length: 3 }, () => box.subarray(8, 8 + 1725))),
        );
      return box;
    }),
  );
  const trex = setRunOffset(
    editMp4Boxes(fixed, (type, box) => {
      if (type === "trex") box.writeUInt32BE(1725, 24);
      if (type !== "tfhd") return box;
      const payload = Buffer.concat([box.subarray(8, 20), box.subarray(24)]);
      payload.writeUInt32BE(payload.readUInt32BE(0) & ~16);
      return mp4FixtureBox(type, payload);
    }),
  );
  const explicitBase = absoluteFragmentedMp4();
  const tfhd = explicitBase.indexOf("tfhd");
  explicitBase.writeUInt32BE(explicitBase.readUInt32BE(tfhd + 4) | 0x020000, tfhd + 4);
  return [
    { kind: "implicit base and later run continuation", bytes: split },
    { kind: "tfhd default sample sizes", bytes: fixed },
    { kind: "trex default sample sizes", bytes: trex },
    { kind: "explicit base takes precedence", bytes: explicitBase },
  ];
}

/** Container/reference failures, preserving outer box lengths unless explicitly shortened. */
export function invalidMp4References(): { kind: string; bytes: Buffer }[] {
  const cases: { kind: string; bytes: Buffer }[] = [];
  const changed = (kind: string, source: Buffer, mutate: (bytes: Buffer) => void) => {
    const bytes = Buffer.from(source);
    mutate(bytes);
    cases.push({ kind, bytes });
  };
  const src = realMp4();
  changed("stco beyond EOF", src, (b) => b.writeUInt32BE(0xfffffff0, b.indexOf("stco") + 12));
  changed("stco in box header", src, (b) =>
    b.writeUInt32BE(b.indexOf("mdat"), b.indexOf("stco") + 12),
  );
  changed("stco in metadata", src, (b) =>
    b.writeUInt32BE(b.indexOf("moov") + 4, b.indexOf("stco") + 12),
  );
  for (const name of ["stsz", "stsc", "stco", "stts", "dref"])
    changed(`missing ${name}`, src, (b) => b.write("free", b.indexOf(name)));
  for (const [name, offset, value] of [
    ["stsz", 12, 0xffffffff],
    ["stsz", 16, 0xffffffff],
    ["stsz", 16, 0],
    ["stsc", 12, 0],
    ["stsc", 12, 2],
    ["stsc", 16, 2],
    ["stsc", 16, 4],
    ["stsc", 20, 2],
    ["stts", 12, 2],
    ["stss", 12, 4],
    ["stco", 8, 0xffffffff],
    ["url ", 4, 0],
  ] as const)
    changed(`${name} field ${offset}=${value}`, src, (b) =>
      b.writeUInt32BE(value, b.indexOf(name) + offset),
    );
  cases.push({
    kind: "one-byte mdat",
    bytes: editMp4Boxes(src, (type, box) =>
      type === "mdat" ? mp4FixtureBox(type, box.subarray(8, 9)) : box,
    ),
  });
  for (const name of ["stsz", "stco", "stsc", "stsd", "stts", "trak"])
    cases.push({
      kind: `duplicate ${name}`,
      bytes: editMp4Boxes(src, (type, box) => (type === name ? Buffer.concat([box, box]) : box)),
    });
  const variants = mp4TableVariants();
  const co64 = variants[1]!.bytes;
  changed("co64 unsafe integer", co64, (b) =>
    b.writeBigUInt64BE(2n ** 63n, b.indexOf("co64") + 12),
  );
  changed("later chunk outside mdat", co64, (b) =>
    b.writeBigUInt64BE(BigInt(b.length), b.indexOf("co64") + 28),
  );
  changed("second track bad offset", variants[4]!.bytes, (b) =>
    b.writeUInt32BE(0xfffffff0, b.lastIndexOf("stco") + 12),
  );
  changed("fixed size overflow", variants[3]!.bytes, (b) =>
    b.writeUInt32BE(0xffffffff, b.indexOf("stsz") + 8),
  );
  for (const variant of variants.slice(5)) {
    changed(`${variant.kind} bad last sample`, variant.bytes, (b) => {
      b[b.indexOf("stz2") - 4 + b.readUInt32BE(b.indexOf("stz2") - 4) - 1] = 255;
    });
  }
  const compact = variants[2]!.bytes;
  changed("stz2 invalid width", compact, (b) => {
    b[b.indexOf("stz2") + 11] = 7;
  });
  changed("stz2 oversized last sample", compact, (b) =>
    b.writeUInt16BE(65535, b.indexOf("stz2") + 20),
  );
  const fragmentVariants = mp4FragmentVariants();
  changed("later implicit run oversized", fragmentVariants[0]!.bytes, (b) =>
    b.writeUInt32BE(0xffffffff, b.lastIndexOf("trun") + 16),
  );
  changed("tfhd inherited size oversized", fragmentVariants[1]!.bytes, (b) =>
    b.writeUInt32BE(0xffffffff, b.indexOf("tfhd") + 16),
  );
  changed("trex inherited size oversized", fragmentVariants[2]!.bytes, (b) =>
    b.writeUInt32BE(0xffffffff, b.indexOf("trex") + 20),
  );
  changed("zero-stride run count overflow", fragmentVariants[1]!.bytes, (b) =>
    b.writeUInt32BE(0xffffffff, b.indexOf("trun") + 8),
  );
  const fragment = fragmentedMp4();
  for (const name of ["tfhd", "trex", "trun", "mfhd"])
    changed(`missing ${name}`, fragment, (b) => b.write("free", b.indexOf(name)));
  changed("trun offset beyond EOF", fragment, (b) =>
    b.writeInt32BE(0x7fffffff, b.indexOf("trun") + 12),
  );
  changed("trun negative offset", fragment, (b) =>
    b.writeInt32BE(-0x7fffffff, b.indexOf("trun") + 12),
  );
  changed("trun oversized last sample", fragment, (b) =>
    b.writeUInt32BE(0xffffffff, b.indexOf("trun") + 28),
  );
  changed("trun oversized count", fragment, (b) =>
    b.writeUInt32BE(0xffffffff, b.indexOf("trun") + 8),
  );
  changed("tfhd undeclared track", fragment, (b) => b.writeUInt32BE(99, b.indexOf("tfhd") + 8));
  changed("trex bad description", fragment, (b) => b.writeUInt32BE(99, b.indexOf("trex") + 12));
  for (const name of ["tfhd", "trex"])
    cases.push({
      kind: `duplicate ${name}`,
      bytes: editMp4Boxes(fragment, (type, box) =>
        type === name ? Buffer.concat([box, box]) : box,
      ),
    });
  changed("tfhd unsafe base", absoluteFragmentedMp4(), (b) =>
    b.writeBigUInt64BE(2n ** 63n, b.indexOf("tfhd") + 12),
  );
  changed("hybrid later run beyond EOF", hybridMp4(), (b) =>
    b.writeInt32BE(0x7fffffff, b.lastIndexOf("trun") + 12),
  );
  return cases;
}

/** FFmpeg 16 mono PCM s16 samples in ISO-BMFF/QuickTime (two bytes/sample). */
function pcmSampleMp4(): Buffer {
  return Buffer.from(
    "AAAAFGZ0eXBxdCAgAAACAHF0ICAAAAAId2lkZQAAAChtZGF0AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKKbW9v" +
      "dgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAAAIAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAA" +
      "AABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAfV0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAAAIA" +
      "AAAAAAAAAAAAAAEBAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAkZWR0cwAAABxlbHN0" +
      "AAAAAAAAAAEAAAACAAAAAAABAAAAAAFtbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAfQAAAABB//wAAAAAALWhkbHIAAAAAbWhs" +
      "cnNvdW4AAAAAAAAAAAAAAAAMU291bmRIYW5kbGVyAAABGG1pbmYAAAAQc21oZAAAAAAAAAAAAAAALGhkbHIAAAAAZGhscnVybCAA" +
      "AAAAAAAAAAAAAAALRGF0YUhhbmRsZXIAAAAkZGluZgAAABxkcmVmAAAAAAAAAAEAAAAMdXJsIAAAAAEAAACwc3RibAAAAExzdHNk" +
      "AAAAAAAAAAEAAAA8c293dAAAAAAAAAABAAAAAAAAAAAAAQAQAAAAAB9AAAAAAAAYY2hhbgAAAAAAZAABAAAAAAAAAAAAAAAYc3R0" +
      "cwAAAAAAAAABAAAAEAAAAAEAAAAcc3RzYwAAAAAAAAABAAAAAQAAABAAAAABAAAAFHN0c3oAAAAAAAAAAgAAABAAAAAUc3RjbwAA" +
      "AAAAAAABAAAAJAAAACF1ZHRhAAAAGalzd3IADVXETGF2ZjYwLjE2LjEwMA==",
    "base64",
  );
}

/** Classic objects with an optional final object in a Flate ObjStm. All offsets
 * and xref records are regenerated, so budget probes remain structurally valid.
 */
export function structuralPdf(objects: string[], compressedLast = false): Buffer {
  const parts: Buffer[] = [Buffer.from("%PDF-1.5\n")];
  const offsets = [0];
  let length = parts[0]!.length;
  const append = (part: Buffer) => {
    parts.push(part);
    length += part.length;
  };
  const directCount = objects.length - (compressedLast ? 1 : 0);
  for (let i = 0; i < directCount; i++) {
    offsets.push(length);
    append(Buffer.from(`${i + 1} 0 obj\n${objects[i]}\nendobj\n`, "latin1"));
  }
  if (!compressedLast) {
    const xref = length;
    append(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`));
    for (const offset of offsets.slice(1))
      append(Buffer.from(`${String(offset).padStart(10, "0")} 00000 n \n`));
    append(
      Buffer.from(
        `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
      ),
    );
  } else {
    const object = objects.length;
    const stream = object + 1;
    const xrefObject = stream + 1;
    const header = `${object} 0 `;
    const data = deflateSync(Buffer.from(header + objects.at(-1), "latin1"));
    const streamOffset = length;
    append(
      Buffer.from(
        `${stream} 0 obj\n<< /Type /ObjStm /N 1 /First ${header.length} /Length ${data.length} /Filter /FlateDecode >>\nstream\n`,
      ),
    );
    append(data);
    append(Buffer.from("\nendstream\nendobj\n"));
    const xref = length;
    const rows = Buffer.alloc((xrefObject + 1) * 7);
    rows.writeUInt16BE(65535, 5);
    for (let id = 1; id <= xrefObject; id++) {
      rows[id * 7] = id === object ? 2 : 1;
      rows.writeUInt32BE(
        id === object
          ? stream
          : id === stream
            ? streamOffset
            : id === xrefObject
              ? xref
              : offsets[id]!,
        id * 7 + 1,
      );
    }
    append(
      Buffer.from(
        `${xrefObject} 0 obj\n<< /Type /XRef /Size ${xrefObject + 1} /Root 1 0 R /W [1 4 2] /Length ${rows.length} >>\nstream\n`,
      ),
    );
    append(rows);
    append(Buffer.from(`\nendstream\nendobj\nstartxref\n${xref}\n%%EOF\n`));
  }
  return Buffer.concat(parts);
}

type PdfRevisionObject = {
  object: number;
  value: string | null;
  generation?: number;
  compressed?: boolean;
};

/** Append only changed entries, with regenerated offsets and a real /Prev chain. */
function appendPdfRevision(
  bytes: Buffer,
  changes: PdfRevisionObject[],
  encoding: "classic" | "stream" | "hybrid",
): Buffer {
  const original = bytes.toString("latin1");
  const previous = Number([...original.matchAll(/startxref\n(\d+)/g)].at(-1)![1]);
  const next = Math.max(
    ...[...original.matchAll(/\/Size (\d+)/g)].map((m) => Number(m[1])),
    ...changes.map((change) => change.object + 1),
  );
  const parts = [bytes];
  let length = bytes.length;
  const append = (part: Buffer) => {
    parts.push(part);
    length += part.length;
  };
  const entries = new Map<number, [number, number, number]>();
  entries.set(0, [0, changes.find((change) => change.value === null)?.object ?? 0, 65535]);
  const compressed = changes.filter((change) => change.compressed);
  for (const { object, value, generation = 0, compressed } of changes) {
    if (compressed) continue;
    entries.set(object, [value === null ? 0 : 1, value === null ? 0 : length, generation]);
    if (value !== null)
      append(Buffer.from(`${object} ${generation} obj\n${value}\nendobj\n`, "latin1"));
  }
  if (compressed.length) {
    let header = "";
    let values = "";
    for (const [index, change] of compressed.entries()) {
      entries.set(change.object, [2, next, index]);
      header += `${change.object} ${values.length} `;
      values += `${change.value}\n`;
    }
    const data = deflateSync(Buffer.from(header + values, "latin1"));
    entries.set(next, [1, length, 0]);
    append(
      Buffer.from(
        `${next} 0 obj\n<< /Type /ObjStm /N ${compressed.length} /First ${header.length} /Length ${data.length} /Filter /FlateDecode >>\nstream\n`,
      ),
    );
    append(data);
    append(Buffer.from("\nendstream\nendobj\n"));
  }
  const xrefObject = next + (compressed.length ? 1 : 0);
  const size = xrefObject + (encoding === "classic" ? 0 : 1);
  const streamOffset = length;
  if (encoding !== "classic") {
    entries.set(xrefObject, [1, length, 0]);
    const sorted = [...entries].sort(([a], [b]) => a - b);
    const rows = Buffer.alloc(sorted.length * 7);
    for (const [i, [, [type, value, generation]]] of sorted.entries()) {
      rows[i * 7] = type;
      rows.writeUInt32BE(value, i * 7 + 1);
      rows.writeUInt16BE(generation, i * 7 + 5);
    }
    append(
      Buffer.from(
        `${xrefObject} 0 obj\n<< /Type /XRef /Size ${size} /Root 1 0 R /Prev ${previous} /W [1 4 2] /Index [${sorted.map(([id]) => `${id} 1`).join(" ")}] /Length ${rows.length} >>\nstream\n`,
      ),
    );
    append(rows);
    append(Buffer.from("\nendstream\nendobj\n"));
  }
  const xref = encoding === "stream" ? streamOffset : length;
  if (encoding !== "stream") {
    append(Buffer.from("xref\n"));
    for (const [id, [type, value, generation]] of [...entries].sort(([a], [b]) => a - b)) {
      // A hybrid table marks compressed objects free for pre-1.5 readers;
      // its supplemental stream supplies their current definitions.
      append(
        Buffer.from(
          `${id} 1\n${String(type === 2 ? 0 : value).padStart(10, "0")} ${String(generation).padStart(5, "0")} ${type === 1 ? "n" : "f"} \n`,
        ),
      );
    }
    append(
      Buffer.from(
        `trailer\n<< /Size ${size} /Root 1 0 R /Prev ${previous}${encoding === "hybrid" ? ` /XRefStm ${streamOffset}` : ""} >>\n`,
      ),
    );
  }
  append(Buffer.from(`startxref\n${xref}\n%%EOF\n`));
  return Buffer.concat(parts);
}

export function pdfRevisionCases(): { kind: string; bytes: Buffer; ok: boolean }[] {
  const page = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>";
  const baseObjects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    page,
  ];
  const direct = structuralPdf(baseObjects);
  const compressed = structuralPdf(baseObjects, true);
  const invalid = page.replace("100 100", "0 0");
  const cases: { kind: string; bytes: Buffer; ok: boolean }[] = [];
  for (const encoding of ["classic", "stream", "hybrid"] as const) {
    for (const [name, base] of [
      ["direct", direct],
      ["compressed", compressed],
    ] as const) {
      for (const [kind, value, ok] of [
        ["replacement", invalid, false],
        ["free", null, false],
      ] as const)
        cases.push({
          kind: `${encoding} ${kind} shadows ${name}`,
          bytes: appendPdfRevision(
            base,
            [{ object: 3, value, generation: value === null ? 1 : 0 }],
            encoding,
          ),
          ok,
        });
      cases.push({
        kind: `${encoding} stale generation shadows ${name}`,
        bytes: appendPdfRevision(base, [{ object: 3, value: page, generation: 1 }], encoding),
        ok: false,
      });
      if (encoding !== "classic")
        cases.push({
          kind: `${encoding} invalid compressed replacement shadows ${name}`,
          bytes: appendPdfRevision(
            base,
            [{ object: 3, value: invalid, compressed: true }],
            encoding,
          ),
          ok: false,
        });
    }
    cases.push({
      kind: `${encoding} reuses freed object at new generation`,
      bytes: appendPdfRevision(
        appendPdfRevision(direct, [{ object: 3, value: null, generation: 1 }], encoding),
        [
          { object: 2, value: baseObjects[1]!.replace("3 0 R", "3 1 R") },
          { object: 3, value: page, generation: 1 },
        ],
        encoding,
      ),
      ok: true,
    });
    const nested = [
      { object: 2, value: "<< /Type /Pages /Count 1 /Kids [6 0 R] >>" },
      { object: 6, value: "<< /Type /Pages /Parent 2 0 R /Count 1 /Kids [3 0 R] >>" },
      { object: 3, value: page.replace("/Parent 2", "/Parent 6"), compressed: true },
    ];
    cases.push({
      kind: `${encoding} direct replacement of compressed page with new parent`,
      bytes: appendPdfRevision(
        compressed,
        nested.map((entry) => ({ ...entry, compressed: false })),
        encoding,
      ),
      ok: true,
    });
    if (encoding === "classic") continue;
    const updated = appendPdfRevision(direct, nested, encoding);
    cases.push({
      kind: `${encoding} compressed replacement with new parent`,
      bytes: updated,
      ok: true,
    });
    cases.push({
      kind: `${encoding} newer free shadows compressed replacement`,
      bytes: appendPdfRevision(updated, [{ object: 3, value: null, generation: 1 }], "classic"),
      ok: false,
    });
    cases.push({
      kind: `${encoding} freed object stream cannot resolve old bytes`,
      bytes: appendPdfRevision(compressed, [{ object: 4, value: null, generation: 1 }], encoding),
      ok: false,
    });
    cases.push({
      kind: `${encoding} replaced object stream uses current bytes`,
      bytes: appendPdfRevision(
        compressed,
        [{ object: 4, value: "<< /Type /NotAnObjectStream >>" }],
        encoding,
      ),
      ok: false,
    });
  }
  return cases;
}

export function sharedMediaBoxPdf(pages: number, commentBytes: number, compressed = false): Buffer {
  const box = pages + 3;
  return structuralPdf(
    [
      "<< /Type /Catalog /Pages 2 0 R >>",
      `<< /Type /Pages /Count ${pages} /Kids [${Array.from({ length: pages }, (_, i) => `${i + 3} 0 R`).join(" ")}] >>`,
      ...Array.from(
        { length: pages },
        () => `<< /Type /Page /Parent 2 0 R /MediaBox ${box} 0 R >>`,
      ),
      `%${"x".repeat(commentBytes)}\n[0 0 100 100]`,
    ],
    compressed,
  );
}

/** Metadata-only incremental saves, retaining the original page tree. */
export function incrementalPdf(saves: number, encoding: "classic" | "stream" | "mixed"): Buffer {
  let bytes = structuralPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>",
  ]);
  let previous = Number(/startxref\n(\d+)/.exec(bytes.toString("latin1"))![1]);
  for (let i = 0; i < saves; i++) {
    const info = bytes.length;
    const body = Buffer.from(`4 0 obj\n<< /Title (Revision ${i}) >>\nendobj\n`);
    const xref = info + body.length;
    const streamed = encoding === "stream" || (encoding === "mixed" && i % 2 === 0);
    const xrefObject = 5 + i;
    let section: Buffer;
    if (streamed) {
      const rows = Buffer.alloc(14);
      for (const [i, offset] of [info, xref].entries()) {
        rows[i * 7] = 1;
        rows.writeUInt32BE(offset, i * 7 + 1);
      }
      section = Buffer.concat([
        Buffer.from(
          `${xrefObject} 0 obj\n<< /Type /XRef /Size ${xrefObject + 1} /Info 4 0 R /Prev ${previous} /W [1 4 2] /Index [4 1 ${xrefObject} 1] /Length ${rows.length} >>\nstream\n`,
        ),
        rows,
        Buffer.from("\nendstream\nendobj\n"),
      ]);
    } else {
      section = Buffer.from(
        `xref\n0 1\n0000000000 65535 f \n4 1\n${String(info).padStart(10, "0")} 00000 n \ntrailer\n<< /Size ${xrefObject + 1} /Info 4 0 R /Prev ${previous} >>\n`,
      );
    }
    bytes = Buffer.concat([bytes, body, section, Buffer.from(`startxref\n${xref}\n%%EOF\n`)]);
    previous = xref;
  }
  return bytes;
}

/** More than 100k genuine MPEG-2.5 frames: FFmpeg/LAME 8kbps, 8kHz mono silence. */
export function longMp3(frames = 110_000): Buffer {
  const frame = Buffer.from(
    "/+MYxAAAAANIAAAAAExBTUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy4xMDBVVVVVVVVVVVVV",
    "base64",
  );
  return Buffer.alloc(frames * frame.length, frame);
}

/** Extend the real PCM fixture with actual two-byte samples and matching tables. */
export function longPcmMp4(samples = 150_000): Buffer {
  return editMp4Boxes(pcmSampleMp4(), (type, box) => {
    if (type === "mdat") return mp4FixtureBox(type, Buffer.alloc(samples * 2));
    if (type === "stsz") return mp4FixtureBox(type, mp4Words(0, 2, samples));
    if (type === "stts") return mp4FixtureBox(type, mp4Words(0, 1, samples, 1));
    if (type === "stsc") return mp4FixtureBox(type, mp4Words(0, 1, 1, samples, 1));
    return box;
  });
}

/** Opus silence has three-byte packets: bitrate assumptions must not cap duration. */
export function longOpusOgg(packets = 60_000): Buffer {
  const source = opusOgg();
  let headerEnd = 0;
  for (let page = 0; page < 2; page++) {
    const count = source[headerEnd + 26]!;
    const laces = source.subarray(headerEnd + 27, headerEnd + 27 + count);
    headerEnd += 27 + count + laces.reduce((sum, size) => sum + size, 0);
  }
  const parts = [source.subarray(0, headerEnd)];
  for (let sent = 0, sequence = 2; sent < packets; sequence++) {
    const count = Math.min(255, packets - sent);
    const page = Buffer.alloc(27 + count * 4);
    page.write("OggS");
    page[5] = sent + count === packets ? 4 : 0;
    page.writeBigUInt64LE(BigInt((sent + count) * 960), 6);
    page.writeUInt32LE(source.readUInt32LE(14), 14);
    page.writeUInt32LE(sequence, 18);
    page[26] = count;
    page.fill(3, 27, 27 + count);
    page.fill(Buffer.from([0xf8, 0xff, 0xfe]), 27 + count);
    oggCrc(page, 0, page.length);
    parts.push(page);
    sent += count;
  }
  return Buffer.concat(parts);
}

/** One-byte GIF comment sub-blocks also have linear, byte-backed record counts. */
export function manyGifSubBlocks(blocks = 110_000): Buffer {
  const source = minimalGif();
  return Buffer.concat([
    source.subarray(0, -1),
    Buffer.from([0x21, 0xfe]),
    Buffer.alloc(blocks * 2, Buffer.from([1, 0x61])),
    Buffer.from([0, 0x3b]),
  ]);
}

/** Compact fixed sample tables in distinct tracks all reference the same large
 * mdat. Vary the counts to probe linear and excessive shared-reference work.
 */
export function sharedSamplesMp4(tracks = 16, samples = 8000): Buffer {
  return editMp4Boxes(pcmSampleMp4(), (type, box) => {
    if (type === "mdat") return mp4FixtureBox(type, Buffer.alloc(512 * 1024));
    if (type === "stsz") return mp4FixtureBox(type, mp4Words(0, 2, samples));
    if (type === "stts") return mp4FixtureBox(type, mp4Words(0, 1, samples, 1));
    if (type === "stsc") return mp4FixtureBox(type, mp4Words(0, 1, 1, samples, 1));
    if (type !== "trak") return box;
    return Buffer.concat(
      Array.from({ length: tracks }, (_, i) => {
        const track = Buffer.from(box);
        track.writeUInt32BE(i + 1, track.indexOf("tkhd") + 16);
        return track;
      }),
    );
  });
}

/** Each ANMF is individually small; their subchunks must spend a shared counter. */
export function manyFrameChunksWebp(frames = 1000, chunks = 100): Buffer {
  const src = animatedWebp();
  const start = src.indexOf("ANMF");
  const size = src.readUInt32LE(start + 4);
  const junk = Buffer.alloc(chunks * 8);
  for (let i = 0; i < chunks; i++) junk.write("JUNK", i * 8, "latin1");
  const frame = Buffer.concat([src.subarray(start, start + 8 + size), junk]);
  frame.writeUInt32LE(size + junk.length, 4);
  return wrapWebpChunks(src.subarray(12, start), Buffer.concat(Array(frames).fill(frame)));
}

export function manyChunksWav(chunks = 100_000): Buffer {
  const src = minimalWav();
  const junk = Buffer.alloc(chunks * 8);
  for (let i = 0; i < chunks; i++) junk.write("JUNK", i * 8, "latin1");
  const result = Buffer.concat([src, junk]);
  result.writeUInt32LE(result.length - 8, 4);
  return result;
}

export function mediaWorkBudgetCases(): { kind: string; mime: CasSniffMime; bytes: Buffer }[] {
  return [
    {
      kind: "compressed shared MediaBox scan amplification",
      mime: "application/pdf",
      bytes: sharedMediaBoxPdf(100, 512 * 1024, true),
    },
  ];
}

export function linearMediaWorkCases(): { kind: string; mime: CasSniffMime; bytes: Buffer }[] {
  return [
    { kind: "long MPEG audio", mime: "audio/mpeg", bytes: longMp3() },
    { kind: "dense PCM samples", mime: "video/mp4", bytes: longPcmMp4() },
    { kind: "short Opus packets", mime: "audio/ogg", bytes: longOpusOgg() },
    { kind: "short GIF sub-blocks", mime: "image/gif", bytes: manyGifSubBlocks() },
    { kind: "shared mdat samples", mime: "video/mp4", bytes: sharedSamplesMp4() },
    { kind: "nested ANMF chunks", mime: "image/webp", bytes: manyFrameChunksWebp() },
    { kind: "RIFF chunks", mime: "audio/wav", bytes: manyChunksWav() },
  ];
}
