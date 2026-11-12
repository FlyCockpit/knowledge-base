//! Evaluator for the canonical kb/1 JSON Schema artifact.
//!
//! The artifact (`packages/api/src/lib/kb/protocol/schema.json`) is generated
//! from the TypeScript runtime schemas and embedded here at compile time, so
//! the Rust client enforces the exact same closed shapes, bounds and portable
//! `x-kb-*` rules as the server. The evaluator is deliberately fail-closed: a
//! keyword or `pattern` it does not know makes the artifact unusable instead
//! of being silently ignored.

use std::collections::{BTreeMap, HashSet};
use std::fmt;
use std::sync::OnceLock;

use serde_json::{Map, Number, Value};

use crate::path::{casefold_path_key, check_kb_path};

const ARTIFACT_JSON: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../../packages/api/src/lib/kb/protocol/schema.json"
));

/// Which side of a tool call a schema describes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Direction {
    Input,
    Output,
}

/// Where and which rule rejected a value. Never contains the rejected value
/// or any caller-chosen object key: `pointer` only uses schema-declared
/// property names and array indices, and `member` only a safe ASCII name.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SchemaViolation {
    pub pointer: String,
    pub keyword: &'static str,
    /// For `required`: the first missing member. For `additionalProperties`:
    /// the unknown member, only when it is a safe `[A-Za-z0-9_]{1,64}` name
    /// (caller-chosen text never enters a violation otherwise).
    pub member: Option<String>,
    /// For a length, item-count or range violation: the schema's inclusive
    /// integer bounds for that value (both when it declares both), so a
    /// caller learns the limit it broke (`min`/`max`).
    pub min: Option<i64>,
    pub max: Option<i64>,
}

impl fmt::Display for SchemaViolation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let pointer = if self.pointer.is_empty() {
            "/"
        } else {
            &self.pointer
        };
        write!(f, "`{pointer}` violates `{}`", self.keyword)
    }
}

struct Artifact {
    request_meta: Value,
    builtin_id: String,
    tools: BTreeMap<String, (Value, Value)>,
    descriptions: BTreeMap<String, String>,
    groups: BTreeMap<String, Vec<&'static str>>,
    presets: BTreeMap<String, Vec<&'static str>>,
    access: BTreeMap<String, MinimumAccess>,
}

/// A tool's minimum KB access (`catalog.minimumAccess`), which discovery
/// uses to decide what a principal could ever call.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MinimumAccess {
    /// The KB bit.
    Permission(crate::types::Permission),
    /// The KB's owner holding `manage` (delete).
    OwnerManage,
    /// The connection may create KBs.
    GlobalAllowCreate,
    ProposeOrWrite,
    /// A sealed grant, which needs `read`.
    SealedGrant,
    /// A proposal's author holding `propose`.
    AuthorWithPropose,
    AnyOf(Vec<MinimumAccess>),
}

/// Tool groups a connection can be granted, in catalog display order (the
/// closed set from `KB_TOOL_GROUPS`). An artifact naming any other group, or
/// one out of this order, is rejected.
pub const TOOL_GROUPS: &[&str] = &[
    "read",
    "edit",
    "assets",
    "export",
    "pull_requests",
    "index_admin",
    "kb_admin",
    "sealed",
];

fn artifact() -> Result<&'static Artifact, SchemaViolation> {
    static ARTIFACT: OnceLock<Result<Artifact, SchemaViolation>> = OnceLock::new();
    ARTIFACT
        .get_or_init(load_artifact)
        .as_ref()
        .map_err(Clone::clone)
}

fn artifact_error(keyword: &'static str) -> SchemaViolation {
    SchemaViolation {
        pointer: "#artifact".to_owned(),
        keyword,
        member: None,
        min: None,
        max: None,
    }
}

fn load_artifact() -> Result<Artifact, SchemaViolation> {
    let root: Value =
        serde_json::from_str(ARTIFACT_JSON).map_err(|_| artifact_error("artifact-json"))?;
    if root.get("schemaVersion").and_then(Value::as_str) != Some(crate::PROTOCOL_VERSION) {
        return Err(artifact_error("schemaVersion"));
    }
    // The closed group set is a checked copy: the artifact's order must equal
    // [`TOOL_GROUPS`] exactly, so the two cannot drift.
    let order: Option<Vec<&str>> = root
        .get("toolGroups")
        .and_then(Value::as_array)
        .and_then(|groups| groups.iter().map(Value::as_str).collect());
    if order.as_deref() != Some(TOOL_GROUPS) {
        return Err(artifact_error("toolGroups"));
    }
    let listed = root
        .get("toolPresets")
        .and_then(Value::as_object)
        .filter(|presets| !presets.is_empty())
        .ok_or(artifact_error("toolPresets"))?;
    let mut presets = BTreeMap::new();
    for (name, groups) in listed {
        let groups = group_list(groups, "toolPresets")?;
        if groups.is_empty() || TOOL_GROUPS.contains(&name.as_str()) && groups != [name.as_str()] {
            return Err(artifact_error("toolPresets"));
        }
        presets.insert(name.clone(), groups);
    }
    let tools = root
        .get("tools")
        .and_then(Value::as_object)
        .ok_or(artifact_error("tools"))?;
    let mut out = BTreeMap::new();
    let mut descriptions = BTreeMap::new();
    let mut groups = BTreeMap::new();
    let mut access = BTreeMap::new();
    for (name, row) in tools {
        let input = row.get("input").cloned().ok_or(artifact_error("input"))?;
        let output = row.get("output").cloned().ok_or(artifact_error("output"))?;
        audit_schema(&input)?;
        audit_schema(&output)?;
        let description = row
            .pointer("/catalog/description")
            .and_then(Value::as_str)
            .ok_or(artifact_error("description"))?;
        descriptions.insert(name.clone(), description.to_owned());
        groups.insert(name.clone(), catalog_groups(row)?);
        access.insert(
            name.clone(),
            minimum_access(
                row.pointer("/catalog/minimumAccess")
                    .ok_or(artifact_error("minimumAccess"))?,
            )?,
        );
        out.insert(name.clone(), (input, output));
    }
    let builtin_id = root
        .pointer("/builtinProvider/id")
        .and_then(Value::as_str)
        .filter(|id| is_kb_id(id))
        .ok_or(artifact_error("builtinProvider"))?
        .to_owned();
    if root
        .pointer("/builtinProvider/name")
        .and_then(Value::as_str)
        != Some(crate::types::ProviderRef::BUILTIN)
    {
        return Err(artifact_error("builtinProvider"));
    }
    let request_meta = root
        .get("requestMeta")
        .cloned()
        .ok_or(artifact_error("requestMeta"))?;
    audit_schema(&request_meta)?;
    Ok(Artifact {
        request_meta,
        builtin_id,
        tools: out,
        descriptions,
        groups,
        presets,
        access,
    })
}

/// `catalog.minimumAccess`; an unknown kind or bit fails closed.
fn minimum_access(value: &Value) -> Result<MinimumAccess, SchemaViolation> {
    let error = || artifact_error("minimumAccess");
    Ok(match value.get("kind").and_then(Value::as_str) {
        Some("permission") => MinimumAccess::Permission(
            serde_json::from_value(value.get("bit").cloned().ok_or_else(error)?)
                .map_err(|_| error())?,
        ),
        Some("owner_manage") => MinimumAccess::OwnerManage,
        Some("global_allow_create") => MinimumAccess::GlobalAllowCreate,
        Some("propose_or_write") => MinimumAccess::ProposeOrWrite,
        Some("sealed_grant") => MinimumAccess::SealedGrant,
        Some("author_with_propose") => MinimumAccess::AuthorWithPropose,
        Some("any_of") => MinimumAccess::AnyOf(
            value
                .get("of")
                .and_then(Value::as_array)
                .filter(|of| !of.is_empty())
                .ok_or_else(error)?
                .iter()
                .map(minimum_access)
                .collect::<Result<_, _>>()?,
        ),
        _ => return Err(error()),
    })
}

/// `catalog.groups`: known groups, each once, in [`TOOL_GROUPS`] order. Empty
/// marks a supporting tool.
fn catalog_groups(row: &Value) -> Result<Vec<&'static str>, SchemaViolation> {
    group_list(
        row.pointer("/catalog/groups")
            .ok_or(artifact_error("groups"))?,
        "groups",
    )
}

/// Known groups, each once, in [`TOOL_GROUPS`] order.
fn group_list(value: &Value, keyword: &'static str) -> Result<Vec<&'static str>, SchemaViolation> {
    let listed = value.as_array().ok_or(artifact_error(keyword))?;
    let mut groups = Vec::with_capacity(listed.len());
    let mut last = None;
    for group in listed {
        let index = group
            .as_str()
            .and_then(|g| TOOL_GROUPS.iter().position(|known| *known == g))
            .ok_or(artifact_error(keyword))?;
        if last.is_some_and(|previous| index <= previous) {
            return Err(artifact_error(keyword));
        }
        last = Some(index);
        groups.push(TOOL_GROUPS[index]);
    }
    Ok(groups)
}

/// Names of the tools the embedded artifact defines.
pub fn artifact_tool_names() -> Result<Vec<&'static str>, SchemaViolation> {
    Ok(artifact()?.tools.keys().map(String::as_str).collect())
}

/// Canonical schemas for transport advertisement; no second schema inventory.
pub fn tool_schemas(tool: &str) -> Result<(&'static Value, &'static Value), SchemaViolation> {
    let (input, output) = artifact()?
        .tools
        .get(tool)
        .ok_or_else(|| artifact_error("unknown-tool"))?;
    Ok((input, output))
}

/// Validate a raw JSON value against the artifact schema for `tool`.
pub fn validate(tool: &str, direction: Direction, value: &Value) -> Result<(), SchemaViolation> {
    let artifact = artifact()?;
    let (input, output) = artifact
        .tools
        .get(tool)
        .ok_or(artifact_error("unknown-tool"))?;
    let schema = match direction {
        Direction::Input => input,
        Direction::Output => output,
    };
    let mut pointer = String::new();
    check(schema, value, &mut pointer)
}

/// Ordinary request metadata, generated directly from the pinned server SDK.
/// Checked before envelope/session admission, just like its JSON-RPC decoder.
pub fn validate_request_meta(value: &Value) -> Result<(), SchemaViolation> {
    check(&artifact()?.request_meta, value, &mut String::new())
}

/// Whether `value` satisfies one schema node of the artifact.
pub(crate) fn conforms(schema: &Value, value: &Value) -> bool {
    check(schema, value, &mut String::new()).is_ok()
}

/// Canonical tool description for transport advertisement.
pub fn tool_description(tool: &str) -> Result<&'static str, SchemaViolation> {
    artifact()?
        .descriptions
        .get(tool)
        .map(String::as_str)
        .ok_or_else(|| artifact_error("unknown-tool"))
}

/// Groups that make `tool` available (any one suffices); empty for a
/// supporting tool.
pub fn tool_groups(tool: &str) -> Result<&'static [&'static str], SchemaViolation> {
    artifact()?
        .groups
        .get(tool)
        .map(Vec::as_slice)
        .ok_or_else(|| artifact_error("unknown-tool"))
}

/// The catalog's minimum KB access for `tool`.
pub fn tool_minimum_access(tool: &str) -> Result<&'static MinimumAccess, SchemaViolation> {
    artifact()?
        .access
        .get(tool)
        .ok_or_else(|| artifact_error("unknown-tool"))
}

/// The groups a named preset (`read`, `propose`, `direct`) selects, in
/// [`TOOL_GROUPS`] order, from the artifact's `toolPresets`; `None` for any
/// other name.
pub fn preset_groups(preset: &str) -> Result<Option<&'static [&'static str]>, SchemaViolation> {
    Ok(artifact()?.presets.get(preset).map(Vec::as_slice))
}

/// Every preset name the artifact defines, sorted.
pub fn preset_names() -> Result<Vec<&'static str>, SchemaViolation> {
    Ok(artifact()?.presets.keys().map(String::as_str).collect())
}

// ── Artifact audit (fail closed) ────────────────────────────────────────────

const KNOWN_KEYWORDS: &[&str] = &[
    "$schema",
    "additionalProperties",
    "allOf",
    "anyOf",
    "const",
    "else",
    "enum",
    "if",
    "items",
    "maxItems",
    "maxLength",
    "maximum",
    "minItems",
    "minLength",
    "minimum",
    "not",
    "oneOf",
    "pattern",
    "properties",
    "propertyNames",
    "required",
    "then",
    "type",
    "x-kb-base64-canonical",
    "x-kb-iso-range",
    "x-kb-iso-utc-instant",
    "x-kb-json-depth-max",
    "x-kb-json-encoded-max-bytes",
    "x-kb-no-control-chars",
    "x-kb-metadata-text",
    "x-kb-path",
    "x-kb-path-prefix",
    "x-kb-change-paths",
    "x-kb-unique-items",
    "x-kb-utf8-max-bytes",
];

fn audit_schema(schema: &Value) -> Result<(), SchemaViolation> {
    let object = match schema {
        Value::Bool(_) => return Ok(()),
        Value::Object(object) => object,
        _ => return Err(artifact_error("schema-node")),
    };
    for (key, value) in object {
        if !KNOWN_KEYWORDS.contains(&key.as_str()) {
            return Err(artifact_error("unknown-keyword"));
        }
        match key.as_str() {
            "properties" => {
                for child in value
                    .as_object()
                    .ok_or(artifact_error("properties"))?
                    .values()
                {
                    audit_schema(child)?;
                }
            }
            "items" | "additionalProperties" | "propertyNames" | "not" | "if" | "then" | "else" => {
                audit_schema(value)?
            }
            "anyOf" | "allOf" | "oneOf" => {
                for child in value.as_array().ok_or(artifact_error("combinator"))? {
                    audit_schema(child)?;
                }
            }
            "pattern" => {
                let pattern = value.as_str().ok_or(artifact_error("pattern"))?;
                if known_pattern(pattern).is_none() {
                    return Err(artifact_error("unknown-pattern"));
                }
            }
            _ => {}
        }
    }
    Ok(())
}

// ── Patterns ────────────────────────────────────────────────────────────────

type Matcher = fn(&str) -> bool;

pub(crate) const PATTERN_SHA: &str = "^[0-9a-f]{40}$";
pub(crate) const PATTERN_UUID: &str =
    "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
pub(crate) const PATTERN_ID: &str = "^[a-z0-9]{24,32}$";
pub(crate) const PATTERN_SLUG: &str = "^[a-z0-9]+(-[a-z0-9]+)*$";
pub(crate) const PATTERN_CONCEPT_ID: &str = "^[a-z0-9][a-z0-9_-]{0,127}$";
pub(crate) const PATTERN_KEY: &str = "^[A-Za-z0-9_-]{16,128}$";
pub(crate) const PATTERN_ISO: &str =
    "^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2}):(\\d{2})(?:\\.(\\d{1,9}))?Z$";
pub(crate) const PATTERN_PG_TEXT: &str = "^[^\\u0000]*$";
pub(crate) const PATTERN_HASH: &str = "^sha256:[0-9a-f]{64}$";

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

fn matches_iso_shape(s: &str) -> bool {
    iso_fields(s).is_some()
}

fn known_pattern(pattern: &str) -> Option<Matcher> {
    Some(match pattern {
        PATTERN_SHA => is_sha,
        PATTERN_UUID => is_uuid,
        PATTERN_ID => is_kb_id,
        PATTERN_SLUG => is_slug,
        PATTERN_CONCEPT_ID => is_concept_id,
        PATTERN_KEY => is_idempotency_key,
        PATTERN_ISO => matches_iso_shape,
        PATTERN_HASH => is_content_hash,
        PATTERN_PG_TEXT => |s| !s.contains('\0'),
        _ => return None,
    })
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

// ── Base64 ──────────────────────────────────────────────────────────────────

fn base64_value(c: u8) -> Option<u32> {
    Some(match c {
        b'A'..=b'Z' => c - b'A',
        b'a'..=b'z' => c - b'a' + 26,
        b'0'..=b'9' => c - b'0' + 52,
        b'+' => 62,
        b'/' => 63,
        _ => return None,
    } as u32)
}

/// Decoded length of canonical standard base64 (padded, zero trailing bits),
/// or `None` when the text is not canonical.
pub(crate) fn canonical_base64_len(s: &str) -> Option<usize> {
    let b = s.as_bytes();
    if b.is_empty() || !b.len().is_multiple_of(4) {
        return None;
    }
    let padding = b.iter().rev().take_while(|&&c| c == b'=').count();
    if padding > 2 || padding == b.len() {
        return None;
    }
    let body = &b[..b.len() - padding];
    let values = body
        .iter()
        .map(|&c| base64_value(c))
        .collect::<Option<Vec<u32>>>()?;
    // The final group's unused low bits must be zero for an exact re-encoding.
    match padding {
        1 if values.last()? & 0b11 != 0 => return None,
        2 if values.last()? & 0b1111 != 0 => return None,
        _ => {}
    }
    Some(b.len() / 4 * 3 - padding)
}

// ── JSON size and depth (JavaScript `JSON.stringify` semantics) ─────────────

fn js_number_text(number: &Number) -> String {
    let Some(x) = number.as_f64() else {
        return number.to_string();
    };
    if x == 0.0 {
        return "0".to_owned();
    }
    let sign = if x < 0.0 { "-" } else { "" };
    let sci = format!("{:e}", x.abs());
    let Some((mantissa, exponent)) = sci.split_once('e') else {
        return sci;
    };
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let Ok(exponent) = exponent.parse::<i64>() else {
        return sci;
    };
    let k = digits.len() as i64;
    let n = exponent + 1;
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let rest = if k > 1 {
            format!(".{}", &digits[1..])
        } else {
            String::new()
        };
        let e_sign = if n > 0 { "+" } else { "-" };
        format!("{}{rest}e{e_sign}{}", &digits[..1], (n - 1).abs())
    };
    format!("{sign}{body}")
}

fn js_string_len(s: &str) -> usize {
    2 + s
        .chars()
        .map(|c| match c {
            '"' | '\\' | '\u{8}' | '\u{c}' | '\n' | '\r' | '\t' => 2,
            c if (c as u32) < 0x20 => 6,
            c => c.len_utf8(),
        })
        .sum::<usize>()
}

/// UTF-8 byte length of `JSON.stringify(value)`.
/// Local producers use this same representation when enforcing kb/1 limits.
pub fn js_json_len(value: &Value) -> usize {
    match value {
        Value::Null => 4,
        Value::Bool(true) => 4,
        Value::Bool(false) => 5,
        Value::Number(n) => js_number_text(n).len(),
        Value::String(s) => js_string_len(s),
        Value::Array(items) => {
            2 + items.iter().map(js_json_len).sum::<usize>() + items.len().saturating_sub(1)
        }
        Value::Object(map) => {
            2 + map
                .iter()
                .map(|(k, v)| js_string_len(k) + 1 + js_json_len(v))
                .sum::<usize>()
                + map.len().saturating_sub(1)
        }
    }
}

fn json_depth(value: &Value) -> usize {
    match value {
        Value::Array(items) => 1 + items.iter().map(json_depth).max().unwrap_or(0),
        Value::Object(map) => 1 + map.values().map(json_depth).max().unwrap_or(0),
        _ => 0,
    }
}

// ── Evaluator ───────────────────────────────────────────────────────────────

fn fail(pointer: &str, keyword: &'static str) -> Result<(), SchemaViolation> {
    fail_member(pointer, keyword, None)
}

fn fail_member(
    pointer: &str,
    keyword: &'static str,
    member: Option<String>,
) -> Result<(), SchemaViolation> {
    Err(SchemaViolation {
        pointer: pointer.to_owned(),
        keyword,
        member,
        min: None,
        max: None,
    })
}

/// Bounds from an ancestor refinement are not declarations of the value's
/// schema node. Walk the full path through this node's own properties/items:
/// if it declares the failing value, the alternative only refines it and
/// introduces no bound owner. Otherwise the selected branch owns that value, and
/// its bounds survive, including through nested content unions.
fn owned_bounds(
    node: &serde_json::Map<String, Value>,
    base: &str,
    violation: SchemaViolation,
) -> SchemaViolation {
    let Some(path) = violation
        .pointer
        .strip_prefix(base)
        .and_then(|p| p.strip_prefix('/'))
    else {
        return violation;
    };
    let mut owner = Some(node);
    for member in path.split('/') {
        owner = owner.and_then(|node| {
            if member.parse::<usize>().is_ok() {
                node.get("items")
            } else {
                node.get("properties")
                    .and_then(Value::as_object)
                    .and_then(|p| p.get(member))
            }
            .and_then(Value::as_object)
        });
    }
    if owner.is_some() {
        SchemaViolation {
            min: None,
            max: None,
            ..violation
        }
    } else {
        violation
    }
}

/// A bound violation carrying the schema's integer bounds `min_key`/`max_key`.
fn fail_bounds(
    pointer: &str,
    keyword: &'static str,
    schema: &serde_json::Map<String, Value>,
    (min_key, max_key): (&str, &str),
) -> Result<(), SchemaViolation> {
    let bound = |key: &str| schema.get(key).and_then(Value::as_i64);
    Err(SchemaViolation {
        pointer: pointer.to_owned(),
        keyword,
        member: None,
        min: bound(min_key),
        max: bound(max_key),
    })
}

fn safe_member(key: &str) -> Option<String> {
    ((1..=64).contains(&key.len()) && key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_'))
        .then(|| key.to_owned())
}

fn select<'a>(root: &'a Value, selector: &str) -> Vec<&'a Value> {
    select_at(root, selector)
        .into_iter()
        .map(|(_, v)| v)
        .collect()
}

/// [`select`] with each value's JSON pointer relative to `root` (selector
/// segments are schema-declared names; indices are array positions).
fn select_at<'a>(root: &'a Value, selector: &str) -> Vec<(String, &'a Value)> {
    let mut current = vec![(String::new(), root)];
    for segment in selector.split('.') {
        let (key, iterate) = match segment.strip_suffix("[]") {
            Some(key) => (key, true),
            None => (segment, false),
        };
        let mut next = Vec::new();
        for (at, base) in current {
            let Some(value) = base.as_object().and_then(|o| o.get(key)) else {
                continue;
            };
            let at = format!("{at}/{key}");
            if iterate {
                if let Value::Array(items) = value {
                    next.extend(
                        items
                            .iter()
                            .enumerate()
                            .map(|(index, item)| (format!("{at}/{index}"), item)),
                    );
                }
            } else {
                next.push((at, value));
            }
        }
        current = next;
    }
    current
}

/// `x-kb-change-paths`: no path twice for one kind (asset ops vs document
/// ops), and no two non-removal changes on the same case-folded path. A
/// removal may meet any case variant (resolving a case clash).
/// Returns the index of the first change that collides with an earlier one.
fn change_paths_collide(changes: &[&Value]) -> Option<usize> {
    let mut named = HashSet::new();
    let mut written = HashSet::new();
    for (index, change) in changes.iter().enumerate() {
        let op = change.get("op").and_then(Value::as_str).unwrap_or_default();
        let path = change
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let asset = matches!(op, "assetPut" | "assetRemove");
        if !named.insert((asset, path)) {
            return Some(index);
        }
        if matches!(op, "delete" | "assetRemove") {
            continue;
        }
        if !written.insert(casefold_path_key(path)) {
            return Some(index);
        }
    }
    None
}

/// JavaScript `Set` (SameValueZero) distinctness in linear expected time.
/// JSON has no NaN; zero signs compare equal and objects/arrays are distinct.
/// The index of the first item repeating an earlier one, if any.
fn unique_items(items: &[&Value]) -> Option<usize> {
    #[derive(PartialEq, Eq, Hash)]
    enum Scalar<'a> {
        Null,
        Bool(bool),
        String(&'a str),
        Number(u64),
    }
    let mut seen = HashSet::new();
    items.iter().position(|item| {
        let key = match item {
            Value::Null => Scalar::Null,
            Value::Bool(b) => Scalar::Bool(*b),
            Value::String(s) => Scalar::String(s),
            Value::Number(n) => {
                let f = n.as_f64().unwrap_or(f64::NAN);
                Scalar::Number(if f == 0.0 { 0 } else { f.to_bits() })
            }
            Value::Array(_) | Value::Object(_) => return false,
        };
        !seen.insert(key)
    })
}

/// JSON equality with JavaScript numerical semantics, for enum/const values
/// and the two copies of a kb/1 envelope in a CallToolResult.
pub(crate) fn js_equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(p, q)| js_equal(p, q))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len()
                && x.iter()
                    .zip(y.iter())
                    .all(|((ka, va), (kb, vb))| ka == kb && js_equal(va, vb))
        }
        _ => a == b,
    }
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

/// Serde's integer visitors reject integral floating JSON numbers. Canonicalize
/// only safe integral numbers before typed decoding. Fractions and unsafe
/// values retain their representation; validation runs before this traversal.
/// Open user JSON retains the same numerical value, as in JSON.stringify.
pub(crate) fn normalize_integers(mut value: Value) -> Value {
    match &mut value {
        Value::Number(_) => {
            if let Some(n) = safe_integer(&value) {
                value = Value::from(n);
            }
        }
        Value::Array(items) => {
            for item in items {
                *item = normalize_integers(std::mem::take(item));
            }
        }
        Value::Object(record) => {
            for item in record.values_mut() {
                *item = normalize_integers(std::mem::take(item));
            }
        }
        _ => {}
    }
    value
}

fn is_integer(value: &Value) -> bool {
    match value {
        Value::Number(n) => {
            n.is_i64()
                || n.is_u64()
                || n.as_f64()
                    .is_some_and(|f| f.is_finite() && f.fract() == 0.0)
        }
        _ => false,
    }
}

fn type_matches(ty: &str, value: &Value) -> bool {
    match ty {
        "object" => value.is_object(),
        "array" => value.is_array(),
        "string" => value.is_string(),
        "integer" => is_integer(value),
        "number" => value.is_number(),
        "boolean" => value.is_boolean(),
        "null" => value.is_null(),
        _ => false,
    }
}

fn as_usize(value: &Value) -> Option<usize> {
    value.as_u64().and_then(|n| usize::try_from(n).ok())
}

fn check_portable(
    schema: &Map<String, Value>,
    value: &Value,
    pointer: &str,
) -> Result<(), SchemaViolation> {
    if let Value::String(s) = value {
        if let Some(max) = schema.get("x-kb-utf8-max-bytes").and_then(as_usize)
            && s.len() > max
        {
            return fail(pointer, "x-kb-utf8-max-bytes");
        }
        if schema.get("x-kb-no-control-chars") == Some(&Value::Bool(true))
            && s.chars()
                .any(|c| (c as u32) < 32 && !matches!(c, '\t' | '\n' | '\r'))
        {
            return fail(pointer, "x-kb-no-control-chars");
        }
        if let Some(field) = schema.get("x-kb-metadata-text").and_then(Value::as_str) {
            let forbidden = match field {
                "name" => s.chars().any(|c| (c as u32) < 32 || c == '\u{7f}'),
                "description" => s.chars().any(|c| {
                    c == '\u{7f}' || ((c as u32) < 32 && !matches!(c, '\t' | '\n' | '\r'))
                }),
                _ => return fail(pointer, "x-kb-metadata-text"),
            };
            if forbidden {
                return fail(pointer, "x-kb-metadata-text");
            }
        }
        if let Some(bounds) = schema.get("x-kb-base64-canonical") {
            let min = bounds.get("minBytes").and_then(as_usize).unwrap_or(0);
            let max = bounds.get("maxBytes").and_then(as_usize).unwrap_or(0);
            match canonical_base64_len(s) {
                Some(len) if (min..=max).contains(&len) => {}
                _ => return fail(pointer, "x-kb-base64-canonical"),
            }
        }
        if schema.get("x-kb-path") == Some(&Value::Bool(true)) && check_kb_path(s).is_err() {
            return fail(pointer, "x-kb-path");
        }
        if schema.get("x-kb-path-prefix") == Some(&Value::Bool(true))
            && check_kb_path(s.strip_suffix('/').unwrap_or(s)).is_err()
        {
            return fail(pointer, "x-kb-path-prefix");
        }
        if schema.get("x-kb-iso-utc-instant") == Some(&Value::Bool(true))
            && parse_iso_instant(s).is_none()
        {
            return fail(pointer, "x-kb-iso-utc-instant");
        }
    }
    if value.is_object() || value.is_array() {
        if let Some(max) = schema.get("x-kb-json-encoded-max-bytes").and_then(as_usize)
            && js_json_len(value) > max
        {
            return fail(pointer, "x-kb-json-encoded-max-bytes");
        }
        if let Some(max) = schema.get("x-kb-json-depth-max").and_then(as_usize)
            && json_depth(value) > max
        {
            return fail(pointer, "x-kb-json-depth-max");
        }
        if let Some(range) = schema.get("x-kb-iso-range") {
            let after = range
                .get("after")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let before = range
                .get("before")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let after_values = select(value, after);
            let before_values = select(value, before);
            if let (Some(a), Some(b)) = (after_values.first(), before_values.first()) {
                let order = match (a.as_str(), b.as_str()) {
                    (Some(a), Some(b)) => compare_iso(a, b),
                    _ => None,
                };
                if order != Some(std::cmp::Ordering::Less) {
                    return fail(pointer, "x-kb-iso-range");
                }
            }
        }
    }
    Ok(())
}

fn check(schema: &Value, value: &Value, pointer: &mut String) -> Result<(), SchemaViolation> {
    let schema = match schema {
        Value::Bool(true) => return Ok(()),
        Value::Bool(false) => return fail(pointer, "false"),
        Value::Object(object) => object,
        _ => return fail(pointer, "schema-node"),
    };

    match schema.get("type") {
        Some(Value::String(ty)) if !type_matches(ty, value) => return fail(pointer, "type"),
        Some(Value::Array(types))
            if !types
                .iter()
                .any(|t| t.as_str().is_some_and(|t| type_matches(t, value))) =>
        {
            return fail(pointer, "type");
        }
        _ => {}
    }
    // Canonical selection order (docs/mcp.md): scalar bounds before
    // portable refinements, independently of validation-library issue order.
    if let Value::String(s) = value {
        let scalars = s.chars().count();
        if schema
            .get("minLength")
            .and_then(as_usize)
            .is_some_and(|min| scalars < min)
        {
            return fail_bounds(pointer, "minLength", schema, ("minLength", "maxLength"));
        }
        if schema
            .get("maxLength")
            .and_then(as_usize)
            .is_some_and(|max| scalars > max)
        {
            return fail_bounds(pointer, "maxLength", schema, ("minLength", "maxLength"));
        }
    }
    check_portable(schema, value, pointer)?;

    if let Some(options) = schema.get("enum").and_then(Value::as_array)
        && !options.iter().any(|option| js_equal(option, value))
    {
        return fail(pointer, "enum");
    }
    if let Some(constant) = schema.get("const")
        && !js_equal(constant, value)
    {
        return fail(pointer, "const");
    }

    match value {
        Value::String(s) => {
            if let Some(pattern) = schema.get("pattern").and_then(Value::as_str) {
                match known_pattern(pattern) {
                    Some(matcher) if matcher(s) => {}
                    _ => {
                        return fail_bounds(pointer, "pattern", schema, ("minLength", "maxLength"));
                    }
                }
            }
        }
        Value::Number(n) => {
            let x = n.as_f64().unwrap_or(f64::NAN);
            if schema
                .get("minimum")
                .and_then(Value::as_f64)
                .is_some_and(|min| x < min || x.is_nan())
            {
                return fail_bounds(pointer, "minimum", schema, ("minimum", "maximum"));
            }
            if schema
                .get("maximum")
                .and_then(Value::as_f64)
                .is_some_and(|max| x > max || x.is_nan())
            {
                return fail_bounds(pointer, "maximum", schema, ("minimum", "maximum"));
            }
        }
        Value::Array(items) => {
            if schema
                .get("minItems")
                .and_then(as_usize)
                .is_some_and(|min| items.len() < min)
            {
                return fail_bounds(pointer, "minItems", schema, ("minItems", "maxItems"));
            }
            if schema
                .get("maxItems")
                .and_then(as_usize)
                .is_some_and(|max| items.len() > max)
            {
                return fail_bounds(pointer, "maxItems", schema, ("minItems", "maxItems"));
            }
            if let Some(item_schema) = schema.get("items") {
                for (index, item) in items.iter().enumerate() {
                    let len = pointer.len();
                    pointer.push_str(&format!("/{index}"));
                    check(item_schema, item, pointer)?;
                    pointer.truncate(len);
                }
            }
        }
        Value::Object(record) => {
            let empty = Map::new();
            let properties = schema
                .get("properties")
                .and_then(Value::as_object)
                .unwrap_or(&empty);
            for (key, property_schema) in properties {
                if let Some(child) = record.get(key) {
                    let len = pointer.len();
                    pointer.push('/');
                    pointer.push_str(key);
                    check(property_schema, child, pointer)?;
                    pointer.truncate(len);
                }
            }
            if let Some(required) = schema.get("required").and_then(Value::as_array)
                && let Some(missing) = required
                    .iter()
                    .filter_map(Value::as_str)
                    .find(|key| !record.contains_key(*key))
            {
                return fail_member(pointer, "required", safe_member(missing));
            }
            let additional = schema.get("additionalProperties");
            for (key, child) in record {
                if properties.contains_key(key) {
                    continue;
                }
                match additional {
                    Some(Value::Bool(false)) => {
                        return fail_member(pointer, "additionalProperties", safe_member(key));
                    }
                    None | Some(Value::Bool(true)) => {}
                    Some(additional_schema) => {
                        // Caller-chosen keys never enter the pointer.
                        let len = pointer.len();
                        pointer.push_str("/*");
                        check(additional_schema, child, pointer)?;
                        pointer.truncate(len);
                    }
                }
            }
            if let Some(names) = schema.get("propertyNames") {
                for key in record.keys() {
                    if check(names, &Value::String(key.clone()), &mut pointer.clone()).is_err() {
                        return fail(pointer, "propertyNames");
                    }
                }
            }
        }
        _ => {}
    }

    let base = pointer.clone();
    let passes = |sub: &Value| check(sub, value, &mut base.clone()).is_ok();
    // When no branch matches, report the most specific branch violation (a
    // deeper pointer) so a caller learns which member was wrong; otherwise
    // the combinator itself.
    let deepest = |options: &[Value], keyword: &'static str| {
        // A discriminated variant (every `const` member it declares matches
        // the value, as an `op` does) owns the diagnostic, as on the server.
        let discriminated = options.iter().find(|option| {
            let Some(properties) = option.get("properties").and_then(Value::as_object) else {
                return false;
            };
            let mut consts = properties
                .iter()
                .filter_map(|(key, sub)| sub.get("const").map(|c| (key, c)))
                .peekable();
            consts.peek().is_some()
                && consts.all(|(key, expected)| value.get(key) == Some(expected))
        });
        if let Some(option) = discriminated
            && let Err(violation) = check(option, value, &mut base.clone())
        {
            return Err(violation);
        }
        let mut best: Option<SchemaViolation> = None;
        for option in options {
            if let Err(violation) = check(option, value, &mut base.clone())
                && violation.pointer.len() > base.len()
                && best
                    .as_ref()
                    .is_none_or(|b| violation.pointer.len() > b.pointer.len())
            {
                best = Some(violation);
            }
        }
        match best {
            Some(violation) => Err(owned_bounds(schema, &base, violation)),
            None => fail(&base, keyword),
        }
    };
    if let Some(options) = schema.get("anyOf").and_then(Value::as_array)
        && !options.iter().any(passes)
    {
        return deepest(options, "anyOf");
    }
    let own =
        |result: Result<(), SchemaViolation>| result.map_err(|v| owned_bounds(schema, &base, v));
    if let Some(options) = schema.get("allOf").and_then(Value::as_array) {
        for option in options {
            own(check(option, value, pointer))?;
        }
    }
    if let Some(options) = schema.get("oneOf").and_then(Value::as_array) {
        match options.iter().filter(|option| passes(option)).count() {
            1 => {}
            0 => return deepest(options, "oneOf"),
            _ => return fail(pointer, "oneOf"),
        }
    }
    if let Some(negated) = schema.get("not")
        && passes(negated)
    {
        return fail(pointer, "not");
    }
    if let Some(condition) = schema.get("if") {
        let branch = if passes(condition) {
            schema.get("then")
        } else {
            schema.get("else")
        };
        if let Some(branch) = branch {
            own(check(branch, value, pointer))?;
        }
    }
    // All selected arrays/items have passed their bounds before distinctness.
    if value.is_object() || value.is_array() {
        if let Some(selectors) = schema.get("x-kb-unique-items").and_then(Value::as_array) {
            for selector in selectors.iter().filter_map(Value::as_str) {
                let items = select_at(value, selector);
                let values: Vec<&Value> = items.iter().map(|(_, v)| *v).collect();
                if let Some(index) = unique_items(&values) {
                    // `field`: the repeated item (the second occurrence).
                    return fail(&format!("{pointer}{}", items[index].0), "x-kb-unique-items");
                }
            }
        }
        if let Some(selectors) = schema.get("x-kb-change-paths").and_then(Value::as_array) {
            for selector in selectors.iter().filter_map(Value::as_str) {
                let items = select_at(value, selector);
                let values: Vec<&Value> = items.iter().map(|(_, v)| *v).collect();
                if let Some(index) = change_paths_collide(&values) {
                    // `field`: the colliding change's path (the second spelling).
                    let at = format!("{pointer}{}/path", items[index].0);
                    return fail(&at, "x-kb-change-paths");
                }
            }
        }
    }
    Ok(())
}

/// Canonicalize the registry ID at input boundaries, before profile decisions.
pub fn canonical_provider_ref(value: &str) -> &str {
    if artifact().is_ok_and(|a| value == a.builtin_id) {
        crate::types::ProviderRef::BUILTIN
    } else {
        value
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn scalar_distinctness_preserves_same_value_zero_semantics() {
        for value in [
            json!([1, 1.0]),
            json!([0, -0.0]),
            json!([null, null]),
            json!([true, true]),
            json!(["id", "id"]),
        ] {
            assert_eq!(
                unique_items(&value.as_array().unwrap().iter().collect::<Vec<_>>()),
                Some(1)
            );
        }
        let distinct = json!([1, 2.0, 0, true, false, null, "1", "2", {}, {}, [], []]);
        assert_eq!(
            unique_items(&distinct.as_array().unwrap().iter().collect::<Vec<_>>()),
            None
        );
    }

    #[test]
    fn normalization_preserves_fractions_and_open_json_numeric_values() {
        let value = json!({"nested":[-0.0, 1.0, 1.5, 1e100, -9007199254740991.0]});
        let normalized = normalize_integers(value.clone());
        assert_eq!(normalized["nested"][0].as_i64(), Some(0));
        assert_eq!(normalized["nested"][1].as_i64(), Some(1));
        assert_eq!(normalized["nested"][2], value["nested"][2]);
        assert_eq!(normalized["nested"][3], value["nested"][3]);
        assert_eq!(normalized["nested"][4].as_i64(), Some(-MAX_SAFE_INTEGER));
        assert!(js_equal(&value, &normalized));
    }

    #[test]
    fn embedded_artifact_loads_and_is_fully_understood() {
        let names = artifact_tool_names().expect("artifact passes the fail-closed audit");
        assert_eq!(names.len(), crate::ToolName::ALL.len());
    }

    #[test]
    fn artifact_groups_are_read_and_fail_closed() {
        let tools_in = |group: &str| -> Vec<&str> {
            crate::ToolName::ALL
                .iter()
                .map(|name| name.as_str())
                .filter(|name| tool_groups(name).expect("grouped").contains(&group))
                .collect()
        };
        assert_eq!(
            tools_in("read"),
            [
                "knowledge_documents_list",
                "knowledge_documents_get",
                "knowledge_search",
                "knowledge_structured_search"
            ]
        );
        assert_eq!(
            tool_groups("knowledge_upload_begin").expect("grouped"),
            ["edit", "assets"]
        );
        assert!(
            tool_groups("knowledge_bases_list")
                .expect("grouped")
                .is_empty()
        );
        assert!(
            tool_groups("knowledge_bases_get")
                .expect("grouped")
                .is_empty()
        );
        for group in TOOL_GROUPS {
            assert!(!tools_in(group).is_empty(), "{group} governs no tool");
        }
        let row = |groups: Value| json!({"catalog": {"groups": groups}});
        assert!(catalog_groups(&row(json!(["read", "sealed"]))).is_ok());
        for bad in [
            json!(null),
            json!("read"),
            json!(["admin"]),
            json!(["assets", "edit"]),
            json!(["read", "read"]),
            json!([1]),
        ] {
            assert!(catalog_groups(&row(bad.clone())).is_err(), "{bad}");
        }
    }

    #[test]
    fn artifact_presets_are_read_from_the_generated_catalog() {
        // The artifact is generated from `packages/auth/src/mcp-tool-groups.ts`
        // (`pnpm kb:protocol:check` guards it); this pins what the CLI reads.
        assert_eq!(preset_names().unwrap(), ["direct", "propose", "read"]);
        assert_eq!(preset_groups("read").unwrap(), Some(&["read"][..]));
        assert_eq!(
            preset_groups("propose").unwrap(),
            Some(&["read", "edit", "pull_requests"][..])
        );
        assert_eq!(
            preset_groups("direct").unwrap(),
            Some(&["read", "edit", "assets", "pull_requests"][..])
        );
        assert_eq!(preset_groups("admin").unwrap(), None);
        assert_eq!(preset_groups("edit").unwrap(), None);
    }

    #[test]
    fn audit_rejects_unknown_keywords_and_patterns() {
        assert!(audit_schema(&json!({ "type": "string", "format": "email" })).is_err());
        assert!(audit_schema(&json!({ "pattern": "^.*$" })).is_err());
        assert!(audit_schema(&json!({ "properties": { "a": { "x-kb-new": true } } })).is_err());
        assert!(audit_schema(&json!({ "pattern": PATTERN_SHA })).is_ok());
    }

    #[test]
    fn javascript_number_text_matches_number_to_string() {
        for (value, text) in [
            (json!(0), "0"),
            (json!(-0.0), "0"),
            (json!(1.0), "1"),
            (json!(1.5), "1.5"),
            (json!(0.000001), "0.000001"),
            (json!(1e-7), "1e-7"),
            (json!(1e21), "1e+21"),
            (json!(123456789012345680000.0), "123456789012345680000"),
            (json!(-2.5e-10), "-2.5e-10"),
            (json!(9007199254740993u64), "9007199254740992"),
        ] {
            let Value::Number(n) = value else {
                unreachable!()
            };
            assert_eq!(js_number_text(&n), text);
        }
    }

    #[test]
    fn json_length_counts_javascript_escapes() {
        let value = json!({ "a": "é\n\u{1}\"", "b": [1, true, null] });
        let js = r#"{"a":"é\n\u0001\"","b":[1,true,null]}"#;
        assert_eq!(js_json_len(&value), js.len());
    }

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

    #[test]
    fn base64_must_be_canonical() {
        assert_eq!(canonical_base64_len("Zm9v"), Some(3));
        assert_eq!(canonical_base64_len("Zm8="), Some(2));
        assert_eq!(canonical_base64_len("Zg=="), Some(1));
        for bad in [
            "", "Zg", "Zh==", "Zm9=", "Zg===", "====", "Z===", "_-8=", "Zm9v\n", "Z=g=",
        ] {
            assert_eq!(canonical_base64_len(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn violations_never_name_caller_keys() {
        let schema = json!({
            "type": "object",
            "additionalProperties": { "type": "string" }
        });
        let err = check(
            &schema,
            &json!({ "SECRET_KEY_NAME": 1 }),
            &mut String::new(),
        )
        .unwrap_err();
        assert!(!err.to_string().contains("SECRET"));
        let closed = json!({ "type": "object", "properties": {}, "additionalProperties": false });
        let err = check(
            &closed,
            &json!({ "SECRET_KEY_NAME": 1 }),
            &mut String::new(),
        )
        .unwrap_err();
        assert!(!err.to_string().contains("SECRET"));
    }
}
