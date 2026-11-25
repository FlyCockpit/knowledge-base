//! Embedding inputs: chunk limits, calibration and vector normalization.

use super::*;

#[tokio::test]
async fn chunk_limit_fails_before_any_embedding_and_records_its_code() {
    let f = Fixture::new(2);
    let head = kb_client::types::Sha::parse(
        &f.store
            .kb(&f.kb)
            .expect("fixture")
            .expect("fixture")
            .head_sha
            .expect("head"),
    )
    .expect("sha");
    f.store
        .commit_files(
            &f.store.owner(),
            kb_local::CommitRequest {
                kb: f.kb.clone(),
                base_revision: head,
                idempotency_key: "chunk-limit-document".into(),
                changes: vec![kb_local::FileChange {
                    path: "second.md".into(),
                    content: Some(b"second document".to_vec()),
                }],
            },
        )
        .expect("publication");
    assert!(
        kb_local::limits::LocalLimits::default()
            .with_index_chunk_limit(0)
            .is_err()
    );
    assert!(
        kb_local::limits::LocalLimits::default()
            .with_index_chunk_limit(kb_local::limits::INDEX_CHUNKS_DEFAULT + 1)
            .is_err()
    );
    f.store.set_limits(
        kb_local::limits::LocalLimits::default()
            .with_index_chunk_limit(1)
            .expect("lower-only"),
    );
    let job = f.set("profile-chunk-limit");
    let mut calls = 0;
    let result = f
        .store
        .build_generation(
            f.store
                .claim_generation(&job.generation_id, Duration::from_secs(60))
                .expect("claim"),
            async |pin, texts| {
                calls += 1;
                Ok(texts.iter().map(|_| vec![1.; pin.dimensions]).collect())
            },
            &mut |_| Ok(()),
        )
        .await;
    assert_eq!(
        result.err().expect("over the limit").protocol_code(),
        kb_client::ErrorCode::QuotaExceeded
    );
    assert_eq!(calls, 0, "no embedding spend");
    assert_eq!(
        f.db()
            .query_row(
                "SELECT state,error_code,reserved_bytes FROM index_generations WHERE id=?1",
                [job.generation_id.as_str()],
                |r| Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?
                ))
            )
            .expect("ledger"),
        ("FAILED".into(), "INDEX_CHUNK_LIMIT_EXCEEDED".into(), 0)
    );
    // kb/1 projection is unchanged.
    assert_eq!(f.status().error_code.as_deref(), Some("INDEX_BUILD_FAILED"));
    assert!(
        !f.store
            .paths()
            .index_file(&f.kb, &job.generation_id)
            .exists()
    );
    f.store.set_limits(
        kb_local::limits::LocalLimits::default()
            .with_index_chunk_limit(2)
            .expect("lower-only"),
    );
    let next = f.rebuild("rebuild-chunk-limit");
    let built = f.build(&next.generation_id).await;
    assert!(
        f.store
            .activate_built(built)
            .expect("at the limit activates")
    );
}

#[tokio::test]
async fn every_chunk_is_embedded_exactly_once_in_id_order() {
    let f = Fixture::new(2);
    let head = kb_client::types::Sha::parse(
        &f.store
            .kb(&f.kb)
            .expect("fixture")
            .expect("fixture")
            .head_sha
            .expect("head"),
    )
    .expect("sha");
    f.store
        .commit_files(
            &f.store.owner(),
            kb_local::CommitRequest {
                kb: f.kb.clone(),
                base_revision: head,
                idempotency_key: "embed-once-document".into(),
                changes: vec![
                    kb_local::FileChange {
                        path: "b.md".into(),
                        // Distinct words: equal chunk texts would share one vector.
                        content: Some(
                            (0..7000)
                                .map(|i| format!("bravo{i} words "))
                                .collect::<String>()
                                .into_bytes(),
                        ),
                    },
                    kb_local::FileChange {
                        path: "a.md".into(),
                        content: Some(b"alpha".to_vec()),
                    },
                ],
            },
        )
        .expect("publication");
    let job = f.set("profile-embed-once");
    let mut embedded = Vec::new();
    let built = f
        .store
        .build_generation(
            f.store
                .claim_generation(&job.generation_id, Duration::from_secs(120))
                .expect("claim"),
            async |pin, texts| {
                assert!(texts.len() <= 32);
                embedded.extend(texts.iter().cloned());
                Ok(texts.iter().map(|_| vec![1.; pin.dimensions]).collect())
            },
            &mut |_| Ok(()),
        )
        .await
        .expect("build");
    assert!(f.store.activate_built(built).expect("activation"));
    let lease = f
        .store
        .lease_active_generation(&f.store.owner(), &f.kb)
        .expect("lease");
    let rows: Vec<(i64, String, i64, String)> = lease
        .connection()
        .prepare("SELECT id,path,chunk_index,text FROM chunks ORDER BY id")
        .expect("chunks")
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .expect("chunks")
        .collect::<Result<_, _>>()
        .expect("chunks");
    assert!(rows.len() > 32);
    // ids are 1..n in bytewise (path, chunk_index) order.
    let mut keys = rows
        .iter()
        .map(|(_, p, i, _)| (p.clone(), *i))
        .collect::<Vec<_>>();
    keys.sort();
    assert_eq!(
        rows.iter()
            .map(|(_, p, i, _)| (p.clone(), *i))
            .collect::<Vec<_>>(),
        keys
    );
    assert_eq!(
        rows.iter().map(|r| r.0).collect::<Vec<_>>(),
        (1..=rows.len() as i64).collect::<Vec<_>>()
    );
    // Below 4096 chunks every id is a calibration sample: embedded once, in id order.
    assert_eq!(
        embedded,
        rows.iter().map(|r| r.3.clone()).collect::<Vec<_>>()
    );
    assert_eq!(lease.meta().chunk_count, rows.len() as u64);
    assert_eq!(lease.meta().document_count, 3);
}

/// Deterministic 8-d vectors: half the chunks (by text hash) get
/// TWICE_SENSITIVE; the rest are distinguishable, with every unit component
/// below 0.37 so the calibration scale is TWICE_SENSITIVE's 0.37778….
fn text_vector(text: &str) -> Vec<f64> {
    let h = fnv(text);
    if is_twice_sensitive(h) {
        return TWICE_SENSITIVE.to_vec();
    }
    (0..8)
        .map(|k| {
            let bits = (h >> (8 * k)) & 0xff;
            let magnitude = 1. + 0.05 * (bits >> 1) as f64 / 127.;
            if bits & 1 == 0 { magnitude } else { -magnitude }
        })
        .collect()
}

#[tokio::test]
async fn above_4096_chunks_calibrates_on_the_sample_and_embeds_each_chunk_once() {
    let f = Fixture::new(8);
    let head = kb_client::types::Sha::parse(
        &f.store
            .kb(&f.kb)
            .expect("fixture")
            .expect("fixture")
            .head_sha
            .expect("head"),
    )
    .expect("sha");
    // 8 documents x 165,000 unique words: > 4,096 windows of 400 words / step 320.
    let changes = (0..8)
        .map(|d| kb_local::FileChange {
            path: format!("d{d}.md"),
            content: Some(
                (0..165_000)
                    .map(|i| format!("w{d}x{i:x}"))
                    .collect::<Vec<_>>()
                    .join(" ")
                    .into_bytes(),
            ),
        })
        .collect();
    f.store
        .commit_files(
            &f.store.owner(),
            kb_local::CommitRequest {
                kb: f.kb.clone(),
                base_revision: head,
                idempotency_key: "embed-once-large-corpus".into(),
                changes,
            },
        )
        .expect("publication");
    let job = f.set("profile-embed-once-large");
    let mut embedded = Vec::new();
    let built = f
        .store
        .build_generation(
            f.store
                .claim_generation(&job.generation_id, Duration::from_secs(600))
                .expect("claim"),
            async |_, texts| {
                embedded.extend(texts.iter().cloned());
                Ok(texts.iter().map(|t| text_vector(t)).collect())
            },
            &mut |_| Ok(()),
        )
        .await
        .expect("build");
    assert!(f.store.activate_built(built).expect("activation"));
    let lease = f
        .store
        .lease_active_generation(&f.store.owner(), &f.kb)
        .expect("lease");
    let db = lease.connection();
    let rows: Vec<(i64, String, Vec<u8>, Vec<u8>)> = db
        .prepare("SELECT c.id,c.text,b.b,i.e FROM chunks c JOIN chunk_bits b ON b.id=c.id JOIN chunk_int8 i ON i.id=c.id ORDER BY c.id")
        .expect("rows")
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .expect("rows")
        .collect::<Result<_, _>>()
        .expect("rows");
    let n = rows.len() as u64;
    assert!(n > 4096, "{n} chunks");
    assert_eq!(lease.meta().chunk_count, n);
    use kb_local::index_format as fmt;
    let unit = |text: &str| fmt::unit_vector(&text_vector(text), 8).expect("unit");
    let sample = fmt::calibration_ids(n);
    assert!(
        sample.len() < rows.len(),
        "stride > 1: some chunks are unsampled"
    );
    let sampled = sample
        .iter()
        .map(|id| unit(&rows[*id as usize - 1].1))
        .collect::<Vec<_>>();
    let scale = fmt::int8_scale(sampled.iter().map(Vec::as_slice)).expect("scale");
    assert_eq!(lease.meta().int8_scale, Some(scale));
    // Sample first (in id order), then every unsampled chunk in id order:
    // each chunk exactly once.
    let sampled_ids = sample
        .iter()
        .copied()
        .collect::<std::collections::BTreeSet<_>>();
    let expected = sample
        .iter()
        .map(|id| rows[*id as usize - 1].1.clone())
        .chain(
            rows.iter()
                .filter(|r| !sampled_ids.contains(&(r.0 as u64)))
                .map(|r| r.1.clone()),
        )
        .collect::<Vec<_>>();
    assert_eq!(embedded.len(), rows.len());
    assert!(embedded == expected, "embedding order and multiplicity");
    // Every vector lands on its own id.
    for (id, text, bits, int8) in &rows {
        let u = unit(text);
        assert_eq!(bits, &fmt::binary_bits(&u), "bits {id}");
        assert_eq!(
            int8,
            &fmt::i8_bytes(&fmt::quantize_int8(&u, scale).expect("int8")),
            "int8 {id}"
        );
    }
    // Normalized exactly once on both the sampled (cached) and the unsampled
    // path: the spec bytes, never the double-normalized [127×7, 10].
    let once = fmt::unit_vector(&TWICE_SENSITIVE, 8).expect("unit");
    assert_eq!(scale, f64::from(once[0]));
    let mut seen = (0, 0);
    for (id, text, bits, int8) in &rows {
        if !is_twice_sensitive(fnv(text)) {
            continue;
        }
        assert_eq!(bits, &vec![0xffu8], "bits {id}");
        assert_eq!(
            int8,
            &vec![127u8, 127, 127, 127, 127, 127, 127, 11],
            "int8 {id}"
        );
        if sampled_ids.contains(&(*id as u64)) {
            seen.0 += 1;
        } else {
            seen.1 += 1;
        }
    }
    assert!(seen.0 > 0 && seen.1 > 0, "both paths covered: {seen:?}");
}

/// The same near-unit vector through the real external-provider entry point
/// (`build_index` + OpenAI-compatible JSON): the adapter passes the raw f64
/// values on unchanged, and the index normalizes them exactly once.
#[tokio::test]
async fn provider_vectors_are_normalized_once_through_the_real_embedding_path() {
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
            Ok(Secret::new("disposable-normalize-fixture".into()))
        }
        fn delete(&self, _: &str) -> Result<(), StoreError> {
            Ok(())
        }
    }
    struct Io;
    impl Dns for Io {
        fn resolve<'a>(&'a self, _: &'a str, _: u16) -> IoFuture<'a, Vec<std::net::IpAddr>> {
            Box::pin(async { Ok(vec!["8.8.8.8".parse().expect("fixture IP")]) })
        }
    }
    impl Http for Io {
        fn post<'a>(
            &'a self,
            _: &'a Endpoint,
            _: std::net::SocketAddr,
            _: &'a Secret,
            body: Vec<u8>,
        ) -> IoFuture<'a, HttpResponse> {
            Box::pin(async move {
                let body: serde_json::Value = serde_json::from_slice(&body).expect("request");
                let n = body["input"].as_array().expect("texts").len();
                // Decimal JSON exactly as a provider sends it.
                let embedding = format!("[{}]", TWICE_SENSITIVE.map(|v| v.to_string()).join(","));
                let data = (0..n)
                    .map(|i| format!(r#"{{"index":{i},"embedding":{embedding}}}"#))
                    .collect::<Vec<_>>()
                    .join(",");
                Ok(HttpResponse {
                    status: 200,
                    body: format!(r#"{{"data":[{data}]}}"#).into_bytes(),
                })
            })
        }
    }
    let f = Fixture::new(8);
    let job = f.set("profile-normalize-once");
    let egress = PinnedEgress::new(&Io, &Io);
    assert!(
        f.store
            .build_index(
                f.store
                    .claim_generation(&job.generation_id, Duration::from_secs(120))
                    .expect("claim"),
                IndexEmbedder::External {
                    keys: &Keys,
                    egress: &egress,
                },
            )
            .await
            .expect("build")
    );
    let lease = f
        .store
        .lease_active_generation(&f.store.owner(), &f.kb)
        .expect("lease");
    let stored: (Vec<u8>, Vec<u8>) = lease
        .connection()
        .query_row(
            "SELECT b.b,i.e FROM chunk_bits b JOIN chunk_int8 i ON i.id=b.id WHERE b.id=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .expect("vectors");
    assert_eq!(stored.0, vec![0xff]);
    assert_eq!(stored.1, vec![127u8, 127, 127, 127, 127, 127, 127, 11]);
    assert_eq!(lease.meta().int8_scale, Some(0.377_780_079_841_613_77));
}

/// The shared `dims12-pad-bits` case (values not f32-representable) through
/// the real external-provider entry point, as int8 and as
/// binary_int8_rescore: stored f32 bytes, int8, bits and scale equal the
/// fixture.
#[tokio::test]
async fn shared_dims12_case_through_the_real_provider_path() {
    use kb_local::{
        credentials::{Credentials, Secret},
        egress::{Dns, Endpoint, Http, HttpResponse, IoFuture, PinnedEgress},
        index::IndexEmbedder,
    };
    let cases: serde_json::Value = serde_json::from_slice(
        &std::fs::read(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../../../packages/api/src/lib/kb/fixtures/index-quantization-cases.json"),
        )
        .expect("shared fixture"),
    )
    .expect("shared fixture");
    let case = cases["cases"]
        .as_array()
        .expect("cases")
        .iter()
        .find(|c| c["name"] == "dims12-pad-bits")
        .expect("dims12-pad-bits")
        .clone();
    let vectors = case["vectors"].as_array().expect("vectors").clone();
    assert_eq!(vectors.len(), 4);
    const WORDS: [&str; 4] = ["zero", "one", "two", "three"];
    struct Keys;
    impl Credentials for Keys {
        fn set(&self, _: &str, _: &Secret) -> Result<(), StoreError> {
            Ok(())
        }
        fn get(&self, _: &str) -> Result<Secret, StoreError> {
            Ok(Secret::new("disposable-dims12-fixture".into()))
        }
        fn delete(&self, _: &str) -> Result<(), StoreError> {
            Ok(())
        }
    }
    struct Io(Vec<serde_json::Value>);
    impl Dns for Io {
        fn resolve<'a>(&'a self, _: &'a str, _: u16) -> IoFuture<'a, Vec<std::net::IpAddr>> {
            Box::pin(async { Ok(vec!["8.8.8.8".parse().expect("fixture IP")]) })
        }
    }
    impl Http for Io {
        fn post<'a>(
            &'a self,
            _: &'a Endpoint,
            _: std::net::SocketAddr,
            _: &'a Secret,
            body: Vec<u8>,
        ) -> IoFuture<'a, HttpResponse> {
            Box::pin(async move {
                let body: serde_json::Value = serde_json::from_slice(&body).expect("request");
                let data = body["input"]
                    .as_array()
                    .expect("texts")
                    .iter()
                    .enumerate()
                    .map(|(index, text)| {
                        let word = text
                            .as_str()
                            .expect("text")
                            .rsplit(' ')
                            .next()
                            .expect("word");
                        let at = WORDS.iter().position(|w| *w == word).expect("known text");
                        // The fixture's decimal values, re-serialized exactly.
                        json!({"index": index, "embedding": self.0[at]})
                    })
                    .collect::<Vec<_>>();
                Ok(HttpResponse {
                    status: 200,
                    body: serde_json::to_vec(&json!({ "data": data })).expect("response"),
                })
            })
        }
    }
    let hex = |b: &[u8]| b.iter().map(|x| format!("{x:02x}")).collect::<String>();
    for quantization in ["int8", "binary_int8_rescore"] {
        let f = Fixture::new(12);
        let head = Sha::parse(
            &f.store
                .kb(&f.kb)
                .expect("fixture")
                .expect("fixture")
                .head_sha
                .expect("head"),
        )
        .expect("sha");
        // Exactly the four case vectors: ids 1..4 = a.md..d.md, index.md empty.
        let mut changes = WORDS
            .iter()
            .enumerate()
            .map(|(i, word)| kb_local::FileChange {
                path: format!("{}.md", (b'a' + i as u8) as char),
                content: Some(format!("vector {word}").into_bytes()),
            })
            .collect::<Vec<_>>();
        changes.push(kb_local::FileChange {
            path: "index.md".into(),
            content: Some(vec![]),
        });
        f.store
            .commit_files(
                &f.store.owner(),
                kb_local::CommitRequest {
                    kb: f.kb.clone(),
                    base_revision: head,
                    idempotency_key: "dims12-real-provider".into(),
                    changes,
                },
            )
            .expect("publication");
        // The CLI builds binary_int8_rescore; the int8 run selects the
        // shared format's int8 variant through the test seam.
        f.store
            .set_index_quantization_for_tests(match quantization {
                "int8" => kb_local::index_format::IndexQuantization::Int8,
                _ => kb_local::index_format::IndexQuantization::BinaryInt8Rescore,
            });
        let job = f.set("profile-dims12-real-provider");
        let io = Io(vectors.clone());
        let egress = PinnedEgress::new(&io, &io);
        assert!(
            f.store
                .build_index(
                    f.store
                        .claim_generation(&job.generation_id, Duration::from_secs(120))
                        .expect("claim"),
                    IndexEmbedder::External {
                        keys: &Keys,
                        egress: &egress,
                    },
                )
                .await
                .expect("build")
        );
        let lease = f
            .store
            .lease_active_generation(&f.store.owner(), &f.kb)
            .expect("lease");
        let db = lease.connection();
        assert_eq!(lease.meta().chunk_count, 4);
        for i in 0..4usize {
            let id = i as i64 + 1;
            let text: String = db
                .query_row("SELECT text FROM chunks WHERE id=?1", [id], |r| r.get(0))
                .expect("chunk");
            assert_eq!(text, format!("vector {}", WORDS[i]));
            if quantization == "int8" {
                let stored: Vec<u8> = db
                    .query_row(
                        "SELECT embedding FROM chunk_vec WHERE rowid=?1",
                        [id],
                        |r| r.get(0),
                    )
                    .expect("int8 bytes");
                let expected = case["int8"][i]
                    .as_array()
                    .expect("int8")
                    .iter()
                    .map(|v| v.as_i64().expect("int8") as i8 as u8)
                    .collect::<Vec<_>>();
                assert_eq!(stored, expected, "int8 {i}");
            } else {
                let (bits, int8): (Vec<u8>, Vec<u8>) = db
                    .query_row(
                        "SELECT b.b,i.e FROM chunk_bits b JOIN chunk_int8 i ON i.id=b.id WHERE b.id=?1",
                        [id],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .expect("vectors");
                assert_eq!(
                    hex(&bits),
                    case["bitsHex"][i].as_str().expect("hex"),
                    "bits {i}"
                );
                let expected = case["int8"][i]
                    .as_array()
                    .expect("int8")
                    .iter()
                    .map(|v| v.as_i64().expect("int8") as i8 as u8)
                    .collect::<Vec<_>>();
                assert_eq!(int8, expected, "int8 {i}");
            }
        }
        assert_eq!(lease.meta().int8_scale, case["int8Scale"].as_f64());
    }
}

/// Server/CLI normalization parity on real built-in model output: the shared
/// fixture holds raw pooled vectors from the real Qwen and Gemma runtimes and
/// the server's `unitVector` bytes; the CLI's one normalization must produce
/// exactly those bytes (the server's format.test.ts asserts the same).
#[test]
fn normalization_matches_the_server_on_real_model_output() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../../../../packages/test-utils/src/kb/embedding-normalization.json"
    ))
    .expect("fixture");
    let models = fixture["models"].as_object().expect("models");
    assert_eq!(models.len(), 2);
    for rows in models.values() {
        for row in rows.as_array().expect("rows") {
            let raw = row["raw"]
                .as_array()
                .expect("raw")
                .iter()
                .map(|v| v.as_f64().expect("f64"))
                .collect::<Vec<_>>();
            assert!(raw.iter().map(|v| v * v).sum::<f64>().sqrt() > 10.);
            let unit = kb_local::index_format::unit_vector(&raw, raw.len()).expect("unit");
            let hex = unit
                .iter()
                .flat_map(|v| v.to_le_bytes())
                .map(|b| format!("{b:02x}"))
                .collect::<String>();
            assert_eq!(
                hex,
                row["unitF32Hex"].as_str().expect("hex"),
                "{}",
                row["id"]
            );
        }
    }
}
