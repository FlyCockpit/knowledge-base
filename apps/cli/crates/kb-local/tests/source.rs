//! Immutable source reads from real Git objects: reachability
//! within this repository, exact bytes, blob SHA, full-source contentHash
//! and UTF-8 body offsets. Nothing here is inferred from HEAD.

#[path = "support/fixture.rs"]
mod fixture;

use fixture::{Fixture, sha, with_required};
use kb_client::ErrorCode;
use kb_client::snapshot::{content_hash, git_blob_sha};
use kb_local::git_read::{GitError, GitRepo, SourceError, read_document};
use kb_local::markdown::YamlValue;

const DOC: &str = "---\r\ntitle: über\r\ntopic: 😊\r\nid: doc-ü\r\ncitations:\r\n  - label: Ref ✓\r\n    target: https://example.com/a\r\n---\r\nBody ü line\r\nsecond\r\n";

#[test]
fn reads_exact_source_with_utf8_body_offset() {
    let fx = Fixture::new("src");
    let commit = fx.commit_files(&with_required(&[("docs/a.md", DOC.as_bytes())]), &[]);
    let repo = GitRepo::open(&fx.repo).unwrap();
    let doc = read_document(&repo, &sha(&commit), "docs/a.md").unwrap();
    assert_eq!(doc.markdown, DOC);
    assert_eq!(doc.commit_sha, sha(&commit));
    assert_eq!(doc.path.as_str(), "docs/a.md");
    // Git's own blob name for the exact bytes, and SHA-256 of the whole source.
    let git_blob = fx.git(&["rev-parse", &format!("{commit}:docs/a.md")]);
    assert_eq!(doc.blob_sha.as_str(), git_blob);
    assert_eq!(doc.blob_sha, git_blob_sha(DOC.as_bytes()));
    assert_eq!(doc.content_hash, content_hash(DOC.as_bytes()));
    // Body starts after the CRLF closing delimiter, counted in UTF-8 bytes.
    let expected_start = DOC.find("Body").unwrap();
    assert_eq!(doc.body_start, expected_start);
    assert!(
        expected_start > DOC[..expected_start].chars().count(),
        "multibyte front matter"
    );
    assert_eq!(doc.body(), "Body ü line\r\nsecond\r\n");
    assert_eq!(doc.document_id.as_deref(), Some("doc-ü"));
    assert_eq!(
        doc.front_matter.get("title"),
        Some(&YamlValue::String("über".to_owned()))
    );
    assert_eq!(doc.citations.len(), 1);
    assert_eq!(doc.citations[0].label, "Ref ✓");
    assert_eq!(doc.citations[0].target, "https://example.com/a");
}

#[test]
fn old_commit_returns_old_bytes_not_head() {
    let fx = Fixture::new("history");
    let v1 = fx.commit_files(&with_required(&[("a.md", b"version one\n")]), &[]);
    let v2 = fx.commit_files(&with_required(&[("a.md", b"version two\n")]), &[&v1]);
    let repo = GitRepo::open(&fx.repo).unwrap();
    assert_eq!(
        read_document(&repo, &sha(&v1), "a.md").unwrap().markdown,
        "version one\n"
    );
    assert_eq!(
        read_document(&repo, &sha(&v2), "a.md").unwrap().markdown,
        "version two\n"
    );
    // A document deleted at HEAD is still readable at its cited commit.
    let v3 = fx.commit_files(&with_required(&[]), &[&v2]);
    assert!(matches!(
        read_document(&repo, &sha(&v3), "a.md"),
        Err(SourceError::NotFound)
    ));
    assert_eq!(
        read_document(&repo, &sha(&v2), "a.md").unwrap().markdown,
        "version two\n"
    );
}

#[test]
fn received_commit_identity_is_preserved() {
    let fx = Fixture::new("author");
    let tree = fx.tree(&with_required(&[]));
    let commit = fx.git_with_env(
        &["commit-tree", &tree, "-m", "external"],
        &[
            ("GIT_AUTHOR_NAME", "Ada Lovelace"),
            ("GIT_AUTHOR_EMAIL", "ada@example.invalid"),
            ("GIT_AUTHOR_DATE", "1111111111 +0130"),
            ("GIT_COMMITTER_NAME", "Pusher"),
            ("GIT_COMMITTER_EMAIL", "push@example.invalid"),
            ("GIT_COMMITTER_DATE", "1222222222 -0500"),
        ],
    );
    fx.set_ref("refs/heads/main", &commit);
    let repo = GitRepo::open(&fx.repo).unwrap();
    let info = repo.read_commit(&sha(&commit)).unwrap();
    assert_eq!(info.sha, sha(&commit));
    assert_eq!(info.tree.as_str(), tree);
    assert!(info.parents.is_empty());
    assert_eq!(
        info.author,
        "Ada Lovelace <ada@example.invalid> 1111111111 +0130"
    );
    assert_eq!(
        info.committer,
        "Pusher <push@example.invalid> 1222222222 -0500"
    );
}

#[test]
fn unreachable_and_foreign_revisions_are_not_found() {
    let fx = Fixture::new("reach");
    let main = fx.commit_files(&with_required(&[("a.md", b"a\n")]), &[]);
    // Dangling commit: present in the object store, reachable from no branch.
    let dangling = fx.commit(&fx.tree(&with_required(&[("b.md", b"b\n")])), &[&main]);
    // Retained non-main branch commits are readable.
    let side = fx.commit(&fx.tree(&with_required(&[("c.md", b"c\n")])), &[&main]);
    fx.set_ref("refs/heads/pr/1", &side);
    // A commit that exists only in another repository.
    let other = Fixture::new("reach-other");
    let foreign = other.commit_files(&with_required(&[("a.md", b"x\n")]), &[]);
    // A tree object and a blob object in this repository.
    let tree = fx.git(&["rev-parse", &format!("{main}^{{tree}}")]);
    let blob = fx.git(&["rev-parse", &format!("{main}:a.md")]);

    let repo = GitRepo::open(&fx.repo).unwrap();
    assert_eq!(
        repo.resolve_readable_commit(&sha(&main)).unwrap(),
        sha(&main)
    );
    assert_eq!(
        repo.resolve_readable_commit(&sha(&side)).unwrap(),
        sha(&side)
    );
    for missing in [&dangling, &foreign, &tree, &blob] {
        assert!(
            matches!(
                repo.resolve_readable_commit(&sha(missing)),
                Err(GitError::NotFound)
            ),
            "{missing}"
        );
        let err = read_document(&repo, &sha(missing), "a.md").unwrap_err();
        assert!(matches!(err, SourceError::NotFound), "{missing}: {err:?}");
        assert_eq!(err.protocol_code(), ErrorCode::NotFound);
    }
    // A refs/tags or refs/pr-style ref outside refs/heads does not make it readable.
    fx.set_ref("refs/tags/t", &dangling);
    assert!(matches!(
        repo.resolve_readable_commit(&sha(&dangling)),
        Err(GitError::NotFound)
    ));
}

#[test]
fn replace_refs_are_never_honored() {
    let fx = Fixture::new("replace");
    let real = fx.commit_files(&with_required(&[("a.md", b"real\n")]), &[]);
    let fake = fx.commit(&fx.tree(&with_required(&[("a.md", b"fake\n")])), &[]);
    fx.git(&["replace", &real, &fake]);
    let repo = GitRepo::open(&fx.repo).unwrap();
    assert_eq!(
        read_document(&repo, &sha(&real), "a.md").unwrap().markdown,
        "real\n"
    );
    let real_tree = fx.git(&[
        "--no-replace-objects",
        "rev-parse",
        &format!("{real}^{{tree}}"),
    ]);
    assert_eq!(
        repo.read_commit(&sha(&real)).unwrap().tree.as_str(),
        real_tree
    );
}

#[test]
fn invalid_paths_and_non_documents() {
    let fx = Fixture::new("paths");
    let commit = sha(&fx.commit_files(&with_required(&[("docs/a.md", b"a\n")]), &[]));
    let repo = GitRepo::open(&fx.repo).unwrap();
    for bad in [
        "",
        "/docs/a.md",
        "docs/../a.md",
        "docs\\a.md",
        "docs//a.md",
        "con.md",
    ] {
        let err = read_document(&repo, &commit, bad).unwrap_err();
        assert!(matches!(err, SourceError::InvalidPath), "{bad:?}: {err:?}");
        assert_eq!(err.protocol_code(), ErrorCode::InvalidArgument);
    }
    // A directory is not a document.
    assert!(matches!(
        read_document(&repo, &commit, "docs"),
        Err(SourceError::NotFound)
    ));
    assert!(matches!(
        read_document(&repo, &commit, "docs/missing.md"),
        Err(SourceError::NotFound)
    ));
    // Paths match exactly; case-folded spellings are different paths.
    assert!(matches!(
        read_document(&repo, &commit, "Docs/a.md"),
        Err(SourceError::NotFound)
    ));
}

#[test]
fn oversized_and_invalid_sources_fail_closed() {
    let fx = Fixture::new("bad-src");
    let big = vec![b'a'; 2 * 1024 * 1024 + 1];
    let commit = sha(&fx.commit_files(
        &with_required(&[("big.md", big.as_slice()), ("ctl.md", b"a\x01b\n")]),
        &[],
    ));
    let repo = GitRepo::open(&fx.repo).unwrap();
    assert!(matches!(
        read_document(&repo, &commit, "big.md"),
        Err(SourceError::TooLarge)
    ));
    let err = read_document(&repo, &commit, "ctl.md").unwrap_err();
    assert!(matches!(err, SourceError::InvalidMarkdown(_)), "{err:?}");
    assert_eq!(err.protocol_code(), ErrorCode::InvalidArgument);
}

#[test]
fn restricted_yaml_conformance_has_exact_decoded_values_and_kinds() {
    use kb_local::markdown::{MarkdownIssueCode, parse_markdown};
    fn decoded(value: &YamlValue) -> serde_json::Value {
        match value {
            YamlValue::Null => serde_json::Value::Null,
            YamlValue::Bool(b) => (*b).into(),
            YamlValue::Number(n) => serde_json::from_str(&n.to_string()).unwrap(),
            YamlValue::String(s) => s.clone().into(),
            YamlValue::Seq(items) => items.iter().map(decoded).collect(),
            YamlValue::Map(map) => map
                .entries()
                .iter()
                .map(|(k, v)| (k.clone(), decoded(v)))
                .collect(),
        }
    }
    let cases: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../../packages/api/src/lib/kb/fixtures/yaml-conformance.json"
    ))
    .unwrap();
    for case in cases.as_array().unwrap() {
        let source = format!("---\n{}\n---\nbody\n", case["yaml"].as_str().unwrap());
        let result = parse_markdown(source.as_bytes());
        if case.get("error").is_some() {
            assert_eq!(
                result.unwrap_err().code,
                MarkdownIssueCode::Yaml,
                "{}",
                case["name"]
            );
        } else {
            let parsed = result.unwrap();
            assert_eq!(
                decoded(&YamlValue::Map(parsed.front_matter)),
                case["value"],
                "{}",
                case["name"]
            );
        }
    }
}

#[test]
fn final_frontmatter_encoded_size_boundaries() {
    use kb_local::markdown::{MarkdownIssueCode, parse_markdown};
    for character in ["\t", "\"", "\\", "é", "😊"] {
        let width = serde_json::to_vec(character).unwrap().len() - 2;
        let value = character.repeat((64 * 1024 - 8) / width);
        assert_eq!(
            serde_json::to_vec(&serde_json::json!({"k":value}))
                .unwrap()
                .len(),
            64 * 1024
        );
        let source = format!("---\nk: '{value}'\n---\nbody\n");
        assert!(parse_markdown(source.as_bytes()).is_ok(), "{character:?}");
        let source = format!("---\nk: '{value}a'\n---\nbody\n");
        assert_eq!(
            parse_markdown(source.as_bytes()).unwrap_err().code,
            MarkdownIssueCode::FrontmatterSize,
            "{character:?}"
        );
    }
    let mut map = serde_json::Map::new();
    let mut prefix = String::new();
    for i in 0..2000 {
        map.insert(format!("k{i}"), "a".into());
        prefix.push_str(&format!("k{i}: a\n"));
    }
    map.insert("padding".into(), "".into());
    let padding = 64 * 1024 - serde_json::to_vec(&map).unwrap().len();
    for extra in [0, 1] {
        let source = format!(
            "---\n{prefix}padding: '{}'\n---\n",
            "a".repeat(padding + extra)
        );
        let result = parse_markdown(source.as_bytes());
        if extra == 0 {
            assert!(result.is_ok());
        } else {
            assert_eq!(result.unwrap_err().code, MarkdownIssueCode::FrontmatterSize);
        }
    }
}

#[test]
fn corrupt_revision_and_failed_traversal_are_storage_failures() {
    let fx = Fixture::new("corrupt-source");
    let first = fx.commit_files(&with_required(&[]), &[]);
    let second = fx.commit_files(&with_required(&[("a.md", b"a\n")]), &[&first]);
    let repo = GitRepo::open(&fx.repo).unwrap();
    let object = fx.repo.join("objects").join(&first[..2]).join(&first[2..]);
    std::fs::remove_file(&object).unwrap();
    std::fs::write(object, b"invalid zlib object").unwrap();
    for result in [
        repo.resolve_readable_commit(&sha(&first)),
        repo.resolve_readable_commit(&sha(&second)),
    ] {
        let error = result.unwrap_err();
        assert!(!matches!(error, GitError::NotFound), "{error:?}");
        assert_eq!(
            kb_local::StoreError::from(error).protocol_code(),
            ErrorCode::StorageUnavailable
        );
    }
    assert!(matches!(
        repo.commits_between(None, &sha(&second), 10),
        Err(GitError::Failed(_))
    ));
    // Missing/non-commit/foreign cases have a separate positive absence test.
    assert!(matches!(
        GitRepo::open(&fx.root.join("missing.git")),
        Err(GitError::NotFound)
    ));
    let file = fx.root.join("not-a-parent");
    std::fs::write(&file, b"file").unwrap();
    assert!(matches!(
        GitRepo::open(&file.join("repo.git")),
        Err(GitError::Io(_))
    ));
}

#[test]
fn missing_packed_revision_is_absent_but_corrupt_pack_is_storage_failure() {
    let fx = Fixture::new("packed-absence");
    let head = sha(&fx.commit_files(&with_required(&[]), &[]));
    fx.git(&["repack", "-ad"]);
    let repo = GitRepo::open(&fx.repo).unwrap();
    assert_eq!(repo.resolve_readable_commit(&head).unwrap(), head);
    let missing = sha("0000000000000000000000000000000000000000");
    assert!(matches!(
        repo.resolve_readable_commit(&missing),
        Err(GitError::NotFound)
    ));
    let pack = std::fs::read_dir(fx.repo.join("objects/pack"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .find(|p| p.extension().is_some_and(|e| e == "pack"))
        .unwrap();
    std::fs::remove_file(&pack).unwrap();
    std::fs::write(pack, b"invalid pack").unwrap();
    let error = repo.resolve_readable_commit(&head).unwrap_err();
    assert_eq!(
        kb_local::StoreError::from(error).protocol_code(),
        ErrorCode::StorageUnavailable
    );
}

#[cfg(unix)]
#[test]
fn unreadable_repo_is_io_error_and_permissions_are_restored() {
    use std::os::unix::fs::PermissionsExt;
    let fx = Fixture::new("permission-absence");
    let permissions = std::fs::metadata(&fx.root).unwrap().permissions();
    std::fs::set_permissions(&fx.root, std::fs::Permissions::from_mode(0o0)).unwrap();
    let native = std::fs::symlink_metadata(&fx.repo);
    let result = GitRepo::open(&fx.repo);
    std::fs::set_permissions(&fx.root, permissions).unwrap();
    // A root-runner has no discretionary permission denial. On ordinary
    // users this asserts the actual OS boundary, before fixture cleanup.
    if let Err(error) = native {
        assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
        assert!(
            matches!(result, Err(GitError::Io(ref e)) if e.kind() == std::io::ErrorKind::PermissionDenied)
        );
    }
}

#[test]
fn encoded_frontmatter_counts_portable_decimal_number_spelling() {
    use kb_local::markdown::{MarkdownIssueCode, parse_markdown};
    let mut yaml = String::new();
    let mut expected_json = String::from("{");
    for i in 0..3000 {
        yaml.push_str(&format!("n{i}: 1e-6\n"));
        expected_json.push_str(&format!("\"n{i}\":0.000001,"));
    }
    expected_json.push_str("\"padding\":\"\"}");
    let padding = 64 * 1024 - expected_json.len();
    for extra in [0, 1] {
        let source = format!(
            "---\n{yaml}padding: '{}'\n---\n",
            "a".repeat(padding + extra)
        );
        let result = parse_markdown(source.as_bytes());
        if extra == 0 {
            assert!(result.is_ok());
        } else {
            assert_eq!(result.unwrap_err().code, MarkdownIssueCode::FrontmatterSize);
        }
    }
}

#[test]
fn corrupt_payload_is_storage_failure_on_batch_and_source_reads() {
    let fx = Fixture::new("corrupt-payload");
    let head = sha(&fx.commit_files(&with_required(&[("a.md", b"a\n")]), &[]));
    let blob = fx.git(&["rev-parse", &format!("{head}:a.md")]);
    let object = fx.repo.join("objects").join(&blob[..2]).join(&blob[2..]);
    std::fs::remove_file(&object).unwrap();
    std::fs::write(object, b"invalid zlib").unwrap();
    let repo = GitRepo::open(&fx.repo).unwrap();
    let error = repo
        .object_reader()
        .unwrap()
        .read_checked(&blob, 10, &mut |_, _| Ok(()))
        .unwrap_err();
    assert_eq!(
        kb_local::StoreError::from(error).protocol_code(),
        ErrorCode::StorageUnavailable
    );
    assert_eq!(
        read_document(&repo, &head, "a.md")
            .unwrap_err()
            .protocol_code(),
        ErrorCode::StorageUnavailable
    );
    // The corrupt body does not turn a truly absent path into a storage fault.
    assert!(matches!(
        read_document(&repo, &head, "missing.md"),
        Err(SourceError::NotFound)
    ));
    let missing = "0000000000000000000000000000000000000000";
    assert!(matches!(
        repo.object_reader()
            .unwrap()
            .read_checked(missing, 10, &mut |_, _| Ok(())),
        Err(GitError::NotFound)
    ));
}

#[test]
fn missing_referenced_tree_is_storage_fault_after_pinning_revision() {
    let fx = Fixture::new("missing-reference");
    let head = sha(&fx.commit_files(&with_required(&[]), &[]));
    let tree = fx.git(&["rev-parse", &format!("{head}^{{tree}}")]);
    std::fs::remove_file(fx.repo.join("objects").join(&tree[..2]).join(&tree[2..])).unwrap();
    let repo = GitRepo::open(&fx.repo).unwrap();
    assert_eq!(repo.resolve_readable_commit(&head).unwrap(), head);
    assert_eq!(
        read_document(&repo, &head, "index.md")
            .unwrap_err()
            .protocol_code(),
        ErrorCode::StorageUnavailable
    );
}
