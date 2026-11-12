//! Closed schemas before effects; exact envelopes and once-only local replay.
use kb_client::{ToolName, stdio::CallControl};
use kb_local::{Store, dispatch::dispatch};
use serde_json::{Value, json};
#[path = "support/fixture.rs"]
mod fixture;
#[path = "support/model_host.rs"]
mod model_host;
#[tokio::test]
async fn every_row_validates_and_lifecycle_replays() {
    let f = fixture::Fixture::new("dispatch");
    let s = Store::open(&f.root.join("store")).expect("fixture");
    let exe = model_host::fake_host(&f.root, std::time::Duration::from_secs(5));
    for name in ToolName::ALL {
        let r = dispatch(
            &s,
            &s.owner(),
            *name,
            json!({"unexpected":true}),
            &CallControl::default(),
            &exe,
        )
        .await;
        assert_eq!(
            r["structuredContent"]["error"]["code"],
            "INVALID_ARGUMENT",
            "{}",
            name.as_str()
        );
        // A closed reason; the unknown member is named when it is the cause.
        let details = &r["structuredContent"]["error"]["details"];
        match details["reason"].as_str() {
            Some("UNKNOWN_ARGUMENT") => assert_eq!(details["field"], "/unexpected"),
            Some("MISSING_ARGUMENT") => assert!(details["field"].is_string(), "{details}"),
            other => panic!("{}: unexpected reason {other:?}", name.as_str()),
        }
        assert_eq!(
            r["content"][0]["text"],
            r["structuredContent"].to_string(),
            "text envelope mirrors structuredContent"
        );
    }
    let input = json!({"name":"Parity","slug":"parity","description":"Parity fixture description","idempotencyKey":"create-parity-001"});
    let a = dispatch(
        &s,
        &s.owner(),
        ToolName::KnowledgeBasesCreate,
        input.clone(),
        &CallControl::default(),
        &exe,
    )
    .await;
    assert_eq!(a["isError"], false, "{a}");
    let kb = a["structuredContent"]["data"]["kb"]["id"].clone();
    let document = dispatch(
        &s,
        &s.owner(),
        ToolName::KnowledgeDocumentsGet,
        json!({"kbId":kb,"path":"index.md"}),
        &CallControl::default(),
        &exe,
    )
    .await;
    assert_eq!(
        document["structuredContent"]["data"]["markdown"],
        "# Knowledge base\n\nParity fixture description\n"
    );
    let b = dispatch(
        &s,
        &s.owner(),
        ToolName::KnowledgeBasesCreate,
        input,
        &CallControl::default(),
        &exe,
    )
    .await;
    assert_eq!(a, b);
    let list = dispatch(
        &s,
        &s.owner(),
        ToolName::KnowledgeBasesList,
        json!({}),
        &CallControl::default(),
        &exe,
    )
    .await;
    assert_eq!(
        list["structuredContent"]["data"]["items"]
            .as_array()
            .expect("fixture")
            .len(),
        1
    );
    for r in [a, b, list] {
        assert_eq!(
            serde_json::from_str::<Value>(r["content"][0]["text"].as_str().expect("fixture"))
                .expect("fixture"),
            r["structuredContent"]
        );
    }
}
