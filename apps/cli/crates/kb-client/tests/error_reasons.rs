//! (L-9): `INVALID_ARGUMENT` / `CONFLICT` reasons and JSON pointers.

use kb_client::error::{
    ConflictReason, ErrorCode, ErrorDetails, InvalidReason, KbError, ToolError,
    invalid_input_details_value, is_field_pointer,
};
use kb_client::types::{KnowledgeSearch, ToolName};
use kb_client::{decode_envelope, encode_error_envelope};
use serde_json::{Value, json};

fn error_member(code: &str, details: Value) -> Value {
    let code: ErrorCode = code.parse().expect("known code");
    json!({"schemaVersion": "kb/1", "error": {
        "code": code.as_str(), "message": if code == ErrorCode::InvalidArgument && details["reason"] == "TOO_MANY_CHANGES" { "At most 32 changes per call. Each call commits on success: apply the first 32 now, then send the rest in another call using the returned commit as baseRevision." } else { code.message() },
        "retryable": code.retryable(), "details": details}})
}

fn decode(code: &str, details: Value) -> Result<ToolError, KbError> {
    match decode_envelope::<KnowledgeSearch>(error_member(code, details)) {
        Err(KbError::Tool(error)) => Ok(error),
        Err(other) => Err(other),
        Ok(_) => panic!("an error envelope decoded as success"),
    }
}

#[test]
fn field_pointer_accepts_only_safe_segments() {
    for ok in ["/changes", "/changes/7/path", "/a_b/0", &"/x".repeat(8)] {
        assert!(is_field_pointer(ok), "{ok}");
    }
    let long = format!("/{}", "a".repeat(65));
    for bad in [
        "",
        "/",
        "changes",
        "/changes/",
        "/a b",
        "/a~1b",
        "/*",
        &"/x".repeat(9),
        &long,
    ] {
        assert!(!is_field_pointer(bad), "{bad}");
    }
}

#[test]
fn invalid_argument_reason_round_trips_and_reasonless_details_stay_valid() {
    for reason in InvalidReason::ALL {
        for field in [None, Some("/changes/0/path".to_owned())] {
            let details = ErrorDetails::InvalidArgument {
                reason: *reason,
                field: field.clone(),
                min: None,
                max: None,
            };
            let error = ToolError::new(ErrorCode::InvalidArgument, details.clone()).unwrap();
            let wire = encode_error_envelope(&error);
            assert_eq!(wire["error"]["details"]["reason"], reason.as_str());
            assert_eq!(
                wire["error"]["details"]
                    .get("field")
                    .and_then(Value::as_str),
                field.as_deref()
            );
            let parsed = decode_envelope::<KnowledgeSearch>(wire).unwrap_err();
            assert_eq!(parsed, KbError::Tool(error));
            // A reason never rides on another code.
            assert!(ToolError::new(ErrorCode::NotFound, details.clone()).is_err());
            assert!(ToolError::new(ErrorCode::Conflict, details).is_err());
        }
    }
    // `{}`: a refusal with no single reason (no schema issue to name).
    assert!(decode("INVALID_ARGUMENT", json!({})).is_ok());
}

#[test]
fn malformed_reason_details_are_rejected() {
    for details in [
        json!({"reason": "NOT_A_REASON"}),
        json!({"reason": "SCHEMA", "field": "/a b"}),
        json!({"reason": "SCHEMA", "field": 3}),
        json!({"reason": "SCHEMA", "field": "/ok", "extra": 1}),
        json!({"reason": "SCHEMA", "min": "10"}),
        json!({"reason": "SCHEMA", "max": 1.5}),
        json!({"reason": "SCHEMA", "max": 9_007_199_254_740_992_u64}),
        json!({"field": "/ok"}),
        json!({"reason": "PATH_EXISTS"}),
    ] {
        assert!(
            decode("INVALID_ARGUMENT", details.clone()).is_err(),
            "{details}"
        );
    }
    assert!(decode("CONFLICT", json!({"reason": "SCHEMA"})).is_err());
    assert!(
        ToolError::new(
            ErrorCode::InvalidArgument,
            ErrorDetails::InvalidArgument {
                reason: InvalidReason::Schema,
                field: Some("/bad key".into()),
                min: None,
                max: None,
            },
        )
        .is_err()
    );
}

/// The broken inclusive bounds ride along, alone or together.
#[test]
fn invalid_argument_bounds_round_trip() {
    for details in [
        json!({"reason": "TOO_MANY_CHANGES", "field": "/changes", "max": 32}),
        json!({"reason": "SCHEMA", "field": "/description", "min": 10}),
        json!({"reason": "LIMIT_OUT_OF_RANGE", "field": "/limit", "min": 1, "max": 100}),
    ] {
        let error = decode("INVALID_ARGUMENT", details.clone()).unwrap();
        assert_eq!(error.details().to_value(), details);
    }
}

#[test]
fn oversized_batches_explain_commit_boundaries_on_stdio_and_remote_decode() {
    let details = json!({"reason":"TOO_MANY_CHANGES", "field":"/changes", "max":32});
    let result = kb_client::stdio::tool_error(ErrorCode::InvalidArgument, details);
    let error = ToolError::from_value(&result["structuredContent"]["error"]).unwrap();
    assert!(
        error
            .message()
            .contains("Each call commits on success: apply the first 32 now")
    );
    assert_eq!(error.to_value(), result["structuredContent"]["error"]);
}

/// Every closed CONFLICT and NOT_FOUND reason round-trips, and never rides
/// on another code.
#[test]
fn closed_conflict_and_not_found_reasons_round_trip() {
    for reason in ConflictReason::ALL {
        let details = json!({"reason": reason.as_str()});
        assert!(decode("CONFLICT", details.clone()).is_ok(), "{details}");
        assert!(decode("NOT_FOUND", details).is_err());
    }
    for reason in kb_client::error::NotFoundReason::ALL {
        let details = json!({"reason": reason.as_str(), "field": "/path"});
        assert_eq!(
            decode("NOT_FOUND", details.clone())
                .unwrap()
                .details()
                .to_value(),
            details
        );
        assert!(decode("CONFLICT", details).is_err());
    }
    assert!(decode("NOT_FOUND", json!({})).is_ok());
}

#[test]
fn conflict_path_exists_round_trips() {
    let error = decode(
        "CONFLICT",
        json!({"reason": "PATH_EXISTS", "field": "/changes/2/path"}),
    )
    .unwrap();
    assert_eq!(
        *error.details(),
        ErrorDetails::ConflictReason {
            reason: ConflictReason::PathExists,
            field: Some("/changes/2/path".into()),
        }
    );
    assert!(decode("CONFLICT", json!({"reason": "PATH_EXISTS"})).is_ok());
    // A stale base revision keeps its `{headSha, proposalNumber}` shape.
    let sha = "0".repeat(40);
    assert!(decode("CONFLICT", json!({"headSha": sha, "proposalNumber": null})).is_ok());
}

#[test]
fn proposal_conflict_round_trips_and_is_closed() {
    let a = "a".repeat(40);
    let b = "b".repeat(40);
    let c = "c".repeat(40);
    let details = json!({
        "headSha": a, "proposalNumber": 5, "reason": "PROPOSAL_CONFLICT",
        "baseSha": b, "proposalHeadSha": c, "contentIncluded": true,
        "paths": [{"path": "runbooks/rate.md", "kind": "document", "base": "100\n",
            "theirs": "50\n", "yours": null, "baseSha": b, "theirsSha": a, "yoursSha": c}],
    });
    let error = decode("CONFLICT", details.clone()).unwrap();
    assert!(matches!(
        error.details(),
        ErrorDetails::ProposalConflict(c) if c.paths.len() == 1 && c.content_included
    ));
    assert_eq!(encode_error_envelope(&error)["error"]["details"], details);

    let mutate = |f: &dyn Fn(&mut Value)| {
        let mut d = details.clone();
        f(&mut d);
        d
    };
    for bad in [
        mutate(&|d| d["paths"] = json!([])),
        mutate(&|d| {
            d["contentIncluded"] = json!(false);
        }),
        mutate(&|d| d["paths"][0]["path"] = json!("../x.md")),
        mutate(&|d| d["baseSha"] = json!("nope")),
        mutate(&|d| d["extra"] = json!(1)),
        mutate(&|d| {
            d.as_object_mut().unwrap().remove("proposalHeadSha");
        }),
        mutate(&|d| d["paths"][0]["base"] = json!(1)),
        mutate(&|d| d["paths"][0]["kind"] = json!("folder")),
        mutate(&|d| d["paths"][0]["yoursSha"] = json!("short")),
        mutate(&|d| {
            d["paths"][0].as_object_mut().unwrap().remove("theirsSha");
        }),
        mutate(&|d| d["paths"] = json!(vec![details["paths"][0].clone(); 51])),
    ] {
        assert!(decode("CONFLICT", bad.clone()).is_err(), "{bad}");
    }
    // Without content every version is null.
    let without = mutate(&|d| {
        d["contentIncluded"] = json!(false);
        d["paths"][0]["base"] = Value::Null;
        d["paths"][0]["theirs"] = Value::Null;
    });
    assert!(decode("CONFLICT", without).is_ok());
}

fn input_details(tool: ToolName, input: Value) -> Value {
    let error = tool.check_input(input.clone()).expect_err("rejected input");
    invalid_input_details_value(&error, &input)
}

#[test]
fn schema_violations_carry_reason_and_pointer() {
    let kb = "abcdefghijklmnopqrstuvwx";
    let sha = "0".repeat(40);
    let key = "k".repeat(16);
    let change =
        |path: &str| json!({"op": "create", "path": path, "content": {"markdown": "# a\n"}});
    let apply = |changes: Value| {
        json!({"kbId": kb, "baseRevision": sha, "idempotencyKey": key, "mode": "edit",
               "title": "t", "changes": changes, "sourceSessionIds": []})
    };
    let dream = |sessions: Option<Value>| {
        let mut input = json!({"kbId": kb, "baseRevision": sha, "idempotencyKey": key,
            "mode": "dream", "title": "t", "changes": [],
            "dream": {"model": {"provider": "p", "model": "m"}, "redactionApplied": true,
                "upserts": [{"id": "c1", "type": "concept", "title": null, "body": "b",
                    "citations": [], "provenance": "dream"}]}});
        if let Some(sessions) = sessions {
            input["sourceSessionIds"] = sessions;
        }
        input
    };
    let cases = [
        (
            ToolName::KnowledgeChangesApply,
            apply(json!(
                (0..33)
                    .map(|i| change(&format!("n{i}.md")))
                    .collect::<Vec<_>>()
            )),
            json!({"reason": "TOO_MANY_CHANGES", "field": "/changes", "max": 32}),
        ),
        (
            ToolName::KnowledgeChangesApply,
            apply(json!([change("con.md")])),
            json!({"reason": "RESERVED_PATH", "field": "/changes/0/path"}),
        ),
        (
            ToolName::KnowledgeChangesApply,
            apply(json!([change("a:b.md")])),
            json!({"reason": "RESERVED_PATH", "field": "/changes/0/path"}),
        ),
        (
            // The discriminated variant (`op`) owns the diagnostic.
            ToolName::KnowledgeChangesApply,
            apply(json!([{"op": "delete", "path": "a.md", "bogus": 1}])),
            json!({"reason": "UNKNOWN_ARGUMENT", "field": "/changes/0/bogus"}),
        ),
        (
            ToolName::KnowledgeChangesApply,
            apply(json!([change("CAPS.md"), change("caps.md")])),
            // The second spelling is the offending change.
            json!({"reason": "PATH_CASE_COLLISION", "field": "/changes/1/path"}),
        ),
        (
            ToolName::KnowledgeChangesApply,
            apply(json!([change("a.md"), change("b.md"), change("a.md")])),
            json!({"reason": "PATH_CASE_COLLISION", "field": "/changes/2/path"}),
        ),
        (
            ToolName::KnowledgeDocumentsGet,
            json!({"kbId": kb, "path": "index.md", "revision": sha}),
            json!({"reason": "UNKNOWN_ARGUMENT", "field": "/revision"}),
        ),
        (
            ToolName::KnowledgeDocumentsList,
            json!({"kbId": kb, "pathPrefix": "notes"}),
            json!({"reason": "UNKNOWN_ARGUMENT", "field": "/pathPrefix"}),
        ),
        (
            ToolName::KnowledgeDocumentsList,
            json!({"kbId": kb, "bad key": 1}),
            json!({"reason": "UNKNOWN_ARGUMENT"}),
        ),
        (
            ToolName::KnowledgeDocumentsList,
            // L-22: one trailing slash is valid; a traversal is not.
            json!({"kbId": kb, "prefix": "../notes/"}),
            json!({"reason": "INVALID_PREFIX", "field": "/prefix"}),
        ),
        (
            ToolName::KnowledgeSearch,
            json!({"query": "q".repeat(1025)}),
            json!({"reason": "QUERY_TOO_LONG", "field": "/query", "min": 1, "max": 1024}),
        ),
        (
            ToolName::KnowledgeSearch,
            json!({"query": "q", "limit": 21}),
            json!({"reason": "LIMIT_OUT_OF_RANGE", "field": "/limit", "min": 1, "max": 20}),
        ),
        (
            ToolName::KnowledgeSearch,
            json!({"query": "q", "limit": 0}),
            json!({"reason": "LIMIT_OUT_OF_RANGE", "field": "/limit", "min": 1, "max": 20}),
        ),
        (
            // A bound inside one undiscriminated alternative is not the
            // value's own: the field, but no `min`/`max` (server parity).
            ToolName::KnowledgeStructuredSearch,
            json!({"kbId": kb, "tags": []}),
            json!({"reason": "SCHEMA", "field": "/tags"}),
        ),
        (
            // Edit mode's `minItems: 1` is a root `if`/`then` rule, not the
            // `changes` node's own bound.
            ToolName::KnowledgeChangesApply,
            apply(json!([])),
            json!({"reason": "SCHEMA", "field": "/changes"}),
        ),
        (
            // A repeated session ID names its second occurrence.
            ToolName::KnowledgeChangesApply,
            {
                let mut input = apply(json!([change("a.md")]));
                let id = "00000000-0000-4000-8000-000000000004";
                input["sourceSessionIds"] = json!([id, id]);
                input
            },
            json!({"reason": "SCHEMA", "field": "/sourceSessionIds/1"}),
        ),
        (
            // A conditional requirement on an absent argument is MISSING_ARGUMENT.
            ToolName::KnowledgeChangesApply,
            dream(None),
            json!({"reason": "MISSING_ARGUMENT", "field": "/sourceSessionIds"}),
        ),
        (
            // Present but empty breaks the same rule's bound: SCHEMA, no bounds
            // (the rule is a root condition, not the member's own).
            ToolName::KnowledgeChangesApply,
            dream(Some(json!([]))),
            json!({"reason": "SCHEMA", "field": "/sourceSessionIds"}),
        ),
        (
            // A bound on the value's own node inside the union that is the only
            // way to reach it keeps its bounds (server parity).
            ToolName::KnowledgeDocumentsCreate,
            json!({"kbId": kb, "baseRevision": sha, "idempotencyKey": key, "path": "a.md",
                   "content": {"markdown": "a".repeat(131_073)}}),
            json!({"reason": "TOO_LARGE", "field": "/content/markdown", "max": 131072}),
        ),
        (
            ToolName::KnowledgeChangesApply,
            apply(json!([{"op": "create", "path": "a.md",
                          "content": {"markdown": "a".repeat(131_073)}}])),
            json!({"reason": "TOO_LARGE", "field": "/changes/0/content/markdown", "max": 131072}),
        ),
        (
            // A wrong type is never a domain reason.
            ToolName::KnowledgeSearch,
            json!({"query": "q", "limit": "5"}),
            json!({"reason": "SCHEMA", "field": "/limit"}),
        ),
        (
            ToolName::KnowledgeDocumentsList,
            json!({"kbId": kb, "prefix": 5}),
            json!({"reason": "SCHEMA", "field": "/prefix"}),
        ),
        (
            ToolName::KnowledgeBasesCreate,
            json!({"name": "N", "slug": "n", "description": "short",
                   "idempotencyKey": key}),
            json!({"reason": "SCHEMA", "field": "/description", "min": 10, "max": 2000}),
        ),
        (
            ToolName::KnowledgeBasesCreate,
            json!({"name": "N", "slug": "n", "description": "Valid description",
                   "idempotencyKey": "!".repeat(16)}),
            json!({"reason": "SCHEMA", "field": "/idempotencyKey", "min": 16, "max": 128}),
        ),
        (
            ToolName::KnowledgeBasesCreate,
            json!({"name": "N", "slug": "invalid slug", "description": "Valid description",
                   "idempotencyKey": key}),
            json!({"reason": "SCHEMA", "field": "/slug", "max": 63}),
        ),
        (
            ToolName::KnowledgeDocumentsDelete,
            json!({"kbId": kb, "baseRevision": sha, "idempotencyKey": key, "path": "a.md"}),
            json!({"reason": "CONFIRM_REQUIRED", "field": "/confirm"}),
        ),
        (
            ToolName::KnowledgeDocumentsDelete,
            json!({"kbId": kb, "baseRevision": sha, "idempotencyKey": key, "path": "a.md",
                   "confirm": "yes"}),
            json!({"reason": "CONFIRM_REQUIRED", "field": "/confirm"}),
        ),
        (
            // A confirmation of the wrong type is still a missing confirmation.
            ToolName::KnowledgeDocumentsDelete,
            json!({"kbId": kb, "baseRevision": sha, "idempotencyKey": key, "path": "a.md",
                   "confirm": null}),
            json!({"reason": "CONFIRM_REQUIRED", "field": "/confirm"}),
        ),
        (
            ToolName::KnowledgeDocumentsGet,
            json!({"path": "index.md"}),
            json!({"reason": "MISSING_ARGUMENT", "field": "/kbId"}),
        ),
    ];
    for (tool, input, want) in cases {
        let got = input_details(tool, input.clone());
        for (key, value) in want.as_object().unwrap() {
            assert_eq!(&got[key], value, "{tool:?} {input}: {got}");
        }
        for key in ["field", "min", "max"] {
            if want.get(key).is_none() {
                assert!(got.get(key).is_none(), "{tool:?} {input}: {got}");
            }
        }
        // Whatever is produced is a valid INVALID_ARGUMENT envelope.
        decode("INVALID_ARGUMENT", got).expect("valid details");
    }
}
