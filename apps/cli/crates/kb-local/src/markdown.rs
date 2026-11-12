//! Markdown source and restricted YAML front matter — a faithful port of
//! `packages/api/src/lib/kb/parse-markdown.ts` so local and remote reach the
//! same decision on every document (shared corpus: `tests/trees.rs`).
//!
//! The YAML subset decodes quoted keys/scalars, rejects tags, anchors,
//! aliases, merge keys, directives and duplicate decoded keys anywhere
//! (including flow collections), caps YAML and final JSON at 64 KiB and depth 16 during
//! parsing and never reinterprets an unsupported construct as a string.
//! JavaScript semantics are reproduced where they decide validity: UTF-16
//! length for document IDs, `Number` parsing and the safe-integer bound, and
//! surrogate pairing of `\u` escapes.

use serde_json::{Map, Number, Value};
use std::collections::HashSet;

use kb_client::types::{ContentHash, DocCitation, KbPath, Sha};

pub const FRONTMATTER_MAX_BYTES: usize = 64 * 1024;
pub const FRONTMATTER_MAX_DEPTH: usize = 16;
pub const MAX_CITATIONS: usize = 100;
pub const MAX_CITATION_LABEL_SCALARS: usize = 240;
pub const MAX_CITATION_TARGET_SCALARS: usize = 2048;
/// Measured in UTF-16 code units, like the TypeScript `string.length`.
pub const MAX_DOCUMENT_ID_UNITS: usize = 256;

const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
const FORBIDDEN_YAML_KEYS: [&str; 3] = ["__proto__", "constructor", "prototype"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MarkdownIssueCode {
    Utf8,
    Control,
    FrontmatterSize,
    Yaml,
    YamlDepth,
    YamlDuplicate,
    YamlTag,
    YamlAlias,
    JsonValue,
    DocumentId,
    Citations,
    CitationShape,
}

impl MarkdownIssueCode {
    /// The reason for this issue, exactly as the server maps it.
    pub fn reason(self) -> kb_client::error::InvalidReason {
        use kb_client::error::InvalidReason;
        match self {
            MarkdownIssueCode::Control => InvalidReason::ControlCharacter,
            MarkdownIssueCode::Utf8 => InvalidReason::InvalidMarkdown,
            _ => InvalidReason::InvalidFrontMatter,
        }
    }
}

/// Why a Markdown source was rejected. Messages never quote source content
/// beyond a duplicate key name.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MarkdownIssue {
    pub code: MarkdownIssueCode,
    pub message: String,
}

fn issue(code: MarkdownIssueCode, message: impl Into<String>) -> MarkdownIssue {
    MarkdownIssue {
        code,
        message: message.into(),
    }
}

fn yaml_issue(message: &str) -> MarkdownIssue {
    issue(MarkdownIssueCode::Yaml, message)
}

fn alias_issue() -> MarkdownIssue {
    issue(
        MarkdownIssueCode::YamlAlias,
        "front matter must not use YAML anchors or aliases",
    )
}

fn tag_issue() -> MarkdownIssue {
    issue(
        MarkdownIssueCode::YamlTag,
        "front matter must not use YAML tags",
    )
}

fn depth_issue() -> MarkdownIssue {
    issue(
        MarkdownIssueCode::YamlDepth,
        "front matter exceeds depth limit",
    )
}

/// JSON-safe front matter value.
#[derive(Clone, Debug, PartialEq)]
pub enum YamlValue {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Seq(Vec<YamlValue>),
    Map(YamlMap),
}

/// Insertion-ordered mapping with unique keys.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct YamlMap {
    entries: Vec<(String, YamlValue)>,
}

impl YamlMap {
    pub fn get(&self, key: &str) -> Option<&YamlValue> {
        self.entries.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    pub fn entries(&self) -> &[(String, YamlValue)] {
        &self.entries
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

/// JS number semantics: integral values within the safe range serialize as
/// integers (`JSON.stringify(2) === "2"`).
pub(crate) fn json_number(value: f64) -> Value {
    const SAFE: f64 = 9_007_199_254_740_991.0;
    if value.fract() == 0.0 && value.abs() <= SAFE {
        // Exact: |value| <= 2^53 - 1.
        #[allow(clippy::cast_possible_truncation)]
        return Value::Number(Number::from(value as i64));
    }
    Number::from_f64(value).map_or(Value::Null, Value::Number)
}

fn yaml_to_json(value: &YamlValue) -> Value {
    match value {
        YamlValue::Null => Value::Null,
        YamlValue::Bool(b) => Value::Bool(*b),
        YamlValue::Number(n) => json_number(*n),
        YamlValue::String(s) => Value::String(s.clone()),
        YamlValue::Seq(items) => Value::Array(items.iter().map(yaml_to_json).collect()),
        YamlValue::Map(map) => Value::Object(map_to_json(map)),
    }
}

pub(crate) fn map_to_json(map: &YamlMap) -> Map<String, Value> {
    map.entries()
        .iter()
        .map(|(k, v)| (k.clone(), yaml_to_json(v)))
        .collect()
}

/// A parsed Markdown document.
#[derive(Clone, Debug, PartialEq)]
pub struct ParsedMarkdown {
    pub front_matter: YamlMap,
    /// UTF-8 byte offset of the body (after the closing front matter
    /// delimiter line), `0` without front matter.
    pub body_start: usize,
    pub document_id: Option<String>,
    pub citations: Vec<DocCitation>,
}

/// Immutable source of one document at one commit. Spans are never part of
/// it: they come from an index generation pinned to this commit.
#[derive(Clone, Debug, PartialEq)]
pub struct SourceDocument {
    pub path: KbPath,
    pub commit_sha: Sha,
    pub blob_sha: Sha,
    /// SHA-256 of the exact full source bytes, front matter included.
    pub content_hash: ContentHash,
    pub markdown: String,
    pub front_matter: YamlMap,
    pub body_start: usize,
    pub document_id: Option<String>,
    pub citations: Vec<DocCitation>,
}

impl SourceDocument {
    /// Body text (source bytes after the front matter).
    pub fn body(&self) -> &str {
        self.markdown.get(self.body_start..).unwrap_or_default()
    }
}

/// Caller supplies admitted source and manifest from one reachable commit.
pub struct ConversionInput<'a> {
    pub media_type: &'a str,
    pub bytes: &'a [u8],
    pub path: &'a KbPath,
    pub commit_sha: &'a Sha,
    pub commit_timestamp: &'a str,
    pub manifest_commit_sha: &'a Sha,
    pub manifest_entries: &'a [crate::tree::ManifestEntry],
}
#[derive(Debug)]
pub struct ConvertedSource {
    pub source: SourceDocument,
    pub asset_refs: Vec<kb_client::types::AssetRef>,
    pub chunked: crate::chunk::ChunkedBody,
    pub structured: crate::structured::StructuredDocument,
}
#[derive(Debug)]
pub enum ConversionError {
    UnsupportedMedia,
    InvalidSource,
}
impl ConversionError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::UnsupportedMedia => "UNSUPPORTED_MEDIA",
            Self::InvalidSource => "INVALID_ARGUMENT",
        }
    }
}
impl std::fmt::Display for ConversionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code())
    }
}
impl std::error::Error for ConversionError {}
pub fn convert_source(input: &ConversionInput<'_>) -> Result<ConvertedSource, ConversionError> {
    if input.media_type != "text/markdown" {
        return Err(ConversionError::UnsupportedMedia);
    }
    if input.bytes.len() > crate::git_read::DOCUMENT_MAX_BYTES
        || input.commit_sha != input.manifest_commit_sha
    {
        return Err(ConversionError::InvalidSource);
    }
    let parsed = parse_markdown(input.bytes).map_err(|_| ConversionError::InvalidSource)?;
    let markdown = std::str::from_utf8(input.bytes).map_err(|_| ConversionError::InvalidSource)?;
    let body = &markdown[parsed.body_start..];
    let refs = crate::manifest::referenced_paths(body, input.path.as_str());
    let asset_refs = input
        .manifest_entries
        .iter()
        .filter(|e| refs.contains(&e.path))
        .map(crate::manifest::asset_ref)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| ConversionError::InvalidSource)?;
    let structured =
        crate::structured::extract_structured_document(&parsed, body, input.commit_timestamp)
            .map_err(|_| ConversionError::InvalidSource)?;
    Ok(ConvertedSource {
        chunked: crate::chunk::chunk_body(body),
        structured,
        asset_refs,
        source: SourceDocument {
            path: input.path.clone(),
            commit_sha: input.commit_sha.clone(),
            blob_sha: kb_client::snapshot::git_blob_sha(input.bytes),
            content_hash: kb_client::snapshot::content_hash(input.bytes),
            markdown: markdown.into(),
            front_matter: parsed.front_matter,
            body_start: parsed.body_start,
            document_id: parsed.document_id,
            citations: parsed.citations,
        },
    })
}
/// Internal unsupported-media errors project to the common tool code.
pub fn convert_markdown_source(
    input: &ConversionInput<'_>,
) -> Result<ConvertedSource, crate::StoreError> {
    convert_source(input)
        .map_err(|_| crate::StoreError::InvalidArgument("invalid Markdown source or media".into()))
}

/// Split into optional YAML bytes and the body start offset. Delimiters are
/// located in the raw bytes, so multibyte front matter never shifts the body.
pub fn split_front_matter(bytes: &[u8]) -> (Option<&[u8]>, usize) {
    let at = |i: usize| bytes.get(i).copied();
    if bytes.is_empty() || at(0) != Some(b'-') || at(1) != Some(b'-') || at(2) != Some(b'-') {
        return (None, 0);
    }
    if bytes.len() > 3 && at(3) != Some(b'\n') && !(at(3) == Some(b'\r') && at(4) == Some(b'\n')) {
        return (None, 0);
    }
    let Some(open_end) = find_byte(bytes, b'\n', 3) else {
        return (None, 0);
    };
    let yaml_start = open_end + 1;
    let mut close = None;
    let mut cursor = yaml_start;
    while cursor <= bytes.len() {
        let lf = find_byte(bytes, b'\n', cursor);
        let line_end = lf.unwrap_or(bytes.len());
        let line = &bytes[cursor..line_end];
        let dash_end = if line.last() == Some(&b'\r') {
            line.len() - 1
        } else {
            line.len()
        };
        if dash_end == 3 && line.starts_with(b"---") {
            close = Some(cursor);
            break;
        }
        match lf {
            Some(lf) => cursor = lf + 1,
            None => break,
        }
    }
    let Some(close) = close else {
        return (None, 0);
    };
    let yaml_end = close + 3;
    let body_start = if at(yaml_end) == Some(b'\r') && at(yaml_end + 1) == Some(b'\n') {
        yaml_end + 2
    } else if at(yaml_end) == Some(b'\n') {
        yaml_end + 1
    } else if yaml_end == bytes.len() {
        yaml_end
    } else {
        return (None, 0);
    };
    (Some(&bytes[yaml_start..close]), body_start)
}

fn find_byte(bytes: &[u8], needle: u8, from: usize) -> Option<usize> {
    bytes
        .get(from..)?
        .iter()
        .position(|b| *b == needle)
        .map(|i| i + from)
}

fn is_forbidden_control(c: char) -> bool {
    c == '\u{7f}' || ((c as u32) < 0x20 && c != '\t' && c != '\n' && c != '\r')
}

/// Strict UTF-8 (a leading BOM is kept as content) without C0 controls other
/// than tab/CR/LF, and without DEL.
pub fn validate_markdown_bytes(bytes: &[u8]) -> Result<&str, MarkdownIssue> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| issue(MarkdownIssueCode::Utf8, "markdown must be valid UTF-8"))?;
    if text.chars().any(is_forbidden_control) {
        return Err(issue(
            MarkdownIssueCode::Control,
            "markdown contains forbidden control characters",
        ));
    }
    Ok(text)
}

/// Parse and validate one Markdown document (same rules as the server).
pub fn parse_markdown(bytes: &[u8]) -> Result<ParsedMarkdown, MarkdownIssue> {
    validate_markdown_bytes(bytes)?;
    let (yaml, body_start) = split_front_matter(bytes);
    let mut front_matter = YamlMap::default();
    if let Some(yaml) = yaml {
        if yaml.len() > FRONTMATTER_MAX_BYTES {
            return Err(issue(
                MarkdownIssueCode::FrontmatterSize,
                "front matter exceeds size limit",
            ));
        }
        let text = std::str::from_utf8(yaml)
            .map_err(|_| issue(MarkdownIssueCode::Utf8, "markdown must be valid UTF-8"))?;
        front_matter = YamlParser::parse(text)?;
    }
    for (_, value) in &front_matter.entries {
        assert_json_safe(value, 2)?;
    }
    // The portable contract counts JSON.stringify bytes, including its
    // decimal/scientific number spelling, rather than serde's wire spelling.
    if kb_client::schema::js_json_len(&Value::Object(map_to_json(&front_matter)))
        > FRONTMATTER_MAX_BYTES
    {
        return Err(issue(
            MarkdownIssueCode::FrontmatterSize,
            "front matter exceeds encoded size limit",
        ));
    }
    let document_id = match front_matter.get("id") {
        None | Some(YamlValue::Null) => None,
        Some(YamlValue::String(id)) => {
            let units = id.encode_utf16().count();
            if units == 0 || units > MAX_DOCUMENT_ID_UNITS {
                return Err(issue(
                    MarkdownIssueCode::DocumentId,
                    "document id length is invalid",
                ));
            }
            Some(id.clone())
        }
        Some(_) => {
            return Err(issue(
                MarkdownIssueCode::DocumentId,
                "document id must be a string",
            ));
        }
    };
    let citations = match front_matter.get("citations") {
        None => Vec::new(),
        Some(value) => parse_citations(value)?,
    };
    Ok(ParsedMarkdown {
        front_matter,
        body_start,
        document_id,
        citations,
    })
}

fn parse_citations(value: &YamlValue) -> Result<Vec<DocCitation>, MarkdownIssue> {
    let YamlValue::Seq(items) = value else {
        return Err(issue(
            MarkdownIssueCode::Citations,
            "citations must be an array",
        ));
    };
    if items.len() > MAX_CITATIONS {
        return Err(issue(
            MarkdownIssueCode::Citations,
            "citations exceed limit",
        ));
    }
    let shape = |message: &str| issue(MarkdownIssueCode::CitationShape, message);
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        let YamlValue::Map(row) = item else {
            return Err(shape("citation must be an object"));
        };
        if row.len() != 2 || row.get("label").is_none() || row.get("target").is_none() {
            return Err(shape("citation must contain only label and target"));
        }
        let (Some(YamlValue::String(label)), Some(YamlValue::String(target))) =
            (row.get("label"), row.get("target"))
        else {
            return Err(shape("citation requires label and target"));
        };
        if label.chars().count() > MAX_CITATION_LABEL_SCALARS {
            return Err(shape("citation label is too long"));
        }
        if target.chars().count() > MAX_CITATION_TARGET_SCALARS {
            return Err(shape("citation target is too long"));
        }
        out.push(DocCitation {
            label: label.clone(),
            target: target.clone(),
        });
    }
    Ok(out)
}

/// Depth counts containers, including the root mapping (depth 1).
fn assert_json_safe(value: &YamlValue, depth: usize) -> Result<(), MarkdownIssue> {
    match value {
        YamlValue::Null | YamlValue::Bool(_) | YamlValue::String(_) => Ok(()),
        YamlValue::Number(n) => {
            if !n.is_finite() {
                return Err(issue(
                    MarkdownIssueCode::JsonValue,
                    "front matter numbers must be finite",
                ));
            }
            if n.fract() == 0.0 && n.abs() > MAX_SAFE_INTEGER {
                return Err(issue(
                    MarkdownIssueCode::JsonValue,
                    "front matter integers must be safe",
                ));
            }
            Ok(())
        }
        YamlValue::Seq(_) | YamlValue::Map(_) if depth > FRONTMATTER_MAX_DEPTH => {
            Err(depth_issue())
        }
        YamlValue::Seq(items) => items
            .iter()
            .try_for_each(|v| assert_json_safe(v, depth + 1)),
        YamlValue::Map(map) => map
            .entries
            .iter()
            .try_for_each(|(_, v)| assert_json_safe(v, depth + 1)),
    }
}

// ── Sealed references ──────────────────────────────────────────────────────

const SEALED_PREFIX: &str = "sealed:v1:knowledge_base:";

/// Every `{{sealed:v1:knowledge_base:<36>:<36>}}` reference in `text`
/// (prefix ASCII case-insensitive, like the TS `/gi` pattern), normalized to
/// `sealed:v1:knowledge_base:<a>:<b>`, leftmost non-overlapping.
pub fn find_sealed_references(text: &str) -> Vec<String> {
    sealed_ranges(text)
        .into_iter()
        .map(|r| {
            let token = &text[r.start + 2..r.end - 2];
            format!("{SEALED_PREFIX}{}", &token[SEALED_PREFIX.len()..])
        })
        .collect()
}

pub(crate) fn sealed_ranges(text: &str) -> Vec<std::ops::Range<usize>> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    // Skip ordinary Markdown with the standard substring search instead of
    // attempting the full pattern at every byte of a potentially 2 MiB file.
    // The ASCII opener and match end keep all slicing on UTF-8 boundaries.
    while let Some(offset) = text[i..].find("{{") {
        i += offset;
        if let Some((end, _, _)) = match_sealed_at(bytes, i) {
            out.push(i..end);
            i = end;
        } else {
            i += 1;
        }
    }
    out
}

fn match_sealed_at(bytes: &[u8], start: usize) -> Option<(usize, &str, &str)> {
    let rest = bytes.get(start..)?;
    let rest = rest.strip_prefix(b"{{")?;
    let prefix = rest.get(..SEALED_PREFIX.len())?;
    if !prefix.eq_ignore_ascii_case(SEALED_PREFIX.as_bytes()) {
        return None;
    }
    let rest = &rest[SEALED_PREFIX.len()..];
    let uuidish = |s: &[u8]| s.len() == 36 && s.iter().all(|c| c.is_ascii_hexdigit() || *c == b'-');
    let a = rest.get(..36)?;
    if !uuidish(a) || rest.get(36) != Some(&b':') {
        return None;
    }
    let b = rest.get(37..73)?;
    if !uuidish(b) || rest.get(73..75) != Some(b"}}".as_slice()) {
        return None;
    }
    let end = start + 2 + SEALED_PREFIX.len() + 75;
    Some((
        end,
        std::str::from_utf8(a).ok()?,
        std::str::from_utf8(b).ok()?,
    ))
}

/// References found in the raw source (comments, keys, raw values) plus the
/// decoded front matter keys and string values (escape-encoded references
/// never appear literally in the bytes). Order: raw source first.
pub fn sealed_references_in(parsed: &ParsedMarkdown, raw_source: &str) -> Vec<String> {
    let mut out = find_sealed_references(raw_source);
    fn walk(value: &YamlValue, out: &mut Vec<String>) {
        match value {
            YamlValue::String(s) => out.extend(find_sealed_references(s)),
            YamlValue::Seq(items) => items.iter().for_each(|v| walk(v, out)),
            YamlValue::Map(map) => {
                for (k, v) in &map.entries {
                    out.extend(find_sealed_references(k));
                    walk(v, out);
                }
            }
            _ => {}
        }
    }
    for (k, v) in &parsed.front_matter.entries {
        out.extend(find_sealed_references(k));
        walk(v, &mut out);
    }
    out
}

// ── Restricted YAML ────────────────────────────────────────────────────────

fn is_sep(c: char) -> bool {
    c == ' ' || c == '\t'
}

fn trim_sep_start(text: &[char]) -> &[char] {
    let start = text.iter().position(|c| !is_sep(*c)).unwrap_or(text.len());
    &text[start..]
}

fn trim_sep(text: &[char]) -> &[char] {
    let text = trim_sep_start(text);
    let end = text.iter().rposition(|c| !is_sep(*c)).map_or(0, |i| i + 1);
    &text[..end]
}

fn starts_with(text: &[char], prefix: &str) -> bool {
    let mut chars = text.iter();
    prefix.chars().all(|p| chars.next() == Some(&p))
}

fn is_seq_entry(content: &[char]) -> bool {
    content == ['-'] || starts_with(content, "- ")
}

fn to_string(text: &[char]) -> String {
    text.iter().collect()
}

/// `/:(?:[ \t]|$)/` — a mapping colon anywhere in `text`.
fn has_mapping_colon(text: &[char]) -> bool {
    text.iter()
        .enumerate()
        .any(|(i, c)| *c == ':' && text.get(i + 1).is_none_or(|n| is_sep(*n)))
}

fn line_indent(line: &[char]) -> Result<usize, MarkdownIssue> {
    let mut i = 0;
    while let Some(c) = line.get(i) {
        match c {
            ' ' => i += 1,
            '\t' => return Err(yaml_issue("YAML indentation must use spaces")),
            _ => break,
        }
    }
    Ok(i)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum NodeKind {
    Map,
    Seq,
}

struct StackNode {
    arena: usize,
    kind: NodeKind,
    indent: isize,
    indentless: bool,
}

enum Slot {
    Value(YamlValue),
    Node(usize),
}

enum ArenaNode {
    Map(Vec<(String, Slot)>, HashSet<String>),
    Seq(Vec<Slot>),
}

struct YamlParser {
    lines: Vec<Vec<char>>,
    index: usize,
    arena: Vec<ArenaNode>,
    stack: Vec<StackNode>,
}

struct MapEntry {
    key: String,
    raw: Vec<char>,
}

impl YamlParser {
    fn parse(source: &str) -> Result<YamlMap, MarkdownIssue> {
        let source = source.strip_prefix('\u{feff}').unwrap_or(source);
        let normalized = source.replace("\r\n", "\n").replace('\r', "\n");
        let mut lines: Vec<Vec<char>> = normalized
            .split('\n')
            .map(|l| l.chars().collect())
            .collect();
        if normalized.ends_with('\n') {
            lines.pop();
        }
        let mut parser = YamlParser {
            lines,
            index: 0,
            arena: vec![ArenaNode::Map(Vec::new(), HashSet::new())],
            stack: vec![StackNode {
                arena: 0,
                kind: NodeKind::Map,
                indent: -1,
                indentless: false,
            }],
        };
        parser.run()?;
        match parser.build(0) {
            YamlValue::Map(map) => Ok(map),
            _ => Err(yaml_issue("front matter must be a mapping")),
        }
    }

    fn build(&mut self, id: usize) -> YamlValue {
        let node = std::mem::replace(&mut self.arena[id], ArenaNode::Seq(Vec::new()));
        match node {
            ArenaNode::Map(entries, _) => {
                let entries = entries
                    .into_iter()
                    .map(|(k, slot)| (k, self.build_slot(slot)))
                    .collect();
                YamlValue::Map(YamlMap { entries })
            }
            ArenaNode::Seq(items) => YamlValue::Seq(
                items
                    .into_iter()
                    .map(|slot| self.build_slot(slot))
                    .collect(),
            ),
        }
    }

    fn build_slot(&mut self, slot: Slot) -> YamlValue {
        match slot {
            Slot::Value(v) => v,
            Slot::Node(id) => self.build(id),
        }
    }

    fn top(&self) -> &StackNode {
        // The root map is never popped.
        &self.stack[self.stack.len() - 1]
    }

    fn peek_content_line(&self) -> Option<(usize, usize)> {
        for scan in self.index..self.lines.len() {
            let candidate = &self.lines[scan];
            if trim_sep(candidate).is_empty() || trim_sep_start(candidate).first() == Some(&'#') {
                continue;
            }
            return line_indent(candidate).ok().map(|indent| (scan, indent));
        }
        None
    }

    fn push_container(
        &mut self,
        kind: NodeKind,
        indent: usize,
        indentless: bool,
    ) -> Result<usize, MarkdownIssue> {
        if self.stack.len() >= FRONTMATTER_MAX_DEPTH {
            return Err(depth_issue());
        }
        let id = self.arena.len();
        self.arena.push(match kind {
            NodeKind::Map => ArenaNode::Map(Vec::new(), HashSet::new()),
            NodeKind::Seq => ArenaNode::Seq(Vec::new()),
        });
        self.stack.push(StackNode {
            arena: id,
            kind,
            indent: indent as isize,
            indentless,
        });
        Ok(id)
    }

    fn map_insert(&mut self, map: usize, key: String, slot: Slot) {
        if let ArenaNode::Map(entries, keys) = &mut self.arena[map] {
            keys.insert(key.clone());
            entries.push((key, slot));
        }
    }

    fn map_has(&self, map: usize, key: &str) -> bool {
        matches!(&self.arena[map], ArenaNode::Map(_, keys) if keys.contains(key))
    }

    fn seq_push(&mut self, seq: usize, slot: Slot) {
        if let ArenaNode::Seq(items) = &mut self.arena[seq] {
            items.push(slot);
        }
    }

    /// Reserve a child container slot in `parent` (map key or seq item).
    fn attach(&mut self, parent: usize, key: Option<String>, child: usize) {
        match key {
            Some(key) => self.map_insert(parent, key, Slot::Node(child)),
            None => self.seq_push(parent, Slot::Node(child)),
        }
    }

    fn assign_map_value(&mut self, entry: MapEntry, col: usize) -> Result<(), MarkdownIssue> {
        let target = self.top();
        if target.kind != NodeKind::Map {
            return Err(yaml_issue("mapping entries require a map parent"));
        }
        let target = target.arena;
        let value: Vec<char> = trim_sep(&entry.raw).to_vec();
        if value.is_empty() {
            if let Some((line, indent)) = self.peek_content_line()
                && indent >= col
            {
                let nested = &self.lines[line][indent..];
                if is_seq_entry(nested) {
                    let child = self.push_container(NodeKind::Seq, col, indent == col)?;
                    self.attach(target, Some(entry.key), child);
                    return Ok(());
                }
                if indent > col {
                    let child = self.push_container(NodeKind::Map, col, false)?;
                    self.attach(target, Some(entry.key), child);
                    return Ok(());
                }
            }
            self.map_insert(target, entry.key, Slot::Value(YamlValue::Null));
            return Ok(());
        }
        match value[0] {
            '&' | '*' => return Err(alias_issue()),
            '!' => return Err(tag_issue()),
            '%' => {
                return Err(yaml_issue(
                    "YAML directives are not supported in front matter",
                ));
            }
            '|' | '>' => {
                let header_ok =
                    value.len() == 1 || (value.len() == 2 && matches!(value[1], '+' | '-'));
                if !header_ok {
                    return Err(yaml_issue("unsupported block scalar header"));
                }
                let text = self.parse_block_scalar(&value, col)?;
                self.map_insert(target, entry.key, Slot::Value(YamlValue::String(text)));
                return Ok(());
            }
            _ => {}
        }
        let inline = parse_inline_value(&value, self.stack.len())?;
        if let Some((_, indent)) = self.peek_content_line()
            && indent > col
        {
            return Err(yaml_issue("multi-line plain scalars are not supported"));
        }
        self.map_insert(target, entry.key, Slot::Value(inline));
        Ok(())
    }

    fn parse_block_scalar(&mut self, header: &[char], col: usize) -> Result<String, MarkdownIssue> {
        let literal = header[0] == '|';
        let chomp = header.get(1).copied();
        let mut raw_lines: Vec<Vec<char>> = Vec::new();
        let mut content_indent: Option<usize> = None;
        while self.index < self.lines.len() {
            let raw = &self.lines[self.index];
            let indent = raw.iter().take_while(|c| **c == ' ').count();
            if indent == raw.len() {
                raw_lines.push(raw.clone());
                self.index += 1;
                continue;
            }
            if indent <= col {
                break;
            }
            let ci = match content_indent {
                Some(ci) => ci,
                None => {
                    if raw_lines.iter().any(|blank| blank.len() > indent) {
                        return Err(yaml_issue(
                            "leading blank lines exceed block scalar indentation",
                        ));
                    }
                    content_indent = Some(indent);
                    indent
                }
            };
            if indent < ci {
                return Err(yaml_issue("block scalar has inconsistent indentation"));
            }
            raw_lines.push(raw.clone());
            self.index += 1;
        }
        let mut collected: Vec<String> = raw_lines
            .iter()
            .map(|raw| match content_indent {
                Some(ci) => to_string(raw.get(ci..).unwrap_or_default()),
                None => String::new(),
            })
            .collect();
        let mut trailing = 0;
        while collected.last().is_some_and(String::is_empty) {
            trailing += 1;
            collected.pop();
        }
        if collected.is_empty() {
            if chomp == Some('+') && trailing > 0 {
                return Ok("\n".repeat(trailing));
            }
            return Ok(String::new());
        }
        let text = if literal {
            collected.join("\n")
        } else {
            let mut out = String::new();
            let mut started = false;
            let mut prev_more = false;
            let mut pending = 0;
            for line in &collected {
                if line.is_empty() {
                    pending += 1;
                    continue;
                }
                let more = line.starts_with(' ') || line.starts_with('\t');
                if !started {
                    out.push_str(&"\n".repeat(pending));
                } else if prev_more || more {
                    out.push_str(&"\n".repeat(pending + 1));
                } else if pending > 0 {
                    out.push_str(&"\n".repeat(pending));
                } else {
                    out.push(' ');
                }
                pending = 0;
                out.push_str(line);
                started = true;
                prev_more = more;
            }
            out
        };
        Ok(match chomp {
            Some('-') => text,
            Some('+') => format!("{text}\n{}", "\n".repeat(trailing)),
            _ => format!("{text}\n"),
        })
    }

    fn run(&mut self) -> Result<(), MarkdownIssue> {
        while self.index < self.lines.len() {
            let line = self.lines[self.index].clone();
            if trim_sep(&line).is_empty() || trim_sep_start(&line).first() == Some(&'#') {
                self.index += 1;
                continue;
            }
            let indent = line_indent(&line)?;
            let content = &line[indent..];
            let sequence_entry = is_seq_entry(content);
            while self.stack.len() > 1 {
                let top = self.top();
                if indent as isize > top.indent {
                    break;
                }
                if indent as isize == top.indent
                    && top.kind == NodeKind::Seq
                    && top.indentless
                    && sequence_entry
                {
                    break;
                }
                self.stack.pop();
            }
            let parent_kind = self.top().kind;
            let parent = self.top().arena;

            if sequence_entry {
                if parent_kind != NodeKind::Seq {
                    return Err(yaml_issue("sequence entries require an array parent"));
                }
                let rest: &[char] = if content.len() == 1 {
                    &[]
                } else {
                    &content[2..]
                };
                if is_seq_entry(rest) {
                    return Err(yaml_issue("nested sequence entries are not supported"));
                }
                let item_text: Vec<char> = trim_sep_start(rest).to_vec();
                let item_col = indent + 2 + (rest.len() - item_text.len());
                self.index += 1;
                if item_text.is_empty() {
                    if let Some((next, next_indent)) = self.peek_content_line()
                        && next_indent > indent
                    {
                        if is_seq_entry(&self.lines[next][next_indent..]) {
                            return Err(yaml_issue("nested sequence entries are not supported"));
                        }
                        let child = self.push_container(NodeKind::Map, indent, false)?;
                        self.attach(parent, None, child);
                        continue;
                    }
                    self.seq_push(parent, Slot::Value(YamlValue::Null));
                    continue;
                }
                if is_mapping_line(&item_text) {
                    let entry = parse_map_entry(&item_text)?;
                    let child = self.push_container(NodeKind::Map, indent, false)?;
                    self.attach(parent, None, child);
                    self.assign_map_value(entry, item_col)?;
                    continue;
                }
                sequence_scalar_issue(&item_text)?;
                let inline = parse_inline_value(&item_text, self.stack.len())?;
                if let Some((_, next_indent)) = self.peek_content_line()
                    && next_indent > item_col
                {
                    return Err(yaml_issue("multi-line plain scalars are not supported"));
                }
                self.seq_push(parent, Slot::Value(inline));
                continue;
            }

            let entry = parse_map_entry(content)?;
            if parent_kind != NodeKind::Map {
                return Err(yaml_issue("mapping entries require a map parent"));
            }
            if self.map_has(parent, &entry.key) {
                return Err(issue(
                    MarkdownIssueCode::YamlDuplicate,
                    format!("duplicate front matter key {}", entry.key),
                ));
            }
            self.index += 1;
            self.assign_map_value(entry, indent)?;
        }
        Ok(())
    }
}

fn sequence_scalar_issue(item: &[char]) -> Result<(), MarkdownIssue> {
    match item.first() {
        Some('&' | '*') => Err(alias_issue()),
        Some('!') => Err(tag_issue()),
        Some('%') => Err(yaml_issue(
            "YAML directives are not supported in front matter",
        )),
        Some('|' | '>') => Err(yaml_issue(
            "block scalars in sequence items are not supported",
        )),
        _ => Ok(()),
    }
}

fn skip_seps(text: &[char], mut pos: usize) -> usize {
    while text.get(pos).is_some_and(|c| is_sep(*c)) {
        pos += 1;
    }
    pos
}

/// Parse one `key: value` line, decoding quoted keys.
fn parse_map_entry(content: &[char]) -> Result<MapEntry, MarkdownIssue> {
    let (key, raw): (String, &[char]) = if matches!(content.first(), Some('"' | '\'')) {
        let (text, end) = scan_quoted_scalar(content, 0)?;
        let pos = skip_seps(content, end);
        if content.get(pos) != Some(&':') {
            return Err(yaml_issue("quoted keys must be followed by a colon"));
        }
        (text, &content[pos + 1..])
    } else {
        let colon = content
            .iter()
            .enumerate()
            .position(|(i, c)| *c == ':' && content.get(i + 1).is_none_or(|n| is_sep(*n)))
            .ok_or_else(|| yaml_issue("front matter must use key: value mappings"))?;
        let plain = trim_sep(&content[..colon]);
        assert_plain_scalar(plain, false)?;
        (to_string(plain), &content[colon + 1..])
    };
    assert_yaml_key(&key)?;
    let trimmed = trim_sep(raw);
    if trimmed.first() == Some(&'#') {
        return Ok(MapEntry {
            key,
            raw: Vec::new(),
        });
    }
    Ok(MapEntry {
        key,
        raw: trimmed.to_vec(),
    })
}

fn is_mapping_line(text: &[char]) -> bool {
    match text.first() {
        Some('"' | '\'') => match scan_quoted_scalar(text, 0) {
            Ok((_, end)) => text.get(skip_seps(text, end)) == Some(&':'),
            Err(_) => false,
        },
        Some('[' | '{') => false,
        _ => has_mapping_colon(text),
    }
}

fn parse_inline_value(raw: &[char], parent_depth: usize) -> Result<YamlValue, MarkdownIssue> {
    match raw.first() {
        Some('"' | '\'') => {
            let (text, end) = scan_quoted_scalar(raw, 0)?;
            if !trailing_content_ok(&raw[end..]) {
                return Err(yaml_issue("unexpected content after a quoted scalar"));
            }
            Ok(YamlValue::String(text))
        }
        Some('[' | '{') => {
            let mut flow = FlowParser { text: raw, pos: 0 };
            let value = flow.collection(parent_depth + 1)?;
            if !trailing_content_ok(&raw[flow.pos..]) {
                return Err(yaml_issue("unexpected content after a flow collection"));
            }
            Ok(value)
        }
        Some('&' | '*' | '!' | '%') => Err(yaml_issue(
            "front matter values must not start with YAML indicators",
        )),
        _ => {
            let stripped = strip_plain_comment(raw);
            let scalar = trim_sep(stripped);
            if has_mapping_colon(scalar) {
                return Err(yaml_issue("plain scalars must not contain mapping colons"));
            }
            assert_plain_scalar(scalar, false)?;
            if scalar.is_empty() {
                return Ok(YamlValue::Null);
            }
            Ok(decode_plain_scalar(&to_string(scalar)))
        }
    }
}

struct FlowParser<'a> {
    text: &'a [char],
    pos: usize,
}

impl FlowParser<'_> {
    fn peek(&self) -> Option<char> {
        self.text.get(self.pos).copied()
    }

    fn skip(&mut self) {
        self.pos = skip_seps(self.text, self.pos);
    }

    fn value(&mut self, nested: usize) -> Result<YamlValue, MarkdownIssue> {
        self.skip();
        match self.peek() {
            Some('[' | '{') => return self.collection(nested + 1),
            Some('"' | '\'') => {
                let (text, end) = scan_quoted_scalar(self.text, self.pos)?;
                self.pos = end;
                return Ok(YamlValue::String(text));
            }
            Some('&' | '*') => return Err(alias_issue()),
            Some('!') => return Err(tag_issue()),
            Some(',' | ']' | '}') => return Ok(YamlValue::Null),
            _ => {}
        }
        let mut end = self.pos;
        while self
            .text
            .get(end)
            .is_some_and(|c| !matches!(c, ',' | ']' | '}'))
        {
            end += 1;
        }
        let token = trim_sep(&self.text[self.pos..end]);
        self.pos = end;
        if has_mapping_colon(token) {
            return Err(yaml_issue(
                "flow mappings inside sequences are not supported",
            ));
        }
        assert_plain_scalar(token, true)?;
        Ok(decode_plain_scalar(&to_string(token)))
    }

    fn collection(&mut self, nested: usize) -> Result<YamlValue, MarkdownIssue> {
        if nested > FRONTMATTER_MAX_DEPTH {
            return Err(depth_issue());
        }
        let is_seq = self.peek() == Some('[');
        let closer = if is_seq { ']' } else { '}' };
        self.pos += 1;
        self.skip();
        if is_seq {
            let mut items = Vec::new();
            if self.peek() == Some(closer) {
                self.pos += 1;
                return Ok(YamlValue::Seq(items));
            }
            loop {
                if self.peek() == Some(',') {
                    return Err(yaml_issue("flow sequences must not contain empty entries"));
                }
                items.push(self.value(nested)?);
                self.skip();
                if self.peek() == Some(',') {
                    self.pos += 1;
                    self.skip();
                    if self.peek() == Some(closer) {
                        self.pos += 1;
                        return Ok(YamlValue::Seq(items));
                    }
                    continue;
                }
                if self.peek() == Some(closer) {
                    self.pos += 1;
                    return Ok(YamlValue::Seq(items));
                }
                return Err(yaml_issue("flow sequence is not closed"));
            }
        }
        let mut entries: Vec<(String, YamlValue)> = Vec::new();
        let mut keys: HashSet<String> = HashSet::new();
        if self.peek() == Some(closer) {
            self.pos += 1;
            return Ok(YamlValue::Map(YamlMap { entries }));
        }
        loop {
            self.skip();
            let key = if matches!(self.peek(), Some('"' | '\'')) {
                let (text, end) = scan_quoted_scalar(self.text, self.pos)?;
                self.pos = end;
                text
            } else {
                let mut end = self.pos;
                while let Some(c) = self.text.get(end) {
                    if matches!(c, ',' | '}' | ']')
                        || (*c == ':'
                            && self.text.get(end + 1).is_none_or(|n| {
                                is_sep(*n) || matches!(n, '[' | ']' | '{' | '}' | ',')
                            }))
                    {
                        break;
                    }
                    end += 1;
                }
                let plain = trim_sep(&self.text[self.pos..end]);
                assert_plain_scalar(plain, true)?;
                let key = to_string(plain);
                self.pos = end;
                key
            };
            assert_yaml_key(&key)?;
            self.skip();
            if self.peek() != Some(':') {
                return Err(yaml_issue("flow mapping entries require a colon"));
            }
            self.pos += 1;
            if keys.contains(&key) {
                return Err(issue(
                    MarkdownIssueCode::YamlDuplicate,
                    format!("duplicate front matter key {key}"),
                ));
            }
            let value = self.value(nested)?;
            keys.insert(key.clone());
            entries.push((key, value));
            self.skip();
            if self.peek() == Some(',') {
                self.pos += 1;
                self.skip();
                if self.peek() == Some(closer) {
                    self.pos += 1;
                    return Ok(YamlValue::Map(YamlMap { entries }));
                }
                continue;
            }
            if self.peek() == Some(closer) {
                self.pos += 1;
                return Ok(YamlValue::Map(YamlMap { entries }));
            }
            return Err(yaml_issue("flow mapping is not closed"));
        }
    }
}

/// Decoded scalar text as JS would hold it: scalar values plus raw UTF-16
/// surrogates from `\u`/`\U` escapes, which must pair up.
fn finish_decoded(units: Vec<u32>) -> Result<String, MarkdownIssue> {
    let mut out = String::with_capacity(units.len());
    let mut i = 0;
    while i < units.len() {
        let unit = units[i];
        if unit == 0x7f || (unit < 0x20 && unit != 0x09 && unit != 0x0a && unit != 0x0d) {
            return Err(yaml_issue(
                "decoded front matter strings must not contain control characters",
            ));
        }
        if (0xd800..=0xdbff).contains(&unit) {
            let low = units.get(i + 1).copied().unwrap_or(0);
            if !(0xdc00..=0xdfff).contains(&low) {
                return Err(yaml_issue(
                    "decoded front matter strings must not contain lone surrogates",
                ));
            }
            let scalar = 0x10000 + ((unit - 0xd800) << 10) + (low - 0xdc00);
            out.push(char::from_u32(scalar).ok_or_else(|| yaml_issue("invalid surrogate pair"))?);
            i += 2;
            continue;
        }
        if (0xdc00..=0xdfff).contains(&unit) {
            return Err(yaml_issue(
                "decoded front matter strings must not contain lone surrogates",
            ));
        }
        out.push(char::from_u32(unit).ok_or_else(|| yaml_issue("invalid code point"))?);
        i += 1;
    }
    Ok(out)
}

/// Scan a quoted scalar at `start`; returns the decoded text and the index
/// just past the closing quote.
fn scan_quoted_scalar(text: &[char], start: usize) -> Result<(String, usize), MarkdownIssue> {
    let not_closed = || yaml_issue("quoted scalar is not closed");
    let mut out: Vec<u32> = Vec::new();
    let mut i = start + 1;
    if text.get(start) == Some(&'\'') {
        while let Some(&ch) = text.get(i) {
            if ch == '\'' {
                if text.get(i + 1) == Some(&'\'') {
                    out.push('\'' as u32);
                    i += 2;
                    continue;
                }
                return Ok((finish_decoded(out)?, i + 1));
            }
            out.push(ch as u32);
            i += 1;
        }
        return Err(not_closed());
    }
    while let Some(&ch) = text.get(i) {
        if ch == '"' {
            return Ok((finish_decoded(out)?, i + 1));
        }
        if ch == '\\' {
            let Some(&next) = text.get(i + 1) else {
                break;
            };
            let simple = match next {
                'n' => Some('\n'),
                't' => Some('\t'),
                'r' => Some('\r'),
                '0' => Some('\0'),
                'b' => Some('\u{8}'),
                'f' => Some('\u{c}'),
                '\\' | '"' | '/' => Some(next),
                _ => None,
            };
            if let Some(c) = simple {
                out.push(c as u32);
                i += 2;
                continue;
            }
            let width = match next {
                'u' => 4,
                'x' => 2,
                'U' => 8,
                _ => return Err(yaml_issue("unsupported escape in a double-quoted scalar")),
            };
            let hex = text.get(i + 2..i + 2 + width).unwrap_or_default();
            if hex.len() != width || !hex.iter().all(char::is_ascii_hexdigit) {
                return Err(yaml_issue(
                    "invalid hexadecimal escape in a double-quoted scalar",
                ));
            }
            let code = u64::from_str_radix(&to_string(hex), 16)
                .map_err(|_| yaml_issue("invalid hexadecimal escape in a double-quoted scalar"))?;
            if code > 0x10ffff {
                return Err(yaml_issue("Unicode escape exceeds U+10FFFF"));
            }
            if code > 0xffff {
                // String.fromCodePoint yields a surrogate pair.
                let v = code as u32 - 0x10000;
                out.push(0xd800 + (v >> 10));
                out.push(0xdc00 + (v & 0x3ff));
            } else {
                out.push(code as u32);
            }
            i += 2 + width;
            continue;
        }
        out.push(ch as u32);
        i += 1;
    }
    Err(not_closed())
}

fn strip_plain_comment(raw: &[char]) -> &[char] {
    for (i, c) in raw.iter().enumerate() {
        if *c == '#' && (i == 0 || is_sep(raw[i - 1])) {
            return &raw[..i];
        }
    }
    raw
}

fn trailing_content_ok(rest: &[char]) -> bool {
    match rest.first() {
        None => true,
        Some(c) if !is_sep(*c) => false,
        Some(_) => {
            let trimmed = trim_sep_start(rest);
            trimmed.is_empty() || trimmed[0] == '#'
        }
    }
}

// Context-specific syntax checks apply only to plain scalars. Quoted
// equivalents remain strings, and internal block punctuation stays valid.
fn assert_plain_scalar(raw: &[char], flow: bool) -> Result<(), MarkdownIssue> {
    if raw.first().is_some_and(|c| {
        matches!(
            c,
            '[' | ']'
                | '{'
                | '}'
                | ','
                | '#'
                | '&'
                | '*'
                | '!'
                | '|'
                | '>'
                | '\''
                | '"'
                | '%'
                | '@'
                | '`'
        )
    }) || (matches!(raw.first(), Some('?' | ':' | '-'))
        && raw
            .get(1)
            .is_none_or(|c| is_sep(*c) || (flow && matches!(c, '[' | ']' | '{' | '}' | ','))))
        || raw.windows(2).any(|w| is_sep(w[0]) && w[1] == '#')
        || (flow && raw.iter().any(|c| matches!(c, '[' | ']' | '{' | '}' | ',')))
    {
        return Err(yaml_issue("unsupported YAML plain scalar syntax"));
    }
    Ok(())
}

fn assert_yaml_key(key: &str) -> Result<(), MarkdownIssue> {
    if key.is_empty() {
        return Err(yaml_issue("front matter key must not be empty"));
    }
    if key == "<<" {
        return Err(yaml_issue("front matter must not use YAML merge keys"));
    }
    if key.starts_with(['&', '*', '!']) {
        return Err(yaml_issue(
            "front matter keys must not use YAML anchors, aliases or tags",
        ));
    }
    if FORBIDDEN_YAML_KEYS.contains(&key) {
        return Err(yaml_issue("front matter key is not allowed"));
    }
    Ok(())
}

/// YAML 1.2 core-schema plain scalar resolution with JavaScript `Number`
/// semantics (null/bool/int/float, else string).
fn decode_plain_scalar(raw: &str) -> YamlValue {
    match raw {
        "null" | "Null" | "NULL" | "~" => return YamlValue::Null,
        "true" | "True" | "TRUE" => return YamlValue::Bool(true),
        "false" | "False" | "FALSE" => return YamlValue::Bool(false),
        _ => {}
    }
    let unsigned = raw.strip_prefix(['+', '-']).unwrap_or(raw);
    if matches!(unsigned, ".inf" | ".Inf" | ".INF") {
        return YamlValue::Number(if raw.starts_with('-') {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        });
    }
    if matches!(raw, ".nan" | ".NaN" | ".NAN") {
        return YamlValue::Number(f64::NAN);
    }
    let radix = |digits: &str, base: u32| -> Option<f64> {
        if digits.is_empty() || !digits.chars().all(|c| c.is_digit(base)) {
            return None;
        }
        Some(digits.chars().fold(0.0, |acc, c| {
            acc * f64::from(base) + f64::from(c.to_digit(base).unwrap_or(0))
        }))
    };
    if let Some(hex) = raw.strip_prefix("0x")
        && let Some(n) = radix(hex, 16)
    {
        return YamlValue::Number(n);
    }
    if let Some(oct) = raw.strip_prefix("0o")
        && let Some(n) = radix(oct, 8)
    {
        return YamlValue::Number(n);
    }
    if is_js_decimal(raw)
        && let Ok(n) = raw.parse::<f64>()
    {
        return YamlValue::Number(n);
    }
    YamlValue::String(raw.to_owned())
}

/// `^[-+]?(\.\d+|\d+(\.\d*)?)([eE][-+]?\d+)?$` (also covers `^[-+]?\d+$`).
fn is_js_decimal(raw: &str) -> bool {
    let b = raw.as_bytes();
    let mut i = usize::from(matches!(b.first(), Some(b'+' | b'-')));
    let digits = |i: &mut usize| {
        let start = *i;
        while b.get(*i).is_some_and(u8::is_ascii_digit) {
            *i += 1;
        }
        *i - start
    };
    if b.get(i) == Some(&b'.') {
        i += 1;
        if digits(&mut i) == 0 {
            return false;
        }
    } else {
        if digits(&mut i) == 0 {
            return false;
        }
        if b.get(i) == Some(&b'.') {
            i += 1;
            digits(&mut i);
        }
    }
    if matches!(b.get(i), Some(b'e' | b'E')) {
        i += 1;
        if matches!(b.get(i), Some(b'+' | b'-')) {
            i += 1;
        }
        if digits(&mut i) == 0 {
            return false;
        }
    }
    i == b.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fm(src: &str) -> Result<ParsedMarkdown, MarkdownIssue> {
        parse_markdown(format!("---\n{src}---\nbody\n").as_bytes())
    }

    #[test]
    fn split_handles_crlf_and_eof() {
        assert_eq!(split_front_matter(b"---\na: 1\n---\nbody").1, 13);
        assert_eq!(split_front_matter(b"---\r\na: 1\r\n---\r\nbody").1, 16);
        assert_eq!(split_front_matter(b"---\na: 1\n---").1, 12);
        assert!(split_front_matter(b"---\na: 1\n---\r").0.is_none());
        assert!(split_front_matter(b"--- \na\n---\n").0.is_none());
        assert!(split_front_matter(b"---\nnever closed\n").0.is_none());
    }

    #[test]
    fn scalars_follow_js_number_semantics() {
        let p = fm("a: 0x10\nb: 1e3\nc: +.5\nd: 5.\ne: '1'\nf: ~\ng: TRUE\nh: 1_000\n").unwrap();
        let get = |k: &str| p.front_matter.get(k).cloned();
        assert_eq!(get("a"), Some(YamlValue::Number(16.0)));
        assert_eq!(get("b"), Some(YamlValue::Number(1000.0)));
        assert_eq!(get("c"), Some(YamlValue::Number(0.5)));
        assert_eq!(get("d"), Some(YamlValue::Number(5.0)));
        assert_eq!(get("e"), Some(YamlValue::String("1".into())));
        assert_eq!(get("f"), Some(YamlValue::Null));
        assert_eq!(get("g"), Some(YamlValue::Bool(true)));
        assert_eq!(get("h"), Some(YamlValue::String("1_000".into())));
        assert_eq!(
            fm("a: .nan\n").unwrap_err().code,
            MarkdownIssueCode::JsonValue
        );
        assert_eq!(
            fm("a: -.inf\n").unwrap_err().code,
            MarkdownIssueCode::JsonValue
        );
        assert!(fm("a: 9007199254740991\n").is_ok());
    }

    #[test]
    fn escapes_pair_surrogates_like_javascript() {
        let p = fm("a: \"\\uD83D\\uDE00\"\nb: \"\\U0001F600\"\n").unwrap();
        assert_eq!(
            p.front_matter.get("a"),
            Some(&YamlValue::String("😀".into()))
        );
        assert_eq!(
            p.front_matter.get("b"),
            Some(&YamlValue::String("😀".into()))
        );
        assert_eq!(
            fm("a: \"\\uD83D\"\n").unwrap_err().code,
            MarkdownIssueCode::Yaml
        );
        assert_eq!(
            fm("a: \"\\x01\"\n").unwrap_err().code,
            MarkdownIssueCode::Yaml
        );
        assert_eq!(
            fm("a: \"\\q\"\n").unwrap_err().code,
            MarkdownIssueCode::Yaml
        );
    }

    #[test]
    fn block_scalars_fold_and_chomp() {
        let p = fm("a: |\n  one\n  two\nb: >\n  one\n  two\n\n  three\nc: |-\n  x\nd: |+\n  x\n\n")
            .unwrap();
        assert_eq!(
            p.front_matter.get("a"),
            Some(&YamlValue::String("one\ntwo\n".into()))
        );
        assert_eq!(
            p.front_matter.get("b"),
            Some(&YamlValue::String("one two\nthree\n".into()))
        );
        assert_eq!(
            p.front_matter.get("c"),
            Some(&YamlValue::String("x".into()))
        );
        assert_eq!(
            p.front_matter.get("d"),
            Some(&YamlValue::String("x\n\n".into()))
        );
    }

    #[test]
    fn document_id_counts_utf16_units() {
        let ok = format!("id: \"{}\"\n", "😀".repeat(128));
        assert_eq!(
            fm(&ok).unwrap().document_id.map(|s| s.chars().count()),
            Some(128)
        );
        let long = format!("id: \"{}a\"\n", "😀".repeat(128));
        assert_eq!(fm(&long).unwrap_err().code, MarkdownIssueCode::DocumentId);
    }

    #[test]
    fn sealed_scan_is_case_insensitive_and_sees_decoded_values() {
        let upper = "{{SEALED:V1:KNOWLEDGE_BASE:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222}}";
        assert_eq!(find_sealed_references(upper).len(), 1);
        let escaped = "a: \"\\u007b{sealed:v1:knowledge_base:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222}}\"\n";
        let src = format!("---\n{escaped}---\n");
        let parsed = parse_markdown(src.as_bytes()).unwrap();
        assert_eq!(sealed_references_in(&parsed, &src).len(), 1);
    }

    #[test]
    fn sealed_scan_preserves_overlaps_order_and_uuid_case() {
        let first = "sealed:v1:knowledge_base:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222";
        let second = "sealed:v1:knowledge_base:AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        let upper = format!(
            "{{{{{}}}}}",
            second.replace(SEALED_PREFIX, "SEALED:V1:KNOWLEDGE_BASE:")
        );
        // The extra opener overlaps the valid first match; a failed outer
        // candidate must not swallow the following valid inner candidate.
        let text = format!("🌿{{{{invalid {{{{{first}}}}}🦉{upper}{{{{");
        assert_eq!(find_sealed_references(&text), vec![first, second]);
        assert_eq!(
            find_sealed_references(&format!("{{{{{{{first}}}}}")),
            vec![first]
        );
        for text in ["", "{", "{{", "{{sealed:v1:knowledge_base:"] {
            assert!(find_sealed_references(text).is_empty(), "{text}");
        }
        // Full-size ordinary text and dense malformed openers are both valid
        // inputs. A late reference must still be found exactly once.
        let large = "x".repeat(crate::git_read::DOCUMENT_MAX_BYTES);
        assert!(find_sealed_references(&large).is_empty());
        assert_eq!(
            find_sealed_references(&format!("{large}{{{{{first}}}}}")),
            vec![first]
        );
        assert!(
            find_sealed_references(&"{".repeat(crate::git_read::DOCUMENT_MAX_BYTES)).is_empty()
        );
    }
}
