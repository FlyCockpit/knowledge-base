//! Disposable native-key substitute only in this test binary. Domain, Git,
//! SQLite, crypto, egress and stdio are the production implementations.
use kb_client::{
    decode_input,
    sealed::RecipientKey,
    stdio::{serve, tool_error},
    types::*,
};
use kb_local::{
    PrincipalKind, Store, StoreError,
    credentials::{Credentials, Secret},
    dispatch::{DispatchIo, dispatch_with_io},
    egress::{Dns, Endpoint, Http, HttpResponse, IoFuture, PinnedEgress},
    providers::ProviderConfig,
    qwen::ModelRuntime,
    sealed::{Enroll, Grant, Literal},
};
use serde_json::json;
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
#[derive(Default)]
struct Keys(Mutex<BTreeMap<String, String>>);
impl Credentials for Keys {
    fn set(&self, a: &str, s: &Secret) -> Result<(), StoreError> {
        self.0
            .lock()
            .expect("keys")
            .insert(a.into(), s.expose().into());
        Ok(())
    }
    fn get(&self, a: &str) -> Result<Secret, StoreError> {
        self.0
            .lock()
            .expect("keys")
            .get(a)
            .cloned()
            .map(Secret::new)
            .ok_or_else(kb_local::credentials::unavailable)
    }
    fn delete(&self, a: &str) -> Result<(), StoreError> {
        self.0.lock().expect("keys").remove(a);
        Ok(())
    }
}
// Same deterministic host vectors as the server generation fixture. Network
// policy is independently covered by provider/egress suites; this test owns
// transport/domain/index/crypto behavior, not public DNS or TLS evidence.
struct FixtureIo;
impl Dns for FixtureIo {
    fn resolve<'a>(&'a self, _: &'a str, _: u16) -> IoFuture<'a, Vec<std::net::IpAddr>> {
        Box::pin(async { Ok(vec!["1.1.1.1".parse().expect("fixture IP")]) })
    }
}
impl Http for FixtureIo {
    fn post<'a>(
        &'a self,
        _: &'a Endpoint,
        _: std::net::SocketAddr,
        _: &'a Secret,
        body: Vec<u8>,
    ) -> IoFuture<'a, HttpResponse> {
        Box::pin(async move {
            let body: serde_json::Value = serde_json::from_slice(&body).expect("embedding request");
            let input = body["input"].as_array().expect("texts");
            Ok(HttpResponse{status:200,body:serde_json::to_vec(&json!({"data":input.iter().enumerate().map(|(index,_)|json!({"index":index,"embedding":[1.,0.]})).collect::<Vec<_>>()})).expect("embedding response")})
        })
    }
}
fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    let root = PathBuf::from(&args[3]);
    let endpoint = &args[5];
    let s = Store::open(&root)?;
    let owner = s.owner();
    let keys = Arc::new(Keys::default());
    let made=s.bases_create(&owner,decode_input::<BasesCreate>(json!({"name":"Rich","slug":"rich","description":"Rich parity fixture","idempotencyKey":"rich-create-key-001"}))?)?;

    let provider = s.provider_register(
        &owner,
        ProviderConfig {
            idempotency_key: "rich-provider-001".into(),
            provider_id: None,
            name: "Fixture".into(),
            endpoint_url: endpoint.into(),
            model: "fixture".into(),
            dimensions: 2,
        },
        Secret::new("disposable-parity-credential".into()),
        keys.as_ref(),
    )?;
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let dns = FixtureIo;
    let http = FixtureIo;
    let egress = PinnedEgress::new(&dns, &http);
    rt.block_on(s.provider_probe(
        &owner,
        &provider.provider_id,
        1,
        keys.as_ref(),
        &egress,
        &kb_local::embedder::ProviderControl::default(),
    ))?;
    let guard = s.lock_write(std::slice::from_ref(&made.kb.id))?;
    let proposer = s.register_principal(
        &guard,
        PrincipalKind::Test,
        &made.kb.id,
        &[Permission::Propose],
    )?;
    let manager = s.register_principal(
        &guard,
        PrincipalKind::Test,
        &made.kb.id,
        &[Permission::Manage],
    )?;
    let actor = if args.iter().any(|arg| arg == "--narrow-manager") {
        manager
    } else {
        owner.clone()
    };
    drop(guard);
    let recipient =
        RecipientKey::from_bytes("00000000-0000-4000-8000-000000000003".parse()?, [2; 32]);
    let enrolled = s.sealed_enroll(
        &owner,
        &made.kb.id,
        Enroll {
            idempotency_key: "rich-sealed-enroll".into(),
            record_id: None,
        },
        Literal::from_utf8("disposable-sealed-parity-canary".into())?,
        keys.as_ref(),
    )?;
    let reference = enrolled.reference;
    s.sealed_grant(
        &owner,
        &made.kb.id,
        Grant {
            idempotency_key: "rich-sealed-grant".into(),
            reference: reference.parse()?,
            consumer_id: owner.id().into(),
            recipient_key_id: recipient.id().clone(),
            recipient_public_key: recipient.public_key_base64(),
            expires_at: "2099-01-01T00:00:00Z".parse()?,
        },
    )?;
    let db = rusqlite::Connection::open(s.paths().state_db())?;
    // Out-of-band fixture setup of an owned USER branch, exactly as PR tests.
    let git = std::process::Command::new("git")
        .arg("--git-dir")
        .arg(s.paths().repo_dir(&made.kb.id))
        .args([
            "update-ref",
            "refs/heads/users/topic",
            made.kb.head_sha.as_str(),
        ])
        .status()?;
    if !git.success() {
        return Err("fixture branch failed".into());
    }
    db.execute(
        "INSERT INTO branch_owners VALUES (?1,'refs/heads/users/topic',?2,'USER','fixture')",
        (made.kb.id.as_str(), owner.actor_key()),
    )?;
    if args
        .windows(2)
        .any(|pair| pair == ["--builtin-state", "loading"])
    {
        // No model bytes or native inference: pin the initial load's state.
        db.execute(
            "UPDATE builtin_model SET enabled=1,reloading=1 WHERE id=1",
            [],
        )?;
    }
    drop(db);
    let exe = std::env::current_exe()?
        .parent()
        .ok_or("fixture executable directory")?
        .join("kb");
    let model_root = s
        .paths()
        .root()
        .parent()
        .ok_or("fixture store parent")?
        .join("model-host");
    let model = Arc::new(ModelRuntime::new(
        &s,
        kb_local::qwen::ModelHost::new(
            exe,
            model_root.join("r"),
            model_root.join("m"),
            Duration::from_secs(5),
        )?,
    )?);
    use std::io::Write;
    writeln!(
        std::io::stdout(),
        "{}",
        json!({"jsonrpc":"2.0","id":"fixture","result":{"providerId":provider.provider_id,"proposer":proposer.id(),"reference":reference,"recipientKeyId":recipient.id(),"recipientPublicKey":recipient.public_key_base64(),"kb":made.kb}})
    )?;
    drop(s);
    // Calls run on the serving runtime, like `kb mcp`: none builds its own.
    let handle = rt.handle().clone();
    let result = rt.block_on(serve(
        tokio::io::stdin(),
        tokio::io::stdout(),
        move |name, input, control| {
            let work = || -> Result<_, Box<dyn std::error::Error>> {
                let s = Store::open(&root)?;
                let rt = &handle;
                let dns = FixtureIo;
                let http = FixtureIo;
                let egress = PinnedEgress::new(&dns, &http);
                let io = DispatchIo {
                    keys: keys.as_ref(),
                    egress: &egress,
                    model: &model,
                    kbs: None,
                };
                let response =
                    rt.block_on(dispatch_with_io(&s, &actor, name, input, &control, &io));
                // Shared deterministic fixture vectors and production builder; immutable job
                // snapshots are used even though this fixture drives delivery inline.
                while let Some(id) = s.pending_generation(None)? {
                    let a = s.claim_generation(&id, Duration::from_secs(60))?;
                    rt.block_on(s.build_index(
                        a,
                        kb_local::index::IndexEmbedder::External {
                            keys: keys.as_ref(),
                            egress: &egress,
                        },
                    ))?;
                }
                Ok(response)
            };
            work().unwrap_or_else(|_| tool_error(kb_client::ErrorCode::Internal, json!({})))
        },
    ));
    rt.shutdown_timeout(Duration::ZERO);
    result?;
    Ok(())
}
fn main() {
    if run().is_err() {
        std::process::exit(1)
    }
}
