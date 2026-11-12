//! Task 58 executable contract fixture.
//! Required explicit lane: missing weights are failures, never conditional skip.
use kb_local::{
    Store,
    qwen::{ModelRuntime, Purpose, descriptor},
};
use std::{path::PathBuf, time::Duration};
mod support {
    pub mod fixture;
    pub mod model_host;
}
use support::fixture::Fixture;
#[path = "support/retrieval.rs"]
mod retrieval;
#[path = "support/search_fixture.rs"]
mod search_support;
fn cosine(a: &[f32], b: &[f32]) -> f64 {
    assert_eq!(a.len(), b.len(), "reference dimensions must match");
    a.iter()
        .zip(b)
        .map(|(x, y)| f64::from(*x) * f64::from(*y))
        .sum::<f64>()
        / (a.iter().map(|x| f64::from(*x).powi(2)).sum::<f64>().sqrt()
            * b.iter().map(|x| f64::from(*x).powi(2)).sum::<f64>().sqrt())
}
fn raw_norm(v: &[f32]) -> f64 {
    v.iter().map(|x| f64::from(*x).powi(2)).sum::<f64>().sqrt()
}
/// Mean raw norm of the model's recorded outputs in the shared fixture.
fn recorded_raw_norm(model: &str) -> f64 {
    let parity: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../../packages/test-utils/src/kb/embedding-normalization.json"
    ))
    .expect("normalization fixture");
    let rows = parity["models"][model].as_array().expect("model rows");
    rows.iter()
        .map(|row| {
            row["raw"]
                .as_array()
                .expect("raw")
                .iter()
                .map(|v| v.as_f64().expect("f64").powi(2))
                .sum::<f64>()
                .sqrt()
        })
        .sum::<f64>()
        / rows.len() as f64
}
fn run(id: &str, var: &str, fixture: &str) {
    let f = Fixture::new("real-model");
    #[cfg(unix)]
    {
        // The model cache must sit below owner-only directories (ROOT 1).
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&f.root, std::fs::Permissions::from_mode(0o700))
            .expect("private fixture root");
    }
    let s = Store::open(&f.root.join("store")).expect("task 58 fixture");
    let m = descriptor(id).expect("task 58 fixture");
    let path =
        PathBuf::from(std::env::var(var).expect("explicit model lane requires verified GGUF path"));
    // The real `kb embed-worker` and a per-test model cache.
    let host = kb_local::qwen::ModelHost::new(
        PathBuf::from(std::env::var("KB_MODEL_EXECUTABLE").expect("built kb executable required")),
        support::model_host::runtime_dir(&f.root),
        f.root.join("m"),
        Duration::from_secs(30),
    )
    .expect("model host");
    let r = ModelRuntime::new(&s, host.clone()).expect("task 58 fixture");
    let initial = s.model_state().expect("disabled default");
    assert!(
        r.configure(
            &s,
            &s.owner(),
            kb_local::qwen::ModelConfiguration {
                model_id: id,
                context_tokens: 1024,
                acknowledge_memory_warning: false,
                available_bytes: Some(16 << 30),
                timeout: Duration::from_secs(180),
            }
        )
        .is_err(),
        "actual native load must reject a missing artifact"
    );
    assert_eq!(s.model_state().expect("unchanged default"), initial);
    host.cache()
        .adopt(&m, &path)
        .expect("verified weights adopted");
    r.configure(
        &s,
        &s.owner(),
        kb_local::qwen::ModelConfiguration {
            model_id: id,
            context_tokens: 4096,
            acknowledge_memory_warning: false,
            available_bytes: Some(16 << 30),
            timeout: Duration::from_secs(900),
        },
    )
    .expect("native max-context probe");
    let other_id = if m.causal {
        "embeddinggemma-2-q8_0"
    } else {
        "qwen3-embedding-0.6b-q8_0"
    };
    let other = descriptor(other_id).expect("other model");
    let old = s.model_state().expect("native last good");
    let old_pid = r
        .embed(&s, "healthy", Purpose::Document, Duration::from_secs(180))
        .expect("native active child")
        .pid;
    assert!(
        r.configure(
            &s,
            &s.owner(),
            kb_local::qwen::ModelConfiguration {
                model_id: other_id,
                context_tokens: 1024,
                acknowledge_memory_warning: true,
                available_bytes: Some(
                    other.estimate_bytes(1024).expect("candidate estimate") * 5 / 4
                ),
                timeout: Duration::from_secs(180),
            }
        )
        .is_err(),
        "a candidate without cached weights must fail"
    );
    let restored = s.model_state().expect("restored native last good");
    assert_eq!(restored.model_id, old.model_id);
    assert_eq!(restored.context_tokens, old.context_tokens);
    assert!(restored.enabled && !restored.reloading);
    assert_eq!(
        r.embed(&s, "healthy", Purpose::Document, Duration::from_secs(180))
            .expect("native last good keeps serving")
            .pid,
        old_pid
    );
    let data: serde_json::Value = serde_json::from_str(fixture).expect("task 58 fixture");
    let mut vectors = Vec::new();
    let shared: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../../packages/test-utils/src/kb/embedding-patch-reference.json"
    ))
    .expect("task 58 fixture");
    let mut shared_ids = std::collections::BTreeSet::new();
    let lane = if m.causal { "qwen" } else { "gemma" };
    for item in data["items"].as_array().expect("task 58 fixture") {
        let purpose = if item["purpose"] == "query" {
            Purpose::Query
        } else {
            Purpose::Document
        };
        let e = r
            .embed(
                &s,
                item["text"].as_str().expect("task 58 fixture"),
                purpose,
                Duration::from_secs(180),
            )
            .expect("task 58 fixture");
        assert_eq!(e.vector.len(), m.dimensions);
        assert!(e.vector.iter().all(|x| x.is_finite()));
        // Raw pooled output; the index normalizes exactly once. Enforced
        // before normalizing: the magnitude stays within 20x of the model's
        // recorded raw outputs (norms vary with input length: Gemma's long
        // input is ~0.17x), so an already-normalized vector (norm 1, under
        // 0.011x) fails. The same-input parity below is checked to 1%.
        let ratio = raw_norm(&e.vector) / recorded_raw_norm(id);
        assert!(
            (0.05..20.).contains(&ratio),
            "raw norm ratio {ratio} for {}",
            item["id"]
        );
        let reference = item["vector"]
            .as_array()
            .expect("task 58 fixture")
            .iter()
            .map(|x| x.as_f64().expect("task 58 fixture") as f32)
            .collect::<Vec<_>>();
        assert!(
            cosine(&e.vector, &reference) >= 0.999,
            "fixture {}",
            item["id"]
        );
        for shared_item in shared["models"][lane]
            .as_array()
            .expect("task 58 fixture")
            .iter()
            .filter(|x| x["id"] == item["id"])
        {
            assert!(
                shared_ids.insert(shared_item["id"].as_str().expect("shared ID").to_owned()),
                "duplicate shared comparison"
            );
            let node = shared_item["patched"]
                .as_array()
                .expect("task 58 fixture")
                .iter()
                .map(|x| x.as_f64().expect("task 58 fixture") as f32)
                .collect::<Vec<_>>();
            assert!(
                cosine(&e.vector, &node) >= 0.999,
                "Node/Rust {}",
                item["id"]
            );
        }
        if let Some(n) = item["tokens"].as_u64() {
            assert_eq!(e.tokens.len(), n as usize);
        }
        assert_eq!(e.tokens.last(), Some(&m.eos_token_id));
        if m.add_bos {
            assert_eq!(e.tokens.first(), Some(&m.bos_token_id));
        }
        vectors.push(e.vector);
    }
    assert_eq!(
        shared_ids,
        std::collections::BTreeSet::from(["d1".to_owned(), "q1".to_owned(), "long".to_owned()])
    );
    let literal = r
        .embed(
            &s,
            "<|endoftext|> <bos> <eos>",
            Purpose::Query,
            Duration::from_secs(180),
        )
        .expect("task 58 fixture");
    assert_eq!(
        literal
            .tokens
            .iter()
            .filter(|t| **t == m.eos_token_id)
            .count(),
        1
    );
    if m.add_bos {
        assert_eq!(
            literal
                .tokens
                .iter()
                .filter(|t| **t == m.bos_token_id)
                .count(),
            1
        );
    }
    assert!(vectors.len() >= 6);
    // Server/CLI normalization parity: the live raw output, normalized once by
    // the index format, matches the server runtime's recorded unit vectors.
    let parity: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../../packages/test-utils/src/kb/embedding-normalization.json"
    ))
    .expect("normalization fixture");
    for item in parity["items"].as_array().expect("items") {
        let purpose = if item["purpose"] == "query" {
            Purpose::Query
        } else {
            Purpose::Document
        };
        let e = r
            .embed(
                &s,
                item["text"].as_str().expect("text"),
                purpose,
                Duration::from_secs(180),
            )
            .expect("parity embedding");
        let raw = e.vector.iter().map(|x| f64::from(*x)).collect::<Vec<_>>();
        let recorded = parity["models"][id]
            .as_array()
            .expect("model rows")
            .iter()
            .find(|row| row["id"] == item["id"])
            .expect("recorded row");
        // Same input: the live raw magnitude matches the server's recorded
        // raw output (raw, not pre-normalized), before normalizing.
        let recorded_norm = recorded["raw"]
            .as_array()
            .expect("raw")
            .iter()
            .map(|v| v.as_f64().expect("f64").powi(2))
            .sum::<f64>()
            .sqrt();
        assert!(
            (raw_norm(&e.vector) / recorded_norm - 1.).abs() < 0.01,
            "raw magnitude {}",
            item["id"]
        );
        let unit = kb_local::index_format::unit_vector(&raw, m.dimensions).expect("unit");
        let hex = recorded["unitF32Hex"].as_str().expect("hex");
        let server = (0..hex.len() / 8)
            .map(|i| {
                let b = u32::from_str_radix(&hex[i * 8..i * 8 + 8], 16).expect("hex");
                f32::from_le_bytes(b.to_be_bytes())
            })
            .collect::<Vec<_>>();
        assert!(
            cosine(&unit, &server) >= 0.9999,
            "server/CLI parity {}",
            item["id"]
        );
    }
    // d1=locks, d2=redaction; query fixture asks about writers.
    assert!(cosine(&vectors[0], &vectors[3]) > cosine(&vectors[1], &vectors[3]));
    r.configure(
        &s,
        &s.owner(),
        kb_local::qwen::ModelConfiguration {
            model_id: id,
            context_tokens: 1024,
            acknowledge_memory_warning: false,
            available_bytes: Some(16 << 30),
            timeout: Duration::from_secs(900),
        },
    )
    .expect("task 58 fixture");
    let before_overflow = r
        .embed(&s, "healthy", Purpose::Document, Duration::from_secs(180))
        .expect("healthy model")
        .pid;
    for text in [
        "\"".repeat(32 * 1024),
        "\"".repeat(64 * 1024),
        "\\".repeat(64 * 1024),
        "\u{1}".repeat(64 * 1024),
    ] {
        assert_eq!(
            r.embed(&s, &text, Purpose::Document, Duration::from_secs(180))
                .expect_err("escaped tokenizer overflow")
                .protocol_code(),
            kb_client::ErrorCode::EmbeddingInputTooLong
        );
    }
    assert_eq!(
        r.embed(&s, "healthy", Purpose::Document, Duration::from_secs(180))
            .expect("healthy after rejection")
            .pid,
        before_overflow
    );
    assert_eq!(
        r.embed(
            &s,
            &"token ".repeat(9000),
            Purpose::Document,
            Duration::from_secs(180)
        )
        .expect_err("task 58 rejection")
        .protocol_code(),
        kb_client::ErrorCode::EmbeddingInputTooLong
    );
    // Max-context inference discriminates a source that allocates pooled logits.
    let e = r
        .embed(
            &s,
            &"hello ".repeat(1000),
            Purpose::Document,
            Duration::from_secs(180),
        )
        .expect("task 58 fixture");
    assert!(e.tokens.len() <= 1024 && e.tokens.len() > 990);
    if cfg!(target_os = "linux") {
        assert!(
            e.peak_bytes.expect("task 58 fixture")
                < m.estimate_bytes(1024).expect("task 58 fixture")
        );
    }
    let pid = e.pid;
    // The shared worker outlives one client and reports the loaded model.
    let info = host.status().expect("shared worker still running");
    assert_eq!(info.pid, pid);
    assert_eq!(info.loaded.as_deref(), Some(id));
    // ROOT B: the resident model is read into private memory, never mapped:
    // the worker holds neither a mapping nor a handle of the GGUF, so the
    // verified bytes cannot change under it and Windows can delete the file.
    #[cfg(target_os = "linux")]
    {
        let held = |pid: u32| {
            std::fs::read_to_string(format!("/proc/{pid}/maps"))
                .expect("worker mappings")
                .contains(&m.file_name)
                || std::fs::read_dir(format!("/proc/{pid}/fd"))
                    .expect("worker handles")
                    .flatten()
                    .any(|fd| {
                        std::fs::read_link(fd.path())
                            .is_ok_and(|t| t.to_string_lossy().contains(&m.file_name))
                    })
        };
        assert!(!held(pid), "a resident model holds no mapping or handle");
    }
    // The adopted weights are the cache's own recorded inode in the
    // private `verified/`, loaded in place. A trust change while resident
    // (it becomes group-writable): the worker stops serving the old load and
    // reloads from a fresh verified inode, never the loosened one.
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        use std::os::unix::fs::PermissionsExt;
        let file = host.cache().resolve(&m).expect("found").path;
        // Adopted into the private `verified/` (a configured models_dir is
        // only ever read), as the cache's own recorded inode.
        assert_eq!(
            file,
            host.cache()
                .private_copy(&m)
                .expect("copy")
                .canonicalize()
                .expect("copy")
        );
        assert!(host.cache().resolve(&m).expect("found").trusted);
        let before = std::fs::metadata(&file).expect("file").ino();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o660))
            .expect("group-writable");
        assert!(!host.cache().resolve(&m).expect("found").trusted);
        let e = r
            .embed(&s, "healthy", Purpose::Query, Duration::from_secs(180))
            .expect("served from a fresh verified copy");
        assert_eq!(e.pid, pid);
        assert_ne!(
            std::fs::metadata(&file).expect("fresh copy").ino(),
            before,
            "a fresh inode of ours"
        );
    }
    // Removal asks the worker to release the model before deleting: no
    // inference traffic is needed to unload it.
    host.remove_model(&m).expect("remove resident model");
    assert_eq!(host.status().expect("worker").loaded, None);
    assert!(!host.cache().private_copy(&m).expect("file").exists());
    assert!(!host.cache().file(&m).expect("file").exists());
    for _ in 0..3 {
        assert!(
            r.embed(&s, "healthy", Purpose::Query, Duration::from_secs(30))
                .is_err()
        );
        assert_eq!(host.status().expect("worker").loaded, None);
    }
    drop(r);
    s.model_disable(&s.owner()).expect("task 58 fixture");
}
#[test]
#[ignore = "required real-model lane, weights are never bundled"]
fn gemma_real_model() {
    run(
        "embeddinggemma-2-q8_0",
        "KB_GEMMA_MODEL_PATH",
        include_str!("../../../../../packages/test-utils/src/kb/gemma-reference.json"),
    );
}
#[test]
#[ignore = "required real-model lane, weights are never bundled"]
fn qwen_real_model() {
    run(
        "qwen3-embedding-0.6b-q8_0",
        "KB_QWEN_MODEL_PATH",
        include_str!("../../../../../packages/test-utils/src/kb/qwen-batch-reference.json"),
    );
}
/// Real-model lane: the shared retrieval-quality corpus through the real
/// build and search pipeline with the real Gemma worker. With
/// `KB_RECORD_RETRIEVAL=<file>` it also writes the vector arm's order per
/// query (the `vectorRanking` the CI lanes replay).
#[test]
#[ignore = "required real-model lane, weights are never bundled"]
fn gemma_retrieval_quality() {
    use kb_local::StoreError;
    let id = "embeddinggemma-2-q8_0";
    let c = retrieval::retrieval_corpus();
    let f = search_support::Fixture::new(768);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&f.root, std::fs::Permissions::from_mode(0o700))
            .expect("private fixture root");
    }
    let m = descriptor(id).expect("gemma");
    let host = kb_local::qwen::ModelHost::new(
        PathBuf::from(std::env::var("KB_MODEL_EXECUTABLE").expect("built kb executable required")),
        support::model_host::runtime_dir(&f.root),
        f.root.join("m"),
        Duration::from_secs(30),
    )
    .expect("model host");
    host.cache()
        .adopt(
            &m,
            &PathBuf::from(std::env::var("KB_GEMMA_MODEL_PATH").expect("verified GGUF path")),
        )
        .expect("verified weights adopted");
    let r = ModelRuntime::new(&f.store, host.clone()).expect("runtime");
    r.configure(
        &f.store,
        &f.store.owner(),
        kb_local::qwen::ModelConfiguration {
            model_id: id,
            context_tokens: 1024,
            acknowledge_memory_warning: false,
            available_bytes: Some(16 << 30),
            timeout: Duration::from_secs(900),
        },
    )
    .expect("gemma 1K");
    let embed = |text: &str, purpose| -> Result<Vec<f64>, StoreError> {
        Ok(r.embed(&f.store, text, purpose, Duration::from_secs(180))?
            .vector
            .into_iter()
            .map(f64::from)
            .collect())
    };
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime");
    let paths = retrieval::paths(&c);
    let mut docs = vec![vec![]; paths.len()];
    retrieval::publish_corpus(&f, &c);
    rt.block_on(retrieval::build_hybrid(&f, async |_, texts| {
        texts
            .iter()
            .map(|t| {
                let v = embed(t, Purpose::Document)?;
                docs[retrieval::document_of(&c, t)] = v.clone();
                Ok(v)
            })
            .collect()
    }));
    assert!(docs.iter().all(|d| d.len() == 768), "one chunk per note");
    let mut ranking = serde_json::Map::new();
    for (query, _, _) in retrieval::queries(&c) {
        let q = embed(&query, Purpose::Query).expect("query embedding");
        ranking.insert(
            query,
            retrieval::vector_order(&docs, &q)
                .into_iter()
                .map(|i| serde_json::Value::from(paths[i].clone()))
                .collect(),
        );
    }
    if let Ok(out) = std::env::var("KB_RECORD_RETRIEVAL") {
        std::fs::write(
            out,
            serde_json::to_string_pretty(&ranking).expect("ranking json"),
        )
        .expect("recorded ranking");
    }
    let score = rt.block_on(retrieval::score(
        &f,
        &c,
        async |_, text| embed(text, Purpose::Query),
        kb_client::types::SearchMode::Hybrid,
    ));
    // The measured numbers for the lane log.
    let _ = std::io::Write::write_fmt(
        &mut std::io::stderr(),
        format_args!("GEMMA_RETRIEVAL {score}\n"),
    );
    let (h1, h3, k1) = retrieval::thresholds(&c, "gemma");
    assert!(
        score.semantic_hit1 >= h1 && score.semantic_hit3 >= h3 && score.keyword_hit1 >= k1,
        "{score}"
    );
    drop(r);
}
