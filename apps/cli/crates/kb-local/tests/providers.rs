//! Spec-first 57a: real durable state; injected DNS/HTTP and credential store.
use kb_local::{
    Bits, PrincipalKind, Store, StoreError,
    credentials::{Credentials, NativeCredentials, Secret},
    egress::{
        Dns, Endpoint, Http, HttpResponse, IoFuture, NativeDns, NativeHttp, PinnedEgress, is_public,
    },
    embedder::{ProviderControl, validate_embeddings},
    providers::ProviderConfig,
};
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    collections::{BTreeMap, VecDeque},
    net::{IpAddr, SocketAddr},
    time::Duration,
};
#[path = "support/fixture.rs"]
mod fixture;
const CANARY: &str = "disposable-provider-fixture-canary";
#[derive(Default)]
struct Keys {
    values: RefCell<BTreeMap<String, String>>,
    fail: Cell<bool>,
    calls: Cell<usize>,
}
impl Credentials for Keys {
    fn set(&self, account: &str, secret: &Secret) -> Result<(), StoreError> {
        self.calls.set(self.calls.get() + 1);
        if self.fail.get() {
            return Err(kb_local::credentials::unavailable());
        }
        self.values
            .borrow_mut()
            .insert(account.into(), secret.expose().into());
        Ok(())
    }
    fn get(&self, account: &str) -> Result<Secret, StoreError> {
        self.calls.set(self.calls.get() + 1);
        if self.fail.get() {
            return Err(kb_local::credentials::unavailable());
        }
        self.values
            .borrow()
            .get(account)
            .map(|s| Secret::new(s.clone()))
            // A reachable keystore without the entry, as the native one reports.
            .ok_or_else(kb_local::credentials::missing_entry)
    }
    fn delete(&self, account: &str) -> Result<(), StoreError> {
        self.calls.set(self.calls.get() + 1);
        if self.fail.get() {
            return Err(kb_local::credentials::unavailable());
        }
        self.values.borrow_mut().remove(account);
        Ok(())
    }
}
struct Resolver(RefCell<VecDeque<Vec<IpAddr>>>);
impl Resolver {
    fn new(answers: &[&[&str]]) -> Self {
        Self(RefCell::new(
            answers
                .iter()
                .map(|a| a.iter().map(|s| s.parse().expect("fixture IP")).collect())
                .collect(),
        ))
    }
}
impl Dns for Resolver {
    fn resolve<'a>(&'a self, _: &'a str, _: u16) -> IoFuture<'a, Vec<IpAddr>> {
        Box::pin(async {
            Ok(self
                .0
                .borrow_mut()
                .pop_front()
                .expect("one resolution per dispatch"))
        })
    }
}
type Observed = (String, SocketAddr, String, Value);
struct FakeHttp {
    calls: RefCell<Vec<Observed>>,
    status: u16,
    body: Value,
}
impl Default for FakeHttp {
    fn default() -> Self {
        Self {
            calls: RefCell::new(vec![]),
            status: 200,
            body: json!({"data":[{"index":0,"embedding":[3,4]}]}),
        }
    }
}
impl Http for FakeHttp {
    fn post<'a>(
        &'a self,
        e: &'a Endpoint,
        addr: SocketAddr,
        s: &'a Secret,
        body: Vec<u8>,
    ) -> IoFuture<'a, HttpResponse> {
        Box::pin(async move {
            self.calls.borrow_mut().push((
                e.url().to_string(),
                addr,
                s.expose().to_string(),
                serde_json::from_slice(&body).expect("request JSON"),
            ));
            Ok(HttpResponse {
                status: self.status,
                body: serde_json::to_vec(&self.body).expect("fixture response JSON"),
            })
        })
    }
}
fn config() -> ProviderConfig {
    ProviderConfig {
        idempotency_key: format!(
            "fixture-register-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("fixture clock")
                .as_nanos()
        ),
        provider_id: None,
        name: "fixture provider".into(),
        endpoint_url: "https://provider.test:8443/exact/embed".into(),
        model: "fixture-model".into(),
        dimensions: 2,
    }
}
fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("fixture runtime")
}
fn setup(tag: &str) -> (fixture::Fixture, Store, Keys) {
    let f = fixture::Fixture::new(tag);
    let s = Store::open(&f.root.join("store")).expect("fixture store");
    (f, s, Keys::default())
}
async fn probe(
    s: &Store,
    r: &kb_local::providers::ProviderRevision,
    k: &dyn Credentials,
    e: &PinnedEgress<'_>,
) -> Result<kb_local::providers::ProviderRevision, StoreError> {
    s.provider_probe(
        &s.owner(),
        &r.provider_id,
        r.revision,
        k,
        e,
        &ProviderControl::default(),
    )
    .await
}
fn register(s: &Store, k: &Keys) -> kb_local::providers::ProviderRevision {
    s.provider_register(&s.owner(), config(), Secret::new(CANARY.into()), k)
        .expect("fixture provider")
}
#[test]
fn owner_control_empty_list_and_keystore_only_immutable_revisions() {
    let (_f, s, k) = setup("providers-metadata");
    assert!(s.provider_list(&s.owner(), None, 20).unwrap().is_empty());
    let r = register(&s, &k);
    let db = rusqlite::Connection::open(s.paths().state_db()).unwrap();
    assert!(
        db.execute(
            "UPDATE provider_revisions SET model='other' WHERE provider_id=?1",
            [r.provider_id.as_str()]
        )
        .is_err()
    );
    assert!(
        db.execute(
            "UPDATE provider_revisions SET endpoint_url='https://evil.test/' WHERE provider_id=?1",
            [r.provider_id.as_str()]
        )
        .is_err()
    );
    let mut c = config();
    c.provider_id = Some(r.provider_id.clone());
    c.endpoint_url = "https://provider.test:9443/exact/embed".into();
    let r2 = s
        .provider_register(
            &s.owner(),
            c,
            Secret::new("second-disposable-canary".into()),
            &k,
        )
        .unwrap();
    assert_eq!(r2.revision, 2);
    assert_ne!(r.fingerprint, r2.fingerprint);
    assert_eq!(s.provider_list(&s.owner(), None, 1).unwrap().len(), 1);
    assert_eq!(k.values.borrow().len(), 2);
    assert_eq!(
        s.provider_revision(&s.owner(), &r.provider_id, 1)
            .unwrap()
            .endpoint_url,
        r.endpoint_url
    );
    let g = s.lock_write(&[]).unwrap();
    let narrow = s
        .register_creator(&g, PrincipalKind::Config, &Bits::ALL.permissions())
        .unwrap();
    drop(g);
    let calls = k.calls.get();
    assert!(matches!(
        s.provider_list(&narrow, None, 20),
        Err(StoreError::Forbidden)
    ));
    assert!(matches!(
        s.provider_register(&narrow, config(), Secret::new(CANARY.into()), &k),
        Err(StoreError::Forbidden)
    ));
    assert!(matches!(
        s.provider_revision(&narrow, &r.provider_id, 1),
        Err(StoreError::Forbidden)
    ));
    assert!(matches!(
        s.provider_revoke(&narrow, &r.provider_id, &k),
        Err(StoreError::Forbidden)
    ));
    assert!(matches!(
        s.provider_set_loopback(&narrow, true),
        Err(StoreError::Forbidden)
    ));
    assert!(matches!(
        s.with_provider_result(&narrow, &r.provider_id, 1, || Ok(())),
        Err(StoreError::Forbidden)
    ));
    runtime().block_on(async {
        let dns = Resolver::new(&[]);
        let http = FakeHttp::default();
        let egress = PinnedEgress::new(&dns, &http);
        let ctl = ProviderControl::default();
        assert!(matches!(
            s.provider_probe(&narrow, &r.provider_id, 1, &k, &egress, &ctl)
                .await,
            Err(StoreError::Forbidden)
        ));
        assert!(matches!(
            s.provider_embed(&narrow, &r.provider_id, 1, &["x".into()], &k, &egress, &ctl)
                .await,
            Err(StoreError::Forbidden)
        ));
        assert!(http.calls.borrow().is_empty());
    });
    assert_eq!(calls, k.calls.get());
    assert!(
        s.provider_list(&s.owner(), Some(&r.provider_id), 20)
            .unwrap()
            .is_empty()
    );
    for limit in [0, 51] {
        assert!(s.provider_list(&s.owner(), None, limit).is_err());
    }
    for path in [
        s.paths().state_db(),
        s.paths().state_db().with_extension("sqlite-wal"),
    ] {
        if let Ok(bytes) = std::fs::read(path) {
            assert!(!bytes.windows(CANARY.len()).any(|w| w == CANARY.as_bytes()));
        }
    }
    assert!(!format!("{s:?} {r:?} {:?}", Secret::new(CANARY.into())).contains(CANARY));
    assert!(!serde_json::to_string(&r).unwrap().contains(CANARY));
}
#[test]
fn native_failure_and_partial_write_never_fall_back_and_revoke_is_retryable() {
    let (_f, s, k) = setup("providers-keystore");
    k.fail.set(true);
    let e = s
        .provider_register(&s.owner(), config(), Secret::new(CANARY.into()), &k)
        .unwrap_err();
    assert!(e.to_string().contains("OS credential store unavailable"));
    assert!(!format!("{e:?} {e}").contains(CANARY));
    let r = s
        .provider_list(&s.owner(), None, 20)
        .unwrap()
        .pop()
        .unwrap();
    assert_ne!(r.state, "READY");
    k.fail.set(false);
    let live = register(&s, &k);
    k.fail.set(true);
    assert!(
        s.provider_revoke(&s.owner(), &live.provider_id, &k)
            .is_err()
    );
    assert_eq!(
        s.provider_revision(&s.owner(), &live.provider_id, 1)
            .unwrap()
            .state,
        "REVOKED"
    );
    k.fail.set(false);
    s.provider_revoke(&s.owner(), &live.provider_id, &k)
        .unwrap();
    s.provider_revoke(&s.owner(), &live.provider_id, &k)
        .unwrap();
    assert!(k.values.borrow().is_empty());
    let mut c = config();
    c.provider_id = Some(live.provider_id);
    assert!(
        s.provider_register(&s.owner(), c, Secret::new(CANARY.into()), &k)
            .is_err()
    );
}
#[test]
fn fingerprints_preserve_full_path_port_model_dimensions_and_match_server_versions() {
    let c = config();
    let e = Endpoint::parse(&c.endpoint_url, false).unwrap();
    let f = c.fingerprint(&e).unwrap();
    for (url, model, dims) in [
        ("https://provider.test:8443/exact/other", "fixture-model", 2),
        ("https://provider.test:443/exact/embed", "fixture-model", 2),
        ("https://provider.test:8443/exact/embed", "other", 2),
        ("https://provider.test:8443/exact/embed", "fixture-model", 1),
    ] {
        let mut c = config();
        c.endpoint_url = url.into();
        c.model = model.into();
        c.dimensions = dims;
        assert_ne!(
            c.fingerprint(&Endpoint::parse(url, false).unwrap())
                .unwrap(),
            f
        );
    }
    assert_eq!(
        Endpoint::parse("https://PROVIDER.test:443/a", false)
            .unwrap()
            .url()
            .as_str(),
        "https://provider.test/a"
    );
    let ts = include_str!("../../../../../packages/api/src/lib/kb/fingerprint.ts");
    for version in kb_local::providers::EMBEDDING_VERSIONS {
        assert!(
            ts.contains(version),
            "fingerprint version {version} drifted"
        );
    }
    let workflow = include_str!("../../../../../.github/workflows/cli-ci.yml");
    assert_eq!(
        workflow
            .matches("- \"packages/api/src/lib/kb/fingerprint.ts\"")
            .count(),
        2
    );
}
#[test]
fn response_permutation_and_norm_rules_match_shared_server_cases() {
    assert_eq!(
        validate_embeddings(&json!({"data":[{"index":0.0,"embedding":[3,4]}]}), 1, 2).unwrap(),
        // Raw values, unchanged: the index normalizes exactly once.
        vec![vec![3., 4.]]
    );
    let response = json!({"data":[{"index":1,"embedding":[0,2]},{"index":0,"embedding":[3,4]}]});
    assert_eq!(
        validate_embeddings(&response, 2, 2).unwrap(),
        vec![vec![3., 4.], vec![0., 2.]]
    );
    for indices in [vec![0, 0], vec![0], vec![-1, 0], vec![0, 2]] {
        let v = json!({"data":indices.iter().map(|i|json!({"index":i,"embedding":[1,2]})).collect::<Vec<_>>()});
        assert!(validate_embeddings(&v, 2, 2).is_err());
    }
    for v in [
        json!([0, 0]),
        json!([1e39, 1]),
        json!([1e-50, 0]),
        json!([1]),
        json!([]),
        json!([1, 2, 3]),
        json!([null, 1]),
        json!(["NaN", 1]),
    ] {
        assert!(validate_embeddings(&json!({"data":[{"index":0,"embedding":v}]}), 1, 2).is_err());
    }
    for i in [json!(0.5), json!(null), json!("0")] {
        assert!(
            validate_embeddings(&json!({"data":[{"index":i,"embedding":[1,2]}]}), 1, 2).is_err()
        );
    }
    for d in [1, 2000] {
        let v = validate_embeddings(&json!({"data":[{"index":0,"embedding":vec![1.;d]}]}), 1, d)
            .unwrap();
        assert_eq!(v[0], vec![1.; d]);
    }
    for d in [0, 2001] {
        assert!(validate_embeddings(&json!({"data":[]}), 0, d).is_err());
    }
    assert!(
        validate_embeddings(&json!({"data":[]}), 0, 2)
            .unwrap()
            .is_empty()
    );
}
#[test]
fn pinned_dns_rejects_rebinding_mixed_answers_and_redirects_without_forwarding() {
    runtime().block_on(async {
        let (_f,s,k)=setup("providers-egress");let r=register(&s,&k);
        let dns=Resolver::new(&[&["8.8.8.8"],&["127.0.0.1"]]);let http=FakeHttp::default();let egress=PinnedEgress::new(&dns,&http);
        probe(&s, &r, &k, &egress).await.unwrap();
        assert_eq!(http.calls.borrow()[0].1,"8.8.8.8:8443".parse().unwrap());
        assert_eq!(http.calls.borrow()[0].2,CANARY);assert_eq!(http.calls.borrow()[0].0,r.endpoint_url);
        assert_eq!(http.calls.borrow()[0].3,json!({"model":"fixture-model","input":["knowledge base provider probe"],"dimensions":2,"encoding_format":"float"}));
        assert!(probe(&s, &r, &k, &egress).await.is_err());assert_eq!(http.calls.borrow().len(),1);
        for answers in [&["8.8.8.8","10.0.0.1"][..],&[][..]] {
            let d=Resolver::new(&[answers]);let h=FakeHttp::default();
            assert!(probe(&s, &r, &k, &PinnedEgress::new(&d,&h)).await.is_err());assert!(h.calls.borrow().is_empty());
        }
        let d=Resolver::new(&[&["8.8.8.8"]]);let h=FakeHttp { status:302,body:json!({"Location":"https://elsewhere.test/","error":CANARY}),..Default::default() };
        let err=probe(&s, &r, &k, &PinnedEgress::new(&d,&h)).await.unwrap_err();
        assert_eq!(h.calls.borrow().len(),1);assert!(!format!("{err:?} {err}").contains(CANARY));
    });
}
#[test]
fn only_owner_persisted_development_setting_allows_literal_loopback() {
    let (_f, s, k) = setup("providers-loopback");
    let mut c = config();
    c.endpoint_url = "http://127.0.0.1:8765/v1/embeddings".into();
    assert!(
        s.provider_register(&s.owner(), c.clone(), Secret::new(CANARY.into()), &k)
            .is_err()
    );
    s.provider_set_loopback(&s.owner(), true).unwrap();
    let r = s
        .provider_register(&s.owner(), c, Secret::new(CANARY.into()), &k)
        .unwrap();
    for url in [
        "http://private.test/",
        "http://10.0.0.1/",
        "https://10.0.0.1/",
        "https://user:password@host.test/",
        "https://host.test/a?key=canary",
        "https://host.test/a#hash",
    ] {
        assert!(Endpoint::parse(url, true).is_err(), "{url}");
    }
    s.provider_set_loopback(&s.owner(), false).unwrap();
    runtime().block_on(async {
        let d = Resolver::new(&[]);
        let h = FakeHttp::default();
        assert!(probe(&s, &r, &k, &PinnedEgress::new(&d, &h)).await.is_err());
        assert!(h.calls.borrow().is_empty());
    });
    assert!(Endpoint::parse("https://[::1]:9876/embed", true).is_ok());
}
#[test]
fn public_ip_policy_positive_global_allowlist() {
    for ip in [
        "8.8.8.8",
        "192.0.0.9",
        "192.0.0.10",
        "2606:4700:4700::1111",
        "2001:3::1",
        "::ffff:8.8.8.8",
        "64:ff9b::808:808",
    ] {
        assert!(is_public(ip.parse().unwrap()), "{ip}");
    }
    for ip in [
        "0.0.0.0",
        "10.0.0.1",
        "100.64.0.1",
        "127.0.0.1",
        "169.254.169.254",
        "172.16.0.1",
        "192.168.0.1",
        "192.0.0.8",
        "192.0.2.1",
        "192.88.99.1",
        "198.18.0.1",
        "198.51.100.1",
        "203.0.113.1",
        "224.0.0.1",
        "240.0.0.1",
        "255.255.255.255",
        "::",
        "::1",
        "fe80::1",
        "fec0::1",
        "fc00::1",
        "ff02::1",
        "2001::1",
        "2001:2::1",
        "2001:db8::1",
        "2002:808:808::1",
        "3fff::1",
        "::ffff:127.0.0.1",
        "64:ff9b::a00:1",
        "64:ff9b:1::1",
        "::8.8.8.8",
    ] {
        assert!(!is_public(ip.parse().unwrap()), "{ip}");
    }
}
struct RevokeHttp<'a> {
    s: &'a Store,
    k: &'a Keys,
    id: kb_client::types::KbId,
}
impl Http for RevokeHttp<'_> {
    fn post<'a>(
        &'a self,
        _: &'a Endpoint,
        _: SocketAddr,
        _: &'a Secret,
        _: Vec<u8>,
    ) -> IoFuture<'a, HttpResponse> {
        Box::pin(async {
            self.s
                .provider_revoke(&self.s.owner(), &self.id, self.k)
                .expect("concurrent revoke");
            Ok(HttpResponse {
                status: 200,
                body: serde_json::to_vec(&json!({"data":[{"index":0,"embedding":[3,4]}]}))
                    .expect("fixture response JSON"),
            })
        })
    }
}
#[test]
fn revoke_from_second_handle_fences_pending_probe_embedding_and_publication() {
    runtime().block_on(async {
        let (_f, s, k) = setup("providers-revoke");
        let r = register(&s, &k);
        let second = Store::open(s.paths().root()).unwrap();
        let d = Resolver::new(&[&["8.8.8.8"]]);
        let h = RevokeHttp {
            s: &second,
            k: &k,
            id: r.provider_id.clone(),
        };
        assert!(probe(&s, &r, &k, &PinnedEgress::new(&d, &h)).await.is_err());
        assert_eq!(
            s.provider_revision(&s.owner(), &r.provider_id, 1)
                .unwrap()
                .state,
            "REVOKED"
        );
        assert!(k.values.borrow().is_empty());
        let mut used = false;
        assert!(
            s.with_provider_result(&s.owner(), &r.provider_id, 1, || {
                used = true;
                Ok(())
            })
            .is_err()
        );
        assert!(!used);
        let d = Resolver::new(&[]);
        let h = FakeHttp::default();
        assert!(
            s.provider_embed(
                &s.owner(),
                &r.provider_id,
                1,
                &["x".into()],
                &k,
                &PinnedEgress::new(&d, &h),
                &ProviderControl::default()
            )
            .await
            .is_err()
        );
        assert!(h.calls.borrow().is_empty());
        // An already READY embed request revoked while HTTP is in flight.
        let live = register(&s, &k);
        let dns = Resolver::new(&[&["8.8.8.8"]]);
        probe(&s, &live, &k, &PinnedEgress::new(&dns, &h))
            .await
            .unwrap();
        let dns = Resolver::new(&[&["8.8.8.8"]]);
        let revoke = RevokeHttp {
            s: &second,
            k: &k,
            id: live.provider_id.clone(),
        };
        assert!(
            s.provider_embed(
                &s.owner(),
                &live.provider_id,
                1,
                &["x".into()],
                &k,
                &PinnedEgress::new(&dns, &revoke),
                &ProviderControl::default()
            )
            .await
            .is_err()
        );
    });
}
struct Stalled;
impl Http for Stalled {
    fn post<'a>(
        &'a self,
        _: &'a Endpoint,
        _: SocketAddr,
        _: &'a Secret,
        _: Vec<u8>,
    ) -> IoFuture<'a, HttpResponse> {
        Box::pin(std::future::pending())
    }
}
/// #4: a provider key removed outside kb is reported as that provider's
/// key, with the recovery that exists (a new revision), not the sealed
/// master-key guidance.
#[test]
fn a_lost_provider_key_names_its_recovery() {
    runtime().block_on(async {
        let (_f, s, k) = setup("providers-lost-key");
        let r = register(&s, &k);
        k.values.borrow_mut().clear();
        let d = Resolver::new(&[&["8.8.8.8"]]);
        let why = probe(&s, &r, &k, &PinnedEgress::new(&d, &Stalled))
            .await
            .expect_err("no key")
            .to_string();
        assert!(why.contains("API key for provider"), "{why}");
        assert!(why.contains("kb providers register --provider-id"), "{why}");
        assert!(!why.contains("sealed"), "{why}");
    });
}
#[test]
fn timeout_shutdown_empty_batch_and_narrowed_principal_have_no_late_result() {
    runtime().block_on(async {
        let (_f, s, k) = setup("providers-deadline");
        let r = register(&s, &k);
        let h = Stalled;
        let d = Resolver::new(&[&["8.8.8.8"]]);
        let ctl = ProviderControl::with_timeout(Duration::from_millis(250));
        assert!(matches!(
            s.provider_probe(
                &s.owner(),
                &r.provider_id,
                1,
                &k,
                &PinnedEgress::new(&d, &h),
                &ctl
            )
            .await,
            Err(StoreError::EmbeddingTimeout)
        ));
        assert_eq!(
            s.provider_revision(&s.owner(), &r.provider_id, 1)
                .unwrap()
                .state,
            "FAILED"
        );
        let ctl = ProviderControl::default();
        let cancellation = ctl.clone();
        let d = Resolver::new(&[&["8.8.8.8"]]);
        let e = PinnedEgress::new(&d, &h);
        let owner = s.owner();
        let (r, _) = tokio::join!(
            s.provider_probe(&owner, &r.provider_id, 1, &k, &e, &ctl),
            async {
                tokio::task::yield_now().await;
                cancellation.cancel();
            }
        );
        assert!(r.is_err());
        let r = s
            .provider_list(&s.owner(), None, 20)
            .unwrap()
            .pop()
            .unwrap();
        let d = Resolver::new(&[&["8.8.8.8"]]);
        let h = FakeHttp::default();
        probe(&s, &r, &k, &PinnedEgress::new(&d, &h)).await.unwrap();
        let d = Resolver::new(&[]);
        let h = FakeHttp::default();
        assert!(
            s.provider_embed(
                &s.owner(),
                &r.provider_id,
                1,
                &[],
                &k,
                &PinnedEgress::new(&d, &h),
                &ProviderControl::default()
            )
            .await
            .unwrap()
            .is_empty()
        );
        assert!(h.calls.borrow().is_empty());
        assert!(
            s.provider_embed(
                &s.owner(),
                &r.provider_id,
                1,
                &vec!["x".into(); 33],
                &k,
                &PinnedEgress::new(&d, &h),
                &ProviderControl::default()
            )
            .await
            .is_err()
        );
    });
}
#[test]
#[ignore = "requires a disposable native OS credential store; run explicitly in platform CI"]
fn actual_native_keystore_smoke() {
    let native = NativeCredentials::new(
        std::env::current_exe()
            .unwrap()
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join(if cfg!(windows) { "kb.exe" } else { "kb" }),
    );
    let (_fixture, store, _) = setup("native-smoke");
    // Even an assertion failure must revoke every allocated account before
    // the fixture removes its state. Exercise controlled native calls through
    // the real Store, including both revisions and the maximum-size key.
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let mut provider = None;
        for value in [CANARY.to_owned(), "\"".repeat(16384)] {
            let mut c = config();
            c.provider_id = provider.clone();
            let revision = store
                .provider_register(&store.owner(), c, Secret::new(value.clone()), &native)
                .unwrap();
            provider = Some(revision.provider_id.clone());
            let http = FakeHttp::default();
            let dns = Resolver::new(&[&["8.8.8.8"]]);
            let ready = runtime()
                .block_on(probe(
                    &store,
                    &revision,
                    &native,
                    &PinnedEgress::new(&dns, &http),
                ))
                .unwrap();
            assert_eq!(ready.state, "READY");
            assert_eq!(http.calls.borrow()[0].2, value);
        }
    }));
    let rows = store.provider_list(&store.owner(), None, 50).unwrap();
    let cleanup: Vec<_> = rows
        .iter()
        .map(|row| store.provider_revoke(&store.owner(), &row.provider_id, &native))
        .collect();
    for deletion in cleanup {
        deletion.unwrap();
    }
    for row in rows {
        for revision in 1..=row.revision {
            assert_eq!(
                store
                    .provider_revision(&store.owner(), &row.provider_id, revision)
                    .unwrap()
                    .state,
                "REVOKED"
            );
            let account = format!("{}-{}-{revision}", store.store_uuid(), row.provider_id);
            assert!(
                native.get(&account).is_err(),
                "revocation retained a native secret"
            );
            #[cfg(windows)]
            {
                use keyring_core::api::CredentialStoreApi;
                let backend = windows_native_keyring_store::Store::new().unwrap();
                // Check the fragment inventory as well as the length marker:
                // a missing marker alone could hide eight leaked native keys.
                for suffix in std::iter::once(String::new()).chain((0..8).map(|i| format!("-{i}")))
                {
                    let entry = backend
                        .build(
                            "knowledge-base-provider-v1",
                            &format!("{account}{suffix}"),
                            None,
                        )
                        .unwrap();
                    assert!(matches!(
                        entry.get_secret(),
                        Err(keyring_core::Error::NoEntry)
                    ));
                }
            }
        }
    }
    if let Err(panic) = result {
        std::panic::resume_unwind(panic);
    }
}

#[test]
fn real_http_uses_exact_path_key_and_refuses_redirect_and_tls_downgrade() {
    use std::{
        io::{Read, Write},
        net::TcpListener,
        thread,
    };
    for mode in ["ok", "redirect", "tls"] {
        let (_f, s, k) = setup(mode);
        s.provider_set_loopback(&s.owner(), true).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let target = TcpListener::bind("127.0.0.1:0").unwrap();
        target.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let location = target.local_addr().unwrap();
        let mut c = config();
        c.endpoint_url = format!(
            "{}://{address}/exact/embed",
            if mode == "tls" { "https" } else { "http" }
        );
        let r = s
            .provider_register(&s.owner(), c, Secret::new(CANARY.into()), &k)
            .unwrap();
        listener.set_nonblocking(true).unwrap();
        let task = thread::spawn(move || {
            let until = std::time::Instant::now() + Duration::from_secs(12);
            let (mut stream, _) = loop {
                match listener.accept() {
                    Ok(stream) => break stream,
                    Err(e)
                        if e.kind() == std::io::ErrorKind::WouldBlock
                            && std::time::Instant::now() < until =>
                    {
                        thread::sleep(Duration::from_millis(10))
                    }
                    Err(e) => panic!("fixture server received no request: {e}"),
                }
            };
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut bytes = vec![0; 8192];
            let n = stream.read(&mut bytes).unwrap();
            bytes.truncate(n);
            let response=match mode {
                "ok"=>"HTTP/1.1 200 OK\r\nContent-Length: 40\r\nConnection: close\r\n\r\n{\"data\":[{\"index\":0,\"embedding\":[3,4]}]}".to_owned(),
                "redirect"=>format!("HTTP/1.1 302 Found\r\nLocation: http://{location}/stolen\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"),
                _=>"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n".to_owned(),
            };
            let _ = stream.write_all(response.as_bytes());
            bytes
        });
        let result = runtime().block_on(probe(
            &s,
            &r,
            &k,
            &PinnedEgress::new(&NativeDns, &NativeHttp),
        ));
        let captured = task
            .join()
            .unwrap_or_else(|_| panic!("{mode} probe result: {result:?}"));
        if mode == "ok" {
            assert!(result.is_ok(), "{result:?}");
        } else {
            assert!(result.is_err());
        }
        if mode == "tls" {
            assert!(
                !captured
                    .windows(CANARY.len())
                    .any(|w| w == CANARY.as_bytes())
            );
        } else {
            let request = String::from_utf8(captured).unwrap();
            assert!(request.starts_with("POST /exact/embed HTTP/1.1\r\n"));
            assert!(request.contains(&format!("authorization: Bearer {CANARY}")));
        }
        assert!(matches!(target.accept(),Err(e) if e.kind()==std::io::ErrorKind::WouldBlock));
    }
}

#[test]
fn shared_egress_prefix_boundaries_and_embedded_forms() {
    use std::net::{Ipv4Addr, Ipv6Addr};
    let corpus: Value = serde_json::from_str(include_str!(
        "../../../../../packages/api/src/lib/kb/fixtures/egress-prefixes.json"
    ))
    .unwrap();
    let ranges: Vec<(u32, u32)> = corpus["blockedRanges"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| {
            (
                u32::from(r[0].as_str().unwrap().parse::<Ipv4Addr>().unwrap()),
                u32::from(r[1].as_str().unwrap().parse::<Ipv4Addr>().unwrap()),
            )
        })
        .collect();
    let mut cases = std::collections::BTreeSet::new();
    for (start, end) in &ranges {
        for v in [
            i64::from(*start) - 1,
            i64::from(*start),
            i64::from(*start) + 1,
            i64::from(*end) - 1,
            i64::from(*end),
            i64::from(*end) + 1,
        ] {
            if let Ok(v) = u32::try_from(v) {
                cases.insert(v);
            }
        }
    }
    let sweep = &corpus["sweep"];
    for third in sweep["thirdFrom"].as_u64().unwrap()..=sweep["thirdTo"].as_u64().unwrap() {
        for last in sweep["lastOctets"].as_array().unwrap() {
            cases.insert(u32::from(
                format!("{}.{}.{}", sweep["prefix"].as_str().unwrap(), third, last)
                    .parse::<Ipv4Addr>()
                    .unwrap(),
            ));
        }
    }
    for v in cases {
        let ip = Ipv4Addr::from(v);
        let expected = sweep["exceptions"]
            .as_array()
            .unwrap()
            .contains(&json!(ip.to_string()))
            || !ranges.iter().any(|(start, end)| v >= *start && v <= *end);
        for form in [
            IpAddr::V4(ip),
            IpAddr::V6(Ipv6Addr::from((0xffffu128 << 32) | u128::from(v))),
            IpAddr::V6(Ipv6Addr::from((0x64ff9bu128 << 96) | u128::from(v))),
        ] {
            assert_eq!(is_public(form), expected, "{form}");
        }
    }
}

#[test]
fn durable_probe_budget_covers_failure_second_handle_restart_and_expiry() {
    runtime().block_on(async {
        let (f, s, k) = setup("probe-budget");
        let r = register(&s, &k);
        // A lowered window (local default is 30/min) keeps the
        // boundary small; the durable charge semantics are unchanged.
        let five = || {
            kb_local::limits::LocalLimits::default()
                .with_probe_limit(5)
                .unwrap()
        };
        s.set_limits(five());
        s.set_cursor_clock_for_tests(1000);
        let s2 = Store::open(&f.root.join("store")).unwrap();
        s2.set_limits(five());
        s2.set_cursor_clock_for_tests(1000);
        let dns = Resolver::new(&[
            &["8.8.8.8"],
            &["8.8.8.8"],
            &["8.8.8.8"],
            &["8.8.8.8"],
            &["8.8.8.8"],
            &["8.8.8.8"],
        ]);
        let http = FakeHttp::default();
        let e = PinnedEgress::new(&dns, &http);
        for n in 0..5 {
            k.fail.set(n == 2); // Native admission failure is still charged.
            let handle = if n % 2 == 0 { &s } else { &s2 };
            let result = handle
                .provider_probe(
                    &handle.owner(),
                    &r.provider_id,
                    1,
                    &k,
                    &e,
                    &Default::default(),
                )
                .await;
            assert_eq!(result.is_ok(), n != 2);
        }
        k.fail.set(false);
        let before = (k.calls.get(), http.calls.borrow().len());
        let db = rusqlite::Connection::open(s.paths().state_db()).unwrap();
        let attempt: i64 = db
            .query_row("SELECT attempt FROM provider_revisions", [], |r| r.get(0))
            .unwrap();
        let reopened = Store::open(&f.root.join("store")).unwrap();
        reopened.set_limits(five());
        reopened.set_cursor_clock_for_tests(1000);
        assert!(matches!(
            reopened
                .provider_probe(
                    &reopened.owner(),
                    &r.provider_id,
                    1,
                    &k,
                    &e,
                    &Default::default()
                )
                .await,
            Err(StoreError::RateLimited(60))
        ));
        assert_eq!(before, (k.calls.get(), http.calls.borrow().len()));
        assert_eq!(
            attempt,
            db.query_row("SELECT attempt FROM provider_revisions", [], |r| r
                .get::<_, i64>(0))
                .unwrap()
        );
        assert_eq!(
            db.query_row(
                "SELECT count(*) FROM provider_events WHERE event='provider_probe'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            5
        );
        reopened.set_cursor_clock_for_tests(1060);
        reopened
            .provider_probe(
                &reopened.owner(),
                &r.provider_id,
                1,
                &k,
                &e,
                &Default::default(),
            )
            .await
            .unwrap();
        assert_eq!(http.calls.borrow().len(), 5);
        assert!(
            kb_local::limits::LocalLimits::default()
                .with_probe_limit(kb_local::limits::LOCAL_PROBES_PER_MINUTE + 1)
                .is_err()
        );
        reopened.set_limits(
            kb_local::limits::LocalLimits::default()
                .with_probe_limit(1)
                .unwrap(),
        );
        assert!(matches!(
            reopened
                .provider_probe(
                    &reopened.owner(),
                    &r.provider_id,
                    1,
                    &k,
                    &e,
                    &Default::default()
                )
                .await,
            Err(StoreError::RateLimited(_))
        ));
    });
}
#[test]
fn retained_revision_caps_are_shared_transactional_and_include_failed_revoked_rows() {
    use kb_local::limits::{
        PROBES_PER_MINUTE_PER_USER, PROVIDER_REVISIONS_PER_PROVIDER, PROVIDER_REVISIONS_PER_USER,
        PROVIDERS_PER_USER,
    };
    let ts = include_str!("../../../../../packages/api/src/lib/kb/limits.ts");
    for (name, value) in [
        ("providersPerUser", PROVIDERS_PER_USER),
        (
            "providerRevisionsPerProvider",
            PROVIDER_REVISIONS_PER_PROVIDER,
        ),
        ("providerRevisionsPerUser", PROVIDER_REVISIONS_PER_USER),
        ("probesPerMinutePerUser", PROBES_PER_MINUTE_PER_USER),
    ] {
        assert!(ts.contains(&format!("{name}: {value},")));
    }
    let (_f, s, k) = setup("revision-caps");
    let first = register(&s, &k);
    for n in 1..50 {
        let mut c = config();
        c.provider_id = Some(first.provider_id.clone());
        k.fail.set(n == 49);
        let result = s.provider_register(&s.owner(), c, Secret::new(CANARY.into()), &k);
        assert_eq!(result.is_ok(), n != 49, "revision {n}: {result:?}");
    }
    k.fail.set(false);
    let before = k.calls.get();
    let mut c = config();
    c.provider_id = Some(first.provider_id.clone());
    assert!(matches!(
        s.provider_register(&s.owner(), c, Secret::new(CANARY.into()), &k),
        Err(StoreError::QuotaExceeded(_))
    ));
    assert_eq!(k.calls.get(), before);
    s.provider_revoke(&s.owner(), &first.provider_id, &k)
        .unwrap();
    // Build retained-history fixture in one transaction; rejection still runs
    // through the actual Store allocation boundary, never a mocked quota.
    let db = rusqlite::Connection::open(s.paths().state_db()).unwrap();
    let tx = db.unchecked_transaction().unwrap();
    for n in 1..20 {
        let id = format!("retainedprovider{n:09}");
        tx.execute(
            "INSERT INTO providers(id,name,revoked) VALUES(?1,'retained fixture',1)",
            [&id],
        )
        .unwrap();
        for v in 1..=50 {
            tx.execute("INSERT INTO provider_revisions(provider_id,revision,endpoint_url,model,dimensions,fingerprint,state,secret_deleted) VALUES(?1,?2,'https://provider.test/','fixture',2,?3,'REVOKED',1)",(&id,v,&first.fingerprint)).unwrap();
        }
    }
    tx.commit().unwrap();
    let before = k.calls.get();
    assert!(matches!(
        s.provider_register(&s.owner(), config(), Secret::new(CANARY.into()), &k),
        Err(StoreError::QuotaExceeded(_))
    ));
    assert_eq!(k.calls.get(), before);
    let db = rusqlite::Connection::open(s.paths().state_db()).unwrap();
    assert_eq!(
        db.query_row("SELECT count(*) FROM provider_revisions", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1000
    );
    assert_eq!(
        db.query_row("SELECT count(*) FROM providers", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        20
    );
}
#[test]
fn registration_replays_one_identity_after_partial_write_and_finalization_failure() {
    struct WriteThenError(Keys);
    impl Credentials for WriteThenError {
        fn set(&self, a: &str, s: &Secret) -> Result<(), StoreError> {
            self.0.set(a, s)?;
            Err(kb_local::credentials::unavailable())
        }
        fn get(&self, a: &str) -> Result<Secret, StoreError> {
            self.0.get(a)
        }
        fn delete(&self, a: &str) -> Result<(), StoreError> {
            self.0.delete(a)
        }
    }
    let (f, s, k) = setup("register-replay");
    let c = config();
    let broken = WriteThenError(k);
    assert!(
        s.provider_register(&s.owner(), c.clone(), Secret::new(CANARY.into()), &broken)
            .is_err()
    );
    let r = s
        .provider_list(&s.owner(), None, 20)
        .unwrap()
        .pop()
        .unwrap();
    assert_eq!(r.state, "STORING");
    assert_eq!(broken.0.values.borrow().len(), 1);
    drop(s);
    let s = Store::open(&f.root.join("store")).unwrap();
    assert!(matches!(
        s.provider_register(
            &s.owner(),
            c.clone(),
            Secret::new("changed".into()),
            &broken.0
        ),
        Err(StoreError::IdempotencyMismatch)
    ));
    let mut changed = c.clone();
    changed.model = "different".into();
    assert!(matches!(
        s.provider_register(&s.owner(), changed, Secret::new(CANARY.into()), &broken.0),
        Err(StoreError::IdempotencyMismatch)
    ));
    let db = rusqlite::Connection::open(s.paths().state_db()).unwrap();
    db.execute_batch("CREATE TRIGGER fail_provider_finalize BEFORE INSERT ON provider_events WHEN NEW.event='provider_create' AND (SELECT allow_loopback FROM provider_settings WHERE id=1)=0 BEGIN SELECT RAISE(ABORT,'fixture finalization failure'); END;").unwrap();
    assert!(
        s.provider_register(&s.owner(), c.clone(), Secret::new(CANARY.into()), &broken.0)
            .is_err()
    );
    assert_eq!(
        s.provider_revision(&s.owner(), &r.provider_id, 1)
            .unwrap()
            .state,
        "STORING"
    );
    s.provider_set_loopback(&s.owner(), true).unwrap();
    let done = s
        .provider_register(&s.owner(), c.clone(), Secret::new(CANARY.into()), &broken.0)
        .unwrap();
    assert_eq!(done.provider_id, r.provider_id);
    assert_eq!(done.operation_id, r.operation_id);
    let calls = broken.0.calls.get();
    let replay = s
        .provider_register(&s.owner(), c.clone(), Secret::new(CANARY.into()), &broken.0)
        .unwrap();
    assert_eq!(replay.operation_id, done.operation_id);
    assert_eq!(calls, broken.0.calls.get());
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM provider_events WHERE event='provider_create'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
    assert_eq!(
        db.query_row("SELECT count(*) FROM provider_revisions", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    s.provider_revoke(&s.owner(), &r.provider_id, &broken.0)
        .unwrap();
    assert!(
        s.provider_register(&s.owner(), c, Secret::new(CANARY.into()), &broken.0)
            .is_err()
    );
    assert!(broken.0.values.borrow().is_empty());
}

#[cfg(target_os = "linux")]
struct Resume(String);
#[cfg(target_os = "linux")]
impl Drop for Resume {
    fn drop(&mut self) {
        let _ = std::process::Command::new("kill")
            .args(["-CONT", &self.0])
            .status();
    }
}

#[cfg(target_os = "linux")]
#[test]
#[ignore = "script creates and owns the isolated Secret Service before selection"]
fn actual_native_stall_cancel_shutdown() {
    use std::{process::Command, thread, time::Instant};
    let service = std::env::var("KB_TEST_SECRET_SERVICE_PID").expect("owned test service pid");
    assert!(
        service.parse::<u32>().is_ok_and(|pid| pid > 1),
        "positive owned daemon pid required"
    );
    let signal = |name: &str| {
        assert!(
            Command::new("kill")
                .args([name, &service])
                .status()
                .unwrap()
                .success()
        )
    };
    // Observe the real native future after it has spawned its worker and
    // yielded pending; elapsed sleeps cannot establish this boundary.
    struct StartedNative<'a> {
        native: &'a NativeCredentials,
        started: RefCell<Option<tokio::sync::oneshot::Sender<()>>>,
        finished: Cell<bool>,
    }
    impl<'a> StartedNative<'a> {
        fn new(native: &'a NativeCredentials) -> (Self, tokio::sync::oneshot::Receiver<()>) {
            let (tx, rx) = tokio::sync::oneshot::channel();
            (
                Self {
                    native,
                    started: RefCell::new(Some(tx)),
                    finished: Cell::new(false),
                },
                rx,
            )
        }
    }
    impl Credentials for StartedNative<'_> {
        fn set(&self, account: &str, secret: &Secret) -> Result<(), StoreError> {
            self.native.set(account, secret)
        }
        fn get(&self, account: &str) -> Result<Secret, StoreError> {
            self.native.get(account)
        }
        fn delete(&self, account: &str) -> Result<(), StoreError> {
            self.native.delete(account)
        }
        fn get_controlled<'a>(
            &'a self,
            account: &'a str,
            ctl: &'a ProviderControl,
            fence: &'a kb_local::locks::CredentialFence,
        ) -> IoFuture<'a, Secret> {
            Box::pin(async move {
                let mut read = self.native.get_controlled(account, ctl, fence);
                std::future::poll_fn(|cx| {
                    let result = read.as_mut().poll(cx);
                    if result.is_pending() {
                        if let Some(tx) = self.started.borrow_mut().take() {
                            let _ = tx.send(());
                        }
                    } else {
                        self.finished.set(true);
                        drop(self.started.borrow_mut().take());
                    }
                    result
                })
                .await
            })
        }
    }
    let exe = std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("kb");
    let native = NativeCredentials::new(exe.clone());
    let (_fixture, s, _) = setup("native-lifecycle");
    let r = s
        .provider_register(&s.owner(), config(), Secret::new(CANARY.into()), &native)
        .unwrap();
    let root = s.paths().root().to_owned();
    let helper = exe.clone();
    let id = r.provider_id.clone();
    let (ready_tx, ready_rx) = std::sync::mpsc::channel();
    let (observed, started) = StartedNative::new(&native);
    let revoke = thread::spawn(move || {
        let other = Store::open(&root)?;
        let _ = ready_tx.send(());
        if started.blocking_recv().is_err() {
            return Err(kb_local::credentials::unavailable());
        }
        other.provider_revoke(&other.owner(), &id, &NativeCredentials::new(helper))
    });
    // Prepare the second handle before timing or stopping the service.
    let ready = ready_rx.recv_timeout(Duration::from_secs(15));
    signal("-STOP");
    let resume = Resume(service.clone());
    let checks = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        ready.unwrap();
        let start = Instant::now();
        let result = runtime().block_on(s.provider_probe(
            &s.owner(),
            &r.provider_id,
            1,
            &native,
            &PinnedEgress::new(&Resolver::new(&[]), &FakeHttp::default()),
            &ProviderControl::with_timeout(Duration::from_millis(250)),
        ));
        assert!(result.is_err());
        assert!(start.elapsed() < Duration::from_secs(2));
        // Independently coordinate concurrent revocation after a real native
        // read is pending. Commit latency is not promised to fit in 250ms.
        runtime().block_on(async {
            let owner = s.owner();
            let ctl = ProviderControl::default();
            let dns = Resolver::new(&[]);
            let http = FakeHttp::default();
            let e = PinnedEgress::new(&dns, &http);
            let (result, ()) = tokio::join!(
                s.provider_probe(&owner, &r.provider_id, 1, &observed, &e, &ctl),
                async {
                    let until = Instant::now() + Duration::from_secs(5);
                    while s
                        .provider_revision(&owner, &r.provider_id, 1)
                        .unwrap()
                        .state
                        != "REVOKED"
                    {
                        assert!(
                            Instant::now() < until,
                            "revocation must commit while native read is pending"
                        );
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                    assert!(
                        !observed.finished.get(),
                        "revocation must precede native completion"
                    );
                    assert!(s.provider_list(&owner, None, 20).is_ok()); // writer admitted during the native wait
                    ctl.cancel();
                }
            );
            assert!(result.is_err());
        });
    }));
    drop(observed); // Unblocks the owned revoker if admission never reached native I/O.
    drop(resume);
    let revoked = revoke.join(); // Always drain, including assertion failure.
    if let Err(panic) = checks {
        std::panic::resume_unwind(panic);
    }
    revoked.unwrap().unwrap();
    let r = s
        .provider_register(&s.owner(), config(), Secret::new(CANARY.into()), &native)
        .unwrap();
    signal("-STOP");
    let resume = Resume(service.clone());
    runtime().block_on(async {
        let owner = s.owner();
        let ctl = ProviderControl::default(); let dns = Resolver::new(&[]); let http = FakeHttp::default(); let e = PinnedEgress::new(&dns, &http);
        let (observed, started) = StartedNative::new(&native);
        let (result, ()) = tokio::join!(s.provider_probe(&owner, &r.provider_id, 1, &observed, &e, &ctl), async {
            tokio::time::timeout(Duration::from_secs(10), started).await.expect("native startup watchdog").expect("actual native read pending"); ctl.cancel();
        });
        assert!(matches!(result, Err(StoreError::OperationAborted(kb_client::ErrorCode::Cancelled))));
        let ctl = ProviderControl::default();
        let (observed, started) = StartedNative::new(&native);
        tokio::select! { biased; _=async { tokio::time::timeout(Duration::from_secs(10), started).await.expect("native startup watchdog").expect("actual native read pending"); }=>{}, _=s.provider_probe(&owner,&r.provider_id,1,&observed,&e,&ctl)=>panic!("stopped native service completed") }
    });
    drop(resume);
    s.provider_revoke(&s.owner(), &r.provider_id, &native)
        .unwrap();
}

#[cfg(target_os = "linux")]
#[test]
#[ignore = "script creates and owns the isolated Secret Service before selection"]
fn actual_native_crash_reentry_waits_for_native_effect_drain() {
    use std::{
        io::Write,
        process::{Command, Stdio},
        thread,
        time::Instant,
    };
    let service = std::env::var("KB_TEST_SECRET_SERVICE_PID").expect("owned test service pid");
    assert!(
        service.parse::<u32>().is_ok_and(|pid| pid > 1),
        "positive owned daemon pid required"
    );
    let signal = |name: &str| {
        assert!(
            Command::new("kill")
                .args([name, &service])
                .status()
                .unwrap()
                .success()
        )
    };
    // An account lock alone can still belong only to the CLI before spawn
    // or before its pipe writer runs. Require the owned native child to hold
    // its independently opened native fence AND connect to the isolated bus.
    fn native_child_started(owner: u32, account: &std::path::Path) -> Option<u32> {
        let mut children = std::collections::BTreeSet::new();
        if let Ok(tasks) = std::fs::read_dir(format!("/proc/{owner}/task")) {
            for task in tasks.flatten() {
                if let Ok(ids) = std::fs::read_to_string(task.path().join("children")) {
                    for pid in ids.split_whitespace().filter_map(|s| s.parse::<u32>().ok()) {
                        if let Ok(fds) = std::fs::read_dir(format!("/proc/{pid}/fd"))
                            && fds.flatten().any(|fd| {
                                std::fs::read_link(fd.path())
                                    .is_ok_and(|path| path == account.with_extension("native.lock"))
                            })
                        {
                            children.insert(pid);
                        }
                    }
                }
            }
        }
        if children.is_empty() {
            return None;
        }
        let query = |method: &str, argument: Option<String>| {
            let mut command = Command::new("dbus-send");
            command.args([
                "--session",
                "--type=method_call",
                "--print-reply",
                "--reply-timeout=1000",
                "--dest=org.freedesktop.DBus",
                "/org/freedesktop/DBus",
                method,
            ]);
            if let Some(argument) = argument {
                command.arg(argument);
            }
            command
                .output()
                .ok()
                .filter(|out| out.status.success())
                .and_then(|out| String::from_utf8(out.stdout).ok())
        };
        let names = query("org.freedesktop.DBus.ListNames", None)?;
        for name in names
            .lines()
            .filter_map(|line| line.trim().strip_prefix("string \"")?.strip_suffix('"'))
            .filter(|name| name.starts_with(':'))
        {
            if let Some(reply) = query(
                "org.freedesktop.DBus.GetConnectionUnixProcessID",
                Some(format!("string:{name}")),
            ) && let Some(pid) = reply
                .lines()
                .filter_map(|line| line.trim().strip_prefix("uint32 ")?.parse::<u32>().ok())
                .find(|pid| children.contains(pid))
            {
                return Some(pid);
            }
        }
        None
    }
    let exe = std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("kb");
    let native = NativeCredentials::new(exe.clone());
    let (f, s, _) = setup("native-crash");
    // Kill the production owner after durable identity and before native set returns.
    // The child owns only the native effect fence; matching replay reconciles that identity.
    let c = config();
    signal("-STOP");
    let resume = Resume(service.clone());
    let mut child = fixture::ChildGuard::spawn(
        Command::new(&exe)
            .args([
                "providers",
                "--root",
                s.paths().root().to_str().unwrap(),
                "--json",
                "register",
                "--idempotency-key",
                &c.idempotency_key,
                "--name",
                &c.name,
                "--endpoint",
                &c.endpoint_url,
                "--model",
                &c.model,
                "--dimensions",
                "2",
                "--key-stdin",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null()),
    )
    .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(CANARY.as_bytes())
        .unwrap();
    let crash_start = Instant::now();
    let (pending, worker) = loop {
        assert!(crash_start.elapsed() < Duration::from_secs(15));
        if let Some(row) = s
            .provider_list(&s.owner(), None, 20)
            .unwrap()
            .into_iter()
            .find(|r| r.state == "STORING")
        {
            let path = s
                .paths()
                .locks_dir()
                .join(format!("provider_{}_1.lock", row.provider_id));
            if let Some(pid) = native_child_started(child.id(), &path) {
                break (row, pid);
            }
        }
        thread::sleep(Duration::from_millis(10));
    };
    let lifecycle_path = s
        .paths()
        .locks_dir()
        .join(format!("provider_{}_1.lock", pending.provider_id));
    let native_path = lifecycle_path.with_extension("native.lock");
    assert!(
        Command::new("kill")
            .args(["-STOP", &worker.to_string()])
            .status()
            .unwrap()
            .success()
    );
    let mut resume_worker = Some(Resume(worker.to_string()));
    let mut resume_service = Some(resume);
    child.kill().unwrap();
    child.wait().unwrap();
    let lifecycle = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&lifecycle_path)
        .unwrap();
    lifecycle
        .try_lock()
        .expect("dead owner releases lifecycle lock");
    lifecycle.unlock().unwrap();
    // Lifecycle admission is already free, but the parked orphan still owns
    // the native effect fence. Observe that exclusion before resuming either
    // process, then wait for that SAME fence before the unfenced keystore read.
    // Switching this probe back to the lifecycle file fails deterministically.
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&native_path)
        .unwrap();
    let drain_start = Instant::now();
    let mut observed_parked = false;
    loop {
        match file.try_lock() {
            Ok(()) => {
                assert!(
                    observed_parked,
                    "drain must observe the parked native worker"
                );
                file.unlock().unwrap();
                break;
            }
            Err(std::fs::TryLockError::WouldBlock) => {
                if !observed_parked {
                    observed_parked = true;
                    drop(resume_service.take());
                    drop(resume_worker.take());
                }
            }
            Err(error) => panic!("native drain probe failed: {error}"),
        }
        assert!(drain_start.elapsed() < Duration::from_secs(5));
        thread::sleep(Duration::from_millis(10));
    }
    let pending_account = format!("{}-{}-1", s.store_uuid(), pending.provider_id);
    assert_eq!(native.get(&pending_account).unwrap().expose(), CANARY);
    let db = rusqlite::Connection::open(s.paths().state_db()).unwrap();
    db.execute_batch("CREATE TRIGGER native_finalize_fault BEFORE INSERT ON provider_events WHEN NEW.event='provider_create' AND (SELECT allow_loopback FROM provider_settings WHERE id=1)=0 BEGIN SELECT RAISE(ABORT,'fixture failure after native storage'); END;").unwrap();
    assert!(
        s.provider_register(&s.owner(), c.clone(), Secret::new(CANARY.into()), &native)
            .is_err()
    );
    assert_eq!(
        s.provider_revision(&s.owner(), &pending.provider_id, 1)
            .unwrap()
            .state,
        "STORING"
    );
    assert_eq!(native.get(&pending_account).unwrap().expose(), CANARY);
    s.provider_set_loopback(&s.owner(), true).unwrap();
    let done = s
        .provider_register(&s.owner(), c.clone(), Secret::new(CANARY.into()), &native)
        .unwrap();
    assert_eq!(done.provider_id, pending.provider_id);
    assert_eq!(done.operation_id, pending.operation_id);
    let replay = s
        .provider_register(&s.owner(), c, Secret::new(CANARY.into()), &native)
        .unwrap();
    assert_eq!(replay.operation_id, done.operation_id);
    // Delete-before-return is also recoverable after owner death; the durable
    // revoked fence remains authoritative while the account child drains.
    signal("-STOP");
    let resume = Resume(service.clone());
    let mut deletion = fixture::ChildGuard::spawn(
        Command::new(&exe)
            .args([
                "providers",
                "--root",
                s.paths().root().to_str().unwrap(),
                "revoke",
                done.provider_id.as_str(),
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null()),
    )
    .unwrap();
    let delete_start = Instant::now();
    loop {
        assert!(delete_start.elapsed() < Duration::from_secs(5));
        if s.provider_revision(&s.owner(), &done.provider_id, 1)
            .unwrap()
            .state
            == "REVOKED"
        {
            let path = s
                .paths()
                .locks_dir()
                .join(format!("provider_{}_1.lock", done.provider_id));
            if native_child_started(deletion.id(), &path).is_some() {
                break;
            }
        }
        thread::sleep(Duration::from_millis(10));
    }
    deletion.kill().unwrap();
    deletion.wait().unwrap();
    drop(resume);
    s.provider_revoke(&s.owner(), &done.provider_id, &native)
        .unwrap();
    let account = format!("{}-{}-1", s.store_uuid(), done.provider_id);
    assert!(native.get(&account).is_err());
    assert!(f.root.exists());
}

#[test]
fn concurrent_probe_admission_has_exactly_five_durable_charges() {
    use std::sync::{Arc, Barrier};
    let (f, s, k) = setup("probe-race");
    let r = register(&s, &k);
    let barrier = Arc::new(Barrier::new(7));
    let mut calls = Vec::new();
    for _ in 0..6 {
        let root = f.root.join("store");
        let id = r.provider_id.clone();
        let barrier = barrier.clone();
        calls.push(std::thread::spawn(move || {
            let s = Store::open(&root).unwrap();
            s.set_limits(
                kb_local::limits::LocalLimits::default()
                    .with_probe_limit(5)
                    .unwrap(),
            );
            s.set_cursor_clock_for_tests(2000);
            let keys = Keys::default();
            keys.values
                .borrow_mut()
                .insert(format!("{}-{}-1", s.store_uuid(), id), CANARY.into());
            let dns = Resolver::new(&[&["8.8.8.8"]]);
            let http = FakeHttp::default();
            barrier.wait();
            runtime().block_on(s.provider_probe(
                &s.owner(),
                &id,
                1,
                &keys,
                &PinnedEgress::new(&dns, &http),
                &Default::default(),
            ))
        }));
    }
    barrier.wait();
    let results = calls
        .into_iter()
        .map(|t| t.join().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        results
            .iter()
            .filter(|r| matches!(r, Err(StoreError::RateLimited(_))))
            .count(),
        1
    );
    let db = rusqlite::Connection::open(s.paths().state_db()).unwrap();
    assert_eq!(
        db.query_row("SELECT count(*) FROM provider_probe_charges", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        5
    );
    assert_eq!(
        db.query_row("SELECT attempt FROM provider_revisions", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        5
    );
}

// 57b: the shared provider boundary rejects the entire batch before keys/DNS/HTTP.
#[test]
fn credentials_rejected_and_sealed_redacted_at_actual_provider_dispatch() {
    let (_f, s, keys) = setup("safe-dispatch");
    let r = register(&s, &keys);
    let dns = Resolver::new(&[&["8.8.8.8"], &["8.8.8.8"]]);
    let http = FakeHttp::default();
    let egress = PinnedEgress::new(&dns, &http);
    runtime().block_on(async {
        probe(&s, &r, &keys, &egress).await.unwrap();
        let before = (keys.calls.get(), dns.0.borrow().len(), http.calls.borrow().len());
        for texts in [vec!["sk-fixture-canary-0123456789".into()],vec!["safe".into(),"Bearer synthetic-canary-12345678".into()]] {
            let error=s.provider_embed(&s.owner(),&r.provider_id,1,&texts,&keys,&egress,&Default::default()).await.unwrap_err();
            assert_eq!(error.protocol_code(),kb_client::ErrorCode::SensitiveQuery);
            assert!(!format!("{error:?} {error}").contains("canary"));
            assert_eq!((keys.calls.get(),dns.0.borrow().len(),http.calls.borrow().len()),before);
        }
        assert!(s.provider_embed(&s.owner(),&r.provider_id,1,&[],&keys,&egress,&Default::default()).await.unwrap().is_empty());
        assert_eq!(http.calls.borrow().len(),before.2);
        let symbol="{{sealed:v1:knowledge_base:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222}}";
        s.provider_embed(&s.owner(),&r.provider_id,1,&[format!("猫 {symbol}")],&keys,&egress,&Default::default()).await.unwrap();
        assert_eq!(http.calls.borrow().last().unwrap().3["input"],json!(["猫 [sealed value redacted]"]));
        let ctl=ProviderControl::default();ctl.cancel();
        assert!(s.provider_embed(&s.owner(),&r.provider_id,1,&["safe".into()],&keys,&egress,&ctl).await.is_err());
        assert_eq!(http.calls.borrow().len(),before.2+1);
        s.provider_revoke(&s.owner(),&r.provider_id,&keys).unwrap();
        assert!(s.provider_embed(&s.owner(),&r.provider_id,1,&["safe".into()],&keys,&egress,&Default::default()).await.is_err());
        assert_eq!(http.calls.borrow().len(),before.2+1);
    });
}
#[test]
fn provider_values_reach_the_index_as_exact_f64() {
    // None of these is representable as f32: an early `as f32` changes bits.
    for (wire, expected) in [
        (
            r#"{"data":[{"index":0,"embedding":[1.00000007,1]}]}"#,
            vec![1.000_000_07_f64, 1.],
        ),
        (
            r#"{"data":[{"index":0,"embedding":[0.1,0.3333333333333333,0.7]}]}"#,
            vec![0.1, 1. / 3., 0.7],
        ),
    ] {
        let body: Value = serde_json::from_str(wire).unwrap();
        let out = validate_embeddings(&body, 1, expected.len()).unwrap();
        assert_eq!(
            out[0].iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
            expected.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
            "{wire}"
        );
        assert!(
            out[0]
                .iter()
                .any(|v| f64::from(*v as f32).to_bits() != v.to_bits())
        );
    }
}
