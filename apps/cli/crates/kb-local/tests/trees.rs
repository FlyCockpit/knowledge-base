//! Whole-tree validation against real Git objects.
//!
//! The shared TypeScript corpus (`packages/api/src/lib/kb/fixtures/tree-cases.json`)
//! is read directly; the expected decisions below are the ones asserted by
//! `packages/api/src/lib/kb/validate-tree.test.ts`. Every case must be
//! classified, so a new TS case fails here until Rust decides it too.

#[path = "support/fixture.rs"]
mod fixture;

use std::cell::RefCell;
use std::collections::BTreeMap;

use fixture::{Fixture, GITIGNORE, INDEX, MANIFEST, sha, with_required};
use kb_client::types::Sha;
use kb_local::git_read::{GitError, GitRepo, IncomingBudget, WalkBudget, walk_tree};
use kb_local::tree::{
    EmptyAssetsNoSealed, ManifestEntry, SealedOccurrence, TREE_LIMITS, TreeCode, TreeError,
    TreePolicy, validate_commit, validate_newly_reachable,
};

fn corpus() -> BTreeMap<String, BTreeMap<String, String>> {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../../packages/api/src/lib/kb/fixtures/tree-cases.json"
    );
    let raw = std::fs::read_to_string(path).expect("shared tree corpus");
    let value: serde_json::Value = serde_json::from_str(&raw).expect("corpus json");
    let mut out = BTreeMap::new();
    for (name, case) in value.as_object().expect("object") {
        let mut files = BTreeMap::new();
        for (path, content) in case["files"].as_object().expect("files") {
            files.insert(path.clone(), content.as_str().expect("string").to_owned());
        }
        out.insert(name.clone(), files);
    }
    out
}

const VALID: &[&str] = &[
    "validMinimal",
    "citationsShape",
    "crlfBody",
    "unicodePath",
    "multibyteFrontmatter",
    "yamlCommentsAndBlocks",
    "flowCitations",
    "indentationlessCitations",
    "nestedFlowArrays",
];

/// Invalid cases; `Some(code)` where the TS test pins the failure code.
const INVALID: &[(&str, Option<TreeCode>)] = &[
    ("nonPortablePath0", Some(TreeCode::Path)),
    ("nonPortablePath1", Some(TreeCode::Path)),
    ("nonPortablePath2", Some(TreeCode::Path)),
    ("nonPortablePath3", Some(TreeCode::Path)),
    ("nonPortablePath4", Some(TreeCode::Path)),
    ("nonPortablePath5", Some(TreeCode::Path)),
    ("nonPortablePath6", Some(TreeCode::Path)),
    ("nonPortablePath7", Some(TreeCode::Path)),
    ("nonPortablePath8", Some(TreeCode::Path)),
    ("nonPortablePath9", Some(TreeCode::Path)),
    ("nonPortablePath10", Some(TreeCode::Path)),
    ("nonPortablePath11", Some(TreeCode::Path)),
    ("nonPortablePath12", Some(TreeCode::Path)),
    ("duplicateDocumentId", Some(TreeCode::DocumentId)),
    ("manifestPathCollision", Some(TreeCode::Manifest)),
    ("forbiddenControlInBody", Some(TreeCode::Markdown)),
    ("yamlDuplicateKey", Some(TreeCode::Markdown)),
    ("sigmaCaseCollision", Some(TreeCode::Path)),
    ("sharpSCaseCollision", Some(TreeCode::Path)),
    ("greekCasefoldCollision", Some(TreeCode::Path)),
    ("yamlQuotedKeyDuplicate", Some(TreeCode::Markdown)),
    ("assetsNestedBlob", Some(TreeCode::FileKind)),
    ("numericDocumentId", Some(TreeCode::Markdown)),
    ("sealedInComment", Some(TreeCode::Sealed)),
    ("sealedInQuotedKey", Some(TreeCode::Sealed)),
    ("foldedLeadingBlankDuplicateId", Some(TreeCode::DocumentId)),
    ("hexadecimalDocumentId", Some(TreeCode::Markdown)),
    ("octalDocumentId", Some(TreeCode::Markdown)),
    ("cherokeeCaseCollision", Some(TreeCode::Path)),
    ("cherokeeUppercaseVariantCollision", Some(TreeCode::Path)),
    ("escapedDel", Some(TreeCode::Markdown)),
    ("escapedOutOfRangeCodepoint", Some(TreeCode::Markdown)),
];

fn commit_case(fx: &Fixture, files: &BTreeMap<String, String>) -> Sha {
    let list: Vec<(&str, &[u8])> = files
        .iter()
        .map(|(p, c)| (p.as_str(), c.as_bytes()))
        .collect();
    sha(&fx.commit_files(&list, &[]))
}

fn code_of(result: Result<impl std::fmt::Debug, TreeError>) -> TreeCode {
    match result {
        Err(TreeError::Invalid(v)) => v.code,
        other => panic!("expected a tree violation, got {other:?}"),
    }
}

fn check(fx: &Fixture, commit: &Sha) -> Result<(), TreeError> {
    let repo = GitRepo::open(&fx.repo).expect("repo");
    validate_commit(&repo, commit, &EmptyAssetsNoSealed).map(|_| ())
}

fn check_files(tag: &str, extra: &[(&str, &[u8])]) -> Result<(), TreeError> {
    let fx = Fixture::new(tag);
    let commit = sha(&fx.commit_files(&with_required(extra), &[]));
    check(&fx, &commit)
}

#[test]
fn shared_corpus_matches_typescript_decisions() {
    let cases = corpus();
    let mut classified: Vec<&str> = VALID.to_vec();
    classified.extend(INVALID.iter().map(|(n, _)| *n));
    classified.sort_unstable();
    let mut names: Vec<&str> = cases.keys().map(String::as_str).collect();
    names.sort_unstable();
    assert_eq!(names, classified, "every shared case must be classified");

    let fx = Fixture::new("corpus");
    for name in VALID {
        let commit = commit_case(&fx, &cases[*name]);
        assert!(
            check(&fx, &commit).is_ok(),
            "{name} must be accepted: {:?}",
            check(&fx, &commit)
        );
    }
    for (name, expected) in INVALID {
        let commit = commit_case(&fx, &cases[*name]);
        let code = code_of(check(&fx, &commit));
        if let Some(expected) = expected {
            assert_eq!(code, *expected, "{name}");
        }
    }
}

#[test]
fn file_modes_match_git_ls_tree_canonicalization() {
    let fx = Fixture::new("modes");
    let index = fx.blob(INDEX);
    let gitignore = fx.blob(GITIGNORE);
    let manifest = fx.blob(MANIFEST);
    let assets = fx.raw_tree(&[("100644", b"manifest.json", &manifest)]);
    let repo = GitRepo::open(&fx.repo).unwrap();
    let with_doc = |mode: &str, target: &str| {
        let tree = fx.raw_tree(&[
            ("40000", b".assets", &assets),
            ("100644", b".gitignore", &gitignore),
            (mode, b"doc.md", target),
            ("100644", b"index.md", &index),
        ]);
        let commit = sha(&fx.commit(&tree, &[]));
        validate_commit(&repo, &commit, &EmptyAssetsNoSealed)
    };
    assert_eq!(code_of(with_doc("100755", &index)), TreeCode::Mode);
    assert_eq!(code_of(with_doc("120000", &index)), TreeCode::Mode);
    let other = fx.commit(&fx.raw_tree(&[]), &[]);
    assert_eq!(code_of(with_doc("160000", &other)), TreeCode::Type);
    // Git canonicalizes group-writable regular files to 100644 (ls-tree parity).
    assert!(with_doc("100664", &index).is_ok());
}

#[test]
fn path_rules_reject_before_content() {
    for (tag, path, code) in [
        ("win", "con.md", TreeCode::Path),
        ("winext", "docs/LPT1.txt.md", TreeCode::Path),
        ("nfd", "docs/u\u{308}ber.md", TreeCode::Path),
        ("gitdir", ".git/x.md", TreeCode::Path),
        ("txt", "notes.txt", TreeCode::FileKind),
        ("assetsdoc", ".assets/x.md", TreeCode::FileKind),
    ] {
        let result = check_files(tag, &[(path, b"# x\n")]);
        assert_eq!(code_of(result), code, "{path}");
    }
}

#[test]
fn malformed_raw_trees_are_structure_or_budget_failures() {
    let fx = Fixture::new("raw");
    let index = fx.blob(INDEX);
    let gitignore = fx.blob(GITIGNORE);
    let manifest = fx.blob(MANIFEST);
    let assets = fx.raw_tree(&[("100644", b"manifest.json", &manifest)]);
    let repo = GitRepo::open(&fx.repo).unwrap();
    let run = |entries: &[(&str, &[u8], &str)]| {
        let commit = sha(&fx.commit(&fx.raw_tree(entries), &[]));
        validate_commit(&repo, &commit, &EmptyAssetsNoSealed)
    };
    let base = |extra: (&'static str, &'static [u8])| {
        vec![
            ("40000", b".assets".as_slice(), assets.as_str()),
            ("100644", b".gitignore".as_slice(), gitignore.as_str()),
            (extra.0, extra.1, index.as_str()),
            ("100644", b"index.md".as_slice(), index.as_str()),
        ]
    };
    // Duplicate entry name inside one tree object.
    let mut dup = base(("100644", b"a.md"));
    dup.insert(3, ("100644", b"a.md", index.as_str()));
    assert_eq!(code_of(run(&dup)), TreeCode::Path);
    // Out of Git order.
    let mut unordered = base(("100644", b"a.md"));
    unordered.swap(2, 3);
    assert_eq!(code_of(run(&unordered)), TreeCode::Path);
    // A raw name containing a slash would alias a real subtree.
    assert_eq!(code_of(run(&base(("100644", b"a/b.md")))), TreeCode::Path);
    // Non-UTF-8 names fail like TS (`TreeReadBudgetError` -> TREE_BUDGET).
    assert_eq!(
        code_of(run(&base(("100644", b"b\xff.md")))),
        TreeCode::Budget
    );
    // Missing required root file.
    let missing = vec![
        ("40000", b".assets".as_slice(), assets.as_str()),
        ("100644", b".gitignore".as_slice(), gitignore.as_str()),
        ("100644", b"a.md".as_slice(), index.as_str()),
    ];
    assert_eq!(code_of(run(&missing)), TreeCode::Required);
}

#[test]
fn reserved_files_are_exact() {
    assert_eq!(
        code_of(check_files("gi", &[(".gitignore", b"# kb managed\n*\n")])),
        TreeCode::FileKind
    );
    assert_eq!(
        code_of(check_files(
            "mf",
            &[(".assets/manifest.json", b"{\"entries\":[],\"version\":1}\n")]
        )),
        TreeCode::Manifest
    );
    // A canonical nonempty manifest is refused by the initial empty-only policy.
    let entry = b"{\"version\":1,\"entries\":[{\"path\":\"img/a.png\",\"hash\":\"sha256:1111111111111111111111111111111111111111111111111111111111111111\",\"size\":3,\"mime\":\"image/png\"}]}\n";
    assert_eq!(
        code_of(check_files("mfe", &[(".assets/manifest.json", entry)])),
        TreeCode::Manifest
    );
    // Case-folded directory/file clash anywhere in the tree.
    assert_eq!(
        code_of(check_files(
            "fold",
            &[("Docs/a.md", b"a\n"), ("docs", b"b\n")]
        )),
        TreeCode::Path
    );
}

struct Recording {
    manifest_commits: RefCell<Vec<Option<String>>>,
    sealed: RefCell<Vec<SealedOccurrence>>,
    allow_hash: &'static str,
}

impl TreePolicy for Recording {
    fn check_manifest_entry(
        &self,
        commit: Option<&Sha>,
        entry: &ManifestEntry,
    ) -> Result<(), String> {
        self.manifest_commits
            .borrow_mut()
            .push(commit.map(|c| c.as_str().to_owned()));
        if entry.hash == self.allow_hash {
            Ok(())
        } else {
            Err("manifest hash is not authorized for this knowledge base".to_owned())
        }
    }

    fn check_sealed_references(
        &self,
        _commit: Option<&Sha>,
        refs: &[SealedOccurrence],
    ) -> Result<(), SealedOccurrence> {
        self.sealed.borrow_mut().extend(refs.iter().cloned());
        Ok(())
    }
}

#[test]
fn manifest_and_sealed_callbacks_see_every_new_commit() {
    let fx = Fixture::new("callbacks");
    let hash = "sha256:2222222222222222222222222222222222222222222222222222222222222222";
    let manifest = format!(
        "{{\"version\":1,\"entries\":[{{\"path\":\"img/a.png\",\"hash\":\"{hash}\",\"size\":3,\"mime\":\"image/png\"}}]}}\n"
    );
    let sealed_doc = b"see {{sealed:v1:knowledge_base:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222}}\n";
    let base = fx.commit_files(&with_required(&[]), &[]);
    let a = fx.commit_files(
        &with_required(&[
            (".assets/manifest.json", manifest.as_bytes()),
            ("s.md", sealed_doc),
        ]),
        &[&base],
    );
    let b = fx.commit_files(
        &with_required(&[
            (".assets/manifest.json", manifest.as_bytes()),
            ("t.md", b"t\n"),
        ]),
        &[&a],
    );
    let repo = GitRepo::open(&fx.repo).unwrap();
    let policy = Recording {
        manifest_commits: RefCell::new(Vec::new()),
        sealed: RefCell::new(Vec::new()),
        allow_hash: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
    };
    let validated = validate_newly_reachable(&repo, Some(&sha(&base)), &sha(&b), &policy).unwrap();
    assert_eq!(validated, vec![sha(&a), sha(&b)]);
    let seen = policy.manifest_commits.borrow();
    assert!(
        seen.contains(&Some(a.clone())),
        "ancestor commit context must be checked"
    );
    assert!(seen.contains(&Some(b.clone())));
    let sealed = policy.sealed.borrow();
    assert_eq!(sealed.len(), 1);
    assert_eq!(sealed[0].path, "s.md");
    assert_eq!(
        sealed[0].reference,
        "sealed:v1:knowledge_base:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222"
    );
    // The default policy refuses both.
    assert_eq!(
        code_of(validate_newly_reachable(
            &repo,
            Some(&sha(&base)),
            &sha(&b),
            &EmptyAssetsNoSealed
        )),
        TreeCode::Manifest
    );
}

#[test]
fn invalid_ancestor_with_valid_tip_is_rejected() {
    let fx = Fixture::new("ancestor");
    let base = fx.commit_files(&with_required(&[]), &[]);
    let bad = fx.commit_files(&with_required(&[("x.txt", b"not markdown\n")]), &[&base]);
    let tip = fx.commit_files(&with_required(&[("ok.md", b"fine\n")]), &[&bad]);
    let repo = GitRepo::open(&fx.repo).unwrap();
    // Tip-only validation would accept it...
    assert!(validate_commit(&repo, &sha(&tip), &EmptyAssetsNoSealed).is_ok());
    // ...but every newly reachable commit is validated.
    match validate_newly_reachable(&repo, Some(&sha(&base)), &sha(&tip), &EmptyAssetsNoSealed) {
        Err(TreeError::Invalid(v)) => {
            assert_eq!(v.code, TreeCode::FileKind);
            assert_eq!(v.path.as_deref(), Some("x.txt"));
        }
        other => panic!("expected FileKind, got {other:?}"),
    }
    // Initial publication (no old ref) walks the whole history too.
    assert_eq!(
        code_of(validate_newly_reachable(
            &repo,
            None,
            &sha(&tip),
            &EmptyAssetsNoSealed
        )),
        TreeCode::FileKind
    );
    // Starting after the bad commit leaves only the valid tip.
    assert_eq!(
        validate_newly_reachable(&repo, Some(&sha(&bad)), &sha(&tip), &EmptyAssetsNoSealed)
            .unwrap(),
        vec![sha(&tip)]
    );
}

#[test]
fn file_count_and_markdown_size_quotas() {
    let fx = Fixture::new("quota");
    let names: Vec<String> = (0..TREE_LIMITS.max_files - 4)
        .map(|i| format!("d/{i:05}.md"))
        .collect();
    let mut files: Vec<(&str, &[u8])> = with_required(&[]);
    files.extend(names.iter().map(|n| (n.as_str(), b"x\n".as_slice())));
    // Exactly max_files regular files: 3 required + (max - 4) + e.md.
    files.push(("e.md", b"x\n"));
    assert_eq!(files.len(), TREE_LIMITS.max_files);
    let ok = sha(&fx.commit_files(&files, &[]));
    assert!(check(&fx, &ok).is_ok());
    files.push(("f.md", b"x\n"));
    let over = sha(&fx.commit_files(&files, &[]));
    assert_eq!(code_of(check(&fx, &over)), TreeCode::Budget);

    let big = vec![b'a'; TREE_LIMITS.max_markdown_bytes + 1];
    assert_eq!(
        code_of(check_files("big", &[("big.md", &big)])),
        TreeCode::Budget
    );
    let exact = vec![b'a'; TREE_LIMITS.max_markdown_bytes];
    assert!(check_files("exact", &[("big.md", &exact)]).is_ok());
}

#[test]
fn whole_tree_byte_quota_counts_every_entry() {
    let fx = Fixture::new("bytes");
    let doc = vec![b'a'; TREE_LIMITS.max_markdown_bytes];
    let count = TREE_LIMITS.max_tree_bytes / TREE_LIMITS.max_markdown_bytes + 1;
    let names: Vec<String> = (0..count).map(|i| format!("{i:03}.md")).collect();
    let mut files = with_required(&[]);
    files.extend(names.iter().map(|n| (n.as_str(), doc.as_slice())));
    let commit = sha(&fx.commit_files(&files, &[]));
    assert_eq!(code_of(check(&fx, &commit)), TreeCode::Budget);

    // Repeated object IDs still charge every tree entry, while an exactly
    // full tree must remain valid with the production Git-child deadline.
    let required_bytes = GITIGNORE.len() + MANIFEST.len() + INDEX.len();
    let full_docs = TREE_LIMITS.max_tree_bytes / doc.len();
    let mut exact = with_required(&[]);
    exact.extend(
        names[..full_docs - 1]
            .iter()
            .map(|n| (n.as_str(), doc.as_slice())),
    );
    exact.push((
        names[full_docs - 1].as_str(),
        &doc[..doc.len() - required_bytes],
    ));
    let commit = sha(&fx.commit_files(&exact, &[]));
    assert!(check(&fx, &commit).is_ok());
}

#[test]
fn sealed_reference_at_end_of_full_size_document_is_rejected() {
    let reference = b"{{SEALED:V1:KNOWLEDGE_BASE:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222}}";
    let mut doc = vec![b'a'; TREE_LIMITS.max_markdown_bytes - reference.len()];
    doc.extend_from_slice(reference);
    assert_eq!(
        code_of(check_files("late-sealed", &[("doc.md", &doc)])),
        TreeCode::Sealed
    );
}

#[test]
fn entry_budget_and_early_walk_termination() {
    let fx = Fixture::new("entries");
    let empty = fx.raw_tree(&[]);
    let names: Vec<String> = (0..TREE_LIMITS.max_entries)
        .map(|i| format!("d{i:05}"))
        .collect();
    let mut entries: Vec<(&str, &[u8], &str)> = names
        .iter()
        .map(|n| ("40000", n.as_bytes(), empty.as_str()))
        .collect();
    entries.sort_by(|a, b| a.1.cmp(b.1));
    let big = fx.raw_tree(&entries);
    let repo = GitRepo::open(&fx.repo).unwrap();
    let mut reader = repo.object_reader().unwrap();
    // A small budget stops the walk right after it is exceeded, not after
    // visiting the whole tree.
    let mut budget = WalkBudget::new(10);
    let mut incoming = IncomingBudget::new(
        TREE_LIMITS.max_objects,
        TREE_LIMITS.max_uncompressed_object_bytes,
        None,
    );
    let err = walk_tree(&mut reader, &sha(&big), &mut budget, &mut incoming).unwrap_err();
    assert!(matches!(err, GitError::Budget(_)), "{err:?}");
    assert_eq!(budget.entries, 11);
    // The real budget rejects the whole tree (root + 8192 dirs > 8192).
    let commit = sha(&fx.commit(&big, &[]));
    assert_eq!(code_of(check(&fx, &commit)), TreeCode::Budget);
}

#[test]
fn depth_limit_is_enforced_during_descent() {
    let depth = TREE_LIMITS.max_tree_depth;
    let deep_ok = format!("{}x.md", "d/".repeat(depth - 1));
    assert!(check_files("depth-ok", &[(deep_ok.as_str(), b"x\n")]).is_ok());
    let too_deep = format!("{}x.md", "d/".repeat(depth));
    assert_eq!(
        code_of(check_files("depth", &[(too_deep.as_str(), b"x\n")])),
        TreeCode::Path
    );
}

#[test]
fn yaml_quotas_and_restrictions() {
    let mut big = b"---\nk: \"".to_vec();
    big.extend(std::iter::repeat_n(b'a', 64 * 1024));
    big.extend_from_slice(b"\"\n---\nbody\n");
    let nested = format!("---\nk: {}v{}\n---\n", "[".repeat(16), "]".repeat(16));
    let nested_ok = format!("---\nk: {}v{}\n---\n", "[".repeat(15), "]".repeat(15));
    for (tag, doc, ok) in [
        ("yaml-size", big.clone(), false),
        ("yaml-depth", nested.into_bytes(), false),
        ("yaml-depth-ok", nested_ok.into_bytes(), true),
        ("yaml-alias", b"---\na: &x 1\nb: *x\n---\n".to_vec(), false),
        ("yaml-tag", b"---\na: !!str 1\n---\n".to_vec(), false),
        ("yaml-merge", b"---\n<<: {a: 1}\n---\n".to_vec(), false),
        (
            "yaml-dup-flow",
            b"---\na: {b: 1, b: 2}\n---\n".to_vec(),
            false,
        ),
        (
            "yaml-unsafe-int",
            b"---\na: 9007199254740993\n---\n".to_vec(),
            false,
        ),
        (
            "yaml-ok",
            b"---\nid: doc-1\ntags: [a, b]\nn: 12\n---\nbody\n".to_vec(),
            true,
        ),
    ] {
        let result = check_files(tag, &[("doc.md", doc.as_slice())]);
        if ok {
            assert!(result.is_ok(), "{tag}: {result:?}");
        } else {
            assert_eq!(code_of(result), TreeCode::Markdown, "{tag}");
        }
    }
    assert_eq!(
        code_of(check_files(
            "dup-id",
            &[
                ("a.md", b"---\nid: same\n---\n"),
                ("b.md", b"---\nid: same\n---\n")
            ]
        )),
        TreeCode::DocumentId
    );
}

#[test]
fn commit_count_bound_stops_before_any_tree_is_read() {
    let fx = Fixture::new("commits");
    let base = fx.commit_files(&with_required(&[]), &[]);
    // Every commit's tree is invalid; the commit-count bound must fire first.
    let bad_tree = fx.tree(&[("x.txt", b"x\n")]);
    let mut parent = base.clone();
    for _ in 0..=TREE_LIMITS.max_new_commits {
        parent = fx.commit(&bad_tree, &[&parent]);
    }
    fx.set_ref("refs/heads/main", &parent);
    let repo = GitRepo::open(&fx.repo).unwrap();
    assert_eq!(
        code_of(validate_newly_reachable(
            &repo,
            Some(&sha(&base)),
            &sha(&parent),
            &EmptyAssetsNoSealed
        )),
        TreeCode::Budget
    );
    assert!(matches!(
        repo.commits_between(Some(&sha(&base)), &sha(&parent), 5),
        Err(GitError::Budget(_))
    ));
    assert!(matches!(
        repo.newly_reachable_objects(Some(&sha(&base)), &sha(&parent), 3),
        Err(GitError::Budget(_))
    ));
}

#[test]
fn newly_reachable_objects_exclude_restored_history() {
    let fx = Fixture::new("restored");
    let v1 = fx.commit_files(&with_required(&[("a.md", b"one\n")]), &[]);
    let v2 = fx.commit_files(&with_required(&[("a.md", b"two\n")]), &[&v1]);
    // v3 restores v1's exact tree: only the commit object is new.
    let v1_tree = fx.git(&["rev-parse", &format!("{v1}^{{tree}}")]);
    let v3 = fx.commit(&v1_tree, &[&v2]);
    let repo = GitRepo::open(&fx.repo).unwrap();
    let objects = repo
        .newly_reachable_objects(Some(&sha(&v2)), &sha(&v3), 100)
        .unwrap();
    assert_eq!(objects.len(), 1);
    assert!(objects.contains(&v3));
}

#[test]
fn incoming_metadata_exact_cap_deduplicates_preflight_and_full_validation() {
    let fx = Fixture::new("metadata-exact-cap");
    let tree = fx.tree(&with_required(&[]));
    // Distinct tree/blob bytes leave the remaining exact allowance for commits.
    let objects = fx.git(&["ls-tree", "-r", "-t", &tree]);
    let mut seen = std::collections::HashSet::from([tree.clone()]);
    for line in objects.lines() {
        seen.insert(line.split_whitespace().nth(2).unwrap().to_owned());
    }
    let other: usize = seen
        .iter()
        .map(|name| fx.git(&["cat-file", "-s", name]).parse::<usize>().unwrap())
        .sum();
    let mut parent = None;
    for i in 0..16 {
        let mut body = format!("tree {tree}\n{}author A <a@example.invalid> 1 +0000\ncommitter A <a@example.invalid> 1 +0000\n\n{i}\n", parent.as_ref().map_or(String::new(), |p| format!("parent {p}\n"))).into_bytes();
        body.resize(
            kb_local::git_read::METADATA_OBJECT_MAX_BYTES - if i == 15 { other } else { 0 },
            b'x',
        );
        parent = Some(fx.raw_commit(&body));
    }
    let new = parent.unwrap();
    fx.set_ref("refs/heads/main", &new);
    let repo = GitRepo::open(&fx.repo).unwrap();
    let commits = validate_newly_reachable(&repo, None, &sha(&new), &EmptyAssetsNoSealed).unwrap();
    assert_eq!(commits.len(), 16);
    // Re-entry and retained-history exclusion: the old large metadata is free.
    let next = sha(&fx.commit_files(&with_required(&[("next.md", b"next\n")]), &[&new]));
    assert_eq!(
        validate_newly_reachable(&repo, Some(&sha(&new)), &next, &EmptyAssetsNoSealed).unwrap(),
        vec![next]
    );
}
