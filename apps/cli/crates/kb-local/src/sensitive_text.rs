//! Conservative credential-pattern floor (port of
//! `packages/api/src/lib/kb/sensitive-text.ts`).
//!
//! This is intentionally INCOMPLETE — it does not detect arbitrary secrets.
//! It recognizes exactly the server's patterns, with the same regex
//! semantics (hand-matched, no regex engine). Both test suites read the shared
//! cases in `packages/api/src/lib/kb/fixtures/sensitive-text.json`:
//!
//! * `\bsk-[A-Za-z0-9_-]{10,}\b` (ASCII word boundaries);
//! * a PEM `-----BEGIN [RSA |EC |OPENSSH |ENCRYPTED ]PRIVATE KEY-----`
//!   block through its matching END line or end of input;
//! * `authorization` (case-insensitive) + optional white space + `:`/`=` +
//!   optional white space + optional `bearer<ws>` + >= 8 token characters
//!   (`[A-Za-z0-9._~+/-]`) and trailing `=`;
//! * `bearer<ws>` + a >= 8-character token run that contains at least one
//!   digit or separator (so English prose like "Bearer authentication" or
//!   "the bearer of" stays prose).
//!
//! Every matcher is evaluated at every start position, so each one must do
//! bounded work per start or consume what it scanned: fixed-length shapes
//! inspect only their length plus the boundary character, and unbounded runs
//! (`{n,}`) either match (and the scan is consumed) or fail within `n`, or
//! fail once per run. The shared `repeatedPrefixes` fixtures time-bound this.
//!
//! The last two use the `iu` flags on the server: under Unicode case
//! folding `ſ` (U+017F) and the Kelvin sign (U+212A) also match `[A-Za-z]`
//! and `\w`, so they are token/word characters here too. White space is the
//! Unicode `White_Space` property (`char::is_whitespace`).

use std::ops::Range;

pub const SEALED_EMBED_MARKER: &str = "[sealed value redacted]";
/// Shared query/document dispatch floor; never decrypts a sealed reference.
pub fn prepare_embedding_query(text: &str) -> Result<String, crate::StoreError> {
    if contains_known_credential_patterns(text) {
        return Err(crate::StoreError::OperationAborted(
            kb_client::ErrorCode::SensitiveQuery,
        ));
    }
    let mut safe = String::with_capacity(text.len());
    let mut last = 0;
    for range in crate::markdown::sealed_ranges(text) {
        safe.push_str(&text[last..range.start]);
        safe.push_str(SEALED_EMBED_MARKER);
        last = range.end;
    }
    safe.push_str(&text[last..]);
    Ok(safe)
}

/// `\w` for the ASCII (`g`) pattern.
fn ascii_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// `\w` under the `iu` flags.
fn iu_word(c: char) -> bool {
    ascii_word(c) || c == '\u{17f}' || c == '\u{212a}'
}

/// `[A-Za-z0-9._~+/-]` under the `iu` flags.
fn token_char(c: char) -> bool {
    c.is_ascii_alphanumeric()
        || matches!(
            c,
            '.' | '_' | '~' | '+' | '/' | '-' | '\u{17f}' | '\u{212a}'
        )
}

/// `[0-9._~+/-]` (the bearer lookahead's required character).
fn digit_or_separator(c: char) -> bool {
    c.is_ascii_digit() || matches!(c, '.' | '_' | '~' | '+' | '/' | '-')
}

type Chars = [(usize, char)];

fn byte_at(chars: &Chars, i: usize, len: usize) -> usize {
    chars.get(i).map_or(len, |(b, _)| *b)
}

/// ASCII-case-insensitive literal at char index `i`; returns the end index.
fn literal_ci(chars: &Chars, i: usize, word: &str) -> Option<usize> {
    let mut j = i;
    for w in word.chars() {
        let (_, c) = chars.get(j)?;
        if !c.eq_ignore_ascii_case(&w) {
            return None;
        }
        j += 1;
    }
    Some(j)
}

fn literal(chars: &Chars, i: usize, word: &str) -> Option<usize> {
    let mut j = i;
    for w in word.chars() {
        if chars.get(j)?.1 != w {
            return None;
        }
        j += 1;
    }
    Some(j)
}

fn run(chars: &Chars, mut i: usize, class: fn(char) -> bool) -> usize {
    while chars.get(i).is_some_and(|(_, c)| class(*c)) {
        i += 1;
    }
    i
}

fn boundary_before(chars: &Chars, i: usize, word: fn(char) -> bool) -> bool {
    i == 0 || !chars.get(i - 1).is_some_and(|(_, c)| word(*c))
}

/// `\bsk-[A-Za-z0-9_-]{10,}\b` at `i` (greedy, with backtracking).
fn match_sk(chars: &Chars, i: usize) -> Option<usize> {
    if !boundary_before(chars, i, ascii_word) {
        return None;
    }
    let start = literal(chars, i, "sk-")?;
    let class = |c: char| c.is_ascii_alphanumeric() || c == '_' || c == '-';
    let end = run(chars, start, class);
    // Longest k >= 10 with a word boundary after the k-th character.
    let is_word_at = |j: usize| chars.get(j).is_some_and(|(_, c)| ascii_word(*c));
    (start + 10..=end)
        .rev()
        .find(|&k| is_word_at(k - 1) != is_word_at(k))
}

const PEM_KINDS: [&str; 5] = ["", "RSA ", "EC ", "OPENSSH ", "ENCRYPTED "];

/// A PEM private-key block at `i`, through the matching END or end of input.
fn match_pem(chars: &Chars, i: usize) -> Option<usize> {
    let after_begin = literal(chars, i, "-----BEGIN ")?;
    for kind in PEM_KINDS {
        let label = format!("{kind}PRIVATE KEY");
        let Some(after_label) = literal(chars, after_begin, &label) else {
            continue;
        };
        let Some(body) = literal(chars, after_label, "-----") else {
            continue;
        };
        let end_line = format!("-----END {label}-----");
        let end = (body..chars.len())
            .find_map(|j| literal(chars, j, &end_line))
            .unwrap_or(chars.len());
        return Some(end);
    }
    None
}

/// `[token]{8,}=*` at `i`.
fn token_tail(chars: &Chars, i: usize) -> Option<usize> {
    let end = run(chars, i, token_char);
    (end - i >= 8).then(|| run(chars, end, |c| c == '='))
}

fn authorization(chars: &Chars, i: usize) -> Option<usize> {
    if !boundary_before(chars, i, iu_word) {
        return None;
    }
    let mut j = literal_ci(chars, i, "authorization")?;
    j = run(chars, j, char::is_whitespace);
    if !chars.get(j).is_some_and(|(_, c)| matches!(c, ':' | '=')) {
        return None;
    }
    j = run(chars, j + 1, char::is_whitespace);
    if let Some(after) = literal_ci(chars, j, "bearer") {
        let token = run(chars, after, char::is_whitespace);
        if token > after
            && let Some(end) = token_tail(chars, token)
        {
            return Some(end);
        }
    }
    token_tail(chars, j)
}

fn bearer(chars: &Chars, i: usize) -> Option<usize> {
    if !boundary_before(chars, i, iu_word) {
        return None;
    }
    let after = literal_ci(chars, i, "bearer")?;
    let token = run(chars, after, char::is_whitespace);
    if token == after {
        return None;
    }
    let end = run(chars, token, token_char);
    if !chars[token..end]
        .iter()
        .any(|(_, c)| digit_or_separator(*c))
    {
        return None;
    }
    token_tail(chars, token)
}

fn upper_or_digit(c: char) -> bool {
    c.is_ascii_uppercase() || c.is_ascii_digit()
}

fn at_char(chars: &Chars, i: usize, class: impl Fn(char) -> bool) -> bool {
    chars.get(i).is_some_and(|(_, c)| class(*c))
}

/// `[_-]?` — consume one separator when present.
fn separator(chars: &Chars, i: usize) -> usize {
    if at_char(chars, i, |c| matches!(c, '_' | '-')) {
        i + 1
    } else {
        i
    }
}

/// `\b(?:AKIA|ASIA)[A-Z0-9]{16}\b`.
fn aws_access_key_id(chars: &Chars, i: usize) -> Option<usize> {
    if !boundary_before(chars, i, ascii_word) {
        return None;
    }
    let start = literal(chars, i, "AKIA").or_else(|| literal(chars, i, "ASIA"))?;
    let end = start + 16;
    ((start..end).all(|j| at_char(chars, j, upper_or_digit)) && !at_char(chars, end, ascii_word))
        .then_some(end)
}

/// The AWS secret key name: `aws[_-]?secret[_-]?(?:access[_-]?)?key` or
/// `secret[_-]?access[_-]?key` (ASCII case-insensitive), then `\b`.
fn aws_secret_key_name(chars: &Chars, i: usize) -> Option<usize> {
    let secret_access_key = |j: usize| {
        let j = separator(chars, literal_ci(chars, j, "secret")?);
        let j = separator(chars, literal_ci(chars, j, "access")?);
        literal_ci(chars, j, "key")
    };
    let end = literal_ci(chars, i, "aws")
        .and_then(|j| {
            let j = separator(chars, j);
            let j = separator(chars, literal_ci(chars, j, "secret")?);
            literal_ci(chars, j, "access")
                .and_then(|k| literal_ci(chars, separator(chars, k), "key"))
                .or_else(|| literal_ci(chars, j, "key"))
        })
        .or_else(|| secret_access_key(i))?;
    (!at_char(chars, end, ascii_word)).then_some(end)
}

/// `\b<name>\b["']?[ \t]*(?:=>|[:=])[ \t]*["']?[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])`.
fn aws_secret_access_key(chars: &Chars, i: usize) -> Option<usize> {
    if !boundary_before(chars, i, ascii_word) {
        return None;
    }
    let quote = |c: char| matches!(c, '"' | '\'');
    let blank = |c: char| matches!(c, ' ' | '\t');
    let secret = |c: char| c.is_ascii_alphanumeric() || matches!(c, '/' | '+');
    let mut j = aws_secret_key_name(chars, i)?;
    if at_char(chars, j, quote) {
        j += 1;
    }
    j = run(chars, j, blank);
    let assigned = [
        literal(chars, j, "=>"),
        literal(chars, j, ":"),
        literal(chars, j, "="),
    ];
    assigned.into_iter().flatten().find_map(|after| {
        let mut k = run(chars, after, blank);
        if at_char(chars, k, quote) {
            k += 1;
        }
        let end = k + 40;
        ((k..end).all(|m| at_char(chars, m, secret))
            && !at_char(chars, end, |c| secret(c) || c == '='))
        .then_some(end)
    })
}

/// `\bgh[pousr]_[A-Za-z0-9]{36,}(?![A-Za-z0-9_])`.
fn github_token(chars: &Chars, i: usize) -> Option<usize> {
    if !boundary_before(chars, i, ascii_word) {
        return None;
    }
    let j = literal(chars, i, "gh")?;
    if !at_char(chars, j, |c| matches!(c, 'p' | 'o' | 'u' | 's' | 'r')) {
        return None;
    }
    let start = literal(chars, j + 1, "_")?;
    let end = run(chars, start, |c| c.is_ascii_alphanumeric());
    (end - start >= 36 && !at_char(chars, end, |c| c == '_')).then_some(end)
}

/// `\bgithub_pat_[A-Za-z0-9_]{22,}`.
fn github_fine_grained_token(chars: &Chars, i: usize) -> Option<usize> {
    if !boundary_before(chars, i, ascii_word) {
        return None;
    }
    let start = literal(chars, i, "github_pat_")?;
    let end = run(chars, start, ascii_word);
    (end - start >= 22).then_some(end)
}

/// `\bxox[abprs]-[A-Za-z0-9-]{10,}`.
fn slack_token(chars: &Chars, i: usize) -> Option<usize> {
    if !boundary_before(chars, i, ascii_word) {
        return None;
    }
    let j = literal(chars, i, "xox")?;
    if !at_char(chars, j, |c| matches!(c, 'a' | 'b' | 'p' | 'r' | 's')) {
        return None;
    }
    let start = literal(chars, j + 1, "-")?;
    let end = run(chars, start, |c| c.is_ascii_alphanumeric() || c == '-');
    (end - start >= 10).then_some(end)
}

/// `\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])`.
fn google_api_key(chars: &Chars, i: usize) -> Option<usize> {
    if !boundary_before(chars, i, ascii_word) {
        return None;
    }
    let start = literal(chars, i, "AIza")?;
    // Inspect exactly 35 key characters plus the boundary character: a scan
    // to the end of the run would make repeated `AIza-` text quadratic.
    let key = |c: char| ascii_word(c) || c == '-';
    let end = start + 35;
    ((start..end).all(|j| at_char(chars, j, key)) && !at_char(chars, end, key)).then_some(end)
}

type Matcher = fn(&Chars, usize) -> Option<usize>;

/// Server order: redaction consumes an authorization literal before a bare
/// bearer literal, so a header plus token is one span.
const PATTERNS: [Matcher; 10] = [
    match_sk,
    match_pem,
    authorization,
    bearer,
    aws_access_key_id,
    aws_secret_access_key,
    github_token,
    github_fine_grained_token,
    slack_token,
    google_api_key,
];

/// Leftmost non-overlapping matches of one pattern, as char index ranges.
fn matches_of(chars: &Chars, pattern: Matcher) -> Vec<Range<usize>> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        match pattern(chars, i) {
            Some(end) if end > i => {
                out.push(i..end);
                i = end;
            }
            _ => i += 1,
        }
    }
    out
}

/// True when `text` contains any known credential pattern.
pub fn contains_known_credential_patterns(text: &str) -> bool {
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    PATTERNS
        .iter()
        .any(|pattern| (0..chars.len()).any(|i| pattern(&chars, i).is_some_and(|end| end > i)))
}

/// UTF-8 byte ranges of every match (per pattern, leftmost non-overlapping),
/// sorted by start.
pub fn known_credential_ranges(text: &str) -> Vec<Range<usize>> {
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let mut out: Vec<Range<usize>> = PATTERNS
        .iter()
        .flat_map(|pattern| matches_of(&chars, *pattern))
        .map(|r| byte_at(&chars, r.start, text.len())..byte_at(&chars, r.end, text.len()))
        .collect();
    out.sort_by_key(|r| r.start);
    out
}

/// Replace credential-shaped substrings with `[redacted]` (patterns applied
/// in server order, each over the previous output).
pub fn redact_sensitive_substrings(text: &str) -> String {
    let mut out = text.to_owned();
    for pattern in PATTERNS {
        let chars: Vec<(usize, char)> = out.char_indices().collect();
        let ranges = matches_of(&chars, pattern);
        if ranges.is_empty() {
            continue;
        }
        let mut next = String::with_capacity(out.len());
        let mut last = 0;
        for range in ranges {
            let start = byte_at(&chars, range.start, out.len());
            next.push_str(&out[last..start]);
            next.push_str("[redacted]");
            last = byte_at(&chars, range.end, out.len());
        }
        next.push_str(&out[last..]);
        out = next;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // Mirrors `sensitive-text.test.ts`.
    #[test]
    fn documents_the_detector_as_a_conservative_floor() {
        assert!(!contains_known_credential_patterns(
            "routine prose without tokens"
        ));
        assert!(!contains_known_credential_patterns(
            "custom api_key=not-in-floor"
        ));
    }

    #[test]
    fn matches_known_credential_patterns() {
        for text in [
            "prefix sk-proj-abcdefghijklmnopqrstuvwxyz suffix",
            "-----BEGIN RSA PRIVATE KEY-----",
            "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
            "Authorization: Bearer super-secret-value",
            "Bearer synthetic-review-token-0123456789",
            "authorization=abcdefgh12345678",
            "AUTHORIZATION : abcdefgh",
            "Bearer\tsynthetic-review-token-0123456789",
            "bearer\u{3000}abcdefg1",
        ] {
            assert!(contains_known_credential_patterns(text), "{text:?}");
        }
    }

    #[test]
    fn keeps_english_and_near_misses_out_of_the_floor() {
        for text in [
            "the bearer of bad news",
            "Bearer authentication is required",
            "Bearer abcdefghijkl",
            "Bearer abc1",
            "ask-proj-abcdefghijklmnop",
            "sk-short",
            "sk-abcdefghi",
            "xauthorization: abcdefgh1234",
            "authorization: short",
            "-----BEGIN PUBLIC KEY-----",
            "-----BEGIN DSA PRIVATE KEY-----",
        ] {
            assert!(!contains_known_credential_patterns(text), "{text:?}");
        }
    }

    #[test]
    fn sk_boundary_backtracks_like_the_regex() {
        // `\b` after at least ten class characters: "sk-abcdefghij-" ends in
        // a word/non-word boundary after "j".
        assert!(contains_known_credential_patterns("sk-abcdefghij-"));
        // All-dash tail never has a word character before a boundary.
        assert!(!contains_known_credential_patterns("sk-----------"));
        // Non-ASCII letters are not `\w` for the ASCII pattern.
        assert!(contains_known_credential_patterns("ésk-abcdefghijk"));
    }

    #[test]
    fn unicode_case_folding_letters_are_word_and_token_characters() {
        // `ſ` folds to `s` under `iu`, so it is a token character...
        assert!(contains_known_credential_patterns("Bearer ſſſſſſſ1"));
        // ...and a word character, so no boundary before "bearer".
        assert!(!contains_known_credential_patterns("ſbearer abcdefg1"));
    }

    #[test]
    fn redacts_matched_patterns_completely() {
        let redacted =
            redact_sensitive_substrings("leaked sk-proj-abcdefghijklmnopqrstuvwxyz here");
        assert_eq!(redacted, "leaked [redacted] here");
        let header =
            redact_sensitive_substrings("Authorization: Bearer synthetic-review-token-0123456789");
        assert!(!header.contains("synthetic-review-token"));
        assert!(!header.contains("Bearer"));
        let bare = redact_sensitive_substrings("token Bearer abcdefgh-1234 tail");
        assert_eq!(bare, "token [redacted] tail");
        let pem = redact_sensitive_substrings(
            "a -----BEGIN EC PRIVATE KEY-----\nk\n-----END EC PRIVATE KEY----- b",
        );
        assert_eq!(pem, "a [redacted] b");
        let unclosed = redact_sensitive_substrings("x -----BEGIN PRIVATE KEY-----\nkey material");
        assert_eq!(unclosed, "x [redacted]");
    }

    #[derive(serde::Deserialize)]
    struct FixtureCase {
        name: String,
        parts: Vec<String>,
        redacted: Option<String>,
    }

    #[derive(serde::Deserialize)]
    struct RepeatedPrefix {
        name: String,
        unit: Vec<String>,
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Fixtures {
        positive: Vec<FixtureCase>,
        negative: Vec<FixtureCase>,
        repeated_prefixes: Vec<RepeatedPrefix>,
    }

    fn shared_fixtures() -> Fixtures {
        serde_json::from_str(include_str!(
            "../../../../../packages/api/src/lib/kb/fixtures/sensitive-text.json"
        ))
        .expect("shared sensitive-text fixtures parse")
    }

    // The same fixture drives `sensitive-text.test.ts`.
    #[test]
    fn shared_provider_token_fixtures_match_the_server() {
        let fixtures = shared_fixtures();
        assert!(!fixtures.positive.is_empty() && !fixtures.negative.is_empty());
        for case in fixtures.positive {
            let text = case.parts.concat();
            assert!(contains_known_credential_patterns(&text), "{}", case.name);
            assert!(!known_credential_ranges(&text).is_empty(), "{}", case.name);
            let expected = case
                .redacted
                .as_deref()
                .expect("positive case has `redacted`");
            assert_eq!(
                redact_sensitive_substrings(&text),
                expected,
                "{}",
                case.name
            );
        }
        for case in fixtures.negative {
            let text = case.parts.concat();
            assert!(!contains_known_credential_patterns(&text), "{}", case.name);
            assert_eq!(redact_sensitive_substrings(&text), text, "{}", case.name);
        }
    }

    // Adversarial repeated prefixes (shared with sensitive-text.test.ts): each
    // pattern family must stay linear. Each takes well under a second in a
    // debug build at 256 KiB; quadratic work would be ~10^10-10^11 steps.
    #[test]
    fn repeated_prefixes_stay_linear() {
        const TARGET: usize = 256 << 10;
        let fixtures = shared_fixtures();
        assert!(!fixtures.repeated_prefixes.is_empty());
        for case in fixtures.repeated_prefixes {
            let unit = case.unit.concat();
            let text = unit.repeat(TARGET / unit.len() + 1);
            let started = std::time::Instant::now();
            let _ = contains_known_credential_patterns(&text);
            let _ = known_credential_ranges(&text);
            let _ = redact_sensitive_substrings(&text);
            let elapsed = started.elapsed();
            assert!(
                elapsed < std::time::Duration::from_secs(10),
                "{} took {elapsed:?}",
                case.name
            );
        }
    }

    #[test]
    fn ranges_are_utf8_byte_offsets() {
        let text = "é sk-abcdefghijklmn";
        let ranges = known_credential_ranges(text);
        assert_eq!(ranges.len(), 1);
        assert_eq!(&text[ranges[0].clone()], "sk-abcdefghijklmn");
    }
}
