//! A refusal's details are a publication (server dispatch parity): a principal
//! revoked while a tool runs gets the KB's empty `NOT_FOUND`, whatever reason
//! the tool would have reported, for missing and existing paths alike.
use kb_client::{
    ToolName,
    stdio::CallControl,
    types::{KbId, Permission},
};
use kb_local::{PrincipalKind, Store, dispatch::dispatch_observed};
use serde_json::{Value, json};
use std::{sync::Mutex, time::Duration};
#[path = "support/fixture.rs"]
mod fixture;
#[path = "support/model_host.rs"]
mod model_host;

#[tokio::test]
async fn refusals_are_reauthorized_before_their_details_publish() {
    let f = fixture::Fixture::new("refusal-authority");
    let root = f.root.join("store");
    let s = Store::open(&root).expect("store");
    let host = model_host::fake_host(&f.root, Duration::from_secs(5));
    let owner = s.owner();
    let created = dispatch_observed(
        &s,
        &owner,
        ToolName::KnowledgeBasesCreate,
        json!({"name": "Refusals", "slug": "refusals",
               "description": "Refusal authority fixture", "idempotencyKey": "refusal-create-0001"}),
        &CallControl::default(),
        &host,
        &|| {},
    )
    .await;
    let kb_value = &created["structuredContent"]["data"]["kb"];
    let kb = KbId::parse(kb_value["id"].as_str().expect("id")).expect("kb id");
    let head = kb_value["headSha"].as_str().expect("head").to_owned();
    let guard = s.lock_write(&[]).expect("lock");
    let who = s
        .register_principal(
            &guard,
            PrincipalKind::Test,
            &kb,
            &[Permission::Read, Permission::Write],
        )
        .expect("principal");
    drop(guard);
    let other = Store::open(&root).expect("second handle");
    // Each case: (tool, input, the reason a live principal is told).
    let apply = |path: &str, key: &str| {
        json!({"kbId": kb, "baseRevision": head, "idempotencyKey": key, "mode": "edit",
               "title": "t", "changes": [{"op": "create", "path": path,
               "content": {"markdown": "# x\n"}}]})
    };
    let cases: Vec<(ToolName, Value, Value)> = vec![
        (
            ToolName::KnowledgeDocumentsGet,
            json!({"kbId": kb, "path": "missing.md"}),
            json!({"reason": "PATH_NOT_FOUND", "field": "/path"}),
        ),
        (
            ToolName::KnowledgeChangesApply,
            apply("index.md", "refusal-exists-0001"),
            json!({"reason": "PATH_EXISTS", "field": "/changes/0/path"}),
        ),
        (
            ToolName::KnowledgeChangesApply,
            apply(".assets/x.md", "refusal-reserved-01"),
            json!({"reason": "RESERVED_PATH", "field": "/changes/0/path"}),
        ),
    ];
    for (tool, input, live) in cases {
        let mut outs = Vec::new();
        for revoke in [false, true] {
            let fired = Mutex::new(false);
            let hook = || {
                if revoke {
                    let guard = other.lock_write(&[]).expect("lock");
                    other
                        .set_principal_permissions(&guard, &who, &kb, &[])
                        .expect("revoke");
                }
                *fired.lock().expect("flag") = true;
            };
            let out = dispatch_observed(
                &s,
                &who,
                tool,
                input.clone(),
                &CallControl::default(),
                &host,
                &hook,
            )
            .await;
            assert!(*fired.lock().expect("flag"), "{tool:?} refused");
            outs.push(out);
        }
        let (told, hidden) = (outs.remove(0), outs.remove(0));
        // Live authority: the reason is told.
        assert_eq!(
            told["structuredContent"]["error"]["details"], live,
            "{tool:?}"
        );
        // Revoked mid-call: the KB's empty denial, like any unreadable KB.
        assert_eq!(
            hidden["structuredContent"]["error"],
            json!({"code": "NOT_FOUND", "details": {}, "message": "Not found", "retryable": false}),
            "{tool:?}"
        );
        let guard = other.lock_write(&[]).expect("lock");
        other
            .set_principal_permissions(&guard, &who, &kb, &[Permission::Read, Permission::Write])
            .expect("restore");
        drop(guard);
    }
}
