//! 57b spec-first: shared TS corpora, exact source spans and safe projections.
use kb_client::{
    ErrorCode,
    snapshot::{content_hash, git_blob_sha},
    types::{KbPath, Sha},
};
use kb_local::{
    chunk::{chunk_body, citation_snippet},
    fingerprint::{EMBEDDING_VERSIONS, embedding_fingerprint},
    markdown::{ConversionInput, convert_source},
    sensitive_text::prepare_embedding_query,
    structured::{
        StructuredFilters, extract_structured_document, extract_table_rows,
        match_structured_document,
    },
};
use serde_json::{Value, json};
#[path = "support/fixture.rs"]
mod fixture;
const STAMP: &str = "2026-09-24T12:00:00.000000002Z";
fn corpus(name: &str) -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../packages/api/src/lib/kb/fixtures")
        .join(format!("{name}.json"));
    serde_json::from_slice(&std::fs::read(path).expect("fixture")).expect("JSON")
}
fn structured(markdown: &str) -> kb_local::structured::StructuredDocument {
    let parsed = kb_local::markdown::parse_markdown(markdown.as_bytes()).expect("Markdown");
    extract_structured_document(&parsed, &markdown[parsed.body_start..], STAMP).expect("structured")
}
#[test]
fn shared_numeric_cells_and_raw_filter_transport_match_javascript() {
    for case in corpus("structured-numbers")["cases"].as_array().unwrap() {
        let cell = case["cell"].as_str().unwrap();
        let doc = structured(&format!("n|other\n-|-----\n{cell}|ok"));
        let value = &doc.rows[0].values["n"];
        if let Some(bits) = case["bits"].as_str() {
            assert_eq!(
                format!("{:016x}", value.as_f64().unwrap().to_bits()),
                bits,
                "{cell}"
            );
            // Decode raw JSON at both filter entry points, before any Value can
            // round the decimal. The canonical JS spelling must match too.
            for raw in [cell.to_owned(), case["value"].to_string()] {
                let json = format!(r#"{{"structured":[{{"column":"n","equals":{raw}}}]}}"#);
                let filters: StructuredFilters = serde_json::from_str(&json).unwrap();
                assert_eq!(
                    match_structured_document(&doc, &filters).unwrap().len(),
                    1,
                    "{cell}: {raw}"
                );
            }
            let wrong = value.as_f64().unwrap() + 1.;
            if wrong.is_finite() && wrong != value.as_f64().unwrap() {
                let filters =
                    serde_json::from_value(json!({"structured":[{"column":"n","equals":wrong}]}))
                        .unwrap();
                assert!(
                    match_structured_document(&doc, &filters)
                        .unwrap()
                        .is_empty()
                );
            }
            let filters =
                serde_json::from_value(json!({"structured":[{"column":"n","equals":cell}]}))
                    .unwrap();
            assert!(
                match_structured_document(&doc, &filters)
                    .unwrap()
                    .is_empty()
            );
        } else {
            assert_eq!(value, &case["value"], "{cell}");
        }
    }
}
#[test]
fn tags_preserve_first_seen_order_normalization_and_exact_case_at_source_cap() {
    assert!(structured("").tags.is_empty());
    let md = "---\ntags: [\" é \", \"é\", \"É\", \"\\uFEFFé\\uFEFF\", \" \", true, 7, null, \"z\", \"z\"]\n---\n";
    let doc = structured(md);
    assert_eq!(doc.tags, ["é", "É", "z"]);
    for (tag, count) in [(" é ", 1), ("É", 1), ("é", 1), ("Z", 0)] {
        let filters = serde_json::from_value(json!({"tags":[tag]})).unwrap();
        assert_eq!(
            match_structured_document(&doc, &filters).unwrap().len(),
            count
        );
    }
    // Near the cap that matters: the front matter's JSON.stringify encoding
    // (quoted tags) is bounded at 64 KiB, which is tighter than the YAML source.
    let tags: Vec<_> = (0..8_000).map(|n| format!("t{n}")).collect();
    let md = format!("---\ntags: [{}]\n---\n", tags.join(","));
    let encoded = serde_json::to_vec(&json!({ "tags": tags })).unwrap().len();
    assert!(encoded > 60 * 1024 && encoded <= 64 * 1024, "{encoded}");
    assert_eq!(structured(&md).tags, tags);
}
#[test]
fn shared_chunk_corpus_exact_spans_ordinals_payloads_and_accounting() {
    for case in corpus("chunks")["cases"].as_array().unwrap() {
        let markdown = case["markdown"].as_str().unwrap();
        let parsed = kb_local::markdown::parse_markdown(markdown.as_bytes()).unwrap();
        let body = &markdown[parsed.body_start..];
        assert_eq!(body, case["body"].as_str().unwrap());
        let result = chunk_body(body);
        let wire = serde_json::to_value(&result).unwrap();
        assert_eq!(wire["state"], case["state"], "{}", case["name"]);
        assert_eq!(wire["originalWindowCount"], case["originalWindowCount"]);
        let windows: Vec<_> = result.chunks.iter().map(|c| json!({"chunkIndex":c.chunk_index,"span":c.span,"source": &body[c.span.start_byte as usize..c.span.end_byte as usize],"text":c.text,"snippet":c.snippet})).collect();
        assert_eq!(json!(windows), case["windows"], "{}", case["name"]);
        for c in result.chunks {
            assert!(!c.text.contains("sk-fixture-canary"));
            assert!(!c.text.contains("{{sealed:"));
            assert!(c.snippet.chars().count() <= 240);
        }
    }
}
#[test]
fn near_limit_single_word_chunks_preserve_snippets() {
    for case in corpus("plain-snippet")["stressCases"].as_array().unwrap() {
        let count = case["repeat"].as_u64().unwrap() as usize;
        let input = case["head"].as_str().unwrap().to_owned()
            + &case["unit"].as_str().unwrap().repeat(count)
            + case["tail"].as_str().unwrap();
        let parsed = kb_local::markdown::parse_markdown(input.as_bytes()).unwrap();
        // Formatter timing is asserted separately, excluding credential scanning.
        let result = chunk_body(&input[parsed.body_start..]);
        assert_eq!(result.chunks.len(), 1);
        assert_eq!(
            result.chunks[0].snippet,
            case["snippet"].as_str().unwrap(),
            "{}",
            case["name"]
        );
    }
}

#[test]
fn windows_boundaries_and_pathological_single_words() {
    for (words, count) in [(1, 1), (400, 1), (401, 2), (720, 2), (721, 3)] {
        let result = chunk_body(&vec!["word"; words].join(" "));
        assert_eq!(result.original_window_count, count);
        assert_eq!(result.chunks.last().unwrap().span.end_token, words as u64);
    }
    let word = "😀".repeat(10_000);
    let result = chunk_body(&word);
    assert_eq!(result.chunks.len(), 1);
    assert_eq!(result.chunks[0].text, word);
    assert_eq!(result.chunks[0].span.end_byte, 40_000);
    assert_eq!(citation_snippet(&"😀".repeat(240)), "😀".repeat(240));
    assert_eq!(citation_snippet(&word), format!("{}…", "😀".repeat(239)));
    assert_eq!(citation_snippet(""), "");
}
#[test]
fn whole_source_credentials_cover_cross_window_and_pem_continuations() {
    let mut words = vec!["word"; 399];
    words.extend(["Bearer", "synthetic-canary-12345678"]);
    words.extend(vec!["word"; 50]);
    let result = chunk_body(&words.join(" "));
    assert_eq!(
        serde_json::to_value(result).unwrap(),
        json!({"state":"SKIPPED_REDACTED","originalWindowCount":2,"chunks":[]})
    );
    for end in ["", "-----END PRIVATE KEY-----"] {
        let body = format!(
            "-----BEGIN PRIVATE KEY-----\n{}\n{end}",
            vec!["opaque-canary"; 1000].join(" ")
        );
        let result = chunk_body(&body);
        assert_eq!(result.original_window_count, 3);
        assert!(result.chunks.is_empty());
    }
    assert!(
        chunk_body("Authorization:\u{85}Bearer\u{85}abcdefghijk")
            .chunks
            .is_empty()
    );
    assert_eq!(
        prepare_embedding_query("Bearer authentication is required").unwrap(),
        "Bearer authentication is required"
    );
    for text in [
        "sk-fixture-canary-0123456789",
        "Bearer synthetic-canary-12345678",
        "-----BEGIN PRIVATE KEY-----\ncanary",
    ] {
        let e = prepare_embedding_query(text).unwrap_err();
        assert_eq!(e.protocol_code(), ErrorCode::SensitiveQuery);
        assert!(!format!("{e:?} {e}").contains(text));
    }
    let symbol = "{{SEALED:V1:KNOWLEDGE_BASE:------------------------------------:------------------------------------}}";
    assert_eq!(
        prepare_embedding_query(&format!("猫 {symbol}")).unwrap(),
        "猫 [sealed value redacted]"
    );
    assert_eq!(
        prepare_embedding_query("{{invalid}} {{").unwrap(),
        "{{invalid}} {{"
    );
}
#[test]
fn shared_dream_markdown_projection_uses_frontmatter_citations_only() {
    for case in corpus("dream-golden")["serialization"].as_array().unwrap() {
        let upsert = serde_json::from_value(case["upsert"].clone()).unwrap();
        let markdown = kb_local::dream::serialize_dream_markdown(&upsert);
        assert_eq!(
            markdown.as_bytes(),
            case["markdown"].as_str().unwrap().as_bytes()
        );
        let parsed = kb_local::markdown::parse_markdown(markdown.as_bytes()).unwrap();
        let result = chunk_body(&markdown[parsed.body_start..]);
        let expected = upsert.body.split_whitespace().collect::<Vec<_>>().join(" ");
        assert_eq!(
            result.chunks.first().map(|c| c.text.as_str()).unwrap_or(""),
            expected
        );
        assert_eq!(parsed.citations.len(), upsert.citations.len());
    }
}
#[test]
fn shared_structured_corpus_matches_exact_rows_metadata_and_time_boundaries() {
    let fixture = corpus("structured-search");
    let documents: Vec<_> = fixture["documents"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(path, md)| {
            let md = md.as_str().unwrap();
            let parsed = kb_local::markdown::parse_markdown(md.as_bytes()).unwrap();
            (
                path,
                extract_structured_document(
                    &parsed,
                    &md[parsed.body_start..],
                    fixture["commitTimestamp"].as_str().unwrap(),
                )
                .unwrap(),
                chunk_body(&md[parsed.body_start..]),
            )
        })
        .collect();
    for case in fixture["structured"].as_array().unwrap() {
        let filters: StructuredFilters = serde_json::from_value(case["input"].clone()).unwrap();
        let mut hits = vec![];
        for (path, doc, chunks) in &documents {
            for row in match_structured_document(doc, &filters).unwrap() {
                let chunk = chunks.chunks.iter().find(|c| {
                    row.is_none_or(|r| {
                        c.span.start_byte <= r.span.start_byte && c.span.end_byte >= r.span.end_byte
                    })
                });
                if let Some(c) = chunk {
                    hits.push(json!({"path":path,"chunkIndex":c.chunk_index,"matchedRow":row.map(|r| &r.values)}));
                }
            }
        }
        assert_eq!(json!(hits), case["expected"], "{}", case["name"]);
    }
}
#[test]
fn gfm_scalar_conversion_exact_crlf_unicode_spans_and_code_exclusion() {
    let body = "猫\r\n\r\n| name | n | yes | nothing | object | code |\r\n|---|---:|:---|:---:|---|---|\r\n| café | 1.25 | true | null | {\"x\":1} | a\\|b |\r\n| \"quoted\" | 1e30 | false | \"null\" | [1] | `c\\|d` |\r\n";
    let rows = extract_table_rows(body).unwrap();
    assert_eq!(
        json!(rows.iter().map(|r| &r.values).collect::<Vec<_>>()),
        json!([
            {"name":"café","n":1.25,"yes":true,"nothing":null,"object":"{\"x\":1}","code":"a|b"},
            {"name":"quoted","n":1e30,"yes":false,"nothing":"null","object":"[1]","code":"`c|d`"}
        ])
    );
    for r in &rows {
        let source = &body[r.span.start_byte as usize..r.span.end_byte as usize];
        assert_eq!(source, body.split("\r\n").nth(r.row_index + 4).unwrap());
        let words: Vec<_> = body.split_whitespace().collect();
        assert_eq!(
            words[r.span.start_token as usize..r.span.end_token as usize].join(" "),
            source.split_whitespace().collect::<Vec<_>>().join(" ")
        );
    }
    let rows=extract_table_rows("```md\na|b\n-|-\nx|y\n```` trailing\n~~~\n```\n\na|b\n-|-\nx|\ny|z|extra\n\n    a|b\n    -|-\n    x|y\n").unwrap();
    assert_eq!(
        json!(rows.iter().map(|r| &r.values).collect::<Vec<_>>()),
        json!([{ "a":"x", "b":"" }, {"a":"y", "b":"z"}])
    );
    assert_eq!(
        extract_table_rows("a|b\n-|-\na\\\\|b\n").unwrap()[0].values["a"],
        "a\\"
    );
    assert_eq!(
        extract_table_rows("a|b\n-|-\n\u{a0}true\u{a0}|false\nplain").unwrap()[0].values["a"],
        "\u{a0}true\u{a0}"
    );
    assert!(
        extract_table_rows("~~~\na|b\n-|-\nx|y\n~~~\n")
            .unwrap()
            .is_empty()
    );
}
#[test]
fn structured_defaults_normalization_bounds_rejections_and_inverse_cases() {
    assert!(extract_table_rows("a|b\n-|-\n\"\\uD800\"|y").is_err());
    assert!(extract_table_rows("a|b\n-|-\n\"\\uDC00\"|y").is_err());
    assert_eq!(
        extract_table_rows("a|b\n-|-\n\"\\uD800\\uDC00\"|y").unwrap()[0].values["a"],
        "𐀀"
    );
    assert_eq!(
        extract_table_rows("a|b\n-|-\n\"\\uD800\" trailing|y").unwrap()[0].values["a"],
        "\"\\uD800\" trailing"
    );
    let empty = structured("");
    assert!(empty.rows.is_empty());
    assert_eq!(
        match_structured_document(&empty, &Default::default()).unwrap(),
        vec![None]
    );
    let value = structured(
        "---\ntype: \" Report \"\ntitle: \"Straße Σ ᾀ\"\ntags: [\" café \", \"café\", \"Work\", 1]\n---\nbody",
    );
    assert_eq!(value.tags, vec!["café", "Work"]);
    for title in ["STRASSE", "ς", "ἀι"] {
        let f =
            serde_json::from_value(json!({"title":title,"type":"Report","tags":["café"]})).unwrap();
        assert_eq!(match_structured_document(&value, &f).unwrap(), vec![None]);
    }
    for f in [
        json!({"tags":["work"]}),
        json!({"type":"report"}),
        json!({"timestamp":{"before":STAMP}}),
    ] {
        assert!(
            match_structured_document(&value, &serde_json::from_value(f).unwrap())
                .unwrap()
                .is_empty()
        );
    }
    for range in [
        json!({"after":STAMP,"before":STAMP}),
        json!({"after":"2027-01-01T00:00:00Z","before":STAMP}),
        json!({"after":"bad"}),
        json!({"before":"2026-02-30T00:00:00Z"}),
    ] {
        let f = serde_json::from_value(json!({"timestamp":range})).unwrap();
        assert!(match_structured_document(&value, &f).is_err());
    }
    for valid_from in ["bad", "null", "2026-02-30T00:00:00Z"] {
        let md = format!("---\nvalid_from: {valid_from}\n---\nbody");
        let p = kb_local::markdown::parse_markdown(md.as_bytes()).unwrap();
        assert!(extract_structured_document(&p, "body", STAMP).is_err());
    }
    assert_eq!(
        extract_table_rows(&format!("a|b\n-|-\n{}", "x|y\n".repeat(1024)))
            .unwrap()
            .len(),
        1024
    );
    for body in [
        format!("a|b\n-|-\n{}", "x|y\n".repeat(1025)),
        format!("a|b\n-|-\n{}|y", "😀".repeat(1025)),
        format!("{}|b\n-|-\nx|y", "a".repeat(257)),
        "a|a\n-|-\nx|y".into(),
        format!(
            "{}\n{}",
            (0..65)
                .map(|n| format!("h{n}"))
                .collect::<Vec<_>>()
                .join("|"),
            vec!["-"; 65].join("|")
        ),
    ] {
        assert!(extract_table_rows(&body).is_err());
    }
    assert_eq!(
        extract_table_rows(&format!("a|b\n-|-\n{}|y", json!("😀".repeat(1024)))).unwrap()[0].values
            ["a"],
        "😀".repeat(1024)
    );
    for f in [
        json!({"structured":[{"column":"x","equals":{}}]}),
        json!({"structured":vec![json!({"column":"x","equals":1});17]}),
        json!({"tags":vec!["x";17]}),
    ] {
        assert!(match_structured_document(&value, &serde_json::from_value(f).unwrap()).is_err());
    }
}
#[test]
fn fingerprint_full_endpoint_semantics_every_version_no_credentials() {
    use kb_local::{egress::Endpoint, providers::ProviderConfig};
    let mut c = ProviderConfig {
        idempotency_key: "fixture-key-00000000".into(),
        provider_id: None,
        name: "fixture".into(),
        endpoint_url: "https://EXAMPLE.com:443/v1/embeddings".into(),
        model: "embed".into(),
        dimensions: 2,
    };
    let endpoint = Endpoint::parse(&c.endpoint_url, false).unwrap();
    let base =
        embedding_fingerprint(&endpoint, &c.model, c.dimensions, &EMBEDDING_VERSIONS).unwrap();
    assert_eq!(c.fingerprint(&endpoint).unwrap(), base);
    assert_eq!(base.len(), 71);
    assert_eq!(
        embedding_fingerprint(
            &Endpoint::parse("https://example.com/v1/embeddings", false).unwrap(),
            "embed",
            2,
            &EMBEDDING_VERSIONS
        )
        .unwrap(),
        base
    );
    for url in [
        "https://example.com:8443/v1/embeddings",
        "https://example.com/tenant/v1/embeddings",
    ] {
        assert_ne!(
            embedding_fingerprint(
                &Endpoint::parse(url, false).unwrap(),
                "embed",
                2,
                &EMBEDDING_VERSIONS
            )
            .unwrap(),
            base
        );
    }
    assert_ne!(
        embedding_fingerprint(&endpoint, "other", 2, &EMBEDDING_VERSIONS).unwrap(),
        base
    );
    assert_ne!(
        embedding_fingerprint(&endpoint, "embed", 3, &EMBEDDING_VERSIONS).unwrap(),
        base
    );
    for n in 0..EMBEDDING_VERSIONS.len() {
        let mut versions = EMBEDDING_VERSIONS;
        versions[n] = "next";
        assert_ne!(
            embedding_fingerprint(&endpoint, "embed", 2, &versions).unwrap(),
            base
        );
    }
    let ts = include_str!("../../../../../packages/api/src/lib/kb/fingerprint.ts");
    assert_eq!(
        base,
        "sha256:d1054c2257fccb11aa797f9dc54c8b52922c10dab1acc908a65313ccbbc9c796"
    );
    let table = ts
        .split_once("export const EMBEDDING_VERSIONS = {")
        .unwrap()
        .1
        .split_once("} as const;")
        .unwrap()
        .0;
    let ts_versions: Vec<_> = table
        .lines()
        .filter_map(|line| line.split_once(':'))
        .map(|(_, value)| value.trim().trim_end_matches(',').trim_matches('"'))
        .collect();
    assert_eq!(ts_versions, EMBEDDING_VERSIONS);
    c.name = "canary-rotated".into();
    c.idempotency_key = "different-idempotency".into();
    assert_eq!(c.fingerprint(&endpoint).unwrap(), base);
}
#[test]
fn markdown_only_converter_source_identity_citations_and_pinned_manifest() {
    use kb_local::tree::ManifestEntry;
    let rev = Sha::parse("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").unwrap();
    let other = Sha::parse("cccccccccccccccccccccccccccccccccccccccc").unwrap();
    let path = KbPath::parse("docs/note.md").unwrap();
    let asset = ManifestEntry {
        path: "images/a b.png".into(),
        hash: format!("sha256:{}", "b".repeat(64)),
        size: 12,
        mime: "image/png".into(),
    };
    let entries = [
        asset.clone(),
        ManifestEntry {
            path: "unused.png".into(),
            ..asset.clone()
        },
    ];
    let md = "---\nid: doc-1\ntitle: \"metadata [fake](../unused.png)\"\ncitations:\n  - label: episode\n    target: \"cockpit:episode/42\"\n---\n猫 ![image](../images/a%20b.png) [inline](https://example.com)\n";
    let mut input = ConversionInput {
        media_type: "text/markdown",
        bytes: md.as_bytes(),
        path: &path,
        commit_sha: &rev,
        commit_timestamp: STAMP,
        manifest_commit_sha: &rev,
        manifest_entries: &entries,
    };
    let converted = convert_source(&input).unwrap();
    assert_eq!(converted.source.markdown, md);
    assert_eq!(converted.source.content_hash, content_hash(md.as_bytes()));
    assert_eq!(converted.source.blob_sha, git_blob_sha(md.as_bytes()));
    assert_eq!(converted.asset_refs.len(), 1);
    assert_eq!(converted.asset_refs[0].path.as_str(), asset.path);
    assert_eq!(converted.source.citations.len(), 1);
    assert_eq!(converted.source.citations[0].target, "cockpit:episode/42");
    assert!(!converted.chunked.chunks[0].text.contains("metadata"));
    input.manifest_commit_sha = &other;
    assert!(convert_source(&input).is_err());
    input.manifest_commit_sha = &rev;
    for media in [
        "application/pdf",
        "image/png",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ] {
        input.media_type = media;
        assert_eq!(
            convert_source(&input).unwrap_err().code(),
            "UNSUPPORTED_MEDIA"
        );
        assert_eq!(
            kb_local::markdown::convert_markdown_source(&input)
                .unwrap_err()
                .protocol_code(),
            ErrorCode::InvalidArgument
        );
    }
    input.media_type = "text/markdown";
    input.bytes = b"";
    let empty = convert_source(&input).unwrap();
    assert!(empty.chunked.chunks.is_empty());
    assert_eq!(empty.chunked.original_window_count, 0);
    let canary = "sk-fixture-canary-0123456789";
    let private = format!("---\nprivate: {canary}\n---\nsafe");
    input.bytes = private.as_bytes();
    assert_eq!(
        convert_source(&input).unwrap().chunked.chunks[0].text,
        "safe"
    );
    let bad = format!("---\ncitations: {canary}\n---\nbody");
    input.bytes = bad.as_bytes();
    let e = convert_source(&input).unwrap_err();
    assert!(!format!("{e:?}").contains(canary));
    let oversized = vec![b'a'; 2 * 1024 * 1024 + 1];
    input.bytes = &oversized;
    assert!(convert_source(&input).is_err());
    input.bytes = &oversized[..2 * 1024 * 1024];
    assert!(convert_source(&input).is_ok());
}
