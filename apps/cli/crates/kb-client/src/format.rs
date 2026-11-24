//! Lexical formats shared by the value types, the schema evaluator and the
//! error details: identifier shapes, exact UTC instants and safe JavaScript
//! integers, each checked exactly as the TypeScript runtime does.

use serde_json::Value;

fn lower_hex(c: u8) -> bool {
    c.is_ascii_digit() || (b'a'..=b'f').contains(&c)
}

fn lower_alnum(c: u8) -> bool {
    c.is_ascii_digit() || c.is_ascii_lowercase()
}

pub(crate) fn is_sha(s: &str) -> bool {
    s.len() == 40 && s.bytes().all(lower_hex)
}

pub(crate) fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, &c)| match i {
            8 | 13 | 18 | 23 => c == b'-',
            _ => lower_hex(c),
        })
}

pub(crate) fn is_kb_id(s: &str) -> bool {
    (24..=32).contains(&s.len()) && s.bytes().all(lower_alnum)
}

pub(crate) fn is_slug(s: &str) -> bool {
    !s.is_empty()
        && s.split('-')
            .all(|part| !part.is_empty() && part.bytes().all(lower_alnum))
}

pub(crate) fn is_concept_id(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 128
        && lower_alnum(b[0])
        && b[1..]
            .iter()
            .all(|&c| lower_alnum(c) || c == b'_' || c == b'-')
}

pub(crate) fn is_idempotency_key(s: &str) -> bool {
    (16..=128).contains(&s.len())
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}

pub(crate) fn is_content_hash(s: &str) -> bool {
    s.strip_prefix("sha256:")
        .is_some_and(|hex| hex.len() == 64 && hex.bytes().all(lower_hex))
}

pub(crate) fn matches_iso_shape(s: &str) -> bool {
    iso_fields(s).is_some()
}

// ── Instants ────────────────────────────────────────────────────────────────

struct IsoFields {
    year: i64,
    month: u32,
    day: u32,
    hour: u32,
    minute: u32,
    second: u32,
    fraction: String,
}

fn digits(s: &[u8]) -> Option<u32> {
    if s.is_empty() || !s.iter().all(u8::is_ascii_digit) {
        return None;
    }
    s.iter().try_fold(0u32, |acc, &d| {
        acc.checked_mul(10)?.checked_add(u32::from(d - b'0'))
    })
}

/// Shape-only parse of the ISO pattern (no calendar validation).
fn iso_fields(s: &str) -> Option<IsoFields> {
    let b = s.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' {
        return None;
    }
    if b[16] != b':' || *b.last()? != b'Z' {
        return None;
    }
    let fraction = match &b[19..b.len() - 1] {
        [] => "",
        [b'.', rest @ ..]
            if (1..=9).contains(&rest.len()) && rest.iter().all(u8::is_ascii_digit) =>
        {
            std::str::from_utf8(rest).ok()?
        }
        _ => return None,
    };
    Some(IsoFields {
        year: i64::from(digits(&b[0..4])?),
        month: digits(&b[5..7])?,
        day: digits(&b[8..10])?,
        hour: digits(&b[11..13])?,
        minute: digits(&b[14..16])?,
        second: digits(&b[17..19])?,
        fraction: fraction.trim_end_matches('0').to_owned(),
    })
}

fn days_in_month(year: i64, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 => 29,
        _ => 28,
    }
}

fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let m = i64::from(month);
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + i64::from(day) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Exact UTC instant: whole epoch seconds plus the fraction with trailing
/// zeros stripped, or `None` for anything the TypeScript runtime rejects —
/// including years 0000–0099, which `Date.UTC` maps into the 1900s.
pub(crate) fn parse_iso_instant(s: &str) -> Option<(i64, String)> {
    let f = iso_fields(s)?;
    if f.year < 100 || !(1..=12).contains(&f.month) || f.hour > 23 || f.minute > 59 {
        return None;
    }
    if f.second > 59 || f.day < 1 || f.day > days_in_month(f.year, f.month) {
        return None;
    }
    let days = days_from_civil(f.year, f.month, f.day);
    let seconds =
        days * 86_400 + i64::from(f.hour) * 3600 + i64::from(f.minute) * 60 + i64::from(f.second);
    Some((seconds, f.fraction))
}

/// Compare two instants exactly at the accepted precision.
pub(crate) fn compare_iso(a: &str, b: &str) -> Option<std::cmp::Ordering> {
    let (sa, fa) = parse_iso_instant(a)?;
    let (sb, fb) = parse_iso_instant(b)?;
    if sa != sb {
        return Some(sa.cmp(&sb));
    }
    let width = fa.len().max(fb.len());
    Some(format!("{fa:0<width$}").cmp(&format!("{fb:0<width$}")))
}

pub(crate) const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

/// Safe JS integer by numerical value, independent of JSON lexical spelling.
/// Check integer variants before floating conversion so unsafe integers cannot
/// round into the safe interval. Direct interval checks cannot overflow.
pub(crate) fn safe_integer(value: &Value) -> Option<i64> {
    if let Some(n) = value.as_i64() {
        return (-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER)
            .contains(&n)
            .then_some(n);
    }
    let n = value.as_f64()?;
    (n.is_finite()
        && n.fract() == 0.0
        && (-MAX_SAFE_INTEGER as f64..=MAX_SAFE_INTEGER as f64).contains(&n))
    .then_some(n as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn instants_follow_the_typescript_rules() {
        assert!(parse_iso_instant("2024-02-29T23:59:59.123456789Z").is_some());
        assert!(parse_iso_instant("2023-02-29T00:00:00Z").is_none());
        assert!(parse_iso_instant("2026-04-31T00:00:00Z").is_none());
        assert!(parse_iso_instant("2026-01-01T24:00:00Z").is_none());
        assert!(parse_iso_instant("2026-01-01T00:00:60Z").is_none());
        assert!(parse_iso_instant("2026-01-01T00:00:00.Z").is_none());
        assert!(parse_iso_instant("0099-12-31T00:00:00Z").is_none());
        assert!(parse_iso_instant("0100-01-01T00:00:00Z").is_some());
        assert_eq!(parse_iso_instant("1970-01-01T00:00:01Z").unwrap().0, 1);
        use std::cmp::Ordering::*;
        assert_eq!(
            compare_iso("2026-01-01T00:00:00Z", "2026-01-01T00:00:00.000Z"),
            Some(Equal)
        );
        assert_eq!(
            compare_iso("2026-01-01T00:00:00.1Z", "2026-01-01T00:00:00.02Z"),
            Some(Greater)
        );
        assert_eq!(
            compare_iso("2026-01-01T00:00:00.000001Z", "2026-01-01T00:00:00.000002Z"),
            Some(Less)
        );
    }
}
