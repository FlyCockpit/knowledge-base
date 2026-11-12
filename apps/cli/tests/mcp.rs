//! Real CLI stdout framing, EOF and fail-closed durable state.
#[path = "../crates/kb-local/tests/support/child_guard.rs"]
mod child_guard;
use child_guard::ChildGuard;
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Write},
    process::{Command, Stdio},
};
#[test]
fn cli_handshake_call_eof_reopen() {
    let temp = tempfile::tempdir().expect("fixture");
    let root = temp.path().join("store");
    for read_only in [true, false] {
        let mut command = Command::new(assert_cmd::cargo::cargo_bin!("kb"));
        if read_only {
            command.arg("--quiet");
        }
        command.args(["mcp"]);
        if read_only {
            command.arg("--read-only");
        }
        let mut c = ChildGuard::spawn_capture(
            command
                .arg("--root")
                .arg(&root)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped()),
        )
        .expect("fixture");
        let mut w = c.stdin.take().expect("fixture");
        let mut r = BufReader::new(c.stdout.take().expect("fixture"));
        for v in [
            json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2026-07-28","clientInfo":{"name":"test","version":"1"},"capabilities":{}}}),
            json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
            json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"knowledge_bases_list","arguments":{}}}),
        ] {
            writeln!(w, "{v}").expect("fixture");
        }
        if read_only {
            writeln!(w,"{}",json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"knowledge_bases_create","arguments":{"name":"Denied","slug":"denied","description":"Scope boundary","idempotencyKey":"scope-create-key-01"}}})).expect("fixture");
        }
        let replies: Vec<Value> = (0..if read_only { 3 } else { 2 })
            .map(|_| {
                let mut line = String::new();
                r.read_line(&mut line).expect("reply");
                serde_json::from_str(&line).expect("JSON")
            })
            .collect();
        // This running-file removal probe uses Unix unlink semantics.
        // Startup state-loss rejection below covers every platform.
        #[cfg(unix)]
        if !read_only {
            let detached = temp.path().join("detached-state.sqlite");
            std::fs::rename(root.join("state.sqlite"), &detached)
                .expect("simulate state loss in disposable fixture");
            writeln!(w,"{}",json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"knowledge_bases_list","arguments":{}}})).expect("call");
            let mut line = String::new();
            r.read_line(&mut line).expect("reply");
            let failed: Value = serde_json::from_str(&line).expect("JSON");
            assert_eq!(
                failed["result"]["structuredContent"]["error"]["code"],
                "REPAIR_REQUIRED"
            );
            assert!(!root.join("state.sqlite").exists());
            std::fs::rename(detached, root.join("state.sqlite")).expect("restore fixture state");
        }
        drop(w);
        assert!(c.wait().expect("fixture").success());
        assert_eq!(replies.len(), if read_only { 3 } else { 2 });
        if read_only {
            assert_eq!(
                replies.iter().find(|v| v["id"] == 3).expect("fixture")["result"]["structuredContent"]
                    ["error"]["code"],
                "FORBIDDEN"
            );
        }
        assert_eq!(
            replies.iter().find(|v| v["id"] == 2).expect("fixture")["result"]["structuredContent"]
                ["data"]["items"],
            json!([])
        );
        assert!(root.join("state.sqlite").exists());
    }
}
#[test]
fn missing_state_is_never_recreated() {
    let temp = tempfile::tempdir().expect("fixture");
    std::fs::write(temp.path().join("valuable.md"), "keep").expect("fixture");
    let r = Command::new(assert_cmd::cargo::cargo_bin!("kb"))
        .args(["mcp", "--root"])
        .arg(temp.path())
        .output()
        .expect("fixture");
    assert!(!r.status.success());
    assert!(r.stdout.is_empty());
    assert!(!temp.path().join("state.sqlite").exists());
    assert_eq!(
        std::fs::read_to_string(temp.path().join("valuable.md")).expect("fixture"),
        "keep"
    );
}

#[test]
fn blocked_stdout_and_oversized_input_stay_bounded() {
    use std::time::{Duration, Instant};
    for oversized in [false, true] {
        let temp = tempfile::tempdir().expect("fixture");
        let mut c = ChildGuard::spawn_capture(
            Command::new(assert_cmd::cargo::cargo_bin!("kb"))
                .args(["mcp", "--root"])
                .arg(temp.path().join("store"))
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped()),
        )
        .expect("CLI");
        let mut input = c.stdin.take().expect("stdin");
        // Exclude durable-store initialization from the transport deadline.
        writeln!(
            input,
            "{}",
            json!({"jsonrpc":"2.0","id":0,"method":"server/discover"})
        )
        .expect("discover");
        let mut output = BufReader::new(c.stdout.take().expect("stdout"));
        let mut ready = String::new();
        output.read_line(&mut ready).expect("ready");
        if oversized {
            // L-20: the oversize line is answered and the server keeps
            // serving; closing stdin then ends it normally.
            input
                .write_all(&vec![b'x'; 1024 * 1024 + 1])
                .expect("oversized frame");
            input.write_all(b"\n").expect("newline");
            let mut error = String::new();
            output.read_line(&mut error).expect("error reply");
            let error: serde_json::Value = serde_json::from_str(&error).expect("json");
            assert_eq!(error["error"]["code"], -32600);
            writeln!(
                input,
                "{}",
                json!({"jsonrpc":"2.0","id":99,"method":"server/discover"})
            )
            .expect("discover again");
            let mut again = String::new();
            output.read_line(&mut again).expect("still serving");
            assert!(again.contains("\"id\":99"), "{again}");
            drop(input);
        } else {
            for id in 1..12 {
                writeln!(
                    input,
                    "{}",
                    json!({"jsonrpc":"2.0","id":id,"method":"tools/list"})
                )
                .expect("list");
            }
        }
        let until = Instant::now() + Duration::from_secs(10);
        loop {
            #[cfg(target_os = "linux")]
            if let Ok(status) = std::fs::read_to_string(format!("/proc/{}/status", c.id()))
                && let Some(kib) = status
                    .lines()
                    .find(|l| l.starts_with("VmHWM:"))
                    .and_then(|l| l.split_whitespace().nth(1))
                    .and_then(|n| n.parse::<u64>().ok())
            {
                assert!(kib < 128 * 1024, "bounded MCP must stay below 128MiB");
            }
            if c.try_wait().expect("wait").is_some() {
                break;
            }
            if Instant::now() >= until {
                c.kill().expect("kill stalled CLI");
                c.wait().expect("reap");
                panic!("MCP must exit on blocked output or at EOF");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

#[cfg(unix)]
#[test]
fn sigterm_drains_with_stdin_still_open() {
    let temp = tempfile::tempdir().expect("fixture");
    let mut c = ChildGuard::spawn_capture(
        Command::new(assert_cmd::cargo::cargo_bin!("kb"))
            .args(["mcp", "--root"])
            .arg(temp.path().join("store"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped()),
    )
    .expect("CLI");
    let mut input = c.stdin.take().expect("stdin");
    writeln!(input, "{}", json!({"jsonrpc":"2.0","id":1,"method":"ping"})).expect("ping");
    let mut line = String::new();
    BufReader::new(c.stdout.take().expect("stdout"))
        .read_line(&mut line)
        .expect("ready");
    assert!(
        Command::new("kill")
            .args(["-TERM", &c.id().to_string()])
            .status()
            .expect("signal")
            .success()
    );
    let until = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        if let Some(status) = c.try_wait().expect("wait") {
            assert!(status.success());
            break;
        }
        if std::time::Instant::now() >= until {
            c.kill().expect("kill");
            c.wait().expect("reap");
            panic!("signal shutdown must drain");
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

#[path = "../crates/kb-local/tests/support/index_fixture.rs"]
mod index_fixture;

// Real production host with bounded reads and RAII child/thread drain on failure.
struct Peer {
    child: ChildGuard,
    input: Option<std::process::ChildStdin>,
    replies: std::sync::mpsc::Receiver<Value>,
    reader: Option<std::thread::JoinHandle<()>>,
    id: u64,
}
impl Peer {
    fn start(root: &std::path::Path) -> Self {
        Self::start_with(root, &[])
    }
    fn start_with(root: &std::path::Path, scope: &[&str]) -> Self {
        let mut child = ChildGuard::spawn(
            Command::new(assert_cmd::cargo::cargo_bin!("kb"))
                .args(["-v", "mcp", "--root"])
                .arg(root)
                .args(scope)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit()),
        )
        .expect("CLI");
        let input = child.stdin.take();
        let output = child.stdout.take().expect("stdout");
        let (send, replies) = std::sync::mpsc::channel();
        let reader = std::thread::spawn(move || {
            for line in BufReader::new(output).lines() {
                let Ok(line) = line else { break };
                let Ok(value) = serde_json::from_str(&line) else {
                    break;
                };
                if send.send(value).is_err() {
                    break;
                }
            }
        });
        let mut peer = Self {
            child,
            input,
            replies,
            reader: Some(reader),
            id: 0,
        };
        peer.request(
            json!({"method":"server/discover"}),
            std::time::Duration::from_secs(180),
        );
        peer
    }
    fn request(&mut self, mut request: Value, timeout: std::time::Duration) -> Value {
        self.id += 1;
        request["id"] = json!(self.id);
        request["jsonrpc"] = json!("2.0");
        writeln!(self.input.as_mut().expect("stdin"), "{request}").expect("request");
        self.replies.recv_timeout(timeout).unwrap_or_else(|error| {
            panic!(
                "bounded CLI reply for {}: {error}",
                request["params"]["name"]
                    .as_str()
                    .or_else(|| request["method"].as_str())
                    .unwrap_or("unknown request")
            )
        })
    }
    fn call(&mut self, name: &str, arguments: Value) -> Value {
        self.request(
            json!({"method":"tools/call","params":{"name":name,"arguments":arguments}}),
            std::time::Duration::from_secs(30),
        )["result"]["structuredContent"]
            .clone()
    }
    fn close(mut self) {
        self.input.take();
        let until = std::time::Instant::now() + std::time::Duration::from_secs(15);
        loop {
            if let Some(status) = self.child.try_wait().expect("wait") {
                assert!(status.success(), "clean EOF drain");
                return;
            }
            assert!(std::time::Instant::now() < until, "bounded EOF drain");
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }
}
impl Drop for Peer {
    fn drop(&mut self) {
        self.input.take();
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
        self.child.drain().expect("peer tree drainage");
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}
fn eventually(mut predicate: impl FnMut() -> bool) {
    let until = std::time::Instant::now() + std::time::Duration::from_secs(30);
    while !predicate() {
        assert!(
            std::time::Instant::now() < until,
            "production lifecycle did not settle"
        );
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

#[cfg(unix)]
#[test]
fn launched_root_absence_empty_replacement_and_uuid_change_fail_closed() {
    use kb_local::Store;
    let temp = tempfile::tempdir().expect("fixture");
    let root = temp.path().join("store");
    let original = Store::open(&root).expect("first launch");
    let uuid = original.store_uuid().clone();
    drop(original);
    let mut peer = Peer::start(&root);
    assert_eq!(
        peer.call("knowledge_bases_list", json!({}))["data"]["items"],
        json!([])
    );
    // On Linux, start from the point where every index builder (threads
    // `kb-index-<slot>`, `INDEX_BUILDERS` = 2) has opened the store and idles
    // between passes, so each replacement below lands on a running loop.
    #[cfg(target_os = "linux")]
    eventually(|| {
        let builders = std::fs::read_dir(format!("/proc/{}/task", peer.child.id()))
            .expect("owned process threads")
            .filter_map(Result::ok)
            .filter(|t| {
                std::fs::read_to_string(t.path().join("comm"))
                    .unwrap_or_default()
                    .starts_with("kb-index-")
            })
            .map(|t| {
                std::fs::read_to_string(t.path().join("wchan"))
                    .unwrap_or_default()
                    .trim()
                    == "hrtimer_nanosleep"
            })
            .collect::<Vec<_>>();
        builders.len() == 2 && builders.iter().all(|idle| *idle)
    });
    for replacement in ["absent", "empty", "new-store"] {
        let detached = temp.path().join("detached");
        std::fs::rename(&root, &detached).expect("detach owned fixture");
        if replacement == "empty" {
            std::fs::create_dir(&root).expect("empty replacement");
        }
        if replacement == "new-store" {
            drop(Store::open(&root).expect("independent new store"));
        }
        let reply = peer.call("knowledge_bases_list", json!({}));
        assert_eq!(
            reply["error"]["code"], "REPAIR_REQUIRED",
            "replacement={replacement} reply={reply}"
        );
        if replacement == "absent" {
            assert!(!root.exists(), "no root recreation");
        }
        if replacement == "empty" {
            assert_eq!(
                std::fs::read_dir(&root).expect("empty").count(),
                0,
                "no registry/lock recreation"
            );
            std::fs::remove_dir(&root).expect("remove owned empty fixture");
        }
        if replacement == "new-store" {
            std::fs::remove_dir_all(&root).expect("remove owned replacement fixture");
        }
        std::fs::rename(detached, &root).expect("restore original fixture");
        assert_eq!(
            peer.call("knowledge_bases_list", json!({}))["data"]["items"],
            json!([]),
            "original identity re-entry"
        );
    }
    let db = rusqlite::Connection::open(root.join("state.sqlite")).expect("fixture");
    db.execute(
        "UPDATE store_meta SET store_uuid=?1 WHERE id=1",
        ["00000000-0000-4000-8000-000000000000"],
    )
    .expect("identity replacement");
    assert_eq!(
        peer.call("knowledge_bases_list", json!({}))["error"]["code"],
        "REPAIR_REQUIRED"
    );
    db.execute(
        "UPDATE store_meta SET store_uuid=?1 WHERE id=1",
        [uuid.as_str()],
    )
    .expect("restore identity");
    drop(db);
    peer.close();
    assert_eq!(
        Store::open(&root).expect("ordinary reopen").store_uuid(),
        &uuid
    );
}

struct NoKeys;
impl kb_local::credentials::Credentials for NoKeys {
    fn set(&self, _: &str, _: &kb_local::credentials::Secret) -> Result<(), kb_local::StoreError> {
        Err(kb_local::StoreError::IndexUnavailable)
    }
    fn get(&self, _: &str) -> Result<kb_local::credentials::Secret, kb_local::StoreError> {
        Err(kb_local::StoreError::IndexUnavailable)
    }
    fn delete(&self, _: &str) -> Result<(), kb_local::StoreError> {
        Ok(())
    }
}
fn sibling(f: &index_fixture::Fixture, empty: bool) -> kb_client::types::KbId {
    let made = f
        .store
        .create_kb(
            &f.store.owner(),
            kb_local::CreateKbRequest {
                name: "Healthy sibling".into(),
                slug: "healthy-sibling".into(),
                description: "Healthy worker fixture".into(),
                idempotency_key: "healthy-sibling-001".into(),
            },
        )
        .expect("sibling");
    if empty {
        f.store.documents_update(&f.store.owner(), serde_json::from_value(json!({"kbId":made.kb_id,"baseRevision":made.commit_sha,"idempotencyKey":"empty-sibling-001","path":"index.md","content":{"markdown":""}})).expect("input")).expect("empty source skips external IO");
    }
    made.kb_id
}
#[test]
fn production_worker_replaces_revoked_pending_lexically_preserves_contention_and_restart() {
    let f = index_fixture::Fixture::new(2);
    let bad = f.set("revoked-pending-001");
    // Exercise the real revocation producer; only absent OS-key deletion is a fixture seam.
    f.store
        .provider_revoke(&f.store.owner(), &f.provider, &NoKeys)
        .expect("revoke");
    let healthy_kb = sibling(&f, true);
    let db = f.db();
    let provider = kb_client::types::KbId::parse(&"h".repeat(24)).expect("provider");
    db.execute(
        "INSERT INTO providers(id,name) VALUES(?1,'Healthy')",
        [provider.as_str()],
    )
    .expect("fixture");
    db.execute("INSERT INTO provider_revisions(provider_id,revision,endpoint_url,model,dimensions,fingerprint,state) VALUES(?1,1,'https://example.invalid/embeddings','fixture',2,?2,'READY')",(provider.as_str(),format!("sha256:{}","b".repeat(64)))).expect("fixture");
    db.execute("INSERT INTO provider_registrations(operation_id,idempotency_key,request_mac,provider_id,revision) VALUES('00000000-0000-4000-8000-000000000000','healthy-register-001',zeroblob(32),?1,1)",[provider.as_str()]).expect("fixture");
    let healthy = f.store.embedding_profile_set(&f.store.owner(),serde_json::from_value(json!({"kbId":healthy_kb,"providerId":provider,"revision":1,"idempotencyKey":"healthy-profile-001","confirm":"RUN"})).expect("input")).expect("profile");
    let permit = std::fs::File::create(
        f.root
            .join("locks")
            .join(format!("index-build-{healthy_kb}.lock")),
    )
    .expect("permit");
    permit.lock().expect("contention");
    let mut peer = Peer::start(&f.root);
    // L-7: the revocation superseded the pending hybrid generation with a
    // lexical-only one, which the production worker builds and activates.
    let lexical = f
        .status()
        .desired_generation_id
        .expect("lexical generation");
    assert_ne!(lexical, bad.generation_id);
    eventually(|| {
        peer.call("knowledge_index_status", json!({"kbId":f.kb}))["data"]["activeGenerationId"]
            == json!(lexical)
    });
    let status = peer.call("knowledge_index_status", json!({"kbId":f.kb}));
    assert_eq!(status["data"]["freshness"], "current");
    assert_eq!(status["data"]["fingerprint"], json!(null));
    assert_eq!(
        db.query_row(
            "SELECT state FROM index_jobs WHERE generation_id=?1",
            [bad.generation_id.as_str()],
            |r| r.get::<_, String>(0)
        )
        .expect("job"),
        "CANCELLED"
    );
    assert_eq!(
        peer.call("knowledge_index_status", json!({"kbId":healthy_kb}))["data"]["desiredState"],
        "PENDING",
        "permit contention is transient"
    );
    peer.close();
    permit.unlock().expect("release");
    drop(permit);
    let mut peer = Peer::start(&f.root);
    eventually(|| {
        peer.call("knowledge_index_status", json!({"kbId":healthy_kb}))["data"]["activeGenerationId"]
            == json!(healthy.generation_id)
    });
    assert_eq!(
        peer.call("knowledge_index_status", json!({"kbId":f.kb}))["data"]["activeGenerationId"],
        json!(lexical),
        "the lexical generation survives restart"
    );
    peer.close();
}

#[tokio::test]
async fn production_retention_preserves_active_build_completion_and_reader_leases() {
    let f = index_fixture::Fixture::new(2);
    let a = f.set("retain-reader-001");
    f.store
        .activate_built(f.build(&a.generation_id).await)
        .expect("activate");
    let reader = f
        .store
        .lease_active_generation(&f.store.owner(), &f.kb)
        .expect("reader");
    let b = f.rebuild("retain-completion-001");
    let completion = f.build(&b.generation_id).await;
    let c = f.rebuild("retain-active-001");
    f.store
        .activate_built(f.build(&c.generation_id).await)
        .expect("activate");
    f.store.advance_clock_for_tests(3601); // real hourly admission window
    let d = f.rebuild("retain-failed-001");
    let attempt = f
        .store
        .claim_generation(&d.generation_id, std::time::Duration::from_secs(120))
        .expect("claim");
    assert!(
        f.store
            .build_generation(
                attempt,
                async |_, _| Err(kb_local::StoreError::IndexUnavailable),
                // Every vector of this rebuild is reused: fail the rows stage instead.
                &mut |_| Err(kb_local::StoreError::IndexUnavailable)
            )
            .await
            .is_err()
    );
    let building_kb = sibling(&f, false);
    let e = f.store.embedding_profile_set(&f.store.owner(),serde_json::from_value(json!({"kbId":building_kb,"providerId":f.provider,"revision":1,"idempotencyKey":"retain-building-001","confirm":"RUN"})).expect("input")).expect("profile");
    f.settle_companion(&e.generation_id).await;
    let building = f
        .store
        .claim_generation(&e.generation_id, std::time::Duration::from_secs(120))
        .expect("building lease");
    let db = f.db();
    db.execute(
        "UPDATE index_generations SET finished_ms=0 WHERE kb_id IN (?1,?2)",
        (f.kb.as_str(), building_kb.as_str()),
    )
    .expect("aged history");
    // Expired metadata still cannot override an actual OS reader lease.
    db.execute(
        "UPDATE generation_leases SET expires_ms=0 WHERE generation_id=?1",
        [a.generation_id.as_str()],
    )
    .expect("expired reader TTL");
    let path = |id: &kb_client::types::KbId| f.store.paths().index_file(&f.kb, id);
    let mut peer = Peer::start(&f.root);
    eventually(|| !path(&d.generation_id).exists());
    for id in [&a.generation_id, &b.generation_id, &c.generation_id] {
        assert!(path(id).exists(), "protected generation {id}");
    }
    assert_eq!(
        peer.call("knowledge_index_status", json!({"kbId":building_kb}))["data"]["desiredState"],
        "BUILDING"
    );
    assert_eq!(
        reader
            .connection()
            .query_row("SELECT count(*) FROM documents", [], |r| r.get::<_, i64>(0))
            .expect("leased data"),
        1
    );
    drop(reader);
    drop(completion);
    // The periodic pass, without restart, must reclaim newly unleased history.
    // One minute scheduler plus the production call's120s IO budget. Kernel
    // fsync stalls are outside that budget; this is a bounded regression wait,
    // not a new75s reclamation SLA (the earlier host runs exceeded that margin).
    let until = std::time::Instant::now() + std::time::Duration::from_secs(180);
    while path(&a.generation_id).exists() || path(&b.generation_id).exists() {
        assert!(
            std::time::Instant::now() < until,
            "periodic production retention: reader_exists={} completion_exists={} child={:?}",
            path(&a.generation_id).exists(),
            path(&b.generation_id).exists(),
            peer.child.try_wait().expect("child state")
        );
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    assert!(
        path(&c.generation_id).exists(),
        "active generation retained"
    );
    peer.close();
    drop(building);
    let mut peer = Peer::start(&f.root);
    assert_eq!(
        peer.call("knowledge_index_status", json!({"kbId":f.kb}))["data"]["activeGenerationId"],
        json!(c.generation_id)
    );
    peer.close();
    assert!(
        f.root.join("state.sqlite").exists(),
        "durable identity/history retained"
    );
}

#[test]
fn owner_chosen_tools_and_kbs_shape_discovery_and_refuse_calls() {
    use kb_local::{CreateKbRequest, Store};
    let temp = tempfile::tempdir().expect("fixture");
    let root = temp.path().join("store");
    let store = Store::open(&root).expect("store");
    // This fixture tests scope/admission, not index delivery (covered by the
    // production_worker tests above). Occupy its producer slots so background
    // fsyncs cannot race the bounded store lock used by the metadata tools.
    let _index_slots: Vec<_> = (0..kb_local::generations::EXTERNAL_BUILD_SLOTS)
        .map(|slot| {
            let permit = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(root.join("locks").join(format!("index-slot-{slot}.lock")))
                .expect("index slot");
            permit.try_lock().expect("reserve fixture index slot");
            permit
        })
        .collect();
    let owner = store.owner();
    let create = |name: &str, slug: &str, key: &str| {
        store
            .create_kb(
                &owner,
                CreateKbRequest {
                    name: name.into(),
                    slug: slug.into(),
                    description: "Scope fixture".into(),
                    idempotency_key: key.into(),
                },
            )
            .expect("kb")
            .kb_id
    };
    let selected = create("Selected", "selected", "scope-selected-001");
    let other = create("Other", "other", "scope-other-00001");
    // An asset upload staged by an unscoped session of the same owner.
    let png = b"\x89PNG\r\n\x1a\n".to_vec();
    let staged = store
        .upload_begin(
            &owner,
            serde_json::from_value(json!({"kbId":selected,"kind":"asset","mime":"image/png",
                "size":png.len(),"contentHash":kb_client::snapshot::content_hash(&png),
                "idempotencyKey":"scope-asset-upload-1"}))
            .expect("input"),
        )
        .expect("staged asset upload");
    drop(store);
    let mut peer = Peer::start_with(&root, &["--tools", "edit", "--kb", selected.as_str()]);
    let tools = peer.request(
        json!({"method":"tools/list"}),
        std::time::Duration::from_secs(30),
    )["result"]["tools"]
        .clone();
    let names: Vec<&str> = tools
        .as_array()
        .expect("tools")
        .iter()
        .map(|t| t["name"].as_str().expect("name"))
        .collect();
    assert_eq!(
        names,
        [
            "knowledge_bases_list",
            "knowledge_bases_get",
            "knowledge_changes_apply",
            "knowledge_documents_create",
            "knowledge_documents_update",
            "knowledge_documents_delete",
            "knowledge_upload_begin",
            "knowledge_upload_write",
            "knowledge_upload_finish"
        ]
    );
    for tool in tools.as_array().expect("tools").iter().skip(1) {
        assert_eq!(
            tool["inputSchema"]["properties"]["kbId"]["enum"],
            json!([selected]),
            "{}",
            tool["name"]
        );
    }
    let items = peer.call("knowledge_bases_list", json!({}))["data"]["items"].clone();
    assert_eq!(items.as_array().expect("items").len(), 1);
    assert_eq!(items[0]["id"], json!(selected));
    let kb = peer.call("knowledge_bases_get", json!({"kbId":selected}));
    assert_eq!(
        kb["data"]["kb"]["id"],
        json!(selected),
        "supporting tools stay callable: {kb}"
    );
    assert_eq!(kb["data"]["index"]["desiredState"], "PENDING", "{kb}");
    let refused = [
        ("knowledge_bases_get", json!({"kbId":other}), "NOT_FOUND"),
        (
            "knowledge_documents_list",
            json!({"kbId":selected}),
            "FORBIDDEN",
        ),
        (
            "knowledge_bases_create",
            json!({"name":"Denied","slug":"denied","description":"Scope boundary","idempotencyKey":"scope-create-key-01"}),
            "FORBIDDEN",
        ),
        (
            "knowledge_upload_begin",
            json!({"kbId":selected,"kind":"asset","mime":"image/png","size":8,
            "contentHash":format!("sha256:{}", "0".repeat(64)),"idempotencyKey":"scope-asset-upload-2"}),
            "FORBIDDEN",
        ),
        (
            "knowledge_upload_write",
            json!({"kbId":selected,"uploadId":staged.upload_id,"offset":0,"bytesBase64":"iVBORw0KGgo="}),
            "FORBIDDEN",
        ),
        (
            "knowledge_upload_finish",
            json!({"kbId":selected,"uploadId":staged.upload_id}),
            "FORBIDDEN",
        ),
        (
            "knowledge_documents_create",
            json!({"kbId":other,"baseRevision":"0".repeat(40),"path":"a.md",
            "content":{"markdown":"x"},"idempotencyKey":"scope-doc-create-01"}),
            "NOT_FOUND",
        ),
    ];
    let staged_row = || {
        rusqlite::Connection::open(root.join("state.sqlite"))
            .expect("fixture")
            .query_row(
                "SELECT state, \"offset\", pending_size IS NULL, expires_ms FROM staged_uploads WHERE id = ?1",
                [staged.upload_id.as_str()],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, bool>(2)?,
                        r.get::<_, i64>(3)?,
                    ))
                },
            )
            .expect("staged row")
    };
    let before = staged_row();
    for (name, arguments, code) in refused {
        assert_eq!(peer.call(name, arguments)["error"]["code"], code, "{name}");
    }
    // Denied upload kinds change nothing: the staged row is untouched.
    assert_eq!(staged_row(), before);
    assert_eq!(before.0, "WRITING");
    peer.close();
    // `--read-only` intersects with the selected groups.
    let mut peer = Peer::start_with(&root, &["--tools", "direct", "--read-only"]);
    let tools = peer.request(
        json!({"method":"tools/list"}),
        std::time::Duration::from_secs(30),
    )["result"]["tools"]
        .clone();
    let names: Vec<&str> = tools
        .as_array()
        .expect("tools")
        .iter()
        .map(|t| t["name"].as_str().expect("name"))
        .collect();
    assert_eq!(
        names,
        [
            "knowledge_bases_list",
            "knowledge_documents_list",
            "knowledge_documents_get",
            "knowledge_search",
            "knowledge_structured_search",
            "knowledge_assets_list",
            "knowledge_pull_requests_list",
            "knowledge_pull_requests_get"
        ]
    );
    assert!(tools[1]["inputSchema"]["properties"]["kbId"]["enum"].is_null());
    assert_eq!(
        peer.call("knowledge_bases_list", json!({}))["data"]["items"]
            .as_array()
            .expect("items")
            .len(),
        2
    );
    assert_eq!(
        peer.call(
            "knowledge_documents_create",
            json!({"kbId":other,"baseRevision":"0".repeat(40),"path":"a.md",
            "content":{"markdown":"x"},"idempotencyKey":"scope-doc-create-02"})
        )["error"]["code"],
        "FORBIDDEN"
    );
    peer.close();
    // A delete retry returns its receipt after the KB leaves every enum.
    let scope = ["--tools", "kb_admin", "--kb", other.as_str()];
    let mut peer = Peer::start_with(&root, &scope);
    let kb = peer.call("knowledge_bases_get", json!({"kbId":other}));
    let version = kb["data"]["kb"]["metadataVersion"]
        .as_i64()
        .unwrap_or_else(|| panic!("knowledge_bases_get must return metadataVersion: {kb}"));
    let delete = json!({"kbId":other,"metadataVersion":version,"confirm":"DELETE",
        "idempotencyKey":"scope-delete-key-01"});
    let receipt = peer.call("knowledge_bases_delete", delete.clone());
    assert_eq!(receipt["data"]["tombstoned"], true, "{receipt}");
    peer.close();
    let mut peer = Peer::start_with(&root, &scope);
    let tools = peer.request(
        json!({"method":"tools/list"}),
        std::time::Duration::from_secs(30),
    )["result"]["tools"]
        .clone();
    assert!(
        tools
            .as_array()
            .expect("tools")
            .iter()
            .all(|tool| tool["inputSchema"]["properties"]["kbId"]["enum"].is_null())
    );
    assert_eq!(peer.call("knowledge_bases_delete", delete), receipt);
    peer.close();
}

#[test]
fn tool_and_kb_flags_are_validated_and_local_only() {
    let temp = tempfile::tempdir().expect("fixture");
    for args in [vec!["--tools", "admin"], vec!["--kb", "Not-An-Id"]] {
        let r = Command::new(assert_cmd::cargo::cargo_bin!("kb"))
            .args(["mcp", "--root"])
            .arg(temp.path().join("store"))
            .args(&args)
            .output()
            .expect("CLI");
        assert_eq!(r.status.code(), Some(2), "{args:?}");
        assert!(r.stdout.is_empty());
    }
    assert!(
        !temp.path().join("store").exists(),
        "usage errors open nothing"
    );
    let r = Command::new(assert_cmd::cargo::cargo_bin!("kb"))
        .args([
            "mcp",
            "--server",
            "https://kb.example.test",
            "--tools",
            "read",
        ])
        .env("KB_CONFIG_DIR", temp.path())
        .output()
        .expect("CLI");
    assert!(!r.status.success());
    assert!(
        String::from_utf8_lossy(&r.stderr).contains("require a local managed store"),
        "{}",
        String::from_utf8_lossy(&r.stderr)
    );
}

#[test]
fn discovery_is_live_and_follows_principal_ceilings_within_one_session() {
    use kb_client::types::Permission;
    use kb_local::{CreateKbRequest, PrincipalKind, Store};
    let temp = tempfile::tempdir().expect("fixture");
    let root = temp.path().join("store");
    let store = Store::open(&root).expect("store");
    // Keep indexing out of this discovery fixture, including the KB created
    // mid-session; its writes otherwise compete with metadata tool admission.
    let _index_slots: Vec<_> = (0..kb_local::generations::EXTERNAL_BUILD_SLOTS)
        .map(|slot| {
            let permit = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(root.join("locks").join(format!("index-slot-{slot}.lock")))
                .expect("index slot");
            permit.try_lock().expect("reserve fixture index slot");
            permit
        })
        .collect();
    let owner = store.owner();
    let create = |slug: &str, key: &str| {
        store
            .create_kb(
                &owner,
                CreateKbRequest {
                    name: slug.into(),
                    slug: slug.into(),
                    description: "Live discovery fixture".into(),
                    idempotency_key: key.into(),
                },
            )
            .expect("kb")
            .kb_id
    };
    let read_kb = create("read-kb", "live-read-kb-0001");
    let write_kb = create("write-kb", "live-write-kb-001");
    let guard = store.lock_write(&[]).expect("lock");
    let principal = store
        .register_principal(&guard, PrincipalKind::Config, &read_kb, &[Permission::Read])
        .expect("principal");
    drop(guard);
    rusqlite::Connection::open(root.join("state.sqlite"))
        .expect("fixture")
        .execute(
            "INSERT INTO principal_ceilings (principal_id, kind, kb_id, bits) VALUES (?1, 'CONFIG', ?2, 4)",
            (principal.id(), write_kb.as_str()),
        )
        .expect("write ceiling");
    let list = |peer: &mut Peer| -> Vec<(String, Value)> {
        peer.request(
            json!({"method":"tools/list"}),
            std::time::Duration::from_secs(30),
        )["result"]["tools"]
            .as_array()
            .expect("tools")
            .iter()
            .map(|t| {
                (
                    t["name"].as_str().expect("name").to_owned(),
                    t["inputSchema"]["properties"]["kbId"]["enum"].clone(),
                )
            })
            .collect()
    };
    let enum_of = |tools: &[(String, Value)], name: &str| {
        tools
            .iter()
            .find(|(tool, _)| tool == name)
            .map(|(_, e)| e.clone())
    };
    // A capability principal: per-tool enums follow its ceilings; no create,
    // manage or delete tools without those capabilities.
    let mut peer = Peer::start_with(&root, &["--principal", principal.id()]);
    let tools = list(&mut peer);
    let mut readable = [read_kb.as_str(), write_kb.as_str()];
    readable.sort_unstable();
    assert_eq!(
        enum_of(&tools, "knowledge_documents_get"),
        Some(json!(readable))
    );
    assert_eq!(
        enum_of(&tools, "knowledge_documents_create"),
        Some(json!([write_kb]))
    );
    for absent in [
        "knowledge_bases_create",
        "knowledge_bases_update",
        "knowledge_bases_delete",
        "knowledge_index_rebuild",
    ] {
        assert!(enum_of(&tools, absent).is_none(), "{absent}");
    }
    // Revoking the write ceiling mid-session removes the write tools.
    let guard = store.lock_write(&[]).expect("lock");
    store
        .set_principal_permissions(&guard, &principal, &write_kb, &[])
        .expect("revoke");
    drop(guard);
    let tools = list(&mut peer);
    assert!(enum_of(&tools, "knowledge_documents_create").is_none());
    assert_eq!(
        enum_of(&tools, "knowledge_documents_get"),
        Some(json!([read_kb]))
    );
    peer.close();
    // The owner, scoped to one KB: a KB it creates joins the list, a KB it
    // deletes leaves it, all in one session.
    let mut peer = Peer::start_with(&root, &["--kb", read_kb.as_str()]);
    assert_eq!(
        enum_of(&list(&mut peer), "knowledge_documents_get"),
        Some(json!([read_kb]))
    );
    let created = peer.call(
        "knowledge_bases_create",
        json!({"name":"Created","slug":"created","description":"Joins the selection",
            "idempotencyKey":"live-create-key-001"}),
    );
    let created_id = created["data"]["kb"]["id"]
        .as_str()
        .expect("created")
        .to_owned();
    let mut both = [read_kb.as_str().to_owned(), created_id.clone()];
    both.sort();
    assert_eq!(
        enum_of(&list(&mut peer), "knowledge_documents_get"),
        Some(json!(both))
    );
    assert_eq!(
        peer.call("knowledge_bases_list", json!({}))["data"]["items"]
            .as_array()
            .expect("items")
            .len(),
        2
    );
    let kb = peer.call("knowledge_bases_get", json!({"kbId":read_kb}));
    let version = kb["data"]["kb"]["metadataVersion"]
        .as_i64()
        .unwrap_or_else(|| panic!("knowledge_bases_get must return metadataVersion: {kb}"));
    assert_eq!(kb["data"]["index"]["desiredState"], "PENDING", "{kb}");
    let deleted = peer.call(
        "knowledge_bases_delete",
        json!({"kbId":read_kb,"metadataVersion":version,"confirm":"DELETE",
            "idempotencyKey":"live-delete-key-001"}),
    );
    assert_eq!(deleted["data"]["tombstoned"], true, "{deleted}");
    assert_eq!(
        enum_of(&list(&mut peer), "knowledge_documents_get"),
        Some(json!([created_id]))
    );
    peer.close();
}

/// L-23: the documented CLI-only review flow. The owner creates a
/// propose-only principal, an agent session acting as it proposes a change
/// (a pull request, never `main`), and the owner's session merges it.
#[test]
fn cli_principal_proposes_and_the_owner_merges_its_pull_request() {
    let temp = tempfile::tempdir().expect("fixture");
    let root = temp.path().join("store");
    // Durable KB creation is fixture preparation, outside the PR call budget.
    // Starting an owner session here also starts competing index builders.
    let store = kb_local::Store::open(&root).expect("fixture store");
    let created = store.bases_create(
        &store.owner(),
        kb_client::decode_input::<kb_client::types::BasesCreate>(
            json!({"name":"Review","slug":"review","description":"Review flow fixture","idempotencyKey":"review-create-0001"}),
        ).expect("fixture input"),
    ).expect("fixture KB");
    let kb = serde_json::to_value(created.kb).expect("fixture KB JSON");
    let kb_id = kb["id"].as_str().expect("id").to_owned();
    drop(store);
    let created = Command::new(assert_cmd::cargo::cargo_bin!("kb"))
        .args(["principals", "--root"])
        .arg(&root)
        .args(["create", "--kb", &kb_id, "--access", "propose", "--json"])
        .output()
        .expect("principals create");
    assert!(created.status.success(), "{created:?}");
    let principal: Value = serde_json::from_slice(&created.stdout).expect("json");
    let principal_id = principal["principalId"].as_str().expect("id").to_owned();
    let listed = Command::new(assert_cmd::cargo::cargo_bin!("kb"))
        .args(["principals", "--root"])
        .arg(&root)
        .args(["list", "--json"])
        .output()
        .expect("principals list");
    let listed: Value = serde_json::from_slice(&listed.stdout).expect("json");
    assert_eq!(listed[0]["principalId"], principal_id.as_str());
    // The agent session acting as the principal: its write is a proposal.
    let mut agent = Peer::start_with(&root, &["--principal", &principal_id]);
    let proposed = agent.call(
        "knowledge_documents_create",
        json!({"kbId":kb_id,"baseRevision":kb["headSha"],"path":"idea.md","content":{"markdown":"# Idea"},"idempotencyKey":"review-propose-0001"}),
    )["data"]
        .clone();
    assert_eq!(proposed["kind"], "proposed", "{proposed}");
    let pr = proposed["proposal"].clone();
    assert_eq!(pr["status"], "OPEN");
    agent.close();
    // The owner reviews and merges it in a fresh session.
    let mut owner = Peer::start(&root);
    let merged = owner.call(
        "knowledge_pull_requests_review",
        json!({"kbId":kb_id,"number":pr["number"],"decision":"merge","expectedHeadSha":pr["headSha"],"expectedTargetSha":pr["targetSha"],"confirm":"MERGE","idempotencyKey":"review-merge-00001"}),
    );
    assert_eq!(merged["data"]["pr"]["status"], "MERGED", "{merged}");
    let doc = owner.call(
        "knowledge_documents_get",
        json!({"kbId":kb_id,"path":"idea.md"}),
    );
    assert_eq!(doc["data"]["markdown"], "# Idea");
    owner.close();
    // Removing the principal revokes it.
    let removed = Command::new(assert_cmd::cargo::cargo_bin!("kb"))
        .args(["principals", "--root"])
        .arg(&root)
        .args(["remove", &principal_id, "--json"])
        .output()
        .expect("principals remove");
    let removed: Value = serde_json::from_slice(&removed.stdout).expect("json");
    assert_eq!(removed["removed"], true);
    let gone = Command::new(assert_cmd::cargo::cargo_bin!("kb"))
        .args(["mcp", "--root"])
        .arg(&root)
        .args(["--principal", &principal_id])
        .stdin(Stdio::null())
        .output()
        .expect("mcp");
    assert!(
        !gone.status.success(),
        "a removed principal cannot be served"
    );
}

/// R3 review: a Git older than the PR flow needs refuses `kb mcp` at startup
/// (server parity: a startup probe), naming the found and required
/// versions in the complete MCP initialization error. R6: the refusal is one
/// admission decision, so stateless enveloped requests get it too and no
/// catalog (scoped or not) is ever listed.
#[cfg(unix)]
#[test]
fn an_old_git_refuses_startup_with_found_and_required_versions() {
    use std::os::unix::fs::PermissionsExt;
    let temp = tempfile::tempdir().expect("fixture");
    let bin = temp.path().join("bin");
    std::fs::create_dir(&bin).expect("fixture");
    let real = String::from_utf8(
        Command::new("sh")
            .args(["-c", "command -v git"])
            .output()
            .expect("git path")
            .stdout,
    )
    .expect("utf8");
    let shim = bin.join("git");
    std::fs::write(
        &shim,
        format!(
            "#!/bin/sh\ncase \" $* \" in *\" version \"*) echo 'git version 2.44.0'; exit 0;; esac\nexec {} \"$@\"\n",
            real.trim()
        ),
    )
    .expect("fixture");
    std::fs::set_permissions(&shim, std::fs::Permissions::from_mode(0o755)).expect("fixture");
    let path = format!("{}:{}", bin.display(), std::env::var("PATH").expect("PATH"));
    let mut child = ChildGuard::spawn_capture(
        Command::new(assert_cmd::cargo::cargo_bin!("kb"))
            .args(["mcp", "--read-only", "--root"])
            .arg(temp.path().join("store"))
            .env("PATH", path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped()),
    )
    .expect("CLI");
    let mut writer = child.stdin.take().expect("stdin");
    // Every request but `ping` is refused before routing: the handshake, the
    // un-enveloped and the stateless (enveloped) tool requests alike.
    let meta = json!({"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}});
    let requests = [
        json!({"method":"initialize","params":{"protocolVersion":"2026-07-28","clientInfo":{"name":"t","version":"1"},"capabilities":{}}}),
        json!({"method":"server/discover","params":{}}),
        json!({"method":"tools/list","params":{}}),
        json!({"method":"tools/list","params":{"_meta":meta}}),
        json!({"method":"tools/call","params":{"_meta":meta,"name":"knowledge_bases_list","arguments":{}}}),
        json!({"method":"tools/call","params":{"_meta":meta,"name":"knowledge_bases_create","arguments":{"name":"No","slug":"no","description":"Refused","idempotencyKey":"refused-create-0001"}}}),
        json!({"method":"ping","params":{}}),
    ];
    for (id, request) in requests.iter().enumerate() {
        let mut request = request.clone();
        request["jsonrpc"] = json!("2.0");
        request["id"] = json!(id + 1);
        writeln!(writer, "{request}").expect("request");
    }
    drop(writer);
    let output = child.wait_with_output().expect("CLI");
    assert!(!output.status.success());
    let replies: Vec<Value> = String::from_utf8(output.stdout)
        .expect("UTF8")
        .lines()
        .map(|line| serde_json::from_str(line).expect("JSON"))
        .collect();
    assert_eq!(replies.len(), requests.len());
    let (ping, refused) = replies.split_last().expect("replies");
    for (index, reply) in refused.iter().enumerate() {
        assert_eq!(reply["id"], index + 1);
        assert!(reply.get("result").is_none(), "nothing is served: {reply}");
        assert_eq!(reply["error"]["code"], -32603, "{reply}");
        assert_eq!(reply["error"]["data"]["code"], "STORAGE_UNAVAILABLE");
        let message = reply["error"]["message"].as_str().expect("message");
        assert!(
            message.contains("needs git 2.45 or newer") && message.contains("found git 2.44.0"),
            "{message}"
        );
    }
    assert!(
        ping.get("error").is_none() && ping["result"].is_object(),
        "liveness still answers: {ping}"
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("needs git 2.45 or newer") && stderr.contains("found git 2.44.0"),
        "{stderr}"
    );
}

/// R6 review: a stateless (enveloped, no handshake) client sees the scoped
/// session's catalog, so `--read-only` holds without `initialize`.
#[test]
fn enveloped_requests_see_the_scoped_read_only_catalog_without_a_handshake() {
    let temp = tempfile::tempdir().expect("fixture");
    let mut child = ChildGuard::spawn_capture(
        Command::new(assert_cmd::cargo::cargo_bin!("kb"))
            .args(["mcp", "--read-only", "--root"])
            .arg(temp.path().join("store"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped()),
    )
    .expect("CLI");
    let mut writer = child.stdin.take().expect("stdin");
    let meta = json!({"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}});
    writeln!(
        writer,
        "{}",
        json!({"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":meta}})
    )
    .expect("request");
    writeln!(writer,"{}",json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"_meta":meta,"name":"knowledge_bases_create","arguments":{"name":"Denied","slug":"denied","description":"Scope boundary","idempotencyKey":"scope-create-key-02"}}})).expect("request");
    // Stdin stays open until both replies arrive (EOF cancels live work).
    let mut reader = BufReader::new(child.stdout.take().expect("stdout"));
    let replies: Vec<Value> = (0..2)
        .map(|_| {
            let mut line = String::new();
            reader.read_line(&mut line).expect("reply");
            serde_json::from_str(&line).expect("JSON")
        })
        .collect();
    drop(writer);
    assert!(child.wait().expect("CLI").success());
    let reply = |id: u64| replies.iter().find(|r| r["id"] == id).expect("reply");
    let tools = reply(1)["result"]["tools"].as_array().expect("tools");
    assert!(!tools.is_empty());
    for tool in tools {
        let name: kb_client::ToolName = tool["name"]
            .as_str()
            .expect("name")
            .parse()
            .expect("catalog tool");
        assert!(name.read_only(), "{name:?} listed under --read-only");
    }
    assert_eq!(
        reply(2)["result"]["structuredContent"]["error"]["code"],
        "FORBIDDEN"
    );
}
