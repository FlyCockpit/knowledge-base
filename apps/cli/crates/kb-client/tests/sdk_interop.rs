//! End-to-end interop against the official TypeScript MCP SDK server
//! (`@modelcontextprotocol/server` 2.0.0, profile 2026-07-28).
//!
//! These tests need the SDK fixture from
//! `packages/test-utils/src/kb/client-interop.ts`; they are driven by
//! `pnpm test:kb -- client-interop`, which starts the fixture, runs this file
//! with `--ignored`, and then asserts the headers the SDK server observed.
//! Running them without `KB_INTEROP_RESOURCE` fails loudly instead of passing.

use std::time::{Duration, Instant};

use kb_client::dream::{DreamChangeSet, DreamOutcome, apply_dream};
use kb_client::types::{
    BasesGet, BasesList, DocCitation, DocumentsCreate, DocumentsGet, DreamModel, DreamProvenance,
    DreamUpsert, IdempotencyKey, IndexStatusGet, KbId, Uuid,
};
use kb_client::{
    CallControl, CancellationToken, ClientError, ClientOptions, Credential, Deadline, ErrorCode,
    KbError, McpClient, McpResource, SecretToken, Tool, ToolName, TransportPolicy,
};
use serde_json::Value;

fn env(name: &str) -> String {
    std::env::var(name)
        .unwrap_or_else(|_| panic!("{name} is unset; run `pnpm test:kb -- client-interop`"))
}

fn client_with(token: String) -> McpClient {
    let resource = McpResource::parse(
        &env("KB_INTEROP_RESOURCE"),
        TransportPolicy::AllowLoopbackHttp,
    )
    .expect("test fixture");
    let credential = Credential::new(resource.clone(), SecretToken::new(token));
    McpClient::new(resource, credential, ClientOptions::default()).expect("test fixture")
}

fn client() -> McpClient {
    client_with(env("KB_INTEROP_TOKEN"))
}

fn fixture<T: Tool>(side: &str) -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../../packages/api/src/lib/kb/protocol/fixtures.json"
    );
    let all: Value = serde_json::from_str(&std::fs::read_to_string(path).expect("test fixture"))
        .expect("test fixture");
    all["tools"][T::NAME.as_str()][side].clone()
}

fn input<T: Tool>() -> T::Input {
    serde_json::from_value(fixture::<T>("validInput")).expect("test fixture")
}

fn ctl() -> CallControl {
    CallControl::timeout(Duration::from_secs(10))
}

#[tokio::test]
#[ignore = "driven by `pnpm test:kb -- client-interop`"]
async fn interop_discover_and_list() {
    let client = client();
    let discovery = client.discover(&ctl()).await.expect("test fixture");
    assert_eq!(discovery.server_name, "kb-client-interop");
    let tools = client.list_tools(&ctl()).await.expect("test fixture");
    for name in [
        ToolName::KnowledgeBasesList,
        ToolName::KnowledgeBasesGet,
        ToolName::KnowledgeDocumentsGet,
        ToolName::KnowledgeDocumentsCreate,
        ToolName::KnowledgeIndexStatus,
    ] {
        assert!(tools.contains(&name), "{name} missing from {tools:?}");
    }
}

#[tokio::test]
#[ignore = "driven by `pnpm test:kb -- client-interop`"]
async fn interop_read() {
    let client = client();
    let page = client
        .call::<BasesList>(&input::<BasesList>(), &ctl())
        .await
        .expect("test fixture");
    assert_eq!(
        serde_json::to_value(page).expect("test fixture"),
        fixture::<BasesList>("validOutput")
    );
    let doc = client
        .call::<DocumentsGet>(&input::<DocumentsGet>(), &ctl())
        .await
        .expect("test fixture");
    assert_eq!(
        serde_json::to_value(doc).expect("test fixture"),
        fixture::<DocumentsGet>("validOutput")
    );
}

#[tokio::test]
#[ignore = "driven by `pnpm test:kb -- client-interop`"]
async fn interop_mutation_retry_keeps_the_key() {
    // The fixture fails the first create with STORAGE_UNAVAILABLE and records
    // every idempotency key it sees; the runner asserts they are identical.
    let client = client();
    let out = client
        .call_with_retry::<DocumentsCreate>(&input::<DocumentsCreate>(), &ctl(), 3)
        .await
        .expect("test fixture");
    assert_eq!(
        serde_json::to_value(out).expect("test fixture"),
        fixture::<DocumentsCreate>("validOutput")
    );
}

#[tokio::test]
#[ignore = "driven by `pnpm test:kb -- client-interop`"]
async fn interop_domain_and_auth_errors() {
    let e = client()
        .call::<BasesGet>(&input::<BasesGet>(), &ctl())
        .await
        .unwrap_err();
    assert!(
        matches!(e, ClientError::Kb(KbError::Tool(ref t)) if t.code() == ErrorCode::NotFound),
        "{e:?}"
    );
    let e = client_with("kb_pat_wrong_interop_token".into())
        .call::<BasesList>(&input::<BasesList>(), &ctl())
        .await
        .unwrap_err();
    assert_eq!(e, ClientError::Unauthorized);
}

#[tokio::test]
#[ignore = "driven by `pnpm test:kb -- client-interop`"]
async fn interop_cancel() {
    // The fixture holds knowledge_index_status until the request aborts and
    // records the abort; the runner asserts it observed exactly one.
    let client = client();
    let cancel = CancellationToken::new();
    let control = CallControl::new(Deadline::after(Duration::from_secs(10)), cancel.clone());
    let trigger = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(300)).await;
        cancel.cancel();
    });
    let start = Instant::now();
    let e = client
        .call::<IndexStatusGet>(&input::<IndexStatusGet>(), &control)
        .await
        .unwrap_err();
    trigger.await.expect("test fixture");
    assert_eq!(e, ClientError::Kb(KbError::Cancelled));
    assert!(start.elapsed() < Duration::from_secs(5));
    // Give the server a moment to observe the hang-up before the runner reads it.
    tokio::time::sleep(Duration::from_millis(300)).await;
}

#[tokio::test]
#[ignore = "driven by `pnpm test:kb -- client-interop`"]
async fn interop_dream_is_one_atomic_call() {
    // Eight upserts -> one bases_get (base pin) + exactly one
    // knowledge_changes_apply; the runner asserts the SDK saw one apply.
    let set = DreamChangeSet {
        knowledge_base_id: KbId::parse("dreamkbdreamkbdreamkbdre").expect("test fixture"),
        source_session_ids: vec![
            Uuid::parse("00000000-0000-4000-8000-000000000011").expect("test fixture"),
            Uuid::parse("00000000-0000-4000-8000-000000000012").expect("test fixture"),
        ],
        upserts: (0..8)
            .map(|i| DreamUpsert {
                id: format!("interop-{i}").parse().expect("test fixture"),
                kind: "concept".into(),
                title: Some(format!("Interop {i}")),
                body: format!("Interop dream body {i}.\n"),
                citations: vec![DocCitation {
                    label: "episode".into(),
                    target: format!("cockpit://episode/{i}"),
                }],
                provenance: DreamProvenance,
            })
            .collect(),
        model: DreamModel {
            provider: "interop-provider".into(),
            model: "interop-model".into(),
        },
        title: None,
    };
    let key = IdempotencyKey::parse("interop-dream-key-0001").expect("test fixture");
    let outcome = apply_dream(&client(), &set, key, &ctl())
        .await
        .expect("test fixture");
    let DreamOutcome::Applied(result) = &outcome else {
        panic!("expected applied, got {outcome:?}");
    };
    assert_eq!(result.changed_paths.len(), 8);
    assert!(outcome.advances_consumer_ledger());
}
