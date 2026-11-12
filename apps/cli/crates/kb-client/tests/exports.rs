//! Consumer invariants at the real HTTP/typed-client boundary. Real server
//! ownership, grace and durable CLI save are in `pnpm test:kb -- exports`.
mod common;

use base64::{Engine, engine::general_purpose::STANDARD};
use kb_client::export::{ExportError, download_export};
use kb_client::snapshot::content_hash;
use kb_client::types::ExportPrepareInput;
use kb_client::{CancellationToken, ClientError, ErrorCode, KbError};
use serde_json::{Value, json};
use std::io::{self, Write};

const ID: &str = "00000000-0000-4000-8000-000000000001";
const KB: &str = "aaaaaaaaaaaaaaaaaaaaaaaa";
const FRAME: usize = 196608;

fn input() -> ExportPrepareInput {
    serde_json::from_value(
        json!({"kbId": KB, "kind": "whole", "idempotencyKey": "export-test-key-0001"}),
    )
    .expect("test fixture")
}
fn answer(tool: &str, args: &Value, bytes: &[u8]) -> Value {
    let hash = content_hash(bytes);
    common::ok(match tool {
        "knowledge_export_prepare" => {
            json!({"operationId": ID, "transferId": ID, "rev": "a".repeat(40), "size": bytes.len(), "contentHash": hash, "expiresAt": "2030-01-01T00:00:00.000Z", "mime": "application/zip"})
        }
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
    let verified = download_export(&client, &input(), &mut saved, &common::ctl())
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
    let verified = download_export(&client, &input(), &mut saved, &common::ctl())
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
        let result = download_export(&client, &input(), &mut Vec::new(), &common::ctl()).await;
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
    let server = common::tool_server(|tool, args, _| answer(tool, args, &vec![7; FRAME + 1])).await;
    let client = server.client();
    assert!(matches!(
        download_export(&client, &input(), &mut FailedWrite, &common::ctl()).await,
        Err(ExportError::Io(_))
    ));
    let ctl = common::ctl();
    assert!(matches!(
        download_export(
            &client,
            &input(),
            &mut CancelWrite(ctl.cancel.clone()),
            &ctl
        )
        .await,
        Err(ExportError::Client(ClientError::Kb(KbError::Cancelled)))
    ));
    assert!(server.calls_to("knowledge_export_complete").is_empty());
    assert_eq!(server.calls_to("knowledge_transfer_read").len(), 2);
}
