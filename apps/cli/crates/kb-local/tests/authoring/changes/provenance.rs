//! Agent provenance stamping and the provenance-only noop rule.

use super::*;

// ── Write modes and agent provenance ───────────────────────────────────────

/// Every direct write of a local MCP session is labelled `provenance: agent`,
/// whatever the caller wrote (a spoofed `dream` or `human` included); a
/// rewrite that differs only by the label is a noop that keeps the stored
/// bytes; an unstampable label is refused at `/changes/<i>/content`.
#[test]
fn direct_writes_are_stamped_agent_and_label_only_rewrites_are_noops() {
    let kb = new_kb("stamp");
    let owner = kb.store.owner();
    let applied = kb
        .apply(
            &owner,
            &kb.main,
            "stamp-key-00000001",
            json!([
                create("plain.md", "# Plain\n"),
                create(
                    "dream.md",
                    "---\nid: \"d1\"\nprovenance: dream\n---\n# Spoofed dream\n"
                ),
                create(
                    "human.md",
                    "---\nprovenance: human\ntitle: T\n---\n# Spoofed human\n"
                ),
            ]),
            None,
        )
        .expect("apply");
    let head = applied.commit_sha.clone();
    assert_eq!(
        kb.get(&head, "plain.md").unwrap(),
        "---\nprovenance: agent\n---\n# Plain\n"
    );
    assert_eq!(
        kb.get(&head, "dream.md").unwrap(),
        "---\nid: \"d1\"\nprovenance: agent\n---\n# Spoofed dream\n"
    );
    assert_eq!(
        kb.get(&head, "human.md").unwrap(),
        "---\nprovenance: agent\ntitle: T\n---\n# Spoofed human\n"
    );
    // The wrappers stamp too.
    let wrapped = kb
        .store
        .documents_create(
            &owner,
            input::<DocumentsCreate>(json!({
                "kbId": kb.kb.as_str(), "baseRevision": head.as_str(),
                "idempotencyKey": "stamp-key-00000002", "path": "wrapped.md",
                "content": {"markdown": "---\nprovenance: human\n---\nW\n"},
            })),
        )
        .expect("wrapper");
    let head = wrapped.commit_sha.clone();
    assert_eq!(
        kb.get(&head, "wrapped.md").unwrap(),
        "---\nprovenance: agent\n---\nW\n"
    );
    // Rewriting without the label (or with another one) is no change.
    for (key, text) in [
        ("stamp-key-00000003", "# Plain\n"),
        (
            "stamp-key-00000004",
            "---\nprovenance: human\n---\n# Plain\n",
        ),
    ] {
        let noop = kb
            .apply(&owner, &head, key, json!([replace("plain.md", text)]), None)
            .expect("label-only rewrite");
        assert_eq!(noop.kind, ApplyKind::Noop, "{text:?}");
        assert_eq!(kb.head(), head);
    }
    // An unstampable label: SCHEMA at the change's content, no effects.
    let before = effects(&kb);
    let err = kb
        .apply(
            &owner,
            &head,
            "stamp-key-00000005",
            json!([
                create("ok.md", "# ok\n"),
                create("bad.md", "---\n\"provenance\": dream\n---\nB\n"),
            ]),
            None,
        )
        .expect_err("quoted key");
    assert_eq!(
        err.protocol_details(),
        json!({"reason": "SCHEMA", "field": "/changes/1/content"})
    );
    assert_eq!(effects(&kb), before);
}

/// The label-only noop removes provenance lines before comparing: over a
/// person's document, a quoted `provenance: "agent"` or an escaped or quoted
/// key saying `agent` (each left untouched by the stamp, as it already reads
/// `agent`) is no change and keeps the stored bytes; a real body change is
/// stamped `agent`.
#[test]
fn quoted_or_escaped_label_changes_cannot_relabel_a_human_document() {
    let kb = new_kb("relabel");
    let owner = kb.store.owner();
    kb.store
        .set_edit_stamp_for_tests(Some(kb_local::markdown::ProvenanceStamp::Human));
    let human = "---\nprovenance: human\ntitle: T\n---\n# Person\n";
    let applied = kb
        .apply(
            &owner,
            &kb.main,
            "relabel-key-000001",
            json!([create("person.md", human)]),
            None,
        )
        .expect("human write");
    kb.store
        .set_edit_stamp_for_tests(Some(kb_local::markdown::ProvenanceStamp::Agent));
    let head = applied.commit_sha.clone();
    assert_eq!(kb.get(&head, "person.md").unwrap(), human);
    for (key, text) in [
        (
            "relabel-key-000002",
            "---\nprovenance: \"agent\"\ntitle: T\n---\n# Person\n",
        ),
        (
            "relabel-key-000003",
            "---\n\"\\u0070rovenance\": agent\ntitle: T\n---\n# Person\n",
        ),
        (
            "relabel-key-000004",
            "---\n'provenance': 'agent'\ntitle: T\n---\n# Person\n",
        ),
    ] {
        let noop = kb
            .apply(
                &owner,
                &head,
                key,
                json!([replace("person.md", text)]),
                None,
            )
            .expect("label-only rewrite");
        assert_eq!(noop.kind, ApplyKind::Noop, "{text:?}");
        assert_eq!(kb.head(), head);
        assert_eq!(kb.get(&head, "person.md").unwrap(), human);
    }
    // A body change is a change, stamped `agent`.
    let changed = kb
        .apply(
            &owner,
            &head,
            "relabel-key-000005",
            json!([replace(
                "person.md",
                "---\nprovenance: human\ntitle: T\n---\n# Edited\n"
            )]),
            None,
        )
        .expect("body change");
    assert_ne!(changed.kind, ApplyKind::Noop);
    assert_eq!(
        kb.get(&changed.commit_sha, "person.md").unwrap(),
        "---\nprovenance: agent\ntitle: T\n---\n# Edited\n"
    );
}

/// The provenance-only noop is line-based (identical on the server): any
/// other front-matter byte, a comment or a requoted value included, is a
/// change and is stamped `agent`; a block-scalar label keeps its indented
/// value lines in the comparison, so changing that value is a change too.
#[test]
fn only_provenance_lines_are_ignored_by_the_noop_rule() {
    let kb = new_kb("noop-lines");
    let owner = kb.store.owner();
    kb.store
        .set_edit_stamp_for_tests(Some(kb_local::markdown::ProvenanceStamp::Human));
    let human = "---\nprovenance: human\ntitle: T # old\n---\n# Person\n";
    let block = "---\nprovenance: |\n  human\ntitle: T\n---\n# Block\n";
    let applied = kb
        .apply(
            &owner,
            &kb.main,
            "lines-key-00000001",
            json!([create("person.md", human)]),
            None,
        )
        .expect("human write");
    let head = applied.commit_sha.clone();
    // A legacy block-scalar label (stamping cannot write one).
    kb.store.set_edit_stamp_for_tests(None);
    let head = kb
        .apply(
            &owner,
            &head,
            "lines-key-00000002",
            json!([create("block.md", block)]),
            None,
        )
        .expect("legacy write")
        .commit_sha;
    kb.store
        .set_edit_stamp_for_tests(Some(kb_local::markdown::ProvenanceStamp::Agent));
    assert_eq!(kb.get(&head, "person.md").unwrap(), human);
    assert_eq!(kb.get(&head, "block.md").unwrap(), block);
    // A comment-only edit is published, stamped `agent`.
    let changed = kb
        .apply(
            &owner,
            &head,
            "lines-key-00000003",
            json!([replace(
                "person.md",
                "---\nprovenance: human\ntitle: T # new\n---\n# Person\n"
            )]),
            None,
        )
        .expect("comment edit");
    assert_ne!(changed.kind, ApplyKind::Noop);
    let head = changed.commit_sha.clone();
    assert_eq!(
        kb.get(&head, "person.md").unwrap(),
        "---\nprovenance: agent\ntitle: T # new\n---\n# Person\n"
    );
    // A block-scalar provenance value change is a change too; its label is
    // unstampable, so it is refused rather than silently kept.
    let err = kb
        .apply(
            &owner,
            &head,
            "lines-key-00000004",
            json!([replace(
                "block.md",
                "---\nprovenance: |\n  agent\ntitle: T\n---\n# Block\n"
            )]),
            None,
        )
        .expect_err("block value change");
    assert_eq!(
        err.protocol_details(),
        json!({"reason": "SCHEMA", "field": "/changes/0/content"})
    );
    // Re-saving the unchanged block-scalar document is a noop: the prior
    // comparison runs before the (refusing) stamp.
    let noop = kb
        .apply(
            &owner,
            &head,
            "lines-key-00000005",
            json!([replace("block.md", block)]),
            None,
        )
        .expect("unchanged legacy re-save");
    assert_eq!(noop.kind, ApplyKind::Noop);
    assert_eq!(kb.head(), head);
}

/// Re-saving an unchanged legacy document whose label is unstampable (a
/// quoted or escaped key) is a noop, not INVALID_ARGUMENT: the prior
/// comparison runs before the stamp, as on the server.
#[test]
fn unchanged_legacy_label_with_an_escaped_key_resaves_as_a_noop() {
    let kb = new_kb("legacy-key");
    let owner = kb.store.owner();
    let legacy = "---\n\"\\u0070rovenance\": human\ntitle: T\n---\n# Legacy\n";
    kb.store.set_edit_stamp_for_tests(None);
    let head = kb
        .apply(
            &owner,
            &kb.main,
            "legacy-key-0000001",
            json!([create("legacy.md", legacy)]),
            None,
        )
        .expect("legacy write")
        .commit_sha;
    kb.store
        .set_edit_stamp_for_tests(Some(kb_local::markdown::ProvenanceStamp::Agent));
    for (key, text) in [
        ("legacy-key-0000002", legacy),
        // The same with only the label requoted: still no change.
        (
            "legacy-key-0000003",
            "---\n\"\\u0070rovenance\": 'agent'\ntitle: T\n---\n# Legacy\n",
        ),
    ] {
        let noop = kb
            .apply(
                &owner,
                &head,
                key,
                json!([replace("legacy.md", text)]),
                None,
            )
            .expect("unchanged re-save");
        assert_eq!(noop.kind, ApplyKind::Noop, "{text:?}");
        assert_eq!(kb.head(), head);
        assert_eq!(kb.get(&head, "legacy.md").unwrap(), legacy);
    }
    // A real change to it is refused at its content: the key is unstampable.
    let err = kb
        .apply(
            &owner,
            &head,
            "legacy-key-0000004",
            json!([replace(
                "legacy.md",
                "---\n\"\\u0070rovenance\": human\ntitle: T\n---\n# Edited\n"
            )]),
            None,
        )
        .expect_err("unstampable change");
    assert_eq!(
        err.protocol_details(),
        json!({"reason": "SCHEMA", "field": "/changes/0/content"})
    );
}

/// A `create` resolving a recorded conflict over an existing path goes
/// through the same provenance-only noop as a replace: an agent choosing the
/// PR's version there (a person's document, unchanged or relabelled only)
/// keeps it `human` (prior bytes), and the conflict still counts as resolved.
#[test]
fn create_resolving_a_conflict_with_the_unchanged_human_document_stays_human() {
    let human = "---\nprovenance: human\n---\n# Doc\n\nfrom the PR\n";
    for (tag, text) in [
        ("resolve-same", human),
        (
            "resolve-label",
            "---\nprovenance: agent\n---\n# Doc\n\nfrom the PR\n",
        ),
    ] {
        let kb = new_kb(tag);
        let owner = kb.store.owner();
        let proposer = kb.principal(&[Permission::Propose]);
        let base = kb.head();
        // A person's proposal...
        kb.store
            .set_edit_stamp_for_tests(Some(kb_local::markdown::ProvenanceStamp::Human));
        let pr = kb
            .apply(
                &proposer,
                &base,
                "resolve-key-000001",
                json!([create("doc.md", "# Doc\n\nfrom the PR\n")]),
                None,
            )
            .expect("proposal");
        let number = pr.proposal.as_ref().expect("proposal").number;
        assert_eq!(kb.get(&pr.commit_sha, "doc.md").unwrap(), human);
        // ...clashing with an agent's document on main.
        kb.store
            .set_edit_stamp_for_tests(Some(kb_local::markdown::ProvenanceStamp::Agent));
        let main = kb
            .apply(
                &owner,
                &base,
                "resolve-key-000002",
                json!([create("doc.md", "# Doc\n\nfrom main\n")]),
                None,
            )
            .expect("agent on main")
            .commit_sha;
        // An agent resolves by creating the person's version.
        let resolved = kb
            .apply_pr(
                &proposer,
                &main,
                "resolve-key-000003",
                json!([create("doc.md", text)]),
                number,
                &pr.commit_sha,
            )
            .expect("resolution");
        assert_ne!(resolved.kind, ApplyKind::Noop, "{text:?}");
        let open = resolved.proposal.clone().expect("proposal");
        assert_eq!(open.status, PrStatus::Open, "{text:?}");
        assert_eq!(
            kb.get(&resolved.commit_sha, "doc.md").unwrap(),
            human,
            "{text:?}"
        );
    }
}
