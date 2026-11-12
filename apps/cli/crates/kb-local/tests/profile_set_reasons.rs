//! Classification of `knowledge_embedding_profile_set`, one contract with
//! the server: an unknown, revoked or someone else's provider is NOT_FOUND {};
//! a revision the provider never had, or an obsolete one, is CONFLICT
//! `REVISION_NOT_CURRENT` on `/revision`; the current revision while it is not
//! usable yet is the retryable INDEX_UNAVAILABLE; an omitted external revision
//! is MISSING_ARGUMENT on `/revision`.
#[path = "support/index_fixture.rs"]
mod index_fixture;
use index_fixture::*;
use kb_client::{ErrorCode, types::*};
use kb_local::{PrincipalKind, StoreError};
use serde_json::{Value, json};

fn attach(f: &Fixture, provider: &str, revision: Option<i64>, key: &str) -> Result<(), StoreError> {
    let mut input =
        json!({"kbId": f.kb, "providerId": provider, "idempotencyKey": key, "confirm": "RUN"});
    if let Some(r) = revision {
        input["revision"] = json!(r);
    }
    let input = serde_json::from_value(input).expect("input");
    f.store
        .embedding_profile_set(&f.store.owner(), input)
        .map(|_| ())
}
fn refusal(result: Result<(), StoreError>) -> (ErrorCode, Value, bool) {
    let e = result.expect_err("refused");
    (
        e.protocol_code(),
        e.protocol_details(),
        e.protocol_code().retryable(),
    )
}
fn not_current() -> (ErrorCode, Value, bool) {
    (
        ErrorCode::Conflict,
        json!({"reason": "REVISION_NOT_CURRENT", "field": "/revision"}),
        false,
    )
}

#[test]
fn profile_set_refusals_follow_one_classification() {
    let f = Fixture::new(2);
    let p = f.provider.as_str().to_owned();
    // A revision the provider never had.
    assert_eq!(
        refusal(attach(&f, &p, Some(7), "reason-key-0000001")),
        not_current()
    );
    // Revision 2 is the latest but its probe is pending: a retryable outage.
    f.db().execute("INSERT INTO provider_revisions(provider_id,revision,endpoint_url,model,dimensions,fingerprint,state) VALUES(?1,2,'https://example.invalid/embeddings','fixture',2,?2,'PROBING')",rusqlite::params![p,format!("sha256:{}","b".repeat(64))]).expect("revision 2");
    f.db().execute("INSERT INTO provider_registrations(operation_id,idempotency_key,request_mac,provider_id,revision) VALUES('00000000-0000-4000-8000-0000000000b2','fixture-register-0002',zeroblob(32),?1,2)",[&p]).expect("registration 2");
    assert_eq!(
        refusal(attach(&f, &p, Some(2), "reason-key-0000002")),
        (ErrorCode::IndexUnavailable, json!({}), true)
    );
    // The older revision still READY stays attachable.
    attach(&f, &p, Some(1), "reason-key-0000003").expect("older usable revision");
    // ... but once it is unusable and replaced, it is obsolete.
    f.db()
        .execute(
            "UPDATE provider_revisions SET state='FAILED' WHERE provider_id=?1 AND revision=1",
            [&p],
        )
        .expect("fail revision 1");
    assert_eq!(
        refusal(attach(&f, &p, Some(1), "reason-key-0000004")),
        not_current()
    );
    // Omitted external revision.
    assert_eq!(
        refusal(attach(&f, &p, None, "reason-key-0000005")),
        (
            ErrorCode::InvalidArgument,
            json!({"reason": "MISSING_ARGUMENT", "field": "/revision"}),
            false
        )
    );
    // Unknown and revoked providers: NOT_FOUND without details.
    let unknown = "q".repeat(24);
    assert_eq!(
        refusal(attach(&f, &unknown, Some(1), "reason-key-0000006")),
        (ErrorCode::NotFound, json!({}), false)
    );
    // Someone other than the owner (a narrowed manager): NOT_FOUND too.
    let guard = f.store.lock_write(&[]).expect("lock");
    let manager = f
        .store
        .register_principal(&guard, PrincipalKind::Test, &f.kb, &[Permission::Manage])
        .expect("manager");
    drop(guard);
    let input = serde_json::from_value(json!({"kbId": f.kb, "providerId": p, "revision": 2,
        "idempotencyKey": "reason-key-0000008", "confirm": "RUN"}))
    .expect("input");
    let e = f
        .store
        .embedding_profile_set(&manager, input)
        .expect_err("not theirs");
    assert_eq!(
        (e.protocol_code(), e.protocol_details()),
        (ErrorCode::NotFound, json!({}))
    );
    f.db()
        .execute("UPDATE providers SET revoked=1 WHERE id=?1", [&p])
        .expect("revoke");
    assert_eq!(
        refusal(attach(&f, &p, Some(2), "reason-key-0000007")),
        (ErrorCode::NotFound, json!({}), false)
    );
}

/// The built-in: a revision other than the current configuration's is
/// REVISION_NOT_CURRENT whatever the model's state; the current one while the
/// model is disabled is the retryable INDEX_UNAVAILABLE.
#[test]
fn builtin_revisions_classify_before_usability() {
    let f = Fixture::new(2);
    assert_eq!(
        refusal(attach(&f, "builtin", Some(5), "builtin-key-000001")),
        not_current()
    );
    let current = f.store.model_state().expect("model").epoch + 1;
    let (code, _, retryable) = refusal(attach(&f, "builtin", Some(current), "builtin-key-000002"));
    assert_eq!((code, retryable), (ErrorCode::IndexUnavailable, true));
}

#[test]
fn profile_set_revision_is_a_positive_integer_in_the_shared_schema() {
    let f = Fixture::new(2);
    for revision in [-1, 0] {
        let e = attach(
            &f,
            f.provider.as_str(),
            Some(revision),
            "positive-revision-test",
        )
        .expect_err("positive revision required");
        assert_eq!(e.protocol_code(), ErrorCode::InvalidArgument);
        assert_eq!(e.protocol_details()["reason"], "SCHEMA");
        assert_eq!(e.protocol_details()["field"], "/revision");
        assert_eq!(e.protocol_details()["min"], 1);
    }
}
