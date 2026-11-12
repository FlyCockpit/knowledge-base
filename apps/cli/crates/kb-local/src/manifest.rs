//! Immutable manifest snapshots and retained per-KB authority, shared by all publishers.
use crate::{
    Store, StoreError,
    git_read::{DOCUMENT_MAX_BYTES, GitRepo, ObjectKind, blob_at},
    tree::{self, ManifestEntry, SealedOccurrence, TreePolicy},
};
use kb_client::types::{AssetRef, ContentHash, KbId, KbPath, Mime, Sha};
use rusqlite::OptionalExtension;

pub(crate) fn at_revision(repo: &GitRepo, rev: &Sha) -> Result<Vec<ManifestEntry>, StoreError> {
    let mut reader = repo.object_reader()?;
    let tree = reader.read_commit(rev)?.tree;
    let path = KbPath::parse(tree::MANIFEST_PATH).map_err(|_| unavailable())?;
    let blob = blob_at(&mut reader, &tree, &path)?.ok_or_else(unavailable)?;
    let bytes = reader.read(&blob, ObjectKind::Blob, DOCUMENT_MAX_BYTES)?;
    let entries = tree::parse_manifest(&bytes).map_err(|_| unavailable())?;
    if bytes != tree::canonical_manifest_bytes(&entries) {
        return Err(unavailable());
    }
    Ok(entries)
}
pub(crate) fn unavailable() -> StoreError {
    StoreError::StorageUnavailable("asset authority unavailable".into())
}
pub(crate) fn asset_ref(e: &ManifestEntry) -> Result<AssetRef, StoreError> {
    Ok(AssetRef {
        path: KbPath::parse(&e.path).map_err(|_| unavailable())?,
        hash: ContentHash::parse(&e.hash).map_err(|_| unavailable())?,
        size: e.size,
        mime: serde_json::from_value(serde_json::json!(e.mime)).map_err(|_| unavailable())?,
    })
}
pub(crate) struct Policy<'a> {
    pub store: &'a Store,
    pub kb: &'a KbId,
    pub pending: &'a [ManifestEntry],
    /// L-8: `path -> blob` of the commit this one builds on. References in
    /// a blob unchanged at its path were validated when it was written, so
    /// a later revocation never blocks unrelated writes; only changed paths
    /// must reference live records. `None` validates every reference.
    pub base: Option<&'a std::collections::HashMap<String, String>>,
}
impl TreePolicy for Policy<'_> {
    fn check_manifest_entry(&self, _commit: Option<&Sha>, e: &ManifestEntry) -> Result<(), String> {
        let trusted:Option<(i64,String,bool)>=self.store.conn.query_row("SELECT size,mime,EXISTS(SELECT 1 FROM kb_asset_lineage WHERE kb_id=?1 AND hash=?2) FROM asset_blobs WHERE hash=?2",(self.kb.as_str(),&e.hash),|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(|_|"asset catalog unavailable")?;
        if trusted
            .as_ref()
            .is_some_and(|(size, mime, _)| *size != e.size as i64 || mime != &e.mime)
        {
            return Err("manifest metadata differs from trusted catalog".into());
        }
        if trusted.is_some_and(|(_, _, lineage)| lineage)
            || self
                .pending
                .iter()
                .any(|p| p.hash == e.hash && p.size == e.size && p.mime == e.mime)
        {
            Ok(())
        } else {
            Err("manifest hash is not authorized for this knowledge base".into())
        }
    }
    fn check_sealed_references(
        &self,
        _c: Option<&Sha>,
        refs: &[SealedOccurrence],
    ) -> Result<(), SealedOccurrence> {
        let changed = refs
            .iter()
            .filter(|r| self.base.and_then(|b| b.get(&r.path)) != Some(&r.blob))
            .cloned()
            .collect::<Vec<_>>();
        self.store.check_local_sealed(self.kb, &changed, true)
    }
}
/// Immutable exports retain symbolic source after record revocation. All
/// manifest authority and tree checks still run; this policy cannot publish.
pub(crate) struct SnapshotPolicy<'a>(pub Policy<'a>);
impl TreePolicy for SnapshotPolicy<'_> {
    fn check_manifest_entry(&self, c: Option<&Sha>, e: &ManifestEntry) -> Result<(), String> {
        self.0.check_manifest_entry(c, e)
    }
    fn check_sealed_references(
        &self,
        _c: Option<&Sha>,
        refs: &[SealedOccurrence],
    ) -> Result<(), SealedOccurrence> {
        self.0.store.check_local_sealed(self.0.kb, refs, false)
    }
}
/// `path -> blob` of one commit's tree (bounded like every tree walk).
pub(crate) fn blob_map(
    repo: &GitRepo,
    commit: &Sha,
) -> Result<std::collections::HashMap<String, String>, StoreError> {
    let info = repo.read_commit(commit)?;
    let mut reader = repo.object_reader()?;
    let entries = crate::git_read::walk_tree(
        &mut reader,
        &info.tree,
        &mut crate::git_read::WalkBudget::new(crate::tree::TREE_LIMITS.max_entries),
        &mut crate::git_read::IncomingBudget::new(
            crate::tree::TREE_LIMITS.max_objects,
            crate::tree::TREE_LIMITS.max_uncompressed_object_bytes,
            None,
        ),
    )?;
    Ok(entries.into_iter().map(|e| (e.path, e.sha)).collect())
}
impl Store {
    pub(crate) fn manifest_entries(
        &self,
        kb: &KbId,
        repo: &GitRepo,
        rev: &Sha,
    ) -> Result<Vec<ManifestEntry>, StoreError> {
        let entries = at_revision(repo, rev)?;
        let policy = Policy {
            store: self,
            kb,
            pending: &[],
            base: None,
        };
        for e in &entries {
            policy
                .check_manifest_entry(Some(rev), e)
                .map_err(|_| unavailable())?;
        }
        Ok(entries)
    }
    pub(crate) fn verify_asset_bytes(&self, e: &ManifestEntry) -> Result<(), StoreError> {
        let hash = ContentHash::parse(&e.hash).map_err(|_| unavailable())?;
        let path = crate::cas::blob_path(&self.paths, &hash);
        self.paths.check_no_follow(&path)?;
        let mut file = crate::paths::open_no_follow(&path, std::fs::OpenOptions::new().read(true))
            .map_err(|_| unavailable())?;
        let bytes = crate::cas::verified_bytes(&mut file, &hash, e.size)?;
        let mime: Mime =
            serde_json::from_value(serde_json::json!(e.mime)).map_err(|_| unavailable())?;
        crate::mime::validate_media(&bytes, mime).map_err(|_| unavailable())
    }
}

use std::collections::{HashMap, HashSet};
// Port of the bounded documents-read.ts scanner: bracket pairing is linear, and
// every destination attempt claims its scanned region even when malformed.
// ECMAScript \s/trim includes BOM, but excludes Unicode NEXT LINE.
fn js_whitespace(c: char) -> bool {
    matches!(c, '\u{9}'..='\u{d}' | ' ' | '\u{a0}' | '\u{1680}'
        | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
        | '\u{205f}' | '\u{3000}' | '\u{feff}')
}
fn strip_code(source: &str) -> String {
    let mut text = String::new();
    let mut fence: Option<(u8, usize)> = None;
    let mut paragraph = false;
    for line in source.split('\n') {
        let trimmed = line.trim_start_matches(' ');
        let indent = line.len() - trimmed.len();
        let ch = trimmed.as_bytes().first().copied().unwrap_or(0);
        let n = trimmed.bytes().take_while(|b| *b == ch).count();
        let marker = indent <= 3 && matches!(ch, b'`' | b'~') && n >= 3;
        if let Some((c, len)) = fence {
            if marker && c == ch && n >= len && trimmed[n..].trim_matches(js_whitespace).is_empty()
            {
                fence = None;
            }
            continue;
        }
        if marker {
            fence = Some((ch, n));
            paragraph = false;
            continue;
        }
        if line.trim_matches(js_whitespace).is_empty() {
            paragraph = false;
        } else if line.starts_with("    ") || line.starts_with('\t') {
            if !paragraph {
                continue;
            }
        } else {
            paragraph = true;
        }
        text.push_str(line);
        text.push('\n');
    }
    let b = text.as_bytes();
    let mut runs = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'`' {
            let start = i;
            while i < b.len() && b[i] == b'`' {
                i += 1;
            }
            runs.push((start, i - start));
        } else {
            i += 1;
        }
    }
    let mut next = HashMap::new();
    let mut ends = HashMap::new();
    for (j, (_, n)) in runs.iter().enumerate().rev() {
        if let Some(end) = next.insert(*n, j) {
            ends.insert(j, end);
        }
    }
    let mut out = String::new();
    let mut cursor = 0;
    let mut j = 0;
    while j < runs.len() {
        if let Some(&end) = ends.get(&j) {
            out.push_str(&text[cursor..runs[j].0]);
            out.push(' ');
            cursor = runs[end].0 + runs[end].1;
            j = end + 1;
        } else {
            j += 1;
        }
    }
    out.push_str(&text[cursor..]);
    out
}
// Destination source is bounded by the admitted document, not the decoded
// manifest path: character references and discarded queries can be much longer.
// No whole-suffix Unicode walk per link; construct claims bound the total work.
fn part_end(source: &str, start: usize) -> usize {
    source.len().min(start.saturating_add(DOCUMENT_MAX_BYTES))
}
fn scan(text: &str, mut i: usize, stop: impl Fn(u8) -> bool) -> usize {
    let b = text.as_bytes();
    let end = part_end(text, i);
    while i < end {
        if b[i] == b'\\' {
            i = (i + 2).min(end);
        } else if stop(b[i]) {
            return i;
        } else {
            i += 1;
        }
    }
    end
}
fn skip(b: &[u8], mut i: usize, inline: bool) -> usize {
    while i < b.len()
        && if inline {
            matches!(b[i], b' ' | b'\t')
        } else {
            b[i].is_ascii_whitespace()
        }
    {
        i += 1;
    }
    i
}
// Returns a byte range and the last scanned position (always a UTF8 boundary
// for accepted ranges; rejected attempts use byte offsets only).
fn destination(text: &str, start: usize, definition: bool) -> (Option<(usize, usize)>, usize) {
    let b = text.as_bytes();
    let limit = if definition {
        b[start..]
            .iter()
            .position(|c| *c == b'\n')
            .map_or(b.len(), |n| start + n)
    } else {
        b.len()
    };
    let text = &text[..limit];
    let b = text.as_bytes();
    let i = skip(b, start, true);
    if i >= b.len() || (!definition && i - start >= DOCUMENT_MAX_BYTES - 1) {
        return (None, i);
    }
    let (a, end, mut k) = if b[i] == b'<' {
        let j = scan(text, i + 1, |c| matches!(c, b'>' | b'\n'));
        if j >= part_end(text, i + 1) || b.get(j) != Some(&b'>') {
            return (None, j);
        }
        (i + 1, j, j + 1)
    } else {
        let mut j = i;
        let mut depth = 0usize;
        let end = part_end(text, i);
        while j < end {
            match b[j] {
                b'\\' => {
                    j = (j + 2).min(b.len());
                    continue;
                }
                b'(' if !definition => depth += 1,
                b')' if !definition => {
                    if depth == 0 {
                        break;
                    }
                    depth -= 1;
                }
                c if c.is_ascii_whitespace() => break,
                _ => {}
            }
            j += 1;
        }
        if depth != 0 || (!definition && j >= b.len()) {
            return (None, j);
        }
        (i, j, j)
    };
    k = skip(b, k, definition);
    if let Some(&quote) = b.get(k)
        && matches!(quote, b'\'' | b'"' | b'(')
    {
        let close = if quote == b'(' { b')' } else { quote };
        let j = if quote == b'(' {
            let mut at = k + 1;
            let mut depth = 0usize;
            let end = part_end(text, k);
            while at < end {
                match b[at] {
                    b'\\' => {
                        at = (at + 2).min(end);
                        continue;
                    }
                    b'(' => depth += 1,
                    b')' => {
                        if depth == 0 {
                            break;
                        }
                        depth -= 1;
                    }
                    _ => {}
                }
                at += 1;
            }
            if at >= end {
                return (None, at);
            }
            at
        } else {
            let at = scan(text, k + 1, |c| c == close || c == b'\n');
            if at >= part_end(text, k + 1) {
                return (None, at);
            }
            at
        };
        if b.get(j) != Some(&close) {
            return (None, j);
        }
        k = skip(b, j + 1, definition);
    }
    if (definition && k == b.len()) || (!definition && b.get(k) == Some(&b')')) {
        (Some((a, end)), if definition { k } else { k + 1 })
    } else {
        (None, k)
    }
}
fn external(s: &str) -> bool {
    s.is_empty()
        || s.starts_with('#')
        || s.starts_with("//")
        || s.split_once(':').is_some_and(|(scheme, _)| {
            scheme
                .as_bytes()
                .first()
                .is_some_and(u8::is_ascii_alphabetic)
                && scheme
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'.' | b'-'))
        })
}
/// CommonMark escape/entity decoding in a single pass, before URL normalization.
/// Escaped ampersands must not become a second character-reference parse.
fn decode_destination(raw: &str) -> String {
    static ENTITIES: std::sync::OnceLock<HashMap<String, String>> = std::sync::OnceLock::new();
    let entities = ENTITIES.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../../../packages/api/src/lib/kb/fixtures/markdown-entities.json"
        ))
        .expect("generated CommonMark entity table")
    });
    let mut result = String::with_capacity(raw.len());
    let mut chars = raw.char_indices().peekable();
    while let Some((at, ch)) = chars.next() {
        if ch == '\\' && chars.peek().is_some_and(|(_, c)| c.is_ascii_punctuation()) {
            result.push(chars.next().expect("peeked character").1);
            continue;
        }
        if ch == '&' {
            // Longest named entity is 31 ASCII characters; numeric bodies <=9.
            let end = raw[at + 1..].bytes().take(33).position(|b| b == b';');
            if let Some(end) = end {
                let token = &raw[at + 1..at + 1 + end];
                let replacement = if let Some(number) = token.strip_prefix('#') {
                    let (digits, radix, limit) = if let Some(hex) = number.strip_prefix(['x', 'X'])
                    {
                        (hex, 16, 6)
                    } else {
                        (number, 10, 7)
                    };
                    if !digits.is_empty()
                        && digits.len() <= limit
                        && digits.bytes().all(|b| {
                            if radix == 16 {
                                b.is_ascii_hexdigit()
                            } else {
                                b.is_ascii_digit()
                            }
                        })
                    {
                        u32::from_str_radix(digits, radix).ok().map(|code| {
                            let invalid = code < 9
                                || code == 11
                                || (14..32).contains(&code)
                                || (127..160).contains(&code)
                                || (55_296..57_344).contains(&code)
                                || (64_976..65_008).contains(&code)
                                || (code & 65_535) >= 65_534
                                || code > 1_114_111;
                            if invalid {
                                "\u{FFFD}".into()
                            } else {
                                char::from_u32(code).expect("valid scalar").to_string()
                            }
                        })
                    } else {
                        None
                    }
                } else {
                    entities.get(token).cloned()
                };
                if let Some(replacement) = replacement {
                    result.push_str(&replacement);
                    while chars.peek().is_some_and(|(i, _)| *i <= at + 1 + end) {
                        chars.next();
                    }
                    continue;
                }
            }
        }
        result.push(ch);
    }
    result
}

fn add(out: &mut HashSet<String>, document: &str, raw: &str) {
    let raw = raw.trim_matches(js_whitespace);
    if external(raw) {
        return;
    }
    let escaped = decode_destination(raw);
    if external(&escaped) {
        return;
    }
    let raw = escaped.split(['?', '#']).next().unwrap_or_default();
    let mut decoded = Vec::new();
    let b = raw.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = b
                .get(i + 1..i + 3)
                .filter(|s| s.iter().all(u8::is_ascii_hexdigit))
                .and_then(|s| std::str::from_utf8(s).ok())
                .and_then(|s| u8::from_str_radix(s, 16).ok());
            if let Some(v) = hex {
                decoded.push(v);
                i += 3;
                continue;
            }
            decoded.clear();
            break;
        }
        decoded.push(b[i]);
        i += 1;
    }
    let decoded = String::from_utf8(decoded)
        .ok()
        .filter(|_| i == b.len())
        .unwrap_or_else(|| raw.into());
    if external(&decoded) {
        return;
    }
    let mut parts: Vec<&str> = if decoded.starts_with('/') {
        Vec::new()
    } else {
        document
            .split('/')
            .take(document.split('/').count() - 1)
            .collect()
    };
    for part in decoded.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    return;
                }
            }
            other => parts.push(other),
        }
    }
    if !parts.is_empty() {
        out.insert(parts.join("/"));
    }
}
fn label(s: &str) -> Option<String> {
    if s.is_empty() || s.encode_utf16().count() > 999 {
        return None;
    }
    let s = s
        .split(js_whitespace)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    if s.is_empty() { None } else { Some(s) }
}
pub fn referenced_paths(source: &str, document: &str) -> HashSet<String> {
    let text = strip_code(source);
    let b = text.as_bytes();
    let mut pairs = Vec::new();
    let mut stack = Vec::new();
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'\\' => {
                i += 2;
                continue;
            }
            b'[' => stack.push(i),
            b']' => {
                if let Some(open) = stack.pop() {
                    pairs.push((open, i));
                }
            }
            _ => {}
        }
        i += 1;
    }
    let mut out = HashSet::new();
    let mut defs = HashMap::new();
    let mut pending = HashSet::new();
    let mut claimed = 0;
    for (open, close) in pairs {
        if close < claimed {
            continue;
        }
        let after = close + 1;
        match b.get(after) {
            Some(b'(') => {
                let (range, end) = destination(&text, after + 1, false);
                claimed = end;
                if let Some((a, z)) = range
                    && let Some(s) = text.get(a..z)
                {
                    add(&mut out, document, s);
                }
            }
            Some(b'[') => {
                let end = scan(&text, after + 1, |c| c == b']');
                claimed = (end + 1).min(b.len());
                if b.get(end) == Some(&b']') {
                    let s = &text[after + 1..end];
                    if let Some(key) = label(if s.is_empty() {
                        &text[open + 1..close]
                    } else {
                        s
                    }) {
                        pending.insert(key);
                    }
                }
            }
            Some(b':') => {
                let mut line_start = open;
                while line_start > 0
                    && open - line_start <= 3
                    && matches!(b[line_start - 1], b' ' | b'\t')
                {
                    line_start -= 1;
                }
                if close - open <= 3997
                    && text[open + 1..close].encode_utf16().count() <= 999
                    && open - line_start <= 3
                    && (line_start == 0 || b[line_start - 1] == b'\n')
                {
                    let (range, _) = destination(&text, after + 1, true);
                    claimed = text[after..].find('\n').map_or(b.len(), |n| after + n);
                    if let Some((a, z)) = range
                        && let Some(key) = label(&text[open + 1..close])
                        && let Some(s) = text.get(a..z)
                    {
                        defs.entry(key).or_insert(s);
                    }
                }
            }
            _ if close - open <= 3997 && text[open + 1..close].encode_utf16().count() <= 999 => {
                if let Some(key) = label(&text[open + 1..close]) {
                    pending.insert(key);
                }
            }
            _ => {}
        }
    }
    // Normalize each used definition once, regardless of its reference count.
    for key in pending {
        if let Some(dest) = defs.get(&key) {
            add(&mut out, document, dest);
        }
    }
    out
}
