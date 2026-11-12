//! Bounded content sniffing; declared MIME never selects an unchecked format.
use crate::{StoreError, cas::ASSET_MAX_BYTES};
use kb_client::types::Mime;
pub fn is_asset_mime(mime: Mime) -> bool {
    matches!(
        mime,
        Mime::ImageJpeg
            | Mime::ImagePng
            | Mime::ImageGif
            | Mime::ImageWebp
            | Mime::VideoMp4
            | Mime::VideoWebm
            | Mime::AudioMpeg
            | Mime::AudioWav
            | Mime::AudioOgg
            | Mime::ApplicationPdf
    )
}
pub fn validate_media(b: &[u8], mime: Mime) -> Result<(), StoreError> {
    let text = String::from_utf8_lossy(&b[..b.len().min(512)]).to_ascii_lowercase();
    let valid = !b.is_empty()
        && b.len() as u64 <= ASSET_MAX_BYTES
        && !["<html", "<!doctype html", "<script", "<svg"]
            .iter()
            .any(|s| text.contains(s))
        && match mime {
            Mime::ImageJpeg => jpeg(b),
            Mime::ImagePng => png(b),
            Mime::ImageGif => gif(b),
            Mime::ImageWebp => webp(b),
            Mime::AudioWav => wav(b),
            Mime::AudioMpeg => mp3(b),
            Mime::VideoMp4 => mp4(b),
            Mime::VideoWebm => webm(b),
            Mime::AudioOgg => ogg(b),
            Mime::ApplicationPdf => pdf(b),
            _ => false,
        };
    if valid {
        Ok(())
    } else {
        Err(StoreError::InvalidArgument(
            "untrusted media or MIME mismatch".into(),
        ))
    }
}
fn at(b: &[u8], p: usize, s: &[u8]) -> bool {
    b.get(p..p + s.len()) == Some(s)
}
fn le(b: &[u8], p: usize, n: usize) -> Option<u64> {
    Some(
        b.get(p..p.checked_add(n)?)?
            .iter()
            .enumerate()
            .map(|(i, v)| u64::from(*v) << (i * 8))
            .sum(),
    )
}
fn be(b: &[u8], p: usize, n: usize) -> Option<u64> {
    Some(
        b.get(p..p.checked_add(n)?)?
            .iter()
            .fold(0, |v, x| (v << 8) | u64::from(*x)),
    )
}
fn crc(b: &[u8], ogg: bool) -> u32 {
    let mut c = if ogg { 0 } else { u32::MAX };
    for x in b {
        if ogg {
            c ^= u32::from(*x) << 24;
            for _ in 0..8 {
                c = (c << 1) ^ if c & 0x80000000 != 0 { 0x04c11db7 } else { 0 };
            }
        } else {
            c ^= u32::from(*x);
            for _ in 0..8 {
                c = (c >> 1) ^ if c & 1 != 0 { 0xedb88320 } else { 0 };
            }
        }
    }
    if ogg { c } else { !c }
}
fn png(b: &[u8]) -> bool {
    (|| {
        if !at(b, 0, b"\x89PNG\r\n\x1a\n") {
            return None;
        }
        let mut p = 8;
        let mut data = 0;
        let mut ended = false;
        let mut palette = false;
        let mut color = 0;
        while p + 12 <= b.len() {
            let n = be(b, p, 4)? as usize;
            let end = p.checked_add(n)?.checked_add(12)?;
            let chunk = b.get(p + 4..end - 4)?;
            if crc(chunk, false) != be(b, end - 4, 4)? as u32 {
                return None;
            }
            let tag = chunk.get(..4)?;
            if p == 8 && tag != b"IHDR" {
                return None;
            }
            match tag {
                b"IHDR" => {
                    if p != 8 || n != 13 || be(b, p + 8, 4)? == 0 || be(b, p + 12, 4)? == 0 {
                        return None;
                    }
                    let depth = *b.get(p + 16)?;
                    color = *b.get(p + 17)?;
                    if !match color {
                        0 => [1, 2, 4, 8, 16].contains(&depth),
                        2 | 4 | 6 => [8, 16].contains(&depth),
                        3 => [1, 2, 4, 8].contains(&depth),
                        _ => false,
                    } || *b.get(p + 18)? != 0
                        || *b.get(p + 19)? != 0
                        || *b.get(p + 20)? > 1
                    {
                        return None;
                    }
                }
                b"PLTE" => {
                    if palette
                        || data > 0
                        || n == 0
                        || !n.is_multiple_of(3)
                        || n > 768
                        || color == 0
                        || color == 4
                    {
                        return None;
                    }
                    palette = true;
                }
                b"IDAT" => {
                    if ended || (color == 3 && !palette) {
                        return None;
                    }
                    data += n;
                }
                b"IEND" => return (n == 0 && data > 0 && end == b.len()).then_some(()),
                _ => {
                    if data > 0 {
                        ended = true
                    }
                    if tag[0] & 32 == 0 {
                        return None;
                    }
                }
            }
            p = end;
        }
        None
    })()
    .is_some()
}
fn jpeg(b: &[u8]) -> bool {
    (|| {
        if !at(b, 0, b"\xff\xd8") {
            return None;
        }
        let mut p = 2;
        let mut frame = false;
        let mut scan = false;
        while p + 1 < b.len() {
            if b[p] != 255 {
                return None;
            }
            p += 1;
            while *b.get(p)? == 255 {
                p += 1
            }
            let tag = *b.get(p)?;
            p += 1;
            if tag == 0xd9 {
                return (p == b.len() && frame && scan).then_some(());
            }
            if tag == 1 {
                continue;
            }
            if tag == 0 || tag == 0xd8 || (0xd0..=0xd7).contains(&tag) {
                return None;
            }
            let len = be(b, p, 2)? as usize;
            if len < 2 {
                return None;
            }
            let segment = b.get(p..p + len)?;
            if (0xc0..=0xcf).contains(&tag) && ![0xc4, 0xc8, 0xcc].contains(&tag) {
                if frame
                    || len < 8
                    || be(segment, 3, 2)? == 0
                    || be(segment, 5, 2)? == 0
                    || segment[7] == 0
                    || segment[7] > 4
                    || len != 8 + 3 * usize::from(segment[7])
                {
                    return None;
                }
                frame = true;
            }
            p += len;
            if tag == 0xda {
                if !frame || len < 8 {
                    return None;
                }
                scan = true;
                let start = p;
                while p + 1 < b.len() {
                    if b[p] == 255
                        && b[p + 1] != 0
                        && b[p + 1] != 255
                        && !(0xd0..=0xd7).contains(&b[p + 1])
                    {
                        break;
                    }
                    p += if b[p] == 255 { 2 } else { 1 };
                }
                if p == start {
                    return None;
                }
            }
        }
        None
    })()
    .is_some()
}
fn gif(b: &[u8]) -> bool {
    (|| {
        if !at(b, 0, b"GIF87a") && !at(b, 0, b"GIF89a") {
            return None;
        }
        if le(b, 6, 2)? == 0 || le(b, 8, 2)? == 0 {
            return None;
        }
        let packed = *b.get(10)?;
        let mut p = 13
            + if packed & 128 != 0 {
                3usize << ((packed & 7) + 1)
            } else {
                0
            };
        let mut image = false;
        loop {
            let tag = *b.get(p)?;
            p += 1;
            if tag == 0x3b {
                return (image && p == b.len()).then_some(());
            }
            let require = match tag {
                0x21 => {
                    p += 1;
                    false
                }
                0x2c => {
                    let d = b.get(p..p + 9)?;
                    if le(d, 4, 2)? == 0 || le(d, 6, 2)? == 0 || d[8] & 0x18 != 0 {
                        return None;
                    }
                    if le(d, 0, 2)? + le(d, 4, 2)? > le(b, 6, 2)?
                        || le(d, 2, 2)? + le(d, 6, 2)? > le(b, 8, 2)?
                    {
                        return None;
                    }
                    if (d[8] | packed) & 128 == 0 {
                        return None;
                    }
                    p += 9 + if d[8] & 128 != 0 {
                        3usize << ((d[8] & 7) + 1)
                    } else {
                        0
                    };
                    if !(2..=8).contains(b.get(p)?) {
                        return None;
                    }
                    p += 1;
                    image = true;
                    true
                }
                _ => return None,
            };
            let mut data = 0;
            loop {
                let n = usize::from(*b.get(p)?);
                p += 1;
                if n == 0 {
                    break;
                }
                b.get(p..p + n)?;
                p += n;
                data += n;
            }
            if require && data == 0 {
                return None;
            }
        }
    })()
    .is_some()
}
fn riff<'a>(b: &'a [u8], kind: &[u8]) -> Option<Vec<(&'a [u8], &'a [u8])>> {
    if !at(b, 0, b"RIFF") || !at(b, 8, kind) || le(b, 4, 4)? + 8 != b.len() as u64 {
        return None;
    }
    let mut chunks = Vec::new();
    let mut p = 12;
    while p + 8 <= b.len() {
        let n = le(b, p + 4, 4)? as usize;
        chunks.push((b.get(p..p + 4)?, b.get(p + 8..p + 8 + n)?));
        p += 8 + n + n % 2;
    }
    (p == b.len() || (kind == b"WEBP" && b.len() - p <= 2 && b[p..].iter().all(|x| *x == 0)))
        .then_some(chunks)
}
fn webp(b: &[u8]) -> bool {
    (|| {
        let chunks = riff(b, b"WEBP")?;
        let mut image = false;
        for (tag, data) in chunks {
            match tag {
                b"VP8 " => {
                    if data.len() <= 10
                        || data[0] & 1 != 0
                        || !at(data, 3, b"\x9d\x01\x2a")
                        || le(data, 6, 2)? & 0x3fff == 0
                        || le(data, 8, 2)? & 0x3fff == 0
                    {
                        return None;
                    }
                    image = true;
                }
                b"VP8L" => {
                    if data.len() <= 5 || data[0] != 0x2f || le(data, 1, 4)? >> 29 != 0 {
                        return None;
                    }
                    image = true;
                }
                b"VP8X" => {
                    if data.len() != 10 {
                        return None;
                    }
                }
                b"ANMF" => {
                    if data.len() <= 24 || !data.windows(4).any(|w| w == b"VP8 " || w == b"VP8L") {
                        return None;
                    }
                    image = true;
                }
                _ => {}
            }
        }
        image.then_some(())
    })()
    .is_some()
}
fn wav(b: &[u8]) -> bool {
    (|| {
        let chunks = riff(b, b"WAVE")?;
        let mut align = None;
        let mut data = false;
        for (tag, bytes) in chunks {
            match tag {
                b"fmt " => {
                    if align.is_some() || bytes.len() < 16 {
                        return None;
                    }
                    let format = le(bytes, 0, 2)?;
                    let channels = le(bytes, 2, 2)?;
                    let rate = le(bytes, 4, 4)?;
                    let byte_rate = le(bytes, 8, 4)?;
                    let block = le(bytes, 12, 2)?;
                    let bits = le(bytes, 14, 2)?;
                    if channels == 0 || rate == 0 || byte_rate == 0 || block == 0 {
                        return None;
                    }
                    if format == 1 || format == 3 {
                        if bits == 0
                            || bits % 8 != 0
                            || block != channels * bits / 8
                            || byte_rate != rate * block
                            || (format == 3 && bits != 32 && bits != 64)
                        {
                            return None;
                        }
                    } else if bytes.len() < 18 || le(bytes, 16, 2)? > bytes.len() as u64 - 18 {
                        return None;
                    }
                    align = Some(if format == 1 || format == 3 { block } else { 1 });
                }
                b"data" => {
                    if bytes.is_empty() || !(bytes.len() as u64).is_multiple_of(align?) {
                        return None;
                    }
                    data = true;
                }
                _ => {}
            }
        }
        data.then_some(())
    })()
    .is_some()
}
fn mp3(b: &[u8]) -> bool {
    (|| {
        let mut p = 0;
        let mut end = b.len();
        if at(b, 0, b"ID3") {
            let header = b.get(..10)?;
            if ![3, 4].contains(&header[3]) || header[6..].iter().any(|x| *x > 127) {
                return None;
            }
            p = 10
                + header[6..]
                    .iter()
                    .fold(0usize, |v, x| (v << 7) | usize::from(*x))
                + if header[5] & 16 != 0 { 10 } else { 0 };
        }
        if end >= 128 && at(b, end - 128, b"TAG") {
            end -= 128;
            if end >= 227 && at(b, end - 227, b"TAG+") {
                end -= 227
            }
        }
        let initial = b.get(p..p + 4)?;
        let mut frames = 0;
        while p < end {
            let h = b.get(p..p + 4)?;
            let version = (h[1] >> 3) & 3;
            let layer = (h[1] >> 1) & 3;
            let rate_index = (h[2] >> 2) & 3;
            let index = (h[2] >> 4) as usize;
            if h[0] != 255
                || h[1] & 0xe0 != 0xe0
                || version == 1
                || layer == 0
                || rate_index == 3
                || index == 0
                || index == 15
                || h[3] & 3 == 2
                || h[1] & 30 != initial[1] & 30
                || h[2] & 12 != initial[2] & 12
            {
                return None;
            }
            let table = match (version == 3, layer) {
                (true, 3) => [
                    0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448,
                ],
                (true, 2) => [
                    0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384,
                ],
                (true, 1) => [
                    0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
                ],
                (false, 3) => [
                    0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256,
                ],
                _ => [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
            };
            let rate = [44100, 48000, 32000][rate_index as usize]
                / if version == 3 {
                    1
                } else if version == 2 {
                    2
                } else {
                    4
                };
            let bitrate = table[index] * 1000;
            let pad = ((h[2] >> 1) & 1) as usize;
            let len = if layer == 3 {
                (12 * bitrate / rate + pad) * 4
            } else {
                (if layer == 1 && version != 3 { 72 } else { 144 }) * bitrate / rate + pad
            };
            p += len;
            frames += 1;
        }
        (p == end && frames >= 2).then_some(())
    })()
    .is_some()
}
fn boxes(b: &[u8], depth: usize, found: &mut [bool; 5]) -> Option<()> {
    if depth > 32 {
        return None;
    }
    let mut p = 0;
    while p < b.len() {
        let tag = b.get(p + 4..p + 8)?;
        let mut len = be(b, p, 4)? as usize;
        let mut header = 8;
        if len == 1 {
            len = usize::try_from(be(b, p + 8, 8)?).ok()?;
            header = 16;
        } else if len == 0 {
            if tag != b"mdat" {
                return None;
            }
            len = b.len() - p;
        }
        if len < header {
            return None;
        }
        let data = b.get(p + header..p.checked_add(len)?)?;
        match tag {
            b"ftyp" => {
                if depth != 0 || data.len() < 8 {
                    return None;
                }
                found[0] = true;
            }
            b"mdat" => {
                if !data.is_empty() {
                    found[1] = true
                }
            }
            b"moov" | b"trak" | b"mdia" | b"minf" | b"stbl" | b"mvex" | b"moof" | b"traf" => {
                if tag == b"moov" {
                    found[2] = true
                }
                boxes(data, depth + 1, found)?;
            }
            b"stsd" => {
                if data.len() < 16 || be(data, 4, 4)? == 0 {
                    return None;
                }
                found[3] = true;
            }
            b"stsz" | b"stz2" | b"trun" => {
                if data.len() < 8 {
                    return None;
                }
                found[4] = true;
            }
            _ => {}
        }
        p += len;
    }
    Some(())
}
fn mp4(b: &[u8]) -> bool {
    let mut found = [false; 5];
    boxes(b, 0, &mut found).is_some() && found.iter().all(|x| *x)
}
fn vint(b: &[u8], p: &mut usize, id: bool) -> Option<(u64, bool)> {
    let first = *b.get(*p)?;
    let n = first.leading_zeros() as usize + 1;
    if n > 8 || (id && n > 4) {
        return None;
    }
    let raw = be(b, *p, n)?;
    *p += n;
    let mask = (1u64 << (7 * n)) - 1;
    Some((if id { raw } else { raw & mask }, !id && raw & mask == mask))
}
fn ebml(b: &[u8], depth: usize, found: &mut [bool; 4]) -> Option<()> {
    if depth > 32 {
        return None;
    }
    let mut p = 0;
    while p < b.len() {
        let (id, _) = vint(b, &mut p, true)?;
        let (size, unknown) = vint(b, &mut p, false)?;
        let len = if unknown {
            if id != 0x18538067 {
                return None;
            }
            b.len() - p
        } else {
            usize::try_from(size).ok()?
        };
        let data = b.get(p..p.checked_add(len)?)?;
        match id {
            0x1a45dfa3 | 0x18538067 | 0x1654ae6b | 0xae | 0x1f43b675 => {
                ebml(data, depth + 1, found)?;
            }
            0x4282 => {
                if data != b"webm" {
                    return None;
                }
                found[0] = true
            }
            0x86 => {
                if ![
                    b"V_VP8".as_slice(),
                    b"V_VP9",
                    b"V_AV1",
                    b"A_OPUS",
                    b"A_VORBIS",
                ]
                .contains(&data)
                {
                    return None;
                }
                found[1] = true
            }
            0xa3 => {
                if data.len() < 5 {
                    return None;
                }
                found[2] = true
            }
            0xe7 => found[3] = true,
            _ => {}
        }
        p += len;
    }
    Some(())
}
fn webm(b: &[u8]) -> bool {
    let mut found = [false; 4];
    at(b, 0, b"\x1a\x45\xdf\xa3") && ebml(b, 0, &mut found).is_some() && found.iter().all(|x| *x)
}
fn ogg(b: &[u8]) -> bool {
    (|| {
        let mut p = 0;
        let mut seq = 0;
        let mut packets = 0;
        let mut eos = false;
        let mut payload = Vec::new();
        let mut serial = None;
        let mut opus = false;
        while p < b.len() {
            let h = b.get(p..p + 27)?;
            if !at(h, 0, b"OggS") || h[4] != 0 || h[5] & !7 != 0 || eos || le(h, 18, 4)? != seq {
                return None;
            }
            let stream = le(h, 14, 4)?;
            if serial.is_some_and(|s| s != stream) {
                return None;
            }
            serial = Some(stream);
            if seq == 0 && h[5] & 2 == 0 {
                return None;
            }
            let laces = b.get(p + 27..p + 27 + usize::from(h[26]))?;
            let len: usize = laces.iter().map(|x| usize::from(*x)).sum();
            let end = p + 27 + laces.len() + len;
            let mut page = b.get(p..end)?.to_vec();
            page[22..26].fill(0);
            if crc(&page, true) != le(h, 22, 4)? as u32 {
                return None;
            }
            let mut off = p + 27 + laces.len();
            for n in laces {
                let n = usize::from(*n);
                payload.extend_from_slice(b.get(off..off + n)?);
                off += n;
                if n < 255 {
                    if packets == 0 {
                        opus = at(&payload, 0, b"OpusHead");
                        if !opus && !at(&payload, 0, b"\x01vorbis") {
                            return None;
                        }
                    }
                    packets += 1;
                    payload.clear();
                }
            }
            eos = h[5] & 4 != 0;
            seq += 1;
            p = end;
        }
        (eos && payload.is_empty() && packets >= if opus { 3 } else { 4 }).then_some(())
    })()
    .is_some()
}
fn pdf(b: &[u8]) -> bool {
    let text = String::from_utf8_lossy(b);
    let trimmed = text.trim_end();
    at(b, 0, b"%PDF-")
        && trimmed.ends_with("%%EOF")
        && text.contains("/Catalog")
        && text.contains("/Pages")
        && text.contains("/Page")
        && text.contains("/MediaBox")
        && text.contains("/Root")
        && text.contains("startxref")
        && text.contains("endobj")
        && text
            .rsplit("startxref")
            .next()
            .and_then(|s| s.split_whitespace().next())
            .and_then(|s| s.parse::<usize>().ok())
            .is_some_and(|p| p < b.len() && (at(b, p, b"xref") || text.contains("/XRef")))
}
