//! Consumer invariants at the real HTTP/typed-client boundary. Real server
//! ownership, grace and durable CLI save are in `pnpm test:kb -- exports`.
mod common;

use base64::{Engine, engine::general_purpose::STANDARD};
use kb_client::host::export::{
    ExportError, cancel_export, download_export, export_status, start_export, wait_for_export,
};
use kb_client::host::snapshot::content_hash;
use kb_client::types::{ExportJob, ExportPrepareInput, ExportState, KbId};
use kb_client::{CallControl, CancellationToken, ClientError, ErrorCode, KbError};
use serde_json::{Value, json};
use std::io::{self, Write};
use std::time::Duration;

const ID: &str = "00000000-0000-4000-8000-000000000001";
const KB: &str = "aaaaaaaaaaaaaaaaaaaaaaaa";
const FRAME: usize = 196608;

fn input() -> ExportPrepareInput {
    serde_json::from_value(
        json!({"kbId": KB, "kind": "whole", "idempotencyKey": "export-test-key-0001"}),
    )
    .expect("test fixture")
}
fn kb() -> KbId {
    serde_json::from_value(json!(KB)).expect("test fixture")
}
fn job(state: &str, bytes: &[u8]) -> Value {
    let ready = state == "ready";
    let error = if state == "failed" {
        json!({"code": "DEADLINE_EXCEEDED", "message": "The export took longer than its time limit."})
    } else {
        Value::Null
    };
    json!({"operationId": ID, "transferId": ID, "kind": "whole", "rev": "a".repeat(40), "state": state,
        "progress": {"doneBytes": if ready { bytes.len() } else { 0 }, "totalBytes": bytes.len()},
        "size": if ready { json!(bytes.len()) } else { Value::Null },
        "contentHash": if ready { json!(content_hash(bytes)) } else { Value::Null },
        "expiresAt": if ready { json!("2030-01-01T00:00:00.000Z") } else { Value::Null },
        "error": error, "mime": "application/zip"})
}
fn ready_job(bytes: &[u8]) -> ExportJob {
    serde_json::from_value(job("ready", bytes)).expect("test fixture")
}
fn answer(tool: &str, args: &Value, bytes: &[u8]) -> Value {
    let hash = content_hash(bytes);
    common::ok(match tool {
        "knowledge_export_prepare" | "knowledge_export_status" => job("ready", bytes),
        "knowledge_transfer_read" => {
            let offset = args["offset"].as_u64().expect("test fixture") as usize;
            let end = (offset + FRAME).min(bytes.len());
            json!({"transferId": ID, "offset": offset, "nextOffset": end, "bytesBase64": STANDARD.encode(&bytes[offset..end]), "eof": end == bytes.len(), "contentHash": hash})
        }
        "knowledge_export_complete" => json!({"transferId": ID, "released": true}),
        _ => panic!("unexpected tool {tool}"),
    })
}

#[tokio::test]
async fn exact_bounded_bytes_verify_before_explicit_completion_and_failed_ack_is_retryable() {
    let bytes = vec![7; FRAME + 7];
    let serving = bytes.clone();
    let server = common::tool_server(move |tool, args, _| answer(tool, args, &serving)).await;
    let client = server.client();
    let mut saved = Vec::new();
    let verified = download_export(
        &client,
        &kb(),
        &ready_job(&bytes),
        &mut saved,
        &common::ctl(),
        |_| {},
    )
    .await
    .expect("test fixture");
    assert_eq!(saved, bytes);
    assert!(server.calls_to("knowledge_export_complete").is_empty());
    verified
        .complete(&common::ctl())
        .await
        .expect("test fixture");
    assert_eq!(
        server.calls_to("knowledge_export_complete")[0].arguments,
        json!({"kbId": KB, "transferId": ID})
    );
    let reads = server.calls_to("knowledge_transfer_read");
    assert_eq!(reads.len(), 2);
    assert_eq!(reads[0].arguments["maxBytes"], FRAME);
    assert_eq!(reads[1].arguments["offset"], FRAME);

    let server = common::tool_server(|tool, args, _| {
        if tool == "knowledge_export_complete" {
            common::err(ErrorCode::StorageUnavailable, json!({}))
        } else {
            answer(tool, args, b"verified")
        }
    })
    .await;
    let client = server.client();
    let mut saved = Vec::new();
    let verified = download_export(
        &client,
        &kb(),
        &ready_job(b"verified"),
        &mut saved,
        &common::ctl(),
        |_| {},
    )
    .await
    .expect("test fixture");
    assert!(verified.complete(&common::ctl()).await.is_err());
    assert_eq!(saved, b"verified");
    assert_eq!(server.calls_to("knowledge_export_complete").len(), 2);
}

#[tokio::test]
async fn corrupt_digest_or_frame_identity_offset_size_and_eof_never_acknowledge() {
    for variant in ["hash", "transfer", "offset", "size", "eof", "bytes"] {
        let server = common::tool_server(move |tool, args, _| {
            let mut out = answer(tool, args, b"verified");
            if tool == "knowledge_transfer_read" {
                match variant {
                    "hash" => out["data"]["contentHash"] = json!(content_hash(b"other")),
                    "transfer" => {
                        out["data"]["transferId"] = json!("00000000-0000-4000-8000-000000000002")
                    }
                    "offset" => out["data"]["offset"] = json!(1),
                    "size" => out["data"]["nextOffset"] = json!(9),
                    "eof" => out["data"]["eof"] = json!(false),
                    "bytes" => out["data"]["bytesBase64"] = json!(STANDARD.encode(b"tampered")),
                    _ => unreachable!(),
                }
            }
            out
        })
        .await;
        let client = server.client();
        let result = download_export(
            &client,
            &kb(),
            &ready_job(b"verified"),
            &mut Vec::new(),
            &common::ctl(),
            |_| {},
        )
        .await;
        assert!(
            matches!(
                result,
                Err(ExportError::InvalidFrame | ExportError::HashMismatch)
            ),
            "variant {variant}"
        );
        assert!(server.calls_to("knowledge_export_complete").is_empty());
    }
}

struct FailedWrite;
impl Write for FailedWrite {
    fn write(&mut self, _: &[u8]) -> io::Result<usize> {
        Err(io::Error::other("disk full"))
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
struct CancelWrite(CancellationToken);
impl Write for CancelWrite {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.cancel();
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[tokio::test]
async fn write_failure_or_cancellation_cannot_publish_a_verified_receipt_or_ack() {
    let served = vec![7; FRAME + 1];
    let job = ready_job(&served);
    let server = common::tool_server(move |tool, args, _| answer(tool, args, &served)).await;
    let client = server.client();
    assert!(matches!(
        download_export(
            &client,
            &kb(),
            &job,
            &mut FailedWrite,
            &common::ctl(),
            |_| {}
        )
        .await,
        Err(ExportError::Io(_))
    ));
    let ctl = common::ctl();
    assert!(matches!(
        download_export(
            &client,
            &kb(),
            &job,
            &mut CancelWrite(ctl.cancel.clone()),
            &ctl,
            |_| {},
        )
        .await,
        Err(ExportError::Client(ClientError::Kb(KbError::Cancelled)))
    ));
    assert!(server.calls_to("knowledge_export_complete").is_empty());
    assert_eq!(server.calls_to("knowledge_transfer_read").len(), 2);
}

#[tokio::test]
async fn start_returns_at_once_and_wait_polls_status_until_ready_then_downloads() {
    let bytes = b"background".to_vec();
    let serving = bytes.clone();
    let server = common::tool_server(move |tool, args, index| match tool {
        "knowledge_export_prepare" => common::ok(job("pending", &serving)),
        // First poll still building, second ready.
        "knowledge_export_status" if index < 2 => common::ok(job("building", &serving)),
        _ => answer(tool, args, &serving),
    })
    .await;
    let client = server.client();
    let started = start_export(&client, &input(), &common::ctl())
        .await
        .expect("test fixture");
    assert_eq!(started.state, ExportState::Pending);
    assert!(server.calls_to("knowledge_transfer_read").is_empty());
    let mut seen = Vec::new();
    let ready = wait_for_export(
        &client,
        &kb(),
        started,
        Duration::from_secs(30),
        &common::ctl(),
        |job| seen.push(job.state),
    )
    .await
    .expect("test fixture");
    assert_eq!(seen, [ExportState::Building, ExportState::Ready]);
    assert_eq!(
        server.calls_to("knowledge_export_status")[0].arguments,
        json!({"kbId": KB, "transferId": ID})
    );
    let mut saved = Vec::new();
    download_export(&client, &kb(), &ready, &mut saved, &common::ctl(), |_| {})
        .await
        .expect("test fixture");
    assert_eq!(saved, bytes);
}

#[tokio::test]
async fn failed_or_cancelled_jobs_are_not_ready_and_never_download() {
    for state in ["failed", "cancelled", "expired"] {
        let server = common::tool_server(move |tool, args, _| match tool {
            "knowledge_export_status" | "knowledge_export_cancel" => common::ok(job(state, b"x")),
            _ => answer(tool, args, b"x"),
        })
        .await;
        let client = server.client();
        let pending: ExportJob = serde_json::from_value(job("pending", b"x")).expect("fixture");
        let result = wait_for_export(
            &client,
            &kb(),
            pending.clone(),
            Duration::from_secs(30),
            &common::ctl(),
            |_| {},
        )
        .await;
        let Err(ExportError::NotReady(ended)) = result else {
            panic!("{state}: {result:?}");
        };
        if state == "failed" {
            assert_eq!(
                ExportError::NotReady(ended.clone()).to_string(),
                "export failed: The export took longer than its time limit."
            );
        }
        assert!(matches!(
            download_export(
                &client,
                &kb(),
                &ended,
                &mut Vec::new(),
                &common::ctl(),
                |_| {}
            )
            .await,
            Err(ExportError::NotReady(_))
        ));
        let cancelled = cancel_export(&client, &kb(), &pending.transfer_id, &common::ctl())
            .await
            .expect("test fixture");
        assert_eq!(cancelled.transfer_id, pending.transfer_id);
        assert!(server.calls_to("knowledge_transfer_read").is_empty());
    }
}

#[tokio::test]
async fn the_wait_is_bounded_and_reports_the_job_to_resume() {
    let server = common::tool_server(|tool, _, _| match tool {
        "knowledge_export_status" => common::ok(job("building", b"x")),
        _ => panic!("unexpected tool {tool}"),
    })
    .await;
    let client = server.client();
    let building: ExportJob = serde_json::from_value(job("building", b"x")).expect("fixture");
    let result = wait_for_export(
        &client,
        &kb(),
        building,
        Duration::from_millis(1500),
        &common::ctl(),
        |_| {},
    )
    .await;
    let Err(error @ ExportError::StillRunning(_)) = result else {
        panic!("{result:?}");
    };
    assert_eq!(
        error.to_string(),
        format!("export `{ID}` is still being prepared")
    );
    assert!(server.calls_to("knowledge_export_status").len() <= 2);
    // A status answer for another job is refused.
    let server = common::tool_server(|_, _, _| {
        let mut other = job("ready", b"x");
        other["transferId"] = json!("00000000-0000-4000-8000-000000000002");
        common::ok(other)
    })
    .await;
    let id = ready_job(b"x").transfer_id;
    assert!(matches!(
        export_status(&server.client(), &kb(), &id, &common::ctl()).await,
        Err(ExportError::InvalidFrame)
    ));
}

/// A status call that stalls cannot outlive the wait bound: it inherits the
/// earlier of the caller's deadline and the bound, and running into the bound
/// is "still running", not a transport failure.
#[tokio::test]
async fn a_stalled_status_poll_is_clamped_to_the_wait_bound() {
    let server = common::stalled_server().await;
    let client = server.client();
    let building: ExportJob = serde_json::from_value(job("building", b"x")).expect("fixture");
    let started = std::time::Instant::now();
    let result = wait_for_export(
        &client,
        &kb(),
        building,
        Duration::from_millis(1500),
        // The caller's own deadline is far later than the wait bound.
        &kb_client::CallControl::timeout(Duration::from_secs(120)),
        |_| {},
    )
    .await;
    assert!(
        matches!(result, Err(ExportError::StillRunning(_))),
        "{result:?}"
    );
    // The bound is 1.5 s; the caller's deadline (120 s) never comes into play.
    assert!(
        started.elapsed() < Duration::from_millis(3000),
        "{:?}",
        started.elapsed()
    );
}

#[tokio::test]
async fn http_429_is_waited_out_by_its_retry_after_from_the_last_verified_frame() {
    let bytes: Vec<u8> = (0..3 * FRAME + 5).map(|i| (i % 251) as u8).collect();
    let serving = bytes.clone();
    // The second frame is refused twice (once with Retry-After: 1, once without).
    let server = common::tool_server(move |tool, args, index| {
        if tool == "knowledge_transfer_read" && args["offset"] == FRAME && index < 3 {
            return common::http_429(if index == 1 { Some(1) } else { None });
        }
        answer(tool, args, &serving)
    })
    .await;
    let client = server.client();
    let mut saved = Vec::new();
    let mut waits = Vec::new();
    let started = std::time::Instant::now();
    download_export(
        &client,
        &kb(),
        &ready_job(&bytes),
        &mut saved,
        &common::ctl(),
        |wait| waits.push(wait),
    )
    .await
    .expect("test fixture");
    assert_eq!(saved, bytes);
    assert_eq!(waits, vec![Duration::from_secs(1); 2]);
    assert!(started.elapsed() >= Duration::from_secs(2));
    let offsets: Vec<_> = server
        .calls_to("knowledge_transfer_read")
        .iter()
        .map(|call| call.arguments["offset"].as_u64().expect("test fixture"))
        .collect();
    let frame = FRAME as u64;
    // Never restarted: the refused frame is repeated, earlier ones are not.
    assert_eq!(offsets, vec![0, frame, frame, frame, 2 * frame, 3 * frame]);
}

#[tokio::test]
async fn a_server_that_keeps_refusing_fails_after_bounded_waits_and_never_acknowledges() {
    let server = common::tool_server(move |tool, args, _| {
        if tool == "knowledge_transfer_read" {
            return common::http_429(Some(0));
        }
        answer(tool, args, b"verified")
    })
    .await;
    let client = server.client();
    let mut waits = 0;
    let result = download_export(
        &client,
        &kb(),
        &ready_job(b"verified"),
        &mut Vec::new(),
        &CallControl::timeout(Duration::from_secs(60)),
        |_| waits += 1,
    )
    .await;
    assert!(matches!(
        result,
        Err(ExportError::Client(ClientError::HttpRateLimited {
            retry_after_seconds: Some(0)
        }))
    ));
    assert_eq!(
        waits,
        kb_client::host::export::DOWNLOAD_RATE_LIMIT_MAX_WAITS
    );
    assert_eq!(
        server.calls_to("knowledge_transfer_read").len() as u32,
        kb_client::host::export::DOWNLOAD_RATE_LIMIT_MAX_WAITS + 1
    );
    assert!(server.calls_to("knowledge_export_complete").is_empty());
}

#[tokio::test]
async fn a_rate_limit_wait_ends_at_cancellation() {
    let server = common::tool_server(move |tool, args, _| {
        if tool == "knowledge_transfer_read" {
            return common::http_429(Some(60));
        }
        answer(tool, args, b"verified")
    })
    .await;
    let client = server.client();
    let ctl = common::ctl();
    let cancel = ctl.cancel.clone();
    let started = std::time::Instant::now();
    let result = download_export(
        &client,
        &kb(),
        &ready_job(b"verified"),
        &mut Vec::new(),
        &ctl,
        move |_| cancel.cancel(),
    )
    .await;
    assert!(matches!(
        result,
        Err(ExportError::Client(ClientError::Kb(KbError::Cancelled)))
    ));
    assert!(started.elapsed() < Duration::from_secs(10));
}

#[tokio::test]
async fn a_rate_limited_tool_error_without_a_wait_is_waited_out_too() {
    let server = common::tool_server(move |tool, args, index| {
        if tool == "knowledge_transfer_read" && index == 0 {
            return common::err(ErrorCode::RateLimited, json!({}));
        }
        answer(tool, args, b"verified")
    })
    .await;
    let client = server.client();
    let mut saved = Vec::new();
    let mut waits = Vec::new();
    download_export(
        &client,
        &kb(),
        &ready_job(b"verified"),
        &mut saved,
        &common::ctl(),
        |wait| waits.push(wait),
    )
    .await
    .expect("test fixture");
    assert_eq!(saved, b"verified");
    assert_eq!(waits, vec![Duration::from_secs(1)]);
}
