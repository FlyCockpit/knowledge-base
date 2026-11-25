//! Real SQLite and activation boundaries; trusted deterministic embedder only.
#[path = "../../support/model_admission.rs"]
mod model_admission;
#[path = "../../support/model_host.rs"]
mod model_host;
#[path = "../../support/index_fixture.rs"]
mod support;
use kb_client::tools::{EmbeddingProfileGet, EmbeddingProfileSet, IndexStatusGet};
use kb_client::types::*;
use kb_local::{StoreError, index::BuildStage};
use rusqlite::Connection;
use serde_json::json;
use std::time::Duration;
use support::*;

/// Near-unit raw vector (norm ≈ 1.0000000353) whose int8 bytes differ when a
/// unit vector is normalized a second time: once ⇒ [127×7, 11], twice ⇒
/// [127×7, 10] (scale = its own 0.37778… component).
const TWICE_SENSITIVE: [f64; 8] = [
    0.377_780_079_841_613_77,
    0.377_780_079_841_613_77,
    0.377_780_079_841_613_77,
    0.377_780_079_841_613_77,
    0.377_780_079_841_613_77,
    0.377_780_079_841_613_77,
    0.377_780_079_841_613_77,
    0.031_233_789_399_266_243,
];
fn fnv(text: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in text.bytes() {
        h = (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3);
    }
    h
}
/// FNV-1a's low bit is a byte-parity sum; use a high bit.
fn is_twice_sensitive(h: u64) -> bool {
    (h >> 61) & 1 == 0
}

/// Nothing semantic serves: no active generation, or only the lexical
/// companion that keeps the KB searchable.
fn no_semantic_active(f: &Fixture) -> bool {
    let record = f.store.kb(&f.kb).expect("kb").expect("kb");
    record.active_generation_id.is_none_or(|id| {
        f.store
            .generation_snapshot(&id)
            .expect("snapshot")
            .is_lexical()
    })
}

mod embedding;
mod files;
mod jobs;
mod state_machine;
