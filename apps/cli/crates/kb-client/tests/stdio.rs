//! Spec-first MCP framing, admission and cancellation over real duplex pipes.
use kb_client::{
    ToolName,
    stdio::{CallControl, catalog, serve},
};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
async fn send(w: &mut (impl tokio::io::AsyncWrite + Unpin), v: Value) {
    w.write_all(format!("{v}\n").as_bytes())
        .await
        .expect("fixture");
}
async fn read(r: &mut (impl tokio::io::AsyncBufRead + Unpin)) -> Value {
    let mut line = String::new();
    tokio::time::timeout(Duration::from_secs(5), r.read_line(&mut line))
        .await
        .expect("fixture")
        .expect("fixture");
    serde_json::from_str(&line).expect("fixture")
}
fn init() -> Value {
    json!({"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2026-07-28","clientInfo":{"name":"fixture","version":"1"},"capabilities":{}}})
}
#[tokio::test]
async fn valid_notifications_are_silent_and_requests_still_receive_errors() {
    let (client, server) = tokio::io::duplex(1024 * 1024);
    let (sr, sw) = tokio::io::split(server);
    let work = tokio::spawn(serve(sr, sw, |_, _, _| json!({})));
    let (cr, mut cw) = tokio::io::split(client);
    let mut cr = BufReader::new(cr);
    for ready in [false, true] {
        if ready {
            send(&mut cw, init()).await;
            assert_eq!(read(&mut cr).await["id"], 0);
        }
        for notification in [
            json!({"jsonrpc":"2.0","method":"notifications/example","params":{}}),
            json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
            json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
            json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{}}),
            json!({"jsonrpc":"2.0","method":"tools/call","params":{}}),
        ] {
            send(&mut cw, notification).await;
        }
        // A following request is a deterministic barrier: any unsolicited
        // response would be read before this request's response.
        send(&mut cw, json!({"jsonrpc":"2.0","id":1,"method":"ping"})).await;
        let reply = read(&mut cr).await;
        assert_eq!(reply["id"], 1);
        assert!(reply["result"].is_object());
        assert!(reply.get("error").is_none());
    }
    send(
        &mut cw,
        json!({"jsonrpc":"2.0","id":2,"method":"notifications/example"}),
    )
    .await;
    let reply = read(&mut cr).await;
    assert_eq!(reply["id"], 2);
    assert_eq!(reply["error"]["code"], -32601);
    send(
        &mut cw,
        json!({"jsonrpc":"2.0","method":"notifications/example","params":false}),
    )
    .await;
    assert_eq!(read(&mut cr).await["error"]["code"], -32600);
    cw.shutdown().await.expect("fixture");
    work.await.expect("fixture").expect("fixture");
}

#[tokio::test]
async fn handshake_catalog_and_redacted_protocol_errors() {
    let (client, server) = tokio::io::duplex(1024 * 1024);
    let (sr, sw) = tokio::io::split(server);
    let work = tokio::spawn(serve(sr, sw, |_, _, _| json!({})));
    let (cr, mut cw) = tokio::io::split(client);
    let mut cr = BufReader::new(cr);
    send(
        &mut cw,
        json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}),
    )
    .await;
    assert_eq!(read(&mut cr).await["error"]["code"], -32600);
    let mut malformed = init();
    malformed["params"]["clientInfo"] = json!({});
    send(&mut cw, malformed).await;
    assert_eq!(read(&mut cr).await["error"]["code"], -32602);
    send(&mut cw, init()).await;
    assert_eq!(
        read(&mut cr).await["result"]["protocolVersion"],
        "2026-07-28"
    );
    send(
        &mut cw,
        json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
    )
    .await;
    send(
        &mut cw,
        json!({"jsonrpc":"2.0","id":"list","method":"tools/list"}),
    )
    .await;
    let listed = read(&mut cr).await["result"]["tools"].clone();
    assert_eq!(
        listed
            .as_array()
            .expect("tools")
            .iter()
            .map(|t| t["name"].as_str().expect("name"))
            .collect::<Vec<_>>(),
        ToolName::ALL.iter().map(|n| n.as_str()).collect::<Vec<_>>()
    );
    for (t, name) in listed.as_array().expect("tools").iter().zip(ToolName::ALL) {
        assert_eq!(t["annotations"]["readOnlyHint"], name.read_only());
        assert_eq!(
            &t["inputSchema"],
            kb_client::schema::tool_schemas(name.as_str())
                .expect("canonical schema")
                .0
        );
    }
    assert_eq!(listed, catalog().expect("fixture"));
    send(&mut cw,json!({"jsonrpc":"2.0","id":3,"method":"shell/execute","params":{"command":"secret-canary"}})).await;
    let e = read(&mut cr).await;
    assert_eq!(e["error"]["code"], -32601);
    assert!(!e.to_string().contains("secret-canary"));
    cw.write_all(b"not-json\n").await.expect("fixture");
    assert_eq!(read(&mut cr).await["error"]["code"], -32700);
    send(
        &mut cw,
        json!({"jsonrpc":"2.0","id":9007199254740992_u64,"method":"ping"}),
    )
    .await;
    assert_eq!(read(&mut cr).await["error"]["code"], -32600);
    cw.shutdown().await.expect("fixture");
    work.await.expect("fixture").expect("fixture");
}
#[tokio::test]
async fn cancellation_eof_and_concurrency_are_bounded() {
    let (client, server) = tokio::io::duplex(1024 * 1024);
    let (sr, sw) = tokio::io::split(server);
    let active = Arc::new(AtomicUsize::new(0));
    let count = active.clone();
    let work = tokio::spawn(serve(sr, sw, move |_: ToolName, _, c: CallControl| {
        assert!(count.fetch_add(1, Ordering::SeqCst) < 4);
        while !c.is_cancelled() {
            std::thread::sleep(Duration::from_millis(2));
        }
        count.fetch_sub(1, Ordering::SeqCst);
        kb_client::stdio::tool_error(kb_client::ErrorCode::Cancelled, json!({}))
    }));
    let (cr, mut cw) = tokio::io::split(client);
    let mut cr = BufReader::new(cr);
    send(&mut cw, init()).await;
    read(&mut cr).await;
    send(
        &mut cw,
        json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
    )
    .await;
    for id in 1..=4 {
        send(&mut cw,json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":{"name":"knowledge_bases_list","arguments":{}}})).await;
    }
    tokio::time::timeout(Duration::from_secs(5), async {
        while active.load(Ordering::SeqCst) != 4 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("fixture");
    send(&mut cw,json!({"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"knowledge_bases_list"}})).await;
    assert_eq!(read(&mut cr).await["error"]["code"], -32000);
    send(&mut cw,json!({"jsonrpc":"2.0","id":4.0,"method":"tools/call","params":{"name":"knowledge_bases_list"}})).await;
    assert_eq!(read(&mut cr).await["error"]["code"], -32600);
    send(
        &mut cw,
        json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":1}}),
    )
    .await;
    assert_eq!(
        read(&mut cr).await["result"]["structuredContent"]["error"]["code"],
        "CANCELLED"
    );
    cw.shutdown().await.expect("fixture");
    for _ in 0..3 {
        read(&mut cr).await;
    }
    work.await.expect("fixture").expect("fixture");
    assert_eq!(active.load(Ordering::SeqCst), 0);
}
#[tokio::test]
async fn oversized_frame_gets_an_error_and_the_session_continues() {
    // L-20: one oversize line never takes the agent host's connection down.
    let (client, server) = tokio::io::duplex(64 * 1024);
    let (sr, sw) = tokio::io::split(server);
    let work = tokio::spawn(serve(sr, sw, |_, _, _| unreachable!("no call admitted")));
    let (cr, mut cw) = tokio::io::split(client);
    let mut cr = BufReader::new(cr);
    let writer = tokio::spawn(async move {
        // Streamed (never buffered whole by the server), then a newline.
        let chunk = vec![b'x'; 64 * 1024];
        for _ in 0..20 {
            cw.write_all(&chunk).await.expect("fixture");
        }
        cw.write_all(b"\n").await.expect("fixture");
        cw.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"server/discover\"}\n")
            .await
            .expect("fixture");
        cw
    });
    let error = read(&mut cr).await;
    assert_eq!(error["error"]["code"], -32600);
    assert!(error["id"].is_null());
    let discover = read(&mut cr).await;
    assert_eq!(discover["id"], 7);
    assert!(discover["result"].is_object(), "{discover}");
    let mut cw = writer.await.expect("fixture");
    // A partial oversize frame at EOF still ends the session with an error.
    cw.write_all(&vec![b'x'; 1024 * 1024 + 1])
        .await
        .expect("fixture");
    cw.shutdown().await.expect("fixture");
    assert!(
        tokio::time::timeout(Duration::from_secs(5), work)
            .await
            .expect("fixture")
            .expect("fixture")
            .is_err()
    );
}
#[test]
fn cancellation_and_reservation_are_ordered() {
    let before = CallControl::default();
    before.cancel();
    assert!(before.reserve().is_err());
    let after = CallControl::default();
    after.reserve().expect("fixture");
    after.cancel();
    assert!(after.is_cancelled());
    assert!(!after.work_flag().load(Ordering::Acquire));
}

#[tokio::test]
async fn result_cap_and_backpressure_drain_workers() {
    let (client, server) = tokio::io::duplex(1024);
    let (sr, sw) = tokio::io::split(server);
    let work = tokio::spawn(serve(
        sr,
        sw,
        |_, _, _| json!({"content":"x".repeat(8*1024*1024)}),
    ));
    let (cr, mut cw) = tokio::io::split(client);
    let mut cr = BufReader::new(cr);
    send(&mut cw, init()).await;
    read(&mut cr).await;
    send(
        &mut cw,
        json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
    )
    .await;
    send(&mut cw,json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"knowledge_bases_list"}})).await;
    let capped = read(&mut cr).await;
    assert_eq!(
        capped["result"]["structuredContent"]["error"]["code"],
        "QUOTA_EXCEEDED"
    );
    // A reader that stays connected but never consumes output must terminate.
    for id in 2..8 {
        send(
            &mut cw,
            json!({"jsonrpc":"2.0","id":id,"method":"tools/list"}),
        )
        .await;
    }
    assert!(
        tokio::time::timeout(Duration::from_secs(8), work)
            .await
            .expect("fixture")
            .expect("fixture")
            .is_err()
    );
}

#[tokio::test]
async fn cancellation_never_finishes_a_staged_partial_query_response() {
    use tokio::io::AsyncReadExt;
    for eof in [false, true] {
        let (client, server) = tokio::io::duplex(1024);
        let (sr, sw) = tokio::io::split(server);
        let (tx, rx) = std::sync::mpsc::channel();
        let work = tokio::spawn(serve(sr, sw, move |_, _, c| {
            tx.send(c).expect("control");
            json!({"data":"x".repeat(2*1024*1024)})
        }));
        let (cr, mut cw) = tokio::io::split(client);
        let mut cr = BufReader::new(cr);
        send(&mut cw, init()).await;
        read(&mut cr).await;
        send(
            &mut cw,
            json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
        )
        .await;
        send(
        &mut cw,
        json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"knowledge_bases_list"}}),
    )
    .await;
        let mut bytes = vec![0; 64];
        cr.read_exact(&mut bytes).await.expect("partial frame");
        let control = rx.try_recv().expect("started handler");
        if eof {
            cw.shutdown().await.expect("EOF");
        } else {
            send(
        &mut cw,
        json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":1}}),
    )
    .await;
        }
        tokio::time::timeout(Duration::from_secs(5), async {
            while !control.is_cancelled() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("cancel acknowledgement");
        drop(cw);
        tokio::time::timeout(Duration::from_secs(5), cr.read_until(b'\n', &mut bytes))
            .await
            .expect("response drain deadline")
            .expect("closed response");
        assert!(
            serde_json::from_slice::<Value>(&bytes).is_err(),
            "late success must never complete"
        );
        assert!(work.await.expect("server task").is_err());
    }
}

#[tokio::test]
async fn invalid_tool_input_never_enters_domain_io() {
    let (client, server) = tokio::io::duplex(1024 * 1024);
    let (sr, sw) = tokio::io::split(server);
    let calls = Arc::new(AtomicUsize::new(0));
    let count = calls.clone();
    let work = tokio::spawn(serve(sr, sw, move |_, _, _| {
        count.fetch_add(1, Ordering::SeqCst);
        json!({})
    }));
    let (cr, mut cw) = tokio::io::split(client);
    let mut cr = BufReader::new(cr);
    send(&mut cw, init()).await;
    read(&mut cr).await;
    send(
        &mut cw,
        json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
    )
    .await;
    send(&mut cw,json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"knowledge_bases_create","arguments":{"unexpected":true}}})).await;
    assert_eq!(
        read(&mut cr).await["result"]["structuredContent"]["error"]["code"],
        "INVALID_ARGUMENT"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    send(&mut cw,json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"knowledge_bases_list","arguments":{}}})).await;
    read(&mut cr).await;
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    cw.shutdown().await.expect("EOF");
    work.await.expect("server").expect("serve");
}

#[tokio::test]
async fn local_scope_lists_its_subset_and_refuses_before_the_handler() {
    use kb_client::{scope::ToolScope, stdio::Advertised, types::KbId};
    const A: &str = "aaaaaaaaaaaaaaaaaaaaaaaa";
    const B: &str = "bbbbbbbbbbbbbbbbbbbbbbbb";
    let scope = ToolScope::new(&["read"], false, Some(&[KbId::parse(A).expect("id")]));
    let authority = kb_client::scope::LiveAuthority::owner(Some(vec![A.to_owned()]));
    let advertised = Advertised::scoped(scope, &authority).expect("catalog");
    let expected = advertised.tools();
    let (client, server) = tokio::io::duplex(1024 * 1024);
    let (sr, sw) = tokio::io::split(server);
    let calls = Arc::new(AtomicUsize::new(0));
    let count = calls.clone();
    let work = tokio::spawn(kb_client::stdio::serve_until(
        sr,
        sw,
        advertised,
        move |_, _, _| {
            count.fetch_add(1, Ordering::SeqCst);
            json!({})
        },
        std::future::pending(),
    ));
    let (cr, mut cw) = tokio::io::split(client);
    let mut cr = BufReader::new(cr);
    send(&mut cw, init()).await;
    read(&mut cr).await;
    send(
        &mut cw,
        json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
    )
    .await;
    send(
        &mut cw,
        json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}),
    )
    .await;
    let list = read(&mut cr).await;
    assert_eq!(list["result"]["tools"], expected);
    assert_eq!(
        list["result"]["tools"][1]["inputSchema"]["properties"]["kbId"]["enum"],
        json!([A])
    );
    let call = |id: u64, name: &str, arguments: Value| json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":{"name":name,"arguments":arguments}});
    // A grouped tool outside the scope, and a KB outside the selection.
    for (id, name, arguments, code) in [
        (2, "knowledge_index_status", json!({"kbId": A}), "FORBIDDEN"),
        (
            3,
            "knowledge_documents_get",
            json!({"kbId": B, "path": "a.md"}),
            "NOT_FOUND",
        ),
        (4, "knowledge_bases_get", json!({"kbId": B}), "NOT_FOUND"),
    ] {
        send(&mut cw, call(id, name, arguments)).await;
        assert_eq!(
            read(&mut cr).await["result"]["structuredContent"]["error"]["code"],
            code,
            "{name}"
        );
    }
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    // An unlisted supporting tool stays callable on a selected KB.
    send(&mut cw, call(5, "knowledge_bases_get", json!({"kbId": A}))).await;
    read(&mut cr).await;
    send(
        &mut cw,
        call(6, "knowledge_search", json!({"kbId": A, "query": "x"})),
    )
    .await;
    read(&mut cr).await;
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    cw.shutdown().await.expect("EOF");
    work.await.expect("server").expect("serve");
}

/// A fake store: authority and staged upload kinds the test changes live.
struct FakeSource {
    authority: std::sync::Mutex<kb_client::scope::LiveAuthority>,
    reads: AtomicUsize,
}
impl kb_client::scope::LiveSource for FakeSource {
    fn authority(
        &self,
        _: &kb_client::scope::ToolScope,
    ) -> Result<kb_client::scope::LiveAuthority, kb_client::ErrorCode> {
        Ok(self.authority.lock().expect("fixture").clone())
    }
    fn staged_upload_kind(
        &self,
        _: &str,
        upload: &str,
    ) -> Result<Option<String>, kb_client::ErrorCode> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        Ok((upload == "00000000-0000-4000-8000-000000000001").then(|| "asset".to_owned()))
    }
}

#[tokio::test]
async fn live_lists_follow_authority_and_stored_checks_precede_the_handler() {
    use kb_client::{
        scope::{LiveAuthority, ToolScope},
        stdio::Advertised,
        types::KbId,
    };
    const A: &str = "aaaaaaaaaaaaaaaaaaaaaaaa";
    const C: &str = "cccccccccccccccccccccccc";
    let source = Arc::new(FakeSource {
        authority: std::sync::Mutex::new(LiveAuthority::owner(Some(vec![A.to_owned()]))),
        reads: AtomicUsize::new(0),
    });
    let scope = ToolScope::new(
        &["edit"],
        false,
        Some(&[KbId::parse(A).expect("id"), KbId::parse(C).expect("id")]),
    );
    let advertised = Advertised::live(scope, source.clone()).expect("live");
    let (client, server) = tokio::io::duplex(1024 * 1024);
    let (sr, sw) = tokio::io::split(server);
    let calls = Arc::new(AtomicUsize::new(0));
    let count = calls.clone();
    let work = tokio::spawn(kb_client::stdio::serve_until(
        sr,
        sw,
        advertised,
        move |_, _, _| {
            count.fetch_add(1, Ordering::SeqCst);
            json!({})
        },
        std::future::pending(),
    ));
    let (cr, mut cw) = tokio::io::split(client);
    let mut cr = BufReader::new(cr);
    send(&mut cw, init()).await;
    read(&mut cr).await;
    send(
        &mut cw,
        json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
    )
    .await;
    let mut list = async |id: u64| {
        send(
            &mut cw,
            json!({"jsonrpc":"2.0","id":id,"method":"tools/list"}),
        )
        .await;
        let reply = read(&mut cr).await;
        reply["result"]["tools"][2]["inputSchema"]["properties"]["kbId"]["enum"].clone()
    };
    assert_eq!(list(1).await, json!([A]));
    // A KB created or granted since appears; one deleted or revoked leaves.
    *source.authority.lock().expect("fixture") =
        LiveAuthority::owner(Some(vec![A.into(), C.into()]));
    assert_eq!(list(2).await, json!([A, C]));
    *source.authority.lock().expect("fixture") = LiveAuthority::owner(Some(vec![C.into()]));
    assert_eq!(list(3).await, json!([C]));
    let call = |id: u64, name: &str, upload: &str| {
        json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":{"name":name,
            "arguments":{"kbId":A,"uploadId":upload}}})
    };
    // A staged asset upload is refused under `edit` without entering the handler.
    send(
        &mut cw,
        call(
            4,
            "knowledge_upload_finish",
            "00000000-0000-4000-8000-000000000001",
        ),
    )
    .await;
    assert_eq!(
        read(&mut cr).await["result"]["structuredContent"]["error"]["code"],
        "FORBIDDEN"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    // An unknown upload goes on to the handler, which reports NOT_FOUND.
    send(
        &mut cw,
        call(
            5,
            "knowledge_upload_finish",
            "00000000-0000-4000-8000-000000000002",
        ),
    )
    .await;
    read(&mut cr).await;
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(source.reads.load(Ordering::SeqCst), 2);
    cw.shutdown().await.expect("EOF");
    work.await.expect("server").expect("serve");
}
#[tokio::test]
async fn initialize_answers_own_revision_for_other_requested_versions() {
    let (client, server) = tokio::io::duplex(1024 * 1024);
    let (sr, sw) = tokio::io::split(server);
    let work = tokio::spawn(serve(sr, sw, |_, _, _| json!({})));
    let (cr, mut cw) = tokio::io::split(client);
    let mut cr = BufReader::new(cr);
    let mut empty = init();
    empty["params"]["protocolVersion"] = json!("");
    send(&mut cw, empty).await;
    assert_eq!(read(&mut cr).await["error"]["code"], -32602);
    let mut numeric = init();
    numeric["params"]["protocolVersion"] = json!(20250618);
    send(&mut cw, numeric).await;
    assert_eq!(read(&mut cr).await["error"]["code"], -32602);
    let mut older = init();
    older["params"]["protocolVersion"] = json!("2025-06-18");
    send(&mut cw, older).await;
    let answered = read(&mut cr).await;
    assert_eq!(answered["id"], 0);
    assert_eq!(answered["result"]["protocolVersion"], "2026-07-28");
    send(
        &mut cw,
        json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
    )
    .await;
    send(
        &mut cw,
        json!({"jsonrpc":"2.0","id":"list","method":"tools/list"}),
    )
    .await;
    assert!(
        read(&mut cr).await["result"]["tools"]
            .as_array()
            .is_some_and(|t| !t.is_empty())
    );
    cw.shutdown().await.expect("EOF");
    work.await.expect("join").expect("serve");
}
#[test]
fn version_diagnostic_names_both_versions_and_escapes_input() {
    use kb_client::stdio::version_diagnostic;
    assert_eq!(version_diagnostic("2026-07-28"), None);
    let note = version_diagnostic("2025-06-18").expect("mismatch");
    assert!(note.contains("\"2025-06-18\"") && note.contains("2026-07-28"));
    let hostile =
        version_diagnostic(&format!("x\n\u{1b}[31m{}", "y".repeat(500))).expect("mismatch");
    assert!(!hostile.contains('\n') && !hostile.contains('\u{1b}'));
    assert!(hostile.len() < 300);
}
fn envelope(version: Value) -> Value {
    json!({"io.modelcontextprotocol/protocolVersion":version,"io.modelcontextprotocol/clientCapabilities":{}})
}
/// R3-L11: stateless 2026-07-28 requests need no handshake (HTTP parity), and a
/// per-request version claim is validated in and out of a session.
#[tokio::test]
async fn enveloped_requests_need_no_handshake_and_claims_are_validated() {
    let (client, server) = tokio::io::duplex(1024 * 1024);
    let (sr, sw) = tokio::io::split(server);
    let work = tokio::spawn(serve(sr, sw, |_, _, _| json!({"ok":true})));
    let (cr, mut cw) = tokio::io::split(client);
    let mut cr = BufReader::new(cr);
    // No claim and no session: refused with a hint.
    send(
        &mut cw,
        json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}),
    )
    .await;
    let refused = read(&mut cr).await;
    assert_eq!(refused["error"]["code"], -32600);
    assert!(
        refused["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("_meta"))
    );
    // A valid envelope is served without initialize/server/discover.
    let meta = envelope(json!("2026-07-28"));
    send(
        &mut cw,
        json!({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{"_meta":meta}}),
    )
    .await;
    assert!(
        read(&mut cr).await["result"]["tools"]
            .as_array()
            .is_some_and(|t| !t.is_empty())
    );
    send(
        &mut cw,
        json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"_meta":meta,"name":"knowledge_bases_list","arguments":{}}}),
    )
    .await;
    assert_eq!(read(&mut cr).await["result"]["ok"], true);
    // Envelope-only traffic opens no session for claim-less requests.
    send(
        &mut cw,
        json!({"jsonrpc":"2.0","id":4,"method":"tools/list"}),
    )
    .await;
    assert_eq!(read(&mut cr).await["error"]["code"], -32600);
    // Unsupported and malformed claims, before any session.
    let unsupported = |id: i64| json!({"jsonrpc":"2.0","id":id,"method":"tools/list","params":{"_meta":envelope(json!("1999-01-01"))}});
    send(&mut cw, unsupported(5)).await;
    let error = read(&mut cr).await["error"].clone();
    assert_eq!(error["code"], -32022);
    assert_eq!(error["message"], "Unsupported protocol version: 1999-01-01");
    assert_eq!(
        error["data"],
        json!({"supported":["2026-07-28"],"requested":"1999-01-01"})
    );
    send(
        &mut cw,
        json!({"jsonrpc":"2.0","id":6,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}),
    )
    .await;
    let error = read(&mut cr).await["error"].clone();
    assert_eq!(error["code"], -32602);
    assert_eq!(
        error["data"]["envelope"]["key"],
        "io.modelcontextprotocol/clientCapabilities"
    );
    send(
        &mut cw,
        json!({"jsonrpc":"2.0","id":7,"method":"ping","params":{"_meta":envelope(json!(20260728))}}),
    )
    .await;
    assert_eq!(read(&mut cr).await["error"]["code"], -32602);
    // Inside a legacy session a bad per-request claim is still refused.
    send(&mut cw, init()).await;
    assert_eq!(
        read(&mut cr).await["result"]["protocolVersion"],
        "2026-07-28"
    );
    send(
        &mut cw,
        json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
    )
    .await;
    send(&mut cw, unsupported(8)).await;
    assert_eq!(read(&mut cr).await["error"]["code"], -32022);
    send(
        &mut cw,
        json!({"jsonrpc":"2.0","id":9,"method":"tools/list"}),
    )
    .await;
    assert!(read(&mut cr).await["result"]["tools"].is_array());
    // server/discover validates its own claim too.
    send(
        &mut cw,
        json!({"jsonrpc":"2.0","id":10,"method":"server/discover","params":{"_meta":envelope(json!("2025-06-18"))}}),
    )
    .await;
    assert_eq!(read(&mut cr).await["error"]["code"], -32022);
    cw.shutdown().await.expect("EOF");
    work.await.expect("server").expect("serve");
}
/// R3-L11 review: every reserved envelope field and nested capability shape is
/// checked as the pinned SDK checks it, from the shared case table, and the
/// error is the SDK's `-32602` envelope frame, in a session and outside one.
#[tokio::test]
async fn malformed_envelopes_are_refused_like_the_sdk_in_and_out_of_a_session() {
    let table: Value =
        serde_json::from_str(include_str!("fixtures/envelope-cases.json")).expect("table");
    let cases = table["cases"].as_array().expect("cases");
    for case in cases {
        let meta = case["meta"].as_object().expect("meta");
        if kb_client::schema::validate_request_meta(&case["meta"]).is_err() {
            continue;
        }
        let got = kb_client::envelope::first_issue(meta)
            .map(|i| json!({"key": i.key, "problem": i.problem}));
        assert_eq!(
            got.unwrap_or(Value::Null),
            case["issue"],
            "{}",
            case["name"]
        );
    }
    let (client, server) = tokio::io::duplex(1024 * 1024);
    let (sr, sw) = tokio::io::split(server);
    let work = tokio::spawn(serve(sr, sw, |_, _, _| json!({})));
    let (cr, mut cw) = tokio::io::split(client);
    let mut cr = BufReader::new(cr);
    let mut id = 0;
    for session in [false, true] {
        if session {
            send(&mut cw, init()).await;
            read(&mut cr).await;
            send(
                &mut cw,
                json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
            )
            .await;
        }
        for case in cases {
            id += 1;
            send(
                &mut cw,
                json!({"jsonrpc":"2.0","id":id,"method":"tools/list","params":{"_meta":case["meta"]}}),
            )
            .await;
            let reply = read(&mut cr).await;
            if kb_client::schema::validate_request_meta(&case["meta"]).is_err() {
                assert_eq!(reply["error"]["code"], -32600, "{}", case["name"]);
                continue;
            }
            match &case["issue"] {
                Value::Null => assert!(reply["result"]["tools"].is_array(), "{}", case["name"]),
                issue => {
                    assert_eq!(reply["error"]["code"], -32602, "{}", case["name"]);
                    assert_eq!(
                        reply["error"]["data"]["envelope"], *issue,
                        "{}",
                        case["name"]
                    );
                    assert_eq!(
                        reply["error"]["message"],
                        format!(
                            "Invalid _meta envelope for protocol revision 2026-07-28: {}: {}",
                            issue["key"].as_str().expect("key"),
                            issue["problem"].as_str().expect("problem")
                        )
                    );
                }
            }
        }
    }
    cw.shutdown().await.expect("EOF");
    work.await.expect("server").expect("serve");
}

#[tokio::test]
async fn base_metadata_is_checked_without_a_version_in_initialized_and_discovered_sessions() {
    for discover in [false, true] {
        let (client, server) = tokio::io::duplex(1024 * 1024);
        let (sr, sw) = tokio::io::split(server);
        let work = tokio::spawn(serve(sr, sw, |_, _, _| json!({})));
        let (cr, mut cw) = tokio::io::split(client);
        let mut cr = BufReader::new(cr);
        if discover {
            send(
                &mut cw,
                json!({"jsonrpc":"2.0","id":0,"method":"server/discover","params":{}}),
            )
            .await;
        } else {
            send(&mut cw, init()).await;
        }
        assert!(read(&mut cr).await.get("result").is_some());
        if !discover {
            send(
                &mut cw,
                json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
            )
            .await;
        }
        for token in [
            json!(9007199254740992_u64),
            json!(-9007199254740992_i64),
            json!(1.5),
            json!({}),
            json!(null),
            json!(true),
        ] {
            send(&mut cw, json!({"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{"progressToken":token}}})).await;
            assert_eq!(read(&mut cr).await["error"]["code"], -32600, "{token}");
        }
        for meta in [json!(null), json!(1), json!([])] {
            send(
                &mut cw,
                json!({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{"_meta":meta}}),
            )
            .await;
            assert_eq!(read(&mut cr).await["error"]["code"], -32600);
        }
        for token in [
            json!("progress"),
            json!(0),
            json!(9007199254740991_u64),
            json!(-9007199254740991_i64),
        ] {
            send(&mut cw, json!({"jsonrpc":"2.0","id":3,"method":"tools/list","params":{"_meta":{"progressToken":token}}})).await;
            assert!(read(&mut cr).await.get("result").is_some(), "{token}");
        }
        cw.shutdown().await.expect("fixture");
        work.await.expect("fixture").expect("fixture");
    }
}

/// The same SDK-generated corpus runs against the HTTP endpoint. Every base
/// metadata field is checked before protocol admission, with or without a
/// claimed envelope, before discovery and in initialized/discovered sessions.
#[tokio::test]
async fn generated_sdk_request_metadata_is_checked_in_every_session_state() {
    let fixture: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../../packages/api/src/lib/kb/protocol/fixtures.json"
    )))
    .expect("corpus");
    for session in ["none", "initialize", "discover"] {
        let (client, server) = tokio::io::duplex(1024 * 1024);
        let (sr, sw) = tokio::io::split(server);
        let work = tokio::spawn(serve(sr, sw, |_, _, _| json!({})));
        let (cr, mut cw) = tokio::io::split(client);
        let mut cr = BufReader::new(cr);
        if session != "none" {
            let request = if session == "initialize" {
                init()
            } else {
                json!({"jsonrpc":"2.0","id":0,"method":"server/discover","params":{}})
            };
            send(&mut cw, request).await;
            assert!(read(&mut cr).await.get("result").is_some());
            if session == "initialize" {
                send(
                    &mut cw,
                    json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
                )
                .await;
            }
        }
        for claimed in [false, true] {
            for case in fixture["requestMetadata"]
                .as_array()
                .expect("metadata cases")
            {
                let mut meta = case["value"].clone();
                if claimed && let Some(object) = meta.as_object_mut() {
                    object.extend(
                        envelope(json!("2026-07-28"))
                            .as_object()
                            .expect("envelope")
                            .clone(),
                    );
                }
                assert_eq!(
                    kb_client::schema::validate_request_meta(&meta).is_ok(),
                    case["valid"].as_bool().expect("verdict"),
                    "{case}"
                );
                send(
                    &mut cw,
                    json!({"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":meta}}),
                )
                .await;
                let reply = read(&mut cr).await;
                if case["valid"] == false {
                    assert_eq!(reply["error"]["code"], -32600, "{session} {claimed} {case}");
                    assert!(
                        reply["error"]["data"]["field"]
                            .as_str()
                            .expect("field")
                            .starts_with("/params/_meta")
                    );
                } else if claimed || session != "none" {
                    assert!(
                        reply["result"]["tools"].is_array(),
                        "{session} {claimed} {case}: {reply}"
                    );
                } else {
                    assert_eq!(reply["error"]["code"], -32600, "session required");
                }
            }
        }
        cw.shutdown().await.expect("EOF");
        work.await.expect("server").expect("serve");
    }
}

#[tokio::test]
async fn discover_is_supported_after_initialize_without_reinitializing_the_session() {
    let (client, server) = tokio::io::duplex(1024 * 1024);
    let (sr, sw) = tokio::io::split(server);
    let work = tokio::spawn(serve(sr, sw, |_, _, _| json!({})));
    let (cr, mut cw) = tokio::io::split(client);
    let mut cr = BufReader::new(cr);
    send(&mut cw, init()).await;
    assert!(read(&mut cr).await["result"].is_object());
    send(
        &mut cw,
        json!({"jsonrpc":"2.0","id":1,"method":"server/discover"}),
    )
    .await;
    assert!(read(&mut cr).await["result"]["supportedVersions"].is_array());
    send(
        &mut cw,
        json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}),
    )
    .await;
    assert!(read(&mut cr).await["result"]["tools"].is_array());
    send(&mut cw, init()).await;
    assert!(
        read(&mut cr).await["error"].is_object(),
        "discover must not permit a second initialize"
    );
    cw.shutdown().await.expect("EOF");
    work.await.expect("server").expect("serve");
}
