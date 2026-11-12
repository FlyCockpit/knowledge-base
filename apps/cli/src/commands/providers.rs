//! Owner-only provider control; secrets imported through existing private input.
use crate::{auth, output};
use anyhow::Result;
use kb_client::types::KbId;
use kb_local::{
    credentials::{NativeCredentials, Secret},
    egress::{NativeDns, NativeHttp, PinnedEgress},
    embedder::ProviderControl,
    providers::ProviderConfig,
};
use std::path::PathBuf;
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LoopbackReply {
    allow_loopback: bool,
}
#[derive(serde::Serialize)]
struct RevokeReply {
    revoked: bool,
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RegistrationReply {
    operation_id: String,
    provider: kb_client::types::ProviderSummary,
}
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
#[derive(Debug, clap::Subcommand)]
enum Sub {
    /// Register a new immutable revision; key bytes never appear in argv.
    /// `--endpoint` is the exact embeddings URL, usually ending in
    /// `/embeddings` (e.g. `https://api.example.com/v1/embeddings`).
    Register {
        /// Replay key (16-128 letters, digits, underscores or hyphens).
        #[arg(long)]
        idempotency_key: String,
        /// Existing provider ID to add a revision to; omit for a new provider.
        #[arg(long)]
        provider_id: Option<String>,
        /// Human-readable provider name.
        #[arg(long)]
        name: String,
        /// Exact HTTPS embeddings endpoint URL.
        #[arg(long)]
        endpoint: String,
        /// Model name understood by the provider.
        #[arg(long)]
        model: String,
        /// Number of dimensions returned by the model (1-2000).
        #[arg(long)]
        dimensions: usize,
        /// Read the API key from stdin (never from a command-line argument).
        #[arg(
            long,
            required_unless_present = "key_file",
            conflicts_with = "key_file"
        )]
        key_stdin: bool,
        /// Read the API key from an owner-only UTF-8 file.
        #[arg(long)]
        key_file: Option<PathBuf>,
    },
    /// Probe an exact registered revision.
    Probe {
        /// The provider ID (`kb providers list`).
        #[arg(long, value_name = "PROVIDER_ID")]
        provider: String,
        /// The revision to probe.
        #[arg(long)]
        revision: i64,
    },
    /// List latest revisions using an opaque ID keyset page.
    List {
        #[arg(long)]
        after: Option<String>,
        #[arg(long, default_value_t = 20)]
        limit: usize,
    },
    /// Fence requests and destroy every revision's native secret.
    Revoke {
        /// The provider ID (`kb providers list`).
        #[arg(long, value_name = "PROVIDER_ID")]
        provider: String,
    },
    /// Persist the local owner's explicit literal-loopback development policy.
    Loopback {
        /// Allow provider endpoints on a literal loopback address
        /// (`127.0.0.1`, `[::1]`); omit to forbid them again.
        #[arg(long)]
        enabled: bool,
    },
    /// Use a provider (or the built-in model) for a knowledge base's
    /// semantic search; this rebuilds its index unless that exact profile's
    /// semantic index of the head is already current or building.
    Attach {
        /// The knowledge base ID.
        #[arg(long = "kb", value_name = "KB_ID", value_parser = crate::local::parse_kb_id)]
        kb: KbId,
        /// `builtin` for the enabled built-in model, or a provider ID.
        #[arg(long, value_name = "builtin|PROVIDER_ID")]
        provider: String,
        /// Provider revision (default: the built-in's current one; required
        /// for a registered provider).
        #[arg(long)]
        revision: Option<i64>,
        /// Replay key (16-128 of `A-Z a-z 0-9 _ -`). Default: a fresh key.
        #[arg(long)]
        idempotency_key: Option<String>,
    },
}
fn id(s: &str) -> Result<KbId> {
    KbId::parse(s).map_err(|_| anyhow::anyhow!("invalid provider id"))
}
fn status(s: &kb_client::types::ProviderStatus) -> &'static str {
    match s {
        kb_client::types::ProviderStatus::Ready => "ready",
        kb_client::types::ProviderStatus::Revoked => "revoked",
        kb_client::types::ProviderStatus::Unavailable => "unavailable (not probed or failing)",
    }
}

pub fn run(args: &Args) -> Result<()> {
    let config = crate::config::Config::load()?;
    let native = NativeCredentials::new(std::env::current_exe()?);
    let root = args.root.require(&config)?;
    // Listing never creates a store (L-17); changes create it on first use.
    let store = match &args.command {
        Sub::List { .. } => match kb_local::Store::open_existing(&root) {
            Ok(store) => store,
            Err(e) if e.protocol_code() == kb_client::ErrorCode::NotFound => {
                if args.json {
                    output::json(&Vec::<kb_client::types::ProviderSummary>::new())?;
                } else {
                    output::line(format!(
                        "no providers (no store at `{}` yet)",
                        root.display()
                    ))?;
                }
                return Ok(());
            }
            Err(e) => return Err(e.into()),
        },
        _ => crate::local::open_or_create(&root)?,
    };
    // Built-in status reflects whether its file is in the cache (review r2 #4).
    store.attach_model_cache(crate::paths::model_host(&config)?.cache().clone());
    let owner = store.owner();
    match &args.command {
        Sub::List { after, limit } => {
            let after = after.as_deref().map(id).transpose()?;
            let mut rows = store
                .provider_list(&owner, after.as_ref(), *limit)?
                .iter()
                .map(|r| r.summary())
                .collect::<Vec<_>>();
            // The enabled built-in is attachable like a provider (L-12).
            if after.is_none()
                && let Some(builtin) = store.builtin_provider_summary()?
            {
                rows.insert(0, builtin);
            }
            if args.json {
                output::json(&rows)?;
            } else if rows.is_empty() {
                output::line(
                    "no providers; register one with `kb providers register` or enable the built-in model with `kb model enable`",
                )?;
            } else {
                for r in rows {
                    output::line(format!(
                        "{} revision {} {} — {} ({}, {} dimensions)",
                        r.provider_id,
                        r.revision,
                        status(&r.status),
                        r.name,
                        r.model,
                        r.dimensions
                    ))?;
                }
            }
        }
        Sub::Attach {
            kb,
            provider,
            revision,
            idempotency_key,
        } => {
            let provider = kb_client::types::ProviderRef::parse(provider)
                .map_err(|_| anyhow::anyhow!("`{provider}` is not `builtin` or a provider ID"))?;
            let key = match idempotency_key {
                Some(key) => key.clone(),
                None => format!("cli-attach-{}", kb_local::state::random_key()?),
            };
            let mut input = serde_json::json!({
                "kbId": kb,
                "providerId": provider,
                "idempotencyKey": key,
                "confirm": "RUN",
            });
            if let Some(revision) = revision {
                input["revision"] = serde_json::json!(revision);
            }
            let input = serde_json::from_value(input)?;
            // The store decides under its lock whether that exact profile's
            // semantic generation of the head already serves or is building
            // (R3-L12): then nothing is started and no rebuild budget is spent.
            let job = store.embedding_profile_set(&owner, input)?;
            if args.json {
                output::json(&job)?;
            } else {
                match job.state {
                    kb_client::types::ProfileSetState::Current => output::line(format!(
                        "`{kb}` already uses `{provider}`: index generation `{}` is current; nothing to rebuild",
                        job.generation_id
                    ))?,
                    kb_client::types::ProfileSetState::Pending => output::line(format!(
                        "attached `{provider}` to `{kb}`; index generation `{}` is building",
                        job.generation_id
                    ))?,
                }
            }
        }
        Sub::Loopback { enabled } => {
            store.provider_set_loopback(&owner, *enabled)?;
            if args.json {
                output::json(&LoopbackReply {
                    allow_loopback: *enabled,
                })?;
            } else if *enabled {
                output::line("providers may now use literal loopback endpoints")?;
            } else {
                output::line("providers may no longer use loopback endpoints")?;
            }
        }
        Sub::Revoke {
            provider: provider_id,
        } => {
            store.provider_revoke(&owner, &id(provider_id)?, &native)?;
            if args.json {
                output::json(&RevokeReply { revoked: true })?;
            } else {
                output::line(format!(
                    "revoked provider `{provider_id}`: its requests are fenced and every revision's key is destroyed"
                ))?;
            }
        }
        Sub::Probe {
            provider: provider_id,
            revision,
        } => {
            let egress = PinnedEgress::new(&NativeDns, &NativeHttp);
            let r = crate::runtime()?.block_on(store.provider_probe(
                &owner,
                &id(provider_id)?,
                *revision,
                &native,
                &egress,
                &ProviderControl::default(),
            ))?;
            let summary = r.summary();
            if args.json {
                output::json(&summary)?;
            } else {
                output::line(format!(
                    "provider `{}` revision {}: {}",
                    summary.provider_id,
                    summary.revision,
                    status(&summary.status)
                ))?;
            }
        }
        Sub::Register {
            idempotency_key,
            provider_id,
            name,
            endpoint,
            model,
            dimensions,
            key_file,
            ..
        } => {
            if !endpoint.trim_end_matches('/').ends_with("/embeddings") {
                tracing::warn!(
                    "the endpoint is used exactly as given; most OpenAI-compatible providers expect a URL ending in `/embeddings`"
                );
            }
            let key = auth::import_secret(key_file.as_ref(), auth::InputPolicy::Provider)?;
            let c = ProviderConfig {
                idempotency_key: idempotency_key.clone(),
                provider_id: provider_id.as_deref().map(id).transpose()?,
                name: name.clone(),
                endpoint_url: endpoint.clone(),
                model: model.clone(),
                dimensions: *dimensions,
            };
            let r = store.provider_register(
                &owner,
                c,
                Secret::new(key.expose_secret().to_owned()),
                &native,
            )?;
            let reply = RegistrationReply {
                operation_id: r.operation_id.clone(),
                provider: r.summary(),
            };
            if args.json {
                output::json(&reply)?;
            } else {
                output::line(format!(
                    "registered `{}` as provider `{}` revision {} ({}); probe it with `kb providers probe --provider {} --revision {}`",
                    reply.provider.name,
                    reply.provider.provider_id,
                    reply.provider.revision,
                    status(&reply.provider.status),
                    reply.provider.provider_id,
                    reply.provider.revision
                ))?;
            }
        }
    }
    Ok(())
}
