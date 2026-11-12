//! kb/1 contract parity: the Rust client must accept and reject exactly what the
//! canonical TypeScript runtime does. The corpus is read directly from the
//! repository (`packages/api/src/lib/kb/protocol/`); there is no Rust-only copy.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::Command;

use kb_client::error::{ErrorCode, ErrorDetails, KbError, ProtocolError};
use kb_client::types::{
    self, ChangesApply, Freshness, IdempotencyKey, KbId, KnowledgeSearch, SearchInput, Sha,
};
use kb_client::{
    PROTOCOL_VERSION, SecretToken, Tool, ToolName, decode_envelope, decode_output, encode_input,
    encode_success_envelope,
};
use serde_json::{Value, json};

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../..")
        .canonicalize()
        .expect("repository root")
}

fn protocol_file(name: &str) -> Value {
    let path = repo_root()
        .join("packages/api/src/lib/kb/protocol")
        .join(name);
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    serde_json::from_str(&raw).expect("canonical protocol JSON")
}

fn corpus() -> Value {
    protocol_file("fixtures.json")
}

fn labelled(row: &Value, key: &str) -> Vec<(String, Value)> {
    row[key]
        .as_array()
        .unwrap_or_else(|| panic!("corpus row lacks `{key}`"))
        .iter()
        .map(|entry| {
            (
                entry["label"].as_str().expect("label").to_owned(),
                entry["value"].clone(),
            )
        })
        .collect()
}

// ── Catalog ─────────────────────────────────────────────────────────────────

#[test]
fn catalog_is_the_known_artifact_version() {
    let schema = protocol_file("schema.json");
    assert_eq!(schema["schemaVersion"], PROTOCOL_VERSION);
    let artifact: BTreeSet<&str> = schema["tools"]
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    let known: BTreeSet<&str> = ToolName::ALL.iter().map(|t| t.as_str()).collect();
    assert_eq!(artifact, known, "Rust catalog drifted from schema.json");
    assert_eq!(
        ToolName::ALL.len(),
        known.len(),
        "duplicate catalog entries"
    );
    for name in ToolName::ALL {
        let catalog = &schema["tools"][name.as_str()]["catalog"];
        assert_eq!(
            catalog["readOnly"].as_bool(),
            Some(name.read_only()),
            "{name}"
        );
        let scope = if name.read_only() {
            "mcp:read"
        } else {
            "mcp:write"
        };
        if !name.read_only() {
            assert_eq!(catalog["requiredMcpScope"], scope, "{name}");
        }
    }
}

#[test]
fn arbitrary_operation_names_are_rejected() {
    for bad in [
        "",
        "knowledge_evil",
        "tools/call",
        "KNOWLEDGE_SEARCH",
        "knowledge_search ",
    ] {
        let err = bad.parse::<ToolName>().unwrap_err();
        assert!(
            matches!(err, KbError::Protocol(ProtocolError::UnknownTool)),
            "{bad}"
        );
    }
}

// ── Fixture parity ──────────────────────────────────────────────────────────

#[test]
fn every_tool_accepts_valid_fixtures_and_round_trips_them() {
    let corpus = corpus();
    assert_eq!(corpus["schemaVersion"], PROTOCOL_VERSION);
    for name in ToolName::ALL {
        let row = &corpus["tools"][name.as_str()];
        let mut inputs = vec![("validInput".to_owned(), row["validInput"].clone())];
        inputs.extend(labelled(row, "validInputVariants"));
        for (label, value) in inputs {
            let canonical = name
                .check_input(value.clone())
                .unwrap_or_else(|e| panic!("{name}:{label} rejected: {e}"));
            assert_eq!(
                canonical, value,
                "{name}:{label} typed round-trip changed the value"
            );
        }
        let mut outputs = vec![("validOutput".to_owned(), row["validOutput"].clone())];
        outputs.extend(labelled(row, "validOutputVariants"));
        for (label, value) in outputs {
            let canonical = name
                .check_output(value.clone())
                .unwrap_or_else(|e| panic!("{name}:{label} rejected: {e}"));
            assert_eq!(
                canonical, value,
                "{name}:{label} typed round-trip changed the value"
            );
        }
    }
}

#[test]
fn every_tool_rejects_invalid_fixtures() {
    let corpus = corpus();
    for name in ToolName::ALL {
        let row = &corpus["tools"][name.as_str()];
        let invalid_inputs = labelled(row, "invalidInputs");
        assert!(!invalid_inputs.is_empty(), "{name} has no invalid inputs");
        for (label, value) in invalid_inputs {
            let err = name
                .check_input(value)
                .expect_err(&format!("{name}:{label} accepted"));
            assert!(
                matches!(err, KbError::Protocol(ProtocolError::InvalidInput(_))),
                "{name}:{label}: {err:?}"
            );
            assert_eq!(err.code(), ErrorCode::InvalidArgument, "{name}:{label}");
        }
        let invalid_outputs = labelled(row, "invalidOutputs");
        assert!(!invalid_outputs.is_empty(), "{name} has no invalid outputs");
        for (label, value) in invalid_outputs {
            let err = name
                .check_output(value)
                .expect_err(&format!("{name}:{label} accepted"));
            assert!(
                matches!(err, KbError::Protocol(ProtocolError::InvalidOutput(_))),
                "{name}:{label}: {err:?}"
            );
        }
    }
}

#[test]
fn corpus_covers_every_required_rejection_class() {
    // One named case per acceptance class, so a generator regression that drops
    // a class fails here instead of silently shrinking coverage.
    let corpus = corpus();
    let has = |tool: &str, key: &str, label: &str| {
        labelled(&corpus["tools"][tool], key)
            .iter()
            .any(|(l, _)| l == label)
    };
    for (tool, key, label) in [
        ("knowledge_search", "invalidInputs", "unknown-field"),
        ("knowledge_transfer_read", "invalidInputs", "unsafe-offset"),
        (
            "knowledge_transfer_read",
            "invalidInputs",
            "fractional-offset",
        ),
        (
            "knowledge_transfer_read",
            "validInputVariants",
            "max-safe-offset",
        ),
        (
            "knowledge_structured_search",
            "invalidInputs",
            "impossible-calendar-date",
        ),
        (
            "knowledge_structured_search",
            "invalidInputs",
            "equal-timestamps",
        ),
        (
            "knowledge_structured_search",
            "invalidInputs",
            "inverted-timestamps",
        ),
        (
            "knowledge_upload_write",
            "invalidInputs",
            "non-canonical-padding-bits",
        ),
        ("knowledge_upload_write", "invalidInputs", "bad-base64"),
        (
            "knowledge_changes_apply",
            "invalidInputs",
            "dream-body-over-64kib-utf8",
        ),
        (
            "knowledge_changes_apply",
            "validInputVariants",
            "dream-body-64kib-utf8",
        ),
        ("knowledge_search", "invalidInputs", "query-1025-scalars"),
        (
            "knowledge_search",
            "validInputVariants",
            "query-1024-astral-scalars",
        ),
        (
            "knowledge_documents_get",
            "invalidInputs",
            "null-optional-rev",
        ),
        (
            "knowledge_documents_get",
            "invalidOutputs",
            "absent-nullable-documentId",
        ),
        (
            "knowledge_search",
            "invalidOutputs",
            "hit-missing-matched-row",
        ),
        (
            "knowledge_index_status",
            "invalidOutputs",
            "unsafe-dimensions",
        ),
    ] {
        assert!(has(tool, key, label), "corpus lacks {tool}.{key}:{label}");
    }
}

// ── Typed construction enforces runtime limits ─────────────────────────────

fn kb_id() -> KbId {
    KbId::parse("abcdefghijklmnopqrstuvwx").expect("fixture id")
}

#[test]
fn typed_scalars_reject_malformed_values() {
    assert!(KbId::parse("ABCDEFGHIJKLMNOPQRSTUVWX").is_err());
    assert!(KbId::parse("short").is_err());
    assert!(Sha::parse(&"0".repeat(39)).is_err());
    assert!(Sha::parse(&"0".repeat(40)).is_ok());
    assert!(IdempotencyKey::parse("fixture-idempotency-key-01").is_ok());
    assert!(IdempotencyKey::parse("has space in it!!").is_err());
    assert!(types::KbPath::parse("docs/../x.md").is_err());
    assert!(types::KbPath::parse("docs/guide.md").is_ok());
    assert!(types::IsoInstant::parse("2024-02-29T00:00:00Z").is_ok());
    assert!(types::IsoInstant::parse("2023-02-29T00:00:00Z").is_err());
    assert!(types::IsoInstant::parse("0099-01-01T00:00:00Z").is_err());
    // serde goes through the same validation.
    assert!(serde_json::from_value::<KbId>(json!("NOT-AN-ID")).is_err());
}

#[test]
fn encode_input_enforces_scalar_and_utf8_limits_beyond_serde_shape() {
    let ok = SearchInput {
        kb_id: kb_id(),
        query: "😀".repeat(1024),
        limit: Some(20),
        path_prefix: None,
        document_id: None,
    };
    let encoded = encode_input::<KnowledgeSearch>(&ok).expect("1024 scalars accepted");
    assert_eq!(encoded["query"].as_str().unwrap().chars().count(), 1024);
    assert!(
        encoded.get("pathPrefix").is_none(),
        "absent optional keys stay absent"
    );

    let too_long = SearchInput {
        query: "😀".repeat(1025),
        ..ok.clone()
    };
    assert!(matches!(
        encode_input::<KnowledgeSearch>(&too_long),
        Err(KbError::Protocol(ProtocolError::InvalidInput(_)))
    ));
    let over_limit = SearchInput {
        limit: Some(21),
        ..ok
    };
    assert!(encode_input::<KnowledgeSearch>(&over_limit).is_err());
}

#[test]
fn dream_change_set_body_is_capped_in_utf8_bytes() {
    let corpus = corpus();
    let dream = labelled(
        &corpus["tools"]["knowledge_changes_apply"],
        "validInputVariants",
    )
    .into_iter()
    .find(|(l, _)| l == "dream-body-64kib-utf8")
    .unwrap()
    .1;
    let mut typed: types::ChangesApplyInput = serde_json::from_value(dream).unwrap();
    assert!(encode_input::<ChangesApply>(&typed).is_ok());
    typed.dream.as_mut().unwrap().upserts[0].body.push('é');
    assert!(encode_input::<ChangesApply>(&typed).is_err());
}

// ── Envelope ────────────────────────────────────────────────────────────────

fn populated_search_output() -> Value {
    labelled(
        &corpus()["tools"]["knowledge_search"],
        "validOutputVariants",
    )
    .into_iter()
    .find(|(l, _)| l == "populated-hit")
    .expect("populated-hit variant")
    .1
}

#[test]
fn success_envelope_round_trip_preserves_fields_and_spans() {
    let data = populated_search_output();
    let envelope = json!({ "schemaVersion": "kb/1", "data": data.clone() });
    let decoded = decode_envelope::<KnowledgeSearch>(envelope.clone()).expect("decodes");
    let hit = &decoded.results[0];
    assert_eq!(hit.span.start_token, 7);
    assert_eq!(hit.span.end_token, 19);
    assert_eq!(hit.span.start_byte, 41);
    assert_eq!(hit.span.end_byte, 133);
    assert_eq!(hit.freshness, Freshness::Stale);
    assert!(hit.matched_row.is_some());
    let reencoded = encode_success_envelope::<KnowledgeSearch>(&decoded).expect("encodes");
    assert_eq!(reencoded, envelope);
    // Typed output decode directly (no envelope) matches too.
    let direct = decode_output::<KnowledgeSearch>(data).unwrap();
    assert_eq!(direct, decoded);
}

#[test]
fn schema_version_mismatch_is_a_typed_protocol_error() {
    let data = populated_search_output();
    for version in [json!("kb/2"), json!("KB/1"), json!(1), Value::Null] {
        let err = decode_envelope::<KnowledgeSearch>(
            json!({ "schemaVersion": version, "data": data.clone() }),
        )
        .unwrap_err();
        assert!(
            matches!(err, KbError::Protocol(ProtocolError::SchemaVersionMismatch)),
            "{version}: {err:?}"
        );
    }
    let missing = decode_envelope::<KnowledgeSearch>(json!({ "data": data })).unwrap_err();
    assert!(matches!(
        missing,
        KbError::Protocol(ProtocolError::SchemaVersionMismatch)
    ));
}

#[test]
fn malformed_envelopes_are_protocol_errors() {
    let data = populated_search_output();
    for bad in [
        json!({ "schemaVersion": "kb/1" }),
        json!({ "schemaVersion": "kb/1", "data": data.clone(), "extra": 1 }),
        json!({ "schemaVersion": "kb/1", "data": data.clone(), "error": {} }),
        json!([]),
    ] {
        let err = decode_envelope::<KnowledgeSearch>(bad.clone()).unwrap_err();
        assert!(
            matches!(err, KbError::Protocol(ProtocolError::MalformedEnvelope)),
            "{bad}"
        );
    }
}

#[test]
fn error_envelopes_decode_to_the_closed_error_union() {
    let conflict = json!({
        "schemaVersion": "kb/1",
        "error": {
            "code": "CONFLICT",
            "message": "Conflict",
            "retryable": false,
            "details": { "headSha": "0".repeat(40), "proposalNumber": null }
        }
    });
    let err = decode_envelope::<KnowledgeSearch>(conflict).unwrap_err();
    let KbError::Tool(tool_error) = &err else {
        panic!("{err:?}")
    };
    assert_eq!(tool_error.code(), ErrorCode::Conflict);
    assert!(!tool_error.retryable());
    assert!(matches!(
        tool_error.details(),
        ErrorDetails::Conflict {
            proposal_number: None,
            ..
        }
    ));

    let rate = json!({
        "schemaVersion": "kb/1",
        "error": {
            "code": "RATE_LIMITED",
            "message": "Rate limited",
            "retryable": true,
            "details": { "retryAfterSeconds": 5 }
        }
    });
    let err = decode_envelope::<KnowledgeSearch>(rate).unwrap_err();
    assert!(err.retryable());
    assert!(matches!(
        err,
        KbError::Tool(ref t) if *t.details() == ErrorDetails::RateLimited { retry_after_seconds: 5 }
    ));

    // Server-chosen text, wrong retryability or code-mismatched details are
    // protocol violations, not tool errors.
    for bad in [
        json!({ "code": "NOT_FOUND", "message": "secret path /etc", "retryable": false, "details": {} }),
        json!({ "code": "NOT_FOUND", "message": "Not found", "retryable": true, "details": {} }),
        json!({ "code": "NOT_FOUND", "message": "Not found", "retryable": false,
                "details": { "retryAfterSeconds": 5 } }),
        json!({ "code": "NOPE", "message": "Not found", "retryable": false, "details": {} }),
    ] {
        let err =
            decode_envelope::<KnowledgeSearch>(json!({ "schemaVersion": "kb/1", "error": bad }))
                .unwrap_err();
        assert!(
            matches!(err, KbError::Protocol(ProtocolError::MalformedEnvelope)),
            "{err:?}"
        );
    }
}

#[test]
fn retryable_codes_are_the_fixed_contract_set() {
    let retryable: BTreeSet<&str> = ErrorCode::ALL
        .iter()
        .filter(|c| c.retryable())
        .map(|c| c.as_str())
        .collect();
    assert_eq!(
        retryable,
        BTreeSet::from([
            "DEADLINE_EXCEEDED",
            "INDEX_UNAVAILABLE",
            "RATE_LIMITED",
            "STORAGE_UNAVAILABLE"
        ])
    );
    assert_eq!(ErrorCode::ALL.len(), 19);
}

// ── Secrets ─────────────────────────────────────────────────────────────────

const CANARY: &str = "kbpat_CANARY_do_not_leak_0123456789abcdef";

#[test]
fn secret_token_never_renders_its_value() {
    let token = SecretToken::new(CANARY.to_owned());
    assert_eq!(token.expose_secret(), CANARY);
    let debug = format!("{token:?}");
    let display = format!("{token}");
    let pretty = format!("{token:#?}");
    for rendered in [&debug, &display, &pretty] {
        assert!(!rendered.contains(CANARY), "{rendered}");
        assert!(!rendered.contains("CANARY"), "{rendered}");
    }
    assert!(debug.contains("redacted"));
}

#[test]
fn errors_never_echo_input_values() {
    // A canary-bearing value that fails validation must not surface in the
    // error text or Debug output.
    let input = json!({ "kbId": "abcdefghijklmnopqrstuvwx", "query": CANARY.repeat(40) });
    let err = ToolName::KnowledgeSearch.check_input(input).unwrap_err();
    assert!(!format!("{err}").contains("CANARY"));
    assert!(!format!("{err:?}").contains("CANARY"));

    let bad_id = serde_json::from_value::<KbId>(json!(CANARY)).unwrap_err();
    assert!(!bad_id.to_string().contains("CANARY"));

    let envelope = json!({ "schemaVersion": CANARY, "data": {} });
    let err = decode_envelope::<KnowledgeSearch>(envelope).unwrap_err();
    assert!(!format!("{err} {err:?}").contains("CANARY"));
}

// ── Transport primitives ────────────────────────────────────────────────────

#[test]
fn cancellation_and_deadline_map_to_contract_codes() {
    use kb_client::error::{CancellationToken, Deadline};
    use std::time::Duration;

    let token = CancellationToken::new();
    let child = token.clone();
    assert!(!child.is_cancelled());
    assert!(token.check().is_ok());
    token.cancel();
    assert!(child.is_cancelled());
    let err = child.check().unwrap_err();
    assert_eq!(err.code(), ErrorCode::Cancelled);
    assert!(!err.retryable());

    let expired = Deadline::after(Duration::ZERO);
    let err = expired.check().unwrap_err();
    assert_eq!(err.code(), ErrorCode::DeadlineExceeded);
    assert!(err.retryable());
    let later = Deadline::after(Duration::from_secs(3600));
    assert!(later.check().is_ok());
    assert!(later.remaining() > Duration::from_secs(3000));
}

// ── Workspace wiring ────────────────────────────────────────────────────────

// Deliberately accept only the workflows' simple, unconditional fetch step.
// An unfamiliar spelling must be reviewed, not silently counted as a prerequisite.
fn check_workflow_fetches(workflow: &str) -> Result<usize, String> {
    let mut job = "";
    let mut fetched = false;
    let mut callers = 0;
    let lines: Vec<_> = workflow.lines().collect();
    for (i, line) in lines.iter().enumerate() {
        if line.starts_with("  ") && !line.starts_with("   ") && line.ends_with(':') {
            job = line.trim();
            fetched = false;
        }
        if !line.starts_with("      - ") {
            continue;
        }
        let end = lines[i + 1..]
            .iter()
            .position(|next| !next.trim().is_empty() && !next.starts_with("        "))
            .map_or(lines.len(), |end| i + 1 + end);
        let step = &lines[i..end];
        let run = step.iter().find_map(|line| {
            line.strip_prefix("      - run: ")
                .or_else(|| line.strip_prefix("        run: "))
        });
        if run == Some("cargo fetch --locked") {
            if step.iter().any(|line| {
                let line = line.trim();
                line.starts_with("if:")
                    || line.starts_with("continue-on-error:")
                    || line.starts_with("env:")
            }) {
                return Err(format!(
                    "{job}: fetch must be unconditional and fail closed"
                ));
            }
            fetched = true;
        }
        // Include every caller, including future jobs/files. Doc-only cargo
        // tests never invoke the dependency-graph integration test.
        if step.iter().any(|line| {
            let line = line.trim();
            !line.starts_with('#') && line.contains("cargo test") && !line.contains("--doc")
        }) {
            callers += 1;
            if !fetched {
                return Err(format!(
                    "{job}: offline metadata needs an earlier all-platform fetch"
                ));
            }
        }
    }
    Ok(callers)
}

#[test]
fn ci_fetches_all_platform_dependencies_before_offline_metadata_tests() {
    let mut callers = 0;
    for file in std::fs::read_dir(repo_root().join(".github/workflows")).unwrap() {
        let path = file.unwrap().path();
        if !matches!(
            path.extension().and_then(|s| s.to_str()),
            Some("yml" | "yaml")
        ) {
            continue;
        }
        let workflow = std::fs::read_to_string(&path).unwrap();
        callers += check_workflow_fetches(&workflow)
            .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    }
    assert!(
        callers >= 3,
        "test, MSRV and release-preflight callers must be inventoried"
    );
}

#[test]
fn workflow_fetch_guard_rejects_comments_conditions_and_late_fetches() {
    let test = "      - run: cargo test --workspace --all-targets --locked\n";
    let fetch = "      - run: cargo fetch --locked\n";
    assert_eq!(
        check_workflow_fetches(&format!("{fetch}{test}")).unwrap(),
        1
    );
    assert_eq!(
        check_workflow_fetches(&format!(
            "      - name: Fetch every platform\n        run: cargo fetch --locked\n{test}"
        ))
        .unwrap(),
        1
    );
    for invalid in [
        format!("      # - run: cargo fetch --locked\n{test}"),
        format!("{fetch}        if: false\n{test}"),
        format!("{fetch}        continue-on-error: true\n{test}"),
        format!("{fetch}        env:\n          CARGO_HOME: another-cache\n{test}"),
        format!("{test}{fetch}"),
        format!("{fetch}  another-job:\n{test}"),
        format!("      - run: cargo fetch --locked || true\n{test}"),
        format!("      - run: cargo fetch --locked --target x86_64-unknown-linux-gnu\n{test}"),
    ] {
        assert!(check_workflow_fetches(&invalid).is_err(), "{invalid}");
    }
}

#[test]
fn dependency_graph_has_no_cli_back_edge() {
    let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".to_owned());
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
    let output = Command::new(cargo)
        .args([
            "metadata",
            "--format-version",
            "1",
            "--locked",
            "--offline",
            "--manifest-path",
        ])
        .arg(&manifest)
        .output()
        .expect("cargo metadata runs");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let metadata: Value = serde_json::from_slice(&output.stdout).unwrap();
    let packages = metadata["packages"].as_array().unwrap();
    let name_of = |id: &str| {
        packages
            .iter()
            .find(|p| p["id"] == id)
            .map(|p| p["name"].as_str().unwrap().to_owned())
            .unwrap()
    };
    let nodes = metadata["resolve"]["nodes"].as_array().unwrap();
    let root = packages.iter().find(|p| p["name"] == "kb-client").unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    // Walk the normal (non-dev, non-build) dependency closure of kb-client.
    let mut seen = BTreeSet::new();
    let mut stack = vec![root];
    while let Some(id) = stack.pop() {
        if !seen.insert(id.clone()) {
            continue;
        }
        let node = nodes.iter().find(|n| n["id"] == id.as_str()).unwrap();
        for dep in node["deps"].as_array().unwrap() {
            let normal = dep["dep_kinds"]
                .as_array()
                .unwrap()
                .iter()
                .any(|k| k["kind"].is_null());
            if normal {
                stack.push(dep["pkg"].as_str().unwrap().to_owned());
            }
        }
    }
    let names: BTreeSet<String> = seen.iter().map(|id| name_of(id)).collect();
    for forbidden in [
        "kb",
        "xtask",
        "clap",
        "clap_complete",
        "tracing-subscriber",
        "anyhow",
    ] {
        assert!(
            !names.contains(forbidden),
            "kb-client depends on `{forbidden}`: {names:?}"
        );
    }
    // And the CLI crate is the consumer direction only if it opts in later;
    // today kb-client is a workspace member either way.
    let members: Vec<String> = metadata["workspace_members"]
        .as_array()
        .unwrap()
        .iter()
        .map(|id| name_of(id.as_str().unwrap()))
        .collect();
    assert!(members.contains(&"kb-client".to_owned()));
}

// Parse only the workflow's reviewed event/path-list layout, failing closed on
// unfamiliar entries. Counting occurrences anywhere misses duplicated push paths.
fn workflow_event_paths(workflow: &str, event: &str) -> BTreeSet<String> {
    let mut in_events = false;
    let mut in_event = false;
    let mut in_paths = false;
    let mut paths = BTreeSet::new();
    for line in workflow.lines() {
        if !line.is_empty() && !line.starts_with(' ') && !line.starts_with('#') {
            in_events = line == "on:";
            in_event = false;
            in_paths = false;
            continue;
        }
        if !in_events {
            continue;
        }
        if line.starts_with("  ") && !line.starts_with("   ") {
            in_event = line == format!("  {event}:");
            in_paths = false;
        } else if in_event && line.starts_with("    ") && !line.starts_with("     ") {
            in_paths = line == "    paths:";
        } else if in_paths && !line.trim().is_empty() && !line.trim().starts_with('#') {
            let path = line
                .strip_prefix("      - ")
                .expect("review unfamiliar paths layout");
            let path = path
                .strip_prefix('"')
                .and_then(|s| s.strip_suffix('"'))
                .expect("path entries must be quoted literals");
            assert!(
                paths.insert(path.to_owned()),
                "duplicate path in {event}: {path}"
            );
        }
    }
    paths
}

#[test]
fn ci_path_filters_cover_cli_crates_and_shared_protocol_inputs() {
    let workflow =
        std::fs::read_to_string(repo_root().join(".github/workflows/cli-ci.yml")).unwrap();
    for event in ["push", "pull_request"] {
        let paths = workflow_event_paths(&workflow, event);
        // Complete external-input inventory: embedded protocol, path table,
        // local drift tests, adapter corpora and every enumerated workflow.
        for path in [
            "apps/cli/**",
            "packages/api/src/lib/kb/protocol/**",
            "packages/api/src/lib/kb/paths.ts",
            "packages/api/src/lib/kb/limits.ts",
            "packages/api/src/lib/kb/cursor.ts",
            "packages/api/src/lib/kb/fingerprint.ts",
            "packages/api/src/lib/kb/fixtures/**",
            "packages/api/src/lib/kb/index-file/format.ts",
            "packages/api/src/lib/kb/index-file/writer.ts",
            "packages/api/src/lib/kb/local-model.ts",
            "packages/test-utils/src/kb/*reference.json",
            "packages/test-utils/src/kb/embedding-normalization.json",
            ".github/workflows/**",
        ] {
            assert!(paths.contains(path), "{event} misses consumed input {path}");
        }
        // Derived inventory: every repository path outside apps/cli that the
        // workspace sources name (include_str!, fixture reads) is covered by a
        // filter, so a new shared input cannot silently skip CLI CI.
        for input in external_inputs() {
            assert!(
                paths.iter().any(|filter| filter_matches(filter, &input)),
                "{event} misses consumed input {input}"
            );
        }
    }
    assert!(
        workflow.contains("toolchain: \"1.96.1\""),
        "MSRV lane pinned to 1.96.1"
    );
}

/// Repository-relative paths outside `apps/cli` named by string literals of
/// the form `"../…/packages/…"` or `"../…/apps/…"` in the workspace sources.
fn external_inputs() -> BTreeSet<String> {
    fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
        for entry in std::fs::read_dir(dir).expect("source dir") {
            let path = entry.expect("dir entry").path();
            if path.is_dir() {
                if path
                    .file_name()
                    .is_some_and(|n| n != "target" && n != "vendor")
                {
                    walk(&path, out);
                }
            } else if path.extension().is_some_and(|e| e == "rs") {
                out.push(path);
            }
        }
    }
    let cli = repo_root().join("apps/cli");
    let mut files = Vec::new();
    walk(&cli.join("crates"), &mut files);
    walk(&cli.join("xtask"), &mut files);
    let mut inputs = BTreeSet::new();
    for file in files {
        let text = std::fs::read_to_string(&file).expect("source file");
        for literal in text.split('"').skip(1).step_by(2) {
            let rest = literal.trim_start_matches("../");
            if literal.starts_with("../")
                && (rest.starts_with("packages/") || rest.starts_with("apps/"))
                && !rest.starts_with("apps/cli/")
            {
                inputs.insert(rest.to_owned());
            }
        }
    }
    assert!(
        inputs.contains("packages/test-utils/src/kb/embedding-normalization.json"),
        "the scan sees the shared fixtures"
    );
    inputs
}

/// Path-filter glob subset used by cli-ci.yml: `dir/**`, a `*` wildcard in
/// the last segment, or an exact path (also covering files under it).
fn filter_matches(filter: &str, path: &str) -> bool {
    if let Some(dir) = filter.strip_suffix("/**") {
        return path.starts_with(&format!("{dir}/")) || path == dir;
    }
    if let Some((dir, name)) = filter.rsplit_once('/')
        && let Some((head, tail)) = name.split_once('*')
        && let Some((path_dir, path_name)) = path.rsplit_once('/')
    {
        return dir == path_dir
            && path_name.len() >= head.len() + tail.len()
            && path_name.starts_with(head)
            && path_name.ends_with(tail);
    }
    filter == path || path.starts_with(&format!("{filter}/"))
}

#[test]
fn event_path_guard_cannot_count_push_entries_as_pull_request_coverage() {
    let workflow = "on:\n  push:\n    paths:\n      - \"apps/cli/**\"\n  pull_request:\n    paths:\n      - \"other/**\"\n";
    assert!(workflow_event_paths(workflow, "push").contains("apps/cli/**"));
    assert!(!workflow_event_paths(workflow, "pull_request").contains("apps/cli/**"));
    assert!(workflow_event_paths(workflow, "pull_request").contains("other/**"));
    let job_only = "on:\n  push:\n    branches: [master]\njobs:\n  push:\n    paths:\n      - \"apps/cli/**\"\n";
    assert!(workflow_event_paths(job_only, "push").is_empty());
}

#[test]
fn workspace_msrv_is_coordinated() {
    let cli = repo_root().join("apps/cli");
    let root = std::fs::read_to_string(cli.join("Cargo.toml")).unwrap();
    assert!(root.contains("[workspace.package]\nrust-version = \"1.96\""));
    for member in [
        "Cargo.toml",
        "xtask/Cargo.toml",
        "crates/kb-client/Cargo.toml",
        "crates/kb-local/Cargo.toml",
    ] {
        let text = std::fs::read_to_string(cli.join(member)).unwrap();
        assert!(text.contains("rust-version.workspace = true"), "{member}");
    }
}

#[test]
fn tool_trait_names_match_catalog() {
    assert_eq!(KnowledgeSearch::NAME, ToolName::KnowledgeSearch);
    assert_eq!(ChangesApply::NAME.as_str(), "knowledge_changes_apply");
    assert_eq!(ToolName::KnowledgeSearch.to_string(), "knowledge_search");
}

#[test]
fn builtin_provider_kind_is_model_neutral() {
    use kb_client::types::ProviderKind;
    assert_eq!(
        serde_json::to_string(&ProviderKind::SystemBuiltin).unwrap(),
        "\"SYSTEM_BUILTIN\""
    );
    assert!(matches!(
        serde_json::from_str::<ProviderKind>("\"SYSTEM_BUILTIN\"").unwrap(),
        ProviderKind::SystemBuiltin
    ));
}

// Integral floating numbers survive JSON.parse even though JSON.stringify
// would erase their spelling. Derive values from every canonical valid row,
// then replace each integer with its raw .0 / exponent form before parsing.
fn floating_wire(value: &Value, exponent: bool) -> String {
    match value {
        Value::Number(n) if n.is_i64() || n.is_u64() => {
            format!("{n}{}", if exponent { "e0" } else { ".0" })
        }
        Value::Array(items) => format!(
            "[{}]",
            items
                .iter()
                .map(|v| floating_wire(v, exponent))
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(record) => format!(
            "{{{}}}",
            record
                .iter()
                .map(|(k, v)| format!(
                    "{}:{}",
                    serde_json::to_string(k).expect("string keys always serialize"),
                    floating_wire(v, exponent)
                ))
                .collect::<Vec<_>>()
                .join(",")
        ),
        other => other.to_string(),
    }
}

#[test]
fn raw_integral_wire_spellings_work_for_every_tool_family() {
    let corpus = corpus();
    for name in ToolName::ALL {
        let row = &corpus["tools"][name.as_str()];
        for (direction, primary, extra) in [
            (
                kb_client::schema::Direction::Input,
                "validInput",
                "validInputVariants",
            ),
            (
                kb_client::schema::Direction::Output,
                "validOutput",
                "validOutputVariants",
            ),
        ] {
            let mut cases = vec![("primary".to_owned(), row[primary].clone())];
            cases.extend(labelled(row, extra));
            for (label, value) in cases {
                let check = |value| match direction {
                    kb_client::schema::Direction::Input => name.check_input(value),
                    kb_client::schema::Direction::Output => name.check_output(value),
                };
                let expected = check(value.clone()).unwrap();
                for exponent in [false, true] {
                    let raw = floating_wire(&value, exponent);
                    let result = check(serde_json::from_str(&raw).unwrap()).unwrap_or_else(|e| {
                        panic!("{name} {direction:?} {label} exponent={exponent}: {e}")
                    });
                    assert_eq!(result, expected, "{name} {label}");
                }
            }
        }
    }
}

#[test]
fn generic_decoders_and_integer_literal_accept_numeric_wire_values() {
    use kb_client::types::{BasesList, ConstU64, TransferRead};
    for wire in ["20.0", "2e1"] {
        let raw = format!("{{\"limit\":{wire}}}");
        let input =
            kb_client::decode_input::<BasesList>(serde_json::from_str(&raw).unwrap()).unwrap();
        assert_eq!(
            encode_input::<BasesList>(&input).unwrap(),
            json!({"limit":20})
        );
    }
    for wire in ["0.0", "-0.0", "0e0"] {
        let mut input = corpus()["tools"]["knowledge_transfer_read"]["validInput"].clone();
        input["offset"] = serde_json::from_str(wire).unwrap();
        kb_client::decode_input::<TransferRead>(input).unwrap();
    }
    for wire in ["1", "1.0", "1e0"] {
        serde_json::from_str::<ConstU64<1>>(wire).unwrap();
    }
    for wire in ["1.5", "null", "true", "9007199254740992.0"] {
        assert!(serde_json::from_str::<ConstU64<1>>(wire).is_err());
    }
    assert!(serde_json::from_str::<ConstU64<{ u64::MAX }>>("null").is_err());
    for wire in ["20.5", "9007199254740991.0", "9007199254740992", "-0.0"] {
        let raw = format!("{{\"limit\":{wire}}}");
        assert!(kb_client::decode_input::<BasesList>(serde_json::from_str(&raw).unwrap()).is_err());
    }
}

#[test]
fn error_numeric_wire_boundaries_are_closed_and_never_panic() {
    use kb_client::ToolError;
    for code in [ErrorCode::Conflict, ErrorCode::RateLimited] {
        for (wire, safe) in [
            ("1", true),
            ("1.0", true),
            ("1e0", true),
            ("0", true),
            ("-0.0", true),
            ("-9007199254740991", true),
            ("-9007199254740991.0", true),
            ("9007199254740991", true),
            ("9007199254740991.0", true),
            ("-9007199254740992", false),
            ("-9007199254740992.0", false),
            ("9007199254740992", false),
            ("9007199254740992.0", false),
            ("-9223372036854775808", false),
            ("18446744073709551615", false),
            ("1.5", false),
            ("-1e100", false),
            ("1e100", false),
        ] {
            let number: Value = serde_json::from_str(wire).unwrap();
            let allowed =
                safe && (code != ErrorCode::RateLimited || number.as_f64().unwrap() >= 1.0);
            let details = if code == ErrorCode::Conflict {
                json!({"headSha":"0".repeat(40), "proposalNumber":number})
            } else {
                json!({"retryAfterSeconds":number})
            };
            let value = json!({"code":code.as_str(), "message":code.message(),
                "retryable":code.retryable(), "details":details});
            let envelope = json!({"schemaVersion":"kb/1", "error":value});
            let err = decode_envelope::<KnowledgeSearch>(envelope).unwrap_err();
            if allowed {
                assert!(matches!(err, KbError::Tool(_)), "{code} {wire}: {err:?}");
                assert!(ToolError::from_value(&value).is_ok());
            } else {
                assert!(
                    matches!(err, KbError::Protocol(ProtocolError::MalformedEnvelope)),
                    "{code} {wire}: {err:?}"
                );
                assert!(!err.retryable());
            }
        }
    }
}

#[test]
fn every_error_code_rejects_mismatched_or_unsafe_details_and_round_trips_valid_ones() {
    use kb_client::{ToolError, encode_error_envelope};
    let sha = "0".repeat(40).parse::<Sha>().unwrap();
    let mut details = vec![(None, ErrorDetails::Empty)];
    for proposal_number in [
        None,
        Some(-9_007_199_254_740_991),
        Some(0),
        Some(9_007_199_254_740_991),
    ] {
        details.push((
            Some(ErrorCode::Conflict),
            ErrorDetails::Conflict {
                head_sha: sha.clone(),
                proposal_number,
            },
        ));
    }
    for generation_id in [None, Some("abcdefghijklmnopqrstuvwx".parse().unwrap())] {
        details.push((
            Some(ErrorCode::IndexUnavailable),
            ErrorDetails::IndexUnavailable {
                generation_id,
                state: types::IndexState::Complete,
            },
        ));
    }
    for retry_after_seconds in [1, 9_007_199_254_740_991] {
        details.push((
            Some(ErrorCode::RateLimited),
            ErrorDetails::RateLimited {
                retry_after_seconds,
            },
        ));
    }
    for proposal_number in [
        i64::MIN,
        -9_007_199_254_740_992,
        9_007_199_254_740_992,
        i64::MAX,
    ] {
        details.push((
            Some(ErrorCode::Internal),
            ErrorDetails::Conflict {
                head_sha: sha.clone(),
                proposal_number: Some(proposal_number),
            },
        ));
    }
    for retry_after_seconds in [0, 9_007_199_254_740_992, u64::MAX] {
        details.push((
            Some(ErrorCode::Internal),
            ErrorDetails::RateLimited {
                retry_after_seconds,
            },
        ));
    }
    for code in ErrorCode::ALL {
        for (kind, detail) in &details {
            // INTERNAL is a sentinel: these details are invalid for every code.
            let valid =
                kind.is_none() || (*kind == Some(*code) && *kind != Some(ErrorCode::Internal));
            let result = ToolError::new(*code, detail.clone());
            assert_eq!(result.is_ok(), valid, "{code} {detail:?}");
            if let Ok(error) = result {
                assert_eq!(error.message(), code.message());
                assert_eq!(error.retryable(), code.retryable());
                let envelope = encode_error_envelope(&error);
                let parsed = decode_envelope::<KnowledgeSearch>(envelope).unwrap_err();
                assert_eq!(parsed, KbError::Tool(error));
            }
        }
    }
}

#[test]
fn changes_uniqueness_runs_after_bounds_for_both_selectors() {
    let mut input = corpus()["tools"]["knowledge_changes_apply"]["validInput"].clone();
    let sessions = |count| {
        (0..count)
            .map(|n| json!(format!("00000000-0000-4000-8000-{n:012x}")))
            .collect::<Vec<_>>()
    };
    assert_eq!(
        protocol_file("schema.json")["tools"]["knowledge_changes_apply"]["input"]["properties"]["sourceSessionIds"]
            ["maxItems"],
        kb_client::dream::DREAM_MAX_SOURCE_SESSIONS
    );
    input["sourceSessionIds"] = json!(sessions(100));
    ToolName::KnowledgeChangesApply
        .check_input(input.clone())
        .unwrap();
    let mut duplicate = input.clone();
    duplicate["sourceSessionIds"][99] = duplicate["sourceSessionIds"][0].clone();
    assert!(
        ToolName::KnowledgeChangesApply
            .check_input(duplicate)
            .is_err()
    );
    for count in [101, 10_000] {
        input["sourceSessionIds"] = json!(sessions(count));
        // An early invalid child distinguishes count-before-item traversal.
        input["sourceSessionIds"][0] = json!("invalid");
        let err = ToolName::KnowledgeChangesApply
            .check_input(input.clone())
            .unwrap_err();
        let KbError::Protocol(ProtocolError::InvalidInput(v)) = err else {
            panic!("wrong error")
        };
        assert_eq!(v.keyword, "maxItems");
        assert_eq!(v.pointer, "/sourceSessionIds");
        input["sourceSessionIds"] = json!(vec![sessions(1)[0].clone(); count]);
        let err = ToolName::KnowledgeChangesApply
            .check_input(input.clone())
            .unwrap_err();
        let KbError::Protocol(ProtocolError::InvalidInput(v)) = err else {
            panic!("wrong error")
        };
        assert_eq!(
            v.keyword, "maxItems",
            "count bound precedes even an immediate duplicate"
        );
    }
    input["mode"] = json!("dream");
    input["changes"] = json!([]);
    input["sourceSessionIds"] = json!(sessions(100));
    let upsert = json!({"id":"concept", "type":"concept", "title":"Concept", "body":"", "citations":[], "provenance":"dream"});
    input["dream"] = json!({"model":{"model":"fixture-model", "provider":"fixture"}, "redactionApplied":true,
        "upserts":(0..8).map(|n| {let mut u=upsert.clone();u["id"]=json!(format!("concept-{n}"));u}).collect::<Vec<_>>()});
    ToolName::KnowledgeChangesApply
        .check_input(input.clone())
        .unwrap();
    let mut duplicate = input.clone();
    duplicate["dream"]["upserts"][7]["id"] = duplicate["dream"]["upserts"][0]["id"].clone();
    assert!(
        ToolName::KnowledgeChangesApply
            .check_input(duplicate)
            .is_err()
    );
    input["dream"]["upserts"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id":"concept-8"}));
    let err = ToolName::KnowledgeChangesApply
        .check_input(input)
        .unwrap_err();
    let KbError::Protocol(ProtocolError::InvalidInput(v)) = err else {
        panic!("wrong error")
    };
    assert_eq!(v.keyword, "maxItems");
    assert_eq!(v.pointer, "/dream/upserts");
}
