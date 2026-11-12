//! Shared retrieval-quality corpus (`fixtures/retrieval-quality.json`,
//! TS twin `index-file/retrieval-quality.test.ts`): the real build and search
//! pipeline over 25 notes, scored by hit@1/hit@3 for semantic and keyword
//! queries. The embedders are the lane's: a one-hot replay of the recorded
//! Gemma vector ranking in CI, the real model in the `qwen_model` lane.
#![allow(dead_code)]
use super::search_support::*;
use kb_client::types::*;
use kb_local::{
    StoreError,
    generations::ProfileSnapshot,
    search::{SearchControl, fuse_ranks},
};
use serde_json::{Value, json};

#[derive(Debug, Default)]
pub struct Score {
    pub semantic_hit1: usize,
    pub semantic_hit3: usize,
    pub keyword_hit1: usize,
    pub misses: Vec<String>,
}
impl std::fmt::Display for Score {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "semantic hit@1 {} hit@3 {} keyword hit@1 {}; misses: {:#?}",
            self.semantic_hit1, self.semantic_hit3, self.keyword_hit1, self.misses
        )
    }
}
pub fn retrieval_corpus() -> Value {
    corpus("retrieval-quality")
}
/// Every (query, target) pair: semantic first, then keyword.
pub fn queries(c: &Value) -> Vec<(String, String, bool)> {
    let pairs = |key: &str, semantic: bool| {
        c[key]
            .as_array()
            .expect("query set")
            .iter()
            .map(move |q| {
                (
                    q["query"].as_str().expect("query").to_owned(),
                    q["target"].as_str().expect("target").to_owned(),
                    semantic,
                )
            })
            .collect::<Vec<_>>()
    };
    let mut all = pairs("semantic", true);
    all.extend(pairs("keyword", false));
    all
}
pub fn paths(c: &Value) -> Vec<String> {
    let mut paths = c["documents"]
        .as_object()
        .expect("documents")
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    paths.sort();
    paths
}
/// The corpus document a chunk text comes from (each note is one chunk).
pub fn document_of(c: &Value, text: &str) -> usize {
    // Chunk text normalizes whitespace; every note starts with a unique heading.
    let docs = c["documents"].as_object().expect("documents");
    paths(c)
        .iter()
        .position(|p| {
            let heading = docs[p]
                .as_str()
                .expect("text")
                .lines()
                .next()
                .unwrap_or_default();
            text.trim_start().starts_with(&format!("{heading} ")) || text.trim() == heading
        })
        .unwrap_or_else(|| panic!("chunk of no corpus note: {text:?}"))
}
/// Publishes the corpus (batches of 8, the fixture commit size).
pub fn publish_corpus(f: &Fixture, c: &Value) {
    let docs = c["documents"].as_object().expect("documents");
    for (n, batch) in docs.iter().collect::<Vec<_>>().chunks(8).enumerate() {
        publish(
            f,
            batch
                .iter()
                .map(|(p, s)| (p.as_str(), Some(s.as_str().expect("text").to_owned())))
                .collect(),
            &format!("retrieval-corpus-{n:04}"),
        );
    }
}
/// Builds and activates the hybrid generation with `embed` for documents.
pub async fn build_hybrid(
    f: &Fixture,
    embed: impl AsyncFnMut(&ProfileSnapshot, &[String]) -> Result<Vec<Vec<f64>>, StoreError>,
) {
    let job = f.set("retrieval-profile-0001");
    f.settle_companion(&job.generation_id).await;
    let a = f
        .store
        .claim_generation(&job.generation_id, std::time::Duration::from_secs(600))
        .expect("claim");
    let b = f
        .store
        .build_generation(a, embed, &mut |_| Ok(()))
        .await
        .expect("build");
    assert!(f.store.activate_built(b).expect("activate"));
}
/// Builds and activates the lexical-only generation of a profileless KB.
pub async fn build_lexical_only(f: &Fixture) {
    let id = f
        .status()
        .desired_generation_id
        .expect("lexical generation");
    let a = f
        .store
        .claim_generation(&id, std::time::Duration::from_secs(120))
        .expect("claim");
    assert!(a.snapshot().is_lexical());
    let b = f
        .store
        .build_generation(
            a,
            async |_, _| -> Result<Vec<Vec<f64>>, StoreError> { panic!("lexical never embeds") },
            &mut |_| Ok(()),
        )
        .await
        .expect("build");
    assert!(f.store.activate_built(b).expect("activate"));
}
/// Runs every query through `search_generation` and scores the ranking.
pub async fn score(
    f: &Fixture,
    c: &Value,
    mut embed: impl AsyncFnMut(&ProfileSnapshot, &str) -> Result<Vec<f64>, StoreError>,
    expected_mode: SearchMode,
) -> Score {
    let mut s = Score::default();
    for (query, target, semantic) in queries(c) {
        let out = f
            .store
            .search_generation(
                &f.store.owner(),
                input(f, json!({"query":query,"limit":10})),
                &SearchControl::default(),
                &mut embed,
                &mut |_| Ok(()),
            )
            .await
            .expect("search");
        assert!(
            out.results.iter().all(|h| h.mode == expected_mode),
            "{query}"
        );
        let got = out
            .results
            .iter()
            .map(|h| h.path.as_str())
            .collect::<Vec<_>>();
        let hit1 = got.first() == Some(&target.as_str());
        if semantic {
            s.semantic_hit1 += usize::from(hit1);
            s.semantic_hit3 += usize::from(got.iter().take(3).any(|p| *p == target));
        } else {
            s.keyword_hit1 += usize::from(hit1);
        }
        if !hit1 {
            s.misses
                .push(format!("{query} -> {:?}", &got[..got.len().min(3)]));
        }
    }
    s
}
/// One-hot document vectors and query vectors weighted by the recorded
/// vector rank: cosine order equals the recorded order, distinct after int8.
pub fn replay_document(c: &Value, text: &str) -> Vec<f64> {
    let mut v = vec![0.; paths(c).len()];
    v[document_of(c, text)] = 1.;
    v
}
pub fn replay_query(c: &Value, query: &str) -> Vec<f64> {
    let all = paths(c);
    let ranking = c["vectorRanking"][query]
        .as_array()
        .unwrap_or_else(|| panic!("no recorded ranking for {query}"));
    assert_eq!(ranking.len(), all.len(), "{query}");
    let mut v = vec![0.; all.len()];
    for (rank, p) in ranking.iter().enumerate() {
        let at = all
            .iter()
            .position(|x| x == p.as_str().expect("path"))
            .expect("ranked corpus path");
        v[at] = (all.len() - rank) as f64;
    }
    v
}
pub fn thresholds(c: &Value, lane: &str) -> (usize, usize, usize) {
    let t = &c["thresholds"][lane];
    let get = |k: &str| t[k].as_u64().unwrap_or_else(|| panic!("{lane}.{k}")) as usize;
    (get("semanticHit1"), get("semanticHit3"), get("keywordHit1"))
}
/// The vector arm alone (exact cosine over the raw vectors), best first.
pub fn vector_order(docs: &[Vec<f64>], query: &[f64]) -> Vec<usize> {
    let unit = |v: &[f64]| {
        let n = v.iter().map(|x| x * x).sum::<f64>().sqrt();
        v.iter().map(|x| x / n).collect::<Vec<_>>()
    };
    let q = unit(query);
    let mut scored = docs
        .iter()
        .enumerate()
        .map(|(i, d)| (i, unit(d).iter().zip(&q).map(|(a, b)| a * b).sum::<f64>()))
        .collect::<Vec<_>>();
    scored.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
    // `fuse_ranks` is the fusion both lanes use; one arm keeps the order.
    let arm = scored
        .iter()
        .map(|(i, _)| (i.to_string(), 0))
        .collect::<Vec<_>>();
    fuse_ranks(&[arm])
        .into_iter()
        .map(|(i, _, _)| i.parse().expect("index"))
        .collect()
}
