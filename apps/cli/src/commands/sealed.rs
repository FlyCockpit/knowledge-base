//! Human-only owner control. Plaintext input is never a clap field/argv.
use crate::{auth, output};
use anyhow::Result;
use kb_client::{
    sealed::SealedReference,
    types::{IsoInstant, KbId, Uuid},
};
use kb_local::{
    Store,
    credentials::NativeCredentials,
    sealed::{Enroll, Grant},
};
use std::path::PathBuf;
#[derive(Debug, clap::Args)]
pub struct Args {
    #[command(flatten)]
    root: crate::local::RootArg,
    /// Emit JSON instead of human-readable text.
    #[arg(long, global = true)]
    json: bool,
    #[command(subcommand)]
    command: Sub,
}
#[derive(Debug, clap::Args)]
struct Common {
    /// The knowledge base ID.
    #[arg(long = "kb", value_name = "KB_ID")]
    kb: KbId,
    /// Replay key: the same key and arguments return the first result.
    #[arg(long)]
    idempotency_key: String,
}
#[derive(Debug, clap::Subcommand)]
enum Sub {
    /// Encrypt a bounded UTF8 literal, returning its opaque reference.
    Enroll {
        #[command(flatten)]
        common: Common,
        /// Import with this record UUID (it must never have been used).
        #[arg(long, value_name = "UUID")]
        record_id: Option<Uuid>,
        /// Read the literal from standard input.
        #[arg(long, required_unless_present = "file", conflicts_with = "file")]
        stdin: bool,
        /// Read the literal from this owner-only file.
        #[arg(long)]
        file: Option<PathBuf>,
    },
    /// Approve one exact local consumer and recipient key until an expiry.
    Grant {
        #[command(flatten)]
        common: Common,
        /// The sealed reference `kb sealed enroll` printed.
        #[arg(long)]
        reference: SealedReference,
        /// The approved local principal (`kb sealed owner` prints the
        /// owner's own ID).
        #[arg(long)]
        consumer_id: String,
        /// UUID of the recipient key the consumer resolves with.
        #[arg(long, value_name = "UUID")]
        recipient_key_id: Uuid,
        /// The recipient's 32-byte X25519 public key in base64 (standard or
        /// URL-safe alphabet, padded or not).
        #[arg(long, value_name = "BASE64")]
        recipient_public_key: String,
        /// When the approval ends: a UTC RFC 3339 instant ending in `Z`,
        /// e.g. `2026-12-31T23:59:59Z`.
        #[arg(long, value_name = "RFC3339")]
        expires_at: IsoInstant,
    },
    /// Destroy the record ciphertext and all its consumer approvals.
    /// Documents that still mention it keep the symbol (and stay editable);
    /// the command lists them.
    Revoke {
        #[command(flatten)]
        common: Common,
        /// The sealed reference to revoke.
        #[arg(long)]
        reference: SealedReference,
    },
    /// Print the store owner's principal ID: the `--consumer-id` for
    /// approving the owner's own agent sessions (`kb mcp` without
    /// `--principal`).
    Owner,
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct OwnerReply {
    consumer_id: String,
}
pub fn run(args: &Args) -> Result<()> {
    let config = crate::config::Config::load()?;
    let root = args.root.require(&config)?;
    if let Sub::Owner = &args.command {
        let store = crate::local::open_existing(&root)?;
        let reply = OwnerReply {
            consumer_id: store.owner().id().to_owned(),
        };
        if args.json {
            output::json(&reply)?;
        } else {
            output::line(&reply.consumer_id)?;
        }
        return Ok(());
    }
    let store = Store::open(&root)?;
    let owner = store.owner();
    let keys = NativeCredentials::new(std::env::current_exe()?);
    let (reply, verb) = match &args.command {
        Sub::Enroll {
            common,
            record_id,
            file,
            ..
        } => (
            store.sealed_enroll(
                &owner,
                &common.kb,
                Enroll {
                    idempotency_key: common.idempotency_key.clone(),
                    record_id: record_id.clone(),
                },
                auth::import_sealed_literal(file.as_ref())?,
                &keys,
            )?,
            "enrolled",
        ),
        Sub::Grant {
            common,
            reference: r,
            consumer_id,
            recipient_key_id,
            recipient_public_key,
            expires_at,
        } => (
            store.sealed_grant(
                &owner,
                &common.kb,
                Grant {
                    idempotency_key: common.idempotency_key.clone(),
                    reference: r.clone(),
                    consumer_id: consumer_id.clone(),
                    recipient_key_id: recipient_key_id.clone(),
                    recipient_public_key: kb_client::sealed::canonical_recipient_public_key(
                        recipient_public_key,
                    )
                    .map_err(|_| {
                        anyhow::anyhow!(
                            "`--recipient-public-key` must be a 32-byte X25519 public key in base64"
                        )
                    })?,
                    expires_at: expires_at.clone(),
                },
            )?,
            "approved",
        ),
        Sub::Revoke {
            common,
            reference: r,
        } => {
            let reply = store.sealed_revoke(&owner, &common.kb, r, &common.idempotency_key)?;
            // L-8: say where the revoked symbol is still written.
            match store.sealed_reference_paths(&common.kb, r) {
                Ok(paths) if !paths.is_empty() => tracing::warn!(
                    "the revoked record is still referenced in {}; those documents keep the symbol (search redacts it) and remain editable, but a changed document must not keep referencing it",
                    paths
                        .iter()
                        .map(|p| format!("`{p}`"))
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
                Ok(_) => {}
                Err(e) => {
                    tracing::warn!("could not check which documents reference the record: {e}")
                }
            }
            (reply, "revoked")
        }
        Sub::Owner => return Ok(()),
    };
    if args.json {
        output::json(&reply)?;
    } else {
        // The reference stays alone on its own line so scripts can still
        // take the last line (R3-L12).
        output::line(format!("{verb} sealed record; reference:"))?;
        output::line(&reply.reference)?;
    }
    Ok(())
}
