//! Closed schemas before effects; exact envelopes and once-only local replay.
use kb_client::{ToolName, mcp::stdio::CallControl};
use kb_local::{Store, dispatch::dispatch};
use serde_json::{Value, json};
#[path = "../support/fixture.rs"]
mod fixture;
#[path = "../support/model_host.rs"]
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
        "---\nprovenance: agent\n---\n# Knowledge base\n\nParity fixture description\n"
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

/// Defence in depth behind `kb mcp --write-mode`: a store held to a write
/// mode refuses every mutation the mode does not allow (each tool's every
/// corpus input), FORBIDDEN with `WRITE_MODE` details, before any effect;
/// what the mode allows is never refused for it.
#[tokio::test]
async fn write_modes_refuse_each_mutation_before_any_effect() {
    use kb_client::{authoring::AuthoringMode, tools::tool_authoring_need};
    const FIXTURES: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../../packages/api/src/lib/kb/protocol/fixtures.json"
    ));
    let fixtures: Value = serde_json::from_str(FIXTURES).expect("shared fixtures");
    for mode in [AuthoringMode::Dream, AuthoringMode::Edit] {
        let f = fixture::Fixture::new(&format!("write-mode-{mode}"));
        let s = Store::open(&f.root.join("store")).expect("fixture");
        let exe = model_host::fake_host(&f.root, std::time::Duration::from_secs(5));
        let made = dispatch(
            &s,
            &s.owner(),
            ToolName::KnowledgeBasesCreate,
            json!({"name":"Modes","slug":"modes","description":"Write mode fixture","idempotencyKey":"create-modes-001"}),
            &CallControl::default(),
            &exe,
        )
        .await;
        let kb = made["structuredContent"]["data"]["kb"]["id"]
            .as_str()
            .expect("created")
            .to_owned();
        s.narrow_authoring(mode);
        assert_eq!(s.authoring(), mode);
        let db = rusqlite::Connection::open(s.paths().state_db()).expect("state");
        let effects = || -> (i64, i64, i64, i64) {
            let count = |table: &str| {
                db.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
                    .expect("count")
            };
            (
                count("operation_intents"),
                count("staged_uploads"),
                count("pull_requests"),
                count("kbs"),
            )
        };
        for name in ToolName::ALL {
            let row = &fixtures["tools"][name.as_str()];
            let inputs = std::iter::once(row["validInput"].clone()).chain(
                row["validInputVariants"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|variant| variant["value"].clone()),
            );
            for mut input in inputs {
                if input.get("kbId").is_some() {
                    input["kbId"] = json!(kb);
                }
                let need = tool_authoring_need(*name, &input);
                let before = effects();
                let r = dispatch(&s, &s.owner(), *name, input, &CallControl::default(), &exe).await;
                let error = &r["structuredContent"]["error"];
                match need {
                    Some(need) if !mode.allows(need) => {
                        assert_eq!(error["code"], "FORBIDDEN", "{} {mode}", name.as_str());
                        assert_eq!(
                            error["details"],
                            json!({"reason":"WRITE_MODE","required":need.as_str()}),
                            "{}",
                            name.as_str()
                        );
                        assert_eq!(
                            error["message"],
                            kb_client::error::write_mode_message(need),
                            "{}",
                            name.as_str()
                        );
                        assert_eq!(effects(), before, "{} has no effect", name.as_str());
                    }
                    _ => assert_ne!(
                        error["details"]["reason"],
                        "WRITE_MODE",
                        "{} {mode}",
                        name.as_str()
                    ),
                }
            }
        }
    }
}
