//! ROOT 4: every keyed tool replays its recorded result before it looks at
//! any mutable state (limits, windows, disk, the built-in model, quotas).
use kb_client::{ToolName, stdio::CallControl};
use kb_local::{Store, dispatch::dispatch, limits::LocalLimits};
use serde_json::{Value, json};
use std::time::Duration;
#[path = "support/fixture.rs"]
mod fixture;
#[path = "support/model_host.rs"]
mod model_host;

fn zero_disk(_: &kb_local::StorePaths, _: &std::path::Path) -> Result<u64, kb_local::StoreError> {
    Ok(0)
}

#[tokio::test]
async fn every_keyed_tool_replays_after_its_inputs_state_changes() {
    let f = fixture::Fixture::new("replay-table");
    let s = Store::open(&f.root.join("store")).expect("store");
    let host = model_host::fake_host(&f.root, Duration::from_secs(5));
    let owner = s.owner();
    let mut done: Vec<(ToolName, Value, Value)> = Vec::new();
    macro_rules! call {
        ($name:expr, $input:expr) => {{
            let input: Value = $input;
            let out = dispatch(
                &s,
                &owner,
                $name,
                input.clone(),
                &CallControl::default(),
                &host,
            )
            .await;
            assert_eq!(out["isError"], false, "{:?}: {out}", $name);
            done.push(($name, input, out.clone()));
            out["structuredContent"]["data"].clone()
        }};
    }
    let created = call!(
        ToolName::KnowledgeBasesCreate,
        json!({"name":"Replay","slug":"replay","description":"Replay fixture knowledge base","idempotencyKey":"replay-create-0001"})
    );
    let kb = created["kb"]["id"].clone();
    let other = call!(
        ToolName::KnowledgeBasesCreate,
        json!({"name":"Gone","slug":"gone","description":"Deleted replay fixture","idempotencyKey":"replay-create-0002"})
    );
    let other_id = other["kb"]["id"].clone();
    // Deleted below: its create replay is NOT_FOUND by design, not config.
    done.pop();
    let head = created["kb"]["headSha"].clone();
    let a = call!(
        ToolName::KnowledgeDocumentsCreate,
        json!({"kbId":kb,"baseRevision":head,"path":"a.md","content":{"markdown":"# A"},"idempotencyKey":"replay-doc-create-01"})
    );
    let b = call!(
        ToolName::KnowledgeDocumentsUpdate,
        json!({"kbId":kb,"baseRevision":a["commitSha"],"path":"a.md","content":{"markdown":"# A2"},"idempotencyKey":"replay-doc-update-01"})
    );
    let c = call!(
        ToolName::KnowledgeChangesApply,
        json!({"kbId":kb,"baseRevision":b["commitSha"],"mode":"edit","title":"replay","changes":[{"op":"create","path":"b.md","content":{"markdown":"# B"}}],"sourceSessionIds":[],"idempotencyKey":"replay-changes-0001"})
    );
    let _ = call!(
        ToolName::KnowledgeDocumentsDelete,
        json!({"kbId":kb,"baseRevision":c["commitSha"],"path":"b.md","confirm":"DELETE","idempotencyKey":"replay-doc-delete-01"})
    );
    let _ = call!(
        ToolName::KnowledgeBasesUpdate,
        json!({"kbId":kb,"metadataVersion":created["kb"]["metadataVersion"],"name":"Replayed","idempotencyKey":"replay-update-00001"})
    );
    let _ = call!(
        ToolName::KnowledgeIndexRebuild,
        json!({"kbId":kb,"confirm":"RUN","idempotencyKey":"replay-rebuild-0001"})
    );
    // A built-in to attach (state only; no inference runs here).
    let db = rusqlite::Connection::open(s.paths().state_db()).expect("db");
    db.execute("UPDATE builtin_model SET enabled=1 WHERE id=1", [])
        .expect("enable fixture");
    let _ = call!(
        ToolName::KnowledgeEmbeddingProfileSet,
        json!({"kbId":kb,"providerId":"builtin","confirm":"RUN","idempotencyKey":"replay-profile-0001"})
    );
    let text = b"# uploaded\n";
    let _ = call!(
        ToolName::KnowledgeUploadBegin,
        json!({"kbId":kb,"kind":"markdown","mime":"text/markdown","size":text.len(),"contentHash":kb_client::snapshot::content_hash(text),"idempotencyKey":"replay-upload-0001"})
    );
    let _ = call!(
        ToolName::KnowledgeExportPrepare,
        json!({"kbId":kb,"kind":"whole","idempotencyKey":"replay-export-0001"})
    );
    let _ = call!(
        ToolName::KnowledgeBasesDelete,
        json!({"kbId":other_id,"metadataVersion":other["kb"]["metadataVersion"],"confirm":"DELETE","idempotencyKey":"replay-delete-00001"})
    );

    // Every piece of mutable state an admission check reads, changed.
    db.execute(
        "UPDATE builtin_model SET enabled=0,epoch=epoch+1 WHERE id=1",
        [],
    )
    .expect("disable the built-in");
    s.set_disk_meter_for_tests(zero_disk);
    s.set_limits(LocalLimits::lowered(1, 1).expect("lowered"));
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_millis() as u64;
    let full = serde_json::to_string(&vec![
        now;
        kb_local::limits::LOCAL_MUTATIONS_PER_MINUTE_PER_KB
    ])
    .expect("window");
    db.execute("UPDATE mutation_windows SET times_json=?1", [&full])
        .expect("fill every write window");

    for (name, input, first) in &done {
        let replay = dispatch(
            &s,
            &owner,
            *name,
            input.clone(),
            &CallControl::default(),
            &host,
        )
        .await;
        assert_eq!(replay["isError"], false, "{name:?} replay: {replay}");
        // The operation identity is the replay contract (a KB create replay
        // re-reads the live KB, by design); everything else is byte-equal.
        let data = |v: &Value| v["structuredContent"]["data"].clone();
        if *name == ToolName::KnowledgeBasesCreate {
            assert_eq!(
                data(&replay)["operationId"],
                data(first)["operationId"],
                "{name:?}"
            );
        } else {
            assert_eq!(&replay, first, "{name:?} must replay its recorded result");
        }
    }
}
