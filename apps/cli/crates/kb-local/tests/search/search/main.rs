//! Task 60: spec-first tests against real Git, SQLite FTS5 and sqlite-vec.
#[path = "../../support/model_admission.rs"]
mod model_admission;
#[path = "../../support/model_host.rs"]
mod model_host;
#[path = "../../support/search_fixture.rs"]
mod support;
use kb_client::tools::{IndexRebuild, KnowledgeSearch, StructuredSearch};
use kb_client::{
    ErrorCode,
    host::snapshot::{content_hash, git_blob_sha},
    types::*,
};
use kb_local::{
    StoreError,
    search::{SearchControl, SearchStage, fuse_ranks},
};
use serde_json::json;
use std::time::Duration;
use support::*;

fn lexical_notice(f: &Fixture, detail: LexicalOnlyReason) -> Vec<IndexNotice> {
    vec![IndexNotice::LexicalOnly(LexicalOnlyNotice {
        kb_id: f.kb.clone(),
        code: LexicalOnlyCode,
        detail,
    })]
}

mod builtin;
mod degradation;
mod external;
mod lexical;
mod ranking;
mod repair;
mod runtime;
