//! R2-27 (TS twin `packages/api/src/lib/kb/plain-snippet.ts`, shared corpus
//! `fixtures/plain-snippet.json`): format source windows before clipping.
//! Markdown passes mirror the TS version after protecting literal code.

/// ECMAScript `\s` (WhiteSpace and LineTerminator).
fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}
/// ECMAScript `.` without the `s` flag.
fn js_dot(c: char) -> bool {
    !matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}
/// ECMAScript `\w`.
fn js_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}
/// `[\p{Alphabetic}\p{N}_]`.
fn word_char(c: char) -> bool {
    c.is_alphabetic() || c.is_numeric() || c == '_'
}

/// `/<\/?[a-z][^<>]*>/gi` -> " "
fn tags(s: &[char]) -> Vec<char> {
    let mut out = vec![];
    let mut i = 0;
    while i < s.len() {
        if s[i] == '<' {
            let mut j = i + 1;
            if j < s.len() && s[j] == '/' {
                j += 1;
            }
            if j < s.len() && s[j].is_ascii_alphabetic() {
                j += 1;
                while j < s.len() && s[j] != '<' && s[j] != '>' {
                    j += 1;
                }
                if j < s.len() && s[j] == '>' {
                    out.push(' ');
                    i = j + 1;
                    continue;
                }
            }
        }
        out.push(s[i]);
        i += 1;
    }
    out
}
/// `[label]` then `(...)` or `[...]` (`open2`/`close2`), replaced by the
/// label; `image` requires the leading `!`, `nonempty` a nonempty label.
fn bracketed(s: &[char], image: bool, nonempty: bool, open2: char, close2: char) -> Vec<char> {
    let mut out = vec![];
    let mut i = 0;
    let mut end = 0;
    let mut close = 0;
    while i < s.len() {
        let start = if image {
            (s[i] == '!' && s.get(i + 1) == Some(&'[')).then_some(i + 2)
        } else {
            (s[i] == '[').then_some(i + 1)
        };
        if let Some(label) = start {
            // Cursors only advance: a failed opener never rescans the suffix.
            end = end.max(label);
            while end < s.len() && s[end] != ']' {
                end += 1;
            }
            if end < s.len() && (!nonempty || end > label) && s.get(end + 1) == Some(&open2) {
                close = close.max(end + 2);
                while close < s.len() && s[close] != close2 {
                    close += 1;
                }
                if close < s.len() {
                    out.extend_from_slice(&s[label..end]);
                    i = close + 1;
                    continue;
                }
            }
        }
        out.push(s[i]);
        i += 1;
    }
    out
}
/// `/(^|\s)#{1,6}(?=\s|$)/g` and `/(^|\s):?(?:-{3,}|\*{3,}|_{3,}):?(?=\s|$)/g`
/// -> "$1": a whitespace-delimited token that is entirely the marker goes.
fn marker_tokens(s: &[char], marker: fn(&[char]) -> bool) -> Vec<char> {
    let mut out = vec![];
    let mut i = 0;
    while i < s.len() {
        if i == 0 || js_space(s[i - 1]) {
            let end = s[i..]
                .iter()
                .position(|c| js_space(*c))
                .map_or(s.len(), |p| i + p);
            if end > i && marker(&s[i..end]) {
                i = end;
                continue;
            }
        }
        out.push(s[i]);
        i += 1;
    }
    out
}
fn heading(t: &[char]) -> bool {
    (1..=6).contains(&t.len()) && t.iter().all(|c| *c == '#')
}
fn rule(t: &[char]) -> bool {
    let t = t.strip_prefix(&[':']).unwrap_or(t);
    let t = t.strip_suffix(&[':']).unwrap_or(t);
    t.len() >= 3 && matches!(t[0], '-' | '*' | '_') && t.iter().all(|c| *c == t[0])
}
/// `/^\s*(?:>+|[-*+])\s+/` -> ""
fn leading_marker(s: &[char]) -> Vec<char> {
    let mut i = s.iter().take_while(|c| js_space(**c)).count();
    let quotes = s[i..].iter().take_while(|c| **c == '>').count();
    if quotes > 0 {
        i += quotes;
    } else if matches!(s.get(i), Some('-' | '*' | '+')) {
        i += 1;
    } else {
        return s.to_vec();
    }
    let spaces = s[i..].iter().take_while(|c| js_space(**c)).count();
    if spaces == 0 {
        return s.to_vec();
    }
    s[i + spaces..].to_vec()
}
/// The lazy `(?=\S)(.*?\S)` + `close` + optional negative lookahead: the
/// inner end, if `s[from..]` holds one.
fn lazy_inner(
    s: &[char],
    from: usize,
    close: &[char],
    after_ok: fn(Option<&char>) -> bool,
    multiline: bool,
) -> Option<usize> {
    if s.get(from).is_none_or(|c| js_space(*c)) {
        return None;
    }
    let mut e = from + 1;
    loop {
        // `.` must have matched s[e - 1].
        if !multiline && !js_dot(s[e - 1]) {
            return None;
        }
        if !js_space(s[e - 1])
            && s.get(e..e + close.len()) == Some(close)
            && after_ok(s.get(e + close.len()))
        {
            return Some(e);
        }
        if e >= s.len() {
            return None;
        }
        e += 1;
    }
}
/// Paired emphasis (including triple stars), across line boundaries.
fn emphasis(s: &[char]) -> Vec<char> {
    let mut out = vec![];
    let mut i = 0;
    'scan: while i < s.len() {
        let mut delimiters: Vec<usize> = vec![];
        if s.get(i..i + 3) == Some(&['*', '*', '*']) {
            delimiters.push(3);
        }
        if s.get(i..i + 2) == Some(&['*', '*']) {
            delimiters.push(2);
        }
        if s.get(i..i + 2) == Some(&['~', '~']) {
            delimiters.push(2);
        }
        if s[i] == '*' {
            delimiters.push(1);
        }
        for len in delimiters {
            if let Some(end) = lazy_inner(s, i + len, &s[i..i + len], |_| true, true) {
                out.extend_from_slice(&s[i + len..end]);
                i = end + len;
                continue 'scan;
            }
        }
        out.push(s[i]);
        i += 1;
    }
    out
}
/// `/(^|[^\p{Alphabetic}\p{N}_])(__?)(?=\S)(.*?\S)\2(?![\p{Alphabetic}\p{N}_])/gu`
/// -> "$1$3"
fn underscores(s: &[char]) -> Vec<char> {
    let mut out = vec![];
    let mut i = 0;
    'scan: while i < s.len() {
        // `^` (only at 0), then a consumed non-word character.
        let mut starts = vec![];
        if i == 0 {
            starts.push(0);
        }
        if !word_char(s[i]) {
            starts.push(1);
        }
        for lead in starts {
            let at = i + lead;
            for len in [2, 1] {
                if s.get(at..at + len)
                    .is_some_and(|d| d.iter().all(|c| *c == '_'))
                    && let Some(end) = lazy_inner(
                        s,
                        at + len,
                        &s[at..at + len],
                        |c| c.is_none_or(|c| !word_char(*c)),
                        false,
                    )
                {
                    out.extend_from_slice(&s[i..at]);
                    out.extend_from_slice(&s[at + len..end]);
                    i = end + len;
                    continue 'scan;
                }
            }
        }
        out.push(s[i]);
        i += 1;
    }
    out
}
/// Protect code contents before any Markdown pass. A source-absent marker
/// prevents literal input from impersonating a protected span.
fn protect_code(s: &[char]) -> (Vec<char>, Vec<String>, String) {
    let mut longest = 0;
    let mut run = 0;
    for c in s {
        run = if *c == '\0' { run + 1 } else { 0 };
        longest = longest.max(run);
    }
    let marker = format!("{}:", "\0".repeat(longest + 1));
    let mut out = vec![];
    let mut literals = vec![];
    let mut i = 0;
    while i < s.len() {
        if s[i] != '`' {
            out.push(s[i]);
            i += 1;
            continue;
        }
        let run = s[i..].iter().take_while(|c| **c == '`').count();
        let mut start = i + run;
        if run >= 3 {
            while start < s.len() && (js_word(s[start]) || s[start] == '-') {
                start += 1;
            }
        }
        let mut end = start;
        while end < s.len() {
            if s[end] != '`' {
                end += 1;
                continue;
            }
            let close = s[end..].iter().take_while(|c| **c == '`').count();
            if close == run {
                break;
            }
            end += close;
        }
        let key = format!("{marker}{}{marker}", literals.len());
        if run >= 3 {
            out.push(' ');
        }
        out.extend(key.chars());
        if run >= 3 {
            out.push(' ');
        }
        literals.push(s[start..end].iter().collect());
        i = if end < s.len() { end + run } else { end };
    }
    (out, literals, marker)
}

/// Whitespace runs become one space; trimmed.
fn finish(s: &[char]) -> String {
    let mut out = String::new();
    let mut space = false;
    for c in s.iter().copied() {
        if js_space(c) {
            space = true;
            continue;
        }
        if space && !out.is_empty() {
            out.push(' ');
        }
        space = false;
        out.push(c);
    }
    out
}
pub fn plain_snippet(markdown: &str) -> String {
    let s = markdown.chars().collect::<Vec<_>>();
    let (s, literals, marker) = protect_code(&s);
    let s = tags(&s);
    let s = bracketed(&s, true, false, '(', ')');
    let s = bracketed(&s, false, true, '(', ')');
    let s = bracketed(&s, false, true, '[', ']');
    let s = s
        .into_iter()
        .map(|c| if c == '|' { ' ' } else { c })
        .collect::<Vec<_>>();
    let s = marker_tokens(&s, heading);
    let s = marker_tokens(&s, rule);
    let s = leading_marker(&s);
    let s = emphasis(&s);
    let s = underscores(&s);
    // Unpaired stars may be literal globs; preserve them when lookahead ends.
    // Restore in one pass; never search/copy the whole output per code span.
    let protected: String = s.iter().collect();
    let mut plain = String::new();
    let mut cursor = 0;
    while let Some(offset) = protected[cursor..].find(&marker) {
        let start = cursor + offset;
        plain.push_str(&protected[cursor..start]);
        let digits = start + marker.len();
        let end = digits
            + protected[digits..]
                .bytes()
                .take_while(u8::is_ascii_digit)
                .count();
        if protected[end..].starts_with(&marker)
            && let Some(literal) = protected[digits..end]
                .parse::<usize>()
                .ok()
                .and_then(|i| literals.get(i))
        {
            plain.push_str(literal);
            cursor = end + marker.len();
        } else {
            plain.push_str(&marker);
            cursor = digits;
        }
    }
    plain.push_str(&protected[cursor..]);
    finish(&plain.chars().collect::<Vec<_>>())
}

#[cfg(test)]
mod tests {
    #[test]
    fn near_limit_formatting_matches_the_shared_corpus() {
        let corpus: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../../packages/api/src/lib/kb/fixtures/plain-snippet.json"
        ))
        .expect("shared corpus");
        for case in corpus["stressCases"].as_array().expect("stress cases") {
            let count = case["repeat"].as_u64().unwrap() as usize;
            let input = case["head"].as_str().unwrap().to_owned()
                + &case["unit"].as_str().unwrap().repeat(count)
                + case["tail"].as_str().unwrap();
            let expected = case["plainHead"].as_str().unwrap().to_owned()
                + &case["plainUnit"].as_str().unwrap().repeat(count)
                + case["plainTail"].as_str().unwrap();
            let plain = super::plain_snippet(&input);
            assert!(plain == expected, "{}", case["name"]);
            let snippet = crate::chunk::citation_snippet(&input);
            assert_eq!(
                snippet,
                case["snippet"].as_str().unwrap(),
                "{}",
                case["name"]
            );
        }
    }

    #[test]
    fn plain_snippet_matches_the_shared_corpus() {
        let corpus: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../../packages/api/src/lib/kb/fixtures/plain-snippet.json"
        ))
        .expect("shared corpus");
        let mut failures = vec![];
        for case in corpus["cases"].as_array().expect("cases") {
            let input = case["input"].as_str().expect("input");
            let expected = case["plain"].as_str().expect("plain");
            let got = super::plain_snippet(input);
            if got != expected {
                failures.push(format!("{input:?}: {got:?} != {expected:?}"));
            }
        }
        for case in corpus["clippedCases"].as_array().expect("clipped cases") {
            let input = case["input"].as_str().expect("input");
            let expected = case["plain"].as_str().expect("plain");
            let got = crate::chunk::citation_snippet(input);
            if got != expected {
                failures.push(format!("clipped {input:?}: {got:?} != {expected:?}"));
            }
        }
        assert!(failures.is_empty(), "{}", failures.join("\n"));
    }
}
