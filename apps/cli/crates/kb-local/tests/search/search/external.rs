//! External embedding providers: read rechecks, breakers and resolver isolation.

use super::*;

#[tokio::test]
async fn host_external_adapter_rechecks_read_after_dns_before_http() {
    use kb_local::{
        credentials::{Credentials, Secret},
        egress::{Dns, Endpoint, Http, HttpResponse, IoFuture, PinnedEgress},
        index::IndexEmbedder,
    };
    struct Keys;
    impl Credentials for Keys {
        fn set(&self, _: &str, _: &Secret) -> Result<(), StoreError> {
            Ok(())
        }
        fn get(&self, _: &str) -> Result<Secret, StoreError> {
            Ok(Secret::new("disposable-search-fixture".into()))
        }
        fn delete(&self, _: &str) -> Result<(), StoreError> {
            Ok(())
        }
    }
    struct Resolver<'a>(&'a dyn Fn());
    impl Dns for Resolver<'_> {
        fn resolve<'a>(&'a self, _: &'a str, _: u16) -> IoFuture<'a, Vec<std::net::IpAddr>> {
            Box::pin(async move {
                (self.0)();
                Ok(vec!["8.8.8.8".parse().expect("valid fixture")])
            })
        }
    }
    struct Transport(std::cell::Cell<usize>);
    impl Http for Transport {
        fn post<'a>(
            &'a self,
            _: &'a Endpoint,
            _: std::net::SocketAddr,
            _: &'a Secret,
            body: Vec<u8>,
        ) -> IoFuture<'a, HttpResponse> {
            Box::pin(async move {
                let body: serde_json::Value = serde_json::from_slice(&body).expect("valid fixture");
                assert_eq!(body["model"], "fixture");
                assert_eq!(body["input"][0], "alpha");
                self.0.set(self.0.get() + 1);
                Ok(HttpResponse {
                    status: 200,
                    body: serde_json::to_vec(&json!({"data":[{"index":0,"embedding":[1,1]}]}))
                        .expect("valid fixture"),
                })
            })
        }
    }
    for revoke in [false, true] {
        let f = Fixture::new(2);
        ready(&f).await;
        let p = reader(&f);
        let action = || {
            if revoke {
                f.db()
                    .execute(
                        "UPDATE principal_ceilings SET bits=0 WHERE principal_id=?1",
                        [p.id()],
                    )
                    .expect("valid fixture");
            }
        };
        let dns = Resolver(&action);
        let http = Transport(std::cell::Cell::new(0));
        let egress = PinnedEgress::new(&dns, &http);
        let out = f
            .store
            .search(
                &p,
                input(&f, json!({})),
                IndexEmbedder::External {
                    keys: &Keys,
                    egress: &egress,
                },
                &SearchControl::default(),
            )
            .await;
        if revoke {
            assert_eq!(out.unwrap_err().protocol_code(), ErrorCode::NotFound);
            assert_eq!(http.0.get(), 0);
        } else {
            assert_eq!(out.expect("valid fixture").results.len(), 1);
            assert_eq!(http.0.get(), 1);
        }
        no_leases(&f);
    }
}

/// Exercise the production provider adapter, including native-key admission,
/// rather than treating an already-admitted test closure as the provider call.
/// Admission is excluded from the target budget; DNS, connect and response
/// share it. The timer driver is paused: durable Git/SQLite work and CPU
/// scheduling cannot consume the simulated admission/target delays.
#[tokio::test(start_paused = true)]
async fn query_breakers_charge_only_target_io_through_the_production_adapter() {
    use kb_local::{
        credentials::{Credentials, Secret},
        egress::{Dns, Endpoint, Http, HttpResponse, IoFuture, PinnedEgress},
        embedder::ProviderControl,
        index::IndexEmbedder,
        locks::CredentialFence,
    };
    use std::cell::Cell;
    struct Keys {
        delay: Cell<Duration>,
        reads: Cell<usize>,
    }
    impl Credentials for Keys {
        fn set(&self, _: &str, _: &Secret) -> Result<(), StoreError> {
            Ok(())
        }
        fn get(&self, _: &str) -> Result<Secret, StoreError> {
            panic!("search must use controlled credential admission")
        }
        fn delete(&self, _: &str) -> Result<(), StoreError> {
            Ok(())
        }
        fn get_controlled<'a>(
            &'a self,
            _: &'a str,
            _: &'a ProviderControl,
            _: &'a CredentialFence,
        ) -> IoFuture<'a, Secret> {
            Box::pin(async move {
                self.reads.set(self.reads.get() + 1);
                let delay = self.delay.get();
                if !delay.is_zero() {
                    tokio::time::sleep(delay).await;
                }
                Ok(Secret::new("disposable-search-fixture".into()))
            })
        }
    }
    /// `None` is a resolver that never answers.
    struct Resolver {
        delay: Cell<Option<Duration>>,
        calls: Cell<usize>,
    }
    impl Dns for Resolver {
        fn resolve<'a>(&'a self, _: &'a str, _: u16) -> IoFuture<'a, Vec<std::net::IpAddr>> {
            Box::pin(async move {
                self.calls.set(self.calls.get() + 1);
                match self.delay.get() {
                    Some(delay) if !delay.is_zero() => tokio::time::sleep(delay).await,
                    Some(_) => {}
                    None => std::future::pending().await,
                }
                Ok(vec!["8.8.8.8".parse().expect("fixture IP")])
            })
        }
    }
    struct Transport {
        delay: Cell<Duration>,
        calls: Cell<usize>,
    }
    impl Http for Transport {
        fn post<'a>(
            &'a self,
            _: &'a Endpoint,
            _: std::net::SocketAddr,
            _: &'a Secret,
            _: Vec<u8>,
        ) -> IoFuture<'a, HttpResponse> {
            Box::pin(async move {
                self.calls.set(self.calls.get() + 1);
                let delay = self.delay.get();
                if !delay.is_zero() {
                    tokio::time::sleep(delay).await;
                }
                Ok(HttpResponse {
                    status: 200,
                    body: serde_json::to_vec(&json!({"data":[{"index":0,"embedding":[1,1]}]}))
                        .expect("fixture response"),
                })
            })
        }
    }
    for structured_method in [false, true] {
        let f = Fixture::new(2);
        f.store.advance_clock_for_tests(0);
        publish(
            &f,
            vec![("index.md", Some("# Index\n\nalpha keyword body".into()))],
            "slow-admission-publish-0001",
        );
        ready(&f).await;
        let keys = Keys {
            delay: Cell::new(Duration::ZERO),
            reads: Cell::new(0),
        };
        let http = Transport {
            delay: Cell::new(Duration::ZERO),
            calls: Cell::new(0),
        };
        let dns = Resolver {
            delay: Cell::new(Some(Duration::ZERO)),
            calls: Cell::new(0),
        };
        let egress = PinnedEgress::new(&dns, &http);
        let query = async |timeout| {
            let ctl = SearchControl::with_timeout(timeout);
            let io = IndexEmbedder::External {
                keys: &keys,
                egress: &egress,
            };
            let (results, notices) = if structured_method {
                let out = f
                    .store
                    .structured_search(
                        &f.store.owner(),
                        structured(&f, json!({"query":"alpha"})),
                        io,
                        &ctl,
                    )
                    .await
                    .expect("structured query within overall deadline");
                (out.items, out.index_notices)
            } else {
                let out = f
                    .store
                    .search(&f.store.owner(), input(&f, json!({})), io, &ctl)
                    .await
                    .expect("query within overall deadline");
                (out.results, out.index_notices)
            };
            assert!(
                !results.is_empty(),
                "real lexical/vector ranking participates"
            );
            let mode = results[0].mode;
            assert!(results.iter().all(|hit| hit.mode == mode));
            if mode == SearchMode::Lexical {
                assert!(matches!(notices.as_slice(), [IndexNotice::LexicalOnly(n)]
                    if n.detail == LexicalOnlyReason::EmbeddingProfileUnavailable));
            } else {
                assert!(notices.is_empty());
            }
            no_leases(&f);
            mode
        };
        for (admission_ms, reply_ms, budget_secs, expected, dispatched) in [
            // Admission plus healthy response exceeds eight seconds. The
            // provider itself needs only 2.5 s, so the query remains hybrid.
            (6500, 2500, 60, SearchMode::Hybrid, 1),
            // Exhaust the search share entirely in credential admission.
            (11000, 0, 12, SearchMode::Lexical, 0),
            // Admission leaves less than the full target budget: lexical
            // fallback is correct, but this timeout cannot blame the target.
            (6500, 5000, 12, SearchMode::Lexical, 1),
        ] {
            keys.delay.set(Duration::from_millis(admission_ms));
            http.delay.set(Duration::from_millis(reply_ms));
            let reads = keys.reads.get();
            let calls = http.calls.get();
            assert_eq!(query(Duration::from_secs(budget_secs)).await, expected);
            assert_eq!(keys.reads.get(), reads + 1);
            assert_eq!(http.calls.get(), calls + dispatched);
            keys.delay.set(Duration::ZERO);
            http.delay.set(Duration::ZERO);
            assert_eq!(
                query(Duration::from_secs(60)).await,
                SearchMode::Hybrid,
                "slow admission must not open the breaker (structured: {structured_method})"
            );
            assert_eq!(keys.reads.get(), reads + 2, "next query reads credentials");
            assert_eq!(
                http.calls.get(),
                calls + dispatched + 1,
                "next query reaches provider"
            );
        }
        // Conversely a provider that actually receives eight seconds and
        // never answers must open the breaker for this shared target.
        let calls = http.calls.get();
        let reads = keys.reads.get();
        http.delay.set(Duration::from_secs(9));
        assert_eq!(query(Duration::from_secs(60)).await, SearchMode::Lexical);
        http.delay.set(Duration::ZERO);
        assert_eq!(query(Duration::from_secs(60)).await, SearchMode::Lexical);
        assert_eq!(http.calls.get(), calls + 1, "open breaker skips HTTP");
        assert_eq!(keys.reads.get(), reads + 1, "open breaker skips admission");
        f.store.reset_query_breakers_for_tests();
        assert_eq!(query(Duration::from_secs(60)).await, SearchMode::Hybrid);
        // Resolution is target I/O: resolve, connect and response share the
        // one eight-second target budget; admission alone stays outside it.
        // Both methods embed through the same `PinnedEgress::post` and
        // its one `target()` boundary; cover DNS once through plain search.
        if structured_method {
            continue;
        }
        let full = kb_local::breaker::QUERY_EMBEDDING_DEADLINE;
        for (admission_ms, dns_ms, reply_ms, expected) in [
            // Slow credentials plus a slow resolver: only DNS + HTTP count.
            (6500, Some(4000), 2500, SearchMode::Hybrid),
            // Each step alone fits; together they exceed the target budget.
            (0, Some(5000), 4000, SearchMode::Lexical),
            // A resolver that never answers.
            (0, None, 0, SearchMode::Lexical),
        ] {
            keys.delay.set(Duration::from_millis(admission_ms));
            dns.delay.set(dns_ms.map(Duration::from_millis));
            http.delay.set(Duration::from_millis(reply_ms));
            let (resolves, calls) = (dns.calls.get(), http.calls.get());
            let started = tokio::time::Instant::now();
            assert_eq!(
                query(Duration::from_secs(60)).await,
                expected,
                "dns {dns_ms:?} reply {reply_ms} (structured: {structured_method})"
            );
            let elapsed = started.elapsed();
            assert_eq!(dns.calls.get(), resolves + 1);
            assert_eq!(
                http.calls.get(),
                calls + usize::from(dns_ms.is_some()),
                "a stalled resolver never dispatches"
            );
            let admission = Duration::from_millis(admission_ms);
            if expected == SearchMode::Lexical {
                assert!(
                    elapsed >= admission + full
                        && elapsed < admission + full + Duration::from_secs(2),
                    "the target budget bounds resolution: {elapsed:?}"
                );
            }
            keys.delay.set(Duration::ZERO);
            dns.delay.set(Some(Duration::ZERO));
            http.delay.set(Duration::ZERO);
            let started = tokio::time::Instant::now();
            if expected == SearchMode::Lexical {
                // A full target timeout opened the breaker: the next query
                // is served lexically at once, without resolving or sending.
                assert_eq!(query(Duration::from_secs(60)).await, SearchMode::Lexical);
                assert_eq!(started.elapsed(), Duration::ZERO, "no provider wait");
                assert_eq!(dns.calls.get(), resolves + 1, "open breaker skips DNS");
                f.store.reset_query_breakers_for_tests();
            }
            let started = tokio::time::Instant::now();
            assert_eq!(
                query(Duration::from_secs(60)).await,
                SearchMode::Hybrid,
                "healthy query after dns {dns_ms:?} (structured: {structured_method})"
            );
            assert_eq!(started.elapsed(), Duration::ZERO, "no provider wait");
        }
    }
}

/// What must arrive within the target budget is the MCP
/// handler's reply, not merely its `block_on`. The resolver here blocks a
/// thread of the runtime's blocking pool and never answers in time, as a
/// stalled `getaddrinfo` under `tokio::net::lookup_host` does. A handler that
/// built and dropped a runtime per call would hold the reply until that
/// thread returned, because dropping a runtime waits for its blocking tasks.
#[test]
fn a_blocked_resolver_thread_does_not_hold_the_mcp_reply() {
    use kb_local::{
        credentials::{Credentials, Secret},
        dispatch::{Session, SessionIo},
        egress::{Dns, Endpoint, Http, HttpResponse, IoFuture},
        embedder::ProviderControl,
        locks::CredentialFence,
        qwen::ModelRuntime,
    };
    use std::sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    };
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    const STALL: Duration = Duration::from_secs(40);
    struct Keys;
    impl Credentials for Keys {
        fn set(&self, _: &str, _: &Secret) -> Result<(), StoreError> {
            Ok(())
        }
        fn get(&self, _: &str) -> Result<Secret, StoreError> {
            panic!("search must use controlled credential admission")
        }
        fn delete(&self, _: &str) -> Result<(), StoreError> {
            Ok(())
        }
        fn get_controlled<'a>(
            &'a self,
            _: &'a str,
            _: &'a ProviderControl,
            _: &'a CredentialFence,
        ) -> IoFuture<'a, Secret> {
            Box::pin(async { Ok(Secret::new("disposable-search-fixture".into())) })
        }
    }
    /// Blocks one blocking-pool thread for `STALL`, then answers.
    struct Blocked {
        calls: Arc<AtomicUsize>,
        returned: Arc<AtomicBool>,
    }
    impl Dns for Blocked {
        fn resolve<'a>(&'a self, _: &'a str, _: u16) -> IoFuture<'a, Vec<std::net::IpAddr>> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let returned = self.returned.clone();
            Box::pin(async move {
                tokio::task::spawn_blocking(move || {
                    std::thread::sleep(STALL);
                    returned.store(true, Ordering::SeqCst);
                })
                .await
                .map_err(|_| StoreError::IndexUnavailable)?;
                Ok(vec!["8.8.8.8".parse().expect("fixture IP")])
            })
        }
    }
    struct Unreached;
    impl Http for Unreached {
        fn post<'a>(
            &'a self,
            _: &'a Endpoint,
            _: std::net::SocketAddr,
            _: &'a Secret,
            _: Vec<u8>,
        ) -> IoFuture<'a, HttpResponse> {
            panic!("a stalled resolver never dispatches")
        }
    }
    // The session's one long-lived runtime, as `kb mcp` has.
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime");
    let f = Fixture::new(2);
    publish(
        &f,
        vec![("index.md", Some("# Index\n\nalpha keyword body".into()))],
        "blocked-resolver-publish-0001",
    );
    rt.block_on(ready(&f));
    let host = model_host::seeded(&f.root.with_extension("model"), Duration::from_secs(5));
    let model = Arc::new(ModelRuntime::new(&f.store, host).expect("valid fixture"));
    let (calls, returned) = (
        Arc::new(AtomicUsize::new(0)),
        Arc::new(AtomicBool::new(false)),
    );
    let session = Session::new(
        rt.handle().clone(),
        &f.store,
        f.store.owner(),
        model,
        SessionIo {
            keys: Box::new(Keys),
            dns: Box::new(Blocked {
                calls: calls.clone(),
                returned: returned.clone(),
            }),
            http: Box::new(Unreached),
        },
    );
    let (client, server) = tokio::io::duplex(1 << 20);
    let (server_read, server_write) = tokio::io::split(server);
    let (client_read, mut client_write) = tokio::io::split(client);
    let kb = f.kb.clone();
    let (reply, elapsed) = rt.block_on(async move {
        let serving =
            kb_client::mcp::stdio::serve(server_read, server_write, move |name, input, control| {
                session.call(name, input, control, None)
            });
        let client = async move {
            let mut lines = BufReader::new(client_read).lines();
            let mut send = async |frame: serde_json::Value| {
                client_write
                    .write_all(format!("{frame}\n").as_bytes())
                    .await
                    .expect("request written");
            };
            send(json!({"jsonrpc":"2.0","id":1,"method":"server/discover","params":{}})).await;
            lines.next_line().await.expect("discover reply");
            let started = std::time::Instant::now();
            send(
                json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{
                "name":"knowledge_search","arguments":{"kbId":kb,"query":"alpha"}}}),
            )
            .await;
            let line = lines
                .next_line()
                .await
                .expect("reply read")
                .expect("reply line");
            let elapsed = started.elapsed();
            drop(client_write);
            let reply: serde_json::Value = serde_json::from_str(&line).expect("reply JSON");
            (reply, elapsed)
        };
        let (served, replied) = tokio::join!(serving, client);
        served.expect("session ends at EOF");
        replied
    });
    assert_eq!(reply["id"], 2, "{reply}");
    let budget = kb_local::breaker::QUERY_EMBEDDING_DEADLINE;
    assert!(
        elapsed >= budget && elapsed < budget + Duration::from_secs(2),
        "the reply arrives within the target budget: {elapsed:?}"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(
        !returned.load(Ordering::SeqCst),
        "the resolver thread was still blocked when the reply arrived"
    );
    let result = &reply["result"];
    assert_eq!(result["isError"], false, "{reply}");
    assert_eq!(
        result.pointer("/structuredContent/data/results/0/mode"),
        Some(&json!("lexical")),
        "{reply}"
    );
    // Never wait for the abandoned blocking thread.
    rt.shutdown_background();
}
