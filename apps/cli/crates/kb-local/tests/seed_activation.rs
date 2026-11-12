//! Serving order (one predicate for scheduling, preservation and
//! activation; server parity): head work keeps priority, and while nothing of
//! the head serves, the newest generation of an older commit does. Seeding a
//! KB with quick commits therefore never leaves it without an index.
use kb_client::{decode_input, types::*};
use kb_local::Store;
use serde_json::json;
use std::time::Duration;
#[path = "support/fixture.rs"]
mod fixture;

fn active(s: &Store, kb: &KbId) -> Option<KbId> {
    s.kb(kb).expect("kb").expect("kb").active_generation_id
}
fn state(s: &Store, id: &KbId) -> String {
    rusqlite::Connection::open(s.paths().state_db())
        .expect("db")
        .query_row(
            "SELECT state FROM index_generations WHERE id=?1",
            [id.as_str()],
            |r| r.get(0),
        )
        .expect("state")
}
fn commit(s: &Store, kb: &KbId, key: &str, path: &str) -> KbId {
    let head = s.kb(kb).expect("kb").expect("kb").head_sha.expect("head");
    s.documents_create(
        &s.owner(),
        decode_input::<DocumentsCreate>(json!({"kbId": kb, "baseRevision": head,
            "idempotencyKey": key, "path": path, "content": {"markdown": "# x\n"}}))
        .expect("input"),
    )
    .expect("commit");
    s.bases_get(
        &s.owner(),
        decode_input::<BasesGet>(json!({"kbId": kb})).expect("input"),
    )
    .expect("get")
    .index
    .desired_generation_id
    .expect("desired")
}
async fn finish(
    s: &Store,
    claim: kb_local::generations::BuildAttempt,
) -> Result<bool, kb_local::StoreError> {
    let built = s
        .build_generation(
            claim,
            async |_, _| -> Result<Vec<Vec<f64>>, kb_local::StoreError> {
                panic!("a lexical build never embeds")
            },
            &mut |_| Ok(()),
        )
        .await?;
    s.activate_built(built)
}
fn claim(s: &Store, id: &KbId) -> kb_local::generations::BuildAttempt {
    s.claim_generation(id, Duration::from_secs(120))
        .expect("claim")
}

#[tokio::test]
async fn the_newest_older_generation_serves_until_head_work_does() {
    let f = fixture::Fixture::new("serve-order");
    let s = Store::open(&f.root.join("store")).expect("store");
    let kb = s
        .bases_create(
            &s.owner(),
            decode_input::<BasesCreate>(json!({"name": "Seed", "slug": "seed",
                "description": "Seeded with quick commits", "idempotencyKey": "seed-create-00001"}))
            .expect("input"),
        )
        .expect("create")
        .kb
        .id;
    // A serves.
    let a = s.pending_generation(None).expect("scan").expect("A");
    assert!(finish(&s, claim(&s, &a)).await.expect("A"));
    assert_eq!(active(&s, &kb), Some(a.clone()));
    // Head moves to B (its build starts), then to C before B finishes.
    let b = commit(&s, &kb, "serve-commit-000001", "b.md");
    let b_claim = claim(&s, &b);
    let c = commit(&s, &kb, "serve-commit-000002", "c.md");
    assert_ne!(state(&s, &b), "SUPERSEDED", "B still outranks the active A");
    // B (intermediate, newer than A) finishes: it serves.
    assert!(finish(&s, b_claim).await.expect("B"));
    assert_eq!(active(&s, &kb), Some(b.clone()));
    // C's build fails: B keeps serving.
    let c_claim = claim(&s, &c);
    let failed = s
        .build_generation(
            c_claim,
            async |_, _| -> Result<Vec<Vec<f64>>, kb_local::StoreError> { unreachable!() },
            &mut |_| {
                Err(kb_local::StoreError::Internal(
                    "injected build failure".into(),
                ))
            },
        )
        .await;
    assert!(failed.is_err());
    assert_eq!(active(&s, &kb), Some(b.clone()));
    // C (or its retry) finishes: the head's work serves.
    let retry = if state(&s, &c) == "PENDING" {
        c.clone()
    } else {
        s.advance_clock_for_tests(3601);
        s.index_rebuild(
            &s.owner(),
            decode_input::<IndexRebuild>(
                json!({"kbId": kb, "idempotencyKey": "serve-rebuild-0001", "confirm": "RUN"}),
            )
            .expect("input"),
        )
        .expect("rebuild")
        .generation_id
    };
    assert!(finish(&s, claim(&s, &retry)).await.expect("C"));
    assert_eq!(active(&s, &kb), Some(retry));
}

#[tokio::test]
async fn an_older_build_activates_while_nothing_is_active() {
    let f = fixture::Fixture::new("serve-order-empty");
    let s = Store::open(&f.root.join("store")).expect("store");
    let kb = s
        .bases_create(
            &s.owner(),
            decode_input::<BasesCreate>(json!({"name": "Seed", "slug": "seed",
                "description": "Seeded with quick commits", "idempotencyKey": "seed-create-00002"}))
            .expect("input"),
        )
        .expect("create")
        .kb
        .id;
    let first = s.pending_generation(None).expect("scan").expect("first");
    let first_claim = claim(&s, &first);
    let head = commit(&s, &kb, "serve-commit-000003", "a.md");
    assert_eq!(active(&s, &kb), None);
    assert!(finish(&s, first_claim).await.expect("first"));
    assert_eq!(active(&s, &kb), Some(first), "an older commit serves");
    assert!(finish(&s, claim(&s, &head)).await.expect("head"));
    assert_eq!(active(&s, &kb), Some(head));
}
