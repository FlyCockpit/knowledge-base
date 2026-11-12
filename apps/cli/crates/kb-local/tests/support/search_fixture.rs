//! Shared golden corpora, real Git/SQLite, deterministic host embedder.
#![allow(dead_code)]
#[path = "index_fixture.rs"]
mod index;
pub use index::*;
use kb_client::types::*;
use kb_local::{CommitRequest, FileChange, LocalPrincipal};
use kb_local::{
    StoreError,
    search::{SearchControl, SearchStage},
};
use serde_json::{Value, json};
impl Fixture {
    pub async fn query(&self, extra: Value) -> Result<SearchOutput, StoreError> {
        self.store
            .search_generation(
                &self.store.owner(),
                input(self, extra),
                &SearchControl::default(),
                async |_, text| Ok(vector(text)),
                &mut |_| Ok(()),
            )
            .await
    }
    pub async fn filter(&self, extra: Value) -> Result<StructuredSearchOutput, StoreError> {
        self.filter_as(&self.store.owner(), extra, &mut |_| Ok(()))
            .await
    }
    pub async fn filter_as(
        &self,
        p: &LocalPrincipal,
        extra: Value,
        observer: &mut dyn FnMut(SearchStage) -> Result<(), StoreError>,
    ) -> Result<StructuredSearchOutput, StoreError> {
        let queried = extra.get("query").is_some();
        self.store
            .structured_search_generation(
                p,
                structured(self, extra),
                &SearchControl::default(),
                async |_, text| {
                    assert!(queried, "queryless must not embed");
                    Ok(vector(text))
                },
                observer,
            )
            .await
    }
    pub fn cited(&self, h: &CitationHit) -> Document {
        self.store
            .documents_get(
                &self.store.owner(),
                DocumentsGetInput {
                    kb_id: self.kb.clone(),
                    rev: Some(h.commit_sha.clone()),
                    path: h.path.clone(),
                },
            )
            .expect("valid fixture")
    }
}
pub fn corpus(name: &str) -> Value {
    serde_json::from_slice(
        &std::fs::read(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../../../packages/api/src/lib/kb/fixtures")
                .join(format!("{name}.json")),
        )
        .expect("valid fixture"),
    )
    .expect("valid fixture")
}
pub fn vector(text: &str) -> Vec<f64> {
    vec![
        1. + text.matches("alpha").count() as f64,
        1. + text.matches("beta").count() as f64,
    ]
}
/// Normalized hybrid score of a golden row (L-25: RRF sum * 61 / 2 arms).
pub fn score(w: &Value) -> f64 {
    let rrf: f64 = ["vectorRank", "ftsRank"]
        .iter()
        .filter_map(|k| w[k].as_u64())
        .map(|r| 1. / (60. + r as f64))
        .sum();
    kb_local::search::normalized_score(rrf, 2.)
}
pub fn input(f: &Fixture, extra: Value) -> SearchInput {
    let mut v = json!({"kbId":f.kb,"query":"alpha"});
    v.as_object_mut()
        .expect("valid fixture")
        .extend(extra.as_object().expect("valid fixture").clone());
    serde_json::from_value(v).expect("valid fixture")
}
pub fn structured(f: &Fixture, extra: Value) -> StructuredSearchInput {
    let mut v = json!({"kbId":f.kb});
    v.as_object_mut()
        .expect("valid fixture")
        .extend(extra.as_object().expect("valid fixture").clone());
    serde_json::from_value(v).expect("valid fixture")
}
pub fn publish(f: &Fixture, docs: Vec<(&str, Option<String>)>, key: &str) {
    let head = Sha::parse(
        &f.store
            .kb(&f.kb)
            .expect("valid fixture")
            .expect("valid fixture")
            .head_sha
            .expect("valid fixture"),
    )
    .expect("valid fixture");
    f.store
        .commit_files(
            &f.store.owner(),
            CommitRequest {
                kb: f.kb.clone(),
                base_revision: head,
                idempotency_key: key.into(),
                changes: docs
                    .into_iter()
                    .map(|(path, content)| FileChange {
                        path: path.into(),
                        content: content.map(String::into_bytes),
                    })
                    .collect(),
            },
        )
        .expect("valid fixture");
}
pub async fn ready(f: &Fixture) -> KbId {
    let job = f.set("search-profile-0001");
    build_semantic(f, &job.generation_id).await;
    job.generation_id
}
/// Builds and activates the semantic generation `id` after its companion.
pub async fn build_semantic(f: &Fixture, id: &KbId) {
    f.settle_companion(id).await;
    let a = f
        .store
        .claim_generation(id, std::time::Duration::from_secs(120))
        .expect("valid fixture");
    let b = f
        .store
        .build_generation(
            a,
            async |_, texts| Ok(texts.iter().map(|s| vector(s)).collect()),
            &mut |_| Ok(()),
        )
        .await
        .expect("valid fixture");
    assert!(f.store.activate_built(b).expect("valid fixture"));
}
pub fn load(f: &Fixture, name: &str) -> Value {
    let v = corpus(name);
    let docs = v["documents"].as_object().expect("valid fixture");
    if let Some(assets) = v["assets"].as_array() {
        for a in assets {
            f.db()
                .execute(
                    "INSERT INTO asset_blobs VALUES(?1,?2,?3,'fixture')",
                    rusqlite::params![
                        a["hash"].as_str().expect("valid fixture"),
                        a["size"].as_i64().expect("valid fixture"),
                        a["mime"].as_str().expect("valid fixture")
                    ],
                )
                .expect("valid fixture");
            f.db().execute("INSERT INTO kb_asset_lineage(kb_id,hash,actor_key,source) VALUES(?1,?2,'fixture','UPLOAD')",(f.kb.as_str(),a["hash"].as_str().expect("valid fixture"))).expect("valid fixture");
        }
        let entries = assets
            .iter()
            .map(|a| kb_local::tree::ManifestEntry {
                path: a["path"].as_str().expect("valid fixture").into(),
                hash: a["hash"].as_str().expect("valid fixture").into(),
                size: a["size"].as_u64().expect("valid fixture"),
                mime: a["mime"].as_str().expect("valid fixture").into(),
            })
            .collect::<Vec<_>>();
        let md = String::from_utf8(kb_local::tree::canonical_manifest_bytes(&entries))
            .expect("valid fixture");
        publish(
            f,
            vec![(".assets/manifest.json", Some(md))],
            "search-corpus-manifest",
        );
    }
    publish(
        f,
        vec![("index.md", Some(String::new()))],
        "search-empty-root",
    );
    for (n, batch) in docs.iter().collect::<Vec<_>>().chunks(8).enumerate() {
        publish(
            f,
            batch
                .iter()
                .map(|(p, s)| {
                    let mut s = s.as_str().expect("valid fixture").to_owned();
                    // Fixture commit's fallback timestamp, independent of wall clock.
                    if name == "structured-search" && !s.starts_with("---") && !s.is_empty() {
                        s = format!(
                            "---\nvalid_from: \"{}\"\n---\n{s}",
                            v["commitTimestamp"].as_str().expect("valid fixture")
                        );
                    }
                    (p.as_str(), Some(s))
                })
                .collect(),
            &format!("search-corpus-batch-{n:04}"),
        );
    }
    v
}
pub fn reader(f: &Fixture) -> LocalPrincipal {
    let id = "11111111-1111-4111-8111-111111111111";
    f.db()
        .execute(
            "INSERT INTO principal_ceilings(principal_id,kind,kb_id,bits) VALUES(?1,'TEST',?2,1)",
            (id, f.kb.as_str()),
        )
        .expect("valid fixture");
    f.store.principal(id).expect("valid fixture")
}
pub fn no_leases(f: &Fixture) {
    assert_eq!(
        f.db()
            .query_row("SELECT count(*) FROM generation_leases", [], |r| r
                .get::<_, i64>(0))
            .expect("valid fixture"),
        0
    );
}
