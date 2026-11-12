//! Real on-disk state, Git and SQLite generation fixture.
#![allow(dead_code)]
use kb_client::types::*;
use kb_local::{CreateKbRequest, Store, generations::BuiltGeneration};
use rusqlite::Connection;
use serde_json::json;
use std::{path::PathBuf, time::Duration};
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("valid fixture")
        .as_millis() as u64
}
/// The active generation when it is semantic: a lexical companion
/// keeping the KB searchable does not count.
pub fn semantic_active(store: &Store, kb: &KbId) -> Option<KbId> {
    let id = store
        .kb(kb)
        .expect("kb")
        .expect("kb")
        .active_generation_id?;
    (!store
        .generation_snapshot(&id)
        .expect("snapshot")
        .is_lexical())
    .then_some(id)
}
pub fn check<T: Tool>(v: &T::Output) {
    kb_client::encode_output::<T>(v).expect("valid fixture");
}
pub struct Fixture {
    pub root: PathBuf,
    pub store: Store,
    pub kb: KbId,
    pub provider: KbId,
    _cleanup: Cleanup,
}
impl Fixture {
    pub fn new(dims: usize) -> Self {
        let root = std::env::temp_dir().join(format!(
            "kb-index-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("valid fixture")
                .as_nanos()
        ));
        let store = Store::open(&root).expect("valid fixture");
        let kb = store
            .create_kb(
                &store.owner(),
                CreateKbRequest {
                    name: "Index tests".into(),
                    slug: "index-tests".into(),
                    description: "Real generation fixture".into(),
                    idempotency_key: "create-index-0001".into(),
                },
            )
            .expect("valid fixture")
            .kb_id;
        let provider = KbId::parse(&"p".repeat(24)).expect("valid fixture");
        let db = Connection::open(store.paths().state_db()).expect("valid fixture");
        db.execute(
            "INSERT INTO providers(id,name) VALUES(?1,'Fixture')",
            [provider.as_str()],
        )
        .expect("valid fixture");
        db.execute("INSERT INTO provider_revisions(provider_id,revision,endpoint_url,model,dimensions,fingerprint,state) VALUES(?1,1,'https://example.invalid/embeddings','fixture',?2,?3,'READY')",rusqlite::params![provider.as_str(),dims as i64,format!("sha256:{}","a".repeat(64))]).expect("valid fixture");
        db.execute("INSERT INTO provider_registrations(operation_id,idempotency_key,request_mac,provider_id,revision) VALUES(?1,'fixture-register-0001',zeroblob(32),?2,1)",(store.owner().id(),provider.as_str())).expect("valid fixture");
        Self {
            _cleanup: Cleanup(root.clone()),
            root,
            store,
            kb,
            provider,
        }
    }
    /// Attaches the fixture provider and builds the lexical companion the
    /// semantic generation waits for, so the job is claimable at once.
    pub fn set(&self, key: &str) -> ProfileSetOutput {
        let job = self.set_raw(key);
        self.settle_companion_blocking(&job.generation_id);
        job
    }
    /// The profile set alone: a companion (if any) stays PENDING.
    pub fn set_raw(&self, key: &str) -> ProfileSetOutput {
        self.store.embedding_profile_set(&self.store.owner(),serde_json::from_value(json!({"kbId":self.kb,"providerId":self.provider,"revision":1,"idempotencyKey":key,"confirm":"RUN"})).expect("valid fixture")).expect("valid fixture")
    }
    /// [`Fixture::settle_companion`] from synchronous fixture code: a second
    /// store handle on its own thread and runtime.
    pub fn settle_companion_blocking(&self, id: &KbId) {
        let paths = self.store.paths().clone();
        let uuid = self.store.store_uuid().clone();
        let kb = self.kb.clone();
        let provider = self.provider.clone();
        let root = self.root.clone();
        let id = id.clone();
        std::thread::spawn(move || {
            let store = Store::reopen(&paths, &uuid).expect("second handle");
            let f = Fixture {
                root,
                store,
                kb,
                provider,
                _cleanup: Cleanup(PathBuf::new()),
            };
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("runtime")
                .block_on(f.settle_companion(&id));
        })
        .join()
        .expect("companion thread");
    }
    pub fn rebuild(&self, key: &str) -> GenerationJobOutput {
        let job = self
            .store
            .index_rebuild(
                &self.store.owner(),
                serde_json::from_value(
                    json!({"kbId":self.kb,"idempotencyKey":key,"confirm":"RUN"}),
                )
                .expect("valid fixture"),
            )
            .expect("valid fixture");
        self.settle_companion_blocking(&job.generation_id);
        job
    }
    pub fn status(&self) -> IndexStatus {
        self.store
            .index_status_get(
                &self.store.owner(),
                KbRef {
                    kb_id: self.kb.clone(),
                },
            )
            .expect("valid fixture")
    }
    pub fn db(&self) -> Connection {
        Connection::open(self.store.paths().state_db()).expect("valid fixture")
    }
    /// A semantic generation is claimed only after its lexical companion
    /// (if any) built; positive fixtures build and activate it first.
    pub async fn settle_companion(&self, id: &KbId) {
        let Ok(s) = self.store.generation_snapshot(id) else {
            return;
        };
        let companion: Option<String> = self
            .db()
            .query_row(
                "SELECT id FROM index_generations WHERE kb_id=?1 AND epoch=?2 AND state='PENDING' AND json_type(snapshot_json,'$.profile') IS NOT 'object'",
                (s.kb_id.as_str(), s.epoch - 1),
                |r| r.get(0),
            )
            .ok();
        let Some(companion) = companion else { return };
        let companion = KbId::parse(&companion).expect("companion id");
        // Best effort: a KB whose companion cannot build (tombstoned, ...)
        // leaves the semantic claim to fail on its own.
        let Ok(a) = self
            .store
            .claim_generation(&companion, Duration::from_secs(120))
        else {
            return;
        };
        let built = self
            .store
            .build_generation(
                a,
                async |_, _| -> Result<Vec<Vec<f64>>, kb_local::StoreError> {
                    panic!("a lexical companion never embeds")
                },
                &mut |_| Ok(()),
            )
            .await
            .expect("companion build");
        self.store
            .activate_built(built)
            .expect("companion activation");
    }
    pub async fn build(&self, id: &KbId) -> BuiltGeneration {
        self.settle_companion(id).await;
        let a = self
            .store
            // Positive fixture construction uses the CLI worker's build budget.
            // Deadline/cancellation tests claim their own shorter attempts;
            // shared-disk fsync time must not invalidate a retention fixture.
            .claim_generation(id, Duration::from_secs(120))
            .expect("valid fixture");
        self.store
            .build_generation(
                a,
                async |pin, texts| Ok(texts.iter().map(|_| vec![1.; pin.dimensions]).collect()),
                &mut |_| Ok(()),
            )
            .await
            .expect("valid fixture")
    }
}
struct Cleanup(PathBuf);
impl Drop for Cleanup {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
        // A fake shared-worker host (`model_host::seeded`) beside the store.
        if !self.0.as_os_str().is_empty() {
            let _ = std::fs::remove_dir_all(self.0.with_extension("model"));
            #[cfg(unix)]
            for top in [self.0.clone(), self.0.with_extension("model")] {
                remove_short_runtime_dirs(&top);
            }
        }
    }
}

/// Remove the short shared-worker runtime dirs (`model_host::runtime_dir`)
/// of fixtures rooted at the temp entry `top`.
#[cfg(unix)]
pub fn remove_short_runtime_dirs(top: &std::path::Path) {
    let hash = top
        .as_os_str()
        .as_encoded_bytes()
        .iter()
        .fold(0xcbf2_9ce4_8422_2325_u64, |h, b| {
            (h ^ u64::from(*b)).wrapping_mul(0x0100_0000_01b3)
        });
    let prefix = format!("kbr-{hash:016x}-");
    if let Ok(entries) = std::fs::read_dir("/tmp") {
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().starts_with(&prefix) {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }
}
