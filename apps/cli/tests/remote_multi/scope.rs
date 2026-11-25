//! Per-server tool narrowing and write modes.

use super::*;

#[test]
fn tools_narrowing_checks_each_operations_group_on_every_server() {
    let (a, b, dir) = pair(Fake::full(&[KB_A]), Fake::full(&[KB_B]));
    let mut peer = start(dir.path(), &a, &b, &["--tools", "edit"]);
    // An asset change inside `knowledge_changes_apply` needs `assets`.
    let mut apply = with(valid("knowledge_changes_apply"), "b");
    apply["kbId"] = json!(KB_B);
    apply["changes"] = json!([{"op":"assetRemove","path":"assets/x.png"}]);
    let refused = peer.call("knowledge_changes_apply", apply);
    assert_eq!(refused["structuredContent"]["error"]["code"], "FORBIDDEN");
    assert_eq!(refused["_meta"]["kb/server"], "b");
    // So does an asset upload.
    let mut upload = with(valid("knowledge_upload_begin"), "a");
    upload["kbId"] = json!(KB_A);
    upload["kind"] = json!("asset");
    upload["mime"] = json!("image/png");
    let refused = peer.call("knowledge_upload_begin", upload);
    assert_eq!(refused["structuredContent"]["error"]["code"], "FORBIDDEN");
    assert!(calls(&a).is_empty() && calls(&b).is_empty());
    // A Markdown change is the edit group's own.
    let mut apply = with(valid("knowledge_changes_apply"), "a");
    apply["kbId"] = json!(KB_A);
    peer.ok("knowledge_changes_apply", apply);
    assert_eq!(calls(&a).len(), 1);
    peer.close();
}

#[test]
fn a_narrowed_session_only_writes_uploads_it_began_with_an_allowed_kind() {
    let (a, b, dir) = pair(Fake::full(&[KB_A]), Fake::full(&[KB_B]));
    let foreign_upload = "00000000-0000-4000-8000-0000000000ff";
    let upload = |name: &str, server: &str, kb: &str, id: &str| {
        let mut input = with(valid(name), server);
        input["kbId"] = json!(kb);
        input["uploadId"] = json!(id);
        input
    };
    let mut peer = start(dir.path(), &a, &b, &["--tools", "edit"]);
    // An upload begun elsewhere (maybe an asset): its kind is unknown here.
    for name in ["knowledge_upload_write", "knowledge_upload_finish"] {
        let refused = peer.call(name, upload(name, "a", KB_A, foreign_upload));
        assert_eq!(
            refused["structuredContent"]["error"]["code"], "FORBIDDEN",
            "{name}"
        );
    }
    assert!(calls(&a).is_empty());
    // A Markdown upload this session began (edit's own kind) goes through.
    let mut begin = with(valid("knowledge_upload_begin"), "a");
    begin["kbId"] = json!(KB_A);
    let id = peer.ok("knowledge_upload_begin", begin)["uploadId"]
        .as_str()
        .unwrap()
        .to_owned();
    peer.ok(
        "knowledge_upload_write",
        upload("knowledge_upload_write", "a", KB_A, &id),
    );
    peer.ok(
        "knowledge_upload_finish",
        upload("knowledge_upload_finish", "a", KB_A, &id),
    );
    // Known per server: the same ID on B was not begun there.
    let refused = peer.call(
        "knowledge_upload_write",
        upload("knowledge_upload_write", "b", KB_B, &id),
    );
    assert_eq!(refused["structuredContent"]["error"]["code"], "FORBIDDEN");
    assert!(calls(&b).is_empty());
    peer.close();
    // One server under `--tools` follows the same rule.
    let mut peer = Peer::start(
        dir.path(),
        &[
            "mcp",
            "--server",
            &a.origin,
            "--allow-loopback-http",
            "--tools",
            "edit",
        ],
    );
    let before = calls(&a).len();
    let mut write = valid("knowledge_upload_write");
    write["uploadId"] = json!(foreign_upload);
    let refused = peer.call("knowledge_upload_write", write);
    assert_eq!(refused["structuredContent"]["error"]["code"], "FORBIDDEN");
    assert_eq!(calls(&a).len(), before);
    peer.close();
}

fn dream_input() -> Value {
    fixture()["tools"]["knowledge_changes_apply"]["validInputVariants"]
        .as_array()
        .unwrap()
        .iter()
        .map(|variant| variant["value"].clone())
        .find(|value| value["mode"] == "dream")
        .map(|mut value| {
            // A small dream: the fixture's body is at the size limit.
            value["dream"]["upserts"][0]["body"] = json!("Dreamed.");
            value
        })
        .unwrap()
}

fn write_mode_refusal(reply: &Value, required: &str) {
    let error = &reply["structuredContent"]["error"];
    assert_eq!(error["code"], "FORBIDDEN", "{reply}");
    assert_eq!(
        error["details"],
        json!({"reason":"WRITE_MODE","required":required})
    );
    kb_client::ToolError::from_value(error).expect("a valid kb/1 refusal");
}

/// Each server's write mode is its login's approved mode ∩ `--write-mode`
/// ∩ its configured `write_mode`: a dream-only server lists no edit tool,
/// refuses edits and merges locally with the server's details, and still
/// forwards dreams; a mode that leaves nothing is a startup error naming the
/// server.
#[test]
fn write_modes_intersect_per_server_and_refuse_with_details() {
    use kb_client::authoring::AuthoringMode;
    let (a, b) = (Fake::full(&[KB_A]).serve(), Fake::full(&[KB_B]).serve());
    let dir = support::canonical_tempdir();
    let resource =
        |origin: &str| McpResource::parse(origin, TransportPolicy::AllowLoopbackHttp).unwrap();
    CredentialStore::new(dir.path().join("data/credentials"))
        .save_with_mode(
            &resource(&a.origin),
            &SecretToken::new(token("a")),
            Some(AuthoringMode::Dream),
        )
        .unwrap();
    save(dir.path(), &b.origin, "b");
    let mut peer = start(dir.path(), &a, &b, &[]);
    let tools = peer.tools();
    assert_eq!(
        row(&tools, "knowledge_documents_create")["inputSchema"]["properties"]["server"]["enum"],
        json!(["b"])
    );
    assert_eq!(
        row(&tools, "knowledge_changes_apply")["inputSchema"]["properties"]["server"]["enum"],
        json!(["a", "b"])
    );
    // The union keeps the canonical text.
    assert!(
        row(&tools, "knowledge_changes_apply")["description"]
            .as_str()
            .unwrap()
            .starts_with(kb_client::schema::tool_description("knowledge_changes_apply").unwrap())
    );
    let mut edit = with(valid("knowledge_changes_apply"), "a");
    edit["kbId"] = json!(KB_A);
    let refused = peer.call("knowledge_changes_apply", edit.clone());
    write_mode_refusal(&refused, "edit");
    assert_eq!(refused["_meta"]["kb/server"], "a");
    let mut merge = with(valid("knowledge_pull_requests_review"), "a");
    merge["kbId"] = json!(KB_A);
    merge["decision"] = json!("merge");
    merge["confirm"] = json!("MERGE");
    write_mode_refusal(&peer.call("knowledge_pull_requests_review", merge), "edit");
    // A tool the mode hides on `a` (still listed for `b`) is the same
    // refusal on `a`, not an unknown tool.
    let mut create = with(valid("knowledge_documents_create"), "a");
    create["kbId"] = json!(KB_A);
    let refused = peer.call("knowledge_documents_create", create);
    write_mode_refusal(&refused, "edit");
    assert_eq!(refused["_meta"]["kb/server"], "a");
    assert!(
        calls(&a).is_empty(),
        "nothing reached the dream-only server"
    );
    let mut dream = with(dream_input(), "a");
    dream["kbId"] = json!(KB_A);
    peer.ok("knowledge_changes_apply", dream);
    // The other server is not narrowed.
    let mut edit_b = with(valid("knowledge_changes_apply"), "b");
    edit_b["kbId"] = json!(KB_B);
    peer.ok("knowledge_changes_apply", edit_b);
    peer.close();
    assert_eq!(calls(&a).len(), 1);

    // `--write-mode edit` against a dream-only login leaves nothing.
    let (an, bn) = (format!("a={}", a.origin), format!("b={}", b.origin));
    let failed = cli(dir.path())
        .args([
            "mcp",
            "--server",
            &an,
            "--server",
            &bn,
            "--allow-loopback-http",
        ])
        .args(["--write-mode", "edit"])
        .assert()
        .failure()
        .get_output()
        .clone();
    let stderr = String::from_utf8_lossy(&failed.stderr);
    assert!(
        stderr.contains("server `a`") && stderr.contains("`dream`"),
        "{stderr}"
    );

    // One server: `--write-mode dream` hides edits, describes dreams, refuses.
    let mut one = Peer::start(
        dir.path(),
        &[
            "mcp",
            "--server",
            &bn,
            "--allow-loopback-http",
            "--write-mode",
            "dream",
        ],
    );
    let names: Vec<String> = one
        .tools()
        .iter()
        .map(|t| t["name"].as_str().unwrap().to_owned())
        .collect();
    assert!(names.contains(&"knowledge_changes_apply".to_owned()));
    assert!(!names.contains(&"knowledge_documents_create".to_owned()));
    let seen = calls(&b).len();
    let mut edit = valid("knowledge_changes_apply");
    edit["kbId"] = json!(KB_B);
    let reply = one.request(
        "tools/call",
        json!({"name":"knowledge_changes_apply","arguments":edit}),
    );
    write_mode_refusal(&reply["result"], "edit");
    assert_eq!(calls(&b).len(), seen);
    one.close();
    // Hidden on every server: the union does not list it, yet a call naming a
    // server that hides it is refused with the mode's details.
    let mut both_dream = start(dir.path(), &a, &b, &["--write-mode", "dream"]);
    assert!(
        !both_dream
            .tools()
            .iter()
            .any(|t| t["name"] == "knowledge_documents_create")
    );
    let seen = calls(&b).len();
    let mut create = with(valid("knowledge_documents_create"), "b");
    create["kbId"] = json!(KB_B);
    let refused = both_dream.call("knowledge_documents_create", create);
    write_mode_refusal(&refused, "edit");
    assert_eq!(refused["_meta"]["kb/server"], "b");
    assert_eq!(calls(&b).len(), seen);
    both_dream.close();

    // A configured `write_mode` joins the intersection.
    cli(dir.path())
        .args([
            "config",
            "add-server",
            "b",
            &b.origin,
            "--allow-loopback-http",
        ])
        .args(["--write-mode", "edit"])
        .assert()
        .success();
    let failed = cli(dir.path())
        .args(["mcp", "--server", "b", "--write-mode", "dream"])
        .assert()
        .failure()
        .get_output()
        .clone();
    let stderr = String::from_utf8_lossy(&failed.stderr);
    assert!(stderr.contains("server `b`"), "{stderr}");
    let mut edits = Peer::start(dir.path(), &["mcp", "--server", "b"]);
    let mut dream = dream_input();
    dream["kbId"] = json!(KB_B);
    let reply = edits.request(
        "tools/call",
        json!({"name":"knowledge_changes_apply","arguments":dream}),
    );
    write_mode_refusal(&reply["result"], "dream");
    edits.close();
}
