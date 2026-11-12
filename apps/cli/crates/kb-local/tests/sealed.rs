//! Task 61 spec-first tests. Real SQLite, Git and publication boundaries;
//! only the trusted OS credential adapter is substituted with disposable keys.
use base64::{Engine as _, engine::general_purpose::STANDARD};
use kb_client::{
    ErrorCode, decode_input,
    schema::{Direction, validate},
    sealed::{RecipientKey, SealedReference, open_envelope},
    types::*,
};
use kb_local::{
    PrincipalKind, Store, StoreError,
    credentials::{Credentials, Secret},
    embedder::ProviderControl,
    sealed::{Enroll, Grant, Literal},
};
use std::{
    cell::{Cell, RefCell},
    collections::BTreeMap,
    time::{Duration, SystemTime},
};
#[path = "support/fixture.rs"]
mod fixture;
const CANARY: &str = "disposable-sealed-canary-λ\nsecond line";
fn uuid(n: u8) -> Uuid {
    format!("00000000-0000-4000-8000-{n:012}")
        .parse()
        .expect("sealed fixture")
}
#[derive(Default)]
struct Keys {
    values: RefCell<BTreeMap<String, String>>,
    fail: Cell<bool>,
    interrupt_after_set: Cell<bool>,
    on_get: RefCell<Option<Box<dyn FnOnce()>>>,
}
impl Credentials for Keys {
    fn set(&self, a: &str, s: &Secret) -> Result<(), StoreError> {
        if self.fail.get() {
            return Err(kb_local::credentials::unavailable());
        }
        self.values.borrow_mut().insert(a.into(), s.expose().into());
        if self.interrupt_after_set.replace(false) {
            return Err(kb_local::credentials::unavailable());
        }
        Ok(())
    }
    fn get(&self, a: &str) -> Result<Secret, StoreError> {
        if let Some(hook) = self.on_get.borrow_mut().take() {
            hook();
        }
        if self.fail.get() {
            return Err(kb_local::credentials::unavailable());
        }
        self.values
            .borrow()
            .get(a)
            .map(|s| Secret::new(s.clone()))
            // A reachable keystore without the entry, as the native one reports.
            .ok_or_else(kb_local::credentials::missing_entry)
    }
    fn delete(&self, a: &str) -> Result<(), StoreError> {
        if self.fail.get() {
            return Err(kb_local::credentials::unavailable());
        }
        self.values.borrow_mut().remove(a);
        Ok(())
    }
}
struct Test {
    _f: fixture::Fixture,
    s: Store,
    kb: KbAttachment,
    keys: Keys,
    recipient: RecipientKey,
}
impl Test {
    fn new() -> Self {
        let f = fixture::Fixture::new("sealed");
        let s = Store::open(&f.root.join("store")).expect("sealed fixture");
        let kb=s.bases_create(&s.owner(),decode_input::<BasesCreate>(serde_json::json!({"name":"Sealed", "slug":"sealed", "description":"Synthetic sealed fixture", "idempotencyKey":"create-sealed-001"})).expect("sealed fixture")).expect("sealed fixture").kb;
        Self {
            _f: f,
            s,
            kb,
            keys: Keys::default(),
            recipient: RecipientKey::from_bytes(uuid(3), [2; 32]),
        }
    }
    fn enrollment(
        &self,
        record_id: Option<Uuid>,
        id: &str,
        text: &str,
    ) -> Result<kb_local::sealed::ControlReply, StoreError> {
        self.s.sealed_enroll(
            &self.s.owner(),
            &self.kb.id,
            Enroll {
                idempotency_key: id.into(),
                record_id,
            },
            Literal::from_utf8(text.into()).expect("sealed fixture"),
            &self.keys,
        )
    }
    fn enroll(&self, id: u8) -> SealedReference {
        self.enrollment(Some(uuid(id)), &format!("enroll-sealed-{id:03}"), CANARY)
            .expect("sealed fixture")
            .reference
            .parse()
            .expect("sealed fixture")
    }
    fn grant(&self, r: &SealedReference, p: &kb_local::LocalPrincipal) {
        self.s
            .sealed_grant(
                &self.s.owner(),
                &self.kb.id,
                Grant {
                    idempotency_key: format!("grant-sealed-{}", r.record_id()),
                    reference: r.clone(),
                    consumer_id: p.id().into(),
                    recipient_key_id: self.recipient.id().clone(),
                    recipient_public_key: self.recipient.public_key_base64(),
                    expires_at: "2099-01-01T00:00:00Z".parse().expect("sealed fixture"),
                },
            )
            .expect("sealed fixture");
    }
    fn source(&mut self, r: &SealedReference) -> Sha {
        self.s.documents_create(&self.s.owner(),decode_input::<DocumentsCreate>(serde_json::json!({"kbId":self.kb.id,"baseRevision":self.s.kb(&self.kb.id).expect("sealed fixture").expect("sealed fixture").head_sha,"idempotencyKey":format!("source-{}",r.record_id()),"path":format!("secret-{}.md",r.record_id()),"content":{"markdown":format!("# Secret\n{r}\n")}})).expect("sealed fixture")).expect("sealed fixture").commit_sha
    }
    fn input(&self, r: &SealedReference, rev: Option<Sha>) -> SealedResolveInput {
        SealedResolveInput {
            kb_id: self.kb.id.clone(),
            rev,
            path: format!("secret-{}.md", r.record_id())
                .parse()
                .expect("sealed fixture"),
            reference: r.to_string(),
            recipient_key_id: self.recipient.id().clone(),
        }
    }
    fn resolve(
        &self,
        r: &SealedReference,
        p: &kb_local::LocalPrincipal,
    ) -> Result<SealedResolveOutput, StoreError> {
        self.s.sealed_resolve(
            p,
            self.input(r, None),
            &self.keys,
            &ProviderControl::default(),
        )
    }
    fn document(&self, r: &SealedReference, rev: Option<Sha>) -> Document {
        let input = self.input(r, rev);
        self.s
            .documents_get(
                &self.s.owner(),
                DocumentsGetInput {
                    kb_id: input.kb_id,
                    rev: input.rev,
                    path: input.path,
                },
            )
            .expect("sealed fixture")
    }
    fn count(&self, sql: &str) -> i64 {
        self.db()
            .query_row(sql, [], |r| r.get(0))
            .expect("fixture scalar")
    }
    fn db(&self) -> rusqlite::Connection {
        rusqlite::Connection::open(self.s.paths().state_db()).expect("sealed fixture")
    }
}
fn code<T>(r: Result<T, StoreError>, expected: ErrorCode) {
    assert_eq!(r.err().expect("required denial").protocol_code(), expected);
}
fn unresolved<T>(r: Result<T, StoreError>) {
    code(r, ErrorCode::UnresolvedReference);
}
#[test]
fn owner_needs_explicit_approval_and_output_is_recipient_ciphertext() {
    let mut t = Test::new();
    let r = t.enroll(1);
    let rev = t.source(&r);
    unresolved(t.resolve(&r, &t.s.owner()));
    t.grant(&r, &t.s.owner());
    let out = t.resolve(&r, &t.s.owner()).unwrap();
    validate(
        SealedResolve::NAME.as_str(),
        Direction::Output,
        &serde_json::to_value(&out).unwrap(),
    )
    .unwrap();
    assert_eq!(
        open_envelope(&t.recipient, &r, &out, SystemTime::now())
            .unwrap()
            .expose_str(),
        Some(CANARY)
    );
    assert!(!serde_json::to_string(&out).unwrap().contains(CANARY));
    assert!(!format!("{out:?}").contains(CANARY));
    let doc = t.document(&r, Some(rev));
    let indexed = serde_json::to_string(&kb_local::chunk::chunk_body(&doc.markdown)).unwrap();
    assert!(indexed.contains("[sealed value redacted]"));
    assert!(!indexed.contains(CANARY));

    assert!(doc.markdown.contains(&r.to_string()));
    assert!(!serde_json::to_string(&doc).unwrap().contains(CANARY));
}
#[test]
fn exact_consumer_key_expiry_read_namespace_and_source_occurrence() {
    let mut t = Test::new();
    let r = t.enroll(1);
    let old = t.kb.head_sha.clone();
    let rev = t.source(&r);
    let p = {
        let g = t.s.lock_write(std::slice::from_ref(&t.kb.id)).unwrap();
        t.s.register_principal(&g, PrincipalKind::Test, &t.kb.id, &[Permission::Read])
            .unwrap()
    };
    t.grant(&r, &p);
    unresolved(t.resolve(&r, &t.s.owner()));
    t.resolve(&r, &p).expect("approved consumer resolution");
    let mut input = t.input(&r, None);
    input.recipient_key_id = uuid(8);
    unresolved(t.s.sealed_resolve(&p, input, &t.keys, &ProviderControl::default()));
    let mut input = t.input(&r, None);
    input.path = "index.md".parse().unwrap();
    unresolved(t.s.sealed_resolve(&p, input, &t.keys, &ProviderControl::default()));
    unresolved(t.s.sealed_resolve(
        &p,
        t.input(&r, Some(old)),
        &t.keys,
        &ProviderControl::default(),
    ));
    let mut input = t.input(&r, Some(rev));
    input.rev = Some("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee".parse().unwrap());
    unresolved(t.s.sealed_resolve(&p, input, &t.keys, &ProviderControl::default()));
    let foreign = SealedReference::new(uuid(99), r.record_id().clone());
    unresolved(t.resolve(&foreign, &p));
    let other = Test::new();
    let mut input = t.input(&r, None);
    input.kb_id = other.kb.id.clone();
    unresolved(other.s.sealed_resolve(
        &other.s.owner(),
        input,
        &t.keys,
        &ProviderControl::default(),
    ));
    t.db()
        .execute(
            "UPDATE sealed_grants SET expires_ms=1 WHERE consumer_id=?1",
            [p.id()],
        )
        .unwrap();
    unresolved(t.resolve(&r, &p));
    t.db()
        .execute(
            "UPDATE sealed_grants SET expires_ms=4102444800000 WHERE consumer_id=?1",
            [p.id()],
        )
        .unwrap();
    t.db()
        .execute(
            "UPDATE principal_ceilings SET bits=0 WHERE principal_id=?1",
            [p.id()],
        )
        .unwrap();
    unresolved(t.resolve(&r, &p));
}
#[test]
fn losing_a_ready_native_key_never_regenerates_or_rebinds_records() {
    let t = Test::new();
    t.enroll(1);
    t.keys.values.borrow_mut().clear();
    let lost = t
        .enrollment(Some(uuid(2)), "enroll-lost-key-001", CANARY)
        .expect_err("the lost master key is reported");
    assert_eq!(lost.protocol_code(), ErrorCode::StorageUnavailable);
    // #4: the guidance names the master key and only recoveries that exist
    // (revoke needs no key; a new store has its own), never re-enrollment here.
    let why = lost.to_string();
    assert!(
        why.contains("sealed master key") && why.contains("never regenerates"),
        "{why}"
    );
    assert!(
        why.contains("kb sealed revoke") && why.contains("new store"),
        "{why}"
    );
    assert!(t.keys.values.borrow().is_empty());
    assert_eq!(t.count("SELECT sealed_key_ready FROM store_meta"), 1);
    assert_eq!(t.count("SELECT count(*) FROM sealed_records"), 1);
}

#[test]
fn enrolled_tree_policy_rejects_foreign_missing_and_revoked_with_zero_publish_effects() {
    let mut t = Test::new();
    let r = t.enroll(1);
    t.source(&r);
    for reference in [
        SealedReference::new(uuid(99), uuid(1)),
        SealedReference::new(r.namespace().clone(), uuid(2)),
    ] {
        let head = t.s.kb(&t.kb.id).unwrap().unwrap().head_sha.unwrap();
        let n: i64 = t.count("SELECT count(*) FROM operation_intents");
        let result=t.s.documents_create(&t.s.owner(),decode_input::<DocumentsCreate>(serde_json::json!({"kbId":t.kb.id,"baseRevision":head,"idempotencyKey":format!("invalid-{}",reference.namespace()),"path":"bad.md","content":{"markdown":reference.to_string()}})).unwrap());
        assert!(result.is_err());
        assert_eq!(
            t.s.kb(&t.kb.id).unwrap().unwrap().head_sha.as_deref(),
            Some(head.as_str())
        );
        assert_eq!(t.count("SELECT count(*) FROM operation_intents"), n);
    }
    t.s.sealed_revoke(&t.s.owner(), &t.kb.id, &r, "revoke-sealed-001")
        .unwrap();
    let head = t.s.kb(&t.kb.id).unwrap().unwrap().head_sha.unwrap();
    let err = t.s.documents_create(&t.s.owner(),decode_input::<DocumentsCreate>(serde_json::json!({"kbId":t.kb.id,"baseRevision":head,"idempotencyKey":"revoked-source-001","path":"bad.md","content":{"markdown":r.to_string()}})).unwrap()).unwrap_err();
    // The revoked reference is named by reason and the offending field.
    assert_eq!(err.protocol_code(), ErrorCode::InvalidArgument);
    assert_eq!(
        err.protocol_details(),
        serde_json::json!({"reason": "SEALED_REFERENCE_REVOKED", "field": "/content"})
    );
}
#[test]
fn l8_revoked_reference_in_an_unchanged_document_never_blocks_other_writes() {
    let mut t = Test::new();
    let r = t.enroll(3);
    t.source(&r);
    let secret = format!("secret-{}.md", r.record_id());
    t.s.sealed_revoke(&t.s.owner(), &t.kb.id, &r, "revoke-retained-001")
        .unwrap();
    // The revoke warning names exactly the documents still mentioning it.
    assert_eq!(
        t.s.sealed_reference_paths(&t.kb.id, &r).unwrap(),
        vec![secret.clone()]
    );
    let head = |t: &Test| t.s.kb(&t.kb.id).unwrap().unwrap().head_sha.unwrap();
    // Unrelated single and batch writes succeed while the symbol is retained.
    let h = head(&t);
    t.s.documents_create(&t.s.owner(),decode_input::<DocumentsCreate>(serde_json::json!({"kbId":t.kb.id,"baseRevision":h,"idempotencyKey":"retained-plain-001","path":"plain.md","content":{"markdown":"# plain"}})).unwrap()).expect("unrelated write");
    // Editing the referencing document while keeping the symbol is refused.
    let h = head(&t);
    assert!(t.s.documents_update(&t.s.owner(),decode_input::<DocumentsUpdate>(serde_json::json!({"kbId":t.kb.id,"baseRevision":h,"idempotencyKey":"retained-edit-001","path":secret,"content":{"markdown":format!("# Secret\n{r}\nmore\n")}})).unwrap()).is_err());
    // Dropping the reference is an ordinary edit.
    t.s.documents_update(&t.s.owner(),decode_input::<DocumentsUpdate>(serde_json::json!({"kbId":t.kb.id,"baseRevision":h,"idempotencyKey":"retained-drop-001","path":secret,"content":{"markdown":"# Secret\nremoved\n"}})).unwrap()).expect("drop the reference");
    assert!(t.s.sealed_reference_paths(&t.kb.id, &r).unwrap().is_empty());
}
#[test]
fn revoke_before_reply_suppresses_result_and_destroys_only_sealed_state() {
    let mut t = Test::new();
    let r = t.enroll(1);
    let rev = t.source(&r);
    t.grant(&r, &t.s.owner());
    unresolved(t.s.sealed_resolve_observed(
        &t.s.owner(),
        t.input(&r, None),
        &t.keys,
        &ProviderControl::default(),
        &mut || {
            t.s.sealed_revoke(&t.s.owner(), &t.kb.id, &r, "revoke-barrier-001")?;
            Ok(())
        },
    ));
    assert!(
        t.db()
            .query_row(
                "SELECT ciphertext IS NULL FROM sealed_records WHERE record_id=?1",
                [r.record_id().as_str()],
                |r| r.get::<_, bool>(0)
            )
            .unwrap()
    );
    assert_eq!(t.count("SELECT count(*) FROM sealed_grants"), 0);
    assert_eq!(t.keys.values.borrow().len(), 1); // Store key stays for other records.
    assert_eq!(
        t.s.kb(&t.kb.id).unwrap().unwrap().head_sha.as_deref(),
        Some(rev.as_str())
    );
    assert!(t.document(&r, None).markdown.contains(&r.to_string()));
    assert!(
        t.enrollment(Some(uuid(1)), "reimport-sealed-001", CANARY)
            .is_err()
    );
}
#[test]
fn private_storage_aad_and_absent_only_idempotent_enrollment_survive_reopen() {
    let mut t = Test::new();
    let r = t.enroll(1);
    let first = t.keys.values.borrow().values().next().unwrap().clone();
    assert_eq!(STANDARD.decode(first).unwrap().len(), 32);
    assert_eq!(t.enroll(1), r);
    assert_eq!(t.keys.values.borrow().len(), 1);
    let result = t.enrollment(Some(uuid(1)), "enroll-sealed-001", "different");
    code(result, ErrorCode::IdempotencyMismatch);
    assert!(
        t.enrollment(Some(uuid(1)), "enroll-other-001", CANARY)
            .is_err()
    );
    for suffix in ["", "-wal", "-shm"] {
        let p = t.s.paths().root().join(format!("state.sqlite{suffix}"));
        if let Ok(bytes) = std::fs::read(p) {
            assert!(!bytes.windows(CANARY.len()).any(|s| s == CANARY.as_bytes()));
        }
    }
    let original = t
        .enrollment(Some(uuid(1)), "enroll-sealed-001", CANARY)
        .unwrap();
    t.source(&r);
    t.grant(&r, &t.s.owner());
    let reopened = Store::open(t.s.paths().root()).unwrap();
    assert_eq!(reopened.store_uuid(), t.s.store_uuid());
    let replay = reopened
        .sealed_enroll(
            &reopened.owner(),
            &t.kb.id,
            Enroll {
                idempotency_key: "enroll-sealed-001".into(),
                record_id: Some(uuid(1)),
            },
            Literal::from_utf8(CANARY.into()).unwrap(),
            &t.keys,
        )
        .unwrap();
    assert_eq!(replay.operation_id, original.operation_id);
    let out = reopened
        .sealed_resolve(
            &reopened.owner(),
            t.input(&r, None),
            &t.keys,
            &ProviderControl::default(),
        )
        .unwrap();
    assert_eq!(
        open_envelope(&t.recipient, &r, &out, SystemTime::now())
            .unwrap()
            .expose_str(),
        Some(CANARY)
    );
    assert_eq!(t.keys.values.borrow().len(), 1);
    let events: String = t
        .db()
        .query_row("SELECT group_concat(event) FROM sealed_events", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(events, "ENROLL,GRANT");
    // A SQLite snapshot cannot test guesses using its public cursor key.
    let cursor: Vec<u8> = t
        .db()
        .query_row("SELECT cursor_key FROM store_meta", [], |r| r.get(0))
        .unwrap();
    let mac: Vec<u8> = t
        .db()
        .query_row(
            "SELECT request_mac FROM sealed_receipts WHERE operation='ENROLL'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let binding = serde_json::to_vec(&(&t.kb.id, Some(uuid(1)), CANARY)).unwrap();
    assert!(
        ring::hmac::verify(
            &ring::hmac::Key::new(ring::hmac::HMAC_SHA256, &cursor),
            &binding,
            &mac
        )
        .is_err()
    );
    let generated = t.enrollment(None, "enroll-generated-001", CANARY).unwrap();
    let reference: SealedReference = generated.reference.parse().unwrap();
    assert_eq!(reference.namespace(), &t.kb.sealed_namespace);
    assert_ne!(reference.record_id(), r.record_id());
    assert_eq!(
        t.enrollment(None, "enroll-generated-001", CANARY)
            .unwrap()
            .operation_id,
        generated.operation_id
    );
    let escaped = "\0".repeat(16384);
    let maximal = t
        .enrollment(Some(uuid(10)), "escaped-enroll-001", &escaped)
        .unwrap();
    assert_eq!(
        t.enrollment(Some(uuid(10)), "escaped-enroll-001", &escaped)
            .unwrap()
            .operation_id,
        maximal.operation_id
    );
}
#[test]
fn keychain_failure_and_interrupted_key_write_fail_closed_retry_is_safe() {
    let t = Test::new();
    t.keys.fail.set(true);
    let enroll = || t.enrollment(Some(uuid(1)), "enroll-sealed-001", CANARY);
    code(enroll(), ErrorCode::StorageUnavailable);
    assert_eq!(t.count("SELECT sealed_key_ready FROM store_meta"), 0);
    t.keys.fail.set(false);
    t.keys.interrupt_after_set.set(true);
    assert!(enroll().is_err());
    let prior = t.keys.values.borrow().values().next().unwrap().clone();
    let response = enroll().unwrap();
    assert_ne!(prior, *t.keys.values.borrow().values().next().unwrap());
    let r: SealedReference = response.reference.parse().unwrap();
    t.grant(&r, &t.s.owner());
    t.keys.fail.set(true);
    // Revocation needs no decryption/native key: destroy the record even offline.
    t.s.sealed_revoke(&t.s.owner(), &t.kb.id, &r, "revoke-sealed-001")
        .unwrap();
    assert!(
        t.db()
            .query_row("SELECT ciphertext IS NULL FROM sealed_records", [], |r| {
                r.get::<_, bool>(0)
            })
            .unwrap()
    );
    t.keys.fail.set(false);
    t.s.sealed_revoke(&t.s.owner(), &t.kb.id, &r, "revoke-sealed-001")
        .unwrap();
}
#[test]
fn control_is_owner_only_input_is_bounded_utf8_and_grants_are_exact() {
    assert!(Literal::from_utf8(String::new()).is_err());
    assert!(Literal::from_utf8("x".repeat(16385)).is_err());
    assert!(Literal::from_utf8("λ".repeat(8192)).is_ok());
    let t = Test::new();
    let r = t.enroll(1);
    let p = {
        let g = t.s.lock_write(std::slice::from_ref(&t.kb.id)).unwrap();
        t.s.register_principal(&g, PrincipalKind::Config, &t.kb.id, &[Permission::Manage])
            .unwrap()
    };
    code(
        t.s.sealed_enroll(
            &p,
            &t.kb.id,
            Enroll {
                idempotency_key: "enroll-manager-001".into(),
                record_id: None,
            },
            Literal::from_utf8(CANARY.into()).unwrap(),
            &t.keys,
        ),
        ErrorCode::Forbidden,
    );
    code(
        t.s.sealed_revoke(&p, &t.kb.id, &r, "revoke-manager-001"),
        ErrorCode::Forbidden,
    );
    code(
        t.s.sealed_grant(
            &p,
            &t.kb.id,
            Grant {
                idempotency_key: "grant-manager-001".into(),
                reference: r.clone(),
                consumer_id: p.id().into(),
                recipient_key_id: t.recipient.id().clone(),
                recipient_public_key: t.recipient.public_key_base64(),
                expires_at: "2099-01-01T00:00:00Z".parse().unwrap(),
            },
        ),
        ErrorCode::Forbidden,
    );
    for (consumer, key, expiry) in [
        (
            "*".to_owned(),
            t.recipient.public_key_base64(),
            "2099-01-01T00:00:00Z",
        ),
        (
            t.s.owner().id().into(),
            STANDARD.encode([0; 32]),
            "2099-01-01T00:00:00Z",
        ),
        (
            t.s.owner().id().into(),
            t.recipient.public_key_base64(),
            "2000-01-01T00:00:00Z",
        ),
    ] {
        assert!(
            t.s.sealed_grant(
                &t.s.owner(),
                &t.kb.id,
                Grant {
                    idempotency_key: "invalid-grant-001".into(),
                    reference: r.clone(),
                    consumer_id: consumer,
                    recipient_key_id: t.recipient.id().clone(),
                    recipient_public_key: key,
                    expires_at: expiry.parse().unwrap()
                }
            )
            .is_err()
        );
    }
}
#[test]
fn cancel_deadline_live_read_barrier_and_at_rest_tamper_deny() {
    let mut t = Test::new();
    let r = t.enroll(1);
    t.source(&r);
    t.grant(&r, &t.s.owner());
    let ctl = ProviderControl::default();
    ctl.cancel();
    code(
        t.s.sealed_resolve(&t.s.owner(), t.input(&r, None), &t.keys, &ctl),
        ErrorCode::Cancelled,
    );
    code(
        t.s.sealed_resolve(
            &t.s.owner(),
            t.input(&r, None),
            &t.keys,
            &ProviderControl::with_timeout(Duration::ZERO),
        ),
        ErrorCode::DeadlineExceeded,
    );
    t.keys.fail.set(true);
    code(t.resolve(&r, &t.s.owner()), ErrorCode::StorageUnavailable);
    t.keys.fail.set(false);
    t.db()
        .execute(
            "UPDATE sealed_records SET ciphertext=zeroblob(length(ciphertext)) WHERE record_id=?1",
            [r.record_id().as_str()],
        )
        .unwrap();
    unresolved(t.resolve(&r, &t.s.owner()));
}

#[test]
fn at_rest_ciphertext_cannot_be_transplanted_to_another_record() {
    let mut t = Test::new();
    let a = t.enroll(1);
    let b = t.enroll(2);
    t.source(&a);
    t.source(&b);
    t.grant(&a, &t.s.owner());
    t.grant(&b, &t.s.owner());
    // A single store key isolates this failure to record AAD authentication.
    assert_eq!(t.keys.values.borrow().len(), 1);
    t.db().execute("UPDATE sealed_records SET ciphertext=(SELECT ciphertext FROM sealed_records WHERE record_id=?1),nonce=(SELECT nonce FROM sealed_records WHERE record_id=?1) WHERE record_id=?2",(a.record_id().as_str(),b.record_id().as_str())).unwrap();
    unresolved(t.resolve(&b, &t.s.owner()));
}
#[test]
fn final_barrier_rechecks_read_and_grant_expiry() {
    let mut t = Test::new();
    let r = t.enroll(1);
    t.source(&r);
    let p = {
        let g = t.s.lock_write(std::slice::from_ref(&t.kb.id)).unwrap();
        t.s.register_principal(&g, PrincipalKind::Test, &t.kb.id, &[Permission::Read])
            .unwrap()
    };
    t.grant(&r, &p);
    unresolved(t.s.sealed_resolve_observed(
        &p,
        t.input(&r, None),
        &t.keys,
        &ProviderControl::default(),
        &mut || {
            t.db().execute(
                "UPDATE principal_ceilings SET bits=0 WHERE principal_id=?1",
                [p.id()],
            )?;
            Ok(())
        },
    ));
    t.db()
        .execute(
            "UPDATE principal_ceilings SET bits=1 WHERE principal_id=?1",
            [p.id()],
        )
        .unwrap();
    unresolved(t.s.sealed_resolve_observed(
        &p,
        t.input(&r, None),
        &t.keys,
        &ProviderControl::default(),
        &mut || {
            t.db().execute(
                "UPDATE sealed_grants SET expires_ms=1 WHERE consumer_id=?1",
                [p.id()],
            )?;
            Ok(())
        },
    ));
}

#[test]
#[cfg(unix)]
fn native_key_read_cancellation_kills_and_reaps_the_actual_worker() {
    use std::os::unix::fs::PermissionsExt;
    let mut t = Test::new();
    let r = t.enroll(1);
    t.source(&r);
    t.grant(&r, &t.s.owner());
    let marker = t._f.root.join("worker.pid");
    let executable = t._f.root.join("credential-worker");
    std::fs::write(
        &executable,
        format!(
            "#!/bin/sh\necho $$ > '{}'\nexec sleep 30\n",
            marker.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
    let ctl = ProviderControl::default();
    let cancel = ctl.clone();
    let announced = marker.clone();
    let join = std::thread::spawn(move || {
        let end = std::time::Instant::now() + Duration::from_secs(5);
        while !announced.exists() && std::time::Instant::now() < end {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(announced.exists());
        cancel.cancel();
    });
    let native = kb_local::credentials::NativeCredentials::new(executable);
    code(
        t.s.sealed_resolve(&t.s.owner(), t.input(&r, None), &native, &ctl),
        ErrorCode::Cancelled,
    );
    join.join().unwrap();
    #[cfg(target_os = "linux")]
    {
        let pid = std::fs::read_to_string(marker).unwrap();
        assert!(!std::path::Path::new(&format!("/proc/{}", pid.trim())).exists());
    }
}

#[test]
fn wall_clock_expiry_suppresses_an_approved_owner_reply() {
    let mut t = Test::new();
    let r = t.enroll(1);
    t.source(&r);
    t.grant(&r, &t.s.owner());
    t.s.set_cursor_clock_for_tests(2_840_140_800); // 2060, still before approval expiry.
    assert!(t.resolve(&r, &t.s.owner()).is_ok());
    unresolved(t.s.sealed_resolve_observed(
        &t.s.owner(),
        t.input(&r, None),
        &t.keys,
        &ProviderControl::default(),
        &mut || {
            t.s.set_cursor_clock_for_tests(4_102_444_800);
            Ok(())
        }, // 2100.
    ));
}

#[test]
fn human_approval_rejects_an_expired_fractional_instant() {
    let t = Test::new();
    let r = t.enroll(1);
    let expires_at = "2000-01-01T00:00:00.001Z".parse().unwrap();
    code(
        t.s.sealed_grant(
            &t.s.owner(),
            &t.kb.id,
            Grant {
                idempotency_key: "fractional-expiry-001".into(),
                reference: r,
                consumer_id: t.s.owner().id().into(),
                recipient_key_id: t.recipient.id().clone(),
                recipient_public_key: t.recipient.public_key_base64(),
                expires_at,
            },
        ),
        ErrorCode::InvalidArgument,
    );
}

#[test]
fn fix_revoked_symbols_export_from_current_and_historical_revisions() {
    let mut t = Test::new();
    let r = t.enroll(1);
    let rev = t.source(&r);
    t.s.documents_create(&t.s.owner(), decode_input::<DocumentsCreate>(serde_json::json!({"kbId":t.kb.id,"baseRevision":rev,"idempotencyKey":"advance-export-001","path":"extra.md","content":{"markdown":"# Extra"}})).unwrap()).unwrap();
    t.s.sealed_revoke(&t.s.owner(), &t.kb.id, &r, "revoke-export-001")
        .unwrap();
    let guard = t.s.lock_write(std::slice::from_ref(&t.kb.id)).unwrap();
    let reader =
        t.s.register_principal(&guard, PrincipalKind::Test, &t.kb.id, &[Permission::Read])
            .unwrap();
    drop(guard);
    for (i, (kind, pinned)) in [
        ("whole", Some(&rev)),
        ("assets", Some(&rev)),
        ("whole", None),
        ("assets", None),
    ]
    .into_iter()
    .enumerate()
    {
        let mut request = serde_json::json!({"kbId":t.kb.id,"kind":kind,"idempotencyKey":format!("revoked-export-{i:03}")});
        if let Some(rev) = pinned {
            request["rev"] = serde_json::json!(rev);
        }
        let out =
            t.s.export_prepare(&reader, decode_input::<ExportPrepare>(request).unwrap())
                .unwrap();
        let frame =
            t.s.transfer_read(
                &reader,
                TransferReadInput {
                    kb_id: t.kb.id.clone(),
                    transfer_id: out.transfer_id.clone(),
                    offset: 0,
                    max_bytes: None,
                },
            )
            .unwrap();
        assert!(frame.eof);
        let bytes = STANDARD.decode(frame.bytes_base64).unwrap();
        assert!(!bytes.windows(CANARY.len()).any(|s| s == CANARY.as_bytes()));
        if kind == "whole" {
            let symbol = r.to_string();
            // The existing independent exports suite verifies STORE ZIP entries.
            assert!(bytes.windows(symbol.len()).any(|s| s == symbol.as_bytes()));
        }
        t.s.export_complete(
            &reader,
            TransferRef {
                kb_id: t.kb.id.clone(),
                transfer_id: out.transfer_id,
            },
        )
        .unwrap();
    }
    unresolved(t.resolve(&r, &t.s.owner()));
}
#[test]
fn fix_tombstone_destroys_only_its_sealed_authority_and_replays() {
    let mut t = Test::new();
    let r = t.enroll(1);
    let rev = t.source(&r);
    t.grant(&r, &t.s.owner());
    let other = t.s.bases_create(&t.s.owner(), decode_input::<BasesCreate>(serde_json::json!({"name":"Other", "slug":"other", "description":"Another sealed knowledge base", "idempotencyKey":"create-other-001"})).unwrap()).unwrap().kb;
    let retained =
        t.s.sealed_enroll(
            &t.s.owner(),
            &other.id,
            Enroll {
                idempotency_key: "enroll-other-001".into(),
                record_id: Some(uuid(2)),
            },
            Literal::from_utf8(CANARY.into()).unwrap(),
            &t.keys,
        )
        .unwrap();
    let deletion = || {
        decode_input::<BasesDelete>(serde_json::json!({"kbId":t.kb.id,"metadataVersion":t.kb.metadata_version,"idempotencyKey":"delete-sealed-001","confirm":"DELETE"})).unwrap()
    };
    let deleted = t.s.bases_delete(&t.s.owner(), deletion()).unwrap();
    assert_eq!(
        t.s.bases_delete(&t.s.owner(), deletion())
            .unwrap()
            .operation_id,
        deleted.operation_id
    );
    assert_eq!(t.count("SELECT count(*) FROM sealed_records WHERE state='REVOKED' AND ciphertext IS NULL AND nonce IS NULL"), 1);
    assert_eq!(t.count("SELECT count(*) FROM sealed_grants"), 0);
    assert_eq!(
        t.count(
            "SELECT count(*) FROM sealed_records WHERE state='ACTIVE' AND ciphertext IS NOT NULL"
        ),
        1
    );
    assert_eq!(
        t.count("SELECT count(*) FROM sealed_receipts WHERE operation='ENROLL'"),
        2
    );
    assert_eq!(t.keys.values.borrow().len(), 1);
    let repo = kb_local::git_read::GitRepo::for_kb(t.s.paths(), &t.kb.id).unwrap();
    assert!(
        kb_local::git_read::read_document(&repo, &rev, t.input(&r, None).path.as_str())
            .unwrap()
            .markdown
            .contains(&r.to_string())
    );
    unresolved(t.resolve(&r, &t.s.owner()));
    t.s.sealed_revoke(
        &t.s.owner(),
        &other.id,
        &retained.reference.parse().unwrap(),
        "revoke-other-001",
    )
    .unwrap();
}
#[test]
fn fix_repair_allows_only_owner_destructive_control() {
    let t = Test::new();
    let r = t.enroll(1);
    t.grant(&r, &t.s.owner());
    let guard = t.s.lock_write(std::slice::from_ref(&t.kb.id)).unwrap();
    let manager =
        t.s.register_principal(&guard, PrincipalKind::Test, &t.kb.id, &[Permission::Manage])
            .unwrap();
    drop(guard);
    t.db()
        .execute(
            "UPDATE kbs SET state='REPAIR_REQUIRED' WHERE id=?1",
            [t.kb.id.as_str()],
        )
        .unwrap();
    code(
        t.enrollment(Some(uuid(2)), "enroll-repair-001", CANARY),
        ErrorCode::NotFound,
    );
    code(
        t.s.sealed_revoke(&manager, &t.kb.id, &r, "revoke-repair-001"),
        ErrorCode::Forbidden,
    );
    let reply =
        t.s.sealed_revoke(&t.s.owner(), &t.kb.id, &r, "revoke-repair-001")
            .unwrap();
    assert_eq!(
        reply.operation_id,
        t.s.sealed_revoke(&t.s.owner(), &t.kb.id, &r, "revoke-repair-001")
            .unwrap()
            .operation_id
    );
    assert_eq!(
        t.count("SELECT count(*) FROM sealed_records WHERE nonce IS NULL AND ciphertext IS NULL"),
        1
    );
    assert_eq!(t.count("SELECT count(*) FROM sealed_grants"), 0);
    assert_eq!(t.keys.values.borrow().len(), 1);
}
#[test]
fn fix_invalid_enrollment_has_zero_key_registry_receipt_audit_or_charge_effects() {
    let t = Test::new();
    let before =
        t.count("SELECT coalesce(sum(json_array_length(times_json)),0) FROM mutation_windows");
    for id in [
        "".to_owned(),
        "x".repeat(129),
        "invalid key with spaces".into(),
    ] {
        code(
            t.enrollment(Some(uuid(1)), &id, CANARY),
            ErrorCode::InvalidArgument,
        );
        assert!(t.keys.values.borrow().is_empty());
        assert_eq!(t.count("SELECT sealed_key_ready FROM store_meta"), 0);
        for table in ["sealed_records", "sealed_receipts", "sealed_events"] {
            assert_eq!(t.count(&format!("SELECT count(*) FROM {table}")), 0);
        }
        assert_eq!(
            t.count("SELECT coalesce(sum(json_array_length(times_json)),0) FROM mutation_windows"),
            before
        );
    }
    t.enroll(1);
}
#[test]
fn fix_resolver_preserves_repair_and_source_storage_errors() {
    let mut t = Test::new();
    let r = t.enroll(1);
    t.source(&r);
    t.grant(&r, &t.s.owner());
    t.db()
        .execute(
            "UPDATE kbs SET state='REPAIR_REQUIRED' WHERE id=?1",
            [t.kb.id.as_str()],
        )
        .unwrap();
    code(t.resolve(&r, &t.s.owner()), ErrorCode::RepairRequired);
    t.db()
        .execute(
            "UPDATE kbs SET state='ACTIVE' WHERE id=?1",
            [t.kb.id.as_str()],
        )
        .unwrap();
    let doc = t.document(&r, None);
    let hash = doc.blob_sha.as_str();
    t._f.repo = t.s.paths().repo_dir(&t.kb.id);
    // Publications install packs. Corrupt just this blob's packed entry so
    // the reachable commit/tree remain readable and the source read fails.
    let (index, offset) = std::fs::read_dir(t._f.repo.join("objects/pack"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "idx"))
        .find_map(|index| {
            let listing = t._f.git(&["verify-pack", "-v", index.to_str().unwrap()]);
            let offset = listing
                .lines()
                .find(|line| line.starts_with(&format!("{hash} ")))?
                .split_whitespace()
                .nth(4)?
                .parse::<usize>()
                .ok()?;
            Some((index, offset))
        })
        .expect("pack containing source blob");
    let pack = index.with_extension("pack");
    let mut bytes = std::fs::read(&pack).unwrap();
    bytes[offset] = 0; // invalid packed object type, without changing other offsets
    std::fs::remove_file(&pack).unwrap();
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    std::io::Write::write_all(&mut options.open(pack).unwrap(), &bytes).unwrap();
    code(t.resolve(&r, &t.s.owner()), ErrorCode::StorageUnavailable);
    assert_eq!(
        t.count("SELECT count(*) FROM sealed_events WHERE event='RESOLVE_DENIED'"),
        0
    );
}
fn no_disk(_: &kb_local::StorePaths, _: &std::path::Path) -> Result<u64, StoreError> {
    Ok(0)
}
fn disk_headroom(_: &kb_local::StorePaths, _: &std::path::Path) -> Result<u64, StoreError> {
    Ok(kb_local::limits::FREE_DISK_FLOOR_BYTES + kb_local::limits::WRITE_DISK_RESERVE_BYTES)
}
fn ciphertext_headroom(_: &kb_local::StorePaths, _: &std::path::Path) -> Result<u64, StoreError> {
    Ok(kb_local::limits::FREE_DISK_FLOOR_BYTES
        + kb_local::limits::WRITE_DISK_RESERVE_BYTES
        + CANARY.len() as u64
        + 16)
}
#[test]
fn fix_disk_admission_precedes_initial_key_and_fresh_writes_but_exempts_replay_and_revoke() {
    let t = Test::new();
    for meter in [
        no_disk as fn(&kb_local::StorePaths, &std::path::Path) -> Result<u64, StoreError>,
        disk_headroom,
    ] {
        t.s.set_disk_meter_for_tests(meter);
        code(
            t.enrollment(Some(uuid(1)), "enroll-sealed-001", CANARY),
            ErrorCode::QuotaExceeded,
        );
        assert!(t.keys.values.borrow().is_empty());
        assert_eq!(t.count("SELECT sealed_key_ready FROM store_meta"), 0);
        assert_eq!(t.count("SELECT count(*) FROM sealed_receipts"), 0);
    }
    t.s.set_disk_meter_for_tests(ciphertext_headroom);
    let first = t
        .enrollment(Some(uuid(1)), "enroll-sealed-001", CANARY)
        .unwrap();
    let r = first.reference.parse().unwrap();
    t.grant(&r, &t.s.owner());
    let grants = t.count("SELECT count(*) FROM sealed_receipts WHERE operation='GRANT'");
    t.s.set_disk_meter_for_tests(no_disk);
    assert_eq!(
        t.enrollment(Some(uuid(1)), "enroll-sealed-001", CANARY)
            .unwrap()
            .operation_id,
        first.operation_id
    );
    t.grant(&r, &t.s.owner()); // Exact receipt replay needs no allocation.
    code(
        t.enrollment(Some(uuid(2)), "enroll-other-001", CANARY),
        ErrorCode::QuotaExceeded,
    );
    code(
        t.s.sealed_grant(
            &t.s.owner(),
            &t.kb.id,
            Grant {
                idempotency_key: "new-grant-key-001".into(),
                reference: r.clone(),
                consumer_id: t.s.owner().id().into(),
                recipient_key_id: uuid(4),
                recipient_public_key: t.recipient.public_key_base64(),
                expires_at: "2099-01-01T00:00:00Z".parse().unwrap(),
            },
        ),
        ErrorCode::QuotaExceeded,
    );
    assert_eq!(
        t.count("SELECT count(*) FROM sealed_receipts WHERE operation='GRANT'"),
        grants
    );
    assert_eq!(t.count("SELECT count(*) FROM sealed_records"), 1);
    t.keys.fail.set(true);
    t.s.sealed_revoke(&t.s.owner(), &t.kb.id, &r, "revoke-no-disk-001")
        .unwrap();
    assert_eq!(t.count("SELECT count(*) FROM sealed_grants"), 0);
}
#[test]
fn fix_disk_admission_preserves_pending_upload_promises() {
    let t = Test::new();
    let bytes = vec![b'x'; 4096];
    t.s.upload_begin(&t.s.owner(), decode_input::<UploadBegin>(serde_json::json!({"kbId":t.kb.id,"idempotencyKey":"pending-upload-001","kind":"markdown","size":bytes.len(),"contentHash":kb_client::snapshot::content_hash(&bytes),"mime":"text/markdown"})).unwrap()).unwrap();
    t.s.set_disk_meter_for_tests(ciphertext_headroom);
    code(
        t.enrollment(Some(uuid(1)), "pending-enroll-001", CANARY),
        ErrorCode::QuotaExceeded,
    );
    assert!(t.keys.values.borrow().is_empty());
    assert_eq!(t.count("SELECT sealed_key_ready FROM store_meta"), 0);
    assert_eq!(t.count("SELECT count(*) FROM sealed_records"), 0);
    assert_eq!(
        t.count("SELECT count(*) FROM staged_uploads WHERE reserved=1"),
        1
    );
}

#[test]
fn fix_final_reachability_preserves_operational_error_and_native_sibling_reauths() {
    let mut t = Test::new();
    let r = t.enroll(1);
    t.source(&r);
    t.grant(&r, &t.s.owner());
    let config = t.s.paths().repo_dir(&t.kb.id).join("config");
    let original = std::fs::read(&config).unwrap();
    code(
        t.s.sealed_resolve_observed(
            &t.s.owner(),
            t.input(&r, None),
            &t.keys,
            &ProviderControl::default(),
            &mut || {
                std::fs::write(&config, b"[core]\n hooksPath=fixture\n").unwrap();
                Ok(())
            },
        ),
        ErrorCode::RepairRequired,
    );
    std::fs::write(&config, original).unwrap();
    code(
        t.s.sealed_resolve_observed(
            &t.s.owner(),
            t.input(&r, None),
            &t.keys,
            &ProviderControl::default(),
            &mut || {
                t.db().execute(
                    "UPDATE kbs SET state='REPAIR_REQUIRED' WHERE id=?1",
                    [t.kb.id.as_str()],
                )?;
                Ok(())
            },
        ),
        ErrorCode::RepairRequired,
    );
    t.db()
        .execute(
            "UPDATE kbs SET state='ACTIVE' WHERE id=?1",
            [t.kb.id.as_str()],
        )
        .unwrap();
    t.keys.fail.set(true);
    code(t.resolve(&r, &t.s.owner()), ErrorCode::StorageUnavailable);
    let root = t.s.paths().root().to_path_buf();
    let kb = t.kb.id.clone();
    let reference = r.clone();
    *t.keys.on_get.borrow_mut() = Some(Box::new(move || {
        let s = Store::open(&root).unwrap();
        s.sealed_revoke(&s.owner(), &kb, &reference, "revoke-native-error-001")
            .unwrap();
    }));
    // Revocation occurs inside GET, immediately before its storage failure.
    // Only the native-error branch's reauthorization can suppress that error.
    unresolved(t.resolve(&r, &t.s.owner()));
}

#[test]
fn fix_tombstone_cleanup_failure_rolls_back_lifecycle_and_authority() {
    let t = Test::new();
    let r = t.enroll(1);
    t.grant(&r, &t.s.owner());
    let receipts = t.count("SELECT count(*) FROM operation_intents");
    // A real SQLite fault after the ciphertext update must abort the whole
    // existing lifecycle transaction, including the preceding KB tombstone.
    t.db().execute_batch("CREATE TRIGGER fixture_sealed_failure AFTER UPDATE ON sealed_records BEGIN SELECT RAISE(ABORT,'fixture storage failure'); END;").unwrap();
    let result = t.s.bases_delete(&t.s.owner(),decode_input::<BasesDelete>(serde_json::json!({"kbId":t.kb.id,"metadataVersion":t.kb.metadata_version,"idempotencyKey":"delete-rollback-001","confirm":"DELETE"})).unwrap());
    assert!(result.is_err());
    assert_eq!(
        t.s.kb(&t.kb.id).unwrap().unwrap().state,
        kb_local::KbState::Active
    );
    assert_eq!(t.count("SELECT count(*) FROM sealed_records WHERE state='ACTIVE' AND nonce IS NOT NULL AND ciphertext IS NOT NULL"),1);
    assert_eq!(t.count("SELECT count(*) FROM sealed_grants"), 1);
    assert_eq!(t.count("SELECT count(*) FROM operation_intents"), receipts);
}

/// R3 review: a PR's status comes from the reviewed merge's own validated
/// plan. A PR adding a sealed reference whose record is then revoked, with
/// no Git head moving, reads CONFLICT exactly when the
/// merge of those heads is refused.
#[test]
fn pr_status_runs_the_merges_whole_tree_validation() {
    let t = Test::new();
    let r = t.enroll(4);
    let author = {
        let guard =
            t.s.lock_write(std::slice::from_ref(&t.kb.id))
                .expect("fixture");
        t.s.register_principal(
            &guard,
            kb_local::PrincipalKind::Test,
            &t.kb.id,
            &[kb_client::types::Permission::Propose],
        )
        .expect("fixture")
    };
    let head = |t: &Test| t.s.kb(&t.kb.id).unwrap().unwrap().head_sha.unwrap();
    let proposed = t.s.documents_create(&author, decode_input::<DocumentsCreate>(serde_json::json!({"kbId":t.kb.id,"baseRevision":head(&t),"idempotencyKey":"pr-sealed-create-1","path":"secret.md","content":{"markdown":format!("# Secret\n{r}\n")}})).unwrap()).expect("proposal");
    let number = proposed.proposal.expect("proposal").number;
    let cached =
        t.s.pull_requests_get(
            &t.s.owner(),
            decode_input::<kb_client::types::PullRequestsGet>(
                serde_json::json!({"kbId":t.kb.id,"number":number}),
            )
            .unwrap(),
        )
        .expect("cache OPEN");
    assert_eq!(cached.pr.status, kb_client::types::PrStatus::Open);
    t.s.sealed_revoke(&t.s.owner(), &t.kb.id, &r, "revoke-pr-sealed-01")
        .unwrap();
    assert_eq!(head(&t), proposed.base_revision.as_str());
    let get =
        t.s.pull_requests_get(
            &t.s.owner(),
            decode_input::<kb_client::types::PullRequestsGet>(
                serde_json::json!({"kbId":t.kb.id,"number":number}),
            )
            .unwrap(),
        )
        .expect("get");
    assert_eq!(get.pr.status, kb_client::types::PrStatus::Conflict);
    let merge = t.s.pull_requests_review(
        &t.s.owner(),
        decode_input::<kb_client::types::PullRequestsReview>(serde_json::json!({
            "kbId":t.kb.id,"number":number,"decision":"merge","confirm":"MERGE",
            "expectedHeadSha":get.pr.head_sha,"expectedTargetSha":get.pr.target_sha,
            "idempotencyKey":"pr-sealed-merge-01"
        }))
        .unwrap(),
    );
    assert_eq!(
        merge.expect_err("refused").protocol_code(),
        ErrorCode::Conflict
    );
}
