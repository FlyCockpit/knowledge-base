//! Driven by the real SQL/Git/MCP fixture in `pnpm test:kb -- sealed`.
use std::time::Duration;

use kb_client::attachment::attach;
use kb_client::dream::{
    DreamChangeSet, DreamError, DreamOutcome, PreparedDream, apply_dream, submit_dream,
};
use kb_client::sealed::{RecipientKey, SealedReference, forward_sealed_resolve, resolve_sealed};
use kb_client::types::{
    DreamModel, DreamProvenance, DreamUpsert, IdempotencyKey, KbId, KbPath, PullRequestsReview,
    PullRequestsReviewInput, ReviewConfirm, ReviewDecision, SealedResolveInput, Uuid,
};
use kb_client::{
    CallControl, ClientOptions, Credential, KbLocator, McpClient, McpResource, SecretToken,
    TransportPolicy,
};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    kb_id: KbId,
    reference: String,
    recipient_key_id: Uuid,
    private_key: [u8; 32],
    canary: String,
}

fn client(resource: &McpResource, name: &str) -> McpClient {
    let token = std::env::var(name).expect("run pnpm test:kb -- sealed");
    McpClient::new(
        resource.clone(),
        Credential::new(resource.clone(), SecretToken::new(token)),
        ClientOptions::default(),
    )
    .expect("fixture client")
}
static NEXT_KEY: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
fn key() -> IdempotencyKey {
    IdempotencyKey::parse(&format!(
        "r50-production-{:016}",
        NEXT_KEY.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ))
    .expect("fixture key")
}
fn ctl() -> CallControl {
    CallControl::timeout(Duration::from_secs(60))
}

#[tokio::test]
#[ignore = "driven by pnpm test:kb -- sealed with a real production handler"]
async fn real_proposal_noop_merge_and_sealed_host_projection() {
    let fixture: Fixture = serde_json::from_str(&std::env::var("KB_R50_FIXTURE").expect("fixture"))
        .expect("fixture shape");
    let resource = McpResource::parse(
        &std::env::var("KB_R50_RESOURCE").expect("fixture resource"),
        TransportPolicy::AllowLoopbackHttp,
    )
    .expect("fixture origin");
    let proposer = client(&resource, "KB_R50_PAT");
    let owner = client(&resource, "KB_R50_OWNER_PAT");
    let locator = KbLocator::parse(
        &format!("{}#kb={}", resource.as_string(), fixture.kb_id),
        TransportPolicy::AllowLoopbackHttp,
    )
    .expect("locator");
    let (attachment, _) = attach(&proposer, &locator, &ctl())
        .await
        .expect("production attachment");
    let reference: SealedReference = fixture.reference.parse().expect("reference");
    let recipient = RecipientKey::from_bytes(fixture.recipient_key_id.clone(), fixture.private_key);
    let path = KbPath::parse("sealed.md").expect("path");
    let literal = resolve_sealed(
        &proposer,
        &attachment,
        &path,
        None,
        &reference,
        &recipient,
        &ctl(),
    )
    .await
    .expect("real recipient envelope");
    assert!(
        literal.expose_secret() == fixture.canary.as_bytes(),
        "recipient plaintext mismatch"
    );
    drop(literal);
    let projected = forward_sealed_resolve(
        &proposer,
        &SealedResolveInput {
            kb_id: fixture.kb_id.clone(),
            rev: None,
            path,
            reference: fixture.reference.clone(),
            recipient_key_id: fixture.recipient_key_id,
        },
        &ctl(),
    )
    .await
    .expect("agent projection");
    assert!(
        !serde_json::to_string(&projected)
            .expect("projection")
            .contains(&fixture.canary)
    );

    let set = DreamChangeSet {
        knowledge_base_id: fixture.kb_id.clone(),
        source_session_ids: vec![
            Uuid::parse("00000000-0000-4000-8000-000000000051").expect("session"),
        ],
        upserts: vec![DreamUpsert {
            id: kb_client::types::ConceptId::parse("production-dream").expect("concept id"),
            kind: "concept".into(),
            title: None,
            body: "Safe production dream".into(),
            citations: vec![],
            provenance: DreamProvenance,
        }],
        model: DreamModel {
            provider: "fixture".into(),
            model: "fixture".into(),
        },
        title: None,
    };
    let proposed = apply_dream(&proposer, &set, key(), &ctl())
        .await
        .expect("real proposal");
    assert!(matches!(proposed, DreamOutcome::Proposed(_)));
    assert!(!proposed.advances_consumer_ledger());
    let observed = proposed
        .result()
        .proposal
        .as_ref()
        .expect("active proposal");
    let pinned = PreparedDream::new_for_proposal(
        &set,
        proposed.result().commit_sha.clone(),
        key(),
        observed.number,
        observed.head_sha.clone(),
    )
    .expect("pin active proposal and its observed head");
    let noop = submit_dream(&proposer, &pinned, &ctl(), 1)
        .await
        .expect("production proposal noop");
    assert!(matches!(noop, DreamOutcome::ProposalNoop(_)));
    assert!(!noop.advances_consumer_ledger());
    assert_eq!(noop.result().base_revision, noop.result().commit_sha);
    let (main, _) = attach(&owner, &locator, &ctl())
        .await
        .expect("main before merge");
    assert_eq!(
        &main.attachment().head_sha,
        &proposed.result().base_revision
    );
    let pr = noop.result().proposal.as_ref().expect("existing proposal");
    let merged = owner
        .call::<PullRequestsReview>(
            &PullRequestsReviewInput {
                kb_id: fixture.kb_id.clone(),
                number: pr.number,
                decision: ReviewDecision::Merge,
                expected_head_sha: pr.head_sha.clone(),
                expected_target_sha: proposed.result().base_revision.clone(),
                idempotency_key: key(),
                confirm: ReviewConfirm::Merge,
            },
            &ctl(),
        )
        .await
        .expect("production merge");
    assert_eq!(merged.pr.status, kb_client::types::PrStatus::Merged);
    let main_noop = apply_dream(&owner, &set, key(), &ctl())
        .await
        .expect("main noop after merge");
    assert!(matches!(main_noop, DreamOutcome::Noop(_)));
    assert!(main_noop.advances_consumer_ledger());
    let mut fault = set;
    fault.title = Some("fault-noop".into());
    assert!(
        matches!(
            apply_dream(&owner, &fault, key(), &ctl()).await,
            Err(DreamError::InvalidOutcome(_))
        ),
        "mutated production noop must fail closed"
    );
}
