//! The shared retrieval-quality corpus through the real build and
//! search pipeline (TS twin `index-file/retrieval-quality.test.ts`; the real
//! Gemma lane is `qwen_model::gemma_retrieval_quality`).
#[path = "support/retrieval.rs"]
mod retrieval;
#[path = "support/search_fixture.rs"]
mod search_support;
use kb_client::types::SearchMode;
use search_support::Fixture;

fn assert_lane(score: &retrieval::Score, c: &serde_json::Value, lane: &str) {
    let (h1, h3, k1) = retrieval::thresholds(c, lane);
    assert!(
        score.semantic_hit1 >= h1 && score.semantic_hit3 >= h3 && score.keyword_hit1 >= k1,
        "{lane}: {score}"
    );
}

#[tokio::test]
async fn hybrid_replay_of_the_recorded_vector_ranking_keeps_semantic_hits_first() {
    let c = retrieval::retrieval_corpus();
    let f = Fixture::new(retrieval::paths(&c).len());
    retrieval::publish_corpus(&f, &c);
    retrieval::build_hybrid(&f, async |_, texts| {
        Ok(texts
            .iter()
            .map(|t| retrieval::replay_document(&c, t))
            .collect())
    })
    .await;
    let score = retrieval::score(
        &f,
        &c,
        async |_, q| Ok(retrieval::replay_query(&c, q)),
        SearchMode::Hybrid,
    )
    .await;
    assert_lane(&score, &c, "replay");
}

#[tokio::test]
async fn lexical_only_keyword_queries_rank_their_note_first() {
    let c = retrieval::retrieval_corpus();
    let f = Fixture::new(2);
    retrieval::publish_corpus(&f, &c);
    retrieval::build_lexical_only(&f).await;
    let score = retrieval::score(
        &f,
        &c,
        async |_, _| -> Result<Vec<f64>, kb_local::StoreError> {
            panic!("a lexical generation never embeds the query")
        },
        SearchMode::Lexical,
    )
    .await;
    assert_lane(&score, &c, "lexical");
}
