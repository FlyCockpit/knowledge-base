//! Task 58 executable contract fixture.
//! Real OS processes, fake inference only: the shared embedding worker
//! lifecycle, socket and cache are the actual production code.
use kb_client::ErrorCode;
use kb_local::{
    Store,
    qwen::{ModelHost, ModelRuntime, Purpose, descriptor, options},
};
use std::{
    process::{Command, Stdio},
    time::Duration,
};
mod support {
    pub mod fixture;
    pub mod model_admission;
    pub mod model_host;
}
use support::{fixture::Fixture, model_host};

const IDLE: Duration = Duration::from_secs(5);

fn setup(tag: &str) -> (Fixture, Store, ModelHost) {
    let f = Fixture::new(tag);
    let s = Store::open(&f.root.join("store")).expect("task 58 fixture");
    let host = model_host::seeded(&f.root, IDLE);
    (f, s, host)
}
fn runtime(s: &Store, host: &ModelHost) -> ModelRuntime {
    ModelRuntime::new(s, host.clone()).expect("fixture runtime")
}
fn configure(s: &Store, host: &ModelHost) {
    // Fake worker substitutes native load, never lifecycle, epoch or authority.
    runtime(s, host)
        .configure(
            s,
            &s.owner(),
            kb_local::qwen::ModelConfiguration {
                model_id: "embeddinggemma-2-q8_0",
                context_tokens: 1024,
                acknowledge_memory_warning: false,
                available_bytes: Some(8 << 30),
                timeout: Duration::from_secs(900),
            },
        )
        .expect("task 58 fixture");
}
fn config(id: &str, context: u32, budget: u64) -> kb_local::qwen::ModelConfiguration<'_> {
    kb_local::qwen::ModelConfiguration {
        model_id: id,
        context_tokens: context,
        acknowledge_memory_warning: true,
        available_bytes: Some(budget),
        timeout: Duration::from_secs(10),
    }
}
#[cfg(target_os = "linux")]
fn pid_alive(pid: u32) -> bool {
    std::path::Path::new(&format!("/proc/{pid}")).exists()
}
fn wait_until(what: &str, mut done: impl FnMut() -> bool) {
    let end = std::time::Instant::now() + Duration::from_secs(20);
    while !done() {
        assert!(std::time::Instant::now() < end, "timed out waiting: {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn descriptors_tiers_memory_and_default_optional() {
    let (_f, s, _host) = setup("model-default");
    assert!(!s.model_state().expect("task 58 fixture").enabled);
    assert_eq!(
        s.model_state().expect("task 58 fixture").model_id,
        kb_local::qwen::default_model()
    );
    assert_eq!(
        s.model_state().expect("task 58 fixture").context_tokens,
        1024
    );
    let g = descriptor("embeddinggemma-2-q8_0").expect("task 58 fixture");
    assert_eq!(g.dimensions, 768);
    assert_eq!(g.query_prefix, "task: search result | query: ");
    assert!(g.add_bos && g.add_eos && !g.causal);
    let rows = options(Some(8 << 30)).expect("task 58 fixture");
    assert_eq!(rows.len(), 8);
    assert_eq!(rows.iter().filter(|r| r.recommended).count(), 1);
    assert_eq!(
        rows.iter()
            .find(|r| r.recommended)
            .expect("recommendation")
            .context_tokens,
        1024
    );
    assert!(
        rows.iter()
            .find(|r| r.recommended)
            .expect("task 58 fixture")
            .model_id
            .starts_with("embeddinggemma")
    );
    assert!(
        options(None)
            .expect("task 58 fixture")
            .iter()
            .all(|r| !r.recommended && r.level == "unknown")
    );
    for id in ["embeddinggemma-2-q8_0", "qwen3-embedding-0.6b-q8_0"] {
        for n in [1024, 2048, 4096, 8192] {
            let m = descriptor(id).expect("task 58 fixture");
            let bytes = m.estimate_bytes(n).expect("task 58 fixture");
            assert!(bytes > 1 << 30);
            assert_eq!(
                options(Some(bytes))
                    .expect("task 58 fixture")
                    .iter()
                    .find(|r| r.model_id == id && r.context_tokens == n)
                    .expect("task 58 fixture")
                    .level,
                "block"
            );
        }
    }
    assert!(g.estimate_bytes(16384).is_err());
}
#[test]
fn rust_consumes_ts_descriptor_source_and_server_native_source() {
    let data: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../../packages/api/src/lib/kb/fixtures/builtin-models.json"
    ))
    .expect("task 58 fixture");
    for model in data["models"].as_array().expect("task 58 fixture") {
        let mut expected = model.clone();
        for field in ["baseMiB", "tokenMiB", "quadraticMiB"] {
            expected["memory"][field] = serde_json::Value::from(
                expected["memory"][field].as_f64().expect("task 58 fixture"),
            );
        }
        assert_eq!(
            serde_json::to_value(
                descriptor(model["modelId"].as_str().expect("task 58 fixture"))
                    .expect("task 58 fixture")
            )
            .expect("task 58 fixture"),
            expected
        );
    }
    // The CLI and the server worker build the same unpatched llama.cpp release,
    // and every vendored file matches the inventory derived from the pinned
    // archives (scripts/sync-cli-vendor-inventory.mjs).
    let runtime: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../../packages/api/src/lib/kb/fixtures/embedding-runtime.json"
    ))
    .expect("runtime pin");
    let inventory: serde_json::Value =
        serde_json::from_str(include_str!("../../../vendor/inventory.json")).expect("inventory");
    for (key, pin) in [
        ("release", "release"),
        ("commit", "commit"),
        ("archive", "sourceUrl"),
        ("archiveSha256", "sourceSha256"),
    ] {
        assert_eq!(inventory["llamaCpp"][key], runtime[pin], "llama.cpp {key}");
    }
    let vendor = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../vendor");
    let mut actual = std::collections::BTreeMap::new();
    let mut pending = vec![vendor.join("llama-cpp-2"), vendor.join("llama-cpp-sys-2")];
    while let Some(dir) = pending.pop() {
        for entry in std::fs::read_dir(&dir).expect("vendor dir") {
            let path = entry.expect("vendor entry").path();
            if path.is_dir() {
                pending.push(path);
            } else {
                let relative = path
                    .strip_prefix(&vendor)
                    .expect("vendor path")
                    .components()
                    .map(|c| c.as_os_str().to_str().expect("UTF-8 vendor path"))
                    .collect::<Vec<_>>()
                    .join("/");
                let digest = ring::digest::digest(
                    &ring::digest::SHA256,
                    &std::fs::read(&path).expect("read"),
                );
                let hex = digest
                    .as_ref()
                    .iter()
                    .map(|b| format!("{b:02x}"))
                    .collect::<String>();
                actual.insert(relative, hex);
            }
        }
    }
    let expected = inventory["files"]
        .as_object()
        .expect("inventory files")
        .iter()
        .map(|(k, v)| (k.clone(), v.as_str().expect("sha256").to_owned()))
        .collect::<std::collections::BTreeMap<_, _>>();
    let added: Vec<_> = actual
        .keys()
        .filter(|k| !expected.contains_key(*k))
        .collect();
    let removed: Vec<_> = expected
        .keys()
        .filter(|k| !actual.contains_key(*k))
        .collect();
    let changed: Vec<_> = expected
        .iter()
        .filter(|(k, v)| actual.get(*k).is_some_and(|a| a != *v))
        .map(|(k, _)| k)
        .collect();
    assert!(
        added.is_empty() && removed.is_empty() && changed.is_empty(),
        "vendored files drift from inventory: added {added:?}, removed {removed:?}, changed {changed:?}"
    );
    // Upstream skips the LM head and the logits buffer for pooled embeddings
    // (ggml-org/llama.cpp#30445), which the retired output-buffer patch did.
    let graph = include_str!("../../../vendor/llama-cpp-sys-2/llama.cpp/src/llama-graph.cpp");
    assert!(graph.contains(
        "if (cparams.embeddings && pooling_type != LLAMA_POOLING_TYPE_NONE) {\n        res->t_logits = nullptr;"
    ));
    let context = include_str!("../../../vendor/llama-cpp-sys-2/llama.cpp/src/llama-context.cpp");
    assert!(context.contains("bool has_logits     = !cparams.embeddings || graph_has_logits;"));
}

#[test]
fn owner_only_and_memory_rejection_have_no_effect() {
    let (_f, s, host) = setup("model-owner");
    let before = s.model_state().expect("initial state");
    let db = rusqlite::Connection::open(s.paths().state_db()).expect("DB");
    let events = || {
        db.query_row("SELECT COUNT(*) FROM model_events", [], |r| {
            r.get::<_, u32>(0)
        })
        .expect("events")
    };
    let initial = events();
    let foreign = Store::open(
        &s.paths()
            .root()
            .parent()
            .expect("task 58 fixture")
            .join("foreign"),
    )
    .expect("task 58 fixture");
    let stranger = foreign.owner();
    assert_eq!(
        s.model_configure(
            &stranger,
            &host,
            "embeddinggemma-2-q8_0",
            1024,
            false,
            Some(8 << 30)
        )
        .expect_err("task 58 rejection")
        .protocol_code(),
        ErrorCode::Forbidden
    );
    for budget in [None, Some(1 << 20)] {
        let error = s
            .model_configure(
                &s.owner(),
                &host,
                "embeddinggemma-2-q8_0",
                1024,
                false,
                budget,
            )
            .expect_err("memory admission");
        assert!(error.to_string().contains("memory budget"), "{error}");
    }
    // L-18: unknown models/tiers name the valid ones.
    let unknown = s
        .model_configure(&s.owner(), &host, "nosuch", 1024, false, Some(8 << 30))
        .expect_err("unknown model");
    assert!(
        unknown.to_string().contains("embeddinggemma-2-q8_0"),
        "{unknown}"
    );
    let tier = s
        .model_configure(
            &s.owner(),
            &host,
            "embeddinggemma-2-q8_0",
            3000,
            false,
            Some(8 << 30),
        )
        .expect_err("unknown tier");
    assert!(
        tier.to_string().contains("1024, 2048, 4096, 8192"),
        "{tier}"
    );
    assert_eq!(s.model_state().expect("rejected state unchanged"), before);
    assert_eq!(events(), initial);
}
#[test]
fn missing_weights_fail_before_any_state_change_with_the_fix() {
    let f = Fixture::new("model-missing");
    let s = Store::open(&f.root.join("store")).expect("store");
    let host = model_host::fake_host(&f.root, IDLE);
    let before = s.model_state().expect("state");
    let error = runtime(&s, &host)
        .configure(
            &s,
            &s.owner(),
            config("embeddinggemma-2-q8_0", 1024, 8 << 30),
        )
        .expect_err("not downloaded");
    assert!(error.to_string().contains("kb model download"), "{error}");
    assert_eq!(s.model_state().expect("unchanged"), before);
    assert!(
        !model_host::hook(&host, "model-test-probe-started").exists(),
        "no worker may start for a missing model"
    );
}
#[test]
fn sensitive_floor_precedes_worker_and_sealed_references_are_redacted() {
    let (_f, s, host) = setup("model-sensitive");
    configure(&s, &host);
    let r = runtime(&s, &host);
    let canary = format!("sk-{}", "synthetic_canary_1234");
    assert_eq!(
        r.embed(&s, &canary, Purpose::Query, Duration::from_secs(3))
            .expect_err("task 58 rejection")
            .protocol_code(),
        ErrorCode::SensitiveQuery
    );
    let e=r.embed(&s,"echo {{sealed:v1:knowledge_base:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222}}",Purpose::Query,Duration::from_secs(3)).expect("task 58 fixture");
    assert_eq!(
        e.tokens
            .iter()
            .map(|n| char::from_u32(*n as u32).expect("task 58 fixture"))
            .collect::<String>(),
        "echo [sealed value redacted]"
    );
}

#[cfg(unix)]
#[test]
fn runtime_dir_socket_and_cache_are_owner_only() {
    use std::os::unix::fs::{FileTypeExt, PermissionsExt};
    let (_f, s, host) = setup("model-perms");
    configure(&s, &host);
    runtime(&s, &host)
        .embed(&s, "hello", Purpose::Query, Duration::from_secs(5))
        .expect("embed");
    let mode =
        |p: &std::path::Path| std::fs::metadata(p).expect("meta").permissions().mode() & 0o777;
    assert_eq!(mode(host.runtime_dir()), 0o700);
    let socket = std::fs::symlink_metadata(host.endpoint()).expect("socket");
    assert!(socket.file_type().is_socket());
    assert_eq!(socket.permissions().mode() & 0o777, 0o600);
    // A runtime directory other users can enter is refused, never used.
    std::fs::set_permissions(host.runtime_dir(), std::fs::Permissions::from_mode(0o755))
        .expect("loosen");
    let fresh = runtime(&s, &host);
    assert!(
        fresh
            .embed(&s, "hello", Purpose::Query, Duration::from_secs(3))
            .is_err(),
        "a group/world-accessible runtime directory must be refused"
    );
    std::fs::set_permissions(host.runtime_dir(), std::fs::Permissions::from_mode(0o700))
        .expect("restore");
    // A cache file writable by others is never trusted, even with the right size.
    let m = descriptor("embeddinggemma-2-q8_0").expect("descriptor");
    let file = host.cache().private_copy(&m).expect("file");
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o666)).expect("loosen");
    assert_eq!(
        host.cache().verify(&m).expect("verify"),
        kb_local::model_download::Verification::Mismatch
    );
}

#[test]
fn two_stores_threads_and_processes_share_one_worker() {
    let f = Fixture::new("model-shared");
    let host = model_host::seeded(&f.root, IDLE);
    let stores = ["a", "b"].map(|n| {
        let s = Store::open(&f.root.join(n)).expect("store");
        configure(&s, &host);
        s
    });
    // Complete the unrelated identity's durable setup before observing a live
    // worker. Under load this can take longer than the five-second idle life.
    let other = model_host::seeded(&f.root.join("other"), IDLE);
    let o = Store::open(&f.root.join("c")).expect("store");
    configure(&o, &other);
    // Cold start from many clients at once: one worker wins the lock.
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(4));
    let threads = (0..4)
        .map(|i| {
            let root = stores[i % 2].paths().root().to_path_buf();
            let host = host.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let s = Store::open(&root).expect("store");
                let r = ModelRuntime::new(&s, host).expect("runtime");
                barrier.wait();
                r.embed(&s, "hello", Purpose::Query, Duration::from_secs(30))
                    .expect("concurrent embed")
                    .pid
            })
        })
        .collect::<Vec<_>>();
    let pids = threads
        .into_iter()
        .map(|t| t.join().expect("thread"))
        .collect::<Vec<_>>();
    assert!(pids.iter().all(|p| *p == pids[0]), "{pids:?}");
    // Other OS processes (other `kb mcp` sessions) reuse the same worker.
    let mut parents = (0..2)
        .map(|i| {
            support::fixture::ChildGuard::spawn(
                Command::new(model_host::helper())
                    .arg("parent")
                    .arg(stores[i].paths().root())
                    .arg(host.runtime_dir())
                    .arg(host.cache().dir())
                    .stdout(Stdio::piped()),
            )
            .expect("parent")
        })
        .collect::<Vec<_>>();
    for parent in &mut parents {
        use std::io::BufRead;
        let mut line = String::new();
        std::io::BufReader::new(parent.stdout.take().expect("stdout"))
            .read_line(&mut line)
            .expect("pid line");
        assert_eq!(line.trim().parse::<u32>().expect("pid"), pids[0]);
    }
    for mut parent in parents {
        parent.kill().expect("kill parent");
        parent.wait().expect("reap parent");
    }
    // A client exit never takes the shared worker down.
    let s = &stores[0];
    assert_eq!(
        runtime(s, &host)
            .embed(s, "after", Purpose::Query, Duration::from_secs(5))
            .expect("still served")
            .pid,
        pids[0]
    );
    assert_eq!(
        host.status().expect("running worker").pid,
        pids[0],
        "status reports the live worker without starting one"
    );
    // Starting another identity may outlast the first worker's idle life.
    assert_ne!(
        runtime(&o, &other)
            .embed(&o, "hello", Purpose::Query, Duration::from_secs(5))
            .expect("other identity")
            .pid,
        pids[0]
    );
}

#[test]
fn idle_exit_and_restart_with_a_new_pid() {
    let f = Fixture::new("model-idle");
    let s = Store::open(&f.root.join("store")).expect("store");
    let host = model_host::seeded(&f.root, Duration::from_millis(200));
    configure(&s, &host);
    let r = runtime(&s, &host);
    let first = r
        .embed(&s, "hello", Purpose::Document, Duration::from_secs(5))
        .expect("first");
    assert_eq!(first.vector.len(), 768);
    wait_until("idle worker exit", || host.status().is_none());
    #[cfg(target_os = "linux")]
    wait_until("idle worker reaped", || !pid_alive(first.pid));
    // The pooled connection is dead; the runtime reconnects and restarts.
    let second = r
        .embed(&s, "hello", Purpose::Document, Duration::from_secs(5))
        .expect("restarted");
    assert_ne!(first.pid, second.pid);
}

#[test]
fn worker_crash_mid_request_fails_fast_and_restarts() {
    let (_f, s, host) = setup("model-crash");
    configure(&s, &host);
    let r = runtime(&s, &host);
    let first = r
        .embed(&s, "hello", Purpose::Query, Duration::from_secs(5))
        .expect("first");
    // Killed while idle: the next request restarts it transparently.
    model_host::kill_worker(&host, first.pid);
    let second = r
        .embed(&s, "hello", Purpose::Query, Duration::from_secs(5))
        .expect("restart after kill");
    assert_ne!(second.pid, first.pid);
    // Crash during a request: an error well before the deadline, no hang.
    std::fs::write(model_host::hook(&host, "model-test-worker-crash"), b"x").expect("hook");
    let started = std::time::Instant::now();
    assert!(
        r.embed(&s, "hello", Purpose::Query, Duration::from_secs(30))
            .is_err()
    );
    assert!(started.elapsed() < Duration::from_secs(10));
    std::fs::remove_file(model_host::hook(&host, "model-test-worker-crash")).expect("clear");
    let third = r
        .embed(&s, "hello", Purpose::Query, Duration::from_secs(5))
        .expect("restart after crash");
    assert_ne!(third.pid, second.pid);
}

#[cfg(unix)]
#[test]
fn stale_or_foreign_socket_is_replaced_by_a_real_worker() {
    let (_f, s, host) = setup("model-stale");
    configure(&s, &host);
    let first = runtime(&s, &host)
        .embed(&s, "hello", Purpose::Query, Duration::from_secs(10))
        .expect("first worker")
        .pid;
    // A crash leaves the socket file behind with nobody listening.
    model_host::kill_worker(&host, first);
    wait_until("killed worker gone", || host.status().is_none());
    assert!(host.endpoint().exists(), "socket file left by the crash");
    let e = runtime(&s, &host)
        .embed(&s, "hello", Purpose::Query, Duration::from_secs(10))
        .expect("stale socket replaced");
    assert_ne!(e.pid, first);
    let worker = e.pid;
    model_host::kill_worker(&host, worker);
    wait_until("killed worker gone", || host.status().is_none());
    // A listener that answers garbage is not a worker: no hang, replaced.
    let _ = std::fs::remove_file(host.endpoint());
    let rogue = std::os::unix::net::UnixListener::bind(host.endpoint()).expect("rogue");
    let rogue_thread = std::thread::spawn(move || {
        if let Ok((mut stream, _)) = rogue.accept() {
            use std::io::Write;
            let _ = stream.write_all(b"{\"not\":\"a worker\"}\n");
            std::thread::sleep(Duration::from_millis(200));
        }
    });
    let e = runtime(&s, &host)
        .embed(&s, "hello", Purpose::Query, Duration::from_secs(10))
        .expect("rogue replaced");
    assert_ne!(e.pid, worker);
    rogue_thread.join().expect("rogue");
}

#[test]
fn worker_start_failure_is_reported_promptly() {
    let (_f, s, host) = setup("model-start-fail");
    configure(&s, &host);
    let r = runtime(&s, &host);
    let pid = r
        .embed(&s, "hello", Purpose::Query, Duration::from_secs(5))
        .expect("warm")
        .pid;
    model_host::kill_worker(&host, pid);
    std::fs::write(model_host::hook(&host, "model-test-worker-fail"), b"x").expect("hook");
    let fresh = runtime(&s, &host);
    let started = std::time::Instant::now();
    // A document caller keeps the worker's explanation...
    let error = fresh
        .embed(&s, "hello", Purpose::Document, Duration::from_secs(60))
        .expect_err("worker cannot start");
    assert!(started.elapsed() < Duration::from_secs(10), "{error}");
    assert_eq!(error.protocol_code(), ErrorCode::IndexUnavailable);
    assert!(error.to_string().contains("embedding worker"), "{error}");
    // ...a query sees the embedder failing (search degrades to keywords).
    let error = fresh
        .embed(&s, "hello", Purpose::Query, Duration::from_secs(60))
        .expect_err("worker cannot start");
    assert!(
        matches!(error, kb_local::StoreError::EmbeddingFailed),
        "{error}"
    );
    assert!(error.degradable_for(Purpose::Query));
}

#[test]
fn disable_fences_an_in_flight_reply() {
    let (f, s, host) = setup("model-disable");
    configure(&s, &host);
    let root = f.root.join("store");
    let r = runtime(&s, &host);
    let started = model_host::hook(&host, "model-test-started");
    let release = model_host::hook(&host, "model-test-release");
    let t = std::thread::spawn(move || {
        let other = Store::open(&root).expect("task 58 fixture");
        support::model_admission::wait_for_marker(&started, || None)
            .expect("request admitted before disable");
        other
            .model_disable(&other.owner())
            .expect("disable commits");
        std::fs::write(release, b"late").expect("late reply marker");
    });
    let error = r
        .embed(&s, "park", Purpose::Query, Duration::from_secs(60))
        .expect_err("disabled request");
    assert_ne!(
        error.protocol_code(),
        ErrorCode::DeadlineExceeded,
        "ordinary timeout masked revocation"
    );
    t.join().expect("disable thread");
    assert!(
        r.embed(&s, "late", Purpose::Query, Duration::from_secs(3))
            .is_err()
    );
    configure(&s, &host);
    assert!(
        r.embed(&s, "reload", Purpose::Query, Duration::from_secs(5))
            .is_ok()
    );
}

#[test]
fn deadline_is_prompt_and_the_worker_keeps_serving() {
    let (_f, s, host) = setup("model-timeout");
    configure(&s, &host);
    let r = runtime(&s, &host);
    let pid = r
        .embed(&s, "hello", Purpose::Query, Duration::from_secs(5))
        .expect("warm")
        .pid;
    let started = std::time::Instant::now();
    assert_eq!(
        r.embed(&s, "park", Purpose::Query, Duration::from_millis(150))
            .expect_err("task 58 rejection")
            .protocol_code(),
        ErrorCode::DeadlineExceeded
    );
    assert!(started.elapsed() < Duration::from_millis(800));
    assert_eq!(
        r.embed(&s, "park", Purpose::Query, Duration::ZERO)
            .expect_err("expired before dispatch")
            .protocol_code(),
        ErrorCode::DeadlineExceeded
    );
    std::fs::write(model_host::hook(&host, "model-test-release"), b"go").expect("release");
    let after = r
        .embed(&s, "hello", Purpose::Query, Duration::from_secs(5))
        .expect("serving after an abandoned request");
    assert_eq!(
        after.pid, pid,
        "an abandoned request must not kill the shared worker"
    );
}

#[test]
fn queries_are_served_before_queued_document_batches() {
    let (_f, s, host) = setup("model-priority");
    configure(&s, &host);
    let root = s.paths().root().to_path_buf();
    let spawn = |text: &'static str, purpose: Purpose| {
        let root = root.clone();
        let host = host.clone();
        std::thread::spawn(move || {
            let s = Store::open(&root).expect("store");
            ModelRuntime::new(&s, host)
                .expect("runtime")
                .embed(&s, text, purpose, Duration::from_secs(30))
                .map(|e| e.pid)
        })
    };
    let parked = spawn("park", Purpose::Document);
    support::model_admission::wait_for_marker(
        &model_host::hook(&host, "model-test-started"),
        || None,
    )
    .expect("parked");
    let document = spawn("document", Purpose::Document);
    std::thread::sleep(Duration::from_millis(300));
    let query = spawn("query", Purpose::Query);
    std::thread::sleep(Duration::from_millis(300));
    std::fs::write(model_host::hook(&host, "model-test-release"), b"go").expect("release");
    for t in [parked, document, query] {
        t.join().expect("thread").expect("embed");
    }
    let order =
        std::fs::read_to_string(model_host::hook(&host, "model-test-order")).expect("order log");
    let lines = order.lines().collect::<Vec<_>>();
    let at = |l: &str| lines.iter().position(|x| *x == l).expect(l);
    assert!(at("q:query") < at("d:document"), "{order}");
}

#[test]
fn failed_probe_preserves_last_good_and_success_promotes() {
    let (_f, s, host) = setup("model-probe-rollback");
    let r = runtime(&s, &host);
    r.configure(
        &s,
        &s.owner(),
        config("embeddinggemma-2-q8_0", 1024, 8 << 30),
    )
    .expect("initial probe");
    let first = r
        .embed(&s, "hello", Purpose::Document, Duration::from_secs(3))
        .expect("initial model");
    let old = s.model_state().expect("last good");
    std::fs::write(model_host::hook(&host, "model-test-probe-fail"), b"fail").expect("fault");
    let error = r
        .configure(
            &s,
            &s.owner(),
            config("qwen3-embedding-0.6b-q8_0", 1024, 8 << 30),
        )
        .expect_err("probe fails");
    assert!(error.to_string().contains("last good"), "{error}");
    assert_eq!(s.model_state().expect("state"), old);
    assert_eq!(
        r.embed(&s, "hello", Purpose::Document, Duration::from_secs(3))
            .expect("uninterrupted old service")
            .pid,
        first.pid
    );
    std::fs::remove_file(model_host::hook(&host, "model-test-probe-fail")).expect("clear");
    std::fs::write(model_host::hook(&host, "model-test-probe-park"), b"park").expect("park");
    let mut timed = config("qwen3-embedding-0.6b-q8_0", 1024, 8 << 30);
    timed.timeout = Duration::from_millis(300);
    assert!(r.configure(&s, &s.owner(), timed).is_err());
    let after_timeout = s.model_state().expect("timeout rollback");
    assert_eq!(after_timeout, old);
    std::fs::write(model_host::hook(&host, "model-test-probe-release"), b"go").expect("release");
    std::fs::remove_file(model_host::hook(&host, "model-test-probe-park")).expect("clear");
    r.configure(
        &s,
        &s.owner(),
        config("qwen3-embedding-0.6b-q8_0", 1024, 8 << 30),
    )
    .expect("candidate accepted");
    let active = r
        .embed(&s, "hello", Purpose::Query, Duration::from_secs(3))
        .expect("promoted model");
    assert_eq!(active.vector.len(), 1024);
    assert_eq!(
        s.model_state().expect("state").model_id,
        "qwen3-embedding-0.6b-q8_0"
    );
}

#[test]
fn disable_wins_a_parked_probe() {
    let (_f, s, host) = setup("model-probe-disable");
    let r = std::sync::Arc::new(runtime(&s, &host));
    r.configure(
        &s,
        &s.owner(),
        config("embeddinggemma-2-q8_0", 1024, 8 << 30),
    )
    .expect("initial probe");
    let started = model_host::hook(&host, "model-test-probe-started");
    std::fs::remove_file(&started).expect("clear marker");
    std::fs::write(model_host::hook(&host, "model-test-probe-park"), b"park").expect("park");
    let worker = std::sync::Arc::clone(&r);
    let root = s.paths().root().to_path_buf();
    let t = std::thread::spawn(move || {
        let s = Store::open(&root).expect("other handle");
        worker.configure(
            &s,
            &s.owner(),
            config("qwen3-embedding-0.6b-q8_0", 2048, 8 << 30),
        )
    });
    support::model_admission::wait_for_marker(&started, || {
        t.is_finished().then(|| "configure thread completed".into())
    })
    .expect("probe admitted before disable");
    s.model_disable(&s.owner()).expect("disable");
    assert!(t.join().expect("configure thread").is_err());
    assert!(!s.model_state().expect("disabled").enabled);
    std::fs::write(model_host::hook(&host, "model-test-probe-release"), b"go").expect("release");
    std::fs::remove_file(model_host::hook(&host, "model-test-probe-park")).expect("clear park");
    r.configure(
        &s,
        &s.owner(),
        config("embeddinggemma-2-q8_0", 1024, 8 << 30),
    )
    .expect("reentry");
}

#[test]
fn killed_probe_recovers_last_good_before_reentry() {
    let (_f, s, host) = setup("model-probe-crash");
    configure(&s, &host);
    let old = s.model_state().expect("last good");
    let root = s.paths().root().to_path_buf();
    let started = model_host::hook(&host, "model-test-probe-started");
    std::fs::remove_file(&started).expect("clear marker");
    std::fs::write(model_host::hook(&host, "model-test-probe-park"), b"park").expect("park");
    let mut parent = support::fixture::ChildGuard::spawn(
        Command::new(model_host::helper())
            .arg("configure-parent")
            .arg(&root)
            .arg(host.runtime_dir())
            .arg(host.cache().dir()),
    )
    .expect("controller");
    let admitted =
        support::model_admission::wait_for_marker(&started, || match parent.try_wait() {
            Ok(None) => None,
            Ok(Some(status)) => Some(format!("configure controller exited: {status}")),
            Err(error) => Some(format!("configure controller wait failed: {error}")),
        });
    if admitted.is_err() {
        let _ = parent.kill();
        let _ = parent.wait();
    }
    admitted.expect("probe must be admitted before controller kill");
    parent.kill().expect("kill controller");
    parent.wait().expect("reap controller");
    std::fs::write(model_host::hook(&host, "model-test-probe-release"), b"go").expect("release");
    let reopened = Store::open(&root).expect("recover interrupted intent");
    let active = reopened.model_state().expect("restored");
    assert_eq!(active.model_id, old.model_id);
    assert_eq!(active.context_tokens, old.context_tokens);
    assert!(active.enabled && !active.reloading);
    let db = rusqlite::Connection::open(reopened.paths().state_db()).expect("DB");
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM model_probe", [], |r| r
            .get::<_, u32>(0))
            .expect("pending"),
        0
    );
    std::fs::remove_file(model_host::hook(&host, "model-test-probe-park")).expect("clear park");
    runtime(&reopened, &host)
        .embed(&reopened, "hello", Purpose::Query, Duration::from_secs(5))
        .expect("last-good reentry");
}

#[test]
fn available_memory_obeys_nested_cgroups_and_unknown_usage_fails_closed() {
    use kb_local::qwen::linux_available_memory;
    use std::collections::BTreeMap;
    let mut files = BTreeMap::from([
        (
            "/proc/meminfo".to_owned(),
            "MemAvailable: 16777216 kB\n".to_owned(),
        ),
        (
            "/proc/self/cgroup".to_owned(),
            "0::/parent/child\n".to_owned(),
        ),
        (
            "/sys/fs/cgroup/cgroup.controllers".to_owned(),
            "memory".to_owned(),
        ),
        ("/sys/fs/cgroup/memory.max".to_owned(), "max".to_owned()),
        (
            "/sys/fs/cgroup/parent/memory.max".to_owned(),
            "2147483648".to_owned(),
        ),
        (
            "/sys/fs/cgroup/parent/memory.current".to_owned(),
            "1073741824".to_owned(),
        ),
        (
            "/sys/fs/cgroup/parent/child/memory.max".to_owned(),
            "4294967296".to_owned(),
        ),
        (
            "/sys/fs/cgroup/parent/child/memory.current".to_owned(),
            "104857600".to_owned(),
        ),
    ]);
    assert_eq!(
        linux_available_memory(|p| files.get(p).cloned()),
        Some(1 << 30)
    );
    files.remove("/sys/fs/cgroup/parent/memory.current");
    assert_eq!(linux_available_memory(|p| files.get(p).cloned()), None);
    files.insert("/proc/self/cgroup".into(), "2:cpu,memory:/nested".into());
    files.remove("/sys/fs/cgroup/cgroup.controllers");
    files.insert(
        "/sys/fs/cgroup/memory/nested/memory.limit_in_bytes".into(),
        "2147483648".into(),
    );
    files.insert(
        "/sys/fs/cgroup/memory/nested/memory.usage_in_bytes".into(),
        "1073741824".into(),
    );
    assert_eq!(
        linux_available_memory(|p| files.get(p).cloned()),
        Some(1 << 30)
    );
    files.insert(
        "/sys/fs/cgroup/memory/nested/memory.usage_in_bytes".into(),
        "3147483648".into(),
    );
    assert_eq!(linux_available_memory(|p| files.get(p).cloned()), Some(0));
    files.remove("/proc/meminfo");
    assert_eq!(linux_available_memory(|p| files.get(p).cloned()), None);
}

#[test]
fn escaped_raw_limit_reaches_child_and_returns_permanent_overflow() {
    let (_f, s, host) = setup("model-frame-limit");
    configure(&s, &host);
    let r = runtime(&s, &host);
    r.embed(
        &s,
        &" ".repeat(64 * 1024),
        Purpose::Document,
        Duration::from_secs(3),
    )
    .expect("exact raw bound can succeed");
    for text in [
        "\"".repeat(32 * 1024),
        "\"".repeat(64 * 1024),
        "\\".repeat(64 * 1024),
        "\0".repeat(64 * 1024),
        "x".repeat(64 * 1024 + 1),
    ] {
        assert_eq!(
            r.embed(&s, &text, Purpose::Document, Duration::from_secs(3))
                .expect_err("permanent overflow")
                .protocol_code(),
            ErrorCode::EmbeddingInputTooLong
        );
        r.embed(&s, "hello", Purpose::Query, Duration::from_secs(3))
            .expect("healthy reentry");
    }
    for text in [
        "",
        "quote: \" slash: \\ control: \0",
        "normal successful input",
    ] {
        assert!(
            r.embed(&s, text, Purpose::Document, Duration::from_secs(3))
                .is_ok()
        );
    }
}

#[test]
fn every_pooled_connection_of_a_dead_worker_is_retired_and_the_retry_restarts_it() {
    let f = Fixture::new("model-pool-epoch");
    let s = Store::open(&f.root.join("store")).expect("store");
    let host = model_host::seeded(&f.root, Duration::from_millis(300));
    configure(&s, &host);
    let r = std::sync::Arc::new(runtime(&s, &host));
    for round in 0..2 {
        // Two concurrent requests leave two pooled connections.
        let threads = (0..2)
            .map(|_| {
                let r = r.clone();
                let root = s.paths().root().to_path_buf();
                std::thread::spawn(move || {
                    let s = Store::open(&root).expect("store");
                    r.embed(&s, "wait", Purpose::Query, Duration::from_secs(10))
                        .expect("warm")
                        .pid
                })
            })
            .collect::<Vec<_>>();
        let pid = threads
            .into_iter()
            .map(|t| t.join().expect("thread"))
            .next_back()
            .expect("pid");
        if round == 0 {
            wait_until("idle worker exit", || host.status().is_none());
        } else {
            model_host::kill_worker(&host, pid);
            wait_until("killed worker gone", || host.status().is_none());
        }
        let next = r
            .embed(&s, "hello", Purpose::Query, Duration::from_secs(10))
            .expect("the first request after the exit restarts the worker");
        assert_ne!(next.pid, pid);
    }
}

#[test]
fn removing_a_model_refuses_it_at_once_even_while_another_store_has_it_loaded() {
    let f = Fixture::new("model-remove-live");
    let host = model_host::seeded(&f.root, IDLE);
    let a = Store::open(&f.root.join("a")).expect("store");
    let b = Store::open(&f.root.join("b")).expect("store");
    configure(&a, &host);
    configure(&b, &host);
    let ra = runtime(&a, &host);
    let pid = ra
        .embed(&a, "hello", Purpose::Query, Duration::from_secs(5))
        .expect("loaded")
        .pid;
    // Store B disables the model and the owner removes the file.
    b.model_disable(&b.owner()).expect("disable");
    let m = descriptor("embeddinggemma-2-q8_0").expect("descriptor");
    assert!(host.cache().remove(&m).expect("removed"));
    let error = ra
        .embed(&a, "hello", Purpose::Document, Duration::from_secs(5))
        .expect_err("refused once the file is gone");
    assert_eq!(error.protocol_code(), ErrorCode::IndexUnavailable);
    assert!(error.to_string().contains("was removed"), "{error}");
    assert!(error.to_string().contains("kb model download"), "{error}");
    let error = ra
        .embed(&a, "hello", Purpose::Query, Duration::from_secs(5))
        .expect_err("refused for queries too");
    assert!(
        matches!(error, kb_local::StoreError::EmbeddingFailed),
        "{error}"
    );
    let status = host.status().expect("same worker");
    assert_eq!(status.pid, pid);
    assert_eq!(status.loaded, None, "resident state must be invalidated");
    assert!(model_host::hook(&host, "model-test-unloaded").exists());
    model_host::seed_models(&host);
    ra.embed(&a, "hello", Purpose::Query, Duration::from_secs(5))
        .expect("served again once the file is back");
}

/// ROOT B: `kb model remove` asks the authenticated worker to release the
/// model under the removal fence before deleting (no inference traffic is
/// needed to unload it), and a disabling store's unload request frees it too.
#[test]
fn removal_and_disable_ask_the_worker_to_release_the_model_first() {
    let (_f, s, host) = setup("model-remove-unload");
    configure(&s, &host);
    let r = runtime(&s, &host);
    let pid = r
        .embed(&s, "hello", Purpose::Query, Duration::from_secs(5))
        .expect("loaded")
        .pid;
    let m = descriptor("embeddinggemma-2-q8_0").expect("descriptor");
    assert_eq!(
        host.status().expect("worker").loaded.as_deref(),
        Some("embeddinggemma-2-q8_0")
    );
    s.model_disable(&s.owner()).expect("disable");
    assert!(host.remove_model(&m).expect("removed"));
    let status = host.status().expect("same worker");
    assert_eq!(status.pid, pid);
    assert_eq!(
        status.loaded, None,
        "released before deletion, without traffic"
    );
    assert!(model_host::hook(&host, "model-test-unloaded").exists());
    assert!(!host.cache().private_copy(&m).expect("file").exists());
    // Disable path: the same control request; a model that is not resident
    // (or no worker at all) is a no-op.
    model_host::seed_models(&host);
    configure(&s, &host);
    r.embed(&s, "hello", Purpose::Query, Duration::from_secs(5))
        .expect("loaded again");
    std::fs::remove_file(model_host::hook(&host, "model-test-unloaded")).expect("reset hook");
    host.unload("qwen3-embedding-0.6b-q8_0")
        .expect("not resident: no-op");
    assert!(!model_host::hook(&host, "model-test-unloaded").exists());
    host.unload("embeddinggemma-2-q8_0").expect("released");
    assert_eq!(host.status().expect("worker").loaded, None);
    assert!(model_host::hook(&host, "model-test-unloaded").exists());
    model_host::kill_worker(&host, pid);
    host.unload("embeddinggemma-2-q8_0")
        .expect("no worker: nothing resident");
}

#[test]
fn missing_model_failures_do_not_extend_the_workers_idle_lifetime() {
    let f = Fixture::new("model-removed-idle");
    let host = model_host::seeded(&f.root, Duration::from_millis(500));
    let s = Store::open(&f.root.join("store")).expect("store");
    configure(&s, &host);
    let r = runtime(&s, &host);
    let pid = r
        .embed(&s, "hello", Purpose::Query, Duration::from_secs(5))
        .expect("loaded")
        .pid;
    host.cache()
        .remove(&descriptor("embeddinggemma-2-q8_0").expect("model"))
        .expect("remove");
    let started = std::time::Instant::now();
    let mut failures = 0;
    while let Some(info) = host.status() {
        if info.pid != pid {
            break;
        }
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "failed traffic must not keep the original worker alive"
        );
        assert!(
            r.embed(&s, "hello", Purpose::Query, Duration::from_secs(1))
                .is_err()
        );
        failures += 1;
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(failures > 3, "sustained failed traffic");
    assert!(
        model_host::hook(&host, "model-test-unloaded").exists(),
        "engine released the resident model"
    );
    #[cfg(target_os = "linux")]
    wait_until("removed model worker reaped", || !pid_alive(pid));
}

/// Lifecycle (rounds 6 and 8): work queued behind a long failing request when
/// the lifetime expires is dropped by the Draining worker and, on its
/// caller's single retry, served by a fresh worker. The retry never reaches
/// the draining instance (it accepts no handshake); it waits for the old
/// worker to hand over its instance lock, so at most one worker lives.
#[test]
fn queued_work_succeeds_across_expiry_on_a_fresh_worker() {
    let f = Fixture::new("model-expiry-queued");
    let host = model_host::seeded(&f.root, Duration::from_millis(300));
    let s = Store::open(&f.root.join("store")).expect("store");
    configure(&s, &host);
    let old = runtime(&s, &host)
        .embed(&s, "hello", Purpose::Query, Duration::from_secs(5))
        .expect("warm")
        .pid;
    let spawn = |text: &'static str| {
        let (root, host) = (s.paths().root().to_path_buf(), host.clone());
        std::thread::spawn(move || {
            let s = Store::open(&root).expect("store");
            ModelRuntime::new(&s, host)
                .expect("runtime")
                .embed(&s, text, Purpose::Query, Duration::from_secs(30))
                .map(|e| e.pid)
        })
    };
    let long = spawn("failpark");
    wait_until("long request running", || {
        model_host::hook(&host, "model-test-started").exists()
    });
    // The lifetime passes while it runs; then more work queues behind it.
    std::thread::sleep(Duration::from_millis(400));
    let queued = spawn("hello");
    std::thread::sleep(Duration::from_millis(200));
    std::fs::write(model_host::hook(&host, "model-test-release"), b"x").expect("release");
    assert!(
        long.join().expect("long").is_err(),
        "the long request failed"
    );
    let served = queued
        .join()
        .expect("queued")
        .expect("queued work is served across the expiry");
    assert_ne!(served, old, "by a fresh worker, never the draining one");
    // The fresh worker only started once the old one handed over.
    #[cfg(target_os = "linux")]
    wait_until("old worker exited", || !pid_alive(old));
    #[cfg(target_os = "linux")]
    wait_until("drained worker exited", || !pid_alive(old));
}

/// Round 8 invariant: at most one live worker per identity. The old engine
/// is slow to release its model after idle expiry: a new request's retry
/// waits for the hand-over (bounded by its deadline) instead of reaching a
/// second worker, and an unload meanwhile has no proof (no answering worker,
/// the lifecycle lock held) so it is refused.
#[test]
fn a_slow_release_holds_the_identity_until_the_model_is_gone() {
    let f = Fixture::new("model-slow-release");
    let host = model_host::seeded(&f.root, Duration::from_millis(300));
    let s = Store::open(&f.root.join("store")).expect("store");
    configure(&s, &host);
    let old = runtime(&s, &host)
        .embed(&s, "hello", Purpose::Query, Duration::from_secs(5))
        .expect("loaded")
        .pid;
    std::fs::write(model_host::hook(&host, "model-test-slow-release"), b"x").expect("hook");
    wait_until("idle expiry starts releasing the model", || {
        model_host::hook(&host, "model-test-releasing").exists()
    });
    assert!(
        host.status().is_none(),
        "a draining worker answers no handshake"
    );
    let waiting = {
        let (root, host) = (s.paths().root().to_path_buf(), host.clone());
        std::thread::spawn(move || {
            let s = Store::open(&root).expect("store");
            ModelRuntime::new(&s, host)
                .expect("runtime")
                .embed(&s, "hello", Purpose::Query, Duration::from_secs(30))
                .map(|e| e.pid)
        })
    };
    std::thread::sleep(Duration::from_millis(500));
    assert!(!waiting.is_finished(), "the retry waits for the hand-over");
    let error = host
        .with_unload_wait(Duration::from_millis(300))
        .unload("qwen3-embedding-0.6b-q8_0")
        .expect_err("no proof while the old worker still releases");
    assert_eq!(error.protocol_code(), ErrorCode::DeadlineExceeded);
    std::fs::write(model_host::hook(&host, "model-test-release-go"), b"x").expect("go");
    let served = waiting
        .join()
        .expect("thread")
        .expect("served after the hand-over");
    assert_ne!(served, old);
    #[cfg(target_os = "linux")]
    wait_until("old worker exited", || !pid_alive(old));
}

/// Round 6: an unload behind inference longer than the remover's wait.
/// Removal reports the unconfirmed release as an explicit error and deletes
/// nothing; the accepted unload control is engine state, so it still runs
/// when the request finishes although its caller has disconnected; a retry
/// then confirms at once and deletes.
#[test]
fn an_unload_behind_long_inference_survives_its_caller_and_removal_waits_for_it() {
    let (_f, s, host) = setup("model-unload-long");
    configure(&s, &host);
    let r = runtime(&s, &host);
    r.embed(&s, "hello", Purpose::Query, Duration::from_secs(5))
        .expect("loaded");
    let long = {
        let (root, host) = (s.paths().root().to_path_buf(), host.clone());
        std::thread::spawn(move || {
            let s = Store::open(&root).expect("store");
            ModelRuntime::new(&s, host)
                .expect("runtime")
                .embed(&s, "park", Purpose::Query, Duration::from_secs(60))
                .map(|e| e.pid)
        })
    };
    wait_until("long inference running", || {
        model_host::hook(&host, "model-test-started").exists()
    });
    let m = descriptor("embeddinggemma-2-q8_0").expect("descriptor");
    let error = host
        .with_unload_wait(Duration::from_millis(500))
        .remove_model(&m)
        .expect_err("release not confirmed");
    assert_eq!(error.protocol_code(), ErrorCode::DeadlineExceeded);
    assert!(error.to_string().contains("nothing was deleted"), "{error}");
    assert!(
        host.cache().private_copy(&m).expect("file").exists(),
        "never deleted while it may be loaded"
    );
    assert!(!model_host::hook(&host, "model-test-unloaded").exists());
    // The request finishes; the abandoned control still runs.
    std::fs::write(model_host::hook(&host, "model-test-release"), b"x").expect("release");
    let pid = long.join().expect("long").expect("long inference served");
    wait_until("abandoned unload ran", || {
        model_host::hook(&host, "model-test-unloaded").exists()
    });
    let status = host.status().expect("same worker");
    assert_eq!((status.pid, status.loaded), (pid, None));
    assert!(host.remove_model(&m).expect("confirmed now"));
    assert!(!host.cache().private_copy(&m).expect("file").exists());
}

/// Round 7 (closed world): success of an unload needs positive evidence.
/// A stopped worker, a missing or unreadable key and an unverifiable runtime
/// directory all leave a possibly loaded worker unconfirmed: removal fails
/// with DEADLINE_EXCEEDED and deletes nothing. No worker at all is proven by
/// the lifecycle lock.
#[cfg(unix)]
#[test]
fn unload_without_positive_evidence_is_never_success() {
    use std::os::unix::fs::PermissionsExt;
    let (_f, s, host) = setup("model-unload-evidence");
    let m = descriptor("embeddinggemma-2-q8_0").expect("descriptor");
    let file = host.cache().private_copy(&m).expect("file");
    // No worker has ever run: the lifecycle lock proves nothing is resident.
    host.unload(&m.model_id).expect("no worker: proven");
    configure(&s, &host);
    let r = runtime(&s, &host);
    let pid = r
        .embed(&s, "hello", Purpose::Query, Duration::from_secs(5))
        .expect("loaded")
        .pid;
    let quick = host.with_unload_wait(Duration::from_millis(400));
    let refused = |why: &str| {
        let error = quick.remove_model(&m).expect_err(why);
        assert_eq!(
            error.protocol_code(),
            ErrorCode::DeadlineExceeded,
            "{why}: {error}"
        );
        assert!(file.exists(), "{why}: nothing deleted");
    };
    // A stopped (stalled) worker never answers.
    let signal = |sig: &str| {
        assert!(
            Command::new("kill")
                .args([sig, &pid.to_string()])
                .status()
                .expect("signal")
                .success()
        )
    };
    signal("-STOP");
    refused("stopped worker");
    signal("-CONT");
    // Its key unreadable, then missing: the worker cannot be authenticated.
    let key = std::fs::read_dir(host.runtime_dir())
        .expect("runtime dir")
        .map(|e| e.expect("entry").path())
        .find(|p| p.extension().is_some_and(|x| x == "key"))
        .expect("key file");
    std::fs::set_permissions(&key, std::fs::Permissions::from_mode(0o000)).expect("chmod");
    refused("unreadable key");
    std::fs::set_permissions(&key, std::fs::Permissions::from_mode(0o600)).expect("chmod");
    let bytes = std::fs::read(&key).expect("key");
    std::fs::remove_file(&key).expect("remove key");
    refused("missing key");
    std::fs::write(&key, &bytes).expect("restore key");
    std::fs::set_permissions(&key, std::fs::Permissions::from_mode(0o600)).expect("chmod");
    // An unverifiable runtime directory.
    std::fs::set_permissions(host.runtime_dir(), std::fs::Permissions::from_mode(0o755))
        .expect("loosen");
    refused("unverifiable runtime directory");
    std::fs::set_permissions(host.runtime_dir(), std::fs::Permissions::from_mode(0o700))
        .expect("restore");
    // With evidence again: the authenticated acknowledgement.
    assert!(host.remove_model(&m).expect("confirmed"));
    assert!(!file.exists());
    model_host::kill_worker(&host, pid);
    host.unload(&m.model_id)
        .expect("dead worker: proven by the lifecycle lock");
}

/// Round 5: lifetime is decided at each dequeue from successful-activity
/// time. Back-to-back requests that fail slowly WHILE RUNNING (a correctly
/// sized file whose checksum is wrong, verified in full by the production
/// load path) leave no idle gap, yet the worker still expires: it stops
/// taking queued work after its idle period and exits.
#[test]
fn sustained_slow_failures_while_running_cannot_keep_the_worker_alive() {
    let f = Fixture::new("model-slow-failures");
    let host = model_host::seeded(&f.root, Duration::from_millis(300));
    let s = Store::open(&f.root.join("store")).expect("store");
    configure(&s, &host);
    let pid = runtime(&s, &host)
        .embed(&s, "hello", Purpose::Query, Duration::from_secs(5))
        .expect("warm")
        .pid;
    std::fs::write(model_host::hook(&host, "model-test-verify-load"), b"x").expect("hook");
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    // Two clients keep the queue non-empty: the next job is always waiting
    // when one completes.
    let clients = (0..2)
        .map(|_| {
            let (stop, root, host) = (stop.clone(), s.paths().root().to_path_buf(), host.clone());
            std::thread::spawn(move || {
                let s = Store::open(&root).expect("store");
                let r = ModelRuntime::new(&s, host).expect("runtime");
                let mut failures = 0;
                while !stop.load(std::sync::atomic::Ordering::Acquire) {
                    if r.embed(&s, "hello", Purpose::Query, Duration::from_secs(60))
                        .is_err()
                    {
                        failures += 1;
                    }
                }
                failures
            })
        })
        .collect::<Vec<_>>();
    let verified = || {
        std::fs::read_to_string(model_host::hook(&host, "model-test-verified"))
            .unwrap_or_default()
            .lines()
            .filter(|l| *l == pid.to_string())
            .count()
    };
    let started = std::time::Instant::now();
    while host.status().is_some_and(|info| info.pid == pid) {
        assert!(
            started.elapsed() < Duration::from_secs(120),
            "slow failing traffic kept the worker alive ({} failed loads)",
            verified()
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    stop.store(true, std::sync::atomic::Ordering::Release);
    let failures: usize = clients.into_iter().map(|c| c.join().expect("client")).sum();
    assert!(failures >= 1, "the traffic was failing");
    // Lifetime was decided at dequeue: once the idle period passed, the
    // original worker took no more than the jobs already admitted.
    assert!(verified() <= 3, "{} loads after expiry", verified());
    #[cfg(target_os = "linux")]
    wait_until("expired worker exited", || !pid_alive(pid));
}

#[cfg(unix)]
#[test]
fn cancellation_reaches_the_start_lock_and_a_stalled_handshake() {
    let (_f, s, host) = setup("model-cancel-acquire");
    configure(&s, &host);
    let r = runtime(&s, &host);
    let cancel_after = |ms: u64| {
        let token = kb_client::CancellationToken::new();
        let t = token.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(ms));
            t.cancel();
        });
        token
    };
    // 1) A stalled worker: connect is accepted, the handshake never answers.
    let pid = r
        .embed(&s, "hello", Purpose::Query, Duration::from_secs(5))
        .expect("warm")
        .pid;
    let stop = |sig: &str| {
        assert!(
            Command::new("kill")
                .args([sig, &pid.to_string()])
                .status()
                .expect("signal")
                .success()
        )
    };
    stop("-STOP");
    let fresh = runtime(&s, &host);
    let started = std::time::Instant::now();
    let error = fresh
        .embed_cancellable(
            &s,
            "hello",
            Purpose::Query,
            Duration::from_secs(30),
            &cancel_after(100),
        )
        .expect_err("cancelled");
    let elapsed = started.elapsed();
    stop("-CONT");
    assert_eq!(error.protocol_code(), ErrorCode::Cancelled);
    assert!(elapsed < Duration::from_secs(1), "{elapsed:?}");
    // 2) No worker and another process holding the start lock.
    model_host::kill_worker(&host, pid);
    wait_until("worker gone", || host.status().is_none());
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(host.endpoint().with_extension("start.lock"))
        .expect("start lock");
    lock.try_lock().expect("hold the start lock");
    let started = std::time::Instant::now();
    let error = runtime(&s, &host)
        .embed_cancellable(
            &s,
            "hello",
            Purpose::Query,
            Duration::from_secs(30),
            &cancel_after(100),
        )
        .expect_err("cancelled");
    assert_eq!(error.protocol_code(), ErrorCode::Cancelled);
    assert!(started.elapsed() < Duration::from_secs(1));
    lock.unlock().expect("release");
}

#[test]
fn a_build_progresses_under_sustained_query_traffic() {
    let (_f, s, host) = setup("model-fairness");
    configure(&s, &host);
    let root = s.paths().root().to_path_buf();
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let clients = (0..3)
        .map(|_| {
            let (root, host, stop) = (root.clone(), host.clone(), stop.clone());
            std::thread::spawn(move || {
                let s = Store::open(&root).expect("store");
                let r = ModelRuntime::new(&s, host).expect("runtime");
                let mut n = 0;
                while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                    r.embed(&s, "wait", Purpose::Query, Duration::from_secs(30))
                        .expect("query");
                    n += 1;
                }
                n
            })
        })
        .collect::<Vec<_>>();
    std::thread::sleep(Duration::from_millis(500));
    let started = std::time::Instant::now();
    runtime(&s, &host)
        .embed(&s, "document", Purpose::Document, Duration::from_secs(30))
        .expect("the document batch runs while queries continue");
    let waited = started.elapsed();
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    let queries: usize = clients.into_iter().map(|t| t.join().expect("client")).sum();
    // At most QUERY_BURST queries (150 ms each) run ahead of it.
    assert!(waited < Duration::from_secs(2), "{waited:?}");
    assert!(queries > 3, "query traffic was sustained: {queries}");
}

/// ROOT 2: a pipe re-created under a dead worker's published name (pipe
/// names are enumerable) cannot prove the instance key, so the client never
/// sends it document text.
#[cfg(windows)]
#[test]
fn a_squatted_stale_pipe_name_is_refused_before_any_document_text() {
    let (_f, s, host) = setup("model-pipe-squat");
    configure(&s, &host);
    let r = runtime(&s, &host);
    let pid = r
        .embed(&s, "hello", Purpose::Query, Duration::from_secs(5))
        .expect("warm")
        .pid;
    let name = std::fs::read_to_string(host.endpoint()).expect("published pipe name");
    model_host::kill_worker(&host, pid);
    // The squatter: answers the handshake with a forged reply.
    let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<u8>::new()));
    let recorder = seen.clone();
    let squatter = std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        rt.block_on(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let mut server = tokio::net::windows::named_pipe::ServerOptions::new()
                .create(&name)
                .expect("squat the stale name");
            if tokio::time::timeout(Duration::from_secs(10), server.connect())
                .await
                .is_err()
            {
                return;
            }
            let mut buf = vec![0; 65536];
            if let Ok(Ok(n)) =
                tokio::time::timeout(Duration::from_secs(5), server.read(&mut buf)).await
            {
                recorder.lock().expect("record").extend_from_slice(&buf[..n]);
            }
            let forged = serde_json::json!({"protocol":2,"version":"0","pid":1,"modelsDir":"","loaded":null,"proof":"00"});
            let _ = server.write_all(format!("{forged}\n").as_bytes()).await;
            if let Ok(Ok(n)) =
                tokio::time::timeout(Duration::from_secs(2), server.read(&mut buf)).await
            {
                recorder.lock().expect("record").extend_from_slice(&buf[..n]);
            }
        });
    });
    std::thread::sleep(Duration::from_millis(300));
    // The client refuses the squatter and (re)starts a real worker; either
    // way the squatter never receives the text.
    let _ = runtime(&s, &host).embed(
        &s,
        "secret document text",
        Purpose::Document,
        Duration::from_secs(20),
    );
    squatter.join().expect("squatter");
    let seen = String::from_utf8_lossy(&seen.lock().expect("seen")).to_string();
    assert!(!seen.contains("secret document text"), "{seen}");
}
