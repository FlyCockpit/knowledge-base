//! kb/1 repository path rules, mirroring the TypeScript reference normalizer
//! (`packages/api/src/lib/kb/paths.ts`): relative, NFC, bounded, no dot or Git
//! metadata segments, no Windows reserved names, plus the full Unicode
//! case-fold key used for collision checks.

use unicode_normalization::UnicodeNormalization;

/// Maximum UTF-8 byte length of a kb path.
pub const PATH_MAX_BYTES: usize = 512;
/// Maximum number of `/`-separated segments in a kb path.
pub const PATH_MAX_SEGMENTS: usize = 32;

/// Why a path was rejected. Carries no part of the rejected value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PathIssue {
    Empty,
    Absolute,
    Backslash,
    Dot,
    DotDot,
    Control,
    ByteOrderMark,
    TooLong,
    TooDeep,
    NotNfc,
    GitReserved,
    WindowsReserved,
    NotPortable,
}

const WINDOWS_RESERVED: [&str; 22] = [
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// Validate one kb path exactly as the server path normalizer does.
pub fn check_kb_path(raw: &str) -> Result<(), PathIssue> {
    if raw.is_empty() {
        return Err(PathIssue::Empty);
    }
    let bytes = raw.as_bytes();
    if raw.starts_with('/')
        || (bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':')
    {
        return Err(PathIssue::Absolute);
    }
    if raw.contains('\\') {
        return Err(PathIssue::Backslash);
    }
    if !raw.nfc().eq(raw.chars()) {
        return Err(PathIssue::NotNfc);
    }
    if raw.len() > PATH_MAX_BYTES {
        return Err(PathIssue::TooLong);
    }
    if raw.split('/').count() > PATH_MAX_SEGMENTS {
        return Err(PathIssue::TooDeep);
    }
    for segment in raw.split('/') {
        if segment.is_empty() {
            return Err(PathIssue::Empty);
        }
        if segment == "." {
            return Err(PathIssue::Dot);
        }
        if segment == ".." {
            return Err(PathIssue::DotDot);
        }
        if segment.chars().any(|c| (c as u32) < 0x20 || c == '\u{7f}') {
            return Err(PathIssue::Control);
        }
        if segment.contains('\u{feff}') {
            return Err(PathIssue::ByteOrderMark);
        }
        if is_git_metadata_segment(segment) {
            return Err(PathIssue::GitReserved);
        }
        if WINDOWS_RESERVED.contains(&windows_reserved_basename(segment).as_str()) {
            return Err(PathIssue::WindowsReserved);
        }
        let stem = if segment.to_ascii_lowercase().ends_with(".md") {
            &segment[..segment.len() - 3]
        } else {
            segment
        };
        if segment.contains(['<', '>', ':', '"', '|', '?', '*'])
            || segment.starts_with(' ')
            || segment.ends_with([' ', '.'])
            || stem.ends_with([' ', '.'])
        {
            return Err(PathIssue::NotPortable);
        }
    }
    Ok(())
}

/// Case-fold collision key for a whole path (per-segment full case fold).
pub fn casefold_path_key(path: &str) -> String {
    path.split('/')
        .map(casefold_segment)
        .collect::<Vec<_>>()
        .join("/")
}

/// NFKC, full Unicode case fold (CaseFolding.txt C+F exceptions, lowercase
/// elsewhere), then NFKC again — identical to the TypeScript key.
fn casefold_segment(segment: &str) -> String {
    let mut folded = String::with_capacity(segment.len());
    for ch in segment.nfkc() {
        match CASEFOLD_EXPANSIONS.binary_search_by_key(&(ch as u32), |(cp, _)| *cp) {
            Ok(index) => folded.push_str(CASEFOLD_EXPANSIONS[index].1),
            Err(_) => folded.extend(ch.to_lowercase()),
        }
    }
    folded.nfkc().collect()
}

fn is_git_metadata_segment(segment: &str) -> bool {
    let folded: String = casefold_segment(segment)
        .chars()
        .filter(|c| {
            !matches!(*c as u32,
                0x200c..=0x200f | 0x202a..=0x202e | 0x206a..=0x206f | 0xfeff)
        })
        .collect();
    let head = folded.split(':').next().unwrap_or_default();
    let basename = head.trim_end_matches([' ', '.']);
    basename == ".git" || basename == "git~1"
}

/// JavaScript `\s` (with the `u` flag): WhiteSpace plus LineTerminator.
fn is_js_space(c: char) -> bool {
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

fn windows_reserved_basename(segment: &str) -> String {
    let folded = casefold_segment(segment);
    let without_trailing = folded.trim_end_matches(|c| c == '.' || is_js_space(c));
    let base = match without_trailing.find('.') {
        Some(dot) => &without_trailing[..dot],
        None => without_trailing,
    };
    base.trim_end_matches(|c| c == '.' || is_js_space(c))
        .to_owned()
}

/// Copy of `CASEFOLD_EXPANSIONS` in `packages/api/src/lib/kb/paths.ts`,
/// sorted by code point. The drift test below re-reads the TypeScript source.
const CASEFOLD_EXPANSIONS: &[(u32, &str)] = &[
    (181, "\u{3bc}"),
    (223, "ss"),
    (329, "\u{2bc}n"),
    (383, "s"),
    (496, "j\u{30c}"),
    (837, "\u{3b9}"),
    (912, "\u{3b9}\u{308}\u{301}"),
    (944, "\u{3c5}\u{308}\u{301}"),
    (962, "\u{3c3}"),
    (976, "\u{3b2}"),
    (977, "\u{3b8}"),
    (981, "\u{3c6}"),
    (982, "\u{3c0}"),
    (1008, "\u{3ba}"),
    (1009, "\u{3c1}"),
    (1013, "\u{3b5}"),
    (1415, "\u{565}\u{582}"),
    (5024, "\u{13a0}"),
    (5025, "\u{13a1}"),
    (5026, "\u{13a2}"),
    (5027, "\u{13a3}"),
    (5028, "\u{13a4}"),
    (5029, "\u{13a5}"),
    (5030, "\u{13a6}"),
    (5031, "\u{13a7}"),
    (5032, "\u{13a8}"),
    (5033, "\u{13a9}"),
    (5034, "\u{13aa}"),
    (5035, "\u{13ab}"),
    (5036, "\u{13ac}"),
    (5037, "\u{13ad}"),
    (5038, "\u{13ae}"),
    (5039, "\u{13af}"),
    (5040, "\u{13b0}"),
    (5041, "\u{13b1}"),
    (5042, "\u{13b2}"),
    (5043, "\u{13b3}"),
    (5044, "\u{13b4}"),
    (5045, "\u{13b5}"),
    (5046, "\u{13b6}"),
    (5047, "\u{13b7}"),
    (5048, "\u{13b8}"),
    (5049, "\u{13b9}"),
    (5050, "\u{13ba}"),
    (5051, "\u{13bb}"),
    (5052, "\u{13bc}"),
    (5053, "\u{13bd}"),
    (5054, "\u{13be}"),
    (5055, "\u{13bf}"),
    (5056, "\u{13c0}"),
    (5057, "\u{13c1}"),
    (5058, "\u{13c2}"),
    (5059, "\u{13c3}"),
    (5060, "\u{13c4}"),
    (5061, "\u{13c5}"),
    (5062, "\u{13c6}"),
    (5063, "\u{13c7}"),
    (5064, "\u{13c8}"),
    (5065, "\u{13c9}"),
    (5066, "\u{13ca}"),
    (5067, "\u{13cb}"),
    (5068, "\u{13cc}"),
    (5069, "\u{13cd}"),
    (5070, "\u{13ce}"),
    (5071, "\u{13cf}"),
    (5072, "\u{13d0}"),
    (5073, "\u{13d1}"),
    (5074, "\u{13d2}"),
    (5075, "\u{13d3}"),
    (5076, "\u{13d4}"),
    (5077, "\u{13d5}"),
    (5078, "\u{13d6}"),
    (5079, "\u{13d7}"),
    (5080, "\u{13d8}"),
    (5081, "\u{13d9}"),
    (5082, "\u{13da}"),
    (5083, "\u{13db}"),
    (5084, "\u{13dc}"),
    (5085, "\u{13dd}"),
    (5086, "\u{13de}"),
    (5087, "\u{13df}"),
    (5088, "\u{13e0}"),
    (5089, "\u{13e1}"),
    (5090, "\u{13e2}"),
    (5091, "\u{13e3}"),
    (5092, "\u{13e4}"),
    (5093, "\u{13e5}"),
    (5094, "\u{13e6}"),
    (5095, "\u{13e7}"),
    (5096, "\u{13e8}"),
    (5097, "\u{13e9}"),
    (5098, "\u{13ea}"),
    (5099, "\u{13eb}"),
    (5100, "\u{13ec}"),
    (5101, "\u{13ed}"),
    (5102, "\u{13ee}"),
    (5103, "\u{13ef}"),
    (5104, "\u{13f0}"),
    (5105, "\u{13f1}"),
    (5106, "\u{13f2}"),
    (5107, "\u{13f3}"),
    (5108, "\u{13f4}"),
    (5109, "\u{13f5}"),
    (5112, "\u{13f0}"),
    (5113, "\u{13f1}"),
    (5114, "\u{13f2}"),
    (5115, "\u{13f3}"),
    (5116, "\u{13f4}"),
    (5117, "\u{13f5}"),
    (7296, "\u{432}"),
    (7297, "\u{434}"),
    (7298, "\u{43e}"),
    (7299, "\u{441}"),
    (7300, "\u{442}"),
    (7301, "\u{442}"),
    (7302, "\u{44a}"),
    (7303, "\u{463}"),
    (7304, "\u{a64b}"),
    (7830, "h\u{331}"),
    (7831, "t\u{308}"),
    (7832, "w\u{30a}"),
    (7833, "y\u{30a}"),
    (7834, "a\u{2be}"),
    (7835, "\u{1e61}"),
    (7838, "ss"),
    (8016, "\u{3c5}\u{313}"),
    (8018, "\u{3c5}\u{313}\u{300}"),
    (8020, "\u{3c5}\u{313}\u{301}"),
    (8022, "\u{3c5}\u{313}\u{342}"),
    (8064, "\u{1f00}\u{3b9}"),
    (8065, "\u{1f01}\u{3b9}"),
    (8066, "\u{1f02}\u{3b9}"),
    (8067, "\u{1f03}\u{3b9}"),
    (8068, "\u{1f04}\u{3b9}"),
    (8069, "\u{1f05}\u{3b9}"),
    (8070, "\u{1f06}\u{3b9}"),
    (8071, "\u{1f07}\u{3b9}"),
    (8072, "\u{1f00}\u{3b9}"),
    (8073, "\u{1f01}\u{3b9}"),
    (8074, "\u{1f02}\u{3b9}"),
    (8075, "\u{1f03}\u{3b9}"),
    (8076, "\u{1f04}\u{3b9}"),
    (8077, "\u{1f05}\u{3b9}"),
    (8078, "\u{1f06}\u{3b9}"),
    (8079, "\u{1f07}\u{3b9}"),
    (8080, "\u{1f20}\u{3b9}"),
    (8081, "\u{1f21}\u{3b9}"),
    (8082, "\u{1f22}\u{3b9}"),
    (8083, "\u{1f23}\u{3b9}"),
    (8084, "\u{1f24}\u{3b9}"),
    (8085, "\u{1f25}\u{3b9}"),
    (8086, "\u{1f26}\u{3b9}"),
    (8087, "\u{1f27}\u{3b9}"),
    (8088, "\u{1f20}\u{3b9}"),
    (8089, "\u{1f21}\u{3b9}"),
    (8090, "\u{1f22}\u{3b9}"),
    (8091, "\u{1f23}\u{3b9}"),
    (8092, "\u{1f24}\u{3b9}"),
    (8093, "\u{1f25}\u{3b9}"),
    (8094, "\u{1f26}\u{3b9}"),
    (8095, "\u{1f27}\u{3b9}"),
    (8096, "\u{1f60}\u{3b9}"),
    (8097, "\u{1f61}\u{3b9}"),
    (8098, "\u{1f62}\u{3b9}"),
    (8099, "\u{1f63}\u{3b9}"),
    (8100, "\u{1f64}\u{3b9}"),
    (8101, "\u{1f65}\u{3b9}"),
    (8102, "\u{1f66}\u{3b9}"),
    (8103, "\u{1f67}\u{3b9}"),
    (8104, "\u{1f60}\u{3b9}"),
    (8105, "\u{1f61}\u{3b9}"),
    (8106, "\u{1f62}\u{3b9}"),
    (8107, "\u{1f63}\u{3b9}"),
    (8108, "\u{1f64}\u{3b9}"),
    (8109, "\u{1f65}\u{3b9}"),
    (8110, "\u{1f66}\u{3b9}"),
    (8111, "\u{1f67}\u{3b9}"),
    (8114, "\u{1f70}\u{3b9}"),
    (8115, "\u{3b1}\u{3b9}"),
    (8116, "\u{3ac}\u{3b9}"),
    (8118, "\u{3b1}\u{342}"),
    (8119, "\u{3b1}\u{342}\u{3b9}"),
    (8124, "\u{3b1}\u{3b9}"),
    (8126, "\u{3b9}"),
    (8130, "\u{1f74}\u{3b9}"),
    (8131, "\u{3b7}\u{3b9}"),
    (8132, "\u{3ae}\u{3b9}"),
    (8134, "\u{3b7}\u{342}"),
    (8135, "\u{3b7}\u{342}\u{3b9}"),
    (8140, "\u{3b7}\u{3b9}"),
    (8146, "\u{3b9}\u{308}\u{300}"),
    (8147, "\u{3b9}\u{308}\u{301}"),
    (8150, "\u{3b9}\u{342}"),
    (8151, "\u{3b9}\u{308}\u{342}"),
    (8162, "\u{3c5}\u{308}\u{300}"),
    (8163, "\u{3c5}\u{308}\u{301}"),
    (8164, "\u{3c1}\u{313}"),
    (8166, "\u{3c5}\u{342}"),
    (8167, "\u{3c5}\u{308}\u{342}"),
    (8178, "\u{1f7c}\u{3b9}"),
    (8179, "\u{3c9}\u{3b9}"),
    (8180, "\u{3ce}\u{3b9}"),
    (8182, "\u{3c9}\u{342}"),
    (8183, "\u{3c9}\u{342}\u{3b9}"),
    (8188, "\u{3c9}\u{3b9}"),
    (43888, "\u{13a0}"),
    (43889, "\u{13a1}"),
    (43890, "\u{13a2}"),
    (43891, "\u{13a3}"),
    (43892, "\u{13a4}"),
    (43893, "\u{13a5}"),
    (43894, "\u{13a6}"),
    (43895, "\u{13a7}"),
    (43896, "\u{13a8}"),
    (43897, "\u{13a9}"),
    (43898, "\u{13aa}"),
    (43899, "\u{13ab}"),
    (43900, "\u{13ac}"),
    (43901, "\u{13ad}"),
    (43902, "\u{13ae}"),
    (43903, "\u{13af}"),
    (43904, "\u{13b0}"),
    (43905, "\u{13b1}"),
    (43906, "\u{13b2}"),
    (43907, "\u{13b3}"),
    (43908, "\u{13b4}"),
    (43909, "\u{13b5}"),
    (43910, "\u{13b6}"),
    (43911, "\u{13b7}"),
    (43912, "\u{13b8}"),
    (43913, "\u{13b9}"),
    (43914, "\u{13ba}"),
    (43915, "\u{13bb}"),
    (43916, "\u{13bc}"),
    (43917, "\u{13bd}"),
    (43918, "\u{13be}"),
    (43919, "\u{13bf}"),
    (43920, "\u{13c0}"),
    (43921, "\u{13c1}"),
    (43922, "\u{13c2}"),
    (43923, "\u{13c3}"),
    (43924, "\u{13c4}"),
    (43925, "\u{13c5}"),
    (43926, "\u{13c6}"),
    (43927, "\u{13c7}"),
    (43928, "\u{13c8}"),
    (43929, "\u{13c9}"),
    (43930, "\u{13ca}"),
    (43931, "\u{13cb}"),
    (43932, "\u{13cc}"),
    (43933, "\u{13cd}"),
    (43934, "\u{13ce}"),
    (43935, "\u{13cf}"),
    (43936, "\u{13d0}"),
    (43937, "\u{13d1}"),
    (43938, "\u{13d2}"),
    (43939, "\u{13d3}"),
    (43940, "\u{13d4}"),
    (43941, "\u{13d5}"),
    (43942, "\u{13d6}"),
    (43943, "\u{13d7}"),
    (43944, "\u{13d8}"),
    (43945, "\u{13d9}"),
    (43946, "\u{13da}"),
    (43947, "\u{13db}"),
    (43948, "\u{13dc}"),
    (43949, "\u{13dd}"),
    (43950, "\u{13de}"),
    (43951, "\u{13df}"),
    (43952, "\u{13e0}"),
    (43953, "\u{13e1}"),
    (43954, "\u{13e2}"),
    (43955, "\u{13e3}"),
    (43956, "\u{13e4}"),
    (43957, "\u{13e5}"),
    (43958, "\u{13e6}"),
    (43959, "\u{13e7}"),
    (43960, "\u{13e8}"),
    (43961, "\u{13e9}"),
    (43962, "\u{13ea}"),
    (43963, "\u{13eb}"),
    (43964, "\u{13ec}"),
    (43965, "\u{13ed}"),
    (43966, "\u{13ee}"),
    (43967, "\u{13ef}"),
    (64256, "ff"),
    (64257, "fi"),
    (64258, "fl"),
    (64259, "ffi"),
    (64260, "ffl"),
    (64261, "st"),
    (64262, "st"),
    (64275, "\u{574}\u{576}"),
    (64276, "\u{574}\u{565}"),
    (64277, "\u{574}\u{56b}"),
    (64278, "\u{57e}\u{576}"),
    (64279, "\u{574}\u{56d}"),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn casefold_table_matches_typescript_source() {
        let source = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../../packages/api/src/lib/kb/paths.ts"
        ))
        .expect("TypeScript path normalizer is readable");
        let start = source
            .find("const CASEFOLD_EXPANSIONS")
            .expect("table present");
        let body = &source[start..];
        let body = &body[..body.find("};").expect("table end")];
        let mut parsed = Vec::new();
        for line in body.lines().skip(1) {
            let line = line.trim().trim_end_matches(',');
            let Some((cp, value)) = line.split_once(": ") else {
                continue;
            };
            let cp: u32 = cp.parse().expect("decimal code point");
            let value: String = serde_json::from_str(value).expect("JSON-compatible string");
            parsed.push((cp, value));
        }
        let ours: Vec<(u32, String)> = CASEFOLD_EXPANSIONS
            .iter()
            .map(|(cp, v)| (*cp, (*v).to_owned()))
            .collect();
        assert_eq!(parsed, ours, "casefold table drifted from paths.ts");
        assert!(
            CASEFOLD_EXPANSIONS.windows(2).all(|w| w[0].0 < w[1].0),
            "sorted for search"
        );
    }

    #[test]
    fn folds_known_collisions() {
        assert_eq!(
            casefold_path_key("Docs/Straße.md"),
            casefold_path_key("docs/STRASSE.md")
        );
        assert_eq!(casefold_segment("Σ"), casefold_segment("ς"));
        assert_ne!(casefold_path_key("a/b"), casefold_path_key("a/c"));
    }

    #[test]
    fn rejects_the_reference_path_classes() {
        for (path, issue) in [
            ("", PathIssue::Empty),
            ("/abs", PathIssue::Absolute),
            ("C:/x", PathIssue::Absolute),
            ("a\\b", PathIssue::Backslash),
            ("a//b", PathIssue::Empty),
            ("./a", PathIssue::Dot),
            ("a/../b", PathIssue::DotDot),
            ("a\u{7f}", PathIssue::Control),
            ("a\u{feff}b", PathIssue::ByteOrderMark),
            ("cafe\u{301}.md", PathIssue::NotNfc),
            (".git/config", PathIssue::GitReserved),
            ("x/.GIT. /y", PathIssue::GitReserved),
            ("x/.git\u{200c}:stream", PathIssue::GitReserved),
            ("GIT~1/y", PathIssue::GitReserved),
            ("con", PathIssue::WindowsReserved),
            ("docs/Com1.txt.md", PathIssue::WindowsReserved),
            ("lpt9 . ", PathIssue::WindowsReserved),
            ("1:b", PathIssue::NotPortable),
        ] {
            assert_eq!(check_kb_path(path), Err(issue), "{path:?}");
        }
        let long = "a".repeat(PATH_MAX_BYTES + 1);
        assert_eq!(check_kb_path(&long), Err(PathIssue::TooLong));
        let deep = vec!["a"; PATH_MAX_SEGMENTS + 1].join("/");
        assert_eq!(check_kb_path(&deep), Err(PathIssue::TooDeep));
        for ok in [
            "docs/guide.md",
            "notes/café.md",
            "console.md",
            ".gitignore-notes/x",
        ] {
            assert_eq!(check_kb_path(ok), Ok(()), "{ok:?}");
        }
    }
}
