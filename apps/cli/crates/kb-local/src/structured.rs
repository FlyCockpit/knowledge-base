//! Bounded GFM scalar rows and exact filters, mirroring structured.ts.
use crate::{
    StoreError,
    chunk::source_tokens,
    markdown::{ParsedMarkdown, YamlValue},
};
use kb_client::{
    casefold_path_key,
    types::{CitationSpan, IsoInstant},
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashSet;
use unicode_normalization::UnicodeNormalization;

pub const MAX_ROWS: usize = 1024;
pub const MAX_COLUMNS: usize = 64;
pub const MAX_COLUMN_SCALARS: usize = 256;
pub const MAX_CELL_SCALARS: usize = 1024;
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuredRow {
    pub row_index: usize,
    pub values: Map<String, Value>,
    pub span: CitationSpan,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuredDocument {
    pub r#type: Option<String>,
    pub title: Option<String>,
    pub title_folded: Option<String>,
    pub tags: Vec<String>,
    pub timestamp: String,
    pub rows: Vec<StructuredRow>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TimeRange {
    pub after: Option<String>,
    pub before: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Condition {
    pub column: String,
    pub equals: Value,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StructuredFilters {
    pub r#type: Option<String>,
    pub title: Option<String>,
    pub tags: Option<Vec<String>>,
    pub timestamp: Option<TimeRange>,
    pub structured: Option<Vec<Condition>>,
}
fn invalid() -> StoreError {
    StoreError::InvalidArgument("invalid structured document or filter".into())
}
// JS trim includes BOM and excludes NEL; token segmentation uses White_Space.
fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}')
}
fn normalize(s: &str) -> String {
    js_trim(&s.nfc().collect::<String>()).to_owned()
}
fn trim_cell(s: &str) -> &str {
    s.trim_matches([' ', '\t'])
}
fn cells(line: &str) -> Option<Vec<String>> {
    let mut text = trim_cell(line.trim_end_matches(['\r', '\n']));
    if !text.contains('|') {
        return None;
    }
    text = text.strip_prefix('|').unwrap_or(text);
    let mut chars = text.chars();
    let mut cell = String::new();
    let mut out = vec![];
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some(next @ ('|' | '\\')) => cell.push(next),
                Some(next) => {
                    cell.push(c);
                    cell.push(next);
                }
                None => cell.push(c),
            }
        } else if c == '|' {
            out.push(trim_cell(&cell).to_owned());
            cell.clear();
        } else {
            cell.push(c);
        }
    }
    if !trim_cell(&cell).is_empty() || !text.ends_with('|') {
        out.push(trim_cell(&cell).to_owned());
    }
    Some(out)
}
fn scalar(cell: &str) -> Result<Value, StoreError> {
    let parsed = serde_json::from_str::<Value>(cell).ok();
    if parsed.is_none() && cell.contains("\\u") {
        // JS accepts lone UTF-16 surrogates as JSON, then rejects them as
        // scalar text. Replace unicode escapes only to test JSON syntax;
        // invalid JSON stays source text, including trailing junk.
        let mut chars = cell.chars();
        let mut probe = String::new();
        while let Some(c) = chars.next() {
            probe.push(c);
            if c == '\\'
                && let Some(next) = chars.next()
            {
                probe.push(next);
                if next == 'u' {
                    let hex: String = chars.by_ref().take(4).collect();
                    probe.push_str(
                        if hex.len() == 4 && hex.bytes().all(|b| b.is_ascii_hexdigit()) {
                            "0061"
                        } else {
                            &hex
                        },
                    );
                }
            }
        }
        if serde_json::from_str::<Value>(&probe).is_ok_and(|v| v.is_string()) {
            return Err(invalid());
        }
    }
    let mut result = parsed
        .filter(|v| !v.is_array() && !v.is_object())
        .unwrap_or_else(|| Value::String(cell.into()));
    if let Some(n) = result.as_f64() {
        // JS JSON.parse uses IEEE-754 for every number, including integers.
        result = if n.fract() == 0. && n.abs() <= 9_007_199_254_740_991. {
            Value::from(n as i64)
        } else {
            serde_json::Number::from_f64(n)
                .map(Value::Number)
                .unwrap_or_else(|| Value::String(cell.into()))
        };
    }
    if result
        .as_str()
        .is_some_and(|s| s.chars().count() > MAX_CELL_SCALARS)
    {
        return Err(invalid());
    }
    Ok(result)
}
fn marker(text: &str) -> Option<(u8, usize, &str)> {
    let content = text.trim_start_matches(' ');
    if text.len() - content.len() > 3 {
        return None;
    }
    let c = *content.as_bytes().first()?;
    if c != b'`' && c != b'~' {
        return None;
    }
    let n = content.bytes().take_while(|b| *b == c).count();
    (n >= 3).then(|| (c, n, &content[n..]))
}
fn block_marker(text: &str) -> bool {
    let s = text.trim_start_matches(' ');
    if text.len() - s.len() > 3 {
        return false;
    }
    if s.starts_with(['>', '<']) {
        return true;
    }
    let b = s.as_bytes();
    let hash = b.iter().take_while(|c| **c == b'#').count();
    if (1..=6).contains(&hash) && b.get(hash).is_some_and(|c| matches!(c, b' ' | b'\t')) {
        return true;
    }
    if b.first().is_some_and(|c| matches!(c, b'-' | b'+' | b'*'))
        && b.get(1).is_some_and(|c| matches!(c, b' ' | b'\t'))
    {
        return true;
    }
    let digits = b.iter().take_while(|c| c.is_ascii_digit()).count();
    digits > 0
        && b.get(digits).is_some_and(|c| matches!(c, b'.' | b')'))
        && b.get(digits + 1).is_some_and(|c| matches!(c, b' ' | b'\t'))
}
pub fn extract_table_rows(body: &str) -> Result<Vec<StructuredRow>, StoreError> {
    let tokens = source_tokens(body);
    let mut token_index = 0;
    let mut rows = vec![];
    // Preserve CR, LF and CRLF offsets without normalizing the body.
    let mut at = 0;
    let mut lines = vec![];
    for line in body.split_inclusive('\n') {
        let mut rest = line;
        while !rest.is_empty() {
            let end = rest.find(['\r', '\n']).unwrap_or(rest.len());
            lines.push((at, &rest[..end]));
            let tail = &rest[end..];
            let width = if tail.starts_with("\r\n") {
                2
            } else {
                usize::from(!tail.is_empty())
            };
            at += end + width;
            rest = &tail[width..];
        }
    }
    let mut headers: Option<Vec<String>> = None;
    let mut fence: Option<(u8, usize)> = None;
    let mut i = 0;
    while i < lines.len() {
        let (start, text) = lines[i];
        i += 1;
        let mark = marker(text);
        if let Some((c, n)) = fence {
            if mark.is_some_and(|(m, k, rest)| m == c && k >= n && js_trim(rest).is_empty()) {
                fence = None;
            }
            continue;
        }
        if let Some((c, n, _)) = mark {
            fence = Some((c, n));
            headers = None;
            continue;
        }
        if text.starts_with("    ") || text.starts_with('\t') || js_trim(text).is_empty() {
            headers = None;
            continue;
        }
        if headers.is_some() && block_marker(text) {
            headers = None;
        }
        let Some(values) = cells(text) else {
            headers = None;
            continue;
        };
        if headers.is_none() {
            let separator = lines.get(i).and_then(|(_, line)| cells(line));
            if !separator.is_some_and(|s| {
                s.len() == values.len()
                    && s.iter().all(|v| {
                        let d = v.strip_prefix(':').unwrap_or(v);
                        let d = d.strip_suffix(':').unwrap_or(d);
                        !d.is_empty() && d.bytes().all(|b| b == b'-')
                    })
            }) {
                continue;
            }
            if values.len() > MAX_COLUMNS
                || values
                    .iter()
                    .any(|v| v.is_empty() || v.chars().count() > MAX_COLUMN_SCALARS)
                || values
                    .iter()
                    .collect::<std::collections::HashSet<_>>()
                    .len()
                    != values.len()
            {
                return Err(invalid());
            }
            headers = Some(values);
            i += 1;
            continue;
        }
        if rows.len() >= MAX_ROWS {
            return Err(invalid());
        }
        while tokens.get(token_index).is_some_and(|t| t.end <= start) {
            token_index += 1;
        }
        let start_token = token_index;
        while tokens
            .get(token_index)
            .is_some_and(|t| t.start < start + text.len())
        {
            token_index += 1;
        }
        let row = headers
            .as_ref()
            .into_iter()
            .flatten()
            .enumerate()
            .map(|(n, k)| Ok((k.clone(), scalar(values.get(n).map_or("", String::as_str))?)))
            .collect::<Result<Map<_, _>, StoreError>>()?;
        rows.push(StructuredRow {
            row_index: rows.len(),
            values: row,
            span: CitationSpan {
                start_token: start_token as u64,
                end_token: token_index as u64,
                start_byte: start as u64,
                end_byte: (start + text.len()) as u64,
            },
        });
    }
    Ok(rows)
}
pub fn iso_sort_key(stamp: &str) -> Result<String, StoreError> {
    IsoInstant::parse(stamp).map_err(|_| invalid())?;
    let fraction = stamp.get(20..stamp.len() - 1).unwrap_or("");
    Ok(format!("{}{fraction:0<9}", &stamp[..19]))
}
pub fn extract_structured_document(
    parsed: &ParsedMarkdown,
    body: &str,
    commit_timestamp: &str,
) -> Result<StructuredDocument, StoreError> {
    let fm = &parsed.front_matter;
    let timestamp = match fm.get("valid_from") {
        None => commit_timestamp,
        Some(YamlValue::String(s)) => s,
        _ => return Err(invalid()),
    };
    iso_sort_key(timestamp)?;
    let field = |k| match fm.get(k) {
        Some(YamlValue::String(s)) => Some(normalize(s)),
        _ => None,
    };
    let title = field("title");
    let mut tags = vec![];
    let mut seen_tags = HashSet::new();
    if let Some(YamlValue::Seq(items)) = fm.get("tags") {
        for item in items {
            if let YamlValue::String(s) = item {
                let s = normalize(s);
                if !s.is_empty() && seen_tags.insert(s.clone()) {
                    tags.push(s);
                }
            }
        }
    }
    Ok(StructuredDocument {
        r#type: field("type"),
        title_folded: title.as_deref().map(casefold_path_key),
        title,
        tags,
        timestamp: timestamp.into(),
        rows: extract_table_rows(body)?,
    })
}
fn scalar_equal(a: &Value, b: &Value) -> bool {
    match (a.as_f64(), b.as_f64()) {
        (Some(a), Some(b)) => a == b,
        _ => a == b,
    }
}
pub fn match_structured_document<'a>(
    document: &'a StructuredDocument,
    filters: &StructuredFilters,
) -> Result<Vec<Option<&'a StructuredRow>>, StoreError> {
    let conditions = filters.structured.as_deref().unwrap_or_default();
    let tags = filters.tags.as_deref().unwrap_or_default();
    if tags.len() > 16
        || conditions.len() > 16
        || filters
            .r#type
            .iter()
            .chain(filters.title.iter())
            .chain(tags)
            .any(|s| s.is_empty() || s.chars().count() > 256)
        || conditions.iter().any(|c| {
            c.column.is_empty()
                || c.column.chars().count() > 256
                || c.equals.is_array()
                || c.equals.is_object()
                || c.equals.as_str().is_some_and(|s| s.chars().count() > 1024)
        })
    {
        return Err(invalid());
    }
    let time = filters.timestamp.as_ref();
    let after = time
        .and_then(|t| t.after.as_deref())
        .map(iso_sort_key)
        .transpose()?;
    let before = time
        .and_then(|t| t.before.as_deref())
        .map(iso_sort_key)
        .transpose()?;
    if after
        .as_ref()
        .zip(before.as_ref())
        .is_some_and(|(a, b)| a >= b)
    {
        return Err(invalid());
    }
    let stamp = iso_sort_key(&document.timestamp)?;
    if filters
        .r#type
        .as_ref()
        .is_some_and(|s| document.r#type.as_ref() != Some(&normalize(s)))
        || filters.title.as_ref().is_some_and(|s| {
            document
                .title_folded
                .as_ref()
                .is_none_or(|t| !t.contains(&casefold_path_key(&normalize(s))))
        })
        || tags.iter().any(|s| !document.tags.contains(&normalize(s)))
        || after.is_some_and(|a| stamp < a)
        || before.is_some_and(|b| stamp >= b)
    {
        return Ok(vec![]);
    }
    if conditions.is_empty() {
        return Ok(vec![None]);
    }
    Ok(document
        .rows
        .iter()
        .filter(|r| {
            conditions.iter().all(|c| {
                r.values
                    .get(&c.column)
                    .is_some_and(|v| scalar_equal(v, &c.equals))
            })
        })
        .map(Some)
        .collect())
}
