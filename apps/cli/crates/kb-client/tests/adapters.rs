//! Cockpit host adapter seams — attachment identity, immutable
//! snapshot retrieval and the one-call atomic dream apply.
//!
//! Checks the host adapter contract (dreaming / shared
//! output shapes), not from the implementation.

mod common;

use common::{ctl, err, ok, tool_server};
use kb_client::attachment::{
    AttachmentError, attach, local_attachment_locator, local_attachment_namespace,
    remote_attachment_namespace, verify_attachment,
};
use kb_client::dream::{
    ConceptUpsert, DREAM_MAX_UPSERTS, DreamChangeSet, DreamError, DreamOutcome, apply_dream,
    prepare_dream, submit_dream,
};
use kb_client::snapshot::{
    SnapshotError, StructuredFilters, content_hash, git_blob_sha, retrieve, retrieve_structured,
    verify_snapshot,
};
use kb_client::types::{
    CitationHit, DocCitation, Document, DreamModel, DreamProvenance, IdempotencyKey, KbId,
    SearchInput, Uuid,
};
use kb_client::{ClientError, ErrorCode, KbError, KbLocator, TransportPolicy};
use serde_json::{Value, json};

const KB_A: &str = "abcdefghijklmnopqrstuvwx";
const KB_B: &str = "zyxwvutsrqponmlkjihgfedc";
const GEN: &str = "gggggggggggggggggggggggg";
const COMMIT_OLD: &str = "1111111111111111111111111111111111111111";
const COMMIT_NEW: &str = "2222222222222222222222222222222222222222";
const COMMIT_DREAM: &str = "3333333333333333333333333333333333333333";

// Independently computed with `git hash-object` / `sha256sum`.
const OLD_SOURCE: &str = "---\nid: alpha\ntitle: Alpha\n---\nOld alpha body at revision one.\n";
const OLD_BLOB: &str = "c8b14ddf0470b34340d5196f0ff0baad41984367";
const OLD_HASH: &str = "sha256:db5a4b1aaccc2f030184bab26e8ea795f21835b2174aae96ebbbf3eefaf8fa86";
const NEW_SOURCE: &str = "---\nid: alpha\ntitle: Alpha\n---\nNew alpha body after main advanced.\n";
const NEW_BLOB: &str = "6f43f981731615addeb72f423574457be6bff639";
const NEW_HASH: &str = "sha256:58f176c30c47d4ab68b8a18cc85b0c6b479cde9b29a45edcc393707afa024027";

fn golden() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../../packages/api/src/lib/kb/fixtures/attachment.json"
    );
    serde_json::from_str(&std::fs::read_to_string(path).expect("test fixture"))
        .expect("test fixture")
}

fn locator(text: &str) -> KbLocator {
    KbLocator::parse(text, TransportPolicy::AllowLoopbackHttp).expect("test fixture")
}

fn kb(id: &str) -> KbId {
    KbId::parse(id).expect("test fixture")
}

fn uuid(text: &str) -> Uuid {
    Uuid::parse(text).expect("test fixture")
}

fn attachment_json(locator: &str, id: &str, name: &str, namespace: &str) -> Value {
    json!({
        "id": id, "name": name, "slug": "alpha", "description": "Synthetic attachment for chunk 50.",
        "defaultBranch": "main", "headSha": COMMIT_NEW, "metadataVersion": 1,
        "capabilities": ["read", "propose"], "writeMode": "proposal_required",
        "embeddingGeneration": null, "attachmentLocator": locator, "sealedNamespace": namespace,
    })
}

fn index_json() -> Value {
    json!({
        "activeGenerationId": GEN, "desiredGenerationId": GEN, "desiredEpoch": "1",
        "activeState": "COMPLETE", "desiredState": "COMPLETE", "indexedCommitSha": COMMIT_NEW,
        "headSha": COMMIT_NEW, "dimensions": 1024, "fingerprint": null, "freshness": "current",
        "errorCode": null, "rebuildPending": null,
    })
}

// ── 1. Attachment identity ──────────────────────────────────────────────────

#[test]
fn golden_attachment_vectors_match_the_shared_fixture() {
    let golden = golden();
    let vectors = golden["vectors"].as_array().expect("test fixture");
    assert!(vectors.len() >= 5);
    for v in vectors {
        let namespace = v["namespace"].as_str().expect("test fixture");
        match v["kind"].as_str() {
            Some("remote") => {
                let loc = locator(v["locator"].as_str().expect("test fixture"));
                assert_eq!(
                    loc.as_string(),
                    v["locator"].as_str().expect("test fixture")
                );
                assert_eq!(remote_attachment_namespace(&loc).as_str(), namespace);
            }
            Some("local") => {
                let store = uuid(v["storeUuid"].as_str().expect("test fixture"));
                let id = kb(v["kbId"].as_str().expect("test fixture"));
                assert_eq!(local_attachment_locator(&store, &id), v["locator"]);
                assert_eq!(local_attachment_namespace(&store, &id).as_str(), namespace);
            }
            other => panic!("unexpected vector kind {other:?}"),
        }
    }
}

#[test]
fn two_kbs_on_one_origin_have_distinct_identities() {
    let a = locator(&format!("https://kb.example.test/mcp#kb={KB_A}"));
    let b = locator(&format!("https://kb.example.test/mcp#kb={KB_B}"));
    assert_eq!(a.resource(), b.resource());
    assert_ne!(
        remote_attachment_namespace(&a),
        remote_attachment_namespace(&b)
    );
    // Equivalent spellings canonicalize to one identity.
    let spelled = locator(&format!("HTTPS://KB.Example.TEST:443/mcp#kb={KB_A}"));
    assert_eq!(
        remote_attachment_namespace(&spelled),
        remote_attachment_namespace(&a)
    );
    // A different origin is a different identity (origin move = reattach).
    let moved = locator(&format!("https://kb2.example.test/mcp#kb={KB_A}"));
    assert_ne!(
        remote_attachment_namespace(&moved),
        remote_attachment_namespace(&a)
    );
}

#[test]
fn renamed_display_keeps_the_identity() {
    let loc = locator(&format!("https://kb.example.test/mcp#kb={KB_A}"));
    let ns = remote_attachment_namespace(&loc);
    let first: kb_client::types::KbAttachment = serde_json::from_value(attachment_json(
        &loc.as_string(),
        KB_A,
        "Alpha",
        ns.as_str(),
    ))
    .expect("test fixture");
    let renamed: kb_client::types::KbAttachment = serde_json::from_value(attachment_json(
        &loc.as_string(),
        KB_A,
        "Renamed Beta",
        ns.as_str(),
    ))
    .expect("test fixture");
    let a = verify_attachment(&loc, first).expect("verified");
    let b = verify_attachment(&loc, renamed).expect("rename does not reattach");
    assert_eq!(a.namespace(), b.namespace());
    assert_eq!(a.locator(), b.locator());
    assert_eq!(b.attachment().name, "Renamed Beta");
}

#[test]
fn hostile_namespace_locator_or_kb_is_rejected() {
    let loc = locator(&format!("https://kb.example.test/mcp#kb={KB_A}"));
    let ns = remote_attachment_namespace(&loc);
    let parse = |v: Value| -> kb_client::types::KbAttachment {
        serde_json::from_value(v).expect("test fixture")
    };
    // Server claims another namespace (e.g. a victim KB's) for this locator.
    let other_ns =
        remote_attachment_namespace(&locator(&format!("https://kb.example.test/mcp#kb={KB_B}")));
    assert_eq!(
        verify_attachment(
            &loc,
            parse(attachment_json(
                &loc.as_string(),
                KB_A,
                "A",
                other_ns.as_str()
            ))
        )
        .unwrap_err(),
        AttachmentError::NamespaceMismatch
    );
    // Silent origin override: server returns a locator for another origin
    // together with that origin's matching namespace.
    let moved = locator(&format!("https://evil.example.test/mcp#kb={KB_A}"));
    let moved_ns = remote_attachment_namespace(&moved);
    assert_eq!(
        verify_attachment(
            &loc,
            parse(attachment_json(
                &moved.as_string(),
                KB_A,
                "A",
                moved_ns.as_str()
            ))
        )
        .unwrap_err(),
        AttachmentError::LocatorMismatch
    );
    // A different KB id under the same origin.
    let b = locator(&format!("https://kb.example.test/mcp#kb={KB_B}"));
    assert_eq!(
        verify_attachment(
            &loc,
            parse(attachment_json(
                &b.as_string(),
                KB_B,
                "B",
                remote_attachment_namespace(&b).as_str()
            ))
        )
        .unwrap_err(),
        AttachmentError::KbMismatch
    );
    // Non-canonical locator spelling is not accepted as the identity input.
    assert_eq!(
        verify_attachment(
            &loc,
            parse(attachment_json(
                &format!("HTTPS://KB.example.test/mcp#kb={KB_A}"),
                KB_A,
                "A",
                ns.as_str()
            ))
        )
        .unwrap_err(),
        AttachmentError::LocatorMismatch
    );
}

#[tokio::test]
async fn attach_rejects_a_foreign_origin_attachment_and_never_forwards_off_origin() {
    // The server answers with a self-consistent attachment for ANOTHER origin
    // (locator + that origin's namespace): a silent origin override.
    let elsewhere = locator(&format!("https://kb.example.test/mcp#kb={KB_A}"));
    let hostile = attachment_json(
        &elsewhere.as_string(),
        KB_A,
        "Alpha",
        remote_attachment_namespace(&elsewhere).as_str(),
    );
    let server =
        tool_server(move |_, _, _| ok(json!({"kb": hostile, "index": index_json()}))).await;
    let loc = KbLocator::new(server.resource(), kb(KB_A));
    assert_eq!(
        attach(&server.client(), &loc, &ctl()).await.unwrap_err(),
        AttachmentError::LocatorMismatch
    );
    assert_eq!(server.calls().len(), 1);

    // A locator on another origin than the client's resource never reaches
    // the wire (no credential forwarding to another server's KB).
    assert_eq!(
        attach(&server.client(), &elsewhere, &ctl())
            .await
            .unwrap_err(),
        AttachmentError::ResourceMismatch
    );
    assert_eq!(server.calls().len(), 1);
}

#[tokio::test]
async fn attach_accepts_the_server_canonical_attachment() {
    let slot = std::sync::Arc::new(std::sync::Mutex::new(Value::Null));
    let answer = slot.clone();
    let server = tool_server(move |_, _, _| {
        ok(json!({"kb": answer.lock().expect("test fixture").clone(), "index": index_json()}))
    })
    .await;
    let loc = KbLocator::new(server.resource(), kb(KB_A));
    let ns = remote_attachment_namespace(&loc);
    *slot.lock().expect("test fixture") =
        attachment_json(&loc.as_string(), KB_A, "Alpha", ns.as_str());
    let (verified, index) = attach(&server.client(), &loc, &ctl())
        .await
        .expect("attached");
    assert_eq!(verified.namespace(), &ns);
    assert_eq!(index.head_sha.as_str(), COMMIT_NEW);
    assert_eq!(server.calls_to("knowledge_bases_get").len(), 1);
    assert_eq!(
        server.calls()[0].arguments,
        json!({"kbId": KB_A}),
        "attach sends only the pinned kb id"
    );
}

// ── 2. Snapshot retrieval ───────────────────────────────────────────────────

fn hit_json(commit: &str, blob: &str, hash: &str) -> Value {
    json!({
        "knowledgeBaseId": KB_A, "knowledgeBaseName": "Alpha KB", "path": "concepts/alpha.md",
        "documentId": "alpha", "commitSha": commit, "blobSha": blob, "contentHash": hash,
        "chunkIndex": 0,
        "span": {"startToken": 0, "endToken": 5, "startByte": 0, "endByte": 31},
        "snippet": "Old alpha body at revision one.", "score": 0.5, "mode": "hybrid",
        "indexGenerationId": GEN, "freshness": "stale",
        "documentCitations": [{"label": "episode", "target": "cockpit://episode/1"}],
        "assetRefs": [], "matchedRow": null,
    })
}

fn document_json(commit: &str, source: &str, blob: &str, hash: &str) -> Value {
    json!({
        "path": "concepts/alpha.md", "documentId": "alpha", "markdown": source,
        "frontMatter": {"id": "alpha", "title": "Alpha"}, "commitSha": commit, "blobSha": blob,
        "contentHash": hash,
        "documentCitations": [{"label": "episode", "target": "cockpit://episode/1"}],
        "assetRefs": [],
    })
}

fn search_output(results: Vec<Value>) -> Value {
    json!({
        "results": results, "generationId": GEN, "freshness": "stale",
        "indexedCommitSha": COMMIT_OLD, "headSha": COMMIT_NEW, "indexNotices": [],
    })
}

fn search_input() -> SearchInput {
    serde_json::from_value(json!({"kbId": KB_A, "query": "alpha"})).expect("test fixture")
}

#[test]
fn source_hashes_are_git_blob_sha1_and_sha256() {
    assert_eq!(git_blob_sha(OLD_SOURCE.as_bytes()).as_str(), OLD_BLOB);
    assert_eq!(content_hash(OLD_SOURCE.as_bytes()).as_str(), OLD_HASH);
    assert_eq!(git_blob_sha(NEW_SOURCE.as_bytes()).as_str(), NEW_BLOB);
    assert_eq!(content_hash(NEW_SOURCE.as_bytes()).as_str(), NEW_HASH);
}

#[tokio::test]
async fn old_revision_source_is_fetched_by_commit_and_verified_after_main_advances() {
    // Index still points at the old commit; main has advanced to COMMIT_NEW.
    let server = tool_server(|tool, args, _| match tool {
        "knowledge_search" => ok(search_output(vec![
            hit_json(COMMIT_OLD, OLD_BLOB, OLD_HASH),
            hit_json(COMMIT_OLD, OLD_BLOB, OLD_HASH),
        ])),
        "knowledge_documents_get" => match args["rev"].as_str() {
            Some(COMMIT_OLD) => ok(document_json(COMMIT_OLD, OLD_SOURCE, OLD_BLOB, OLD_HASH)),
            _ => ok(document_json(COMMIT_NEW, NEW_SOURCE, NEW_BLOB, NEW_HASH)),
        },
        other => panic!("unexpected tool {other}"),
    })
    .await;
    let retrieval = retrieve(&server.client(), &search_input(), &ctl())
        .await
        .expect("retrieved");
    assert_eq!(retrieval.hits.len(), 2);
    for hit in &retrieval.hits {
        assert_eq!(hit.source.markdown, OLD_SOURCE);
        assert_eq!(hit.source.commit_sha.as_str(), COMMIT_OLD);
        // Spans, citations and asset refs are preserved from the hit.
        assert_eq!(hit.hit.span.end_byte, 31);
        assert_eq!(hit.hit.document_citations[0].target, "cockpit://episode/1");
        assert_eq!(
            hit.source.document_citations,
            vec![DocCitation {
                label: "episode".into(),
                target: "cockpit://episode/1".into()
            }]
        );
    }
    assert_eq!(retrieval.head_sha.as_str(), COMMIT_NEW);
    let gets = server.calls_to("knowledge_documents_get");
    // One fetch per distinct (path, commit), always pinned to the hit commit.
    assert_eq!(gets.len(), 1);
    assert_eq!(
        gets[0].arguments,
        json!({"kbId": KB_A, "rev": COMMIT_OLD, "path": "concepts/alpha.md"})
    );
}

#[tokio::test]
async fn a_head_answer_instead_of_the_cited_commit_is_rejected() {
    let server = tool_server(|tool, _, _| match tool {
        "knowledge_search" => ok(search_output(vec![hit_json(
            COMMIT_OLD, OLD_BLOB, OLD_HASH,
        )])),
        // Misbehaving server ignores `rev` and answers HEAD.
        _ => ok(document_json(COMMIT_NEW, NEW_SOURCE, NEW_BLOB, NEW_HASH)),
    })
    .await;
    assert_eq!(
        retrieve(&server.client(), &search_input(), &ctl())
            .await
            .unwrap_err(),
        SnapshotError::CommitMismatch
    );
}

#[test]
fn tampered_or_mislabelled_source_bytes_fail_verification() {
    let hit: CitationHit =
        serde_json::from_value(hit_json(COMMIT_OLD, OLD_BLOB, OLD_HASH)).expect("test fixture");
    let doc = |source: &str, blob: &str, hash: &str| -> Document {
        serde_json::from_value(document_json(COMMIT_OLD, source, blob, hash)).expect("test fixture")
    };
    assert_eq!(
        verify_snapshot(&hit, &doc(OLD_SOURCE, OLD_BLOB, OLD_HASH)),
        Ok(())
    );
    // Bytes changed but labels kept: recomputed hashes disagree.
    assert_eq!(
        verify_snapshot(&hit, &doc(NEW_SOURCE, OLD_BLOB, OLD_HASH)),
        Err(SnapshotError::BlobShaMismatch)
    );
    // Consistent new document relabelled at the old commit: blob differs from hit.
    assert_eq!(
        verify_snapshot(&hit, &doc(NEW_SOURCE, NEW_BLOB, NEW_HASH)),
        Err(SnapshotError::BlobShaMismatch)
    );
    // Right blob label, wrong full-source contentHash.
    assert_eq!(
        verify_snapshot(&hit, &doc(OLD_SOURCE, OLD_BLOB, NEW_HASH)),
        Err(SnapshotError::ContentHashMismatch)
    );
    let mut other_path = doc(OLD_SOURCE, OLD_BLOB, OLD_HASH);
    other_path.path = "concepts/beta.md".parse().expect("test fixture");
    assert_eq!(
        verify_snapshot(&hit, &other_path),
        Err(SnapshotError::PathMismatch)
    );
}

#[tokio::test]
async fn hits_from_an_unrequested_kb_are_rejected() {
    let server = tool_server(|_, _, _| {
        let mut hit = hit_json(COMMIT_OLD, OLD_BLOB, OLD_HASH);
        hit["knowledgeBaseId"] = json!(KB_B);
        ok(search_output(vec![hit]))
    })
    .await;
    assert_eq!(
        retrieve(&server.client(), &search_input(), &ctl())
            .await
            .unwrap_err(),
        SnapshotError::KbMismatch
    );
    assert!(server.calls_to("knowledge_documents_get").is_empty());
}

#[test]
fn structured_filters_map_exactly_to_the_shared_contract() {
    // Cockpit's `StructuredSearchQuery` wire shape.
    let filters: StructuredFilters = serde_json::from_value(json!({
        "query": "rates", "type": "table", "title": "Tariff", "tags": ["ops", "pricing"],
        "timestamp": {"after": "2026-01-01T00:00:00Z", "before": "2026-02-01T00:00:00Z"},
        "structured": [{"column": "region", "equals": "eu"}, {"column": "tier", "equals": 2}],
        "limit": 7,
    }))
    .expect("test fixture");
    let input = filters.to_input(kb(KB_A), None).expect("valid filters");
    assert_eq!(
        serde_json::to_value(&input).expect("test fixture"),
        json!({
            "kbId": KB_A, "limit": 7, "query": "rates", "type": "table", "title": "Tariff",
            "tags": ["ops", "pricing"],
            "timestamp": {"after": "2026-01-01T00:00:00Z", "before": "2026-02-01T00:00:00Z"},
            "structured": [{"column": "region", "equals": "eu"}, {"column": "tier", "equals": 2}],
        })
    );
    // Empty optional collections are omitted, not sent as `[]`.
    let minimal: StructuredFilters =
        serde_json::from_value(json!({"tags": [], "structured": [], "type": "note"}))
            .expect("test fixture");
    assert_eq!(
        serde_json::to_value(minimal.to_input(kb(KB_A), None).expect("valid"))
            .expect("test fixture"),
        json!({"kbId": KB_A, "type": "note"})
    );
    // Query or at least one filter is required.
    let empty: StructuredFilters = serde_json::from_value(json!({})).expect("test fixture");
    assert_eq!(
        empty.to_input(kb(KB_A), None).unwrap_err(),
        SnapshotError::InvalidFilters
    );
    // Non-scalar equals and unknown filter keys are rejected.
    assert!(
        serde_json::from_value::<StructuredFilters>(
            json!({"structured": [{"column": "c", "equals": {"x": 1}}]})
        )
        .is_err()
            || serde_json::from_value::<StructuredFilters>(
                json!({"structured": [{"column": "c", "equals": {"x": 1}}]})
            )
            .expect("parsed")
            .to_input(kb(KB_A), None)
            .is_err()
    );
    assert!(serde_json::from_value::<StructuredFilters>(json!({"fuzzy": true})).is_err());
    // Inverted timestamp range is rejected by the shared contract.
    let inverted: StructuredFilters = serde_json::from_value(json!({
        "timestamp": {"after": "2026-02-01T00:00:00Z", "before": "2026-01-01T00:00:00Z"}
    }))
    .expect("test fixture");
    assert_eq!(
        inverted.to_input(kb(KB_A), None).unwrap_err(),
        SnapshotError::InvalidFilters
    );
}

#[tokio::test]
async fn structured_retrieval_fetches_pinned_sources_and_keeps_rows() {
    let server = tool_server(|tool, args, _| match tool {
        "knowledge_structured_search" => {
            assert_eq!(args["structured"][0]["column"], "region");
            let mut hit = hit_json(COMMIT_OLD, OLD_BLOB, OLD_HASH);
            hit["mode"] = json!("structured");
            hit["matchedRow"] = json!({"region": "eu"});
            ok(json!({
                "items": [hit], "nextCursor": null, "generationId": GEN, "freshness": "stale",
                "indexedCommitSha": COMMIT_OLD, "headSha": COMMIT_NEW, "indexNotices": [],
            }))
        }
        _ => ok(document_json(COMMIT_OLD, OLD_SOURCE, OLD_BLOB, OLD_HASH)),
    })
    .await;
    let filters: StructuredFilters =
        serde_json::from_value(json!({"structured": [{"column": "region", "equals": "eu"}]}))
            .expect("test fixture");
    let input = filters.to_input(kb(KB_A), None).expect("valid");
    let out = retrieve_structured(&server.client(), &input, &ctl())
        .await
        .expect("retrieved");
    assert_eq!(out.hits.len(), 1);
    assert_eq!(
        out.hits[0].hit.matched_row,
        Some(
            json!({"region": "eu"})
                .as_object()
                .cloned()
                .unwrap_or_default()
        )
    );
    assert_eq!(out.hits[0].source.commit_sha.as_str(), COMMIT_OLD);
    assert_eq!(out.next_cursor, None);
}

// ── 3. Atomic dream apply ───────────────────────────────────────────────────

fn session(n: u8) -> Uuid {
    uuid(&format!("00000000-0000-4000-8000-0000000000{n:02x}"))
}

fn upsert(i: usize) -> ConceptUpsert {
    ConceptUpsert {
        id: format!("concept-{i}").parse().expect("test fixture"),
        kind: "concept".into(),
        title: Some(format!("Concept {i}")),
        body: format!("Dream body {i}.\n"),
        citations: vec![DocCitation {
            label: format!("episode {i}"),
            target: format!("cockpit://episode/{i}"),
        }],
        provenance: DreamProvenance,
    }
}

fn change_set(n: usize) -> DreamChangeSet {
    DreamChangeSet {
        knowledge_base_id: kb(KB_A),
        source_session_ids: vec![session(1), session(2)],
        upserts: (0..n).map(upsert).collect(),
        model: DreamModel {
            provider: "fixture-provider".into(),
            model: "fixture-model".into(),
        },
        title: None,
    }
}

fn key() -> IdempotencyKey {
    IdempotencyKey::parse("dream-fixture-key-000001").expect("test fixture")
}

fn bases_get_answer() -> Value {
    let loc = format!("https://kb.example.test/mcp#kb={KB_A}");
    ok(json!({
        "kb": attachment_json(&loc, KB_A, "Alpha", "00000000-0000-4000-8000-000000000001"),
        "index": index_json(),
    }))
}

fn apply_answer(args: &Value, kind: &str) -> Value {
    let proposal = if kind == "proposed" {
        json!({
            "number": 4, "title": "Dream", "sourceBranch": "pr/4", "targetBranch": "main",
            "baseSha": COMMIT_NEW, "headSha": COMMIT_DREAM, "targetSha": COMMIT_NEW,
            "status": "OPEN", "authorActorKey": "user:1", "version": 1, "mergeCommitSha": null,
        })
    } else {
        Value::Null
    };
    let (commit, paths, job) = match kind {
        "noop" => (COMMIT_NEW, json!([]), Value::Null),
        "proposed" => (COMMIT_DREAM, json!(["concepts/concept-0.md"]), Value::Null),
        _ => (
            COMMIT_DREAM,
            json!(["concepts/concept-0.md"]),
            json!("00000000-0000-4000-8000-0000000000ff"),
        ),
    };
    ok(json!({
        "operationId": "00000000-0000-4000-8000-0000000000ee", "kind": kind,
        "commitSha": commit, "baseRevision": args["baseRevision"], "proposal": proposal,
        "changedPaths": paths, "sourceSessionIds": args["sourceSessionIds"],
        "indexJobId": job,
    }))
}

#[tokio::test]
async fn eight_upserts_are_one_atomic_call_and_retry_keeps_key_and_base() {
    let server = tool_server(|tool, args, index| match tool {
        "knowledge_bases_get" => bases_get_answer(),
        "knowledge_changes_apply" => {
            // First apply attempt fails retryably (index 1 = first apply).
            if index == 1 {
                err(ErrorCode::StorageUnavailable, json!({}))
            } else {
                apply_answer(args, "applied")
            }
        }
        other => panic!("unexpected tool {other}"),
    })
    .await;
    let set = change_set(DREAM_MAX_UPSERTS);
    assert_eq!(set.upserts.len(), 8);
    let outcome = apply_dream(&server.client(), &set, key(), &ctl())
        .await
        .expect("applied");
    assert!(matches!(outcome, DreamOutcome::Applied(_)));
    assert!(outcome.advances_consumer_ledger());

    let calls = server.calls();
    assert_eq!(calls.len(), 3, "bases_get + apply + one retry: {calls:?}");
    assert_eq!(calls[0].tool, "knowledge_bases_get");
    let applies = server.calls_to("knowledge_changes_apply");
    assert_eq!(applies.len(), 2);
    assert_eq!(
        applies[0].arguments, applies[1].arguments,
        "retry resends identical arguments"
    );
    let args = &applies[0].arguments;
    assert_eq!(args["idempotencyKey"], "dream-fixture-key-000001");
    assert_eq!(args["baseRevision"], COMMIT_NEW, "pinned from bases_get");
    assert_eq!(args["mode"], "dream");
    assert_eq!(args["changes"], json!([]));
    assert_eq!(
        args["sourceSessionIds"],
        json!([session(1).as_str(), session(2).as_str()])
    );
    assert_eq!(
        args["dream"]["model"],
        json!({"provider": "fixture-provider", "model": "fixture-model"})
    );
    assert_eq!(args["dream"]["redactionApplied"], true);
    let upserts = args["dream"]["upserts"].as_array().expect("upserts");
    assert_eq!(upserts.len(), 8);
    assert_eq!(
        upserts[3],
        json!({
            "id": "concept-3", "type": "concept", "title": "Concept 3",
            "body": "Dream body 3.\n",
            "citations": [{"label": "episode 3", "target": "cockpit://episode/3"}],
            "provenance": "dream",
        })
    );
    // No invented watermark or per-document fields.
    let keys: Vec<&String> = args.as_object().expect("object").keys().collect();
    let mut keys: Vec<&str> = keys.iter().map(|k| k.as_str()).collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        vec![
            "baseRevision",
            "changes",
            "dream",
            "idempotencyKey",
            "kbId",
            "mode",
            "sourceSessionIds",
            "title"
        ]
    );
}

#[tokio::test]
async fn a_prepared_dream_is_resubmitted_with_the_same_key_and_base() {
    let server = tool_server(|tool, args, _| match tool {
        "knowledge_bases_get" => bases_get_answer(),
        _ => apply_answer(args, "applied"),
    })
    .await;
    let client = server.client();
    let prepared = prepare_dream(&client, &change_set(2), key(), &ctl())
        .await
        .expect("prepared");
    assert_eq!(prepared.base_revision().as_str(), COMMIT_NEW);
    assert_eq!(prepared.idempotency_key(), &key());
    submit_dream(&client, &prepared, &ctl(), 1)
        .await
        .expect("first");
    submit_dream(&client, &prepared, &ctl(), 1)
        .await
        .expect("caller-level retry");
    let applies = server.calls_to("knowledge_changes_apply");
    assert_eq!(applies.len(), 2);
    assert_eq!(applies[0].arguments, applies[1].arguments);
    assert_eq!(server.calls_to("knowledge_bases_get").len(), 1);
}

#[tokio::test]
async fn outcomes_are_distinct_and_only_committed_or_noop_advance_the_ledger() {
    for (kind, advances) in [("applied", true), ("noop", true), ("proposed", false)] {
        let server = tool_server(move |tool, args, _| match tool {
            "knowledge_bases_get" => bases_get_answer(),
            _ => apply_answer(args, kind),
        })
        .await;
        let n = if kind == "noop" { 0 } else { 1 };
        let mut set = change_set(n);
        if n == 0 {
            set.source_session_ids.clear();
        }
        let outcome = apply_dream(&server.client(), &set, key(), &ctl())
            .await
            .unwrap_or_else(|e| panic!("{kind}: {e:?}"));
        match (kind, &outcome) {
            ("applied", DreamOutcome::Applied(r)) => {
                assert_eq!(r.commit_sha.as_str(), COMMIT_DREAM)
            }
            ("noop", DreamOutcome::Noop(_)) => {}
            ("proposed", DreamOutcome::Proposed(r)) => {
                assert_eq!(r.proposal.as_ref().map(|p| p.number), Some(4));
            }
            _ => panic!("{kind} mapped to {outcome:?}"),
        }
        assert_eq!(outcome.advances_consumer_ledger(), advances, "{kind}");
    }
}

#[tokio::test]
async fn proposal_noop_is_accepted_but_keeps_the_consumer_ledger_deferred() {
    let server = tool_server(|tool, args, _| match tool {
        "knowledge_bases_get" => bases_get_answer(),
        _ => {
            let mut v = apply_answer(args, "proposed");
            v["data"]["kind"] = json!("noop");
            v["data"]["commitSha"] = args["baseRevision"].clone();
            v["data"]["proposal"]["headSha"] = args["baseRevision"].clone();
            v["data"]["changedPaths"] = json!([]);
            v
        }
    })
    .await;
    let outcome = apply_dream(&server.client(), &change_set(1), key(), &ctl())
        .await
        .expect("active proposal noop");
    assert!(!outcome.advances_consumer_ledger());
    assert!(matches!(outcome, DreamOutcome::ProposalNoop(_)));
    assert_eq!(outcome.result().commit_sha.as_str(), COMMIT_NEW);
    assert!(outcome.result().changed_paths.is_empty());
    assert!(outcome.result().index_job_id.is_none());
    assert_eq!(
        outcome.result().proposal.as_ref().map(|p| p.number),
        Some(4)
    );
}

#[tokio::test]
async fn stale_and_failed_applies_are_never_success() {
    // Stale base: CONFLICT with the current head.
    let server = tool_server(|tool, _, _| match tool {
        "knowledge_bases_get" => bases_get_answer(),
        _ => err(
            ErrorCode::Conflict,
            json!({"headSha": COMMIT_DREAM, "proposalNumber": null}),
        ),
    })
    .await;
    let e = apply_dream(&server.client(), &change_set(1), key(), &ctl())
        .await
        .unwrap_err();
    assert_eq!(
        e,
        DreamError::Stale {
            head_sha: Some(COMMIT_DREAM.parse().expect("test fixture"))
        }
    );
    assert_eq!(server.calls_to("knowledge_changes_apply").len(), 1);

    // Persistent retryable failure: bounded retries, then an error.
    let server = tool_server(|tool, _, _| match tool {
        "knowledge_bases_get" => bases_get_answer(),
        _ => err(ErrorCode::StorageUnavailable, json!({})),
    })
    .await;
    let e = apply_dream(&server.client(), &change_set(1), key(), &ctl())
        .await
        .unwrap_err();
    assert!(
        matches!(
            e,
            DreamError::Client(ClientError::Kb(KbError::Tool(ref t)))
                if t.code() == ErrorCode::StorageUnavailable
        ),
        "{e:?}"
    );
    let applies = server.calls_to("knowledge_changes_apply");
    assert!(applies.len() >= 2);
    assert!(applies.iter().all(|c| c.arguments == applies[0].arguments));
}

type Answer = Box<dyn Fn(&Value) -> Value + Send + Sync>;

#[tokio::test]
async fn inconsistent_results_cannot_be_represented_as_committed_success() {
    let cases: Vec<(&str, Answer)> = vec![
        (
            "applied with a proposal",
            Box::new(|args| {
                let mut v = apply_answer(args, "proposed");
                v["data"]["kind"] = json!("applied");
                v
            }),
        ),
        (
            "proposed without a proposal",
            Box::new(|args| {
                let mut v = apply_answer(args, "applied");
                v["data"]["kind"] = json!("proposed");
                v["data"]["indexJobId"] = Value::Null;
                v
            }),
        ),
        (
            "foreign base revision",
            Box::new(|args| {
                let mut v = apply_answer(args, "applied");
                v["data"]["baseRevision"] = json!(COMMIT_OLD);
                v
            }),
        ),
        (
            "rewritten source sessions",
            Box::new(|args| {
                let mut v = apply_answer(args, "applied");
                v["data"]["sourceSessionIds"] = json!([session(9).as_str()]);
                v
            }),
        ),
        (
            "applied without a new commit",
            Box::new(|args| {
                let mut v = apply_answer(args, "applied");
                v["data"]["commitSha"] = json!(COMMIT_NEW);
                v
            }),
        ),
        (
            "noop with a different proposal head",
            Box::new(|args| {
                let mut v = apply_answer(args, "proposed");
                v["data"]["kind"] = json!("noop");
                v["data"]["commitSha"] = args["baseRevision"].clone();
                v["data"]["changedPaths"] = json!([]);
                v
            }),
        ),
        (
            "noop with a terminal proposal",
            Box::new(|args| {
                let mut v = apply_answer(args, "proposed");
                v["data"]["kind"] = json!("noop");
                v["data"]["commitSha"] = args["baseRevision"].clone();
                v["data"]["proposal"]["headSha"] = args["baseRevision"].clone();
                v["data"]["proposal"]["status"] = json!("CLOSED");
                v["data"]["changedPaths"] = json!([]);
                v
            }),
        ),
        (
            "noop with an index job",
            Box::new(|args| {
                let mut v = apply_answer(args, "noop");
                v["data"]["indexJobId"] = json!("00000000-0000-4000-8000-0000000000aa");
                v
            }),
        ),
        (
            "noop at another commit",
            Box::new(|args| {
                let mut v = apply_answer(args, "noop");
                v["data"]["commitSha"] = json!(COMMIT_DREAM);
                v
            }),
        ),
        (
            "noop that changed paths",
            Box::new(|args| {
                let mut v = apply_answer(args, "noop");
                v["data"]["changedPaths"] = json!(["concepts/concept-0.md"]);
                v
            }),
        ),
    ];
    for (name, answer) in cases {
        let answer = std::sync::Arc::new(answer);
        let server = tool_server(move |tool, args, _| match tool {
            "knowledge_bases_get" => bases_get_answer(),
            _ => answer(args),
        })
        .await;
        let e = apply_dream(&server.client(), &change_set(1), key(), &ctl())
            .await
            .unwrap_err();
        assert!(matches!(e, DreamError::InvalidOutcome(_)), "{name}: {e:?}");
    }
}

#[tokio::test]
async fn oversized_or_invalid_change_sets_are_rejected_before_any_request() {
    let server = tool_server(|_, _, _| bases_get_answer()).await;
    let client = server.client();
    // Nine upserts are never split into two calls.
    let too_many = change_set(DREAM_MAX_UPSERTS + 1);
    let mut duplicate = change_set(2);
    duplicate.upserts[1].id = duplicate.upserts[0].id.clone();
    let mut big = change_set(1);
    big.upserts[0].body = "x".repeat(64 * 1024 + 1);
    let mut dup_sessions = change_set(1);
    dup_sessions.source_session_ids = vec![session(1), session(1)];
    let mut too_many_sessions = change_set(1);
    too_many_sessions.source_session_ids = (0..101)
        .map(|n| format!("00000000-0000-4000-8000-{n:012x}").parse().unwrap())
        .collect();
    let mut no_sessions = change_set(1);
    no_sessions.source_session_ids.clear();
    let mut long_title = change_set(1);
    long_title.title = Some("t".repeat(201));
    for (name, set) in [
        ("nine upserts", too_many),
        ("duplicate id", duplicate),
        ("body over 64 KiB", big),
        ("duplicate sessions", dup_sessions),
        ("101 sessions", too_many_sessions),
        ("upserts without sessions", no_sessions),
        ("title over 200", long_title),
    ] {
        let e = apply_dream(&client, &set, key(), &ctl()).await.unwrap_err();
        assert!(
            matches!(e, DreamError::InvalidChangeSet(_)),
            "{name}: {e:?}"
        );
    }
    assert!(server.calls().is_empty(), "{:?}", server.calls());
}

#[tokio::test]
async fn bases_get_for_another_kb_or_without_head_is_refused() {
    let server = tool_server(|tool, _, _| match tool {
        "knowledge_bases_get" => {
            let mut v = bases_get_answer();
            v["data"]["kb"]["headSha"] = Value::Null;
            v
        }
        other => panic!("unexpected {other}"),
    })
    .await;
    assert!(matches!(
        apply_dream(&server.client(), &change_set(1), key(), &ctl()).await,
        Err(DreamError::Client(_))
    ));
    let server = tool_server(|tool, _, _| match tool {
        "knowledge_bases_get" => {
            let mut v = bases_get_answer();
            v["data"]["kb"]["id"] = json!(KB_B);
            v
        }
        other => panic!("unexpected {other}"),
    })
    .await;
    assert!(matches!(
        apply_dream(&server.client(), &change_set(1), key(), &ctl())
            .await
            .unwrap_err(),
        DreamError::InvalidOutcome(_)
    ));
}
#[test]
fn structured_numeric_filters_preserve_json_parse_bits() {
    use kb_client::types::{JsonScalar, StructuredCondition};
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../../packages/api/src/lib/kb/fixtures/structured-numbers.json"
    ))
    .unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let Some(bits) = case["bits"].as_str() else {
            continue;
        };
        let cell = case["cell"].as_str().unwrap();
        let raw = format!(r#"{{"column":"n","equals":{cell}}}"#);
        let condition: StructuredCondition = serde_json::from_str(&raw).unwrap();
        let JsonScalar::Number(number) = condition.equals else {
            panic!("numeric filter")
        };
        assert_eq!(
            format!("{:016x}", number.as_f64().unwrap().to_bits()),
            bits,
            "{cell}"
        );
        let raw = format!(r#"{{"structured":[{raw}]}}"#);
        let filters: kb_client::snapshot::StructuredFilters = serde_json::from_str(&raw).unwrap();
        let JsonScalar::Number(number) = &filters.structured[0].equals else {
            panic!("numeric host filter")
        };
        assert_eq!(
            format!("{:016x}", number.as_f64().unwrap().to_bits()),
            bits,
            "{cell}"
        );
    }
}

#[test]
fn prepared_dream_accepts_the_session_cap_and_rejects_the_next_entry() {
    use kb_client::dream::PreparedDream;
    let mut set = change_set(8);
    set.source_session_ids = (0..100)
        .map(|n| format!("00000000-0000-4000-8000-{n:012x}").parse().unwrap())
        .collect();
    PreparedDream::new(&set, COMMIT_OLD.parse().unwrap(), key()).unwrap();
    set.source_session_ids.push(session(101));
    assert!(matches!(
        PreparedDream::new(&set, COMMIT_OLD.parse().unwrap(), key()),
        Err(DreamError::InvalidChangeSet(_))
    ));
}

#[test]
fn prepared_dream_freezes_explicit_proposal_consent_with_the_request() {
    use kb_client::dream::PreparedDream;
    let set = change_set(1);
    let base = COMMIT_OLD.parse().unwrap();
    let head = COMMIT_NEW.parse().unwrap();
    let request = PreparedDream::new_for_proposal(&set, base, key(), 7, head).unwrap();
    assert_eq!(request.input().proposal_number, Some(7));
    assert_eq!(
        request.input().proposal_head_sha.as_ref().unwrap().as_str(),
        COMMIT_NEW
    );
    assert_eq!(request.base_revision().as_str(), COMMIT_OLD);
    assert_eq!(request.clone().input(), request.input());
    for number in [0, u64::MAX] {
        assert!(matches!(
            PreparedDream::new_for_proposal(
                &set,
                COMMIT_OLD.parse().unwrap(),
                key(),
                number,
                COMMIT_NEW.parse().unwrap()
            ),
            Err(DreamError::InvalidChangeSet(_))
        ));
    }
}
