//! The immutable document catalog: pinned reads, pagination, cursors and live authority.

use super::*;

// ── Documents ───────────────────────────────────────────────────────────────

const CITED: &str = "---\nid: guide-1\ntitle: Guide\ncitations:\n  - label: Source\n    target: https://example.invalid/a\nextra:\n  depth: 2\n---\n# Guide v1\n\nBody.\n";

#[test]
fn historic_get_after_newer_head_returns_old_bytes() {
    let root = temp_root("historic");
    let store = Store::open(&root).expect("open");
    let owner = store.owner();
    let created = create(&store, &owner, "alpha", "create-key-docs-0001");
    let kb = kb_of(&created);
    let v1 = commit(
        &store,
        &kb,
        &head_of(&created),
        "commit-key-docs-0001",
        &[("docs/guide.md", CITED)],
    );
    let v2 = commit(
        &store,
        &kb,
        &v1,
        "commit-key-docs-0002",
        &[("docs/guide.md", "# Guide v2\n")],
    );
    let repo = store.paths().repo_dir(&kb);
    let old = get_doc(
        &store,
        &owner,
        json!({"kbId": kb.as_str(), "path": "docs/guide.md", "rev": v1.as_str()}),
    )
    .expect("historic get");
    assert_eq!(old["markdown"], CITED);
    assert_eq!(old["commitSha"], v1.as_str());
    assert_eq!(
        old["blobSha"],
        git(&repo, &["rev-parse", &format!("{v1}:docs/guide.md")]).as_str()
    );
    assert_eq!(old["contentHash"], content_hash(CITED.as_bytes()).as_str());
    assert_eq!(old["documentId"], "guide-1");
    assert_eq!(
        old["documentCitations"],
        json!([{"label": "Source", "target": "https://example.invalid/a"}])
    );
    assert_eq!(
        old["frontMatter"],
        json!({
            "id": "guide-1",
            "title": "Guide",
            "citations": [{"label": "Source", "target": "https://example.invalid/a"}],
            "extra": {"depth": 2},
        })
    );
    assert_eq!(old["assetRefs"], json!([]));
    // Default rev is the current head.
    let new = get_doc(
        &store,
        &owner,
        json!({"kbId": kb.as_str(), "path": "docs/guide.md"}),
    )
    .expect("head get");
    assert_eq!(new["markdown"], "# Guide v2\n");
    assert_eq!(new["commitSha"], v2.as_str());
    assert_eq!(new["documentId"], Value::Null);
    assert_eq!(new["frontMatter"], json!({}));
    // Missing path at a readable revision.
    let err = get_doc(
        &store,
        &owner,
        json!({"kbId": kb.as_str(), "path": "docs/guide.md", "rev": head_of(&created).as_str()}),
    )
    .expect_err("absent then");
    // A readable KB says it is the path that is missing.
    assert_eq!(
        err.protocol_details(),
        json!({"reason": "PATH_NOT_FOUND", "field": "/path"})
    );
    assert_eq!(code(err), ErrorCode::NotFound);
    // A read-only principal may read; an unreadable one sees NOT_FOUND.
    let read_only = reader(&store, &kb, &[Permission::Read]);
    get_doc(
        &store,
        &read_only,
        json!({"kbId": kb.as_str(), "path": "docs/guide.md", "rev": v1.as_str()}),
    )
    .expect("reader");
    let nobody = reader(&store, &kb, &[]);
    let hidden = get_doc(
        &store,
        &nobody,
        json!({"kbId": kb.as_str(), "path": "docs/missing.md"}),
    )
    .expect_err("hidden");
    // No path reason for a KB the principal cannot read.
    assert_eq!(hidden.protocol_details(), json!({}));
    assert_eq!(code(hidden), ErrorCode::NotFound);
}

#[test]
fn foreign_and_unreachable_revisions_are_denied() {
    let root = temp_root("foreign");
    let store = Store::open(&root).expect("open");
    let owner = store.owner();
    let a = create(&store, &owner, "alpha", "create-key-foreign-01");
    let b = create(&store, &owner, "beta", "create-key-foreign-02");
    let kb_a = kb_of(&a);
    let kb_b = kb_of(&b);
    let b_head = commit(
        &store,
        &kb_b,
        &head_of(&b),
        "commit-key-foreign-01",
        &[("secret.md", "# Secret\n")],
    );
    // A dangling commit object inside KB A's own repository.
    let repo_a = store.paths().repo_dir(&kb_a);
    let tree = git(&repo_a, &["rev-parse", "refs/heads/main^{tree}"]);
    let dangling = git(
        &repo_a,
        &[
            "commit-tree",
            &tree,
            "-p",
            "refs/heads/main",
            "-m",
            "dangling",
        ],
    );
    for rev in [b_head.as_str(), dangling.as_str(), &"a".repeat(40)] {
        let err = get_doc(
            &store,
            &owner,
            json!({"kbId": kb_a.as_str(), "path": "index.md", "rev": rev}),
        )
        .expect_err("unreadable revision");
        assert_eq!(code(err), ErrorCode::NotFound, "{rev}");
        let err = list_docs(&store, &owner, json!({"kbId": kb_a.as_str(), "rev": rev}))
            .expect_err("unreadable revision");
        assert_eq!(code(err), ErrorCode::NotFound, "{rev}");
    }
    // The blob of another KB is never readable through this one.
    let err = get_doc(
        &store,
        &owner,
        json!({"kbId": kb_a.as_str(), "path": "secret.md"}),
    )
    .expect_err("foreign path");
    assert_eq!(code(err), ErrorCode::NotFound);
    // An external edit of main is REPAIR_REQUIRED, never adopted.
    git(&repo_a, &["update-ref", "refs/heads/main", &dangling]);
    let err = get_doc(
        &store,
        &owner,
        json!({"kbId": kb_a.as_str(), "path": "index.md"}),
    )
    .expect_err("repair");
    assert_eq!(code(err), ErrorCode::RepairRequired);
}

#[test]
fn documents_list_pagination_is_complete_bounded_and_pinned() {
    let root = temp_root("paging");
    let store = Store::open(&root).expect("open");
    let owner = store.owner();
    let created = create(&store, &owner, "alpha", "create-key-page-0001");
    let kb = kb_of(&created);
    let files: Vec<(String, String)> = (0..7)
        .map(|i| {
            (
                format!("docs/d{i}.md"),
                format!("---\nid: doc-{i}\n---\n# Doc {i}\n"),
            )
        })
        .collect();
    let refs: Vec<(&str, &str)> = files
        .iter()
        .map(|(p, b)| (p.as_str(), b.as_str()))
        .collect();
    let pinned = commit(
        &store,
        &kb,
        &head_of(&created),
        "commit-key-page-0001",
        &refs,
    );
    let repo = store.paths().repo_dir(&kb);
    let mut seen = Vec::new();
    let mut cursor: Option<String> = None;
    let mut pages = 0;
    loop {
        let mut args = json!({"kbId": kb.as_str(), "limit": 3});
        if let Some(c) = &cursor {
            args["cursor"] = json!(c);
        }
        let page = list_docs(&store, &owner, args).expect("page");
        pages += 1;
        let items = page["items"].as_array().expect("items");
        assert!(items.len() <= 3);
        for item in items {
            assert_eq!(item["commitSha"], pinned.as_str());
            let path = item["path"].as_str().expect("path").to_owned();
            assert_eq!(
                item["blobSha"],
                git(&repo, &["rev-parse", &format!("{pinned}:{path}")]).as_str()
            );
            let size: u64 = git(&repo, &["cat-file", "-s", &format!("{pinned}:{path}")])
                .parse()
                .expect("size");
            assert_eq!(item["size"], size);
            seen.push((path, item["documentId"].clone()));
        }
        if pages == 1 {
            // HEAD moves between pages; the cursor stays on its revision.
            commit(
                &store,
                &kb,
                &pinned,
                "commit-key-page-0002",
                &[("docs/zz-new.md", "# New\n")],
            );
        }
        match page["nextCursor"].as_str() {
            Some(next) => {
                assert!(next.len() <= 1024);
                cursor = Some(next.to_owned());
            }
            None => break,
        }
        assert!(pages < 10, "pagination terminates");
    }
    assert_eq!(pages, 3);
    let mut expected: Vec<String> = files.iter().map(|(p, _)| p.clone()).collect();
    expected.push("index.md".into());
    expected.sort();
    let paths: Vec<String> = seen.iter().map(|(p, _)| p.clone()).collect();
    assert_eq!(paths, expected, "complete, ordered, no duplicates");
    assert_eq!(seen[0].1, json!("doc-0"));
    assert_eq!(seen[7].1, Value::Null, "index.md has no id");
    // A fresh listing sees the new head; prefix filters by raw path prefix.
    let fresh = list_docs(
        &store,
        &owner,
        json!({"kbId": kb.as_str(), "prefix": "docs/zz"}),
    )
    .expect("prefix");
    assert_eq!(fresh["items"].as_array().expect("items").len(), 1);
    assert_eq!(fresh["items"][0]["path"], "docs/zz-new.md");
    assert_eq!(fresh["nextCursor"], Value::Null);
    // A trailing slash is accepted and keeps the raw-prefix meaning
    // (one directory); without it the prefix also matches `docs-*` names.
    let dir = list_docs(
        &store,
        &owner,
        json!({"kbId": kb.as_str(), "prefix": "docs/"}),
    )
    .expect("trailing slash");
    let raw = list_docs(
        &store,
        &owner,
        json!({"kbId": kb.as_str(), "prefix": "docs"}),
    )
    .expect("raw prefix");
    assert!(!dir["items"].as_array().expect("items").is_empty());
    assert!(
        dir["items"]
            .as_array()
            .expect("items")
            .iter()
            .all(|i| i["path"].as_str().expect("path").starts_with("docs/"))
    );
    assert!(
        raw["items"].as_array().expect("items").len()
            >= dir["items"].as_array().expect("items").len()
    );
    for bad in ["docs//", "/", "docs/../x/"] {
        assert!(
            decode_input::<DocumentsList>(json!({"kbId": kb.as_str(), "prefix": bad})).is_err(),
            "{bad}"
        );
    }
    let all = list_docs(&store, &owner, json!({"kbId": kb.as_str()})).expect("default");
    assert_eq!(all["items"].as_array().expect("items").len(), 9);
}

#[test]
fn cursor_tamper_principal_scope_and_expiry_are_rejected() {
    let root = temp_root("cursor");
    let store = Store::open(&root).expect("open");
    // Cursor issuance and validation share an absolute clock, independent of
    // wall time spent in Git, principal changes or reopening the real store.
    let issued_at = 1_800_000_000;
    store.set_cursor_clock_for_tests(issued_at);
    let owner = store.owner();
    let a = create(&store, &owner, "alpha", "create-key-cursor-01");
    let b = create(&store, &owner, "beta", "create-key-cursor-02");
    let kb_a = kb_of(&a);
    let kb_b = kb_of(&b);
    commit(
        &store,
        &kb_a,
        &head_of(&a),
        "commit-key-cursor-01",
        &[("a.md", "# A\n"), ("b.md", "# B\n"), ("c.md", "# C\n")],
    );
    let first =
        list_docs(&store, &owner, json!({"kbId": kb_a.as_str(), "limit": 1})).expect("first page");
    let cursor = first["nextCursor"].as_str().expect("cursor").to_owned();
    next(&store, &owner, &kb_a, &cursor, json!({})).expect("valid cursor");
    // Tampering with any byte of the body or MAC.
    let mut bytes = cursor.clone().into_bytes();
    for index in [0, bytes.len() / 2, bytes.len() - 1] {
        let original = bytes[index];
        bytes[index] = if original == b'A' { b'B' } else { b'A' };
        let tampered = String::from_utf8(bytes.clone()).expect("ascii");
        let err = next(&store, &owner, &kb_a, &tampered, json!({})).expect_err("tampered");
        assert_eq!(code(err), ErrorCode::InvalidCursor, "byte {index}");
        bytes[index] = original;
    }
    assert_eq!(
        code(next(&store, &owner, &kb_a, "garbage", json!({})).expect_err("garbage")),
        ErrorCode::InvalidCursor
    );
    // Bound to principal, KB, filter and revision.
    let other = reader(&store, &kb_a, &[Permission::Read]);
    assert_eq!(
        code(next(&store, &other, &kb_a, &cursor, json!({})).expect_err("principal")),
        ErrorCode::InvalidCursor
    );
    assert_eq!(
        code(next(&store, &owner, &kb_b, &cursor, json!({})).expect_err("kb")),
        ErrorCode::InvalidCursor
    );
    assert_eq!(
        code(next(&store, &owner, &kb_a, &cursor, json!({"prefix": "a"})).expect_err("filter")),
        ErrorCode::InvalidCursor
    );
    assert_eq!(
        code(
            next(
                &store,
                &owner,
                &kb_a,
                &cursor,
                json!({"rev": head_of(&a).as_str()})
            )
            .expect_err("revision")
        ),
        ErrorCode::InvalidCursor
    );
    // A KB-list cursor is not a document cursor.
    let kbs_page = store
        .bases_list(&owner, input::<BasesList>(json!({"limit": 1})))
        .expect("kb page");
    let kb_cursor = kbs_page.next_cursor.expect("kb cursor");
    assert_eq!(
        code(next(&store, &owner, &kb_a, &kb_cursor, json!({})).expect_err("kind")),
        ErrorCode::InvalidCursor
    );
    let rest = store
        .bases_list(
            &owner,
            input::<BasesList>(json!({"limit": 1, "cursor": kb_cursor})),
        )
        .expect("kb page 2");
    assert_eq!(rest.items.len(), 1);
    assert!(rest.next_cursor.is_none());
    assert_ne!(rest.items[0].id, kbs_page.items[0].id);
    // The key is durable (survives reopen) and store-specific.
    drop(store);
    let store = Store::open(&root).expect("reopen");
    store.set_cursor_clock_for_tests(issued_at);
    next(&store, &owner, &kb_a, &cursor, json!({})).expect("cursor after reopen");
    let foreign_root = temp_root("cursor-foreign");
    let foreign = Store::open(&foreign_root).expect("other store");
    let fa = create(&foreign, &foreign.owner(), "alpha", "create-key-cursor-03");
    let err = foreign
        .documents_list(
            &foreign.owner(),
            input::<DocumentsList>(
                json!({"kbId": kb_of(&fa).as_str(), "limit": 1, "cursor": cursor}),
            ),
        )
        .expect_err("foreign store key");
    assert_eq!(code(err), ErrorCode::InvalidCursor);
    // Revocation is checked independently of a valid cursor.
    let guard = store.lock_write(&[]).expect("lock");
    let narrowed = store
        .register_principal(&guard, PrincipalKind::Test, &kb_a, &[Permission::Read])
        .expect("principal");
    drop(guard);
    let theirs = list_docs(
        &store,
        &narrowed,
        json!({"kbId": kb_a.as_str(), "limit": 1}),
    )
    .expect("page")["nextCursor"]
        .as_str()
        .expect("cursor")
        .to_owned();
    let guard = store.lock_write(&[]).expect("lock");
    store
        .set_principal_permissions(&guard, &narrowed, &kb_a, &[])
        .expect("revoke");
    drop(guard);
    assert_eq!(
        code(next(&store, &narrowed, &kb_a, &theirs, json!({})).expect_err("revoked")),
        ErrorCode::NotFound
    );
    // Expiry: exactly 15 minutes is valid, one second later is expired,
    // independent of time spent in the filesystem checks. The clock is still
    // frozen at `issued_at`, so this fresh cursor, the earlier document cursor
    // and the KB-list cursor share one issue instant, clock and signing key.
    let expiry_cursor = list_docs(&store, &owner, json!({"kbId": kb_a.as_str(), "limit": 1}))
        .expect("expiry page")["nextCursor"]
        .as_str()
        .expect("expiry cursor")
        .to_owned();
    store.set_cursor_clock_for_tests(issued_at + CURSOR_TTL_SECS - 1);
    next(&store, &owner, &kb_a, &expiry_cursor, json!({})).expect("one second before expiry");
    store.advance_clock_for_tests(1);
    next(&store, &owner, &kb_a, &expiry_cursor, json!({})).expect("last valid instant");
    next(&store, &owner, &kb_a, &cursor, json!({})).expect("still valid");
    store
        .bases_list(
            &owner,
            input::<BasesList>(json!({"limit": 1, "cursor": kb_cursor})),
        )
        .expect("kb cursor still valid");
    store.advance_clock_for_tests(1);
    assert_eq!(
        code(next(&store, &owner, &kb_a, &expiry_cursor, json!({})).expect_err("expired")),
        ErrorCode::InvalidCursor
    );
    assert_eq!(
        code(next(&store, &owner, &kb_a, &expiry_cursor, json!({})).expect_err("expired")),
        ErrorCode::InvalidCursor
    );
    assert_eq!(
        code(
            store
                .bases_list(
                    &owner,
                    input::<BasesList>(json!({"limit": 1, "cursor": kb_cursor})),
                )
                .expect_err("kb cursor expired")
        ),
        ErrorCode::InvalidCursor
    );
}

fn check_document_return_authority(list: bool) {
    let root = temp_root("return-revoke");
    let store = Store::open(&root).expect("test fixture");
    let created = create(&store, &store.owner(), "private", "private-create-00001");
    let kb = kb_of(&created);
    let who = reader(&store, &kb, &[Permission::Read]);
    let other = Store::open(&root).expect("test fixture");
    let mut assembled = false;
    let mut revoke = || {
        assembled = true;
        let guard = other.lock_write(&[])?;
        other.set_principal_permissions(&guard, &who, &kb, &[])?;
        assert!(matches!(
            other.authorize(&who, &kb, Permission::Read),
            Err(StoreError::NotFound)
        ));
        Ok(())
    };
    if list {
        let result = store.documents_list_observed(
            &who,
            input::<DocumentsList>(json!({"kbId": kb, "limit": 1})),
            &mut revoke,
        );
        assert!(matches!(result, Err(StoreError::NotFound)));
    } else {
        let result = store.documents_get_observed(
            &who,
            input::<DocumentsGet>(json!({"kbId": kb, "path": "index.md"})),
            &mut revoke,
        );
        let error = result.expect_err("revoked");
        assert!(matches!(error, StoreError::NotFound), "{error:?}");
        assert_eq!(error.protocol_details(), json!({}));
    }
    assert!(
        assembled,
        "actual Git/SQLite/content assembly must finish before revoke"
    );
    // Inverse: renewed legitimate authority can read the same immutable bytes.
    let guard = other.lock_write(&[]).expect("test fixture");
    other
        .set_principal_permissions(&guard, &who, &kb, &[Permission::Read])
        .expect("test fixture");
    drop(guard);
    let document = store
        .documents_get(
            &who,
            input::<DocumentsGet>(json!({"kbId": kb, "path": "index.md"})),
        )
        .expect("test fixture");
    assert_eq!(
        document.markdown,
        "---\nprovenance: agent\n---\n# Knowledge base\n\nA local knowledge base for lifecycle tests\n"
    );
    let page = store
        .documents_list(
            &who,
            input::<DocumentsList>(json!({"kbId": kb, "limit": 1})),
        )
        .expect("test fixture");
    assert_eq!(page.items.len(), 1);
}

#[test]
fn document_get_return_checks_live_authority_after_real_assembly() {
    check_document_return_authority(false);
}
#[test]
fn document_list_return_checks_live_authority_after_real_assembly() {
    check_document_return_authority(true);
}

#[test]
fn revoked_kbs_do_not_consume_page_slots_or_reappear_through_cursor() {
    let root = temp_root("return-pagination");
    let store = Store::open(&root).unwrap();
    let guard = store.lock_write(&[]).unwrap();
    let who = store
        .register_creator(
            &guard,
            PrincipalKind::Config,
            &[Permission::Read, Permission::Manage],
        )
        .unwrap();
    drop(guard);
    let mut kbs = Vec::new();
    for (slug, key) in [
        ("a", "page-create-000001"),
        ("b", "page-create-000002"),
        ("c", "page-create-000003"),
    ] {
        kbs.push(kb_of(&create(&store, &who, slug, key)));
    }
    kbs.sort();
    let first = store
        .bases_list(&who, input::<BasesList>(json!({"limit": 1})))
        .unwrap();
    assert_eq!(first.items[0].id, kbs[0]);
    let guard = store.lock_write(&[]).unwrap();
    store
        .set_principal_permissions(&guard, &who, &kbs[1], &[])
        .unwrap();
    drop(guard);
    let rest = store
        .bases_list(
            &who,
            input::<BasesList>(json!({"limit": 1, "cursor": first.next_cursor})),
        )
        .unwrap();
    assert_eq!(rest.items.len(), 1);
    assert_eq!(rest.items[0].id, kbs[2]);
    assert!(rest.next_cursor.is_none());
    let all = store
        .bases_list(&who, input::<BasesList>(json!({"limit": 2})))
        .unwrap();
    assert_eq!(
        all.items
            .iter()
            .map(|row| row.id.clone())
            .collect::<Vec<_>>(),
        vec![kbs[0].clone(), kbs[2].clone()]
    );
    assert!(all.next_cursor.is_none());
    assert!(matches!(
        store.bases_get(&who, input::<BasesGet>(json!({"kbId": kbs[1]}))),
        Err(StoreError::NotFound)
    ));
}
